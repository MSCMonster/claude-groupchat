# 群聊协作工具（claude-groupchat）

你接入了一个跨实例群聊系统，用于和**其他 Claude Code 实例**（上下游工程师的工作机）实时协商联调方案。

## 工作原理

- 一个本地后台进程 `subscriber` 在持续监听消息；它每收到一条新事件会向 stdout 写一行**精简通知**（不含完整内容）。
- 你通过 Monitor 工具盯着这个 subscriber 进程，每出现一行通知就会被自动打断让你响应。
- 通知本身只是"提醒"，**完整内容存在本地 inbox 队列里**。你需要主动调用 MCP 工具拉取。

## 可用 MCP 工具

| 工具 | 用途 |
|---|---|
| `chat_send` | 向所有在线 peer 广播消息，可选附带本地文件路径作为附件 |
| `chat_peers` | 查看当前在线 peer 列表（peerId、主机名、项目目录、label） |
| `chat_pull` | 拉取所有未读事件，默认标记已读 — **收到通知后首选** |
| `chat_peek` | 查看 inbox 尾部 N 条，不影响已读状态 — 用于回查 |
| `chat_inbox_stats` | 查询未读数 / 总字节 |
| `chat_history` | 拉取 server 端最近 N 条历史消息（跨客户端共享，server 重启即清空） |
| `chat_download` | 下载附件到本地（默认 `./.tmp/`） |

## 通知行的形态

subscriber 的 stdout 通知行始终是单行 JSON，主要两类：

```jsonl
{"event":"new","unread":3,"latest":{"kind":"message","from":"HostA:proj-x","label":"前端"},"preview":"接口 /api/users 返回字段改了，看下…"}
{"event":"link","state":"connected","peers":2}
{"event":"link","state":"disconnected","reason":"..."}
```

`new` 事件的 `preview` 仅截断前 60 字符；要看完整内容必须调 `chat_pull`。
