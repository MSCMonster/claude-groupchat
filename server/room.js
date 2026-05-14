// 房间状态：维护在线 peer、转发广播
// 同一 peerId 可能同时有 sender + receiver 两条连接
'use strict';
const { v4: uuidv4 } = require('uuid');
const { MSG, ROLE } = require('../shared/protocol');
const { getLogger } = require('../logger');

const log = getLogger('room');

class Room {
  constructor({ storage }) {
    this.storage = storage;
    // peerId -> { peer, senders: Set<WebSocket>, receivers: Set<WebSocket> }
    this.peers = new Map();
    // WebSocket -> { peerId, role }
    this.connInfo = new WeakMap();
  }

  // ===== 连接注册 / 注销 =====
  async registerConnection(ws, role, peer) {
    if (!peer || !peer.id) throw new Error('peer.id 缺失');
    if (role !== ROLE.SENDER && role !== ROLE.RECEIVER) {
      throw new Error(`非法 role: ${role}`);
    }

    let entry = this.peers.get(peer.id);
    const isNewPeer = !entry;
    if (!entry) {
      entry = { peer, senders: new Set(), receivers: new Set() };
      this.peers.set(peer.id, entry);
    } else {
      // 后注册的连接补全/覆盖元数据（label 可能在某条连接上提供）
      entry.peer = { ...entry.peer, ...peer };
    }

    if (role === ROLE.SENDER) entry.senders.add(ws);
    else entry.receivers.add(ws);

    this.connInfo.set(ws, { peerId: peer.id, role });

    log.info(`peer 连接 id=${peer.id} role=${role} 当前 peers=${this.peers.size}`);

    // 仅在第一次出现 receiver 时认为是"新加入"，广播 PEER_JOIN（附带完整在线列表）
    // 广播给所有 receiver（含新加入者本人），这样所有客户端通过同一条消息维护一致的在线列表
    if (role === ROLE.RECEIVER && entry.receivers.size === 1) {
      this.broadcast({
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

    // 所有 receiver 都断了 → 视为该 peer 离线
    const offline = entry.receivers.size === 0 && entry.senders.size === 0;
    if (offline) {
      this.peers.delete(info.peerId);
      log.info(`peer 离线 id=${info.peerId}`);
      this.broadcast({
        type: MSG.PEER_LEAVE,
        peer: entry.peer,
        peers: this.listPeerSnapshots()
      });
    } else if (info.role === ROLE.RECEIVER && entry.receivers.size === 0) {
      // receiver 全断但 sender 还在 → 也视作离开（无法再被推送）
      log.info(`peer receiver 全断 id=${info.peerId}`);
      // 注意：sender 还在意味着 entry 仍在 peers 中，需要从 listPeerSnapshots 里剔除
      const remaining = this.listPeerSnapshots().filter(p => p.id !== info.peerId);
      this.broadcast({
        type: MSG.PEER_LEAVE,
        peer: entry.peer,
        peers: remaining
      });
    }
  }

  // ===== 广播 =====
  // 仅推送给 receiver 连接；可排除指定 peerId（用于"不发回给自己"）
  broadcast(message, { excludePeerId } = {}) {
    const payload = JSON.stringify(message);
    let count = 0;
    for (const [peerId, entry] of this.peers) {
      if (peerId === excludePeerId) continue;
      for (const ws of entry.receivers) {
        if (ws.readyState === 1) {
          ws.send(payload);
          count += 1;
        }
      }
    }
    return count;
  }

  // ===== 业务方法 =====
  listPeerSnapshots() {
    return Array.from(this.peers.values()).map(e => ({
      ...e.peer,
      senderConnections: e.senders.size,
      receiverConnections: e.receivers.size
    }));
  }

  // 处理一次 SEND：补全元数据 → 入库 → 广播
  async handleSend(fromPeerId, body, attachments) {
    const entry = this.peers.get(fromPeerId);
    if (!entry) throw new Error(`未知 peerId=${fromPeerId}`);

    const message = {
      type: MSG.MESSAGE,
      id: uuidv4(),
      from: entry.peer,
      body: String(body || ''),
      attachments: Array.isArray(attachments) ? attachments : [],
      ts: Date.now()
    };

    await this.storage.appendMessage(message);
    const delivered = this.broadcast(message, { excludePeerId: fromPeerId });
    log.info(`广播消息 from=${fromPeerId} delivered=${delivered} body长度=${message.body.length}`);
    return message;
  }
}

module.exports = { Room };
