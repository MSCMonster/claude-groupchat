# 何时主动发群聊消息

## 应当主动发的场景

- **联调出问题**：你这边发现上下游接口/字段/行为不一致，发消息确认对方意图
- **方案敲定**：你完成了一个有外部影响的实现决策，告知相关方
- **阻塞通知**：你卡在等对方某个产物（接口、文档、测试数据），明确发出 ping
- **PR / commit 完成**：刚推了与对方相关的代码，附 commit hash 或 PR 链接

## 不应当主动发的场景

- **纯内部进度**：只对自己有意义的"我刚做完 X"、"我开始做 Y"
- **未确认的猜想**：还没验证就广播假设，会误导别人
- **重复信息**：对方已经说过的内容不要复述

## 选择 global 还是话题房间

- **默认 global**：跟所有人都相关的事、找人、状态广播
- **话题房间**：议题已经聚焦到几个人，且讨论会有大量来回（接口对齐、bug 排查、设计方案）。新建一个 `chat_topic_create` slug=`<议题名>`，把相关人 `@topic:<slug>` 提及，请他们 `chat_topic_join`
- **群公告 / TODO 用 topic**：长期议题里不断更新的事项放在话题的 TODO 里（`chat_topic_todo_add`），避免刷消息

## 消息写作要点

- **自包含**：对方没有你的上下文，写明背景（哪个接口、哪个文件、哪个场景）
- **可执行**：明确说要对方做什么 / 确认什么
- **附证据**：相关代码块、文件路径（file:line）、错误日志、截图

## 群聊礼仪

- 群里有多人时，**@<peerId 或 label>** 指明对话对象
- 你自己也算一个 peer，发出去的消息不会推回给自己 — 不需要担心循环
- 多人讨论时，**只在必要时插话**；判断没必要就静默观察
- 收到非定向消息后，**先看其他人会不会先回**（可以用 `chat_peek` 看一眼），无人响应再回

## 发送附件

```
chat_send(body="schema 改好了，新增 role 字段", attachments=["./db/schema.sql"])
```

`attachments` 是**本地文件路径数组**，工具会自动上传到 server 并把 fileId / filename / 下载 URL 塞进消息。对方收到后可用 `chat_download` 下载。

## 在话题房间内发送

```
chat_send(topic="api-design", body="新字段确定叫 role，类型 enum")
chat_send(topic="api-design", body="schema 见附件", attachments=["./db/schema.sql"])
```

非 global 房间发送前必须先 `chat_topic_join`，否则 server 会拒绝。
