const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const {
  db,
  addMemory,
  listMemories,
  getMemoryById,
  getMemoriesByIds,
  searchMemoriesFts,
  getMemoryFtsTermDocumentCounts,
  getMemoryFtsStatus,
  rebuildMemoryFts,
  deleteMemory,
  clearAllMemories,
  getMemoryStats,
  listUnembeddedMemories,
  createMemorySearchLog,
  getLatestMemorySearchLog,
  commitMemorySearchInjection,
  finishMemorySearchGeneration,
  addGardenWakeEvent,
  claimGardenWakeEvent,
  finishGardenWakeEvent,
  getGardenWakeStats,
  addAisayWakeEvent,
  claimAisayWakeEvent,
  finishAisayWakeEvent,
  getAisayWakeStats,
  getMemoryOrganizationStatus,
  initializeMemoryOrganizationCoverage,
  resetMemoryOrganizationOverlay,
  getMemoryOrganizationPreviewInputs,
  saveMemoryOrganizationPreview,
  getReliableEventClusterMap,
  processMemoryOrganizationQueue,
  listMemoryClusters,
  listMemoryOrganizationEntries,
  listMemoryActiveEvents,
  upsertMemoryActiveEvent,
  archiveMemoryActiveEvent
} = require('./db');

const {
  buildMemoryOrganizationPreview
} = require('./memory-organization-preview');

const {
  getChromaStatus,
  upsertMemoriesToChroma,
  queryChromaByEmbedding,
  deleteMemoryFromChroma,
  resetChromaCollection
} = require('./chroma-client');

const {
  runRecallShadowPolicy
} = require('./recall-shadow-policy');

const {
  runActiveEventShadow
} = require('./memory-active-event-shadow');

const PORT = Number(process.env.PORT || 8765);
const BACKUP_DIR = process.env.MEMORY_BACKUP_DIR
  ? path.resolve(process.env.MEMORY_BACKUP_DIR)
  : path.join(__dirname, 'backups');
const LATEST_BACKUP_FILE = process.env.MEMORY_BACKUP_DIR
  ? path.join(BACKUP_DIR, 'memory.backup.db')
  : path.join(__dirname, 'memory.backup.db');
const API_TOKEN_FILE = path.join(__dirname, '.memory-api-token');

function getConfiguredApiToken() {
  const environmentToken = String(process.env.MEMORY_API_TOKEN || '').trim();
  if (environmentToken) return environmentToken;

  try {
    return fs.readFileSync(API_TOKEN_FILE, 'utf8').trim();
  } catch (error) {
    return '';
  }
}

function hasValidApiToken(req) {
  const expected = getConfiguredApiToken();
  if (!expected) return true;

  const authorization = String(req.headers.authorization || '');
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) return false;

  const supplied = Buffer.from(match[1].trim());
  const expectedBuffer = Buffer.from(expected);
  return supplied.length === expectedBuffer.length &&
    crypto.timingSafeEqual(supplied, expectedBuffer);
}

let lastMemorySearchState = null;

function compactMemorySearchPreview(memory) {
  if (!memory) return null;

  const dim = Number(memory.embeddingDim || memory._embeddingDim || 0);
  const hasEmbedding = memory.hasEmbedding === true ||
    memory._hasEmbedding === true ||
    dim > 0 ||
    Boolean(memory.embeddingModel);

  return {
    id: String(memory.id || ''),
    category: String(memory.category || ''),
    importance: Number(memory.importance || 0),
    emotionalWeight: Number(memory.emotionalWeight || 0),
    hasEmbedding,
    embeddingDim: dim,
    searchScore: typeof memory._searchScore === 'undefined' ? null : memory._searchScore,
    searchMode: memory._searchMode || '',
    content: String(memory.content || '').replace(/\s+/g, ' ').slice(0, 180)
  };
}

function compactShadowPolicySummary(shadowPolicy) {
  if (!shadowPolicy) return null;
  const { decisions, ...summary } = shadowPolicy;
  return summary;
}

function withReliableEventClusterMetadata(candidates) {
  const safeCandidates = Array.isArray(candidates) ? candidates : [];
  const clusterByMemory = getReliableEventClusterMap(safeCandidates.map(memory => memory?.id));
  return safeCandidates.map(memory => ({
    ...memory,
    _shadowEventClusterId: clusterByMemory[String(memory?.id || '')] || ''
  }));
}

function updateLastMemorySearchState(info = {}) {
  const results = Array.isArray(info.results) ? info.results : [];
  const chroma = info.chroma || { attempted: false };
  const fts = info.fts || { attempted: false };
  const query = String(info.query || '');
  const shadowPolicy = info.shadowPolicy || null;
  const shadowDecisionById = new Map(
    (Array.isArray(shadowPolicy?.decisions) ? shadowPolicy.decisions : [])
      .map(decision => [String(decision?.id || ''), decision])
      .filter(([id]) => id)
  );

  lastMemorySearchState = {
    at: Date.now(),
    atISO: new Date().toISOString(),
    source: String(info.source || ''),
    query: query.slice(0, 500),
    queryPreview: query.replace(/\s+/g, ' ').slice(0, 80),
    searchMode: String(info.searchMode || ''),
    requestedSearchEngine: String(info.requestedSearchEngine || ''),
    limit: Number(info.limit || 0),
    candidateLimit: typeof info.candidateLimit === 'undefined' ? null : Number(info.candidateLimit || 0),
    resultCount: typeof info.resultCount === 'undefined' ? results.length : Number(info.resultCount || 0),
    chroma: {
      attempted: Boolean(chroma.attempted),
      hybrid: typeof chroma.hybrid === 'undefined' ? null : Boolean(chroma.hybrid),
      returned: typeof chroma.returned === 'undefined' ? null : Number(chroma.returned || 0),
      matchedCandidates: typeof chroma.matchedCandidates === 'undefined' ? null : Number(chroma.matchedCandidates || 0),
      addedCandidates: typeof chroma.addedCandidates === 'undefined' ? null : Number(chroma.addedCandidates || 0),
      fallback: typeof chroma.fallback === 'undefined' ? false : Boolean(chroma.fallback),
      error: chroma.error || null
    },
    fts: {
      available: typeof fts.available === 'undefined' ? null : Boolean(fts.available),
      attempted: Boolean(fts.attempted),
      returned: typeof fts.returned === 'undefined' ? null : Number(fts.returned || 0),
      fallback: Boolean(fts.fallback),
      tokenizer: String(fts.tokenizer || ''),
      error: fts.error || null
    },
    shadowPolicy,
    activeEventShadow: info.activeEventShadow || null,
    resultsTop: results.slice(0, 10).map(memory => {
      const preview = compactMemorySearchPreview(memory);
      if (!preview) return null;
      const decision = shadowDecisionById.get(preview.id);
      return decision ? {
        ...preview,
        shadow: {
          admitted: Boolean(decision.admitted),
          selected: Boolean(decision.selected),
          route: decision.route || '',
          reason: decision.finalReason || decision.reason || '',
          admissionScore: decision.admissionScore ?? null,
          softQuotaPenalty: decision.softQuotaPenalty ?? 0
        }
      } : preview;
    }).filter(Boolean)
  };

  try {
    const persisted = createMemorySearchLog({
      ...lastMemorySearchState,
      chatId: info.chatId || '',
      queryVariants: info.queryVariants || [],
      turnId: info.turnId || '',
      attemptId: info.attemptId || '',
      actionType: info.actionType || 'reply',
      results,
      resultsTop: lastMemorySearchState.resultsTop
    });
    lastMemorySearchState = persisted;
    return persisted.id;
  } catch (error) {
    console.warn('[memory-server] failed to persist memory search log:', error.message || String(error));
    return null;
  }
}

const VALID_CATEGORIES = ['U', 'A', 'R', 'E', 'I', 'L', 'P', 'T', 'M', 'C'];

function now() {
  return Date.now();
}

function makeId() {
  return 'mem_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key'
  });
  res.end(JSON.stringify(data, null, 2));
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';

    req.on('data', chunk => {
      body += chunk.toString();

      if (body.length > 10 * 1024 * 1024) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });

    req.on('end', () => {
      if (!body) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(new Error('Invalid JSON body'));
      }
    });
  });
}

function clampNumber(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, Math.round(num)));
}

function normalizeCategory(category) {
  const value = String(category || '').trim().toUpperCase();
  return VALID_CATEGORIES.includes(value) ? value : 'E';
}

function normalizeTags(tags, namesToFilter = []) {
  const categoryLetters = new Set(['U', 'A', 'R', 'E', 'I', 'L', 'P', 'T', 'M', 'C']);
  const excludedNames = new Set((Array.isArray(namesToFilter) ? namesToFilter : [])
    .map(name => String(name || '').normalize('NFKC').trim().toLowerCase())
    .filter(name => name.length >= 2));

  if (!Array.isArray(tags)) return [];

  return tags
    .map(tag => String(tag || '').trim())
    .filter(Boolean)
    .map(tag => tag.replace(/^#/, '').trim())
    .filter(Boolean)
    .filter(tag => !categoryLetters.has(tag.toUpperCase()))
    .filter(tag => !excludedNames.has(tag.normalize('NFKC').toLowerCase()))
    .filter((tag, index, arr) => arr.indexOf(tag) === index)
    .slice(0, 12);
}

function normalizeEmbedding(embedding) {
  if (!Array.isArray(embedding)) return null;

  const cleaned = embedding
    .map(n => Number(n))
    .filter(n => Number.isFinite(n));

  return cleaned.length > 0 ? cleaned : null;
}

function normalizeLinkedMemories(linkedMemories) {
  if (!Array.isArray(linkedMemories)) return [];

  return linkedMemories
    .map(id => String(id || '').trim())
    .filter(Boolean);
}

function normalizeMemoryFragment(body) {
  const timestamp = now();

  const content = String(body.content || '').trim();
  if (!content) {
    throw new Error('content is required');
  }

  return {
    id: body.id ? String(body.id) : makeId(),
    chatId: body.chatId ? String(body.chatId) : null,
    content,
    tags: normalizeTags(body.tags, body.participantNames),
    category: normalizeCategory(body.category),
    importance: clampNumber(body.importance, 1, 10, 5),
    emotionalWeight: clampNumber(body.emotionalWeight, 1, 10, 3),

    createdAt: body.createdAt ?? timestamp,
    memoryTime: body.memoryTime ?? timestamp,
    lastRecalled: body.lastRecalled ?? 0,
    recallCount: clampNumber(body.recallCount, 0, 999999, 0),

    embedding: normalizeEmbedding(body.embedding),
    embeddingModel: body.embeddingModel ? String(body.embeddingModel) : '',
    embeddingDim: Number(body.embeddingDim || (Array.isArray(body.embedding) ? body.embedding.length : 0)),
    embeddingUpdatedAt: body.embeddingUpdatedAt ? String(body.embeddingUpdatedAt) : '',

    linkedMemories: normalizeLinkedMemories(body.linkedMemories),

    source: body.source ? String(body.source) : 'external',
    context: body.context ? String(body.context) : ''
  };
}

function tokenizeText(text) {
  if (!text) return [];

  const raw = String(text).toLowerCase();

  const cnTokens = raw.match(/[\u4e00-\u9fff]{2,5}/g) || [];
  const enTokens = raw.match(/[a-zA-Z0-9]+/g) || [];

  return [...new Set([...cnTokens, ...enTokens].filter(Boolean))];
}

function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
    return 0;
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    const x = Number(a[i]);
    const y = Number(b[i]);

    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;

    dot += x * y;
    normA += x * x;
    normB += y * y;
  }

  if (!normA || !normB) return 0;

  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}


const GENERIC_MEMORY_SEARCH_TERMS = new Set([
  '我', '你', '他', '她', '它', '我们', '你们', '他们', '她们',
  '嗯', '好', '好的', '是吗', '没有啊', '怎么了', '为什么',
  '这个', '那个', '一下', '一点', '什么', '不是', '没有',
  '今天', '明天', '昨天', '今晚', '早上', '中午', '下午', '晚上',
  '上次', '这次', '那次', '今年', '去年', '明年',
  '春天', '夏天', '秋天', '冬天', '春夏秋冬'
]);

function normalizeExactAnchorTerm(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[“”"‘’'＂＇]/g, '')
    .replace(/[\[\]（）(){}<>《》]/g, '')
    .replace(/[。！？!?，,、；;：:\s]+/g, '')
    .trim();
}

function isGenericMemorySearchTerm(value) {
  const term = normalizeExactAnchorTerm(value);
  if (!term) return true;
  if (term.length < 2) return true;
  if (/^\d+$/.test(term)) return true;
  if (GENERIC_MEMORY_SEARCH_TERMS.has(term)) return true;
  if (/^(我|你|他|她|它|我们|你们|他们|她们)/.test(term) && term.length <= 5) return true;
  if (/(怎么了|为什么|怎么办|没事|不是|这个|那个|一下|一点)$/.test(term) && term.length <= 6) return true;
  return false;
}

function parseMemorySearchTags(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return value.split(/[，,\s]+/).filter(Boolean);
    }
  }
  return [];
}

function buildExactAnchorTerms(searchQueries, memories = [], excludedTerms = []) {
  const queries = Array.isArray(searchQueries) ? searchQueries : [searchQueries];
  const queryNorm = normalizeExactAnchorTerm(queries.join(' '));
  if (!queryNorm) return [];

  const total = Math.max(1, Array.isArray(memories) ? memories.length : 0);
  const maxCommonHits = Math.min(120, Math.max(8, Math.ceil(total * 0.08)));

  const candidates = new Map();
  const excluded = new Set((Array.isArray(excludedTerms) ? excludedTerms : [])
    .map(normalizeExactAnchorTerm)
    .filter(Boolean));

  const addCandidate = (term) => {
    const normalized = normalizeExactAnchorTerm(term);
    if (excluded.has(normalized)) return;
    if (isGenericMemorySearchTerm(normalized)) return;
    if (normalized.length > 18) return;
    if (!queryNorm.includes(normalized)) return;

    if (!candidates.has(normalized)) {
      candidates.set(normalized, {
        term: normalized,
        hitCount: 0
      });
    }
  };

  for (const memory of memories || []) {
    for (const tag of parseMemorySearchTags(memory?.tags)) {
      addCandidate(tag);
    }
  }

  if (!candidates.size) return [];

  for (const memory of memories || []) {
    const tags = parseMemorySearchTags(memory?.tags)
      .map(normalizeExactAnchorTerm)
      .filter(Boolean);

    const contentNorm = normalizeExactAnchorTerm([
      memory?.content || '',
      memory?.context || ''
    ].join(' '));

    for (const candidate of candidates.values()) {
      const term = candidate.term;
      const tagHit = tags.some(tag => tag === term || tag.includes(term) || term.includes(tag));
      const contentHit = contentNorm.includes(term);
      if (tagHit || contentHit) {
        candidate.hitCount++;
      }
    }
  }

  return Array.from(candidates.values())
    .filter(item => item.hitCount > 0 && item.hitCount <= maxCommonHits)
    .sort((a, b) => {
      if (a.hitCount !== b.hitCount) return a.hitCount - b.hitCount;
      return b.term.length - a.term.length;
    })
    .slice(0, 16);
}

function scoreExactAnchorTerms(anchorTerms, memory) {
  if (!Array.isArray(anchorTerms) || !anchorTerms.length || !memory) {
    return {
      score: 0,
      matchedTerm: '',
      matchedCount: 0
    };
  }

  const tags = parseMemorySearchTags(memory.tags)
    .map(normalizeExactAnchorTerm)
    .filter(Boolean);

  const contentNorm = normalizeExactAnchorTerm([
    memory.content || '',
    memory.context || ''
  ].join(' '));

  let score = 0;
  let best = 0;
  let matchedTerm = '';
  let matchedCount = 0;

  for (const anchor of anchorTerms) {
    const term = normalizeExactAnchorTerm(anchor?.term || anchor);
    if (isGenericMemorySearchTerm(term)) continue;

    const tagExact = tags.some(tag => tag === term);
    const tagPartial = tags.some(tag => tag.includes(term) || term.includes(tag));
    const contentHit = contentNorm.includes(term);

    let current = 0;
    if (tagExact) current += 0.72;
    else if (tagPartial) current += 0.46;

    if (contentHit) current += 0.38;
    if (tagExact && contentHit) current += 0.15;
    if (current > 0 && term.length >= 3) current += 0.05;

    if (current > 0) {
      matchedCount++;
      score += current;

      if (current > best) {
        best = current;
        matchedTerm = term;
      }
    }
  }

  if (matchedCount >= 2) {
    score += Math.min(0.18, (matchedCount - 1) * 0.06);
  }

  return {
    score: Math.min(1, score),
    matchedTerm,
    matchedCount
  };
}

