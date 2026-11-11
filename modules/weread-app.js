// 微信读书独立 App：书架、进度、目录、笔记/划线。
// API Key 只存在 Cloudflare Worker；前端只保存 Worker 地址和可选访问口令。
(function () {
  'use strict';

  const CONFIG_KEY = 'wereadSyncConfig';
  const SKILL_VERSION = '1.0.5';
  const SHELF_PAGE_SIZE = 50;
  const DEFAULT_DISCUSSION_PROMPT = `你是{{char}}，正在和{{user}}讨论《{{title}}》中的一段划线。

你只是读者，不是书中角色。不要续写书中剧情，不要扮演书中人物。请以你自己的性格、经历和价值观来讨论这段文字。

书名：{{title}}
作者：{{author}}
章节：{{chapter}}
划线：{{quote}}
我的批注：{{note}}

最近聊天记录：
{{recentChat}}

请针对这段划线，写 100–200 字左右的看法。不要写成分析报告。`;
  let state = { shelf: null, book: null, notes: null, loading: false, search: '', sort: 'recent', page: 1 };

  const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));

  function getConfig() {
    try {
      const value = JSON.parse(localStorage.getItem(CONFIG_KEY) || '{}');
      return {
        proxyUrl: String(value.proxyUrl || '').trim(),
        appToken: String(value.appToken || '')
      };
    } catch (_) {
      return { proxyUrl: '', appToken: '', prompt: DEFAULT_DISCUSSION_PROMPT, historyCount: 30, temperature: '', maxTokens: '' };
    }
  }

  function saveConfig(config) {
    localStorage.setItem(CONFIG_KEY, JSON.stringify({
      proxyUrl: String(config.proxyUrl || '').trim(),
      appToken: String(config.appToken || '')
    }));
  }

  function formatTimestamp(value) {
    const timestamp = Number(value);
    if (!Number.isFinite(timestamp) || timestamp <= 0) return '';
    return new Date(timestamp * 1000).toLocaleDateString('zh-CN');
  }

  function formatReadTime(seconds) {
    const total = Math.max(0, Number(seconds) || 0);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    return hours ? `${hours}小时${minutes}分钟` : `${minutes}分钟`;
  }

  async function gateway(apiName, params = {}) {
    const config = getConfig();
    if (!config.proxyUrl) throw new Error('请先填写微信读书 Worker 地址。');
    const response = await fetch(config.proxyUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.appToken ? { 'X-App-Token': config.appToken } : {})
      },
      body: JSON.stringify({
        api_name: apiName,
        skill_version: SKILL_VERSION,
        ...params
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || (data.errcode && Number(data.errcode) !== 0)) {
      throw new Error(data.errmsg || data.error || `HTTP ${response.status}`);
    }
    return data;
  }

  async function callDiscussionAi(systemPrompt, userPrompt, history = [], temperature = 0.7, maxTokens = 300) {
    const api = window.state?.apiConfig || {};
    if (!api.proxyUrl || !api.apiKey || !api.model) throw new Error('请先在 API 设置中配置模型。');
    const isGemini = String(api.proxyUrl).includes('generativelanguage');
    let response;
    if (isGemini && typeof toGeminiRequestData === 'function') {
      const chatMessages = [...(history || []).map(message => ({ role: message.role, content: message.content })), { role: 'user', content: userPrompt }];
      const cfg = toGeminiRequestData(api.model, api.apiKey, systemPrompt, chatMessages);
      try {
        const body = JSON.parse(cfg.data.body);
        body.generationConfig = { ...(body.generationConfig || {}), temperature, maxOutputTokens: maxTokens };
        cfg.data = { ...cfg.data, body: JSON.stringify(body) };
      } catch (_) {}
      response = await fetch(cfg.url, cfg.data);
    } else {
      response = await fetch(`${String(api.proxyUrl).replace(/\/+$/, '')}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${api.apiKey}` },
        body: JSON.stringify({
          model: api.model,
          messages: [{ role: 'system', content: systemPrompt }, ...(history || []), { role: 'user', content: userPrompt }],
          temperature,
          max_tokens: maxTokens
        })
      });
    }
    if (!response.ok) throw new Error(`API ${response.status}`);
    const data = await response.json();
    return String(typeof getGeminiResponseText === 'function' ? getGeminiResponseText(data) : data.choices?.[0]?.message?.content || '').trim();
  }
  function setContent(html) {
    const content = document.getElementById('weread-content');
    if (content) content.innerHTML = html;
  }

  function renderSetup(message = '') {
    setContent(`
      <div style="padding:28px 8px; text-align:center;">
        <div style="font-size:42px; margin-bottom:12px;">📚</div>
        <h3 style="margin:0 0 8px;">连接微信读书</h3>
        <p style="font-size:13px; line-height:1.7; color:var(--text-secondary);">先部署微信读书 Worker，然后在设置中填写 Worker 地址。</p>
        ${message ? `<p style="font-size:13px; color:#c0392b;">${esc(message)}</p>` : ''}
        <button type="button" class="form-button" id="weread-open-settings" style="margin-top:16px;">打开设置</button>
      </div>`);
    document.getElementById('weread-open-settings')?.addEventListener('click', openSettings);
  }

  async function loadShelf() {
    state.loading = true;
    renderLoading('正在读取书架…');
    try {
      const data = await gateway('/shelf/sync');
      state.shelf = data;
      renderShelf();
    } catch (error) {
      renderSetup(error.message || String(error));
    } finally {
      state.loading = false;
    }
  }

  function renderLoading(text) {
    setContent(`<div style="padding:40px 10px; text-align:center; color:var(--text-secondary);">${esc(text)}</div>`);
  }

  function getBooks(data) {
    const books = Array.isArray(data?.books) ? data.books.map(book => ({
      bookId: book.bookId,
      title: book.title || '未命名',
      author: book.author || '',
      cover: book.cover || '',
      category: book.category || '',
      readerLink: book.readerLink || '',
      deepLink: book.deepLink || '',
      isAlbum: false,
      finishReading: Number(book.finishReading) === 1,
      updateTime: book.updateTime,
      readUpdateTime: Number(book.readUpdateTime || book.updateTime) || 0
    })) : [];
    const albums = Array.isArray(data?.albums) ? data.albums.map(item => {
      const info = item.albumInfo || {};
      return {
        bookId: info.albumId,
        title: info.name || '未命名专辑',
        author: info.authorName || '',
        cover: info.cover || '',
        category: '有声书',
        readerLink: info.readerLink || '',
        deepLink: info.deepLink || '',
        isAlbum: true,
        finishReading: Number(info.finish) === 1,
        updateTime: info.updateTime,
        readUpdateTime: Number(item.albumInfoExtra?.lectureReadUpdateTime || info.updateTime) || 0
      };
    }) : [];
    return [...books, ...albums];
  }

  function getVisibleShelfBooks() {
    const books = getBooks(state.shelf);
    const query = String(state.search || '').trim().toLowerCase();
    const filtered = query
      ? books.filter(book =>
        String(book.title || '').toLowerCase().includes(query) ||
        String(book.author || '').toLowerCase().includes(query)
      )
      : books;
    filtered.sort((a, b) => {
      if (state.sort === 'alpha') {
        return String(a.title || '').localeCompare(String(b.title || ''), 'zh-Hans-CN', { sensitivity: 'base' });
      }
      return (Number(b.readUpdateTime) || 0) - (Number(a.readUpdateTime) || 0);
    });
    return { books: filtered, total: books.length };
  }

  function renderShelfBookList() {
    const list = document.getElementById('weread-shelf-list');
    if (!list) return;
    const { books, total } = getVisibleShelfBooks();
    const totalPages = Math.max(1, Math.ceil(books.length / SHELF_PAGE_SIZE));
    state.page = Math.max(1, Math.min(totalPages, Number(state.page) || 1));
    const start = (state.page - 1) * SHELF_PAGE_SIZE;
    const pageBooks = books.slice(start, start + SHELF_PAGE_SIZE);
    const countEl = document.getElementById('weread-shelf-count');
    if (countEl) {
      countEl.textContent = books.length
        ? `${start + 1}–${Math.min(books.length, start + SHELF_PAGE_SIZE)} / ${books.length} 个条目`
        : '0 个条目';
    }
    list.innerHTML = '';
    if (!books.length) {
      list.innerHTML = `<div style="padding:30px; text-align:center; color:var(--text-secondary);">${state.search ? '没有匹配的书籍。' : '书架为空。'}</div>`;
    } else {
      pageBooks.forEach(book => {
        const item = document.createElement('button');
        item.type = 'button';
        item.style.cssText = 'display:flex; width:100%; gap:12px; align-items:center; padding:12px 0; border:none; border-bottom:1px solid var(--border-color,#eee); background:transparent; text-align:left; color:inherit;';
        item.innerHTML = `
          <div style="width:54px; height:76px; border-radius:5px; overflow:hidden; background:#eee; flex-shrink:0;">
            ${book.cover ? `<img src="${esc(book.cover)}" alt="" style="width:100%; height:100%; object-fit:cover;">` : ''}
          </div>
          <div style="flex:1; min-width:0;">
            <div style="font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${esc(book.title)}</div>
            <div class="settings-desc" style="margin-top:3px;">${esc(book.author || book.category || '')}</div>
            <div class="settings-desc" style="margin-top:3px;">${book.isAlbum ? '有声书' : '电子书'}${book.finishReading ? ' · 已读完' : ''}</div>
          </div>
          <span style="color:#bbb;">›</span>`;
        item.addEventListener('click', () => openBook(book));
        list.appendChild(item);
      });
    }
    const pagination = document.getElementById('weread-shelf-pagination');
    if (pagination) {
      pagination.innerHTML = totalPages > 1
        ? `<button type="button" class="settings-mini-btn" id="weread-page-prev" ${state.page <= 1 ? 'disabled' : ''}>上一页</button><span style="font-size:12px; color:var(--text-secondary);">第 ${state.page} / ${totalPages} 页</span><button type="button" class="settings-mini-btn" id="weread-page-next" ${state.page >= totalPages ? 'disabled' : ''}>下一页</button>`
        : '';
      document.getElementById('weread-page-prev')?.addEventListener('click', () => {
        state.page = Math.max(1, state.page - 1);
        renderShelfBookList();
      });
      document.getElementById('weread-page-next')?.addEventListener('click', () => {
        state.page = Math.min(totalPages, state.page + 1);
        renderShelfBookList();
      });
    }
  }
  function renderShelf() {
    setContent(`
      <div style="display:flex; align-items:center; justify-content:space-between; padding:16px 0 10px;">
        <div><h2 style="margin:0;">书架</h2><div class="settings-desc" id="weread-shelf-count"></div></div>
        <button type="button" class="settings-mini-btn" id="weread-refresh-shelf">刷新</button>
      </div>
      <div style="display:flex; gap:8px; margin-bottom:8px;">
        <input type="search" id="weread-shelf-search" placeholder="搜索书名或作者…" value="${esc(state.search)}" style="flex:1; min-width:0; padding:8px 10px; border:1px solid var(--border-color); border-radius:7px; background:var(--secondary-bg); color:var(--text-primary);">
        <select id="weread-shelf-sort" style="padding:8px; border:1px solid var(--border-color); border-radius:7px; background:var(--secondary-bg); color:var(--text-primary);">
          <option value="recent" ${state.sort === 'recent' ? 'selected' : ''}>最近阅读</option>
          <option value="alpha" ${state.sort === 'alpha' ? 'selected' : ''}>书名首字母</option>
        </select>
      </div>
      <div id="weread-shelf-list"></div>
      <div id="weread-shelf-pagination" style="display:flex; align-items:center; justify-content:center; gap:10px; padding:14px 0;"></div>`);
    document.getElementById('weread-refresh-shelf')?.addEventListener('click', loadShelf);
    document.getElementById('weread-shelf-search')?.addEventListener('input', event => {
      state.search = event.target.value;
      state.page = 1;
      renderShelfBookList();
    });
    document.getElementById('weread-shelf-sort')?.addEventListener('change', event => {
      state.sort = event.target.value === 'alpha' ? 'alpha' : 'recent';
      state.page = 1;
      renderShelfBookList();
    });
    renderShelfBookList();
  }
  async function openBook(book) {
    state.book = book;
    state.notes = null;
    renderLoading('正在读取书籍信息…');
    try {
      const [infoResult, progressResult, chapterResult] = await Promise.all([
        gateway('/book/info', { bookId: book.bookId }).catch(() => ({})),
        gateway('/book/getprogress', { bookId: book.bookId }).catch(() => ({})),
        gateway('/book/chapterinfo', { bookId: book.bookId }).catch(() => ({}))
      ]);
      renderBookDetail(book, infoResult, progressResult, chapterResult);
    } catch (error) {
      renderBookError(book, error.message || String(error));
    }
  }

  function renderBookError(book, message) {
    setContent(`
      <div style="padding:16px 0;">
        <button type="button" class="settings-mini-btn" id="weread-back-shelf">‹ 返回书架</button>
        <h2 style="margin:16px 0 6px;">${esc(book.title)}</h2>
        <div style="color:#c0392b; font-size:13px;">${esc(message)}</div>
      </div>`);
    document.getElementById('weread-back-shelf')?.addEventListener('click', renderShelf);
  }

  function renderBookDetail(book, info, progress, chapters) {
    const detail = info?.book || info || {};
    const progressBook = progress?.book || progress || {};
    const percent = Number(progressBook.progress) || 0;
    const chaptersList = Array.isArray(chapters?.chapters) ? chapters.chapters : [];
    const cover = detail.cover || book.cover;
    const readerLink = detail.readerLink || book.readerLink;
    setContent(`
      <div style="padding:14px 0;">
        <button type="button" class="settings-mini-btn" id="weread-back-shelf">‹ 返回书架</button>
        <div style="display:flex; gap:14px; margin:16px 0;">
          <div style="width:78px; height:110px; border-radius:6px; overflow:hidden; background:#eee; flex-shrink:0;">
            ${cover ? `<img src="${esc(cover)}" alt="" style="width:100%; height:100%; object-fit:cover;">` : ''}
          </div>
          <div style="flex:1; min-width:0;">
            <h2 style="margin:0 0 6px; font-size:20px;">${esc(detail.title || book.title)}</h2>
            <div class="settings-desc">${esc(detail.author || book.author || '')}</div>
            <div style="font-size:13px; margin-top:8px;">阅读进度：<strong>${percent}%</strong></div>
            <div class="settings-desc">${formatReadTime(progressBook.recordReadingTime)}</div>
          </div>
        </div>
        <div style="display:flex; gap:8px; margin-bottom:12px; flex-wrap:wrap;">
          ${readerLink ? `<a class="settings-mini-btn" href="${esc(readerLink)}" target="_blank" rel="noopener" style="text-decoration:none;">打开微信读书</a>` : ''}
          <button type="button" class="settings-mini-btn" id="weread-load-notes">同步笔记/划线</button>
        </div>
        <div style="font-size:12px; color:var(--text-secondary); margin-bottom:10px;">${chaptersList.length} 个目录条目</div>
        <div id="weread-chapter-list" style="max-height:230px; overflow-y:auto; border-top:1px solid var(--border-color,#eee);"></div>
        <div id="weread-note-list" style="margin-top:14px;"></div>
      </div>`);
    document.getElementById('weread-back-shelf')?.addEventListener('click', renderShelf);
    document.getElementById('weread-load-notes')?.addEventListener('click', () => loadNotes(book));
    const chapterList = document.getElementById('weread-chapter-list');
    if (!chaptersList.length) {
      chapterList.innerHTML = '<div style="padding:16px 0; color:var(--text-secondary);">暂无目录。</div>';
    } else {
      chaptersList.forEach(chapter => {
        const row = document.createElement('div');
        row.style.cssText = `padding:7px 0 7px ${Math.max(0, Number(chapter.level) - 1) * 16}px; border-bottom:1px solid var(--border-color,#eee); font-size:13px;`;
        row.textContent = chapter.title || `第 ${chapter.chapterIdx || ''} 章`;
        chapterList.appendChild(row);
      });
    }
  }

  async function loadNotes(book) {
    const target = document.getElementById('weread-note-list');
    if (target) target.innerHTML = '<div style="padding:12px 0; color:var(--text-secondary);">正在读取笔记…</div>';
    try {
      const [highlights, reviews] = await Promise.all([
        gateway('/book/bookmarklist', { bookId: book.bookId }).catch(() => ({})),
        gateway('/review/list/mine', { bookid: book.bookId }).catch(() => ({}))
      ]);
      const chapterMap = {};
      (Array.isArray(highlights?.chapters) ? highlights.chapters : []).forEach(chapter => {
        if (chapter?.chapterUid) chapterMap[chapter.chapterUid] = chapter.title || '';
      });
      state.notes = { highlights, reviews, chapterMap };
      renderNotes(highlights, reviews, chapterMap);
    } catch (error) {
      if (target) target.innerHTML = `<div style="color:#c0392b; font-size:13px;">${esc(error.message || String(error))}</div>`;
    }
  }

  function renderNotes(highlightsData, reviewsData, chapterMap = {}) {
    const target = document.getElementById('weread-note-list');
    if (!target) return;
    const highlights = Array.isArray(highlightsData?.updated) ? highlightsData.updated : [];
    const reviews = Array.isArray(reviewsData?.reviews) ? reviewsData.reviews : [];
    const cards = [];
    highlights.forEach((item, index) => {
      const chapter = chapterMap[item.chapterUid] || '';
      cards.push(`<div style="padding:10px; margin-bottom:8px; border-radius:8px; background:rgba(224,178,92,.12); font-size:13px; line-height:1.6;"><div>${esc(item.markText || '')}</div><div class="settings-desc" style="margin-top:5px; display:flex; align-items:center; justify-content:space-between; gap:8px;"><span>${chapter ? `${esc(chapter)} · ` : ''}划线 · ${formatTimestamp(item.createTime)}</span><button type="button" class="settings-mini-btn" data-weread-discuss="${index}">讨论</button></div></div>`);
    });
    reviews.forEach(item => {
      const review = item.review || item;
      const content = review.content || review.abstract || '';
      if (!content) return;
      cards.push(`<div style="padding:10px; margin-bottom:8px; border-radius:8px; background:rgba(90,159,212,.10); font-size:13px; line-height:1.6;"><div>${esc(content)}</div><div class="settings-desc" style="margin-top:5px;">想法/点评</div></div>`);
    });
    target.innerHTML = cards.length ? `<h3 style="font-size:15px; margin:4px 0 8px;">笔记与划线</h3>${cards.join('')}` : '<div style="color:var(--text-secondary); font-size:13px;">这本书还没有笔记或划线。</div>';
    target.querySelectorAll('button[data-weread-discuss]').forEach(button => {
      button.addEventListener('click', () => {
        const highlight = highlights[Number(button.dataset.wereadDiscuss)];
        if (highlight) openRolePicker(highlight);
      });
    });
  }

  function getDiscussionRoles() {
    const chats = window.state?.chats || {};
    return Object.entries(chats)
      .filter(([, chat]) => chat && !chat.isGroup)
      .map(([chatId, chat]) => ({
        chatId,
        name: chat.name || chat.originalName || '角色',
        avatar: chat.settings?.avatar || chat.avatar || ''
      }));
  }

  function openRolePicker(highlight) {
    const list = document.getElementById('weread-role-list');
    if (!list) return;
    state.pendingHighlight = highlight;
    const roles = getDiscussionRoles();
    list.innerHTML = '';
    if (!roles.length) {
      list.innerHTML = '<div style="padding:20px; text-align:center; color:var(--text-secondary);">还没有可用的单聊角色。</div>';
    }
    roles.forEach(role => {
      const button = document.createElement('button');
      button.type = 'button';
      button.style.cssText = 'display:flex; align-items:center; gap:10px; width:100%; padding:10px; border:none; border-bottom:1px solid var(--border-color,#eee); background:transparent; color:inherit; text-align:left;';
      button.innerHTML = `${role.avatar ? `<img src="${esc(role.avatar)}" alt="" style="width:32px; height:32px; border-radius:50%; object-fit:cover;">` : ''}<span>${esc(role.name)}</span>`;
      button.addEventListener('click', () => openDiscussion(highlight, role.chatId));
      list.appendChild(button);
    });
    document.getElementById('weread-role-modal')?.classList.add('visible');
  }

  function getDiscussionBookmarkId(highlight) {
    return String(highlight?.bookmarkId || `${highlight?.chapterUid || ''}:${highlight?.range || ''}:${highlight?.markText || ''}`);
  }

  async function openDiscussion(highlight, chatId) {
    const chat = window.state?.chats?.[chatId];
    if (!chat) return;
    const bookmarkId = getDiscussionBookmarkId(highlight);
    const bookId = state.book?.bookId || '';
    state.discussion = { highlight, chatId, bookmarkId, bookId, recordId: null, messages: [], busy: false };
    const quote = document.getElementById('weread-discussion-quote');
    if (quote) {
      quote.innerHTML = `<div style="font-weight:600; margin-bottom:4px;">${esc(state.bookDetail?.title || state.book?.title || '')}</div><div class="settings-desc">${esc(state.notes?.chapterMap?.[highlight.chapterUid] || '')}</div><div style="margin-top:6px;">${esc(highlight.markText || '')}</div>`;
    }
    document.getElementById('weread-role-modal')?.classList.remove('visible');
    document.getElementById('weread-discussion-modal')?.classList.add('visible');
    const title = document.getElementById('weread-discussion-title');
    if (title) title.textContent = `${chat.name || chat.originalName || '角色'} · 划线讨论`;
    try {
      const rows = await db.wereadDiscussions.where('bookId').equals(bookId).toArray();
      const saved = rows.find(row => String(row.bookmarkId) === bookmarkId && String(row.chatId) === String(chatId));
      if (saved) {
        state.discussion.recordId = saved.id;
        state.discussion.messages = Array.isArray(saved.messages) ? saved.messages : [];
      }
    } catch (_) {}
    renderDiscussionMessages();
  }

  function renderDiscussionMessages() {
    const target = document.getElementById('weread-discussion-messages');
    if (!target) return;
    const messages = state.discussion?.messages || [];
    if (!messages.length) {
      target.innerHTML = '<div style="padding:20px 4px; color:var(--text-secondary); font-size:13px; line-height:1.7;">点“让 TA 说说”，或者直接问 TA 对这段划线的看法。</div>';
      return;
    }
    target.innerHTML = messages.map(message => {
      const isUser = message.role === 'user';
      return `<div style="display:flex; justify-content:${isUser ? 'flex-end' : 'flex-start'}; margin-bottom:8px;"><div style="max-width:88%; padding:8px 10px; border-radius:9px; background:${isUser ? 'rgba(90,159,212,.16)' : 'rgba(224,178,92,.14)'}; font-size:13px; line-height:1.6; white-space:pre-wrap;">${esc(message.content)}</div></div>`;
    }).join('');
    target.scrollTop = target.scrollHeight;
  }

  function getRecentChatContext(chat, count) {
    if (!count) return '（不提供最近聊天记录）';
    const history = Array.isArray(chat.history) ? chat.history.filter(message => message && (message.role === 'user' || message.role === 'assistant')) : [];
    const selected = history.slice(-count);
    return selected.map(message => {
      const text = typeof message.content === 'string'
        ? message.content
        : Array.isArray(message.content)
          ? message.content.map(part => part?.text || part?.content || '').join('')
          : '';
      return `${message.role === 'user' ? '我' : (chat.name || chat.originalName || '角色')}：${String(text).slice(0, 300)}`;
    }).join('\n') || '（无）';
  }

  function buildDiscussionPrompt(highlight, chat) {
    const config = getConfig();
    const chapterTitle = state.notes?.chapterMap?.[highlight.chapterUid] || '未知章节';
    const userName = chat.settings?.myNickname || window.state?.qzoneSettings?.nickname || '用户';
    const values = {
      user: userName,
      char: chat.name || chat.originalName || '角色',
      title: state.bookDetail?.title || state.book?.title || '未知书名',
      author: state.bookDetail?.author || state.book?.author || '未知作者',
      chapter: chapterTitle,
      quote: highlight.markText || '',
      note: highlight.note || '',
      recentChat: getRecentChatContext(chat, Number(config.historyCount) || 0)
    };
    const template = config.prompt || DEFAULT_DISCUSSION_PROMPT;
    return template.replace(/\{\{(\w+)\}\}/g, (_match, key) => values[key] ?? '');
  }

  async function saveDiscussion() {
    if (!state.discussion || !state.book?.bookId) return;
    try {
      const payload = {
        bookId: state.book.bookId,
        bookmarkId: state.discussion.bookmarkId,
        chatId: state.discussion.chatId,
        quote: state.discussion.highlight.markText || '',
        chapterTitle: state.notes?.chapterMap?.[state.discussion.highlight.chapterUid] || '',
        messages: state.discussion.messages.slice(-80),
        updatedAt: Date.now()
      };
      if (state.discussion.recordId) {
        await db.wereadDiscussions.update(state.discussion.recordId, payload);
      } else {
        state.discussion.recordId = await db.wereadDiscussions.add(payload);
      }
    } catch (_) {}
  }

  async function askDiscussion(question = '') {
    const discussion = state.discussion;
    if (!discussion || discussion.busy) return;
    const chat = window.state?.chats?.[discussion.chatId];
    if (!chat) return;
    const config = getConfig();
    const api = window.state?.apiConfig || {};
    const temperature = config.temperature !== '' && Number.isFinite(Number(config.temperature))
      ? Number(config.temperature)
      : Number(api.temperature) || 0.7;
    const maxTokens = config.maxTokens !== '' && Number.isFinite(Number(config.maxTokens))
      ? Math.max(50, Number(config.maxTokens))
      : Number(api.maxTokens) || 300;
    const userText = String(question || '').trim();
    const prior = discussion.messages.slice();
    if (userText) {
      discussion.messages.push({ role: 'user', content: userText, timestamp: Date.now() });
      renderDiscussionMessages();
    }
    discussion.busy = true;
    const target = document.getElementById('weread-discussion-messages');
    if (target) target.insertAdjacentHTML('beforeend', '<div id="weread-discussion-busy" style="color:var(--text-secondary); font-size:12px; padding:4px 0;">思考中…</div>');
    try {
      const prompt = buildDiscussionPrompt(discussion.highlight, chat);
      const persona = chat.settings?.aiPersona || '';
      const systemPrompt = `${persona ? `角色人设：\n${persona}\n\n` : ''}${prompt}`;
      const answer = await callDiscussionAi(
        systemPrompt,
        userText || '请说说你对这段划线的看法。',
        prior.map(message => ({ role: message.role, content: message.content })),
        temperature,
        maxTokens
      );
      discussion.messages.push({ role: 'assistant', content: answer || '……', timestamp: Date.now() });
      renderDiscussionMessages();
      await saveDiscussion();
    } catch (error) {
      discussion.messages.push({ role: 'assistant', content: `（讨论失败：${error.message || error}）`, timestamp: Date.now() });
      renderDiscussionMessages();
    } finally {
      discussion.busy = false;
      document.getElementById('weread-discussion-busy')?.remove();
    }
  }
  function openSettings() {
    const config = getConfig();
    const url = document.getElementById('weread-proxy-url');
    const token = document.getElementById('weread-app-token');
    const prompt = document.getElementById('weread-discussion-prompt');
    const history = document.getElementById('weread-history-count');
    const temperature = document.getElementById('weread-discussion-temperature');
    const maxTokens = document.getElementById('weread-discussion-max-tokens');
    if (url) url.value = config.proxyUrl;
    if (token) token.value = config.appToken;
    if (prompt) prompt.value = config.prompt;
    if (history) history.value = config.historyCount;
    if (temperature) temperature.value = config.temperature;
    if (maxTokens) maxTokens.value = config.maxTokens;
    document.getElementById('weread-settings-modal')?.classList.add('visible');
  }

  function closeSettings() {
    document.getElementById('weread-settings-modal')?.classList.remove('visible');
  }

  function saveSettings() {
    saveConfig({
      proxyUrl: document.getElementById('weread-proxy-url')?.value,
      appToken: document.getElementById('weread-app-token')?.value,
      prompt: document.getElementById('weread-discussion-prompt')?.value,
      historyCount: document.getElementById('weread-history-count')?.value,
      temperature: document.getElementById('weread-discussion-temperature')?.value,
      maxTokens: document.getElementById('weread-discussion-max-tokens')?.value
    });
    closeSettings();
    if (state.shelf) renderShelf();
    else loadShelf();
  }
  function openWereadApp() {
    if (typeof showScreen === 'function') showScreen('weread-screen');
    const config = getConfig();
    if (!config.proxyUrl) renderSetup();
    else loadShelf();
  }

  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('weread-settings-btn')?.addEventListener('click', openSettings);
    document.getElementById('close-weread-settings-btn')?.addEventListener('click', closeSettings);
    document.getElementById('cancel-weread-settings-btn')?.addEventListener('click', closeSettings);
    document.getElementById('save-weread-settings-btn')?.addEventListener('click', saveSettings);
    document.getElementById('reset-weread-discussion-prompt')?.addEventListener('click', () => {
      const prompt = document.getElementById('weread-discussion-prompt');
      if (prompt) prompt.value = DEFAULT_DISCUSSION_PROMPT;
    });
    document.getElementById('close-weread-role-btn')?.addEventListener('click', () => {
      document.getElementById('weread-role-modal')?.classList.remove('visible');
    });
    document.getElementById('close-weread-discussion-btn')?.addEventListener('click', () => {
      document.getElementById('weread-discussion-modal')?.classList.remove('visible');
    });
    document.getElementById('weread-discussion-say')?.addEventListener('click', () => askDiscussion(''));
    document.getElementById('weread-discussion-send')?.addEventListener('click', () => {
      const input = document.getElementById('weread-discussion-input');
      const value = String(input?.value || '').trim();
      if (!value) return;
      if (input) input.value = '';
      askDiscussion(value);
    });
  });

  window.openWereadApp = openWereadApp;
})();
