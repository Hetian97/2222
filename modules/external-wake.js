(function () {
  const WAKE_NOTICE_SOURCE = 'external_wake';

  function asText(value) {
    return value === null || value === undefined ? '' : String(value).trim();
  }

  function getEventId(event) {
    return asText(event?.externalEventId || event?.event_id || event?.id);
  }

  function buildInternalContext(provider, event, internalContext) {
    const lines = [
      '[外部唤醒内部事件]',
      `来源服务：${provider}`
    ];
    const eventId = getEventId(event);
    const category = asText(event?.category || event?.reason);
    if (eventId) lines.push(`事件编号：${eventId}`);
    if (category) lines.push(`事件类别：${category}`);
    if (event?.resource && typeof event.resource === 'object') {
      lines.push(`定位信息：${JSON.stringify(event.resource)}`);
    }
    lines.push('以下内容只提供给 AI，不是主人说的话；请按其中要求读取真实事件，再决定是否回复或行动。');
    if (asText(internalContext)) lines.push(asText(internalContext));
    return lines.join('\n');
  }

  function createExternalWakeMessages({
    provider,
    event,
    visibleText,
    internalContext
  }) {
    const providerName = asText(provider) || '外部服务';
    const eventId = getEventId(event);
    const timestamp = Date.now();
    const notice = {
      role: 'user',
      type: 'external_wake_notice',
      content: asText(visibleText) || `${providerName} 那边好像有新的动静，你要不要去看看？`,
      timestamp,
      source: WAKE_NOTICE_SOURCE,
      externalWakeProvider: providerName,
      externalWakeEventId: eventId,
      isExternalWakeNotice: true,
      countTowardsMessageTotal: true
    };
    const context = {
      role: 'system',
      type: 'external_wake_context',
      content: buildInternalContext(providerName, event, internalContext),
      timestamp: timestamp + 1,
      source: WAKE_NOTICE_SOURCE,
      externalWakeProvider: providerName,
      externalWakeEventId: eventId,
      isHidden: true,
      isExternalWakeContext: true,
      countTowardsMessageTotal: false
    };
    return { notice, context };
  }

  async function deliverExternalWakeEvent({
    appState,
    appDb,
    chatId,
    provider,
    event,
    visibleText,
    internalContext
  }) {
    const chat = appState?.chats?.[chatId];
    if (!chat) throw new Error('指定 Char 已不存在。');

    const messages = createExternalWakeMessages({
      provider,
      event,
      visibleText,
      internalContext
    });
    chat.history = Array.isArray(chat.history) ? chat.history : [];
    chat.history.push(messages.notice, messages.context);
    await appDb.chats.put(chat);

    if (appState.activeChatId === chatId && typeof window.appendMessage === 'function') {
      await window.appendMessage(messages.notice, chat);
    }
    if (typeof window.renderChatList === 'function') window.renderChatList();

    if (typeof window.triggerAiResponse !== 'function') {
      throw new Error('EPhone AI 响应入口尚未就绪。');
    }
    await window.triggerAiResponse(chatId);
  }

  window.createExternalWakeMessages = createExternalWakeMessages;
  window.deliverExternalWakeEvent = deliverExternalWakeEvent;
})();
