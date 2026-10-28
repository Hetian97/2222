// ========================================
// 变量记忆系统 (Variable Memory System)
// 原向量记忆的全面升级版：支持自由时间戳、精细分类
// ========================================

class VariableMemoryManager {
  constructor() {
    this.pendingExternalRecalls = new Map();
    // 10大精细化分类
    this.DEFAULT_CATEGORIES = {
      U: { name: '用户设定', color: '#007aff', icon: '', desc: '外貌、性格、喜好、职业等' },
      A: { name: '角色设定', color: '#5856d6', icon: '', desc: 'AI外貌、习惯、状态变化' },
      R: { name: '关系发展', color: '#ff2d55', icon: '', desc: '里程碑、亲密互动、称呼变化' },
      E: { name: '经历/事件', color: '#34c759', icon: '', desc: '共同经历、日常趣事' },
      I: { name: '物品/礼物', color: '#af52de', icon: '', desc: '互赠礼物、共同拥有的物品' },
      L: { name: '地点/场景', color: '#00c7be', icon: '', desc: '重要的地点记忆' },
      P: { name: '承诺/计划', color: '#ff9500', icon: '', desc: '未来的约定、待办事项' },
      T: { name: '禁忌/规则', color: '#ff3b30', icon: '', desc: '雷区、不能提的话题、特殊规矩' },
      M: { name: '情绪/心理', color: '#e58e26', icon: '', desc: '感动瞬间、心理阴影、深层吐露' },
      C: { name: '核心灵魂', color: '#ff0000', icon: '', desc: '最高优先级、不可遗忘的绝对设定' }
    };
    this.embeddingCache = new Map();
    this._embeddingQueue = [];
    this._isProcessingQueue = false;
  }

  // ==================== 数据结构初始化与迁移 ====================

  getVectorMemory(chat) {
    // 兼容旧接口名，实际返回 variableMemory
    return this.getVariableMemory(chat);
  }

  getVariableMemory(chat) {
    if (!chat.variableMemory) {
      chat.variableMemory = {
        fragments: [],
        timelineSummaries: {},
        settings: {
          topN: 10,
          searchEngine: 'sqlite',
          sqliteCandidateLimit: 6000,
          chromaCandidateLimit: 2000,
          chromaNResults: 200,
          embeddingModel: '',
          embeddingEndpoint: '',
          useCustomEmbedding: false,
          scoreWeights: { semantic: 0.4, keyword: 0.3, importance: 0.2, emotion: 0.05, recency: 0.05 },
          customExtractionPrompt: '',
          useCustomExtractionPrompt: false,
          enableDateTrigger: true,
          enableEmotionTrigger: true,
          enableTopicTrigger: true,
          enablePeriodicReview: true,
          reviewIntervalDays: 7,
          retrievalStrategy: 'user-only',
          retrievalUserMsgCount: 3,
          retrievalCacheEnabled: true,
          retrievalCacheInterval: 3,
          autoExtractionMsgInterval: 20,
          lastExtractedMsgIndex: -1, // 基于消息索引，解决每轮都提取的Bug
          externalMemoryEnabled: localStorage.getItem('vm_external_memory_enabled') === 'true',
          externalMemoryEndpoint: localStorage.getItem('vm_external_memory_endpoint') || 'http://127.0.0.1:8765',
          externalMemoryBearerToken: localStorage.getItem('vm_external_memory_bearer_token') || '',
          // 常驻「待办/计划」上下文：默认开启，可在变量记忆设置页关掉
          planContextEnabled: true
        },
        _customCategories: {},
        stats: { totalFragments: 0, totalRecalls: 0, lastUpdated: 0 },
        _retrievalCache: { query: '', result: null, timestamp: 0, msgCount: 0 },
        _migrated: false
      };
    }
    
    const vm = chat.variableMemory;
    // 自动补全默认值
    if (vm.settings.autoExtractionMsgInterval === undefined) vm.settings.autoExtractionMsgInterval = 20;
    if (vm.settings.lastExtractedMsgIndex === undefined) vm.settings.lastExtractedMsgIndex = -1;
    if (vm.settings.externalMemoryEnabled === undefined) {
      vm.settings.externalMemoryEnabled = localStorage.getItem('vm_external_memory_enabled') === 'true';
    }

    if (vm.settings.externalMemoryEndpoint === undefined) {
      vm.settings.externalMemoryEndpoint = localStorage.getItem('vm_external_memory_endpoint') || 'http://127.0.0.1:8765';
    }
    if (vm.settings.externalMemoryBearerToken === undefined) {
      vm.settings.externalMemoryBearerToken = localStorage.getItem('vm_external_memory_bearer_token') || '';
    }

    // 无损迁移旧版 VectorMemory 数据
    if (chat.vectorMemory && !vm._migrated) {
      this._migrateFromVectorMemory(chat);
    }

    // 外部 memory-server 的 Bearer Token 是设备级凭证，MCP 代理也从
    // localStorage 读取它。旧备份可能只在聊天设置里保存了 Token，导致
    // 设置页看起来已有内容，但 MCP 请求仍然没有 Authorization。
    const storedExternalMemoryToken = String(
      localStorage.getItem('vm_external_memory_bearer_token') || ''
    ).trim();
    const legacyChatToken = String(vm.settings.externalMemoryBearerToken || '').trim();

    if (storedExternalMemoryToken) {
      vm.settings.externalMemoryBearerToken = storedExternalMemoryToken;
    } else if (legacyChatToken) {
      localStorage.setItem('vm_external_memory_bearer_token', legacyChatToken);
      vm.settings.externalMemoryBearerToken = legacyChatToken;
    }

    return vm;
  }

  getMemoryParticipantNames(chat) {
    const appState = typeof window !== 'undefined' ? window.state : null;
    const values = [
      chat?.originalName,
      chat?.name,
      ...(Array.isArray(chat?.nameHistory) ? chat.nameHistory : []),
      chat?.settings?.myNickname,
      appState?.qzoneSettings?.nickname
    ];
    return [...new Set(values.map(value => String(value || '').normalize('NFKC').trim()).filter(value => value.length >= 2))];
  }

