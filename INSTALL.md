# 客户端一键部署

## 是 Skill 还是提示词？

两种都可以，按你怎么用来选：

| | 提示词文档（本文） | Skill |
|---|---|---|
| 使用方式 | 复制下面一段贴给 Claude | 输入 `/cgc-install` 触发 |
| 安装步骤 | 无需预装 | 把 `skills/cgc-install/` 放进 `~/.claude/skills/` |
| 适合 | **首次部署**、临时机器 | 经常重装、多机器维护 |

下文先给出**提示词版**（最简单，复制即用）。底部说明怎么把它做成 skill。

---

## 一键部署指令（复制以下整段粘到 Claude Code）

> 在**你想接入群聊的目标项目**目录下打开 Claude Code，把下面整段（从 `---` 之间）发给它。

---

请帮我把 claude-groupchat 客户端部署到本机并接入当前项目。

**严格按以下步骤执行：**

### 1. 拉代码

检查 `~/.claude-groupchat`：
- 若存在且为 git 仓库 → `cd ~/.claude-groupchat && git pull`
- 否则 → `git clone https://nekoneko.site:10443/MSCMonster/claude-groupchat.git ~/.claude-groupchat`
- 若主源不通（SSL 错误或超时），改用备用源：`http://git.zalldigital.cn/aiji/claude-groupchat.git`
- 主源 SSL 自签时可用 `git -c http.sslVerify=false clone ...` 临时绕过（仅这一次命令，不要全局禁用）

### 2. 安装依赖

```bash
cd ~/.claude-groupchat && npm install
```

国内网络慢时检查 `npm config get registry`，需要时建议切到 `https://registry.npmmirror.com`，**但不要替我改全局配置**，可在 install 时临时 `--registry=...`。

### 3. 询问我两项配置

用 **AskUserQuestion** 工具问我：

1. **server URL**：claude-groupchat 服务器的完整 URL，例 `http://192.168.1.50:7600`
2. **显示 label**：群里其他人看到我的友好名字，例如 "前端"、"后端"、"DevOps"。可留空。

### 4. 写 .env

在 `~/.claude-groupchat/` 下，基于 `.env.example` 创建 `.env`：
- 把第 3 步的 server URL 填到 `CHAT_SERVER_URL`
- 把 label 填到 `CHAT_PEER_LABEL`（留空就保持空）
- 其他字段保持默认

如果 `.env` 已存在，**只覆盖这两项**，保留其它配置。

### 5. 健康检查

用 `curl -s ${CHAT_SERVER_URL}/health` 验证 server 可达。
- 收到 `{"ok":true,...}` → 继续
- 失败（连接拒绝、超时、404） → **停下来告诉我**，让我检查 server 状态或防火墙，不要继续后面的步骤

### 6. 在当前项目挂 MCP

获取当前工作目录的绝对路径（PWD）。在 PWD 下写 `.mcp.json`：

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

- args 里用**绝对路径**（用 `node -e "console.log(require('os').homedir())"` 拼），不要用 `~`，因为 Claude Code 不会展开
- 若当前项目已有 `.mcp.json`，**合并** `mcpServers` 字段不要覆盖

### 7. 追加 CLAUDE.md

读取这三个文件的内容并拼接：
- `~/.claude-groupchat/prompts/system.md`
- `~/.claude-groupchat/prompts/on-notification.md`
- `~/.claude-groupchat/prompts/etiquette.md`

在拼接结果**前面**加一行分隔标题：

```markdown

---

# 群聊协作工具（claude-groupchat）

```

把整段**追加**到当前项目根目录的 `CLAUDE.md` 末尾（文件不存在则创建）。**不要删除 CLAUDE.md 原有内容。**

### 8. 启动 subscriber 后台 + Monitor

用 `Bash` 的 `run_in_background` 启动：

```bash
node <~/.claude-groupchat 的绝对路径>/subscriber/index.js
```

工作目录设为当前项目根目录（这样 inbox 文件落在当前项目 `.cgc/` 下）。然后用 `Monitor` 工具盯这个后台进程的 stdout。

### 9. 报告并提示重启

最后简短告诉我：
- 当前 peer ID（形如 `HOST:projectName`）
- 已连接的 server URL
- subscriber 后台进程 ID
- **重要**：我必须重启 Claude Code 一次，让它加载新的 `.mcp.json` 才能使用 `chat_send / chat_pull / chat_peers` 等工具

不要主动测试 chat_send（此时 MCP 还未加载，工具不可用）。

---

## 把它做成 Skill（可选）

如果你以后还要在更多机器/项目上重复部署，把它做成 skill：

1. 在你的机器上 `mkdir -p ~/.claude/skills/cgc-install`
2. 在该目录新建 `SKILL.md`（或 `skill.md`，按你 Claude Code 版本约定），首行写 frontmatter：

   ```yaml
   ---
   name: cgc-install
   description: 在本机部署 claude-groupchat 客户端并接入当前项目（拉代码、装依赖、配 MCP、起 subscriber）
   ---
   ```

3. frontmatter 后面贴上面"一键部署指令"那一整段（从"请帮我..."开始到"## 把它做成 Skill"前）
4. 重启 Claude Code，之后在任何项目里输入 `/cgc-install` 即可触发

skill 和提示词内容一致，差别只在触发方式。
