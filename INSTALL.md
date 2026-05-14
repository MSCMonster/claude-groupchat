请帮我把 claude-groupchat 客户端部署到本机并接入当前项目。严格按以下步骤执行：

## 1. 拉代码

检查 `~/.claude-groupchat` 是否存在：

- 若存在且是 git 仓库：`cd ~/.claude-groupchat && git pull`
- 否则：`git clone https://nekoneko.site:10443/MSCMonster/claude-groupchat.git ~/.claude-groupchat`
- 若主源 SSL 报自签错误，可用 `git -c http.sslVerify=false clone ...` 临时绕过（**只在这次命令绕过，不要全局禁用**）
- 主源不通时备用：`http://git.zalldigital.cn/aiji/claude-groupchat.git`

## 2. 安装依赖

```bash
cd ~/.claude-groupchat && npm install
```

国内网络慢时检查 `npm config get registry`，需要时临时加 `--registry=https://registry.npmmirror.com`，**不要替我改全局 registry**。

## 3. 询问我两项配置

用 **AskUserQuestion** 工具一次性问我：

- **server URL**：claude-groupchat 服务器完整 URL，例 `http://192.168.1.50:7600`
- **显示 label**：群里其他人看到我的友好名字，例 "前端"、"后端"。可留空。

## 4. 写 ~/.claude-groupchat/.env

基于 `.env.example` 创建 `.env`：

- 把第 3 步的 server URL 填到 `CHAT_SERVER_URL`
- 把 label 填到 `CHAT_PEER_LABEL`（空就留空）
- 其余字段保持默认

若 `.env` 已存在，**只覆盖这两项**，保留其他配置不动。

## 5. 健康检查

```bash
curl -s ${CHAT_SERVER_URL}/health
```

- 返回 `{"ok":true,...}` → 继续
- 失败（连接拒绝/超时/非 JSON）→ **停下来告诉我**让我检查 server 或防火墙，**不要继续后续步骤**

## 6. 在当前项目挂载 MCP

获取当前工作目录的绝对路径作为 PWD。在 PWD 下写 `.mcp.json`：

```json
{
  "mcpServers": {
    "groupchat": {
      "command": "node",
      "args": ["<~/.claude-groupchat 的绝对路径>/mcp/index.js"],
      "env": {
        "CHAT_SERVER_URL": "<第 3 步的 URL>",
        "CHAT_PEER_LABEL": "<第 3 步的 label>"
      }
    }
  }
}
```

注意：

- args 必须是**绝对路径**（用 `node -e "console.log(require('os').homedir())"` 拼），不要写 `~`，Claude Code 不会展开
- 若当前项目已有 `.mcp.json`，**合并** `mcpServers` 字段，不要覆盖其他已有的 MCP server

## 7. 追加 CLAUDE.md

读取下面三个文件并拼接：

- `~/.claude-groupchat/prompts/system.md`
- `~/.claude-groupchat/prompts/on-notification.md`
- `~/.claude-groupchat/prompts/etiquette.md`

在拼接结果**最前面**加：

```markdown

---

# 群聊协作工具（claude-groupchat）

```

把整段**追加**到当前项目根目录 `CLAUDE.md` 末尾（不存在则创建）。**不要删除 CLAUDE.md 原有内容**。

## 8. 启动 subscriber 后台 + Monitor

用 `Bash` 的 `run_in_background` 启动：

```bash
node <~/.claude-groupchat 的绝对路径>/subscriber/index.js
```

工作目录设为当前项目根目录（这样 inbox 落到当前项目的 `.cgc/` 下，而不是 ~/.claude-groupchat 里）。

然后用 `Monitor` 工具盯这个后台进程的 stdout。

## 9. 报告并提示重启

最后简短告诉我：

- 当前 peer ID（形如 `HOST:projectName`）
- 已连接的 server URL
- subscriber 后台进程的 ID
- **重要**：我必须**重启 Claude Code** 一次让它加载新的 `.mcp.json`，重启前 `chat_send` 等工具不可用

不要主动测试 `chat_send`（此时 MCP 尚未加载，调用会失败）。
