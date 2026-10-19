  const chapterDeleteState = {
    isDeleteMode: false,
    selectedChapters: new Set()
  };

  function openChapterList() {
    const sidebar = document.getElementById('gr-chapter-sidebar');
    const overlay = document.getElementById('gr-sidebar-overlay');
    const listContainer = document.getElementById('gr-chapter-list-content');
    const countEl = document.getElementById('gr-total-chapters');

    if (!grState.activeStoryId) return;

    db.grStories.get(grState.activeStoryId).then(story => {
      if (!story) return;
      if (window.GreenRiverStoryEngine) window.GreenRiverStoryEngine.normalizeStory(story);
      // 重置删除模式
      chapterDeleteState.isDeleteMode = false;
      chapterDeleteState.selectedChapters.clear();
      
      renderChapterList(story, listContainer, countEl);

      sidebar.classList.add('visible');
      overlay.classList.add('visible');
    });
  }

  function renderChapterList(story, listContainer, countEl) {
    const escapeHtml = window.GreenRiverStoryEngine?.escapeHtml || (value => String(value));
    listContainer.innerHTML = '';
    countEl.textContent = `共 ${story.chapters.length} 章`;

    // 如果是删除模式，显示控制栏
    if (chapterDeleteState.isDeleteMode) {
      const controlBar = document.createElement('div');
      controlBar.style.cssText = 'padding: 10px; background: #f5f5f5; border-bottom: 1px solid #ddd; display: flex; justify-content: space-between; align-items: center; gap: 10px;';
      
      const leftButtons = document.createElement('div');
      leftButtons.style.cssText = 'display: flex; gap: 8px; align-items: center;';
      
      // 全选按钮
      const selectAllBtn = document.createElement('button');
      selectAllBtn.textContent = '全选';
      selectAllBtn.style.cssText = 'padding: 5px 12px; background: #fff; border: 1px solid #ddd; border-radius: 4px; cursor: pointer; font-size: 13px;';
      selectAllBtn.onclick = () => {
        story.chapters.forEach((_, idx) => chapterDeleteState.selectedChapters.add(idx));
        renderChapterList(story, listContainer, countEl);
      };
      
      // 取消全选按钮
      const deselectAllBtn = document.createElement('button');
      deselectAllBtn.textContent = '取消全选';
      deselectAllBtn.style.cssText = 'padding: 5px 12px; background: #fff; border: 1px solid #ddd; border-radius: 4px; cursor: pointer; font-size: 13px;';
      deselectAllBtn.onclick = () => {
        chapterDeleteState.selectedChapters.clear();
        renderChapterList(story, listContainer, countEl);
      };
      
      // 选中计数
      const countSpan = document.createElement('span');
      countSpan.style.cssText = 'font-size: 13px; color: #666;';
      countSpan.textContent = `已选 ${chapterDeleteState.selectedChapters.size} 章`;
      
      leftButtons.appendChild(selectAllBtn);
      leftButtons.appendChild(deselectAllBtn);
      leftButtons.appendChild(countSpan);
      
      const rightButtons = document.createElement('div');
      rightButtons.style.cssText = 'display: flex; gap: 8px;';
      
      // 确认删除按钮
      const deleteBtn = document.createElement('button');
      deleteBtn.textContent = `删除 (${chapterDeleteState.selectedChapters.size})`;
      deleteBtn.style.cssText = 'padding: 5px 15px; background: #ff4444; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 13px;';
      deleteBtn.disabled = chapterDeleteState.selectedChapters.size === 0;
      if (deleteBtn.disabled) {
        deleteBtn.style.background = '#ccc';
        deleteBtn.style.cursor = 'not-allowed';
      }
      deleteBtn.onclick = async () => {
        if (chapterDeleteState.selectedChapters.size === 0) return;
        
        const confirmed = await showCustomConfirm(
          '确认删除',
          `确定要删除选中的 ${chapterDeleteState.selectedChapters.size} 个章节吗？\n此操作不可撤销！`,
          { confirmText: '删除', confirmButtonClass: 'btn-danger' }
        );
        
        if (confirmed) {
          await deleteSelectedChapters();
        }
      };
      
      // 取消按钮
      const cancelBtn = document.createElement('button');
      cancelBtn.textContent = '取消';
      cancelBtn.style.cssText = 'padding: 5px 15px; background: #fff; color: #666; border: 1px solid #ddd; border-radius: 4px; cursor: pointer; font-size: 13px;';
      cancelBtn.onclick = () => {
        chapterDeleteState.isDeleteMode = false;
        chapterDeleteState.selectedChapters.clear();
        renderChapterList(story, listContainer, countEl);
      };
      
      rightButtons.appendChild(deleteBtn);
      rightButtons.appendChild(cancelBtn);
      
      controlBar.appendChild(leftButtons);
      controlBar.appendChild(rightButtons);
      listContainer.appendChild(controlBar);
    } else {
      // 非删除模式，显示删除按钮
      const toolBar = document.createElement('div');
      toolBar.style.cssText = 'padding: 10px; background: #f9f9f9; border-bottom: 1px solid #ddd; display: flex; justify-content: flex-end;';
      
      const deleteBtn = document.createElement('button');
      deleteBtn.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align: middle; margin-right: 4px;">
          <polyline points="3 6 5 6 21 6"></polyline>
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
        </svg>
        删除章节
      `;
      deleteBtn.style.cssText = 'padding: 6px 12px; background: #fff; color: #666; border: 1px solid #ddd; border-radius: 4px; cursor: pointer; font-size: 13px; display: flex; align-items: center;';
      deleteBtn.onclick = () => {
        chapterDeleteState.isDeleteMode = true;
        renderChapterList(story, listContainer, countEl);
      };
      
      if (Array.isArray(story.deletedChapters) && story.deletedChapters.length) {
        const restoreBtn = document.createElement('button');
        restoreBtn.textContent = '恢复最近删除';
        restoreBtn.style.cssText = 'padding: 6px 12px; background: #fff; color: var(--gr-primary); border: 1px solid var(--gr-primary); border-radius: 4px; cursor: pointer; font-size: 13px; margin-right:8px;';
        restoreBtn.onclick = async () => {
          const latest = await db.grStories.get(story.id);
          const record = latest?.deletedChapters?.[latest.deletedChapters.length - 1];
          if (!record) return;
          const confirmed = await showCustomConfirm('恢复章节', `恢复《${record.chapter.title || '无题'}》到原来的章节位置？`, { confirmText: '恢复' });
          if (!confirmed) return;
          latest.deletedChapters.pop();
          latest.chapters.splice(Math.min(record.originalIndex, latest.chapters.length), 0, record.chapter);
          latest.chapters.forEach((chapter, index) => { chapter.prevSummary = index > 0 ? latest.chapters[index - 1].summary || '' : '这是故事的开始。'; });
          if (window.GreenRiverStoryEngine) window.GreenRiverStoryEngine.refreshGlobalSummary(latest);
          latest.lastUpdated = Date.now();
          await db.grStories.put(latest);
          renderChapterList(latest, listContainer, countEl);
          openReader(latest.id, Math.min(record.originalIndex, latest.chapters.length - 1));
        };
        toolBar.appendChild(restoreBtn);
      }
      toolBar.appendChild(deleteBtn);
      listContainer.appendChild(toolBar);
    }

    // 渲染章节列表
    story.chapters.forEach((ch, index) => {
      const div = document.createElement('div');
      div.className = 'gr-sidebar-item';
      if (index === grState.currentChapterIndex && !chapterDeleteState.isDeleteMode) {
        div.classList.add('active');
      }

      if (chapterDeleteState.isDeleteMode) {
        const isSelected = chapterDeleteState.selectedChapters.has(index);
        
        div.style.cssText = 'display: flex; align-items: center; padding: 12px; cursor: pointer; user-select: none;';
        if (isSelected) {
          div.style.background = '#e3f2fd';
        }
        
        // 复选框
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = isSelected;
        checkbox.style.cssText = 'width: 18px; height: 18px; margin-right: 12px; cursor: pointer;';
        checkbox.onclick = (e) => {
          e.stopPropagation();
        };
        
        div.onclick = () => {
          if (chapterDeleteState.selectedChapters.has(index)) {
            chapterDeleteState.selectedChapters.delete(index);
          } else {
            chapterDeleteState.selectedChapters.add(index);
          }
          renderChapterList(story, listContainer, countEl);
        };
        
        const content = document.createElement('div');
        content.style.cssText = 'flex: 1;';
        content.innerHTML = `
          <div style="display:flex; justify-content:space-between;">
            <span>${index + 1}. ${escapeHtml(ch.title || '无题')}</span>
            <span style="font-size:12px; color:#999;">${new Date(ch.timestamp).toLocaleTimeString()}</span>
          </div>
          <div style="font-size:12px; color:#999; margin-top:4px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml((ch.summary || '').substring(0, 30))}...</div>
        `;
        
        div.appendChild(checkbox);
        div.appendChild(content);
      } else {
        div.innerHTML = `
          <div class="gr-sidebar-chapter-row" style="display:flex; justify-content:space-between;gap:8px;">
            <span>${index + 1}. ${escapeHtml(ch.title || '无题')}</span>
            <span style="font-size:12px; color:#999;white-space:nowrap;">${new Date(ch.timestamp).toLocaleTimeString()}</span>
          </div>
          <div style="font-size:12px; color:#999; margin-left:10px; margin-top:4px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml((ch.summary || '').substring(0, 20))}...</div>
        `;

        const actions = document.createElement('div');
        actions.className = 'gr-chapter-order-actions';
        [['↑', -1, '上移章节'], ['↓', 1, '下移章节']].forEach(([label, offset, title]) => {
          const button = document.createElement('button');
          button.textContent = label;
          button.title = title;
          button.disabled = index + offset < 0 || index + offset >= story.chapters.length;
          button.onclick = async event => {
            event.stopPropagation();
            if (button.disabled) return;
            const targetIndex = index + offset;
            [story.chapters[index], story.chapters[targetIndex]] = [story.chapters[targetIndex], story.chapters[index]];
            story.chapters.forEach((chapter, chapterPosition) => { chapter.prevSummary = chapterPosition > 0 ? story.chapters[chapterPosition - 1].summary || '' : '这是故事的开始。'; });
            if (story.storyBible?.timeline) {
              const order = new Map(story.chapters.map((chapter, chapterPosition) => [chapter.id, chapterPosition]));
              story.storyBible.timeline.sort((a, b) => (order.get(a.chapterId) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.chapterId) ?? Number.MAX_SAFE_INTEGER));
            }
            if (window.GreenRiverStoryEngine) window.GreenRiverStoryEngine.refreshGlobalSummary(story);
            story.lastUpdated = Date.now();
            await db.grStories.put(story);
            grState.currentChapterIndex = targetIndex;
            renderChapterList(story, listContainer, countEl);
            await openReader(story.id, targetIndex);
          };
          actions.appendChild(button);
        });
        div.querySelector('.gr-sidebar-chapter-row').appendChild(actions);

        div.onclick = () => {
          openReader(story.id, index);
          closeChapterList();
        };
      }
      
      listContainer.appendChild(div);
    });
  }

  async function deleteSelectedChapters() {
    if (!grState.activeStoryId) return;
    
    const story = await db.grStories.get(grState.activeStoryId);
    if (!story) return;
    if (window.GreenRiverStoryEngine) window.GreenRiverStoryEngine.normalizeStory(story);
    
    // 将选中的索引转为数组并排序（从大到小，避免删除时索引变化）
    const indicesToDelete = Array.from(chapterDeleteState.selectedChapters).sort((a, b) => b - a);
    
    console.log('[章节删除] 准备删除章节:', indicesToDelete);
    
    story.deletedChapters = Array.isArray(story.deletedChapters) ? story.deletedChapters : [];
    const deletedChapterIds = new Set();
    // 删除章节前保存可恢复副本
    indicesToDelete.forEach(index => {
      const chapter = story.chapters[index];
      if (!chapter) return;
      deletedChapterIds.add(chapter.id);
      story.deletedChapters.push({ chapter: window.GreenRiverStoryEngine ? window.GreenRiverStoryEngine.clone(chapter) : JSON.parse(JSON.stringify(chapter)), originalIndex: index, deletedAt: Date.now() });
      story.chapters.splice(index, 1);
    });
    if (story.deletedChapters.length > 20) story.deletedChapters.splice(0, story.deletedChapters.length - 20);
    story.chapters.forEach((chapter, index) => { chapter.prevSummary = index > 0 ? story.chapters[index - 1].summary || '' : '这是故事的开始。'; });
    if (story.storyBible) {
      story.storyBible.timeline = (story.storyBible.timeline || []).filter(item => !deletedChapterIds.has(item.chapterId));
      story.storyBible.openThreads = (story.storyBible.openThreads || []).filter(item => !deletedChapterIds.has(item.chapterId));
    }
    if (window.GreenRiverStoryEngine) window.GreenRiverStoryEngine.refreshGlobalSummary(story);
    
    story.lastUpdated = Date.now();
    await db.grStories.put(story);
    
    console.log(`[章节删除] 成功删除 ${indicesToDelete.length} 个章节`);
    
    // 重置状态
    chapterDeleteState.isDeleteMode = false;
    chapterDeleteState.selectedChapters.clear();
    
    // 重新渲染列表
    const listContainer = document.getElementById('gr-chapter-list-content');
    const countEl = document.getElementById('gr-total-chapters');
    renderChapterList(story, listContainer, countEl);
    
    // 如果当前阅读的章节被删除了，跳转到最后一章
    if (indicesToDelete.includes(grState.currentChapterIndex)) {
      const newIndex = Math.max(0, story.chapters.length - 1);
      if (story.chapters.length > 0) {
        openReader(story.id, newIndex);
      } else {
        // 如果所有章节都被删除了，显示空状态
        document.getElementById('gr-reader-content').innerHTML = `
          <div style="text-align: center; padding: 50px; color: #999;">
            <p>暂无章节</p>
            <p style="font-size: 14px; margin-top: 10px;">点击下方"续写"按钮开始创作</p>
          </div>
        `;
      }
    } else {
      // 重新加载当前章节（索引可能发生变化）
      const deletedBefore = indicesToDelete.filter(i => i < grState.currentChapterIndex).length;
      const newIndex = grState.currentChapterIndex - deletedBefore;
      openReader(story.id, newIndex);
    }
    
    alert(`成功删除 ${indicesToDelete.length} 个章节`);
  }

  function closeChapterList() {
    document.getElementById('gr-chapter-sidebar').classList.remove('visible');
    document.getElementById('gr-sidebar-overlay').classList.remove('visible');
  }
  // 暴露给 HTML onclick
  window.openChapterList = openChapterList;
  window.closeChapterList = closeChapterList;
  
  // ==========================================
  // 导出TXT功能
  // ==========================================
  async function openExportTxtModal(storyId) {
    const story = await db.grStories.get(storyId);
    if (!story || !story.chapters || story.chapters.length === 0) {
      alert("该作品还没有任何章节，无法导出。");
      return;
    }
    const modal = document.getElementById('gr-export-txt-modal');
    const listEl = document.getElementById('gr-export-txt-list');
    listEl.innerHTML = '';
    
    // 渲染章节列表
    story.chapters.forEach((ch, index) => {
      const div = document.createElement('div');
      div.style.cssText = 'display: flex; align-items: center; padding: 12px; border-bottom: 1px solid #eee;';
      div.innerHTML = `
        <input type="checkbox" class="gr-export-checkbox" value="${index}" checked style="width: 18px; height: 18px; margin-right: 12px; cursor: pointer;">
        <span style="font-size: 14px; color: #333;">${index + 1}. ${(window.GreenRiverStoryEngine?.escapeHtml || String)(ch.title || '无题')}</span>
      `;
      div.onclick = (e) => {
        if (e.target.tagName !== 'INPUT') {
          const cb = div.querySelector('input');
          cb.checked = !cb.checked;
          updateExportSelectAllState();
        }
      };
      listEl.appendChild(div);
    });

    const selectAllCheckbox = document.getElementById('select-all-gr-export');
    selectAllCheckbox.checked = true;
    selectAllCheckbox.onclick = (e) => {
      const isChecked = e.target.checked;
      document.querySelectorAll('.gr-export-checkbox').forEach(cb => cb.checked = isChecked);
    };

    function updateExportSelectAllState() {
      const allCbs = Array.from(document.querySelectorAll('.gr-export-checkbox'));
      const allChecked = allCbs.every(cb => cb.checked);
      const someChecked = allCbs.some(cb => cb.checked);
      selectAllCheckbox.checked = allChecked;
      selectAllCheckbox.indeterminate = someChecked && !allChecked;
    }
    
    document.querySelectorAll('.gr-export-checkbox').forEach(cb => {
      cb.addEventListener('change', updateExportSelectAllState);
    });

    // 绑定按钮事件
    const cancelBtn = document.getElementById('cancel-gr-export-btn');
    const confirmBtn = document.getElementById('confirm-gr-export-btn');
    
    const newCancelBtn = cancelBtn.cloneNode(true);
    cancelBtn.parentNode.replaceChild(newCancelBtn, cancelBtn);
    newCancelBtn.onclick = () => modal.classList.remove('visible');

    const newConfirmBtn = confirmBtn.cloneNode(true);
    confirmBtn.parentNode.replaceChild(newConfirmBtn, confirmBtn);
    newConfirmBtn.onclick = () => doExportTxt(story);

    modal.classList.add('visible');
  }

  function doExportTxt(story) {
    const selectedIndices = Array.from(document.querySelectorAll('.gr-export-checkbox'))
      .filter(cb => cb.checked)
      .map(cb => parseInt(cb.value));

    if (selectedIndices.length === 0) {
      alert("请至少选择一个章节进行导出。");
      return;
    }

    const format = document.getElementById('gr-export-format')?.value || 'txt';
    const includeComments = document.getElementById('gr-export-include-comments')?.checked || false;
    if (format === 'html') {
      doExportGreenRiverHtml(story, selectedIndices, includeComments);
      document.getElementById('gr-export-txt-modal').classList.remove('visible');
      return;
    }
    if (window.GreenRiverStoryEngine) window.GreenRiverStoryEngine.normalizeStory(story);
    let txtContent = story.title + "\n\n";
    selectedIndices.sort((a, b) => a - b).forEach(index => {
      const ch = story.chapters[index];
      txtContent += "===============\n";
      txtContent += (ch.title || `第 ${index + 1} 章`) + "\n";
      txtContent += "===============\n\n";
      txtContent += (ch.content || "") + "\n\n";
      if (includeComments && Array.isArray(ch.readerComments) && ch.readerComments.length) {
        txtContent += "【段评】\n";
        ch.readerComments.forEach(group => (group.comments || []).forEach(comment => { txtContent += `${comment.name || '读者'}：${comment.content || ''}\n`; }));
        txtContent += "\n";
      }
    });

    const blob = new Blob([txtContent], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${story.title || '作品导出'}.txt`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);

    document.getElementById('gr-export-txt-modal').classList.remove('visible');
  }

  function doExportGreenRiverHtml(story, selectedIndices, includeComments) {
    const escapeHtml = window.GreenRiverStoryEngine?.escapeHtml || (value => String(value));
    const chaptersHtml = selectedIndices.sort((a, b) => a - b).map(index => {
      const chapter = story.chapters[index];
      const commentsByParagraph = window.GreenRiverStoryEngine?.paragraphCommentMap(chapter) || new Map();
      const paragraphs = (chapter.paragraphs || window.GreenRiverStoryEngine.splitParagraphs(chapter.content).map(text => ({ text }))).map(paragraph => {
        const comments = includeComments ? (commentsByParagraph.get(paragraph.id) || []) : [];
        const commentHtml = comments.length ? `<aside>${comments.map(comment => `<div><strong>${escapeHtml(comment.name || '读者')}</strong> ${escapeHtml(comment.content || '')}</div>`).join('')}</aside>` : '';
        return `<p>${escapeHtml(paragraph.text)}</p>${commentHtml}`;
      }).join('');
      return `<article><h2>${escapeHtml(chapter.title || `第 ${index + 1} 章`)}</h2>${paragraphs}</article>`;
    }).join('');
    const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(story.title)}</title><style>body{max-width:760px;margin:0 auto;padding:40px 24px;background:#faf9f5;color:#27251f;font:18px/1.9 system-ui,sans-serif}h1,h2{text-align:center}article{margin:60px 0}p{text-indent:2em;white-space:pre-wrap}aside{margin:-6px 0 20px 2em;padding:10px 14px;border-left:3px solid #2e7d32;background:#f1f7f3;font-size:14px;line-height:1.6}aside div+div{margin-top:6px}</style></head><body><h1>${escapeHtml(story.title)}</h1>${chaptersHtml}</body></html>`;
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${story.title || '作品导出'}.html`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  // 暴露给全局
  window.openGreenRiverScreen = openGreenRiverScreen;
  window.openAuthorManager = openAuthorManager;
  window.createNewStory = createNewStory;
  window.openStorySettings = openStorySettings;
  window.addAuthor = addAuthor;
  window.deleteAuthor = deleteAuthor;
