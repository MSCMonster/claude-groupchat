// WS 消息协议常量与构造工具
// server 与 client 必须使用同一份定义
'use strict';

// ===== 消息类型 =====
const MSG = {
  // Client → Server
  HELLO: 'hello',                // 握手，附带 peer 元数据与 role
  SEND: 'send',                  // 发送一条群聊消息（可指定 topic）
  LIST_PEERS: 'list_peers',      // 请求在线 peer 列表
  GET_HISTORY: 'get_history',    // 请求最近 N 条历史（可指定 topic）

  // 话题房间相关（Client → Server，均走 RPC）
  TOPIC_CREATE: 'topic_create',
  TOPIC_DELETE: 'topic_delete',
  TOPIC_JOIN: 'topic_join',
  TOPIC_LEAVE: 'topic_leave',
  TOPIC_LIST: 'topic_list',
  TOPIC_META_GET: 'topic_meta_get',
  TOPIC_META_SET: 'topic_meta_set',
  TOPIC_TODO_ADD: 'topic_todo_add',
  TOPIC_TODO_UPDATE: 'topic_todo_update',
  TOPIC_TODO_DELETE: 'topic_todo_delete',

  // Server → Client
  HELLO_ACK: 'hello_ack',        // 握手响应
  HISTORY: 'history',            // 历史消息（join 时自动推送 + get_history 响应）
  MESSAGE: 'message',            // 广播：一条消息（含 topic 字段）
  PEER_JOIN: 'peer_join',        // 广播：peer 加入
  PEER_LEAVE: 'peer_leave',      // 广播：peer 离开
  PEERS: 'peers',                // list_peers 响应
  TOPIC_EVENT: 'topic_event',    // 广播：话题房间事件（created/deleted/meta/member）
  TOPICS: 'topics',              // topic_list 响应
  TOPIC_META: 'topic_meta',      // topic_meta_get 响应
  ERROR: 'error'                 // 错误响应
};

// ===== 客户端角色 =====
// sender：MCP server 进程，发消息和发起 RPC
// receiver：subscriber 进程，接收广播
const ROLE = {
  SENDER: 'sender',
  RECEIVER: 'receiver'
};

// ===== 内置房间与系统身份 =====
const GLOBAL_TOPIC = 'global';
const SYSTEM_PEER_ID = 'system';
const SYSTEM_PEER_LABEL = '系统';

// 系统消息伪 peer（WebUI 注入消息时使用）
function systemPeer() {
  return {
    id: SYSTEM_PEER_ID,
    hostname: 'webui',
    projectDir: '',
    label: SYSTEM_PEER_LABEL
  };
}

// ===== peerId 自动推断 =====
// 主机名 + 项目目录名（不含完整路径）拼接成稳定标识
const os = require('os');
const path = require('path');
function inferPeerId(projectDir) {
  const host = os.hostname();
  const proj = path.basename(projectDir || process.cwd());
  return `${host}:${proj}`;
}

// 构造完整 peer 描述
function buildPeer({ id, label, projectDir }) {
  const peerId = id || process.env.CHAT_PEER_ID || inferPeerId(projectDir);
  return {
    id: peerId,
    hostname: os.hostname(),
    projectDir: projectDir || process.cwd(),
    label: label || process.env.CHAT_PEER_LABEL || ''
  };
}

// 从消息正文里提取 @topic:<slug> 提及（用于"邀请进话题"语法）
const TOPIC_MENTION_RE = /@topic:([a-zA-Z0-9_\-:.]{1,64})/g;
function extractTopicMentions(body) {
  const out = new Set();
  if (!body) return [];
  let m;
  TOPIC_MENTION_RE.lastIndex = 0;
  while ((m = TOPIC_MENTION_RE.exec(body)) !== null) {
    out.add(m[1]);
  }
  return Array.from(out);
}

module.exports = {
  MSG, ROLE,
  GLOBAL_TOPIC, SYSTEM_PEER_ID, SYSTEM_PEER_LABEL,
  systemPeer, inferPeerId, buildPeer,
  extractTopicMentions
};
