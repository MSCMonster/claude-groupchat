// 本地 inbox 队列（client 侧）
// 设计：
//   - JSON Lines 文件 .cgc/inbox.jsonl 持久化所有收到的事件
//   - 文件 .cgc/inbox.cursor 记录已读偏移（字节数）
//   - subscriber 写入、MCP server 读取/标记已读，两个进程共享这同一份队列
'use strict';
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

class Inbox {
  constructor(rootDir) {
    this.dir = path.join(rootDir || process.cwd(), '.cgc');
    this.file = path.join(this.dir, 'inbox.jsonl');
    this.cursorFile = path.join(this.dir, 'inbox.cursor');
    fs.mkdirSync(this.dir, { recursive: true });
    // 文件不存在则建立空文件，方便后续 append/stat
    if (!fs.existsSync(this.file)) fs.writeFileSync(this.file, '');
    if (!fs.existsSync(this.cursorFile)) fs.writeFileSync(this.cursorFile, '0');
  }

  // ===== 写入：仅 subscriber 调用 =====
  async append(entry) {
    const enriched = { ...entry, receivedAt: entry.receivedAt || Date.now() };
    const line = JSON.stringify(enriched) + '\n';
    await fsp.appendFile(this.file, line, 'utf8');
    return enriched;
  }

  // ===== 状态查询 =====
  async stats() {
    const [size, cursor] = await Promise.all([this._fileSize(), this._cursor()]);
    const unreadBytes = Math.max(0, size - cursor);
    let unread = 0;
    if (unreadBytes > 0) {
      // 数一下未读行数（仅用于显示，不影响读取）
      const buf = await this._readRange(cursor, size);
      unread = buf.toString('utf8').split('\n').filter(Boolean).length;
    }
    return { totalBytes: size, cursorBytes: cursor, unread };
  }

  // ===== 读取：MCP 调用 =====
  // 读取所有未读条目；mark=true 时标记已读
  async pull({ mark = true, limit } = {}) {
    const size = await this._fileSize();
    const cursor = await this._cursor();
    if (size <= cursor) return { entries: [], unread: 0 };

    const buf = await this._readRange(cursor, size);
    const lines = buf.toString('utf8').split('\n').filter(Boolean);
    let entries = lines.map(l => safeJson(l)).filter(Boolean);
    const total = entries.length;

    let newCursor = size;
    if (typeof limit === 'number' && entries.length > limit) {
      entries = entries.slice(0, limit);
      // 计算新 cursor：取前 limit 行对应的字节数
      const consumedBytes = Buffer.byteLength(
        lines.slice(0, limit).join('\n') + '\n', 'utf8'
      );
      newCursor = cursor + consumedBytes;
    }

    if (mark) await this._setCursor(newCursor);
    return { entries, unread: Math.max(0, total - entries.length) };
  }

  // 不影响 cursor 的查看：从尾部取最近 N 条
  async peek({ limit = 20 } = {}) {
    const size = await this._fileSize();
    if (size === 0) return [];
    const buf = await fsp.readFile(this.file, 'utf8');
    const lines = buf.split('\n').filter(Boolean);
    const slice = lines.slice(-limit);
    return slice.map(l => safeJson(l)).filter(Boolean);
  }

  async markAllRead() {
    const size = await this._fileSize();
    await this._setCursor(size);
  }

  // ===== 内部工具 =====
  async _fileSize() {
    try {
      const s = await fsp.stat(this.file);
      return s.size;
    } catch {
      return 0;
    }
  }
  async _cursor() {
    try {
      const txt = await fsp.readFile(this.cursorFile, 'utf8');
      const n = Number(txt.trim()) || 0;
      return n;
    } catch {
      return 0;
    }
  }
  async _setCursor(n) {
    await fsp.writeFile(this.cursorFile, String(n), 'utf8');
  }
  async _readRange(start, end) {
    const length = end - start;
    if (length <= 0) return Buffer.alloc(0);
    const fh = await fsp.open(this.file, 'r');
    try {
      const buf = Buffer.alloc(length);
      await fh.read(buf, 0, length, start);
      return buf;
    } finally {
      await fh.close();
    }
  }
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

module.exports = { Inbox };
