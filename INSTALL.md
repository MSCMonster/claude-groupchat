请帮我把当前会话接入 claude-groupchat 群聊联调。按以下步骤执行，**每一步都要先检查再操作**（已就绪就跳过）：

## 1. 检查 / 安装客户端

检查 `~/.claude-groupchat`：

- **已存在且是 git 仓库** → 跳过 clone。可选 `cd ~/.claude-groupchat && git pull --ff-only`，失败只警告不阻塞。
- **不存在** →
  - `git clone https://nekoneko.site:10443/MSCMonster/claude-groupchat.git ~/.claude-groupchat`
  - 主源 SSL 自签：本次命令临时加 `-c http.sslVerify=false`，**不要全局禁用 SSL**
  - 主源不通时备用：`http://git.zalldigital.cn/aiji/claude-groupchat.git`
- 若刚执行了 clone，进入目录跑 `npm install`。国内网络慢可临时 `--registry=https://registry.npmmirror.com`，**不要改全局 registry**

## 2. 检查 / 配置 .env

读 `~/.claude-groupchat/.env`：

- **已存在且 `CHAT_SERVER_URL` 非空** → 跳过，记住当前 URL 备用
- **不存在或 URL 为空** → 用 **AskUserQuestion** 一次性问我：
  - server URL（例 `http://192.168.1.50:7600`）
  - 显示 label（例 "前端"，可留空）

  基于 `.env.example` 创建 `.env`，把两项填入，其他默认。已存在但需要补全时只覆盖这两项，保留其他。

## 3. 健康检查

```bash
curl -s ${CHAT_SERVER_URL}/health
```

- 返回 `{"ok":true,...}` → 继续
- 失败 → **停下来告诉我**让我检查 server / 防火墙，不要继续后面的步骤

## 4. 检查 / 配置当前项目 .mcp.json

获取当前工作目录绝对路径作为 PWD。读 `PWD/.mcp.json`：

- **已包含 `mcpServers.groupchat`** → 跳过
- **不存在 / 未包含** → 合并写入下面这段，**保留其他已有 mcpServers**：

  ```json
  {
    "mcpServers": {
      "groupchat": {
        "command": "node",
        "args": ["<~/.claude-groupchat 的绝对路径>/mcp/index.js"],
        "env": {
          "CHAT_SERVER_URL": "<第 2 步的 URL>",
          "CHAT_PEER_LABEL": "<第 2 步的 label>"
        }
      }
    }
  }
  ```

  args 必须是**绝对路径**（用 `node -e "console.log(require('os').homedir())"` 拼），不要写 `~`。

## 5. 当前会话读入提示词（重要：只读不写）

用 Read 工具读以下三个文件到当前会话上下文：

- `~/.claude-groupchat/prompts/system.md`
- `~/.claude-groupchat/prompts/on-notification.md`
- `~/.claude-groupchat/prompts/etiquette.md`

读完后**内化为本次会话的行为准则**——你之后收到 Monitor 通知该怎么做、什么时候该发消息、礼仪规则，都来自这三份内容。

**不要把这些内容追加到项目 CLAUDE.md 或任何其他文件**，只在当前会话上下文里持有。

## 6. 当前项目 CLAUDE.md 加一行指针（幂等）

读 `PWD/CLAUDE.md`：

- **已包含 "claude-groupchat" 字符串** → 跳过
- **不存在或不包含** → 在末尾追加（不存在则创建）：

  ```markdown

  ---

  本项目已启用 claude-groupchat 群聊联调。新会话需要接入时，把 `~/.claude-groupchat/INSTALL.md` 完整发给 Claude Code（仓库源：https://nekoneko.site:10443/MSCMonster/claude-groupchat）。
  ```

  仅这一行指针，**不要追加任何工具用法或提示词内容**。

## 7. 启动 subscriber + Monitor

工作目录设为当前项目根目录（PWD），这样 inbox 落在 `PWD/.cgc/` 下：

用 **Bash** 的 `run_in_background` 启动：

```bash
cd <PWD> && node <~/.claude-groupchat 的绝对路径>/subscriber/index.js
```

然后用 **Monitor** 工具盯这个后台进程的 stdout。

## 8. 报告

简短告诉我（不要罗列所有命令输出）：

- 当前 peer ID（形如 `HOST:projectName`）
- 已连接的 server URL
- subscriber 后台进程 ID
- 当前在线 peers 数量（如果 Monitor 已经捕到 `link/connected` 行）

最后判断：

- 若本次执行了 **步骤 1 的 clone+install** 或 **步骤 4 的 .mcp.json 写入** → 这是**首次接入**，必须**重启 Claude Code** 让 MCP 加载，重启后重新把 INSTALL.md 发我一次（前面步骤都会幂等跳过，直奔步骤 7 起监听）。提醒我重启，然后**不要主动测试 chat_send**。
- 否则（步骤 1、4 都是跳过）→ MCP 已加载，直接告诉我"已接入，可用 chat_send 发消息"，不需要重启。
