// 存储层：消息历史走 Redis LIST、文件元数据走 Redis HASH + 创建时间 ZSET
// Redis 5.x 兼容（仅使用 SCAN / HSET 多字段 / ZADD / LPUSH / LTRIM / EXPIRE 等基础命令）
'use strict';
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const { v4: uuidv4 } = require('uuid');
const Redis = require('ioredis');
const { getLogger } = require('../logger');

const log = getLogger('storage');

class Storage {
  constructor(opts = {}) {
    this.prefix = opts.prefix || process.env.REDIS_PREFIX || 'cgc:';
    this.historyMax = Number(opts.historyMax || process.env.HISTORY_MAX_COUNT || 1000);
    this.historyPush = Number(opts.historyPush || process.env.HISTORY_PUSH_COUNT || 10);
    this.fileTtlMs = Number(opts.fileTtlHours || process.env.FILE_TTL_HOURS || 24) * 3600 * 1000;
    this.uploadDir = path.isAbsolute(opts.uploadDir || process.env.UPLOAD_DIR || '')
      ? (opts.uploadDir || process.env.UPLOAD_DIR)
      : path.join(__dirname, '..', opts.uploadDir || process.env.UPLOAD_DIR || 'uploads');

    fs.mkdirSync(this.uploadDir, { recursive: true });

    this.redis = new Redis({
      host: process.env.REDIS_HOST || '127.0.0.1',
      port: Number(process.env.REDIS_PORT || 6379),
      password: process.env.REDIS_PASSWORD || undefined,
      db: Number(process.env.REDIS_DB || 0),
      lazyConnect: false,
      maxRetriesPerRequest: 3
    });

    this.redis.on('error', (err) => log.error(`redis 错误: ${err.message}`));
    this.redis.on('connect', () => log.info('redis 已连接'));
  }

  // ===== 键名 =====
  kMessages() { return `${this.prefix}messages`; }
  kFile(fileId) { return `${this.prefix}file:${fileId}`; }
  kFilesByTime() { return `${this.prefix}files:by_time`; }
  kFilesByName(filename) { return `${this.prefix}files:name:${filename}`; }

  // ===== 启动：清空所有索引和文件（server 重启即清空） =====
  async resetAll() {
    log.info('清空 Redis 索引与上传目录');

    // 删 messages
    await this.redis.del(this.kMessages());

    // 取所有 fileId 并逐个删 hash
    const fileIds = await this.redis.zrange(this.kFilesByTime(), 0, -1);
    if (fileIds.length) {
      const pipe = this.redis.pipeline();
      for (const id of fileIds) pipe.del(this.kFile(id));
      await pipe.exec();
    }

    // 删两个索引
    await this.redis.del(this.kFilesByTime());

    // 扫描并删除所有 filename 索引（用 SCAN，避免 KEYS 阻塞）
    let cursor = '0';
    do {
      const [next, keys] = await this.redis.scan(
        cursor, 'MATCH', `${this.prefix}files:name:*`, 'COUNT', 200
      );
      cursor = next;
      if (keys.length) await this.redis.del(...keys);
    } while (cursor !== '0');

    // 清空 uploads 目录
    try {
      const entries = await fsp.readdir(this.uploadDir, { withFileTypes: true });
      await Promise.all(entries.map(e =>
        fsp.rm(path.join(this.uploadDir, e.name), { force: true, recursive: true })
      ));
    } catch (err) {
      log.warn(`清空 uploads 目录失败: ${err.message}`);
    }
  }

  // ===== 消息 =====
  // 追加一条消息（LPUSH + LTRIM 让最新在前、上限固定）
  async appendMessage(msg) {
    const payload = JSON.stringify(msg);
    const pipe = this.redis.pipeline();
    pipe.lpush(this.kMessages(), payload);
    pipe.ltrim(this.kMessages(), 0, this.historyMax - 1);
    await pipe.exec();
  }

  // 取最近 N 条（按时间正序返回，最旧的在前）
  async recentMessages(count) {
    const n = Math.max(1, Math.min(Number(count) || this.historyPush, this.historyMax));
    const items = await this.redis.lrange(this.kMessages(), 0, n - 1);
    return items.map(s => JSON.parse(s)).reverse();
  }

  // ===== 文件 =====
  // 已经落盘的文件登记到 Redis；返回完整元数据
  async registerFile({ originalName, mimeType, size, storedPath }) {
    const fileId = uuidv4();
    const createdAt = Date.now();
    const meta = {
      fileId,
      filename: originalName,
      mimeType: mimeType || 'application/octet-stream',
      size: Number(size) || 0,
      createdAt,
      storedPath
    };

    const pipe = this.redis.pipeline();
    pipe.hset(this.kFile(fileId), meta);
    pipe.zadd(this.kFilesByTime(), createdAt, fileId);
    // filename → fileId 反向索引（ZSET，按创建时间排，同名取最新）
    pipe.zadd(this.kFilesByName(originalName), createdAt, fileId);
    await pipe.exec();

    log.info(`文件登记 fileId=${fileId} filename=${originalName} size=${size}`);
    return meta;
  }

  async getFileById(fileId) {
    if (!fileId) return null;
    const meta = await this.redis.hgetall(this.kFile(fileId));
    if (!meta || !meta.fileId) return null;
    meta.size = Number(meta.size);
    meta.createdAt = Number(meta.createdAt);
    return meta;
  }

  // 按文件名查找最新一份
  async getFileByName(filename) {
    if (!filename) return null;
    // ZREVRANGE 取分数最大（最新）的一个
    const ids = await this.redis.zrevrange(this.kFilesByName(filename), 0, 0);
    if (!ids.length) return null;
    return this.getFileById(ids[0]);
  }

  // 清理过期文件（24h 之前的）
  async cleanupExpiredFiles() {
    const cutoff = Date.now() - this.fileTtlMs;
    const expiredIds = await this.redis.zrangebyscore(this.kFilesByTime(), '-inf', cutoff);
    if (!expiredIds.length) return 0;

    let deleted = 0;
    for (const id of expiredIds) {
      const meta = await this.getFileById(id);
      if (meta && meta.storedPath) {
        try {
          await fsp.unlink(meta.storedPath);
        } catch (err) {
          if (err.code !== 'ENOENT') log.warn(`删除文件失败 ${meta.storedPath}: ${err.message}`);
        }
      }
      const pipe = this.redis.pipeline();
      pipe.del(this.kFile(id));
      pipe.zrem(this.kFilesByTime(), id);
      if (meta && meta.filename) pipe.zrem(this.kFilesByName(meta.filename), id);
      await pipe.exec();
      deleted += 1;
    }

    log.info(`清理过期文件 ${deleted} 个`);
    return deleted;
  }

  async close() {
    try { await this.redis.quit(); } catch { /* ignore */ }
  }
}

module.exports = { Storage };
