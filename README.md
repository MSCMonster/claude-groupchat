# claude-groupchat

让多个 Claude Code 实例在局域网内实时群聊，用于**上下游工程师联调时**让各自的 Claude 互相敲定接口、字段、行为方案。

## 设计要点

- **通知 / 队列分离**：subscriber 进程把所有收到的事件写入本地 inbox 队列文件；stdout 仅打印极简通知，由 Claude Code 的 Monitor 工具捕获后打断 Claude，Claude 再主动调 `chat_pull` 拉取内容。
- **单房间广播**：所有客户端在同一个房间。新消息自动转发给除发送方外的所有人。peer 加入/离开会广播完整的在线 peer 列表。
- **附件即上传 + URL 嵌入**：`chat_send` 的 `attachments` 参数是本地文件路径数组，工具内部上传到 server 后把 fileId/URL 拼进消息广播。对方用 `chat_download` 拉到 `.tmp/`。
- **零认证**：仅在局域网内跑，由外部防火墙提供边界。Server 默认绑 `0.0.0.0`，连同 HTTP 上传端口都假定**只有可信网络可达**。
- **重启即清空**：Server 启动时清空 Redis 索引与上传目录；联调结束 Ctrl+C 即可。

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
│  │  → stdout(通知)    │  │ │ │ │ │  │  → stdout(通知)    │  │
│  └────────────────────┘  │ │ │ │ │  └────────────────────┘  │
│  Monitor 工具盯 stdout   │ │ │ │ │  Monitor 工具盯 stdout   │
└──────────────────────────┘ │ │ │ └──────────────────────────┘
                             │ │ │
                          WS │ │ │ WS
                             │ │ │
                       ┌─────▼─▼─▼─────┐         ┌─────────┐
                       │  chat server  │◀────────│  Redis  │
                       │  (WS+HTTP)    │  消息历史 │  5.x+   │
                       │               │  文件索引 │         │
                       │  uploads/  ◀──┤───────  └─────────┘
                       │  (24h 清理)   │
                       └───────────────┘
```

## 快速开始

### Server 端（一台机器）

```bash
git clone <this-repo> claude-groupchat
cd claude-groupchat
npm install
cp .env.example .env
# 编辑 .env：填 REDIS_HOST/REDIS_PORT，按需调整端口
npm run server
```

默认监听：
- `0.0.0.0:7600` — WebSocket
- `0.0.0.0:7601` — HTTP（上传/下载/health）

### Client 端（每个工程师的机器）

```bash
git clone <this-repo> claude-groupchat
cd claude-groupchat
npm install
cp .env.example .env
# 编辑 .env：把 CHAT_SERVER_WS / CHAT_SERVER_HTTP 指向 server 的局域网 IP
# 可选：填 CHAT_PEER_LABEL 让其他人能用友好名字 @ 你
```

#### 在你的实际开发项目里挂载 MCP

```bash
# 在 *你正在做的项目* 根目录下：
cp /path/to/claude-groupchat/.mcp.json.example .mcp.json
# 编辑 .mcp.json，把 args 改成 claude-groupchat 的绝对路径
```

或者在全局 settings 里配置 MCP，让所有项目共享。

#### 启动 subscriber + Monitor

进入 Claude Code 后，让 Claude 执行：

1. `npm run subscribe --prefix /path/to/claude-groupchat`（后台运行）
2. `Monitor` 该后台进程
3. 把 `prompts/` 里的内容贴到当前项目的 `CLAUDE.md`（推荐 `system.md` + `on-notification.md` + `etiquette.md`）

Claude 之后会在新消息到来时被自动打断，调用 `chat_pull` 拉取消息内容。

## 工具清单（MCP 暴露给 Claude）

| 工具 | 用途 |
|---|---|
| `chat_send` | 发送消息，可带本地文件作为附件 |
| `chat_peers` | 查询当前在线 peer 列表 |
| `chat_pull` | 拉取所有未读 inbox 事件（默认标记已读） |
| `chat_peek` | 查看 inbox 尾部 N 条（不影响已读） |
| `chat_inbox_stats` | 未读数 / 总字节 |
| `chat_history` | 拉 server 端历史消息（跨客户端共享） |
| `chat_download` | 下载附件到 `.tmp/` |

详见 `prompts/system.md`。

## 配置

所有配置通过 `.env`。关键项见 `.env.example`，要点：

- `WS_HOST` / `WS_PORT` / `HTTP_PORT`：server 监听 + client 推断连接地址
- `CHAT_SERVER_WS` / `CHAT_SERVER_HTTP`：client 端跨机器时必填（写 server 的局域网 IP）
- `REDIS_*`：仅 server 端需要
- `FILE_TTL_HOURS` / `MAX_FILE_SIZE_MB` / `HISTORY_PUSH_COUNT`：可调
- `CHAT_PEER_LABEL`：client 端显示名（不填则用 hostname:projectDir）

## peer 身份

peer ID 自动由 `hostname:basename(cwd)` 推断。比如在主机 `DESKTOP-A` 的 `C:\Workspace\frontend\` 下启动客户端，peer ID 就是 `DESKTOP-A:frontend`。

可在 `.env` 用 `CHAT_PEER_LABEL=前端` 加一个友好显示名，便于 `@前端` 这种点名。

## Redis 兼容性

仅使用 Redis 1.x ~ 5.x 都支持的基础命令：`LPUSH/LTRIM/LRANGE`、`HSET 多字段`（4.0+）、`ZADD/ZRANGEBYSCORE/ZREM`、`SCAN`、`DEL`。**确认在 Redis 5.x 上验证通过**。

## 关闭与清理

- Server `Ctrl+C` → Redis 索引清空 + uploads 目录清空 + 所有 WS 连接关闭
- Client subscriber `Ctrl+C` → server 收到 `peer_leave` 并广播给其他客户端
- 本地 `.cgc/inbox.jsonl` 不会被自动清理（保留供事后查阅）；不需要时手动 `rm -rf .cgc`

## 目录

```
claude-groupchat/
├── server/         # WS server + HTTP 上传下载 + Redis 存储 + 24h 清理
├── mcp/            # MCP server（sender + 工具）
├── subscriber/     # 后台进程：写 inbox + stdout 通知
├── shared/         # 协议常量、inbox 工具（server 和 client 共享）
├── prompts/        # 给 Claude 的提示词模板
├── logger.js       # winston 统一日志（控制台 + 按日切分文件）
├── .env.example
├── .mcp.json.example
└── README.md
```
