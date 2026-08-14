// ========== 整洁聊天设置：与普通模式共用一套语义顺序 ==========
(function() {
  'use strict';

  let cleanScreenEl = null;
  let movedElements = [];

  function directChildContaining(container, selector) {
    const match = container && container.querySelector(selector);
    if (!match) return null;
    let node = match;
    while (node.parentElement && node.parentElement !== container) node = node.parentElement;
    return node.parentElement === container ? node : null;
  }

  function moveUnits(source, target, selectors) {
    selectors.forEach(selector => {
      const unit = directChildContaining(source, selector);
      if (unit && unit.parentElement === source) target.appendChild(unit);
    });
  }

  function placeUnitsBefore(target, selectors, beforeSelector) {
    const before = directChildContaining(target, beforeSelector);
    if (!before) return;
    selectors.forEach(selector => {
      const unit = directChildContaining(target, selector);
      if (unit && unit !== before) target.insertBefore(unit, before);
    });
  }

  function normalizeChatSettingsOrder() {
    const container = document.querySelector('#chat-settings-screen .settings-container');
    const reply = document.getElementById('chat-reply-memory-section');
    const media = document.getElementById('chat-media-mode-section');
    if (!container || !reply || !media) return;

    let automation = document.getElementById('chat-automation-section');
    if (!automation) {
      automation = document.createElement('div');
      automation.id = 'chat-automation-section';
      automation.className = 'settings-section';
      container.insertBefore(automation, reply.nextSibling);
    }

    const single = document.getElementById('single-char-background-activity-group');
    if (single) {
      let singleReply = document.getElementById('single-char-reply-settings-group');
      if (!singleReply) {
        singleReply = document.createElement('div');
        singleReply.id = 'single-char-reply-settings-group';
        reply.insertBefore(singleReply, single);
      }
      moveUnits(single, singleReply, [
        '#reply-count-range-group',
        '#reply-count-range-config',
        '#inject-thought-group',
        '#char-reply-sanitizer-switch',
        '#char-reply-sanitizer-rules-row'
      ]);
      automation.insertBefore(single, automation.firstChild);
    }

    moveUnits(reply, automation, [
      '#group-background-activity-group',
      '#ai-cooldown-group',
      '#group-cooldown-group',
      '#couple-space-notify-group',
      '#ai-behavior-qzone-item',
      '#ai-behavior-view-myphone-item',
      '#ai-behavior-cross-chat-item',
      '#ai-behavior-status-item'
    ]);

    if (single) {
      const backgroundSwitchUnit = directChildContaining(single, '#char-background-activity-switch');
      const cooldownUnit = directChildContaining(single, '#ai-cooldown-group') || directChildContaining(automation, '#ai-cooldown-group');
      if (backgroundSwitchUnit && cooldownUnit) backgroundSwitchUnit.after(cooldownUnit);
    }

    // 这些项目决定回复方式或角色能读取什么，归入“回复与记忆”。
    moveUnits(media, reply, [
      '#chat-show-seconds-switch',
      '#narrator-mode-group',
      '#bilingual-mode-group',
      '#bilingual-characters-group',
      '#bilingual-display-mode-group',
      '#sticker-vision-group',
      '#sticker-smart-match-group',
      '#offline-mode-group',
      '#offline-mode-options',
      '#todo-list-setting-group',
      '#purchased-items-prompt-setting-group',
      '#character-wallet-prompt-setting-group',
      '#group-reply-sanitizer-switch-row',
      '#group-reply-sanitizer-rules-row'
    ]);
    placeUnitsBefore(reply, [
      '#narrator-mode-group',
      '#bilingual-mode-group',
      '#bilingual-characters-group',
      '#bilingual-display-mode-group',
      '#sticker-vision-group',
      '#sticker-smart-match-group',
      '#offline-mode-group',
      '#offline-mode-options'
    ], '#todo-list-setting-group');

    let reality = document.getElementById('chat-reality-perception-section');
    if (!reality) {
      reality = document.createElement('div');
      reality.id = 'chat-reality-perception-section';
      reality.className = 'settings-section';
      container.insertBefore(reality, automation);
    }
    moveUnits(media, reality, [
      '#time-perception-group',
      '#music-time-awareness-group',
      '#time-zone-group',
      '#custom-time-group',
      '#custom-time-settings-group'
    ]);
    moveUnits(reply, reality, [
      '#time-perception-group',
      '#music-time-awareness-group',
      '#time-zone-group',
      '#custom-time-group',
      '#custom-time-settings-group'
    ]);

    const order = [
      'chat-basic-settings-section',
      'chat-persona-settings-section',
      'chat-reply-memory-section',
      'chat-reality-perception-section',
      'weather-settings-section',
      'chat-automation-section',
      'chat-media-mode-section',
      'video-call-optimization-section',
      'chat-appearance-section',
      'memory-archive-section',
      'api-history-section',
      'message-navigation-section',
      'chat-data-actions-section'
    ];
    const spacer = Array.from(container.children).find(el =>
      el.matches && el.matches('div[style*="height: 40px"]')
    );
    order.forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      if (spacer) container.insertBefore(el, spacer);
      else container.appendChild(el);
    });
  }

  function openCleanChatDetail() {
    if (!state.activeChatId) return;
    buildCleanScreen();
  }

  function buildCleanScreen() {
    if (cleanScreenEl) closeCleanScreenOnly();
    normalizeChatSettingsOrder();

    const oldScreen = document.getElementById('chat-settings-screen');
    const oldContainer = oldScreen && oldScreen.querySelector('.settings-container');
    if (!oldContainer) return;

    oldScreen.classList.remove('active');
    oldScreen.style.display = 'none';

    cleanScreenEl = document.createElement('div');
    cleanScreenEl.id = 'clean-chat-detail-screen';

    const chat = state.chats[state.activeChatId];
    const header = document.createElement('div');
    header.className = 'ccd-header';
    header.innerHTML = '<span class="ccd-back">\u2039</span>' +
      '<span class="ccd-title">' + escapeHtml(chat ? chat.name : '聊天设置') + '</span>' +
      '<span class="ccd-save">保存</span>';
    cleanScreenEl.appendChild(header);
    header.querySelector('.ccd-back').addEventListener('click', closeClean);
    header.querySelector('.ccd-save').addEventListener('click', () => {
      const saveBtn = document.getElementById('save-chat-settings-btn');
      if (saveBtn) saveBtn.click();
      closeClean();
    });

    const tabBar = document.createElement('div');
    tabBar.className = 'ccd-tabs';
    const body = document.createElement('div');
    body.className = 'ccd-body';
    cleanScreenEl.appendChild(tabBar);
    cleanScreenEl.appendChild(body);

    const panels = [
      { id: 'basic', label: '基础资料', ids: ['chat-basic-settings-section'] },
      { id: 'persona', label: '人设与世界', ids: ['chat-persona-settings-section'] },
      { id: 'reply', label: '回复与记忆', ids: ['chat-reply-memory-section'] },
      { id: 'reality', label: '现实感知', ids: ['chat-reality-perception-section', 'weather-settings-section'] },
      { id: 'automation', label: '后台与自动化', ids: ['chat-automation-section'] },
      { id: 'media', label: '语音与图像', ids: ['chat-media-mode-section', 'video-call-optimization-section'] },
      { id: 'appearance', label: '外观', ids: ['chat-appearance-section'] },
      { id: 'data', label: '记录与数据', ids: ['memory-archive-section', 'api-history-section', 'message-navigation-section', 'chat-data-actions-section'] }
    ].map(panel => ({
      ...panel,
      elements: panel.ids.map(id => document.getElementById(id)).filter(Boolean)
    })).filter(panel => panel.elements.length);

    movedElements = [];
    panels.forEach((panel, index) => {
      const tab = document.createElement('div');
      tab.className = 'ccd-tab' + (index === 0 ? ' active' : '');
      tab.textContent = panel.label;
      tab.dataset.tabId = panel.id;
      tab.addEventListener('click', () => switchTab(panel.id));
      tabBar.appendChild(tab);

      const panelEl = document.createElement('div');
      panelEl.className = 'ccd-panel' + (index === 0 ? ' active' : '');
      panelEl.id = 'ccd-panel-' + panel.id;
      const inner = document.createElement('div');
      inner.className = 'settings-container';
      panel.elements.forEach(el => {
        movedElements.push(el);
        inner.appendChild(el);
      });
      panelEl.appendChild(inner);
      body.appendChild(panelEl);
    });

    document.body.appendChild(cleanScreenEl);
  }

  function switchTab(tabId) {
    if (!cleanScreenEl) return;
    let activeTab = null;
    cleanScreenEl.querySelectorAll('.ccd-tab').forEach(tab => {
      const isActive = tab.dataset.tabId === tabId;
      tab.classList.toggle('active', isActive);
      if (isActive) activeTab = tab;
    });
    cleanScreenEl.querySelectorAll('.ccd-panel').forEach(panel =>
      panel.classList.toggle('active', panel.id === 'ccd-panel-' + tabId)
    );
    if (activeTab) activeTab.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
  }

  function restoreElements() {
    const container = document.querySelector('#chat-settings-screen .settings-container');
    if (!container) return;
    const spacer = Array.from(container.children).find(el =>
      el.matches && el.matches('div[style*="height: 40px"]')
    );
    movedElements.forEach(el => {
      if (spacer) container.insertBefore(el, spacer);
      else container.appendChild(el);
    });
    movedElements = [];
    normalizeChatSettingsOrder();
  }

  function closeCleanScreenOnly() {
    restoreElements();
    if (cleanScreenEl) cleanScreenEl.remove();
    cleanScreenEl = null;
  }

  function closeClean() {
    closeCleanScreenOnly();
    const oldScreen = document.getElementById('chat-settings-screen');
    if (oldScreen) oldScreen.style.display = '';
    showScreen('chat-interface-screen');
  }

  function escapeHtml(value) {
    const div = document.createElement('div');
    div.textContent = value || '';
    return div.innerHTML;
  }

  normalizeChatSettingsOrder();
  window.openCleanChatDetail = openCleanChatDetail;
})();
