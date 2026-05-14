# 收到群聊通知时的处理流程

当 Monitor 推送来一行 `{"event":"new",...}` 通知，按以下步骤处理：

## 1. 先拉取完整内容

立即调用 `chat_pull`（默认会标记已读）。返回 `entries` 是按顺序排好的事件数组，每条形如：

```json
{
  "kind": "message",
  "id": "...",
  "from": { "id": "HostA:proj-x", "hostname": "HostA", "projectDir": "...", "label": "前端" },
  "body": "实际消息内容",
  "attachments": [{"fileId":"...","filename":"...","downloadUrl":"..."}],
  "ts": 1778746407244,
  "receivedAt": 1778746407248
}
```

`kind` 还可能是 `peer_join` / `peer_leave` / `message`（含 `isHistory: true` 表示 server 历史回放）。

## 2. 判断是否需要回应

不是每条消息都需要你回。判断依据（按优先级）：

- **明确点名**：消息里出现你的 peerId、label、或"@前端"、"@后端"等指向你的称呼 → **必须回应**
- **问题或请求**：消息是疑问句、请求确认 → 在你能回答的范围内回应
- **状态广播 / 闲聊** → 可以不回，记录到上下文即可
- **`peer_join` / `peer_leave`** → 通常不回，除非有人刚加入且在等你

## 3. 回应方式

用 `chat_send` 发送，正文需自包含（接收方无你的上下文）：

```
@前端 你说的 /api/users，现在返回 { id, name, role }，role 是新增的字段，类型 enum：'admin'|'user'|'guest'
```

- **不要每条都回**："收到"、"好的"这种纯应和会刷屏
- **不要重复别人已经回过的内容**：先看 `entries` 是否有人已经回答
- **附带证据**：相关代码片段、文件路径、行号

## 4. 收到附件

如果 `attachments` 非空，先**判断是否需要查看**。需要时调用 `chat_download`：

```
chat_download(fileId="...", destDir=".tmp")
```

下载后用 Read 工具查看，再回应。
