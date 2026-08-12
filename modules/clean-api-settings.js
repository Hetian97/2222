// ========== 整洁总设置：普通模式与分页模式共用同一分类顺序 ==========
(function() {
  'use strict';

  let cleanScreenEl = null;
  let movedElements = [];

  const categoryOrder = [
    { id: 'api', label: 'API' },
    { id: 'ai', label: 'AI 设置' },
    { id: 'media', label: '媒体服务' },
    { id: 'storage', label: '存储与同步' },
    { id: 'general', label: '显示与工具' },
    { id: 'notify', label: '通知与唤醒' },
    { id: 'about', label: '关于' }
  ];

  function directChildContaining(container, selector) {
    const match = container && container.querySelector(selector);
    if (!match) return null;
    let node = match;
    while (node.parentElement && node.parentElement !== container) node = node.parentElement;
    return node.parentElement === container ? node : null;
  }

  function sectionAfterHeader(container, text) {
    const header = Array.from(container.children).find(el =>
      el.classList && el.classList.contains('settings-header') && el.textContent.includes(text)
    );
    if (!header) return null;
    let node = header.nextElementSibling;
    while (node && !(node.classList && node.classList.contains('settings-section'))) {
      node = node.nextElementSibling;
    }
    return node;
  }

  function moveSettingUnit(selector, target) {
    const match = document.querySelector(selector);
    if (!match || !target) return;
    const source = match.closest('.settings-section');
    const unit = directChildContaining(source, selector);
    if (unit) target.appendChild(unit);
  }

  function prepareApiSettingsStructure() {
    const container = document.querySelector('#api-settings-screen .settings-container');
    if (!container) return;

    // “语言”没有灰色标题，显式标记为独立分组，避免被前一个分区吸收。
    const languageSection = document.getElementById('language-select')?.closest('.settings-section');
    if (languageSection) {
      languageSection.dataset.cleanStandaloneGroup = 'true';
      languageSection.dataset.cleanCategory = 'general';
    }

    const backgroundSection = document.getElementById('background-activity-switch')?.closest('.settings-section');
    if (backgroundSection) {
      const mainSwitch = directChildContaining(backgroundSection, '#background-activity-switch');
      const interval = directChildContaining(backgroundSection, '#background-interval-input');
      if (mainSwitch && interval) backgroundSection.insertBefore(interval, mainSwitch.nextSibling);
    }

    let proactiveSection = document.getElementById('global-proactive-behavior-section');
    if (!proactiveSection) {
      const header = document.createElement('div');
      header.className = 'settings-header';
      header.textContent = '角色主动行为（全局默认）';
      header.dataset.cleanCategory = 'ai';
      proactiveSection = document.createElement('div');
      proactiveSection.id = 'global-proactive-behavior-section';
      proactiveSection.className = 'settings-section';
      const desc = document.createElement('div');
      desc.className = 'settings-desc';
      desc.textContent = '控制角色可主动执行的行为；可在每个角色的聊天设置中单独覆盖。';
      const ttsHeader = Array.from(container.children).find(el =>
        el.classList && el.classList.contains('settings-header') && el.getAttribute('data-lang-key') === 'apiTtsSettings'
      );
      container.insertBefore(header, ttsHeader || null);
      container.insertBefore(proactiveSection, ttsHeader || null);
      container.insertBefore(desc, ttsHeader || null);
    }

    moveSettingUnit('#global-enable-qzone-actions-switch', proactiveSection);
    moveSettingUnit('#global-enable-view-myphone-switch', proactiveSection);
    moveSettingUnit('#global-enable-view-myphone-bg-switch', proactiveSection);
    moveSettingUnit('#global-view-myphone-chance-input', proactiveSection);
    moveSettingUnit('#global-enable-cross-chat-switch', proactiveSection);

    const promptHeader = Array.from(container.children).find(el =>
      el.classList && el.classList.contains('settings-header') &&
      (el.textContent.includes('AI行为控制') || el.textContent.includes('回复与提示词'))
    );
    if (promptHeader) {
      promptHeader.textContent = '回复与提示词（全局默认）';
      promptHeader.dataset.cleanCategory = 'ai';
    }

    const dataSection = sectionAfterHeader(container, '数据管理');
    moveSettingUnit('#global-prompt-clear-memory-switch', dataSection);
  }

  function buildGroups(container) {
    const groups = [];
    let current = { headerEl: null, header: '', elements: [] };
    Array.from(container.children).forEach(el => {
      if (el.dataset && el.dataset.cleanStandaloneGroup === 'true') {
        if (current.headerEl || current.elements.length) groups.push(current);
        groups.push({
          headerEl: null,
          header: '',
          elements: [el],
          forcedCategory: el.dataset.cleanCategory || 'general'
        });
        current = { headerEl: null, header: '', elements: [] };
        return;
      }
      if (el.classList && el.classList.contains('settings-header')) {
        if (current.headerEl || current.elements.length) groups.push(current);
        current = { headerEl: el, header: el.textContent.trim(), elements: [el] };
      } else {
        current.elements.push(el);
      }
    });
    if (current.headerEl || current.elements.length) groups.push(current);
    return groups;
  }

  function categoryFor(group) {
    if (group.forcedCategory) return group.forcedCategory;
    if (!group.headerEl) return 'general';
    if (group.headerEl.dataset.cleanCategory) return group.headerEl.dataset.cleanCategory;
    const key = group.headerEl.getAttribute('data-lang-key') || '';
    const text = group.header;

    if (['apiPresetManagement', 'apiPrimarySettings', 'apiSecondarySettings',
      'apiBackgroundSettings', 'apiVisionSettings', 'apiCoupleSpaceSettings'].includes(key)) return 'api';
    if (key === 'apiBgActivitySettings') return 'ai';
    if (['apiTtsSettings', 'apiImageGenSettings'].includes(key)) return 'media';

    if (/参数设置|高级参数|识图优化|AI行为控制|回复与提示词|角色主动行为|提示词管理/.test(text)) return 'ai';
    if (/云服务与存储|数据管理/.test(text)) return 'storage';
    if (/后台保活|系统级通知|自动唤醒/.test(text)) return 'notify';
    if (/应用更新|许愿|反馈/.test(text)) return 'about';
    if (/调试工具|悬浮球快捷工具|性能与显示|截图水印/.test(text)) return 'general';
    return 'general';
  }

  function normalizeApiSettingsOrder() {
    const container = document.querySelector('#api-settings-screen .settings-container');
    if (!container) return;
    prepareApiSettingsStructure();
    const groups = buildGroups(container);
    const buckets = Object.fromEntries(categoryOrder.map(category => [category.id, []]));
    groups.forEach(group => {
      const category = categoryFor(group);
      group.category = category;
      if (group.headerEl) group.headerEl.dataset.cleanCategory = category;
      buckets[category].push(group);
    });
    categoryOrder.forEach(category => {
      buckets[category.id].forEach(group => group.elements.forEach(el => container.appendChild(el)));
    });
  }

  function openCleanApiSettings() {
    buildCleanScreen();
  }

  function buildCleanScreen() {
    if (cleanScreenEl) closeCleanScreenOnly();
    normalizeApiSettingsOrder();

    const oldScreen = document.getElementById('api-settings-screen');
    const oldContainer = oldScreen && oldScreen.querySelector('.settings-container');
    if (!oldContainer) return;
    const groups = buildGroups(oldContainer);
    const buckets = Object.fromEntries(categoryOrder.map(category => [category.id, []]));
    groups.forEach(group => buckets[categoryFor(group)].push(...group.elements));

    oldScreen.classList.remove('active');
    oldScreen.style.display = 'none';
    cleanScreenEl = document.createElement('div');
    cleanScreenEl.id = 'clean-api-settings-screen';

    const header = document.createElement('div');
    header.className = 'cas-header';
    header.innerHTML = '<span class="cas-back">\u2039</span>' +
      '<span class="cas-title">设置</span><span class="cas-save">完成</span>';
    cleanScreenEl.appendChild(header);
    header.querySelector('.cas-back').addEventListener('click', closeClean);
    header.querySelector('.cas-save').addEventListener('click', () => {
      const saveBtn = document.getElementById('save-api-settings-btn');
      if (saveBtn) saveBtn.click();
      closeClean();
    });

    const tabBar = document.createElement('div');
    tabBar.className = 'cas-tabs';
    const body = document.createElement('div');
    body.className = 'cas-body';
    cleanScreenEl.appendChild(tabBar);
    cleanScreenEl.appendChild(body);

    movedElements = [];
    categoryOrder.filter(category => buckets[category.id].length).forEach((category, index) => {
      const tab = document.createElement('div');
      tab.className = 'cas-tab' + (index === 0 ? ' active' : '');
      tab.textContent = category.label;
      tab.dataset.tabId = category.id;
      tab.addEventListener('click', () => switchTab(category.id));
      tabBar.appendChild(tab);

      const panel = document.createElement('div');
      panel.className = 'cas-panel' + (index === 0 ? ' active' : '');
      panel.id = 'cas-panel-' + category.id;
      const inner = document.createElement('div');
      inner.className = 'settings-container';
      buckets[category.id].forEach(el => {
        movedElements.push(el);
        inner.appendChild(el);
      });
      panel.appendChild(inner);
      body.appendChild(panel);
    });

    document.body.appendChild(cleanScreenEl);
  }

  function switchTab(tabId) {
    if (!cleanScreenEl) return;
    let activeTab = null;
    cleanScreenEl.querySelectorAll('.cas-tab').forEach(tab => {
      const isActive = tab.dataset.tabId === tabId;
      tab.classList.toggle('active', isActive);
      if (isActive) activeTab = tab;
    });
    cleanScreenEl.querySelectorAll('.cas-panel').forEach(panel =>
      panel.classList.toggle('active', panel.id === 'cas-panel-' + tabId)
    );
    if (activeTab) activeTab.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
  }

  function restoreElements() {
    const container = document.querySelector('#api-settings-screen .settings-container');
    if (!container) return;
    movedElements.forEach(el => container.appendChild(el));
    movedElements = [];
    normalizeApiSettingsOrder();
  }

  function closeCleanScreenOnly() {
    restoreElements();
    if (cleanScreenEl) cleanScreenEl.remove();
    cleanScreenEl = null;
  }

  function closeClean() {
    closeCleanScreenOnly();
    const oldScreen = document.getElementById('api-settings-screen');
    if (oldScreen) oldScreen.style.display = '';
    showScreen('home-screen');
  }

  normalizeApiSettingsOrder();
  window.openCleanApiSettings = openCleanApiSettings;
  window.closeCleanApiSettings = closeClean;
})();
