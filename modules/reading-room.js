// ============================================================
// reading-room.js
// 来源：script.js 第 52560~53310 行（DOMContentLoaded 内部）
// 功能：阅读室 —— openReadingRoom、initReadingSession、closeReadingRoom、
//       renderReadingRoom、showNextPage、showPrevPage、importBook、
//       decodeTextFile、handleBookFileUpload、handlePageJump、
//       saveReadingProgress、openBookLibrary、renderBookLibrary、
//       loadBookFromLibrary、addGreenRiverToShelf、removeGreenRiverFromShelf、
//       deleteBookFromLibrary、processImportedText、makeDraggable、
//       minimizeReadingRoom、restoreReadingRoom、debounce、
//       formatReadingStateForAI、updateReadingContextOnScroll
// ============================================================

(function () {
  // state 和 db 通过全局作用域访问（window.state/window.db，由 init-and-state.js 初始化）

  // ========== 闭包变量 ==========

  let readingState = {};
  let readingSelection = null;
  let readingAnnotationsCache = [];
  let editingReadingAnnotation = null;
  let readingTocTab = 'chapters';

  // ========== 来源：script.js 第 52560~53310 行 ==========

  function openReadingRoom() {
    bindReadingAnnotationUi();
    if (!state.activeChatId) return;
    const chatId = state.activeChatId;
    const overlay = document.getElementById('reading-overlay');
    const windowEl = document.getElementById('reading-window');
    const restoreBtn = document.getElementById('reading-restore-btn');

    let session = readingState[chatId];


    if (session && session.isActive) {
      if (session.isMinimized) {
        restoreReadingRoom();
      }

      overlay.style.display = 'flex';
      return;
    }


    initReadingSession(chatId);
    renderReadingRoom(chatId);


    overlay.style.display = 'flex';
    windowEl.classList.remove('minimized');
    restoreBtn.style.display = 'none';




    const phoneScreen = document.getElementById('phone-screen');
    const windowRect = windowEl.getBoundingClientRect();


    const top = (phoneScreen.clientHeight - windowRect.height) / 2;
    const left = (phoneScreen.clientWidth - windowRect.width) / 2;


    windowEl.style.top = `${top}px`;
    windowEl.style.left = `${left}px`;
    windowEl.style.transform = '';

  }


  function initReadingSession(chatId) {
    readingState[chatId] = {
      isActive: true,
      isMinimized: false,
      title: '未选择书籍',
      contentLines: [],
      currentPage: 0,
      totalPages: 0,
      linesPerPage: 15,
      currentSnippet: '',
      readingStartedAt: Date.now(),
      summaryGenerated: false
    };
  }


  function closeReadingRoom() {
    const chatId = state.activeChatId;
    if (!chatId || !readingState[chatId] || !readingState[chatId].isActive) return;

    const session = readingState[chatId];
    session.isActive = false;
    document.getElementById('reading-overlay').style.display = 'none';
    document.getElementById('reading-restore-btn').style.display = 'none';
    document.getElementById('reading-window').classList.remove('minimized');
    console.log("读书会话已关闭。");
    generateReadingSummary(chatId, session).catch(error => {
      console.warn('生成读书总结失败:', error);
    });
  }





  function escapeReadingHtml(value) {
    return String(value || '').replace(/[&<>"']/g, ch => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
  }

  function isShortReadingHeading(line, index, lines) {
    const text = String(line || '').trim();
    if (!text || text.length > 24) return false;
    if (/^(目录|目\s*录|contents)$/i.test(text)) return false;
    if (/[。！？；，、]/.test(text) && !/^[一二三四五六七八九十百]+[、.．]/.test(text)) return false;
    const prevBlank = index === 0 || !String(lines[index - 1] || '').trim();
    const nextBlank = index === lines.length - 1 || !String(lines[index + 1] || '').trim();
    if (!prevBlank || !nextBlank) return false;
    if (/^[一二三四五六七八九十百]+(?:[、.．].*)?$/.test(text)) return true;
    if (/^(序章|序幕|序言|导读|引子|尾声|后记|终章|番外)/.test(text)) return true;
    return false;
  }

  function isReadingAnnotationLikeLine(text) {
    return /^[\[【(（]\s*\d{1,4}\s*[\]】)）]/.test(text) ||
      /^[①-⑳]/.test(text) ||
      /^(注|注释|注解|校注|脚注)\s*[:：]/.test(text);
  }

  function isDateTitleHeading(line, index, lines) {
    const text = String(line || '').trim();
    if (!text) return false;
    const isDate = /^(?:19|20)\d{2}\s*年(?:\s*\d{1,2}\s*月)?(?:\s*\d{1,2}\s*日)?$/.test(text) ||
      /^(?:19|20)\d{2}[./-]\d{1,2}(?:[./-]\d{1,2})?$/.test(text);
    if (!isDate) return false;
    const prevBlank = index === 0 || !String(lines[index - 1] || '').trim();
    const nextBlank = index === lines.length - 1 || !String(lines[index + 1] || '').trim();
    return prevBlank && nextBlank;
  }

  function isLooseShortReadingHeading(line, index, lines) {
    if (isShortReadingHeading(line, index, lines)) return true;
    const text = String(line || '').trim();
    if (!text || text.length > 18) return false;
    if (isReadingAnnotationLikeLine(text)) return false;
    if (/[。！？；，、]/.test(text)) return false;
    const prevBlank = index === 0 || !String(lines[index - 1] || '').trim();
    const nextBlank = index === lines.length - 1 || !String(lines[index + 1] || '').trim();
    return prevBlank && nextBlank;
  }

  function findReadingTocChapters(lines) {
    const tocIndex = lines.findIndex((line, index) =>
      index < 160 && /^(目录|目\s*录|contents)$/i.test(String(line || '').trim())
    );
    if (tocIndex < 0) return null;
    const entries = [];
    let tocEnd = tocIndex;
    for (let i = tocIndex + 1; i < lines.length && entries.length < 120; i++) {
      const text = String(lines[i] || '').trim();
      if (!text) continue;
      if (text.length > 60 || /[。！？]$/.test(text)) break;
      entries.push({ title: text, tocLine: i });
      tocEnd = i;
    }
    if (entries.length < 2) return null;
    const starts = [];
    let cursor = tocEnd + 1;
    for (const entry of entries) {
      let found = -1;
      for (let i = cursor; i < lines.length; i++) {
        if (String(lines[i] || '').trim() === entry.title) {
          found = i;
          break;
        }
      }
      if (found < 0) continue;
      starts.push({ startLine: found, title: entry.title });
      cursor = found + 1;
    }
    return starts.length >= 2 ? starts : null;
  }

  function buildReadingChaptersFromStartLines(session, startLines) {
    const lines = session.contentLines || [];
    const sorted = Array.from(new Set(startLines.map(Number).filter(line => Number.isInteger(line) && line >= 0)))
      .sort((a, b) => a - b);
    if (!sorted.length) return null;
    return sorted.map((startLine, index) => {
      const endLine = index + 1 < sorted.length ? sorted[index + 1] : lines.length;
      const heading = String(lines[startLine] || '').trim();
      return {
        index,
        title: heading || `第 ${index + 1} 章`,
        startLine,
        endLine,
        startOffset: getReadingPageStartOffset(session, startLine),
        endOffset: getReadingPageStartOffset(session, endLine)
      };
    });
  }

  function getReadingChapters(session) {
    const manualChapters = buildReadingChaptersFromStartLines(session, session.manualChapterStarts || []);
    if (manualChapters) return manualChapters;
    const epubHeadings = Array.isArray(session.epubHeadings) ? session.epubHeadings : [];
    if (epubHeadings.length) {
      const startLines = epubHeadings.map(heading => getReadingLineIndexForOffset(session, Number(heading.offset) || 0));
      const chapters = buildReadingChaptersFromStartLines(session, startLines);
      if (chapters) {
        chapters.forEach((chapter, index) => {
          if (epubHeadings[index]?.title) chapter.title = epubHeadings[index].title;
        });
        return chapters;
      }
    }
    const lines = session.contentLines || [];
    const builtInPattern = /^\s*(?:第\s*[0-9零〇一二三四五六七八九十百千万两]{1,9}\s*[章节節回卷部篇集]|chapter\s+[0-9ivxlcdm]+|【[^】]{1,30}】|\[[^\]]{1,30}\]|[0-9]{1,3}(?:、|[.．](?![0-9]))|={3,}.+={3,})/i;
    const customPattern = String(session.chapterSplitRegex || '').trim();
    const shortTitleMode = customPattern === '__short_titles__';
    const dateTitleMode = customPattern === '__date_titles__';
    let headingPattern = builtInPattern;
    if (customPattern && !shortTitleMode && !dateTitleMode) {
      try {
        headingPattern = new RegExp(customPattern, 'i');
      } catch (error) {
        console.warn('章节切分正则无效，改用内置规则:', error);
      }
    }

    let starts = [];
    if (customPattern && !shortTitleMode && !dateTitleMode) {
      lines.forEach((line, index) => {
        if (headingPattern.test(line)) starts.push({ startLine: index, title: String(line || '').trim() });
      });
    } else if (dateTitleMode) {
      lines.forEach((line, index) => {
        if (isReadingAnnotationLikeLine(String(line || '').trim())) return;
        if (isDateTitleHeading(line, index, lines) || headingPattern.test(line)) {
          starts.push({ startLine: index, title: String(line || '').trim() });
        }
      });
    } else {
      const tocChapters = findReadingTocChapters(lines);
      if (tocChapters) {
        starts = tocChapters;
      } else {
        lines.forEach((line, index) => {
          if (isReadingAnnotationLikeLine(String(line || '').trim())) return;
          if (headingPattern.test(line) || (shortTitleMode ? isLooseShortReadingHeading(line, index, lines) : isShortReadingHeading(line, index, lines))) {
            starts.push({ startLine: index, title: String(line || '').trim() });
          }
        });
      }
    }

    if (!starts.length) {
      return [{ index: 0, title: session.title || '本书', startLine: 0, endLine: lines.length, startOffset: 0, endOffset: getReadingPageStartOffset(session, lines.length) }];
    }
    starts.sort((a, b) => a.startLine - b.startLine);
    const deduped = starts.filter((item, index) => index === 0 || item.startLine !== starts[index - 1].startLine);
    if (deduped[0].startLine > 0) {
      deduped.unshift({ startLine: 0, title: '序章' });
    }
    return deduped.map((item, index) => {
      const startLine = item.startLine;
      const endLine = index + 1 < deduped.length ? deduped[index + 1].startLine : lines.length;
      const heading = String(item.title || lines[startLine] || '').trim();
      const title = heading.replace(/^=+|=+$/g, '').trim() || (index === 0 && startLine === 0 ? '序章' : `第 ${index + 1} 章`);
      return {
        index,
        title,
        startLine,
        endLine,
        startOffset: getReadingPageStartOffset(session, startLine),
        endOffset: getReadingPageStartOffset(session, endLine)
      };
    });
  }
  function getCurrentReadingChapter(session) {
    const chapters = getReadingChapters(session);
    return chapters[Math.max(0, Math.min(chapters.length - 1, Number(session.currentPage) || 0))] || chapters[0];
  }

  function getReadingChapterAnnotations(session, chapter) {
    return getReadingBookAnnotations(session.activeBookId).filter(annotation =>
      Number(annotation.startOffset) < Number(chapter.endOffset) &&
      Number(annotation.endOffset) > Number(chapter.startOffset)
    );
  }

  function getDefaultReadingGuideTemplate() {
    return `你是 {{char}}，正在和 {{user}} 一起读《{{title}}》。
只作为读者，不扮演书中角色，不续写剧情，不写动作、神态、场景。
以你自己的认知、经历和价值观阅读本书，可以赞同、质疑或联想。
不要为了讨好用户而解释，不要只顺着用户说。
重点关注人物命运、情节发展和书中表达，落点留在书上。`;
  }

  function getReadingSummaryPromptDefault() {
    return `你是一个客观的阅读记录助手。请根据下面的共读信息，写一段第三人称中文总结，用于写入聊天记录。

要求：
1. 称用户为“{{user}}”，称角色为“{{char}}”，不要用“我”“你”。
2. 第一句交代时间、人物和书名，例如：晚上 21:10–22:35，{{char}} 陪 {{user}} 读了《{{title}}》。
3. 用 1–2 句话概括读到哪里、读了多少。
4. 用 1–3 句话写两人讨论了什么、角色的主要观点和用户关注点。
5. 全文 100–300 字，一段话，不要 Markdown，不要“总结：”前缀，不要加引号。`;
  }

  function getReadingSummaryChatSettings(chat) {
    const settings = chat.readingSettings || {};
    return {
      enabled: settings.summaryEnabled !== false,
      prompt: String(settings.summaryPrompt || '').trim(),
      temperature: settings.summaryTemperature,
      maxTokens: settings.summaryMaxTokens
    };
  }

  async function generateReadingSummary(chatId, session) {
    if (!session || session.summaryGenerated) return;
    const chat = state.chats[chatId];
    if (!chat || !session.activeBookId) return;
    const settings = getReadingSummaryChatSettings(chat);
    if (!settings.enabled) return;

    const annotations = getReadingBookAnnotations(session.activeBookId);
    const reflections = await db.readingChapterReflections.where('bookId').equals(session.activeBookId).toArray().catch(() => []);
    const progressPages = Math.max(0, Number(session.currentPage) || 0) + 1;
    if (!annotations.length && !reflections.length && progressPages < 2) return;

    session.summaryGenerated = true;
    try {
      const book = await db.readingLibrary.get(session.activeBookId);
      const user = chat.settings?.myNickname || '用户';
      const char = chat.name || chat.originalName || '角色';
      const title = book?.title || session.title || '这本书';
      const total = Math.max(1, Number(session.totalPages) || 1);
      const current = Math.min(total, progressPages);
      const start = session.readingStartedAt ? new Date(session.readingStartedAt) : new Date();
      const end = new Date();
      const clock = date => `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
      const instruction = settings.prompt || getReadingSummaryPromptDefault();
      const filled = instruction
        .replace(/\{\{user\}\}/g, user)
        .replace(/\{\{char\}\}/g, char)
        .replace(/\{\{title\}\}/g, title);
      const annotationText = annotations.slice(-12).map(item => {
        const parts = [`划线：${String(item.quote || '').slice(0, 240)}`];
        if (item.note) parts.push(`批注：${String(item.note).slice(0, 180)}`);
        if (item.roleComment) parts.push(`${char}：${String(item.roleComment).slice(0, 220)}`);
        return parts.join('；');
      }).join('\n');
      const reflectionText = reflections.slice(-5).map(item => `章节反思：${String(item.content || '').slice(0, 300)}`).join('\n');
      const info = [
        `时间：${clock(start)}–${clock(end)}`,
        `书名：《${title}》`,
        `进度：第 ${current} / ${total} 章`,
        `用户：${user}`,
        `角色：${char}`,
        annotationText ? `划线批注：\n${annotationText}` : '',
        reflectionText ? `章节反思：\n${reflectionText}` : ''
      ].filter(Boolean).join('\n');

      const mainTemperature = Number.isFinite(Number(state.globalSettings?.apiTemperature))
        ? Number(state.globalSettings.apiTemperature)
        : 0.8;
      const mainMaxTokens = state.globalSettings?.apiMaxTokensEnabled && Number(state.globalSettings?.apiMaxTokens) > 0
        ? Number(state.globalSettings.apiMaxTokens)
        : 600;
      const hasTemp = settings.temperature !== null && settings.temperature !== undefined && String(settings.temperature).trim() !== '' && Number.isFinite(Number(settings.temperature));
      const hasMax = settings.maxTokens !== null && settings.maxTokens !== undefined && String(settings.maxTokens).trim() !== '' && Number.isFinite(Number(settings.maxTokens));
      const summary = await callReadingAi(
        filled,
        info,
        hasMax ? Number(settings.maxTokens) : mainMaxTokens,
        hasTemp ? Number(settings.temperature) : mainTemperature
      );
      const text = String(summary || '').trim().replace(/^["“”]+|["“”]+$/g, '').slice(0, 800);
      if (!text) return;
      const message = {
        role: 'system',
        type: 'narration',
        content: text,
        senderName: '旁白',
        timestamp: Date.now(),
        isReadingSummary: true
      };
      chat.history.push(message);
      await db.chats.put(chat);
      if (state.activeChatId === chatId && typeof window.appendMessage === 'function') {
        await window.appendMessage(message, chat);
      } else if (typeof renderChatList === 'function') {
        renderChatList();
      }
      window.showToast?.('读书总结已写入聊天', 'success');
    } catch (error) {
      console.error('生成读书总结失败:', error);
      window.showToast?.('读书总结生成失败', 'error');
    }
  }

  async function generateReadingChapterReflection() {
    const session = getActiveReadingSession();
    const chat = state.chats[state.activeChatId];
    if (!session?.activeBookId || !chat) return;
    const chapter = getCurrentReadingChapter(session);
    if (!chapter) return;
    const book = await db.readingLibrary.get(session.activeBookId);
    const annotations = getReadingChapterAnnotations(session, chapter);
    const existing = await db.readingChapterReflections
      .where('bookId').equals(session.activeBookId)
      .filter(item => String(item.chatId) === String(chat.id) && Number(item.chapterIndex) === Number(chapter.index))
      .first();
    if (existing) {
      const overwrite = await showCustomConfirm('重新生成反思', '这一章已经有反思，要覆盖吗？');
      if (!overwrite) return;
    }

    window.showToast?.('TA 正在写本章反思…');
    try {
      const guide = String(book?.annotationGuide || '以角色自己的认知和价值观阅读本书，关注人物命运、情节发展和书中表达。')
        .replace(/\{\{char\}\}/g, chat.name || chat.originalName || '角色')
        .replace(/\{\{user\}\}/g, chat.settings?.myNickname || '用户')
        .replace(/\{\{title\}\}/g, book?.title || session.title || '这本书');
      const noteText = annotations.length
        ? annotations.slice(-10).map(item => [
          `划线：${String(item.quote || '').slice(0, 180)}`,
          item.note ? `批注：${String(item.note).slice(0, 140)}` : '',
          item.roleComment ? `已有想法：${String(item.roleComment).slice(0, 180)}` : ''
        ].filter(Boolean).join('；')).join('\n')
        : '（这一章没有划线或批注）';
      const excerpt = session.contentLines.slice(chapter.startLine, chapter.endLine).join('\n').slice(0, 1800);
      const system = [
        `你是${chat.name || chat.originalName || '角色'}，正在和${chat.settings?.myNickname || '用户'}一起读《${book?.title || session.title}》。`,
        '你只是读者，不扮演书中角色，不续写剧情，不写动作、神态、场景。',
        chat.settings?.aiPersona ? `角色设定：\n${String(chat.settings.aiPersona).slice(0, 30000)}` : '',
        `本书批注侧重：${guide}`,
        '请写一段 200–250 字的本章反思，只谈书的内容、人物、情节和阅读感受，尽量体现你自己的判断。'
      ].join('\n\n');
      const user = [
        `章节：${chapter.title}`,
        `本章用户划线/批注：\n${noteText}`,
        `本章正文摘录：\n${excerpt}`
      ].join('\n\n');
      const mainTemperature = Number.isFinite(Number(state.globalSettings?.apiTemperature))
        ? Number(state.globalSettings.apiTemperature)
        : 0.8;
      const mainMaxTokens = state.globalSettings?.apiMaxTokensEnabled && Number(state.globalSettings?.apiMaxTokens) > 0
        ? Number(state.globalSettings.apiMaxTokens)
        : 500;
      const rawTemp = book?.annotationTemperature;
      const rawMax = book?.annotationMaxTokens;
      const hasTemp = rawTemp !== null && rawTemp !== undefined && String(rawTemp).trim() !== '' && Number.isFinite(Number(rawTemp));
      const hasMax = rawMax !== null && rawMax !== undefined && String(rawMax).trim() !== '' && Number.isFinite(Number(rawMax));
      const content = await callReadingAi(
        system,
        user,
        hasMax ? Number(rawMax) : mainMaxTokens,
        hasTemp ? Number(rawTemp) : mainTemperature
      );
      const text = String(content || '').trim().slice(0, 1200);
      if (!text) return;
      const record = {
        bookId: session.activeBookId,
        chatId: chat.id,
        chapterIndex: chapter.index,
        chapterTitle: chapter.title,
        content: text,
        createdAt: Date.now()
      };
      if (existing?.id) {
        record.id = existing.id;
        await db.readingChapterReflections.put(record);
      } else {
        await db.readingChapterReflections.add(record);
      }
      await renderReadingAnnotationPanel(state.activeChatId);
      window.showToast?.('本章反思已保存', 'success');
    } catch (error) {
      console.error('生成章节反思失败:', error);
      await showCustomAlert('生成失败', error.message || String(error));
    }
  }

  function getReadingPageStartOffset(session, startLine) {
    let offset = 0;
    for (let i = 0; i < startLine; i++) offset += String(session.contentLines[i] || '').length + 1;
    return offset;
  }

  function getReadingBookAnnotations(bookId) {
    return readingAnnotationsCache.filter(item => String(item.bookId) === String(bookId));
  }

  async function loadReadingAnnotations(bookId) {
    if (!bookId) {
      readingAnnotationsCache = [];
      return;
    }
    try {
      readingAnnotationsCache = await db.readingAnnotations.where('bookId').equals(bookId).toArray();
    } catch (error) {
      readingAnnotationsCache = [];
      console.warn('读取批注失败:', error);
    }
  }

  function renderReadingTextWithBookmarks(text, globalStart) {
    const bookmarks = Array.isArray(readingState[state.activeChatId]?.bookmarks)
      ? readingState[state.activeChatId].bookmarks
      : [];
    const textEnd = globalStart + text.length;
    const markers = bookmarks
      .filter(item => Number(item.startOffset) >= globalStart && Number(item.startOffset) <= textEnd)
      .sort((a, b) => Number(a.startOffset) - Number(b.startOffset));
    if (!markers.length) return escapeReadingHtml(text);
    let output = '';
    let cursor = 0;
    for (const bookmark of markers) {
      const local = Math.max(0, Math.min(text.length, Number(bookmark.startOffset) - globalStart));
      if (local < cursor) continue;
      output += escapeReadingHtml(text.slice(cursor, local));
      output += `<span class="reading-bookmark-marker" data-bookmark-id="${escapeReadingHtml(bookmark.id)}" title="书签">🔖</span>`;
      cursor = local;
    }
    output += escapeReadingHtml(text.slice(cursor));
    return output;
  }

  function renderReadingPageHtml(session, startLine, endLine) {
    const pageText = session.contentLines.slice(startLine, endLine).join('\n');
    const pageStart = getReadingPageStartOffset(session, startLine);
    const pageEnd = pageStart + pageText.length;
    const annotations = getReadingBookAnnotations(session.activeBookId)
      .filter(item => Number(item.endOffset) > pageStart && Number(item.startOffset) < pageEnd)
      .sort((a, b) => Number(a.startOffset) - Number(b.startOffset));

    if (!annotations.length) return renderReadingTextWithBookmarks(pageText, pageStart);

    let html = '';
    let cursor = 0;
    for (const annotation of annotations) {
      const start = Math.max(0, Number(annotation.startOffset) - pageStart);
      const end = Math.min(pageText.length, Number(annotation.endOffset) - pageStart);
      if (end <= cursor || end <= start) continue;
      const style = ['highlight', 'underline', 'wavy', 'note'].includes(annotation.style) ? annotation.style : 'highlight';
      const color = /^#[0-9a-f]{6}$/i.test(annotation.color || '') ? annotation.color : '#ffd54f';
      const decoration = style === 'highlight' ? `background-color:${color};` : `text-decoration-color:${color};`;
      html += renderReadingTextWithBookmarks(pageText.slice(cursor, start), pageStart + cursor);
      html += `<mark class="reading-annotation-${style}" data-reading-annotation-id="${escapeReadingHtml(annotation.id)}" style="${decoration}">${renderReadingTextWithBookmarks(pageText.slice(start, end), pageStart + start)}</mark>`;
      cursor = end;
    }
    html += renderReadingTextWithBookmarks(pageText.slice(cursor), pageStart + cursor);
    return html;
  }

  function renderReadingRoom(chatId) {
    const session = readingState[chatId];
    if (!session) return;

    // --- 【新增/修改部分开始】 ---
    // 1. 获取当前聊天的字体设置
    const chat = state.chats[chatId];
    // 默认 13px，如果有设置则使用设置值
    const fontSize = Number(chat?.readingSettings?.fontSize) || (chat && chat.settings && chat.settings.fontSize) || 13;

    const contentEl = document.getElementById('reading-content');
    const previousScrollTop = contentEl ? contentEl.scrollTop : 0;

    // 2. 将字体大小应用到读书容器
    contentEl.style.fontSize = `${fontSize}px`;
    const annotationPanel = document.getElementById('reading-annotation-panel');
    if (annotationPanel) annotationPanel.style.fontSize = `${fontSize}px`;
    // 3. 动态调整行高 (Line Height)，防止字体变大后文字挤在一起
    // 1.6 是一个比较舒适的阅读倍率
    contentEl.style.lineHeight = '1.6';
    // --- 【新增/修改部分结束】 ---

    const titleEl = document.getElementById('reading-title');
    // const contentEl = document.getElementById('reading-content'); // 这行上面已经获取了，可以注释掉或删除
    const pageIndicator = document.getElementById('page-indicator');
    const prevBtn = document.getElementById('prev-page-btn');
    const nextBtn = document.getElementById('next-page-btn');

    titleEl.textContent = session.title;

    if (session.contentLines.length === 0) {
      contentEl.innerHTML = '<p style="text-align:center; padding-top:50px; color:#888;">点击"导入"按钮，<br>从本地.txt文件或网络URL加载书籍内容。</p>';
      session.totalPages = 0;
      session.currentPage = 0;
    } else {
      const chapters = getReadingChapters(session);
      session.totalPages = Math.max(1, chapters.length);
      if (session.currentPage >= session.totalPages) session.currentPage = session.totalPages - 1;
      if (session.currentPage < 0) session.currentPage = 0;
      const chapter = chapters[session.currentPage] || chapters[0];
      contentEl.style.whiteSpace = 'pre-wrap';
      contentEl.innerHTML = renderReadingPageHtml(session, chapter.startLine, chapter.endLine);
      contentEl.scrollTop = previousScrollTop;
    }

    pageIndicator.textContent = session.totalPages
      ? `第 ${session.currentPage + 1} / ${session.totalPages} 章`
      : '0 / 0';
    renderReadingAnnotationPanel(chatId);
    prevBtn.disabled = session.currentPage === 0;
    nextBtn.disabled = session.currentPage >= session.totalPages - 1;
  }

  function getActiveReadingSession() {
    const chatId = state.activeChatId;
    if (!chatId) return null;
    const session = readingState[chatId];
    return session && session.isActive ? session : null;
  }

  function hideReadingSelectionToolbar() {
    document.getElementById('reading-selection-toolbar')?.classList.remove('visible');
    readingSelection = null;
  }

  function getReadingSelectionFromDom() {
    const session = getActiveReadingSession();
    const contentEl = document.getElementById('reading-content');
    const selection = window.getSelection();
    if (!session || !contentEl || !selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
    const range = selection.getRangeAt(0);
    if (!contentEl.contains(range.commonAncestorContainer)) return null;

    const before = range.cloneRange();
    before.selectNodeContents(contentEl);
    before.setEnd(range.startContainer, range.startOffset);
    const after = range.cloneRange();
    after.selectNodeContents(contentEl);
    after.setEnd(range.endContainer, range.endOffset);
    let startInPage = before.toString().length;
    let endInPage = after.toString().length;
    if (endInPage < startInPage) [startInPage, endInPage] = [endInPage, startInPage];
    if (endInPage <= startInPage) return null;

    const chapter = getCurrentReadingChapter(session);
    const pageStart = chapter?.startOffset || 0;
    const startOffset = pageStart + startInPage;
    const endOffset = pageStart + endInPage;
    const fullText = session.contentLines.join('\n');
    return {
      startOffset,
      endOffset,
      quote: fullText.slice(startOffset, endOffset)
    };
  }

  function showReadingSelectionToolbar(rect) {
    const toolbar = document.getElementById('reading-selection-toolbar');
    if (!toolbar || !readingSelection) return;
    toolbar.classList.add('visible');
    const width = 300;
    const left = Math.max(8, Math.min(window.innerWidth - width - 8, rect.left));
    const top = Math.max(8, rect.top - 86);
    toolbar.style.left = `${left}px`;
    toolbar.style.top = `${top}px`;
  }

  function captureReadingSelection() {
    const next = getReadingSelectionFromDom();
    if (!next || !next.quote.trim()) {
      hideReadingSelectionToolbar();
      return;
    }
    readingSelection = next;
    const selection = window.getSelection();
    const rect = selection.rangeCount ? selection.getRangeAt(0).getBoundingClientRect() : { left: 16, top: 180 };
    showReadingSelectionToolbar(rect);
  }

  async function saveReadingAnnotation(style = 'highlight', note = '', selection = readingSelection) {
    const session = getActiveReadingSession();
    if (!session || !session.activeBookId || !selection) return null;
    const colorInput = document.getElementById('reading-annotation-color');
    const annotation = {
      bookId: session.activeBookId,
      chatId: state.activeChatId,
      startOffset: selection.startOffset,
      endOffset: selection.endOffset,
      quote: selection.quote.slice(0, 2000),
      style: ['highlight', 'underline', 'wavy', 'note'].includes(style) ? style : 'highlight',
      color: /^#[0-9a-f]{6}$/i.test(colorInput?.value || '') ? colorInput.value : '#ffd54f',
      note: String(note || '').slice(0, 1000),
      roleComment: '',
      createdAt: Date.now()
    };
    try {
      const id = await db.readingAnnotations.add(annotation);
      annotation.id = id;
      readingAnnotationsCache.push(annotation);
      window.getSelection()?.removeAllRanges();
      hideReadingSelectionToolbar();
      renderReadingRoom(state.activeChatId);
      return annotation;
    } catch (error) {
      console.error('保存批注失败:', error);
      await showCustomAlert('保存批注失败', error.message || String(error));
      return null;
    }
  }

  function openReadingAnnotationEdit(annotationId) {
    const session = getActiveReadingSession();
    const annotation = readingAnnotationsCache.find(item => String(item.id) === String(annotationId));
    if (!session || !annotation) return;
    editingReadingAnnotation = { ...annotation };
    const quoteEl = document.getElementById('reading-annotation-edit-quote');
    if (quoteEl) quoteEl.textContent = annotation.quote;
    const styleEl = document.getElementById('reading-annotation-edit-style');
    if (styleEl) styleEl.value = annotation.style || 'highlight';
    const colorEl = document.getElementById('reading-annotation-edit-color');
    if (colorEl) colorEl.value = /^#[0-9a-f]{6}$/i.test(annotation.color || '') ? annotation.color : '#ffd54f';
    const noteEl = document.getElementById('reading-annotation-edit-note');
    if (noteEl) noteEl.value = annotation.note || '';
    const lengthEl = document.getElementById('reading-annotation-edit-length');
    if (lengthEl) lengthEl.textContent = `${annotation.quote.length} 字`;
    document.getElementById('reading-annotation-edit-modal')?.classList.add('visible');
  }

  function adjustReadingAnnotationEdit(delta) {
    const session = getActiveReadingSession();
    if (!session || !editingReadingAnnotation) return;
    const fullText = session.contentLines.join('\n');
    editingReadingAnnotation.endOffset = Math.max(
      editingReadingAnnotation.startOffset + 1,
      Math.min(fullText.length, editingReadingAnnotation.endOffset + delta)
    );
    editingReadingAnnotation.quote = fullText.slice(editingReadingAnnotation.startOffset, editingReadingAnnotation.endOffset);
    const quoteEl = document.getElementById('reading-annotation-edit-quote');
    if (quoteEl) quoteEl.textContent = editingReadingAnnotation.quote;
    const lengthEl = document.getElementById('reading-annotation-edit-length');
    if (lengthEl) lengthEl.textContent = `${editingReadingAnnotation.quote.length} 字`;
  }

  async function saveReadingAnnotationEdit() {
    if (!editingReadingAnnotation) return;
    try {
      const styleEl = document.getElementById('reading-annotation-edit-style');
      const colorEl = document.getElementById('reading-annotation-edit-color');
      const noteEl = document.getElementById('reading-annotation-edit-note');
      editingReadingAnnotation.style = ['highlight', 'underline', 'wavy', 'note'].includes(styleEl?.value) ? styleEl.value : 'highlight';
      editingReadingAnnotation.color = /^#[0-9a-f]{6}$/i.test(colorEl?.value || '') ? colorEl.value : '#ffd54f';
      editingReadingAnnotation.note = String(noteEl?.value || '').slice(0, 1000);
      editingReadingAnnotation.updatedAt = Date.now();
      await db.readingAnnotations.put(editingReadingAnnotation);
      readingAnnotationsCache = readingAnnotationsCache.map(item =>
        String(item.id) === String(editingReadingAnnotation.id) ? { ...editingReadingAnnotation } : item
      );
      document.getElementById('reading-annotation-edit-modal')?.classList.remove('visible');
      editingReadingAnnotation = null;
      renderReadingRoom(state.activeChatId);
      openReadingAnnotationPanel();
    } catch (error) {
      console.error('保存批注编辑失败:', error);
      await showCustomAlert('保存失败', error.message || String(error));
    }
  }

  function getReadingAnnotationConversation(annotation) {
    const conversation = Array.isArray(annotation?.roleConversation)
      ? annotation.roleConversation
        .filter(message => message && (message.role === 'user' || message.role === 'assistant') && message.content)
        .map(message => ({ role: message.role, content: String(message.content).replace(/^[\s\u3000]+/, '').trim() }))
      : [];
    if (!conversation.length && annotation?.roleComment) {
      conversation.push({ role: 'assistant', content: String(annotation.roleComment) });
    }
    return conversation;
  }

  async function focusReadingAnnotationCard(annotationId) {
    openReadingAnnotationPanel();
    await renderReadingAnnotationPanel(state.activeChatId);
    const card = document.querySelector('#reading-annotation-list .reading-annotation-card[data-reading-annotation-id="' + annotationId + '"]');
    if (!card) return;
    card.classList.add('is-focused');
    const list = document.getElementById('reading-annotation-list');
    if (list) {
      const cardRect = card.getBoundingClientRect();
      const listRect = list.getBoundingClientRect();
      const targetTop = list.scrollTop + cardRect.top - listRect.top - Math.max(8, (list.clientHeight - cardRect.height) / 2);
      list.scrollTo({ top: Math.max(0, targetTop), behavior: 'smooth' });
    }
    setTimeout(() => card.classList.remove('is-focused'), 1800);
  }
  function openReadingAnnotationPanel() {
    document.getElementById('reading-selection-toolbar')?.classList.remove('visible');
    document.getElementById('reading-annotation-panel')?.classList.add('visible');
    renderReadingAnnotationPanel(state.activeChatId);
  }

  async function renderReadingAnnotationPanel(chatId) {
    const session = readingState[chatId];
    const listEl = document.getElementById('reading-annotation-list');
    if (!session || !listEl) return;
    const annotations = getReadingBookAnnotations(session.activeBookId)
      .slice()
      .sort((a, b) => Number(a.startOffset) - Number(b.startOffset));
    const reflections = session.activeBookId
      ? await db.readingChapterReflections.where('bookId').equals(session.activeBookId).toArray().catch(() => [])
      : [];
    listEl.innerHTML = '';
    if (!annotations.length && !reflections.length) {
      listEl.innerHTML = '<div class="reading-annotation-empty">还没有批注。选中正文后划线，或点“批注”记录想法。</div>';
      return;
    }
    annotations.forEach(annotation => {
      const card = document.createElement('div');
      card.className = 'reading-annotation-card';
      card.dataset.readingAnnotationId = annotation.id;
      const styleName = annotation.style === 'underline' ? '直线' : annotation.style === 'wavy' ? '波浪' : annotation.style === 'note' ? '批注' : '高亮';
      const conversation = getReadingAnnotationConversation(annotation);
      const chat = state.chats[chatId];
      const userName = chat?.settings?.myNickname || '我';
      const charName = chat?.name || chat?.originalName || '角色';
      const threadHtml = conversation.map(message => `<div class="reading-annotation-thread-message ${message.role === 'user' ? 'is-user' : 'is-char'}"><strong>${escapeReadingHtml(message.role === 'user' ? userName : charName)}：</strong><span>${escapeReadingHtml(message.content)}</span></div>`).join('');
      card.innerHTML = `
        <div class="reading-annotation-quote">${escapeReadingHtml(annotation.quote)}</div>
        ${annotation.note ? `<div class="reading-annotation-user-note"><strong>我的批注：</strong>${escapeReadingHtml(String(annotation.note).replace(/^[\s\u3000]+/, ''))}</div>` : ''}
        ${threadHtml ? `<div class="reading-annotation-thread">${threadHtml}</div>` : ''}
        <div class="reading-annotation-actions">
          <span style="color:var(--text-secondary);font-size:11px;flex:1;">${styleName}</span>
          <button type="button" data-reading-annotation-action="edit" data-annotation-id="${escapeReadingHtml(annotation.id)}">编辑</button>
          <button type="button" data-reading-annotation-action="react" data-annotation-id="${escapeReadingHtml(annotation.id)}">让 TA 说说</button>
          <button type="button" data-reading-annotation-action="followup" data-annotation-id="${escapeReadingHtml(annotation.id)}">追问</button>
          <button type="button" data-reading-annotation-action="delete" data-annotation-id="${escapeReadingHtml(annotation.id)}">删除</button>
        </div>`;
      card.addEventListener('click', event => {
        if (event.target.closest('button')) return;
        jumpToReadingAnnotation(annotation.id);
      });
      listEl.appendChild(card);
    });
    if (reflections.length) {
      const heading = document.createElement('div');
      heading.className = 'reading-annotation-card';
      heading.style.fontWeight = '600';
      heading.textContent = `章节反思（${reflections.length}）`;
      listEl.appendChild(heading);
      reflections
        .slice()
        .sort((a, b) => Number(a.chapterIndex) - Number(b.chapterIndex))
        .forEach(reflection => {
          const card = document.createElement('div');
          card.className = 'reading-annotation-card';
          card.innerHTML = `<div class="reading-annotation-note" style="font-weight:600;">${escapeReadingHtml(reflection.chapterTitle || '章节反思')}</div><div style="margin-top:5px;white-space:pre-wrap;">${escapeReadingHtml(reflection.content || '')}</div>`;
          listEl.appendChild(card);
        });
    }
  }

  function scrollReadingToOffset(offset) {
    const session = getActiveReadingSession();
    const content = document.getElementById('reading-content');
    if (!session || !content) return;
    const chapter = getCurrentReadingChapter(session);
    if (!chapter) return;
    const target = Math.max(0, Math.min(chapter.endOffset - chapter.startOffset, Number(offset) - chapter.startOffset));
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
    let remaining = target;
    let node = walker.nextNode();
    while (node) {
      const length = node.nodeValue ? node.nodeValue.length : 0;
      if (remaining <= length) {
        try {
          const range = document.createRange();
          range.setStart(node, Math.min(length, remaining));
          range.setEnd(node, Math.min(length, remaining + 1));
          const rect = range.getBoundingClientRect();
          const contentRect = content.getBoundingClientRect();
          content.scrollTop += rect.top - contentRect.top - 24;
        } catch (error) {
          console.warn('定位书签失败:', error);
        }
        return;
      }
      remaining -= length;
      node = walker.nextNode();
    }
  }

  function scrollReadingElementIntoView(element) {
    const content = document.getElementById('reading-content');
    if (!content || !element) return false;
    const rect = element.getBoundingClientRect();
    const contentRect = content.getBoundingClientRect();
    content.scrollTop += rect.top - contentRect.top - 24;
    return true;
  }

  function jumpToReadingAnnotation(annotationId) {
    const session = getActiveReadingSession();
    const annotation = readingAnnotationsCache.find(item => String(item.id) === String(annotationId));
    if (!session || !annotation) return;
    const chapters = getReadingChapters(session);
    const chapter = chapters.find(item =>
      Number(annotation.startOffset) >= Number(item.startOffset) &&
      Number(annotation.startOffset) < Number(item.endOffset)
    ) || chapters[0];
    if (chapter) session.currentPage = chapter.index;
    renderReadingRoom(state.activeChatId);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const mark = document.querySelector('[data-reading-annotation-id="' + annotation.id + '"]');
      if (!scrollReadingElementIntoView(mark)) scrollReadingToOffset(annotation.startOffset);
    }));
  }

  async function reactToReadingAnnotation(annotationId) {
    await requestReadingAnnotationReply(annotationId, '');
  }

  async function followUpReadingAnnotation(annotationId) {
    const question = await showCustomPrompt('继续讨论', '你想继续问 TA 什么？', '');
    if (question === null || !question.trim()) return;
    await requestReadingAnnotationReply(annotationId, question.trim());
  }

  async function requestReadingAnnotationReply(annotationId, question = '') {
    const annotation = readingAnnotationsCache.find(item => String(item.id) === String(annotationId));
    const session = getActiveReadingSession();
    const chat = state.chats[state.activeChatId];
    if (!annotation || !session || !chat) return;

    const conversation = getReadingAnnotationConversation(annotation);
    if (question) {
      annotation.roleConversation = conversation.concat({ role: 'user', content: question });
      await db.readingAnnotations.put(annotation);
      await renderReadingAnnotationPanel(state.activeChatId);
    }

    window.showToast?.(question ? 'TA 正在回复…' : 'TA 正在读这段话…');
    try {
      const book = await db.readingLibrary.get(session.activeBookId);
      const charName = chat.name || chat.originalName || '角色';
      const userName = chat.settings?.myNickname || '用户';
      const bookTitle = book?.title || session.title || '这本书';
      const defaultGuide = getDefaultReadingGuideTemplate();
      const annotationGuide = String(book?.annotationGuide || defaultGuide)
        .replace(/\{\{char\}\}/g, charName)
        .replace(/\{\{user\}\}/g, userName)
        .replace(/\{\{title\}\}/g, bookTitle);
      const system = [
        `你是${charName}，正在和${userName}一起读《${bookTitle}》。`,
        '你只是读者，不是书中角色。只谈书的内容和你的判断，不写动作、神态、场景，不续写剧情。',
        chat.settings?.aiPersona ? `角色设定：\n${String(chat.settings.aiPersona).slice(0, 30000)}` : '',
        `本书批注侧重：${annotationGuide}`,
        '回复 100–150 字，直接说你的看法；不要围着用户说，不要为了讨好用户而解释。'
      ].filter(Boolean).join('\n\n');
      const user = [
        `划线内容：${annotation.quote}`,
        annotation.note ? `我的批注：${annotation.note}` : '',
        question ? `我的问题：${question}` : '请直接谈谈你对这段话的看法。'
      ].filter(Boolean).join('\n\n');
      const mainTemperature = Number.isFinite(Number(state.globalSettings?.apiTemperature))
        ? Number(state.globalSettings.apiTemperature)
        : 0.8;
      const mainMaxTokens = state.globalSettings?.apiMaxTokensEnabled && Number(state.globalSettings?.apiMaxTokens) > 0
        ? Number(state.globalSettings.apiMaxTokens)
        : 350;
      const rawReadingTemperature = book?.annotationTemperature;
      const hasReadingTemperature = rawReadingTemperature !== null && rawReadingTemperature !== undefined &&
        String(rawReadingTemperature).trim() !== '' && Number.isFinite(Number(rawReadingTemperature));
      const rawReadingMaxTokens = book?.annotationMaxTokens;
      const hasReadingMaxTokens = rawReadingMaxTokens !== null && rawReadingMaxTokens !== undefined &&
        String(rawReadingMaxTokens).trim() !== '' && Number.isFinite(Number(rawReadingMaxTokens));
      const roleTemperature = hasReadingTemperature ? Number(rawReadingTemperature) : mainTemperature;
      const roleMaxTokens = hasReadingMaxTokens ? Number(rawReadingMaxTokens) : mainMaxTokens;
      const answer = await callReadingAi(system, user, roleMaxTokens, roleTemperature, conversation);
      const updatedConversation = getReadingAnnotationConversation(annotation).concat({
        role: 'assistant',
        content: String(answer || '').trim().slice(0, 1000)
      });
      annotation.roleConversation = updatedConversation;
      annotation.roleComment = updatedConversation.filter(message => message.role === 'assistant').slice(-1)[0]?.content || '';
      await db.readingAnnotations.put(annotation);
      await renderReadingAnnotationPanel(state.activeChatId);
    } catch (error) {
      console.error('角色批注失败:', error);
      await showCustomAlert('批注失败', error.message || String(error));
    }
  }
  async function callReadingAi(systemPrompt, userPrompt, maxTokens = 350, temperature = 0.7, history = []) {
    const { proxyUrl, apiKey, model } = state.apiConfig || {};
    if (!proxyUrl || !apiKey || !model) throw new Error('请先在 API 设置中配置模型。');
    const isGemini = String(proxyUrl).includes('generativelanguage');
    let response;
    if (isGemini && typeof toGeminiRequestData === 'function') {
      const chatMessages = [...(history || []).map(message => ({ role: message.role, content: message.content })), { role: 'user', content: userPrompt }];
      const cfg = toGeminiRequestData(model, apiKey, systemPrompt, chatMessages);
      try {
        const body = JSON.parse(cfg.data.body);
        body.generationConfig = {
          ...(body.generationConfig || {}),
          temperature,
          maxOutputTokens: maxTokens
        };
        cfg.data = { ...cfg.data, body: JSON.stringify(body) };
      } catch (_) {}
      response = await fetch(cfg.url, cfg.data);
    } else {
      response = await fetch(`${String(proxyUrl).replace(/\/+$/, '')}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          messages: [{ role: 'system', content: systemPrompt }, ...(history || []).map(message => ({ role: message.role, content: message.content })), { role: 'user', content: userPrompt }],
          temperature,
          max_tokens: maxTokens
        })
      });
    }
    if (!response.ok) throw new Error(`API ${response.status}`);
    const data = await response.json();
    return String(typeof getGeminiResponseText === 'function' ? getGeminiResponseText(data) : data.choices?.[0]?.message?.content || '').trim();
  }

  async function openReadingGuideModal() {
    const session = getActiveReadingSession();
    if (!session?.activeBookId) return;
    const book = await db.readingLibrary.get(session.activeBookId);
    const input = document.getElementById('reading-guide-input');
    if (input) input.value = book?.annotationGuide || '';
    const temperatureInput = document.getElementById('reading-role-temperature');
    if (temperatureInput) temperatureInput.value = book?.annotationTemperature ?? '';
    const maxTokensInput = document.getElementById('reading-role-max-tokens');
    if (maxTokensInput) maxTokensInput.value = book?.annotationMaxTokens ?? '';
    document.getElementById('reading-guide-modal')?.classList.add('visible');
  }

  async function saveReadingGuide() {
    const session = getActiveReadingSession();
    if (!session?.activeBookId) return;
    const value = String(document.getElementById('reading-guide-input')?.value || '').trim();
    const annotationTemperature = parseFloat(document.getElementById('reading-role-temperature')?.value);
    const annotationMaxTokens = parseInt(document.getElementById('reading-role-max-tokens')?.value, 10);
    await db.readingLibrary.update(session.activeBookId, {
      annotationGuide: value,
      annotationTemperature: Number.isFinite(annotationTemperature) ? annotationTemperature : null,
      annotationMaxTokens: Number.isFinite(annotationMaxTokens) ? annotationMaxTokens : null
    });
    document.getElementById('reading-guide-modal')?.classList.remove('visible');
    window.showToast?.('本书批注引导词已保存');
  }

  function getReadingParagraphAtOffset(session, offset) {
    const lines = session.contentLines || [];
    let offsetCursor = 0;
    let lineIndex = 0;
    for (let i = 0; i < lines.length; i++) {
      const next = offsetCursor + String(lines[i] || '').length + 1;
      if (offset < next) {
        lineIndex = i;
        break;
      }
      offsetCursor = next;
      lineIndex = i;
    }
    if (!String(lines[lineIndex] || '').trim()) return null;
    let startLine = lineIndex;
    let endLine = lineIndex + 1;
    while (startLine > 0 && String(lines[startLine - 1] || '').trim()) startLine--;
    while (endLine < lines.length && String(lines[endLine] || '').trim()) endLine++;
    const raw = lines.slice(startLine, endLine).join('\n');
    const leading = (raw.match(/^\s*/) || [''])[0].length;
    return {
      startOffset: getReadingPageStartOffset(session, startLine) + leading,
      endOffset: getReadingPageStartOffset(session, endLine),
      quote: raw.trim()
    };
  }

  async function saveReadingBookmark() {
    const session = getActiveReadingSession();
    if (!session?.activeBookId || !readingSelection) return;
    const paragraph = getReadingParagraphAtOffset(session, readingSelection.startOffset);
    if (!paragraph || !paragraph.quote) {
      window.showToast?.('没有找到可添加书签的段落');
      return;
    }
    const chapter = getCurrentReadingChapter(session);
    const book = await db.readingLibrary.get(session.activeBookId);
    const bookmarks = Array.isArray(book?.bookmarks) ? book.bookmarks.slice() : [];
    if (bookmarks.some(item => Number(item.startOffset) === Number(paragraph.startOffset))) {
      window.showToast?.('这一段已经有书签了');
      return;
    }
    bookmarks.push({
      id: 'bookmark_' + Date.now(),
      chapterIndex: chapter?.index ?? 0,
      chapterTitle: chapter?.title || '',
      startOffset: paragraph.startOffset,
      endOffset: paragraph.endOffset,
      quote: paragraph.quote.slice(0, 500),
      createdAt: Date.now()
    });
    try {
      await db.readingLibrary.update(session.activeBookId, { bookmarks });
      session.bookmarks = bookmarks;
    } catch (error) {
      console.error('添加书签失败:', error);
      await showCustomAlert('添加书签失败', error.message || String(error));
      return;
    }
    window.getSelection()?.removeAllRanges();
    hideReadingSelectionToolbar();
    renderReadingRoom(state.activeChatId);
    if (document.getElementById('reading-toc-modal')?.classList.contains('visible')) {
      readingTocTab = 'bookmarks';
      renderReadingToc();
    }
    window.showToast?.('已添加书签');
  }

  function jumpToReadingBookmark(bookmark) {
    const session = getActiveReadingSession();
    if (!session || !bookmark) return;
    const chapters = getReadingChapters(session);
    const chapter = chapters.find(item =>
      Number(bookmark.startOffset) >= Number(item.startOffset) && Number(bookmark.startOffset) < Number(item.endOffset)
    ) || chapters.find(item => Number(bookmark.chapterIndex) === Number(item.index)) || chapters[0];
    if (!chapter) return;
    session.currentPage = chapter.index;
    document.getElementById('reading-toc-modal')?.classList.remove('visible');
    renderReadingRoom(state.activeChatId);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const marker = document.querySelector('[data-bookmark-id="' + bookmark.id + '"]');
      if (!scrollReadingElementIntoView(marker)) scrollReadingToOffset(bookmark.startOffset);
    }));
    saveReadingProgress(session.activeBookId, session.currentPage);
  }

  async function renderReadingToc() {
    const session = getActiveReadingSession();
    const listEl = document.getElementById('reading-toc-list');
    if (!session || !listEl) return;
    document.getElementById('reading-toc-tab-chapters')?.classList.toggle('is-active', readingTocTab === 'chapters');
    document.getElementById('reading-toc-tab-bookmarks')?.classList.toggle('is-active', readingTocTab === 'bookmarks');
    const book = session.activeBookId ? await db.readingLibrary.get(session.activeBookId) : null;
    const bookmarks = Array.isArray(book?.bookmarks) ? book.bookmarks : [];
    const bookmarkTab = document.getElementById('reading-toc-tab-bookmarks');
    if (bookmarkTab) bookmarkTab.textContent = bookmarks.length ? `书签 ${bookmarks.length}` : '书签';
    listEl.innerHTML = '';
    if (readingTocTab === 'chapters') {
      getReadingChapters(session).forEach(chapter => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'reading-toc-item' + (Number(chapter.index) === Number(session.currentPage) ? ' is-current' : '');
        item.innerHTML = `<span>${escapeReadingHtml(chapter.title || `第 ${chapter.index + 1} 章`)}</span><small>${chapter.index + 1}</small>`;
        item.addEventListener('click', () => {
          session.currentPage = chapter.index;
          document.getElementById('reading-toc-modal')?.classList.remove('visible');
          renderReadingRoom(state.activeChatId);
          document.getElementById('reading-content').scrollTop = 0;
          saveReadingProgress(session.activeBookId, session.currentPage);
        });
        listEl.appendChild(item);
      });
      return;
    }

    if (!bookmarks.length) {
      listEl.innerHTML = '<div class="reading-annotation-empty">还没有书签。选中一段文字后点“书签”。</div>';
      return;
    }
    bookmarks.slice().sort((a, b) => Number(a.startOffset) - Number(b.startOffset)).forEach(bookmark => {
      const item = document.createElement('div');
      item.className = 'reading-bookmark-item';
      item.innerHTML = `<div class="reading-bookmark-main"><div class="reading-bookmark-title">${escapeReadingHtml(bookmark.chapterTitle || '书签')}</div><div class="reading-bookmark-quote">${escapeReadingHtml(String(bookmark.quote || '').slice(0, 40))}${String(bookmark.quote || '').length > 40 ? '…' : ''}</div></div><button type="button" class="reading-bookmark-delete" title="删除书签">删除</button>`;
      item.querySelector('.reading-bookmark-main')?.addEventListener('click', () => jumpToReadingBookmark(bookmark));
      item.querySelector('.reading-bookmark-delete')?.addEventListener('click', async event => {
        event.stopPropagation();
        const confirmed = await showCustomConfirm('删除书签', '确定删除这条书签吗？');
        if (!confirmed) return;
        const latestBook = await db.readingLibrary.get(session.activeBookId);
        const nextBookmarks = (Array.isArray(latestBook?.bookmarks) ? latestBook.bookmarks : [])
          .filter(old => String(old.id) !== String(bookmark.id));
        await db.readingLibrary.update(session.activeBookId, { bookmarks: nextBookmarks });
        session.bookmarks = nextBookmarks;
        renderReadingRoom(state.activeChatId);
        renderReadingToc();
      });
      listEl.appendChild(item);
    });
  }

  function getReadingChapterCandidates(session) {
    const lines = session.contentLines || [];
    const candidates = new Set();
    lines.forEach((line, index) => {
      const text = String(line || '').trim();
      if (!text || text.length > 60) return;
      if (isReadingAnnotationLikeLine(text)) return;
      const prevBlank = index === 0 || !String(lines[index - 1] || '').trim();
      const nextBlank = index === lines.length - 1 || !String(lines[index + 1] || '').trim();
      if (prevBlank && nextBlank) candidates.add(index);
    });
    const savedManual = session.manualChapterStarts;
    session.manualChapterStarts = [];
    getReadingChapters(session).forEach(chapter => candidates.add(chapter.startLine));
    session.manualChapterStarts = savedManual;
    return Array.from(candidates).sort((a, b) => a - b);
  }

  function renderReadingChapterCandidates() {
    const session = getActiveReadingSession();
    const listEl = document.getElementById('reading-chapter-candidate-list');
    if (!session || !listEl) return;
    const selected = new Set((session.manualChapterStarts || []).map(Number));
    const hasManual = selected.size > 0;
    const autoStarts = new Set();
    const savedManual = session.manualChapterStarts;
    session.manualChapterStarts = [];
    getReadingChapters(session).forEach(chapter => autoStarts.add(chapter.startLine));
    session.manualChapterStarts = savedManual;
    listEl.innerHTML = '';
    getReadingChapterCandidates(session).forEach((lineIndex, index) => {
      const text = String(session.contentLines[lineIndex] || '').trim();
      const checked = hasManual ? selected.has(lineIndex) : autoStarts.has(lineIndex);
      const label = document.createElement('label');
      label.style.cssText = 'display:flex;gap:8px;align-items:flex-start;padding:7px 2px;border-bottom:1px solid var(--border-color,#eee);font-size:12px;line-height:1.4;';
      label.innerHTML = `<input type="checkbox" data-chapter-line="${lineIndex}" ${checked ? 'checked' : ''}><span style="flex:1;min-width:0;">${escapeReadingHtml(text)}</span><small style="color:var(--text-secondary,#999);">${lineIndex + 1}</small>`;
      listEl.appendChild(label);
    });
  }

  function openReadingChapterEditor() {
    const session = getActiveReadingSession();
    if (!session) return;
    renderReadingChapterCandidates();
    document.getElementById('reading-toc-modal')?.classList.remove('visible');
    document.getElementById('reading-chapter-editor-modal')?.classList.add('visible');
  }

  async function saveReadingChapterEditor() {
    const session = getActiveReadingSession();
    if (!session?.activeBookId) return;
    const checked = Array.from(document.querySelectorAll('#reading-chapter-candidate-list input[data-chapter-line]:checked'))
      .map(input => Number(input.dataset.chapterLine))
      .filter(Number.isInteger)
      .sort((a, b) => a - b);
    await db.readingLibrary.update(session.activeBookId, { manualChapterStarts: checked });
    session.manualChapterStarts = checked;
    document.getElementById('reading-chapter-editor-modal')?.classList.remove('visible');
    renderReadingRoom(state.activeChatId);
    window.showToast?.(checked.length ? '手动章节已保存' : '已恢复自动章节');
  }
  function openReadingToc() {
    const session = getActiveReadingSession();
    if (!session) return;
    readingTocTab = 'chapters';
    renderReadingToc();
    document.getElementById('reading-toc-modal')?.classList.add('visible');
  }
  async function openReadingSettings() {
    const chat = state.chats[state.activeChatId];
    const session = getActiveReadingSession();
    if (!chat) return;
    const settings = chat.readingSettings || {};
    const book = session?.activeBookId ? await db.readingLibrary.get(session.activeBookId) : null;
    const fontSizeInput = document.getElementById('reading-font-size');
    if (fontSizeInput) fontSizeInput.value = Number(settings.fontSize) || Number(chat.settings?.fontSize) || 13;
    const enabled = document.getElementById('reading-summary-enabled');
    if (enabled) enabled.checked = settings.summaryEnabled !== false;
    const prompt = document.getElementById('reading-summary-prompt');
    if (prompt) prompt.value = settings.summaryPrompt || getReadingSummaryPromptDefault();
    const temperature = document.getElementById('reading-summary-temperature');
    if (temperature) temperature.value = settings.summaryTemperature ?? '';
    const maxTokens = document.getElementById('reading-summary-max-tokens');
    if (maxTokens) maxTokens.value = settings.summaryMaxTokens ?? '';
    const guideInput = document.getElementById('reading-settings-guide-input');
    if (guideInput) guideInput.value = book?.annotationGuide || getDefaultReadingGuideTemplate();
    const roleTemperature = document.getElementById('reading-settings-role-temperature');
    if (roleTemperature) roleTemperature.value = book?.annotationTemperature ?? '';
    const roleMaxTokens = document.getElementById('reading-settings-role-max-tokens');
    if (roleMaxTokens) roleMaxTokens.value = book?.annotationMaxTokens ?? '';
    const savedChapterMode = book?.chapterSplitRegex || '';
    const chapterRegex = document.getElementById('reading-chapter-regex');
    if (chapterRegex) chapterRegex.value = (savedChapterMode === '__short_titles__' || savedChapterMode === '__date_titles__') ? '' : savedChapterMode;
    const chapterPreset = document.getElementById('reading-chapter-preset-select');
    if (chapterPreset) chapterPreset.value = savedChapterMode;
    document.getElementById('reading-settings-modal')?.classList.add('visible');
  }

  async function saveReadingSettings() {
    const chat = state.chats[state.activeChatId];
    const session = getActiveReadingSession();
    if (!chat) return;
    const parseOptionalNumber = value => {
      const raw = String(value ?? '').trim();
      if (!raw) return null;
      const number = Number(raw);
      return Number.isFinite(number) ? number : null;
    };
    const chapterPresetValue = String(document.getElementById('reading-chapter-preset-select')?.value || '').trim();
    const chapterRegex = (chapterPresetValue === '__short_titles__' || chapterPresetValue === '__date_titles__')
      ? chapterPresetValue
      : String(document.getElementById('reading-chapter-regex')?.value || '').trim();
    if (chapterRegex && chapterRegex !== '__short_titles__' && chapterRegex !== '__date_titles__') {
      try {
        new RegExp(chapterRegex, 'i');
      } catch (error) {
        await showCustomAlert('章节规则无效', '这个正则表达式无法解析，请检查后再保存。');
        return;
      }
    }
    const readingFontSize = Math.max(10, Math.min(32, parseInt(document.getElementById('reading-font-size')?.value, 10) || 13));
    chat.readingSettings = {
      fontSize: readingFontSize,
      summaryEnabled: document.getElementById('reading-summary-enabled')?.checked !== false,
      summaryPrompt: String(document.getElementById('reading-summary-prompt')?.value || '').trim(),
      summaryTemperature: parseOptionalNumber(document.getElementById('reading-summary-temperature')?.value),
      summaryMaxTokens: parseOptionalNumber(document.getElementById('reading-summary-max-tokens')?.value)
    };
    if (session?.activeBookId) {
      const guideValue = String(document.getElementById('reading-settings-guide-input')?.value || '').trim();
      await db.readingLibrary.update(session.activeBookId, {
        annotationGuide: guideValue || getDefaultReadingGuideTemplate(),
        annotationTemperature: parseOptionalNumber(document.getElementById('reading-settings-role-temperature')?.value),
        annotationMaxTokens: parseOptionalNumber(document.getElementById('reading-settings-role-max-tokens')?.value),
        chapterSplitRegex: chapterRegex
      });
      session.chapterSplitRegex = chapterRegex;
    }
    await db.chats.put(chat);
    document.getElementById('reading-settings-modal')?.classList.remove('visible');
    renderReadingRoom(state.activeChatId);
    window.showToast?.('阅读设置已保存');
  }
  function bindReadingAnnotationUi() {
    const readingWindow = document.getElementById('reading-window');
    const contentEl = document.getElementById('reading-content');
    if (!contentEl || !readingWindow) return;
    if (readingWindow.dataset.readingAnnotationUiBound === '1') return;
    readingWindow.dataset.readingAnnotationUiBound = '1';
    if (!contentEl.dataset.readingAnnotationBound) {
      contentEl.dataset.readingAnnotationBound = '1';
      const capture = () => setTimeout(captureReadingSelection, 30);
      contentEl.addEventListener('mouseup', capture);
      contentEl.addEventListener('touchend', capture);
      document.addEventListener('selectionchange', debounce(() => {
        if (document.getElementById('reading-overlay')?.style.display !== 'none') captureReadingSelection();
      }, 250));
      contentEl.addEventListener('click', event => {
        const mark = event.target.closest('[data-reading-annotation-id]');
        if (!mark) return;
        focusReadingAnnotationCard(mark.dataset.readingAnnotationId);
      });
    }

    const toolbar = document.getElementById('reading-selection-toolbar');
    if (toolbar && !toolbar.dataset.bound) {
      toolbar.dataset.bound = '1';
      toolbar.addEventListener('mousedown', event => {
        if (event.target.closest('button')) event.preventDefault();
      });
      toolbar.querySelectorAll('[data-reading-style]').forEach(button => {
        button.addEventListener('click', () => saveReadingAnnotation(button.dataset.readingStyle));
      });
      document.getElementById('reading-selection-note')?.addEventListener('click', async () => {
        const pendingSelection = readingSelection ? { ...readingSelection } : null;
        const note = await showCustomPrompt('添加批注', '写下你的想法：', '');
        if (note === null || !pendingSelection) return;
        const annotation = await saveReadingAnnotation('note', note, false, pendingSelection);
        if (annotation) openReadingAnnotationPanel();
      });
      document.getElementById('reading-selection-copy')?.addEventListener('click', async () => {
        if (!readingSelection) return;
        await navigator.clipboard?.writeText(readingSelection.quote).catch(() => {});
        window.showToast?.('已复制');
      });
      document.getElementById('reading-selection-ask')?.addEventListener('click', async () => {
        const annotation = await saveReadingAnnotation('highlight');
        if (annotation) await reactToReadingAnnotation(annotation.id);
      });
      document.getElementById('reading-selection-bookmark')?.addEventListener('click', saveReadingBookmark);      document.getElementById('reading-selection-cancel')?.addEventListener('click', () => {
        window.getSelection()?.removeAllRanges();
        hideReadingSelectionToolbar();
      });
    }

    document.getElementById('reading-annotations-btn')?.addEventListener('click', openReadingAnnotationPanel);
    document.getElementById('reading-annotation-panel-close')?.addEventListener('click', () => {
      document.getElementById('reading-annotation-panel')?.classList.remove('visible');
    });
    document.getElementById('reading-book-guide-btn')?.addEventListener('click', openReadingGuideModal);
    document.getElementById('reading-generate-reflection-btn')?.addEventListener('click', generateReadingChapterReflection);
    document.getElementById('reading-toc-tab-chapters')?.addEventListener('click', () => {
      readingTocTab = 'chapters';
      renderReadingToc();
    });
    document.getElementById('reading-toc-tab-bookmarks')?.addEventListener('click', () => {
      readingTocTab = 'bookmarks';
      renderReadingToc();
    });
    document.getElementById('reading-toc-btn')?.addEventListener('click', openReadingToc);
    document.getElementById('close-reading-toc-btn')?.addEventListener('click', () => {
      document.getElementById('reading-toc-modal')?.classList.remove('visible');
    });
    document.getElementById('reading-edit-chapters-btn')?.addEventListener('click', openReadingChapterEditor);
    document.getElementById('close-reading-chapter-editor-btn')?.addEventListener('click', () => {
      document.getElementById('reading-chapter-editor-modal')?.classList.remove('visible');
    });
    document.getElementById('cancel-reading-chapter-editor-btn')?.addEventListener('click', () => {
      document.getElementById('reading-chapter-editor-modal')?.classList.remove('visible');
    });
    document.getElementById('save-reading-chapter-editor-btn')?.addEventListener('click', saveReadingChapterEditor);
    document.getElementById('reading-chapters-use-auto')?.addEventListener('click', () => {
      const session = getActiveReadingSession();
      if (!session) return;
      const saved = session.manualChapterStarts;
      session.manualChapterStarts = [];
      renderReadingChapterCandidates();
      session.manualChapterStarts = saved;
    });
    document.getElementById('reading-chapters-clear')?.addEventListener('click', () => {
      document.querySelectorAll('#reading-chapter-candidate-list input[data-chapter-line]').forEach(input => {
        input.checked = false;
      });
    });
    document.getElementById('reading-settings-btn')?.addEventListener('click', openReadingSettings);    const adjustReadingFontSize = delta => {
      const input = document.getElementById('reading-font-size');
      if (!input) return;
      input.value = Math.max(10, Math.min(32, (parseInt(input.value, 10) || 13) + delta));
    };
    document.getElementById('reading-font-size-minus')?.addEventListener('click', () => adjustReadingFontSize(-1));
    document.getElementById('reading-font-size-plus')?.addEventListener('click', () => adjustReadingFontSize(1));
    document.getElementById('close-reading-settings-btn')?.addEventListener('click', () => {
      document.getElementById('reading-settings-modal')?.classList.remove('visible');
    });
    document.getElementById('cancel-reading-settings-btn')?.addEventListener('click', () => {
      document.getElementById('reading-settings-modal')?.classList.remove('visible');
    });
    document.getElementById('save-reading-settings-btn')?.addEventListener('click', saveReadingSettings);
    document.getElementById('reset-reading-summary-prompt')?.addEventListener('click', () => {
      const input = document.getElementById('reading-summary-prompt');
      if (input) input.value = getReadingSummaryPromptDefault();
    });
    document.getElementById('reset-reading-settings-guide')?.addEventListener('click', () => {
      const input = document.getElementById('reading-settings-guide-input');
      if (input) input.value = getDefaultReadingGuideTemplate();
    });
    document.getElementById('reading-chapter-preset-select')?.addEventListener('change', event => {
      const input = document.getElementById('reading-chapter-regex');
      if (input) input.value = (event.target.value === '__short_titles__' || event.target.value === '__date_titles__') ? '' : (event.target.value || '');
    });
    document.getElementById('close-reading-guide-btn')?.addEventListener('click', () => {
      document.getElementById('reading-guide-modal')?.classList.remove('visible');
    });
    document.getElementById('cancel-reading-guide-btn')?.addEventListener('click', () => {
      document.getElementById('reading-guide-modal')?.classList.remove('visible');
    });
    document.getElementById('save-reading-guide-btn')?.addEventListener('click', saveReadingGuide);
    document.getElementById('close-reading-annotation-edit-btn')?.addEventListener('click', () => {
      document.getElementById('reading-annotation-edit-modal')?.classList.remove('visible');
    });
    document.getElementById('cancel-reading-annotation-edit-btn')?.addEventListener('click', () => {
      document.getElementById('reading-annotation-edit-modal')?.classList.remove('visible');
    });
    document.getElementById('reading-annotation-edit-shrink')?.addEventListener('click', () => adjustReadingAnnotationEdit(-1));
    document.getElementById('reading-annotation-edit-grow')?.addEventListener('click', () => adjustReadingAnnotationEdit(1));
    document.getElementById('save-reading-annotation-edit-btn')?.addEventListener('click', saveReadingAnnotationEdit);

    const listEl = document.getElementById('reading-annotation-list');
    if (listEl && !listEl.dataset.bound) {
      listEl.dataset.bound = '1';
      listEl.addEventListener('click', event => {
        const button = event.target.closest('[data-reading-annotation-action]');
        if (!button) return;
        const id = button.dataset.annotationId;
        if (button.dataset.readingAnnotationAction === 'edit') openReadingAnnotationEdit(id);
        if (button.dataset.readingAnnotationAction === 'react') reactToReadingAnnotation(id);
        if (button.dataset.readingAnnotationAction === 'followup') followUpReadingAnnotation(id);
        if (button.dataset.readingAnnotationAction === 'delete') {
          showCustomConfirm('删除批注', '确定删除这条批注吗？').then(async ok => {
            if (!ok) return;
            await db.readingAnnotations.delete(Number(id) || id);
            readingAnnotationsCache = readingAnnotationsCache.filter(item => String(item.id) !== String(id));
            renderReadingRoom(state.activeChatId);
            openReadingAnnotationPanel();
          });
        }
      });
    }
  }

  // showNextPage 旧版（同步版，无 notifyAiOfPageTurn）已删除
  // 保留下方的 async 版本

  async function showPrevPage() {
    const session = readingState[state.activeChatId];
    if (session && session.currentPage > 0) {
      session.currentPage--;
      renderReadingRoom(state.activeChatId);
      document.getElementById('reading-content').scrollTop = 0;
      await saveReadingProgress(session.activeBookId, session.currentPage);


      await notifyAiOfPageTurn(state.activeChatId, session);
    }
  }


  function closeReadingImportModal() {
    document.getElementById('reading-import-modal')?.classList.remove('visible');
  }

  function openLocalBookPicker() {
    closeReadingImportModal();
    document.getElementById('book-upload-input').click();
  }

  function bindReadingImportModal() {
    const modal = document.getElementById('reading-import-modal');
    if (!modal || modal.dataset.readingImportBound === '1') return;
    modal.dataset.readingImportBound = '1';
    document.getElementById('close-reading-import-btn')?.addEventListener('click', closeReadingImportModal);
    document.getElementById('import-local-book-btn')?.addEventListener('click', openLocalBookPicker);
    document.getElementById('import-url-book-btn')?.addEventListener('click', () => {
      closeReadingImportModal();
      importBookFromUrl();
    });
    modal.addEventListener('click', event => {
      if (event.target === modal) closeReadingImportModal();
    });
  }

  function importBook() {
    const modal = document.getElementById('reading-import-modal');
    if (!modal) {
      openLocalBookPicker();
      return;
    }
    bindReadingImportModal();
    modal.classList.add('visible');
  }

  function htmlToPlainText(html) {
    const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
    doc.querySelectorAll('script,style,noscript,svg,iframe').forEach(el => el.remove());
    doc.querySelectorAll('br,p,div,li,tr,h1,h2,h3,h4,h5,h6,section,article,blockquote')
      .forEach(el => el.append('\n'));
    return String(doc.body?.textContent || '')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function isEpubHeadingElement(element) {
    const tag = String(element?.tagName || '').toLowerCase();
    if (/^h[1-6]$/.test(tag)) return true;
    const type = String(element?.getAttribute?.('epub:type') || '').toLowerCase();
    if (/(?:^|\s)(?:chapter|part)(?:\s|$)/.test(type)) return true;
    const role = String(element?.getAttribute?.('role') || '').toLowerCase();
    if (role === 'doc-chapter') return true;
    const className = String(element?.getAttribute?.('class') || '');
    return /(?:chapter|section|part)[-_ ]?(?:title|heading|name)(?:$|[\s_-])/i.test(className);
  }

  function collectEpubHeadingElements(doc) {
    const candidates = Array.from(doc.body?.querySelectorAll('*') || []).filter(isEpubHeadingElement);
    return candidates.filter(element => !candidates.some(other => other !== element && element.contains(other)));
  }
  function htmlToPlainTextWithHeadings(html) {
    const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
    const text = htmlToPlainText(html);
    const headings = [];
    let cursor = 0;
    collectEpubHeadingElements(doc).forEach(element => {
      const title = String(element.textContent || '').replace(/\s+/g, ' ').trim();
      if (!title || title.length > 120) return;
      const index = text.indexOf(title, cursor);
      if (index < 0) return;
      headings.push({ title, offset: index });
      cursor = index + title.length;
    });
    return { text, headings };
  }

  function getReadingLineIndexForOffset(session, offset) {
    let cursor = 0;
    for (let i = 0; i < session.contentLines.length; i++) {
      const next = cursor + String(session.contentLines[i] || '').length + 1;
      if (offset < next) return i;
      cursor = next;
    }
    return Math.max(0, session.contentLines.length - 1);
  }

  function resolveZipPath(basePath, href) {
    const baseParts = String(basePath || '').split('/');
    baseParts.pop();
    const parts = baseParts.concat(String(href || '').split('/'));
    const resolved = [];
    parts.forEach(part => {
      if (!part || part === '.') return;
      if (part === '..') resolved.pop();
      else resolved.push(part);
    });
    return resolved.join('/');
  }

  async function extractEpubText(arrayBuffer, fileName = '') {
    if (typeof JSZip === 'undefined') {
      throw new Error('EPUB 解析库未加载，请刷新页面后重试。');
    }
    const zip = await JSZip.loadAsync(arrayBuffer);
    const containerFile = zip.file('META-INF/container.xml');
    if (!containerFile) throw new Error('不是有效的 EPUB：缺少 META-INF/container.xml。');

    const containerDoc = new DOMParser().parseFromString(await containerFile.async('string'), 'application/xml');
    const rootfile = Array.from(containerDoc.getElementsByTagName('*'))
      .find(el => String(el.localName || el.nodeName).toLowerCase() === 'rootfile');
    const opfPath = rootfile?.getAttribute('full-path');
    if (!opfPath) throw new Error('无法读取 EPUB 的 OPF 文件路径。');

    const opfFile = zip.file(opfPath) || zip.file(decodeURIComponent(opfPath));
    if (!opfFile) throw new Error('无法读取 EPUB 的 OPF 文件。');
    const opfDoc = new DOMParser().parseFromString(await opfFile.async('string'), 'application/xml');
    const allElements = Array.from(opfDoc.getElementsByTagName('*'));
    const localName = el => String(el.localName || el.nodeName).split(':').pop().toLowerCase();

    const titleEl = allElements.find(el => localName(el) === 'title' && el.textContent.trim());
    const manifest = {};
    allElements.filter(el => localName(el) === 'item').forEach(item => {
      const id = item.getAttribute('id');
      const href = item.getAttribute('href');
      if (id && href) manifest[id] = href;
    });
    const spine = allElements.filter(el => localName(el) === 'itemref')
      .map(item => item.getAttribute('idref'))
      .filter(Boolean);

    const ordered = spine.length ? spine : Object.keys(manifest);
    let text = '';
    const headings = [];
    for (const id of ordered) {
      const href = manifest[id];
      if (!href) continue;
      const path = resolveZipPath(opfPath, href);
      const file = zip.file(path) || zip.file(decodeURIComponent(path));
      if (!file) continue;
      const extracted = htmlToPlainTextWithHeadings(await file.async('string'));
      if (!extracted.text) continue;
      if (text) text += '\n\n';
      const baseOffset = text.length;
      text += extracted.text;
      extracted.headings.forEach(heading => {
        headings.push({ title: heading.title, offset: baseOffset + heading.offset });
      });
    }

    text = text.trim();
    if (!text) throw new Error('EPUB 中没有可提取的文本内容。');
    return {
      text,
      title: cleanImportedBookTitle(titleEl?.textContent || fileName),
      headings
    };
  }

  async function importBookFromUrl() {
    const url = await showCustomPrompt(
      '从网络 URL 导入',
      '请输入返回纯文本的 URL（网页正文请先转换成文本链接）：',
      'https://'
    );
    if (!url || !url.trim()) return;
    const target = url.trim();
    if (!/^https?:\/\//i.test(target)) {
      await showCustomAlert('URL 无效', '请输入以 http:// 或 https:// 开头的地址。');
      return;
    }

    try {
      const response = await fetch(target, { credentials: 'omit' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const contentType = String(response.headers.get('content-type') || '').toLowerCase();
      const raw = await response.text();
      const isHtml = contentType.includes('html') || /^\s*<!doctype html|^\s*<html/i.test(raw);
      const textContent = isHtml ? htmlToPlainText(raw) : raw;
      if (!textContent.trim()) throw new Error('URL 返回的内容为空。');

      let title = '';
      if (isHtml) {
        const doc = new DOMParser().parseFromString(raw, 'text/html');
        title = cleanImportedBookTitle(doc.title || '');
      }
      if (!title) title = inferBookTitleFromText(textContent);
      if (!title) {
        try {
          const pathname = new URL(target).pathname;
          title = cleanImportedBookTitle(decodeURIComponent(pathname.split('/').filter(Boolean).pop() || ''));
        } catch (_) {}
      }
      if (!title) {
        const entered = await showCustomPrompt('填写书名', '未能从 URL 推断书名，请输入：', '网络书籍');
        if (entered === null) return;
        title = cleanImportedBookTitle(entered) || '网络书籍';
      }

      const newBookId = await db.readingLibrary.add({
        title,
        content: textContent,
        sourceUrl: target,
        lastOpened: Date.now()
      });
      await loadBookFromLibrary(newBookId);
      if (document.getElementById('reading-library-modal')?.classList.contains('visible')) {
        renderBookLibrary(document.getElementById('reading-library-search-input')?.value.trim() || '');
      }
    } catch (error) {
      console.error('从 URL 导入书籍失败:', error);
      await showCustomAlert('导入失败', error.message || String(error));
    }
  }

  async function decodeTextFile(arrayBuffer) {
    const uint8array = new Uint8Array(arrayBuffer);


    if (uint8array.length >= 3 && uint8array[0] === 0xEF && uint8array[1] === 0xBB && uint8array[2] === 0xBF) {
      console.log("检测到 UTF-8 BOM，使用 UTF-8 解码。");
      return new TextDecoder('utf-8').decode(uint8array);
    }
    if (uint8array.length >= 2 && uint8array[0] === 0xFF && uint8array[1] === 0xFE) {
      console.log("检测到 UTF-16 LE BOM，使用 UTF-16 LE 解码。");
      return new TextDecoder('utf-16le').decode(uint8array);
    }
    if (uint8array.length >= 2 && uint8array[0] === 0xFE && uint8array[1] === 0xFF) {
      console.log("检测到 UTF-16 BE BOM，使用 UTF-16 BE 解码。");
      return new TextDecoder('utf-16be').decode(uint8array);
    }


    try {
      console.log("未检测到BOM，尝试使用 UTF-8 解码...");

      const decoded = new TextDecoder('utf-8', {
        fatal: true
      }).decode(uint8array);
      console.log("UTF-8 解码成功。");
      return decoded;
    } catch (e) {
      console.log("UTF-8 解码失败，将尝试 GBK (ANSI) 解码...");

      try {
        const decoded = new TextDecoder('gbk').decode(uint8array);
        console.log("GBK 解码成功。");
        return decoded;
      } catch (err) {
        console.error("所有解码尝试均失败:", err);

        throw new Error("无法识别的文件编码。请尝试将文件转换为 UTF-8 格式后重新导入。");
      }
    }
  }

  function cleanImportedBookTitle(value) {
    return String(value || '')
      .replace(/^\uFEFF/, '')
      .replace(/\.(?:txt|epub)$/i, '')
      .replace(/[\u0000-\u001F\u007F]/g, '')
      .trim();
  }

  function isTemporaryBookFilename(title) {
    const normalized = cleanImportedBookTitle(title)
      .replace(/^[{(]|[})]$/g, '')
      .replace(/\s*\(\d+\)$/, '');

    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(normalized)
      || /^[0-9a-f]{32}$/i.test(normalized);
  }

  function inferBookTitleFromText(textContent) {
    const lines = String(textContent || '')
      .replace(/^\uFEFF/, '')
      .split(/\r\n?|\n/)
      .slice(0, 20)
      .map(line => line.trim())
      .filter(Boolean);

    for (const line of lines) {
      const labeledTitle = line.match(/^(?:【\s*)?(?:书名|小说名|作品名|标题)(?:\s*】)?\s*[：:]\s*(.+)$/i);
      if (labeledTitle) return cleanImportedBookTitle(labeledTitle[1]).replace(/^《|》$/g, '').trim();

      const bracketedTitle = line.match(/^《([^》]{1,80})》(?:\s|$)/);
      if (bracketedTitle) return cleanImportedBookTitle(bracketedTitle[1]);
    }

    const firstLine = lines[0] || '';
    const looksLikeMetadata = /^(?:作者|简介|内容简介|文案|版权|来源|网址|URL)\s*[：:]/i.test(firstLine);
    const looksLikeChapter = /^(?:第\s*[0-9一二三四五六七八九十百千万零〇两]+\s*[章节卷回部篇]|chapter\s+\d+)/i.test(firstLine);
    const looksLikeSeparator = /^[-_=*#·]{3,}$/.test(firstLine);
    const looksLikeUrl = /^(?:https?:\/\/|www\.)/i.test(firstLine);

    if (firstLine.length <= 80 && !looksLikeMetadata && !looksLikeChapter && !looksLikeSeparator && !looksLikeUrl) {
      return cleanImportedBookTitle(firstLine).replace(/^《|》$/g, '').trim();
    }

    return '';
  }

  async function resolveImportedBookTitle(fileName, textContent) {
    const fileTitle = cleanImportedBookTitle(fileName);
    if (fileTitle && !isTemporaryBookFilename(fileTitle)) return fileTitle;

    const inferredTitle = inferBookTitleFromText(textContent);
    if (inferredTitle) return inferredTitle;

    const enteredTitle = await showCustomPrompt(
      '填写书名',
      '文件选择器没有提供原始书名，请输入这本书的名称。',
      ''
    );
    if (enteredTitle === null) return null;

    const cleanedTitle = cleanImportedBookTitle(enteredTitle);
    if (!cleanedTitle) {
      await showCustomAlert('无法导入', '书名不能为空。');
      return null;
    }
    return cleanedTitle;
  }

  async function handleBookFileUpload(event) {
    const file = event.target.files[0];
    if (!file) return;

    try {

      const arrayBuffer = await file.arrayBuffer();
      const isEpub = /\.epub$/i.test(file.name);
      const epub = isEpub ? await extractEpubText(arrayBuffer, file.name) : null;
      const textContent = epub ? epub.text : await decodeTextFile(arrayBuffer);

      const title = (epub && epub.title) || await resolveImportedBookTitle(file.name, textContent);
      if (!title) return;

      const newBookId = await db.readingLibrary.add({
        title: title,
        content: textContent,
        sourceType: isEpub ? 'epub' : 'txt',
        epubHeadings: epub ? epub.headings : [],
        lastOpened: Date.now()
      });

      await loadBookFromLibrary(newBookId);
      if (document.getElementById('reading-library-modal').classList.contains('visible')) {
        renderBookLibrary();
      }
    } catch (error) {

      console.error("导入书籍失败:", error);
      await showCustomAlert("导入失败", error.message);
    } finally {
      event.target.value = null;
    }
  }
  async function handlePageJump() {
    const chatId = state.activeChatId;
    if (!chatId) return;
    const session = readingState[chatId];
    if (!session || session.totalPages <= 1) return;

    const targetPageStr = await showCustomPrompt(
      '章节跳转',
      `请输入想跳转的章节 (1 - ${session.totalPages})`,
      session.currentPage + 1
    );

    if (targetPageStr === null) return;

    const targetPage = parseInt(targetPageStr);

    if (isNaN(targetPage) || targetPage < 1 || targetPage > session.totalPages) {
      alert("请输入一个有效的页码！");
      return;
    }

    session.currentPage = targetPage - 1;
    renderReadingRoom(chatId);

    saveReadingProgress(session.activeBookId, session.currentPage);
  }


  async function saveReadingProgress(bookId, pageNumber) {
    if (!bookId) return;
    try {

      await db.readingLibrary.update(bookId, {
        currentPage: pageNumber
      });
    } catch (error) {
      console.error(`保存书籍(ID: ${bookId})的阅读进度失败:`, error);
    }
  }

  async function showNextPage() {
    const session = readingState[state.activeChatId];
    if (session && session.currentPage < session.totalPages - 1) {
      session.currentPage++;
      renderReadingRoom(state.activeChatId);
      document.getElementById('reading-content').scrollTop = 0;
      await saveReadingProgress(session.activeBookId, session.currentPage);


      await notifyAiOfPageTurn(state.activeChatId, session);
    }
  }





  async function openBookLibrary() {

    const searchInput = document.getElementById('reading-library-search-input');
    searchInput.value = '';
    if (!searchInput.dataset.readingSearchBound) {
      searchInput.dataset.readingSearchBound = '1';
      searchInput.addEventListener('input', debounce(() => {
        renderBookLibrary(searchInput.value.trim());
      }, 200));
    }

    await renderBookLibrary();
    document.getElementById('reading-library-modal').classList.add('visible');
  }


  async function renderBookLibrary(searchTerm = '') {
    const listEl = document.getElementById('reading-library-list');
    let books = await db.readingLibrary.orderBy('lastOpened').reverse().toArray();
    listEl.innerHTML = '';


    if (searchTerm) {
      const needle = searchTerm.toLowerCase();
      books = books.filter(book =>
        String(book.title || '').toLowerCase().includes(needle) ||
        String(book.content || '').toLowerCase().includes(needle)
      );
    }


    if (books.length === 0) {
      const message = searchTerm ?
        '找不到匹配的书籍' :
        '书库是空的，点击"导入新书"添加第一本吧！';
      listEl.innerHTML = `<p style="text-align:center; color: var(--text-secondary); padding: 50px 0;">${message}</p>`;
      return;
    }

    books.forEach(book => {
      const item = document.createElement('div');
      item.className = 'existing-group-item';
      item.innerHTML = `
            <span class="group-name" style="cursor:pointer;" data-book-id="${book.id}">${book.title}</span>
            <button class="delete-group-btn" data-book-id="${book.id}" title="删除书籍">×</button>
        `;
      listEl.appendChild(item);
    });
  }


  // 找到 loadBookFromLibrary 函数，替换整个函数
  async function loadBookFromLibrary(bookId) {
    const chatId = state.activeChatId;
    if (!chatId) return;

    let book = await db.readingLibrary.get(bookId);
    if (!book) {
      alert('找不到这本书！');
      return;
    }

    // --- 【核心新增逻辑：同步绿江内容】 ---
    if (book.linkedStoryId) {
      try {
        const grStory = await db.grStories.get(book.linkedStoryId);
        if (grStory) {
          console.log(`[同步] 正在从绿江同步《${grStory.title}》的最新章节...`);

          // 拼接所有章节内容
          // 格式：
          // 第1章 标题
          // 正文...
          let fullContent = "";
          grStory.chapters.forEach((ch, idx) => {
            const title = ch.title || `第 ${idx + 1} 章`;
            fullContent += `\n\n========== ${title} ==========\n\n`;
            fullContent += ch.content;
          });

          // 更新内存里的临时对象
          book.title = grStory.title; // 同步标题
          book.content = fullContent; // 同步内容

          // 同时更新数据库，保持缓存最新
          await db.readingLibrary.update(bookId, {
            title: grStory.title,
            content: fullContent,
            lastOpened: Date.now()
          });
        } else {
          console.warn("关联的绿江作品已被删除，保留最后一次缓存的内容。");
        }
      } catch (e) {
        console.error("同步绿江内容失败:", e);
      }
    } else {
      // 普通书籍只更新时间
      await db.readingLibrary.update(bookId, {
        lastOpened: Date.now()
      });
    }
    // -------------------------------------

    const session = readingState[chatId];
    session.activeBookId = bookId;
    session.title = book.title;
    // 处理内容换行
    session.contentLines = (book.content || "").split(/\r\n?|\n/).map(line => line.replace(/ +/g, ' '));
    session.chapterSplitRegex = book.chapterSplitRegex || '';
    session.bookmarks = Array.isArray(book.bookmarks) ? book.bookmarks.slice() : [];
    session.manualChapterStarts = Array.isArray(book.manualChapterStarts) ? book.manualChapterStarts.slice() : [];
    session.epubHeadings = Array.isArray(book.epubHeadings) ? book.epubHeadings.slice() : [];
    session.totalPages = Math.max(1, getReadingChapters(session).length);

    // 如果总页数为0，至少设为1
    if (session.totalPages === 0) session.totalPages = 1;

    session.currentPage = book.currentPage || 0;
    await loadReadingAnnotations(bookId);

    // 防止页码越界（比如同步后内容变短了，虽然一般是变长）
    if (session.currentPage >= session.totalPages) {
      session.currentPage = session.totalPages - 1;
    }
    if (session.currentPage < 0) session.currentPage = 0;

    renderReadingRoom(chatId);

    document.getElementById('reading-content').scrollTop = 0;
    document.getElementById('reading-library-modal').classList.remove('visible');
  }

  async function addGreenRiverToShelf(storyId, btnElement) {
    try {
      const story = await db.grStories.get(storyId);
      if (!story) return;

      // 防止重复添加
      const existing = await db.readingLibrary.where('linkedStoryId').equals(storyId).first();
      if (existing) {
        alert("该书籍已在书架中。");
        return;
      }

      let fullContent = "";
      story.chapters.forEach((ch, idx) => {
        const title = ch.title || `第 ${idx + 1} 章`;
        fullContent += `\n\n========== ${title} ==========\n\n`;
        fullContent += ch.content;
      });

      if (!fullContent) fullContent = "(暂无内容，请作者赶快更新...)";

      await db.readingLibrary.add({
        title: story.title,
        content: fullContent,
        lastOpened: Date.now(),
        currentPage: 0,
        linkedStoryId: story.id
      });

      // 【核心修改】更新按钮UI为"已添加"状态，并绑定移除事件
      if (btnElement) {
        btnElement.textContent = "✓ 已在书架";
        btnElement.classList.add('added');
        // 重新绑定 onclick 为移除函数
        btnElement.onclick = (e) => {
          e.stopPropagation();
          removeGreenRiverFromShelf(storyId, btnElement);
        };
      }

      await showCustomAlert("收藏成功", `《${story.title}》已加入书架，并开启同步更新。`);

    } catch (e) {
      console.error("加入书架失败:", e);
      alert("加入失败: " + e.message);
    }
  }

  // 记得把这个函数暴露给全局，否则 HTML onclick 找不到
  window.addGreenRiverToShelf = addGreenRiverToShelf;
  // 【新增】从"一起读"书架中移除绿江作品
  async function removeGreenRiverFromShelf(storyId, btnElement) {
    try {
      // 查找对应的书架记录
      const bookRecord = await db.readingLibrary.where('linkedStoryId').equals(storyId).first();

      if (!bookRecord) {
        // 数据库里可能已经被删了，直接更新UI
        if (btnElement) resetBtnToAddState(storyId, btnElement);
        return;
      }

      const confirmed = await showCustomConfirm(
        "移出书架",
        `确定要将《${bookRecord.title}》从"一起读"书架中移除吗？\n(绿江APP中的原稿不会被删除)`,
        { confirmButtonClass: 'btn-danger', confirmText: '移出' }
      );

      if (confirmed) {
        // 删除书架记录
        await db.readingLibrary.delete(bookRecord.id);

        // 更新 UI 为"未添加"状态
        if (btnElement) {
          resetBtnToAddState(storyId, btnElement);
        }

        await showCustomAlert("已移除", "书籍已从书架移出。");
      }
    } catch (e) {
      console.error("移除失败:", e);
    }
  }

  // 辅助函数：重置按钮为"加入"状态
  function resetBtnToAddState(storyId, btn) {
    btn.textContent = "+ 加入共读";
    btn.classList.remove('added');
    btn.onclick = (e) => {
      e.stopPropagation();
      addGreenRiverToShelf(storyId, btn);
    };
  }

  // 暴露给全局
  window.removeGreenRiverFromShelf = removeGreenRiverFromShelf;
  async function deleteBookFromLibrary(bookId) {
    const book = await db.readingLibrary.get(bookId);
    if (!book) return;

    const confirmed = await showCustomConfirm('删除书籍', `确定要删除《${book.title}》吗？`, {
      confirmButtonClass: 'btn-danger'
    });
    if (confirmed) {
      await db.readingLibrary.delete(bookId);
      await renderBookLibrary();
    }
  }

  function processImportedText(title, textContent) {
    const chatId = state.activeChatId;
    if (!chatId) return;

    const session = readingState[chatId];
    session.title = title.replace(/\.txt$/i, '');
    session.contentLines = textContent.split(/\r\n?|\n/);
    session.chapterSplitRegex = session.chapterSplitRegex || '';
    session.totalPages = Math.max(1, getReadingChapters(session).length);
    session.currentPage = 0;

    renderReadingRoom(chatId);
  }



  function makeDraggable(windowEl, headerEl) {
    let pos1 = 0,
      pos2 = 0,
      pos3 = 0,
      pos4 = 0;
    let isDragging = false;
    let hasMoved = false;
    const phoneScreen = document.getElementById('phone-screen');

    const startDrag = (e) => {

      if (windowEl !== headerEl && e.target.closest('button')) {
        return;
      }

      isDragging = true;
      hasMoved = false;

      const event = e.type === 'touchstart' ? e.touches[0] : e;
      pos3 = event.clientX;
      pos4 = event.clientY;


      windowEl.style.top = `${windowEl.offsetTop}px`;
      windowEl.style.left = `${windowEl.offsetLeft}px`;
      windowEl.style.transform = '';

      document.addEventListener('mouseup', endDrag);
      document.addEventListener('mousemove', elementDrag);
      document.addEventListener('touchend', endDrag);

      document.addEventListener('touchmove', elementDrag, {
        passive: false
      });
    };

    const elementDrag = (e) => {
      if (!isDragging) return;

      const event = e.type === 'touchmove' ? e.touches[0] : e;
      const diffX = event.clientX - pos3;
      const diffY = event.clientY - pos4;


      if (!hasMoved && (Math.abs(diffX) > 5 || Math.abs(diffY) > 5)) {
        hasMoved = true;
      }


      if (hasMoved && e.cancelable) {
        e.preventDefault();
      }

      pos1 = pos3 - event.clientX;
      pos2 = pos4 - event.clientY;
      pos3 = event.clientX;
      pos4 = event.clientY;

      let newTop = windowEl.offsetTop - pos2;
      let newLeft = windowEl.offsetLeft - pos1;

      const maxTop = phoneScreen.clientHeight - windowEl.offsetHeight - 10;
      const maxLeft = phoneScreen.clientWidth - windowEl.offsetWidth - 10;
      newTop = Math.max(10, Math.min(newTop, maxTop));
      newLeft = Math.max(10, Math.min(newLeft, maxLeft));

      windowEl.style.top = newTop + "px";
      windowEl.style.left = newLeft + "px";
    };

    const endDrag = () => {
      document.removeEventListener('mouseup', endDrag);
      document.removeEventListener('mousemove', elementDrag);
      document.removeEventListener('touchend', endDrag);
      document.removeEventListener('touchmove', elementDrag);

      if (!isDragging) return;
      isDragging = false;

      // 保存观影对话框的位置
      if (windowEl.id === 'watch-together-chat-float' && watchTogetherState.isActive && watchTogetherState.chatId) {
        const chat = state.chats[watchTogetherState.chatId];
        if (chat) {
          if (!chat.watchTogetherSettings) {
            chat.watchTogetherSettings = {};
          }
          chat.watchTogetherSettings.position = {
            top: windowEl.style.top,
            left: windowEl.style.left
          };
          saveChatsToIndexedDB();
        }
      }

      if (!hasMoved) {

        windowEl.click();
      }
    };

    headerEl.addEventListener('mousedown', startDrag);

    headerEl.addEventListener('touchstart', startDrag, {
      passive: false
    });
  }



  function minimizeReadingRoom() {
    const session = readingState[state.activeChatId];
    if (!session || !session.isActive) return;

    document.getElementById('reading-window').classList.add('minimized');
    document.getElementById('reading-restore-btn').style.display = 'flex';
    session.isMinimized = true;
  }


  function restoreReadingRoom() {
    const session = readingState[state.activeChatId];
    if (!session || !session.isActive) return;

    document.getElementById('reading-restore-btn').style.display = 'none';
    document.getElementById('reading-window').classList.remove('minimized');
    session.isMinimized = false;
  }





  function debounce(func, delay) {
    let timeout;
    return function (...args) {
      const context = this;
      clearTimeout(timeout);
      timeout = setTimeout(() => func.apply(context, args), delay);
    };
  }



  function formatReadingStateForAI(chatId) {
    const session = readingState[chatId];


    if (!session || !session.isActive) {
      return "";
    }

    const title = session.title || '未知书籍';
    let contentForAI = '';
    let contextLabel = '';


    if (session.currentSnippet && session.currentSnippet.trim()) {
      contentForAI = session.currentSnippet;
      contextLabel = '你正在阅读的段落';
    } else if (session.contentLines.length > 0) {
      const chapter = getCurrentReadingChapter(session);
      contentForAI = session.contentLines.slice(chapter.startLine, chapter.endLine).join('\n').substring(0, 500);
      contextLabel = `当前章节：${chapter.title}`;
    } else {
      contentForAI = '(无内容)';
      contextLabel = '内容';
    }
    return `
    - **书名**: 《${title}》
    - **${contextLabel}**: "${contentForAI}..."
    #一起读书模式 | 行为铁律
    1.  **角色定位**: 你【不是】书中的任何角色，你是【你自己】(${state.chats[chatId]?.originalName || 'AI角色'})，正在和用户一起【阅读和讨论】这本书。
    2.  **行为准则**: 你的回复【必须】是作为读者的【感想、评论、提问或联想】。你可以：
        -   分享你对当前段落的看法。
        -   对书中的角色或情节发表评论。
        -   向用户提问，询问TA对内容的看法。
        -   根据书本内容，联想到你自己的经历或记忆。
    3.  **严禁**: 你的回复【绝对禁止】使用书中角色的口吻和人称！【绝对禁止】扮演书中的任何角色！【绝对禁止】续写或模仿书中的情节！你必须时刻记住，你只是一个读者。    
`;
  }



  function updateReadingContextOnScroll() {
    const chatId = state.activeChatId;
    if (!chatId || !readingState[chatId]) return;

    const session = readingState[chatId];
    const container = document.getElementById('reading-content');

    if (!container) return;


    const chapter = getCurrentReadingChapter(session);
    if (!chapter) return;
    const chapterText = session.contentLines.slice(chapter.startLine, chapter.endLine).join('\n');
    const maxScroll = Math.max(1, container.scrollHeight - container.clientHeight);
    const ratio = Math.max(0, Math.min(1, container.scrollTop / maxScroll));
    const start = Math.floor(chapterText.length * ratio);
    session.currentSnippet = chapterText.slice(start, start + 600);
  }

  // ========== 全局暴露 ==========

  window.readingState = readingState;
  window.openReadingRoom = openReadingRoom;
  window.initReadingSession = initReadingSession;
  window.closeReadingRoom = closeReadingRoom;
  window.renderReadingRoom = renderReadingRoom;
  window.showNextPage = showNextPage;
  window.showPrevPage = showPrevPage;
  window.importBook = importBook;
  window.decodeTextFile = decodeTextFile;
  window.handleBookFileUpload = handleBookFileUpload;
  window.handlePageJump = handlePageJump;
  window.saveReadingProgress = saveReadingProgress;
  window.openBookLibrary = openBookLibrary;
  window.renderBookLibrary = renderBookLibrary;
  window.loadBookFromLibrary = loadBookFromLibrary;
  window.addGreenRiverToShelf = addGreenRiverToShelf;
  window.removeGreenRiverFromShelf = removeGreenRiverFromShelf;
  window.resetBtnToAddState = resetBtnToAddState;
  window.deleteBookFromLibrary = deleteBookFromLibrary;
  window.processImportedText = processImportedText;
  window.makeDraggable = makeDraggable;
  window.minimizeReadingRoom = minimizeReadingRoom;
  window.restoreReadingRoom = restoreReadingRoom;
  window.debounce = debounce;
  window.formatReadingStateForAI = formatReadingStateForAI;
  window.updateReadingContextOnScroll = updateReadingContextOnScroll;

  // ========== 从 script.js 迁移：toggleReadingFullscreen ==========
  function toggleReadingFullscreen() {
    const readingWindow = document.getElementById('reading-window');
    const readingOverlay = document.getElementById('reading-overlay');

    if (readingWindow && readingOverlay) {
      readingWindow.classList.toggle('fullscreen');
      readingOverlay.classList.toggle('fullscreen-active');
    }
  }
  window.toggleReadingFullscreen = toggleReadingFullscreen;

})();
