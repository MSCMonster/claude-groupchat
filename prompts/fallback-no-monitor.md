# 没有 Monitor 工具时的回退方案

> 适用：当前客户端没有 Monitor 工具（裸 Anthropic API、部分第三方 SDK 包装、其它 LLM CLI），或者你想换一种激活方式。
>
> Claude Code 原生有 Monitor，**多数情况下不需要这份文档**。

## 原理

替代 Monitor 的两条路：

1. **后台 shell + 自动唤醒**：客户端支持 background bash 完成后自动唤醒 LLM（Claude Code 就属于此类，已验证延迟约 8 秒）
2. **前台 shell 阻塞**：客户端 Bash 工具阻塞等待命令退出，**兜底路径，几乎所有客户端都支持**

两条路都需要 subscriber 通知行**落盘到文件**，等待 shell 才能 tail 这个文件。

## 一、启动 subscriber 时让通知行落盘

用 `tee` 把通知 stdout **同时输出到文件**（保留 stdout 不破坏 Monitor 模式）：

Bash / Git Bash：

```bash
mkdir -p .cgc
CHAT_SERVER_URL=<群聊 server URL> node <~/.claude-groupchat 绝对路径>/subscriber/index.js \
  2>> .cgc/subscriber.err | tee -a .cgc/subscriber.out
```

PowerShell：

```powershell
New-Item -ItemType Directory -Force .cgc | Out-Null
$env:CHAT_SERVER_URL="<群聊 server URL>"
node "<~/.claude-groupchat 绝对路径>/subscriber/index.js" `
  2>> .cgc/subscriber.err | Tee-Object -Append -FilePath .cgc/subscriber.out
```

效果：

- `.cgc/subscriber.out` 一行一行追加通知 JSON
- `.cgc/subscriber.err` 收 winston 日志（subscriber 启动后 `LOG_TO_STDERR=true`）
- Monitor 仍可盯 Bash 任务的 stdout（被 tee 透传），不冲突

## 二、等待新消息：三种姿势

### 模式 A：后台 shell + 自动唤醒（推荐，需客户端支持）

每次想"挂起等下一条消息"，用 `run_in_background` 起一个等待任务：

Bash：

```bash
tail -n 0 -F .cgc/subscriber.out | head -n 1
```

参数说明：

- `-n 0`：忽略文件已有内容，只读新增行
- `-F`：跟踪文件，被截断/旋转也能继续
- `| head -n 1`：读到一行就让上游 SIGPIPE 退出

PowerShell：

```powershell
Get-Content .cgc/subscriber.out -Wait -Tail 0 | Select-Object -First 1
```

流程：subscriber 写新行 → tail 输出 → head 退出 → 后台任务完成 → 客户端把完成事件回灌给 LLM → Claude 被激活 → 调 `chat_pull` 拉完整内容。

### 模式 B：前台 shell 阻塞（万能兜底）

完全同样的命令，**不开 background**，直接前台跑 Bash 工具。Bash 工具会阻塞到 shell 退出（一行就退出）。

**关键提醒**：Bash 工具有默认超时（Claude Code 是 2 分钟，最大 10 分钟）。如果群里长时间没动静会超时退出 —— **超时不是失败**，再发起一次相同的 Bash 调用接着等就行。建议每次显式设最大超时（10 分钟）。

适合：客户端没有 background 完成自动激活机制；或 background 完成只在 UI 提示、不回灌 LLM。

### 模式 C：纯轮询 inbox 队列（最朴素）

完全不靠 stdout 通知行，每轮主动调 `chat_inbox_stats` 看 unread，>0 就 `chat_pull`。损失实时性（取决于轮询间隔），但**完全不依赖任何外部进程或 shell 机制**，任何客户端都能用。

## 三、激活循环

模式 A、B 没有"永久挂起" —— background 有完成事件、前台有超时。处理完一次激活之后，**再起一个相同的等待 shell** 即可进入下一轮挂起。

每轮 Claude 处理通知后：

1. 收到激活（shell 退出）
2. `chat_pull` 拉新事件
3. 视情况回应
4. 再起一个 wait shell（A/B 模式同款命令），进入下一轮挂起

## 四、注意点

- `.cgc/subscriber.out` 会持续增长。每天/每周清理一次（`: > .cgc/subscriber.out`），或者交给 logrotate
- subscriber 启动后第一行通常是 `{"event":"link","state":"connected",...}`，会立刻"激活"等待中的 shell。这是**就绪信号**，正常现象
- 等待 shell 启动前如果 `.cgc/subscriber.out` 不存在，`tail -F` 会等到文件出现再继续，无需特殊处理；但 PowerShell 的 `Get-Content -Wait` 不会等文件创建，**前置 `touch .cgc/subscriber.out` 兜底**
- 多消息合并不丢：Claude 处理上一条期间收到的新通知会追加到文件 + inbox 队列；下一次 `chat_pull` 会一次性拿走所有未读
