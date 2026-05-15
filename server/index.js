// claude-groupchat server 入口：WS + HTTP（含 WebUI）+ SQLite
'use strict';
require('dotenv').config();

const http = require('http');
const path = require('path');
const express = require('express');
const session = require('express-session');
const { WebSocketServer } = require('ws');

const { Storage } = require('./storage');
const { Room } = require('./room');
const { buildRouter } = require('./upload');
const { buildWebUIRouter } = require('./webui');
const { MSG, ROLE, GLOBAL_TOPIC, SYSTEM_PEER_ID } = require('../shared/protocol');
const { getLogger, httpLogger } = require('../logger');

const log = getLogger('server');

// ===== 配置 =====
const BIND_HOST = process.env.BIND_HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 7600);

// ===== 启动 =====
async function main() {
  const storage = new Storage();
  const room = new Room({ storage });

  // ===== HTTP =====
  const app = express();
  app.use(httpLogger());

  app.use(session({
    name: 'cgc.sid',
    secret: process.env.WEB_SESSION_SECRET || 'cgc-default-secret-please-change',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 7 * 24 * 3600 * 1000
    }
  }));

  // 健康检查
  app.get('/health', (req, res) => res.json({
    ok: true,
    peers: room.listPeerSnapshots().length,
    topics: storage.listTopics().length,
    ts: Date.now()
  }));

  // 文件上传/下载接口（兼容旧 MCP）
  app.use(buildRouter({ storage }));

  // WebUI（/web/*）
  app.use('/web', buildWebUIRouter({ storage, room, getHttpBase }));
  // 根路径友好跳转
  app.get('/', (req, res) => res.redirect('/web/'));

  const httpServer = http.createServer(app);

  // ===== WebSocket 共用同一端口 =====
  const wss = new WebSocketServer({ noServer: true });
  wss.on('connection', (ws, req) => handleConnection(ws, req, room, storage));
  httpServer.on('upgrade', (req, socket, head) => {
    const url = req.url || '/';
    if (url !== '/' && url !== '/ws') {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  httpServer.listen(PORT, BIND_HOST, () => {
    log.info(`监听 :${PORT}（bind=${BIND_HOST}） — HTTP + WS + WebUI 同端口`);
    log.info(`WebUI: http://${BIND_HOST === '0.0.0.0' ? '127.0.0.1' : BIND_HOST}:${PORT}/web/`);
  });

  // 心跳：30s ping，60s 未回应断开
  const pingInterval = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) { try { ws.terminate(); } catch {} continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch {}
    }
  }, 30 * 1000);
  wss.on('close', () => clearInterval(pingInterval));

  // ===== 优雅退出 =====
  const shutdown = async (sig) => {
    log.info(`收到 ${sig}，关闭中`);
    clearInterval(pingInterval);
    for (const ws of wss.clients) {
      try { ws.close(1001, 'server shutdown'); } catch {}
    }
    wss.close();
    httpServer.close();
    await storage.close();
    setTimeout(() => process.exit(0), 500);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// 推断当前请求的 http base（用于拼下载 URL）
function getHttpBase(req) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const host = req.headers.host;
  return `${proto}://${host}`;
}

