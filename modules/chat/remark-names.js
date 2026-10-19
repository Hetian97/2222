// 备注修改事实独立于聊天窗口保存，供提示词和记忆总结共同使用。
(function () {
  'use strict';

  function getEvent(message, chat) {
    if (!message || message.role !== 'system' || chat?.isGroup) return null;
    const event = message.remarkChange;
    if (event && typeof event.newName === 'string' && ['character', 'user'].includes(event.actor)) {
      return { ...event, timestamp: Number(event.timestamp ?? message.timestamp) || 0 };
    }
    // 只识别旧版程序生成的明确记录，不从普通对话、曾用名或昵称推测来源。
    const content = typeof message.content === 'string' ? message.content : '';
    if (message.type === 'pat_message' && chat?.originalName) {
      const prefix = `“${chat.originalName}” 将备注修改为 “`;
      if (content.startsWith(prefix) && content.endsWith('”')) {
        return { actor: 'character', oldName: null, newName: content.slice(prefix.length, -1), timestamp: Number(message.timestamp) || 0 };
      }
    }
    if (message.isHidden) {
      const match = content.match(/^\[系统提示：你刚刚成功将自己的备注名修改为了“([\s\S]*)”。请自然地接受这个新名字，不要对此感到惊讶。\]$/);
      if (match) return { actor: 'character', oldName: null, newName: match[1], timestamp: Number(message.timestamp) || 0 };
    }
    return null;
  }

  function getCurrentChange(chat) {
    if (!chat || chat.isGroup) return null;
    // 持久化的最新修改是当前状态的依据，不能因时钟回拨而被旧历史覆盖。
    if (chat.lastRemarkChange) {
      const latest = chat.lastRemarkChange;
      return latest.newName === chat.name && ['character', 'user'].includes(latest.actor) ? latest : null;
    }
    let latest = null;
    // 旧聊天尚无持久化来源时，从完整历史恢复，不能只查看当前上下文窗口。
    for (const message of chat.history || []) {
      const event = getEvent(message, chat);
      if (event) latest = event;
    }
    if (latest?.newName !== chat.name || !['character', 'user'].includes(latest?.actor)) return null;
    // 随聊天的下一次正常保存持久化，清理历史后仍能保留已确认的来源。
    chat.lastRemarkChange = { ...latest };
    return chat.lastRemarkChange;
  }

  function describe(event, chat) {
    const actor = event.actor === 'user' ? '用户' : `角色（${chat.originalName || '角色本人'}）`;
    const change = typeof event.oldName === 'string'
      ? `从 ${JSON.stringify(event.oldName)} 修改为 ${JSON.stringify(event.newName)}`
      : `修改为 ${JSON.stringify(event.newName)}（旧备注未记录）`;
    return `${actor}将角色在此聊天中的备注名${change}。`;
  }

  function recordChange(chat, newName, actor, timestamp = Date.now()) {
    if (!chat || chat.isGroup || typeof newName !== 'string' || !['character', 'user'].includes(actor)) return null;
    newName = newName.trim();
    if (!newName || newName === chat.name) return null;
    const event = { actor, oldName: chat.name, newName, timestamp };
    if (!Array.isArray(chat.nameHistory)) chat.nameHistory = [];
    if (!chat.nameHistory.includes(chat.name)) chat.nameHistory.push(chat.name);
    chat.name = newName;
    chat.lastRemarkChange = event;
    const message = { role: 'system', type: 'pat_message', content: describe(event, chat), timestamp, remarkChange: event };
    if (!Array.isArray(chat.history)) chat.history = [];
    chat.history.push(message);
    return message;
  }

  function formatMemoryEvent(message, chat) {
    const event = getEvent(message, chat);
    return event ? `[系统事件；时间戳：${event.timestamp}] ${describe(event, chat)}` : null;
  }

  function buildContext(chat, history = []) {
    if (!chat || chat.isGroup) return '';
    const latest = getCurrentChange(chat);
    const lines = [
      '# 【当前备注与修改来源】',
      `角色本名：${JSON.stringify(chat.originalName || '')}；当前聊天备注名：${JSON.stringify(chat.name || '')}。本名与备注名独立。`,
      '备注可以由用户设置，也可以由你执行 change_remark_name 修改。依据下面的系统事实判断修改者；备注这个称呼本身不代表修改者。',
      latest ? `最近一次修改（时间戳：${latest.timestamp}）：${describe(latest, chat)}` : '当前备注的修改来源未知。没有明确记录时，不推断是谁修改的。'
    ];
    const events = [];
    for (const message of history) {
      const event = getEvent(message, chat);
      if (!event) continue;
      // 旧版同一行动包含一条可见通知和一条紧随其后的隐藏提示。
      const previous = events[events.length - 1];
      if (message.isHidden && previous && previous.actor === event.actor && previous.newName === event.newName && Math.abs(previous.timestamp - event.timestamp) <= 1) continue;
      events.push(event);
    }
    if (events.length) {
      lines.push('当前对话窗口内的备注修改事件（系统事实）：');
      for (const event of events) lines.push(`- 时间戳 ${event.timestamp}：${describe(event, chat)}`);
    }
    return '\n\n' + lines.join('\n');
  }

  window.RemarkNames = { getEvent, getCurrentChange, recordChange, formatMemoryEvent, buildContext };
})();