function keywordScore(query, memory, excludedTerms = []) {
  const rawQuery = String(query || '');
  const q = rawQuery.toLowerCase();
  if (!q.trim()) return 0;

  const parseTags = (value) => {
    if (Array.isArray(value)) return value;
    if (typeof value === 'string') {
      try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return value.split(/[，,\s]+/).filter(Boolean);
      }
    }
    return [];
  };

  const excluded = new Set((Array.isArray(excludedTerms) ? excludedTerms : [])
    .map(value => String(value || '').normalize('NFKC').trim().toLowerCase())
    .filter(Boolean));
  const tags = parseTags(memory.tags)
    .map(t => String(t || '').trim())
    .filter(Boolean)
    .filter(tag => !excluded.has(tag.normalize('NFKC').toLowerCase()));
  const tagText = tags.join(' ');
  const content = String(memory.content || '');
  const context = String(memory.context || '');
  const haystackRaw = [content, context, tagText].join(' ');
  const haystack = haystackRaw.toLowerCase();

  let score = 0;

  // 英文缩写 / 专名强命中：BERA、MCP、Akso、API、VPS 等
  const latinTokens = Array.from(new Set(rawQuery.match(/[A-Za-z][A-Za-z0-9._-]{1,}/g) || []))
    .map(t => t.toLowerCase())
    .filter(t => t.length >= 2);

  for (const token of latinTokens) {
    const inContent = haystack.includes(token);
    const inTag = tags.some(tag => tag.toLowerCase().includes(token));
    if (inTag) score += 0.45;
    else if (inContent) score += 0.28;
  }

  // tag 完整命中：query 里有 BERA会议 / 北京会议 / 乔教授 等，强加分
  for (const tag of tags) {
    const nt = tag.toLowerCase();
    if (!nt) continue;
    if (q.includes(nt)) {
      score += 0.55;
    } else {
      for (const token of latinTokens) {
        if (nt.includes(token)) score += 0.35;
      }
    }
  }

  // 中文连续短语命中：按查询自身与候选正文的重合度判断，不依赖地点、职业或事件词表。
  // 每个分句只采用最长命中，避免一段长文本因大量重叠 n-gram 重复加分。
  const chineseRuns = Array.from(new Set(rawQuery.match(/[\u3400-\u9fff]{3,48}/g) || []));
  let chinesePhraseScore = 0;
  for (const run of chineseRuns) {
    let longestMatch = 0;
    const maximumSize = Math.min(8, run.length);
    for (let size = maximumSize; size >= 3 && !longestMatch; size--) {
      for (let index = 0; index <= run.length - size; index++) {
        if (haystack.includes(run.slice(index, index + size).toLowerCase())) {
          longestMatch = size;
          break;
        }
      }
    }
    if (longestMatch >= 3) {
      chinesePhraseScore += longestMatch >= 6 ? 0.22 : longestMatch === 5 ? 0.16 : longestMatch === 4 ? 0.12 : 0.08;
    }
  }
  score += Math.min(0.35, chinesePhraseScore);

  // 原有宽松词面匹配，保留少量普通关键词作用
  const looseTokens = Array.from(new Set(
    rawQuery
      .replace(/[，。！？、；：\n\r\t"'“”‘’（）()\[\]{}]/g, ' ')
      .split(/\s+/)
      .map(t => t.trim().toLowerCase())
      .filter(t => t.length >= 2 && t.length <= 24)
  ));

  for (const token of looseTokens) {
    if (haystack.includes(token)) score += 0.04;
  }

  return Math.min(1, score);
}

function safeParseEmbedding(value) {
  if (!value) return null;
  if (Array.isArray(value)) return value;

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function createQueryEmbedding({ endpoint, apiKey, model, input }) {
  if (!endpoint || !apiKey || !input) return null;

  const base = String(endpoint).replace(/\/$/, '');
  const url = base.endsWith('/v1/embeddings')
    ? base
    : `${base}/v1/embeddings`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: model || 'BAAI/bge-m3',
      input
    })
  });

  if (!response.ok) {
    let errorText = '';
    try {
      errorText = await response.text();
    } catch {}

    throw new Error(`Embedding query failed: HTTP ${response.status}${errorText ? ': ' + errorText.slice(0, 160) : ''}`);backupSqliteDb
  }

  const data = await response.json();
  const embedding = data?.data?.[0]?.embedding;

  return Array.isArray(embedding) && embedding.length > 0 ? embedding : null;
}

async function createChatCompletion({ endpoint, apiKey, model, messages, temperature = 0.2 }) {
  const base = String(endpoint || '').replace(/\/$/, '');
  const url = base.endsWith('/v1/chat/completions')
    ? base
    : `${base}/v1/chat/completions`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      messages,
      temperature
    })
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`Chat completion failed: HTTP ${response.status}${errorText ? ': ' + errorText.slice(0, 200) : ''}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;

  if (!content || typeof content !== 'string') {
    throw new Error('Chat completion returned empty content');
  }

  return content;
}

function buildRawIngestPrompt({ combinedText, scene, timeRange, source, roleName = '角色', userName = '她' }) {
  return `
# 你的任务：
你是一个长期记忆提取器。请从下面的聊天原文中提取值得长期保存的记忆，并输出严格 JSON 数组。

# 写作视角：
- 以"${roleName}"的第一人称视角写长期记忆。
- 用“我”指代"${roleName}"。
- 用“她”或“${userName}”指代用户。
- 不要用“用户”“角色名”“当前角色”等第三人称称呼来写 content，除非原文本身需要区分其他人物。
- 对话中出现的其他人，使用其全名指代。
- 如实记录事件经过、人物状态、关系变化和重要信息，禁止编造或改写原文信息。

# 主体识别规则：
- 提取记忆前，必须先判断原对话中每个行为、决定、表达和经历的实际主体。
- “我”必须始终指代当前角色，不能代替用户。
- 不要把用户做过的事、说过的话、计划或感受改写成角色自己的经历。
- 不要把角色做过的事、说过的话、计划或感受归属于用户。
- 如果一句话包含“我”“你”“她”等代词，必须结合上下文判断真实指代，而不是直接沿用原句视角。

# 人称解析规则：
- 如果原文带有说话人标签，必须先根据说话人判断“我/你/她/他”的真实指代。
- 当前角色发言中，“我”= 当前角色，“你”= 用户。
- 用户发言中，“我”= 用户，“你”= 当前角色。
- 不要直接复制原句中的代词视角，最终 content 必须统一转换为当前角色第一人称：
  “我”= 当前角色，“她/用户称呼”= 用户。
- 如果内容是在回忆、解释或确认过去事件，必须写明“她回忆/她确认/我解释/我承认”，不要写成当前刚发生。

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

- U = 用户设定（${userName}的外貌/性格/喜好/身份、稳定偏好、习惯、身体感受、生活需求等）
- A = 角色设定（${roleName}自己的长期做法、原则、保护方式、行为边界或自身变化）
- R = 关系发展（${roleName}与${userName}之间的表白、吵架、和好、主动承认想念、亲密互动、关系推进等里程碑）
- I = 物品/礼物（礼物、衣物、饰品、重要物品的赠送、使用或长期意义）
- L = 地点/场景（被命名、反复出现、具有特殊意义、关系节点性质或后续可能被回忆的地点/场景；长期住处或常住地也可归为 L。普通“想去/准备去某地”通常不归为 L，单次共同到访通常优先归为 E）
- P = 承诺/计划（约定的未来事项、答应要做的事、长期承诺、持续计划、共同生活安排、会推动下一场景或后续剧情的短期计划）
- T = 禁忌/规则（隐私边界、雷区、规矩、禁忌、不能对外提及或只允许两人之间知道的事）
- M = 情绪/心理（${roleName}或${userName}产生的强烈、深层或长期影响后续互动的心理状态，如嫉妒、愧疚、懊悔、救赎感、归属感、生命坐标、阴影、崩溃、心理创伤等；普通短暂紧张/害怕通常不归为 M）
- C = 核心灵魂（必须长期牢记的关键设定）
- E = 经历/事件（${roleName}与${userName}共同经历的一次具体事件，例如共同外出、到达某个新地点、完成某件事或发生一次值得回忆的互动；仅在不属于 U/A/R/I/L/P/T/M/C 时使用）

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

# 评分规则（1-10）：
- importance: 1-10。
- 1-4：轻量信息、普通日常、低影响事件、可不长期追踪的短期安排。
- 5-6：值得记住的偏好、普通承诺、普通共同经历、一般地点信息、会推动下一场景的短期计划。
- 7-8：明确长期有效的规则、重要地点、明显关系推进、重要保护原则、持续承诺、会反复影响后续互动的事件。
- 9-10：核心设定、生死约定、不可违背的长期规则、重大关系转折。不要轻易给 9-10。
- 普通“今晚/明天要去某地”“我会安排车”通常为 5-6；只有代表长期安排或重大转折时才给 7 以上。
- emotionalWeight: 1-10。普通安排通常 2-4；明显亲密、恐惧、崩溃、和好、告白等才给 6 以上。

# 输入信息：
原文来源：${source || 'njj'}
场景：${scene || '未提供'}
时间范围：${timeRange || '未提供'}

聊天原文：
${combinedText}

# 输出要求：
请直接输出 JSON 数组。如果没有值得记录的内容，输出 []。`;
}

function buildSummaryIngestPrompt({ summaryText, source, roleName = '角色', userName = '她' }) {
  return `
# 你的任务：
你是一个长期记忆整理器。请将下面已经总结好的场景记忆，转换成适合写入长期向量记忆库的 JSON 数组。

# 输入格式
输入通常是这种格式：
[时间]：...
[概括]：...
[场景X]：...
[记忆X]：...

# 写作视角：
- 以"${roleName}"的第一人称视角写长期记忆。
- 用“我”指代"${roleName}"。
- 用“她”或“${userName}”指代用户。
- 不要直接整段复制原始[记忆]文本，而要整理成更适合检索的长期记忆。
- 保留原总结里的时间、地点、人物、承诺、关系变化、重要事件、稳定偏好和核心设定。
- 禁止编造原总结里没有的信息。
- 不要把角色名或用户昵称本身作为 tags；tags 应该是事件、关系、地点、物品、规则或情绪关键词。

# 主体识别规则：
- 整理记忆前，必须确认原记忆中的行为、决定、表达和经历的实际主体。
- “我”始终指代当前角色（${roleName}），不能代替用户。
- 不要把用户做过的事、说过的话、计划或感受改写成角色自己的经历。
- 不要把角色做过的事、说过的话、计划或感受归属于用户。
- 如果原总结中使用“我”“你”“她”等代词，必须先判断真实主体，再转换为当前角色第一人称。

# 整理原则：
- 检查是否有可合并的重复项，但不要过度合并导致信息丢失。宁可略多，不要过少。
- 每条记忆围绕一个核心主题，长度50-120字。当同一场景或同一话题中包含2个以上互相独立的信息点，应拆成多条，分别记录。
- 如果旧记忆已覆盖当前内容，不重复生成。但如果存在旧记忆未包含的新信息（新细节、新情绪、新约定、新进展），应保留为新的独立记忆，新旧并存。
- 不要把一次性行为改写成“习惯”“总是”“长期如此”等长期模式，除非原文明确表达了持续性。
- 过滤纯寒暄、明确重复、确实无信息量的内容。当不确定是否该保留时，偏向保留而非丢弃。
- E 不是“低价值分类”，也不是“兜底分类”。同一场景中若产生多个独立信息，应拆分为多条记忆分别归入对应分类，而不是全部打包进一条 E。具体分类规则见下方「10大精细分类说明」。

# 10大精细分类说明：
当从同一场景中拆出多条记忆时，按以下标准判断每条记忆的核心归属：
请优先判断这条记忆的核心是什么。若核心是一次具体共同经历、一次场景节点、一次有回忆价值的日常互动，优先归为 E；只有当核心明显属于长期有效的稳定设定、长期规则或边界、关系转折或关系里程碑、具有重要意义的物品、具有长期意义的地点、尚未完成且需要后续兑现的长期承诺或计划、强烈且会持续影响后续互动的心理状态、核心灵魂设定时，才归入 U/A/R/I/L/P/T/M/C。不要把 E 当作兜底分类，也不要把所有日常都归为 E。

- U = 用户设定（${userName}的外貌/性格/喜好/身份、稳定偏好、习惯、身体感受、生活需求等）
- A = 角色设定（${roleName}自己的长期做法、原则、保护方式、行为边界或自身变化）
- R = 关系发展（${roleName}与${userName}之间的表白、吵架、和好、主动承认想念、亲密互动、关系推进等里程碑）
- I = 物品/礼物（礼物、衣物、饰品、重要物品的赠送、使用或长期意义）
- L = 地点/场景（被命名、反复出现、具有特殊意义、关系节点性质或后续可能被回忆的地点/场景；长期住处或常住地也可归为 L。普通“想去/准备去某地”通常不归为 L，单次共同到访通常优先归为 E）
- P = 承诺/计划（约定的未来事项、答应要做的事、长期承诺、持续计划、共同生活安排、会推动下一场景或后续剧情的短期计划）
- T = 禁忌/规则（隐私边界、雷区、规矩、禁忌、不能对外提及或只允许两人之间知道的事）
- M = 情绪/心理（${roleName}或${userName}产生的强烈、深层或长期影响后续互动的心理状态，如嫉妒、愧疚、懊悔、救赎感、归属感、生命坐标、阴影、崩溃、心理创伤等；普通短暂紧张/害怕通常不归为 M）
- C = 核心灵魂（必须长期牢记的关键设定）
- E = 经历/事件（${roleName}与${userName}共同经历的一次具体事件；仅在不属于 U/A/R/I/L/P/T/M/C 时使用）

# 输出格式（严格遵守 JSON 数组）
\`\`\`json
[
  {
    "content": "记忆内容（第一人称，简短清晰，如：${userNickname}告诉我她今天升职了）",
    "tags": ["升职", "开心", "工作"],
    "category": "U/A/R/E/I/L/P/T/M/C",
    "importance": 1-10,
    "emotionalWeight": 1-10,
    "memoryTime": 1700000000000
  }
]
\`\`\`

# 评分规则（1-10）：
- importance: 1-10。
- 1-4：轻量信息、普通日常、低影响事件。
- 5-6：值得记住的偏好、普通承诺、普通共同经历、一般地点信息、会推动下一场景的短期计划。
- 7-8：明确长期有效的规则、重要地点、明显关系推进、重要保护原则、持续承诺、会反复影响后续互动的事件。
- 9-10：核心设定、生死约定、不可违背的长期规则、重大关系转折。不要轻易给 9-10。
- emotionalWeight: 1-10。普通安排通常 2-4；明显亲密、恐惧、崩溃、和好、告白、深层心理转折等才给 6 以上。

# 输入信息：
原文来源：${source || 'njj_summary'}

待处理总结：
${summaryText}

# 输出要求：
请直接输出 JSON 数组。如果没有值得记录的内容，输出 []。`;
}

function parseExtractedMemoryItems(rawText, namesToFilter = []) {
  const jsonMatch = String(rawText || '').match(/\[[\s\S]*\]/);
  if (!jsonMatch) return [];

  const arr = JSON.parse(jsonMatch[0]);
  if (!Array.isArray(arr)) return [];

  return arr
    .filter(item => item && item.content)
    .map(item => {
      const normalized = {
        content: String(item.content || '').trim(),
        tags: normalizeTags(item.tags || [], namesToFilter),
        category: normalizeCategory(item.category || 'E'),
        importance: clampNumber(item.importance, 1, 10, 5),
        emotionalWeight: clampNumber(item.emotionalWeight, 1, 10, 3)
      };

      return normalized;
    })
    .filter(item => item.content);
}

function memoryToSearchText(memory) {
  return [
    memory.content,
    memory.category,
    Array.isArray(memory.tags) ? memory.tags.join(' ') : '',
    memory.context || '',
    memory.source || ''
  ].join(' ').toLowerCase();
}


