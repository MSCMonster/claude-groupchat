// HTTP 路由：文件上传与下载
'use strict';
const path = require('path');
const fs = require('fs');
const express = require('express');
const multer = require('multer');
const mime = require('mime-types');
const { v4: uuidv4 } = require('uuid');
const { getLogger } = require('../logger');

const log = getLogger('upload');

function buildRouter({ storage }) {
  const router = express.Router();

  // multer 落盘：使用 uuid 作为磁盘文件名，避免冲突与路径注入
  const diskStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, storage.uploadDir),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || '';
      cb(null, `${uuidv4()}${ext}`);
    }
  });

  const maxBytes = Number(process.env.MAX_FILE_SIZE_MB || 50) * 1024 * 1024;
  const upload = multer({
    storage: diskStorage,
    limits: { fileSize: maxBytes }
  });

  // POST /upload —— 字段名 file
  router.post('/upload', upload.single('file'), async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: '缺少文件字段 file' });
    }

    // multer 默认按 latin1 解析 multipart 文件名，中文会乱码
    const originalName = Buffer.from(req.file.originalname, 'latin1').toString('utf8');

    try {
      const meta = await storage.registerFile({
        originalName,
        mimeType: req.file.mimetype,
        size: req.file.size,
        storedPath: req.file.path
      });
      res.json({
        fileId: meta.fileId,
        filename: meta.filename,
        size: meta.size,
        mimeType: meta.mimeType
      });
    } catch (err) {
      log.error(`登记文件失败: ${err.message}`);
      try { fs.unlinkSync(req.file.path); } catch { /* ignore */ }
      res.status(500).json({ error: err.message });
    }
  });

  // GET /download?fileId=xxx 或 /download?filename=xxx
  router.get('/download', async (req, res) => {
    const { fileId, filename } = req.query;
    if (!fileId && !filename) {
      return res.status(400).json({ error: '需要 fileId 或 filename 参数' });
    }

    let meta = null;
    if (fileId) {
      meta = await storage.getFileById(String(fileId));
    } else if (filename) {
      meta = await storage.getFileByName(String(filename));
    }

    if (!meta) return res.status(404).json({ error: '文件不存在或已过期' });
    if (!fs.existsSync(meta.storedPath)) {
      return res.status(410).json({ error: '文件已被清理' });
    }

    const ct = meta.mimeType || mime.lookup(meta.filename) || 'application/octet-stream';
    res.setHeader('Content-Type', ct);
    // 文件名做 RFC 5987 编码以支持中文
    const safeName = encodeURIComponent(meta.filename);
    res.setHeader('Content-Disposition',
      `attachment; filename="${safeName}"; filename*=UTF-8''${safeName}`);
    res.setHeader('Content-Length', meta.size);

    fs.createReadStream(meta.storedPath)
      .on('error', (err) => {
        log.error(`下载流错误 ${meta.fileId}: ${err.message}`);
        if (!res.headersSent) res.status(500).end();
        else res.end();
      })
      .pipe(res);
  });

  // 文件元数据查询（debug 用）
  router.get('/files/:fileId', async (req, res) => {
    const meta = await storage.getFileById(req.params.fileId);
    if (!meta) return res.status(404).json({ error: '文件不存在' });
    res.json({
      fileId: meta.fileId,
      filename: meta.filename,
      size: meta.size,
      mimeType: meta.mimeType,
      createdAt: meta.createdAt
    });
  });

  return router;
}

module.exports = { buildRouter };
