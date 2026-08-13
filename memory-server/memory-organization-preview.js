const crypto = require('crypto');

const DEFAULT_OPTIONS = Object.freeze({
  algorithmVersion: 'organization-preview-v1',
  maxFeatureDocumentRatio: 0.12,
  maxFeaturesPerMemory: 24,
  maxBucketSize: 48,
  maxCandidatePairs: 500000,
  maxCandidatesPerMemory: 36,
  embeddingSampleSize: 192,
  eventSimilarityFloor: 0.84,
  topicSimilarityFloor: 0.72,
  nearDuplicateFloor: 0.93,
  eventWindowMs: 14 * 24 * 60 * 60 * 1000,
  topicMaxMembers: 120
});

const GENERIC_TERMS = new Set([
  '我们', '你们', '他们', '自己', '对方', '今天', '现在', '然后', '后来',
  '事情', '时候', '感觉', '觉得', '知道', '记得', '已经', '还是', '没有',
  '一个', '一些', '这个', '那个', '因为', '所以', '但是', '可以', '可能',
  '真的', '这样', '那样', '一直', '一起'
]);

function safeJsonParse(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch (error) {
    return fallback;
  }
}

function normalizeFeature(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .trim();
}

function extractDateKeys(text) {
  const source = String(text || '');
  const keys = new Set();
  const occupied = [];
  const fullPattern = /(20\d{2})[年\-/.](0?[1-9]|1[0-2])[月\-/.](0?[1-9]|[12]\d|3[01])日?/g;
  for (const match of source.matchAll(fullPattern)) {
    keys.add(`${match[1]}-${String(match[2]).padStart(2, '0')}-${String(match[3]).padStart(2, '0')}`);
    occupied.push([match.index, match.index + match[0].length]);
  }
  const shortPattern = /(0?[1-9]|1[0-2])月(0?[1-9]|[12]\d|3[01])日/g;
  for (const match of source.matchAll(shortPattern)) {
    const start = match.index;
    const end = start + match[0].length;
    if (occupied.some(([left, right]) => start < right && end > left)) continue;
    keys.add(`${String(match[1]).padStart(2, '0')}-${String(match[2]).padStart(2, '0')}`);
  }
  return [...keys];
}

function dateKeysCompatible(leftDates, rightDates) {
  for (const left of leftDates) {
    for (const right of rightDates) {
      if (left === right || left.endsWith(`-${right}`) || right.endsWith(`-${left}`)) return true;
    }
  }
  return false;
}

function extractTextFeatures(text) {
  const source = String(text || '').toLowerCase();
  const features = new Set();
  for (const match of source.matchAll(/[a-z0-9][a-z0-9_-]{2,}/g)) {
    features.add(match[0]);
  }
  for (const match of source.matchAll(/[\u3400-\u9fff]{2,8}/g)) {
    const phrase = match[0];
    if (phrase.length <= 4) features.add(phrase);
    for (let index = 0; index < phrase.length - 1; index += 1) {
      features.add(phrase.slice(index, index + 2));
    }
  }
  return [...features]
    .map(normalizeFeature)
    .filter(feature => feature.length >= 2 && !GENERIC_TERMS.has(feature));
}

function normalizeTimestamp(value) {
  if (value === null || value === undefined || value === '') return 0;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const parsed = Date.parse(String(value));
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
  if (norm <= 0) return null;
  return { values, norm: Math.sqrt(norm) };
}

function cosineSample(left, right) {
  if (!left || !right || left.values.length !== right.values.length) return null;
  let dot = 0;
  for (let index = 0; index < left.values.length; index += 1) {
    dot += left.values[index] * right.values[index];
  }
  return dot / (left.norm * right.norm);
}

function intersectionCount(left, right) {
  let count = 0;
  for (const value of left) if (right.has(value)) count += 1;
  return count;
}

function stableId(prefix, memberIds, algorithmVersion) {
  const digest = crypto
    .createHash('sha256')
    .update(`${algorithmVersion}\n${[...memberIds].sort().join('\n')}`)
    .digest('hex')
    .slice(0, 20);
  return `${prefix}_${digest}`;
}

class UnionFind {
  constructor(size) {
    this.parent = Array.from({ length: size }, (_, index) => index);
    this.rank = new Uint8Array(size);
  }

  find(index) {
    let root = index;
    while (this.parent[root] !== root) root = this.parent[root];
    while (this.parent[index] !== index) {
      const next = this.parent[index];
      this.parent[index] = root;
      index = next;
    }
    return root;
  }

