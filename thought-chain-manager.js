const ThoughtChainManager = {
    items: [],
    enabled: true,
    selectedIds: [],
    draggedItemId: null,
    activeMode: 'chat',
    modes: {
        chat: {
            label: '聊天',
            enabledKey: 'ephone_thought_chain_enabled',
            itemsKey: 'ephone_thought_chain_items',
            defaultEnabled: true
        },
        call: {
            label: '通话',
            enabledKey: 'ephone_thought_chain_call_enabled',
            itemsKey: 'ephone_thought_chain_call_items',
            defaultEnabled: false
        },
        offline: {
            label: '线下',
            enabledKey: 'ephone_thought_chain_offline_enabled',
            itemsKey: 'ephone_thought_chain_offline_items',
            defaultEnabled: false
        }
    },

    // ==================== 手动兼容设置（behavior） ====================
    // 与上游 wq70/2222 的字段名保持一致：
    //   prefillEnabled   发送底部 / Assistant 预填条目（关闭 → 请求不再以 model/assistant 轮结尾，
    //                    可规避 Gemini flash 的 400: Requests ending with a model turn are not supported）
    //   extractionEnabled 提取思考内容；extractionMode = tags | regex
    //   startMarker / endMarker / extractionRegex / ignoreCase / removeFromBody
    //   allowMissingStart 兼容缺少开始标记（预填充关闭时靠结束标记反向截取，必须为 true）
    //   extractAll        提取全部匹配
    defaultBehavior: {
        prefillEnabled: true,
        extractionEnabled: true,
        extractionMode: 'tags',
        startMarker: '<thinking>',
        endMarker: '</thinking>',
        extractionRegex: '',
        ignoreCase: true,
        removeFromBody: true,
        allowMissingStart: true,
        extractAll: false,
        // 关闭预填充后模型可能完全不打标记：把 JSON 正文之前的内容当思考内容
        fallbackBeforeJson: true
    },

    // 按模式隔离：线上 / 通话 / 线下各有自己的兼容设置
    behaviors: {},

    // 通话模式自己用 JSON thought_chain_block 方案，不参与通用注入
    modeBehaviorOverrides: {
        call: {
            prefillEnabled: false,
            extractionEnabled: false,
            manageOwnInjection: true
        }
    },

    getBehaviorStorageKey(mode = this.activeMode) {
        return `ephone_thought_chain_behavior_${this.modes[mode] ? mode : 'chat'}`;
    },

    normalizeBehavior(behavior) {
        const merged = { ...this.defaultBehavior, ...(behavior && typeof behavior === 'object' ? behavior : {}) };
        merged.extractionMode = merged.extractionMode === 'regex' ? 'regex' : 'tags';
        merged.startMarker = typeof merged.startMarker === 'string' ? merged.startMarker : this.defaultBehavior.startMarker;
        merged.endMarker = typeof merged.endMarker === 'string' ? merged.endMarker : this.defaultBehavior.endMarker;
        merged.extractionRegex = typeof merged.extractionRegex === 'string' ? merged.extractionRegex : '';
        ['prefillEnabled', 'extractionEnabled', 'ignoreCase', 'removeFromBody', 'allowMissingStart', 'extractAll', 'fallbackBeforeJson'].forEach(key => {
            merged[key] = merged[key] !== false;
        });
        // extractAll 历史上默认是 false，与其它开关相反
        merged.extractAll = behavior && behavior.extractAll === true;
        return merged;
    },

    loadBehavior(mode = this.activeMode) {
        const resolvedMode = this.modes[mode] ? mode : 'chat';
        if (this.behaviors[resolvedMode]) return this.behaviors[resolvedMode];

        let stored = null;
        try {
            stored = localStorage.getItem(this.getBehaviorStorageKey(resolvedMode));
            // 兼容上游单模式键：只在本地没有该模式的独立设置时作为兜底
            if (!stored) stored = localStorage.getItem('ephone_thought_chain_behavior');
        } catch (e) {
            stored = null;
        }

        let parsed = null;
        if (stored) {
            try {
                parsed = JSON.parse(stored);
            } catch (error) {
                console.warn('思维链兼容设置读取失败，已使用默认值:', error);
                parsed = null;
            }
        }

        const behavior = this.normalizeBehavior({ ...(parsed || {}), ...(this.modeBehaviorOverrides[resolvedMode] || {}) });
        this.behaviors[resolvedMode] = behavior;
        return behavior;
    },

    getBehavior(mode = this.activeMode) {
        return this.behaviors[this.modes[mode] ? mode : 'chat'] || this.loadBehavior(mode);
    },

    saveBehavior(mode = this.activeMode) {
        const resolvedMode = this.modes[mode] ? mode : 'chat';
        const behavior = this.behaviors[resolvedMode];
        if (!behavior) return;
        try {
            localStorage.setItem(this.getBehaviorStorageKey(resolvedMode), JSON.stringify(behavior));
        } catch (e) {
            console.warn('思维链兼容设置保存失败:', e);
        }
    },

    getStateSnapshot() {
        return JSON.stringify({ enabled: this.enabled, items: this.items, behavior: this.getBehavior() });
    },

    setSavedSnapshot() {
        this.lastSavedSnapshot = this.getStateSnapshot();
        this.updateDirtyState();
    },

    updateDirtyState() {
        const indicator = document.getElementById('thought-chain-unsaved-indicator');
        if (!indicator) return;
        const dirty = !!this.lastSavedSnapshot && this.getStateSnapshot() !== this.lastSavedSnapshot;
        indicator.hidden = !dirty;
    },

    // 是否允许给“当前模式”发送底部 assistant 预填
    shouldUsePrefill(mode = this.activeMode) {
        return this.getBehavior(mode).prefillEnabled !== false;
    },

    // 某个底部条目是否发送：条目级 on/off 优先，auto 跟随当前模式的 compatibility 设置
    shouldSendBottomItem(item, mode = this.activeMode) {
        if (!item) return false;
        const itemMode = item.prefillMode || 'auto';
        if (itemMode === 'on') return true;
        if (itemMode === 'off') return false;
        return this.shouldUsePrefill(mode);
    },

    getSkippedBottomItems(mode = this.activeMode) {
        const chunks = this.getPayloadChunks(mode);
        return (chunks.bottom || []).filter(item => item && item.content && !this.shouldSendBottomItem(item, mode));
    },

    getBottomPayloadMessages(mode = this.activeMode) {
        const chunks = this.getPayloadChunks(mode);
        return (chunks.bottom || [])
            .filter(item => item && item.content && this.shouldSendBottomItem(item, mode))
            .map(item => ({
                role: item.role || 'assistant',
                content: item.content
            }));
    },

    // 当前模式是否启用（非当前模式读存储值）
    isModeEnabled(mode = this.activeMode) {
        const resolvedMode = this.modes[mode] ? mode : 'chat';
        if (resolvedMode === this.activeMode) return this.enabled !== false;
        return !!this.getStoredModeState(resolvedMode).enabled;
    },

    // 关闭预填充时，往 system prompt 补的替代约束（保持“能提取到思考”）
    buildPrefillFallbackSystemPrompt(mode = this.activeMode) {
        const behavior = this.getBehavior(mode);
        // 该模式没开思维链：不要注入任何约束
        if (!this.isModeEnabled(mode)) return '';
        // 通话模式自管注入，不需要这条兜底约束
        if (behavior.manageOwnInjection) return '';
        if (this.shouldUsePrefill(mode)) return '';
        if (behavior.extractionEnabled === false) return '';

        const chunks = this.getPayloadChunks(mode);
        const triggerTexts = (chunks.bottom || [])
            .filter(item => item && item.content && (item.role || 'assistant') === 'assistant')
            .map(item => String(item.content).trim())
            .filter(Boolean);
        if (!triggerTexts.length) return '';

        const startMarker = behavior.startMarker || '<thinking>';
        const endMarker = behavior.endMarker || '</thinking>';
        const opener = triggerTexts.find(text => text.indexOf(startMarker) === 0) || startMarker;

        const thinkingModules = (chunks.head || []).concat(chunks.middle || [])
            .map(item => String(item && item.content || '').trim())
            .filter(Boolean)
            .join('\n');

        const lines = [
            '# 【思维链输出格式（本轮未使用预填充，必须严格遵守）】',
            '- 本轮已关闭 assistant 预填充，没有替你预填任何开头文本。',
            '- 基础要求：你的回复【必须】仍然是完整的 JSON 数组，数组元素仍然是本轮的行动指令，格式不变。',
            '- 强制要求：数组的【第一个对象】必须是思维链块，且必须写成：',
            '{"type":"thought_chain_block","content":"你本轮的内部判断"}',
            '- thought_chain_block 是前端用来显示“深度思考”的块，不是角色说出口的话，不得写进任何 text / voice_message / offline_text 的正式内容里。',
            '  （线下模式请把它作为数组的第一个元素单独放，不要在 offline_text 内部再输出这个对象）',
            '- 数组里【必须】至少再有一条正式内容，禁止只返回 thought_chain_block。',
            '- 禁止省略 thought_chain_block，禁止输出“思维链无法显示”“系统不展示思维链”之类的解释当台词。',
            `- 如果你更习惯用标记，也可以先输出 ${opener} ... ${endMarker} 再接 JSON 数组，两者任选其一，但必须能让人看出你的思考内容。`,
            '- 示例：',
            '[',
            '  {"type":"thought_chain_block","content":"他这句话在试探我，我先顺着话题，别急着解释。"},',
            '  {"type":"text","content":"嗯，我在听。"}',
            ']'
        ];

        if (thinkingModules) {
            lines.push(
                '',
                '- thought_chain_block 的 content 必须按下面的思考要点逐项展开（这是你本轮的内部判断依据）：',
                thinkingModules
            );
        }

        return lines.join('\n');
    },

    // 未显式传模式时，按当前活跃聊天推断：线下模式 → offline，其余 → chat
    // （通话模式有独立的解析器，不走这里）
    resolveExtractionMode(mode) {
        if (mode && this.modes[mode]) return mode;
        try {
            if (typeof state !== 'undefined' && state && state.activeChatId && state.chats && state.chats[state.activeChatId]) {
                const chat = state.chats[state.activeChatId];
                if (chat && chat.settings && chat.settings.isOfflineMode) return 'offline';
            }
        } catch (e) {
            /* 推断失败时回退到当前模式 */
        }
        return this.modes[this.activeMode] ? this.activeMode : 'chat';
    },

    // ==================== 思考提取（上游 extractReasoning 同款） ====================
    extractReasoning(rawContent, mode = null) {
        const raw = typeof rawContent === 'string' ? rawContent : String(rawContent ?? '');
        const config = this.getBehavior(this.resolveExtractionMode(mode));
        if (!config.extractionEnabled || !raw) return { reasoning: '', body: raw, matches: [], error: null };

        try {
            let source = '';
            if (config.extractionMode === 'regex') {
                if (!config.extractionRegex) return { reasoning: '', body: raw, matches: [], error: '正则表达式为空' };
                source = config.extractionRegex;
            } else {
                const escapeRegex = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const start = escapeRegex(config.startMarker || '');
                const end = escapeRegex(config.endMarker || '');
                if (!end) return { reasoning: '', body: raw, matches: [], error: '结束标记为空' };
                const comparisonRaw = config.ignoreCase ? raw.toLowerCase() : raw;
                const comparisonStart = config.ignoreCase ? String(config.startMarker || '').toLowerCase() : String(config.startMarker || '');
                const hasStartMarker = !!comparisonStart && comparisonRaw.includes(comparisonStart);
                if (start && hasStartMarker) source = `${start}([\\s\\S]*?)${end}`;
                else if (config.allowMissingStart) source = `^([\\s\\S]*?)${end}`;
                else if (start) source = `${start}([\\s\\S]*?)${end}`;
                else source = `^([\\s\\S]*?)${end}`;
            }

            let flags = config.ignoreCase ? 'i' : '';
            if (config.extractAll) flags += 'g';
            const regex = new RegExp(source, flags);
            const matches = [];
            if (config.extractAll) {
                let match;
                while ((match = regex.exec(raw)) !== null) {
                    matches.push({ full: match[0], content: (match[1] ?? match[0]).trim() });
                    if (match[0] === '') regex.lastIndex += 1;
                }
            } else {
                const match = regex.exec(raw);
                if (match) matches.push({ full: match[0], content: (match[1] ?? match[0]).trim() });
            }

            let body = raw;
            if (config.removeFromBody) matches.forEach(match => { body = body.replace(match.full, ''); });
            let reasoning = matches.map(match => match.content).filter(Boolean).join('\n\n');

            // 方式二（最可靠）：模型按 system 约束在 JSON 数组首位返回 thought_chain_block
            let usedFallback = false;
            if (!reasoning) {
                const blockExtraction = this.extractThoughtChainBlocks(body);
                if (blockExtraction.reasoning) {
                    reasoning = blockExtraction.reasoning;
                    body = blockExtraction.body;
                    usedFallback = true;
                }
            }

            // 方式三：模型完全没打任何标记，把 JSON 正文之前的那段文字当思考内容
            if (!reasoning && config.fallbackBeforeJson !== false) {
                const fallback = this.extractLeadingNonJson(body);
                if (fallback.reasoning) {
                    reasoning = fallback.reasoning;
                    body = fallback.body;
                    usedFallback = true;
                }
            }

            this.reportExtractionDebug(config, raw, reasoning, usedFallback);

            return {
                reasoning,
                body: body.trim(),
                matches,
                usedFallback,
                error: null
            };
        } catch (error) {
            return { reasoning: '', body: raw, matches: [], error: error.message || String(error) };
        }
    },

    // 从 JSON 数组/对象里摘出 thought_chain_block，并把它们从正文中移除
    extractThoughtChainBlocks(text) {
        const source = typeof text === 'string' ? text : String(text ?? '');
        const firstBracket = source.indexOf('[');
        const firstBrace = source.indexOf('{');
        let startIndex = -1;
        if (firstBracket !== -1 && firstBrace !== -1) startIndex = Math.min(firstBracket, firstBrace);
        else startIndex = firstBracket !== -1 ? firstBracket : firstBrace;
        if (startIndex === -1) return { reasoning: '', body: source };

        const endIndex = Math.max(source.lastIndexOf(']'), source.lastIndexOf('}'));
        if (endIndex <= startIndex) return { reasoning: '', body: source };

        const jsonText = source.slice(startIndex, endIndex + 1);
        let parsed = null;
        try {
            parsed = JSON.parse(jsonText);
        } catch (e) {
            // 末尾可能还有截断内容，退一步按“最后一个完整对象”再试一次
            const lastBrace = jsonText.lastIndexOf('}');
            if (lastBrace !== -1) {
                try { parsed = JSON.parse(jsonText.slice(0, lastBrace + 1) + ']'); } catch (e2) { parsed = null; }
            }
            if (!parsed) return { reasoning: '', body: source };
        }

        const list = Array.isArray(parsed) ? parsed : [parsed];
        const thoughts = [];
        const kept = list.filter(item => {
            if (item && typeof item === 'object' && item.type === 'thought_chain_block') {
                const content = String(item.content || item.text || '').trim();
                if (content) thoughts.push(content);
                return false;
            }
            return true;
        });
        if (!thoughts.length) return { reasoning: '', body: source };

        const serialized = JSON.stringify(kept, null, 2);
        return {
            reasoning: thoughts.join('\n\n'),
            body: source.slice(0, startIndex).trim() + (source.slice(0, startIndex).trim() ? '\n' : '') + serialized
        };
    },

    // 取正文 JSON（数组或对象）之前的前置文本作为思考内容
    extractLeadingNonJson(text) {
        const source = typeof text === 'string' ? text : String(text ?? '');
        const arrayIndex = source.indexOf('[');
        const objectIndex = source.indexOf('{');
        let jsonIndex = -1;
        if (arrayIndex !== -1 && objectIndex !== -1) jsonIndex = Math.min(arrayIndex, objectIndex);
        else jsonIndex = arrayIndex !== -1 ? arrayIndex : objectIndex;
        if (jsonIndex <= 0) return { reasoning: '', body: source };
        return {
            reasoning: source.slice(0, jsonIndex).trim(),
            body: source.slice(jsonIndex).trim()
        };
    },

    // 提取失败时的诊断日志（移动端控制台可见）：只提示一次，避免刷屏
    reportExtractionDebug(config, raw, reasoning, usedFallback) {
        const mode = this.resolveExtractionMode(null);
        if (reasoning) {
            if (usedFallback) {
                console.log('[思维链] 已按“thought_chain_block / 无标记思考”兜底提取到思考内容。');
            }
            return;
        }
        if (this._extractionWarned && this._extractionWarned[mode]) return;
        this._extractionWarned = this._extractionWarned || {};
        this._extractionWarned[mode] = true;
        const ruleText = config.extractionMode === 'regex'
            ? `正则「${config.extractionRegex || '(空)'}」`
            : `标记「${config.startMarker} / ${config.endMarker}」`;
        console.warn(
            `[思维链] 未提取到思考内容：原始返回既没有命中 ${ruleText}，` +
            'JSON 里也没有 thought_chain_block，JSON 之前也没有前置文字。' +
            `原始返回开头 240 字：${String(raw).slice(0, 240)}`
        );
    },

    // ==================== 消息注入（上游 injectIntoMessages 同款） ====================
    injectIntoMessages(messages, mode = this.activeMode) {
        const history = Array.isArray(messages) ? messages.slice() : [];
        let result = history.slice();
        // 该模式没开思维链就什么都不注入（非当前模式要读存储值，不能只看 this.enabled）
        if (!this.isModeEnabled(mode)) return result;
        const behavior = this.getBehavior(mode);
        if (behavior.manageOwnInjection) return result;

        const chunks = this.getPayloadChunks(mode);
        const asMessage = item => ({ role: item.role, content: item.content });
        const beforeMessages = chunks.before_history.map(asMessage);
        result = [...beforeMessages, ...result];

        const insertedAnchors = [];
        chunks.in_chat.forEach(item => {
            const depth = Math.max(0, Number(item.depth) || 0);
            const anchor = beforeMessages.length + Math.max(0, history.length - Math.min(depth, history.length));
            const offset = insertedAnchors.filter(existingAnchor => existingAnchor <= anchor).length;
            const index = anchor + offset;
            result.splice(index, 0, asMessage(item));
            insertedAnchors.push(anchor);
        });

        result.push(...chunks.after_history.map(asMessage));
        if (behavior.prefillEnabled) result.push(...chunks.bottom.map(asMessage));
        return result;
    },

    defaultItems: [
        {
            id: 'tc_head_1',
            name: '思维链开启引导',
            position: 'head',
            role: 'system',
            content: '在行动前，你必须先思考。请按照以下步骤在 <thinking> 和 </thinking> 标签内进行思考：',
            enabled: true,
            isCore: true
        },
        {
            id: 'tc_mid_1',
            name: '潜台词感知',
            position: 'middle',
            role: 'system',
            content: '- 潜台词感知：对方这句话的潜台词是什么？当前话题是否涉及世界书/人设中的特殊设定？我该如何体现？对他/她的人设是否把握准确？',
            enabled: true
        },
        {
            id: 'tc_mid_2',
            name: '情绪反应',
            position: 'middle',
            role: 'system',
            content: '- 情绪反应：我此刻的真实情绪（开心/委屈/期待？）我的情绪是否符合我的人设',
            enabled: true
        },
        {
            id: 'tc_mid_3',
            name: '角色想法',
            position: 'middle',
            role: 'system',
            content: '- 角色想法：基于人设，我内心最真实的想法...',
            enabled: true
        },
        {
            id: 'tc_bottom_1',
            name: '思维链触发器',
            position: 'bottom',
            role: 'assistant',
            content: '<thinking>\n',
            enabled: true,
            isCore: true
        }
    ],

    init() {
        this.ensurePresetStore();
        this.loadData('chat');
        this.bindEvents();
        this.renderBehaviorSettings();
        this.renderList();
        
        // 由于 Dexie 初始化可能是异步的，等待一点时间后加载下拉框
        setTimeout(() => {
            this.loadPresetsDropdown();
            this.renderBehaviorSettings();
        }, 500);
    },

    ensurePresetStore() {
        if (window.db && db.thoughtChainPresets) return;

        window.db = window.db || {};
        db.thoughtChainPresets = {
            async toArray() {
                try {
                    return JSON.parse(localStorage.getItem('ephone_thought_chain_presets') || '[]');
                } catch (e) {
                    return [];
                }
            },
            async get(id) {
                const presets = await this.toArray();
                return presets.find(preset => preset.id === id);
            },
            async put(presetData) {
                const presets = await this.toArray();
                const id = presetData.id || Date.now();
                const nextPreset = { ...presetData, id };
                const index = presets.findIndex(preset => preset.id === id);
                if (index >= 0) presets[index] = nextPreset;
                else presets.push(nextPreset);
                localStorage.setItem('ephone_thought_chain_presets', JSON.stringify(presets));
                return id;
            },
            async delete(id) {
                const presets = await this.toArray();
                localStorage.setItem('ephone_thought_chain_presets', JSON.stringify(presets.filter(preset => preset.id !== id)));
            },
            where(field) {
                return {
                    equals: (value) => ({
                        first: async () => {
                            const presets = await db.thoughtChainPresets.toArray();
                            return presets.find(preset => preset[field] === value);
                        }
                    })
                };
            }
        };
    },

    async loadPresetsDropdown(forceSelectedId = null) {
        const selectEl = document.getElementById('thought-chain-preset-select');
        if (!selectEl) return;
        
        selectEl.innerHTML = '<option value="current">当前配置 (未保存)</option>';

        try {
            // 插入内置默认模板
            const defaultOption = document.createElement('option');
            defaultOption.value = 'default';
            defaultOption.textContent = '内置默认模板';
            selectEl.appendChild(defaultOption);

            const presets = await db.thoughtChainPresets.toArray();
            presets.forEach(preset => {
                const option = document.createElement('option');
                option.value = preset.id;
                option.textContent = preset.name;
                selectEl.appendChild(option);
            });

            if (forceSelectedId) {
                selectEl.value = forceSelectedId;
                return;
            }
            
            // 尝试匹配当前配置（条目 + 兼容设置 + 总开关）
            let matchingPresetId = null;
            const currentItemsJson = JSON.stringify(this.items);
            const currentBehaviorJson = JSON.stringify(this.getBehavior());
            for (const preset of presets) {
                const sameItems = JSON.stringify(this.normalizeItems(this.clone(preset.items || []))) === currentItemsJson;
                const sameBehavior = JSON.stringify(this.normalizeBehavior(preset.behavior)) === currentBehaviorJson;
                const sameEnabled = (preset.enabled !== false) === this.enabled;
                if (sameItems && sameBehavior && sameEnabled) {
                    matchingPresetId = preset.id;
                    break;
                }
            }

            if (matchingPresetId) {
                selectEl.value = matchingPresetId;
            } else if (JSON.stringify(this.items) === JSON.stringify(this.defaultItems)) {
                selectEl.value = 'default';
            } else {
                selectEl.value = 'current';
            }
        } catch (e) {
            console.error('加载思维链预设失败:', e);
        }
    },

    async handlePresetSelectionChange() {
        const selectEl = document.getElementById('thought-chain-preset-select');
        const selectedValue = selectEl.value;

        if (selectedValue === 'default') {
            this.items = JSON.parse(JSON.stringify(this.defaultItems));
            this.behaviors[this.activeMode] = this.normalizeBehavior({ ...this.defaultBehavior, ...(this.modeBehaviorOverrides[this.activeMode] || {}) });
            this.saveData();
            this.renderList();
            this.renderBehaviorSettings();
            this.setSavedSnapshot();
            showToast('已加载内置默认模板');
            return;
        }

        const selectedId = parseInt(selectedValue);
        if (isNaN(selectedId)) {
            return;
        }

        try {
            const preset = await db.thoughtChainPresets.get(selectedId);
            if (preset && preset.items) {
                this.items = this.normalizeItems(this.clone(preset.items));
                if (preset.behavior) {
                    this.behaviors[this.activeMode] = this.normalizeBehavior({ ...preset.behavior, ...(this.modeBehaviorOverrides[this.activeMode] || {}) });
                }
                if (typeof preset.enabled === 'boolean') this.enabled = preset.enabled;
                this.saveData();
                this.renderList();
                this.renderBehaviorSettings();
                this.setSavedSnapshot();
                showToast(`已加载思维链预设: ${preset.name}`);
            }
        } catch (e) {
            console.error('加载思维链预设详细信息失败:', e);
        }
    },

    async savePreset() {
        const name = await showCustomPrompt('保存思维链预设', '请输入预设名称');
        if (!name || !name.trim()) return;

        const presetData = {
            name: name.trim(),
            items: JSON.parse(JSON.stringify(this.items)), // 深拷贝当前条目
            behavior: this.clone(this.getBehavior()),
            enabled: this.enabled,
            formatVersion: 2,
            updatedAt: Date.now()
        };

        try {
            const existingPreset = await db.thoughtChainPresets.where('name').equals(presetData.name).first();
            if (existingPreset) {
                const confirmed = await showCustomConfirm('覆盖预设', `名为 "${presetData.name}" 的预设已存在。要覆盖它吗？`, {
                    confirmButtonClass: 'btn-danger'
                });
                if (!confirmed) return;
                presetData.id = existingPreset.id;
            }

            await db.thoughtChainPresets.put(presetData);
            await this.loadPresetsDropdown(presetData.id);
            this.setSavedSnapshot();
            showToast('思维链预设已保存！');
        } catch (e) {
            console.error('保存思维链预设失败:', e);
            alert('保存失败，请查看控制台。');
        }
    },

    async deletePreset() {
        const selectEl = document.getElementById('thought-chain-preset-select');
        const selectedId = parseInt(selectEl.value);

        if (isNaN(selectedId)) {
            alert('请先从下拉框中选择一个要删除的预设。');
            return;
        }

        try {
            const preset = await db.thoughtChainPresets.get(selectedId);
            if (!preset) return;

            const confirmed = await showCustomConfirm('删除预设', `确定要删除预设 "${preset.name}" 吗？`, {
                confirmButtonClass: 'btn-danger'
            });
            if (confirmed) {
                await db.thoughtChainPresets.delete(selectedId);
                await this.loadPresetsDropdown();
                showToast('预设已删除。');
            }
        } catch (e) {
            console.error('删除思维链预设失败:', e);
        }
    },

    getModeConfig(mode = this.activeMode) {
        return this.modes[mode] || this.modes.chat;
    },

    clone(value) {
        return JSON.parse(JSON.stringify(value === undefined ? null : value));
    },

    cloneDefaultItems() {
        return JSON.parse(JSON.stringify(this.defaultItems));
    },

    getStoredModeState(mode = 'chat') {
        const config = this.getModeConfig(mode);
        const storedEnabled = localStorage.getItem(config.enabledKey);
        const enabled = storedEnabled !== null ? storedEnabled === 'true' : config.defaultEnabled;
        const storedItems = localStorage.getItem(config.itemsKey);
        let items = this.cloneDefaultItems();

        if (storedItems) {
            try {
                items = JSON.parse(storedItems);
            } catch (e) {
                console.error('Failed to parse thought chain items', e);
            }
        }

        return { enabled, items };
    },

    loadData(mode = this.activeMode) {
        this.activeMode = this.modes[mode] ? mode : 'chat';
        const modeState = this.getStoredModeState(this.activeMode);
        this.enabled = modeState.enabled;
        this.items = modeState.items;
        this.selectedIds = [];
        this.loadBehavior(this.activeMode);

        if (!localStorage.getItem(this.getModeConfig(this.activeMode).itemsKey)) {
            this.saveData();
        }
        
        const enableSwitch = document.getElementById('thought-chain-enable-switch');
        if (enableSwitch) {
            enableSwitch.checked = this.enabled;
        }
        this.updateModeTabs();
        // 未初始化的脏状态不显示
        this.lastSavedSnapshot = '';
        this.updateDirtyState();
    },

    saveData(mode = this.activeMode) {
        const resolvedMode = this.modes[mode] ? mode : this.activeMode;
        const config = this.getModeConfig(resolvedMode);
        this.normalizeItems();
        localStorage.setItem(config.enabledKey, this.enabled);
        localStorage.setItem(config.itemsKey, JSON.stringify(this.items));
        this.saveBehavior(resolvedMode);
        this.updateDirtyState();
    },

    // 兼容旧数据：老条目没有 prefillMode 字段，统一补成 auto
    normalizeItems(items = this.items) {
        if (!Array.isArray(items)) return items;
        items.forEach(item => {
            if (!item) return;
            if (item.prefillMode !== 'on' && item.prefillMode !== 'off') {
                item.prefillMode = 'auto';
            }
        });
        return items;
    },

    switchMode(mode) {
        if (!this.modes[mode] || mode === this.activeMode) return;
        this.saveData();
        this.loadData(mode);
        this.renderList();
        this.renderBehaviorSettings();
        this.loadPresetsDropdown();
    },

    updateModeTabs() {
        document.querySelectorAll('.thought-chain-mode-tab').forEach(btn => {
            const isActive = btn.dataset.mode === this.activeMode;
            btn.style.background = isActive ? '#1f2933' : 'transparent';
            btn.style.color = isActive ? '#fff' : '#666';
            btn.style.boxShadow = isActive ? '0 2px 8px rgba(0,0,0,0.12)' : 'none';
        });
    },

    bindEvents() {
        document.querySelectorAll('.thought-chain-mode-tab').forEach(btn => {
            btn.addEventListener('click', () => this.switchMode(btn.dataset.mode));
        });

        const enableSwitch = document.getElementById('thought-chain-enable-switch');
        if (enableSwitch) {
            enableSwitch.addEventListener('change', (e) => {
                this.enabled = e.target.checked;
                this.saveData();
            });
        }

        const resetBtn = document.getElementById('thought-chain-reset-btn');
        if (resetBtn) {
            resetBtn.addEventListener('click', () => {
                if (confirm('确定要恢复默认的思维链条目和兼容设置吗？这会覆盖你所有的自定义修改。')) {
                    this.items = this.cloneDefaultItems();
                    this.behaviors[this.activeMode] = this.normalizeBehavior({ ...this.defaultBehavior, ...(this.modeBehaviorOverrides[this.activeMode] || {}) });
                    this.saveData();
                    this.renderList();
                    this.renderBehaviorSettings();
                }
            });
        }

        const addBtn = document.getElementById('add-thought-chain-btn');
        if (addBtn) {
            addBtn.addEventListener('click', () => {
                this.openEditor();
            });
        }

        const cancelBtn = document.getElementById('tc-cancel-btn');
        if (cancelBtn) {
            cancelBtn.addEventListener('click', () => {
                this.closeEditor();
            });
        }

        const saveBtn = document.getElementById('tc-save-btn');
        if (saveBtn) {
            saveBtn.addEventListener('click', () => {
                this.saveEditorItem();
            });
        }
        
        // 预设相关事件绑定
        const presetSelect = document.getElementById('thought-chain-preset-select');
        if (presetSelect) {
            presetSelect.addEventListener('change', () => this.handlePresetSelectionChange());
        }
        
        const newPresetBtn = document.getElementById('new-thought-chain-preset-btn');
        if (newPresetBtn) {
            newPresetBtn.addEventListener('click', () => this.createNewPreset());
        }

        const savePresetBtn = document.getElementById('save-thought-chain-preset-btn');
        if (savePresetBtn) {
            savePresetBtn.addEventListener('click', () => this.savePreset());
        }
        
        const deletePresetBtn = document.getElementById('delete-thought-chain-preset-btn');
        if (deletePresetBtn) {
            deletePresetBtn.addEventListener('click', () => this.deletePreset());
        }
        
        const exportPresetBtn = document.getElementById('export-thought-chain-preset-btn');
        if (exportPresetBtn) {
            exportPresetBtn.addEventListener('click', () => this.exportPreset());
        }
        
        const importPresetBtn = document.getElementById('import-thought-chain-preset-btn');
        const importPresetFile = document.getElementById('import-thought-chain-preset-file');
        if (importPresetBtn && importPresetFile) {
            importPresetBtn.addEventListener('click', () => importPresetFile.click());
            importPresetFile.addEventListener('change', (e) => this.importPreset(e));
        }

        // ===== 手动兼容设置（behavior）绑定 =====
        const behaviorBindings = {
            'thought-chain-prefill-switch': ['prefillEnabled', 'checked'],
            'thought-chain-extraction-switch': ['extractionEnabled', 'checked'],
            'thought-chain-extraction-mode': ['extractionMode', 'value'],
            'thought-chain-start-marker': ['startMarker', 'value'],
            'thought-chain-end-marker': ['endMarker', 'value'],
            'thought-chain-extraction-regex': ['extractionRegex', 'value'],
            'thought-chain-ignore-case-switch': ['ignoreCase', 'checked'],
            'thought-chain-remove-from-body-switch': ['removeFromBody', 'checked'],
            'thought-chain-allow-missing-start-switch': ['allowMissingStart', 'checked'],
            'thought-chain-extract-all-switch': ['extractAll', 'checked'],
            'thought-chain-fallback-before-json-switch': ['fallbackBeforeJson', 'checked']
        };
        Object.entries(behaviorBindings).forEach(([id, [key, property]]) => {
            const element = document.getElementById(id);
            if (!element || element.dataset.tcBehaviorBound === '1') return;
            element.dataset.tcBehaviorBound = '1';
            const eventName = (element.tagName === 'SELECT' || element.type === 'checkbox') ? 'change' : 'input';
            element.addEventListener(eventName, () => {
                const behavior = this.getBehavior();
                behavior[key] = element[property];
                this.saveBehavior();
                this.updateBehaviorVisibility();
                this.updateDirtyState();
                if (key === 'prefillEnabled') {
                    this.updatePrefillHint();
                }
            });
        });

        const previewBtn = document.getElementById('thought-chain-preview-btn');
        if (previewBtn) previewBtn.addEventListener('click', () => this.openPreviewTool());
        const parserTestBtn = document.getElementById('thought-chain-parser-test-btn');
        if (parserTestBtn) parserTestBtn.addEventListener('click', () => this.openParserTestTool());
        const toolsCloseBtn = document.getElementById('thought-chain-tools-close-btn');
        if (toolsCloseBtn) toolsCloseBtn.addEventListener('click', () => this.closeToolsModal());
        const toolsRunBtn = document.getElementById('thought-chain-tools-run-btn');
        if (toolsRunBtn) toolsRunBtn.addEventListener('click', () => this.runParserTest());
    },

    renderBehaviorSettings() {
        const behavior = this.getBehavior();
        const values = {
            'thought-chain-prefill-switch': ['prefillEnabled', 'checked'],
            'thought-chain-extraction-switch': ['extractionEnabled', 'checked'],
            'thought-chain-extraction-mode': ['extractionMode', 'value'],
            'thought-chain-start-marker': ['startMarker', 'value'],
            'thought-chain-end-marker': ['endMarker', 'value'],
            'thought-chain-extraction-regex': ['extractionRegex', 'value'],
            'thought-chain-ignore-case-switch': ['ignoreCase', 'checked'],
            'thought-chain-remove-from-body-switch': ['removeFromBody', 'checked'],
            'thought-chain-allow-missing-start-switch': ['allowMissingStart', 'checked'],
            'thought-chain-extract-all-switch': ['extractAll', 'checked'],
            'thought-chain-fallback-before-json-switch': ['fallbackBeforeJson', 'checked']
        };
        Object.entries(values).forEach(([id, [key, property]]) => {
            const element = document.getElementById(id);
            if (element) element[property] = behavior[key];
        });
        const enableSwitch = document.getElementById('thought-chain-enable-switch');
        if (enableSwitch) enableSwitch.checked = this.enabled;
        this.updateBehaviorVisibility();
        this.updateDirtyState();
    },

    updateBehaviorVisibility() {
        const behavior = this.getBehavior();
        const settings = document.getElementById('thought-chain-extraction-settings');
        const tagSettings = document.getElementById('thought-chain-tag-settings');
        const regexSetting = document.getElementById('thought-chain-regex-setting');
        const regexMode = behavior.extractionMode === 'regex';
        if (settings) settings.hidden = behavior.extractionEnabled === false;
        if (tagSettings) tagSettings.hidden = regexMode;
        if (regexSetting) regexSetting.hidden = !regexMode;
        this.updatePrefillHint();
    },

    // 让用户看清“关闭预填”之后发生了什么（是否补了兜底约束）
    updatePrefillHint() {
        const hint = document.getElementById('thought-chain-prefill-hint');
        if (!hint) return;
        const behavior = this.getBehavior();
        const fallback = this.buildPrefillFallbackSystemPrompt();
        if (behavior.manageOwnInjection) {
            hint.textContent = '通话模式自行管理思维链注入，此处设置不影响它。';
            return;
        }
        if (behavior.prefillEnabled !== false) {
            hint.textContent = '当前会照常发送底部预填；Gemini flash 等不支持预填充的模型请关闭。';
            return;
        }
        hint.textContent = fallback
            ? '已关闭：请求不再以 Assistant 轮结尾，并会在 system 提示词末尾补上“必须先输出思考标签再输出正文”的兜底约束，思考内容照常提取与显示。'
            : '已关闭：请求不再以 Assistant 轮结尾（当前没有底部 Assistant 条目或提取已关闭，因此未补兜底约束）。';
    },

    // ===== 工具：最终注入预览 / 测试提取规则 =====
    openToolsModal(title, inputVisible) {
        const modal = document.getElementById('thought-chain-tools-modal');
        const titleEl = document.getElementById('thought-chain-tools-title');
        const input = document.getElementById('thought-chain-test-input');
        const runBtn = document.getElementById('thought-chain-tools-run-btn');
        if (!modal || !titleEl || !input || !runBtn) return;
        titleEl.textContent = title;
        input.hidden = !inputVisible;
        runBtn.hidden = !inputVisible;
        modal.classList.add('visible');
    },

    closeToolsModal() {
        const modal = document.getElementById('thought-chain-tools-modal');
        if (modal) modal.classList.remove('visible');
    },

    openPreviewTool() {
        this.openToolsModal('最终注入预览', false);
        const output = document.getElementById('thought-chain-tools-output');
        if (!output) return;
        const behavior = this.getBehavior();
        const chunks = this.getPayloadChunks();
        const sections = [
            ['头部（合并到主提示词）', chunks.head],
            ['中间（合并到主提示词）', chunks.middle],
            ['聊天记录之前', chunks.before_history],
            ['聊天记录内部', chunks.in_chat],
            ['聊天记录之后', chunks.after_history],
            ['底部 / Assistant 预填', behavior.prefillEnabled ? chunks.bottom : []]
        ];
        const lines = [
            `当前模式：${this.getModeConfig().label || this.activeMode}`,
            `总开关：${this.enabled ? '开启' : '关闭'}`,
            `底部 / 预填：${behavior.prefillEnabled ? '发送' : '不发送'}`,
            `提取思考：${behavior.extractionEnabled === false ? '关闭' : `开启（${behavior.extractionMode === 'regex' ? '正则' : '开始/结束标记'}）`}`,
            ''
        ];
        sections.forEach(([title, items]) => {
            lines.push(`【${title}】`);
            if (!items.length) {
                lines.push('（无启用条目）', '');
                return;
            }
            items.forEach(item => {
                lines.push(`- ${item.name} | ${item.role} | depth=${item.depth || 0} | order=${Number(item.order) || 0}`);
                lines.push(item.content);
            });
            lines.push('');
        });
        const unresolved = [...new Set(this.items.flatMap(item => Array.from(String(item.content || '').matchAll(/\{\{([^{}]+)\}\}/g), match => match[1].trim())))];
        if (unresolved.length) lines.push(`待运行时展开的变量：${unresolved.join('、')}`);
        output.textContent = lines.join('\n');
    },

    openParserTestTool() {
        this.openToolsModal('测试思考提取规则', true);
        const output = document.getElementById('thought-chain-tools-output');
        if (output) output.textContent = '粘贴模拟返回内容后点击“运行测试”。此操作不会调用模型，也不会写入聊天记录。';
    },

    runParserTest() {
        const input = document.getElementById('thought-chain-test-input');
        const output = document.getElementById('thought-chain-tools-output');
        if (!input || !output) return;
        const result = this.extractReasoning(input.value);
        output.textContent = [
            `匹配数量：${result.matches.length}`,
            result.error ? `配置错误：${result.error}` : '',
            '',
            '【提取出的思考内容】',
            result.reasoning || '（无）',
            '',
            '【交给正文解析器的内容】',
            result.body || '（空）'
        ].filter((line, index) => line || index > 1).join('\n');
    },

    async createNewPreset() {
        const name = await showCustomPrompt('新建思维链预设', '请输入新模板名称');
        if (!name || !name.trim()) return;

        // 仅保留头尾核心条目
        const coreItems = this.defaultItems.filter(item => item.isCore);
        
        const presetData = {
            name: name.trim(),
            items: JSON.parse(JSON.stringify(coreItems)),
            behavior: this.clone(this.getBehavior()),
            enabled: this.enabled,
            formatVersion: 2,
            updatedAt: Date.now()
        };

        try {
            const existingPreset = await db.thoughtChainPresets.where('name').equals(presetData.name).first();
            if (existingPreset) {
                const confirmed = await showCustomConfirm('覆盖预设', `名为 "${presetData.name}" 的预设已存在。要覆盖它吗？`, {
                    confirmButtonClass: 'btn-danger'
                });
                if (!confirmed) return;
                presetData.id = existingPreset.id;
            }

            const newId = await db.thoughtChainPresets.put(presetData);
            this.items = presetData.items;
            this.saveData();
            this.renderList();
            this.renderBehaviorSettings();
            await this.loadPresetsDropdown(newId);
            this.setSavedSnapshot();
            showToast('新模板创建成功，你可以自由添加中间的自定义条目了。');
        } catch (e) {
            console.error('新建思维链预设失败:', e);
            alert('创建失败，请查看控制台。');
        }
    },

    exportPreset() {
        if (!this.items || this.items.length === 0) {
            alert('当前没有可导出的思维链配置。');
            return;
        }

        const presetSelect = document.getElementById('thought-chain-preset-select');
        const presetName = presetSelect.options[presetSelect.selectedIndex].text || '思维链预设';
        
        const exportData = {
            formatVersion: 2,
            type: 'ephone-thought-chain-preset',
            name: presetName,
            exportedAt: new Date().toISOString(),
            enabled: this.enabled,
            behavior: this.clone(this.getBehavior()),
            items: this.clone(this.items)
        };
        const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(exportData, null, 2));
        const downloadAnchorNode = document.createElement('a');
        downloadAnchorNode.setAttribute("href",     dataStr);
        // 去除名称中的非法字符
        const safeName = presetName.replace(/[<>:"\/\\|?*\x00-\x1F]/g, '_');
        downloadAnchorNode.setAttribute("download", `思维链预设_${safeName}.json`);
        document.body.appendChild(downloadAnchorNode); // required for firefox
        downloadAnchorNode.click();
        downloadAnchorNode.remove();
        showToast('已导出思维链配置。');
    },

    async importPreset(event) {
        const file = event.target.files[0];
        if (!file) return;

        try {
            const text = await file.text();
            const parsed = JSON.parse(text);
            let parsedItems = parsed;
            let importedBehavior = null;
            let importedEnabled = this.enabled;

            // 兼容历史数组格式，同时支持新版 { items, behavior, enabled } 结构
            if (!Array.isArray(parsedItems)) {
                if (parsedItems.items && Array.isArray(parsedItems.items)) {
                    importedBehavior = parsedItems.behavior;
                    if (typeof parsedItems.enabled === 'boolean') importedEnabled = parsedItems.enabled;
                    parsedItems = parsedItems.items;
                } else {
                     throw new Error('导入的数据格式不正确，应为包含数组的JSON。');
                }
            }

            const confirmed = await showCustomConfirm('导入配置', '确定要导入此思维链配置吗？这将覆盖当前的未保存配置。', { confirmButtonText: '确定导入' });
            if (confirmed) {
                this.items = this.normalizeItems(parsedItems);
                // 重置所有导入项的内部状态以防冲突 (可选，但推荐生成新的内部 ID)
                this.items = this.items.map(item => ({
                    ...item,
                    id: 'tc_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9)
                }));
                if (importedBehavior) {
                    this.behaviors[this.activeMode] = this.normalizeBehavior({ ...importedBehavior, ...(this.modeBehaviorOverrides[this.activeMode] || {}) });
                }
                this.enabled = importedEnabled;
                this.saveData();
                this.renderList();
                this.renderBehaviorSettings();
                
                let defaultName = file.name.replace(/\.json$/i, '');
                if (defaultName.startsWith('思维链预设_')) {
                    defaultName = defaultName.substring('思维链预设_'.length);
                }
                
                const name = await showCustomPrompt('保存为预设', '请输入新预设的名称', defaultName);
                if (name && name.trim()) {
                    const presetData = {
                        name: name.trim(),
                        items: JSON.parse(JSON.stringify(this.items)),
                        behavior: this.clone(this.getBehavior()),
                        enabled: this.enabled,
                        formatVersion: 2,
                        updatedAt: Date.now()
                    };
                    
                    const existingPreset = await db.thoughtChainPresets.where('name').equals(presetData.name).first();
                    let shouldSave = true;
                    if (existingPreset) {
                        const overwrite = await showCustomConfirm('覆盖预设', `名为 "${presetData.name}" 的预设已存在。要覆盖它吗？`, {
                            confirmButtonClass: 'btn-danger'
                        });
                        if (!overwrite) {
                            shouldSave = false;
                        } else {
                            presetData.id = existingPreset.id;
                        }
                    }
                    
                    if (shouldSave) {
                        const newId = await db.thoughtChainPresets.put(presetData);
                        await this.loadPresetsDropdown(newId);
                        showToast('思维链配置导入并保存成功！');
                    } else {
                        this.loadPresetsDropdown();
                        showToast('思维链配置导入成功！（未保存为预设）');
                    }
                } else {
                    this.loadPresetsDropdown(); // 如果取消保存，则重置下拉框为当前未保存状态
                    showToast('思维链配置导入成功！（未保存为预设）');
                }
            }
        } catch (error) {
            console.error('导入思维链配置失败:', error);
            alert(`导入失败: ${error.message || '文件格式错误'}`);
        } finally {
            // 清空 file input，以便下次可以选择同一个文件
            event.target.value = '';
        }
    },

    moveItemUp(index) {
        if (index <= 0) return;
        const item = this.items[index];
        this.items.splice(index, 1);
        this.items.splice(index - 1, 0, item);
        this.saveData();
        this.renderList();
    },

    moveItemDown(index) {
        if (index >= this.items.length - 1) return;
        const item = this.items[index];
        this.items.splice(index, 1);
        this.items.splice(index + 1, 0, item);
        this.saveData();
        this.renderList();
    },

    moveItemTop(index) {
        if (index <= 0) return;
        const item = this.items[index];
        this.items.splice(index, 1);
        this.items.unshift(item);
        this.saveData();
        this.renderList();
    },

    moveItemBottom(index) {
        if (index >= this.items.length - 1) return;
        const item = this.items[index];
        this.items.splice(index, 1);
        this.items.push(item);
        this.saveData();
        this.renderList();
    },

    moveSelectedUp() {
        if (this.selectedIds.length === 0) return;
        let moved = false;
        for (let i = 1; i < this.items.length; i++) {
            if (this.selectedIds.includes(this.items[i].id) && !this.selectedIds.includes(this.items[i-1].id)) {
                const temp = this.items[i];
                this.items[i] = this.items[i-1];
                this.items[i-1] = temp;
                moved = true;
            }
        }
        if (moved) {
            this.saveData();
            this.renderList();
        }
    },

    moveSelectedDown() {
        if (this.selectedIds.length === 0) return;
        let moved = false;
        for (let i = this.items.length - 2; i >= 0; i--) {
            if (this.selectedIds.includes(this.items[i].id) && !this.selectedIds.includes(this.items[i+1].id)) {
                const temp = this.items[i];
                this.items[i] = this.items[i+1];
                this.items[i+1] = temp;
                moved = true;
            }
        }
        if (moved) {
            this.saveData();
            this.renderList();
        }
    },

    moveSelectedTop() {
        if (this.selectedIds.length === 0) return;
        const selectedItems = [];
        const unselectedItems = [];
        
        for (const item of this.items) {
            if (this.selectedIds.includes(item.id)) {
                selectedItems.push(item);
            } else {
                unselectedItems.push(item);
            }
        }
        
        let isAlreadyTop = true;
        for (let i = 0; i < selectedItems.length; i++) {
            if (this.items[i].id !== selectedItems[i].id) {
                isAlreadyTop = false;
                break;
            }
        }
        
        if (!isAlreadyTop) {
            this.items = [...selectedItems, ...unselectedItems];
            this.saveData();
            this.renderList();
        }
    },

    moveSelectedBottom() {
        if (this.selectedIds.length === 0) return;
        const selectedItems = [];
        const unselectedItems = [];
        
        for (const item of this.items) {
            if (this.selectedIds.includes(item.id)) {
                selectedItems.push(item);
            } else {
                unselectedItems.push(item);
            }
        }
        
        let isAlreadyBottom = true;
        for (let i = 0; i < selectedItems.length; i++) {
            if (this.items[this.items.length - selectedItems.length + i].id !== selectedItems[i].id) {
                isAlreadyBottom = false;
                break;
            }
        }
        
        if (!isAlreadyBottom) {
            this.items = [...unselectedItems, ...selectedItems];
            this.saveData();
            this.renderList();
        }
    },

    toggleSelection(id) {
        const index = this.selectedIds.indexOf(id);
        if (index === -1) {
            this.selectedIds.push(id);
        } else {
            this.selectedIds.splice(index, 1);
        }
        this.renderList();
    },

    toggleAllSelection(checked) {
        if (checked) {
            this.selectedIds = this.items.map(item => item.id);
        } else {
            this.selectedIds = [];
        }
        this.renderList();
    },

    renderList() {
        const listContainer = document.getElementById('thought-chain-list');
        if (!listContainer) return;
        
        listContainer.innerHTML = '';
        
        if (this.items.length === 0) {
            listContainer.innerHTML = '<div style="text-align: center; color: #999; padding: 20px;">暂无思维链条目</div>';
            return;
        }

        const allSelected = this.items.length > 0 && this.selectedIds.length === this.items.length;
        const someSelected = this.selectedIds.length > 0;
        
        const toolbarEl = document.createElement('div');
        toolbarEl.style.cssText = 'display: flex; gap: 10px; align-items: center; margin-bottom: 10px; padding: 8px 12px; background: #f9f9f9; border-radius: 8px; border: 1px solid #eee;';
        toolbarEl.innerHTML = `
            <label style="display: flex; align-items: center; gap: 6px; margin: 0; cursor: pointer;">
                <input type="checkbox" id="tc-select-all" ${allSelected ? 'checked' : ''}>
                <span style="font-size: 13px; color: #333; font-weight: 500;">全选</span>
            </label>
            <div style="flex: 1;"></div>
            <button id="tc-btn-move-top" style="padding: 4px 10px; font-size: 12px; border-radius: 4px; border: 1px solid #ccc; background: white; cursor: ${someSelected ? 'pointer' : 'not-allowed'}; opacity: ${someSelected ? 1 : 0.5}; color: #333;">置顶选中</button>
            <button id="tc-btn-move-up" style="padding: 4px 10px; font-size: 12px; border-radius: 4px; border: 1px solid #ccc; background: white; cursor: ${someSelected ? 'pointer' : 'not-allowed'}; opacity: ${someSelected ? 1 : 0.5}; color: #333;">上移选中</button>
            <button id="tc-btn-move-down" style="padding: 4px 10px; font-size: 12px; border-radius: 4px; border: 1px solid #ccc; background: white; cursor: ${someSelected ? 'pointer' : 'not-allowed'}; opacity: ${someSelected ? 1 : 0.5}; color: #333;">下移选中</button>
            <button id="tc-btn-move-bottom" style="padding: 4px 10px; font-size: 12px; border-radius: 4px; border: 1px solid #ccc; background: white; cursor: ${someSelected ? 'pointer' : 'not-allowed'}; opacity: ${someSelected ? 1 : 0.5}; color: #333;">置底选中</button>
        `;
        listContainer.appendChild(toolbarEl);
        
        toolbarEl.querySelector('#tc-select-all').addEventListener('change', (e) => {
            this.toggleAllSelection(e.target.checked);
        });
        toolbarEl.querySelector('#tc-btn-move-top').addEventListener('click', () => {
            this.moveSelectedTop();
        });
        toolbarEl.querySelector('#tc-btn-move-up').addEventListener('click', () => {
            this.moveSelectedUp();
        });
        toolbarEl.querySelector('#tc-btn-move-down').addEventListener('click', () => {
            this.moveSelectedDown();
        });
        toolbarEl.querySelector('#tc-btn-move-bottom').addEventListener('click', () => {
            this.moveSelectedBottom();
        });

        this.items.forEach((item, index) => {
            const el = document.createElement('div');
            el.className = 'tc-item-card';
            el.draggable = true;
            el.dataset.index = index;
            el.dataset.id = item.id;
            
            el.addEventListener('dragstart', (e) => {
                this.draggedItemId = item.id;
                e.dataTransfer.effectAllowed = 'move';
                setTimeout(() => el.style.opacity = '0.5', 0);
            });
            el.addEventListener('dragend', (e) => {
                this.draggedItemId = null;
                el.style.opacity = '1';
                listContainer.querySelectorAll('.tc-item-card').forEach(card => {
                    card.style.borderTop = '';
                    card.style.borderBottom = '';
                });
            });
            el.addEventListener('dragover', (e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                const rect = el.getBoundingClientRect();
                const mid = rect.top + rect.height / 2;
                if (e.clientY < mid) {
                    el.style.borderTop = '2px solid #007aff';
                    el.style.borderBottom = '';
                } else {
                    el.style.borderBottom = '2px solid #007aff';
                    el.style.borderTop = '';
                }
            });
            el.addEventListener('dragleave', (e) => {
                el.style.borderTop = '';
                el.style.borderBottom = '';
            });
            el.addEventListener('drop', (e) => {
                e.preventDefault();
                el.style.borderTop = '';
                el.style.borderBottom = '';
                if (!this.draggedItemId || this.draggedItemId === item.id) return;
                
                const rect = el.getBoundingClientRect();
                const mid = rect.top + rect.height / 2;
                const insertAfter = e.clientY >= mid;
                
                const draggedIndex = this.items.findIndex(i => i.id === this.draggedItemId);
                let targetIndex = index;
                if (insertAfter && draggedIndex > targetIndex) targetIndex++;
                else if (!insertAfter && draggedIndex < targetIndex) targetIndex--;
                
                const draggedItem = this.items[draggedIndex];
                this.items.splice(draggedIndex, 1);
                this.items.splice(targetIndex, 0, draggedItem);
                
                this.saveData();
                this.renderList();
            });

            el.style.cssText = 'background: white; border-radius: 8px; padding: 12px; border: 1px solid #eee; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px; box-shadow: 0 1px 3px rgba(0,0,0,0.02); margin-bottom: 8px; transition: transform 0.2s;';
            
            const isSelected = this.selectedIds.includes(item.id);
            const positionText = item.position === 'head' ? '头部' : (item.position === 'middle' ? '中间' : '底部');
            const roleText = item.role === 'system' ? 'System' : (item.role === 'assistant' ? 'Assistant' : 'User');
            
            el.innerHTML = `
                <div style="display: flex; align-items: center; gap: 8px; flex: 1; min-width: 200px; opacity: ${item.enabled ? '1' : '0.5'};">
                    <div style="cursor: grab; color: #bbb; font-size: 18px; user-select: none; line-height: 1;" title="长按拖动">≡</div>
                    <input type="checkbox" class="tc-item-select" data-id="${item.id}" ${isSelected ? 'checked' : ''} style="cursor: pointer; margin: 0;">
                    <span style="font-weight: bold; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 120px;">${item.name}</span>
                    <span style="font-size: 11px; font-weight: normal; background: #f0f0f0; padding: 2px 6px; border-radius: 4px; color: #666; white-space: nowrap; flex-shrink: 0;">${positionText} | ${roleText}</span>
                </div>
                <div style="display: flex; gap: 6px; align-items: center; flex-wrap: wrap; justify-content: flex-end;">
                    <button class="tc-item-move-top-btn" data-index="${index}" style="background: none; border: 1px solid #ddd; border-radius: 4px; font-size: 12px; padding: 4px 8px; cursor: pointer; color: #333;" ${index === 0 ? 'disabled opacity="0.5"' : ''}>置顶</button>
                    <button class="tc-item-move-up-btn" data-index="${index}" style="background: none; border: 1px solid #ddd; border-radius: 4px; font-size: 12px; padding: 4px 8px; cursor: pointer; color: #333;" ${index === 0 ? 'disabled opacity="0.5"' : ''}>上移</button>
                    <button class="tc-item-move-down-btn" data-index="${index}" style="background: none; border: 1px solid #ddd; border-radius: 4px; font-size: 12px; padding: 4px 8px; cursor: pointer; color: #333;" ${index === this.items.length - 1 ? 'disabled opacity="0.5"' : ''}>下移</button>
                    <button class="tc-item-move-bottom-btn" data-index="${index}" style="background: none; border: 1px solid #ddd; border-radius: 4px; font-size: 12px; padding: 4px 8px; cursor: pointer; color: #333;" ${index === this.items.length - 1 ? 'disabled opacity="0.5"' : ''}>置底</button>
                    <label class="toggle-switch" style="transform: scale(0.8); margin: 0;">
                        <input type="checkbox" class="tc-item-toggle" data-id="${item.id}" ${item.enabled ? 'checked' : ''}>
                        <span class="slider"></span>
                    </label>
                    <button class="tc-item-edit-btn" data-id="${item.id}" style="background: none; border: 1px solid #007aff; border-radius: 4px; font-size: 12px; padding: 4px 8px; cursor: pointer; color: #007aff;">编辑</button>
                    ${!item.isCore ? `<button class="tc-item-delete-btn" data-id="${item.id}" style="background: none; border: 1px solid #ff3b30; border-radius: 4px; font-size: 12px; padding: 4px 8px; cursor: pointer; color: #ff3b30;">删除</button>` : ''}
                </div>
            `;
            
            listContainer.appendChild(el);
        });

        // Bind events for items
        listContainer.querySelectorAll('.tc-item-select').forEach(checkbox => {
            checkbox.addEventListener('change', (e) => {
                const id = e.target.getAttribute('data-id');
                this.toggleSelection(id);
            });
        });

        listContainer.querySelectorAll('.tc-item-move-up-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const index = parseInt(e.target.getAttribute('data-index'), 10);
                this.moveItemUp(index);
            });
        });

        listContainer.querySelectorAll('.tc-item-move-down-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const index = parseInt(e.target.getAttribute('data-index'), 10);
                this.moveItemDown(index);
            });
        });

        listContainer.querySelectorAll('.tc-item-move-top-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const index = parseInt(e.target.getAttribute('data-index'), 10);
                this.moveItemTop(index);
            });
        });

        listContainer.querySelectorAll('.tc-item-move-bottom-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const index = parseInt(e.target.getAttribute('data-index'), 10);
                this.moveItemBottom(index);
            });
        });

        listContainer.querySelectorAll('.tc-item-toggle').forEach(checkbox => {
            checkbox.addEventListener('change', (e) => {
                const id = e.target.getAttribute('data-id');
                const item = this.items.find(i => i.id === id);
                if (item) {
                    item.enabled = e.target.checked;
                    this.saveData();
                    this.renderList();
                }
            });
        });

        listContainer.querySelectorAll('.tc-item-edit-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const id = e.target.getAttribute('data-id');
                this.openEditor(id);
            });
        });

        listContainer.querySelectorAll('.tc-item-delete-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                if (confirm('确定要删除这个条目吗？')) {
                    const id = e.target.getAttribute('data-id');
                    this.items = this.items.filter(i => i.id !== id);
                    
                    const selIndex = this.selectedIds.indexOf(id);
                    if (selIndex !== -1) {
                        this.selectedIds.splice(selIndex, 1);
                    }
                    
                    this.saveData();
                    this.renderList();
                }
            });
        });
    },

    openEditor(itemId = null) {
        const modal = document.getElementById('thought-chain-editor-modal');
        const titleEl = document.getElementById('thought-chain-editor-title');
        
        // Reset form
        document.getElementById('tc-name-input').value = '';
        document.getElementById('tc-position-select').value = 'middle';
        document.getElementById('tc-role-select').value = 'system';
        const prefillSelect = document.getElementById('tc-prefill-select');
        if (prefillSelect) prefillSelect.value = 'auto';
        document.getElementById('tc-content-input').value = '';
        document.getElementById('tc-enabled-switch').checked = true;
        const depthInput = document.getElementById('tc-depth-input');
        const orderInput = document.getElementById('tc-order-input');
        const noteInput = document.getElementById('tc-note-input');
        if (depthInput) depthInput.value = '0';
        if (orderInput) orderInput.value = String(this.items.length);
        if (noteInput) noteInput.value = '';
        
        this.currentEditId = null;

        if (itemId) {
            const item = this.items.find(i => i.id === itemId);
            if (item) {
                this.currentEditId = item.id;
                titleEl.textContent = '编辑条目';
                document.getElementById('tc-name-input').value = item.name;
                document.getElementById('tc-position-select').value = item.position;
                document.getElementById('tc-role-select').value = item.role;
                if (prefillSelect) prefillSelect.value = item.prefillMode || 'auto';
                document.getElementById('tc-content-input').value = item.content;
                document.getElementById('tc-enabled-switch').checked = item.enabled;
                if (depthInput) depthInput.value = String(item.depth || 0);
                if (orderInput) orderInput.value = String(Number.isFinite(Number(item.order)) ? Number(item.order) : this.items.indexOf(item));
                if (noteInput) noteInput.value = item.note || '';
            }
        } else {
            titleEl.textContent = '添加新条目';
        }

        modal.classList.add('visible');
    },

    closeEditor() {
        const modal = document.getElementById('thought-chain-editor-modal');
        if (modal) {
            modal.classList.remove('visible');
        }
        this.currentEditId = null;
    },

    saveEditorItem() {
        const name = document.getElementById('tc-name-input').value.trim();
        const position = document.getElementById('tc-position-select').value;
        const role = document.getElementById('tc-role-select').value;
        const prefillSelect = document.getElementById('tc-prefill-select');
        const prefillMode = prefillSelect ? (prefillSelect.value || 'auto') : 'auto';
        const content = document.getElementById('tc-content-input').value.trim();
        const enabled = document.getElementById('tc-enabled-switch').checked;
        const depthInput = document.getElementById('tc-depth-input');
        const orderInput = document.getElementById('tc-order-input');
        const noteInput = document.getElementById('tc-note-input');
        const depth = Math.max(0, parseInt(depthInput ? depthInput.value : '0', 10) || 0);
        const order = orderInput ? (Number(orderInput.value) || 0) : 0;
        const note = noteInput ? noteInput.value.trim() : '';

        if (!name || !content) {
            alert('名称和内容不能为空！');
            return;
        }

        if (this.currentEditId) {
            const item = this.items.find(i => i.id === this.currentEditId);
            if (item) {
                item.name = name;
                item.position = position;
                item.role = role;
                item.prefillMode = prefillMode;
                item.content = content;
                item.enabled = enabled;
                item.depth = depth;
                item.order = order;
                item.note = note;
            }
        } else {
            const newItem = {
                id: 'tc_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
                name,
                position,
                role,
                prefillMode,
                content,
                enabled,
                depth,
                order,
                note
            };

            let insertIndex = this.items.length;
            if (position === 'head') {
                const lastHeadIndex = this.items.map(i => i.position).lastIndexOf('head');
                insertIndex = lastHeadIndex !== -1 ? lastHeadIndex + 1 : 0;
            } else if (position === 'middle') {
                const lastMiddleIndex = this.items.map(i => i.position).lastIndexOf('middle');
                if (lastMiddleIndex !== -1) {
                    insertIndex = lastMiddleIndex + 1;
                } else {
                    const lastHeadIndex = this.items.map(i => i.position).lastIndexOf('head');
                    insertIndex = lastHeadIndex !== -1 ? lastHeadIndex + 1 : 0;
                }
            }
            
            this.items.splice(insertIndex, 0, newItem);
        }

        this.saveData();
        this.renderList();
        this.closeEditor();
        this.loadPresetsDropdown(); // 更新下拉框状态，可能变为"当前配置 (未保存)"
        this.updateDirtyState();
    },

    getPayloadChunks(mode = this.activeMode) {
        const resolvedMode = this.modes[mode] ? mode : 'chat';
        const modeState = resolvedMode === this.activeMode
            ? { enabled: this.enabled, items: this.items }
            : this.getStoredModeState(resolvedMode);

        const empty = { head: [], middle: [], bottom: [], before_history: [], in_chat: [], after_history: [] };
        if (!modeState.enabled) return empty;

        const chunks = {
            head: [],
            middle: [],
            bottom: [],
            before_history: [],
            in_chat: [],
            after_history: []
        };

        (modeState.items || []).forEach(item => {
            if (!item || !item.enabled) return;
            if (item.position === 'head') chunks.head.push(item);
            else if (item.position === 'middle') chunks.middle.push(item);
            else if (item.position === 'bottom') chunks.bottom.push(item);
            else if (chunks[item.position]) chunks[item.position].push(item);
        });

        Object.values(chunks).forEach(items => items.sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0)));

        return chunks;
    }
};

document.addEventListener('DOMContentLoaded', () => {
    ThoughtChainManager.init();
});
