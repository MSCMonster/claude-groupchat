// Subscriber 后台进程：连 WS server 作为 receiver
// 通知 / 队列 分离：
//   - 收到的事件 → 追加到 .cgc/inbox.jsonl
//   - stdout 仅打印极简通知行（一行 JSON），由 Monitor 触发 Claude
//   - Claude 收到通知后调用 MCP 工具 chat_pull 拉取实际内容
//
// stdout 通知行：
//   {"event":"new","unread":N,"latest":{"kind":"message|topic_*|peer_*","topic":"global","from":"..."},"preview":"..."}
//   {"event":"link","state":"connected","peers":N,"topics":N}
//   {"event":"link","state":"disconnected","reason":"..."}
'use strict';
require('dotenv').config();

// stdout 必须纯净（仅 JSON 通知）；logger 控制台输出走 stderr
process.env.LOG_TO_STDERR = 'true';

const WebSocket = require('ws');
const { MSG, ROLE, GLOBAL_TOPIC, buildPeer } = require('../shared/protocol');
const { Inbox } = require('../shared/inbox');
const { getWsUrl } = require('../shared/url');
const { getLogger } = require('../logger');

const log = getLogger('subscriber');

const WS_URL = getWsUrl();
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 15000;

const peer = buildPeer({ projectDir: process.cwd() });
const inbox = new Inbox(process.cwd());

let ws = null;
let backoff = RECONNECT_BASE_MS;
let stopped = false;
let connected = false;

// ===== 通知 =====
async function notifyNew(latestEntry) {
  const stats = await inbox.stats();
  const preview = buildPreview(latestEntry);
  const line = JSON.stringify({
    event: 'new',
    unread: stats.unread,
    latest: {
      kind: latestEntry.kind,
      topic: latestEntry.topic || null,
      from: latestEntry.from ? latestEntry.from.id : null,
      label: latestEntry.from ? latestEntry.from.label : null
    },
    preview
  });
  process.stdout.write(line + '\n');
}

function notifyLink(state, extra = {}) {
  const line = JSON.stringify({ event: 'link', state, ...extra });
  process.stdout.write(line + '\n');
}

function topicTag(topic) {
  return topic && topic !== GLOBAL_TOPIC ? `[#${topic}] ` : '';
}

function buildPreview(entry) {
  switch (entry.kind) {
    case 'message': {
      const text = String(entry.body || '').replace(/\s+/g, ' ').slice(0, 60);
      const tail = (entry.body || '').length > 60 ? '…' : '';
      const att = entry.attachments && entry.attachments.length
        ? ` (附件 ${entry.attachments.length})` : '';
      const sys = entry.isSystem ? '[系统] ' : '';
      return `${sys}${topicTag(entry.topic)}${text}${tail}${att}`;
    }
    case 'topic_created':
      return `话题创建：#${entry.topic && entry.topic.slug}`;
    case 'topic_deleted':
      return `话题删除：#${entry.topic && entry.topic.slug}`;
    case 'topic_member_joined':
      return `${entry.peerId} 加入 #${entry.topic && entry.topic.slug}`;
    case 'topic_member_left':
      return `${entry.peerId} 退出 #${entry.topic && entry.topic.slug}`;
    case 'topic_meta_updated':
      return `话题元数据更新：#${entry.topic && entry.topic.slug}`;
    case 'topic_todo_added':
      return `[#${entry.topic && entry.topic.slug}] 新 TODO：${truncate(entry.todo && entry.todo.content, 40)}`;
    case 'topic_todo_updated':
      return `[#${entry.topic && entry.topic.slug}] TODO 更新：${truncate(entry.todo && entry.todo.content, 40)}${entry.todo && entry.todo.done ? ' ✓' : ''}`;
    case 'topic_todo_deleted':
      return `[#${entry.topic && entry.topic.slug}] TODO 删除 id=${entry.todoId}`;
    case 'topic_batch': {
      const changes = Array.isArray(entry.changes) ? entry.changes : [];
      const counts = { todo_add: 0, todo_update: 0, todo_delete: 0, meta_set: 0 };
      for (const c of changes) { if (counts[c.op] !== undefined) counts[c.op] += 1; }
      const parts = [];
      if (counts.todo_add) parts.push(`+${counts.todo_add} TODO`);
      if (counts.todo_update) parts.push(`~${counts.todo_update} TODO`);
      if (counts.todo_delete) parts.push(`-${counts.todo_delete} TODO`);
      if (counts.meta_set) parts.push('meta');
      return `[#${entry.topic && entry.topic.slug}] 批量更新 ${changes.length} 项 (${parts.join(', ') || '无变更'})`;
    }
    case 'history':
      return `服务器历史 ${entry.messages ? entry.messages.length : 0} 条`;
    default:
      return entry.kind;
  }
}

