// 房间状态：维护在线 peer、转发广播
// - 全局房间 global：所有在线 peer 默认收到
// - 话题房间 topic:<slug>：仅成员收到
// 同一 peerId 可能同时有 sender + receiver 两条连接
'use strict';

const { v4: uuidv4 } = require('uuid');
const {
  MSG, ROLE, GLOBAL_TOPIC, SYSTEM_PEER_ID, systemPeer, extractTopicMentions
} = require('../shared/protocol');
const { getLogger } = require('../logger');

const log = getLogger('room');

class Room {
  constructor({ storage }) {
    this.storage = storage;
    // peerId -> { peer, senders: Set<WebSocket>, receivers: Set<WebSocket> }
    this.peers = new Map();
    // WebSocket -> { peerId, role }
    this.connInfo = new WeakMap();
    // WebUI 旁路：SSE 客户端监听所有广播事件
    this.eventListeners = new Set();
  }

  addEventListener(fn) { this.eventListeners.add(fn); }
  removeEventListener(fn) { this.eventListeners.delete(fn); }
  _emitEvent(message) {
    for (const fn of this.eventListeners) {
      try { fn(message); } catch (e) { log.warn(`SSE 监听器异常: ${e.message}`); }
    }
  }

  // ===== 连接注册 / 注销 =====
  async registerConnection(ws, role, peer) {
    if (!peer || !peer.id) throw new Error('peer.id 缺失');
    if (peer.id === SYSTEM_PEER_ID) throw new Error('保留 peerId：system');
    if (role !== ROLE.SENDER && role !== ROLE.RECEIVER) {
      throw new Error(`非法 role: ${role}`);
    }

    let entry = this.peers.get(peer.id);
    const isNewPeer = !entry;
    if (!entry) {
      entry = { peer, senders: new Set(), receivers: new Set() };
      this.peers.set(peer.id, entry);
    } else {
      entry.peer = { ...entry.peer, ...peer };
    }

    if (role === ROLE.SENDER) entry.senders.add(ws);
    else entry.receivers.add(ws);

    this.connInfo.set(ws, { peerId: peer.id, role });

    // 持久化 peer 元数据 + 在线计数
    this.storage.upsertPeer(entry.peer);
    this.storage.setPeerConns(peer.id, {
      senders: entry.senders.size, receivers: entry.receivers.size
    });

    log.info(`peer 连接 id=${peer.id} role=${role} 当前 peers=${this.peers.size}`);

    // 仅在第一次出现 receiver 时认为是"新加入"，广播 PEER_JOIN 到全局
    if (role === ROLE.RECEIVER && entry.receivers.size === 1) {
      this.broadcastGlobal({
        type: MSG.PEER_JOIN,
        peer: entry.peer,
        peers: this.listPeerSnapshots()
      });
    }

    return { isNewPeer };
  }

  removeConnection(ws) {
    const info = this.connInfo.get(ws);
    if (!info) return;
    this.connInfo.delete(ws);

    const entry = this.peers.get(info.peerId);
    if (!entry) return;

    if (info.role === ROLE.SENDER) entry.senders.delete(ws);
    else entry.receivers.delete(ws);

    this.storage.setPeerConns(info.peerId, {
      senders: entry.senders.size, receivers: entry.receivers.size
    });

    const offline = entry.receivers.size === 0 && entry.senders.size === 0;
    if (offline) {
      this.peers.delete(info.peerId);
      log.info(`peer 离线 id=${info.peerId}`);
      this.broadcastGlobal({
        type: MSG.PEER_LEAVE,
        peer: entry.peer,
        peers: this.listPeerSnapshots()
      });
    } else if (info.role === ROLE.RECEIVER && entry.receivers.size === 0) {
      log.info(`peer receiver 全断 id=${info.peerId}`);
      const remaining = this.listPeerSnapshots().filter(p => p.id !== info.peerId);
      this.broadcastGlobal({
        type: MSG.PEER_LEAVE,
        peer: entry.peer,
        peers: remaining
      });
    }
  }

  // ===== 广播 =====
  // 全局广播（含发送者本身可排除）
  broadcastGlobal(message, { excludePeerId } = {}) {
    const payload = JSON.stringify(message);
    let count = 0;
    for (const [peerId, entry] of this.peers) {
      if (peerId === excludePeerId) continue;
      for (const ws of entry.receivers) {
        if (ws.readyState === 1) { ws.send(payload); count += 1; }
      }
    }
    this._emitEvent(message);
    return count;
  }

  // 话题房间广播：仅成员
  broadcastTopic(topic, message, { excludePeerId } = {}) {
    if (topic === GLOBAL_TOPIC) return this.broadcastGlobal(message, { excludePeerId });
    const payload = JSON.stringify(message);
    let count = 0;
    const members = this.storage.listMembers(topic);
    for (const m of members) {
      if (m.peerId === excludePeerId) continue;
      const entry = this.peers.get(m.peerId);
      if (!entry) continue; // 离线，跳过
      for (const ws of entry.receivers) {
        if (ws.readyState === 1) { ws.send(payload); count += 1; }
      }
    }
    this._emitEvent(message);
    return count;
  }

  // ===== 状态查询 =====
  listPeerSnapshots() {
    return Array.from(this.peers.values()).map(e => ({
      ...e.peer,
      senderConnections: e.senders.size,
      receiverConnections: e.receivers.size
    }));
  }

