// MCP server 入口（stdio transport）
// 暴露聊天工具给 Claude Code 调用：发消息 / 拉消息 / 文件 / 话题房间
'use strict';
require('dotenv').config();

// stdout 是 MCP 协议通道，logger 必须走 stderr
process.env.LOG_TO_STDERR = 'true';

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
  { name: 'claude-groupchat', version: '0.2.2' },
  { capabilities: { tools: {} } }
);

// ===== 工具：发送消息 =====
server.registerTool('chat_send', {
  description: '向群聊广播一条消息。' +
    '默认发到全局聊天室；指定 topic 则只在该话题房间内可见。' +
    '可在正文里用 @topic:<slug> 提及话题房间（例：邀请其他人加入）。' +
    'attachments 是本地文件路径数组，工具会上传后把 fileId/url 附加到消息里。',
  inputSchema: {
    body: z.string().describe('消息正文'),
    attachments: z.array(z.string()).optional()
      .describe('可选：本地文件路径数组，会上传并附在消息里发出'),
    topic: z.string().optional()
      .describe('可选：话题房间 slug。不传 = global 全局聊天室；非 global 时发送者必须是该房间成员')
  }
}, async ({ body, attachments, topic }) => {
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
    await ws.send(body, uploaded, topic);
  } catch (e) {
    return toolError(`发送失败: ${e.message}`);
  }

  return toolText({
    status: 'sent',
    topic: topic || 'global',
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
  description: '从本地 inbox 拉取所有未读事件（消息、加入/离开通知、话题事件等），默认会标记为已读。' +
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
  description: '从 server 拉取最近的群聊历史消息（SQLite 长期持久化）。可指定 topic',
  inputSchema: {
    count: z.number().int().positive().optional()
      .describe('拉取条数，默认 20'),
    topic: z.string().optional()
      .describe('可选：话题房间 slug，不传 = global')
  }
}, async ({ count, topic }) => {
  try {
    const messages = await ws.getHistory(count || 20, topic);
    return toolText({ topic: topic || 'global', messages });
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

// ===== 话题房间工具 =====
server.registerTool('chat_topic_list', {
  description: '列出所有话题房间，并标出本 peer 已加入的房间',
  inputSchema: {}
}, async () => {
  try { return toolText(await ws.topicList()); }
  catch (e) { return toolError(`获取话题列表失败: ${e.message}`); }
});

server.registerTool('chat_topic_create', {
  description: '创建一个新的话题房间。slug 是 URL 友好标识（字母/数字/_-:.）。' +
    '默认创建后自动加入；autoJoin=false 仅创建不加入。',
  inputSchema: {
    slug: z.string().describe('唯一标识，1-64 字符，支持 a-zA-Z0-9_-:.'),
    title: z.string().optional().describe('展示标题，默认与 slug 相同'),
    description: z.string().optional().describe('简介'),
    autoJoin: z.boolean().optional().describe('是否自动加入，默认 true')
  }
}, async ({ slug, title, description, autoJoin }) => {
  try {
    const topic = await ws.topicCreate({ slug, title, description, autoJoin });
    return toolText({ status: 'created', topic });
  } catch (e) {
    return toolError(`创建话题失败: ${e.message}`);
  }
});

server.registerTool('chat_topic_join', {
  description: '加入一个已存在的话题房间，之后才能在该话题内收发消息',
  inputSchema: { slug: z.string().describe('话题 slug') }
}, async ({ slug }) => {
  try {
    const topic = await ws.topicJoin(slug);
    return toolText({ status: 'joined', topic });
  } catch (e) { return toolError(`加入失败: ${e.message}`); }
});

server.registerTool('chat_topic_leave', {
  description: '退出一个话题房间。退出后该房间的消息不再推送给你',
  inputSchema: { slug: z.string().describe('话题 slug') }
}, async ({ slug }) => {
  try {
    const topic = await ws.topicLeave(slug);
    return toolText({ status: 'left', topic });
  } catch (e) { return toolError(`退出失败: ${e.message}`); }
});

server.registerTool('chat_topic_meta', {
  description: '查看话题房间的元数据：标题、简介、群公告、TODO 列表、成员列表',
  inputSchema: { slug: z.string().describe('话题 slug，例 global / api-design') }
}, async ({ slug }) => {
  try {
    const meta = await ws.topicMetaGet(slug);
    return toolText(meta);
  } catch (e) { return toolError(`获取元数据失败: ${e.message}`); }
});

server.registerTool('chat_topic_meta_set', {
  description: '更新话题房间元数据。任意字段可选；未提供的保持不变',
  inputSchema: {
    slug: z.string().describe('话题 slug'),
    title: z.string().optional(),
    description: z.string().optional(),
    announcement: z.string().optional().describe('群公告（类似置顶通知）')
  }
}, async ({ slug, title, description, announcement }) => {
  try {
    const topic = await ws.topicMetaSet(slug, { title, description, announcement });
    return toolText({ status: 'updated', topic });
  } catch (e) { return toolError(`更新失败: ${e.message}`); }
});

server.registerTool('chat_topic_todo_add', {
  description: '在话题房间下新增一条 TODO/事项',
  inputSchema: {
    slug: z.string().describe('话题 slug'),
    content: z.string().describe('TODO 内容')
  }
}, async ({ slug, content }) => {
  try {
    const todo = await ws.topicTodoAdd(slug, content);
    return toolText({ status: 'added', todo });
  } catch (e) { return toolError(`添加 TODO 失败: ${e.message}`); }
});

server.registerTool('chat_topic_todo_update', {
  description: '更新一条 TODO 的内容或完成状态',
  inputSchema: {
    id: z.number().int().describe('TODO id'),
    content: z.string().optional(),
    done: z.boolean().optional()
  }
}, async ({ id, content, done }) => {
  try {
    const todo = await ws.topicTodoUpdate(id, { content, done });
    return toolText({ status: 'updated', todo });
  } catch (e) { return toolError(`更新 TODO 失败: ${e.message}`); }
});

server.registerTool('chat_topic_todo_delete', {
  description: '删除一条 TODO',
  inputSchema: { id: z.number().int().describe('TODO id') }
}, async ({ id }) => {
  try {
    const ok = await ws.topicTodoDelete(id);
    return toolText({ status: ok ? 'deleted' : 'not_found' });
  } catch (e) { return toolError(`删除 TODO 失败: ${e.message}`); }
});

server.registerTool('chat_topic_batch', {
  description: '在同一话题房间内原子地执行一批操作（TODO 增/改/删 + meta 更新）。' +
    '所有 op 走单个事务：任一失败整体回滚，成功后订阅端只收到一条 topic_batch 事件，' +
    '避免逐条 broadcast 造成的通知刷屏。' +
    '\n\nop 列表：' +
    '\n  { op:"todo_add", content }            // 新增 TODO' +
    '\n  { op:"todo_update", id, content?, done? }  // 更新 TODO（id 必须属于本话题）' +
    '\n  { op:"todo_delete", id }              // 删除 TODO' +
    '\n  { op:"meta_set", title?, description?, announcement? }  // 更新房间元数据/公告',
  inputSchema: {
    slug: z.string().describe('话题 slug，例 global / sandbox-files'),
    ops: z.array(z.object({
      op: z.enum(['todo_add', 'todo_update', 'todo_delete', 'meta_set'])
        .describe('操作类型'),
      id: z.number().int().optional().describe('todo_update / todo_delete 的 TODO id'),
      content: z.string().optional().describe('todo_add 必填；todo_update 选填'),
      done: z.boolean().optional().describe('todo_update 选填'),
      title: z.string().optional().describe('meta_set 选填'),
      description: z.string().optional().describe('meta_set 选填'),
      announcement: z.string().optional().describe('meta_set 选填')
    })).min(1).describe('要执行的操作数组，最少 1 条')
  }
}, async ({ slug, ops }) => {
  try {
    const result = await ws.topicBatch(slug, ops);
    return toolText({ status: 'ok', ...result });
  } catch (e) {
    return toolError(`批量操作失败: ${e.message}`);
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
  ws.ensureConnected().catch(e => log.warn(`预连 WS 失败（工具调用时会重试）: ${e.message}`));
}

process.on('SIGINT', () => { ws.close(); process.exit(0); });
process.on('SIGTERM', () => { ws.close(); process.exit(0); });

main().catch(err => {
  log.error(`MCP 启动失败: ${err.stack || err.message}`);
  process.exit(1);
});