function normalizeMemorySearchQueryText(value) {
  return String(value || '')
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, ' ')
    .replace(/<\/?[A-Za-z][A-Za-z0-9_-]*>/g, ' ')
    .replace(/\`\`\`[\s\S]*?\`\`\`/g, ' ')
    .replace(/^\s*\(Timestamp:\s*\d+\)\s*/gmi, ' ')
    .replace(/^\s*\[(系统|旁白|system)[^\]]*\]\s*/gmi, ' ')
    .replace(/[{}\[\]<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[\s"'“”‘’「」『』《》.,，。!?！？;；:：、*]+|[\s"'“”‘’「」『』《》.,，。!?！？;；:：、*]+$/g, '')
    .trim();
}

function normalizeMemorySearchQueryList(value) {
  const raw = [];

  const add = (item) => {
    const text = normalizeMemorySearchQueryText(item);
    if (text) raw.push(text);
  };

  if (Array.isArray(value)) {
    value.forEach(add);
  } else if (typeof value === 'string') {
    const text = value.trim();
    if (text) {
      try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) parsed.forEach(add);
        else add(text);
      } catch {
        text.split(/[\n\r]+/).forEach(add);
      }
    }
  }

  const seen = new Set();
  return raw.filter(item => {
    const key = item.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 8);
}

function extractTechnicalMemorySearchTokens(rawQuery) {
  const text = normalizeMemorySearchQueryText(rawQuery);
  const tokens = text.match(/[A-Za-z][A-Za-z0-9._-]{3,}|[A-Z]{2,}(?:[._-][A-Z0-9]+)*|\d{3,}/g) || [];

  const seen = new Set();
  return tokens
    .map(item => item.trim())
    .filter(item => item.length >= 2 && item.length <= 48)
    .filter(item => {
      const key = item.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 24);
}

function extractQuotedMemorySearchPhrases(rawQuery) {
  const text = normalizeMemorySearchQueryText(rawQuery);
  const phrases = [];
  const seen = new Set();
  const quotedRe = /[“"「『《]([^”"」』》]{2,40})[”"」』》]/g;
  let match;

  while ((match = quotedRe.exec(text))) {
    const phrase = normalizeMemorySearchQueryText(match[1]);
    if (!phrase) continue;

    const key = phrase.toLowerCase();
    if (seen.has(key)) continue;

    seen.add(key);
    phrases.push(phrase);
  }

  return phrases.slice(0, 8);
}

function scoreMemorySearchClause(clause) {
  const text = normalizeMemorySearchQueryText(clause);
  if (!text) return -1;

  const compact = text.replace(/\s+/g, '');
  const chars = Array.from(compact);
  if (chars.length < 2 || chars.length > 48) return -1;

  const cjkCount = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const latinDigitCount = (text.match(/[A-Za-z0-9]/g) || []).length;

  if (cjkCount + latinDigitCount < 2) return -1;
  if (!latinDigitCount && cjkCount < 3) return -1;

  const unique = new Set(chars);
  if (unique.size <= 1) return -1;

  const counts = new Map();
  for (const ch of chars) counts.set(ch, (counts.get(ch) || 0) + 1);

  let maxRepeat = 0;
  for (const n of counts.values()) {
    if (n > maxRepeat) maxRepeat = n;
  }

  if (maxRepeat / chars.length > 0.65) return -1;

  let score = 0;

  if (/[A-Za-z0-9]/.test(text)) score += 5;
  if (/[A-Z]{2,}/.test(text)) score += 2;
  if (/[A-Za-z][A-Za-z0-9]*(?:[._-][A-Za-z0-9]+)+/.test(text)) score += 3;
  if (/\d/.test(text)) score += 1;

  if (cjkCount >= 4 && cjkCount <= 24) score += 3;
  if (chars.length <= 24) score += 2;
  if (unique.size >= 4) score += 1;

  return score;
}

function extractStructuredMemorySearchClauses(rawQuery) {
  const text = normalizeMemorySearchQueryText(rawQuery);
  if (!text) return [];

  const clauses = text
    .split(/[\n\r，,。.!?！？；;：:、|\/\\]+/)
    .map(item => item.trim())
    .filter(Boolean);

  const items = clauses
    .map((clause, index) => ({
      clause: normalizeMemorySearchQueryText(clause),
      score: scoreMemorySearchClause(clause),
      index
    }))
    .filter(item => item.clause && item.score > 0)
    .filter(item => /[\u4e00-\u9fff]/.test(item.clause));

  const selected = [];
  const seen = new Set();

  const add = (item) => {
    if (!item || !item.clause) return;
    const key = item.clause.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    selected.push(item.clause);
  };

  // 长 query 里，尾部通常更接近“当前状态/当前动作”，所以尾部优先。
  items.slice(-6).forEach(add);

  // 保留少量开头，避免丢失话题起点。
  items.slice(0, 3).forEach(add);

  // 再用形式分数补充少量中间高信息短句；不使用任何领域关键词清单。
  [...items]
    .sort((a, b) => b.score - a.score)
    .slice(0, 6)
    .forEach(add);

  return selected.slice(0, 10);
}

function buildMemorySearchQueries(primaryQuery, extraQueries = []) {
  const candidates = [];
  const seen = new Set();

  const add = (value) => {
    const text = normalizeMemorySearchQueryText(value);
    if (!text) return;

    const key = text.toLowerCase();
    if (seen.has(key)) return;

    seen.add(key);
    candidates.push(text);
  };

  add(primaryQuery);
  normalizeMemorySearchQueryList(extraQueries).forEach(add);

  const technicalTokens = extractTechnicalMemorySearchTokens(primaryQuery);
  if (technicalTokens.length) {
    add(technicalTokens.slice(0, 16).join(' '));
  }

  extractQuotedMemorySearchPhrases(primaryQuery).forEach(add);
  extractStructuredMemorySearchClauses(primaryQuery).forEach(add);

  return candidates.slice(0, 12);
}

function buildRecallIntentAnchors(query, filters = {}) {
  const terms = [];
  const runs = String(query || '').normalize('NFKC').toLowerCase().match(/[\u3400-\u9fff]{2,32}/g) || [];
  for (const size of [6, 5, 4, 3, 2]) {
    const sizedTerms = [];
    for (const run of runs) {
      for (let index = 0; index <= run.length - size; index++) sizedTerms.push(run.slice(index, index + size));
    }
    const uniqueSizedTerms = [...new Set(sizedTerms)];
    const step = Math.max(1, uniqueSizedTerms.length / 16);
    for (let index = 0; index < uniqueSizedTerms.length && terms.length < (7 - size) * 16; index += step) {
      terms.push(uniqueSizedTerms[Math.floor(index)]);
    }
  }
  const stats = getMemoryFtsTermDocumentCounts(terms, filters)
    .filter(item => item.count > 0)
    .sort((left, right) => right.term.length - left.term.length || left.count - right.count);
  const total = Math.max(1, getMemoryFtsStatus({ integrityCheck: false }).totalMemories || 1);
  const rareCeiling = Math.max(8, Math.ceil(total * 0.035));
  const selected = [];
  for (const item of stats) {
    if (item.count > rareCeiling) continue;
    if (selected.some(existing => existing.term.includes(item.term))) continue;
    selected.push({
      term: item.term,
      count: item.count,
      weight: Number((1 + Math.log((total + 1) / (item.count + 1))).toFixed(6))
    });
    if (selected.length >= 12) break;
  }
  return selected;
}

async function simpleSearch(memories, query, limit = 20, options = {}) {
  const q = String(query || '').trim();
  const safeLimit = clampNumber(limit, 1, 200, 20);
  const searchQueries = buildMemorySearchQueries(q, options.queryVariants || options.cleanedQueries || options.queries || []);
  const exactAnchorTerms = buildExactAnchorTerms(searchQueries.slice(0, 1), memories, options.participantNames);

  const rawWeights = options.scoreWeights || options.weights || {};
  const readWeight = (name, fallback) => {
    const value = Number(rawWeights[name]);
    return Number.isFinite(value) ? value : fallback;
  };
  const weights = {
    semantic: readWeight('semantic', 0.4),
    keyword: readWeight('keyword', 0.3),
    importance: readWeight('importance', 0.2),
    emotion: readWeight('emotion', 0.05),
    recency: readWeight('recency', 0.05)
  };

  if (!searchQueries.length) {
    return memories.slice(0, safeLimit);
  }

  const queryEmbeddings = [];

  if (options.embedding?.endpoint && options.embedding?.apiKey) {
    for (const [queryIndex, searchQuery] of searchQueries.slice(0, 2).entries()) {
      try {
        const queryEmbedding = await createQueryEmbedding({
          endpoint: options.embedding.endpoint,
          apiKey: options.embedding.apiKey,
          model: options.embedding.model,
          input: searchQuery
        });

        if (queryEmbedding) {
          console.log('[memory-server] query embedding dim =', queryEmbedding.length, 'query =', searchQuery.slice(0, 80));
          queryEmbeddings.push({
            query: searchQuery,
            embedding: queryEmbedding,
            weight: queryIndex === 0 ? 1 : 0.35
          });
        }
      } catch (error) {
        console.warn('[memory-server] query embedding failed, continue keyword search:', error.message);
      }
    }
  }

  const scored = memories
    .map(memory => {
      const memoryEmbedding = safeParseEmbedding(memory.embedding);

      let vectorScore = 0;
      let vectorMatchedQuery = '';

      if (memoryEmbedding && queryEmbeddings.length) {
        for (const item of queryEmbeddings) {
          const currentScore = cosineSimilarity(item.embedding, memoryEmbedding) * item.weight;
          if (currentScore > vectorScore) {
            vectorScore = currentScore;
            vectorMatchedQuery = item.query;
          }
        }
      }

      let textScore = 0;
      let keywordMatchedQuery = '';

      for (const [queryIndex, searchQuery] of searchQueries.entries()) {
        const queryWeight = queryIndex === 0 ? 1 : 0.35;
        const currentScore = keywordScore(searchQuery, memory, options.participantNames) * queryWeight;
        if (currentScore > textScore) {
          textScore = currentScore;
          keywordMatchedQuery = searchQuery;
        }
      }

      // Exact anchor boost:
      // dynamically detects concrete, relatively rare terms from the current query
      // and boosts memories whose content/tags contain those terms.
      const anchorHit = scoreExactAnchorTerms(exactAnchorTerms, memory);
      if (anchorHit.score > 0) {
        const boostedTextScore = Math.min(1, Math.max(textScore, anchorHit.score));
        if (boostedTextScore > textScore) {
          keywordMatchedQuery = anchorHit.matchedTerm;
        }
        textScore = boostedTextScore;
      } else if (exactAnchorTerms.length && textScore > 0.35) {
        // When concrete anchors exist, do not let generic relationship words
        // such as names/titles outrank memories that actually hit the anchor.
        textScore = 0.35;
      }

      const matchedQuery = keywordMatchedQuery || vectorMatchedQuery || searchQueries[0] || q;

      const importanceVal = Number(memory.importance) || 5;
      let importanceScore = importanceVal / 10;
      if (importanceVal >= 8) importanceScore *= 1.5;
      importanceScore = Math.min(1, importanceScore);

      const emotionScore = (Number(memory.emotionalWeight) || 3) / 10;

      const timeBase = Number(memory.memoryTime || memory.createdAt || memory.updatedAt || 0);
      const daysSince = timeBase > 0
        ? Math.max(0, (Date.now() - timeBase) / (1000 * 60 * 60 * 24))
        : 999;
      let recencyScore = Math.max(0.1, Math.exp(-0.693 * daysSince / 30));
      if (importanceVal >= 9) recencyScore = 1.0;

      const hasVector = vectorScore > 0;

      const totalScore =
        vectorScore * weights.semantic +
        textScore * weights.keyword +
        importanceScore * weights.importance +
        emotionScore * weights.emotion +
        recencyScore * weights.recency;

      const scoreParts = {
        semantic: vectorScore * weights.semantic,
        keyword: textScore * weights.keyword,
        importance: importanceScore * weights.importance,
        emotion: emotionScore * weights.emotion,
        recency: recencyScore * weights.recency
      };

      return {
        memory,
        score: totalScore,
        vectorScore,
        keywordScore: textScore,
        anchorScore: anchorHit?.score || 0,
        anchorMatchedTerm: anchorHit?.matchedTerm || '',
        anchorMatchedCount: anchorHit?.matchedCount || 0,
        normalizedQueryLength: normalizeExactAnchorTerm(q).length,
        matchedQuery,
        hasVector,
        scoreParts
      };
    })
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, safeLimit).map(item => {
    const memoryEmbedding = safeParseEmbedding(item.memory.embedding);

    const {
      embedding,
      ...memoryWithoutEmbedding
    } = item.memory;

    return {
      ...memoryWithoutEmbedding,
      embedding: memoryEmbedding ? `[hidden:${memoryEmbedding.length}d]` : null,
      _hasEmbedding: Boolean(memoryEmbedding),
      _embeddingDim: memoryEmbedding ? memoryEmbedding.length : 0,
      _searchScore: Number(item.score.toFixed(6)),
      _vectorScore: Number(item.vectorScore.toFixed(6)),
      _keywordScore: Number(item.keywordScore.toFixed(6)),
      _anchorScore: Number((item.anchorScore || 0).toFixed(6)),
      _anchorMatchedTerm: item.anchorMatchedTerm || '',
      _anchorMatchedCount: Number(item.anchorMatchedCount || 0),
      _normalizedQueryLength: Number(item.normalizedQueryLength || 0),
      _matchedQuery: item.matchedQuery || q,
      _scoreParts: {
        semantic: Number((item.scoreParts?.semantic || 0).toFixed(6)),
        keyword: Number((item.scoreParts?.keyword || 0).toFixed(6)),
        importance: Number((item.scoreParts?.importance || 0).toFixed(6)),
        emotion: Number((item.scoreParts?.emotion || 0).toFixed(6)),
        recency: Number((item.scoreParts?.recency || 0).toFixed(6))
      },
      _searchMode: item.hasVector ? 'vector+keyword' : 'keyword'
    };
  });
}

async function tryUpsertMemoryToChroma(memory) {
  try {
    const hasEmbedding =
      Array.isArray(memory?.embedding) && memory.embedding.length > 0;

    if (!hasEmbedding) {
      return {
        ok: false,
        skipped: true,
        reason: 'memory has no embedding'
      };
    }

    const result = await upsertMemoriesToChroma([memory], { batchSize: 1 });

    console.log('[memory-server] chroma auto-upsert ok:', memory.id);

    return result;
  } catch (error) {
    console.warn(
      '[memory-server] chroma auto-upsert failed:',
      memory?.id || '',
      error.message || String(error)
    );

    return {
      ok: false,
      error: error.message || String(error)
    };
  }
}

async function tryDeleteMemoryFromChroma(id) {
  try {
    const result = await deleteMemoryFromChroma(id);
    console.log('[memory-server] chroma delete ok:', id);
    return result;
  } catch (error) {
    console.warn(
      '[memory-server] chroma delete failed:',
      id || '',
      error.message || String(error)
    );

    return {
      ok: false,
      error: error.message || String(error)
    };
  }
}

async function tryResetChromaCollection() {
  try {
    const result = await resetChromaCollection();
    console.log('[memory-server] chroma reset ok:', result);
    return result;
  } catch (error) {
    console.warn(
      '[memory-server] chroma reset failed:',
      error.message || String(error)
    );

    return {
      ok: false,
      error: error.message || String(error)
    };
  }
}


function parseExternalMcpResponseJson(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch {}

  const dataLines = raw
    .split(/\r?\n/)
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).trim())
    .filter(Boolean);

  for (const line of dataLines) {
    if (line === '[DONE]') continue;
    try {
      return JSON.parse(line);
    } catch {}
  }

  return null;
}

function isInternalHotlistMcpUrl(serviceUrl) {
  try {
    const url = new URL(String(serviceUrl || '').trim());
    const pathname = url.pathname.replace(/\/+$/, '') || '/';

    return url.protocol === 'https:' &&
      url.hostname.toLowerCase() === 'mcp.htw1.uk' &&
      !url.port &&
      pathname === '/hotlist-mcp' &&
      !url.search &&
      !url.hash;
  } catch {
    return false;
  }
}

async function callInternalHotlistMcp(method, params = {}) {
  const response = await handleHotlistMcpRequest({
    jsonrpc: '2.0',
    id: Date.now(),
    method,
    ...(params && Object.keys(params).length ? { params } : {})
  });

  if (response?.error) {
    throw new Error(method + ' error: ' + JSON.stringify(response.error));
  }

  return response;
}

function getExternalMcpToolErrorMessage(result) {
  if (!result || typeof result !== 'object') {
    return 'External MCP tool returned isError=true.';
  }

  const contentMessages = Array.isArray(result.content)
    ? result.content
      .filter(item => item && item.type === 'text' && typeof item.text === 'string')
      .map(item => item.text.trim())
      .filter(Boolean)
    : [];

  if (contentMessages.length) {
    return contentMessages.join('\n');
  }

  const structured = result.structuredContent;
  if (structured && typeof structured === 'object') {
    for (const key of ['error', 'message', 'detail', 'reason']) {
      if (typeof structured[key] === 'string' && structured[key].trim()) {
        return structured[key].trim();
      }
    }
  }

  return 'External MCP tool returned isError=true.';
}

function buildExternalMcpToolCallResponse({
  url,
  sessionId,
  toolName,
  toolArguments,
  result,
  raw,
  initialize
}) {
  const toolFailed = !!(result && typeof result === 'object' && result.isError === true);

  return {
    ok: !toolFailed,
    ...(toolFailed ? {
      toolError: true,
      error: getExternalMcpToolErrorMessage(result)
    } : {}),
    url,
    sessionId,
    toolName,
    arguments: toolArguments,
    result,
    raw,
    initialize
  };
}

async function callExternalMcpTool(serviceUrl, toolName, toolArguments = {}, options = {}) {
  const urlText = String(serviceUrl || '').trim();
  const safeToolName = String(toolName || '').trim();

  if (!urlText) {
    throw new Error('External MCP service URL is required.');
  }

  if (!safeToolName) {
    throw new Error('External MCP toolName is required.');
  }

  const url = new URL(urlText);

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('External MCP service URL must start with http:// or https://');
  }

  if (isInternalHotlistMcpUrl(urlText)) {
    const initialize = await callInternalHotlistMcp('initialize', {
      protocolVersion: options.protocolVersion || '2024-11-05',
      capabilities: {},
      clientInfo: {
        name: '2222EPhone internal HotList caller',
        version: '0.1.0'
      }
    });
    const call = await callInternalHotlistMcp('tools/call', {
      name: safeToolName,
      arguments: toolArguments && typeof toolArguments === 'object'
        ? toolArguments
        : {}
    });

    return buildExternalMcpToolCallResponse({
      url: urlText,
      sessionId: 'ephone-hotlist-session',
      toolName: safeToolName,
      toolArguments,
      result: call.result,
      raw: call,
      initialize
    });
  }

  const baseHeaders = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream'
  };

  if (options.authorization) {
    baseHeaders.Authorization = String(options.authorization);
  }

  if (options.headers && typeof options.headers === 'object' && !Array.isArray(options.headers)) {
    for (const [key, value] of Object.entries(options.headers)) {
      const headerName = String(key || '').trim();
      if (!headerName) continue;
      if (typeof value === 'undefined' || value === null) continue;
      baseHeaders[headerName] = String(value);
    }
  }

  const timeoutMs = Number(options.timeoutMs || 30000);

  async function postMcp(payload, extraHeaders = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(urlText, {
        method: 'POST',
        headers: {
          ...baseHeaders,
          ...extraHeaders
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });

      const text = await response.text();

      let data = null;
      try {
        data = parseExternalMcpResponseJson(text);
      } catch {
        data = null;
      }

      return {
        response,
        text,
        data,
        sessionId:
          response.headers.get('mcp-session-id') ||
          response.headers.get('Mcp-Session-Id') ||
          response.headers.get('MCP-Session-Id') ||
          ''
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  async function initializeSession() {
    const init = await postMcp({
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'initialize',
      params: {
        protocolVersion: options.protocolVersion || '2024-11-05',
        capabilities: {},
        clientInfo: {
          name: '2222EPhone external MCP tool caller',
          version: '0.1.0'
        }
      }
    });

    if (!init.response.ok) {
      throw new Error('initialize HTTP ' + init.response.status + ': ' + init.text.slice(0, 500));
    }

    if (!init.data) {
      throw new Error('initialize response is not JSON: ' + init.text.slice(0, 500));
    }

    if (init.data.error) {
      throw new Error('initialize error: ' + JSON.stringify(init.data.error));
    }

    const sessionId = init.sessionId;

    if (sessionId) {
      try {
        await postMcp({
          jsonrpc: '2.0',
          method: 'notifications/initialized'
        }, {
          'mcp-session-id': sessionId
        });
      } catch (error) {
        console.warn('[external-mcp] notifications/initialized skipped:', error.message || String(error));
      }
    }

    return {
      sessionId,
      initialize: init.data
    };
  }

  const session = await initializeSession();

  const call = await postMcp({
    jsonrpc: '2.0',
    id: Date.now(),
    method: 'tools/call',
    params: {
      name: safeToolName,
      arguments: toolArguments && typeof toolArguments === 'object'
        ? toolArguments
        : {}
    }
  }, session.sessionId ? {
    'mcp-session-id': session.sessionId
  } : {});

  if (!call.response.ok) {
    throw new Error('tools/call HTTP ' + call.response.status + ': ' + call.text.slice(0, 1000));
  }

  if (!call.data) {
    throw new Error('tools/call response is not JSON: ' + call.text.slice(0, 1000));
  }

  if (call.data.error) {
    throw new Error('tools/call error: ' + JSON.stringify(call.data.error));
  }

  return buildExternalMcpToolCallResponse({
    url: urlText,
    sessionId: session.sessionId,
    toolName: safeToolName,
    toolArguments,
    result: call.data.result,
    raw: call.data,
    initialize: session.initialize
  });
}

async function callExternalMcpToolsList(serviceUrl, options = {}) {
  const urlText = String(serviceUrl || '').trim();

  if (!urlText) {
    throw new Error('External MCP service URL is required.');
  }

  const url = new URL(urlText);

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('External MCP service URL must start with http:// or https://');
  }

  if (isInternalHotlistMcpUrl(urlText)) {
    const listed = await callInternalHotlistMcp('tools/list');
    const tools = Array.isArray(listed?.result?.tools) ? listed.result.tools : [];

    return {
      ok: true,
      url: urlText,
      sessionId: '',
      count: tools.length,
      tools,
      raw: listed,
      initialized: false
    };
  }

  const baseHeaders = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream'
  };

  if (options.authorization) {
    baseHeaders.Authorization = String(options.authorization);
  }

  if (options.headers && typeof options.headers === 'object' && !Array.isArray(options.headers)) {
    for (const [key, value] of Object.entries(options.headers)) {
      const headerName = String(key || '').trim();
      if (!headerName) continue;
      if (typeof value === 'undefined' || value === null) continue;
      baseHeaders[headerName] = String(value);
    }
  }

  const timeoutMs = Number(options.timeoutMs || 15000);

  async function postMcp(payload, extraHeaders = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(urlText, {
        method: 'POST',
        headers: {
          ...baseHeaders,
          ...extraHeaders
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });

      const text = await response.text();

      let data = null;
      try {
        data = parseExternalMcpResponseJson(text);
      } catch {
        data = null;
      }

      return {
        response,
        text,
        data,
        sessionId:
          response.headers.get('mcp-session-id') ||
          response.headers.get('Mcp-Session-Id') ||
          response.headers.get('MCP-Session-Id') ||
          ''
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  async function initializeSession() {
    const init = await postMcp({
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'initialize',
      params: {
        protocolVersion: options.protocolVersion || '2024-11-05',
        capabilities: {},
        clientInfo: {
          name: '2222EPhone external MCP tester',
          version: '0.1.0'
        }
      }
    });

    if (!init.response.ok) {
      throw new Error('initialize HTTP ' + init.response.status + ': ' + init.text.slice(0, 500));
    }

    if (!init.data) {
      throw new Error('initialize response is not JSON: ' + init.text.slice(0, 500));
    }

    if (init.data.error) {
      throw new Error('initialize error: ' + JSON.stringify(init.data.error));
    }

    const sessionId = init.sessionId;

    if (sessionId) {
      try {
        await postMcp({
          jsonrpc: '2.0',
          method: 'notifications/initialized'
        }, {
          'mcp-session-id': sessionId
        });
      } catch (error) {
        console.warn('[external-mcp] notifications/initialized skipped:', error.message || String(error));
      }
    }

    return {
      sessionId,
      initialize: init.data
    };
  }

  async function toolsList(sessionId = '') {
    const headers = sessionId
      ? { 'mcp-session-id': sessionId }
      : {};

    const result = await postMcp({
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/list'
    }, headers);

    if (!result.response.ok) {
      throw new Error('HTTP ' + result.response.status + ': ' + result.text.slice(0, 500));
    }

    if (!result.data) {
      throw new Error('External MCP response is not JSON: ' + result.text.slice(0, 500));
    }

    if (result.data.error) {
      throw new Error(JSON.stringify(result.data.error));
    }

    const tools = Array.isArray(result.data?.result?.tools)
      ? result.data.result.tools
      : [];

    return {
      ok: true,
      url: urlText,
      sessionId: sessionId || result.sessionId || '',
      count: tools.length,
      tools,
      raw: result.data
    };
  }

  try {
    return await toolsList('');
  } catch (firstError) {
    const message = firstError.message || String(firstError);

    if (
      !message.includes('mcp-session-id') &&
      !message.includes('session ID') &&
      !message.includes('valid session') &&
      !message.includes('SESSION_EXPIRED') &&
      !message.includes('连接已过期') &&
      !message.includes('initialize')
    ) {
      throw firstError;
    }

    const session = await initializeSession();
    const listed = await toolsList(session.sessionId);

    return {
      ...listed,
      initialized: true,
      initialize: session.initialize
    };
  }
}

function getPath(req) {
  try {
    return new URL(req.url, `http://${req.headers.host}`).pathname;
  } catch {
    return req.url;
  }
}

