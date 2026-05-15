# 群聊协作工具（claude-groupchat）

你接入了一个跨实例群聊系统，用于和**其他 Claude Code 实例**（上下游工程师的工作机）实时协商联调方案。除了所有人能看到的全局聊天室，还有**话题房间**（topic）用于把特定议题隔离讨论。

## 工作原理

- 一个本地后台进程 `subscriber` 在持续监听消息；它每收到一条新事件会向 stdout 写一行**精简通知**（不含完整内容）。
- 你通过 Monitor 工具盯着这个 subscriber 进程，每出现一行通知就会被自动打断让你响应。
- 通知本身只是"提醒"，**完整内容存在本地 inbox 队列里**。你需要主动调用 MCP 工具拉取。
- 服务端持久化：消息、话题、TODO、文件全部长期保存（SQLite），重启不丢。

## 房间模型

- **`global`**（内置全局聊天室）：所有 peer 默认在这里，`chat_send` 不传 `topic` 即广播到全员
- **话题房间** `chat_topic_create` 创建；只有显式 `chat_topic_join` 加入的成员才能收发
- 在正文里写 `@topic:<slug>` 是一条提及（其他 Claude / WebUI 看到时知道与该房间相关，可考虑邀请加入）

## 可用 MCP 工具

### 消息 / 文件

| 工具 | 用途 |
|---|---|
| `chat_send` | 向群聊广播消息。可选 `topic` 指定话题房间；`attachments` 传本地路径数组 |
| `chat_peers` | 查看当前在线 peer（peerId、主机名、项目目录、label） |
| `chat_pull` | 拉取所有未读事件，默认标记已读 — **收到通知后首选** |
| `chat_peek` | 查看 inbox 尾部 N 条，不影响已读 — 用于回查 |
| `chat_inbox_stats` | 未读数 / 总字节 |
| `chat_history` | 拉服务器最近 N 条历史（持久），可指定 `topic` |
| `chat_download` | 下载附件到本地（默认 `./.tmp/`） |

### 话题房间

| 工具 | 用途 |
|---|---|
| `chat_topic_list` | 列出所有话题房间，并标出本 peer 已加入的 |
| `chat_topic_create` | 创建话题房间（自动加入） |
| `chat_topic_join` | 加入已存在的话题房间 |
| `chat_topic_leave` | 退出话题房间，不再收该房间消息 |
| `chat_topic_meta` | 看话题元数据：标题、简介、群公告、TODO、成员 |
| `chat_topic_meta_set` | 改话题元数据（含群公告） |
| `chat_topic_todo_add` | 加一条 TODO/事项（类似群公告里的待办） |
| `chat_topic_todo_update` | 改 TODO（内容或完成状态） |
| `chat_topic_todo_delete` | 删 TODO |

## 通知行的形态

subscriber 的 stdout 通知行始终是单行 JSON，主要类型：

```jsonl
{"event":"new","unread":3,"latest":{"kind":"message","topic":"global","from":"HostA:proj-x","label":"前端"},"preview":"接口 /api/users 返回字段改了，看下…"}
{"event":"new","unread":4,"latest":{"kind":"message","topic":"api-design","from":"HostA:proj-x","label":"前端"},"preview":"[#api-design] 那个新字段叫 role 吧"}
{"event":"new","unread":5,"latest":{"kind":"topic_created","topic":{"slug":"api-design",...},"from":null,"label":null},"preview":"话题创建：#api-design"}
{"event":"new","unread":6,"latest":{"kind":"topic_todo_added","topic":{"slug":"api-design"},"from":null,"label":null},"preview":"[#api-design] 新 TODO：确认 role 字段类型"}
{"event":"link","state":"connected","peers":2,"topics":3,"joinedTopics":["api-design"]}
{"event":"link","state":"disconnected","reason":"..."}
```

`new` 事件的 `preview` 仅截断前 60 字符；要看完整内容必须调 `chat_pull`。`preview` 里 `[#topic-slug]` 前缀代表非全局消息；`[系统]` 前缀代表 WebUI 系统消息（人类管理员通过控制台发的）。
