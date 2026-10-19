// ========================================
// 绿江 (Green River) 同人创作模块
// 来源: script.js 第 62277 ~ 64166 行
// 包含: grState, DEFAULT_AUTHORS, initGreenRiverData, openGreenRiverScreen,
//       renderBookList, openAuthorManager, openAuthorEditor, saveAuthor,
//       deleteAuthor, addAuthor, createNewStory, openStorySettings,
//       loadStorySettingsUI, saveStorySettings, openReader, handleGenerateStoryContent,
//       openChapterList, closeChapterList, renderChapterList, deleteSelectedChapters,
//       calculateNextUpdateTime, checkAutoUpdate, autoGenerateChapter,
//       checkAllStoriesForAutoUpdate, startAutoUpdateTimer, stopAutoUpdateTimer
// ========================================

  // ==========================================
  // ▼▼▼ 绿江 (Green River) 同人创作模块 ▼▼▼
  // ==========================================

  let grState = {
    activeStoryId: null,
    isGenerating: false,
    currentReaderChapter: null,
    readingOnly: false
  };

  // 默认作者预设
  const DEFAULT_AUTHORS = [
    { name: "细腻情感", style: "侧重心理描写，文笔细腻，擅长捕捉人物间微妙的情感流动，氛围感强。", maxOutput: 600 },
    { name: "正剧剧情", style: "注重剧情逻辑，节奏紧凑，对白干练，擅长推动故事情节发展。", maxOutput: 800 },
    { name: "轻松日常", style: "幽默风趣，轻松愉快，多用生动的对话和有趣的细节描写，治愈系。", maxOutput: 500 },
    { name: "意识流", style: "大量使用隐喻和象征，句式优美复杂，着重于意象和哲学思考，弱化具体情节。", maxOutput: 400 },

    // 著名作家文风
    { name: "鲁迅", style: "犀利深刻，善用讽刺和批判，文笔简练有力，揭露社会黑暗面，语言辛辣而富有战斗性。多用短句，节奏明快，常有深刻的社会洞察。", maxOutput: 600 },
    { name: "张爱玲", style: "细腻敏感，擅长描写都市男女的情感纠葛，文字华丽而苍凉，善用比喻和意象，笔触冷静克制，充满人生况味。关注细节，氛围感极强。", maxOutput: 700 },
    { name: "老舍", style: "京味十足，语言生动幽默，善于刻画小人物的悲欢离合，文字朴实而富有生活气息，对话生动传神，充满市井烟火味。", maxOutput: 650 },
    { name: "沈从文", style: "抒情诗意，文字清新隽永，善于描绘湘西风情和人性美好，笔触细腻温婉，充满诗意和画面感，语言优美流畅。", maxOutput: 600 },
    { name: "钱钟书", style: "博学机智，语言幽默讽刺，善用典故和比喻，文字雅致而犀利，充满知识分子的睿智和调侃，叙述风格独特。", maxOutput: 700 },
    { name: "巴金", style: "激情澎湃，文字真挚热烈，关注社会现实和人性挣扎，笔触饱含感情，语言流畅自然，充满理想主义色彩。", maxOutput: 650 },
    { name: "林语堂", style: "幽默雅致，中西合璧，文字闲适自在，善于议论和抒情，语言轻松诙谐，充满生活哲理和人生智慧。", maxOutput: 600 },
    { name: "冰心", style: "清新纯净，文字温婉柔美，善于抒发母爱、童真和自然之美，笔触细腻真挚，语言优美如诗，充满温情。", maxOutput: 500 },
    { name: "余华", style: "冷峻克制，善于描写命运的荒诞和人性的坚韧，文字简洁有力，叙事冷静客观，却能直击人心，充满悲悯情怀。", maxOutput: 650 },
    { name: "莫言", style: "魔幻现实，想象力丰富，文字恣肆汪洋，善于用民间传说和乡土元素，语言浓烈奔放，充满生命力和张力。", maxOutput: 800 }
  ];

  // 1. 初始化数据 (在 openGreenRiverScreen 时调用)
  async function initGreenRiverData() {
    const count = await db.grAuthors.count();
    if (count === 0) {
      await db.grAuthors.bulkAdd(DEFAULT_AUTHORS);
    }
  }

  // 2. 打开主界面
  async function openGreenRiverScreen() {
    await initGreenRiverData();
    showScreen('green-river-screen');
    const search = document.getElementById('gr-library-search');
    if (search) {
      search.value = '';
      search.oninput = () => renderBookList(search.value);
    }
    renderBookList();
  }

  // 3. 渲染书架
  // 找到 renderBookList 函数，替换整个函数
  async function renderBookList(searchTerm = '') {
    const escapeHtml = window.GreenRiverStoryEngine?.escapeHtml || (value => String(value));
    const listEl = document.getElementById('gr-book-list');
    listEl.innerHTML = '';

    const allStories = await db.grStories.toArray();
    const stories = allStories.filter(story => {
      const bible = Object.assign({}, window.GreenRiverStoryEngine?.DEFAULT_STORY_BIBLE || {}, story.storyBible || {});
      const haystack = [story.title, bible.genre, ...(bible.tags || [])].join(' ').toLowerCase();
      return !searchTerm || haystack.includes(String(searchTerm).trim().toLowerCase());
    }).sort((a, b) => {
      const aTime = a.lastUpdated || 0;
      const bTime = b.lastUpdated || 0;
      return bTime - aTime;
    });
    const authors = await db.grAuthors.toArray();
    const authorMap = new Map(authors.map(a => [a.id, a.name]));

    // 获取已关联的书籍ID集合
    const existingBooks = await db.readingLibrary.toArray();
    const linkedIds = new Set(existingBooks.map(b => b.linkedStoryId).filter(id => id));

    if (stories.length === 0) {
      listEl.innerHTML = `<p style="grid-column:1/-1; text-align:center; color:var(--gr-text-sub); margin-top:50px;">${searchTerm ? '没有找到匹配的作品。' : '书架是空的，点击右上角新建一部作品吧。'}</p>`;
      return;
    }

    stories.forEach(story => {
      const authorName = authorMap.get(story.authorId) || '未知作者';
      const div = document.createElement('div');
      div.className = 'gr-book-card';

      const wordCount = story.chapters.reduce((acc, ch) => acc + (ch.content || '').length, 0);
      const bible = Object.assign({}, window.GreenRiverStoryEngine?.DEFAULT_STORY_BIBLE || {}, story.storyBible || {});
      const tags = (bible.tags || []).slice(0, 3);

      // 【核心逻辑修改】
      const isAdded = linkedIds.has(story.id);
      // 如果已加入，显示"已在书架"，点击触发移除；否则显示"加入"，点击触发加入
      const btnText = isAdded ? '已在书架' : '加入共读';
      const btnClass = isAdded ? 'gr-add-shelf-btn added' : 'gr-add-shelf-btn';
      const actionFn = isAdded ? 'removeGreenRiverFromShelf' : 'addGreenRiverToShelf';

      div.innerHTML = `
            <div>
                <div class="gr-book-title">${escapeHtml(story.title)}</div>
                ${bible.synopsis ? `<div class="gr-book-synopsis">${escapeHtml(bible.synopsis)}</div>` : ''}
                <div class="gr-book-meta">
                    <svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>
                    ${escapeHtml(authorName)}
                    <span class="gr-book-status">${escapeHtml(bible.status || '连载中')}</span>
                </div>
                ${tags.length ? `<div class="gr-book-tags">${tags.map(tag => `<span>${escapeHtml(tag)}</span>`).join('')}</div>` : ''}
            </div>
            <div class="gr-book-meta" style="justify-content: space-between; margin-top:15px; align-items: flex-end;">
                <div style="display:flex; flex-direction:column; gap:2px;">
                    <span>${story.chapters.length} 章</span>
                    <span>${(wordCount / 1000).toFixed(1)}k 字</span>
                </div>
                <button class="${btnClass}" onclick="event.stopPropagation(); ${actionFn}(${story.id}, this);">
                    ${isAdded ? '✓ ' : '+ '}${btnText}
                </button>
            </div>
        `;

      div.onclick = (e) => {
        if (e.target.tagName !== 'BUTTON') openReader(story.id);
      };

      addLongPressListener(div, async () => {
        if (confirm(`确定要删除作品《${story.title}》吗？`)) {
          await db.grStories.delete(story.id);
          renderBookList();
        }
      });

      listEl.appendChild(div);
    });
  }

  // 4. 作者管理
  // --- 绿江作者管理重构 (修复布局和编辑功能) ---

  let editingAuthorId = null; // 用于记录当前正在编辑的作者ID

  // 1. 打开作者管理列表 (渲染界面)
  async function openAuthorManager() {
    const escapeHtml = window.GreenRiverStoryEngine?.escapeHtml || (value => String(value));
    showScreen('gr-author-screen');
    const listEl = document.getElementById('gr-author-list');
    listEl.innerHTML = '';

    const authors = await db.grAuthors.toArray();

    if (authors.length === 0) {
      listEl.innerHTML = '<p style="text-align:center; color:#999; margin-top:50px;">还没有设定作者，点击右上角"+"添加。</p>';
      return;
    }

    authors.forEach(author => {
      const div = document.createElement('div');
      div.className = 'gr-author-item';
      div.innerHTML = `
            <div class="gr-author-info" style="flex-grow: 1; padding-right: 10px; min-width: 0;">
                <h3 style="margin: 0 0 5px 0; font-size: 16px; font-weight: 600; color: #1C1C1E;">${escapeHtml(author.name)}</h3>
                <p style="margin: 0; font-size: 13px; color: #8E8E93; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; line-height: 1.5;">${escapeHtml(author.style)}</p>
            </div>
            <div class="gr-author-actions">
                <button class="gr-icon-btn" onclick="openAuthorEditor(${author.id})" title="编辑">
                   <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
                </button>
                <button class="gr-icon-btn" style="color:#ff3b30;" onclick="deleteAuthor(${author.id})" title="删除">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                </button>
            </div>
        `;
      listEl.appendChild(div);
    });
  }

  // 2. 打开编辑/添加弹窗
  // 如果传入 id，则是编辑模式；否则是添加模式
  async function openAuthorEditor(id = null) {
    editingAuthorId = id;
    const modal = document.getElementById('gr-author-editor-modal');
    const titleEl = document.getElementById('gr-author-editor-title');
    const nameInput = document.getElementById('gr-author-name-input');
    const styleInput = document.getElementById('gr-author-style-input');

    if (id) {
      // 编辑模式：回显数据
      const author = await db.grAuthors.get(id);
      if (author) {
        titleEl.textContent = "编辑作者";
        nameInput.value = author.name;
        styleInput.value = author.style;
      }
    } else {
      // 添加模式：清空数据
      titleEl.textContent = "添加作者";
      nameInput.value = "";
      styleInput.value = "";
    }

    modal.classList.add('visible');
  }

  // 3. 保存作者 (由弹窗内的保存按钮调用)
  async function saveAuthor() {
    const name = document.getElementById('gr-author-name-input').value.trim();
    const style = document.getElementById('gr-author-style-input').value.trim();

    if (!name || !style) {
      alert("名称和风格描述都不能为空！");
      return;
    }

    if (editingAuthorId) {
      // 更新
      await db.grAuthors.update(editingAuthorId, { name, style });
    } else {
      // 新增
      await db.grAuthors.add({ name, style, maxOutput: 600 });
    }

    // 关闭弹窗并刷新列表
    document.getElementById('gr-author-editor-modal').classList.remove('visible');
    openAuthorManager();
  }

  // 4. 删除作者
  async function deleteAuthor(id) {
    const confirmed = await showCustomConfirm("确认删除", "确定删除这位作者设定吗？\n(这不会影响已生成的章节内容)", { confirmButtonClass: 'btn-danger' });
    if (confirmed) {
      await db.grAuthors.delete(id);
      openAuthorManager();
    }
  }

  // 5. 绑定头部"+"按钮到新的编辑器逻辑
  // (这个函数名与HTML中的onclick="addAuthor()"对应，我们将其重定向到openAuthorEditor)
  function addAuthor() {
    openAuthorEditor(null);
  }

  // 6. 绑定保存按钮事件 (在初始化时执行一次即可，防止重复绑定)
  const saveBtn = document.getElementById('gr-save-author-btn');
  if (saveBtn) {
    // 使用 cloneNode 移除旧的监听器 (如果有的话)
    const newBtn = saveBtn.cloneNode(true);
    saveBtn.parentNode.replaceChild(newBtn, saveBtn);
    newBtn.onclick = saveAuthor;
  }

  // 暴露给全局
  window.openAuthorManager = openAuthorManager;
  window.openAuthorEditor = openAuthorEditor;
  window.addAuthor = addAuthor;
  window.deleteAuthor = deleteAuthor;

  // 5. 新建作品 (设置页)
