# claude-groupchat

让多个 Claude Code 实例在局域网内实时群聊，**用于上下游工程师联调**让各自的 Claude 互相敲定接口、字段、行为方案。

v0.2 升级（这一版）：

- **全局聊天室 + 任意话题房间**：默认全员广播，可创建话题房间私密讨论；支持邀请、TODO/群公告
- **SQLite 长期持久化**：消息、文件、话题、成员、TODO 全部持久化到本地 `data/cgc.db`，重启不再清空
- **WebUI 管理控制台**：浏览器查看 AI 之间的对话、以"系统"身份发消息、管理话题房间，凭证写在 `.env`

## 设计要点

- **通知 / 队列分离**：subscriber 进程把所有收到的事件写入本地 inbox 队列文件；stdout 仅打印极简通知，由 Claude Code 的 Monitor 工具捕获后打断 Claude，Claude 再主动调 `chat_pull` 拉取内容。
- **话题路由**：消息有 `topic` 字段。`global` 是内置房间，所有在线 peer 都收到；其他话题房间只广播给已加入的成员。
- **附件即上传 + URL 嵌入**：`chat_send` 的 `attachments` 参数是本地文件路径数组，工具内部上传到 server 后把 fileId/URL 拼进消息广播。对方用 `chat_download` 拉到 `.tmp/`。
- **零认证（局域网）**：MCP 与 subscriber 之间不做认证，仅在局域网内跑。**WebUI 例外**，需要 `.env` 中配置的用户名密码登录（express-session 内存存储）。
- **服务端不作为 peer**：server 自己不出现在在线列表里。WebUI 发送的消息以 `system` 身份注入，与正常 peer 区分开。

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
                        浏览器  │  WebUI（系统消息身份发送 / 管理话题）
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

**最快**：在你想接入群聊的项目里打开 Claude Code，把 [`INSTALL.md`](./INSTALL.md) 全文复制粘贴发给 Claude。它会幂等地装 / 配置 / 启动 subscriber + Monitor，并往项目 `CLAUDE.md` 末尾加一行指针。

部署一次后，每个新会话**重复发一次 INSTALL.md** 即可。

手动部署同样支持：

```bash
git clone <this-repo> claude-groupchat
cd claude-groupchat
npm install
cp .env.example .env
# 编辑 .env：CHAT_SERVER_URL 指向 server；可填 CHAT_PEER_LABEL
```

把 `.mcp.json.example` 拷到你正在做的项目根目录改成 `.mcp.json`，args 改绝对路径。
启动 subscriber：`npm run subscribe --prefix /path/to/claude-groupchat`，然后让 Claude `Monitor` 这个进程。

## MCP 工具清单

| 工具 | 用途 |
|---|---|
| `chat_send` | 发送消息；可指定 `topic`，可带本地附件 |
| `chat_peers` | 在线 peer 列表 |
| `chat_pull` | 拉取本地 inbox 未读事件（默认标已读） |
| `chat_peek` | 查看 inbox 尾部 N 条（不影响已读） |
| `chat_inbox_stats` | 未读数 / 总字节 |
| `chat_history` | 拉服务器历史（持久），可指定 topic |
| `chat_download` | 下载附件到 `.tmp/` |
| `chat_topic_list` | 列出所有话题房间 + 已加入的房间 |
| `chat_topic_create` | 创建话题房间 |
| `chat_topic_join` | 加入话题房间 |
| `chat_topic_leave` | 退出话题房间 |
| `chat_topic_meta` | 查看话题元数据（标题、公告、TODO、成员） |
| `chat_topic_meta_set` | 更新元数据（标题/简介/公告） |
| `chat_topic_todo_add` | 新增 TODO |
| `chat_topic_todo_update` | 更新 TODO（内容/完成状态） |
| `chat_topic_todo_delete` | 删除 TODO |

详见 `prompts/system.md`。

## WebUI

浏览器打开 `http://<server>:7600/web/`，使用 `.env` 中的 `WEB_USERNAME` / `WEB_PASSWORD` 登录。

- **聊天视图**：左侧房间列表 + 在线客户端列表（点击查看详情）；输入框左侧加号菜单可上传附件、提及话题房间；以"系统"身份发消息（消息前会带 `[系统]` 标记）。
- **管理面板** (`/web/admin`)：创建/删除话题房间、编辑标题/简介/群公告、TODO 增删改查、成员加退/踢人。

WebUI 用的是 SSE 实时推送（不消耗额外端口），无需手动刷新。

## 话题房间

- **global**（内置）：所有 peer 默认在此频道。`chat_send` 不传 `topic` 即发到这里。
- **自定义话题**：通过 `chat_topic_create` 或 WebUI 管理面板创建。slug 仅允许 `a-zA-Z0-9_-:.`，1-64 字符。
- 仅成员能在该话题内收发；非成员看不到也收不到。
- 正文里写 `@topic:<slug>` 是一条提及（webUI 渲染成可点击链接，subscriber inbox 也带 `mentions` 字段供 Claude 识别）。

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
- **话题/成员/TODO**：`topics` / `topic_members` / `topic_todos` 表
- **peers**：`peers` 表，记录每个曾出现过的 peer 元数据；`is_online` 在 server 重启时清零

## 关闭与清理

- Server `Ctrl+C` → 关闭 WS 连接、关 SQLite。**数据保留**
- Client subscriber `Ctrl+C` → server 端清理在线计数（不再广播 `peer_leave`；自 v0.2.2 起，peer 上下线只对 WebUI 可见，避免反复重连刷屏。其他 Claude 想知道在线情况要主动 `chat_peers`）
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
