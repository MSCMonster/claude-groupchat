// 统一日志：按 scope 分类，控制台彩色、文件按日切分；支持 reqId / jobId 关联
// 改编自 wenshuAgent/logger.js，补充 LOG_DIR 默认值与项目根目录定位
'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const winston = require('winston');
require('winston-daily-rotate-file');

// 项目根目录（logger.js 直接位于根目录）
const projectRoot = __dirname;

// 日志目录（LOG_DIR 缺省则使用 ./logs）
const logDir = path.isAbsolute(process.env.LOG_DIR || '')
  ? process.env.LOG_DIR
  : path.join(projectRoot, process.env.LOG_DIR || 'logs');
fs.mkdirSync(logDir, { recursive: true });

// 统一输出形状
const line = winston.format.printf(info => {
  const scope = info.scope ? `[${info.scope}]` : '';
  const rid = info.reqId ? ` reqId=${info.reqId}` : '';
  const jid = info.jobId ? ` jobId=${info.jobId}` : '';
  const msg = typeof info.message === 'string' ? info.message : JSON.stringify(info.message);
  return `${info.timestamp} [${info.level}]${scope}${rid}${jid} ${msg}`;
});

// 基础 logger（默认 info；可用环境变量 LOG_LEVEL=debug 调整）
const base = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
  transports: [
    new winston.transports.DailyRotateFile({
      dirname: logDir,
      filename: '%DATE%.log',
      datePattern: process.env.LOG_ROTATE_PATTERN || 'YYYY-MM-DD',
      zippedArchive: process.env.LOG_ZIPPED_ARCHIVE === 'true',
      maxFiles: process.env.LOG_MAX_FILES || null,
      format: winston.format.combine(winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }), line)
    }),
    new winston.transports.Console({
      // 当 LOG_TO_STDERR=true 时，所有日志级别都走 stderr
      // 用于 subscriber 这种 stdout 必须纯净（仅 JSON 事件行）的进程
      stderrLevels: process.env.LOG_TO_STDERR === 'true'
        ? ['error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly']
        : ['error', 'warn'],
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
        line
      )
    })
  ]
});

// 获取带 scope 的子 logger
function getLogger(scope) {
  return base.child({ scope });
}

// HTTP 日志专用 logger（可输出到独立目录）
const httpLogDir = process.env.HTTP_LOG_DIR
  ? (path.isAbsolute(process.env.HTTP_LOG_DIR)
      ? process.env.HTTP_LOG_DIR
      : path.join(projectRoot, process.env.HTTP_LOG_DIR))
  : null;
if (httpLogDir) fs.mkdirSync(httpLogDir, { recursive: true });

const httpLog = httpLogDir
  ? winston.createLogger({
      level: process.env.LOG_LEVEL || 'info',
      format: winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
      transports: [
        new winston.transports.DailyRotateFile({
          dirname: httpLogDir,
          filename: '%DATE%.log',
          datePattern: process.env.LOG_ROTATE_PATTERN || 'YYYY-MM-DD',
          zippedArchive: process.env.LOG_ZIPPED_ARCHIVE === 'true',
          maxFiles: process.env.LOG_MAX_FILES || null,
          format: winston.format.combine(winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }), line)
        }),
        new winston.transports.Console({
          format: winston.format.combine(
            winston.format.colorize(),
            winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
            line
          )
        })
      ]
    }).child({ scope: 'http' })
  : null;

// Express 中间件：HTTP 访问日志（打印请求体与响应体；无 uuid）
// 放在 body-parser（如 express.json()/urlencoded()）之后使用
function httpLogger({ maxBody = 4096 } = {}) {
  const log = httpLog || getLogger('http');

  // 文本类型判定（仅对常见文本类型解码）
  const isText = (ct = '') =>
    /^(text\/|application\/(json|xml|x-www-form-urlencoded|graphql))/.test(String(ct).toLowerCase());

  // 截断长文本，避免日志过大
  const cut = (s) => (s.length > maxBody ? s.slice(0, maxBody) + `…(+${s.length - maxBody})` : s);

  // 安全序列化对象
  const j = (v) => {
    try { return JSON.stringify(v); } catch { return '[JSON 序列化失败]'; }
  };

  return (req, res, next) => {
    const reqId = (crypto.randomUUID && crypto.randomUUID()) || crypto.randomBytes(8).toString('hex');
    req.reqId = reqId;
    const t0 = Date.now();

    // 读取请求体（依赖上游 body-parser）
    const reqCT = req.headers['content-type'] || '';
    const reqBody = req.body === undefined
      ? '[未解析的请求体]'
      : (isText(reqCT) ? cut(typeof req.body === 'string' ? req.body : j(req.body)) : '[非文本体]');

    // 劫持响应写入以捕获响应体
    const chunks = [];
    const _write = res.write;
    const _end = res.end;

    res.write = function (chunk, encoding, cb) {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
      return _write.call(this, chunk, encoding, cb);
    };

    res.end = function (chunk, encoding, cb) {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));

      const cost = Date.now() - t0;
      const buf = Buffer.concat(chunks);
      const resCT = res.getHeader('content-type') || '';
      const resBody = isText(resCT) ? cut(buf.toString('utf8')) : `<${buf.length} bytes 非文本体>`;

      // 统一结构化输出
      log.debug({
        method: req.method,
        url: req.originalUrl,
        status: res.statusCode,
        cost: `${cost}ms`,
        reqHeaders: req.headers,
        reqBody,
        resHeaders: typeof res.getHeaders === 'function' ? res.getHeaders() : {},
        resBody
      });

      return _end.call(this, chunk, encoding, cb);
    };

    next();
  };
}

module.exports = { getLogger, httpLogger };