// ===== WS 连接处理 =====
function handleConnection(ws, req, room, storage) {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  const remote = req.socket.remoteAddress;
  log.debug(`WS 新连接 from=${remote}`);

  let helloed = false;

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); }
    catch { return sendError(ws, null, '消息不是合法 JSON'); }

    try {
      if (!helloed) {
        if (msg.type !== MSG.HELLO) {
          return sendError(ws, msg.requestId, '请先发送 hello 完成握手');
        }
        const role = msg.role;
        const peer = msg.peer;
        if (!peer || !peer.id) return sendError(ws, msg.requestId, 'hello.peer.id 缺失');
        if (peer.id === SYSTEM_PEER_ID) return sendError(ws, msg.requestId, '保留 peerId：system');

        await room.registerConnection(ws, role, peer);
        helloed = true;

        sendJson(ws, {
          type: MSG.HELLO_ACK,
          peer,
          peers: room.listPeerSnapshots(),
          topics: storage.listTopics(),
          joinedTopics: storage.listTopicsForPeer(peer.id).map(t => t.slug),
          serverTime: Date.now()
        });

        // receiver 推全局历史
        if (role === ROLE.RECEIVER) {
          const history = storage.recentMessages({ topic: GLOBAL_TOPIC, limit: storage.historyPush });
          if (history.length) sendJson(ws, { type: MSG.HISTORY, topic: GLOBAL_TOPIC, messages: history });
        }
        return;
      }

      const info = room.connInfo.get(ws);
      if (!info) return sendError(ws, msg.requestId, '连接尚未完成握手');

      switch (msg.type) {
        case MSG.SEND: {
          await room.handleSend(info.peerId, msg.body, msg.attachments, msg.topic);
          break;
        }
        case MSG.LIST_PEERS: {
          sendJson(ws, {
            type: MSG.PEERS, requestId: msg.requestId,
            peers: room.listPeerSnapshots()
          });
          break;
        }
        case MSG.GET_HISTORY: {
          const topic = msg.topic || GLOBAL_TOPIC;
          const count = Number(msg.count) || storage.historyPush;
          const messages = storage.recentMessages({ topic, limit: count });
          sendJson(ws, { type: MSG.HISTORY, requestId: msg.requestId, topic, messages });
          break;
        }

        // ----- 话题房间 -----
        case MSG.TOPIC_LIST: {
          sendJson(ws, {
            type: MSG.TOPICS, requestId: msg.requestId,
            topics: storage.listTopics(),
            joinedTopics: storage.listTopicsForPeer(info.peerId).map(t => t.slug)
          });
          break;
        }
        case MSG.TOPIC_META_GET: {
          const slug = msg.slug;
          const topic = storage.getTopic(slug);
          if (!topic) return sendError(ws, msg.requestId, `话题不存在: ${slug}`);
          const todos = storage.listTodos(slug);
          const members = slug === GLOBAL_TOPIC ? [] : storage.listMembers(slug);
          sendJson(ws, {
            type: MSG.TOPIC_META, requestId: msg.requestId,
            topic, todos, members
          });
          break;
        }
        case MSG.TOPIC_CREATE: {
          const topic = room.createTopic({
            slug: msg.slug, title: msg.title, description: msg.description,
            createdBy: info.peerId, autoJoin: msg.autoJoin !== false
          });
          sendJson(ws, { type: MSG.TOPIC_EVENT, requestId: msg.requestId, kind: 'topic_created', topic });
          break;
        }
        case MSG.TOPIC_DELETE: {
          const ok = room.deleteTopic(msg.slug, info.peerId);
          sendJson(ws, { type: MSG.TOPIC_EVENT, requestId: msg.requestId, kind: 'topic_deleted', ok });
          break;
        }
        case MSG.TOPIC_JOIN: {
          room.joinTopic(msg.slug, info.peerId);
          sendJson(ws, {
            type: MSG.TOPIC_EVENT, requestId: msg.requestId,
            kind: 'topic_member_joined', topic: storage.getTopic(msg.slug), peerId: info.peerId
          });
          break;
        }
        case MSG.TOPIC_LEAVE: {
          room.leaveTopic(msg.slug, info.peerId);
          sendJson(ws, {
            type: MSG.TOPIC_EVENT, requestId: msg.requestId,
            kind: 'topic_member_left', topic: storage.getTopic(msg.slug), peerId: info.peerId
          });
          break;
        }
        case MSG.TOPIC_META_SET: {
          const topic = room.updateTopicMeta(msg.slug, {
            title: msg.title, description: msg.description, announcement: msg.announcement
          }, info.peerId);
          sendJson(ws, { type: MSG.TOPIC_EVENT, requestId: msg.requestId, kind: 'topic_meta_updated', topic });
          break;
        }
        case MSG.TOPIC_TODO_ADD: {
          const todo = room.addTodo({ topicSlug: msg.slug, content: msg.content, createdBy: info.peerId });
          sendJson(ws, { type: MSG.TOPIC_EVENT, requestId: msg.requestId, kind: 'topic_todo_added', todo });
          break;
        }
        case MSG.TOPIC_TODO_UPDATE: {
          const todo = room.updateTodo(Number(msg.id), { content: msg.content, done: msg.done });
          sendJson(ws, { type: MSG.TOPIC_EVENT, requestId: msg.requestId, kind: 'topic_todo_updated', todo });
          break;
        }
        case MSG.TOPIC_TODO_DELETE: {
          const ok = room.deleteTodo(Number(msg.id));
          sendJson(ws, { type: MSG.TOPIC_EVENT, requestId: msg.requestId, kind: 'topic_todo_deleted', ok });
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
