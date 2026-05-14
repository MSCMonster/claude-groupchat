# 附件处理规范

## 接收附件

消息 entry 的 `attachments` 数组每个元素：

```json
{
  "fileId": "uuid",
  "filename": "schema.sql",
  "size": 12345,
  "mimeType": "application/sql",
  "downloadUrl": "http://10.0.0.5:7601/download?fileId=uuid"
}
```

### 下载

**始终下载到本地 `./.tmp/` 目录**（项目根的 `.tmp/`，已在 `.gitignore` 中），避免污染项目。

```
chat_download(fileId="uuid", destDir=".tmp")
```

不传 `destDir` 默认就是 `.tmp`。下载完返回 `savedPath`，用 Read 工具查看。

### 用 fileId 还是 filename

- 优先用 `fileId`：唯一精确
- 用 `filename` 时：同名文件取**最新一份**（server 端按上传时间排序）

## 发送附件

```
chat_send(body="...", attachments=["./db/schema.sql", "./docs/api.md"])
```

- 路径相对当前工作目录（项目根）
- 工具会逐个上传，任意一个失败整个发送中止
- **单文件上限默认 50MB**（server 端 `MAX_FILE_SIZE_MB` 配置）
- 文件**保留 24 小时**后会被 server 自动清理

## 关于敏感文件

- 不要发送 `.env`、私钥、API token、生产数据库 dump 等敏感文件
- 联调通常只需要：schema、接口定义、示例数据（脱敏）、错误日志、配置模板

## 文件生命周期

| 阶段 | 位置 | 时效 |
|---|---|---|
| 上传 | server 上传目录 + Redis 元数据 | 24 小时 |
| 你下载后 | 本地 `./.tmp/` | 由你管理（建议联调结束清理） |
| Server 重启 | 全部清空 | 即时 |
