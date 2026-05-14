// claude-groupchat server 入口：WS + HTTP + Redis + 24h 清理
'use strict';
require('dotenv').config();

const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');

const { Storage } = require('./storage');
const { Room } = require('./room');
const { buildRouter } = require('./upload');
const { MSG, ROLE } = require('../shared/protocol');
const { getLogger, httpLogger } = require('../logger');

const log = getLogger('server');

// ===== 解析配置 =====
const BIND_HOST = process.env.BIND_HOST || '0.0.0.0';
// WS 与 HTTP 共用同一端口（HTTP server upgrade 事件转发给 ws）
const PORT = Number(process.env.PORT || 7600);
const CLEANUP_INTERVAL_MS =
  Number(process.env.CLEANUP_INTERVAL_MINUTES || 30) * 60 * 1000;

// ===== 启动流程 =====
async function main() {
  const storage = new Storage();

  // 等 redis 真正可用（ioredis 默认会自动重连，给一个小窗口让首次连接完成）
  await waitForRedis(storage.redis);
  // server 启动即清空（消息、文件索引、文件本体）
  await storage.resetAll();

  const room = new Room({ storage });

  // ===== HTTP 服务 =====
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(httpLogger());
  app.use(buildRouter({ storage }));
  app.get('/health', (req, res) => res.json({
    ok: true,
    peers: room.listPeerSnapshots().length,
    ts: Date.now()
  }));

  const httpServer = http.createServer(app);

  // ===== WS 服务（共用同一端口，挂在 HTTP server 的 upgrade 事件上）=====
  const wss = new WebSocketServer({ noServer: true });
  wss.on('connection', (ws, req) => handleConnection(ws, req, room, storage));
  httpServer.on('upgrade', (req, socket, head) => {
    // 只接受根路径或 /ws 的升级请求；其它路径直接拒绝
    const url = req.url || '/';
    if (url !== '/' && url !== '/ws') {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  httpServer.listen(PORT, BIND_HOST, () => {
    log.info(`HTTP + WS 监听 :${PORT}（bind=${BIND_HOST}，http://${BIND_HOST}:${PORT} 同址 ws://${BIND_HOST}:${PORT}）`);
  });

  // 心跳：每 30s 给所有连接发 ping，未在 60s 内回应则断开
  const pingInterval = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        try { ws.terminate(); } catch { /* ignore */ }
        continue;
      }
      ws.isAlive = false;
      try { ws.ping(); } catch { /* ignore */ }
    }
  }, 30 * 1000);
  wss.on('close', () => clearInterval(pingInterval));

  // ===== 清理任务 =====
  const cleanupTimer = setInterval(() => {
    storage.cleanupExpiredFiles().catch(err => log.error(`清理失败: ${err.message}`));
  }, CLEANUP_INTERVAL_MS);
  // 启动后立即跑一次（防止重启间隔内残留）
  storage.cleanupExpiredFiles().catch(err => log.error(`首次清理失败: ${err.message}`));

  // ===== 优雅退出 =====
  const shutdown = async (sig) => {
    log.info(`收到 ${sig}，关闭中`);
    clearInterval(cleanupTimer);
    for (const ws of wss.clients) {
      try { ws.close(1001, 'server shutdown'); } catch { /* ignore */ }
    }
    wss.close();
    httpServer.close();
    await storage.close();
    setTimeout(() => process.exit(0), 500);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// ===== 等待 Redis 可用 =====
function waitForRedis(redis, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    if (redis.status === 'ready') return resolve();
    const t = setTimeout(() => reject(new Error('Redis 连接超时')), timeoutMs);
    redis.once('ready', () => { clearTimeout(t); resolve(); });
    redis.once('error', (err) => { clearTimeout(t); reject(err); });
  });
}

// ===== WS 连接处理 =====
function handleConnection(ws, req, room, storage) {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  const remote = req.socket.remoteAddress;
  log.debug(`WS 新连接 from=${remote}`);

  // 等待 HELLO 才确定身份
  let helloed = false;

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (err) {
      return sendError(ws, null, '消息不是合法 JSON');
    }

    try {
      if (!helloed) {
        if (msg.type !== MSG.HELLO) {
          return sendError(ws, msg.requestId, '请先发送 hello 完成握手');
        }
        const role = msg.role;
        const peer = msg.peer;
        if (!peer || !peer.id) return sendError(ws, msg.requestId, 'hello.peer.id 缺失');

        await room.registerConnection(ws, role, peer);
        helloed = true;

        // HELLO_ACK：握手确认 + 当前在线快照（receiver 在 PEER_JOIN 广播里也会再收到一次）
        sendJson(ws, {
          type: MSG.HELLO_ACK,
          peer: peer,
          peers: room.listPeerSnapshots(),
          serverTime: Date.now()
        });

        // 仅 receiver 推送历史
        if (role === ROLE.RECEIVER) {
          const history = await storage.recentMessages(storage.historyPush);
          if (history.length) sendJson(ws, { type: MSG.HISTORY, messages: history });
        }
        return;
      }

      const info = getConnInfoFromWs(ws, room);
      if (!info) return sendError(ws, msg.requestId, '连接尚未完成握手');

      switch (msg.type) {
        case MSG.SEND: {
          await room.handleSend(info.peerId, msg.body, msg.attachments);
          break;
        }
        case MSG.LIST_PEERS: {
          sendJson(ws, {
            type: MSG.PEERS,
            requestId: msg.requestId,
            peers: room.listPeerSnapshots()
          });
          break;
        }
        case MSG.GET_HISTORY: {
          const count = Number(msg.count) || storage.historyPush;
          const messages = await storage.recentMessages(count);
          sendJson(ws, { type: MSG.HISTORY, requestId: msg.requestId, messages });
          break;
        }
        default:
          sendError(ws, msg.requestId, `未知消息类型: ${msg.type}`);
      }
    } catch (err) {
      log.error(`处理消息异常: ${err.message}`);
      sendError(ws, msg && msg.requestId, err.message);
    }
  });

  ws.on('close', () => {
    log.debug(`WS 关闭 from=${remote}`);
    room.removeConnection(ws);
  });

  ws.on('error', (err) => {
    log.warn(`WS 错误 from=${remote}: ${err.message}`);
  });
}

// connInfo 在 Room 内是 WeakMap，外部读取需要小动作
function getConnInfoFromWs(ws, room) {
  return room.connInfo.get(ws);
}

function sendJson(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}
function sendError(ws, requestId, error) {
  sendJson(ws, { type: MSG.ERROR, requestId, error });
}

main().catch(err => {
  log.error(`启动失败: ${err.stack || err.message}`);
  process.exit(1);
});