  createActiveEventSourceContext(sourceChat, messages = [], mountedChat = null) {
    const safeMessages = (Array.isArray(messages) ? messages : []).filter(Boolean);
    const latestMessage = safeMessages.at(-1) || null;
    const sourceType = sourceChat?.isGroup ? 'group' : 'private';
    const speakerIds = [...new Set(safeMessages.map(message => String(
      message?.senderId || message?.characterId || message?.memberId || (message?.role === 'user' ? 'user' : '')
    ).trim()).filter(Boolean))].slice(0, 24);
    const participantIds = sourceChat?.isGroup
      ? [...new Set((Array.isArray(sourceChat?.members) ? sourceChat.members : [])
          .map(member => String(member?.id || '').trim()).filter(Boolean))].slice(0, 50)
      : [String(sourceChat?.id || sourceChat?.chatId || '').trim()].filter(Boolean);
    // 角色最后一条「对话」（不含动作/环境描写）：服务端用它判断角色是否答应了
    // 上一轮的征询句。优先用结构化的 dialogue（线下/线上都有），
    // 没有时才退回正文——半角引号是 JSON 语法，绝不能当对话标记来解析。
    const lastAssistant = [...safeMessages].reverse().find(message => {
      const role = String(message?.role || '');
      return role && role !== 'user';
    });
    const latestAssistantDialogue = String(lastAssistant?.dialogue || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    return {
      type: sourceType,
      sourceChatId: String(sourceChat?.id || sourceChat?.chatId || '').trim(),
      mountedChatId: String(mountedChat?.id || mountedChat?.chatId || sourceChat?.id || sourceChat?.chatId || '').trim(),
      sourceMessageType: sourceType === 'group' ? 'mounted_group_context' : 'direct_private_message',
      latestSpeakerId: String(
        latestMessage?.senderId || latestMessage?.characterId || latestMessage?.memberId || (latestMessage?.role === 'user' ? 'user' : '')
      ).trim(),
      latestSpeakerRole: String(latestMessage?.role || '').trim(),
      latestAssistantDialogue,
      speakerIds,
      participantIds
    };
  }

  normalizeActiveEventSourceContext(source, chat) {
    const fallback = this.createActiveEventSourceContext(chat, [], chat);
    const input = source && typeof source === 'object' ? source : {};
    const allowedTypes = new Set(['private', 'group', 'system', 'unknown']);
    const requestedType = String(input.type || input.sourceType || fallback.type || 'unknown').trim().toLowerCase();
    return {
      ...fallback,
      ...input,
      type: allowedTypes.has(requestedType) ? requestedType : 'unknown',
      sourceChatId: String(input.sourceChatId || fallback.sourceChatId || '').trim(),
      mountedChatId: String(input.mountedChatId || fallback.mountedChatId || '').trim(),
      sourceMessageType: String(input.sourceMessageType || fallback.sourceMessageType || '').trim(),
      latestSpeakerId: String(input.latestSpeakerId || input.speakerId || fallback.latestSpeakerId || '').trim(),
      latestSpeakerRole: String(input.latestSpeakerRole || input.speakerRole || fallback.latestSpeakerRole || '').trim(),
      speakerIds: [...new Set((Array.isArray(input.speakerIds) ? input.speakerIds : fallback.speakerIds)
        .map(value => String(value || '').trim()).filter(Boolean))].slice(0, 24),
      participantIds: [...new Set((Array.isArray(input.participantIds) ? input.participantIds : fallback.participantIds)
        .map(value => String(value || '').trim()).filter(Boolean))].slice(0, 50)
    };
  }

  filterMemoryTags(chat, tags) {
    const excluded = new Set(this.getMemoryParticipantNames(chat).map(value => value.toLowerCase()));
    return [...new Set((Array.isArray(tags) ? tags : [])
      .map(tag => String(tag || '').normalize('NFKC').replace(/^#/, '').trim())
      .filter(Boolean)
      .filter(tag => !excluded.has(tag.toLowerCase()))
    )].slice(0, 12);
  }

  _migrateFromVectorMemory(chat) {
    const old = chat.vectorMemory;
    const vm = chat.variableMemory;
    if (!old) return;

    console.log('[变量记忆] 开始迁移旧版向量记忆数据...');
    
    // 迁移核心记忆为 C 类片段
    if (old.coreMemories && old.coreMemories.length > 0) {
      for (const core of old.coreMemories) {
        vm.fragments.push({
          id: 'mem_core_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
          content: core.content,
          tags: ['核心设定'],
          category: 'C',
          importance: 10,
          emotionalWeight: 5,
          createdAt: core.createdAt || Date.now(),
          memoryTime: core.createdAt || Date.now(), // 关键：新增 memoryTime
          lastRecalled: 0,
          recallCount: 0,
          // 不在前端保存 embedding，向量只保留在 memory-server SQLite
          linkedMemories: [],
          source: 'migrate_core',
          context: ''
        });
      }
    }

    // 迁移普通片段
    if (old.fragments && old.fragments.length > 0) {
      for (const frag of old.fragments) {
        // 旧分类映射到新分类
        let newCat = 'E';
        if (frag.category === 'F') newCat = 'U'; // 偏好/事实 -> 用户设定
        else if (frag.category === 'D') newCat = 'E'; // 决定 -> 事件
        else if (frag.category === 'P') newCat = 'P'; // 计划 -> 计划
        else if (frag.category === 'R') newCat = 'R'; // 关系 -> 关系
        else if (frag.category === 'M') newCat = 'M'; // 情绪 -> 情绪

        const { embedding, ...cleanFrag } = frag;
        
        vm.fragments.push({
          ...cleanFrag,
          category: newCat,
          memoryTime: frag.dialogueTimeRange?.start || frag.createdAt || Date.now(),
          dialogueTimeRange: undefined
        });
      }
    }

    // 迁移设置
    if (old.settings) {
      vm.settings = { ...vm.settings, ...old.settings };
    }
    
    // 迁移 lastExtractedMsgIndex (估算)
    if (old.lastExtractionTimestamp && chat.history) {
      const idx = chat.history.findIndex(m => m.timestamp >= old.lastExtractionTimestamp);
      vm.settings.lastExtractedMsgIndex = idx >= 0 ? idx : chat.history.length - 1;
    } else if (chat.history) {
      vm.settings.lastExtractedMsgIndex = chat.history.length - 1;
    }

    vm.stats = old.stats || vm.stats;
    vm._customCategories = old._customCategories || {};
    vm._migrated = true;
    console.log('[变量记忆] 迁移完成，共', vm.fragments.length, '条记忆');
  }

  // 获取所有可用分类 (包括自定义)
  getCategories(chat) {
    const vm = this.getVariableMemory(chat);
    return { ...this.DEFAULT_CATEGORIES, ...(vm._customCategories || {}) };
  }
  isExternalMemoryEnabled(chat) {
    const vm = this.getVariableMemory(chat);
    return Boolean(vm.settings?.externalMemoryEnabled);
  }

  getExternalMemoryEndpoint(chat) {
    const vm = this.getVariableMemory(chat);
    return (
      vm.settings?.externalMemoryEndpoint ||
      'http://127.0.0.1:8765'
    ).replace(/\/$/, '');
  }

  isPlanContextEnabled(chat) {
    const vm = this.getVariableMemory(chat);
    // 默认开启：只有显式关掉（false）才不注入，避免旧数据缺字段时静默失效
    return vm.settings?.planContextEnabled !== false;
  }

  // 常驻上下文：还没结束的计划 + 用户确认过的当前事实。
  // 直接读 memory-server 现成的只读接口，不需要服务端改动。
  // 这一层的意义：这些内容不该依赖「向量相似度恰好把它召回来」——那正是
  // 「昨天说明天要去医院，今天就忘了」的根因。这里每轮无条件带上。
  async fetchActiveContext(chat, options = {}) {
    if (!this.isExternalMemoryEnabled(chat) || !this.isPlanContextEnabled(chat)) return null;
    const chatId = String(chat?.id || chat?.chatId || '').trim();
    if (!chatId) return null;

    const now = Date.now();
    const eventLimit = Math.max(1, Math.min(20, Number(options.limit || 8)));
    const factLimit = Math.max(1, Math.min(20, Number(options.factLimit || 8)));
    const query = `chatId=${encodeURIComponent(chatId)}`;

    // 两个接口各自兜住失败：一个挂了不能拖累另一个，更不能拖累正常召回
    const [eventsResult, factsResult] = await Promise.all([
      this.externalMemoryRequest(chat, `/memory/active-events?${query}&limit=50`).catch(error => {
        console.warn('[变量记忆] 计划上下文获取失败（不影响召回）:', error.message);
        return null;
      }),
      this.externalMemoryRequest(chat, `/memory/current-facts?${query}&includeInactive=true&limit=200`).catch(error => {
        console.warn('[变量记忆] 事实上下文获取失败（不影响召回）:', error.message);
        return null;
      })
    ]);

    const events = (Array.isArray(eventsResult?.events) ? eventsResult.events : [])
      .filter(event => event && ['candidate', 'planned', 'active'].includes(String(event.status)))
      // 已过期但还没归档的残留不能进提示词
      .filter(event => !event.validUntil || Number(event.validUntil) >= now)
      // 还在等角色答复的征询句不算计划
      .filter(event => event.awaitingConfirmation !== true && Number(event.awaitingConfirmation || 0) !== 1)
      .sort((a, b) => Number(a.startAt || a.validUntil || 0) - Number(b.startAt || b.validUntil || 0))
      .slice(0, eventLimit)
      .map(event => ({
        id: String(event.id || ''),
        title: String(event.title || event.summary || '').replace(/\s+/g, ' ').trim().slice(0, 160),
        status: String(event.status || 'planned'),
        startAt: Number(event.startAt || 0) || null
      }))
      .filter(event => event.title);

    // 事实：只注入 status === 'current'（= 用户在面板里确认过的）。
    // 自动抽取的 shadow_candidate 一律不注入——它们没有人工确认，噪音不该进提示词。
    const latestBySlot = new Map();
    for (const fact of (Array.isArray(factsResult?.facts) ? factsResult.facts : [])) {
      if (!fact || String(fact.status || '') !== 'current') continue;
      const slotKey = String(fact.slotKey || '');
      const text = String(fact.statement || fact.value || '').replace(/\s+/g, ' ').trim().slice(0, 200);
      if (!slotKey || !text) continue;
      if (fact.validUntil && Number(fact.validUntil) < now) continue;
      const at = Number(fact.effectiveAt || fact.updatedAt || 0);
      const previous = latestBySlot.get(slotKey);
      if (!previous || at >= previous.at) latestBySlot.set(slotKey, { at, slotKey, text });
    }
    const facts = [...latestBySlot.values()]
      .sort((a, b) => b.at - a.at)
      .slice(0, factLimit)
      .map(item => ({
        slotKey: item.slotKey,
        label: this.getFactSlotLabel(item.slotKey),
        text: item.text
      }));

    if (!events.length && !facts.length) return null;
    return { generatedAt: Date.now(), events, facts };
  }

  // 兼容旧名字：只返回计划
  async fetchActivePlanContext(chat, options = {}) {
    const context = await this.fetchActiveContext(chat, options);
    return context && context.events.length
      ? { generatedAt: context.generatedAt, events: context.events }
      : null;
  }

  // 槽位 → 人话标签（把 user.residence.current 显示成「居住地」）
  getFactSlotLabel(slotKey) {
    const key = String(slotKey || '').trim();
    if (key === 'user.residence.current') return '居住地';
    if (key === 'user.location.current') return '当前所在地';
    if (key === 'user.trip.current') return '行程状态';
    if (key.startsWith('user.task.')) return `任务：${key.slice('user.task.'.length)}`;
    if (key.startsWith('user.body.')) {
      const part = key.slice('user.body.'.length);
      const option = this.getFactBodyPartOptions().find(item => item.value === part);
      return `身体：${option ? option.label : part}`;
    }
    return key;
  }

  formatActivePlanContextForPrompt(context) {
    if (!context || !Array.isArray(context.events) || !context.events.length) return '';

    const timeZone = window.TimeZoneUtils?.getCurrentTimeZone?.() || 'UTC';
    const statusLabels = { active: '进行中', planned: '待办', candidate: '待办' };

    const lines = context.events.map(event => {
      const label = statusLabels[event.status] || '待办';
      const when = event.startAt
        ? (window.TimeZoneUtils?.format?.(event.startAt, timeZone) || '')
        : '';
      const head = when ? `｜${when}` : '';
      return `- [${label}${head}] ${event.title}`;
    });

    return [
      '## 还没结束的约定与计划（系统维护）',
      '> 这些条目由系统按时间维护，与你是否「想起」无关，也不代表它们刚刚发生。',
      '> 已经完成、取消或过期的条目不会出现在这里。请自然地在合适的时候惦记它们，不要生硬复述。',
      '> 【视角】这些条目全部出自「用户」之口，不是你写的。所以条目里的「我」指用户本人，「你」指你（角色）——不要把「我」当成你自己。',
      ...lines,
      ''
    ].join('\n');
  }

  // 当前事实段：只包含用户「设为当前」过的事实（候选态不进提示词）
  formatActiveFactContextForPrompt(context) {
    if (!context || !Array.isArray(context.facts) || !context.facts.length) return '';

    const lines = context.facts.map(fact => `- ${fact.label}｜${fact.text}`);

    return [
      '## 当前仍然成立的事实（系统维护）',
      '> 以下是用户确认过的、关于「用户」本人的当前状态，不代表它们刚刚发生。',
      '> 【视角】条目里的「我」指用户本人，「你」指你（角色）——不要把「我」当成你自己。',
      ...lines,
      ''
    ].join('\n');
  }

  getExternalMemoryRequestHeaders(chat, extraHeaders = {}) {
    const vm = this.getVariableMemory(chat);
    const token = String(
      localStorage.getItem('vm_external_memory_bearer_token') ||
      vm.settings?.externalMemoryBearerToken ||
      ''
    ).trim();
    return {
      ...extraHeaders,
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    };
  }

  async externalMemoryRequest(chat, path, options = {}) {
    const endpoint = this.getExternalMemoryEndpoint(chat);
    const url = endpoint + path;

    const response = await fetch(url, {
      method: options.method || 'GET',
      headers: this.getExternalMemoryRequestHeaders(chat, {
        'Content-Type': 'application/json',
        ...(options.headers || {})
      }),
      body: options.body ? JSON.stringify(options.body) : undefined
    });

    if (!response.ok) {
      throw new Error(`External memory server error: ${response.status}`);
    }

    return await response.json();
  }

  getActiveChatForExternalMemory() {
    const state = window.state || {};
    if (state.activeChatId && state.chats && state.chats[state.activeChatId]) {
      return state.chats[state.activeChatId];
    }

    const chats = state.chats || {};
    const firstChatId = Object.keys(chats)[0];
    return firstChatId ? chats[firstChatId] : null;
  }

  syncExternalMemorySettingsFromUI(chat) {
    const vm = this.getVariableMemory(chat);

    const enabledEl = document.getElementById('vm-external-memory-enabled');
    const endpointEl = document.getElementById('vm-external-memory-endpoint');
    const tokenEl = document.getElementById('vm-external-memory-bearer-token');

    if (enabledEl) {
      vm.settings.externalMemoryEnabled = enabledEl.checked;
      localStorage.setItem('vm_external_memory_enabled', enabledEl.checked ? 'true' : 'false');
    }

    if (endpointEl) {
      const endpoint = endpointEl.value.trim() || 'http://127.0.0.1:8765';
      vm.settings.externalMemoryEndpoint = endpoint;
      localStorage.setItem('vm_external_memory_endpoint', endpoint);
    }

    if (tokenEl) {
      const token = tokenEl.value.trim();
      vm.settings.externalMemoryBearerToken = token;
      localStorage.setItem('vm_external_memory_bearer_token', token);
    }

    return vm.settings;
  }

  async testExternalMemoryServerFromSettings() {
    const chat = this.getActiveChatForExternalMemory();
    const statusEl = document.getElementById('vm-external-memory-status');

    if (!chat) {
      if (statusEl) statusEl.textContent = '❌ 未找到当前聊天对象';
      return;
    }

    const settings = this.syncExternalMemorySettingsFromUI(chat);
    const endpoint = (settings.externalMemoryEndpoint || 'http://127.0.0.1:8765').replace(/\/$/, '');

    if (statusEl) {
      statusEl.textContent = '正在测试连接...';
      statusEl.style.color = '#999';
    }

    try {
      const res = await fetch(`${endpoint}/health`, {
        headers: this.getExternalMemoryRequestHeaders(chat)
      });
      const data = await res.json();

      if (data?.ok) {
        if (statusEl) {
          statusEl.textContent = `✅ 连接成功：${data.service || 'memory-server'}`;
          statusEl.style.color = '#22c55e';
        }
      } else {
        throw new Error('health 返回异常');
      }
    } catch (error) {
      if (statusEl) {
        statusEl.textContent = `❌ 连接失败：${error.message}`;
        statusEl.style.color = '#ef4444';
      }
    }
  }

  async loadFragmentsFromExternalServer(chat) {
    if (!this.isExternalMemoryEnabled(chat)) return null;

    try {
      const result = await this.externalMemoryRequest(chat, '/memory/list', {
        method: 'GET'
      });

      if (!result?.ok || !Array.isArray(result.memories)) {
        return null;
      }

      const vm = this.getVariableMemory(chat);

      // 外部存储模式：用 memory-server 的内容覆盖本地 UI 缓存
      // 注意：这里只作为前端显示缓存，真正数据以 memory-server 为准
      vm.fragments = result.memories.map(memory => {
        const copy = { ...memory };

        delete copy.embedding;

        return {
          ...copy,
          embedding: null,
          _externalCache: true
        };
      });

      vm.stats.totalFragments = vm.fragments.length;
      vm.stats.lastUpdated = Date.now();
      vm._externalListLoadedAt = Date.now();
      // 服务端记忆总数（可能大于本地缓存的 5000 条），用于"加载更早的记忆"
      vm._memTotal = Number(result?.total || 0) || vm.fragments.length;

      console.log('[变量记忆] 已从外部 memory-server 加载记忆列表:', vm.fragments.length);

      return vm.fragments;
    } catch (error) {
      console.warn('[变量记忆] 从外部 memory-server 加载列表失败，继续使用本地缓存:', error.message);
      return null;
    }
  }

  async saveFragmentToExternalServer(chat, fragment, options = {}) {
    if (!this.isExternalMemoryEnabled(chat)) return null;

    try {
      const temporaryEmbedding = Array.isArray(options.embedding) && options.embedding.length > 0
        ? options.embedding
        : null;
      console.log('[debug save external]', {
        id: fragment.id,
        embedding: temporaryEmbedding ? temporaryEmbedding.length : null,
        model: options.embeddingModel || fragment.embeddingModel,
        dim: temporaryEmbedding ? temporaryEmbedding.length : fragment.embeddingDim
      });

      const { embedding: discardedEmbedding, ...fragmentWithoutEmbedding } = fragment;
      delete fragment.embedding;
      const saveFragment = {
        ...fragmentWithoutEmbedding,
        tags: this.filterMemoryTags(chat, fragmentWithoutEmbedding.tags),
        participantNames: this.getMemoryParticipantNames(chat),
        embedding: temporaryEmbedding,
        clearEmbedding: options.clearEmbedding === true,
        embeddingModel: temporaryEmbedding
          ? String(options.embeddingModel || this.getCurrentEmbeddingModel(chat) || '')
          : String(fragment.embeddingModel || ''),
        embeddingDim: temporaryEmbedding ? temporaryEmbedding.length : Number(fragment.embeddingDim || 0),
        embeddingUpdatedAt: temporaryEmbedding
          ? String(options.embeddingUpdatedAt || Date.now())
          : String(fragment.embeddingUpdatedAt || '')
      };

      const result = await this.externalMemoryRequest(chat, '/memory/add', {
        method: 'POST',
        body: saveFragment
      });

      if (result?.ok) {
        const saved = result.memory || {};
        const hasEmbedding = saved.hasEmbedding === true || saved._hasEmbedding === true;

        fragment.hasEmbedding = hasEmbedding;
        fragment._hasEmbedding = hasEmbedding;
        fragment._embeddingDim = Number(saved._embeddingDim || saved.embeddingDim || fragment.embeddingDim || 0);

        if (saved.embeddingModel !== undefined) {
          fragment.embeddingModel = saved.embeddingModel || '';
        }

        if (saved.embeddingDim !== undefined) {
          fragment.embeddingDim = Number(saved.embeddingDim || 0);
        }

        if (saved.embeddingUpdatedAt !== undefined) {
          fragment.embeddingUpdatedAt = saved.embeddingUpdatedAt || '';
        }
        ['memoryTimeZone', 'createdAtTimeZone', 'updatedAtTimeZone', 'embeddingUpdatedAtTimeZone', 'lastRecalledTimeZone']
          .forEach(field => {
            if (saved[field] !== undefined) fragment[field] = saved[field] || '';
          });
      }

      console.log('[变量记忆] 已同步到外部 memory-server:', result?.memory?.id || fragment.id);
      return result;
    } catch (error) {
      console.warn('[变量记忆] 外部 memory-server 写入失败，已保留内置记忆:', error.message);
      return null;
    }
  }

  async deleteFragmentFromExternalServer(chat, id) {
    if (!this.isExternalMemoryEnabled(chat)) return null;

    try {
      const result = await this.externalMemoryRequest(chat, '/memory/delete', {
        method: 'POST',
        body: { id }
      });

      console.log('[变量记忆] 已从外部 memory-server 删除:', id);
      return result;
    } catch (error) {
      console.warn('[变量记忆] 外部 memory-server 删除失败，已保留本地删除:', error.message);
      return null;
    }
  }

  async reloadExternalMemoryFromSettings() {
    const chat = this.getActiveChatForExternalMemory();
    const statusEl = document.getElementById('vm-external-memory-status');

    if (!chat) {
      if (statusEl) statusEl.textContent = '❌ 未找到当前聊天对象';
      return;
    }

    this.syncExternalMemorySettingsFromUI(chat);

    if (statusEl) {
      statusEl.textContent = '正在从服务器重新加载记忆...';
      statusEl.style.color = '#999';
    }

    try {
      const fragments = await this.loadFragmentsFromExternalServer(chat);

      if (Array.isArray(fragments)) {
        if (statusEl) {
          statusEl.textContent = `✅ 已从服务器加载 ${fragments.length} 条记忆。请关闭并重新打开长期记忆面板查看。`;
          statusEl.style.color = '#22c55e';
        }
      } else {
        throw new Error('服务器没有返回记忆列表');
      }
    } catch (error) {
      if (statusEl) {
        statusEl.textContent = `❌ 重新加载失败：${error.message}`;
        statusEl.style.color = '#ef4444';
      }
    }
  }

  // ==================== 记忆片段增删改查 ====================

  createFragment(chat, data) {
    const vm = this.getVariableMemory(chat);
    const id = 'mem_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);

    const temporaryEmbedding = Array.isArray(data.embedding) && data.embedding.length > 0
      ? data.embedding
      : null;

    const writeTimeZone = window.TimeZoneUtils?.normalizeTimeZone(
      data.memoryTimeZone,
      window.TimeZoneUtils.getCurrentTimeZone()
    ) || 'UTC';
    const createdAt = Date.now();
    const fragment = {
      id,
      chatId: chat.id || chat.chatId || window.state?.activeChatId || null,
      content: data.content,
      tags: this.filterMemoryTags(chat, data.tags || []),
      category: data.category || 'E',
      importance: data.importance || 5,
      emotionalWeight: data.emotionalWeight || 3,
      createdAt,
      createdAtTimeZone: writeTimeZone,
      updatedAt: createdAt,
      updatedAtTimeZone: writeTimeZone,
      memoryTime: data.memoryTime || createdAt, // 发生时间（可自由修改）
      memoryTimeZone: writeTimeZone,
      lastRecalled: 0,
      recallCount: 0,
      hasEmbedding: false,
      _hasEmbedding: false,
      embeddingModel: '',
      embeddingDim: 0,
      embeddingUpdatedAt: '',
      embeddingUpdatedAtTimeZone: '',
      linkedMemories: data.linkedMemories || [],
      source: data.source || 'auto',
      context: data.context || ''
    };

    vm.fragments.push(fragment);
    if (vm._memPanel) vm._memPanel = null;   // 服务端查询结果作废

    if (this.isExternalMemoryEnabled(chat)) {
      this.saveFragmentToExternalServer(chat, fragment, {
        embedding: temporaryEmbedding,
        embeddingModel: temporaryEmbedding ? this.getCurrentEmbeddingModel(chat) : '',
        embeddingUpdatedAt: temporaryEmbedding ? Date.now() : ''
      });
    }

    vm.stats.totalFragments = vm.fragments.length;
    vm.stats.lastUpdated = Date.now();
    return id;
  }

  async editFragment(chat, id, updates) {
    const vm = this.getVariableMemory(chat);
    const frag = vm.fragments.find(f => f.id === id);
    if (!frag) return false;

    const oldContent = String(frag.content || '').trim();
    const hasContentUpdate = updates.content !== undefined;
    const newContent = hasContentUpdate ? String(updates.content || '').trim() : oldContent;
    const contentChanged = hasContentUpdate && newContent !== oldContent;

    if (hasContentUpdate) {
      frag.content = newContent;
    }

    if (updates.tags !== undefined) frag.tags = this.filterMemoryTags(chat, updates.tags);
    if (updates.category !== undefined) frag.category = updates.category;
    if (updates.importance !== undefined) frag.importance = updates.importance;
    if (updates.emotionalWeight !== undefined) frag.emotionalWeight = updates.emotionalWeight;
    if (updates.memoryTime !== undefined) frag.memoryTime = updates.memoryTime; // 核心：修改发生时间
    if (updates.memoryTimeZone !== undefined) {
      frag.memoryTimeZone = window.TimeZoneUtils?.normalizeTimeZone(updates.memoryTimeZone, frag.memoryTimeZone) || updates.memoryTimeZone;
    }
    if (updates.linkedMemories !== undefined) frag.linkedMemories = updates.linkedMemories;
    if (updates.context !== undefined) frag.context = updates.context;

    if (!frag.chatId) {
      frag.chatId = chat.id || chat.chatId || window.state?.activeChatId || null;
    }

    if (contentChanged) {
      delete frag.embedding;
      frag.hasEmbedding = false;
      frag._hasEmbedding = false;
      frag.embeddingModel = '';
      frag.embeddingDim = 0;
      frag.embeddingUpdatedAt = '';

      let temporaryEmbedding = null;

      try {
        temporaryEmbedding = await this.getEmbedding(frag.content, chat);

        if (Array.isArray(temporaryEmbedding) && temporaryEmbedding.length > 0) {
          console.log('[变量记忆] 编辑后已重新生成临时 embedding:', frag.id, 'dim=', temporaryEmbedding.length);
        } else {
          temporaryEmbedding = null;
          console.warn('[变量记忆] 编辑后未能生成 embedding，继续保存为 BM25:', frag.id);
        }
      } catch (error) {
        console.warn('[变量记忆] 编辑后重新生成 embedding 失败:', error.message);
        temporaryEmbedding = null;
      }

      if (this.isExternalMemoryEnabled(chat)) {
        await this.saveFragmentToExternalServer(chat, frag, {
          embedding: temporaryEmbedding,
          clearEmbedding: !temporaryEmbedding,
          embeddingModel: temporaryEmbedding ? this.getCurrentEmbeddingModel(chat) : '',
          embeddingUpdatedAt: temporaryEmbedding ? Date.now() : ''
        });
      }
    } else if (this.isExternalMemoryEnabled(chat)) {
      await this.saveFragmentToExternalServer(chat, frag);
    }
    frag.updatedAt = Date.now();
    frag.updatedAtTimeZone = window.TimeZoneUtils?.getCurrentTimeZone() || 'UTC';

    vm.stats.lastUpdated = Date.now();

    return true;
  }

  async deleteFragment(chat, id) {
    const vm = this.getVariableMemory(chat);
    vm.fragments = vm.fragments.filter(f => f.id !== id);
    if (vm._memPanel) vm._memPanel = null;   // 服务端查询结果作废，下次重新查
    // 清理关联引用
    vm.fragments.forEach(f => {
      f.linkedMemories = (f.linkedMemories || []).filter(lid => lid !== id);
    });
    vm.stats.totalFragments = vm.fragments.length;
    vm.stats.lastUpdated = Date.now();

    if (this.isExternalMemoryEnabled(chat)) {
      await this.deleteFragmentFromExternalServer(chat, id);
    }

    return true;
  }
  
    // 获取批量选中的记忆文本
  getSelectedItemsText(chat, selectedItems) {
    const vm = this.getVariableMemory(chat);
    const lines = [];

    selectedItems.forEach(item => {
      const frag = vm.fragments.find(f => f.id === item.id);
      if (!frag) return;

      const category = frag.category || 'E';
      const tags = Array.isArray(frag.tags) && frag.tags.length > 0
        ? ` #${frag.tags.join(' #')}`
        : '';
      const timeValue = Number(frag.memoryTime || frag.createdAt || 0);
      const time = Number.isFinite(timeValue) && timeValue > 0
        ? window.TimeZoneUtils?.format(timeValue, frag.memoryTimeZone)
        : '';

      lines.push(`[${category}]${tags}${time ? ` (${time})` : ''}\n${frag.content || ''}`);
    });

    return lines.join('\n\n---\n\n');
  }

  // 导出批量选中的记忆
  exportSelected(chat, selectedItems) {
    const vm = this.getVariableMemory(chat);
    const selectedIds = new Set(selectedItems.map(item => item.id));

    const fragments = vm.fragments
      .filter(f => selectedIds.has(f.id))
      .map(f => ({ ...f }));

    return JSON.stringify({
      type: 'vector-memory-partial',
      version: '2222-sqlite-preview',
      exportedAt: Date.now(),
      chatId: chat.id || chat.chatId || window.state?.activeChatId || null,
      fragments
    }, null, 2);
  }
  
    // 导出全部向量记忆
  exportMemory(chat) {
    const vm = this.getVariableMemory(chat);

    return JSON.stringify({
      type: 'vector-memory',
      version: '2222-sqlite-preview',
      exportedAt: Date.now(),
      chatId: chat.id || chat.chatId || window.state?.activeChatId || null,
      settings: vm.settings || {},
      stats: vm.stats || {},
      fragments: (vm.fragments || []).map(f => ({ ...f }))
    }, null, 2);
  }

  // 批量删除
  async batchDelete(chat, selectedItems) {
    const vm = this.getVariableMemory(chat);
    const selectedIds = new Set(selectedItems.map(item => item.id));
    const deletedIds = [];

    vm.fragments = vm.fragments.filter(f => {
      if (selectedIds.has(f.id)) {
        deletedIds.push(f.id);
        return false;
      }
      return true;
    });
    if (vm._memPanel) vm._memPanel = null;   // 服务端查询结果作废

    vm.fragments.forEach(f => {
      f.linkedMemories = (f.linkedMemories || []).filter(lid => !deletedIds.includes(lid));
    });

    vm.stats.totalFragments = vm.fragments.length;
    vm.stats.lastUpdated = Date.now();

    if (this.isExternalMemoryEnabled(chat) && deletedIds.length > 0) {
      await Promise.all(deletedIds.map(id => this.deleteFragmentFromExternalServer(chat, id)));
    }

    return deletedIds.length > 0;
  }
  
    // 导入向量记忆
  async importMemory(chat, jsonText, mode = 'merge') {
    let data;

    try {
      data = JSON.parse(jsonText);
    } catch (error) {
      throw new Error('JSON 格式错误');
    }

    let fragments = [];

    if (Array.isArray(data)) {
      fragments = data;
    } else if (Array.isArray(data.fragments)) {
      fragments = data.fragments;
    } else if (Array.isArray(data.memories)) {
      fragments = data.memories;
    } else if (data.variableMemory && Array.isArray(data.variableMemory.fragments)) {
      fragments = data.variableMemory.fragments;
    } else {
      throw new Error('未找到可导入的 fragments / memories');
    }

    const vm = this.getVariableMemory(chat);

    if (mode === 'replace') {
      const oldIds = vm.fragments.map(f => f.id).filter(Boolean);

      vm.fragments = [];

      if (this.isExternalMemoryEnabled(chat) && oldIds.length > 0) {
        await Promise.all(oldIds.map(id => this.deleteFragmentFromExternalServer(chat, id)));
      }
    }

    let count = 0;

    for (const item of fragments) {
      const content = String(item.content || '').trim();
      if (!content) continue;

      let embedding = Array.isArray(item.embedding) && item.embedding.length > 0
        ? item.embedding
        : null;

      if (!embedding) {
        try {
          embedding = await this.getEmbedding(content, chat);
        } catch (error) {
          embedding = null;
        }
      }

      this.createFragment(chat, {
        content,
        tags: Array.isArray(item.tags) ? item.tags : [],
        category: item.category || 'E',
        importance: Number(item.importance || 5),
        emotionalWeight: Number(item.emotionalWeight || 3),
        memoryTime: item.memoryTime || item.createdAt || Date.now(),
        memoryTimeZone: item.memoryTimeZone || item.createdAtTimeZone || window.TimeZoneUtils?.getCurrentTimeZone(),
        embedding,
        linkedMemories: Array.isArray(item.linkedMemories) ? item.linkedMemories : [],
        source: item.source || 'import',
        context: item.context || ''
      });

      count++;
    }

    vm.stats.totalFragments = vm.fragments.length;
    vm.stats.lastUpdated = Date.now();

    return count;
  }

  getFragment(chat, id) {
    const vm = this.getVariableMemory(chat);
    return vm.fragments.find(f => f.id === id) || null;
  }

  getAllFragments(chat) {
    const vm = this.getVariableMemory(chat);
    return vm.fragments || [];
  }

  // 兼容旧接口
  getCoreMemories(chat) {
    const vm = this.getVariableMemory(chat);
    return vm.fragments.filter(f => f.category === 'C');
  }

  addCoreMemory(chat, content, options = {}) {
    return this.createFragment(chat, {
      content,
      category: 'C',
      importance: options.importance || 10,
      emotionalWeight: options.emotionalWeight || 10,
      memoryTime: options.memoryTime || Date.now(),
      embedding: options.embedding || null,
      source: options.source || 'manual-core',
      tags: options.tags || ['核心设定']
    });
  }

  async editCoreMemory(chat, id, newContent) {
    await this.editFragment(chat, id, { content: newContent });
  }

  async deleteCoreMemory(chat, id) {
    await this.deleteFragment(chat, id);
  }

  async pinToCoreMemory(chat, fragmentId) {
    await this.editFragment(chat, fragmentId, { category: 'C', importance: 10 });
  }

  serializeCoreMemories(chat) {
    const cores = this.getCoreMemories(chat);
    if (cores.length === 0) return '';
    let output = '## 核心灵魂设定（不可违背）\n';
    cores.forEach(m => { output += `- ${m.content}\n`; });
    return output;
  }

  // ==================== Embedding 获取 ====================

  async reembedUnembeddedMemories(chat) {
    const vm = this.getVariableMemory(chat);

    let count = 0;

    for (const frag of vm.fragments) {
      if (!frag.embeddingModel || !frag.embeddingDim) {
        try {
          const embedding = await this.getEmbedding(frag.content, chat);

          if (Array.isArray(embedding) && embedding.length > 0) {

            const embeddingModel = this.getCurrentEmbeddingModel(chat);
            const embeddingUpdatedAt = Date.now();
            let savedResult = null;

            if (this.isExternalMemoryEnabled(chat)) {
              savedResult = await this.saveFragmentToExternalServer(chat, frag, {
                embedding,
                embeddingModel,
                embeddingUpdatedAt
              });
            }

            // 临时向量绝不进入前端记忆对象；只有服务器确认后才算成功。
            delete frag.embedding;

            if (!savedResult?.ok || !this.hasFragmentEmbedding(frag)) {
              console.warn('[变量记忆] 服务器未确认向量写入，继续保留为 BM25:', frag.id);
              continue;
            }

            count++;

            console.log(
              '[变量记忆] 重新向量化成功:',
              frag.id,
              'dim=',
              embedding.length
            );
          }
        } catch (error) {
          console.warn(
            '[变量记忆] 重新向量化失败:',
            frag.id,
            error.message
          );
        }
      }
    }

    vm.stats.lastUpdated = Date.now();
  
    return { count };
  }

  async getEmbedding(text, chat) {
    if (!text || !text.trim()) return null;

    try {
      const vm = this.getVariableMemory(chat);
      const apiConfig = window.state?.apiConfig || {};
      let endpoint, apiKey, model;

      if (vm.settings.useCustomEmbedding && vm.settings.embeddingEndpoint) {
        endpoint = vm.settings.embeddingEndpoint;
        apiKey = vm.settings.embeddingApiKey || apiConfig.apiKey;
        model = vm.settings.embeddingModel || 'text-embedding-3-small';
      } else {
        const useSecondary = apiConfig.secondaryProxyUrl && apiConfig.secondaryApiKey;
        endpoint = useSecondary ? apiConfig.secondaryProxyUrl : apiConfig.proxyUrl;
        apiKey = useSecondary ? apiConfig.secondaryApiKey : apiConfig.apiKey;
        model = 'text-embedding-3-small';
      }

      if (!endpoint || !apiKey) return null; // 降级为BM25纯本地模式

      this._lastEmbeddingModel = model || this.getCurrentEmbeddingModel(chat);

      const cacheKey = `${this._lastEmbeddingModel}::${text.trim().substring(0, 200)}`;
      if (this.embeddingCache.has(cacheKey)) {
        return this.embeddingCache.get(cacheKey);
      }

      const url = endpoint.endsWith('/') ? endpoint + 'v1/embeddings' : endpoint + '/v1/embeddings';
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({ model, input: text.trim() })
      });

      if (!response.ok) return null;
      const data = await response.json();
      const embedding = data?.data?.[0]?.embedding || null;
      if (embedding) this.embeddingCache.set(cacheKey, embedding);
      return embedding;
    } catch (e) {
      return null;
    }
  }

  getCurrentEmbeddingModel(chat) {
    const vm = this.getVariableMemory(chat);

    const fromLast = String(this._lastEmbeddingModel || '').trim();
    const fromSettings = String(vm.settings?.embeddingModel || '').trim();
    const fromInput = String(document.getElementById('vm-embedding-model-input')?.value || '').trim();
    const fromSelect = String(document.getElementById('vm-embedding-model-select')?.value || '').trim();

    return (
      fromLast ||
      fromSettings ||
      fromInput ||
      fromSelect ||
      'text-embedding-3-small'
    );
  }

  // ==================== 检索引擎（BM25 + Vector + Time + Importance） ====================

  cosineSimilarity(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB) || 1);
  }

  // BM25 简化版词频匹配
  bm25Match(queryTokens, text) {
    if (!queryTokens.length || !text) return 0;
    const lowerText = text.toLowerCase();
    let score = 0;
    for (const token of queryTokens) {
      const lt = token.toLowerCase();
      if (lowerText.includes(lt)) {
        // 词频加权
        const count = (lowerText.match(new RegExp(lt, 'g')) || []).length;
        score += count * 1.5; 
      }
    }
    return Math.min(score / (queryTokens.length * 2), 1.0); // 归一化
  }

  tokenize(text) {
    if (!text) return [];
    const stopWords = new Set(['的', '了', '是', '在', '我', '你', '他', '她', '它', '们', '这', '那', '有', '和', '与', '也', '都', '就', '不', '吗', '呢', '吧', '啊', '哦', '嗯', '呀', '哈']);
    const tokens = [];
    const cnMatches = text.match(/[\u4e00-\u9fff]{2,5}/g) || [];
    cnMatches.forEach(m => { if (!stopWords.has(m)) tokens.push(m); });
    const enMatches = text.match(/[a-zA-Z]+/g) || [];
    enMatches.forEach(m => { if (m.length > 1 && !stopWords.has(m.toLowerCase())) tokens.push(m); });
    return [...new Set(tokens)];
  }

  timeDecay(memoryTime) {
    const daysSince = (Date.now() - memoryTime) / (1000 * 60 * 60 * 24);
    if (daysSince < 0) return 1.0; // 未来的计划不衰减
    // 半衰期30天的指数衰减
    return Math.max(0.1, Math.exp(-0.693 * daysSince / 30));
  }


  async retrieveRelevantFromExternalServer(chat, queryText, topN = null, queryVariants = [], retrievalMeta = {}) {
    if (!this.isExternalMemoryEnabled(chat)) return null;

    const query = String(queryText || '').trim();
    if (!query) return null;

    const vm = this.getVariableMemory(chat);
    const chatId = String(chat?.id || chat?.chatId || '');
    if (this.pendingExternalRecalls.has(chatId)) {
      await this.finishExternalMemoryGeneration(chat, 'failed', 'superseded_by_new_generation_attempt');
    }
    const limit = topN || vm.settings.topN || 10;
    const safeQueryVariants = Array.isArray(queryVariants)
      ? queryVariants.map(v => String(v || '').trim()).filter(Boolean).slice(-5)
      : [];
    const primaryQuery = String(retrievalMeta?.primaryQuery || safeQueryVariants.at(-1) || query).trim();
    const activeEventSource = this.normalizeActiveEventSourceContext(retrievalMeta?.activeEventSource, chat);


    try {
      const result = await this.externalMemoryRequest(chat, '/memory/search', {
        method: 'POST',
        body: {
          query,
          queryVariants: safeQueryVariants,
          participantNames: this.getMemoryParticipantNames(chat),
          shadowPrimaryQuery: primaryQuery,
          shadowContextQueries: safeQueryVariants.filter(value => value !== primaryQuery).slice(-4),
          activeEventSource,
          limit,
          chatId: chat?.id || chat?.chatId || '',
          excludeCategories: ['C'],
          scoreWeights: vm.settings?.scoreWeights || {},
          searchEngine: vm.settings?.searchEngine || 'sqlite',
          candidateLimit: ((vm.settings?.searchEngine || 'sqlite') === 'hybrid' || (vm.settings?.searchEngine || 'sqlite') === 'chroma-hybrid')
            ? (parseInt(vm.settings?.chromaCandidateLimit, 10) || 2000)
            : (parseInt(vm.settings?.sqliteCandidateLimit, 10) || 6000),
          chromaNResults: parseInt(vm.settings?.chromaNResults, 10) || 200,
          timeZone: window.TimeZoneUtils?.getCurrentTimeZone() || 'UTC',
          turnId: String((chat?.history || []).filter(message => message?.role === 'user').slice(-1)[0]?.timestamp || ''),
          attemptId: `attempt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          actionType: String(retrievalMeta?.actionType || 'reply')
        }
      });

      const rows = Array.isArray(result?.memories)
        ? result.memories
        : (Array.isArray(result?.results) ? result.results : []);

      if (!result?.ok) {
        return null;
      }

      // A successful zero-recall response is intentional when the admission
      // gate finds no reliable memory. Preserve it as an empty result so the
      // client does not silently fall back to the old permissive local ranking.
      if (rows.length === 0) {
        const emptyMemories = [];
        emptyMemories._searchTraceId = String(result.searchTraceId || '').trim();
        return emptyMemories;
      }

      const memories = rows
        .filter(memory => memory && memory.content)
        .map(memory => {
          const score = Number(
            memory._searchScore ??
            memory._score ??
            memory.score ??
            memory.relevanceScore ??
            0
          ) || 0;

          return {
            fragment: {
              ...memory,
              _externalSearch: true
            },
            score
          };
        });

      if (memories.length === 0) return null;

      memories._searchTraceId = String(result.searchTraceId || '').trim();

      console.log('[变量记忆] 已使用外部 memory-server /memory/search 召回:', memories.length, result.searchMode || '');
      return memories;
    } catch (error) {
      console.warn('[变量记忆] 外部 memory-server /memory/search 失败，回退前端缓存检索:', error.message);
      return null;
    }
  }

  async commitExternalMemoryRecall(chat, searchTraceId, memoryIds) {
    const safeTraceId = String(searchTraceId || '').trim();
    const safeMemoryIds = [...new Set(
      (Array.isArray(memoryIds) ? memoryIds : [])
        .map(value => String(value || '').trim())
        .filter(Boolean)
    )];

    if (!safeTraceId) return null;

    try {
      const result = await this.externalMemoryRequest(chat, '/memory/search/commit', {
        method: 'POST',
        body: {
          searchTraceId: safeTraceId,
          memoryIds: safeMemoryIds,
          lifecycleVersion: 2
        }
      });
      if (result?.ok !== false && result?.log?.status === 'prompt_committed') {
        this.pendingExternalRecalls.set(String(chat?.id || chat?.chatId || ''), safeTraceId);
      }
      return result;
    } catch (error) {
      console.warn('[变量记忆] 外部记忆召回计数回写失败:', error.message);
      return null;
    }
  }

  async finishExternalMemoryGeneration(chat, outcome = 'succeeded', errorText = '') {
    const chatId = String(chat?.id || chat?.chatId || '');
    const searchTraceId = this.pendingExternalRecalls.get(chatId);
    if (!searchTraceId) return null;
    this.pendingExternalRecalls.delete(chatId);
    try {
      const result = await this.externalMemoryRequest(chat, '/memory/search/generation', {
        method: 'POST',
        body: {
          searchTraceId,
          outcome,
          error: String(errorText || '').slice(0, 500),
          timeZone: window.TimeZoneUtils?.getCurrentTimeZone() || 'UTC'
        }
      });
      if (outcome === 'succeeded') this.applyExternalRecallUpdates(chat, result?.recallUpdates);
      return result;
    } catch (error) {
      if (!this.pendingExternalRecalls.has(chatId)) {
        this.pendingExternalRecalls.set(chatId, searchTraceId);
      }
      console.warn('[变量记忆] 生成结果回写失败:', error.message);
      return null;
    }
  }

  applyExternalRecallUpdates(chat, updates) {
    const safeUpdates = Array.isArray(updates) ? updates : [];
    if (!safeUpdates.length) return 0;

    const vm = this.getVariableMemory(chat);
    const updateById = new Map(
      safeUpdates
        .map(update => [String(update?.id || '').trim(), update])
        .filter(([id]) => id)
    );
    let changed = 0;

    for (const fragment of vm.fragments || []) {
      const update = updateById.get(String(fragment?.id || ''));
      if (!update) continue;
      fragment.recallCount = Number(update.recallCount || 0);
      fragment.lastRecalled = Number(update.lastRecalled || 0);
      changed++;
    }

    if (changed > 0) {
      window.dispatchEvent(new CustomEvent('variable-memory-recall-updated', {
        detail: { chatId: chat?.id || chat?.chatId || '', updates: safeUpdates }
      }));
    }

    return changed;
  }

  async retrieveRelevant(chat, queryText, topN = null) {
    const vm = this.getVariableMemory(chat);
    if (!vm.fragments.length) return [];
    if (!topN) topN = vm.settings.topN || 10;
    
    // 缓存机制
    if (vm.settings.retrievalCacheEnabled && vm._retrievalCache) {
      const cache = vm._retrievalCache;
      const cacheAge = (Date.now() - cache.timestamp) / 1000 / 60; 
      const msgCountDiff = (chat.history?.length || 0) - cache.msgCount;
      if (cache.query === queryText && cacheAge < 10 && msgCountDiff < (vm.settings.retrievalCacheInterval || 3) && cache.result) {
        return cache.result;
      }
    }
    
    const weights = vm.settings.scoreWeights;
    const queryEmbedding = await this.getEmbedding(queryText, chat);
    const queryTokens = this.tokenize(queryText);

    const scored = vm.fragments.filter(frag => frag.category !== 'C').map(frag => {
      // 语义得分
      const semanticScore = queryEmbedding && frag.embedding ? this.cosineSimilarity(queryEmbedding, frag.embedding) : 0;
      
      // BM25 本地字面得分 (标签 + 内容)
      const tagText = (frag.tags || []).join(' ');
      const bm25Score = Math.max(this.bm25Match(queryTokens, tagText), this.bm25Match(queryTokens, frag.content) * 0.8);

      // 绝对重要度 (8-10分有极大加权，抗衰减)
      const importanceVal = frag.importance || 5;
      let importanceScore = importanceVal / 10;
      if (importanceVal >= 8) importanceScore *= 1.5; // 高光记忆放大

      // 情绪分
      const emotionScore = (frag.emotionalWeight || 3) / 10;
      
      // 衰减分 (基于真实的 memoryTime)
      let recencyScore = this.timeDecay(frag.memoryTime);
      // 重要度极高的记忆抗衰减
      if (importanceVal >= 9) recencyScore = 1.0; 

      const totalScore =
        semanticScore * (weights.semantic || 0.4) +
        bm25Score * (weights.keyword || 0.3) +
        importanceScore * (weights.importance || 0.2) +
        emotionScore * (weights.emotion || 0.05) +
        recencyScore * (weights.recency || 0.05);

      return { fragment: frag, score: totalScore };
    });

    scored.sort((a, b) => b.score - a.score);
    // 过滤掉得分太低且不是核心的
    let results = scored.slice(0, topN).filter(r => r.score > 0.1);

    // 更新统计
    for (const r of results) {
      r.fragment.lastRecalled = Date.now();
      r.fragment.recallCount = (r.fragment.recallCount || 0) + 1;
    }
    vm.stats.totalRecalls++;
    
    if (vm.settings.retrievalCacheEnabled) {
      vm._retrievalCache = { query: queryText, result: results, timestamp: Date.now(), msgCount: chat.history?.length || 0 };
    }

    return results;
  }

  // ==================== 序列化为 Prompt ====================

  clarifyRelativeMemoryDatesForPrompt(content, memoryTime, memoryTimeZone) {
    const source = String(content || '');
    const anchor = window.TimeZoneUtils?.getParts(Number(memoryTime), memoryTimeZone);
    if (!anchor) return source;

    const pad = value => String(value).padStart(2, '0');
    const anchorDate = new Date(Date.UTC(anchor.year, anchor.month - 1, anchor.day));
    const formatDate = date => {
      return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
    };
    const formatRelativeDate = offset => {
      const date = new Date(anchorDate);
      date.setUTCDate(date.getUTCDate() + offset);
      return formatDate(date);
    };
    const formatRelativeMonth = offset => {
      const date = new Date(Date.UTC(anchor.year, anchor.month - 1 + offset, 1));
      return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}`;
    };
    const clarify = (resolved, original) => `${resolved}（原文称“${original}”）`;
    const dayOffsets = {
      大前天: -3,
      前天: -2,
      昨天: -1,
      今天: 0,
      明天: 1,
      后天: 2,
      大后天: 3
    };
    const compactRelativeTimes = {
      昨晚: { offset: -1, period: '晚上' },
      今晚: { offset: 0, period: '晚上' },
      明晚: { offset: 1, period: '晚上' },
      今早: { offset: 0, period: '早上' },
      明早: { offset: 1, period: '早上' }
    };
    const monthOffsets = {
      上个月: -1,
      上月: -1,
      这个月: 0,
      本月: 0,
      下个月: 1,
      下月: 1
    };
    const yearOffsets = {
      前年: -2,
      去年: -1,
      今年: 0,
      明年: 1
    };
    const weekdayIndexes = {
      一: 0,
      二: 1,
      三: 2,
      四: 3,
      五: 4,
      六: 5,
      日: 6,
      天: 6
    };
    const relativeTimePattern = /大前天|大后天|昨天(?:早上|上午|中午|下午|晚上|夜里|凌晨)?|今天(?:早上|上午|中午|下午|晚上|夜里|凌晨)?|明天(?:早上|上午|中午|下午|晚上|夜里|凌晨)?|前天|后天|昨晚|今晚|明晚|今早|明早|(?:上周|本周|这周|下周)(?:[一二三四五六日天])?|上个月|这个月|下个月|上月|本月|下月|(?:前年|去年|今年|明年)(?:春天|春季|夏天|夏季|秋天|秋季|冬天|冬季|\d{1,2}月)?/g;

    return source.replace(relativeTimePattern, matched => {
      const compact = compactRelativeTimes[matched];
      if (compact) {
        return clarify(`${formatRelativeDate(compact.offset)} ${compact.period}`, matched);
      }
      const dayLabel = Object.keys(dayOffsets).find(label => matched.startsWith(label));
      if (dayLabel) {
        const period = matched.slice(dayLabel.length);
        return clarify(`${formatRelativeDate(dayOffsets[dayLabel])}${period ? ` ${period}` : ''}`, matched);
      }
      if (Object.prototype.hasOwnProperty.call(monthOffsets, matched)) {
        return clarify(formatRelativeMonth(monthOffsets[matched]), matched);
      }
      const weekMatch = matched.match(/^(上周|本周|这周|下周)([一二三四五六日天])?$/);
      if (weekMatch) {
        const weekOffset = weekMatch[1] === '上周' ? -1 : weekMatch[1] === '下周' ? 1 : 0;
        const anchorWeekday = (anchorDate.getUTCDay() + 6) % 7;
        const mondayOffset = -anchorWeekday + weekOffset * 7;
        if (weekMatch[2]) {
          return clarify(formatRelativeDate(mondayOffset + weekdayIndexes[weekMatch[2]]), matched);
        }
        return clarify(`${formatRelativeDate(mondayOffset)}至${formatRelativeDate(mondayOffset + 6)}`, matched);
      }
      const yearMatch = matched.match(/^(前年|去年|今年|明年)(.*)$/);
      if (yearMatch) {
        const targetYear = anchor.year + yearOffsets[yearMatch[1]];
        const suffix = yearMatch[2];
        const numericMonth = suffix.match(/^(\d{1,2})月$/);
        const resolved = numericMonth
          ? `${targetYear}-${pad(Math.min(12, Math.max(1, Number(numericMonth[1]))))}`
          : `${targetYear}年${suffix}`;
        return clarify(resolved, matched);
      }
      return matched;
    });
  }

  async serializeForPrompt(chat, recentMessages = '', queryVariants = [], retrievalMeta = {}) {
    const vm = this.getVariableMemory(chat);
    let output = '';

    // 核心灵魂设定
    const coreStr = this.serializeCoreMemories(chat);
    if (coreStr) output += coreStr + '\n';

    // 动态记忆检索：外置 memory-server 优先，失败再回退前端缓存检索
    if (recentMessages) {
      let results = null;
      // 计划上下文与记忆召回并行请求，避免多一次串行往返
      const planContextPromise = this.fetchActiveContext(chat);

      if (this.isExternalMemoryEnabled(chat)) {
        results = await this.retrieveRelevantFromExternalServer(chat, recentMessages, null, queryVariants, retrievalMeta);
      }

      const externalSearchTraceId = Array.isArray(results)
        ? String(results._searchTraceId || '').trim()
        : '';

      if (!Array.isArray(results) && vm.fragments.length > 0) {
        results = await this.retrieveRelevant(chat, recentMessages);
      }

      const nonCoreResults = (results || []).filter(r => r.fragment && r.fragment.category !== 'C');

      if (nonCoreResults.length > 0) {
        output += '## 回闪记忆 (根据当前情境唤醒的记忆片段)\n';
        output += '> 时间规则：方括号标注的是该段记忆被记录或叙述时的时间基准，不保证是正文中所有事件的实际发生时间。正文中的“昨天、上周、去年”等相对时间已按该条基准换算，且只约束该条内明确对应的事件；严禁把一条记忆的时间修饰套到另一条记忆的事件上。记忆被召回不代表它刚刚发生。\n';

        // 按记忆记录基准时间排序，让 AI 更有时间顺序感
        nonCoreResults.sort((a, b) => {
          const at = Number(a.fragment.memoryTime || a.fragment.createdAt || a.fragment.updatedAt || 0);
          const bt = Number(b.fragment.memoryTime || b.fragment.createdAt || b.fragment.updatedAt || 0);
          return at - bt;
        });

        for (const r of nonCoreResults) {
          const memoryTime = Number(r.fragment.memoryTime || r.fragment.createdAt || r.fragment.updatedAt || Date.now());
          const memoryTimeZone = r.fragment.memoryTimeZone || 'Europe/London';
          const dateStr = window.TimeZoneUtils?.format(memoryTime, memoryTimeZone) || '';
          const promptContent = this.clarifyRelativeMemoryDatesForPrompt(
            r.fragment.content,
            memoryTime,
            memoryTimeZone
          );
          output += '[记忆记录基准时间：' + dateStr + '｜' + memoryTimeZone + ']\n' + promptContent + '\n';
        }

        output += '\n';
      }

      if (externalSearchTraceId) {
        await this.commitExternalMemoryRecall(
          chat,
          externalSearchTraceId,
          nonCoreResults.map(result => result.fragment?.id)
        );
      }

      // 常驻段落：与「回闪记忆」相互独立——回闪是「想起来了」，这里是「一直都知道」
      const activeContext = await planContextPromise;
      const planSection = this.formatActivePlanContextForPrompt(activeContext);
      if (planSection) output += planSection;
      // 当前事实（用户确认过的）同样常驻；候选态的事实不会走到这里
      const factSection = this.formatActiveFactContextForPrompt(activeContext);
      if (factSection) output += factSection;
    }

    if (!output.trim()) output = '(暂无记忆)\n';

    return `## 你的变量记忆档案
[系统强制指令：你必须将以下提取出的记忆作为你真实的过去，并在对话中自然地表现出你记得这些事。]
${output}`;
  }

  // ==================== AI 提取记忆 (修复间隔 Bug) ====================

  getDefaultExtractionPrompt(chat = null) {
    const roleName = chat ? (chat.originalName || chat.name || '角色') : '{{角色名}}';
    const userNickname = chat
      ? (chat.settings?.myNickname || window.state?.qzoneSettings?.nickname || '用户')
      : '{{用户昵称}}';

    return `
# 你的任务：
你是"${roleName}"。请阅读下面的最新对话记录，提取【值得长期记忆】的增量信息，输出为 JSON 数组格式。

# 写作视角：
- 以"${roleName}"的第一人称视角写记忆。
- 用“我”指代"${roleName}"。
- 用“她”或“${userNickname}”指代用户。
- 不要写成旁观者摘要，也不要用“用户”“角色”这种生硬称呼。
- 对话中出现的其他人，使用其全名指代。
- 如实记录对话中的事实、关系变化、重要信息和稳定设定，禁止编造。不得改变事件主体、时间关系、因果关系或说话者身份。

# 主体识别规则：
- 提取记忆前，必须先判断原对话中每个行为、决定、表达和经历的实际主体。
- “我”必须始终指代当前角色（{{角色名}}），不能代替用户。
- 不要把用户做过的事、说过的话、计划或感受改写成角色自己的经历。
- 不要把角色做过的事、说过的话、计划或感受归属于用户。
- 如果一句话包含“我”“你”“她”等代词，必须结合上下文判断真实指代，而不是直接沿用原句视角。

# 提取原则：
- 提取有具体信息量、有记忆价值的内容。“有记忆价值”包括但不限于：事实、情绪、共同经历、承诺、偏好。不要求每条都必须“未来一定有用”。
- 过滤纯寒暄、明确重复的内容，以及确实没有任何信息量的日常。当不确定是否该记时，偏向记录而非丢弃。
- 同一话题下，如果信息点互相独立且未来可能被分别检索，应拆成多条；如果确实紧密相关，再合并成一条。宁可略多，不要过度合并导致信息丢失。不要把连续动作拆碎，但可以按“信息主题”拆分。
- 每条记忆围绕一个核心主题，长度50-120字。当同一场景或同一话题中包含2个以上互相独立的信息点（例如：既发生了具体事件，又产生了新的承诺，又暴露了用户的某个偏好），应拆成多条，分别记录。不要为了“凑一条”而把多个独立信息强行打包。
- 保留关键时间、地点、人物、承诺、关系变化、共同经历（包括普通但有记忆点的日常）和稳定偏好。
- tags 只写能区分这条记忆的事件、第三方人物、地点、物品、规则或情绪关键词；不要把当前角色名、角色曾用名、用户昵称或双方日常称呼本身作为 tags。
- 不要把一次性行为改写成“习惯”“总是”“长期如此”“以后都会”等长期模式，除非原文明确表达了持续性。
- 如果同一主题已有旧记忆，本次对话中出现了旧记忆未包含的新信息（新细节、新情绪、新约定、新进展），则作为一条新的独立记忆补充添加，新旧并存；如果没有新信息，则不新增。旧记忆本身不需要修改或覆盖。
- E 不是“低价值分类”，也不是“兜底分类”。如果一条记忆的核心是一次具体共同经历，优先归为 E。但注意：同一场景中可能同时产生多个独立信息，这些信息应拆分为多条记忆，分别归入对应分类，而不是全部打包进一条 E。具体分类规则见下方「10大精细分类说明」。

# 10大精细分类说明：
当从同一场景中拆出多条记忆时，按以下标准判断每条记忆的核心归属：
请优先判断这条记忆的核心是什么。若核心是一次具体共同经历、一次场景节点、一次有回忆价值的日常互动，优先归为 E；只有当核心明显属于长期有效的稳定设定、长期规则或边界、关系转折或关系里程碑、具有重要意义的物品、具有长期意义的地点、尚未完成且需要后续兑现的长期承诺或计划、强烈且会持续影响后续互动的心理状态、核心灵魂设定时，才归入 U/A/R/I/L/P/T/M/C。不要把 E 当作兜底分类，也不要把所有日常都归为 E。

- U = 用户设定 (${userNickname}的外貌/性格/喜好/身份、稳定偏好、习惯、身体感受、生活需求等)
- A = 角色设定 (${roleName}自己的稳定设定、偏好、习惯、原则、保护方式、行为边界、自身变化等)
- R = 关系发展 (${roleName}与${userNickname}之间的表白、吵架、和好、主动承认想念、亲密互动、关系推进等里程碑)
- I = 物品/礼物 (礼物、衣物、饰品、重要物品的赠送、使用或长期意义)
- L = 地点/场景 (被命名、反复出现、具有特殊意义、关系节点性质或后续可能被回忆的地点/场景；长期住处或常住地也可归为 L。普通“想去/准备去某地”通常不归为 L，单次共同到访通常优先归为 E)
- P = 承诺/计划 (约定的未来事项、答应要做的事、长期承诺、持续计划、共同生活安排、会推动下一场景或后续剧情的短期计划)
- T = 禁忌/规则 (隐私边界、雷区、规矩、禁忌、不能对外提及或只允许两人之间知道的事)
- M = 情绪/心理 (强烈、深层或长期影响后续互动的情感流露、心理转折、救赎感、归属感、阴影、崩溃、心理创伤或长期心理状态；普通短暂紧张/害怕通常不归为 M)
- C = 核心灵魂 (必须长期牢记的关键设定、生死攸关的事、绝对底线)
- E = 经历/事件 (${roleName}与${userNickname}共同经历的一次具体事件、场景节点或有回忆价值的日常互动，例如共同外出、一起吃饭、回家重逢、完成某件事、发生一次值得回忆的互动。若重点是“这次发生了什么”，而不是长期规则、稳定设定、未来计划或重大关系转折，通常归为 E。)

# 输出格式（严格遵守 JSON 数组）
\`\`\`json
[
  {
    "content": "记忆内容（第一人称，简短清晰，如：${userNickname}告诉我她今天升职了）",
    "tags": ["升职", "开心", "工作"],
    "category": "U/A/R/E/I/L/P/T/M/C",
    "importance": 1-10,
    "emotionalWeight": 1-10
  }
]
\`\`\`

# 评分规则 (1-10)：
- importance: 1-10。
- 1-4：轻量信息、普通日常、低影响事件、可不长期追踪的短期安排。
- 5-6：值得记住的偏好、普通承诺、普通共同经历、一般地点信息、会推动下一场景的短期计划。
- 7-8：明确长期有效的规则、重要地点、明显关系推进、重要保护原则、持续承诺、会反复影响后续互动的事件。
- 9-10：核心设定、生死约定、不可违背的长期规则、重大关系转折。不要轻易给 9-10。
- 普通“今晚/明天要去某地”“我会安排车”通常为 5-6；只有代表长期安排或重大转折时才给 7 以上。
- emotionalWeight: 1-10。普通安排通常 2-4；明显亲密、恐惧、崩溃、和好、告白、深层心理转折等才给 6 以上。

# 待提取对话：
{{对话记录}}

# 输出要求：
请直接输出 JSON 数组。如果没有值得记录的内容，输出空数组 []。`;
  }

  buildExtractionPrompt(chat, formattedHistory, timeRangeStr, dialogueTimeRange) {
    const vm = this.getVariableMemory(chat);
    const userNickname = chat.settings.myNickname || (window.state?.qzoneSettings?.nickname || '用户');
    
    // 保存最新的消息索引用于后续更新
    this._tempLastMsgIndex = chat.history ? chat.history.length - 1 : -1;

    if (vm.settings.useCustomExtractionPrompt && vm.settings.customExtractionPrompt?.trim()) {
      return vm.settings.customExtractionPrompt
        .replace(/\{\{角色名\}\}/g, chat.originalName || chat.name)
        .replace(/\{\{用户昵称\}\}/g, userNickname)
        .replace(/\{\{对话记录\}\}/g, formattedHistory);
    }

    return this.getDefaultExtractionPrompt(chat)
      .replace(/\{\{对话记录\}\}/g, formattedHistory);
  }


  parseExtractionResult(rawText, chat = this.getActiveChatForExternalMemory()) {
    this._lastExtractionParseFailed = false;
    const cats = Object.keys(this.DEFAULT_CATEGORIES);

    const normalizeArray = (arr) => {
      if (!Array.isArray(arr)) return [];
      return arr.filter(item => item && item.content).map(item => ({
        content: String(item.content).trim(),
        tags: this.filterMemoryTags(chat, item.tags),
        category: cats.includes(item.category) ? item.category : 'E',
        importance: Math.min(10, Math.max(1, parseInt(item.importance) || 5)),
        emotionalWeight: Math.min(10, Math.max(1, parseInt(item.emotionalWeight) || 3))
      }));
    };

    const tryParseArray = (text) => {
      try {
        const arr = JSON.parse(String(text || '').trim());
        return Array.isArray(arr) ? normalizeArray(arr) : null;
      } catch (e) {
        return null;
      }
    };

    const extractBalancedJsonArrays = (text) => {
      text = String(text || '');
      const candidates = [];

      for (let start = text.indexOf('['); start !== -1; start = text.indexOf('[', start + 1)) {
        let depth = 0;
        let inString = false;
        let escape = false;

        for (let i = start; i < text.length; i++) {
          const ch = text[i];

          if (inString) {
            if (escape) {
              escape = false;
            } else if (ch === '\\') {
              escape = true;
            } else if (ch === '"') {
              inString = false;
            }
            continue;
          }

          if (ch === '"') {
            inString = true;
          } else if (ch === '[') {
            depth++;
          } else if (ch === ']') {
            depth--;
            if (depth === 0) {
              candidates.push(text.slice(start, i + 1));
              start = i;
              break;
            }
          }
        }
      }

      return candidates;
    };

    try {
      const text = String(rawText || '').trim();

      const directParsed = tryParseArray(text);
      if (directParsed) return directParsed;

      const fenceRe = new RegExp('`{3}(?:json)?\\\\s*([\\\\s\\\\S]*?)`{3}', 'gi');
      const codeBlocks = [...text.matchAll(fenceRe)];
      for (const block of codeBlocks) {
        const parsed = tryParseArray(block[1]);
        if (parsed) return parsed;
      }

      const candidates = extractBalancedJsonArrays(text);
      for (const candidate of candidates) {
        const parsed = tryParseArray(candidate);
        if (parsed) return parsed;
      }

      this._lastExtractionParseFailed = true;


      console.error('[变量记忆] 未能从AI返回中解析JSON数组，原始返回:', rawText);
      return [];
    } catch (e) {
      this._lastExtractionParseFailed = true;

      console.error('[变量记忆] 解析提取结果失败:', e, rawText);
      return [];
    }
  }

  async mergeExtractedMemories(chat, extractedItems, defaultTime = Date.now(), defaultTimeZone = null) {
    const vm = this.getVariableMemory(chat);
    const newIds = [];
    
    for (const item of extractedItems) {
      // 去重
      const isDuplicate = vm.fragments.some(f => this.bm25Match(this.tokenize(item.content), f.content) > 0.8);
      if (isDuplicate) continue;

      const embedding = await this.getEmbedding(item.content, chat);
      const id = this.createFragment(chat, {
        ...item,
        embedding,
        memoryTime: defaultTime, // 新提取的记忆发生时间默认为传入时间
        memoryTimeZone: item.memoryTimeZone || defaultTimeZone || window.TimeZoneUtils?.getCurrentTimeZone()
      });
      newIds.push(id);
    }
    
    // 更新最后提取的消息索引 (修复每轮都提取的Bug)
    if (this._tempLastMsgIndex !== undefined && this._tempLastMsgIndex !== -1) {
      vm.settings.lastExtractedMsgIndex = this._tempLastMsgIndex;
    }window.vectorMemoryManager.getEmbedding

    return newIds;
  }

  // 统一判断是否已向量化：只看后端确认的状态，不依赖或保存真实向量数组。
  hasFragmentEmbedding(frag) {
    if (!frag) return false;

    if (frag.hasEmbedding === true || frag._hasEmbedding === true) {
      return true;
    }

    return false;
  }

  // 获取状态和待提取信息
  getStats(chat) {
    const vm = this.getVariableMemory(chat);
    const frags = vm.fragments || [];
    
    // 基于消息索引计算未提取消息数；计数口径排除隐藏消息、情侣空间分享和思维链块
    const lastIdx = vm.settings.lastExtractedMsgIndex !== undefined ? vm.settings.lastExtractedMsgIndex : -1;
    const unextractedMessages = typeof window.getMemorySummaryCountableMessagesAfterIndex === 'function'
      ? window.getMemorySummaryCountableMessagesAfterIndex(chat, lastIdx).length
      : (chat.history || []).slice(lastIdx + 1).filter(m =>
          m &&
          (!m.isHidden || (m.role === 'system' && m.content && m.content.includes('内心独白'))) &&
          m.type !== 'thought_chain_block' &&
          !(typeof m.content === 'string' && m.content.includes('我分享了一条情侣空间记录') && m.content.includes('[情侣空间分享｜'))
        ).length;
    
    const autoInterval = vm.settings.autoExtractionMsgInterval || 20;
    const remainingToAuto = Math.max(0, autoInterval - unextractedMessages);
    
       const embeddedCount = frags.filter(f => this.hasFragmentEmbedding(f)).length;
    let embeddingHealth = frags.length === 0 ? 'empty' : (embeddedCount === frags.length ? 'perfect' : (embeddedCount > 0 ? 'partial' : 'failed'));

    return {
      totalFragments: frags.length,
      coreMemories: frags.filter(f => f.category === 'C').length,
      embeddedCount,
      embeddingHealth,
      unextractedMessages,
      autoInterval,
      remainingToAuto
    };
  }

  // ==================== UI 面板渲染 ====================

  getOrganizationChatId(chat) {
    return String(chat?.id || chat?.chatId || window.state?.activeChatId || '');
  }

  rerenderMemoryPanel(chat, container) {
    if (typeof window.renderVectorMemoryView === 'function') {
      window.renderVectorMemoryView();
      return;
    }
    this.renderMemoryUI(chat, container);
  }

  renderMemoryPanelSwitcher(chat, container, activeView) {
    const switcher = document.createElement('div');
    switcher.className = 'vm-view-switcher';
    switcher.innerHTML = `
      <button type="button" class="vm-view-switch ${activeView === 'memories' ? 'active' : ''}" data-view="memories">单条记忆</button>
      <button type="button" class="vm-view-switch ${activeView === 'clusters' ? 'active' : ''}" data-view="clusters">记忆簇预览</button>
      <button type="button" class="vm-view-switch ${activeView === 'plans' ? 'active' : ''}" data-view="plans">计划与事实</button>
    `;
    switcher.querySelectorAll('.vm-view-switch').forEach(button => {
      button.addEventListener('click', () => {
        const vm = this.getVariableMemory(chat);
        const nextView = ['clusters', 'plans'].includes(button.dataset.view) ? button.dataset.view : 'memories';
        if ((vm._panelView || 'memories') === nextView) return;
        vm._panelView = nextView;
        this.rerenderMemoryPanel(chat, container);
      });
    });
    container.appendChild(switcher);
  }

  async renderOrganizationPreviewUI(chat, container) {
    const vm = this.getVariableMemory(chat);
    const body = document.createElement('div');
    body.className = 'vm-organization-view';
    body.innerHTML = '<div class="vm-organization-loading">正在读取预览层…</div>';
    container.appendChild(body);

    if (!this.isExternalMemoryEnabled(chat)) {
      body.innerHTML = `
        <div class="vm-organization-empty">
          <div class="vm-organization-empty-title">记忆簇预览仅存在于服务器</div>
          <div>请先在向量记忆设置中启用外部 memory-server。</div>
        </div>
      `;
      return;
    }

    const chatId = this.getOrganizationChatId(chat);
    const query = chatId ? `?chatId=${encodeURIComponent(chatId)}` : '';
    try {
      const statusResult = await this.externalMemoryRequest(chat, `/memory/organization/status${query}`, { method: 'GET' });
      if (!statusResult?.ok || !statusResult.organization) throw new Error('服务器未返回整理状态');
      if ((this.getVariableMemory(chat)._panelView || 'memories') !== 'clusters') return;
      vm._organizationStatus = statusResult.organization;
      vm._organizationTab = vm._organizationTab || 'event';
      this.renderOrganizationPreviewShell(chat, body, statusResult.organization);
    } catch (error) {
      body.innerHTML = `
        <div class="vm-organization-empty">
          <div class="vm-organization-empty-title">暂时无法读取记忆簇</div>
          <div>${this._escapeHtml(error.message || String(error))}</div>
          <button type="button" class="vm-toolbar-btn vm-organization-retry">重新加载</button>
        </div>
      `;
      body.querySelector('.vm-organization-retry')?.addEventListener('click', () => {
        this.rerenderMemoryPanel(chat, container);
      });
    }
  }

  getOrganizationCount(status, kind) {
    return (status?.clusters || [])
      .filter(row => row.kind === kind)
      .reduce((sum, row) => sum + Number(row.count || 0), 0);
  }

  renderOrganizationPreviewShell(chat, body, status) {
    const vm = this.getVariableMemory(chat);
    const byStatus = status.byStatus || {};
    const queuePending = Number(status.queue?.pending || 0);
    const eventCount = this.getOrganizationCount(status, 'event');
    const topicCount = this.getOrganizationCount(status, 'topic');
    body.innerHTML = `
      <div class="vm-preview-warning">
        <strong>只读预览</strong>
        <span>这些分组不会合并原记忆，也不会参与召回或提示词。</span>
      </div>
      <div class="vm-organization-stats">
        <span>事件候选 ${eventCount}</span>
        <span>主题候选 ${topicCount}</span>
        <span>独立记忆 ${Number(byStatus.preview_independent || 0)}</span>
        <span>核心记忆 ${Number(byStatus.preview_protected_core || 0)}</span>
        <span>待整理 ${queuePending}</span>
      </div>
      <div class="vm-organization-tabs">
        <button type="button" data-tab="event">事件候选</button>
        <button type="button" data-tab="topic">主题候选</button>
        <button type="button" data-tab="independent">独立记忆</button>
        <button type="button" data-tab="core">核心记忆</button>
      </div>
      <div class="vm-organization-content"></div>
    `;
    const activate = tab => {
      vm._organizationTab = tab;
      body.querySelectorAll('.vm-organization-tabs button').forEach(button => {
        button.classList.toggle('active', button.dataset.tab === tab);
      });
      this.loadOrganizationPreviewTab(chat, body, tab, 0);
    };
    body.querySelectorAll('.vm-organization-tabs button').forEach(button => {
      button.addEventListener('click', () => activate(button.dataset.tab));
    });
    activate(vm._organizationTab || 'event');
  }

  async loadOrganizationPreviewTab(chat, body, tab, offset = 0) {
    const vm = this.getVariableMemory(chat);
    const requestSequence = Number(vm._organizationRequestSequence || 0) + 1;
    vm._organizationRequestSequence = requestSequence;
    const content = body.querySelector('.vm-organization-content');
    if (!content) return;
    content.innerHTML = '<div class="vm-organization-loading">正在加载…</div>';
    const chatId = this.getOrganizationChatId(chat);
    const chatQuery = chatId ? `&chatId=${encodeURIComponent(chatId)}` : '';
    try {
      if (tab === 'event' || tab === 'topic') {
        const result = await this.externalMemoryRequest(
          chat,
          `/memory/organization/clusters?kind=${encodeURIComponent(tab)}&status=preview&limit=1000&includeMembers=false${chatQuery}`,
          { method: 'GET' }
        );
        if (!result?.ok) throw new Error('簇列表读取失败');
        if (vm._organizationRequestSequence !== requestSequence || vm._organizationTab !== tab) return;
        this.renderOrganizationClusters(content, result.clusters || [], tab, chat);
        return;
      }

      const statusName = tab === 'core' ? 'preview_protected_core' : 'preview_independent';
      const result = await this.externalMemoryRequest(
        chat,
        `/memory/organization/memories?status=${encodeURIComponent(statusName)}&limit=50&offset=${offset}${chatQuery}`,
        { method: 'GET' }
      );
      if (!result?.ok) throw new Error('记忆列表读取失败');
      if (vm._organizationRequestSequence !== requestSequence || vm._organizationTab !== tab) return;
      this.renderOrganizationEntries(content, result, tab, chat, body);
    } catch (error) {
      if (vm._organizationRequestSequence !== requestSequence || vm._organizationTab !== tab) return;
      content.innerHTML = `<div class="vm-organization-empty">${this._escapeHtml(error.message || String(error))}</div>`;
    }
  }

  renderOrganizationClusters(content, clusters, kind, chat) {
    if (!clusters.length) {
      content.innerHTML = '<div class="vm-organization-empty">当前没有预览簇。</div>';
      return;
    }
    const label = kind === 'event' ? '事件候选' : '主题候选';
    content.innerHTML = `<div class="vm-cluster-list"></div>`;
    const list = content.querySelector('.vm-cluster-list');
    clusters.forEach(cluster => {
      const card = document.createElement('details');
      card.className = 'vm-cluster-card';
      const subtypeLabels = {
        event_candidate: '单次事件候选',
        ongoing_episode_candidate: '持续事件候选',
        habit_candidate: '习惯候选',
        stable_fact_candidate: '稳定事实候选',
        topic_candidate: '主题候选',
        type_uncertain: '类型待确认'
      };
      const subtypeLabel = subtypeLabels[cluster.subtype] || '类型待确认';
      card.innerHTML = `
        <summary>
          <span class="vm-cluster-kind">${label}</span>
          <span class="vm-cluster-title">${this._escapeHtml(cluster.title || '待确认记忆组')}</span>
          <span class="vm-cluster-count">${Number(cluster.memberCount || 0)}条</span>
        </summary>
        <div class="vm-cluster-meta">
          <span>${subtypeLabel}</span>
          <span>簇置信度 ${Number(cluster.confidence || 0).toFixed(2)}</span>
          <span>预览，不参与召回</span>
        </div>
        <div class="vm-cluster-members"><div class="vm-organization-loading">展开后读取成员原文…</div></div>
      `;
      card.addEventListener('toggle', () => {
        if (!card.open) {
          this.unloadOrganizationClusterMembers(card);
          return;
        }
        list.querySelectorAll('.vm-cluster-card[open]').forEach(other => {
          if (other !== card) other.open = false;
        });
        if (card.dataset.loaded !== 'true' && card.dataset.loaded !== 'loading') {
          this.loadOrganizationClusterMembers(chat, card, cluster.id);
        }
      });
      list.appendChild(card);
    });
  }

  unloadOrganizationClusterMembers(card) {
    const memberContainer = card.querySelector('.vm-cluster-members');
    card.dataset.requestSequence = String(Number(card.dataset.requestSequence || 0) + 1);
    card.dataset.loaded = 'false';
    if (memberContainer) {
      memberContainer.innerHTML = '<div class="vm-organization-loading">展开后读取成员原文…</div>';
    }
  }

  async loadOrganizationClusterMembers(chat, card, clusterId) {
    const memberContainer = card.querySelector('.vm-cluster-members');
    if (!memberContainer) return;
    const requestSequence = Number(card.dataset.requestSequence || 0) + 1;
    card.dataset.requestSequence = String(requestSequence);
    card.dataset.loaded = 'loading';
    const chatId = this.getOrganizationChatId(chat);
    const chatQuery = chatId ? `&chatId=${encodeURIComponent(chatId)}` : '';
    try {
      const result = await this.externalMemoryRequest(
        chat,
        `/memory/organization/clusters?clusterId=${encodeURIComponent(clusterId)}&limit=1&memberLimit=100${chatQuery}`,
        { method: 'GET' }
      );
      const cluster = Array.isArray(result?.clusters) ? result.clusters[0] : null;
      if (!result?.ok || !cluster) throw new Error('簇成员读取失败');
      if (!card.open || Number(card.dataset.requestSequence || 0) !== requestSequence) return;
      const members = Array.isArray(cluster.members) ? cluster.members : [];
      memberContainer.innerHTML = `
        ${members.map(member => `
          <article class="vm-cluster-member">
            <div>${this._escapeHtml(member.content || '')}</div>
            <div class="vm-cluster-member-meta">
              <span>${this._escapeHtml(member.category || '')}</span>
              <span>重要度 ${Number(member.importance || 0)}</span>
              <span>${this._escapeHtml(this.formatOrganizationTime(member.memoryTime))}</span>
            </div>
          </article>
        `).join('') || '<div class="vm-organization-empty">该簇没有可显示的成员。</div>'}
        ${cluster.hasMoreMembers ? '<div class="vm-organization-note">该簇还有更多成员未在本页展开。</div>' : ''}
      `;
      card.dataset.loaded = 'true';
    } catch (error) {
      if (!card.open || Number(card.dataset.requestSequence || 0) !== requestSequence) return;
      card.dataset.loaded = 'false';
      memberContainer.innerHTML = `<div class="vm-organization-empty">${this._escapeHtml(error.message || String(error))}</div>`;
    }
  }

  renderOrganizationEntries(content, result, tab, chat, body) {
    const entries = Array.isArray(result.entries) ? result.entries : [];
    const title = tab === 'core' ? '受保护的核心记忆' : '尚未进入可靠簇的独立记忆';
    content.innerHTML = `
      <div class="vm-organization-note">${title} · ${Number(result.total || 0)}条</div>
      <div class="vm-organization-entry-list">
        ${entries.map(entry => `
          <article class="vm-organization-entry">
            <div>${this._escapeHtml(entry.content || '')}</div>
            <div class="vm-cluster-member-meta">
              <span>${this._escapeHtml(entry.category || '')}</span>
              <span>重要度 ${Number(entry.importance || 0)}</span>
              <span>${this._escapeHtml(this.formatOrganizationTime(entry.memoryTime))}</span>
            </div>
          </article>
        `).join('') || '<div class="vm-organization-empty">暂无记录。</div>'}
      </div>
      <div class="vm-organization-pager"></div>
    `;
    const pager = content.querySelector('.vm-organization-pager');
    if (Number(result.offset || 0) > 0) {
      const previous = document.createElement('button');
      previous.className = 'vm-toolbar-btn';
      previous.textContent = '上一页';
      previous.addEventListener('click', () => this.loadOrganizationPreviewTab(chat, body, tab, Math.max(0, Number(result.offset) - Number(result.limit || 50))));
      pager.appendChild(previous);
    }
    if (result.hasMore) {
      const next = document.createElement('button');
      next.className = 'vm-toolbar-btn';
      next.textContent = '下一页';
      next.addEventListener('click', () => this.loadOrganizationPreviewTab(chat, body, tab, Number(result.offset || 0) + Number(result.limit || 50)));
      pager.appendChild(next);
    }
  }

  // ==================== 计划与事实面板 ====================
  // 这一块只操作 memory-server 的 memory_active_events / memory_current_facts 两张表，
  // 与「向量记忆」（memories 表 + Chroma 向量索引）完全无关：任何查看/编辑/删除
  // 都不会碰单条记忆和向量，也不会影响「单条记忆」「记忆簇预览」两个既有视图。

  // ==================== 事实槽位选择器 ====================
  // 抽取器实际会产生的槽位就这 5 类，全部列出来供选择（手机上下拉框比 datalist 可靠）。

  getFactSlotTypeOptions() {
    return [
      { value: 'user.residence.current', label: '居住地（你住在哪）' },
      { value: 'user.location.current', label: '当前所在地（你现在在哪）' },
      { value: 'user.trip.current', label: '行程状态（出差 / 旅行中）' },
      { value: 'user.task.', label: '任务进行状态（需填任务名）' },
      { value: 'user.body.', label: '身体状态（需选部位）' },
      { value: '__custom__', label: '自定义槽位（手动输入完整 key）' }
    ];
  }

  getFactBodyPartOptions() {
    return [
      { value: 'menstrual_cycle', label: '生理期' },
      { value: 'allergy', label: '过敏' },
      { value: 'asthma', label: '哮喘' },
      { value: 'cold', label: '感冒' },
      { value: 'fever', label: '发烧' },
      { value: 'cough', label: '咳嗽' },
      { value: 'head_pain', label: '头疼' },
      { value: 'abdominal_pain', label: '肚子疼' },
      { value: 'stomach_pain', label: '胃疼' },
      { value: 'chest_tightness', label: '胸闷' },
      { value: 'hypoxia', label: '缺氧' },
      { value: 'dizziness', label: '头晕' },
      { value: 'nausea', label: '恶心' },
      { value: 'general_discomfort', label: '身体不舒服' }
    ];
  }

  // 「类型 + 子键」→ 完整槽位（纯函数，便于测试）
  resolveFactSlotKey(input = {}) {
    const type = String(input.type || '').trim();
    if (type === '__custom__') return String(input.customKey || '').trim();
    if (type === 'user.task.') {
      const name = String(input.taskName || '').trim();
      return name ? `user.task.${name}` : '';
    }
    if (type === 'user.body.') {
      const part = String(input.bodyKey || '').trim();
      return part ? `user.body.${part}` : '';
    }
    return type;
  }

  // 把已有槽位反解成「类型 + 子键」，用于编辑时预填
  splitFactSlotKey(slotKey) {
    const key = String(slotKey || '').trim();
    if (key.startsWith('user.task.')) {
      return { type: 'user.task.', taskName: key.slice('user.task.'.length) };
    }
    if (key.startsWith('user.body.')) {
      return { type: 'user.body.', bodyKey: key.slice('user.body.'.length) };
    }
    const known = this.getFactSlotTypeOptions().some(option => option.value === key);
    if (known) return { type: key };
    return { type: '__custom__', customKey: key };
  }

  buildFactSlotPickerHtml(slotKey = 'user.residence.current') {
    const escape = value => this._escapeHtml(value);
    const parsed = this.splitFactSlotKey(slotKey);
    const typeOptions = this.getFactSlotTypeOptions()
      .map(option => `<option value="${escape(option.value)}" ${parsed.type === option.value ? 'selected' : ''}>${escape(option.label)}</option>`)
      .join('');
    const bodyOptions = this.getFactBodyPartOptions()
      .map(option => `<option value="${escape(option.value)}" ${parsed.bodyKey === option.value ? 'selected' : ''}>${escape(option.label)}</option>`)
      .join('');
    return `
      <select class="vm-input-full" data-field="slotType">${typeOptions}</select>
      <input class="vm-input-full" data-field="taskName" placeholder="任务名，例如 论文"
             value="${escape(parsed.taskName || '')}" style="display:none">
      <select class="vm-input-full" data-field="bodyKey" style="display:none">${bodyOptions}</select>
      <input class="vm-input-full" data-field="customKey" placeholder="完整槽位，例如 user.residence.current"
             value="${escape(parsed.customKey || '')}" style="display:none">
      <div data-role="slot-preview" style="font-size:12px;color:#888;"></div>
    `;
  }

  bindFactSlotPicker(form) {
    if (!form) return;
    const typeEl = form.querySelector('[data-field="slotType"]');
    const taskEl = form.querySelector('[data-field="taskName"]');
    const bodyEl = form.querySelector('[data-field="bodyKey"]');
    const customEl = form.querySelector('[data-field="customKey"]');
    const previewEl = form.querySelector('[data-role="slot-preview"]');
    if (!typeEl) return;

    const refresh = () => {
      const type = String(typeEl.value || '');
      if (taskEl) taskEl.style.display = type === 'user.task.' ? '' : 'none';
      if (bodyEl) bodyEl.style.display = type === 'user.body.' ? '' : 'none';
      if (customEl) customEl.style.display = type === '__custom__' ? '' : 'none';
      const resolved = this.resolveFactSlotKey({
        type,
        taskName: taskEl?.value,
        bodyKey: bodyEl?.value,
        customKey: customEl?.value
      });
      if (previewEl) {
        previewEl.textContent = resolved ? `最终槽位：${resolved}` : '最终槽位：（还没填完整）';
      }
    };

    [typeEl, taskEl, bodyEl, customEl].forEach(element => {
      element?.addEventListener('change', refresh);
      element?.addEventListener('input', refresh);
    });
    refresh();
  }

  readFactSlotKeyFromForm(form) {
    if (!form) return '';
    return this.resolveFactSlotKey({
      type: form.querySelector('[data-field="slotType"]')?.value,
      taskName: form.querySelector('[data-field="taskName"]')?.value,
      bodyKey: form.querySelector('[data-field="bodyKey"]')?.value,
      customKey: form.querySelector('[data-field="customKey"]')?.value
    });
  }

  // 读取页面实际加载的 vector-memory.js 的 ?v= 参数。
  // 用来一眼确认「新代码到底有没有生效」——如果面板上显示的还是旧版本号，
  // 就说明手机/浏览器在用缓存里的旧脚本，而不是代码没改对。
  getPanelBuildTag() {
    try {
      if (typeof document === 'undefined') return 'unknown';
      const scripts = Array.from(document.getElementsByTagName('script') || []);
      const script = scripts.find(item => String(item.src || '').includes('vector-memory.js'));
      const match = script ? String(script.src).match(/[?&]v=([^&]+)/) : null;
      return match ? match[1] : 'dev';
    } catch (error) {
      return 'unknown';
    }
  }

  formatPlanPanelTime(value) {
    const timestamp = Number(value);
    if (!Number.isFinite(timestamp) || timestamp <= 0) return '';
    const timeZone = window.TimeZoneUtils?.getCurrentTimeZone?.() || 'UTC';
    const formatted = window.TimeZoneUtils?.format?.(timestamp, timeZone);
    if (formatted) return formatted;
    const date = new Date(timestamp);
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
  }

  toPlanPanelInputValue(value) {
    const timestamp = Number(value);
    if (!Number.isFinite(timestamp) || timestamp <= 0) return '';
    const timeZone = window.TimeZoneUtils?.getCurrentTimeZone?.() || 'UTC';
    return window.TimeZoneUtils?.toDateTimeLocal?.(timestamp, timeZone) || '';
  }

  parsePlanPanelInputValue(value) {
    const text = String(value || '').trim();
    if (!text) return null;
    const timeZone = window.TimeZoneUtils?.getCurrentTimeZone?.() || 'UTC';
    const parsed = window.TimeZoneUtils?.fromDateTimeLocal?.(text, timeZone);
    return Number.isFinite(parsed) ? Number(parsed) : null;
  }

  getPlanStatusLabel(status, expired = false) {
    if (expired && !['completed', 'cancelled', 'archived'].includes(String(status))) return '已过期';
    return {
      candidate: '待确认',
      planned: '待办',
      active: '进行中',
      completed: '已完成',
      cancelled: '已取消',
      expired: '已过期',
      archived: '已归档'
    }[String(status)] || String(status || '');
  }

  getFinishedPlanStatuses() {
    return ['completed', 'cancelled', 'expired', 'archived'];
  }

  // 计划列表的过滤/排序/归一化（纯函数，便于测试）
  normalizePlanPanelList(events, options = {}) {
    const now = Number(options.now || Date.now());
    const includeFinished = options.includeFinished === true;
    const finishedStatuses = this.getFinishedPlanStatuses();
    return (Array.isArray(events) ? events : [])
      .filter(event => event && event.id)
      .map(event => {
        const status = String(event.status || 'planned');
        const validUntil = Number(event.validUntil || 0) || null;
        return {
          id: String(event.id),
          title: String(event.title || event.summary || '').trim(),
          status,
          startAt: Number(event.startAt || 0) || null,
          validUntil,
          confidence: Number(event.confidence || 0),
          manual: event?.evidence?.manual === true,
          // 还在等角色答复的征询句：不算生效中的计划，也不注入提示词
          pending: event.awaitingConfirmation === true || Number(event.awaitingConfirmation || 0) === 1,
          confirmDeadline: Number(event.confirmDeadline || 0) || null,
          deleted: status === 'archived',
          finished: finishedStatuses.includes(status),
          expired: Boolean(validUntil) && Number(validUntil) < now
        };
      })
      .filter(plan => includeFinished || (!plan.finished && !plan.expired))
      .sort((a, b) => {
        const aDone = (a.finished || a.expired) ? 1 : 0;
        const bDone = (b.finished || b.expired) ? 1 : 0;
        if (aDone !== bDone) return aDone - bDone;
        return Number(a.startAt || 0) - Number(b.startAt || 0);
      });
  }

  // 事实列表：同一 slotKey 只展示最新一条，历史版本收进 versions（纯函数，便于测试）
  normalizeFactPanelList(facts) {
    const bySlot = new Map();
    for (const fact of (Array.isArray(facts) ? facts : [])) {
      if (!fact || !fact.id) continue;
      const slotKey = String(fact.slotKey || '(未分类)');
      const item = {
        id: String(fact.id),
        chatId: String(fact.chatId || ''),
        subjectKey: String(fact.subjectKey || 'user'),
        slotKey,
        value: String(fact.value || ''),
        statement: String(fact.statement || fact.value || ''),
        status: String(fact.status || ''),
        factType: String(fact.factType || ''),
        confidence: Number(fact.confidence || 0),
        effectiveAt: Number(fact.effectiveAt || 0) || null,
        updatedAt: Number(fact.updatedAt || 0) || null
      };
      const entry = bySlot.get(slotKey) || { slotKey, current: null, versions: [] };
      entry.versions.push(item);
      // 只有「有效」的版本才有资格当该槽位的当前值；被删除/作废的只作历史留档
      const eligible = ['current', 'shadow_candidate'].includes(item.status);
      const at = Number(item.effectiveAt || item.updatedAt || 0);
      const currentAt = entry.current ? Number(entry.current.effectiveAt || entry.current.updatedAt || 0) : -1;
      if (eligible && (!entry.current || at >= currentAt)) entry.current = item;
      bySlot.set(slotKey, entry);
    }
    return [...bySlot.values()]
      // 该槽位的版本全被删除/作废时整组不再显示
      .filter(entry => entry.current)
      .map(entry => ({
        ...entry,
        versions: entry.versions
          .slice()
          .sort((a, b) => Number(b.effectiveAt || b.updatedAt || 0) - Number(a.effectiveAt || a.updatedAt || 0))
      }))
      .sort((a, b) => String(a.slotKey).localeCompare(String(b.slotKey)));
  }

  // 写接口的请求体（纯函数，便于测试）
  buildPlanUpsertBody(event, changes = {}) {
    const pick = (field, fallback) => (changes[field] !== undefined ? changes[field] : fallback);
    const title = String(pick('title', event?.title || '')).trim().slice(0, 200);
    return {
      confirm: 'UPSERT_ACTIVE_EVENT',
      event: {
        id: String(event?.id || ''),
        chatId: String(event?.chatId || ''),
        title,
        summary: String(pick('summary', event?.summary || event?.title || title)).slice(0, 500),
        status: String(pick('status', event?.status || 'planned')),
        startAt: Number(pick('startAt', event?.startAt || 0)) || null,
        endAt: Number(pick('endAt', event?.endAt || 0)) || null,
        validUntil: Number(pick('validUntil', event?.validUntil || 0)) || null,
        surfaceMode: String(event?.surfaceMode || 'manual_only'),
        proactiveMention: event?.proactiveMention === true,
        // 待确认状态必须原样带回：否则编辑一下「征询句」就会绕过角色确认直接生效
        awaitingConfirmation: Number(pick('awaitingConfirmation', event?.awaitingConfirmation ? 1 : 0)) === 1,
        confirmDeadline: Number(pick('confirmDeadline', event?.confirmDeadline || 0)) || null,
        aliases: Array.isArray(event?.aliases) ? event.aliases : [],
        confidence: Number(event?.confidence || 0),
        // 必须原样带回 evidence：否则每次编辑都会把该条计划的写入/审计历史清空
        evidence: pick('evidence', event?.evidence || {}),
        createdAt: Number(event?.createdAt || 0) || undefined
      }
    };
  }

  buildPlanArchiveBody(id, status = 'archived') {
    return { confirm: 'ARCHIVE_ACTIVE_EVENT', id: String(id || ''), status: String(status || 'archived') };
  }

  buildFactInvalidateBody(id, status = 'archived') {
    return { confirm: 'INVALIDATE_CURRENT_FACT', id: String(id || ''), status: String(status || 'archived') };
  }

  buildFactPromoteBody(id) {
    return { confirm: 'PROMOTE_CURRENT_FACT', id: String(id || '') };
  }

  notifyPlanPanel(message, isError = false) {
    if (!isError && typeof window.showToast === 'function') {
      window.showToast(message, 'success');
      return;
    }
    if (typeof window.showCustomAlert === 'function') {
      window.showCustomAlert(isError ? '操作失败' : '提示', message);
      return;
    }
    console.warn('[变量记忆] ' + message);
  }

  // 面板内联确认。
  // 刻意不依赖全局的 showCustomConfirm：index.html 里有 8 个 id="custom-modal" 的元素，
  // getElementById 只绑得到第一个，弹窗可能渲染在隐藏容器里、或被面板浮层盖住
  // （实测点「删除」毫无反应就是这个原因）。内联确认就展开在你点的那一行下面，不会有层级问题。
  askInlineConfirm(host, message, onConfirm) {
    if (!host) return;
    host.querySelectorAll('[data-inline-confirm]').forEach(node => node.remove());
    const box = document.createElement('div');
    box.dataset.inlineConfirm = '1';
    box.style.cssText = 'margin-top:8px;padding:8px 10px;border-radius:10px;'
      + 'background:rgba(255,59,48,0.08);border:1px solid rgba(255,59,48,0.35);'
      + 'display:flex;flex-direction:column;gap:8px;';
    box.innerHTML = `
      <div style="font-size:13px;line-height:1.5;word-break:break-word;">${this._escapeHtml(message)}</div>
      <div style="display:flex;gap:8px;">
        <button class="vm-toolbar-btn" data-inline="yes" style="color:#ff3b30">确认</button>
        <button class="vm-toolbar-btn" data-inline="no">取消</button>
      </div>
    `;
    box.querySelector('[data-inline="no"]').addEventListener('click', () => box.remove());
    box.querySelector('[data-inline="yes"]').addEventListener('click', () => {
      box.remove();
      onConfirm();
    });
    host.appendChild(box);
  }

  askDeletePlan(chat, body, data, planId, row) {
    const raw = (data.events || []).find(event => String(event.id) === String(planId));
    if (!raw) return;
    this.askInlineConfirm(
      row,
      `确认要彻底删除这条计划吗？\n\n${raw.title || '(无标题)'}\n\n删除后无法恢复、也无法撤回。想保留的话请改用「归档」。`,
      () => this.applyPlanPanelAction(chat, body, data, planId, 'delete')
    );
  }

  askDeleteFact(chat, body, group, card) {
    const fact = group?.current;
    if (!fact) return;
    this.askInlineConfirm(
      card,
      `确认要彻底删除这条事实吗？\n\n${group.slotKey}\n${fact.statement || fact.value || ''}\n\n删除后无法恢复。`,
      () => this.applyFactPanelAction(chat, body, group, 'delete')
    );
  }

  async renderPlanFactPanel(chat, container) {
    if (!container) return;
    container.querySelectorAll('[data-plan-fact-body]').forEach(node => node.remove());

    const body = document.createElement('div');
    body.className = 'vm-organization-view';
    body.dataset.planFactBody = '1';
    body.innerHTML = '<div class="vm-organization-loading">正在读取计划与事实…</div>';
    container.appendChild(body);

    if (!this.isExternalMemoryEnabled(chat)) {
      body.innerHTML = `
        <div class="vm-organization-empty">
          <div class="vm-organization-empty-title">计划与事实只存在于服务器</div>
          <div>请先在上方设置中启用外部 memory-server。</div>
        </div>
      `;
      return;
    }

    const chatId = this.getOrganizationChatId(chat);
    if (!chatId) {
      body.innerHTML = `
        <div class="vm-organization-empty">
          <div class="vm-organization-empty-title">无法确定当前会话</div>
          <div>请先打开一个聊天再查看计划与事实。</div>
        </div>
      `;
      return;
    }

    try {
      const query = `chatId=${encodeURIComponent(chatId)}`;
      const [eventsResult, factsResult] = await Promise.all([
        this.externalMemoryRequest(chat, `/memory/active-events?${query}&includeArchived=true&limit=100`, { method: 'GET' }),
        this.externalMemoryRequest(chat, `/memory/current-facts?${query}&includeInactive=true&limit=200`, { method: 'GET' })
      ]);
      if ((this.getVariableMemory(chat)._panelView || 'memories') !== 'plans') return;
      this.renderPlanFactShell(chat, body, {
        chatId,
        now: Date.now(),
        events: Array.isArray(eventsResult?.events) ? eventsResult.events : [],
        facts: Array.isArray(factsResult?.facts) ? factsResult.facts : []
      });
    } catch (error) {
      body.innerHTML = `
        <div class="vm-organization-empty">
          <div class="vm-organization-empty-title">暂时无法读取计划与事实</div>
          <div>${this._escapeHtml(error.message || String(error))}</div>
          <button type="button" class="vm-toolbar-btn" data-action="reload">重新加载</button>
        </div>
      `;
      body.querySelector('[data-action="reload"]')?.addEventListener('click', () => {
        this.renderPlanFactPanel(chat, container);
      });
    }
  }

  renderPlanFactShell(chat, body, data) {
    const vm = this.getVariableMemory(chat);
    const tab = vm._planFactTab === 'facts' ? 'facts' : 'plans';
    const escape = value => this._escapeHtml(value);
    const plans = this.normalizePlanPanelList(data.events, { includeFinished: true, now: data.now });
    const pendingPlans = plans.filter(plan => !plan.deleted && !plan.finished && !plan.expired && plan.pending);
    const livePlans = plans.filter(plan => !plan.deleted && !plan.finished && !plan.expired && !plan.pending);
    const historyPlans = plans.filter(plan => !plan.deleted && (plan.finished || plan.expired));
    const deletedPlans = plans.filter(plan => plan.deleted);
    const factGroups = this.normalizeFactPanelList(data.facts);

    const planRow = plan => {
      const isLive = !plan.deleted && !plan.finished && !plan.expired;
      return `
      <div data-plan-id="${escape(plan.id)}" style="padding:10px 12px;border-radius:12px;background:rgba(0,0,0,0.035);margin-bottom:8px;">
        <div style="display:flex;gap:8px;align-items:flex-start;">
          <div style="flex:1;min-width:0;">
            <div style="font-size:14px;line-height:1.5;word-break:break-word;">${escape(plan.title || '(无标题)')}</div>
            <div style="font-size:12px;color:#888;margin-top:4px;line-height:1.5;">
              ${plan.manual ? '手动添加｜' : ''}${escape(this.getPlanStatusLabel(plan.status, plan.expired))}${plan.startAt ? '｜开始 ' + escape(this.formatPlanPanelTime(plan.startAt)) : ''}${plan.validUntil ? '｜有效至 ' + escape(this.formatPlanPanelTime(plan.validUntil)) : ''}｜置信度 ${plan.confidence.toFixed(2)}
              ${plan.pending ? '<br>等角色答复后自动定案；' + (plan.confirmDeadline ? '截止 ' + escape(this.formatPlanPanelTime(plan.confirmDeadline)) : '超时未答复按过期处理') + '，期间不注入提示词' : ''}
            </div>
          </div>
          <div style="display:flex;gap:6px;flex-shrink:0;flex-wrap:wrap;justify-content:flex-end;">
            ${plan.pending
              ? '<button class="vm-toolbar-btn" data-action="edit">编辑</button>'
                + '<button class="vm-toolbar-btn" data-action="archive">归档</button>'
              : (isLive
                ? '<button class="vm-toolbar-btn" data-action="edit">编辑</button>'
                  + '<button class="vm-toolbar-btn" data-action="complete">完成</button>'
                  + '<button class="vm-toolbar-btn" data-action="archive">归档</button>'
                : '<button class="vm-toolbar-btn" data-action="restore">撤回</button>')}
            <button class="vm-toolbar-btn" data-action="delete" style="color:#ff3b30">删除</button>
          </div>
        </div>
      </div>
    `;
    };

    const factCard = group => {
      const isCurrent = group.current?.status === 'current';
      return `
      <div data-fact-slot="${escape(group.slotKey)}" style="padding:10px 12px;border-radius:12px;background:rgba(0,0,0,0.035);margin-bottom:8px;">
        <div style="display:flex;gap:8px;align-items:flex-start;">
          <div style="flex:1;min-width:0;">
            <div style="font-size:12px;color:#888;word-break:break-all;">
              ${escape(group.slotKey)}
              <span style="color:${isCurrent ? '#22c55e' : '#999'};">${isCurrent ? '｜✓ 已注入提示词' : '｜候选（不注入）'}</span>
            </div>
            <div style="font-size:14px;line-height:1.5;margin-top:4px;word-break:break-word;">${escape(group.current?.statement || group.current?.value || '(空)')}</div>
            <div style="font-size:12px;color:#888;margin-top:4px;line-height:1.5;">
              ${group.current?.effectiveAt ? '记录于 ' + escape(this.formatPlanPanelTime(group.current.effectiveAt)) + '｜' : ''}${escape(group.current?.status || '')}｜置信度 ${Number(group.current?.confidence || 0).toFixed(2)}${group.versions.length > 1 ? '｜历史版本 ' + (group.versions.length - 1) : ''}
            </div>
          </div>
          <div style="display:flex;gap:6px;flex-shrink:0;flex-wrap:wrap;justify-content:flex-end;">
            <button class="vm-toolbar-btn" data-fact-action="edit">编辑</button>
            ${isCurrent ? '' : '<button class="vm-toolbar-btn" data-fact-action="promote">设为当前</button>'}
            <button class="vm-toolbar-btn" data-fact-action="delete" style="color:#ff3b30">删除</button>
          </div>
        </div>
      </div>
    `;
    };

    const plansHtml = tab !== 'plans' ? '' : `
      <div data-plan-create-host></div>
      <div style="font-size:13px;color:#666;margin:10px 0 6px;">生效中的计划（会每轮注入提示词）</div>
      ${livePlans.length ? livePlans.map(planRow).join('') : '<div style="font-size:13px;color:#999;">当前没有生效中的计划。</div>'}
      ${pendingPlans.length ? `
        <div style="font-size:13px;color:#666;margin:14px 0 6px;">待确认（${pendingPlans.length}）— 你提过但角色还没答应的约定</div>
        <div style="font-size:12px;color:#999;margin-bottom:6px;line-height:1.5;">
          这些是你说出口的征询（如「要不要一起去看奶奶」）。等角色回答后自动定案：答应 → 转生效；拒绝 → 取消；超过截止时间没答复 → 过期。期间不会注入提示词。
        </div>
        ${pendingPlans.map(planRow).join('')}
      ` : ''}
      ${historyPlans.length ? `
        <details style="margin-top:12px;">
          <summary style="cursor:pointer;font-size:13px;color:#666;">已完成 / 已过期（${historyPlans.length}）</summary>
          <div style="margin-top:8px;">${historyPlans.slice(0, 50).map(planRow).join('')}</div>
        </details>
      ` : ''}
      ${deletedPlans.length ? `
        <details style="margin-top:12px;">
          <summary style="cursor:pointer;font-size:13px;color:#666;">已归档（${deletedPlans.length}）— 归档只是收起来，可以撤回</summary>
          <div style="margin-top:8px;">${deletedPlans.slice(0, 50).map(planRow).join('')}</div>
        </details>
      ` : ''}
    `;

    const factsHtml = tab !== 'facts' ? '' : `
      <div data-fact-create-host></div>
      ${factGroups.length ? factGroups.map(factCard).join('') : '<div style="font-size:13px;color:#999;">当前没有任何事实条目。</div>'}
      <div style="font-size:12px;color:#999;margin-top:8px;line-height:1.5;">
        同一槽位只显示最新一条。<strong>只有「当前」状态的事实会注入提示词</strong>，候选态只留档；
        手动添加的事实会自动设为「当前」，自动抽取的会停在候选态等你确认。
      </div>
    `;

    body.innerHTML = `
      <div class="vm-preview-warning">
        <strong>计划与事实（独立于向量记忆｜脚本 v${escape(this.getPanelBuildTag())}）</strong>
        <span>这里只管理计划与事实两张表，任何改动都不会影响「单条记忆」和向量索引。条目里的「我」都指你（用户），「你」指角色。</span>
      </div>
      <div class="vm-toolbar" style="margin-bottom:10px;flex-wrap:wrap;">
        <button class="vm-toolbar-btn ${tab === 'plans' ? 'vm-primary' : ''}" data-tab="plans">计划（${livePlans.length} 生效 / ${pendingPlans.length} 待确认 / ${historyPlans.length} 历史）</button>
        <button class="vm-toolbar-btn ${tab === 'facts' ? 'vm-primary' : ''}" data-tab="facts">事实（${factGroups.length} 个槽位）</button>
        ${tab === 'plans' ? '<button class="vm-toolbar-btn" data-action="add">添加计划</button>' : ''}
        ${tab === 'facts' ? '<button class="vm-toolbar-btn" data-action="add-fact">添加事实</button>' : ''}
        <div style="flex:1"></div>
        ${tab === 'plans'
          ? '<button class="vm-toolbar-btn" data-action="purge-finished">清理过期与已完成</button>'
            + '<button class="vm-toolbar-btn" data-action="purge-archived">清空已归档</button>'
          : ''}
        <button class="vm-toolbar-btn" data-action="reload">刷新</button>
      </div>
      <div data-panel-confirm-host></div>
      ${plansHtml}
      ${factsHtml}
    `;

    body.querySelectorAll('[data-tab]').forEach(button => {
      button.addEventListener('click', () => {
        this.getVariableMemory(chat)._planFactTab = button.dataset.tab === 'facts' ? 'facts' : 'plans';
        this.renderPlanFactShell(chat, body, data);
      });
    });
    body.querySelector('[data-action="reload"]')?.addEventListener('click', () => {
      this.renderPlanFactPanel(chat, body.parentNode);
    });
    body.querySelector('[data-action="purge-finished"]')?.addEventListener('click', () => {
      this.askPurgePlans(chat, body, 'finished', historyPlans.length);
    });
    body.querySelector('[data-action="purge-archived"]')?.addEventListener('click', () => {
      this.askPurgePlans(chat, body, 'archived', deletedPlans.length);
    });
    body.querySelector('[data-action="add"]')?.addEventListener('click', () => {
      this.openPlanCreateForm(chat, body, data);
    });
    body.querySelector('[data-action="add-fact"]')?.addEventListener('click', () => {
      this.openFactCreateForm(chat, body, data);
    });

    body.querySelectorAll('[data-plan-id]').forEach(row => {
      const planId = row.dataset.planId;
      row.querySelectorAll('[data-action]').forEach(button => {
        button.addEventListener('click', () => {
          const action = button.dataset.action;
          if (action === 'edit') {
            this.openPlanEditForm(chat, body, data, planId, row);
            return;
          }
          if (action === 'delete') {
            this.askDeletePlan(chat, body, data, planId, row);
            return;
          }
          this.applyPlanPanelAction(chat, body, data, planId, action);
        });
      });
    });

    body.querySelectorAll('[data-fact-slot]').forEach(card => {
      const group = factGroups.find(item => String(item.slotKey) === String(card.dataset.factSlot));
      card.querySelectorAll('[data-fact-action]').forEach(button => {
        button.addEventListener('click', () => {
          const action = button.dataset.factAction;
          if (action === 'edit') {
            this.openFactEditForm(chat, body, group, card);
            return;
          }
          if (action === 'delete') {
            this.askDeleteFact(chat, body, group, card);
            return;
          }
          this.applyFactPanelAction(chat, body, group, action);
        });
      });
    });
  }

  openPlanEditForm(chat, body, data, planId, row) {
    if (row.querySelector('[data-plan-edit]')) return;
    const plan = (data.events || []).find(event => String(event.id) === String(planId));
    if (!plan) return;

    const form = document.createElement('div');
    form.dataset.planEdit = '1';
    form.style.cssText = 'margin-top:8px;display:flex;flex-direction:column;gap:6px;';
    form.innerHTML = `
      <input class="vm-input-full" data-field="title" value="${this._escapeHtml(plan.title || '')}" placeholder="标题">
      <input class="vm-input-full" data-field="startAt" value="${this._escapeHtml(this.toPlanPanelInputValue(plan.startAt))}" placeholder="开始时间，例如 2026-10-15 09:00">
      <input class="vm-input-full" data-field="validUntil" value="${this._escapeHtml(this.toPlanPanelInputValue(plan.validUntil))}" placeholder="有效至，例如 2026-10-17 23:59">
      <div style="display:flex;gap:8px;">
        <button class="vm-toolbar-btn vm-primary" data-action="save">保存</button>
        <button class="vm-toolbar-btn" data-action="cancel">取消</button>
      </div>
    `;
    form.querySelector('[data-action="cancel"]').addEventListener('click', () => form.remove());
    form.querySelector('[data-action="save"]').addEventListener('click', () => {
      const readField = field => form.querySelector(`[data-field="${field}"]`)?.value || '';
      const title = readField('title').trim();
      if (!title) {
        this.notifyPlanPanel('标题不能为空', true);
        return;
      }
      const startRaw = readField('startAt').trim();
      const untilRaw = readField('validUntil').trim();
      const startAt = startRaw ? this.parsePlanPanelInputValue(startRaw) : null;
      const validUntil = untilRaw ? this.parsePlanPanelInputValue(untilRaw) : null;
      if (startRaw && startAt === null) {
        this.notifyPlanPanel('开始时间无法识别，请用 2026-10-15 09:00 这种写法', true);
        return;
      }
      if (untilRaw && validUntil === null) {
        this.notifyPlanPanel('有效至无法识别，请用 2026-10-17 23:59 这种写法', true);
        return;
      }
      const changes = { title, summary: title };
      if (startRaw) changes.startAt = startAt;
      if (untilRaw) changes.validUntil = validUntil;
      this.applyPlanPanelAction(chat, body, data, planId, 'save', changes);
    });
    row.appendChild(form);
  }

  // 撤回所需的字段改动（纯函数，便于测试）
  buildPlanRestoreChanges(event, now = Date.now()) {
    const changes = { status: 'planned' };
    const currentValidUntil = Number(event?.validUntil || 0);
    const extended = !currentValidUntil || currentValidUntil < now;
    if (extended) changes.validUntil = now + 86400000 * 2;
    return { changes, extended };
  }

  async applyPlanPanelAction(chat, body, data, planId, action, changes = {}) {
    const raw = (data.events || []).find(event => String(event.id) === String(planId));
    if (!raw) return;
    try {
      if (action === 'save') {
        await this.externalMemoryRequest(chat, '/memory/active-events/upsert', {
          method: 'POST',
          body: this.buildPlanUpsertBody(raw, changes)
        });
        this.notifyPlanPanel('已保存该计划');
      } else if (action === 'restore') {
        // 撤回：把已结束的计划改回「待办」。
        // 如果它的有效至已经过去（撤回后会被立刻判定过期、无法注入），就顺延到今天 + 2 天。
        const { changes: restoreChanges, extended } = this.buildPlanRestoreChanges(raw);
        await this.externalMemoryRequest(chat, '/memory/active-events/upsert', {
          method: 'POST',
          body: this.buildPlanUpsertBody(raw, restoreChanges)
        });
        this.notifyPlanPanel(extended
          ? `已撤回，并把有效至顺延到 ${this.formatPlanPanelTime(restoreChanges.validUntil)}`
          : '已撤回该计划');
      } else if (action === 'complete') {
        await this.externalMemoryRequest(chat, '/memory/active-events/archive', {
          method: 'POST',
          body: this.buildPlanArchiveBody(planId, 'completed')
        });
        this.notifyPlanPanel('已标记为完成，不再注入提示词');
      } else if (action === 'archive') {
        await this.externalMemoryRequest(chat, '/memory/active-events/archive', {
          method: 'POST',
          body: this.buildPlanArchiveBody(planId, 'archived')
        });
        this.notifyPlanPanel('已归档该计划（可在「已归档」里撤回）');
      } else if (action === 'delete') {
        // 物理删除：那一行真的从数据库消失。（对应接口随下次 memory-server 更新上线）
        await this.externalMemoryRequest(chat, '/memory/active-events/delete', {
          method: 'POST',
          body: { confirm: 'DELETE_ACTIVE_EVENT', id: String(planId) }
        });
        this.notifyPlanPanel('已彻底删除该计划');
      } else {
        return;
      }
      this.renderPlanFactPanel(chat, body.parentNode);
    } catch (error) {
      this.notifyPlanPanel(`操作失败：${error.message || error}`, true);
    }
  }

  async applyFactPanelAction(chat, body, group, action, changes = {}) {
    const fact = group?.current;
    if (!fact?.id) return;
    const missingEndpointHint = '这个操作需要 memory-server 更新后才有对应接口，当前服务端版本还不支持；改动没有生效。';
    try {
      if (action === 'save') {
        await this.externalMemoryRequest(chat, '/memory/current-facts/upsert', {
          method: 'POST',
          body: this.buildFactUpsertBody(fact, changes)
        });
        this.notifyPlanPanel('已保存该事实');
      } else if (action === 'promote') {
        await this.externalMemoryRequest(chat, '/memory/current-facts/promote', {
          method: 'POST',
          body: this.buildFactPromoteBody(fact.id)
        });
        this.notifyPlanPanel('已设为当前事实');
      } else if (action === 'delete') {
        // 物理删除事实（对应接口随下次 memory-server 更新上线）
        await this.externalMemoryRequest(chat, '/memory/current-facts/delete', {
          method: 'POST',
          body: { confirm: 'DELETE_CURRENT_FACT', id: fact.id }
        });
        this.notifyPlanPanel('已彻底删除该事实');
      } else {
        return;
      }
      this.renderPlanFactPanel(chat, body.parentNode);
    } catch (error) {
      const message = String(error?.message || error);
      this.notifyPlanPanel(/40[45]/.test(message) ? missingEndpointHint : `操作失败：${message}`, true);
    }
  }

  askPurgePlans(chat, body, scope, candidateCount = 0) {
    const host = body?.querySelector
      ? (body.querySelector('[data-panel-confirm-host]') || body)
      : body;
    const isArchived = scope === 'archived';
    this.askInlineConfirm(
      host,
      isArchived
        ? `确认要清空已归档吗？\n\n将永久删除 ${candidateCount} 条已归档的计划，`
          + '删除后无法恢复、也无法再撤回。\n\n这些条目与向量记忆完全无关。'
        : `确认要清理吗？\n\n将永久删除 ${candidateCount} 条已完成 / 已取消 / 已过期的计划`
          + '（**不含已归档**，归档的会保留可撤回）。\n\n这些条目与向量记忆完全无关。',
      () => this.runPurgePlans(chat, body, scope)
    );
  }

  async runPurgePlans(chat, body, scope) {
    try {
      const chatId = this.getOrganizationChatId(chat);
      const result = await this.externalMemoryRequest(chat, '/memory/active-events/purge', {
        method: 'POST',
        body: { confirm: 'PURGE_ACTIVE_EVENTS', chatId, scope }
      });
      this.notifyPlanPanel(`已清理 ${Number(result?.deleted || 0)} 条计划`);
      await this.renderPlanFactPanel(chat, body?.parentNode || body);
    } catch (error) {
      const message = String(error?.message || error);
      this.notifyPlanPanel(
        /40[45]/.test(message)
          ? '清理需要 memory-server 更新后才有对应接口，当前服务端版本还不支持。'
          : `清理失败：${message}`,
        true
      );
    }
  }

  openPlanCreateForm(chat, body, data) {
    const host = body.querySelector('[data-plan-create-host]');
    if (!host) return;
    const existingForm = host.querySelector('[data-plan-create]');
    if (existingForm) {
      existingForm.remove();
      return;
    }

    const escape = value => this._escapeHtml(value);
    const form = document.createElement('div');
    form.dataset.planCreate = '1';
    form.style.cssText = 'padding:10px 12px;border-radius:12px;background:rgba(0,0,0,0.035);margin-bottom:10px;display:flex;flex-direction:column;gap:6px;';
    form.innerHTML = `
      <div style="font-size:13px;color:#666;">手动添加一条计划（不依赖抽取器，直接写入服务器）</div>
      <input class="vm-input-full" data-field="title" placeholder="标题，例如 明天去医院复诊">
      <input class="vm-input-full" data-field="startAt" value="${escape(this.toPlanPanelInputValue(Date.now() + 86400000))}" placeholder="开始时间，例如 2026-10-15 09:00">
      <input class="vm-input-full" data-field="validUntil" placeholder="有效至（留空 = 开始时间 + 2 天）">
      <div style="display:flex;gap:8px;">
        <button class="vm-toolbar-btn vm-primary" data-action="save">保存</button>
        <button class="vm-toolbar-btn" data-action="cancel">取消</button>
      </div>
    `;
    form.querySelector('[data-action="cancel"]').addEventListener('click', () => form.remove());
    form.querySelector('[data-action="save"]').addEventListener('click', () => {
      const readField = field => form.querySelector(`[data-field="${field}"]`)?.value || '';
      const title = readField('title').trim();
      const startRaw = readField('startAt').trim();
      const untilRaw = readField('validUntil').trim();
      if (!title) {
        this.notifyPlanPanel('标题不能为空', true);
        return;
      }
      const startAt = this.parsePlanPanelInputValue(startRaw);
      if (startAt === null) {
        this.notifyPlanPanel('请填写开始时间，格式如 2026-10-15 09:00', true);
        return;
      }
      let validUntil = untilRaw ? this.parsePlanPanelInputValue(untilRaw) : null;
      if (untilRaw && validUntil === null) {
        this.notifyPlanPanel('有效至格式无法识别，请用 2026-10-17 23:59 这种写法', true);
        return;
      }
      // 留空时默认「开始时间 + 2 天」，与抽取器自动写入的有效期规则保持一致，
      // 避免手动添加的计划永不过期、一直待在提示词里。
      if (validUntil === null) validUntil = startAt + 86400000 * 2;
      if (validUntil < startAt) {
        this.notifyPlanPanel('「有效至」不能早于「开始时间」', true);
        return;
      }
      this.createPlan(chat, body, { title, startAt, validUntil });
    });
    host.appendChild(form);
  }

  async createPlan(chat, body, input) {
    const chatId = this.getOrganizationChatId(chat);
    try {
      await this.externalMemoryRequest(chat, '/memory/active-events/upsert', {
        method: 'POST',
        body: this.buildPlanUpsertBody({
          chatId,
          status: 'planned',
          surfaceMode: 'manual_only',
          proactiveMention: false,
          confidence: 0.99
        }, {
          title: input.title,
          summary: input.title,
          status: 'planned',
          startAt: input.startAt,
          validUntil: input.validUntil,
          evidence: {
            writeVersion: 'manual-panel-v1',
            manual: true,
            addedAt: Date.now(),
            sourceScope: { type: 'private', sourceChatId: chatId }
          }
        })
      });
      this.notifyPlanPanel('已添加计划，下一轮对话就会注入');
      await this.renderPlanFactPanel(chat, body.parentNode);
    } catch (error) {
      this.notifyPlanPanel(`添加失败：${error.message || error}`, true);
    }
  }

  buildFactUpsertBody(fact, changes = {}) {
    const pick = (field, fallback) => (changes[field] !== undefined ? changes[field] : fallback);
    const slotKey = String(pick('slotKey', fact?.slotKey || '')).trim().slice(0, 160);
    const statement = String(pick('statement', fact?.statement || fact?.value || '')).trim().slice(0, 500);
    const value = String(pick('value', fact?.value || statement)).trim().slice(0, 500);
    const inferFactType = slot => {
      if (slot.startsWith('user.residence.')) return 'current_residence';
      if (slot.startsWith('user.location.')) return 'current_location';
      if (slot.startsWith('user.trip.')) return 'current_trip_state';
      if (slot.startsWith('user.task.')) return 'current_task_state';
      if (slot.startsWith('user.body.')) return 'current_body_state';
      return 'type_uncertain';
    };
    return {
      confirm: 'UPSERT_CURRENT_FACT',
      fact: {
        id: String(fact?.id || ''),
        chatId: String(pick('chatId', fact?.chatId || '')),
        subjectKey: String(fact?.subjectKey || 'user'),
        factType: String(pick('factType', fact?.factType || inferFactType(slotKey))),
        slotKey,
        value,
        statement,
        // 默认写 shadow_candidate：current 上有唯一索引（每个槽位只允许一条 current），
        // 直接写 current 会和已有记录冲突。要变成权威值请用「设为当前」。
        status: String(pick('status', fact?.status || 'shadow_candidate')),
        confidence: Number(pick('confidence', fact?.confidence || 0.99)),
        effectiveAt: Number(pick('effectiveAt', fact?.effectiveAt || Date.now())),
        validUntil: Number(pick('validUntil', fact?.validUntil || 0)) || null,
        evidence: pick('evidence', fact?.evidence || {})
      }
    };
  }

  openFactEditForm(chat, body, group, card) {
    const opened = card.querySelector('[data-fact-edit]');
    if (opened) {
      opened.remove();
      return;
    }
    const fact = group?.current;
    if (!fact) return;

    const form = document.createElement('div');
    form.dataset.factEdit = '1';
    form.style.cssText = 'margin-top:8px;display:flex;flex-direction:column;gap:6px;';
    form.innerHTML = `
      ${this.buildFactSlotPickerHtml(group.slotKey)}
      <textarea class="vm-input-full" data-field="statement" style="min-height:64px;" placeholder="事实内容">${this._escapeHtml(fact.statement || fact.value || '')}</textarea>
      <div style="display:flex;gap:8px;">
        <button class="vm-toolbar-btn vm-primary" data-action="save">保存</button>
        <button class="vm-toolbar-btn" data-action="cancel">取消</button>
      </div>
    `;
    this.bindFactSlotPicker(form);
    form.querySelector('[data-action="cancel"]').addEventListener('click', () => form.remove());
    form.querySelector('[data-action="save"]').addEventListener('click', () => {
      const slotKey = this.readFactSlotKeyFromForm(form);
      const statement = form.querySelector('[data-field="statement"]')?.value.trim() || '';
      if (!slotKey || !statement) {
        this.notifyPlanPanel('槽位和事实内容都不能为空', true);
        return;
      }
      this.applyFactPanelAction(chat, body, group, 'save', { slotKey, statement, value: statement });
    });
    card.appendChild(form);
  }

  openFactCreateForm(chat, body, data) {
    const host = body.querySelector('[data-fact-create-host]');
    if (!host) return;
    const existing = host.querySelector('[data-fact-create]');
    if (existing) {
      existing.remove();
      return;
    }

    const form = document.createElement('div');
    form.dataset.factCreate = '1';
    form.style.cssText = 'padding:10px 12px;border-radius:12px;background:rgba(0,0,0,0.035);margin-bottom:10px;display:flex;flex-direction:column;gap:6px;';
    form.innerHTML = `
      <div style="font-size:13px;color:#666;">手动添加一条事实（先写成待确认，需要成为权威值再点「设为当前」）</div>
      ${this.buildFactSlotPickerHtml('user.residence.current')}
      <textarea class="vm-input-full" data-field="statement" style="min-height:64px;" placeholder="事实内容，例如 我最近住在临空。"></textarea>
      <div style="display:flex;gap:8px;">
        <button class="vm-toolbar-btn vm-primary" data-action="save">保存</button>
        <button class="vm-toolbar-btn" data-action="cancel">取消</button>
      </div>
    `;
    this.bindFactSlotPicker(form);
    form.querySelector('[data-action="cancel"]').addEventListener('click', () => form.remove());
    form.querySelector('[data-action="save"]').addEventListener('click', () => {
      const slotKey = this.readFactSlotKeyFromForm(form);
      const statement = form.querySelector('[data-field="statement"]')?.value.trim() || '';
      if (!slotKey || !statement) {
        this.notifyPlanPanel('槽位和事实内容都不能为空', true);
        return;
      }
      this.createFact(chat, body, { slotKey, statement });
    });
    host.appendChild(form);
  }

  async createFact(chat, body, input) {
    const chatId = this.getOrganizationChatId(chat);
    try {
      const saved = await this.externalMemoryRequest(chat, '/memory/current-facts/upsert', {
        method: 'POST',
        body: this.buildFactUpsertBody({ chatId }, {
          slotKey: input.slotKey,
          statement: input.statement,
          value: input.statement,
          status: 'shadow_candidate',
          confidence: 0.99,
          effectiveAt: Date.now(),
          evidence: { writeVersion: 'manual-panel-v1', manual: true, addedAt: Date.now() }
        })
      });

      // 手写的事实直接设为「当前」——只有 current 会注入提示词。
      // promote 接口会走 supersede 链，把同槽位的旧值正确退役（避免唯一索引冲突）。
      const newFactId = String(saved?.fact?.id || '').trim();
      let promoted = false;
      if (newFactId) {
        try {
          await this.externalMemoryRequest(chat, '/memory/current-facts/promote', {
            method: 'POST',
            body: this.buildFactPromoteBody(newFactId)
          });
          promoted = true;
        } catch (error) {
          console.warn('[变量记忆] 设为当前失败，事实已保存为候选态:', error.message);
        }
      }

      this.notifyPlanPanel(
        promoted
          ? '已添加事实并设为当前（会注入提示词）'
          : '已添加事实（候选态，点「设为当前」后才会注入提示词）'
      );
      await this.renderPlanFactPanel(chat, body.parentNode);
    } catch (error) {
      const message = String(error?.message || error);
      this.notifyPlanPanel(`添加失败：${message}`, true);
    }
  }

  formatOrganizationTime(value) {
    const timestamp = Number(value);
    if (!Number.isFinite(timestamp) || timestamp <= 0) return '';
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleString();
  }

  renderMemoryUI(chat, container) {
    const vm = this.getVariableMemory(chat);
    const stats = this.getStats(chat);
    container.innerHTML = '';

    const activeView = vm._panelView || 'memories';
    this.renderMemoryPanelSwitcher(chat, container, activeView);
    if (activeView === 'clusters') {
      this.renderOrganizationPreviewUI(chat, container);
      return;
    }
    if (activeView === 'plans') {
      this.renderPlanFactPanel(chat, container);
      return;
    }

    // 顶部工具栏
    const toolbar = document.createElement('div');
    toolbar.className = 'vm-toolbar';
    toolbar.innerHTML = `
      <button class="vm-toolbar-btn" id="vm-add-fragment-btn">添加记忆</button>
      <button class="vm-toolbar-btn" id="vm-add-core-btn">添加核心</button>
      <button class="vm-toolbar-btn" id="vm-batch-toggle-btn">批量操作</button>

      <span style="font-size:13px;color:#666;margin-left:10px;">
        总数 ${stats.totalFragments}
        | Vector ${stats.embeddedCount}
        | BM25 ${stats.totalFragments - stats.embeddedCount}
      </span>

      <div style="flex:1"></div>
      <button class="vm-toolbar-btn vm-primary" id="vm-summary-btn" title="剩余 ${stats.remainingToAuto} 条消息后自动触发">
        提取记忆 (${stats.unextractedMessages}/${stats.autoInterval})
      </button>
      <button class="vm-toolbar-btn" id="vm-export-btn">导出全部</button>
      <button class="vm-toolbar-btn" id="vm-import-btn">导入</button>
      <button class="vm-toolbar-btn" id="vm-reembed-btn">修复未向量化</button>
      <button class="vm-toolbar-btn" id="vm-settings-btn">设置</button>
      <button class="vm-toolbar-btn" id="vm-guide-btn">便携教程</button>
    `;
    container.appendChild(toolbar);

    // 批量操作工具栏 (默认隐藏)
    const batchToolbar = document.createElement('div');
    batchToolbar.className = 'vm-toolbar';
    batchToolbar.id = 'vm-batch-toolbar';
    batchToolbar.style.display = 'none';
    batchToolbar.innerHTML = `
      <button class="vm-toolbar-btn" id="vm-batch-select-all-btn">全选</button>
      <span style="font-size:13px;color:#666;margin:0 10px;">已选 <span id="vm-batch-selected-count">0</span> 项</span>
      <button class="vm-toolbar-btn" id="vm-batch-copy-btn">复制</button>
      <button class="vm-toolbar-btn" id="vm-batch-export-btn">导出</button>
      <button class="vm-toolbar-btn" id="vm-batch-delete-btn" style="color:#ff3b30">删除</button>
      <div style="flex:1"></div>
      <button class="vm-toolbar-btn" id="vm-batch-cancel-btn">取消</button>
    `;
    container.appendChild(batchToolbar);

        container.appendChild(batchToolbar);

    // 搜索 / 筛选栏
    const filterBar = document.createElement('div');
    filterBar.className = 'vm-filter-bar';
    filterBar.style.cssText = `
      margin: 12px 0 14px;
      padding: 12px;
      border-radius: 14px;
      background: rgba(0,0,0,0.035);
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 10px;
    `.replace(/\s+/g, ' ').trim();

    const filters = vm._panelFilters || {
      query: '',
      category: '',
      vector: '',
      minImportance: '',
      dateFrom: '',
      dateTo: ''
    };

    filterBar.innerHTML = `
      <label style="font-size:13px;color:#666;">搜索</label>
      <input id="vm-search-input" class="vm-filter-input" type="text"
        value="${this._escapeHtml(filters.query || '')}"
        placeholder="输入后按回车或点搜索"
        style="min-width:220px;flex:1;padding:8px 10px;border:1px solid #ddd;border-radius:10px;font-size:14px;">

      <button class="vm-toolbar-btn" id="vm-search-btn">搜索</button>

      <label style="font-size:13px;color:#666;">分类</label>
      <select id="vm-category-filter" class="vm-filter-select" style="padding:8px 10px;border:1px solid #ddd;border-radius:10px;font-size:14px;">
        <option value="">全部</option>
        ${Object.entries(this.getCategories(chat)).map(([code, cat]) => `
          <option value="${code}" ${filters.category === code ? 'selected' : ''}>${code} ${this._escapeHtml(cat.name || '')}</option>
        `).join('')}
      </select>

      <label style="font-size:13px;color:#666;">向量</label>
      <select id="vm-vector-filter" class="vm-filter-select" style="padding:8px 10px;border:1px solid #ddd;border-radius:10px;font-size:14px;">
        <option value="" ${!filters.vector ? 'selected' : ''}>全部</option>
        <option value="vector" ${filters.vector === 'vector' ? 'selected' : ''}>Vector</option>
        <option value="bm25" ${filters.vector === 'bm25' ? 'selected' : ''}>BM25</option>
      </select>

      <label style="font-size:13px;color:#666;">重要度</label>
      <select id="vm-importance-filter" class="vm-filter-select" style="padding:8px 10px;border:1px solid #ddd;border-radius:10px;font-size:14px;">
        <option value="" ${!filters.minImportance ? 'selected' : ''}>全部</option>
        ${[1,2,3,4,5,6,7,8,9,10].map(n => `
          <option value="${n}" ${String(filters.minImportance) === String(n) ? 'selected' : ''}>≥${n}</option>
        `).join('')}
      </select>

      <label style="font-size:13px;color:#666;">开始日期</label>
      <input id="vm-date-from-filter" class="vm-filter-input" type="date"
        value="${this._escapeHtml(filters.dateFrom || '')}"
        style="padding:8px 10px;border:1px solid #ddd;border-radius:10px;font-size:14px;">

      <label style="font-size:13px;color:#666;">结束日期</label>
      <input id="vm-date-to-filter" class="vm-filter-input" type="date"
        value="${this._escapeHtml(filters.dateTo || '')}"
        style="padding:8px 10px;border:1px solid #ddd;border-radius:10px;font-size:14px;">

      <button class="vm-toolbar-btn" id="vm-reset-filter-btn">重置</button>
    `;

    container.appendChild(filterBar);

    // 记忆列表区
    const listContainer = document.createElement('div');
    listContainer.className = 'vm-list-container';

    // ---- 有筛选条件时必须先走服务端 ----
    // 本地缓存只装了最近 5000 条，更早的记忆（比如你聊天的第一天）在本地根本筛不到。
    const activeFilters = this.getActivePanelFilters(vm._panelFilters || {});
    const filterKey = this.getPanelFilterKey(activeFilters);
    if (Object.keys(activeFilters).length > 0) {
      if (!vm._memPanel || vm._memPanel.filterKey !== filterKey) {
        this.loadMemoryPanelPage(chat, container, vm._panelFilters || {}, 0, {});
        listContainer.innerHTML = '<div style="text-align:center;color:#999;padding:32px 20px;font-size:13px;">正在从服务器查询…</div>';
        container.appendChild(listContainer);
        return;
      }
    } else if (vm._memPanel?.serverMode) {
      // 清空筛选 → 回到本地列表（服务端结果作废）
      vm._memPanel = null;
    }

    const categories = this.getCategories(chat);

    // ---- 数据源：有筛选条件时走服务端（能覆盖全部记忆，不受本地 5000 条缓存限制）----
    //      没有筛选时仍用本地缓存（提示词/去重等 30 多处依赖 vm.fragments，不能改）
    const panelState = vm._memPanel;
    const serverMode = Boolean(panelState?.serverMode);

    const filteredFragments = this.applyPanelFilters(
      serverMode ? (panelState.items || []) : (vm.fragments || []),
      vm._panelFilters || {}
    );

    // 分页：本地模式默认显示100条；服务端模式已经是一页一页取回来的
    const displayLimit = serverMode ? filteredFragments.length : (vm.renderLimit || 100);

    const displayFragments = serverMode ? filteredFragments : filteredFragments.slice(0, displayLimit);
    
    // 按分类分组渲染
    for (const [code, catInfo] of Object.entries(categories)) {
      const frags = displayFragments.filter(f => f.category === code);
      if (frags.length === 0) continue;
      
      // 按发生时间倒序排列
      frags.sort((a, b) => b.memoryTime - a.memoryTime);

      const section = document.createElement('div');
      section.className = 'vm-section';
      if (code === 'C') section.classList.add('vm-core-section');
      
      section.innerHTML = `
        <div class="vm-section-header">
          <input type="checkbox" class="vm-batch-element vm-section-select-all" style="display:none; margin-right:8px;" data-category="${code}">
          <span class="vm-section-tag" style="background:${catInfo.color}">${code}</span>
          <span class="vm-section-title">${catInfo.name}</span>
          <span class="vm-section-count">${frags.length}/${filteredFragments.filter(f => f.category === code).length}</span>
        </div>
      `;
      
      const list = document.createElement('div');
      list.className = 'vm-section-list';
      
      frags.forEach(frag => {
        const row = document.createElement('div');
        row.className = 'vm-item-row';
        
        // 格式化时间为 datetime-local 可用的格式
        let rawTime = Number(frag.memoryTime || frag.createdAt || Date.now());

        if (!Number.isFinite(rawTime)) {
          rawTime = Date.now();
        }

        const memoryTimeZone = frag.memoryTimeZone || 'Europe/London';
        const localISOTime = window.TimeZoneUtils?.toDateTimeLocal(rawTime, memoryTimeZone) || '';

        row.innerHTML = `
          <input type="checkbox" class="vm-batch-element vm-item-checkbox" style="display:none; margin-right:10px; width: 16px; height: 16px; flex-shrink: 0; align-self: flex-start; margin-top: 4px;" data-id="${frag.id}" data-type="${code === 'C' ? 'core' : 'fragment'}">
          <div class="vm-item-main">
            <span class="vm-item-content">${this._escapeHtml(frag.content)}</span>
            ${this.renderTagChips(frag.tags)}
            <div class="vm-item-meta">
              <input type="datetime-local" class="vm-time-picker" data-id="${frag.id}" value="${localISOTime}" title="修改记忆发生时间">
              <span class="vm-meta-tag">重要度:${frag.importance}</span>
              ${this.hasFragmentEmbedding(frag) ? '<span class="vm-meta-tag" title="已向量化">Vector✓</span>' : '<span class="vm-meta-tag" style="color:#ff9500">BM25</span>'}
            </div>
          </div>
          <div class="vm-item-actions">
            ${code !== 'C' ? `<button class="vm-item-btn vm-pin-btn" data-id="${frag.id}">置顶为核心</button>` : ''}
            <button class="vm-item-btn vm-detail-frag-btn" data-id="${frag.id}">详情</button>
            <button class="vm-item-btn vm-edit-frag-btn" data-id="${frag.id}">改内容</button>
            <button class="vm-item-btn vm-delete-frag-btn" data-id="${frag.id}" style="color:#ff3b30">删</button>
          </div>
        `;
        list.appendChild(row);
      });
      section.appendChild(list);
      listContainer.appendChild(section);
    }

    if (displayFragments.length === 0) {
      listContainer.innerHTML = serverMode
        ? `
        <div style="text-align:center; color: #999; padding: 40px 20px;">
          <p style="font-size: 16px; font-weight:bold; color:#666;">没有符合条件的记忆</p>
          <p style="font-size: 13px; margin-top: 5px;">换个关键词或日期再试（当前是服务端查询，覆盖全部 ${Number(vm._memTotal || 0) || '全部'} 条）。</p>
        </div>
      `
        : `
        <div style="text-align:center; color: #999; padding: 40px 20px;">
          <div style="font-size:40px; margin-bottom:10px;"></div>
          <p style="font-size: 16px; font-weight:bold; color:#666;">变量记忆是空的</p>
          <p style="font-size: 13px; margin-top: 5px;">继续聊天，当新消息达到 ${stats.autoInterval} 条时，系统会自动提取记忆。</p>
          <p style="font-size: 13px;">你也可以手动点击上方按钮添加。</p>
        </div>
      `;
    }

    container.appendChild(listContainer);

    if (serverMode) {
      // 服务端分页：显示"已取回多少 / 总共多少"，还有更多时继续向服务器要下一页
      const items = panelState.items || [];
      const total = Number(panelState.total || items.length);
      if (panelState.hasMore) {
        const moreBtn = document.createElement('button');
        moreBtn.className = 'vm-toolbar-btn';
        moreBtn.style.margin = '15px auto';
        moreBtn.style.display = 'block';
        moreBtn.textContent = `加载更多（已显示 ${items.length}/${total}，服务端查询）`;
        moreBtn.onclick = () => {
          this.loadMemoryPanelPage(chat, container, vm._panelFilters || {}, items.length, { append: true });
        };
        container.appendChild(moreBtn);
      } else if (items.length > 0) {
        const hint = document.createElement('div');
        hint.style.cssText = 'text-align:center;font-size:12px;color:#999;margin:12px 0;';
        hint.textContent = `已显示全部 ${total} 条（服务端查询）`;
        container.appendChild(hint);
      }
    } else if (displayLimit < filteredFragments.length) {
      const moreBtn = document.createElement('button');

      moreBtn.className = 'vm-toolbar-btn';
      moreBtn.style.margin = '15px auto';
      moreBtn.style.display = 'block';
      moreBtn.textContent = `显示更多（${displayLimit}/${filteredFragments.length}）`;

      moreBtn.onclick = () => {
        vm.renderLimit = displayLimit + 100;
        this.renderMemoryUI(chat, container);
      };

      container.appendChild(moreBtn);
    } else if (Number(vm._memTotal || 0) > filteredFragments.length) {
      // 本地缓存已全部显示，但服务器还有更早的记忆（本地缓存默认只装 5000 条）
      const moreBtn = document.createElement('button');
      moreBtn.className = 'vm-toolbar-btn';
      moreBtn.style.margin = '15px auto';
      moreBtn.style.display = 'block';
      moreBtn.textContent = `加载更早的记忆（本地已显示 ${filteredFragments.length}，共 ${vm._memTotal} 条）`;
      moreBtn.onclick = () => {
        this.loadMemoryPanelPage(chat, container, vm._panelFilters || {}, filteredFragments.length, {});
      };
      container.appendChild(moreBtn);
    }
  }

  // ==================== 设置面板 ====================

  renderSettingsPanel(chat) {
    const vm = this.getVariableMemory(chat);
    const s = vm.settings;
    return `
      <div class="vm-settings-panel">
        <div class="vm-settings-group">
          <h4>提取与触发规则</h4>
          <div class="vm-setting-item">
            <label>多少条新消息自动提取一次？</label>
            <input type="number" id="vm-auto-interval" value="${s.autoExtractionMsgInterval || 20}" min="5" max="100" class="vm-input-full">
            <div style="font-size:11px;color:#999;margin-top:4px;">不用担心刷屏！现在基于绝对消息数量触发，严格锁定。</div>
          </div>
        </div>

        <div class="vm-settings-group">
          <h4>检索引擎调参</h4>
          <div class="vm-setting-item">
            <label>每轮注入 AI 脑海的记忆数 (Top N)</label>
            <input type="number" id="vm-topn" value="${s.topN || 10}" min="1" max="30" class="vm-input-full">
          </div>

          <div class="vm-setting-item" style="margin-top:12px;">
            <label>服务器搜索引擎</label>
            <select id="vm-search-engine" class="vm-input-full" onchange="const is=this.value==='hybrid'||this.value==='chroma-hybrid';const sqlite=document.getElementById('vm-sqlite-candidate-setting');const chroma=document.getElementById('vm-chroma-candidate-setting');const n=document.getElementById('vm-chroma-nresults-setting');if(sqlite)sqlite.style.display=is?'none':'';if(chroma)chroma.style.display=is?'':'none';if(n)n.style.display=is?'':'none';">
              <option value="sqlite" ${(s.searchEngine || 'sqlite') === 'sqlite' ? 'selected' : ''}>SQLite semantic-hybrid（默认稳定）</option>
              <option value="hybrid" ${((s.searchEngine || 'sqlite') === 'hybrid' || (s.searchEngine || 'sqlite') === 'chroma-hybrid') ? 'selected' : ''}>Chroma hybrid rerank（实验）</option>
            </select>
            <div style="font-size:11px;color:#999;margin-top:4px;">SQLite 用 SQLite 候选池；Chroma 会先向量召回，再交给后端 rerank。</div>
          </div>

          <div id="vm-sqlite-candidate-setting" class="vm-setting-item" style="margin-top:12px;${((s.searchEngine || 'sqlite') === 'hybrid' || (s.searchEngine || 'sqlite') === 'chroma-hybrid') ? 'display:none;' : ''}">
            <label>SQLite 候选池 candidateLimit</label>
            <input type="number" id="vm-sqlite-candidate-limit" value="${s.sqliteCandidateLimit ?? s.candidateLimit ?? 6000}" min="1" max="20000" step="100" class="vm-input-full">
          </div>

          <div id="vm-chroma-candidate-setting" class="vm-setting-item" style="margin-top:12px;${((s.searchEngine || 'sqlite') === 'hybrid' || (s.searchEngine || 'sqlite') === 'chroma-hybrid') ? '' : 'display:none;'}">
            <label>Chroma 候选池 candidateLimit</label>
            <input type="number" id="vm-chroma-candidate-limit" value="${s.chromaCandidateLimit ?? 2000}" min="1" max="20000" step="100" class="vm-input-full">
          </div>

          <div id="vm-chroma-nresults-setting" class="vm-setting-item" style="margin-top:12px;${((s.searchEngine || 'sqlite') === 'hybrid' || (s.searchEngine || 'sqlite') === 'chroma-hybrid') ? '' : 'display:none;'}">
            <label>Chroma 召回数 chromaNResults</label>
            <input type="number" id="vm-chroma-nresults" value="${s.chromaNResults ?? 200}" min="1" max="2000" step="10" class="vm-input-full">
          </div>

          <div class="vm-setting-item" style="margin-top:12px;">
            <label>多维打分权重分布</label>
            <div class="vm-weights">
              <div><span>语义(Vector)</span><input type="number" id="vm-w-semantic" value="${s.scoreWeights.semantic}" step="0.1" class="vm-input-sm"></div>
              <div><span>字面(BM25)</span><input type="number" id="vm-w-keyword" value="${s.scoreWeights.keyword}" step="0.1" class="vm-input-sm"></div>
              <div><span>重要度(Importance)</span><input type="number" id="vm-w-importance" value="${s.scoreWeights.importance}" step="0.1" class="vm-input-sm"></div>
              <div><span>情绪权重(Emotion)</span><input type="number" id="vm-w-emotion" value="${s.scoreWeights.emotion ?? 0.05}" step="0.01" class="vm-input-sm"></div>
              <div><span>时间衰减(Decay)</span><input type="number" id="vm-w-recency" value="${s.scoreWeights.recency}" step="0.1" class="vm-input-sm"></div>
            </div>
            <div style="font-size:11px;color:#999;margin-top:4px;">注意：如果无 Embedding API，系统会自动用 BM25 算法替代，依然精准！核心记忆(C类)永远是满分免疫衰减。</div>
          </div>
        </div>

        <div class="vm-settings-group">
             <h4>自定义提示词</h4>

             <div class="vm-setting-row">
               <span>开启自定义记忆提取提示词</span>
               <label class="toggle-switch">
                 <input type="checkbox" id="vm-custom-prompt" ${s.useCustomExtractionPrompt ? 'checked' : ''}>
                 <span class="slider"></span>
               </label>
             </div>

             <div id="vm-custom-prompt-field" style="display:${s.useCustomExtractionPrompt ? 'block' : 'none'}; margin-top:10px;">
               <textarea
                 id="vm-custom-prompt-text"
                 class="vm-input-full"
                 rows="8"
                 placeholder="填写用于自动提取记忆的提示词"
                 style="width:100%;box-sizing:border-box;resize:vertical;line-height:1.6;padding:10px;border:1px solid #ddd;border-radius:10px;"
               >${this._escapeHtml(s.customExtractionPrompt || this.getDefaultExtractionPrompt())}</textarea>

               <button
                 type="button"
                 id="vm-reset-prompt-btn"
                 class="vm-btn-secondary"
                 style="margin-top:8px;"
               >恢复默认</button>

              <div style="font-size:11px;color:#999;margin-top:6px;line-height:1.5;">
                开启后，自动提取记忆时会使用这里的提示词。恢复默认只会重置文本框内容，记得点击“保存设置”。
              </div>
            </div>
          </div>

        <div class="vm-settings-group">
          <h4>向量化端点 (可选)</h4>
          <div class="vm-setting-row">
            <span>开启自定义 Embedding</span>
            <label class="toggle-switch"><input type="checkbox" id="vm-custom-embedding" ${s.useCustomEmbedding ? 'checked' : ''}><span class="slider"></span></label>
          </div>
          <div id="vm-custom-embedding-fields" style="display:${s.useCustomEmbedding ? 'block' : 'none'}; margin-top:8px;">
            <input type="text" id="vm-embedding-endpoint" value="${s.embeddingEndpoint || ''}" placeholder="https://api.openai.com (如需拉取模型请确保地址以/v1结尾)" class="vm-input-full">
            <div style="display:flex;gap:8px;align-items:center;margin-top:4px;">
              <input type="password" id="vm-embedding-apikey" value="${s.embeddingApiKey || ''}" placeholder="API Key" class="vm-input-full" style="flex:1;">
              <button type="button" class="vm-toolbar-btn" id="vm-toggle-embedding-key-btn" style="white-space:nowrap;">显示</button>
            </div>
            <div style="display:flex; gap:8px; margin-top:4px;">
              <input type="text" id="vm-embedding-model-input" value="${s.embeddingModel || 'text-embedding-3-small'}" placeholder="或手动输入模型名称" class="vm-input-full" style="flex:1; display:none;">
              <select id="vm-embedding-model-select" class="vm-input-full" style="flex:1;">
                <option value="${s.embeddingModel || 'text-embedding-3-small'}">${s.embeddingModel || 'text-embedding-3-small'}</option>
              </select>
              <button id="vm-fetch-models-btn" class="vm-btn-secondary" style="white-space:nowrap; padding:0 12px;">拉取模型</button>
            </div>
            <div style="font-size:11px;color:#999;margin-top:4px;text-align:right;cursor:pointer;" id="vm-toggle-model-input">切换为手动输入</div>
          </div>
        </div>

        <div class="vm-settings-group">
          <h4>外部 memory-server（实验）</h4>

          <div class="vm-setting-row">
            <span>使用外部 memory-server</span>
            <label class="toggle-switch">
              <input type="checkbox" id="vm-external-memory-enabled" ${s.externalMemoryEnabled ? 'checked' : ''}>
              <span class="slider"></span>
            </label>
          </div>

          <div style="margin-top:8px;">
            <input
              type="text"
              id="vm-external-memory-endpoint"
              value="${this._escapeHtml(s.externalMemoryEndpoint || 'http://127.0.0.1:8765')}"
              placeholder="http://127.0.0.1:8765"
              class="vm-input-full"
            >
          </div>

          <div style="margin-top:8px;">
            <input
              type="password"
              id="vm-external-memory-bearer-token"
              value="${this._escapeHtml(s.externalMemoryBearerToken || '')}"
              placeholder="Memory Server Bearer Token（启用鉴权后填写）"
              autocomplete="off"
              class="vm-input-full"
            >
          </div>

          <div class="vm-setting-row">
            <span>注入待办/计划与当前事实</span>
            <label class="toggle-switch">
              <input type="checkbox" id="vm-plan-context-enabled" ${s.planContextEnabled !== false ? 'checked' : ''}>
              <span class="slider"></span>
            </label>
          </div>

          <div style="font-size:11px;color:#999;margin-top:6px;line-height:1.5;">
            每轮把「还没结束的约定/计划」和「你设为当前的事实」常驻进提示词（只读 memory-server，无需服务端改动）。
            自动抽取的事实停在候选态、不会注入，只有你确认过的才会。
          </div>

          <div style="display:flex; gap:8px; margin-top:8px; flex-wrap:wrap;">
            <button
              id="vm-test-external-memory-btn"
              class="vm-btn-secondary"
              type="button"
      onclick="window.vectorMemoryManager.testExternalMemoryServerFromSettings()"
            >测试连接</button>
            <button
              id="vm-reload-external-memory-btn"
              class="vm-btn-secondary"
              type="button"
              onclick="window.vectorMemoryManager.reloadExternalMemoryFromSettings()"
            >从服务器重新加载</button>
          </div>

          <div
            id="vm-external-memory-status"
            style="font-size:12px;color:#999;margin-top:6px;"
          ></div>

          <div style="font-size:11px;color:#999;margin-top:6px;line-height:1.5;">
            使用 VPS 时填写 https://mcp.htw1.uk；启用鉴权后，在本设备填写 Bearer Token。Token 不会提交到 GitHub。
          </div>
        </div>

        <button id="vm-save-settings-btn" class="vm-btn-primary" style="width:100%;margin-top:12px;">保存设置</button>
      </div>
    `;
  }

  saveSettingsFromUI(chat) {
    const vm = this.getVariableMemory(chat);
    vm.settings.autoExtractionMsgInterval = parseInt(document.getElementById('vm-auto-interval')?.value) || 20;
    vm.settings.topN = parseInt(document.getElementById('vm-topn')?.value) || 10;

    const readPositiveInt = (id, fallback) => {
      const value = parseInt(document.getElementById(id)?.value, 10);
      return Number.isFinite(value) && value > 0 ? value : fallback;
    };

    const searchEngine = document.getElementById('vm-search-engine')?.value || 'sqlite';
    vm.settings.searchEngine = (searchEngine === 'hybrid' || searchEngine === 'chroma-hybrid') ? 'hybrid' : 'sqlite';
    vm.settings.sqliteCandidateLimit = readPositiveInt('vm-sqlite-candidate-limit', 6000);
    vm.settings.chromaCandidateLimit = readPositiveInt('vm-chroma-candidate-limit', 2000);
    vm.settings.chromaNResults = readPositiveInt('vm-chroma-nresults', 200);

    const readScoreWeight = (id, fallback) => {
      const value = parseFloat(document.getElementById(id)?.value);
      return Number.isFinite(value) ? value : fallback;
    };

    vm.settings.scoreWeights = {
      semantic: readScoreWeight('vm-w-semantic', 0.4),
      keyword: readScoreWeight('vm-w-keyword', 0.3),
      importance: readScoreWeight('vm-w-importance', 0.2),
      emotion: readScoreWeight('vm-w-emotion', 0.05),
      recency: readScoreWeight('vm-w-recency', 0.05)
    };
    vm.settings.useCustomEmbedding = document.getElementById('vm-custom-embedding')?.checked || false;
    vm.settings.embeddingEndpoint = document.getElementById('vm-embedding-endpoint')?.value || '';
    vm.settings.embeddingApiKey = document.getElementById('vm-embedding-apikey')?.value || '';
    const modelInput = document.getElementById('vm-embedding-model-input')?.value.trim();
    const modelSelect = document.getElementById('vm-embedding-model-select')?.value;
    vm.settings.embeddingModel = modelInput || modelSelect || 'text-embedding-3-small';

    const externalEndpoint = document.getElementById('vm-external-memory-endpoint')?.value.trim() || 'http://127.0.0.1:8765';
    const externalBearerToken = document.getElementById('vm-external-memory-bearer-token')?.value.trim() || '';
    vm.settings.externalMemoryEndpoint = externalEndpoint;
    vm.settings.externalMemoryBearerToken = externalBearerToken;
    localStorage.setItem('vm_external_memory_endpoint', externalEndpoint);
    localStorage.setItem('vm_external_memory_bearer_token', externalBearerToken);

    const planContextEl = document.getElementById('vm-plan-context-enabled');
    if (planContextEl) vm.settings.planContextEnabled = planContextEl.checked;
    
      vm.settings.useCustomExtractionPrompt = document.getElementById('vm-custom-prompt')?.checked || false;
      vm.settings.customExtractionPrompt = document.getElementById('vm-custom-prompt-text')?.value || '';

    if (vm._retrievalCache) vm._retrievalCache = { query: '', result: null, timestamp: 0, msgCount: 0 };
  }

  // ==================== 拉取可用模型 ====================
  async fetchAvailableModels(chat) {
    const vm = this.getVariableMemory(chat);
    const apiConfig = window.state?.apiConfig || {};
    
    // 获取当前界面上的设置
    const endpointInput = document.getElementById('vm-embedding-endpoint')?.value;
    const apiKeyInput = document.getElementById('vm-embedding-apikey')?.value;
    const isCustom = document.getElementById('vm-custom-embedding')?.checked;

    let endpoint = endpointInput;
    let apiKey = apiKeyInput;

    if (!isCustom || !endpoint) {
      const useSecondary = apiConfig.secondaryProxyUrl && apiConfig.secondaryApiKey;
      endpoint = useSecondary ? apiConfig.secondaryProxyUrl : apiConfig.proxyUrl;
      apiKey = useSecondary ? apiConfig.secondaryApiKey : apiConfig.apiKey;
    } else {
      if (!apiKey) apiKey = apiConfig.apiKey; // 留空则回退到主配置
    }

    if (!endpoint || !apiKey) {
      throw new Error('未配置有效的端点或API Key');
    }

    try {
      const url = endpoint.endsWith('/') ? endpoint + 'v1/models' : endpoint + '/v1/models';
      const response = await fetch(url, {
        headers: { 'Authorization': `Bearer ${apiKey}` }
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (!data || !data.data) throw new Error('API 返回格式异常');
      
      const models = data.data.map(m => m.id).sort((a, b) => {
        // 将含有 embedding 的模型排在前面
        const aEmb = a.toLowerCase().includes('embed') || a.toLowerCase().includes('bge');
        const bEmb = b.toLowerCase().includes('embed') || b.toLowerCase().includes('bge');
        if (aEmb && !bEmb) return -1;
        if (!aEmb && bEmb) return 1;
        return a.localeCompare(b);
      });
      
      return models;
    } catch (e) {
      throw new Error(e.message || '网络请求失败');
    }
  }

  // ==================== 便携小白教程 ====================

  renderGuide() {
    return `
      <div class="vm-guide">
        <div style="text-align:center; margin-bottom:20px;">
          <h3 style="font-size:18px; color:#333;">变量记忆 小白指南</h3>
          <p style="font-size:13px; color:#666;">彻底治愈 AI 的“失忆症”</p>
        </div>

        <div class="vm-guide-card">
          <div class="vm-guide-card-title">什么是“变量记忆”？</div>
          <p>它是原本“向量记忆”的究极进化版。你不用再管那些晦涩的“向量”、“语义”词汇，把它当成 AI 的**私人日记本**就行了。</p>
        </div>

        <div class="vm-guide-card">
          <div class="vm-guide-card-title">随意穿梭时间！(重磅功能)</div>
          <p>在记忆列表中，你看到那个日期框了吗？**点它！可以直接改！**</p>
          <p>把时间改到“10年前”，这就会成为你们十年前的初遇记忆；把时间改到“明天”，AI 就会知道这是你们明天的计划。</p>
        </div>

        <div class="vm-guide-card">
          <div class="vm-guide-card-title">它怎么自动记东西？</div>
          <p>什么都不用管！只要你在一直聊天，每聊满 20 句话（设置里可改），系统就会在后台悄悄把值得记住的事写进日记里。完全无感！</p>
        </div>

        <div class="vm-guide-card">
          <div class="vm-guide-card-title">什么是“核心灵魂”？</div>
          <p>分类为【C 核心灵魂】的记忆是无敌的！它们拥有最高权重，永远不会随时间衰减，AI 每一轮都会死死记住它。适合用来写你们的“终极人设”或“生死约定”。</p>
        </div>

        <div class="vm-guide-card">
          <div class="vm-guide-card-title">没配置 API 怎么办？</div>
          <p>完全没关系！如果向量化失败，系统会自动无缝切换为 **本地字面量（BM25）超强检索**，不仅不用消耗 API，找东西依然准得离谱。</p>
        </div>
      </div>
    `;
  }

  // ---- 记忆面板的服务端查询（分页 + 关键词/日期/分类/重要度筛选）----
  // 目的：本地缓存只装最近 5000 条，更早的记忆（比如聊天的第一天）本地筛不到。
  getActivePanelFilters(filters = {}) {
    const active = {};
    const query = String(filters.query || '').trim();
    if (query) active.query = query;
    const category = String(filters.category || '').trim();
    if (category) active.category = category;
    const minImportance = filters.minImportance === undefined || filters.minImportance === null
      ? ''
      : String(filters.minImportance).trim();
    if (minImportance) active.minImportance = minImportance;
    const dateFrom = String(filters.dateFrom || '').trim();
    if (dateFrom) active.dateFrom = dateFrom;
    const dateTo = String(filters.dateTo || '').trim();
    if (dateTo) active.dateTo = dateTo;
    return active;
  }

  getPanelFilterKey(filters = {}) {
    const active = this.getActivePanelFilters(filters);
    return JSON.stringify([
      active.query || '',
      active.category || '',
      active.minImportance || '',
      active.dateFrom || '',
      active.dateTo || ''
    ]);
  }

  // 按浏览器本地时区算日界，避免服务端时区不同导致"差一天"
  getPanelDateBounds(filters = {}) {
    const toTs = (value, endOfDay) => {
      const text = String(value || '').trim();
      if (!text) return null;
      const time = new Date(`${text}T${endOfDay ? '23:59:59.999' : '00:00:00'}`).getTime();
      return Number.isFinite(time) ? time : null;
    };
    return { fromTs: toTs(filters.dateFrom, false), toTs: toTs(filters.dateTo, true) };
  }

  async fetchMemoryPanelPage(chat, filters = {}, offset = 0, pageSize = 100) {
    if (!this.isExternalMemoryEnabled(chat)) return null;
    const active = this.getActivePanelFilters(filters);
    const bounds = this.getPanelDateBounds(filters);

    // 注意 1：这里故意不传 chatId —— 面板一直显示 memory-server 里的全部记忆
    // 注意 2：手写查询串（不依赖 URLSearchParams，老 WebView 也能用）
    const parts = [];
    const appendParam = (key, value) => {
      if (value === undefined || value === null || value === '') return;
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
    };
    appendParam('query', active.query);
    appendParam('category', active.category);
    appendParam('minImportance', active.minImportance);
    appendParam('fromTs', bounds.fromTs);
    appendParam('toTs', bounds.toTs);
    appendParam('limit', pageSize);
    appendParam('offset', Math.max(0, Math.floor(Number(offset) || 0)));
    const queryString = parts.join('&');

    const result = await this.externalMemoryRequest(chat, `/memory/list?${queryString}`, { method: 'GET' });
    const items = (Array.isArray(result?.memories) ? result.memories : []).map(memory => ({
      ...memory,
      embedding: null,
      _externalCache: true
    }));
    return {
      items,
      total: Number(result?.total || items.length) || 0,
      hasMore: result?.hasMore === true
    };
  }

  async loadMemoryPanelPage(chat, container, filters = {}, offset = 0, options = {}) {
    const vm = this.getVariableMemory(chat);
    const filterKey = this.getPanelFilterKey(filters);
    const pageSize = 100;
    const previous = options.append && vm._memPanel ? vm._memPanel : null;
    if (vm._memPanel?.loading) return;

    vm._memPanel = {
      serverMode: true,
      loading: true,
      filterKey,
      items: previous?.items || [],
      total: previous?.total || 0,
      hasMore: previous?.hasMore || false
    };

    try {
      const page = await this.fetchMemoryPanelPage(chat, filters, offset, pageSize);
      if (!page) throw new Error('服务端没有返回记忆列表');
      const merged = previous ? [...previous.items, ...page.items] : page.items;
      const seen = new Set();
      const items = merged.filter(item => {
        const id = String(item?.id || '');
        if (!id || seen.has(id)) return false;
        seen.add(id);
        return true;
      });
      vm._memPanel = {
        serverMode: true,
        loading: false,
        filterKey,
        items,
        total: page.total,
        hasMore: page.hasMore
      };
    } catch (error) {
      console.warn('[变量记忆] 服务端查询记忆失败:', error.message);
      vm._memPanel = {
        serverMode: true,
        loading: false,
        filterKey,
        items: previous?.items || [],
        total: previous?.total || 0,
        hasMore: false,
        error: String(error?.message || error)
      };
    }

    this.renderMemoryUI(chat, container);
  }

  applyPanelFilters(fragments, filters = {}) {
    let result = Array.isArray(fragments) ? [...fragments] : [];

    const query = String(filters.query || '').trim().toLowerCase();
    const category = String(filters.category || '').trim();
    const vector = String(filters.vector || '').trim();
    const minImportance = filters.minImportance === '' || filters.minImportance === undefined
      ? ''
      : Number(filters.minImportance);

    const dateFrom = String(filters.dateFrom || '').trim();
    const dateTo = String(filters.dateTo || '').trim();

    const getMemoryTime = (f) => {
      const time = Number(f.memoryTime || f.createdAt || 0);
      return Number.isFinite(time) ? time : 0;
    };

    if (query) {
      result = result.filter(f => {
        const haystack = [
          f.content,
          f.category,
          f.source,
          f.context,
          ...(Array.isArray(f.tags) ? f.tags : [])
        ].filter(Boolean).join(' ').toLowerCase();

        return haystack.includes(query);
      });
    }

    if (category) {
      result = result.filter(f => f.category === category);
    }

    if (vector === 'vector') {
      result = result.filter(f => this.hasFragmentEmbedding(f));
    } else if (vector === 'bm25') {
      result = result.filter(f => !this.hasFragmentEmbedding(f));
    }

    if (Number.isFinite(minImportance)) {
      result = result.filter(f => Number(f.importance || 0) >= minImportance);
    }

    if (dateFrom) {
      const fromTime = new Date(`${dateFrom}T00:00:00`).getTime();
      if (Number.isFinite(fromTime)) {
        result = result.filter(f => getMemoryTime(f) >= fromTime);
      }
    }

    if (dateTo) {
      const toTime = new Date(`${dateTo}T23:59:59`).getTime();
      if (Number.isFinite(toTime)) {
        result = result.filter(f => getMemoryTime(f) <= toTime);
      }
    }

    return result;
  }

    renderTagChips(tags) {
    if (!Array.isArray(tags) || tags.length === 0) return '';

    const visibleTags = tags.slice(0, 3);
    const extraCount = tags.length - visibleTags.length;

    const chipStyle = `
      display:inline-flex;
      align-items:center;
      max-width:120px;
      padding:2px 7px;
      margin:4px 5px 0 0;
      border-radius:999px;
      background:rgba(0,0,0,0.06);
      color:#666;
      font-size:11px;
      line-height:1.4;
      font-weight:500;
      vertical-align:middle;
      white-space:nowrap;
      overflow:hidden;
      text-overflow:ellipsis;
    `.replace(/\s+/g, ' ').trim();

    const chips = visibleTags.map(tag => {
      const safeTag = this._escapeHtml(String(tag));
      return `<span style="${chipStyle}" title="${safeTag}">#${safeTag}</span>`;
    }).join('');

    const extra = extraCount > 0
      ? `<span style="${chipStyle}" title="还有 ${extraCount} 个标签">+${extraCount}</span>`
      : '';

    return `<div style="margin-top:4px;display:flex;flex-wrap:wrap;gap:0;">${chips}${extra}</div>`;
  }

  showFragmentDetail(chat, id) {
    const frag = this.getFragment(chat, id);
    if (!frag) {
      showToast('未找到这条记忆', 'error');
      return;
    }

    const modal = document.createElement('div');
    modal.className = 'custom-modal-overlay';
    modal.style.cssText = `
      position: fixed;
      inset: 0;
      z-index: 999999;
      background: rgba(0,0,0,0.35);
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 16px;
      box-sizing: border-box;
    `;

    const formatTime = (value, timeZone) => {
      const n = Number(value || 0);
      if (!Number.isFinite(n) || n <= 0) return '';
      return window.TimeZoneUtils?.format(n, timeZone || frag.memoryTimeZone || 'Europe/London') || '';
    };

    const detailRows = [
      ['ID', frag.id || ''],
      ['chatId', frag.chatId || ''],
      ['分类', frag.category || ''],
      ['记忆方式', frag.category === 'C' ? '核心常驻' : '动态召回'],
      ['重要度', frag.importance ?? ''],
      ['情绪权重', frag.emotionalWeight ?? ''],
      ['tags', Array.isArray(frag.tags) ? frag.tags.join(', ') : ''],
      ['source', frag.source || ''],
      ['context', frag.context || ''],
      ['embeddingModel', frag.embeddingModel || ''],
      ['embeddingDim', frag.embeddingDim || 0],
      ['embeddingUpdatedAt', formatTime(frag.embeddingUpdatedAt, frag.embeddingUpdatedAtTimeZone)],
      ['createdAt', formatTime(frag.createdAt, frag.createdAtTimeZone)],
      ['updatedAt', formatTime(frag.updatedAt, frag.updatedAtTimeZone)],
      ['memoryTime', formatTime(frag.memoryTime, frag.memoryTimeZone)],
      ['memoryTimeZone', frag.memoryTimeZone || 'Europe/London'],
      ['lastRecalled', formatTime(frag.lastRecalled, frag.lastRecalledTimeZone)],
      ['动态召回次数', frag.category === 'C' ? '不适用' : (frag.recallCount ?? 0)],
      ['linkedMemories', Array.isArray(frag.linkedMemories) ? frag.linkedMemories.join(', ') : '']
    ];

    const rowsHtml = detailRows.map(([key, value]) => `
      <div style="display:grid;grid-template-columns:130px 1fr;gap:8px;padding:6px 0;border-bottom:1px solid rgba(0,0,0,0.06);">
        <div style="font-weight:600;color:#666;">${this._escapeHtml(String(key))}</div>
        <div style="word-break:break-all;">${this._escapeHtml(String(value ?? ''))}</div>
      </div>
    `).join('');

    modal.innerHTML = `
      <div style="
        width: min(680px, 94vw);
        max-height: 86vh;
        background: #fff;
        border-radius: 18px;
        box-shadow: 0 18px 50px rgba(0,0,0,0.22);
        overflow: hidden;
        display: flex;
        flex-direction: column;
      ">
        <div style="padding:18px 20px 10px;text-align:center;font-size:18px;font-weight:700;">
          记忆详情
        </div>

        <div style="padding:14px 22px;overflow:auto;">
          <div style="font-weight:700;margin-bottom:8px;">内容</div>
          <div style="
            white-space:pre-wrap;
            word-break:break-word;
            background:#f7f7f7;
            border-radius:10px;
            padding:12px;
            margin-bottom:14px;
            line-height:1.6;
          ">${this._escapeHtml(frag.content || '')}</div>

          <div style="font-weight:700;margin-bottom:8px;">元信息</div>
          <div style="font-size:13px;line-height:1.5;">
            ${rowsHtml}
          </div>
        </div>

        <div style="display:flex;border-top:1px solid rgba(0,0,0,0.08);">
          <button id="vm-detail-copy" style="
            flex:1;padding:14px 0;border:none;background:#fff;color:#007aff;font-size:16px;cursor:pointer;
            border-right:1px solid rgba(0,0,0,0.08);
          ">复制JSON</button>
          <button id="vm-detail-close" style="
            flex:1;padding:14px 0;border:none;background:#fff;color:#007aff;font-size:16px;font-weight:700;cursor:pointer;
          ">关闭</button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    const closeModal = () => modal.remove();

    modal.querySelector('#vm-detail-close').addEventListener('click', closeModal);
    modal.addEventListener('click', (event) => {
      if (event.target === modal) closeModal();
    });

    modal.querySelector('#vm-detail-copy').addEventListener('click', async () => {
      const text = JSON.stringify(frag, null, 2);
      try {
        await navigator.clipboard.writeText(text);
        showToast('详情 JSON 已复制', 'success');
      } catch (e) {
        showToast('复制失败', 'error');
      }
    });
  }
  
  // 工具函数
  _escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}

// 绑定全局变量（覆盖旧版，全面接管）
window.vectorMemoryManager = new VariableMemoryManager();
