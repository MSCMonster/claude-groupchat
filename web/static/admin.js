// 管理面板：话题房间 CRUD + TODO + 成员
(function () {
  'use strict';
  const { api, toast, openStream, escapeHtml, formatTs } = CGC;

  const state = {
    user: null,
    topics: [],
    currentSlug: null,
    detail: null,
    todos: [],
    members: [],
    peers: []
  };

  const dom = {
    cards: document.getElementById('topic-cards'),
    detail: document.getElementById('admin-detail'),
    userTag: document.getElementById('user-tag'),
    logoutBtn: document.getElementById('logout-btn'),
    newTopicBtn: document.getElementById('new-topic-btn'),
    modalMask: document.getElementById('modal-mask'),
    modalContent: document.getElementById('modal-content')
  };

  async function init() {
    try {
      const sess = await api.session();
      if (!sess.authenticated) { location.href = '/web/login'; return; }
      state.user = sess.user;
      dom.userTag.textContent = '已登录：' + sess.user;
    } catch (e) { location.href = '/web/login'; return; }

    dom.logoutBtn.addEventListener('click', async () => {
      await api.logout(); location.href = '/web/login';
    });
    dom.newTopicBtn.addEventListener('click', showCreateModal);
    dom.modalMask.addEventListener('click', (e) => { if (e.target === dom.modalMask) closeModal(); });

    await refreshTopics();
    await refreshPeers();
    openStream(handleEvent);
  }

  async function refreshTopics() {
    const data = await api.listTopics();
    state.topics = data.topics || [];
    renderCards();
    if (state.currentSlug) renderDetail();
  }

  async function refreshPeers() {
    const data = await api.listPeers();
    state.peers = data.peers || [];
  }

  function renderCards() {
    dom.cards.innerHTML = '';
    for (const t of state.topics) {
      const card = document.createElement('div');
      card.className = 'admin-topic-card' + (t.slug === state.currentSlug ? ' active' : '');
      card.innerHTML = `
        <div class="slug">#${escapeHtml(t.slug)}</div>
        <div class="title">${escapeHtml(t.title || '')}</div>
        <div class="stats">${t.memberCount || 0} 名成员 · 创建于 ${formatTs(t.createdAt)}</div>
      `;
      card.addEventListener('click', () => selectTopic(t.slug));
      dom.cards.appendChild(card);
    }
  }

  async function selectTopic(slug) {
    state.currentSlug = slug;
    renderCards();
    await loadDetail(slug);
  }

  async function loadDetail(slug) {
    state.detail = state.topics.find(t => t.slug === slug);
    try {
      const [todosData, membersData] = await Promise.all([
        api.listTodos(slug), api.listMembers(slug)
      ]);
      state.todos = todosData.todos || [];
      state.members = membersData.members || [];
      renderDetail();
    } catch (e) { toast(e.message, 'error'); }
  }

  function renderDetail() {
    const t = state.detail;
    if (!t) { dom.detail.innerHTML = '<div class="empty">从左侧选择一个话题房间</div>'; return; }
    const isGlobal = t.slug === 'global';

    dom.detail.innerHTML = `
      <h2>#${escapeHtml(t.slug)}</h2>

      <div class="admin-section">
        <h3>基本元数据</h3>
        <div class="row"><label>标题</label><input type="text" id="meta-title" value="${escapeHtml(t.title || '')}"></div>
        <div class="row"><label>简介</label><input type="text" id="meta-desc" value="${escapeHtml(t.description || '')}"></div>
        <div class="row"><label>群公告</label><textarea id="meta-announce" rows="3">${escapeHtml(t.announcement || '')}</textarea></div>
        <div class="modal-actions" style="margin-top:8px">
          <button class="primary" id="save-meta">保存元数据</button>
          ${isGlobal ? '' : '<button class="danger" id="delete-topic">删除话题</button>'}
        </div>
      </div>

      <div class="admin-section">
        <h3>TODO / 群事项</h3>
        <div class="row">
          <input type="text" id="new-todo" placeholder="输入新事项后回车添加">
          <button class="primary" id="add-todo">添加</button>
        </div>
        <div id="todo-list"></div>
      </div>

      <div class="admin-section">
        <h3>成员${isGlobal ? '（默认聊天室）' : ''}</h3>
        <div class="row">
          <select id="add-member-select" style="flex:1"></select>
          <button class="primary" id="add-member">加入</button>
        </div>
        <div id="member-list"></div>
      </div>
    `;

    document.getElementById('save-meta').addEventListener('click', async () => {
      try {
        await api.updateTopic(t.slug, {
          title: document.getElementById('meta-title').value,
          description: document.getElementById('meta-desc').value,
          announcement: document.getElementById('meta-announce').value
        });
        toast('已保存', 'success');
        await refreshTopics();
        await loadDetail(t.slug);
      } catch (e) { toast(e.message, 'error'); }
    });

    if (!isGlobal) {
      document.getElementById('delete-topic').addEventListener('click', async () => {
        if (!confirm('确定删除话题 #' + t.slug + '？')) return;
        try {
          await api.deleteTopic(t.slug);
          toast('已删除', 'success');
          state.currentSlug = null;
          await refreshTopics();
          renderDetail();
        } catch (e) { toast(e.message, 'error'); }
      });
    }

    const newTodo = document.getElementById('new-todo');
    document.getElementById('add-todo').addEventListener('click', addTodo);
    newTodo.addEventListener('keydown', (e) => { if (e.key === 'Enter') addTodo(); });

    renderTodos();
    renderMembers();
  }

  async function addTodo() {
    const inp = document.getElementById('new-todo');
    const v = inp.value.trim();
    if (!v) return;
    try {
      await api.addTodo(state.currentSlug, v);
      inp.value = '';
      const data = await api.listTodos(state.currentSlug);
      state.todos = data.todos || [];
      renderTodos();
    } catch (e) { toast(e.message, 'error'); }
  }

  function renderTodos() {
    const wrap = document.getElementById('todo-list');
    if (!wrap) return;
    wrap.innerHTML = '';
    if (state.todos.length === 0) { wrap.innerHTML = '<div class="empty">暂无</div>'; return; }
    for (const td of state.todos) {
      const row = document.createElement('div');
      row.className = 'todo-row' + (td.done ? ' done' : '');
      row.innerHTML = `
        <input type="checkbox" ${td.done ? 'checked' : ''} data-id="${td.id}" class="t-done" style="width:16px;height:16px">
        <span class="content" contenteditable data-id="${td.id}">${escapeHtml(td.content)}</span>
        <button class="danger ghost t-del" data-id="${td.id}">删</button>
      `;
      wrap.appendChild(row);
    }
    wrap.querySelectorAll('.t-done').forEach(el => {
      el.addEventListener('change', async () => {
        const id = Number(el.dataset.id);
        try {
          await api.updateTodo(id, { done: el.checked });
          const data = await api.listTodos(state.currentSlug);
          state.todos = data.todos || [];
          renderTodos();
        } catch (e) { toast(e.message, 'error'); }
      });
    });
    wrap.querySelectorAll('.content').forEach(el => {
      el.addEventListener('blur', async () => {
        const id = Number(el.dataset.id);
        const content = el.textContent.trim();
        try { await api.updateTodo(id, { content }); }
        catch (e) { toast(e.message, 'error'); }
      });
    });
    wrap.querySelectorAll('.t-del').forEach(el => {
      el.addEventListener('click', async () => {
        const id = Number(el.dataset.id);
        if (!confirm('删除这条 TODO？')) return;
        try {
          await api.deleteTodo(id);
          state.todos = state.todos.filter(x => x.id !== id);
          renderTodos();
        } catch (e) { toast(e.message, 'error'); }
      });
    });
  }

  function renderMembers() {
    const wrap = document.getElementById('member-list');
    const sel = document.getElementById('add-member-select');
    if (!wrap || !sel) return;

    const memberIds = new Set(state.members.map(m => m.peerId));
    const candidates = state.peers.filter(p => !memberIds.has(p.id));
    sel.innerHTML = candidates.length
      ? candidates.map(p => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.label || p.id)} (${escapeHtml(p.id)})</option>`).join('')
      : '<option value="">（无其他可加入的 peer）</option>';

    document.getElementById('add-member').onclick = async () => {
      const v = sel.value;
      if (!v) return;
      try {
        await api.addMember(state.currentSlug, v);
        await loadDetail(state.currentSlug);
        await refreshTopics();
      } catch (e) { toast(e.message, 'error'); }
    };

    wrap.innerHTML = '';
    if (state.members.length === 0) { wrap.innerHTML = '<div class="empty">暂无成员</div>'; return; }
    for (const m of state.members) {
      const row = document.createElement('div');
      row.className = 'member-row';
      row.innerHTML = `
        <span style="width:8px;height:8px;border-radius:50%;background:${m.isOnline ? '#22c55e' : '#4a5872'};display:inline-block"></span>
        <span class="name">${escapeHtml(m.label || m.peerId)}</span>
        <span class="meta">${escapeHtml(m.peerId)}</span>
        <span class="meta">加入于 ${formatTs(m.joinedAt)}</span>
        <button class="danger ghost t-kick" data-id="${escapeHtml(m.peerId)}">踢出</button>
      `;
      wrap.appendChild(row);
    }
    wrap.querySelectorAll('.t-kick').forEach(el => {
      el.addEventListener('click', async () => {
        const peerId = el.dataset.id;
        if (!confirm('踢出 ' + peerId + '？')) return;
        try {
          await api.kickMember(state.currentSlug, peerId);
          await loadDetail(state.currentSlug);
          await refreshTopics();
        } catch (e) { toast(e.message, 'error'); }
      });
    });
  }

  function showCreateModal() {
    openModal(`
      <h2>新建话题房间</h2>
      <div class="form-row"><label>Slug</label><input type="text" id="m-slug" placeholder="如：api-design"></div>
      <div class="form-row"><label>标题</label><input type="text" id="m-title"></div>
      <div class="form-row"><label>简介</label><textarea id="m-desc" rows="3"></textarea></div>
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
        selectTopic(slug);
      } catch (e) { toast(e.message, 'error'); }
    });
  }

  function openModal(html) { dom.modalContent.innerHTML = html; dom.modalMask.classList.add('open'); }
  function closeModal() { dom.modalMask.classList.remove('open'); dom.modalContent.innerHTML = ''; }
  window.__cgcCloseModal = closeModal;

  function handleEvent(ev) {
    if (!ev || !ev.kind) return;
    if (['topic_created', 'topic_deleted', 'topic_meta_updated'].indexOf(ev.kind) >= 0) {
      refreshTopics();
    } else if (['topic_member_joined', 'topic_member_left',
                'topic_todo_added', 'topic_todo_updated', 'topic_todo_deleted'].indexOf(ev.kind) >= 0) {
      if (ev.topic && ev.topic.slug === state.currentSlug) loadDetail(state.currentSlug);
    } else if (ev.kind === 'topic_batch') {
      // 批量事件可能同时影响 meta + todo + 成员，稳妥起见两边都刷
      refreshTopics();
      if (ev.topic && ev.topic.slug === state.currentSlug) loadDetail(state.currentSlug);
    } else if (ev.type === 'peer_join' || ev.type === 'peer_leave') {
      refreshPeers();
    }
  }

  init().catch(e => console.error(e));
})();
