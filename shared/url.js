// URL 推导工具：从单一 CHAT_SERVER_URL 推出 ws / http 双形式
'use strict';

// 客户端基准 URL（http / https）
function getBaseUrl() {
  if (process.env.CHAT_SERVER_URL) {
    return String(process.env.CHAT_SERVER_URL).replace(/\/$/, '');
  }
  const host = process.env.WS_HOST || '127.0.0.1';
  const port = process.env.PORT || 7600;
  return `http://${host}:${port}`;
}

function getHttpUrl() {
  return getBaseUrl();
}

function getWsUrl() {
  const base = getBaseUrl();
  return base.replace(/^http(s?):\/\//i, (_, s) => `ws${s}://`);
}

module.exports = { getBaseUrl, getHttpUrl, getWsUrl };
