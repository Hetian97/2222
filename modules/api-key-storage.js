// API Key 统一存储：db.apiConfig 为主，localStorage 作为兼容镜像。
(function () {
  'use strict';

  const API_KEY_STORAGE_MAP = {
    'pollinations-api-key': 'pollinationsApiKey',
    'google-imagen-api-key': 'googleImagenApiKey',
    'novelai-api-key': 'novelaiApiKey',
    'openai-image-api-key': 'openaiImageApiKey',
    'imgbb-api-key': 'imgbbApiKey',
    'minimax-api-key': 'minimaxApiKey',
    'couplespace-api-key': 'couplespaceApiKey',
    'catbox-userhash': 'catboxUserHash',
    'github-token': 'githubToken',
    'vm_external_memory_bearer_token': 'externalMemoryBearerToken'
  };

  async function ensureUnifiedApiKeyStorage() {
    if (typeof db === 'undefined' || typeof state === 'undefined') return;
    const stored = await db.apiConfig.get('main') || {};
    state.apiConfig = { ...stored, ...(state.apiConfig || {}) };
    const merged = { ...state.apiConfig, id: 'main' };
    let changed = false;

    for (const [localKey, field] of Object.entries(API_KEY_STORAGE_MAP)) {
      const localValue = localStorage.getItem(localKey);
      const dbValue = String(stored[field] ?? '').trim();
      const currentValue = dbValue || String(merged[field] ?? '').trim();

      if (dbValue) {
        // 数据库已有值时以数据库为准，并恢复兼容镜像。
        merged[field] = dbValue;
        state.apiConfig[field] = dbValue;
        if (localValue !== dbValue) localStorage.setItem(localKey, dbValue);
      } else if (localValue || currentValue) {
        // 旧版本只存在 localStorage（或内存）的 key，迁移到数据库。
        const value = String(currentValue || localValue).trim();
        merged[field] = value;
        state.apiConfig[field] = value;
        if (localValue !== value) localStorage.setItem(localKey, value);
        changed = true;
      } else if (!Object.prototype.hasOwnProperty.call(merged, field)) {
        merged[field] = '';
        state.apiConfig[field] = '';
      }
    }

    if (changed || !stored.id) {
      await db.apiConfig.put(merged);
    }
    localStorage.setItem('api-key-storage-unified', '1');
  }

  function setUnifiedApiKey(field, value) {
    if (typeof state !== 'undefined' && state.apiConfig) state.apiConfig[field] = value;
    const entry = Object.entries(API_KEY_STORAGE_MAP).find(([, keyField]) => keyField === field);
    if (entry) localStorage.setItem(entry[0], value || '');
    if (typeof db !== 'undefined' && typeof state !== 'undefined' && state.apiConfig) {
      db.apiConfig.put({ ...state.apiConfig, id: 'main' }).catch(error => {
        console.warn('[API Key] 写入数据库失败:', error);
      });
    }
  }

  function getUnifiedApiKey(field) {
    const value = typeof state !== 'undefined' ? state.apiConfig?.[field] : '';
    if (value) return value;
    const entry = Object.entries(API_KEY_STORAGE_MAP).find(([, keyField]) => keyField === field);
    return entry ? (localStorage.getItem(entry[0]) || '') : '';
  }

  window.ensureUnifiedApiKeyStorage = ensureUnifiedApiKeyStorage;
  window.setUnifiedApiKey = setUnifiedApiKey;
  window.getUnifiedApiKey = getUnifiedApiKey;
})();
