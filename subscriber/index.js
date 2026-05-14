// Subscriber 后台进程：连 WS server 作为 receiver
// 设计：通知 / 队列 分离
//   - 所有收到的事件 → 追加到本地 inbox 队列文件（.cgc/inbox.jsonl）
//   - stdout 仅打印极简通知行（"有 N 条未读，最新来自 X"），用于 Monitor 触发 Claude
//   - Claude 收到通知后调用 MCP 工具 pull_messages 拉取实际内容
//
// stdout 通知行格式（每行一个 JSON 对象）:
//   {"event":"new","unread":N,"latest":{"kind":"message|peer_join|peer_leave","from":"..."},"preview":"..."}
//   {"event":"link","state":"connected","peers":N}
//   {"event":"link","state":"disconnected","reason":"..."}
//
// 通知极简化原因：让 Monitor 一次推送的 token 量最小、避免污染 Claude 上下文；
// 详情由 Claude 主动 pull。
'use strict';
require('dotenv').config();

// 强制 logger 控制台输出走 stderr，保证 stdout 纯净
process.env.LOG_TO_STDERR = 'true';

const WebSocket = require('ws');
const { MSG, ROLE, buildPeer } = require('../shared/protocol');
const { Inbox } = require('../shared/inbox');
const { getLogger } = require('../logger');

const log = getLogger('subscriber');

const WS_URL = process.env.CHAT_SERVER_WS
  || `ws://${process.env.WS_HOST || '127.0.0.1'}:${process.env.WS_PORT || 7600}`;
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

function buildPreview(entry) {
  switch (entry.kind) {
    case 'message': {
      const text = String(entry.body || '').replace(/\s+/g, ' ').slice(0, 60);
      const tail = (entry.body || '').length > 60 ? '…' : '';
      const att = entry.attachments && entry.attachments.length
        ? ` (附件 ${entry.attachments.length})` : '';
      return text + tail + att;
    }
    case 'peer_join':
      return `${entry.peer.id} 加入聊天室`;
    case 'peer_leave':
      return `${entry.peer.id} 离开聊天室`;
    case 'history':
      return `服务器历史 ${entry.messages.length} 条`;
    default:
      return entry.kind;
  }
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
          notifyLink('connected', { peers: (msg.peers || []).length });
          break;
        case MSG.HISTORY:
          if (Array.isArray(msg.messages) && msg.messages.length) {
            // 历史消息逐条写入 inbox（kind=message），但通知合并成一条
            for (const m of msg.messages) {
              await inbox.append({
                kind: 'message',
                id: m.id,
                from: m.from,
                body: m.body,
                attachments: m.attachments || [],
                ts: m.ts,
                isHistory: true
              });
            }
            const stats = await inbox.stats();
            process.stdout.write(JSON.stringify({
              event: 'new',
              unread: stats.unread,
              latest: { kind: 'history', from: null, label: null },
              preview: `服务器历史回放 ${msg.messages.length} 条`
            }) + '\n');
          }
          break;
        case MSG.MESSAGE:
          await recordEvent({
            kind: 'message',
            id: msg.id,
            from: msg.from,
            body: msg.body,
            attachments: msg.attachments || [],
            ts: msg.ts
          });
          break;
        case MSG.PEER_JOIN:
          await recordEvent({
            kind: 'peer_join',
            peer: msg.peer,
            peers: msg.peers || []
          });
          break;
        case MSG.PEER_LEAVE:
          await recordEvent({
            kind: 'peer_leave',
            peer: msg.peer,
            peers: msg.peers || []
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
