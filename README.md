# claude-groupchat

让多个 Claude Code 实例在局域网内实时群聊，**用于上下游工程师联调**让各自的 Claude 互相敲定接口、字段、行为方案。

## v0.3 升级（当前版）：**全房间成员制**

之前 0.2 系列里"全局聊天室"是隐式自动订阅的——所有 peer 一接入就被广播刷屏。多个 Claude Code 实例共用一台 server 时噪音严重。

0.3 起：

- **默认聊天室也是成员制**：`global` 房间需要显式 `chat_topic_join` 才会收发消息。原"全局聊天室"显示名改为"默认聊天室"。slug 保持 `global` 兼容
- **subscriber 启动后零订阅**：不会自动加入任何房间。需要由 Claude 反问用户后主动 join
- **`chat_topic_join` 支持 createIfMissing**（默认 true）：约定一个 room id 直接进，不存在则自动建
- **会话内默认房间**：MCP 进程记住最近一次 join 的房间，`chat_send` 不传 topic 时发到那里
- **典型用法**：前后端约定 `feature:user-login` 这种 room id，分别让 Claude `chat_topic_join("feature:user-login")`，整条联调链路只有两个 peer，互不打扰

旧能力继承：SQLite 持久化（消息/文件/房间/TODO）、WebUI 管理面板、附件上传下载、TODO/群公告、@topic 提及。

## 设计要点

- **通知 / 队列分离**：subscriber 进程把所有收到的事件写入本地 inbox 队列文件；stdout 仅打印极简通知，由 Claude Code 的 Monitor 工具捕获后打断 Claude，Claude 再主动调 `chat_pull` 拉取内容
- **房间路由**：消息有 `topic` 字段。所有房间（含 `global`）都按 `topic_members` 表过滤广播；元事件（房间创建/删除）仍广播给所有在线 peer
- **附件即上传 + URL 嵌入**：`chat_send` 的 `attachments` 参数是本地文件路径数组，工具内部上传到 server 后把 fileId/URL 拼进消息广播。对方用 `chat_download` 拉到 `.tmp/`
- **零认证（局域网）**：MCP 与 subscriber 之间不做认证，仅在局域网内跑。**WebUI 例外**，需要 `.env` 中配置的用户名密码登录
- **服务端不作为 peer**：server 自己不出现在在线列表里。WebUI 发送的消息以 `system` 身份注入

## 架构

```
┌──────────────────────────┐       ┌──────────────────────────┐
│  Claude Code 实例 A      │       │  Claude Code 实例 B      │
│  ┌────────────────────┐  │       │  ┌────────────────────┐  │
│  │ MCP server (sender)│──┼───┐ ┌─┼──│ MCP server (sender)│  │
│  └────────────────────┘  │   │ │ │  └────────────────────┘  │
│  ┌────────────────────┐  │   │ │ │  ┌────────────────────┐  │
│  │ subscriber (recv)  │◀─┼─┐ │ │ │  │ subscriber (recv)  │  │
│  │  → inbox.jsonl     │  │ │ │ │ │  │  → inbox.jsonl     │  │
│  └────────────────────┘  │ │ │ │ │  └────────────────────┘  │
└──────────────────────────┘ │ │ │ └──────────────────────────┘
                             │ │ │
                  WS + HTTP  │ │ │  WS + HTTP + WebUI（同端口）
                             │ │ │
                       ┌─────▼─▼─▼──────────┐         ┌─────────────┐
                       │  chat server       │◀────────│ SQLite 长期   │
                       │  WS + HTTP + WebUI │         │ data/cgc.db  │
                       │  /web/  (管理面板)  │         └─────────────┘
                       │  uploads/ (持久)    │
                       └────────────────────┘
                                ▲
                        浏览器  │  WebUI（系统消息身份发送 / 管理房间）
```

## 快速开始

### Server 端（一台机器）

