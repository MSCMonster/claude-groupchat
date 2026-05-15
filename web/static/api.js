// 共享 API 帮助函数
(function (global) {
  'use strict';

  async function request(method, path, body, opts) {
    opts = opts || {};
    const init = {
      method,
      credentials: 'same-origin',
      headers: opts.headers || {}
    };
    if (body instanceof FormData) {
      init.body = body;
    } else if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const res = await fetch(path, init);
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('application/json') ? await res.json() : await res.text();
    if (!res.ok) {
      const err = new Error((data && data.error) || ('HTTP ' + res.status));
      err.status = res.status; err.data = data;
      throw err;
    }
    return data;
  }

  const api = {
    get: (p) => request('GET', p),
    post: (p, b) => request('POST', p, b),
    patch: (p, b) => request('PATCH', p, b),
    del: (p) => request('DELETE', p),
    upload: (p, file) => {
      const fd = new FormData();
      fd.append('file', file);
      return request('POST', p, fd);
    },
    // ----- 高层封装 -----
    session: () => request('GET', '/web/api/session'),
    login: (username, password) => request('POST', '/web/api/login', { username, password }),
    logout: () => request('POST', '/web/api/logout'),
    listTopics: () => request('GET', '/web/api/topics'),
    createTopic: (data) => request('POST', '/web/api/topics', data),
    deleteTopic: (slug) => request('DELETE', '/web/api/topics/' + encodeURIComponent(slug)),
    updateTopic: (slug, patch) => request('PATCH', '/web/api/topics/' + encodeURIComponent(slug), patch),
    listMembers: (slug) => request('GET', '/web/api/topics/' + encodeURIComponent(slug) + '/members'),
    addMember: (slug, peerId) => request('POST', '/web/api/topics/' + encodeURIComponent(slug) + '/members', { peerId }),
    kickMember: (slug, peerId) => request('DELETE',
      '/web/api/topics/' + encodeURIComponent(slug) + '/members/' + encodeURIComponent(peerId)),
    listTodos: (slug) => request('GET', '/web/api/topics/' + encodeURIComponent(slug) + '/todos'),
    addTodo: (slug, content) => request('POST', '/web/api/topics/' + encodeURIComponent(slug) + '/todos', { content }),
    updateTodo: (id, patch) => request('PATCH', '/web/api/todos/' + id, patch),
    deleteTodo: (id) => request('DELETE', '/web/api/todos/' + id),
    listMessages: (topic, beforeTs, pageSize) => {
      const qs = new URLSearchParams({ topic: topic || 'global' });
      if (beforeTs) qs.set('beforeTs', beforeTs);
      if (pageSize) qs.set('pageSize', pageSize);
      return request('GET', '/web/api/messages?' + qs.toString());
    },
    sendMessage: (topic, body, attachments) =>
      request('POST', '/web/api/messages', { topic, body, attachments }),
    listPeers: () => request('GET', '/web/api/peers'),
    getPeer: (id) => request('GET', '/web/api/peers/' + encodeURIComponent(id)),
    listFiles: (limit) => request('GET', '/web/api/files' + (limit ? '?limit=' + limit : '')),
    deleteFile: (id) => request('DELETE', '/web/api/files/' + encodeURIComponent(id)),
    uploadFile: (file) => {
      const fd = new FormData();
      fd.append('file', file);
      return request('POST', '/web/api/files', fd);
    }
  };

  // ===== Toast =====
  function ensureToastContainer() {
    let c = document.querySelector('.toast-container');
    if (!c) { c = document.createElement('div'); c.className = 'toast-container'; document.body.appendChild(c); }
    return c;
  }
  function toast(message, kind, ms) {
    const c = ensureToastContainer();
    const el = document.createElement('div');
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.textContent = message;
    c.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; }, (ms || 3000) - 300);
    setTimeout(() => el.remove(), ms || 3000);
  }

  // ===== SSE =====
  function openStream(onEvent, onError) {
    const es = new EventSource('/web/api/stream', { withCredentials: true });
    es.onmessage = (ev) => {
      try { onEvent(JSON.parse(ev.data)); } catch (e) { /* ignore */ }
    };
    es.onerror = (e) => { if (onError) onError(e); };
    return es;
  }

  // ===== 工具 =====
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function formatTs(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const today = new Date();
    const sameDay = d.getFullYear() === today.getFullYear()
      && d.getMonth() === today.getMonth() && d.getDate() === today.getDate();
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    if (sameDay) return `${hh}:${mm}`;
    const M = String(d.getMonth() + 1).padStart(2, '0');
    const D = String(d.getDate()).padStart(2, '0');
    return `${M}-${D} ${hh}:${mm}`;
  }
  function formatBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(2) + ' MB';
  }
  function avatarOf(idOrLabel) {
    if (!idOrLabel) return '?';
    const s = String(idOrLabel);
    return s.charAt(0).toUpperCase();
  }

  global.CGC = {
    api, toast, openStream, escapeHtml, formatTs, formatBytes, avatarOf
  };
})(window);
