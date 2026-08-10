(function () {
  const CLIENT_ID_KEY = 'ephoneAisayWakeClientId';
  let appState = null;
  let appDb = null;
  let pollTimer = null;
  let pollInFlight = false;

  function getClientId() {
    let value = localStorage.getItem(CLIENT_ID_KEY) || '';
    if (!value) {
      value = typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `aisay-client-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      localStorage.setItem(CLIENT_ID_KEY, value);
    }
    return value;
  }

  function getConfig() {
    return appState?.globalSettings?.aisayWake || {
      enabled: false,
      targetChatId: '',
      pollSeconds: 15
    };
  }

  function setStatus(text, color = '') {
    const element = document.getElementById('aisay-wake-status');
    if (!element) return;
    element.textContent = text;
    element.style.color = color || 'var(--text-secondary)';
  }

  function wakeApiUrl(path) {
    if (typeof buildExternalMcpProxyUrl === 'function') {
      return buildExternalMcpProxyUrl(path);
    }
    return path;
  }

  function getWakePauseReason(config) {
    if (!appState?.globalSettings?.enableBackgroundActivity) {
      return '已随“后台角色活动”总开关暂停';
    }
    const chat = appState?.chats?.[config.targetChatId];
    if (chat?.settings?.enableBackgroundActivity === false) {
      return `已随“${chat.name || '目标 Char'}”的独立后台活动暂停`;
    }
    return '';
  }

  async function wakeFetch(path, options = {}) {
    const headers = typeof getExternalMcpProxyRequestHeaders === 'function'
      ? getExternalMcpProxyRequestHeaders(options.headers || {})
      : (options.headers || {});
    return fetch(wakeApiUrl(path), { ...options, headers });
  }

  async function saveConfig(patch) {
    appState.globalSettings.aisayWake = {
      ...getConfig(),
      ...patch
    };
    await appDb.globalSettings.put(appState.globalSettings);
    restartPolling();
  }

  function populateChatSelect() {
    const select = document.getElementById('aisay-wake-chat-select');
    if (!select || !appState) return;
    const selected = String(getConfig().targetChatId || '');
    select.innerHTML = '<option value="">请选择角色</option>';
    Object.values(appState.chats || {})
      .filter(chat => chat && !chat.isGroup)
      .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN'))
      .forEach(chat => {
        const option = document.createElement('option');
        option.value = chat.id;
        option.textContent = chat.name || chat.id;
        select.appendChild(option);
      });
    select.value = selected;
  }

  async function acknowledgeEvent(event, status, error = '') {
    const response = await wakeFetch('/aisay-wake/ack', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        eventId: event.id,
        claimToken: event.claimToken,
        status,
        error
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
      throw new Error(data.error || `唤醒确认失败（HTTP ${response.status}）`);
    }
  }

  async function deliverEvent(event, chatId) {
    const chat = appState.chats[chatId];
    if (!chat) throw new Error('指定 Char 已不存在。');

    const wakeMessage = {
      role: 'user',
      content: event.message,
      timestamp: Date.now(),
      source: 'aisay_wake',
      aisayWakeCategory: event.category,
      aisayWakeEventId: event.externalEventId || event.id
    };

    chat.history = Array.isArray(chat.history) ? chat.history : [];
    chat.history.push(wakeMessage);
    await appDb.chats.put(chat);

    if (appState.activeChatId === chatId && typeof appendMessage === 'function') {
      appendMessage(wakeMessage, chat);
    }
    if (typeof renderChatList === 'function') renderChatList();

    if (typeof window.triggerAiResponse !== 'function') {
      throw new Error('EPhone AI 响应入口尚未就绪。');
    }
    await window.triggerAiResponse(chatId);
  }

  async function pollOnce() {
    if (pollInFlight || !appState || !appDb) return;
    const config = getConfig();
    if (!config.enabled) return;
    if (!config.targetChatId || !appState.chats[config.targetChatId]) {
      setStatus('请选择有效的 Char', '#ff3b30');
      return;
    }

    const pauseReason = getWakePauseReason(config);
    if (pauseReason) {
      setStatus(pauseReason, '#ff9500');
      return;
    }

    pollInFlight = true;
    try {
      const response = await wakeFetch('/aisay-wake/claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId: getClientId(), leaseMs: 5 * 60 * 1000 })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) {
        throw new Error(data.error || `唤醒队列请求失败（HTTP ${response.status}）`);
      }

      if (!data.event) {
        setStatus('在线 · 暂无待处理唤醒', '#34c759');
        return;
      }

      setStatus(`正在唤醒 ${appState.chats[config.targetChatId].name || 'Char'}…`, '#ff9500');
      try {
        await deliverEvent(data.event, config.targetChatId);
        await acknowledgeEvent(data.event, 'completed');
        setStatus(`已处理：${data.event.reason}`, '#34c759');
      } catch (error) {
        await acknowledgeEvent(data.event, 'failed', error.message || String(error)).catch(() => {});
        throw error;
      }
    } catch (error) {
      console.warn('[AISay Wake] 处理失败:', error);
      setStatus(`异常：${error.message || String(error)}`, '#ff3b30');
    } finally {
      pollInFlight = false;
    }
  }

  async function checkQueueStatus() {
    try {
      const response = await wakeFetch('/aisay-wake/status');
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) {
        throw new Error(data.error || `唤醒队列请求失败（HTTP ${response.status}）`);
      }
      const pending = Number(data.stats?.pending || 0);
      const processing = Number(data.stats?.processing || 0);
      const failed = Number(data.stats?.failed || 0);
      setStatus(`在线 · 待处理 ${pending} · 处理中 ${processing} · 失败 ${failed}`, failed ? '#ff9500' : '#34c759');
    } catch (error) {
      setStatus(`异常：${error.message || String(error)}`, '#ff3b30');
    }
  }

  function restartPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    const config = getConfig();
    if (!config.enabled) {
      setStatus('未启用');
      return;
    }
    const seconds = Math.min(60, Math.max(10, Number(config.pollSeconds) || 15));
    pollTimer = setInterval(() => pollOnce(), seconds * 1000);
    pollOnce();
  }

  function bindControls() {
    const enabled = document.getElementById('aisay-wake-enabled-switch');
    const chatSelect = document.getElementById('aisay-wake-chat-select');
    const pollSeconds = document.getElementById('aisay-wake-poll-seconds');
    const testButton = document.getElementById('aisay-wake-test-btn');
    const config = getConfig();

    if (enabled) {
      enabled.checked = config.enabled === true;
      enabled.addEventListener('change', () => saveConfig({ enabled: enabled.checked }));
    }
    populateChatSelect();
    if (chatSelect) {
      chatSelect.addEventListener('change', () => saveConfig({ targetChatId: chatSelect.value }));
    }
    if (pollSeconds) {
      pollSeconds.value = String(config.pollSeconds || 15);
      pollSeconds.addEventListener('change', () => saveConfig({ pollSeconds: Number(pollSeconds.value) || 15 }));
    }
    if (testButton) testButton.addEventListener('click', checkQueueStatus);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') pollOnce();
    });
  }

  window.initAisayWakeClient = function initAisayWakeClient(state, db) {
    appState = state;
    appDb = db;
    bindControls();
    restartPolling();
  };
})();