  union(left, right) {
    let leftRoot = this.find(left);
    let rightRoot = this.find(right);
    if (leftRoot === rightRoot) return;
    if (this.rank[leftRoot] < this.rank[rightRoot]) [leftRoot, rightRoot] = [rightRoot, leftRoot];
    this.parent[rightRoot] = leftRoot;
    if (this.rank[leftRoot] === this.rank[rightRoot]) this.rank[leftRoot] += 1;
  }
}

function selectClusterLabel(members, featureDocumentFrequency, maxDocumentFrequency) {
  const scores = new Map();
  const support = new Map();
  for (const member of members) {
    const seen = new Set([...member.tags, ...member.rareFeatures]);
    for (const feature of seen) support.set(feature, (support.get(feature) || 0) + 1);
  }
  for (const member of members) {
    for (const tag of member.tags) {
      if (GENERIC_TERMS.has(tag) || (featureDocumentFrequency.get(tag) || 0) > maxDocumentFrequency || (support.get(tag) || 0) < 2) continue;
      scores.set(tag, (scores.get(tag) || 0) + 4 / Math.max(1, featureDocumentFrequency.get(tag) || 1));
    }
    for (const feature of member.rareFeatures) {
      if ((support.get(feature) || 0) < 2) continue;
      scores.set(feature, (scores.get(feature) || 0) + 1 / Math.max(1, featureDocumentFrequency.get(feature) || 1));
    }
  }
  return [...scores.entries()]
    .filter(([feature]) => feature.length >= 2 && !feature.startsWith('date:'))
    .sort((left, right) => right[1] - left[1] || right[0].length - left[0].length)
    .slice(0, 3)
    .map(([feature]) => feature)
    .join(' · ') || '待确认记忆组';
}

function groupComponents(unionFind, memories) {
  const groups = new Map();
  memories.forEach((memory, index) => {
    const root = unionFind.find(index);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(memory);
  });
  return [...groups.values()];
}

