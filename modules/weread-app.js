// 微信读书独立 App：书架、进度、目录、笔记/划线。
// API Key 只存在 Cloudflare Worker；前端只保存 Worker 地址和可选访问口令。
(function () {
  'use strict';

  const CONFIG_KEY = 'wereadSyncConfig';
  const SKILL_VERSION = '1.0.5';
  const SHELF_PAGE_SIZE = 50;
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
      return { proxyUrl: '', appToken: '' };
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
      state.notes = { highlights, reviews };
      renderNotes(highlights, reviews);
    } catch (error) {
      if (target) target.innerHTML = `<div style="color:#c0392b; font-size:13px;">${esc(error.message || String(error))}</div>`;
    }
  }

  function renderNotes(highlightsData, reviewsData) {
    const target = document.getElementById('weread-note-list');
    if (!target) return;
    const highlights = Array.isArray(highlightsData?.updated) ? highlightsData.updated : [];
    const reviews = Array.isArray(reviewsData?.reviews) ? reviewsData.reviews : [];
    const cards = [];
    highlights.forEach(item => {
      cards.push(`<div style="padding:10px; margin-bottom:8px; border-radius:8px; background:rgba(224,178,92,.12); font-size:13px; line-height:1.6;"><div>${esc(item.markText || '')}</div><div class="settings-desc" style="margin-top:5px;">划线 · ${formatTimestamp(item.createTime)}</div></div>`);
    });
    reviews.forEach(item => {
      const review = item.review || item;
      const content = review.content || review.abstract || '';
      if (!content) return;
      cards.push(`<div style="padding:10px; margin-bottom:8px; border-radius:8px; background:rgba(90,159,212,.10); font-size:13px; line-height:1.6;"><div>${esc(content)}</div><div class="settings-desc" style="margin-top:5px;">想法/点评</div></div>`);
    });
    target.innerHTML = cards.length ? `<h3 style="font-size:15px; margin:4px 0 8px;">笔记与划线</h3>${cards.join('')}` : '<div style="color:var(--text-secondary); font-size:13px;">这本书还没有笔记或划线。</div>';
  }

  function openSettings() {
    const config = getConfig();
    const url = document.getElementById('weread-proxy-url');
    const token = document.getElementById('weread-app-token');
    if (url) url.value = config.proxyUrl;
    if (token) token.value = config.appToken;
    document.getElementById('weread-settings-modal')?.classList.add('visible');
  }

  function closeSettings() {
    document.getElementById('weread-settings-modal')?.classList.remove('visible');
  }

  function saveSettings() {
    saveConfig({
      proxyUrl: document.getElementById('weread-proxy-url')?.value,
      appToken: document.getElementById('weread-app-token')?.value
    });
    closeSettings();
    loadShelf();
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
  });

  window.openWereadApp = openWereadApp;
})();