async function backupSqliteDb() {
  try {
    if (!fs.existsSync(BACKUP_DIR)) {
      fs.mkdirSync(BACKUP_DIR, { recursive: true });
    }

    const timestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, '-');

    const backupFile = path.join(BACKUP_DIR, `memory-${timestamp}.db`);
    const latestBackupFile = LATEST_BACKUP_FILE;

    await db.backup(backupFile);
    await db.backup(latestBackupFile);

    // 只保留最近 3 个历史备份，防止 backups 文件夹无限变大
    const keepCount = 3;
    const backupFiles = fs.readdirSync(BACKUP_DIR)
      .filter(name => /^memory-.*\.db$/.test(name))
      .sort();

    const filesToDelete = backupFiles.slice(0, Math.max(0, backupFiles.length - keepCount));

    for (const file of filesToDelete) {
      try {
        fs.unlinkSync(path.join(BACKUP_DIR, file));
      } catch (deleteError) {
        console.warn('[memory-server] 删除旧备份失败:', file, deleteError.message);
      }
    }

    console.log('[memory-server] 已备份 memory.db:', backupFile);

    return {
      ok: true,
      backupFile,
      latestBackupFile,
      timestamp,
      keptBackups: Math.min(backupFiles.length, keepCount)
    };
  } catch (error) {
    console.warn('[memory-server] 备份 memory.db 失败:', error.message);

    return {
      ok: false,
      error: error.message
    };
  }
}

function mcpResult(id, result) {
  return {
    jsonrpc: '2.0',
    id: id ?? null,
    result
  };
}


const HOTLIST_DEFAULT_BASE_URL = 'https://ephone-hotlist-api.hetianwang1997.workers.dev';

const HOTLIST_PLATFORM_ALIASES = {
  weibo: 'weibo',
  '微博': 'weibo',
  zhihu: 'zhihu',
  '知乎': 'zhihu',
  baidu: 'baidu',
  '百度': 'baidu',
  bilibili: 'bilibili',
  'b站': 'bilibili',
  '哔哩哔哩': 'bilibili',
  douyin: 'douyin',
  '抖音': 'douyin',
  toutiao: 'toutiao',
  '头条': 'toutiao',
  '今日头条': 'toutiao',
  tieba: 'tieba',
  '贴吧': 'tieba',
  hupu: 'hupu',
  '虎扑': 'hupu',
  douban: 'douban-group',
  '豆瓣': 'douban-group',
  '豆瓣小组': 'douban-group',
  ithome: 'ithome',
  'it之家': 'ithome',
  'IT之家': 'ithome',
  '36kr': '36kr',
  '36氪': '36kr',
  juejin: 'juejin',
  '掘金': 'juejin',
  csdn: 'csdn',
  github: 'hellogithub',
  hellogithub: 'hellogithub',
  v2ex: 'v2ex'
};

const HOTLIST_PLATFORM_LABELS = {
  weibo: '微博热搜',
  zhihu: '知乎热榜',
  baidu: '百度热搜',
  bilibili: 'B站热榜',
  douyin: '抖音热点',
  toutiao: '今日头条热榜',
  tieba: '贴吧热议',
  hupu: '虎扑步行街',
  'douban-group': '豆瓣小组精选',
  ithome: 'IT之家热榜',
  '36kr': '36氪热榜',
  juejin: '掘金热榜',
  csdn: 'CSDN排行',
  hellogithub: 'HelloGitHub Trending',
  v2ex: 'V2EX主题榜'
};

function normalizeHotlistPlatform(platform) {
  const raw = String(platform || 'weibo').trim();
  if (!raw) return 'weibo';

  const lower = raw.toLowerCase();
  return HOTLIST_PLATFORM_ALIASES[raw] || HOTLIST_PLATFORM_ALIASES[lower] || lower;
}

function normalizeHotlistLimit(limit) {
  const n = Number(limit || 10);
  if (!Number.isFinite(n)) return 10;
  return Math.max(1, Math.min(50, Math.floor(n)));
}

function normalizeHotlistItem(item, index) {
  const source = item && typeof item === 'object' ? item : {};

  return {
    rank: Number(source.rank || source.index || source.no || index + 1),
    title: String(source.title || source.name || source.word || source.keyword || '').trim(),
    description: String(source.desc || source.description || source.summary || source.excerpt || '').trim(),
    hot: source.hot || source.heat || source.hotValue || source.views || source.score || '',
    url: source.url || source.link || source.mobileUrl || '',
    mobileUrl: source.mobileUrl || source.mobile_url || '',
    image: source.pic || source.cover || source.image || source.img || '',
    raw: source
  };
}

function extractHotlistItems(payload) {
  if (!payload) return [];

  if (Array.isArray(payload)) return payload;

  if (Array.isArray(payload.data)) return payload.data;
  if (Array.isArray(payload.list)) return payload.list;
  if (Array.isArray(payload.items)) return payload.items;
  if (Array.isArray(payload.result)) return payload.result;

  if (payload.data && Array.isArray(payload.data.list)) return payload.data.list;
  if (payload.data && Array.isArray(payload.data.items)) return payload.data.items;
  if (payload.result && Array.isArray(payload.result.list)) return payload.result.list;
  if (payload.result && Array.isArray(payload.result.items)) return payload.result.items;

  return [];
}


async function fetchBilibiliDirectHotlist(limit = 10) {
  const safeLimit = normalizeHotlistLimit(limit);
  const url = 'https://api.bilibili.com/x/web-interface/popular?ps=' + encodeURIComponent(safeLimit) + '&pn=1';

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Accept': 'application/json,text/plain,*/*',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
      'Referer': 'https://www.bilibili.com/'
    }
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error('Bilibili API HTTP ' + response.status + ': ' + text.slice(0, 300));
  }

  let payload;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    throw new Error('Bilibili API did not return JSON: ' + text.slice(0, 300));
  }

  if (!payload || payload.code !== 0) {
    throw new Error('Bilibili API error: ' + (payload && payload.message ? payload.message : text.slice(0, 300)));
  }

  const list = payload && payload.data && Array.isArray(payload.data.list)
    ? payload.data.list
    : [];

  const items = list.slice(0, safeLimit).map((item, index) => ({
    rank: index + 1,
    title: String(item.title || '').trim(),
    description: String(item.desc || item.tname || '').trim(),
    hot: item.stat && item.stat.view ? String(item.stat.view) : '',
    url: item.bvid ? 'https://www.bilibili.com/video/' + item.bvid : '',
    mobileUrl: item.bvid ? 'https://www.bilibili.com/video/' + item.bvid : '',
    image: item.pic || '',
    raw: item
  })).filter(item => item.title);

  return {
    platform: 'bilibili',
    platformName: HOTLIST_PLATFORM_LABELS.bilibili || 'B站热榜',
    source: url,
    fetchedAt: new Date().toISOString(),
    count: items.length,
    items
  };
}


async function fetchHotlistPlatform(platform, limit = 10, options = {}) {
  const normalizedPlatform = normalizeHotlistPlatform(platform);
  const safeLimit = normalizeHotlistLimit(limit);

  if (normalizedPlatform === 'bilibili') {
    return await fetchBilibiliDirectHotlist(safeLimit);
  }

  const baseUrl = String(options.baseUrl || HOTLIST_DEFAULT_BASE_URL).replace(/\/+$/, '');
  const url = baseUrl + '/' + encodeURIComponent(normalizedPlatform);

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Accept': 'application/json,text/plain,*/*',
      'User-Agent': 'EPhone-HotList-MCP/1.0'
    }
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error('HotList API HTTP ' + response.status + ': ' + text.slice(0, 300));
  }

  let payload;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    throw new Error('HotList API did not return JSON: ' + text.slice(0, 300));
  }

  const items = extractHotlistItems(payload)
    .map((item, index) => normalizeHotlistItem(item, index))
    .filter(item => item.title)
    .slice(0, safeLimit);

  return {
    platform: normalizedPlatform,
    platformName: HOTLIST_PLATFORM_LABELS[normalizedPlatform] || normalizedPlatform,
    source: url,
    fetchedAt: new Date().toISOString(),
    count: items.length,
    items
  };
}

function parseHotlistPlatforms(value) {
  if (Array.isArray(value)) {
    return value.map(normalizeHotlistPlatform).filter(Boolean);
  }

  const raw = String(value || '').trim();
  if (!raw) return ['weibo', 'baidu', 'bilibili'];

  return raw
    .split(/[，,;；\n\r]+/)
    .map(item => normalizeHotlistPlatform(item))
    .filter(Boolean);
}

function formatHotlistDigest(results) {
  const lines = [
    '# 今日热榜摘要',
    ''
  ];

  for (const result of results) {
    if (result.error) {
      lines.push('## ' + (result.platformName || result.platform || 'unknown'));
      lines.push('- 获取失败：' + result.error);
      lines.push('');
      continue;
    }

    lines.push('## ' + result.platformName);
    for (const item of (result.items || []).slice(0, 8)) {
      const hotText = item.hot ? ' · 热度：' + item.hot : '';
      const descText = item.description ? ' — ' + item.description : '';
      const urlText = item.url ? ' ｜ ' + item.url : '';
      lines.push('- ' + item.rank + '. ' + item.title + hotText + descText + urlText);
    }
    lines.push('');
  }

  return lines.join('\n').trim();
}

const HOTLIST_MCP_TOOLS = [
  {
    name: 'hotlist_get',
    description: '读取一个平台的今日热榜/热搜。只读工具。当前稳定支持微博、百度、B站。知乎和抖音暂未启用。',
    inputSchema: {
      type: 'object',
      properties: {
        platform: {
          type: 'string',
          description: '平台名称或别名。当前稳定支持 weibo/微博, baidu/百度, bilibili/B站。不要默认使用 zhihu/知乎 或 douyin/抖音。',
          default: 'weibo'
        },
        limit: {
          type: 'number',
          description: '返回条数，1-50。',
          default: 10
        }
      },
      required: []
    }
  },
  {
    name: 'hotlist_all',
    description: '一次读取多个平台的今日热榜/热搜。只读工具。',
    inputSchema: {
      type: 'object',
      properties: {
        platforms: {
          type: 'array',
          items: { type: 'string' },
          description: '平台数组，例如 ["weibo","baidu","bilibili"]。不填则使用默认生活化平台组合。'
        },
        limit: {
          type: 'number',
          description: '每个平台返回条数，1-50。',
          default: 10
        }
      },
      required: []
    }
  },
  {
    name: 'hotlist_digest',
    description: '把多个平台热榜整理成适合聊天使用的“今天大家在聊什么”摘要。只读工具。默认只汇总当前稳定平台：微博、百度、B站；不要主动提及未启用的平台。',
    inputSchema: {
      type: 'object',
      properties: {
        platforms: {
          type: 'array',
          items: { type: 'string' },
          description: '平台数组，例如 ["weibo","baidu","bilibili"]。'
        },
        limit: {
          type: 'number',
          description: '每个平台读取条数，1-50。',
          default: 8
        }
      },
      required: []
    }
  }
];

