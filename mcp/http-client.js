// HTTP 客户端：MCP server 调用 chat server 的上传/下载接口
'use strict';
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { getHttpUrl } = require('../shared/url');
const { getLogger } = require('../logger');

const log = getLogger('http-client');

function baseUrl() {
  return getHttpUrl();
}

// 上传单个文件，返回 server 端的 { fileId, filename, size, mimeType }
async function uploadFile(filePath) {
  const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
  const stat = await fsp.stat(absPath);
  if (!stat.isFile()) throw new Error(`不是文件: ${absPath}`);

  const filename = path.basename(absPath);
  // 用 Node 原生 FormData / Blob（Node 18+）
  const buf = await fsp.readFile(absPath);
  // 在 Node 中 Blob 需要包成 File-like，用 undici 的 Blob/File 也行；
  // 标准做法：fetch + FormData，FormData.append 第三参作为 filename
  const form = new FormData();
  form.append('file', new Blob([buf]), filename);

  const url = `${baseUrl()}/upload`;
  log.info(`上传 ${filename} (${stat.size} bytes) -> ${url}`);
  const res = await fetch(url, { method: 'POST', body: form });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`上传失败 ${res.status}: ${text}`);
  }
  return await res.json();
}

// 下载文件到 destDir，返回 { savedPath, filename, size }
async function downloadFile({ fileId, filename, destDir }) {
  if (!fileId && !filename) throw new Error('需要 fileId 或 filename');
  const params = new URLSearchParams();
  if (fileId) params.set('fileId', fileId);
  else params.set('filename', filename);
  const url = `${baseUrl()}/download?${params.toString()}`;

  log.info(`下载 ${url}`);
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`下载失败 ${res.status}: ${text}`);
  }

  // 从 Content-Disposition 提取文件名
  const cd = res.headers.get('content-disposition') || '';
  let resolvedName = filename || fileId;
  const m = cd.match(/filename\*=UTF-8''([^;]+)/i) || cd.match(/filename="([^"]+)"/i);
  if (m) {
    try { resolvedName = decodeURIComponent(m[1]); }
    catch { resolvedName = m[1]; }
  }

  const dest = path.isAbsolute(destDir) ? destDir : path.resolve(process.cwd(), destDir);
  await fsp.mkdir(dest, { recursive: true });
  const savedPath = path.join(dest, resolvedName);

  // 流式写入
  const buf = Buffer.from(await res.arrayBuffer());
  await fsp.writeFile(savedPath, buf);
  return { savedPath, filename: resolvedName, size: buf.length };
}

module.exports = { uploadFile, downloadFile, baseUrl };
