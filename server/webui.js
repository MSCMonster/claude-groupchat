// WebUI HTTP 路由：登录、聊天 API、管理面板 API、SSE 实时流
// 鉴权：express-session（内存存储，单进程足够）
'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { GLOBAL_TOPIC, SYSTEM_PEER_ID } = require('../shared/protocol');
const { getLogger } = require('../logger');

const log = getLogger('webui');

function buildWebUIRouter({ storage, room, getHttpBase }) {
  const router = express.Router();

  // ===== 静态资源（聊天页 + 管理页 + js/css） =====
  const webDir = path.join(__dirname, '..', 'web');
  // 公开页面：登录页 / 静态资源
  router.use('/static', express.static(path.join(webDir, 'static')));
  router.get('/login', (req, res) => res.sendFile(path.join(webDir, 'login.html')));

  // ===== 登录 API =====
  router.post('/api/login', express.json(), (req, res) => {
    const { username, password } = req.body || {};
    const validUser = process.env.WEB_USERNAME || 'admin';
    const validPass = process.env.WEB_PASSWORD || 'changeme';
    if (username === validUser && password === validPass) {
      req.session.user = username;
      return res.json({ ok: true, user: username });
    }
    res.status(401).json({ ok: false, error: '用户名或密码错误' });
  });

  router.post('/api/logout', (req, res) => {
    req.session.destroy(() => res.json({ ok: true }));
  });

  router.get('/api/session', (req, res) => {
    res.json({
      authenticated: !!(req.session && req.session.user),
      user: req.session && req.session.user || null
    });
  });

  // 受保护路由统一中间件
  function requireAuth(req, res, next) {
    if (req.session && req.session.user) return next();
    if (req.accepts('html') && req.method === 'GET') return res.redirect('/web/login');
    res.status(401).json({ error: '未登录' });
  }

  // ===== 聊天页 / 管理页 =====
  router.get('/', requireAuth, (req, res) => res.sendFile(path.join(webDir, 'chat.html')));
  router.get('/admin', requireAuth, (req, res) => res.sendFile(path.join(webDir, 'admin.html')));

  // ===== 受保护 API =====
  router.use('/api', (req, res, next) => {
    // 例外：登录、登出、session 已在前面处理；其余需鉴权
    if (req.path === '/login' || req.path === '/logout' || req.path === '/session') return next();
    return requireAuth(req, res, next);
  });

  // ----- 话题房间 -----
  router.get('/api/topics', (req, res) => {
    res.json({ topics: storage.listTopics() });
  });

  router.post('/api/topics', express.json(), (req, res) => {
    const { slug, title, description } = req.body || {};
    try {
      const topic = room.createTopic({
        slug, title, description,
        createdBy: SYSTEM_PEER_ID, autoJoin: false
      });
      res.json({ ok: true, topic });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.delete('/api/topics/:slug', (req, res) => {
    try {
      const ok = room.deleteTopic(req.params.slug, SYSTEM_PEER_ID);
      if (!ok) return res.status(404).json({ error: '话题不存在' });
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.patch('/api/topics/:slug', express.json(), (req, res) => {
    const { title, description, announcement } = req.body || {};
    try {
      const topic = room.updateTopicMeta(req.params.slug, { title, description, announcement }, SYSTEM_PEER_ID);
      res.json({ ok: true, topic });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.get('/api/topics/:slug/members', (req, res) => {
    const slug = req.params.slug;
    if (!storage.getTopic(slug)) return res.status(404).json({ error: '话题不存在' });
    // 0.3.0 起默认聊天室 global 也是成员制，统一走 listMembers
    res.json({ members: storage.listMembers(slug) });
  });

  router.post('/api/topics/:slug/members', express.json(), (req, res) => {
    const { peerId } = req.body || {};
    if (!peerId) return res.status(400).json({ error: 'peerId 必填' });
    try {
      room.joinTopic(req.params.slug, peerId);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.delete('/api/topics/:slug/members/:peerId', (req, res) => {
    try {
      room.leaveTopic(req.params.slug, req.params.peerId);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // ----- TODO -----
  router.get('/api/topics/:slug/todos', (req, res) => {
    const slug = req.params.slug;
    if (!storage.getTopic(slug)) return res.status(404).json({ error: '话题不存在' });
    res.json({ todos: storage.listTodos(slug) });
  });

  router.post('/api/topics/:slug/todos', express.json(), (req, res) => {
    const { content } = req.body || {};
    if (!content) return res.status(400).json({ error: 'content 必填' });
    try {
      const todo = room.addTodo({
        topicSlug: req.params.slug, content, createdBy: SYSTEM_PEER_ID
      });
      res.json({ ok: true, todo });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.patch('/api/todos/:id', express.json(), (req, res) => {
    const id = Number(req.params.id);
    const { content, done } = req.body || {};
    try {
      const todo = room.updateTodo(id, { content, done });
      res.json({ ok: true, todo });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.delete('/api/todos/:id', (req, res) => {
    const id = Number(req.params.id);
    try {
      const ok = room.deleteTodo(id);
      if (!ok) return res.status(404).json({ error: 'TODO 不存在' });
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // ----- 消息（分页历史 + 系统发送） -----
  router.get('/api/messages', (req, res) => {
    const topic = String(req.query.topic || GLOBAL_TOPIC);
    const beforeTs = req.query.beforeTs ? Number(req.query.beforeTs) : undefined;
    const pageSize = req.query.pageSize ? Number(req.query.pageSize) : undefined;
    const result = storage.listMessagesPage({ topic, beforeTs, pageSize });
    res.json(result);
  });

  router.post('/api/messages', express.json(), async (req, res) => {
    const { topic, body, attachments } = req.body || {};
    try {
      const message = await room.systemSend({ topic, body, attachments });
      res.json({ ok: true, message });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // ----- Peers -----
  router.get('/api/peers', (req, res) => {
    const stored = storage.listAllPeers();
    const onlineSet = new Set(room.listPeerSnapshots().map(p => p.id));
    const list = stored.map(p => ({ ...p, isOnline: onlineSet.has(p.id) }));
    res.json({ peers: list });
  });

  router.get('/api/peers/:id', (req, res) => {
    const peer = storage.getPeer(req.params.id);
    if (!peer) return res.status(404).json({ error: 'peer 不存在' });
    const onlineSet = new Set(room.listPeerSnapshots().map(p => p.id));
    const topicsJoined = storage.listTopicsForPeer(req.params.id);
    res.json({
      peer: { ...peer, isOnline: onlineSet.has(peer.id) },
      topics: topicsJoined
    });
  });

  // ----- 文件 -----
  router.get('/api/files', (req, res) => {
    const limit = req.query.limit ? Number(req.query.limit) : 100;
    res.json({ files: storage.listFiles({ limit }) });
  });

  router.delete('/api/files/:fileId', async (req, res) => {
    try {
      const ok = await storage.deleteFile(req.params.fileId);
      if (!ok) return res.status(404).json({ error: '文件不存在' });
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // 上传：直接转 storage.registerFile（独立 multer 实例避免与 /upload 路由冲突）
  const maxBytes = Number(process.env.MAX_FILE_SIZE_MB || 50) * 1024 * 1024;
  const uploadMw = multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => cb(null, storage.uploadDir),
      filename: (req, file, cb) => {
        const ext = path.extname(file.originalname) || '';
        cb(null, `${uuidv4()}${ext}`);
      }
    }),
    limits: { fileSize: maxBytes }
  });

  router.post('/api/files', uploadMw.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: '缺少 file 字段' });
    const originalName = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
    try {
      const meta = storage.registerFile({
        originalName,
        mimeType: req.file.mimetype,
        size: req.file.size,
        storedPath: req.file.path,
        uploadedBy: `webui:${req.session.user}`
      });
      res.json({
        ok: true,
        fileId: meta.fileId,
        filename: meta.filename,
        size: meta.size,
        mimeType: meta.mimeType,
        downloadUrl: `${getHttpBase(req)}/download?fileId=${meta.fileId}`
      });
    } catch (err) {
      try { fs.unlinkSync(req.file.path); } catch { /* ignore */ }
      res.status(500).json({ error: err.message });
    }
  });

  // ===== SSE 实时事件流 =====
  router.get('/api/stream', (req, res) => {
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.flushHeaders();
    res.write(`event: hello\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`);

    const listener = (event) => {
      try { res.write(`data: ${JSON.stringify(event)}\n\n`); }
      catch { /* ignore */ }
    };
    room.addEventListener(listener);

    const ka = setInterval(() => {
      try { res.write(': keep-alive\n\n'); } catch { /* ignore */ }
    }, 25_000);

    req.on('close', () => {
      clearInterval(ka);
      room.removeEventListener(listener);
      log.debug('SSE 客户端断开');
    });
  });

  return router;
}

module.exports = { buildWebUIRouter };