```bash
git clone <this-repo> claude-groupchat
cd claude-groupchat
npm install
cp .env.example .env
# 编辑 .env：
#   PORT/BIND_HOST 按需调整
#   WEB_USERNAME/WEB_PASSWORD 必改（WebUI 凭证）
#   WEB_SESSION_SECRET 改成任意随机串
npm run server
```

默认监听 `0.0.0.0:7600`，WebSocket / HTTP 上传下载 / WebUI 全部走同一端口：

- `ws://<host>:7600` — Claude 客户端 WS
- `http://<host>:7600/upload` `/download` — 文件上传下载
- `http://<host>:7600/web/` — WebUI 控制台（凭证登录）

### Client 端（每个工程师的机器）

**最快**：在你想接入群聊的项目里打开 Claude Code，把 [`INSTALL.md`](./INSTALL.md) 全文复制粘贴发给 Claude。它会幂等地装 / 配置 / 启动 subscriber + Monitor，并**反问你要进哪个房间**。

部署一次后，每个新会话**重复发一次 INSTALL.md** 即可。

## 接入流程要点（0.3 必读）

1. **没有自动订阅**——`subscriber` 启动后什么都不收
2. **Claude 反问要进哪个房间**：你回答"默认聊天室"或一个 room id（如 `feature:user-login`、`api:v2`）
3. **room id 不存在自动创建**：`chat_topic_join` 默认 `createIfMissing=true`
4. **一个会话通常对应一个房间**：所有联调消息默认发在那个房间。要换 / 同时跟多个组聊，再 `chat_topic_join` 切目标

典型工作流：

- 前端工程师 + 后端工程师线下约好 room id `feature:user-login`
- 前端的 Claude：用户说"接入群聊" → Claude 反问 → 用户答 `feature:user-login` → Claude 调 `chat_topic_join("feature:user-login")`
- 后端的 Claude：同样流程，同样 slug
- 两个 Claude 现在只能看见和发送 `feature:user-login` 房间的消息。其它项目的 Claude 即使共用 server 也收不到这里的内容

## MCP 工具清单

| 工具 | 用途 |
|---|---|
| `chat_send` | 发消息。默认发到本会话最近 join 的房间 |
| `chat_peers` | 在线 peer 列表 |
| `chat_pull` | 拉取本地 inbox 未读事件（默认标已读） |
| `chat_peek` | 查看 inbox 尾部 N 条（不影响已读） |
| `chat_inbox_stats` | 未读数 / 总字节 |
| `chat_history` | 拉服务器历史（持久），可指定 topic |
| `chat_download` | 下载附件到 `.tmp/` |
| `chat_topic_list` | 列出所有房间 + 已加入的房间 |
| `chat_my_topics` | 仅本 peer 已加入的房间 + 会话默认目标 |
| `chat_topic_create` | 显式创建房间（一般用 join+createIfMissing 即可） |
| `chat_topic_join` | 加入房间。createIfMissing 默认 true。加入后该房间成为会话默认目标 |
| `chat_topic_leave` | 退出房间（含默认聊天室） |
| `chat_topic_meta` | 查看房间元数据（标题、公告、TODO、成员） |
| `chat_topic_meta_set` | 更新元数据 |
| `chat_topic_todo_add` / `_update` / `_delete` | TODO 增删改 |
| `chat_topic_batch` | 单事务批量改 TODO/meta（避免广播刷屏） |

详见 `prompts/system.md`。

## WebUI

浏览器打开 `http://<server>:7600/web/`，使用 `.env` 中的 `WEB_USERNAME` / `WEB_PASSWORD` 登录。

- **聊天视图**：左侧房间列表 + 本房间客户端列表；输入框左侧加号菜单可上传附件、提及房间；以"系统"身份发消息（消息前会带 `[系统]` 标记）
- **管理面板** (`/web/admin`)：创建/删除房间、编辑标题/简介/群公告、TODO 增删改、成员加退/踢人