function buildMemoryOrganizationPreview(rawMemories, inputOptions = {}) {
  const options = { ...DEFAULT_OPTIONS, ...inputOptions };
  const source = rawMemories && typeof rawMemories[Symbol.iterator] === 'function' ? rawMemories : [];
  const memories = [];
  let index = 0;
  for (const row of source) {
    const tags = (Array.isArray(row.tags) ? row.tags : safeJsonParse(row.tags, []))
      .map(normalizeFeature)
      .filter(tag => tag.length >= 2 && !GENERIC_TERMS.has(tag));
    const textFeatures = extractTextFeatures(row.content);
    const dateKeys = extractDateKeys(row.content);
    const dateCandidateFeatures = dateKeys.map(key => `date:${key.slice(-5)}`);
    memories.push({
      index,
      id: String(row.id),
      chatId: String(row.chatId || ''),
      content: String(row.content || ''),
      category: String(row.category || 'E'),
      importance: Number(row.importance || 0),
      emotionalWeight: Number(row.emotionalWeight || 0),
      timestamp: normalizeTimestamp(row.memoryTime || row.createdAt),
      dates: new Set(dateKeys),
      tags: [...new Set(tags)],
      features: new Set([...tags, ...dateCandidateFeatures, ...textFeatures]),
      embedding: buildEmbeddingSample(row.embedding, options.embeddingSampleSize)
    });
    index += 1;
  }

  const featureDocumentFrequency = new Map();
  for (const memory of memories) {
    for (const feature of memory.features) {
      featureDocumentFrequency.set(feature, (featureDocumentFrequency.get(feature) || 0) + 1);
    }
  }
  const maxDocumentFrequency = Math.max(2, Math.floor(memories.length * options.maxFeatureDocumentRatio));
  for (const memory of memories) {
    memory.rareFeatures = new Set([...memory.features]
      .filter(feature => (featureDocumentFrequency.get(feature) || 0) <= maxDocumentFrequency)
      .sort((left, right) => {
        const leftTag = memory.tags.includes(left) ? 1 : 0;
        const rightTag = memory.tags.includes(right) ? 1 : 0;
        return rightTag - leftTag ||
          (featureDocumentFrequency.get(left) || 0) - (featureDocumentFrequency.get(right) || 0) ||
          right.length - left.length;
      })
      .slice(0, options.maxFeaturesPerMemory));
  }

  const featureBuckets = new Map();
  for (const memory of memories) {
    for (const feature of memory.rareFeatures) {
      if (!featureBuckets.has(feature)) featureBuckets.set(feature, []);
      const bucket = featureBuckets.get(feature);
      if (bucket.length < options.maxBucketSize) bucket.push(memory.index);
    }
  }

  const pairSignals = new Map();
  for (const [feature, bucket] of featureBuckets) {
    if (bucket.length < 2) continue;
    const featureWeight = 1 / Math.max(1, featureDocumentFrequency.get(feature) || 1);
    for (let leftIndex = 0; leftIndex < bucket.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < bucket.length; rightIndex += 1) {
        const left = bucket[leftIndex];
        const right = bucket[rightIndex];
        if (memories[left].chatId !== memories[right].chatId) continue;
        if (memories[left].category === 'C' || memories[right].category === 'C') continue;
        const key = `${left}:${right}`;
        const existing = pairSignals.get(key);
        if (!existing && pairSignals.size >= options.maxCandidatePairs) continue;
        const current = existing || { left, right, sharedFeatures: 0, rarityScore: 0 };
        current.sharedFeatures += 1;
        current.rarityScore += featureWeight;
        pairSignals.set(key, current);
      }
    }
  }

  const perMemoryPairs = new Map();
  for (const pair of pairSignals.values()) {
    for (const index of [pair.left, pair.right]) {
      if (!perMemoryPairs.has(index)) perMemoryPairs.set(index, []);
      perMemoryPairs.get(index).push(pair);
    }
  }
  const retainedPairKeys = new Set();
  for (const pairs of perMemoryPairs.values()) {
    pairs
      .sort((left, right) => right.sharedFeatures - left.sharedFeatures || right.rarityScore - left.rarityScore)
      .slice(0, options.maxCandidatesPerMemory)
      .forEach(pair => retainedPairKeys.add(`${pair.left}:${pair.right}`));
  }

  const eventUnion = new UnionFind(memories.length);
  const topicUnion = new UnionFind(memories.length);
  const acceptedPairs = [];
  for (const key of retainedPairKeys) {
    const pair = pairSignals.get(key);
    const left = memories[pair.left];
    const right = memories[pair.right];
    const semantic = cosineSample(left.embedding, right.embedding);
    const sharedTags = intersectionCount(new Set(left.tags), new Set(right.tags));
    const dateConflict = left.dates.size > 0 && right.dates.size > 0 && !dateKeysCompatible(left.dates, right.dates);
    const timeDistance = left.timestamp && right.timestamp ? Math.abs(left.timestamp - right.timestamp) : null;
    const temporallyClose = timeDistance !== null && timeDistance <= options.eventWindowMs;
    const semanticValue = semantic === null ? 0 : semantic;
    const lexicalStrength = Math.min(1, pair.sharedFeatures / 4);
    const topicScore = semantic === null
      ? 0.55 * lexicalStrength + 0.15 * Math.min(1, sharedTags)
      : 0.78 * semanticValue + 0.14 * lexicalStrength + 0.08 * Math.min(1, sharedTags);
    const eventScore = topicScore + (temporallyClose ? 0.08 : 0) + (sharedTags > 0 ? 0.04 : 0);
    const topicAccepted = topicScore >= options.topicSimilarityFloor && (pair.sharedFeatures >= 2 || sharedTags > 0);
    const eventAccepted = !dateConflict && eventScore >= options.eventSimilarityFloor &&
      (temporallyClose || semanticValue >= options.nearDuplicateFloor) &&
      (pair.sharedFeatures >= 2 || sharedTags > 0);

    if (topicAccepted) topicUnion.union(pair.left, pair.right);
    if (eventAccepted) eventUnion.union(pair.left, pair.right);
    if (topicAccepted || eventAccepted) {
      acceptedPairs.push({
        leftId: left.id,
        rightId: right.id,
        semantic: semantic === null ? null : Number(semantic.toFixed(4)),
        sharedFeatures: pair.sharedFeatures,
        sharedTags,
        dateConflict,
        temporallyClose,
        topicScore: Number(topicScore.toFixed(4)),
        eventScore: Number(eventScore.toFixed(4)),
        topicAccepted,
        eventAccepted
      });
    }
  }

  const splitEventDateConflicts = group => {
    const datedMembers = group.filter(member => member.dates.size > 0);
    if (datedMembers.length <= 1 || datedMembers.every(member => dateKeysCompatible(datedMembers[0].dates, member.dates))) return [group];
    const datedBuckets = [];
    const undated = [];
    for (const member of group) {
      if (member.dates.size === 0) {
        undated.push(member);
        continue;
      }
      const compatibleBucket = datedBuckets.find(bucket =>
        bucket.every(candidate => dateKeysCompatible(candidate.dates, member.dates))
      );
      if (compatibleBucket) compatibleBucket.push(member);
      else datedBuckets.push([member]);
    }
    const buckets = datedBuckets;
    const remainingUndated = [];
    for (const member of undated) {
      let bestBucket = null;
      let bestDistance = Number.POSITIVE_INFINITY;
      if (member.timestamp) {
        for (const bucket of buckets) {
          const distances = bucket
            .map(candidate => candidate.timestamp ? Math.abs(candidate.timestamp - member.timestamp) : Number.POSITIVE_INFINITY);
          const distance = Math.min(...distances);
          if (distance < bestDistance) {
            bestDistance = distance;
            bestBucket = bucket;
          }
        }
      }
      if (bestBucket && bestDistance <= options.eventWindowMs) bestBucket.push(member);
      else remainingUndated.push(member);
    }
    if (remainingUndated.length > 0) buckets.push(remainingUndated);
    return buckets.filter(bucket => bucket.length > 0);
  };

  const buildClusters = (kind, unionFind) => groupComponents(unionFind, memories)
    .filter(group => group.length >= 2)
    .flatMap(group => kind === 'event' ? splitEventDateConflicts(group) : [group])
    .filter(group => group.length >= 2)
    .flatMap(group => {
      const chunks = [];
      const maxSize = kind === 'topic' ? options.topicMaxMembers : group.length;
      for (let index = 0; index < group.length; index += maxSize) chunks.push(group.slice(index, index + maxSize));
      return chunks;
    })
    .map(group => {
      const sorted = [...group].sort((left, right) =>
        right.importance - left.importance || right.emotionalWeight - left.emotionalWeight || left.index - right.index
      );
      const representative = sorted[0];
      const memberIds = group.map(member => member.id);
      const times = group.map(member => member.timestamp).filter(Boolean);
      return {
        id: stableId(kind === 'event' ? 'event' : 'topic', memberIds, options.algorithmVersion),
        chatId: representative.chatId,
        kind,
        title: selectClusterLabel(group, featureDocumentFrequency, maxDocumentFrequency),
        summary: `预览分组，共 ${group.length} 条原始记忆；尚未人工确认。`,
        representativeMemoryId: representative.id,
        status: 'preview',
        confidence: Number(Math.min(0.99, 0.6 + Math.log2(group.length) * 0.05).toFixed(4)),
        timeStart: times.length ? Math.min(...times) : null,
        timeEnd: times.length ? Math.max(...times) : null,
        algorithmVersion: options.algorithmVersion,
        members: group.map(member => ({
          memoryId: member.id,
          membershipRole: member.id === representative.id ? 'representative' : 'member',
          confidence: member.id === representative.id ? 1 : 0.8,
          reason: kind === 'event' ? 'preview_event_similarity' : 'preview_topic_similarity',
          source: 'auto_preview'
        }))
      };
    });

  const eventClusters = buildClusters('event', eventUnion);
  const topicClusters = buildClusters('topic', topicUnion);
  const eventByMemory = new Map();
  for (const cluster of eventClusters) {
    for (const member of cluster.members) eventByMemory.set(member.memoryId, cluster.id);
  }
  const topicMembershipCount = new Map();
  for (const cluster of topicClusters) {
    for (const member of cluster.members) {
      topicMembershipCount.set(member.memoryId, (topicMembershipCount.get(member.memoryId) || 0) + 1);
    }
  }
  const organizations = memories.map(memory => {
    if (memory.category === 'C') {
      return {
        memoryId: memory.id,
        chatId: memory.chatId,
        status: 'preview_protected_core',
        primaryEventClusterId: null,
        confidence: 1,
        reason: 'core_memory_not_auto_clustered',
        algorithmVersion: options.algorithmVersion
      };
    }
    const primaryEventClusterId = eventByMemory.get(memory.id) || null;
    const topicCount = topicMembershipCount.get(memory.id) || 0;
    const clustered = Boolean(primaryEventClusterId || topicCount > 0);
    return {
      memoryId: memory.id,
      chatId: memory.chatId,
      status: clustered ? 'preview_clustered' : 'preview_independent',
      primaryEventClusterId,
      confidence: clustered ? 0.8 : 0.65,
      reason: clustered ? 'preview_similarity_evidence' : 'no_reliable_cluster_candidate',
      algorithmVersion: options.algorithmVersion
    };
  });

  return {
    algorithmVersion: options.algorithmVersion,
    behaviorChanged: false,
    sourceMemoryCount: memories.length,
    processedCount: memories.length,
    clusteredCount: organizations.filter(item => item.status === 'preview_clustered').length,
    independentCount: organizations.filter(item => ['preview_independent', 'preview_protected_core'].includes(item.status)).length,
    eventClusters,
    topicClusters,
    organizations,
    diagnostics: {
      featureCount: featureDocumentFrequency.size,
      candidatePairCount: retainedPairKeys.size,
      acceptedPairCount: acceptedPairs.length,
      acceptedPairs
    }
  };
}

module.exports = {
  DEFAULT_OPTIONS,
  buildMemoryOrganizationPreview,
  cosineSample,
  extractDateKeys,
  extractTextFeatures
};
