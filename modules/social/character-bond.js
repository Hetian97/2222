(function () {
  'use strict';

  const DAY_MS = 86400000;
  const PET_ALLOWED_TYPES = new Set(['text', 'sticker', 'voice_message']);

  function localDayKey(timestamp = Date.now()) {
    const date = new Date(Number(timestamp) || Date.now());
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function dayNumber(dayKey) {
    const parts = String(dayKey || '').split('-').map(Number);
    if (parts.length !== 3 || parts.some(Number.isNaN)) return NaN;
    return Math.floor(Date.UTC(parts[0], parts[1] - 1, parts[2]) / DAY_MS);
  }

  function makeId(prefix) {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') return `${prefix}_${window.crypto.randomUUID()}`;
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }

  function ensureChat(chat) {
    if (!chat || chat.isGroup) return null;
    if (!chat.settings) chat.settings = {};
    if (typeof chat.settings.enableCharacterSpark !== 'boolean') chat.settings.enableCharacterSpark = false;
    if (typeof chat.settings.enableSharedPet !== 'boolean') chat.settings.enableSharedPet = false;
    if (!chat.spark || typeof chat.spark !== 'object') {
      chat.spark = {
        schemaVersion: 1,
        enabledAt: null,
        days: {},
        currentStreak: 0,
        bestStreak: 0,
        status: 'unlit',
        lastCompleteDate: null,
        sparks: 0,
        freezeCards: 0,
        restoreCards: 0,
        rewardedWeeks: 0
      };
    }
    if (!Array.isArray(chat.spark.activePeriods)) {
      chat.spark.activePeriods = chat.settings.enableCharacterSpark
        ? [{ start: chat.spark.enabledAt || Date.now(), end: null }]
        : [];
    }
    if (!chat.spark.days || typeof chat.spark.days !== 'object') chat.spark.days = {};
    if (typeof chat.spark.currentStreak !== 'number') chat.spark.currentStreak = 0;
    if (typeof chat.spark.bestStreak !== 'number') chat.spark.bestStreak = 0;
    if (!chat.sharedPet || typeof chat.sharedPet !== 'object') {
      chat.sharedPet = {
        schemaVersion: 1,
        id: makeId('pet'),
        status: 'not_adopted',
        name: '小精灵',
        species: '小精灵',
        persona: '亲近你和角色、活泼但不会抢话的小伙伴',
        avatar: '',
        autoJoin: true,
        interjectCooldownMinutes: 10,
        level: 1,
        experience: 0,
        mood: 80,
        satiety: 80,
        memories: [],
        lastSpokeAt: 0,
        createdAt: null
      };
    }
    if (!Array.isArray(chat.sharedPet.memories)) chat.sharedPet.memories = [];
    if (typeof chat.sharedPet.interjectCooldownMinutes !== 'number' || !Number.isFinite(chat.sharedPet.interjectCooldownMinutes)) {
      chat.sharedPet.interjectCooldownMinutes = 10;
    }
    const petToday = localDayKey();
    const previousCareDay = chat.sharedPet.lastDecayDay || petToday;
    const elapsedDays = Math.max(0, dayNumber(petToday) - dayNumber(previousCareDay));
    if (elapsedDays > 0) {
      chat.sharedPet.satiety = Math.max(0, (chat.sharedPet.satiety || 80) - elapsedDays * 8);
      chat.sharedPet.mood = Math.max(20, (chat.sharedPet.mood || 80) - elapsedDays * 3);
      chat.sharedPet.lastDecayDay = petToday;
    }
    return chat;
  }

  function isVisibleEligibleMessage(msg) {
    if (!msg || msg.isHidden || msg.isExcluded || msg.type === 'thought_chain_block') return false;
    if (msg.role === 'user') return msg.type !== 'narration';
    return msg.role === 'assistant' && msg.actorType !== 'pet';
  }

  function reconcile(chat) {
    if (!ensureChat(chat) || !chat.settings.enableCharacterSpark) return chat && chat.spark;
    const spark = chat.spark;
    const previousStatus = spark.status;
    const previousLastCompleteDate = spark.lastCompleteDate;
    if (!spark.enabledAt) spark.enabledAt = Date.now();
    const days = {};
    const wasEnabledAt = timestamp => spark.activePeriods.some(period => {
      return timestamp >= Number(period.start) && (period.end == null || timestamp <= Number(period.end));
    });
    (chat.history || []).forEach(msg => {
      if (!isVisibleEligibleMessage(msg) || !wasEnabledAt(Number(msg.timestamp))) return;
      const key = localDayKey(msg.timestamp);
      if (!days[key]) days[key] = { user: false, character: false };
      if (msg.role === 'user') days[key].user = true;
      if (msg.role === 'assistant') days[key].character = true;
    });
    if (!spark.protectedDays || typeof spark.protectedDays !== 'object') spark.protectedDays = {};
    if (previousStatus === 'lit' && previousLastCompleteDate && (spark.freezeCards || 0) > 0) {
      const gapBeforeToday = dayNumber(localDayKey()) - dayNumber(previousLastCompleteDate);
      if (gapBeforeToday === 2) {
        const missedDay = new Date((dayNumber(previousLastCompleteDate) + 1) * DAY_MS).toISOString().slice(0, 10);
        if (!spark.protectedDays[missedDay]) {
          spark.protectedDays[missedDay] = 'freeze';
          spark.freezeCards -= 1;
        }
      }
    }
    Object.keys(spark.protectedDays).forEach(key => {
      days[key] = { user: true, character: true, protectedBy: spark.protectedDays[key] };
    });
    spark.days = days;
    const complete = Object.keys(days).filter(key => days[key].user && days[key].character).sort();
    spark.lastCompleteDate = complete.length ? complete[complete.length - 1] : null;

    let streak = 0;
    let completedChain = 0;
    if (complete.length) {
      streak = 1;
      for (let i = complete.length - 1; i > 0; i -= 1) {
        if (dayNumber(complete[i]) - dayNumber(complete[i - 1]) !== 1) break;
        streak += 1;
      }
      completedChain = streak;
      const gap = dayNumber(localDayKey()) - dayNumber(spark.lastCompleteDate);
      if (gap > 1) streak = 0;
    }
    spark.currentStreak = streak;
    spark.bestStreak = Math.max(spark.bestStreak || 0, completedChain);
    const gap = spark.lastCompleteDate ? dayNumber(localDayKey()) - dayNumber(spark.lastCompleteDate) : Infinity;
    spark.status = streak >= 3 ? 'lit' : ((spark.bestStreak || 0) >= 3 && gap <= 7 ? 'recoverable' : 'unlit');

    const earnedWeeks = Math.floor((spark.bestStreak || 0) / 7);
    if (earnedWeeks > (spark.rewardedWeeks || 0)) {
      const delta = earnedWeeks - (spark.rewardedWeeks || 0);
      spark.sparks = (spark.sparks || 0) + delta * 7;
      spark.freezeCards = (spark.freezeCards || 0) + Math.floor(earnedWeeks / 2) - Math.floor((spark.rewardedWeeks || 0) / 2);
      spark.restoreCards = (spark.restoreCards || 0) + delta;
      spark.rewardedWeeks = earnedWeeks;
    }
    return spark;
  }

  function setSwitches(chat, sparkEnabled, petEnabled) {
    ensureChat(chat);
    const wasSparkEnabled = chat.settings.enableCharacterSpark;
    const nextSparkEnabled = Boolean(sparkEnabled);
    if (wasSparkEnabled !== nextSparkEnabled) {
      if (nextSparkEnabled) {
        chat.spark.activePeriods.push({ start: Date.now(), end: null });
      } else {
        const openPeriod = [...chat.spark.activePeriods].reverse().find(period => period.end == null);
        if (openPeriod) openPeriod.end = Date.now();
      }
    }
    chat.settings.enableCharacterSpark = nextSparkEnabled;
    chat.settings.enableSharedPet = Boolean(petEnabled);
    if (!wasSparkEnabled && chat.settings.enableCharacterSpark && !chat.spark.enabledAt) {
      chat.spark.enabledAt = Date.now();
    }
    reconcile(chat);
  }

  function petIsUsable(chat) {
    return Boolean(ensureChat(chat) && chat.settings.enableSharedPet && chat.sharedPet.status === 'active');
  }

  function petMentionToken(chat) {
    return petIsUsable(chat) ? `@[[pet:${chat.sharedPet.id}]]` : '';
  }

  function normalizePetMention(text, chat) {
    if (!petIsUsable(chat) || typeof text !== 'string') return text;
    const name = chat.sharedPet.name || '小精灵';
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return text.replace(new RegExp(`@${escaped}(?=\\s|$)`, 'g'), petMentionToken(chat));
  }

  function displayMentions(text, chat) {
    if (!chat || typeof text !== 'string') return text;
    ensureChat(chat);
    return text.replace(/@\[\[pet:([^\]]+)\]\]/g, (match, id) => {
      return chat.sharedPet && chat.sharedPet.id === id ? `@${chat.sharedPet.name || '小精灵'}` : '@小精灵';
    });
  }

  function getPromptContext(chat, lastUserMessage) {
    if (!petIsUsable(chat)) return '';
    const pet = chat.sharedPet;
    const mentioned = typeof lastUserMessage?.content === 'string' && lastUserMessage.content.includes(petMentionToken(chat));
    const cooldownMinutes = Math.max(0, Math.min(1440, Number(pet.interjectCooldownMinutes) || 0));
    const autoJoinAvailable = pet.autoJoin && (
      cooldownMinutes === 0 || Date.now() - (pet.lastSpokeAt || 0) >= cooldownMinutes * 60 * 1000
    );
    const recentMemories = pet.memories.slice(-8).map(item => `  - ${item.summary}`).join('\n') || '  - 暂无';
    return `# 共同宠物（单聊中的第三位发言者）\n你与用户共同养了一只宠物。它不是群成员，也不是真人账号。\n- 宠物名：${pet.name}\n- 种类：${pet.species}\n- 性格：${pet.persona}\n- 等级：${pet.level}；心情：${pet.mood}/100；饱腹：${pet.satiety}/100\n- 用户用 ${petMentionToken(chat)} 明确呼叫宠物：${mentioned ? '是' : '否'}。\n- 若明确呼叫，必须至少返回一条宠物回复；宠物回复对象须增加 \"speakerType\":\"pet\"。\n- 角色回复使用 \"speakerType\":\"character\"（也可省略）。宠物只允许 text、sticker、voice_message，禁止转账、下单、发帖、通话、图片生成或操作任何角色专属工具。\n- ${autoJoinAvailable ? '未被呼叫时，宠物只可在语境非常自然时偶尔插话，不能连续抢话。' : '本轮未被明确呼叫时，宠物不要主动插话。'}\n- 宠物记忆与角色长期记忆分开；不要声称它读取了角色私密记忆。\n- 宠物自己的近期记忆：\n${recentMemories}`;
  }

  function decorateAssistantBase(baseMessage, msgData, chat) {
    const isPet = petIsUsable(chat) && (
      msgData.speakerType === 'pet' || msgData.speaker_type === 'pet'
      || msgData.speaker === 'pet'
    );
    if (!isPet) {
      return { ...baseMessage, actorType: 'character', actorId: chat.id };
    }
    return {
      ...baseMessage,
      actorType: 'pet',
      actorId: chat.sharedPet.id,
      senderName: chat.sharedPet.name,
      avatarSnapshot: chat.sharedPet.avatar || ''
    };
  }

  function isAllowedPetMessage(msgData, chat) {
    const isPet = petIsUsable(chat) && (
      msgData.speakerType === 'pet' || msgData.speaker_type === 'pet'
      || msgData.speaker === 'pet'
    );
    return !isPet || PET_ALLOWED_TYPES.has(msgData.type || 'text');
  }

  function onMessageSaved(chat, msg) {
    if (!ensureChat(chat)) return;
    if (chat.settings.enableCharacterSpark) reconcile(chat);
    if (msg && msg.role === 'user' && petIsUsable(chat) && typeof msg.content === 'string' && msg.content.includes(petMentionToken(chat))) {
      chat.sharedPet.memories.push({
        timestamp: Number(msg.timestamp) || Date.now(),
        summary: `用户对我说：${displayMentions(msg.content, chat).slice(0, 100)}`
      });
    }
    if (msg && msg.actorType === 'pet' && petIsUsable(chat)) {
      const pet = chat.sharedPet;
      pet.lastSpokeAt = Number(msg.timestamp) || Date.now();
      pet.experience = (pet.experience || 0) + 2;
      pet.level = Math.max(1, Math.floor(pet.experience / 30) + 1);
      pet.mood = Math.min(100, (pet.mood || 80) + 1);
      const memoryText = String(msg.content || '').trim();
      if (memoryText) {
        pet.memories.push({ timestamp: pet.lastSpokeAt, summary: memoryText.slice(0, 120) });
        if (pet.memories.length > 30) pet.memories.splice(0, pet.memories.length - 30);
      }
    }
    if (chat.sharedPet.memories.length > 30) chat.sharedPet.memories.splice(0, chat.sharedPet.memories.length - 30);
    refreshVisibleUi(chat);
  }

  // 高品质火花矢量 SVG 图标定义（多种形态）
  const SPARK_SVGS = {
    // 灰阶/未点燃态（精简柔和灰）
    unlit: `<svg class="spark-svg" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M12 2C11.5 5 9.5 7.5 7 9C4.5 10.5 3 13 3 16C3 19.3137 5.68629 22 9 22C11 22 12 21 12 21C12 21 13 22 15 22C18.3137 22 21 19.3137 21 16C21 13 19.5 10.5 17 9C14.5 7.5 12.5 5 12 2Z" fill="#B0B5BC"/>
      <path d="M12 11C11.5 12.8 10 14.2 8.5 15C7.2 15.7 6.5 17 6.5 18.5C6.5 20.4 8 21.2 10 21.2C11.2 21.2 12 20.5 12 20.5C12 20.5 12.8 21.2 14 21.2C16 21.2 17.5 20.4 17.5 18.5C17.5 17 16.8 15.7 15.5 15C14 14.2 12.5 12.8 12 11Z" fill="#D3D7DD"/>
    </svg>`,
    // 初级点燃态（3~6天，鲜明渐变火苗）
    lit: `<svg class="spark-svg" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="sparkGradLit" x1="12" y1="2" x2="12" y2="22" gradientUnits="userSpaceOnUse">
          <stop stop-color="#FF7A00"/>
          <stop offset="0.5" stop-color="#FF3D00"/>
          <stop offset="1" stop-color="#E52D27"/>
        </linearGradient>
        <linearGradient id="sparkInnerLit" x1="12" y1="10" x2="12" y2="21" gradientUnits="userSpaceOnUse">
          <stop stop-color="#FFF176"/>
          <stop offset="1" stop-color="#FFB300"/>
        </linearGradient>
      </defs>
      <path d="M12 2C11.3 5.2 9.2 7.8 6.5 9.2C3.8 10.6 2 13.5 2 16.5C2 20.1 4.9 22.5 8.8 22.5C11 22.5 12 21.3 12 21.3C12 21.3 13 22.5 15.2 22.5C19.1 22.5 22 20.1 22 16.5C22 13.5 20.2 10.6 17.5 9.2C14.8 7.8 12.7 5.2 12 2Z" fill="url(#sparkGradLit)"/>
      <path d="M12 10.5C11.5 12.5 10 14 8.5 14.8C7.3 15.5 6.6 16.8 6.6 18.2C6.6 20.1 8.2 21 10 21C11.3 21 12 20.2 12 20.2C12 20.2 12.7 21 14 21C15.8 21 17.4 20.1 17.4 18.2C17.4 16.8 16.7 15.5 15.5 14.8C14 14 12.5 12.5 12 10.5Z" fill="url(#sparkInnerLit)"/>
    </svg>`,
    // 高阶炽热态（7天及以上，璀璨大火花+四角星光）
    superLit: `<svg class="spark-svg" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="sparkGradSuper" x1="12" y1="1" x2="12" y2="23" gradientUnits="userSpaceOnUse">
          <stop stop-color="#FF9100"/>
          <stop offset="0.45" stop-color="#FF2A00"/>
          <stop offset="1" stop-color="#D50000"/>
        </linearGradient>
        <linearGradient id="sparkSuperCore" x1="12" y1="9" x2="12" y2="21" gradientUnits="userSpaceOnUse">
          <stop stop-color="#FFFF8D"/>
          <stop offset="0.6" stop-color="#FFEA00"/>
          <stop offset="1" stop-color="#FF9100"/>
        </linearGradient>
      </defs>
      <path d="M12 1.5C11.2 5 8.8 7.8 5.8 9.3C2.8 10.8 1 13.9 1 17C1 20.8 4.2 23 8.5 23C11 23 12 21.6 12 21.6C12 21.6 13 23 15.5 23C19.8 23 23 20.8 23 17C23 13.9 21.2 10.8 18.2 9.3C15.2 7.8 12.8 5 12 1.5Z" fill="url(#sparkGradSuper)"/>
      <path d="M12 9.5C11.4 11.8 9.6 13.5 8 14.4C6.6 15.2 5.8 16.7 5.8 18.3C5.8 20.4 7.6 21.5 9.8 21.5C11.2 21.5 12 20.6 12 20.6C12 20.6 12.8 21.5 14.2 21.5C16.4 21.5 18.2 20.4 18.2 18.3C18.2 16.7 17.4 15.2 16 14.4C14.4 13.5 12.6 11.8 12 9.5Z" fill="url(#sparkSuperCore)"/>
      <path d="M20.5 4L21.2 5.8L23 6.5L21.2 7.2L20.5 9L19.8 7.2L18 6.5L19.8 5.8L20.5 4Z" fill="#FFE57F"/>
      <path d="M4 3L4.5 4.5L6 5L4.5 5.5L4 7L3.5 5.5L2 5L3.5 4.5L4 3Z" fill="#FFE57F"/>
    </svg>`,
    // 待恢复态
    recoverable: `<svg class="spark-svg" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M12 2C11.5 5 9.5 7.5 7 9C4.5 10.5 3 13 3 16C3 19.3137 5.68629 22 9 22C11 22 12 21 12 21C12 21 13 22 15 22C18.3137 22 21 19.3137 21 16C21 13 19.5 10.5 17 9C14.5 7.5 12.5 5 12 2Z" fill="#90949C" opacity="0.6"/>
      <path d="M12 11C11.5 12.8 10 14.2 8.5 15C7.2 15.7 6.5 17 6.5 18.5C6.5 20.4 8 21.2 10 21.2C11.2 21.2 12 20.5 12 20.5C12 20.5 12.8 21.2 14 21.2C16 21.2 17.5 20.4 17.5 18.5C17.5 17 16.8 15.7 15.5 15C14 14.2 12.5 12.8 12 11Z" fill="#CED2D9"/>
    </svg>`
  };

  function badgeLabel(chat) {
    const spark = reconcile(chat);
    if (!chat.settings.enableCharacterSpark) return '';
    if (spark.status === 'lit') return `${spark.currentStreak}天`;
    if (spark.status === 'recoverable') return '待恢复';
    return spark.currentStreak ? `${spark.currentStreak}天` : '未点燃';
  }

  function refreshVisibleUi(chat) {
    if (!chat || chat.isGroup) return;
    // 聊天界面顶部已根据用户要求隐藏火花徽标
    const badge = document.getElementById('character-spark-badge');
    if (badge) {
      badge.hidden = true;
      badge.style.display = 'none';
    }
    updatePetButton(chat);
  }

  function createSparkBadgeNode(chat) {
    const spark = reconcile(chat);
    if (!chat.settings.enableCharacterSpark) return null;

    const badge = document.createElement('span');
    badge.className = 'character-spark-list-badge';

    const streak = spark.currentStreak || 0;
    let svgHtml = '';
    let textHtml = '';

    if (spark.status === 'lit') {
      badge.classList.add('is-lit');
      if (streak >= 7) {
        badge.classList.add('is-super');
        svgHtml = SPARK_SVGS.superLit;
      } else {
        svgHtml = SPARK_SVGS.lit;
      }
      textHtml = `<span class="spark-text">${streak}天</span>`;
      badge.title = `角色火花：已连续点燃 ${streak} 天 (点击查看)`;
    } else if (spark.status === 'recoverable') {
      badge.classList.add('needs-recovery');
      svgHtml = SPARK_SVGS.recoverable;
      textHtml = `<span class="spark-text">待恢复</span>`;
      badge.title = `角色火花中断，可使用恢复卡救回 (点击查看)`;
    } else {
      // 未点燃：如果有天数（如1~2天）则显示灰色天数，否则仅显示灰色小火花
      badge.classList.add('is-unlit');
      svgHtml = SPARK_SVGS.unlit;
      if (streak > 0) {
        textHtml = `<span class="spark-text">${streak}天</span>`;
        badge.title = `角色火花：已连续互动 ${streak}/3 天 (点击查看)`;
      } else {
        textHtml = '';
        badge.title = `角色火花：未点燃，连续互动3天即可点燃 (点击查看)`;
      }
    }

    badge.innerHTML = `${svgHtml}${textHtml}`;

    // 点击直接呼出火花详情面板
    badge.addEventListener('click', (e) => {
      e.stopPropagation();
      showBondModal('spark', chat);
    });

    return badge;
  }

  function decorateChatListItem(item, chat) {
    if (!item || !ensureChat(chat) || !chat.settings.enableCharacterSpark) return;
    const nameLine = item.querySelector('.name-line');
    if (!nameLine) return;
    item.classList.add('has-character-spark');
    const badge = createSparkBadgeNode(chat);
    if (badge) {
      nameLine.appendChild(badge);
    }
  }

  function loadSettingsUi(chat) {
    ensureChat(chat);
    const group = document.getElementById('character-bond-settings-group');
    if (!group) return;
    group.style.display = chat.isGroup ? 'none' : 'block';
    if (chat.isGroup) return;
    document.getElementById('character-spark-switch').checked = chat.settings.enableCharacterSpark;
    document.getElementById('shared-pet-switch').checked = chat.settings.enableSharedPet;
    updateSettingsSummary(chat);
  }

  function updateSettingsSummary(chat) {
    ensureChat(chat);
    const sparkSummary = document.getElementById('character-spark-settings-summary');
    const petSummary = document.getElementById('shared-pet-settings-summary');
    if (sparkSummary) sparkSummary.textContent = chat.settings.enableCharacterSpark ? badgeLabel(chat) : '关闭后不记录角色互动天数';
    if (petSummary) {
      petSummary.textContent = chat.settings.enableSharedPet
        ? (petIsUsable(chat) ? `${chat.sharedPet.name} · Lv.${chat.sharedPet.level}` : '已开启，设置宠物后可在单聊中 @它')
        : '关闭后宠物不出现、不回复，数据仍保留';
    }
  }

  function isPetEnabledInContext(chat) {
    const petSwitch = document.getElementById('shared-pet-switch');
    if (petSwitch && petSwitch.isConnected) {
      return petSwitch.checked;
    }
    return Boolean(chat?.settings?.enableSharedPet);
  }

  function showBondModal(mode, chat) {
    if (!ensureChat(chat)) return;
    const modal = document.getElementById('character-bond-modal');
    if (!modal) return;
    modal.dataset.mode = mode;
    modal.classList.add('visible');
    document.getElementById('character-bond-modal-title').textContent = mode === 'spark' ? '角色火花' : '共同宠物';
    document.getElementById('character-spark-panel').hidden = mode !== 'spark';
    document.getElementById('shared-pet-panel').hidden = mode !== 'pet';
    const petEnabled = isPetEnabledInContext(chat);
    document.getElementById('save-shared-pet-btn').hidden = mode !== 'pet' || !petEnabled;
    if (mode === 'spark') renderSparkPanel(chat);
    else renderPetPanel(chat);
  }

  function renderSparkPanel(chat) {
    const spark = reconcile(chat);
    const sparkSwitch = document.getElementById('character-spark-switch');
    const isSparkEnabled = (sparkSwitch && sparkSwitch.isConnected) ? sparkSwitch.checked : Boolean(chat.settings.enableCharacterSpark);
    const today = spark.days[localDayKey()] || { user: false, character: false };
    const status = !isSparkEnabled ? '火花开关尚未开启' :
      spark.status === 'lit' ? `已点亮，连续 ${spark.currentStreak} 天` :
      spark.status === 'recoverable' ? '火花已中断，可使用恢复卡' : `连续互动 ${spark.currentStreak}/3 天`;
    document.getElementById('character-spark-state').textContent = status;
    document.getElementById('character-spark-today').textContent = `今日：你${today.user ? '已' : '未'}发送 · 角色${today.character ? '已' : '未'}回复`;
    document.getElementById('character-spark-record').textContent = `最高 ${spark.bestStreak || 0} 天 · 火花值 ${spark.sparks || 0} · 冻结卡 ${spark.freezeCards || 0} · 恢复卡 ${spark.restoreCards || 0}`;
    const restoreButton = document.getElementById('restore-character-spark-btn');
    const restoreCards = Number(spark.restoreCards) || 0;
    const recoverable = spark.status === 'recoverable';
    restoreButton.hidden = !(isSparkEnabled && (restoreCards > 0 || recoverable));
    restoreButton.disabled = restoreCards < 1 || !recoverable;
    restoreButton.textContent = restoreCards < 1 ? '暂无恢复卡' : (recoverable ? '使用恢复卡' : '当前无需恢复');
  }

  function renderPetPanel(chat) {
    const pet = chat.sharedPet;
    const petEnabled = isPetEnabledInContext(chat);
    document.getElementById('shared-pet-disabled-note').hidden = petEnabled;
    document.getElementById('shared-pet-form').hidden = !petEnabled;
    document.getElementById('save-shared-pet-btn').hidden = !petEnabled;
    if (!petEnabled) return;
    document.getElementById('shared-pet-name').value = pet.status === 'active' ? pet.name : '';
    document.getElementById('shared-pet-species').value = pet.status === 'active' ? pet.species : '';
    document.getElementById('shared-pet-persona').value = pet.status === 'active' ? pet.persona : '';
    document.getElementById('shared-pet-avatar-url').value = pet.avatar && !pet.avatar.startsWith('data:') ? pet.avatar : '';
    document.getElementById('shared-pet-auto-join').checked = pet.autoJoin !== false;
    const cooldownInput = document.getElementById('shared-pet-interject-cooldown');
    if (cooldownInput) cooldownInput.value = String(pet.interjectCooldownMinutes ?? 10);
    const preview = document.getElementById('shared-pet-avatar-preview');
    preview.src = pet.avatar || chat.settings.aiAvatar || '';
    preview.dataset.pendingAvatar = pet.avatar || '';
    const growth = document.getElementById('shared-pet-growth');
    if (growth) {
      growth.textContent = pet.status === 'active'
        ? `Lv.${pet.level} · 经验 ${pet.experience} · 心情 ${pet.mood} · 饱腹 ${pet.satiety}`
        : '还没有领养宠物';
    }
    const feedButton = document.getElementById('feed-shared-pet-btn');
    if (feedButton) feedButton.hidden = pet.status !== 'active';
  }

  function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error('读取图片失败'));
      reader.readAsDataURL(file);
    });
  }

  async function compressPetImage(file) {
    if (!file || !file.type.startsWith('image/')) throw new Error('请选择图片文件');
    if (file.size > 10 * 1024 * 1024) throw new Error('图片不能超过 10MB');
    if (typeof imageCompression === 'function') {
      const compressed = await imageCompression(file, { maxSizeMB: 0.28, maxWidthOrHeight: 768, useWebWorker: true, fileType: file.type === 'image/png' ? 'image/png' : 'image/webp' });
      return readFileAsDataUrl(compressed);
    }
    return readFileAsDataUrl(file);
  }

  async function savePetFromModal(chat) {
    const petEnabled = isPetEnabledInContext(chat);
    if (!petEnabled) return;
    chat.settings.enableSharedPet = true;
    const petSwitch = document.getElementById('shared-pet-switch');
    if (petSwitch) petSwitch.checked = true;
    const name = document.getElementById('shared-pet-name').value.trim();
    const species = document.getElementById('shared-pet-species').value.trim();
    const persona = document.getElementById('shared-pet-persona').value.trim();
    if (!name || !species || !persona) {
      await showCustomAlert('信息未完成', '请填写宠物名称、种类和性格。');
      return;
    }
    const preview = document.getElementById('shared-pet-avatar-preview');
    const url = document.getElementById('shared-pet-avatar-url').value.trim();
    const avatar = preview.dataset.pendingAvatar || url;
    if (!avatar) {
      await showCustomAlert('缺少形象', '请填写图片 URL 或从本地上传一张宠物图片。');
      return;
    }
    if (!avatar.startsWith('data:image/') && !/^https?:\/\//i.test(avatar)) {
      await showCustomAlert('图片地址无效', '宠物图片 URL 需要以 http:// 或 https:// 开头。');
      return;
    }
    Object.assign(chat.sharedPet, {
      status: 'active', name, species, persona, avatar,
      autoJoin: document.getElementById('shared-pet-auto-join').checked,
      interjectCooldownMinutes: Math.max(0, Math.min(1440, parseInt(document.getElementById('shared-pet-interject-cooldown')?.value, 10) || 10)),
      createdAt: chat.sharedPet.createdAt || Date.now()
    });
    await db.chats.put(chat);
    document.getElementById('character-bond-modal').classList.remove('visible');
    updateSettingsSummary(chat);
    refreshVisibleUi(chat);
    if (typeof renderChatInterface === 'function' && state.activeChatId === chat.id) renderChatInterface(chat.id, { preserveScroll: true });
    showToast(`${name} 已加入这段单聊`);
  }

  async function restoreSpark(chat) {
    const spark = reconcile(chat);
    if (!chat.settings.enableCharacterSpark || spark.status !== 'recoverable' || (spark.restoreCards || 0) < 1 || !spark.lastCompleteDate) return;
    const last = dayNumber(spark.lastCompleteDate);
    const today = dayNumber(localDayKey());
    if (!spark.protectedDays || typeof spark.protectedDays !== 'object') spark.protectedDays = {};
    for (let value = last + 1; value < today; value += 1) {
      spark.protectedDays[new Date(value * DAY_MS).toISOString().slice(0, 10)] = 'restore';
    }
    spark.restoreCards -= 1;
    reconcile(chat);
    await db.chats.put(chat);
    renderSparkPanel(chat);
    refreshVisibleUi(chat);
    if (typeof renderChatList === 'function') renderChatList();
    showToast('角色火花已恢复');
  }

  async function feedPet(chat) {
    if (!petIsUsable(chat)) return;
    const today = localDayKey();
    if (chat.sharedPet.lastFedDay === today) {
      showToast('今天已经喂过啦');
      return;
    }
    chat.sharedPet.lastFedDay = today;
    chat.sharedPet.satiety = Math.min(100, (chat.sharedPet.satiety || 0) + 25);
    chat.sharedPet.mood = Math.min(100, (chat.sharedPet.mood || 0) + 6);
    chat.sharedPet.experience = (chat.sharedPet.experience || 0) + 5;
    chat.sharedPet.level = Math.max(1, Math.floor(chat.sharedPet.experience / 30) + 1);
    await db.chats.put(chat);
    renderPetPanel(chat);
    updateSettingsSummary(chat);
    showToast(`${chat.sharedPet.name} 吃饱了`);
  }

  function petLevel(experience) {
    return Math.max(1, Math.floor(Math.max(0, Number(experience) || 0) / 30) + 1);
  }

  function updatePetButton(chat) {
    const button = document.getElementById('open-pet-panel-btn');
    if (!button) return;
    button.style.display = chat && !chat.isGroup ? 'flex' : 'none';
  }

  function renderPetInteractionSummary(chat) {
    const pet = chat.sharedPet;
    const summary = document.getElementById('pet-interaction-summary');
    const title = document.getElementById('pet-interaction-title');
    const avatar = document.getElementById('pet-interaction-avatar');
    if (!summary || !pet) return;
    const avatarSrc = pet.avatar || chat.settings?.aiAvatar || '';
    if (avatar) {
      avatar.src = avatarSrc;
      avatar.hidden = !avatarSrc;
    }
    const exp = Math.max(0, Number(pet.experience) || 0);
    const level = petLevel(exp);
    const nextLevelExp = level * 30;
    const expPercent = Math.max(0, Math.min(100, (exp % 30) / 30 * 100));
    const mood = Math.max(0, Math.min(100, Number(pet.mood) || 0));
    const satiety = Math.max(0, Math.min(100, Number(pet.satiety) || 0));
    if (title) title.textContent = '共同宠物';
    summary.innerHTML = `
      <strong>${pet.name || '宠物'} · Lv.${level}</strong>
      <p class="pet-stat-line"><span>经验</span><span>${exp} / ${nextLevelExp}</span></p>
      <div class="pet-stat-bar"><span style="width:${expPercent}%"></span></div>
      <p class="pet-stat-line"><span>心情</span><span>${Math.round(mood)} / 100</span></p>
      <div class="pet-stat-bar"><span style="width:${mood}%"></span></div>
      <p class="pet-stat-line"><span>饱腹</span><span>${Math.round(satiety)} / 100</span></p>
      <div class="pet-stat-bar"><span style="width:${satiety}%"></span></div>`;
  }

  function openPetInteractionModal(chat) {
    if (!chat) return;
    if (!petIsUsable(chat)) {
      const adopted = chat.sharedPet && chat.sharedPet.status === 'active';
      if (!adopted) {
        showCustomAlert('还没有共同宠物', '你还没有和TA共同领养宠物哦。');
      } else {
        showCustomAlert('共同宠物未开启', '共同宠物开关还没有打开，请先在聊天设置里开启。');
      }
      return;
    }
    const modal = document.getElementById('pet-interaction-modal');
    if (!modal) return;
    const title = document.getElementById('pet-interaction-title');
    if (title) title.textContent = '共同宠物';
    renderPetInteractionSummary(chat);
    modal.classList.add('visible');
  }

  async function generatePetReply(chat, userText) {
    const fallback = '（呜……我好像说不出话了……）';
    try {
      const config = state.apiConfig || {};
      const override = chat.apiOverride && chat.apiOverride.enabled ? chat.apiOverride : {};
      const proxyUrl = String(override.proxyUrl || config.proxyUrl || '').replace(/\/+$/, '');
      const apiKey = override.apiKey || config.apiKey;
      const model = override.model || config.model;
      if (!proxyUrl || !apiKey || !model) return fallback;
      const pet = chat.sharedPet;
      const userName = chat.settings?.myNickname || '我';
      const response = await fetch(`${proxyUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: `你是用户和角色共同养的宠物“${pet.name}”（${pet.species}）。性格：${pet.persona}。请用宠物第一人称、对用户称“你”来回复这一句话，保持简短、自然、可爱，不要替角色说话，不要输出 JSON。允许 0~2 个简短动作或神态描写，用中文全角括号（）括起来，例如“（歪头蹭蹭${userName}的裤脚）”；动作描写里称呼用户时使用“${userName}”，不要用“她/他”，不要写大段旁白。` },
            { role: 'user', content: userText }
          ],
          temperature: 0.8,
          stream: false
        })
      });
      if (!response.ok) return fallback;
      const data = await response.json();
      const text = data?.choices?.[0]?.message?.content;
      if (!text) return fallback;
      return String(text).trim().replace(/^["“]|["”]$/g, '').slice(0, 500);
    } catch (error) {
      console.warn('[pet-dialogue] 宠物回复生成失败:', error);
      return fallback;
    }
  }

  async function addPetNarration(chat, content) {
    const message = {
      role: 'system',
      type: 'narration',
      senderName: '旁白',
      content,
      timestamp: Date.now()
    };
    if (!Array.isArray(chat.history)) chat.history = [];
    chat.history.push(message);
    await db.chats.put(chat);
    onMessageSaved(chat, message);
    if (state.activeChatId === chat.id && typeof window.appendMessage === 'function') {
      await window.appendMessage(message, chat);
    }
    updateSettingsSummary(chat);
    renderPetInteractionSummary(chat);
  }

  async function interactWithPet(action, chat) {
    if (!petIsUsable(chat)) return;
    const pet = chat.sharedPet;
    const userName = chat.settings.myNickname || '我';
    const petName = pet.name || '宠物';
    let content = '';

    if (action === 'feed') {
      const today = localDayKey();
      if (pet.lastFedDay === today) {
        showToast('今天已经喂过啦');
        return;
      }
      pet.lastFedDay = today;
      pet.satiety = Math.min(100, (pet.satiety || 0) + 25);
      pet.mood = Math.min(100, (pet.mood || 0) + 6);
      pet.experience = Math.max(0, (pet.experience || 0) + 5);
      content = `${userName} 喂了 ${petName} 一些食物。`;
    } else if (action === 'play') {
      pet.mood = Math.min(100, (pet.mood || 0) + 15);
      pet.satiety = Math.max(0, (pet.satiety || 0) - 5);
      pet.experience = Math.max(0, (pet.experience || 0) + 8);
      content = `${userName} 陪 ${petName} 玩了一会儿。`;
    } else if (action === 'pet') {
      pet.mood = Math.min(100, (pet.mood || 0) + 10);
      pet.experience = Math.max(0, (pet.experience || 0) + 3);
      content = `${userName} 轻轻地抚摸了 ${petName}。`;
    } else if (action === 'talk') {
      const text = await showCustomPrompt('和宠物说话', `对${petName}说点什么`, '', 'text');
      if (text === null) return;
      const userText = String(text || '').trim();
      if (!userText) return;
      const reply = await generatePetReply(chat, userText);
      pet.mood = Math.min(100, (pet.mood || 0) + 5);
      pet.experience = Math.max(0, (pet.experience || 0) + 6);
      content = `${userName}和宠物“${petName}”进行了对话。${userName}说：“${userText}”。它回应：“${reply}”。`;
    } else {
      return;
    }

    pet.level = petLevel(pet.experience);
    await addPetNarration(chat, content);
    await db.chats.put(chat);
    refreshVisibleUi(chat);
    if (typeof renderChatList === 'function') renderChatList();
  }

  function bindUi() {
    const modal = document.getElementById('character-bond-modal');
    if (!modal || modal.dataset.bound === 'true') return;
    modal.dataset.bound = 'true';
    const activeChat = () => state.activeChatId ? state.chats[state.activeChatId] : null;
    document.getElementById('character-spark-details-btn')?.addEventListener('click', () => showBondModal('spark', activeChat()));
    document.getElementById('shared-pet-manage-btn')?.addEventListener('click', () => showBondModal('pet', activeChat()));
    document.getElementById('character-spark-badge')?.addEventListener('click', () => showBondModal('spark', activeChat()));
    document.getElementById('close-character-bond-modal')?.addEventListener('click', () => modal.classList.remove('visible'));
    modal.addEventListener('click', event => { if (event.target === modal) modal.classList.remove('visible'); });
    document.getElementById('cancel-character-bond-modal')?.addEventListener('click', () => modal.classList.remove('visible'));
    document.getElementById('save-shared-pet-btn')?.addEventListener('click', () => savePetFromModal(activeChat()));
    document.getElementById('restore-character-spark-btn')?.addEventListener('click', () => restoreSpark(activeChat()));
    document.getElementById('feed-shared-pet-btn')?.addEventListener('click', () => feedPet(activeChat()));
    document.getElementById('shared-pet-avatar-url')?.addEventListener('input', event => {
      const preview = document.getElementById('shared-pet-avatar-preview');
      preview.src = event.target.value.trim();
      preview.dataset.pendingAvatar = event.target.value.trim();
    });
    document.getElementById('shared-pet-upload-btn')?.addEventListener('click', () => document.getElementById('shared-pet-upload-input').click());
    document.getElementById('shared-pet-upload-input')?.addEventListener('change', async event => {
      const file = event.target.files?.[0];
      if (!file) return;
      try {
        const dataUrl = await compressPetImage(file);
        const preview = document.getElementById('shared-pet-avatar-preview');
        preview.src = dataUrl;
        preview.dataset.pendingAvatar = dataUrl;
        document.getElementById('shared-pet-avatar-url').value = '';
      } catch (error) {
        await showCustomAlert('图片不可用', error.message);
      } finally {
        event.target.value = '';
      }
    });

    const petModal = document.getElementById('pet-interaction-modal');
    document.getElementById('open-pet-panel-btn')?.addEventListener('click', () => openPetInteractionModal(activeChat()));
    document.getElementById('close-pet-interaction-modal')?.addEventListener('click', () => petModal?.classList.remove('visible'));
    petModal?.addEventListener('click', event => { if (event.target === petModal) petModal.classList.remove('visible'); });
    petModal?.querySelectorAll('[data-pet-action]').forEach(button => {
      button.addEventListener('click', () => interactWithPet(button.dataset.petAction, activeChat()));
    });
    document.getElementById('dev-add-restore-card-btn')?.addEventListener('click', async () => {
      const chat = activeChat();
      if (!chat || chat.isGroup) return;
      ensureChat(chat);
      chat.spark.restoreCards = (chat.spark.restoreCards || 0) + 1;
      await db.chats.put(chat);
      renderSparkPanel(chat);
      showToast('已添加 1 张恢复卡');
    });
  }

  window.CharacterBond = {
    ensureChat, reconcile, setSwitches, petIsUsable, petMentionToken,
    normalizePetMention, displayMentions, getPromptContext, decorateAssistantBase,
    isAllowedPetMessage, onMessageSaved, refreshVisibleUi, decorateChatListItem,
    loadSettingsUi, updateSettingsSummary, showBondModal, bindUi,
    openPetInteractionModal, interactWithPet, updatePetButton
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bindUi);
  else bindUi();
})();
