// 角色级 MCP 权限：chat.settings.mcp；旧服务级 allowedCaller* 只用于一次性迁移。
(function () {
  'use strict';

  const MIGRATION_FLAG = 'mcpChatPermissionsMigratedV1';
  const STORAGE_KEY = 'mcpServiceConfigs';

  function getServices() {
    try {
      const list = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }

  function normalize(value) {
    return String(value || '').trim().toLowerCase();
  }

  function getChatMcpSettings(chat) {
    const raw = chat && chat.settings && chat.settings.mcp;
    const settings = raw && typeof raw === 'object' ? raw : {};
    return {
      enabled: settings.enabled === true,
      allowedConnections: Array.isArray(settings.allowedConnections) ? settings.allowedConnections.map(String) : [],
      allowedTools: settings.allowedTools && typeof settings.allowedTools === 'object' ? settings.allowedTools : {},
      confirmDangerous: settings.confirmDangerous !== false
    };
  }

  function legacyServiceAllowsChat(service, chat) {
    if (!service || !chat) return false;
    if (service.allowedCallerMode !== 'selected') return true;
    const raw = [];
    if (Array.isArray(service.allowedCallerIds)) raw.push(...service.allowedCallerIds);
    if (typeof service.allowedCallersText === 'string') raw.push(...service.allowedCallersText.split(/[,;，；\n\r]+/));
    if (Array.isArray(service.allowedCallers)) raw.push(...service.allowedCallers);
    const allowed = new Set(raw.map(normalize).filter(Boolean));
    if (allowed.has('*') || allowed.has('all') || allowed.has('全部')) return true;
    return [chat.id, chat.name, chat.originalName]
      .map(normalize)
      .filter(Boolean)
      .some(value => allowed.has(value));
  }

  async function migrateMcpChatPermissions() {
    if (localStorage.getItem(MIGRATION_FLAG) === '1') return;
    if (typeof state === 'undefined' || !state.chats || typeof db === 'undefined') return;
    const services = getServices().filter(service => service && service.enabled !== false);
    const changed = [];
    Object.values(state.chats).forEach(chat => {
      if (!chat || !chat.settings) return;
      if (chat.settings.mcp && typeof chat.settings.mcp === 'object') return;
      const allowed = services.filter(service => legacyServiceAllowsChat(service, chat));
      chat.settings.mcp = {
        enabled: allowed.length > 0,
        allowedConnections: allowed.map(service => String(service.id)),
        allowedTools: {},
        confirmDangerous: true
      };
      changed.push(chat);
    });
    if (changed.length) await db.chats.bulkPut(changed);
    localStorage.setItem(MIGRATION_FLAG, '1');
    console.log('[MCP] 已迁移角色级 MCP 权限:', changed.length);
  }

  function toolNames(service) {
    return Array.isArray(service?.tools)
      ? service.tools.map(tool => String(tool?.name || '')).filter(Boolean)
      : [];
  }

  function saveChatSettings(chat, settings) {
    if (!chat || !chat.settings) return;
    chat.settings.mcp = {
      enabled: settings.enabled === true,
      allowedConnections: Array.isArray(settings.allowedConnections) ? settings.allowedConnections : [],
      allowedTools: settings.allowedTools && typeof settings.allowedTools === 'object' ? settings.allowedTools : {},
      confirmDangerous: settings.confirmDangerous !== false
    };
    if (typeof db !== 'undefined') db.chats.put(chat).catch(error => console.warn('[MCP] 保存角色权限失败:', error));
  }

  function renderChatMcpPermissions(chat) {
    const root = document.getElementById('chat-mcp-services-list');
    const enabledSwitch = document.getElementById('chat-mcp-enabled-switch');
    const confirmSwitch = document.getElementById('chat-mcp-confirm-switch');
    if (!root || !chat) return;
    const settings = getChatMcpSettings(chat);
    if (enabledSwitch) enabledSwitch.checked = settings.enabled;
    if (confirmSwitch) confirmSwitch.checked = settings.confirmDangerous;

    const services = getServices().filter(service => service && service.enabled !== false);
    root.innerHTML = '';
    if (!services.length) {
      root.textContent = '还没有启用的 MCP 服务。请先到 MCP 服务页连接远程 MCP。';
      return;
    }

    services.forEach(service => {
      const serviceId = String(service.id);
      const allowed = settings.allowedConnections.includes(serviceId);
      const toolList = toolNames(service);
      const card = document.createElement('div');
      card.className = 'chat-mcp-service-item';
      card.style.cssText = 'border:1px solid rgba(0,0,0,.08);border-radius:11px;padding:9px;margin-bottom:8px;background:rgba(0,0,0,.02);';

      const head = document.createElement('label');
      head.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:13px;font-weight:600;color:#333;';
      const serviceCheckbox = document.createElement('input');
      serviceCheckbox.type = 'checkbox';
      serviceCheckbox.className = 'chat-mcp-service-checkbox';
      serviceCheckbox.dataset.serviceId = serviceId;
      serviceCheckbox.checked = allowed;
      const name = document.createElement('span');
      name.textContent = service.name || service.url || '未命名 MCP';
      head.appendChild(serviceCheckbox);
      head.appendChild(name);
      card.appendChild(head);

      const detail = document.createElement('details');
      detail.style.cssText = 'margin-top:7px;';
      const summary = document.createElement('summary');
      summary.style.cssText = 'cursor:pointer;font-size:12px;color:#777;';
      summary.textContent = toolList.length ? `工具（${toolList.length}）` : '工具（尚未测试 tools/list）';
      detail.appendChild(summary);
      const toolWrap = document.createElement('div');
      toolWrap.style.cssText = 'display:grid;gap:6px;margin-top:7px;';
      if (!toolList.length) {
        const empty = document.createElement('div');
        empty.style.cssText = 'font-size:12px;color:#999;';
        empty.textContent = '请先到该 MCP 的“工具”页测试 tools/list。';
        toolWrap.appendChild(empty);
      } else {
        const configured = Array.isArray(settings.allowedTools[serviceId]) ? settings.allowedTools[serviceId] : null;
        toolList.forEach(toolName => {
          const toolLabel = document.createElement('label');
          toolLabel.style.cssText = 'display:flex;align-items:center;gap:7px;font-size:12px;color:#555;';
          const checkbox = document.createElement('input');
          checkbox.type = 'checkbox';
          checkbox.className = 'chat-mcp-tool-checkbox';
          checkbox.dataset.serviceId = serviceId;
          checkbox.dataset.toolName = toolName;
          checkbox.checked = configured ? configured.includes(toolName) : true;
          const text = document.createElement('span');
          text.textContent = toolName;
          toolLabel.appendChild(checkbox);
          toolLabel.appendChild(text);
          toolWrap.appendChild(toolLabel);
        });
      }
      detail.appendChild(toolWrap);
      card.appendChild(detail);
      root.appendChild(card);
    });
  }

  function readDomSettings(chat) {
    const settings = getChatMcpSettings(chat);
    settings.enabled = !!document.getElementById('chat-mcp-enabled-switch')?.checked;
    settings.confirmDangerous = !!document.getElementById('chat-mcp-confirm-switch')?.checked;
    const selectedServices = Array.from(document.querySelectorAll('.chat-mcp-service-checkbox:checked'))
      .map(input => String(input.dataset.serviceId || ''))
      .filter(Boolean);
    settings.allowedConnections = selectedServices;
    const allowedTools = {};
    document.querySelectorAll('.chat-mcp-service-checkbox').forEach(serviceCheckbox => {
      const serviceId = String(serviceCheckbox.dataset.serviceId || '');
      if (!selectedServices.includes(serviceId)) return;
      const toolInputs = Array.from(document.querySelectorAll('.chat-mcp-tool-checkbox'))
        .filter(input => String(input.dataset.serviceId || '') === serviceId);
      if (toolInputs.length) {
        allowedTools[serviceId] = toolInputs
          .filter(input => input.checked)
          .map(input => String(input.dataset.toolName || ''))
          .filter(Boolean);
      }
    });
    settings.allowedTools = allowedTools;
    return settings;
  }

  function bindChatMcpPermissionUi() {
    const group = document.getElementById('chat-mcp-permissions-group');
    if (!group || group.dataset.bound === '1') return;
    group.dataset.bound = '1';
    group.addEventListener('change', () => {
      if (!state.activeChatId) return;
      const chat = state.chats[state.activeChatId];
      if (!chat) return;
      saveChatSettings(chat, readDomSettings(chat));
      renderChatMcpPermissions(chat);
    });
  }

  function initMcpChatPermissions() {
    bindChatMcpPermissionUi();
  }

  window.getChatMcpSettings = getChatMcpSettings;
  window.migrateMcpChatPermissions = migrateMcpChatPermissions;
  window.renderChatMcpPermissions = renderChatMcpPermissions;

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initMcpChatPermissions);
  else initMcpChatPermissions();
})();
