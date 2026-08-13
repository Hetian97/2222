const crypto = require('crypto');
const {
  cosineSample,
  extractDateKeys,
  extractTextFeatures
} = require('./memory-organization-preview');

const DEFAULT_INCREMENTAL_OPTIONS = Object.freeze({
  algorithmVersion: 'organization-incremental-v2',
  embeddingSampleSize: 192,
  attachFloor: 0.9,
  pairFloor: 0.92,
  completeLinkFloor: 0.87,
  lexicalFloor: 0.18,
  maxEventMembers: 6,
  maxEventSpanMs: 14 * 24 * 60 * 60 * 1000
});

const HISTORY_JUMP_PATTERN = /(?:上个月|上周|去年|前年|以前|曾经|当年|小时候|那一次|那次|上一次|上次|之前那次|回忆起|想起曾经)/u;
const SCENE_GENERIC_FEATURES = new Set([
  '阿鹤', '夏以昼', '夏太太', '用户', '角色', '我们', '他们', '她们',
  '时间', '事情', '自己', '对方', '后来', '然后', '现在', '今天',
  '喜欢', '偏爱', '关系', '承诺', '照顾', '保护', '亲密', '互动',
  '一起', '主动', '表达', '时候', '当时', '开始', '已经', '还是',
  '没有', '因为', '所以', '一个', '这个', '那个'
]);

