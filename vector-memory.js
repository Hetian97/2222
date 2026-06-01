// ========================================
// 变量记忆系统 (Variable Memory System)
// 原向量记忆的全面升级版：支持自由时间戳、精细分类
// ========================================

class VariableMemoryManager {
  constructor() {
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
          externalMemoryEndpoint: localStorage.getItem('vm_external_memory_endpoint') || 'http://127.0.0.1:8765'
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

    // 无损迁移旧版 VectorMemory 数据
    if (chat.vectorMemory && !vm._migrated) {
      this._migrateFromVectorMemory(chat);
    }

    return vm;
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
          embedding: null, // 需要重新生成
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

        vm.fragments.push({
          ...frag,
          category: newCat,
          memoryTime: frag.dialogueTimeRange?.start || frag.createdAt || Date.now(), // 优先使用对话时间作为记忆时间
          dialogueTimeRange: undefined // 废弃该字段，统一用 memoryTime
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

  async externalMemoryRequest(chat, path, options = {}) {
    const endpoint = this.getExternalMemoryEndpoint(chat);
    const url = endpoint + path;

    const response = await fetch(url, {
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {})
      },
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

    if (enabledEl) {
      vm.settings.externalMemoryEnabled = enabledEl.checked;
      localStorage.setItem('vm_external_memory_enabled', enabledEl.checked ? 'true' : 'false');
    }

    if (endpointEl) {
      const endpoint = endpointEl.value.trim() || 'http://127.0.0.1:8765';
      vm.settings.externalMemoryEndpoint = endpoint;
      localStorage.setItem('vm_external_memory_endpoint', endpoint);
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
      const res = await fetch(`${endpoint}/health`);
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
      vm.fragments = result.memories.map(memory => ({
        ...memory,
        embedding: memory.embedding || null,
        _externalCache: true
      }));

      vm.stats.totalFragments = vm.fragments.length;
      vm.stats.lastUpdated = Date.now();
      vm._externalListLoadedAt = Date.now();

      console.log('[变量记忆] 已从外部 memory-server 加载记忆列表:', vm.fragments.length);

      return vm.fragments;
    } catch (error) {
      console.warn('[变量记忆] 从外部 memory-server 加载列表失败，继续使用本地缓存:', error.message);
      return null;
    }
  }

  async saveFragmentToExternalServer(chat, fragment) {
    if (!this.isExternalMemoryEnabled(chat)) return null;

    try {
      const result = await this.externalMemoryRequest(chat, '/memory/add', {
        method: 'POST',
        body: fragment
      });

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

    const embedding = Array.isArray(data.embedding) && data.embedding.length > 0
      ? data.embedding
      : null;

    const fragment = {
      id,
      chatId: chat.id || chat.chatId || window.state?.activeChatId || null,
      content: data.content,
      tags: data.tags || [],
      category: data.category || 'E',
      importance: data.importance || 5,
      emotionalWeight: data.emotionalWeight || 3,
      createdAt: Date.now(),
      memoryTime: data.memoryTime || Date.now(), // 发生时间（可自由修改）
      lastRecalled: 0,
      recallCount: 0,
      embedding,
      embeddingModel: embedding ? this.getCurrentEmbeddingModel(chat) : '',
      embeddingDim: embedding ? embedding.length : 0,
      embeddingUpdatedAt: embedding ? Date.now() : '',
      linkedMemories: data.linkedMemories || [],
      source: data.source || 'auto',
      context: data.context || ''
    };

    vm.fragments.push(fragment);

    if (this.isExternalMemoryEnabled(chat)) {
      this.saveFragmentToExternalServer(chat, fragment);
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

    if (updates.tags !== undefined) frag.tags = updates.tags;
    if (updates.category !== undefined) frag.category = updates.category;
    if (updates.importance !== undefined) frag.importance = updates.importance;
    if (updates.emotionalWeight !== undefined) frag.emotionalWeight = updates.emotionalWeight;
    if (updates.memoryTime !== undefined) frag.memoryTime = updates.memoryTime; // 核心：修改发生时间
    if (updates.linkedMemories !== undefined) frag.linkedMemories = updates.linkedMemories;
    if (updates.context !== undefined) frag.context = updates.context;

    if (!frag.chatId) {
      frag.chatId = chat.id || chat.chatId || window.state?.activeChatId || null;
    }

    if (contentChanged) {
      frag.embedding = null;
      frag.embeddingModel = '';
      frag.embeddingDim = 0;
      frag.embeddingUpdatedAt = '';

      try {
        const embedding = await this.getEmbedding(frag.content, chat);

        if (Array.isArray(embedding) && embedding.length > 0) {
          frag.embedding = embedding;
          frag.embeddingModel = this.getCurrentEmbeddingModel(chat);
          frag.embeddingDim = embedding.length;
          frag.embeddingUpdatedAt = Date.now();

          console.log('[变量记忆] 编辑后已重新生成 embedding:', frag.id, 'dim=', embedding.length);
        } else {
          console.warn('[变量记忆] 编辑后未能生成 embedding，继续保存为 BM25:', frag.id);
        }
      } catch (error) {
        console.warn('[变量记忆] 编辑后重新生成 embedding 失败:', error.message);
        frag.embedding = null;
        frag.embeddingModel = '';
        frag.embeddingDim = 0;
        frag.embeddingUpdatedAt = '';
      }
    }

    vm.stats.lastUpdated = Date.now();

    if (this.isExternalMemoryEnabled(chat)) {
      this.saveFragmentToExternalServer(chat, frag);
    }

    return true;
  }

  deleteFragment(chat, id) {
    const vm = this.getVariableMemory(chat);
    vm.fragments = vm.fragments.filter(f => f.id !== id);
    // 清理关联引用
    vm.fragments.forEach(f => {
      f.linkedMemories = (f.linkedMemories || []).filter(lid => lid !== id);
    });
    vm.stats.totalFragments = vm.fragments.length;
    vm.stats.lastUpdated = Date.now();

    if (this.isExternalMemoryEnabled(chat)) {
      this.deleteFragmentFromExternalServer(chat, id);
    }
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
        ? new Date(timeValue).toLocaleString('zh-CN')
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
  batchDelete(chat, selectedItems) {
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

    vm.fragments.forEach(f => {
      f.linkedMemories = (f.linkedMemories || []).filter(lid => !deletedIds.includes(lid));
    });

    vm.stats.totalFragments = vm.fragments.length;
    vm.stats.lastUpdated = Date.now();

    if (this.isExternalMemoryEnabled(chat)) {
      deletedIds.forEach(id => this.deleteFragmentFromExternalServer(chat, id));
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

      if (this.isExternalMemoryEnabled(chat)) {
        oldIds.forEach(id => this.deleteFragmentFromExternalServer(chat, id));
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

  addCoreMemory(chat, content) {
    return this.createFragment(chat, { content, category: 'C', importance: 10, tags: ['核心设定'] });
  }

  async editCoreMemory(chat, id, newContent) {
    await this.editFragment(chat, id, { content: newContent });
  }

  deleteCoreMemory(chat, id) {
    this.deleteFragment(chat, id);
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

    const scored = vm.fragments.map(frag => {
      // 核心记忆 C 类直接满分，保证绝对不被遗忘
      if (frag.category === 'C') {
        return { fragment: frag, score: 999 };
      }

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
    let results = scored.slice(0, topN).filter(r => r.score > 0.1 || r.fragment.category === 'C');

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

  async serializeForPrompt(chat, recentMessages = '') {
    const vm = this.getVariableMemory(chat);
    let output = '';

    // 核心灵魂设定
    const coreStr = this.serializeCoreMemories(chat);
    if (coreStr) output += coreStr + '\n';

    // 动态向量检索
    if (recentMessages && vm.fragments.length > 0) {
      const results = await this.retrieveRelevant(chat, recentMessages);
      // 过滤掉已经在核心里的
      const nonCoreResults = results.filter(r => r.fragment.category !== 'C');
      
      if (nonCoreResults.length > 0) {
        output += '## 回闪记忆 (根据当前情境唤醒的记忆片段)\n';
        // 按时间发生顺序排序，让 AI 更有时间观念
        nonCoreResults.sort((a, b) => a.fragment.memoryTime - b.fragment.memoryTime);
        
        const cats = this.getCategories(chat);
        for (const r of nonCoreResults) {
          const cat = cats[r.fragment.category] || { icon: '' };
          const dateStr = new Date(r.fragment.memoryTime).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
          output += `[${dateStr}] ${r.fragment.content}\n`;
        }
        output += '\n';
      }
    }

    if (!output.trim()) output = '(暂无记忆)\n';

    return `## 你的变量记忆档案
[系统强制指令：你必须将以下提取出的记忆作为你真实的过去，并在对话中自然地表现出你记得这些事。]
${output}`;
  }

  // ==================== AI 提取记忆 (修复间隔 Bug) ====================

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

    return `
# 你的任务
你是"${chat.originalName || chat.name}"。请阅读下面的最新对话记录，提取【值得长期记忆】的增量信息，输出为JSON数组格式。

# 输出格式（严格遵守JSON数组）
\`\`\`json
[
  {
    "content": "记忆内容（第一人称，简短清晰，如：用户告诉我她今天升职了）",
    "tags": ["升职", "开心", "工作"],
    "category": "U/A/R/E/I/L/P/T/M/C",
    "importance": 1-10,
    "emotionalWeight": 1-10
  }
]
\`\`\`

# 10大精细分类说明
- U = 用户设定 (用户的外貌/性格/喜好/身份等)
- A = 角色设定 (你自己发生的改变)
- R = 关系发展 (表白/吵架/亲密举动等里程碑)
- E = 经历/事件 (共同经历的事情)
- I = 物品/礼物 (送礼/买东西)
- L = 地点/场景 (去过的重要地方)
- P = 承诺/计划 (约定的未来事项)
- T = 禁忌/规则 (雷区/规矩)
- M = 情绪/心理 (强烈的情感流露/阴影)
- C = 核心灵魂 (必须永远铭记的生死攸关的事)

# 评分规则 (1-10)
- importance: 8-10(极其重要/转折点)，5-7(值得记住)，1-4(日常琐事，尽量别记)
- emotionalWeight: 情感的强烈程度。

# 待提取对话
${formattedHistory}

请直接输出JSON数组，如果没有值得记录的内容，输出空数组 []。`;
  }

  parseExtractionResult(rawText) {
    try {
      const jsonMatch = rawText.match(/\[[\s\S]*\]/);
      if (!jsonMatch) return [];
      const arr = JSON.parse(jsonMatch[0]);
      if (!Array.isArray(arr)) return [];
      const cats = Object.keys(this.DEFAULT_CATEGORIES);
      return arr.filter(item => item && item.content).map(item => ({
        content: String(item.content).trim(),
        tags: Array.isArray(item.tags) ? item.tags.map(t => String(t).trim()) : [],
        category: cats.includes(item.category) ? item.category : 'E',
        importance: Math.min(10, Math.max(1, parseInt(item.importance) || 5)),
        emotionalWeight: Math.min(10, Math.max(1, parseInt(item.emotionalWeight) || 3))
      }));
    } catch (e) {
      console.error('[变量记忆] 解析提取结果失败:', e);
      return [];
    }
  }

  async mergeExtractedMemories(chat, extractedItems, defaultTime = Date.now()) {
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
        memoryTime: defaultTime // 新提取的记忆发生时间默认为传入时间
      });
      newIds.push(id);
    }
    
    // 更新最后提取的消息索引 (修复每轮都提取的Bug)
    if (this._tempLastMsgIndex !== undefined && this._tempLastMsgIndex !== -1) {
      vm.settings.lastExtractedMsgIndex = this._tempLastMsgIndex;
    }

    return newIds;
  }

  // 获取状态和待提取信息
  getStats(chat) {
    const vm = this.getVariableMemory(chat);
    const frags = vm.fragments || [];
    
    // 基于消息索引计算未提取消息数
    const historyLen = chat.history ? chat.history.length : 0;
    const lastIdx = vm.settings.lastExtractedMsgIndex !== undefined ? vm.settings.lastExtractedMsgIndex : -1;
    const unextractedMessages = Math.max(0, historyLen - 1 - lastIdx);
    
    const autoInterval = vm.settings.autoExtractionMsgInterval || 20;
    const remainingToAuto = Math.max(0, autoInterval - unextractedMessages);
    
    const embeddedCount = frags.filter(f => f.embedding).length;
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

  renderMemoryUI(chat, container) {
    const vm = this.getVariableMemory(chat);
    const stats = this.getStats(chat);
    container.innerHTML = '';

    // 顶部工具栏
    const toolbar = document.createElement('div');
    toolbar.className = 'vm-toolbar';
    toolbar.innerHTML = `
      <button class="vm-toolbar-btn" id="vm-add-fragment-btn">添加记忆</button>
      <button class="vm-toolbar-btn" id="vm-add-core-btn">添加核心</button>
      <button class="vm-toolbar-btn" id="vm-batch-toggle-btn">批量操作</button>
      <div style="flex:1"></div>
      <button class="vm-toolbar-btn vm-primary" id="vm-summary-btn" title="剩余 ${stats.remainingToAuto} 条消息后自动触发">
        提取记忆 (${stats.unextractedMessages}/${stats.autoInterval})
      </button>
      <button class="vm-toolbar-btn" id="vm-export-btn">导出全部</button>
      <button class="vm-toolbar-btn" id="vm-import-btn">导入</button>
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
      minImportance: ''
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

      <button class="vm-toolbar-btn" id="vm-reset-filter-btn">重置</button>
    `;

    container.appendChild(filterBar);

    // 记忆列表区
    const listContainer = document.createElement('div');
    listContainer.className = 'vm-list-container';
    
    const categories = this.getCategories(chat);
    const displayFragments = this.applyPanelFilters(vm.fragments || [], vm._panelFilters || {});
    
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
          <span class="vm-section-count">${frags.length}</span>
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

        const dateObj = new Date(rawTime);
        
        // 处理时区偏移
        let localISOTime = '';
        if (!Number.isNaN(dateObj.getTime())) {
          const tzOffset = dateObj.getTimezoneOffset() * 60000;
          localISOTime = new Date(dateObj.getTime() - tzOffset).toISOString().slice(0, 16);
        } else {
          const fallbackDate = new Date();
          const tzOffset = fallbackDate.getTimezoneOffset() * 60000;
          localISOTime = new Date(fallbackDate.getTime() - tzOffset).toISOString().slice(0, 16);
        }

        row.innerHTML = `
          <input type="checkbox" class="vm-batch-element vm-item-checkbox" style="display:none; margin-right:10px; width: 16px; height: 16px; flex-shrink: 0; align-self: flex-start; margin-top: 4px;" data-id="${frag.id}" data-type="${code === 'C' ? 'core' : 'fragment'}">
          <div class="vm-item-main">
            <span class="vm-item-content">${this._escapeHtml(frag.content)}</span>
            ${this.renderTagChips(frag.tags)}
            <div class="vm-item-meta">
              <input type="datetime-local" class="vm-time-picker" data-id="${frag.id}" value="${localISOTime}" title="修改记忆发生时间">
              <span class="vm-meta-tag">重要度:${frag.importance}</span>
              ${frag.embedding ? '<span class="vm-meta-tag" title="已向量化">Vector✓</span>' : '<span class="vm-meta-tag" style="color:#ff9500">BM25</span>'}
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
      listContainer.innerHTML = `
        <div style="text-align:center; color: #999; padding: 40px 20px;">
          <div style="font-size:40px; margin-bottom:10px;"></div>
          <p style="font-size: 16px; font-weight:bold; color:#666;">变量记忆是空的</p>
          <p style="font-size: 13px; margin-top: 5px;">继续聊天，当新消息达到 ${stats.autoInterval} 条时，系统会自动提取记忆。</p>
          <p style="font-size: 13px;">你也可以手动点击上方按钮添加。</p>
        </div>
      `;
    }

    container.appendChild(listContainer);
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
            <label>多维打分权重分布</label>
            <div class="vm-weights">
              <div><span>语义(Vector)</span><input type="number" id="vm-w-semantic" value="${s.scoreWeights.semantic}" step="0.1" class="vm-input-sm"></div>
              <div><span>字面(BM25)</span><input type="number" id="vm-w-keyword" value="${s.scoreWeights.keyword}" step="0.1" class="vm-input-sm"></div>
              <div><span>重要度(Importance)</span><input type="number" id="vm-w-importance" value="${s.scoreWeights.importance}" step="0.1" class="vm-input-sm"></div>
              <div><span>时间衰减(Decay)</span><input type="number" id="vm-w-recency" value="${s.scoreWeights.recency}" step="0.1" class="vm-input-sm"></div>
            </div>
            <div style="font-size:11px;color:#999;margin-top:4px;">注意：如果无 Embedding API，系统会自动用 BM25 算法替代，依然精准！核心记忆(C类)永远是满分免疫衰减。</div>
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
            <input type="password" id="vm-embedding-apikey" value="${s.embeddingApiKey || ''}" placeholder="API Key (留空则使用主设置的Key)" class="vm-input-full" style="margin-top:4px;">
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
            开启后，后续可连接本地 SQLite memory-server。电脑端通常使用 http://127.0.0.1:8765，手机端可使用 Tailscale 地址。
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
    vm.settings.scoreWeights = {
      semantic: parseFloat(document.getElementById('vm-w-semantic')?.value) || 0.4,
      keyword: parseFloat(document.getElementById('vm-w-keyword')?.value) || 0.3,
      importance: parseFloat(document.getElementById('vm-w-importance')?.value) || 0.2,
      recency: parseFloat(document.getElementById('vm-w-recency')?.value) || 0.05,
      emotion: 0.05
    };
    vm.settings.useCustomEmbedding = document.getElementById('vm-custom-embedding')?.checked || false;
    vm.settings.embeddingEndpoint = document.getElementById('vm-embedding-endpoint')?.value || '';
    vm.settings.embeddingApiKey = document.getElementById('vm-embedding-apikey')?.value || '';
    const modelInput = document.getElementById('vm-embedding-model-input')?.value.trim();
    const modelSelect = document.getElementById('vm-embedding-model-select')?.value;
    vm.settings.embeddingModel = modelInput || modelSelect || 'text-embedding-3-small';
    
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

  applyPanelFilters(fragments, filters = {}) {
    let result = Array.isArray(fragments) ? [...fragments] : [];

    const query = String(filters.query || '').trim().toLowerCase();
    const category = String(filters.category || '').trim();
    const vector = String(filters.vector || '').trim();
    const minImportance = filters.minImportance === '' || filters.minImportance === undefined
      ? ''
      : Number(filters.minImportance);

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
      result = result.filter(f => Array.isArray(f.embedding) && f.embedding.length > 0);
    } else if (vector === 'bm25') {
      result = result.filter(f => !Array.isArray(f.embedding) || f.embedding.length === 0);
    }

    if (Number.isFinite(minImportance)) {
      result = result.filter(f => Number(f.importance || 0) >= minImportance);
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

    const formatTime = (value) => {
      const n = Number(value || 0);
      if (!Number.isFinite(n) || n <= 0) return '';
      const d = new Date(n);
      if (Number.isNaN(d.getTime())) return '';
      return d.toLocaleString('zh-CN');
    };

    const detailRows = [
      ['ID', frag.id || ''],
      ['chatId', frag.chatId || ''],
      ['分类', frag.category || ''],
      ['重要度', frag.importance ?? ''],
      ['情绪权重', frag.emotionalWeight ?? ''],
      ['tags', Array.isArray(frag.tags) ? frag.tags.join(', ') : ''],
      ['source', frag.source || ''],
      ['context', frag.context || ''],
      ['embeddingModel', frag.embeddingModel || ''],
      ['embeddingDim', frag.embeddingDim || 0],
      ['embeddingUpdatedAt', formatTime(frag.embeddingUpdatedAt)],
      ['createdAt', formatTime(frag.createdAt)],
      ['updatedAt', formatTime(frag.updatedAt)],
      ['memoryTime', formatTime(frag.memoryTime)],
      ['lastRecalled', formatTime(frag.lastRecalled)],
      ['recallCount', frag.recallCount ?? 0],
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
