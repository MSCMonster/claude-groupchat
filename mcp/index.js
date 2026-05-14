// MCP server 入口（stdio transport）
// 暴露聊天工具给 Claude Code 调用
'use strict';
require('dotenv').config();

// MCP server 通过 stdio 与 Claude Code 通信，stdout 是协议通道
// 必须让 logger 控制台输出走 stderr，避免污染 MCP 协议
process.env.LOG_TO_STDERR = 'true';

const path = require('path');
const { z } = require('zod');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');

const { Inbox } = require('../shared/inbox');
const { WSSenderClient } = require('./ws-client');
const { uploadFile, downloadFile } = require('./http-client');
const { getHttpUrl } = require('../shared/url');
const { getLogger } = require('../logger');

const log = getLogger('mcp');

const inbox = new Inbox(process.cwd());
const ws = new WSSenderClient();

const server = new McpServer(
  { name: 'claude-groupchat', version: '0.1.0' },
  { capabilities: { tools: {} } }
);

// ===== 工具：发送消息 =====
server.registerTool('chat_send', {
  description: '向群聊广播一条消息（除自己之外的所有客户端会收到）。' +
    '可选 attachments 是本地文件路径数组，工具会上传后把 fileId/url 附加到消息里。',
  inputSchema: {
    body: z.string().describe('消息正文'),
    attachments: z.array(z.string()).optional()
      .describe('可选：本地文件路径数组，会上传并附在消息里发出')
  }
}, async ({ body, attachments }) => {
  const uploaded = [];
  if (Array.isArray(attachments) && attachments.length) {
    for (const p of attachments) {
      try {
        const meta = await uploadFile(p);
        uploaded.push({
          fileId: meta.fileId,
          filename: meta.filename,
          size: meta.size,
          mimeType: meta.mimeType,
          downloadUrl: buildDownloadUrl(meta.fileId)
        });
      } catch (e) {
        return toolError(`上传 ${p} 失败: ${e.message}`);
      }
    }
  }

  try {
    await ws.send(body, uploaded);
  } catch (e) {
    return toolError(`发送失败: ${e.message}`);
  }

  return toolText({
    status: 'sent',
    body,
    attachments: uploaded
  });
});

// ===== 工具：在线列表 =====
server.registerTool('chat_peers', {
  description: '查询当前群聊中所有在线 peer（包括自己）',
  inputSchema: {}
}, async () => {
  try {
    const peers = await ws.listPeers();
    return toolText({ peers });
  } catch (e) {
    return toolError(`获取 peers 失败: ${e.message}`);
  }
});

// ===== 工具：拉取未读消息 =====
server.registerTool('chat_pull', {
  description: '从本地 inbox 拉取所有未读事件（消息、加入/离开通知等），默认会标记为已读。' +
    '收到 Monitor 通知后应当用这个工具拿到完整内容。',
  inputSchema: {
    mark_read: z.boolean().optional()
      .describe('是否标记为已读，默认 true'),
    limit: z.number().int().positive().optional()
      .describe('最多返回多少条，未填则返回全部未读')
  }
}, async ({ mark_read, limit }) => {
  const { entries, unread } = await inbox.pull({
    mark: mark_read !== false,
    limit
  });
  return toolText({ entries, remainingUnread: unread });
});

// ===== 工具：偷看尾部 =====
server.registerTool('chat_peek', {
  description: '查看 inbox 尾部最近 N 条事件，不影响已读状态',
  inputSchema: {
    limit: z.number().int().positive().optional()
      .describe('返回多少条，默认 20')
  }
}, async ({ limit }) => {
  const entries = await inbox.peek({ limit: limit || 20 });
  return toolText({ entries });
});

// ===== 工具：inbox 状态 =====
server.registerTool('chat_inbox_stats', {
  description: '查看本地 inbox 状态（未读数、总字节）',
  inputSchema: {}
}, async () => {
  const stats = await inbox.stats();
  return toolText(stats);
});

// ===== 工具：拉服务器历史 =====
server.registerTool('chat_history', {
  description: '从 server 拉取最近的群聊历史消息（server 端 Redis 存储，重启即清空）',
  inputSchema: {
    count: z.number().int().positive().optional()
      .describe('拉取条数，默认 20')
  }
}, async ({ count }) => {
  try {
    const messages = await ws.getHistory(count || 20);
    return toolText({ messages });
  } catch (e) {
    return toolError(`拉取历史失败: ${e.message}`);
  }
});

// ===== 工具：下载文件 =====
server.registerTool('chat_download', {
  description: '下载群聊中的附件到本地 .tmp/ 目录（或指定目录）。' +
    '可用 fileId（更精确）或 filename（同名时取最新一份）',
  inputSchema: {
    fileId: z.string().optional().describe('文件 ID，优先使用'),
    filename: z.string().optional().describe('文件名（仅在没有 fileId 时使用）'),
    destDir: z.string().optional().describe('保存目录，默认 ./.tmp')
  }
}, async ({ fileId, filename, destDir }) => {
  if (!fileId && !filename) return toolError('需要提供 fileId 或 filename');
  try {
    const result = await downloadFile({
      fileId, filename,
      destDir: destDir || '.tmp'
    });
    return toolText(result);
  } catch (e) {
    return toolError(`下载失败: ${e.message}`);
  }
});

// ===== 辅助 =====
function toolText(obj) {
  return {
    content: [{
      type: 'text',
      text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2)
    }]
  };
}
function toolError(msg) {
  return {
    isError: true,
    content: [{ type: 'text', text: msg }]
  };
}
function buildDownloadUrl(fileId) {
  return `${getHttpUrl()}/download?fileId=${fileId}`;
}

// ===== 启动 =====
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info('MCP server 启动完成 (stdio)');
  // 提前连一次 WS（失败也无所谓，工具调用时会再 ensureConnected）
  ws.ensureConnected().catch(e => log.warn(`预连 WS 失败（工具调用时会重试）: ${e.message}`));
}

process.on('SIGINT', () => { ws.close(); process.exit(0); });
process.on('SIGTERM', () => { ws.close(); process.exit(0); });

main().catch(err => {
  log.error(`MCP 启动失败: ${err.stack || err.message}`);
  process.exit(1);
});