async function callHotlistMcpTool(name, args = {}) {
  const toolName = String(name || '').trim();
  const input = args && typeof args === 'object' ? args : {};

  if (toolName === 'hotlist_get') {
    return await fetchHotlistPlatform(input.platform || 'weibo', input.limit || 10);
  }

  if (toolName === 'hotlist_all' || toolName === 'hotlist_digest') {
    const platforms = parseHotlistPlatforms(input.platforms);
    const limit = normalizeHotlistLimit(input.limit || (toolName === 'hotlist_digest' ? 8 : 10));

    const results = [];

    for (const platform of platforms.slice(0, 8)) {
      try {
        results.push(await fetchHotlistPlatform(platform, limit));
      } catch (error) {
        results.push({
          platform,
          platformName: HOTLIST_PLATFORM_LABELS[platform] || platform,
          error: error.message || String(error),
          fetchedAt: new Date().toISOString(),
          items: []
        });
      }
    }

    if (toolName === 'hotlist_digest') {
      return {
        fetchedAt: new Date().toISOString(),
        platforms,
        digest: formatHotlistDigest(results),
        results
      };
    }

    return {
      fetchedAt: new Date().toISOString(),
      platforms,
      results
    };
  }

  throw new Error('Unknown HotList tool: ' + toolName);
}

async function handleHotlistMcpRequest(body) {
  const request = body && typeof body === 'object' ? body : {};
  const id = Object.prototype.hasOwnProperty.call(request, 'id') ? request.id : null;
  const method = request.method;

  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: {
          tools: {}
        },
        serverInfo: {
          name: 'ephone-hotlist',
          version: '1.0.0'
        }
      }
    };
  }

  if (method === 'notifications/initialized') {
    return {
      jsonrpc: '2.0',
      id,
      result: {}
    };
  }

  if (method === 'tools/list') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        tools: HOTLIST_MCP_TOOLS
      }
    };
  }

  if (method === 'tools/call') {
    const params = request.params || {};
    const name = params.name || params.toolName || '';
    const args = params.arguments || params.args || {};

    try {
      const result = await callHotlistMcpTool(name, args);
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2)
            }
          ],
          structuredContent: result
        }
      };
    } catch (error) {
      return mcpError(id, -32000, error.message || String(error));
    }
  }

  return mcpError(id, -32601, 'Method not found: ' + method);
}


function mcpError(id, code, message, data = undefined) {
  return {
    jsonrpc: '2.0',
    id: id ?? null,
    error: {
      code,
      message,
      ...(data !== undefined ? { data } : {})
    }
  };
}

function formatMemoryTime(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n <= 0) return '';

  const d = new Date(n);
  if (Number.isNaN(d.getTime())) return '';

  return d.toLocaleString('zh-CN', { hour12: false });
}

function memoryToMcpText(memory, index = 0) {
  if (!memory) return '';

  const content = String(memory.content || '').trim();
  if (!content) return '';

  const tags = Array.isArray(memory.tags) && memory.tags.length > 0
    ? ` 标签：${memory.tags.join('、')}`
    : '';

  const timeText = formatMemoryTime(memory.memoryTime || memory.createdAt);
  const time = timeText ? ` 时间：${timeText}` : '';

  return `${index + 1}. ${content}${tags}${time}`;
}

function memoriesToMcpText(memories) {
  if (!Array.isArray(memories) || memories.length === 0) {
    return '没有找到相关长期记忆。';
  }

  return [
    '以下是可供角色参考的长期记忆。请不要直接向用户暴露工具调用、数据库字段、ID、category、importance、score 或原始列表；只需把相关内容自然融入回复。',
    '',
    memories.map((memory, index) => memoryToMcpText(memory, index)).join('\n')
  ].join('\n');
}

function sanitizeMemoryForMcp(memory) {
  if (!memory) return memory;

  const embedding = safeParseEmbedding(memory.embedding);

  return {
    ...memory,
    embedding: embedding ? `[hidden:${embedding.length}d]` : null,
    _hasEmbedding: Boolean(embedding),
    _embeddingDim: embedding ? embedding.length : 0
  };
}

function mcpToolSchema() {
  return [
    {
      name: 'search_memory',
      description: 'Privately recall relevant long-term memories from the local SQLite memory database. Use this when the user refers to past events, previous preferences, promises, relationship history, settings, or asks whether something is remembered. Do not reveal tool calls, database IDs, categories, scores, or raw metadata to the user; integrate the recalled memory naturally into the roleplay response.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search query. Can be a keyword or natural-language question.'
          },
          chatId: {
            type: 'string',
            description: 'Optional chatId to restrict search to one role/chat.'
          },
          category: {
            type: 'string',
            description: 'Optional category code: U/A/R/E/I/L/P/T/M/C.'
          },
          limit: {
            type: 'number',
            description: 'Maximum number of memories to return. Default 10.'
          },
          candidateLimit: {
            type: 'number',
            description: 'Maximum candidate memories before ranking. Default 1000.'
          },
          embeddingEndpoint: {
            type: 'string',
            description: 'Optional embedding endpoint for semantic search.'
          },
          embeddingApiKey: {
            type: 'string',
            description: 'Optional embedding API key for semantic search.'
          },
          embeddingModel: {
            type: 'string',
            description: 'Optional embedding model name.'
          }
        },
        required: ['query']
      }
    },
    {
      name: 'add_memory',
      description: 'Add a new long-term memory to the local SQLite memory database.',
      inputSchema: {
        type: 'object',
        properties: {
          content: {
            type: 'string',
            description: 'Memory content.'
          },
          chatId: {
            type: 'string',
            description: 'Optional chatId for the memory.'
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional tags.'
          },
          category: {
            type: 'string',
            description: 'Category code: U/A/R/E/I/L/P/T/M/C. Default E.'
          },
          importance: {
            type: 'number',
            description: 'Importance from 1 to 10. Default 5.'
          },
          emotionalWeight: {
            type: 'number',
            description: 'Emotional weight from 1 to 10. Default 3.'
          },
          source: {
            type: 'string',
            description: 'Source label. Default mcp.'
          },
          context: {
            type: 'string',
            description: 'Optional context.'
          },
          memoryTime: {
            type: 'number',
            description: 'Optional memory event time as Unix milliseconds.'
          }
        },
        required: ['content']
      }
    },
    {
      name: 'list_memory',
      description: 'List long-term memories from the local SQLite memory database with optional filters.',
      inputSchema: {
        type: 'object',
        properties: {
          chatId: { type: 'string' },
          category: { type: 'string' },
          query: { type: 'string' },
          limit: {
            type: 'number',
            description: 'Maximum number of memories to return. Default 20.'
          },
          minImportance: { type: 'number' },
          maxImportance: { type: 'number' }
        }
      }
    },
    {
      name: 'get_memory',
      description: 'Get one memory by id.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' }
        },
        required: ['id']
      }
    },
   {
      name: 'ingest_raw',
      description: 'Receive raw dialogue text from an external chat app for later memory extraction. This first version only validates and reports received content; it does not write memories yet.',
      inputSchema: {
        type: 'object',
        properties: {
          rawText: {
            type: 'string',
            description: 'Raw dialogue text to ingest.'
          },
          messages: {
            type: 'array',
            description: 'Optional message array if the client sends structured chat messages.',
            items: {
              type: 'object',
              properties: {
                role: { type: 'string' },
                content: { type: 'string' },
                time: { type: 'string' }
              }
            }
          },
          chatId: {
            type: 'string',
            description: 'Optional chatId or role/session identifier.'
          },
          scene: {
            type: 'string',
            description: 'Optional scene label, such as private chat, group chat, outing, forum, etc.'
          },
          timeRange: {
            type: 'string',
            description: 'Optional time range for the raw dialogue.'
          },
          source: {
            type: 'string',
            description: 'Source label. Default njj.'
          },
        dryRun: {
          type: 'boolean',
          description: 'If true, only preview extraction and do not write memories. Default false.'
        },
        limit: {
          type: 'number',
          description: 'Maximum number of extracted memories to save. Default 8.'
        },
        llmEndpoint: {
          type: 'string',
          description: 'Optional chat completion endpoint for extraction.'
        },
        llmApiKey: {
          type: 'string',
          description: 'Optional chat completion API key for extraction.'
        },
        llmModel: {
          type: 'string',
          description: 'Optional chat completion model name.'
        }
        }
      }
    },
    {
      name: 'ingest_summary',
      description: 'Receive scene-level summarized memory text such as [时间]/[概括]/[场景]/[记忆], then convert it into structured long-term vector memories.',
      inputSchema: {
        type: 'object',
        properties: {
          summaryText: {
            type: 'string',
            description: 'Scene-level summarized memory text to ingest.'
          },
          text: {
            type: 'string',
            description: 'Alias of summaryText.'
          },
          content: {
            type: 'string',
            description: 'Alias of summaryText.'
          },
          chatId: {
            type: 'string',
            description: 'Optional chatId or role/session identifier.'
          },
          source: {
            type: 'string',
            description: 'Source label. Default njj_summary.'
          },
          dryRun: {
            type: 'boolean',
            description: 'If true, only preview extraction and do not write memories. Default false.'
          },
          limit: {
            type: 'number',
            description: 'Maximum number of extracted memories to save. Default 12.'
          },
          roleName: {
            type: 'string',
            description: 'Current role name.'
          },
          userName: {
            type: 'string',
            description: 'User nickname/name.'
          },
          llmEndpoint: {
            type: 'string',
            description: 'Optional chat completion endpoint for extraction.'
          },
          llmApiKey: {
            type: 'string',
            description: 'Optional chat completion API key for extraction.'
          },
          llmModel: {
            type: 'string',
            description: 'Optional chat completion model name.'
          }
        }
      }
    }
  ];
}

