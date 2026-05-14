// WS sender 客户端：MCP server 内部使用
// 负责连接到 chat server、发送消息、调用 RPC（list_peers / get_history）
'use strict';
const { randomUUID } = require('crypto');
const WebSocket = require('ws');
const { MSG, ROLE, buildPeer } = require('../shared/protocol');
const { getLogger } = require('../logger');

const log = getLogger('ws-client');

class WSSenderClient {
  constructor(opts = {}) {
    this.url = opts.url
      || process.env.CHAT_SERVER_WS
      || `ws://${process.env.WS_HOST || '127.0.0.1'}:${process.env.WS_PORT || 7600}`;
    this.peer = buildPeer({ projectDir: process.cwd() });
    this.ws = null;
    this.connected = false;
    this.pendingRpc = new Map(); // requestId -> { resolve, reject, timer }
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
        // 把所有 pending RPC 用错误结束
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

  async _rpc(type, payload = {}, { timeoutMs = 5000 } = {}) {
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
  async send(body, attachments) {
    await this.ensureConnected();
    // SEND 是单向广播，server 不回 ack；不等响应
    this.ws.send(JSON.stringify({
      type: MSG.SEND,
      body: String(body || ''),
      attachments: Array.isArray(attachments) ? attachments : []
    }));
  }

  async listPeers() {
    const resp = await this._rpc(MSG.LIST_PEERS);
    return resp.peers || [];
  }

  async getHistory(count = 20) {
    const resp = await this._rpc(MSG.GET_HISTORY, { count });
    return resp.messages || [];
  }

  close() {
    this.shouldReconnect = false;
    try { if (this.ws) this.ws.close(1000, 'mcp shutdown'); } catch { /* ignore */ }
  }
}

module.exports = { WSSenderClient };
