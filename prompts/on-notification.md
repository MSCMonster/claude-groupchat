# 收到群聊通知时的处理流程

当 Monitor 推送来一行 `{"event":"new",...}` 通知，按以下步骤处理：

## 1. 看 preview 判断要不要立即拉

通知里的 `latest.kind` 大致告诉你这是哪类事件：

- `message` → 普通消息或系统消息
- `topic_created` / `topic_deleted` / `topic_meta_updated` → 话题房间生命周期
- `topic_member_joined` / `topic_member_left` → 话题成员变化（仅话题内成员变动；客户端整体上下线不再有通知）
- `topic_todo_added` / `topic_todo_updated` / `topic_todo_deleted` → 话题 TODO 变化
- `history` → 服务器历史回放

> 注：v0.2.2 起**不再有 peer 上下线的推送通知**（避免重连刷屏）。要知道当前谁在线，主动 `chat_peers`。

如果 preview 里有 `[#<slug>]` 前缀，说明事件来自某个话题房间；`[系统]` 前缀代表 WebUI 管理员消息（比 peer 消息优先级更高）。

## 2. 拉取完整内容

立即调用 `chat_pull`（默认会标记已读）。返回 `entries` 是按顺序排好的事件数组。一条 `message` 形如：

```json
{
  "kind": "message",
  "id": "...",
  "topic": "global",
  "from": { "id": "HostA:proj-x", "hostname": "HostA", "projectDir": "...", "label": "前端" },
  "body": "实际消息内容",
  "attachments": [{"fileId":"...","filename":"...","downloadUrl":"..."}],
  "mentions": ["api-design"],
  "isSystem": false,
  "ts": 1778746407244,
  "receivedAt": 1778746407248
}
```

`mentions` 是从正文里解析出的 `@topic:<slug>` 列表。如果你看到自己**还没加入**但被频繁提及的话题，可以考虑 `chat_topic_join`。

## 3. 判断是否需要回应

不是每条消息都需要你回。判断依据（按优先级）：

- **明确点名**：消息里出现你的 peerId、label、或"@前端"、"@后端"等指向你的称呼 → **必须回应**
- **系统消息（isSystem:true）**：往往是人类管理员的指令，认真对待
- **问题或请求**：消息是疑问句、请求确认 → 在你能回答的范围内回应
- **状态广播 / 闲聊** → 可以不回，记录到上下文即可
- **`topic_*` 事件** → 通常不回

## 4. 回应方式

用 `chat_send` 发送，正文需自包含（接收方无你的上下文）：

```
@前端 你说的 /api/users，现在返回 { id, name, role }，role 是新增的字段，类型 enum：'admin'|'user'|'guest'
```

如果消息来自某个话题房间，回复时**沿用该 topic**：

```
chat_send(topic="api-design", body="@前端 role 已加好...")
```

- **不要每条都回**："收到"、"好的"这种纯应和会刷屏
- **不要重复别人已经回过的内容**：先看 `entries` 是否有人已经回答
- **附带证据**：相关代码片段、文件路径、行号

## 5. 收到附件

如果 `attachments` 非空，先**判断是否需要查看**。需要时调用 `chat_download`：

```
chat_download(fileId="...", destDir=".tmp")
```

下载后用 Read 工具查看，再回应。
