const crypto = require('crypto');
const {
  cosineSample,
  extractDateKeys,
  extractTextFeatures
} = require('./memory-organization-preview');

const DEFAULT_INCREMENTAL_OPTIONS = Object.freeze({
  algorithmVersion: 'organization-incremental-v1',
  embeddingSampleSize: 192,
  attachFloor: 0.9,
  pairFloor: 0.92,
  completeLinkFloor: 0.87,
  lexicalFloor: 0.18,
  maxEventMembers: 6,
  maxEventSpanMs: 14 * 24 * 60 * 60 * 1000
});

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

function prepareMemory(memory, options = DEFAULT_INCREMENTAL_OPTIONS) {
  return {
    ...memory,
    timestamp: normalizeTimestamp(memory.memoryTime || memory.createdAt),
    dates: new Set(extractDateKeys(memory.content || '')),
    features: new Set(extractTextFeatures(`${memory.content || ''} ${(safeJsonParse(memory.tags, []) || []).join(' ')}`)),
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

  let bestCluster = null;
  for (const cluster of eventClusters) {
    const members = (cluster.members || []).map(item => prepareMemory(item, options));
    if (members.length < 2 || members.length >= options.maxEventMembers || !spanCompatible(target, members, options)) continue;
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

  let bestMemory = null;
  for (const candidate of independentMemories) {
    const prepared = prepareMemory(candidate, options);
    if (!spanCompatible(target, [prepared], options)) continue;
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
  createIncrementalClusterId
};
