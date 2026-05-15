// 聊天页主逻辑
(function () {
  'use strict';
  const { api, toast, openStream, escapeHtml, formatTs, formatBytes, avatarOf } = CGC;

  // ===== Markdown 渲染初始化 =====
  // 依赖通过 CDN 加载（marked / DOMPurify / highlight.js / marked-highlight）。
  // 加载失败时退化为纯文本（escapeHtml + 保留换行）。
  const md = (function initMarkdown() {
    const ok = !!(window.marked && window.DOMPurify);
    if (!ok) return null;
    try {
      // 代码高亮扩展（marked-highlight + highlight.js）
      if (window.markedHighlight && window.hljs) {
        window.marked.use(window.markedHighlight.markedHighlight({
          langPrefix: 'hljs language-',
          highlight(code, lang) {
            const language = window.hljs.getLanguage(lang) ? lang : 'plaintext';
            try {
              return window.hljs.highlight(code, { language, ignoreIllegals: true }).value;
            } catch {
              return window.hljs.highlightAuto(code).value;
            }
          }
        }));
      }
      window.marked.setOptions({
        breaks: true,   // 单换行视为 <br>，更贴近聊天体验
        gfm: true       // 启用 GitHub 风格扩展（表格、删除线、任务列表等）
      });
      return {
        render(text) {
          const raw = window.marked.parse(text || '');
          // 净化，禁掉 <script>、on* 处理器等；保留常见富文本标签
          return window.DOMPurify.sanitize(raw, {
            USE_PROFILES: { html: true },
            ADD_ATTR: ['target', 'rel']
          });
        }
      };
    } catch (e) {
      console.warn('markdown 初始化失败，退化为纯文本：', e);
      return null;
    }
  })();

  const state = {
    user: null,
    currentTopic: 'global',
    topics: [],          // 全部
    joinedTopics: new Set(),
    peers: [],           // 全部 peer
    messages: [],
    earliestTs: null,
    hasMore: true,
    pendingFiles: [],    // 已上传的待发送文件
    todos: [],
    members: [],
    currentTopicMeta: null
  };

  const dom = {
    topicsList: document.getElementById('topics-list'),
    peersList: document.getElementById('peers-list'),
    messages: document.getElementById('messages'),
    loadMore: document.getElementById('load-more'),
    loadMoreBtn: document.getElementById('load-more-btn'),
    topicTitle: document.getElementById('topic-title'),
    topicDesc: document.getElementById('topic-desc'),
    topicAnnouncement: document.getElementById('topic-announcement'),
    topicTodosList: document.getElementById('topic-todos-list'),
    composerInput: document.getElementById('composer-input'),
    plusBtn: document.getElementById('plus-btn'),
    plusMenu: document.getElementById('plus-menu'),
    menuUpload: document.getElementById('menu-upload'),
    menuMention: document.getElementById('menu-mention-topic'),
    sendBtn: document.getElementById('send-btn'),
    fileInput: document.getElementById('file-input'),
    pendingAttachments: document.getElementById('pending-attachments'),
    userTag: document.getElementById('user-tag'),
    logoutBtn: document.getElementById('logout-btn'),
    newTopicBtn: document.getElementById('new-topic-btn'),
    modalMask: document.getElementById('modal-mask'),
    modalContent: document.getElementById('modal-content')
  };

  // ===== 启动 =====
  async function init() {
    try {
      const sess = await api.session();
      if (!sess.authenticated) { location.href = '/web/login'; return; }
      state.user = sess.user;
      dom.userTag.textContent = '已登录：' + sess.user;
    } catch (e) { location.href = '/web/login'; return; }

    bindEvents();
    await Promise.all([refreshTopics(), refreshPeers()]);
    await switchTopic('global');
    openEventStream();
  }

  // ===== 事件绑定 =====
  function bindEvents() {
    dom.logoutBtn.addEventListener('click', async () => {
      await api.logout();
      location.href = '/web/login';
    });
    dom.newTopicBtn.addEventListener('click', showCreateTopicModal);
    dom.plusBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      dom.plusMenu.classList.toggle('open');
    });
    document.addEventListener('click', (e) => {
      if (!dom.plusMenu.contains(e.target) && e.target !== dom.plusBtn) {
        dom.plusMenu.classList.remove('open');
      }
    });
    dom.menuUpload.addEventListener('click', () => {
      dom.plusMenu.classList.remove('open');
      dom.fileInput.click();
    });
    dom.menuMention.addEventListener('click', () => {
      dom.plusMenu.classList.remove('open');
      showMentionTopicModal();
    });
    dom.fileInput.addEventListener('change', onFilePicked);
    dom.sendBtn.addEventListener('click', sendMessage);
    dom.composerInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });
    dom.loadMoreBtn.addEventListener('click', () => loadMessages(true));
    dom.modalMask.addEventListener('click', (e) => {
      if (e.target === dom.modalMask) closeModal();
    });
  }

  // ===== 数据加载 =====
  async function refreshTopics() {
    const data = await api.listTopics();
    state.topics = data.topics || [];
    renderTopics();
  }

  async function refreshPeers() {
    const data = await api.listPeers();
    state.peers = data.peers || [];
    renderPeers();
  }

  async function switchTopic(slug) {
    state.currentTopic = slug;
    state.messages = [];
    state.earliestTs = null;
    state.hasMore = true;
    dom.messages.innerHTML = '<div class="load-more" id="load-more"><button class="ghost" id="load-more-btn">加载更早</button></div>';
    dom.loadMore = document.getElementById('load-more');
    dom.loadMoreBtn = document.getElementById('load-more-btn');
    dom.loadMoreBtn.addEventListener('click', () => loadMessages(true));
    renderTopics(); // 高亮变化
    await Promise.all([loadTopicMeta(slug), loadMessages(false)]);
  }

  async function loadTopicMeta(slug) {
    try {
      const t = state.topics.find(x => x.slug === slug);
      state.currentTopicMeta = t || { slug, title: slug };
      // 拉 todos
      const todosData = await api.listTodos(slug);
      state.todos = todosData.todos || [];
      // 拉 members
      const membersData = await api.listMembers(slug);
      state.members = membersData.members || [];
      renderTopicMeta();
      renderPeers();
    } catch (e) {
      toast('加载话题元数据失败：' + e.message, 'error');
    }
  }

  async function loadMessages(loadMore) {
    if (loadMore && !state.hasMore) return;
    const before = loadMore ? state.earliestTs : undefined;
    try {
      const data = await api.listMessages(state.currentTopic, before, 50);
      const msgs = (data.messages || []).slice().reverse(); // 转为正序
      if (msgs.length === 0) {
        state.hasMore = false;
      } else {
        state.earliestTs = msgs[0].ts;
        if (loadMore) state.messages = msgs.concat(state.messages);
        else state.messages = msgs;
      }
      state.hasMore = data.nextCursor != null;
      renderMessages(loadMore);
    } catch (e) {
      toast('加载消息失败：' + e.message, 'error');
    }
  }

  // ===== 渲染 =====
  function renderTopics() {
    dom.topicsList.innerHTML = '';
    for (const t of state.topics) {
      const li = document.createElement('li');
      li.className = (t.slug === state.currentTopic) ? 'active' : '';
      li.innerHTML = `
        <span class="topic-prefix">#</span>
        <span>${escapeHtml(t.title || t.slug)}</span>
        <span class="meta">${t.memberCount || 0}</span>
      `;
      li.addEventListener('click', () => switchTopic(t.slug));
      dom.topicsList.appendChild(li);
    }
  }

  function renderPeers() {
    dom.peersList.innerHTML = '';
    let list;
    if (state.currentTopic === 'global') {
      list = state.peers.slice();
    } else {
      // 显示话题成员，附加在线状态
      const onlineSet = new Set(state.peers.filter(p => p.isOnline).map(p => p.id));
      list = state.members.map(m => ({
        id: m.peerId,
        label: m.label,
        hostname: m.hostname,
        projectDir: m.projectDir,
        isOnline: onlineSet.has(m.peerId)
      }));
    }
    if (list.length === 0) {
      dom.peersList.innerHTML = '<li style="color:#6b7480;padding:6px 10px;font-size:12px">暂无</li>';
      return;
    }
    // 按在线优先排序
    list.sort((a, b) => (b.isOnline ? 1 : 0) - (a.isOnline ? 1 : 0));
    for (const p of list) {
      const li = document.createElement('li');
      li.innerHTML = `
        <span class="dot ${p.isOnline ? 'online' : ''}"></span>
        <span>${escapeHtml(p.label || p.id)}</span>
        ${p.label ? `<span class="meta">${escapeHtml(shortId(p.id))}</span>` : ''}
      `;
      li.addEventListener('click', () => showPeerDetail(p.id));
      dom.peersList.appendChild(li);
    }
  }

  function renderTopicMeta() {
    const t = state.currentTopicMeta;
    if (!t) return;
    dom.topicTitle.textContent = '#' + (t.title || t.slug);
    dom.topicDesc.textContent = t.description || '';
    if (t.announcement) {
      dom.topicAnnouncement.textContent = '📢 ' + t.announcement;
      dom.topicAnnouncement.style.display = 'block';
    } else {
      dom.topicAnnouncement.style.display = 'none';
    }
    dom.topicTodosList.innerHTML = '';
    if (state.todos.length === 0) {
      dom.topicTodosList.innerHTML = '<li style="color:#6b7480">无</li>';
    } else {
      for (const td of state.todos.slice(0, 6)) {
        const li = document.createElement('li');
        li.className = td.done ? 'done' : '';
        li.textContent = (td.done ? '✓ ' : '○ ') + td.content;
        dom.topicTodosList.appendChild(li);
      }
    }
  }

  function renderMessages(prepend) {
    const wasAtBottom = isScrolledToBottom();
    const scrollHeightBefore = dom.messages.scrollHeight;

    dom.messages.innerHTML = '';
    if (state.hasMore) {
      const lm = document.createElement('div');
      lm.className = 'load-more';
      const btn = document.createElement('button');
      btn.className = 'ghost'; btn.textContent = '加载更早';
      btn.addEventListener('click', () => loadMessages(true));
      lm.appendChild(btn);
      dom.messages.appendChild(lm);
    }
    for (const m of state.messages) {
      dom.messages.appendChild(renderMessage(m));
    }

    if (prepend) {
      // 保持滚动位置
      const heightDiff = dom.messages.scrollHeight - scrollHeightBefore;
      dom.messages.scrollTop = heightDiff;
    } else if (wasAtBottom) {
      dom.messages.scrollTop = dom.messages.scrollHeight;
    }
  }

  function renderMessage(m) {
    const wrap = document.createElement('div');
    wrap.className = 'message' + (m.isSystem ? ' system' : '');
    const name = m.from && (m.from.label || m.from.id) || '未知';
    wrap.innerHTML = `
      <div class="avatar">${escapeHtml(avatarOf(m.from && (m.from.label || m.from.id)))}</div>
      <div class="body">
        <div class="header">
          <span class="name">${escapeHtml(name)}</span>
          ${m.from && m.from.label ? `<span class="label">${escapeHtml(shortId(m.from.id))}</span>` : ''}
          ${m.topic && m.topic !== 'global' ? `<span class="label">#${escapeHtml(m.topic)}</span>` : ''}
          <span class="ts">${formatTs(m.ts)}</span>
        </div>
        ${renderAttachments(m.attachments)}
      </div>`;
    // 正文：markdown 渲染（依赖未就绪时退化为纯文本）
    const body = wrap.querySelector('.body');
    const textEl = document.createElement('div');
    if (md) {
      // markdown-body 是 github-markdown-css 提供的样式作用域类
      textEl.className = 'text markdown markdown-body';
      textEl.innerHTML = md.render(m.body || '');
      // 外链统一新窗口打开
      textEl.querySelectorAll('a[href]').forEach(a => {
        a.setAttribute('target', '_blank');
        a.setAttribute('rel', 'noopener noreferrer');
      });
    } else {
      textEl.className = 'text';
      textEl.innerHTML = linkifyTopicHtml(escapeHtml(m.body || ''));
    }
    // @topic:slug 转跳转链（跳过 code/pre 内的文本节点，避免误伤代码块）
    decorateTopicMentions(textEl);
    // 插入到 header 之后、attachments 之前
    const attachments = body.querySelector('.attachments');
    if (attachments) body.insertBefore(textEl, attachments);
    else body.appendChild(textEl);
    return wrap;
  }

  // 在已渲染的 DOM 节点内，把 @topic:slug 文本替换为可点击 span
  function decorateTopicMentions(rootEl) {
    const re = /@topic:([a-zA-Z0-9_\-:.]{1,64})/g;
    const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        // 跳过 code / pre 子树
        let p = node.parentElement;
        while (p && p !== rootEl) {
          const tag = p.tagName;
          if (tag === 'CODE' || tag === 'PRE') return NodeFilter.FILTER_REJECT;
          p = p.parentElement;
        }
        return re.test(node.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    });
    const targets = [];
    while (walker.nextNode()) targets.push(walker.currentNode);
    for (const node of targets) {
      const text = node.nodeValue;
      const frag = document.createDocumentFragment();
      let last = 0;
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text)) !== null) {
        if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
        const span = document.createElement('span');
        span.className = 'label';
        span.style.cursor = 'pointer';
        span.dataset.jump = m[1];
        span.textContent = '@topic:' + m[1];
        frag.appendChild(span);
        last = m.index + m[0].length;
      }
      if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
      node.parentNode.replaceChild(frag, node);
    }
  }

  // 纯文本退化路径下，原先的字符串级 @topic 替换（保留用于无 md 场景）
  function linkifyTopicHtml(html) {
    return html.replace(/@topic:([a-zA-Z0-9_\-:.]{1,64})/g,
      (_, slug) => `<span class="label" style="cursor:pointer" data-jump="${escapeHtml(slug)}">@topic:${escapeHtml(slug)}</span>`);
  }

  function renderAttachments(arr) {
    if (!arr || !arr.length) return '';
    const items = arr.map(a => `
      <div class="attachment">
        <a class="filename" href="/download?fileId=${encodeURIComponent(a.fileId)}" target="_blank">📎 ${escapeHtml(a.filename)}</a>
        <span class="size">${formatBytes(a.size || 0)}</span>
      </div>`).join('');
    return `<div class="attachments">${items}</div>`;
  }

  // 委托：点击 @topic:xx 切换房间
  document.addEventListener('click', (e) => {
    const target = e.target.closest('[data-jump]');
    if (target) {
      const slug = target.dataset.jump;
      if (state.topics.find(t => t.slug === slug)) switchTopic(slug);
    }
  });

  // ===== 发送 =====
  async function sendMessage() {
    const body = dom.composerInput.value.trim();
    if (!body && state.pendingFiles.length === 0) return;
    dom.sendBtn.disabled = true;
    try {
      const attachments = state.pendingFiles.map(f => ({
        fileId: f.fileId, filename: f.filename, size: f.size,
        mimeType: f.mimeType, downloadUrl: f.downloadUrl
      }));
      await api.sendMessage(state.currentTopic, body, attachments);
      dom.composerInput.value = '';
      state.pendingFiles = [];
      renderPendingAttachments();
    } catch (e) {
      toast('发送失败：' + e.message, 'error');
    } finally {
      dom.sendBtn.disabled = false;
    }
  }

  async function onFilePicked(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    try {
      toast('上传中：' + file.name);
      const data = await api.uploadFile(file);
      state.pendingFiles.push(data);
      renderPendingAttachments();
      toast('已上传 ' + file.name, 'success');
    } catch (err) {
      toast('上传失败：' + err.message, 'error');
    } finally {
      e.target.value = '';
    }
  }

  function renderPendingAttachments() {
    dom.pendingAttachments.innerHTML = '';
    state.pendingFiles.forEach((f, i) => {
      const tag = document.createElement('div');
      tag.className = 'pending-att';
      tag.innerHTML = `📎 ${escapeHtml(f.filename)} <span style="color:#6b7480">${formatBytes(f.size || 0)}</span>`;
      const x = document.createElement('button');
      x.textContent = '×'; x.title = '移除';
      x.addEventListener('click', () => {
        state.pendingFiles.splice(i, 1);
        renderPendingAttachments();
      });
      tag.appendChild(x);
      dom.pendingAttachments.appendChild(tag);
    });
  }

  // ===== Modal =====
  function openModal(html) {
    dom.modalContent.innerHTML = html;
    dom.modalMask.classList.add('open');
  }
  function closeModal() {
    dom.modalMask.classList.remove('open');
    dom.modalContent.innerHTML = '';
  }
  window.__cgcCloseModal = closeModal;

  function showCreateTopicModal() {
    openModal(`
      <h2>新建话题房间</h2>
      <div class="form-row">
        <label>Slug（标识）</label>
        <input type="text" id="m-slug" placeholder="如：api-design">
      </div>
      <div class="form-row">
        <label>标题</label>
        <input type="text" id="m-title">
      </div>
      <div class="form-row">
        <label>简介</label>
        <textarea id="m-desc" rows="3"></textarea>
      </div>
      <div class="modal-actions">
        <button class="ghost" onclick="window.__cgcCloseModal()">取消</button>
        <button class="primary" id="m-create">创建</button>
      </div>
    `);
    document.getElementById('m-create').addEventListener('click', async () => {
      const slug = document.getElementById('m-slug').value.trim();
      const title = document.getElementById('m-title').value.trim();
      const description = document.getElementById('m-desc').value.trim();
      if (!slug) return toast('Slug 必填', 'error');
      try {
        await api.createTopic({ slug, title, description });
        closeModal();
        await refreshTopics();
        switchTopic(slug);
      } catch (e) { toast(e.message, 'error'); }
    });
  }

  function showMentionTopicModal() {
    const opts = state.topics.filter(t => t.slug !== 'global').map(t =>
      `<option value="${escapeHtml(t.slug)}">${escapeHtml(t.title || t.slug)} (${escapeHtml(t.slug)})</option>`).join('');
    openModal(`
      <h2>提及话题房间</h2>
      <div class="form-row">
        <label>选择话题（将插入 @topic:slug 到正文）</label>
        <select id="m-topic">${opts || '<option value="">（无可选）</option>'}</select>
      </div>
      <div class="modal-actions">
        <button class="ghost" onclick="window.__cgcCloseModal()">取消</button>
        <button class="primary" id="m-insert">插入</button>
      </div>
    `);
    document.getElementById('m-insert').addEventListener('click', () => {
      const v = document.getElementById('m-topic').value;
      if (!v) return closeModal();
      const ta = dom.composerInput;
      const insert = '@topic:' + v + ' ';
      const start = ta.selectionStart || ta.value.length;
      ta.value = ta.value.slice(0, start) + insert + ta.value.slice(start);
      ta.focus();
      closeModal();
    });
  }

  async function showPeerDetail(peerId) {
    try {
      const data = await api.getPeer(peerId);
      const p = data.peer;
      const topics = (data.topics || []).map(t => `<li>#${escapeHtml(t.slug)} — ${escapeHtml(t.title)}</li>`).join('');
      openModal(`
        <h2>${escapeHtml(p.label || p.id)}</h2>
        <div class="modal-row"><b style="width:90px">peerId</b><span>${escapeHtml(p.id)}</span></div>
        <div class="modal-row"><b style="width:90px">主机名</b><span>${escapeHtml(p.hostname || '-')}</span></div>
        <div class="modal-row"><b style="width:90px">项目目录</b><span style="word-break:break-all">${escapeHtml(p.projectDir || '-')}</span></div>
        <div class="modal-row"><b style="width:90px">显示名</b><span>${escapeHtml(p.label || '-')}</span></div>
        <div class="modal-row"><b style="width:90px">在线</b><span>${p.isOnline ? '✅ 在线' : '⚪ 离线'}</span></div>
        <div class="modal-row"><b style="width:90px">首次见到</b><span>${formatTs(p.firstSeenAt)}</span></div>
        <div class="modal-row"><b style="width:90px">最近活跃</b><span>${formatTs(p.lastSeenAt)}</span></div>
        <div class="modal-row"><b style="width:90px">连接数</b><span>sender ${p.senderConns} / receiver ${p.receiverConns}</span></div>
        <div style="margin-top:14px">
          <h3 style="margin:6px 0;font-size:13px">已加入话题房间</h3>
          <ul style="margin:0;padding-left:18px">${topics || '<li style="color:#6b7480">无</li>'}</ul>
        </div>
        <div class="modal-actions">
          <button class="primary" onclick="window.__cgcCloseModal()">关闭</button>
        </div>
      `);
    } catch (e) { toast('加载失败：' + e.message, 'error'); }
  }

  // ===== 实时事件流 =====
  function openEventStream() {
    openStream(handleEvent, (e) => {
      // SSE 错误自动重连由浏览器内置；只提示
      console.warn('SSE error', e);
    });
  }

  function handleEvent(ev) {
    if (!ev || !ev.type) return;
    switch (ev.type) {
      case 'message':
        if (ev.topic === state.currentTopic) {
          state.messages.push(ev);
          renderMessages(false);
        }
        // 顶部 topic 列表通知
        break;
      case 'peer_join':
      case 'peer_leave':
        refreshPeers();
        break;
      case 'topic_event':
      // 服务器现在直接以 kind 字段表示子类型；type 是 TOPIC_EVENT
      default:
        if (['topic_created', 'topic_deleted', 'topic_meta_updated',
             'topic_member_joined', 'topic_member_left',
             'topic_todo_added', 'topic_todo_updated', 'topic_todo_deleted',
             'topic_batch'].indexOf(ev.kind) >= 0) {
          refreshTopics();
          if (ev.topic && ev.topic.slug === state.currentTopic) {
            loadTopicMeta(state.currentTopic);
          }
        }
    }
  }

  function isScrolledToBottom() {
    const m = dom.messages;
    return (m.scrollHeight - m.scrollTop - m.clientHeight) < 100;
  }
  function shortId(id) {
    if (!id) return '';
    return id.length > 30 ? id.slice(0, 28) + '…' : id;
  }

  init().catch(e => console.error(e));
})();
