// WS 消息协议常量与构造工具
// server 与 client 必须使用同一份定义
'use strict';

// ===== 消息类型 =====
const MSG = {
  // Client → Server
  HELLO: 'hello',                // 握手，附带 peer 元数据与 role
  SEND: 'send',                  // 发送一条群聊消息
  LIST_PEERS: 'list_peers',      // 请求在线 peer 列表
  GET_HISTORY: 'get_history',    // 请求最近 N 条历史

  // Server → Client
  HELLO_ACK: 'hello_ack',        // 握手响应
  HISTORY: 'history',            // 历史消息（join 时自动推送 + get_history 响应）
  MESSAGE: 'message',            // 广播：他人发送的消息
  PEER_JOIN: 'peer_join',        // 广播：peer 加入
  PEER_LEAVE: 'peer_leave',      // 广播：peer 离开
  PEERS: 'peers',                // list_peers 响应
  ERROR: 'error'                 // 错误响应
};

// ===== 客户端角色 =====
// sender：MCP server 进程，发消息和发起 RPC
// receiver：subscriber 进程，接收广播
const ROLE = {
  SENDER: 'sender',
  RECEIVER: 'receiver'
};

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

module.exports = { MSG, ROLE, inferPeerId, buildPeer };