function safeJsonParse(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function normalizeTimestamp(value) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function buildEmbeddingSample(rawEmbedding, sampleSize) {
  const embedding = safeJsonParse(rawEmbedding, null);
  if (!Array.isArray(embedding) || embedding.length === 0) return null;
  const size = Math.min(sampleSize, embedding.length);
  const values = new Float32Array(size);
  let norm = 0;
  for (let index = 0; index < size; index += 1) {
    const sourceIndex = Math.floor((index * embedding.length) / size);
    const value = Number(embedding[sourceIndex] || 0);
    values[index] = value;
    norm += value * value;
  }
  return norm > 0 ? { values, norm: Math.sqrt(norm) } : null;
}

function extractSceneFeatures(memory) {
  const features = new Set();
  const source = String(memory.content || '').normalize('NFKC').toLowerCase();
  for (const run of (source.match(/[\u3400-\u9fff]+/g) || [])) {
    for (const size of [2, 3, 4]) {
      for (let index = 0; index <= run.length - size; index += 1) {
        features.add(run.slice(index, index + size));
      }
    }
  }
  for (const tag of (safeJsonParse(memory.tags, []) || [])) {
    const normalized = String(tag || '').replace(/[\s\p{P}\p{S}]+/gu, '').trim();
    if (normalized.length >= 2) features.add(normalized);
  }
  return features;
}

function prepareMemory(memory, options = DEFAULT_INCREMENTAL_OPTIONS) {
  return {
    ...memory,
    timestamp: normalizeTimestamp(memory.memoryTime || memory.createdAt),
    dates: new Set(extractDateKeys(memory.content || '')),
    features: new Set(extractTextFeatures(`${memory.content || ''} ${(safeJsonParse(memory.tags, []) || []).join(' ')}`)),
    sceneFeatures: extractSceneFeatures(memory),
    embeddingSample: buildEmbeddingSample(memory.embedding, options.embeddingSampleSize)
  };
}

function lexicalOverlap(left, right) {
  if (!left.features.size || !right.features.size) return 0;
  let intersection = 0;
  for (const feature of left.features) if (right.features.has(feature)) intersection += 1;
  return intersection / Math.max(1, Math.min(left.features.size, right.features.size));
}

function datesConflict(left, right) {
  if (!left.dates.size || !right.dates.size) return false;
  for (const leftDate of left.dates) {
    for (const rightDate of right.dates) {
      if (leftDate === rightDate || leftDate.endsWith(`-${rightDate}`) || rightDate.endsWith(`-${leftDate}`)) return false;
    }
  }
  return true;
}

function pairScore(left, right) {
  if (datesConflict(left, right)) return { accepted: false, score: 0, semantic: 0, lexical: 0, reason: 'explicit_date_conflict' };
  const semantic = cosineSample(left.embeddingSample, right.embeddingSample);
  const lexical = lexicalOverlap(left, right);
  if (!Number.isFinite(semantic)) return { accepted: false, score: 0, semantic: 0, lexical, reason: 'embedding_missing' };
  const score = semantic * 0.96 + lexical * 0.04;
  return { accepted: true, score, semantic, lexical, reason: 'semantic_and_lexical_evidence' };
}

function sameSummaryBatch(left, right, options) {
  const leftMemoryTime = String(left.memoryTime || '');
  const rightMemoryTime = String(right.memoryTime || '');
  if (!leftMemoryTime || leftMemoryTime !== rightMemoryTime) return false;
  const leftCreated = normalizeTimestamp(left.createdAt);
  const rightCreated = normalizeTimestamp(right.createdAt);
  return Boolean(leftCreated && rightCreated && Math.abs(leftCreated - rightCreated) <= Number(options.batchWindowMs || 15000));
}

function hasHistoryJump(memory) {
  return HISTORY_JUMP_PATTERN.test(String(memory.content || ''));
}

function sharedSceneAnchors(left, right) {
  const shared = [...left.sceneFeatures].filter(feature =>
    right.sceneFeatures.has(feature)
      && !SCENE_GENERIC_FEATURES.has(feature)
      && !['阿鹤', '夏以昼', '夏太太'].some(name => feature.includes(name))
      && !(feature.length === 2 && /[我你他她它]/u.test(feature))
  );
  const long = shared.filter(feature => feature.length >= 3);
  const bigrams = shared.filter(feature => feature.length === 2);
  return { shared, long, bigrams };
}

function batchSceneEvidence(left, right, options) {
  if (!sameSummaryBatch(left, right, options)) return { accepted: false, reason: 'different_summary_batch' };
  if (hasHistoryJump(left) || hasHistoryJump(right)) return { accepted: false, reason: 'historical_time_jump' };
  if (datesConflict(left, right)) return { accepted: false, reason: 'explicit_date_conflict' };
  const semantic = cosineSample(left.embeddingSample, right.embeddingSample);
  if (!Number.isFinite(semantic) || semantic < Number(options.batchSemanticFloor || 0.5)) {
    return { accepted: false, reason: 'batch_semantic_floor', semantic: Number.isFinite(semantic) ? semantic : 0 };
  }
  const anchors = sharedSceneAnchors(left, right);
  const anchorAccepted = anchors.long.length > 0 || anchors.bigrams.length >= 1;
  if (!anchorAccepted) return { accepted: false, reason: 'batch_scene_anchor_missing', semantic, anchors: anchors.shared };
  const confidence = Math.min(0.92, 0.84 + Math.max(0, semantic - 0.5) * 0.2 + Math.min(0.06, anchors.shared.length * 0.02));
  return {
    accepted: true,
    reason: 'same_summary_scene_anchor',
    confidence,
    semantic,
    anchors: anchors.shared.slice(0, 8)
  };
}

function spanCompatible(memory, members, options) {
  const times = [memory, ...members].map(item => item.timestamp).filter(Boolean);
  return times.length < 2 || Math.max(...times) - Math.min(...times) <= options.maxEventSpanMs;
}

function decideIncrementalOrganization(memory, eventClusters = [], independentMemories = [], suppliedOptions = {}) {
  const options = { ...DEFAULT_INCREMENTAL_OPTIONS, ...suppliedOptions };
  const target = prepareMemory(memory, options);
  if (String(memory.category || '').toUpperCase() === 'C') {
    return { action: 'protected_core', confidence: 1, reason: 'core_memory_not_auto_clustered' };
  }
  if (!target.embeddingSample) {
    return { action: 'independent', confidence: 0.65, reason: 'embedding_missing' };
  }

  let bestBatchCluster = null;
  for (const cluster of eventClusters) {
    const members = (cluster.members || []).map(item => prepareMemory(item, options));
    if (members.length < 2 || members.length >= options.maxEventMembers) continue;
    const evidence = members
      .map(member => batchSceneEvidence(target, member, options))
      .filter(item => item.accepted)
      .sort((left, right) => right.confidence - left.confidence)[0];
    if (!evidence) continue;
    const allSameBatch = members.every(member => sameSummaryBatch(target, member, options) && !hasHistoryJump(member));
    if (!allSameBatch) continue;
    if (!bestBatchCluster || evidence.confidence > bestBatchCluster.confidence) {
      bestBatchCluster = {
        action: 'attach_event',
        clusterId: cluster.id,
        confidence: evidence.confidence,
        reason: 'incremental_same_batch_scene',
        batchAnchors: evidence.anchors
      };
    }
  }
  if (bestBatchCluster) return bestBatchCluster;

  let bestCluster = null;
  for (const cluster of eventClusters) {
    const members = (cluster.members || []).map(item => prepareMemory(item, options));
    if (members.length < 2 || members.length >= options.maxEventMembers || !spanCompatible(target, members, options)) continue;
    if (members.some(member =>
      sameSummaryBatch(target, member, options) && hasHistoryJump(target) !== hasHistoryJump(member)
    )) continue;
    const scores = members.map(member => pairScore(target, member));
    if (scores.some(item => !item.accepted)) continue;
    const minimum = Math.min(...scores.map(item => item.score));
    const average = scores.reduce((sum, item) => sum + item.score, 0) / scores.length;
    const lexical = Math.max(...scores.map(item => item.lexical));
    if (minimum < options.completeLinkFloor || average < options.attachFloor) continue;
    if (lexical < options.lexicalFloor && average < 0.98) continue;
    if (!bestCluster || average > bestCluster.confidence) {
      bestCluster = { action: 'attach_event', clusterId: cluster.id, confidence: average, minimum, reason: 'incremental_complete_link_match' };
    }
  }
  if (bestCluster) return bestCluster;

  let bestBatchMemory = null;
  for (const candidate of independentMemories) {
    const evidence = batchSceneEvidence(target, prepareMemory(candidate, options), options);
    if (!evidence.accepted) continue;
    if (!bestBatchMemory || evidence.confidence > bestBatchMemory.confidence) {
      bestBatchMemory = {
        action: 'create_event',
        partnerMemoryId: candidate.id,
        confidence: evidence.confidence,
        reason: 'incremental_same_batch_scene',
        batchAnchors: evidence.anchors
      };
    }
  }
  if (bestBatchMemory) return bestBatchMemory;

  let bestMemory = null;
  for (const candidate of independentMemories) {
    const prepared = prepareMemory(candidate, options);
    if (!spanCompatible(target, [prepared], options)) continue;
    if (sameSummaryBatch(target, prepared, options) && hasHistoryJump(target) !== hasHistoryJump(prepared)) continue;
    const score = pairScore(target, prepared);
    if (!score.accepted || score.score < options.pairFloor) continue;
    if (score.lexical < options.lexicalFloor && score.score < 0.985) continue;
    if (!bestMemory || score.score > bestMemory.confidence) {
      bestMemory = { action: 'create_event', partnerMemoryId: candidate.id, confidence: score.score, reason: 'incremental_high_precision_pair' };
    }
  }
  if (bestMemory) return bestMemory;
  return { action: 'independent', confidence: 0.65, reason: 'no_reliable_incremental_match' };
}

function createIncrementalClusterId(memoryIds, algorithmVersion = DEFAULT_INCREMENTAL_OPTIONS.algorithmVersion) {
  const digest = crypto.createHash('sha256').update(`${algorithmVersion}\n${[...memoryIds].sort().join('\n')}`).digest('hex').slice(0, 20);
  return `event_incremental_${digest}`;
}

module.exports = {
  DEFAULT_INCREMENTAL_OPTIONS,
  decideIncrementalOrganization,
  createIncrementalClusterId,
  batchSceneEvidence,
  hasHistoryJump
};