function truncate(s, n) {
  if (!s) return '';
  return s.length > n ? s.slice(0, n) + '…' : s;
}

// ===== inbox 写入 =====
async function recordEvent(entry) {
  const saved = await inbox.append(entry);
  await notifyNew(saved);
}

// ===== 连接 =====
function connect() {
  if (stopped) return;
  log.info(`连接 WS ${WS_URL} as receiver peer=${peer.id}`);
  ws = new WebSocket(WS_URL);

  ws.on('open', () => {
    log.info('WS 已连接，发送 hello');
    backoff = RECONNECT_BASE_MS;
    ws.send(JSON.stringify({ type: MSG.HELLO, role: ROLE.RECEIVER, peer }));
  });

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); }
    catch { return log.warn(`非 JSON 消息: ${raw}`); }

    try {
      switch (msg.type) {
        case MSG.HELLO_ACK:
          connected = true;
          notifyLink('connected', {
            peers: (msg.peers || []).length,
            topics: (msg.topics || []).length,
            joinedTopics: msg.joinedTopics || []
          });
          break;
        case MSG.HISTORY:
          if (Array.isArray(msg.messages) && msg.messages.length) {
            for (const m of msg.messages) {
              await inbox.append({
                kind: 'message',
                id: m.id,
                topic: m.topic || GLOBAL_TOPIC,
                from: m.from,
                body: m.body,
                attachments: m.attachments || [],
                isSystem: !!m.isSystem,
                ts: m.ts,
                isHistory: true
              });
            }
            const stats = await inbox.stats();
            process.stdout.write(JSON.stringify({
              event: 'new',
              unread: stats.unread,
              latest: { kind: 'history', topic: msg.topic || GLOBAL_TOPIC, from: null, label: null },
              preview: `服务器历史回放 ${msg.messages.length} 条 (topic=${msg.topic || GLOBAL_TOPIC})`
            }) + '\n');
          }
          break;
        case MSG.MESSAGE:
          await recordEvent({
            kind: 'message',
            id: msg.id,
            topic: msg.topic || GLOBAL_TOPIC,
            from: msg.from,
            body: msg.body,
            attachments: msg.attachments || [],
            mentions: msg.mentions || [],
            isSystem: !!msg.isSystem,
            ts: msg.ts
          });
          break;
        case MSG.PEER_JOIN:
        case MSG.PEER_LEAVE:
          // v0.2.2 起服务端不再向 WS 客户端广播 peer 上下线（避免反复重连刷屏）。
          // 这里保留 case 仅做兼容性兜底：若对接到老服务端仍收到，则静默忽略。
          break;
        case MSG.TOPIC_EVENT:
          // 子类型直接用作 entry.kind；topic_batch 额外带 changes 数组
          await recordEvent({
            kind: msg.kind || 'topic_event',
            topic: msg.topic || null,
            peerId: msg.peerId || null,
            todo: msg.todo || null,
            todoId: msg.todoId || null,
            changes: Array.isArray(msg.changes) ? msg.changes : undefined,
            by: msg.by || null
          });
          break;
        case MSG.ERROR:
          log.warn(`server 错误: ${msg.error}`);
          break;
        default:
          log.warn(`未识别消息类型: ${msg.type}`);
      }
    } catch (e) {
      log.error(`处理消息失败: ${e.stack || e.message}`);
    }
  });

  ws.on('close', (code, reason) => {
    log.info(`WS 关闭 code=${code} reason=${reason}`);
    if (connected) {
      notifyLink('disconnected', { code, reason: String(reason || '') });
    }
    connected = false;
    scheduleReconnect();
  });

  ws.on('error', (e) => log.warn(`WS 错误: ${e.message}`));
}

function scheduleReconnect() {
  if (stopped) return;
  const delay = backoff;
  backoff = Math.min(backoff * 2, RECONNECT_MAX_MS);
  log.info(`${delay}ms 后重连`);
  setTimeout(connect, delay);
}

function shutdown(sig) {
  log.info(`收到 ${sig}，退出`);
  stopped = true;
  try { if (ws) ws.close(1000, 'subscriber shutdown'); } catch { /* ignore */ }
  setTimeout(() => process.exit(0), 200);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

log.info(`subscriber 启动 peer=${peer.id} inbox=${inbox.file}`);
connect();
