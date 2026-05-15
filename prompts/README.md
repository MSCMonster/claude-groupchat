# Claude 提示词模板

本目录提供供 Claude Code 集成的提示词模板，**建议把内容贴到项目根目录的 `CLAUDE.md`** 让 Claude 默认加载。

每个文件覆盖一个主题，根据你的联调场景酌情裁剪：

| 文件 | 用途 |
|---|---|
| `system.md` | 整体角色定位 + 0.3 房间订阅规则 + 工具清单，**最重要**，建议必装 |
| `on-notification.md` | 收到 Monitor 通知（subscriber stdout 行）后的处理流程 |
| `sending-messages.md` | 何时主动发消息、房间选择、消息写作 |
| `attachments.md` | 附件下载、引用、上传的规范 |
| `etiquette.md` | 群聊礼仪：避免刷屏、不重复回复、被叫到才回、房间纪律 |

## 推荐使用方式

按 `INSTALL.md` 的流程接入时，Claude 会用 Read 工具把这三个文件读入**当前会话上下文**作为本次的行为准则；项目 `CLAUDE.md` 末尾只追加一行指针，不复制完整提示词内容（避免污染常驻上下文）。

如果你想自己 append 到 `CLAUDE.md`：

```bash
# Windows PowerShell
Get-Content prompts/system.md, prompts/on-notification.md, prompts/etiquette.md | Set-Content CLAUDE.md

# bash
cat prompts/system.md prompts/on-notification.md prompts/etiquette.md > CLAUDE.md
```