  // ===== 业务方法 =====
  // 处理一次 SEND：补全元数据 → 入库 → 广播
  async handleSend(fromPeerId, body, attachments, topic) {
    const t = topic || GLOBAL_TOPIC;
    const entry = this.peers.get(fromPeerId);
    const fromPeer = entry ? entry.peer : (fromPeerId === SYSTEM_PEER_ID ? systemPeer() : null);
    if (!fromPeer) throw new Error(`未知 peerId=${fromPeerId}`);

    // 权限：非 global 必须是成员（system 例外，可向任意话题注入）
    if (t !== GLOBAL_TOPIC && fromPeerId !== SYSTEM_PEER_ID) {
      if (!this.storage.getTopic(t)) throw new Error(`话题不存在: ${t}`);
      if (!this.storage.isMember(t, fromPeerId)) {
        throw new Error(`未加入话题房间: ${t}`);
      }
    } else if (t !== GLOBAL_TOPIC && !this.storage.getTopic(t)) {
      throw new Error(`话题不存在: ${t}`);
    }

    const mentions = extractTopicMentions(body);
    const msgId = uuidv4();
    const ts = Date.now();
    this.storage.appendMessage({
      id: msgId, topic: t, kind: 'message', from: fromPeer,
      body, attachments, isSystem: fromPeerId === SYSTEM_PEER_ID, ts
    });

    const message = {
      type: MSG.MESSAGE,
      id: msgId,
      topic: t,
      from: fromPeer,
      body: String(body || ''),
      attachments: Array.isArray(attachments) ? attachments : [],
      mentions,
      isSystem: fromPeerId === SYSTEM_PEER_ID,
      ts
    };

    const delivered = this.broadcastTopic(t, message, { excludePeerId: fromPeerId });
    log.info(`广播消息 topic=${t} from=${fromPeerId} delivered=${delivered} body长度=${message.body.length}`);
    return message;
  }

  // ===== 话题房间操作 =====
  createTopic({ slug, title, description, createdBy, autoJoin = true }) {
    const topic = this.storage.createTopic({ slug, title, description, createdBy });
    if (autoJoin && createdBy && createdBy !== SYSTEM_PEER_ID) {
      this.storage.addMember(slug, createdBy);
    }
    this.broadcastGlobal({
      type: MSG.TOPIC_EVENT,
      kind: 'topic_created',
      topic, by: createdBy || null
    });
    return topic;
  }

  deleteTopic(slug, by) {
    const topic = this.storage.getTopic(slug);
    if (!topic) throw new Error(`话题不存在: ${slug}`);
    const ok = this.storage.deleteTopic(slug);
    if (ok) {
      this.broadcastGlobal({
        type: MSG.TOPIC_EVENT,
        kind: 'topic_deleted',
        topic, by: by || null
      });
    }
    return ok;
  }

  joinTopic(slug, peerId) {
    if (slug === GLOBAL_TOPIC) return; // global 默认在，无需加入
    this.storage.addMember(slug, peerId);
    const topic = this.storage.getTopic(slug);
    this.broadcastTopic(slug, {
      type: MSG.TOPIC_EVENT,
      kind: 'topic_member_joined',
      topic, peerId
    });
  }

  leaveTopic(slug, peerId) {
    if (slug === GLOBAL_TOPIC) return;
    const topic = this.storage.getTopic(slug);
    // 通知现有成员（包含正离开者）
    this.broadcastTopic(slug, {
      type: MSG.TOPIC_EVENT,
      kind: 'topic_member_left',
      topic, peerId
    });
    this.storage.removeMember(slug, peerId);
  }

  updateTopicMeta(slug, patch, by) {
    const topic = this.storage.updateTopicMeta(slug, patch);
    // global 的 meta 全局广播；topic 仅成员
    if (slug === GLOBAL_TOPIC) {
      this.broadcastGlobal({
        type: MSG.TOPIC_EVENT, kind: 'topic_meta_updated', topic, by: by || null
      });
    } else {
      this.broadcastTopic(slug, {
        type: MSG.TOPIC_EVENT, kind: 'topic_meta_updated', topic, by: by || null
      });
    }
    return topic;
  }

  addTodo({ topicSlug, content, createdBy }) {
    const todo = this.storage.addTodo({ topicSlug, content, createdBy });
    this.broadcastTopic(topicSlug, {
      type: MSG.TOPIC_EVENT, kind: 'topic_todo_added', topic: this.storage.getTopic(topicSlug), todo
    });
    return todo;
  }

  updateTodo(id, patch) {
    const todo = this.storage.updateTodo(id, patch);
    this.broadcastTopic(todo.topicSlug, {
      type: MSG.TOPIC_EVENT, kind: 'topic_todo_updated', topic: this.storage.getTopic(todo.topicSlug), todo
    });
    return todo;
  }

  deleteTodo(id) {
    const cur = this.storage.getTodo(id);
    if (!cur) return false;
    const ok = this.storage.deleteTodo(id);
    if (ok) {
      this.broadcastTopic(cur.topicSlug, {
        type: MSG.TOPIC_EVENT, kind: 'topic_todo_deleted',
        topic: this.storage.getTopic(cur.topicSlug), todoId: id
      });
    }
    return ok;
  }

  // 给 webUI 用：以 system 身份发送（topic 可空 = global）
  async systemSend({ body, attachments, topic }) {
    return this.handleSend(SYSTEM_PEER_ID, body, attachments, topic || GLOBAL_TOPIC);
  }
}

module.exports = { Room };
