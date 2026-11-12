// 微信读书独立 App：书架、进度、目录、笔记/划线。
// API Key 只存在 Cloudflare Worker；前端只保存 Worker 地址和可选访问口令。
(function () {
  'use strict';

  const CONFIG_KEY = 'wereadSyncConfig';
  const SKILL_VERSION = '1.0.5';
  const SHELF_PAGE_SIZE = 50;
  const NOTES_PAGE_SIZE = 50;
  const DISCUSSION_AI_HISTORY_LIMIT = 20;
  const DEFAULT_DISCUSSION_PROMPT = `你是{{char}}，正在和{{user}}讨论《{{title}}》中的一段划线。

你只是读者，不是书中角色。不要续写书中剧情，不要扮演书中人物。请以你自己的性格、经历和价值观来讨论这段文字。

书名：{{title}}
作者：{{author}}
书籍简介：{{bookIntro}}
章节：{{chapter}}
划线：{{quote}}
我的批注：{{note}}

最近聊天记录：
{{recentChat}}

如果划线或想法不足以判断上下文，不要编造书中情节，可以先问用户这段出自哪个场景。

请针对这段划线，写 100–200 字左右的看法。不要写成分析报告。`;
  let state = { shelf: null, book: null, notes: null, loading: false, search: '', sort: 'recent', page: 1, notesType: 'all', notesStatus: 'all', notesSort: 'time-desc', notesSearch: '', notesPage: 1, notesRole: 'all' };

  const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));

  function getConfig() {
    try {
      const value = JSON.parse(localStorage.getItem(CONFIG_KEY) || '{}');
      return {
        proxyUrl: String(value.proxyUrl || '').trim(),
        appToken: String(value.appToken || ''),
        prompt: String(value.prompt || DEFAULT_DISCUSSION_PROMPT),
        historyCount: Math.max(0, Math.min(100, Number(value.historyCount ?? 30) || 0)),
        temperature: value.temperature === undefined || value.temperature === null || value.temperature === '' ? '' : String(value.temperature),
        maxTokens: value.maxTokens === undefined || value.maxTokens === null || value.maxTokens === '' ? '' : String(value.maxTokens)
      };
    } catch (_) {
      return { proxyUrl: '', appToken: '', prompt: DEFAULT_DISCUSSION_PROMPT, historyCount: 30, temperature: '', maxTokens: '' };
    }
  }

  function saveConfig(config) {
    localStorage.setItem(CONFIG_KEY, JSON.stringify({
      proxyUrl: String(config.proxyUrl || '').trim(),
      appToken: String(config.appToken || ''),
      prompt: String(config.prompt || DEFAULT_DISCUSSION_PROMPT),
      historyCount: Math.max(0, Math.min(100, Number(config.historyCount ?? 30) || 0)),
      temperature: config.temperature === '' || config.temperature === undefined || config.temperature === null ? '' : String(config.temperature),
      maxTokens: config.maxTokens === '' || config.maxTokens === undefined || config.maxTokens === null ? '' : String(config.maxTokens)
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

  async function fetchAllMyReviews(bookId) {
    const all = [];
    const seen = new Set();
    let synckey = 0;
    let hasMore = true;
    let page = 0;
    let lastData = {};
    while (hasMore && page < 50) {
      page += 1;
      const data = await gateway('/review/list/mine', {
        bookid: bookId,
        count: 100,
        ...(synckey ? { synckey } : {})
      });
      lastData = data;
      const pageReviews = Array.isArray(data?.reviews) ? data.reviews : [];
      pageReviews.forEach(item => {
        const review = item.review || item;
        const key = review.reviewId
          ? `id:${review.reviewId}`
          : `content:${review.content || ''}|${review.createTime || ''}`;
        if (seen.has(key)) return;
        seen.add(key);
        all.push(item);
      });
      hasMore = Number(data?.hasMore) === 1;
      const nextSynckey = Number(data?.synckey) || 0;
      if (!hasMore || !nextSynckey || nextSynckey === synckey || !pageReviews.length) break;
      synckey = nextSynckey;
    }
    return { ...lastData, reviews: all };
  }

  async function loadNotes(book) {
    const target = document.getElementById('weread-note-list');
    if (target) target.innerHTML = '<div style="padding:12px 0; color:var(--text-secondary);">正在读取笔记…</div>';
    try {
      const [highlights, reviews] = await Promise.all([
        gateway('/book/bookmarklist', { bookId: book.bookId }).catch(() => ({})),
        fetchAllMyReviews(book.bookId).catch(() => ({}))
      ]);
      const chapterMap = {};
      (Array.isArray(highlights?.chapters) ? highlights.chapters : []).forEach(chapter => {
        if (chapter?.chapterUid) chapterMap[chapter.chapterUid] = chapter.title || '';
      });
      let discussionRows = [];
      try {
        discussionRows = await db.wereadDiscussions.where('bookId').equals(book.bookId).toArray();
      } catch (_) {}
      state.notes = { highlights, reviews, chapterMap, discussionRows };
      renderNotes(highlights, reviews, chapterMap);
    } catch (error) {
      if (target) target.innerHTML = `<div style="color:#c0392b; font-size:13px;">${esc(error.message || String(error))}</div>`;
    }
  }

  function getReviewQuote(review) {
    const abstract = String(review?.abstract || review?.abstractText || review?.quote || review?.markText || review?.sourceText || '').trim();
    if (abstract) return abstract;
    const range = String(review?.range || '');
    if (!range) return '';
    const highlights = Array.isArray(state.notes?.highlights?.updated) ? state.notes.highlights.updated : [];
    const matched = highlights.find(item => String(item.range || '') === range && String(item.chapterUid || '') === String(review.chapterUid || ''));
    return matched?.markText || '';
  }

  function getReviewChapterTitle(review) {
    return review?.chapterName ||
      state.notes?.chapterMap?.[review?.chapterUid] ||
      (state.bookChapters || []).find(chapter => String(chapter.chapterIdx) === String(review?.chapterIdx))?.title ||
      '';
  }
  function getNoteDiscussionCount(key) {
    const rows = Array.isArray(state.notes?.discussionRows) ? state.notes.discussionRows : [];
    return rows
      .filter(row => String(row.bookmarkId) === String(key))
      .reduce((total, row) => total + (Array.isArray(row.messages) ? row.messages.length : 0), 0);
  }

  function buildNoteRecords() {
    const highlights = Array.isArray(state.notes?.highlights?.updated) ? state.notes.highlights.updated : [];
    const reviews = Array.isArray(state.notes?.reviews?.reviews) ? state.notes.reviews.reviews : [];
    const records = [];
    highlights.forEach(item => {
      const key = getDiscussionBookmarkId(item);
      records.push({
        type: 'highlight',
        key,
        quote: String(item.markText || ''),
        content: '',
        note: String(item.note || ''),
        chapterUid: item.chapterUid || null,
        chapterIdx: item.chapterIdx || null,
        chapterTitle: state.notes?.chapterMap?.[item.chapterUid] || '',
        createdAt: Number(item.createTime) || 0,
        discussionCount: getNoteDiscussionCount(key),
        source: item
      });
    });
    reviews.forEach(item => {
      const source = reviewToDiscussionSource(item);
      const review = item.review || item;
      records.push({
        type: 'review',
        key: source.bookmarkId,
        quote: String(source.markText || ''),
        content: String(review.content || '').trim(),
        note: String(source.note || ''),
        chapterUid: review.chapterUid || null,
        chapterIdx: review.chapterIdx || null,
        chapterTitle: source.chapterName || '',
        createdAt: Number(review.createTime) || 0,
        discussionCount: getNoteDiscussionCount(source.bookmarkId),
        source
      });
    });
    return records;
  }

  function getVisibleNoteRecords(records) {
    const query = String(state.notesSearch || '').trim().toLowerCase();
    let visible = records.filter(record => {
      if (state.notesType !== 'all' && record.type !== state.notesType) return false;
      if (state.notesRole !== 'all' && getDiscussionRoleCount(record.key, state.notesRole) <= 0) return false;
      if (state.notesStatus === 'discussed' && record.discussionCount <= 0) return false;
      if (state.notesStatus === 'undiscussed' && record.discussionCount > 0) return false;
      if (!query) return true;
      return [record.quote, record.content, record.note, record.chapterTitle]
        .some(value => String(value || '').toLowerCase().includes(query));
    });
    visible = visible.slice();
    visible.sort((a, b) => {
      if (state.notesSort === 'chapter') {
        const chapterA = Number(a.chapterIdx) || 999999;
        const chapterB = Number(b.chapterIdx) || 999999;
        return chapterA - chapterB || a.createdAt - b.createdAt;
      }
      if (state.notesSort === 'time-asc') return a.createdAt - b.createdAt;
      return b.createdAt - a.createdAt;
    });
    return visible;
  }

  function populateNoteRoleOptions() {
    const select = document.getElementById('weread-note-role');
    if (!select) return;
    const rows = Array.isArray(state.notes?.discussionRows) ? state.notes.discussionRows : [];
    const roleIds = [...new Set(rows
      .filter(row => Array.isArray(row.messages) && row.messages.length)
      .map(row => String(row.chatId || ''))
      .filter(Boolean))];
    const current = roleIds.includes(String(state.notesRole)) ? String(state.notesRole) : 'all';
    state.notesRole = current;
    select.innerHTML = '<option value="all">全部角色</option>' + roleIds.map(chatId => {
      const chat = window.state?.chats?.[chatId];
      const name = chat?.name || chat?.originalName || '角色';
      return `<option value="${esc(chatId)}">${esc(name)}</option>`;
    }).join('');
    select.value = state.notesRole;
  }

  function updateNoteFilterControls(records) {
    const countAll = records.length;
    const countHighlights = records.filter(record => record.type === 'highlight').length;
    const countReviews = records.filter(record => record.type === 'review').length;
    document.querySelectorAll('#weread-note-list [data-note-type]').forEach(button => {
      const type = button.dataset.noteType;
      const count = type === 'all' ? countAll : type === 'highlight' ? countHighlights : countReviews;
      const label = type === 'all' ? '全部' : type === 'highlight' ? '划线' : '想法/点评';
      button.textContent = `${label} ${count}`;
      button.classList.toggle('is-active', state.notesType === type);
    });
    const status = document.getElementById('weread-note-status');
    if (status) status.value = state.notesStatus;
    const sort = document.getElementById('weread-note-sort');
    if (sort) sort.value = state.notesSort;
    const search = document.getElementById('weread-note-search');
    if (search && search.value !== state.notesSearch) search.value = state.notesSearch;
  }

  function renderNoteCards(records) {
    const visible = getVisibleNoteRecords(records);
    const totalPages = Math.max(1, Math.ceil(visible.length / NOTES_PAGE_SIZE));
    state.notesPage = Math.max(1, Math.min(totalPages, Number(state.notesPage) || 1));
    const start = (state.notesPage - 1) * NOTES_PAGE_SIZE;
    const pageRecords = visible.slice(start, start + NOTES_PAGE_SIZE);
    state.notes.visibleRecords = pageRecords;
    const summary = document.getElementById('weread-note-summary');
    if (summary) summary.textContent = visible.length ? `${start + 1}–${Math.min(visible.length, start + NOTES_PAGE_SIZE)} / ${visible.length} 条` : '0 条';
    const list = document.getElementById('weread-note-cards');
    if (!list) return;
    list.innerHTML = '';
    if (!visible.length) {
      list.innerHTML = '<div style="padding:24px 4px; text-align:center; color:var(--text-secondary); font-size:13px;">没有符合条件的笔记。</div>';
    } else {
      pageRecords.forEach((record, index) => {
        const isReview = record.type === 'review';
        const statusText = record.discussionCount > 0 ? `在聊${record.discussionCount > 1 ? ` ${record.discussionCount}` : ''}` : '未聊';
        const meta = [record.chapterTitle, isReview ? '想法/点评' : '划线', formatTimestamp(record.createdAt)].filter(Boolean).join(' · ');
        const card = document.createElement('div');
        card.style.cssText = `padding:10px; margin-bottom:8px; border-radius:8px; background:${isReview ? 'rgba(90,159,212,.10)' : 'rgba(224,178,92,.12)'}; font-size:13px; line-height:1.6;`;
        card.innerHTML = `
          ${isReview && record.quote ? `<div style="border-left:3px solid #9bb7d4; padding-left:8px; margin-bottom:7px; color:var(--text-secondary);">${esc(record.quote)}</div>` : ''}
          ${isReview ? (record.content ? `<div>${esc(record.content)}</div>` : '') : `<div>${esc(record.quote)}</div>`}
          <div class="settings-desc" style="margin-top:5px; display:flex; align-items:center; justify-content:space-between; gap:8px;">
            <span>${[meta, statusText].filter(Boolean).join(' · ')}</span>
            <button type="button" class="settings-mini-btn" data-note-discuss="${index}">${record.discussionCount > 0 ? '继续讨论' : '讨论'}</button>
          </div>`;
        card.querySelector('[data-note-discuss]')?.addEventListener('click', () => openRolePicker(record.source));
        list.appendChild(card);
      });
    }
    const pagination = document.getElementById('weread-note-pagination');
    if (pagination) {
      pagination.innerHTML = totalPages > 1
        ? `<button type="button" class="settings-mini-btn" id="weread-note-prev" ${state.notesPage <= 1 ? 'disabled' : ''}>上一页</button><span style="font-size:12px; color:var(--text-secondary);">第 ${state.notesPage} / ${totalPages} 页</span><button type="button" class="settings-mini-btn" id="weread-note-next" ${state.notesPage >= totalPages ? 'disabled' : ''}>下一页</button>`
        : '';
      document.getElementById('weread-note-prev')?.addEventListener('click', () => {
        state.notesPage = Math.max(1, state.notesPage - 1);
        renderNoteCards(records);
      });
      document.getElementById('weread-note-next')?.addEventListener('click', () => {
        state.notesPage = Math.min(totalPages, state.notesPage + 1);
        renderNoteCards(records);
      });
    }
  }
  function renderNotes(highlightsData, reviewsData, chapterMap = {}) {
    const target = document.getElementById('weread-note-list');
    if (!target) return;
    target.innerHTML = `
      <div style="display:flex; align-items:center; justify-content:space-between; margin:4px 0 8px;">
        <h3 style="font-size:15px; margin:0;">笔记与划线</h3>
        <span class="settings-desc" id="weread-note-summary"></span>
      </div>
      <div style="display:flex; gap:6px; flex-wrap:wrap; margin-bottom:8px;">
        <button type="button" class="settings-mini-btn" data-note-type="all">全部</button>
        <button type="button" class="settings-mini-btn" data-note-type="highlight">划线</button>
        <button type="button" class="settings-mini-btn" data-note-type="review">想法/点评</button>
      </div>
      <div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:8px;">
        <select id="weread-note-status" style="padding:7px; border:1px solid var(--border-color); border-radius:7px; background:var(--secondary-bg); color:var(--text-primary);">
          <option value="all">全部讨论状态</option>
          <option value="undiscussed">未聊</option>
          <option value="discussed">在聊</option>
        </select>
        <select id="weread-note-sort" style="padding:7px; border:1px solid var(--border-color); border-radius:7px; background:var(--secondary-bg); color:var(--text-primary);">
          <option value="time-desc">时间倒序</option>
          <option value="time-asc">时间正序</option>
          <option value="chapter">章节顺序</option>
        </select>
        <select id="weread-note-role" style="padding:7px; border:1px solid var(--border-color); border-radius:7px; background:var(--secondary-bg); color:var(--text-primary);">
          <option value="all">全部角色</option>
        </select>
      </div>
      <input type="search" id="weread-note-search" placeholder="搜索原文、想法或章节…" value="${esc(state.notesSearch)}" style="width:100%; box-sizing:border-box; padding:7px 9px; margin-bottom:10px; border:1px solid var(--border-color); border-radius:7px; background:var(--secondary-bg); color:var(--text-primary);">
      <div id="weread-note-cards"></div>
      <div id="weread-note-pagination" style="display:flex; align-items:center; justify-content:center; gap:10px; padding:14px 0;"></div>`;
    const records = buildNoteRecords();
    state.notes.records = records;
    updateNoteFilterControls(records);
    populateNoteRoleOptions();
    document.querySelectorAll('#weread-note-list [data-note-type]').forEach(button => {
      button.addEventListener('click', () => {
        state.notesType = button.dataset.noteType || 'all';
        state.notesPage = 1;
        updateNoteFilterControls(records);
        renderNoteCards(records);
      });
    });
    document.getElementById('weread-note-status')?.addEventListener('change', event => {
      state.notesStatus = event.target.value;
      state.notesPage = 1;
      renderNoteCards(records);
    });
    document.getElementById('weread-note-sort')?.addEventListener('change', event => {
      state.notesSort = event.target.value;
      state.notesPage = 1;
      renderNoteCards(records);
    });
    document.getElementById('weread-note-role')?.addEventListener('change', event => {
      state.notesRole = event.target.value;
      state.notesPage = 1;
      renderNoteCards(records);
    });
    document.getElementById('weread-note-search')?.addEventListener('input', event => {
      state.notesSearch = event.target.value;
      state.notesPage = 1;
      renderNoteCards(records);
    });
    renderNoteCards(records);
  }
  function reviewToDiscussionSource(item) {
    const review = item.review || item;
    const abstract = getReviewQuote(review);
    const content = String(review.content || '').trim();
    return {
      markText: abstract || content,
      note: abstract ? content : '',
      chapterUid: review.chapterUid || null,
      chapterName: getReviewChapterTitle(review),
      range: review.range || '',
      bookmarkId: review.reviewId ? `review:${review.reviewId}` : `review:${content.slice(0, 40)}`,
      isReview: true
    };
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

  function getDiscussionRoleCount(key, chatId) {
    const rows = Array.isArray(state.notes?.discussionRows) ? state.notes.discussionRows : [];
    return rows
      .filter(row => String(row.bookmarkId) === String(key) && String(row.chatId) === String(chatId))
      .reduce((total, row) => total + (Array.isArray(row.messages) ? row.messages.length : 0), 0);
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
      const existingCount = getDiscussionRoleCount(highlight.bookmarkId, role.chatId);
      button.innerHTML = `${role.avatar ? `<img src="${esc(role.avatar)}" alt="" style="width:32px; height:32px; border-radius:50%; object-fit:cover;">` : ''}<span>${esc(role.name)}${existingCount ? ' · 在聊' : ''}</span>`;
      button.addEventListener('click', () => openDiscussion(highlight, role.chatId));
      list.appendChild(button);
    });
    document.getElementById('weread-role-modal')?.classList.add('visible');
  }

  function getDiscussionBookmarkId(highlight) {
    return String(highlight?.bookmarkId || `${highlight?.chapterUid || ''}:${highlight?.range || ''}:${highlight?.markText || ''}`);
  }

  function getDiscussionChapterTitle(highlight) {
    return highlight?.chapterName || state.notes?.chapterMap?.[highlight?.chapterUid] || '';
  }

  async function openDiscussion(highlight, chatId) {
    const chat = window.state?.chats?.[chatId];
    if (!chat) return;
    const bookmarkId = getDiscussionBookmarkId(highlight);
    const bookId = state.book?.bookId || '';
    state.discussion = { highlight, chatId, bookmarkId, bookId, recordId: null, messages: [], busy: false };
    const quote = document.getElementById('weread-discussion-quote');
    if (quote) {
      quote.innerHTML = `<div style="font-weight:600; margin-bottom:4px;">${esc(state.bookDetail?.title || state.book?.title || '')}</div><div class="settings-desc">${esc(getDiscussionChapterTitle(highlight))}</div><div style="margin-top:6px;">${esc(highlight.markText || '')}</div>`;
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
    const chapterTitle = getDiscussionChapterTitle(highlight) || '未知章节';
    const userName = chat.settings?.myNickname || window.state?.qzoneSettings?.nickname || '用户';
    const rawIntro = String(state.bookDetail?.intro || '').replace(/\s+/g, ' ').trim();
    const bookIntro = rawIntro ? `${rawIntro.slice(0, 500)}${rawIntro.length > 500 ? '…' : ''}` : '';
    const values = {
      user: userName,
      char: chat.name || chat.originalName || '角色',
      title: state.bookDetail?.title || state.book?.title || '未知书名',
      author: state.bookDetail?.author || state.book?.author || '未知作者',
      bookIntro: bookIntro || '（暂无简介）',
      chapter: chapterTitle,
      quote: highlight.markText || '',
      note: highlight.note || '',
      recentChat: getRecentChatContext(chat, Number(config.historyCount) || 0)
    };
    const template = config.prompt || DEFAULT_DISCUSSION_PROMPT;
    let rendered = template.replace(/\{\{(\w+)\}\}/g, (_match, key) => values[key] ?? '');
    if (!template.includes('{{bookIntro}}') && bookIntro) {
      rendered += `\n\n书籍简介：\n${bookIntro}`;
    }
    if (!rendered.includes('不要编造')) {
      rendered += '\n\n如果上下文不足，不要编造书中情节，可以先询问用户这段出自哪里。';
    }
    return rendered;
  }

  async function saveDiscussion() {
    if (!state.discussion || !state.book?.bookId) return;
    try {
      const payload = {
        bookId: state.book.bookId,
        bookmarkId: state.discussion.bookmarkId,
        chatId: state.discussion.chatId,
        quote: state.discussion.highlight.markText || '',
        chapterTitle: getDiscussionChapterTitle(state.discussion.highlight),
        messages: state.discussion.messages.slice(-80),
        updatedAt: Date.now()
      };
      if (state.discussion.recordId) {
        await db.wereadDiscussions.update(state.discussion.recordId, payload);
      } else {
        state.discussion.recordId = await db.wereadDiscussions.add(payload);
      }
      if (state.notes) {
        if (!Array.isArray(state.notes.discussionRows)) state.notes.discussionRows = [];
        const row = { ...payload, id: state.discussion.recordId };
        const rowIndex = state.notes.discussionRows.findIndex(item => item.id === row.id);
        if (rowIndex >= 0) state.notes.discussionRows[rowIndex] = row;
        else state.notes.discussionRows.push(row);
      }
    } catch (_) {}
  }

  function refreshNotesAfterDiscussion() {
    if (!state.notes?.highlights) return;
    renderNotes(state.notes.highlights, state.notes.reviews, state.notes.chapterMap || {});
  }

  async function clearCurrentDiscussion() {
    const discussion = state.discussion;
    if (!discussion) return;
    const message = '清空后这条划线/想法与当前角色的讨论记录会被删除，无法恢复。';
    const confirmed = typeof window.showCustomConfirm === 'function'
      ? await window.showCustomConfirm('清空当前讨论', message)
      : window.confirm(message);
    if (!confirmed) return;
    try {
      if (discussion.recordId) await db.wereadDiscussions.delete(discussion.recordId);
      if (state.notes?.discussionRows) {
        state.notes.discussionRows = state.notes.discussionRows.filter(row => row.id !== discussion.recordId);
      }
    } catch (_) {}
    discussion.recordId = null;
    discussion.messages = [];
    renderDiscussionMessages();
    window.showToast?.('当前讨论已清空');
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
        prior.slice(-DISCUSSION_AI_HISTORY_LIMIT).map(message => ({ role: message.role, content: message.content })),
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
      refreshNotesAfterDiscussion();
    });
    document.getElementById('weread-discussion-clear')?.addEventListener('click', clearCurrentDiscussion);
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