async function handleMcpRequest(body) {
  const id = body?.id ?? null;
  const method = body?.method;

  if (method === 'initialize') {
    return mcpResult(id, {
      protocolVersion: body?.params?.protocolVersion || '2024-11-05',
      capabilities: {
        tools: {}
      },
      serverInfo: {
        name: 'aion-sqlite-memory-server',
        version: '0.1.0'
      }
    });
  }

  if (method === 'notifications/initialized') {
    return mcpResult(id, {});
  }

  if (method === 'tools/list') {
    return mcpResult(id, {
      tools: mcpToolSchema()
    });
  }

  if (method === 'tools/call') {
    const name = body?.params?.name;
    const args = body?.params?.arguments || {};

    try {
      if (name === 'search_memory') {
        const memories = listMemories({
          chatId: args.chatId || '',
          category: args.category || '',
          minImportance: args.minImportance || '',
          maxImportance: args.maxImportance || '',
          limit: Math.min(10000, Math.max(1000, Number(args.candidateLimit || process.env.MEMORY_SEARCH_CANDIDATE_LIMIT || 6000) || 6000))
        });

        const embeddingConfig = {
          endpoint: args.embeddingEndpoint || process.env.EMBEDDING_ENDPOINT || '',
          apiKey: args.embeddingApiKey || process.env.EMBEDDING_API_KEY || '',
          model: args.embeddingModel || process.env.EMBEDDING_MODEL || 'BAAI/bge-m3'
        };

        const debugQueries = buildMemorySearchQueries(args.query || '', args.queryVariants || args.cleanedQueries || args.queries || []);

        const safeMcpLimit = clampNumber(args.limit || 10, 1, 200, 10);
        const shadowCandidateLimit = clampNumber(
          args.shadowCandidateLimit || process.env.MEMORY_SHADOW_CANDIDATE_LIMIT || Math.max(safeMcpLimit * 5, 60),
          safeMcpLimit,
          200,
          Math.max(safeMcpLimit * 5, 60)
        );
        const rankedCandidates = await simpleSearch(memories, args.query || '', shadowCandidateLimit, {
          embedding: embeddingConfig,
          queryVariants: debugQueries.slice(1),
          participantNames: args.participantNames || [],
          scoreWeights: args.scoreWeights || args.weights || {}
        });
        const results = rankedCandidates.slice(0, safeMcpLimit);
        const shadowPolicy = runRecallShadowPolicy(withReliableEventClusterMetadata(rankedCandidates), {
          targetLimit: safeMcpLimit,
          candidateLimit: shadowCandidateLimit,
          query: args.query || '',
          primaryQuery: args.shadowPrimaryQuery || args.query || '',
          contextQueries: args.shadowContextQueries || debugQueries.slice(1)
        });

        const mcpSearchMode = embeddingConfig.endpoint && embeddingConfig.apiKey ? 'semantic-hybrid' : 'keyword-fallback';

        let searchTraceId = null;
        if (!args.diagnostic) {
          searchTraceId = updateLastMemorySearchState({
            source: 'mcp:search_memory',
            query: args.query || '',
            queryVariants: debugQueries.slice(1),
            chatId: args.chatId || '',
            searchMode: mcpSearchMode,
            requestedSearchEngine: 'mcp-simpleSearch',
            limit: safeMcpLimit,
            candidateLimit: memories.length,
            resultCount: results.length,
            chroma: {
              attempted: false,
              fallback: false
            },
            shadowPolicy,
            results
          });
        }

        const text = memoriesToMcpText(results);

        return mcpResult(id, {
          content: [
            {
              type: 'text',
              text
            }
          ],
          structuredContent: {
            ok: true,
            query: args.query || '',
            debugQueries,
            cleanedQueries: debugQueries.slice(1),
            count: results.length,
            searchTraceId,
            shadowPolicy: compactShadowPolicySummary(shadowPolicy),
            memories: results
          }
        });
      }

      if (name === 'add_memory') {
        const content = String(args.content || '').trim();

        if (!content) {
          return mcpError(id, -32602, 'content is required');
        }

        const embeddingConfig = {
          endpoint: args.embeddingEndpoint || process.env.EMBEDDING_ENDPOINT || '',
          apiKey: args.embeddingApiKey || process.env.EMBEDDING_API_KEY || '',
          model: args.embeddingModel || process.env.EMBEDDING_MODEL || 'BAAI/bge-m3'
        };

        let generatedEmbedding = null;

        if (embeddingConfig.endpoint && embeddingConfig.apiKey) {
          try {
            generatedEmbedding = await createQueryEmbedding({
              endpoint: embeddingConfig.endpoint,
              apiKey: embeddingConfig.apiKey,
              model: embeddingConfig.model,
              input: content
            });
          } catch (error) {
            console.warn('[mcp] add_memory embedding failed, save as BM25:', error.message);
          }
        }

        await backupSqliteDb();

        const memory = normalizeMemoryFragment({
          ...args,
          content,
          source: args.source || 'mcp',
          embedding: generatedEmbedding,
          embeddingModel: generatedEmbedding ? embeddingConfig.model : '',
          embeddingDim: generatedEmbedding ? generatedEmbedding.length : 0,
          embeddingUpdatedAt: generatedEmbedding ? String(now()) : '',
          createdAt: args.createdAt || now(),
          updatedAt: now()
        });

        const savedMemory = addMemory({
          ...memory,
          updatedAt: now()
        });

        await tryUpsertMemoryToChroma(savedMemory);

        return mcpResult(id, {
          content: [
            {
              type: 'text',
              text: `Memory added.\n\n${memoryToMcpText(savedMemory)}`
            }
          ],
          structuredContent: {
            ok: true,
            memory: savedMemory
          }
        });
      }

      if (name === 'list_memory') {
        const memories = listMemories({
          chatId: args.chatId || '',
          category: args.category || '',
          minImportance: args.minImportance || '',
          maxImportance: args.maxImportance || '',
          query: args.query || '',
          limit: args.limit || 20
        });

        const text = memoriesToMcpText(memories);

        return mcpResult(id, {
          content: [
            {
              type: 'text',
              text
            }
          ],
          structuredContent: {
            ok: true,
            count: memories.length,
            memories: memories.map(sanitizeMemoryForMcp)
          }
        });
      }

      if (name === 'get_memory') {
        const idArg = String(args.id || '').trim();

        if (!idArg) {
          return mcpError(id, -32602, 'id is required');
        }

        const memory = getMemoryById(idArg);

        if (!memory) {
          return mcpError(id, -32004, 'Memory not found');
        }

        return mcpResult(id, {
          content: [
            {
              type: 'text',
              text: memoriesToMcpText([memory])
            }
          ],
          structuredContent: {
            ok: true,
            memory: sanitizeMemoryForMcp(memory)
          }
        });
      }

      if (name === 'ingest_summary') {
        const summaryText = String(args.summaryText || args.text || args.content || '').trim();

        if (!summaryText) {
          return mcpError(id, -32602, 'summaryText is required');
        }

        const charCount = summaryText.length;
        const blockCount = (summaryText.match(/\[记忆\d*\]/g) || []).length || summaryText.split(/\n\n+/).filter(Boolean).length;
        const dryRun = args.dryRun === true || String(args.dryRun || '').toLowerCase() === 'true';
        const limit = clampNumber(args.limit, 1, 50, 12);

        const llmConfig = {
          endpoint: args.llmEndpoint || process.env.LLM_ENDPOINT || process.env.EMBEDDING_ENDPOINT || '',
          apiKey: args.llmApiKey || process.env.LLM_API_KEY || process.env.EMBEDDING_API_KEY || '',
          model: args.llmModel || process.env.LLM_MODEL || 'Qwen/Qwen3-8B'
        };

        if (!llmConfig.endpoint || !llmConfig.apiKey) {
          return mcpError(id, -32001, 'LLM endpoint/apiKey is required for ingest_summary extraction. Set LLM_ENDPOINT and LLM_API_KEY, or pass llmEndpoint/llmApiKey.');
        }

        let extractedItems = [];
        const roleName = args.roleName || args.actor || args._actor || '角色';
        const userName = args.userName || args.userNickname || '她';
        const participantNames = [...new Set([
          roleName,
          userName,
          ...(Array.isArray(args.participantNames) ? args.participantNames : [])
        ].filter(Boolean))];

        try {
          const prompt = buildSummaryIngestPrompt({
            summaryText,
            source: args.source || 'njj_summary',
            roleName,
            userName
          });

          const rawExtraction = await createChatCompletion({
            endpoint: llmConfig.endpoint,
            apiKey: llmConfig.apiKey,
            model: llmConfig.model,
            messages: [
              {
                role: 'system',
                content: '你是严格的 JSON 记忆整理器。只输出 JSON 数组。'
              },
              {
                role: 'user',
                content: prompt
              }
            ],
            temperature: 0.2
          });

          extractedItems = parseExtractedMemoryItems(rawExtraction, participantNames).slice(0, limit);

          if (!dryRun && extractedItems.length === 0) {
            console.warn('[mcp] ingest_summary extracted 0 items on write attempt, retry once.');

            const retryExtraction = await createChatCompletion({
              endpoint: llmConfig.endpoint,
              apiKey: llmConfig.apiKey,
              model: llmConfig.model,
              messages: [
                {
                  role: 'system',
                  content: '你是严格的 JSON 记忆整理器。只输出 JSON 数组。'
                },
                {
                  role: 'user',
                  content: prompt + '\n\n注意：上一次没有提取到记忆。请重新判断，除非文本完全没有长期价值，否则至少输出 1 条。'
                }
              ],
              temperature: 0.1
            });

            extractedItems = parseExtractedMemoryItems(retryExtraction, participantNames).slice(0, limit);
          }
        } catch (error) {
          return mcpError(id, -32002, `ingest_summary extraction failed: ${error.message}`);
        }

        if (dryRun) {
          return mcpResult(id, {
            content: [
              {
                type: 'text',
                text: [
                  '已完成总结记忆转换预览，但未写入 SQLite。',
                  `字符数：${charCount}`,
                  `记忆块数：${blockCount}`,
                  `提取条数：${extractedItems.length}`,
                  '',
                  extractedItems.length > 0
                    ? extractedItems.map((item, index) => `${index + 1}. [${item.category}] ${item.content} #${item.tags.join(' #')} 重要度:${item.importance} 情绪:${item.emotionalWeight}`).join('\n')
                    : '没有提取到值得长期保存的记忆。'
                ].join('\n')
              }
            ],
            structuredContent: {
              ok: true,
              dryRun: true,
              source: args.source || 'njj_summary',
              chatId: args.chatId || '',
              charCount,
              blockCount,
              extractedCount: extractedItems.length,
              extractedItems
            }
          });
        }

        await backupSqliteDb();

        const embeddingConfig = {
          endpoint: args.embeddingEndpoint || process.env.EMBEDDING_ENDPOINT || '',
          apiKey: args.embeddingApiKey || process.env.EMBEDDING_API_KEY || '',
          model: args.embeddingModel || process.env.EMBEDDING_MODEL || 'BAAI/bge-m3'
        };

        const savedMemories = [];

        for (const item of extractedItems) {
          let generatedEmbedding = null;

          if (embeddingConfig.endpoint && embeddingConfig.apiKey) {
            try {
              generatedEmbedding = await createQueryEmbedding({
                endpoint: embeddingConfig.endpoint,
                apiKey: embeddingConfig.apiKey,
                model: embeddingConfig.model,
                input: item.content
              });
            } catch (error) {
              console.warn('[mcp] ingest_summary embedding failed, save as BM25:', error.message);
            }
          }

          const memory = normalizeMemoryFragment({
            ...item,
            participantNames,
            chatId: args.chatId || '',
            source: args.source || 'njj_summary',
            context: 'summary_ingest',
            memoryTime: args.memoryTime || now(),
            embedding: generatedEmbedding,
            embeddingModel: generatedEmbedding ? embeddingConfig.model : '',
            embeddingDim: generatedEmbedding ? generatedEmbedding.length : 0,
            embeddingUpdatedAt: generatedEmbedding ? String(now()) : '',
            createdAt: now(),
            updatedAt: now()
          });

          const savedMemory = addMemory({
            ...memory,
            updatedAt: now()
          });

          await tryUpsertMemoryToChroma(savedMemory);

          savedMemories.push(savedMemory);
        }

        return mcpResult(id, {
          content: [
            {
              type: 'text',
              text: [
                '已从总结文本中转换并写入长期记忆。',
                `字符数：${charCount}`,
                `记忆块数：${blockCount}`,
                `写入条数：${savedMemories.length}`,
                '',
                savedMemories.length > 0
                  ? savedMemories.map((item, index) => `${index + 1}. ${item.content}`).join('\n')
                  : '没有写入新的长期记忆。'
              ].join('\n')
            }
          ],
          structuredContent: {
            ok: true,
            dryRun: false,
            source: args.source || 'njj_summary',
            chatId: args.chatId || '',
            charCount,
            blockCount,
            extractedCount: extractedItems.length,
            savedCount: savedMemories.length,
            memories: savedMemories.map(sanitizeMemoryForMcp)
          }
        });
      }

      if (name === 'ingest_raw') {
        const rawText = String(args.rawText || args.text || args.content || '').trim();
        const messages = Array.isArray(args.messages) ? args.messages : [];

        const messageText = messages
          .map((msg, index) => {
            const role = String(msg.role || msg.sender || `message_${index + 1}`).trim();
            const content = String(msg.content || msg.text || '').trim();
            const time = msg.time || msg.timestamp || '';
            return content ? `[${time || 'no-time'}] ${role}: ${content}` : '';
          })
          .filter(Boolean)
          .join('\n');

        const combinedText = rawText || messageText;

        if (!combinedText) {
          return mcpError(id, -32602, 'rawText or messages is required');
        }

        const charCount = combinedText.length;
        const messageCount = messages.length || combinedText.split(/\n+/).filter(Boolean).length;
        const dryRun = args.dryRun === true || String(args.dryRun || '').toLowerCase() === 'true';
        const limit = clampNumber(args.limit, 1, 30, 8);

        const llmConfig = {
          endpoint: args.llmEndpoint || process.env.LLM_ENDPOINT || process.env.EMBEDDING_ENDPOINT || '',
          apiKey: args.llmApiKey || process.env.LLM_API_KEY || process.env.EMBEDDING_API_KEY || '',
          model: args.llmModel || process.env.LLM_MODEL || 'Qwen/Qwen3-8B'
        };

        if (!llmConfig.endpoint || !llmConfig.apiKey) {
          return mcpError(id, -32001, 'LLM endpoint/apiKey is required for ingest_raw extraction. Set LLM_ENDPOINT and LLM_API_KEY, or pass llmEndpoint/llmApiKey.');
        }

        let extractedItems = [];
        const roleName = args.roleName || args.actor || args._actor || '角色';
        const userName = args.userName || args.userNickname || '她';
        const participantNames = [...new Set([
          roleName,
          userName,
          ...(Array.isArray(args.participantNames) ? args.participantNames : [])
        ].filter(Boolean))];

        try {
          const prompt = buildRawIngestPrompt({
            combinedText,
            scene: args.scene || '',
            timeRange: args.timeRange || '',
            source: args.source || 'njj',
            roleName,
            userName
          });

          const rawExtraction = await createChatCompletion({
            endpoint: llmConfig.endpoint,
            apiKey: llmConfig.apiKey,
            model: llmConfig.model,
            messages: [
              {
                role: 'system',
                content: '你是严格的 JSON 记忆提取器。只输出 JSON 数组。'
              },
              {
                role: 'user',
                content: prompt
              }
            ],
            temperature: 0.2
          });

          extractedItems = parseExtractedMemoryItems(rawExtraction, participantNames).slice(0, limit);

        } catch (error) {
          return mcpError(id, -32002, `ingest_raw extraction failed: ${error.message}`);
        }

        if (dryRun) {
          return mcpResult(id, {
            content: [
              {
                type: 'text',
                text: [
                  '已完成原文记忆提取预览，但未写入 SQLite。',
                  `字符数：${charCount}`,
                  `消息/行数：${messageCount}`,
                  `提取条数：${extractedItems.length}`,
                  '',
                  extractedItems.length > 0
                    ? extractedItems.map((item, index) => `${index + 1}. [${item.category}] ${item.content} #${item.tags.join(' #')} 重要度:${item.importance} 情绪:${item.emotionalWeight}`).join('\n')
                    : '没有提取到值得长期保存的记忆。'
                ].join('\n')
              }
            ],
            structuredContent: {
              ok: true,
              dryRun: true,
              source: args.source || 'njj',
              chatId: args.chatId || '',
              scene: args.scene || '',
              timeRange: args.timeRange || '',
              charCount,
              messageCount,
              extractedCount: extractedItems.length,
              extractedItems
            }
          });
        }

        await backupSqliteDb();

        const embeddingConfig = {
          endpoint: args.embeddingEndpoint || process.env.EMBEDDING_ENDPOINT || '',
          apiKey: args.embeddingApiKey || process.env.EMBEDDING_API_KEY || '',
          model: args.embeddingModel || process.env.EMBEDDING_MODEL || 'BAAI/bge-m3'
        };

        const savedMemories = [];

        for (const item of extractedItems) {
          let generatedEmbedding = null;

          if (embeddingConfig.endpoint && embeddingConfig.apiKey) {
            try {
              generatedEmbedding = await createQueryEmbedding({
                endpoint: embeddingConfig.endpoint,
                apiKey: embeddingConfig.apiKey,
                model: embeddingConfig.model,
                input: item.content
              });
            } catch (error) {
              console.warn('[mcp] ingest_raw embedding failed, save as BM25:', error.message);
            }
          }

          const memory = normalizeMemoryFragment({
            ...item,
            participantNames,
            chatId: args.chatId || '',
            source: args.source || 'njj_raw',
            context: [
              args.scene ? `scene=${args.scene}` : '',
              args.timeRange ? `timeRange=${args.timeRange}` : ''
            ].filter(Boolean).join('; '),
            memoryTime: args.memoryTime || now(),
            embedding: generatedEmbedding,
            embeddingModel: generatedEmbedding ? embeddingConfig.model : '',
            embeddingDim: generatedEmbedding ? generatedEmbedding.length : 0,
            embeddingUpdatedAt: generatedEmbedding ? String(now()) : '',
            createdAt: now(),
            updatedAt: now()
          });

          const savedMemory = addMemory({
            ...memory,
            updatedAt: now()
          });

          await tryUpsertMemoryToChroma(savedMemory);

          savedMemories.push(savedMemory);
        }

        return mcpResult(id, {
          content: [
            {
              type: 'text',
              text: [
                '已从原始对话中提取并写入长期记忆。',
                `字符数：${charCount}`,
                `消息/行数：${messageCount}`,
                `写入条数：${savedMemories.length}`,
                '',
                savedMemories.length > 0
                  ? savedMemories.map((item, index) => `${index + 1}. ${item.content}`).join('\n')
                  : '没有写入新的长期记忆。'
              ].join('\n')
            }
          ],
          structuredContent: {
            ok: true,
            dryRun: false,
            source: args.source || 'njj',
            chatId: args.chatId || '',
            scene: args.scene || '',
            timeRange: args.timeRange || '',
            charCount,
            messageCount,
            extractedCount: extractedItems.length,
            savedCount: savedMemories.length,
            memories: savedMemories.map(sanitizeMemoryForMcp)
          }
        });
      }

        return mcpError(id, -32601, `Unknown tool: ${name}`);
      } catch (error) {
        return mcpError(id, -32000, error.message);
      }
    }

  return mcpError(id, -32601, `Method not found: ${method}`);
}

