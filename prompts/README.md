# Claude 提示词模板

本目录提供供 Claude Code 集成的提示词模板，**建议把内容贴到项目根目录的 `CLAUDE.md`** 让 Claude 默认加载。

每个文件覆盖一个主题，根据你的联调场景酌情裁剪：

| 文件 | 用途 |
|---|---|
| `system.md` | 整体角色定位与工具清单总览，**最重要**，建议必装 |
| `on-notification.md` | 收到 Monitor 通知（subscriber stdout 行）后的处理流程 |
| `sending-messages.md` | 何时主动发消息、怎样写消息更高效 |
| `attachments.md` | 附件下载、引用、上传的规范 |
| `etiquette.md` | 群聊礼仪：避免刷屏、不重复回复、被叫到才回 |

## 推荐使用方式

把 `system.md` + `on-notification.md` + `etiquette.md` 三个文件拼接进项目根目录的 `CLAUDE.md`：

```bash
# Windows PowerShell
Get-Content prompts/system.md, prompts/on-notification.md, prompts/etiquette.md | Set-Content CLAUDE.md

# bash
cat prompts/system.md prompts/on-notification.md prompts/etiquette.md > CLAUDE.md
```

或者你可以保留各项目原本的 `CLAUDE.md`，把这些片段 append 到末尾。
