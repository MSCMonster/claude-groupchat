// SQLite 存储层（better-sqlite3，同步 API）
// 持久化：消息、文件元数据、话题房间、成员关系、TODO/公告
// 重启不清空，仅把 peers.is_online 置 0
'use strict';

const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const { v4: uuidv4 } = require('uuid');
const Database = require('better-sqlite3');
const { getLogger } = require('../logger');

const log = getLogger('storage');

const GLOBAL_TOPIC = 'global';

class Storage {
  constructor(opts = {}) {
    // 数据库文件路径
    const sqlitePath = opts.sqlitePath || process.env.SQLITE_PATH || 'data/cgc.db';
    this.dbPath = path.isAbsolute(sqlitePath)
      ? sqlitePath
      : path.join(__dirname, '..', sqlitePath);
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });

    // 上传目录
    const uploadDir = opts.uploadDir || process.env.UPLOAD_DIR || 'uploads';
    this.uploadDir = path.isAbsolute(uploadDir)
      ? uploadDir
      : path.join(__dirname, '..', uploadDir);
    fs.mkdirSync(this.uploadDir, { recursive: true });

    this.historyPush = Number(opts.historyPush || process.env.HISTORY_PUSH_COUNT || 20);
    this.webPageSize = Number(opts.webPageSize || process.env.WEB_PAGE_SIZE || 50);

    log.info(`打开 SQLite ${this.dbPath}`);
    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('synchronous = NORMAL');

    this._initSchema();
    this._ensureGlobalTopic();
    // 启动时把所有 peer 置为离线（连接是新一轮，旧 is_online 不可信）
    this.db.prepare('UPDATE peers SET is_online = 0').run();
  }

  // ===== 表结构 =====
  _initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS peers (
        id TEXT PRIMARY KEY,
        hostname TEXT,
        project_dir TEXT,
        label TEXT,
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        is_online INTEGER NOT NULL DEFAULT 0,
        sender_conns INTEGER NOT NULL DEFAULT 0,
        receiver_conns INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS topics (
        slug TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        announcement TEXT NOT NULL DEFAULT '',
        created_by TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS topic_members (
        topic_slug TEXT NOT NULL,
        peer_id TEXT NOT NULL,
        joined_at INTEGER NOT NULL,
        PRIMARY KEY (topic_slug, peer_id),
        FOREIGN KEY (topic_slug) REFERENCES topics(slug) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS topic_todos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        topic_slug TEXT NOT NULL,
        content TEXT NOT NULL,
        done INTEGER NOT NULL DEFAULT 0,
        created_by TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (topic_slug) REFERENCES topics(slug) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        topic TEXT NOT NULL DEFAULT 'global',
        kind TEXT NOT NULL DEFAULT 'message',
        from_peer_id TEXT,
        from_label TEXT,
        from_hostname TEXT,
        from_project_dir TEXT,
        body TEXT NOT NULL DEFAULT '',
        attachments TEXT NOT NULL DEFAULT '[]',
        is_system INTEGER NOT NULL DEFAULT 0,
        ts INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_topic_ts ON messages(topic, ts DESC);
      CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(ts DESC);

      CREATE TABLE IF NOT EXISTS files (
        file_id TEXT PRIMARY KEY,
        filename TEXT NOT NULL,
        mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
        size INTEGER NOT NULL DEFAULT 0,
        stored_path TEXT NOT NULL,
        uploaded_by TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_files_filename_time ON files(filename, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_files_created_at ON files(created_at DESC);
    `);
  }

  _ensureGlobalTopic() {
    const exists = this.db.prepare('SELECT 1 FROM topics WHERE slug = ?').get(GLOBAL_TOPIC);
    if (!exists) {
      const now = Date.now();
      this.db.prepare(`
        INSERT INTO topics (slug, title, description, announcement, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(GLOBAL_TOPIC, '全局聊天室', '所有 peer 默认在此频道收发消息', '', 'system', now, now);
      log.info('创建内置全局房间 global');
    }
  }

  // ===== peer =====
  upsertPeer(peer) {
    const now = Date.now();
    const existing = this.db.prepare('SELECT id FROM peers WHERE id = ?').get(peer.id);
    if (existing) {
      this.db.prepare(`
        UPDATE peers SET hostname = ?, project_dir = ?, label = ?, last_seen_at = ?
        WHERE id = ?
      `).run(peer.hostname || '', peer.projectDir || '', peer.label || '', now, peer.id);
    } else {
      this.db.prepare(`
        INSERT INTO peers (id, hostname, project_dir, label, first_seen_at, last_seen_at, is_online)
        VALUES (?, ?, ?, ?, ?, ?, 0)
      `).run(peer.id, peer.hostname || '', peer.projectDir || '', peer.label || '', now, now);
    }
  }

  setPeerConns(peerId, { senders, receivers }) {
    const isOnline = (senders + receivers) > 0 ? 1 : 0;
    this.db.prepare(`
      UPDATE peers SET sender_conns = ?, receiver_conns = ?, is_online = ?, last_seen_at = ?
      WHERE id = ?
    `).run(senders, receivers, isOnline, Date.now(), peerId);
  }

  getPeer(peerId) {
    const row = this.db.prepare('SELECT * FROM peers WHERE id = ?').get(peerId);
    return row ? rowToPeer(row) : null;
  }

  listAllPeers() {
    return this.db.prepare('SELECT * FROM peers ORDER BY last_seen_at DESC').all().map(rowToPeer);
  }

  // ===== 消息 =====
  appendMessage({ id, topic, kind, from, body, attachments, isSystem, ts }) {
    const msgId = id || uuidv4();
    const t = topic || GLOBAL_TOPIC;
    const fromPeer = from || {};
    this.db.prepare(`
      INSERT INTO messages (
        id, topic, kind, from_peer_id, from_label, from_hostname, from_project_dir,
        body, attachments, is_system, ts
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      msgId, t, kind || 'message',
      fromPeer.id || null, fromPeer.label || '', fromPeer.hostname || '', fromPeer.projectDir || '',
      String(body || ''),
      JSON.stringify(Array.isArray(attachments) ? attachments : []),
      isSystem ? 1 : 0,
      ts || Date.now()
    );
    return msgId;
  }

  // 历史消息（topic 内最近 N 条，按时间正序）
  recentMessages({ topic, limit } = {}) {
    const t = topic || GLOBAL_TOPIC;
    const n = Math.max(1, Math.min(Number(limit) || this.historyPush, 1000));
    const rows = this.db.prepare(`
      SELECT * FROM messages WHERE topic = ? ORDER BY ts DESC LIMIT ?
    `).all(t, n);
    return rows.map(rowToMessage).reverse();
  }

  // 分页（WebUI 用）：按时间倒序，beforeTs 用于游标
  listMessagesPage({ topic, beforeTs, pageSize } = {}) {
    const t = topic || GLOBAL_TOPIC;
    const size = Math.max(1, Math.min(Number(pageSize) || this.webPageSize, 200));
    const before = Number(beforeTs) || Date.now() + 1;
    const rows = this.db.prepare(`
      SELECT * FROM messages WHERE topic = ? AND ts < ? ORDER BY ts DESC LIMIT ?
    `).all(t, before, size);
    return {
      messages: rows.map(rowToMessage),
      nextCursor: rows.length === size ? rows[rows.length - 1].ts : null
    };
  }

  // ===== 文件 =====
  registerFile({ originalName, mimeType, size, storedPath, uploadedBy }) {
    const fileId = uuidv4();
    const createdAt = Date.now();
    this.db.prepare(`
      INSERT INTO files (file_id, filename, mime_type, size, stored_path, uploaded_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(fileId, originalName, mimeType || 'application/octet-stream',
      Number(size) || 0, storedPath, uploadedBy || null, createdAt);
    log.info(`文件登记 fileId=${fileId} filename=${originalName} size=${size}`);
    return {
      fileId, filename: originalName,
      mimeType: mimeType || 'application/octet-stream',
      size: Number(size) || 0, storedPath, uploadedBy: uploadedBy || null,
      createdAt
    };
  }

  getFileById(fileId) {
    if (!fileId) return null;
    const row = this.db.prepare('SELECT * FROM files WHERE file_id = ?').get(fileId);
    return row ? rowToFile(row) : null;
  }

  // 同名取最新一份
  getFileByName(filename) {
    if (!filename) return null;
    const row = this.db.prepare(`
      SELECT * FROM files WHERE filename = ? ORDER BY created_at DESC LIMIT 1
    `).get(filename);
    return row ? rowToFile(row) : null;
  }

  listFiles({ limit = 100 } = {}) {
    return this.db.prepare(`
      SELECT * FROM files ORDER BY created_at DESC LIMIT ?
    `).all(Math.max(1, Math.min(Number(limit) || 100, 1000))).map(rowToFile);
  }

  // 手动清理：删除指定时间之前的文件（不再自动跑）
  async cleanupBefore(cutoffTs) {
    const rows = this.db.prepare('SELECT * FROM files WHERE created_at < ?').all(Number(cutoffTs));
    let deleted = 0;
    for (const row of rows) {
      try { await fsp.unlink(row.stored_path); }
      catch (err) {
        if (err.code !== 'ENOENT') log.warn(`删除文件失败 ${row.stored_path}: ${err.message}`);
      }
      this.db.prepare('DELETE FROM files WHERE file_id = ?').run(row.file_id);
      deleted += 1;
    }
    log.info(`手动清理文件 ${deleted} 个`);
    return deleted;
  }

  async deleteFile(fileId) {
    const row = this.db.prepare('SELECT * FROM files WHERE file_id = ?').get(fileId);
    if (!row) return false;
    try { await fsp.unlink(row.stored_path); }
    catch (err) {
      if (err.code !== 'ENOENT') log.warn(`删除文件失败 ${row.stored_path}: ${err.message}`);
    }
    this.db.prepare('DELETE FROM files WHERE file_id = ?').run(fileId);
    return true;
  }

  // ===== 话题房间 =====
  createTopic({ slug, title, description, createdBy }) {
    if (!slug || !/^[a-zA-Z0-9_\-:.]{1,64}$/.test(slug)) {
      throw new Error('topic slug 仅允许字母数字与 _ - : .，长度 1-64');
    }
    if (slug === GLOBAL_TOPIC) throw new Error('global 是内置房间');
    const exists = this.db.prepare('SELECT 1 FROM topics WHERE slug = ?').get(slug);
    if (exists) throw new Error(`话题房间已存在: ${slug}`);
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO topics (slug, title, description, announcement, created_by, created_at, updated_at)
      VALUES (?, ?, ?, '', ?, ?, ?)
    `).run(slug, title || slug, description || '', createdBy || null, now, now);
    return this.getTopic(slug);
  }

  deleteTopic(slug) {
    if (slug === GLOBAL_TOPIC) throw new Error('不能删除内置全局房间');
    const info = this.db.prepare('DELETE FROM topics WHERE slug = ?').run(slug);
    return info.changes > 0;
  }

  getTopic(slug) {
    const row = this.db.prepare('SELECT * FROM topics WHERE slug = ?').get(slug);
    return row ? rowToTopic(row) : null;
  }

  listTopics() {
    const rows = this.db.prepare(`
      SELECT t.*, (SELECT COUNT(*) FROM topic_members WHERE topic_slug = t.slug) AS member_count
      FROM topics t ORDER BY (t.slug = 'global') DESC, t.created_at ASC
    `).all();
    return rows.map(r => ({ ...rowToTopic(r), memberCount: r.member_count }));
  }

  updateTopicMeta(slug, { title, description, announcement }) {
    const cur = this.getTopic(slug);
    if (!cur) throw new Error(`话题不存在: ${slug}`);
    const now = Date.now();
    this.db.prepare(`
      UPDATE topics SET title = ?, description = ?, announcement = ?, updated_at = ?
      WHERE slug = ?
    `).run(
      title !== undefined ? String(title) : cur.title,
      description !== undefined ? String(description) : cur.description,
      announcement !== undefined ? String(announcement) : cur.announcement,
      now,
      slug
    );
    return this.getTopic(slug);
  }

  addMember(slug, peerId) {
    if (!this.getTopic(slug)) throw new Error(`话题不存在: ${slug}`);
    const now = Date.now();
    this.db.prepare(`
      INSERT OR IGNORE INTO topic_members (topic_slug, peer_id, joined_at)
      VALUES (?, ?, ?)
    `).run(slug, peerId, now);
  }

  removeMember(slug, peerId) {
    const info = this.db.prepare(`
      DELETE FROM topic_members WHERE topic_slug = ? AND peer_id = ?
    `).run(slug, peerId);
    return info.changes > 0;
  }

  listMembers(slug) {
    return this.db.prepare(`
      SELECT m.peer_id, m.joined_at, p.hostname, p.project_dir, p.label, p.is_online
      FROM topic_members m LEFT JOIN peers p ON p.id = m.peer_id
      WHERE m.topic_slug = ? ORDER BY m.joined_at ASC
    `).all(slug).map(r => ({
      peerId: r.peer_id, joinedAt: r.joined_at,
      hostname: r.hostname || '', projectDir: r.project_dir || '',
      label: r.label || '', isOnline: !!r.is_online
    }));
  }

  isMember(slug, peerId) {
    const r = this.db.prepare(`
      SELECT 1 FROM topic_members WHERE topic_slug = ? AND peer_id = ?
    `).get(slug, peerId);
    return !!r;
  }

  listTopicsForPeer(peerId) {
    return this.db.prepare(`
      SELECT t.* FROM topics t
      INNER JOIN topic_members m ON m.topic_slug = t.slug
      WHERE m.peer_id = ? ORDER BY t.created_at ASC
    `).all(peerId).map(rowToTopic);
  }

  // ===== TODO（话题公告/事项）=====
  addTodo({ topicSlug, content, createdBy }) {
    if (!this.getTopic(topicSlug)) throw new Error(`话题不存在: ${topicSlug}`);
    const now = Date.now();
    const info = this.db.prepare(`
      INSERT INTO topic_todos (topic_slug, content, done, created_by, created_at, updated_at)
      VALUES (?, ?, 0, ?, ?, ?)
    `).run(topicSlug, String(content || ''), createdBy || null, now, now);
    return this.getTodo(info.lastInsertRowid);
  }

  updateTodo(id, { content, done }) {
    const cur = this.getTodo(id);
    if (!cur) throw new Error(`TODO 不存在: ${id}`);
    const now = Date.now();
    this.db.prepare(`
      UPDATE topic_todos SET content = ?, done = ?, updated_at = ?
      WHERE id = ?
    `).run(
      content !== undefined ? String(content) : cur.content,
      done !== undefined ? (done ? 1 : 0) : (cur.done ? 1 : 0),
      now, id
    );
    return this.getTodo(id);
  }

  deleteTodo(id) {
    const info = this.db.prepare('DELETE FROM topic_todos WHERE id = ?').run(id);
    return info.changes > 0;
  }

  getTodo(id) {
    const row = this.db.prepare('SELECT * FROM topic_todos WHERE id = ?').get(id);
    return row ? rowToTodo(row) : null;
  }

  listTodos(topicSlug) {
    return this.db.prepare(`
      SELECT * FROM topic_todos WHERE topic_slug = ? ORDER BY done ASC, created_at ASC
    `).all(topicSlug).map(rowToTodo);
  }

  async close() {
    try { this.db.close(); } catch { /* ignore */ }
  }
}

// ===== 行 → 对象 =====
function rowToPeer(r) {
  return {
    id: r.id,
    hostname: r.hostname || '',
    projectDir: r.project_dir || '',
    label: r.label || '',
    firstSeenAt: r.first_seen_at,
    lastSeenAt: r.last_seen_at,
    isOnline: !!r.is_online,
    senderConns: r.sender_conns || 0,
    receiverConns: r.receiver_conns || 0
  };
}

function rowToMessage(r) {
  return {
    id: r.id,
    topic: r.topic,
    kind: r.kind,
    from: {
      id: r.from_peer_id,
      label: r.from_label || '',
      hostname: r.from_hostname || '',
      projectDir: r.from_project_dir || ''
    },
    body: r.body,
    attachments: safeParseArray(r.attachments),
    isSystem: !!r.is_system,
    ts: r.ts
  };
}

function rowToFile(r) {
  return {
    fileId: r.file_id,
    filename: r.filename,
    mimeType: r.mime_type,
    size: r.size,
    storedPath: r.stored_path,
    uploadedBy: r.uploaded_by,
    createdAt: r.created_at
  };
}

function rowToTopic(r) {
  return {
    slug: r.slug,
    title: r.title,
    description: r.description || '',
    announcement: r.announcement || '',
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  };
}

function rowToTodo(r) {
  return {
    id: r.id,
    topicSlug: r.topic_slug,
    content: r.content,
    done: !!r.done,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  };
}

function safeParseArray(s) {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}

module.exports = { Storage, GLOBAL_TOPIC };