const server = http.createServer(async (req, res) => {
  const pathname = getPath(req);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key'
    });
    res.end();
    return;
  }

  if (!hasValidApiToken(req)) {
    sendJson(res, 401, {
      ok: false,
      error: 'Unauthorized'
    });
    return;
  }


  if (pathname === '/hotlist-mcp' && req.method === 'GET') {
    sendJson(res, 200, {
      ok: true,
      name: 'ephone-hotlist',
      endpoint: '/hotlist-mcp',
      tools: HOTLIST_MCP_TOOLS.map(tool => tool.name)
    });
    return;
  }

  if (pathname === '/hotlist-mcp' && req.method === 'POST') {
    try {
      const body = await readRequestBody(req);

      if (body && body.method === 'initialize') {
        res.setHeader('mcp-session-id', 'ephone-hotlist-session');
      }

      const result = await handleHotlistMcpRequest(body);
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, mcpError(null, -32700, error.message || String(error)));
    }
    return;
  }

  if (pathname === '/mcp' && req.method === 'GET') {
    sendJson(res, 200, {
      ok: true,
      service: 'Aion Memory MCP Endpoint',
      transport: 'http-jsonrpc',
      endpoint: '/mcp',
      methods: ['initialize', 'tools/list', 'tools/call'],
      tools: mcpToolSchema().map(tool => tool.name)
    });
    return;
  }

  if (pathname === '/mcp' && req.method === 'POST') {
    try {
      const body = await readRequestBody(req);
      const result = await handleMcpRequest(body);
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, mcpError(null, -32700, error.message));
    }
    return;
  }

  if (pathname === '/health' && req.method === 'GET') {
    const memories = listMemories();

    sendJson(res, 200, {
      ok: true,
      service: 'Aion Memory Server',
      message: 'Memory server is running.',
      format: '111/2222-compatible-sqlite',
      storage: 'sqlite',
      count: memories.length
    });
    return;
  }

  if (pathname === '/garden-wake/events' && req.method === 'POST') {
    try {
      const body = await readRequestBody(req);
      if (body?.version !== 1 || body?.type !== 'garden_wake') {
        throw new Error('Invalid Garden wake envelope.');
      }

      const event = addGardenWakeEvent({
        reason: body.reason,
        message: body.message
      });

      sendJson(res, 201, {
        ok: true,
        eventId: event.id,
        queuedAt: event.createdAt
      });
    } catch (error) {
      sendJson(res, 400, {
        ok: false,
        error: error.message || String(error)
      });
    }
    return;
  }

  if (pathname === '/garden-wake/claim' && req.method === 'POST') {
    try {
      const body = await readRequestBody(req);
      const event = claimGardenWakeEvent(body.clientId, body.leaseMs);
      sendJson(res, 200, {
        ok: true,
        event: event ? {
          id: event.id,
          reason: event.reason,
          message: event.message,
          createdAt: event.createdAt,
          claimToken: event.claimToken
        } : null
      });
    } catch (error) {
      sendJson(res, 400, {
        ok: false,
        error: error.message || String(error)
      });
    }
    return;
  }

  if (pathname === '/garden-wake/ack' && req.method === 'POST') {
    try {
      const body = await readRequestBody(req);
      const updated = finishGardenWakeEvent(
        body.eventId,
        body.claimToken,
        body.status,
        body.error || ''
      );

      if (!updated) {
        sendJson(res, 409, {
          ok: false,
          error: 'Garden wake event is no longer owned by this claim.'
        });
        return;
      }

      sendJson(res, 200, { ok: true });
    } catch (error) {
      sendJson(res, 400, {
        ok: false,
        error: error.message || String(error)
      });
    }
    return;
  }

  if (pathname === '/garden-wake/status' && req.method === 'GET') {
    sendJson(res, 200, {
      ok: true,
      stats: getGardenWakeStats()
    });
    return;
  }

  if (pathname === '/aisay-wake/events' && req.method === 'POST') {
    try {
      const body = await readRequestBody(req);
      if (body?.version !== 1 || body?.type !== 'aisay_wake') {
        throw new Error('Invalid AISay wake envelope.');
      }

      const queued = addAisayWakeEvent({
        externalEventId: body.event_id,
        category: body.category,
        reason: body.reason || body.category,
        message: body.message,
        payload: body,
        createdAt: body.created_at ? Date.parse(body.created_at) : Date.now()
      });

      sendJson(res, queued.duplicate ? 200 : 201, {
        ok: true,
        eventId: queued.event.id,
        externalEventId: queued.event.externalEventId,
        duplicate: queued.duplicate,
        queuedAt: queued.event.createdAt
      });
    } catch (error) {
      sendJson(res, 400, {
        ok: false,
        error: error.message || String(error)
      });
    }
    return;
  }

  if (pathname === '/aisay-wake/claim' && req.method === 'POST') {
    try {
      const body = await readRequestBody(req);
      const event = claimAisayWakeEvent(body.clientId, body.leaseMs);
      sendJson(res, 200, {
        ok: true,
        event: event ? {
          id: event.id,
          externalEventId: event.externalEventId,
          category: event.category,
          reason: event.reason,
          message: event.message,
          payload: event.payload,
          createdAt: event.createdAt,
          claimToken: event.claimToken
        } : null
      });
    } catch (error) {
      sendJson(res, 400, {
        ok: false,
        error: error.message || String(error)
      });
    }
    return;
  }

  if (pathname === '/aisay-wake/ack' && req.method === 'POST') {
    try {
      const body = await readRequestBody(req);
      const updated = finishAisayWakeEvent(
        body.eventId,
        body.claimToken,
        body.status,
        body.error || ''
      );

      if (!updated) {
        sendJson(res, 409, {
          ok: false,
          error: 'AISay wake event is no longer owned by this client.'
        });
      } else {
        sendJson(res, 200, { ok: true });
      }
    } catch (error) {
      sendJson(res, 400, {
        ok: false,
        error: error.message || String(error)
      });
    }
    return;
  }

  if (pathname === '/aisay-wake/status' && req.method === 'GET') {
    sendJson(res, 200, {
      ok: true,
      stats: getAisayWakeStats()
    });
    return;
  }

  if (pathname === '/memory/list' && req.method === 'GET') {
    const url = new URL(req.url, `http://${req.headers.host}`);

    const filters = {
      chatId: url.searchParams.get('chatId') || '',
      category: url.searchParams.get('category') || '',
      minImportance: url.searchParams.get('minImportance') || '',
      maxImportance: url.searchParams.get('maxImportance') || '',
      query: url.searchParams.get('query') || '',
      limit: url.searchParams.get('limit') || 5000
    };

    const memories = listMemories(filters);

    const publicMemories = memories.map(memory => {
      const hasEmbedding =
        Array.isArray(memory.embedding) && memory.embedding.length > 0;

      const { embedding, ...rest } = memory;

      return {
        ...rest,
        hasEmbedding,
        _hasEmbedding: hasEmbedding,
        _embeddingDim: hasEmbedding ? memory.embedding.length : 0
      };
    });

    sendJson(res, 200, {
      ok: true,
      count: publicMemories.length,
      filters,
      memories: publicMemories
    });
    return;
  }

  if (pathname === '/external-mcp/tools-call' && req.method === 'POST') {
    try {
      const body = await readRequestBody(req);
      const actor = body.actor && typeof body.actor === 'object' ? body.actor : null;
      const result = await callExternalMcpTool(
        body.url || body.serviceUrl || body.mcpUrl || '',
        body.toolName || body.name || '',
        body.arguments || body.args || {},
        {
          authorization: body.authorization || '',
          headers: body.headers || body.extraHeaders || {},
          timeoutMs: body.timeoutMs || 30000
        }
      );

      if (actor && result && typeof result === 'object') {
        result.actor = actor;
      }

      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, {
        ok: false,
        error: error.message || String(error)
      });
    }
    return;
  }

  if (pathname === '/external-mcp/tools-list' && req.method === 'POST') {
    try {
      const body = await readRequestBody(req);
      const result = await callExternalMcpToolsList(body.url || body.serviceUrl || body.mcpUrl || '', {
        authorization: body.authorization || '',
        headers: body.headers || body.extraHeaders || {},
        timeoutMs: body.timeoutMs || 15000
      });

      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, {
        ok: false,
        error: error.message || String(error)
      });
    }
    return;
  }

  if (pathname === '/memory/stats' && req.method === 'GET') {
    const stats = getMemoryStats();

    sendJson(res, 200, {
      ok: true,
      storage: 'sqlite',
      stats,
      fts: getMemoryFtsStatus({ integrityCheck: false })
    });
    return;
  }

  if (pathname === '/memory/chroma/status' && req.method === 'GET') {
    try {
      const status = await getChromaStatus();

      sendJson(res, 200, {
        ok: true,
        chroma: status
      });
    } catch (error) {
      sendJson(res, 500, {
        ok: false,
        error: error.message || String(error)
      });
    }
    return;
  }

  if (pathname === '/memory/fts/status' && req.method === 'GET') {
    try {
      sendJson(res, 200, {
        ok: true,
        fts: getMemoryFtsStatus({ integrityCheck: true })
      });
    } catch (error) {
      sendJson(res, 500, {
        ok: false,
        error: error.message || String(error)
      });
    }
    return;
  }

  if (pathname === '/memory/organization/status' && req.method === 'GET') {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      sendJson(res, 200, {
        ok: true,
        organization: getMemoryOrganizationStatus(url.searchParams.get('chatId') || '')
      });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error.message || String(error) });
    }
    return;
  }

  if (pathname === '/memory/active-events' && req.method === 'GET') {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const events = listMemoryActiveEvents({
        chatId: url.searchParams.get('chatId') || '',
        status: url.searchParams.get('status') || '',
        includeArchived: url.searchParams.get('includeArchived') === 'true',
        limit: url.searchParams.get('limit') || 50
      });
      sendJson(res, 200, { ok: true, count: events.length, events });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error.message || String(error) });
    }
    return;
  }

  if (pathname === '/memory/active-events/upsert' && req.method === 'POST') {
    try {
      const body = await readRequestBody(req);
      if (String(body.confirm || '') !== 'UPSERT_ACTIVE_EVENT') {
        throw new Error('Explicit confirmation is required to save an active event');
      }
      const event = upsertMemoryActiveEvent(body.event || body);
      sendJson(res, 200, { ok: true, event });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error.message || String(error) });
    }
    return;
  }

  if (pathname === '/memory/active-events/archive' && req.method === 'POST') {
    try {
      const body = await readRequestBody(req);
      if (String(body.confirm || '') !== 'ARCHIVE_ACTIVE_EVENT') {
        throw new Error('Explicit confirmation is required to archive an active event');
      }
      const event = archiveMemoryActiveEvent(body.id, body.status || 'archived');
      if (!event) throw new Error('Active event not found');
      sendJson(res, 200, { ok: true, event });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error.message || String(error) });
    }
    return;
  }

  if (pathname === '/memory/organization/clusters' && req.method === 'GET') {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const clusters = listMemoryClusters({
        clusterId: url.searchParams.get('clusterId') || '',
        chatId: url.searchParams.get('chatId') || '',
        kind: url.searchParams.get('kind') || '',
        status: url.searchParams.get('status') || '',
        subtype: url.searchParams.get('subtype') || '',
        limit: url.searchParams.get('limit') || 100,
        memberLimit: url.searchParams.get('memberLimit') || 200,
        includeMembers: url.searchParams.get('includeMembers') !== 'false'
      });
      sendJson(res, 200, { ok: true, count: clusters.length, clusters });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error.message || String(error) });
    }
    return;
  }

  if (pathname === '/memory/organization/memories' && req.method === 'GET') {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const result = listMemoryOrganizationEntries({
        chatId: url.searchParams.get('chatId') || '',
        status: url.searchParams.get('status') || '',
        limit: url.searchParams.get('limit') || 50,
        offset: url.searchParams.get('offset') || 0
      });
      sendJson(res, 200, { ok: true, ...result });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error.message || String(error) });
    }
    return;
  }

  if (pathname === '/memory/organization/initialize' && req.method === 'POST') {
    try {
      const body = await readRequestBody(req);
      const backup = await backupSqliteDb();
      if (!backup.ok) {
        throw new Error(`Pre-initialization backup failed: ${backup.error || 'unknown error'}`);
      }
      const organization = initializeMemoryOrganizationCoverage({
        chatId: body.chatId || '',
        algorithmVersion: body.algorithmVersion || 'organization-v1'
      });
      sendJson(res, 200, { ok: true, backup, organization });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error.message || String(error) });
    }
    return;
  }

  if (pathname === '/memory/organization/reset' && req.method === 'POST') {
    try {
      const body = await readRequestBody(req);
      if (String(body.confirm || '') !== 'RESET_ORGANIZATION_OVERLAY') {
        throw new Error('Explicit confirmation is required to reset the organization overlay');
      }
      const backup = await backupSqliteDb();
      if (!backup.ok) {
        throw new Error(`Pre-reset backup failed: ${backup.error || 'unknown error'}`);
      }
      const organization = resetMemoryOrganizationOverlay({ confirm: body.confirm });
      sendJson(res, 200, { ok: true, backup, organization });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error.message || String(error) });
    }
    return;
  }

  if (pathname === '/memory/organization/preview' && req.method === 'POST') {
    try {
      const body = await readRequestBody(req);
      if (String(body.confirm || '') !== 'RUN_ORGANIZATION_PREVIEW') {
        throw new Error('Explicit confirmation is required to run the organization preview');
      }
      const backup = await backupSqliteDb();
      if (!backup.ok) {
        throw new Error(`Pre-preview backup failed: ${backup.error || 'unknown error'}`);
      }
      const chatId = String(body.chatId || '');
      const inputs = getMemoryOrganizationPreviewInputs(chatId);
      const preview = buildMemoryOrganizationPreview(inputs, {
        algorithmVersion: body.algorithmVersion || 'organization-preview-v2'
      });
      const organization = saveMemoryOrganizationPreview(preview, {
        chatId,
        confirm: 'SAVE_ORGANIZATION_PREVIEW'
      });
      sendJson(res, 200, {
        ok: true,
        backup,
        preview: {
          algorithmVersion: preview.algorithmVersion,
          behaviorChanged: false,
          sourceMemoryCount: preview.sourceMemoryCount,
          processedCount: preview.processedCount,
          clusteredCount: preview.clusteredCount,
          independentCount: preview.independentCount,
          eventClusterCount: preview.eventClusters.length,
          topicClusterCount: preview.topicClusters.length,
          diagnostics: {
            featureCount: preview.diagnostics.featureCount,
            candidatePairCount: preview.diagnostics.candidatePairCount,
            acceptedPairCount: preview.diagnostics.acceptedPairCount,
            subtypeCounts: preview.diagnostics.subtypeCounts
          }
        },
        organization
      });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error.message || String(error) });
    }
    return;
  }

  if (pathname === '/memory/fts/rebuild' && req.method === 'POST') {
    try {
      const rebuild = rebuildMemoryFts();
      sendJson(res, 200, {
        ok: true,
        rebuild,
        fts: getMemoryFtsStatus({ integrityCheck: true })
      });
    } catch (error) {
      sendJson(res, 500, {
        ok: false,
        error: error.message || String(error)
      });
    }
    return;
  }

  if (pathname === '/memory/chroma/rebuild' && req.method === 'POST') {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const limit = Number(url.searchParams.get('limit') || 10000);
      const batchSize = Number(url.searchParams.get('batchSize') || 100);

      const memories = listMemories({ limit });
      const result = await upsertMemoriesToChroma(memories, { batchSize });
      const status = await getChromaStatus();

      sendJson(res, 200, {
        ok: true,
        sqlite: {
          loaded: memories.length
        },
        rebuild: result,
        chroma: status
      });
    } catch (error) {
      sendJson(res, 500, {
        ok: false,
        error: error.message || String(error)
      });
    }
    return;
  }
  if (pathname === '/memory/unembedded' && req.method === 'GET') {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const limit = url.searchParams.get('limit') || 100;
    const memories = listUnembeddedMemories(limit);

    sendJson(res, 200, {
      ok: true,
      count: memories.length,
      memories
    });
    return;
  }

  if (pathname === '/memory/add' && req.method === 'POST') {
    try {
      const body = await readRequestBody(req);
      let memory = normalizeMemoryFragment(body);
      const existingMemory = memory.id ? getMemoryById(memory.id) : null;
      const receivedEmbedding = Array.isArray(memory.embedding) && memory.embedding.length > 0;
      const clearEmbedding = body.clearEmbedding === true;

      // Metadata-only edits must not erase the server-side vector merely because
      // the browser intentionally does not keep a copy of the 4096d array.
      if (existingMemory && !receivedEmbedding && !clearEmbedding) {
        memory = {
          ...memory,
          embedding: existingMemory.embedding,
          embeddingModel: existingMemory.embeddingModel,
          embeddingDim: existingMemory.embeddingDim,
          embeddingUpdatedAt: existingMemory.embeddingUpdatedAt
        };
      }

      if (clearEmbedding) {
        memory = {
          ...memory,
          embedding: null,
          embeddingModel: '',
          embeddingDim: 0,
          embeddingUpdatedAt: ''
        };
      }

      await backupSqliteDb();

      const savedMemory = addMemory({
        ...memory,
        updatedAt: now()
      });

      if (Array.isArray(savedMemory.embedding) && savedMemory.embedding.length > 0) {
        await tryUpsertMemoryToChroma(savedMemory);
      } else if (existingMemory?.embedding) {
        await tryDeleteMemoryFromChroma(savedMemory.id);
      }

      const hasEmbedding =
        Array.isArray(savedMemory?.embedding) && savedMemory.embedding.length > 0;

      const { embedding, ...publicSavedMemory } = savedMemory || {};

      sendJson(res, 200, {
        ok: true,
        memory: {
          ...publicSavedMemory,
          hasEmbedding,
          _hasEmbedding: hasEmbedding,
          _embeddingDim: hasEmbedding ? savedMemory.embedding.length : 0
        }
      });
    } catch (error) {
      sendJson(res, 400, {
        ok: false,
        error: error.message
      });
    }

    return;
  }

  // ↓↓↓ 从这里开始粘贴 reembed 接口

  if (pathname === '/memory/reembed-unembedded' && req.method === 'POST') {
    try {
      const body = await readRequestBody(req);

      const memories = listUnembeddedMemories(body.limit || 1000);

      const embeddingConfig = {
        endpoint: body.embeddingEndpoint || process.env.EMBEDDING_ENDPOINT || '',
        apiKey: body.embeddingApiKey || process.env.EMBEDDING_API_KEY || '',
        model: body.embeddingModel || process.env.EMBEDDING_MODEL || 'BAAI/bge-m3'
      };

      let success = 0;
      let failed = 0;

      for (const memory of memories) {
        try {
          const embedding = await createQueryEmbedding({
            endpoint: embeddingConfig.endpoint,
            apiKey: embeddingConfig.apiKey,
            model: embeddingConfig.model,
            input: memory.content
          });

          if (Array.isArray(embedding) && embedding.length > 0) {
            const savedMemory = addMemory({
              ...memory,
              embedding,
              embeddingModel: embeddingConfig.model,
              embeddingDim: embedding.length,
              embeddingUpdatedAt: String(Date.now()),
              updatedAt: Date.now()
            });

            await tryUpsertMemoryToChroma(savedMemory);

            success++;
          } else {
            failed++;
          }

        } catch (error) {
          console.warn('[reembed] failed:', memory.id, error.message);
          failed++;
        }
      }

      sendJson(res, 200, {
        ok: true,
        total: memories.length,
        success,
        failed
      });

    } catch (error) {
      sendJson(res, 400, {
        ok: false,
        error: error.message
      });
    }

    return;
  }

  if (pathname === '/memory/search/last' && req.method === 'GET') {
    sendJson(res, 200, {
      ok: true,
      lastSearch: getLatestMemorySearchLog() || lastMemorySearchState
    });
    return;
  }

  if (pathname === '/memory/search/commit' && req.method === 'POST') {
    try {
      const body = await readRequestBody(req);
      let result = commitMemorySearchInjection(
        body.searchTraceId,
        body.memoryIds
      );
      if (Number(body.lifecycleVersion || 1) < 2 && result.committed) {
        const legacyFinalized = finishMemorySearchGeneration(body.searchTraceId, 'succeeded');
        result = {
          ...result,
          recallDeferred: false,
          legacyLifecycle: true,
          log: legacyFinalized.log
        };
      }
      const recallUpdates = getMemoriesByIds(result.log?.injectedMemoryIds || []).map(memory => ({
        id: memory.id,
        recallCount: Number(memory.recallCount || 0),
        lastRecalled: Number(memory.lastRecalled || 0)
      }));

      sendJson(res, 200, {
        ok: true,
        committed: result.committed,
        alreadyCommitted: result.alreadyCommitted,
        recallDeferred: Boolean(result.recallDeferred),
        log: result.log || null,
        searchTraceId: result.log?.id || '',
        injectedCount: result.log?.injectedCount || 0,
        injectedMemoryIds: result.log?.injectedMemoryIds || [],
        recallUpdates
      });
    } catch (error) {
      const notFound = String(error.message || '').includes('not found');
      sendJson(res, notFound ? 404 : 400, {
        ok: false,
        error: error.message || String(error)
      });
    }
    return;
  }

  if (pathname === '/memory/search/generation' && req.method === 'POST') {
    try {
      const body = await readRequestBody(req);
      const result = finishMemorySearchGeneration(
        body.searchTraceId,
        body.outcome,
        body.error || ''
      );
      const recallUpdates = result.recallApplied
        ? getMemoriesByIds(result.log?.injectedMemoryIds || []).map(memory => ({
            id: memory.id,
            recallCount: Number(memory.recallCount || 0),
            lastRecalled: Number(memory.lastRecalled || 0) || null
          }))
        : [];
      sendJson(res, 200, { ok: true, ...result, recallUpdates });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error.message || String(error) });
    }
    return;
  }

  if (pathname === '/memory/search' && req.method === 'POST') {
    try {
      const body = await readRequestBody(req);
      const requestedQuery = String(body.query || '').trim();
      const shadowPrimaryQuery = String(body.shadowPrimaryQuery || requestedQuery).trim();
      const recallGateEnabled = body.recallGateEnabled === true
        || String(process.env.MEMORY_RECALL_GATE_ENABLED || '').toLowerCase() === 'true';
      // The latest user message always owns retrieval intent. Older user messages
      // remain low-weight context variants; assistant prose must never replace the
      // current user query, regardless of whether the experimental gate is enabled.
      const q = shadowPrimaryQuery || requestedQuery;
      const activeEventShadow = runActiveEventShadow(listMemoryActiveEvents({
        chatId: body.chatId || '',
        limit: 50
      }), {
        query: q,
        maxSelected: 2
      });
      const safeLimit = clampNumber(body.limit || 20, 1, 200, 20);
      const debugQueries = buildMemorySearchQueries(q, body.queryVariants || body.cleanedQueries || body.queries || []);

      const memoryFilters = {
        chatId: body.chatId || '',
        category: body.category || '',
        excludeCategories: Array.isArray(body.excludeCategories) ? body.excludeCategories : [],
        minImportance: body.minImportance || '',
        maxImportance: body.maxImportance || ''
      };
      const recallIntentAnchors = buildRecallIntentAnchors(shadowPrimaryQuery || q, memoryFilters);
      const fallbackCandidateLimit = Math.min(
        10000,
        Math.max(1000, Number(body.candidateLimit || process.env.MEMORY_SEARCH_CANDIDATE_LIMIT || 6000) || 6000)
      );
      const ftsCandidateLimit = clampNumber(
        body.ftsCandidateLimit || process.env.MEMORY_FTS_CANDIDATE_LIMIT || Math.max(safeLimit * 20, 200),
        safeLimit,
        2000,
        Math.max(safeLimit * 20, 200)
      );
      const ftsResult = searchMemoriesFts(debugQueries, {
        ...memoryFilters,
        limit: ftsCandidateLimit
      });
      // Shadow gets a small, independent full-store FTS lane driven only by the
      // latest user message. It cannot alter live Top-N; it merely prevents precise
      // current-intent candidates from disappearing before the policy can judge them.
      const precisionFtsResult = searchMemoriesFts([shadowPrimaryQuery], {
        ...memoryFilters,
        limit: Math.min(200, Math.max(60, safeLimit * 12))
      });
      const precisionFtsIds = new Set(precisionFtsResult.memories.map(memory => String(memory.id)));
      const ftsMeta = {
        available: ftsResult.available,
        attempted: ftsResult.attempted,
        returned: ftsResult.memories.length,
        fallback: ftsResult.fallback,
        tokenizer: getMemoryFtsStatus({ integrityCheck: false }).tokenizer,
        error: ftsResult.error || null
      };

      // FTS5 searches the whole SQLite store. The most recent N rows are retained
      // only as a compatibility fallback when FTS5 is unavailable or the query is
      // too short to produce a useful indexed term.
      const usedFtsCandidates = ftsResult.memories.length > 0;
      let memories = ftsResult.memories.length
        ? ftsResult.memories
        : listMemories({ ...memoryFilters, limit: fallbackCandidateLimit });

      const embeddingConfig = {
        endpoint: body.embeddingEndpoint || process.env.EMBEDDING_ENDPOINT || '',
        apiKey: body.embeddingApiKey || process.env.EMBEDDING_API_KEY || '',
        model: body.embeddingModel || process.env.EMBEDDING_MODEL || 'BAAI/bge-m3'
      };

      let chromaError = null;
      let chromaAttempted = false;
      const memorySearchEngine = String(body.searchEngine || process.env.MEMORY_SEARCH_ENGINE || 'sqlite').trim().toLowerCase();
      const preferChroma = memorySearchEngine === 'chroma';
      const preferHybrid = memorySearchEngine === 'hybrid' || memorySearchEngine === 'chroma-hybrid';

      if (preferChroma && q && embeddingConfig.endpoint && embeddingConfig.apiKey) {
        chromaAttempted = true;

        try {
          const queryEmbedding = await createQueryEmbedding({
            endpoint: embeddingConfig.endpoint,
            apiKey: embeddingConfig.apiKey,
            model: embeddingConfig.model,
            input: q
          });

          if (queryEmbedding) {
            console.log('[memory-server] chroma query embedding dim =', queryEmbedding.length);

            const chromaNResults = clampNumber(
              body.chromaNResults || Math.max(safeLimit * 10, 50),
              safeLimit,
              1000,
              Math.max(safeLimit * 10, 50)
            );

            const chromaResult = await queryChromaByEmbedding(queryEmbedding, {
              nResults: chromaNResults
            });

            const ids = chromaResult?.ids?.[0] || [];
            const distances = chromaResult?.distances?.[0] || [];
            const fullStoreCandidates = getMemoriesByIds(ids, memoryFilters);
            const candidateById = new Map(
              fullStoreCandidates.map(memory => [String(memory.id), memory])
            );
            const chromaMemories = [];
            const seen = new Set();
            const chromaShadowCandidateLimit = clampNumber(
              body.shadowCandidateLimit || process.env.MEMORY_SHADOW_CANDIDATE_LIMIT || Math.max(safeLimit * 5, 60),
              safeLimit,
              200,
              Math.max(safeLimit * 5, 60)
            );

            for (let i = 0; i < ids.length; i++) {
              const id = String(ids[i]);

              if (seen.has(id)) continue;
              seen.add(id);

              const memory = candidateById.get(id);
              if (!memory) continue;

              const memoryEmbedding = safeParseEmbedding(memory.embedding);
              const {
                embedding,
                ...memoryWithoutEmbedding
              } = memory;

              const distance = Number(distances[i] || 0);
              const vectorScore = Number.isFinite(distance)
                ? 1 / (1 + Math.max(0, distance))
                : 0;

              const textScore = keywordScore(q, memory, body.participantNames);
              const importanceScore = (Number(memory.importance) || 0) / 10;
              const emotionScore = (Number(memory.emotionalWeight) || 0) / 10;
              const totalScore = vectorScore * 0.82 + textScore * 0.08 + importanceScore * 0.07 + emotionScore * 0.03;

              chromaMemories.push({
                ...memoryWithoutEmbedding,
                embedding: memoryEmbedding ? `[hidden:${memoryEmbedding.length}d]` : null,
                _hasEmbedding: Boolean(memoryEmbedding),
                _embeddingDim: memoryEmbedding ? memoryEmbedding.length : 0,
                _searchScore: Number(totalScore.toFixed(6)),
                _vectorScore: Number(vectorScore.toFixed(6)),
                _keywordScore: Number(textScore.toFixed(6)),
                _chromaDistance: Number.isFinite(distance) ? Number(distance.toFixed(6)) : null,
                _searchMode: 'chroma-vector'
              });

              if (chromaMemories.length >= chromaShadowCandidateLimit) break;
            }

              if (chromaMemories.length > 0) {
                const shadowPolicy = runRecallShadowPolicy(withReliableEventClusterMetadata(chromaMemories), {
                  targetLimit: safeLimit,
                  candidateLimit: chromaShadowCandidateLimit,
                  query: q,
                  primaryQuery: body.shadowPrimaryQuery || q,
                  contextQueries: body.shadowContextQueries || debugQueries.slice(1),
                  intentAnchors: recallIntentAnchors
                });
                const effectiveShadowPolicy = recallGateEnabled ? {
                  ...shadowPolicy,
                  mode: 'active',
                  version: 'recall-gate-v2',
                  behaviorChanged: true
                } : shadowPolicy;
                const selectedById = new Map(chromaMemories.map(memory => [String(memory.id), memory]));
                const liveChromaMemories = recallGateEnabled
                  ? effectiveShadowPolicy.selectedMemoryIds.map(id => selectedById.get(String(id))).filter(Boolean).slice(0, safeLimit)
                  : chromaMemories.slice(0, safeLimit);
                const responsePayload = {
                  ok: true,
                  query: q,
                  count: liveChromaMemories.length,
                  searchMode: 'chroma-vector',
                  chroma: {
                    attempted: true,
                    returned: ids.length,
                    matchedCandidates: chromaMemories.length
                  },
                  fts: ftsMeta,
                  shadowPolicy: compactShadowPolicySummary(effectiveShadowPolicy),
                  activeEventShadow,
                  memories: liveChromaMemories
                };

                if (!body.diagnostic) {
                  responsePayload.searchTraceId = updateLastMemorySearchState({
                    source: '/memory/search',
                    query: q,
                    queryVariants: debugQueries.slice(1),
                    turnId: body.turnId || '',
                    attemptId: body.attemptId || '',
                    actionType: body.actionType || 'reply',
                    chatId: body.chatId || '',
                    searchMode: responsePayload.searchMode,
                    requestedSearchEngine: memorySearchEngine,
                    limit: safeLimit,
                    candidateLimit: memories.length,
                    resultCount: liveChromaMemories.length,
                    chroma: responsePayload.chroma,
                    fts: responsePayload.fts,
                    shadowPolicy: effectiveShadowPolicy,
                    activeEventShadow,
                    results: liveChromaMemories
                  });
                }

                sendJson(res, 200, responsePayload);
                return;
              }

            chromaError = 'chroma returned no matching memories after local filters';
          } else {
            chromaError = 'query embedding was empty';
          }
        } catch (error) {
          chromaError = error.message || String(error);
          console.warn('[memory-server] chroma search failed, fallback to sqlite simpleSearch:', chromaError);
        }
      }

      let chromaHybridMeta = null;

      if (preferHybrid) {
        chromaHybridMeta = {
          attempted: false,
          hybrid: true,
          returned: 0,
          matchedCandidates: 0,
          addedCandidates: 0,
          fallback: false,
          error: null
        };
      }

      if (preferHybrid && q && embeddingConfig.endpoint && embeddingConfig.apiKey) {
        chromaAttempted = true;
        chromaHybridMeta.attempted = true;

        try {
          const queryEmbedding = await createQueryEmbedding({
            endpoint: embeddingConfig.endpoint,
            apiKey: embeddingConfig.apiKey,
            model: embeddingConfig.model,
            input: q
          });

          if (queryEmbedding) {
            const chromaNResults = clampNumber(
              body.chromaNResults || Math.max(safeLimit * 20, 100),
              safeLimit,
              1000,
              Math.max(safeLimit * 20, 100)
            );

            const chromaResult = await queryChromaByEmbedding(queryEmbedding, {
              nResults: chromaNResults
            });

            const ids = chromaResult?.ids?.[0] || [];
            chromaHybridMeta.returned = ids.length;
            const chromaCandidateById = new Map(
              getMemoriesByIds(ids, memoryFilters).map(memory => [String(memory.id), memory])
            );

            const existingIds = new Set(memories.map(memory => String(memory.id)));
            const addedMemories = [];

            const matchesFilters = (memory) => {
              if (!memory) return false;

              if (body.chatId && String(memory.chatId || '') !== String(body.chatId)) {
                return false;
              }

              if (body.category && String(memory.category || '').toUpperCase() !== String(body.category).trim().toUpperCase()) {
                return false;
              }

              const importance = Number(memory.importance || 0);

              if (body.minImportance !== undefined && body.minImportance !== null && body.minImportance !== '' && importance < Number(body.minImportance)) {
                return false;
              }

              if (body.maxImportance !== undefined && body.maxImportance !== null && body.maxImportance !== '' && importance > Number(body.maxImportance)) {
                return false;
              }

              return true;
            };

            for (const rawId of ids) {
              const memoryId = String(rawId || '').trim();
              if (!memoryId) continue;

              if (existingIds.has(memoryId)) {
                chromaHybridMeta.matchedCandidates++;
                continue;
              }

              const memory = chromaCandidateById.get(memoryId);
              if (!matchesFilters(memory)) continue;

              existingIds.add(memoryId);
              addedMemories.push(memory);
              chromaHybridMeta.addedCandidates++;
            }

            if (addedMemories.length) {
              memories = memories.concat(addedMemories);
            }
          } else {
            chromaError = 'query embedding was empty';
            chromaHybridMeta.error = chromaError;
          }
        } catch (error) {
          chromaError = error.message || String(error);
          chromaHybridMeta.error = chromaError;
          chromaHybridMeta.fallback = true;
          console.warn('[memory-server] chroma hybrid candidate expansion failed, continue sqlite simpleSearch:', chromaError);
        }
      }

      const shadowCandidateLimit = clampNumber(
        body.shadowCandidateLimit || process.env.MEMORY_SHADOW_CANDIDATE_LIMIT || Math.max(safeLimit * 5, 60),
        safeLimit,
        200,
        Math.max(safeLimit * 5, 60)
      );
      const extendedRankLimit = Math.min(200, Math.max(shadowCandidateLimit, shadowCandidateLimit + precisionFtsIds.size));
      const rankedCandidatesExtended = await simpleSearch(memories, q, extendedRankLimit, {
        embedding: embeddingConfig,
        queryVariants: debugQueries.slice(1),
        participantNames: body.participantNames || [],
        scoreWeights: body.scoreWeights || body.weights || {}
      });
      const rankedCandidates = rankedCandidatesExtended.slice(0, shadowCandidateLimit);
      const shadowCandidateById = new Map(rankedCandidates.map(memory => [String(memory.id), memory]));
      const precisionRankedCandidates = await simpleSearch(
        precisionFtsResult.memories,
        shadowPrimaryQuery,
        precisionFtsResult.memories.length || 1,
        {
          embedding: embeddingConfig,
          participantNames: body.participantNames || [],
          scoreWeights: body.scoreWeights || body.weights || {}
        }
      );
      for (const memory of precisionRankedCandidates) {
        const id = String(memory.id);
        if (!shadowCandidateById.has(id)) {
          shadowCandidateById.set(id, { ...memory, _shadowPrecisionCandidate: true });
        }
      }
      for (const memory of rankedCandidates) {
        if (precisionFtsIds.has(String(memory.id))) memory._shadowPrecisionCandidate = true;
      }
      const shadowCandidates = [...shadowCandidateById.values()].slice(0, 200);
      // Shadow mode observes a wider ranked pool, but the live response remains the
      // exact same top-N slice as before stage 3.
      const shadowPolicy = runRecallShadowPolicy(withReliableEventClusterMetadata(shadowCandidates), {
        targetLimit: safeLimit,
        candidateLimit: shadowCandidates.length,
        query: q,
        primaryQuery: body.shadowPrimaryQuery || q,
        contextQueries: body.shadowContextQueries || debugQueries.slice(1),
        intentAnchors: recallIntentAnchors
      });
      const effectiveShadowPolicy = recallGateEnabled ? {
        ...shadowPolicy,
        mode: 'active',
        version: 'recall-gate-v2',
        behaviorChanged: true
      } : shadowPolicy;
      const selectedById = new Map(shadowCandidates.map(memory => [String(memory.id), memory]));
      const results = recallGateEnabled
        ? effectiveShadowPolicy.selectedMemoryIds.map(id => selectedById.get(String(id))).filter(Boolean).slice(0, safeLimit)
        : rankedCandidates.slice(0, safeLimit);

      let searchMode = '';
      if (preferHybrid && chromaAttempted && !chromaHybridMeta?.fallback) {
        searchMode = usedFtsCandidates ? 'chroma-fts5-rerank' : 'chroma-hybrid-rerank';
      } else if (chromaAttempted) {
        searchMode = usedFtsCandidates ? 'fts5-fallback-after-chroma' : 'sqlite-fallback-after-chroma';
      } else if (usedFtsCandidates) {
        searchMode = embeddingConfig.endpoint && embeddingConfig.apiKey
          ? 'fts5-semantic-rerank'
          : 'fts5-keyword-rerank';
      } else {
        searchMode = embeddingConfig.endpoint && embeddingConfig.apiKey
          ? 'semantic-hybrid-fallback'
          : 'keyword-fallback';
      }

      const responsePayload = {
        ok: true,
        query: q,
        debugQueries,
        cleanedQueries: debugQueries.slice(1),
        count: results.length,
        searchMode,
        chroma: chromaHybridMeta || (chromaAttempted ? {
          attempted: true,
          fallback: true,
          error: chromaError
        } : {
          attempted: false
        }),
        fts: ftsMeta,
        shadowPolicy: compactShadowPolicySummary(effectiveShadowPolicy),
        activeEventShadow,
        memories: results
      };

      if (!body.diagnostic) {
        responsePayload.searchTraceId = updateLastMemorySearchState({
          source: '/memory/search',
          query: q,
          queryVariants: debugQueries.slice(1),
          turnId: body.turnId || '',
          attemptId: body.attemptId || '',
          actionType: body.actionType || 'reply',
          chatId: body.chatId || '',
          searchMode: responsePayload.searchMode,
          requestedSearchEngine: memorySearchEngine,
          limit: safeLimit,
          candidateLimit: memories.length,
          resultCount: results.length,
          chroma: responsePayload.chroma,
          fts: responsePayload.fts,
          shadowPolicy: effectiveShadowPolicy,
          activeEventShadow,
          results
        });
      }

      sendJson(res, 200, responsePayload);
    } catch (error) {
      sendJson(res, 400, {
        ok: false,
        error: error.message
      });
    }

    return;
  }

  if (pathname === '/memory/backup' && req.method === 'POST') {
    const result = await backupSqliteDb();

    if (result.ok) {
      sendJson(res, 200, {
        ok: true,
        message: 'SQLite memory database backed up.',
        backupFile: result.backupFile,
        latestBackupFile: result.latestBackupFile,
        timestamp: result.timestamp
      });
    } else {
      sendJson(res, 500, {
        ok: false,
        error: result.error || 'Backup failed'
      });
    }

    return;
  }

  if (pathname === '/memory/delete' && req.method === 'POST') {
    try {
      const body = await readRequestBody(req);
      const id = String(body.id || '').trim();

      if (!id) {
        sendJson(res, 400, {
          ok: false,
          error: 'id is required'
        });
        return;
      }

      await backupSqliteDb();

      const deleted = deleteMemory(id);

      if (deleted) {
        await tryDeleteMemoryFromChroma(id);
      }

      sendJson(res, 200, {
        ok: true,
        deleted: deleted ? 1 : 0
      });
    } catch (error) {
      sendJson(res, 400, {
        ok: false,
        error: error.message
      });
    }

    return;
  }

  if (pathname === '/memory/clear' && req.method === 'POST') {
    await backupSqliteDb();

    const deleted = clearAllMemories();

    await tryResetChromaCollection();

    sendJson(res, 200, {
      ok: true,
      deleted,
      message: 'All memories cleared.'
    });
    return;
  }

  sendJson(res, 404, {
    ok: false,
    error: 'Not found'
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Aion Memory Server running at http://127.0.0.1:${PORT}`);
  console.log(`Local health check: http://127.0.0.1:${PORT}/health`);
  console.log(`Tailscale access: http://100.81.84.121:${PORT}/health`);
  console.log('Storage: SQLite memory.db');
});

if (String(process.env.MEMORY_ORGANIZATION_INCREMENTAL_ENABLED || 'true').toLowerCase() !== 'false') {
  const runIncrementalOrganization = () => {
    try {
      const result = processMemoryOrganizationQueue({ limit: 20 });
      if (result.processedCount || result.failedCount) {
        console.log(`[memory-organization] incremental processed=${result.processedCount} failed=${result.failedCount}`);
      }
    } catch (error) {
      console.warn('[memory-organization] incremental queue failed:', error.message || String(error));
    }
  };
  setTimeout(runIncrementalOrganization, 1500).unref();
  setInterval(runIncrementalOrganization, 30000).unref();
}