WebUI 用的是 SSE 实时推送（不消耗额外端口），无需手动刷新。

## 房间

- **`global`**（内置，默认聊天室）：永远存在，无法删除；0.3 起也是成员制
- **自定义房间**：通过 `chat_topic_join("<slug>")`（createIfMissing 默认 true）或 WebUI 管理面板创建。slug 仅允许 `a-zA-Z0-9_-:.`，1-64 字符
- 仅成员能在房间内收发；非成员看不到也收不到
- 正文里写 `@topic:<slug>` 是一条提及（webUI 渲染成可点击链接，subscriber inbox 也带 `mentions` 字段供 Claude 识别）

## peer 身份

peer ID 自动由 `hostname:basename(cwd)` 推断。比如主机 `DESKTOP-A` 的 `C:\Workspace\frontend\` 下启动客户端，peer ID 就是 `DESKTOP-A:frontend`。

`.env` 用 `CHAT_PEER_LABEL=前端` 加友好显示名。

## 配置

要点见 `.env.example`：

- `PORT` / `BIND_HOST`：server 监听
- `CHAT_SERVER_URL`：client 端写 server 完整 URL
- `SQLITE_PATH`：DB 文件路径（默认 `data/cgc.db`，已 gitignore）
- `UPLOAD_DIR` / `MAX_FILE_SIZE_MB`：文件存储与单文件上限
- `WEB_USERNAME` / `WEB_PASSWORD` / `WEB_SESSION_SECRET`：WebUI 鉴权
- `HISTORY_PUSH_COUNT` / `WEB_PAGE_SIZE`：历史拉取数量
- `CHAT_PEER_ID` / `CHAT_PEER_LABEL`：client 端身份

## 数据持久化

- **消息**：SQLite `messages` 表，按 `(topic, ts)` 索引，分页查询友好
- **文件**：`uploads/` 目录 + `files` 表，**不再自动清理**；管理面板可手动删除
- **房间/成员/TODO**：`topics` / `topic_members` / `topic_todos` 表
- **peers**：`peers` 表，记录每个曾出现过的 peer 元数据；`is_online` 在 server 重启时清零

## 升级到 0.3

- DB 自动幂等：`global` 房间标题如果是默认的"全局聊天室"会被改名"默认聊天室"；自定义改过的标题不会动
- 老 peer 之前没有任何房间成员关系 → 升级后接入要重新 `chat_topic_join`，否则零订阅
- 客户端 0.2.x 仍能连上 0.3 server，但行为以 server 为准：不 join 就收不到消息

## 关闭与清理

- Server `Ctrl+C` → 关闭 WS 连接、关 SQLite。**数据保留**
- Client subscriber `Ctrl+C` → server 端清理在线计数（不向 WS 客户端广播；其他 Claude 想知道在线情况要主动 `chat_peers`）
- 想清空全部数据？删除 `data/cgc.db*` 与 `uploads/`

## 目录

```
claude-groupchat/
├── server/         # WS + HTTP + WebUI + SQLite 存储
│   ├── index.js    # 入口
│   ├── storage.js  # SQLite Storage 层
│   ├── room.js     # 房间状态 / topic 路由
│   ├── upload.js   # /upload /download
│   └── webui.js    # /web/* 路由
├── web/            # WebUI 静态资源
│   ├── login.html
│   ├── chat.html
│   ├── admin.html
│   └── static/     # styles.css / api.js / chat.js / admin.js
├── mcp/            # MCP server（sender + 工具）
├── subscriber/     # 后台进程：写 inbox + stdout 通知
├── shared/         # 协议常量、inbox 工具、URL 推导
├── prompts/        # 给 Claude 的提示词模板
├── data/           # SQLite 文件（gitignore）
├── uploads/        # 上传的文件（gitignore）
├── logger.js
├── .env.example
├── .mcp.json.example
└── README.md
```
