// WS sender 客户端：MCP server 内部使用
// 负责连接到 chat server、发送消息、调用 RPC（list_peers / get_history / topic_*）
'use strict';
const { randomUUID } = require('crypto');
const WebSocket = require('ws');
const { MSG, ROLE, buildPeer } = require('../shared/protocol');
const { getWsUrl } = require('../shared/url');
const { getLogger } = require('../logger');

const log = getLogger('ws-client');

class WSSenderClient {
  constructor(opts = {}) {
    this.url = opts.url || getWsUrl();
    this.peer = buildPeer({ projectDir: process.cwd() });
    this.ws = null;
    this.connected = false;
    this.pendingRpc = new Map();
    this.connectingPromise = null;
    this.shouldReconnect = true;
    this.reconnectMs = 1000;
  }

  async ensureConnected() {
    if (this.connected) return;
    if (this.connectingPromise) return this.connectingPromise;
    this.connectingPromise = this._connect();
    try { await this.connectingPromise; }
    finally { this.connectingPromise = null; }
  }

  _connect() {
    return new Promise((resolve, reject) => {
      log.info(`连接 WS ${this.url} as sender peer=${this.peer.id}`);
      const ws = new WebSocket(this.url);
      this.ws = ws;

      const onOpen = () => {
        ws.send(JSON.stringify({ type: MSG.HELLO, role: ROLE.SENDER, peer: this.peer }));
      };
      const onHelloAck = () => {
        this.connected = true;
        log.info('sender 握手完成');
        ws.removeListener('message', onMessageOnce);
        resolve();
      };
      const onMessageOnce = (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.type === MSG.HELLO_ACK) onHelloAck();
          else if (msg.type === MSG.ERROR) {
            ws.removeListener('message', onMessageOnce);
            reject(new Error(`server 拒绝握手: ${msg.error}`));
          }
        } catch { /* ignore */ }
      };

      ws.on('open', onOpen);
      ws.on('message', onMessageOnce);
      ws.on('message', (raw) => this._handleMessage(raw));
      ws.on('close', (code, reason) => {
        log.info(`WS 关闭 code=${code} reason=${reason}`);
        this.connected = false;
        for (const [, p] of this.pendingRpc) {
          clearTimeout(p.timer);
          p.reject(new Error('WS 连接断开'));
        }
        this.pendingRpc.clear();
      });
      ws.on('error', (err) => {
        log.warn(`WS 错误: ${err.message}`);
        if (!this.connected) reject(err);
      });
    });
  }

  _handleMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw.toString()); }
    catch { return; }
    if (!msg.requestId) return;
    const pending = this.pendingRpc.get(msg.requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingRpc.delete(msg.requestId);
    if (msg.type === MSG.ERROR) pending.reject(new Error(msg.error));
    else pending.resolve(msg);
  }

  async _rpc(type, payload = {}, { timeoutMs = 8000 } = {}) {
    await this.ensureConnected();
    const requestId = randomUUID();
    const req = { type, requestId, ...payload };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRpc.delete(requestId);
        reject(new Error(`RPC ${type} 超时`));
      }, timeoutMs);
      this.pendingRpc.set(requestId, { resolve, reject, timer });
      this.ws.send(JSON.stringify(req));
    });
  }

  // ===== 对外 API =====
  async send(body, attachments, topic) {
    await this.ensureConnected();
    this.ws.send(JSON.stringify({
      type: MSG.SEND,
      topic: topic || undefined,
      body: String(body || ''),
      attachments: Array.isArray(attachments) ? attachments : []
    }));
  }

  async listPeers() {
    const resp = await this._rpc(MSG.LIST_PEERS);
    return resp.peers || [];
  }

  async getHistory(count = 20, topic) {
    const resp = await this._rpc(MSG.GET_HISTORY, { count, topic: topic || undefined });
    return resp.messages || [];
  }

  // 话题房间
  async topicList() {
    const resp = await this._rpc(MSG.TOPIC_LIST);
    return { topics: resp.topics || [], joinedTopics: resp.joinedTopics || [] };
  }
  async topicCreate({ slug, title, description, autoJoin }) {
    const resp = await this._rpc(MSG.TOPIC_CREATE, { slug, title, description, autoJoin });
    return resp.topic;
  }
  async topicDelete(slug) {
    const resp = await this._rpc(MSG.TOPIC_DELETE, { slug });
    return !!resp.ok;
  }
  async topicJoin(slug) {
    const resp = await this._rpc(MSG.TOPIC_JOIN, { slug });
    return resp.topic;
  }
  async topicLeave(slug) {
    const resp = await this._rpc(MSG.TOPIC_LEAVE, { slug });
    return resp.topic;
  }
  async topicMetaGet(slug) {
    const resp = await this._rpc(MSG.TOPIC_META_GET, { slug });
    return { topic: resp.topic, todos: resp.todos || [], members: resp.members || [] };
  }
  async topicMetaSet(slug, { title, description, announcement }) {
    const resp = await this._rpc(MSG.TOPIC_META_SET, { slug, title, description, announcement });
    return resp.topic;
  }
  async topicTodoAdd(slug, content) {
    const resp = await this._rpc(MSG.TOPIC_TODO_ADD, { slug, content });
    return resp.todo;
  }
  async topicTodoUpdate(id, { content, done }) {
    const resp = await this._rpc(MSG.TOPIC_TODO_UPDATE, { id, content, done });
    return resp.todo;
  }
  async topicTodoDelete(id) {
    const resp = await this._rpc(MSG.TOPIC_TODO_DELETE, { id });
    return !!resp.ok;
  }
  async topicBatch(slug, ops) {
    const resp = await this._rpc(MSG.TOPIC_BATCH, { slug, ops }, { timeoutMs: 15000 });
    return { topic: resp.topic, results: resp.results || [] };
  }

  close() {
    this.shouldReconnect = false;
    try { if (this.ws) this.ws.close(1000, 'mcp shutdown'); } catch { /* ignore */ }
  }
}

module.exports = { WSSenderClient };
