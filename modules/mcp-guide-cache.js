// MCP 指南缓存：只保存只读的 guide/help/schema 等资料，不保存认证信息。
(function () {
  'use strict';

  const DB_NAME = 'ephone-mcp-guide-cache';
  const DB_VERSION = 1;
  const STORE_NAME = 'entries';
  const PER_SERVICE_LIMIT = 2 * 1024 * 1024;
  const TOTAL_LIMIT = 10 * 1024 * 1024;
  const TTL_MS = 30 * 24 * 60 * 60 * 1000;
  const MAX_CONTEXT_BYTES = 16 * 1024;
  const cacheReady = typeof indexedDB === 'undefined' ? Promise.resolve(null) : openDatabase();

  function openDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
          store.createIndex('serviceKey', 'serviceKey', { unique: false });
          store.createIndex('updatedAt', 'updatedAt', { unique: false });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('MCP 指南缓存数据库打开失败'));
    });
  }

  function transact(mode, callback) {
    return cacheReady.then(db => {
      if (!db) return callback(null);
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, mode);
        const store = tx.objectStore(STORE_NAME);
        let result;
        try { result = callback(store); } catch (error) { reject(error); return; }
        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(tx.error || new Error('MCP 指南缓存操作失败'));
        tx.onabort = () => reject(tx.error || new Error('MCP 指南缓存操作已取消'));
      });
    });
  }

  function requestToPromise(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function getAllEntries() {
    return transact('readonly', store => store ? requestToPromise(store.getAll()) : []);
  }

  function serviceKey(service) {
    const name = String(service?.name || service?.serverName || '').trim();
    const url = String(service?.url || '').trim();
    return `${name}\u0000${url}`;
  }

  function normalizeVersion(value) {
    return value === undefined || value === null ? '' : String(value).trim();
  }

  function resultVersion(data, service) {
    return normalizeVersion(
      service?.serverVersion || service?.version ||
      data?.serverVersion || data?.serverInfo?.version ||
      data?.result?.serverInfo?.version || data?.structuredContent?.serverInfo?.version
    );
  }

  function toolDescription(service, toolName) {
    const tool = Array.isArray(service?.tools)
      ? service.tools.find(item => String(item?.name || '') === String(toolName || ''))
      : null;
    return String(tool?.description || '');
  }

  function isGuideTool(service, toolName) {
    const text = `${toolName || ''} ${toolDescription(service, toolName)}`.toLowerCase();
    return /(guide|help|schema|manual|reference|instruction|discover|list|status|describe|documentation|指南|帮助|手册|说明|文档|目录|状态|发现)/i.test(text);
  }

  function textFromValue(value, seen = new WeakSet()) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value;
    if (typeof value !== 'object') return String(value);
    if (seen.has(value)) return '';
    seen.add(value);
    if (Array.isArray(value)) return value.map(item => textFromValue(item, seen)).filter(Boolean).join('\n');
    const preferred = ['text', 'content', 'description', 'instructions', 'result'];
    const parts = [];
    for (const key of preferred) if (value[key] !== undefined) {
      const text = textFromValue(value[key], seen);
      if (text) parts.push(text);
    }
    if (parts.length) return parts.join('\n');
    return Object.entries(value).map(([key, item]) => `${key}: ${textFromValue(item, seen)}`).join('\n');
  }

  function redactSensitiveText(text) {
    return String(text || '')
      .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,}\]]+/ig, '$1[REDACTED]')
      .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]{12,}/ig, '$1[REDACTED]')
      .replace(/([?&](?:token|api[_-]?key|access[_-]?token|secret|password)=)[^&\s]+/ig, '$1[REDACTED]')
      .replace(/("?(?:token|api[_-]?key|access[_-]?token|secret|password)"?\s*[:=]\s*")[^"]*(")/ig, '$1[REDACTED]$2');
  }

  function splitText(text, maxChars = 6000) {
    const chunks = [];
    for (let i = 0; i < text.length; i += maxChars) chunks.push(text.slice(i, i + maxChars));
    return chunks;
  }

  function byteLength(text) {
    return typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(text).length : unescape(encodeURIComponent(text)).length;
  }

  function truncateToBytes(text, maxBytes) {
    if (byteLength(text) <= maxBytes) return text;
    let end = Math.min(text.length, maxBytes);
    while (end > 0 && byteLength(text.slice(0, end)) > maxBytes) end = Math.floor(end * 0.9);
    return text.slice(0, end);
  }

  async function deleteEntries(ids) {
    if (!ids.length) return;
    await transact('readwrite', store => ids.forEach(id => store.delete(id)));
  }

  async function purgeExpired(entries, now = Date.now()) {
    const expired = entries.filter(entry => Number(entry.expiresAt || 0) <= now).map(entry => entry.id);
    await deleteEntries(expired);
    return entries.filter(entry => !expired.includes(entry.id));
  }

  async function save(service, toolName, data) {
    if (!service?.url || !toolName || !isGuideTool(service, toolName)) return false;
    const rawText = redactSensitiveText(textFromValue(data)).trim();
    if (!rawText) return false;
    const text = truncateToBytes(rawText, PER_SERVICE_LIMIT);
    const chunks = splitText(text);
    const now = Date.now();
    const key = serviceKey(service);
    const version = resultVersion(data, service);
    let entries = await purgeExpired(await getAllEntries(), now);

    // 同一服务地址或名称的版本、地址变化会使旧资料失效。
    const stale = entries.filter(entry =>
      (entry.serviceName === String(service.name || '') || entry.serviceUrl === String(service.url || '')) &&
      (entry.serviceUrl !== String(service.url || '') || (version && entry.serviceVersion && entry.serviceVersion !== version))
    ).map(entry => entry.id);
    await deleteEntries(stale);
    entries = entries.filter(entry => !stale.includes(entry.id));

    const id = `${key}\u0000${toolName}`;
    await transact('readwrite', store => store.put({
      id,
      serviceKey: key,
      serviceName: String(service.name || service.url),
      serviceUrl: String(service.url),
      serviceVersion: version,
      toolName: String(toolName),
      chunks,
      sizeBytes: byteLength(text),
      updatedAt: now,
      expiresAt: now + TTL_MS
    }));

    entries = entries.filter(entry => entry.id !== id);
    entries.push({ id, serviceKey: key, serviceName: String(service.name || service.url), serviceUrl: String(service.url), sizeBytes: byteLength(text), updatedAt: now });
    const serviceEntries = entries.filter(entry => entry.serviceKey === key).sort((a, b) => b.updatedAt - a.updatedAt);
    let serviceBytes = serviceEntries.reduce((sum, entry) => sum + Number(entry.sizeBytes || 0), 0);
    const remove = [];
    for (const entry of serviceEntries) {
      if (serviceBytes <= PER_SERVICE_LIMIT) break;
      // 保留最新的一条，若单条本身已达到上限则不再继续删除它。
      if (entry.id === id) continue;
      serviceBytes -= Number(entry.sizeBytes || 0);
      remove.push(entry.id);
    }
    await deleteEntries(remove);
    entries = entries.filter(entry => !remove.includes(entry.id));

    const total = entries.reduce((sum, entry) => sum + Number(entry.sizeBytes || 0), 0);
    if (total > TOTAL_LIMIT) {
      const oldest = entries.filter(entry => !remove.includes(entry.id)).sort((a, b) => a.updatedAt - b.updatedAt);
      let excess = total - TOTAL_LIMIT;
      const totalRemove = [];
      for (const entry of oldest) {
        if (excess <= 0) break;
        excess -= Number(entry.sizeBytes || 0);
        totalRemove.push(entry.id);
      }
      await deleteEntries(totalRemove);
    }
    return true;
  }

  function scoreEntry(entry, query, services) {
    // 以 URL 作为服务身份，地址变化时旧缓存不会再次注入。
    const service = services.find(item => String(item?.url || '') === entry.serviceUrl);
    if (!service || service.enabled === false) return -1;
    if (resultVersion({}, service) && entry.serviceVersion && resultVersion({}, service) !== entry.serviceVersion) return -1;
    const haystack = `${entry.serviceName} ${entry.toolName} ${(entry.chunks || []).join(' ')}`.toLowerCase();
    const terms = String(query || '').toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter(term => term.length >= 2).slice(0, 12);
    return terms.reduce((score, term) => score + (haystack.includes(term) ? 2 : 0), 0) + 1;
  }

  async function invalidateAgainstServices(entries, services) {
    if (!Array.isArray(services)) return entries;
    const stale = entries.filter(entry => {
      const matchingUrl = services.find(item => String(item?.url || '') === entry.serviceUrl);
      const sameNamedService = services.some(item => String(item?.name || '') === entry.serviceName);
      if (!matchingUrl) return sameNamedService;
      const currentVersion = resultVersion({}, matchingUrl);
      return !!(currentVersion && entry.serviceVersion && currentVersion !== entry.serviceVersion);
    }).map(entry => entry.id);
    await deleteEntries(stale);
    return entries.filter(entry => !stale.includes(entry.id));
  }

  async function getContext(query, services) {
    let entries = await purgeExpired(await getAllEntries());
    entries = await invalidateAgainstServices(entries, services);
    if (!entries.length || !Array.isArray(services) || !services.length) return '';
    const ranked = entries.map(entry => ({ entry, score: scoreEntry(entry, query, services) }))
      .filter(item => item.score >= 0).sort((a, b) => b.score - a.score || b.entry.updatedAt - a.entry.updatedAt);
    let output = '';
    for (const { entry } of ranked) {
      const section = `\n【${entry.serviceName} · ${entry.toolName}（缓存指南，${new Date(entry.updatedAt).toLocaleDateString()}）】\n${(entry.chunks || []).join('\n')}`;
      if (byteLength(output + section) > MAX_CONTEXT_BYTES) break;
      output += section;
    }
    return output ? '【外部 MCP 指南缓存上下文】\n以下是之前成功读取的只读资料，仅供参考；若与当前服务不一致，应重新调用 MCP 核实。' + output : '';
  }

  async function stats() {
    let entries = await purgeExpired(await getAllEntries());
    let services = [];
    try {
      const raw = localStorage.getItem('mcpServiceConfigs');
      services = raw ? JSON.parse(raw) : [];
    } catch (_) { services = []; }
    entries = await invalidateAgainstServices(entries, services);
    const byService = {};
    entries.forEach(entry => {
      const key = entry.serviceKey;
      if (!byService[key]) byService[key] = { serviceKey: key, serviceName: entry.serviceName, serviceUrl: entry.serviceUrl, sizeBytes: 0, entries: 0 };
      byService[key].sizeBytes += Number(entry.sizeBytes || 0);
      byService[key].entries++;
    });
    return { totalBytes: entries.reduce((sum, entry) => sum + Number(entry.sizeBytes || 0), 0), totalLimit: TOTAL_LIMIT, perServiceLimit: PER_SERVICE_LIMIT, services: Object.values(byService) };
  }

  async function clearAll() { const entries = await getAllEntries(); await deleteEntries(entries.map(entry => entry.id)); }
  async function clearService(key) { const entries = await getAllEntries(); await deleteEntries(entries.filter(entry => entry.serviceKey === key).map(entry => entry.id)); }

  window.saveMcpGuideCache = save;
  window.getMcpGuideCacheContext = getContext;
  window.getMcpGuideCacheStats = stats;
  window.clearMcpGuideCache = clearAll;
  window.clearMcpGuideCacheService = clearService;
})();
