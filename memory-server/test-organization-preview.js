const assert = require('assert');

const {
  buildMemoryOrganizationPreview,
  extractDateKeys,
  classifyClusterSubtype
} = require('./memory-organization-preview');

function vector(seed, size = 384) {
  const values = [];
  for (let index = 0; index < size; index += 1) {
    values.push(Math.sin(seed + index * 0.017) + Math.cos(seed * 0.3 + index * 0.011));
  }
  return values;
}

function memory(id, content, tags, embedding, memoryTime, overrides = {}) {
  return {
    id,
    chatId: overrides.chatId || 'chat-1',
    content,
    tags: JSON.stringify(tags),
    embedding: JSON.stringify(embedding),
    memoryTime: String(memoryTime),
    category: overrides.category || 'E',
    importance: overrides.importance || 5,
    emotionalWeight: overrides.emotionalWeight || 5
  };
}

const day = 24 * 60 * 60 * 1000;
const base = Date.UTC(2026, 7, 1);
const starVector = vector(1);
const knotVector = vector(7);
const noiseVector = vector(30);

const preview = buildMemoryOrganizationPreview([
  memory('stars-a', '2026年8月1日在露台看星星，喝了气泡水。', ['露台', '看星星', '夏以昼'], starVector, base),
  memory('stars-b', '那晚在露台看星星时突然来了生理期。', ['露台', '看星星', '阿鹤'], starVector.map((value, index) => value + Math.sin(index) * 0.002), base + day),
  memory('stars-shortdate', '8月1日的露台星空很亮。', ['露台', '看星星'], starVector, base),
  memory('stars-other-date', '2026年8月20日又在露台看星星。', ['露台', '看星星'], starVector, base + 19 * day),
  memory('knot-a', '买回来的中国结尺寸太大，不懂装饰的留白。', ['中国结', '留白'], knotVector, base + 2 * day),
  memory('knot-b', '后来又吐槽中国结太大，挂起来没有留白。', ['中国结', '留白'], knotVector.map(value => value * 0.999), base + 3 * day),
  memory('noise', '在厨房整理普通餐具。', ['厨房'], noiseVector, base + 2 * day, { importance: 10, emotionalWeight: 10 }),
  memory('core', '角色的核心安全边界。', ['安全边界'], starVector, base, { category: 'C' }),
  memory('other-chat', '在露台看星星。', ['露台', '看星星'], starVector, base, { chatId: 'chat-2' })
], {
  algorithmVersion: 'organization-preview-test-v1',
  maxFeatureDocumentRatio: 0.5
});

assert.equal(preview.behaviorChanged, false);
assert.equal(preview.sourceMemoryCount, 9);
assert.equal(preview.processedCount, 9);
assert.equal(preview.organizations.length, 9);

const starEvent = preview.eventClusters.find(cluster =>
  cluster.members.some(member => member.memoryId === 'stars-a')
);
assert(starEvent, 'same star-gazing episode should form an event preview');
assert(starEvent.members.some(member => member.memoryId === 'stars-b'));
assert(starEvent.members.some(member => member.memoryId === 'stars-shortdate'), 'full and short forms of the same date should remain compatible');
assert(!starEvent.members.some(member => member.memoryId === 'stars-other-date'), 'different explicit dates must not be folded into one event');
assert(!starEvent.members.some(member => member.memoryId === 'other-chat'), 'different chats must never share a cluster');

const knotCluster = preview.topicClusters.find(cluster =>
  cluster.members.some(member => member.memoryId === 'knot-a')
);
assert(knotCluster, 'related knot memories should form a topic preview');
assert(knotCluster.members.some(member => member.memoryId === 'knot-b'));
assert(!knotCluster.members.some(member => member.memoryId === 'noise'));

const coreStatus = preview.organizations.find(item => item.memoryId === 'core');
assert.equal(coreStatus.status, 'preview_protected_core');
assert.equal(coreStatus.primaryEventClusterId, null);
assert(!preview.eventClusters.some(cluster => cluster.members.some(member => member.memoryId === 'core')));
assert(!preview.topicClusters.some(cluster => cluster.members.some(member => member.memoryId === 'core')));

const noiseStatus = preview.organizations.find(item => item.memoryId === 'noise');
assert.equal(noiseStatus.status, 'preview_independent', 'importance and emotion alone must not create a cluster');

assert.deepEqual(extractDateKeys('2026年8月1日和8月20日'), ['2026-08-01', '08-20']);
assert.deepEqual(extractDateKeys('3月11日、3月18日、七月七日和十一月二十日'), ['03-11', '03-18', '07-07', '11-20']);
assert(preview.eventClusters.every(cluster => cluster.status === 'preview'));
assert(preview.topicClusters.every(cluster => cluster.status === 'preview'));
assert(!preview.eventClusters.some(cluster => /夏以昼|阿鹤|夏太太/.test(cluster.title)), 'ubiquitous participant labels should not dominate titles');

const scaleStart = Date.now();
const scaleMemories = Array.from({ length: 4274 }, (_, index) => {
  const topic = index % 100;
  const episode = Math.floor(index / 100);
  return memory(
    `scale-${index}`,
    `第${episode}段日常记录，包含主题物品${topic}和独立细节${index}。`,
    [`主题物品${topic}`, '共同参与者'],
    vector(topic + 1, 192),
    base + episode * day
  );
});
const scalePreview = buildMemoryOrganizationPreview(scaleMemories, {
  algorithmVersion: 'organization-preview-scale-test-v1'
});
assert.equal(scalePreview.processedCount, 4274);
assert.equal(scalePreview.organizations.length, 4274);
assert(scalePreview.diagnostics.candidatePairCount <= 500000);
assert(Date.now() - scaleStart < 20000, '4,274-memory preview should remain bounded');

const chainVectorA = vector(40);
const chainVectorB = chainVectorA.map((value, index) => value + Math.sin(index * 0.2) * 0.05);
const chainVectorC = vector(44);
const chainPreview = buildMemoryOrganizationPreview([
  memory('chain-a', '早餐时讨论论文监督安排。', ['早餐', '论文监督'], chainVectorA, base),
  memory('chain-b', '早餐后又谈到论文和工作。', ['早餐', '论文', '工作'], chainVectorB, base + day),
  memory('chain-c', '工作结束后讨论婚姻承诺。', ['工作', '婚姻承诺'], chainVectorC, base + 2 * day)
], {
  algorithmVersion: 'organization-preview-chain-test-v2',
  maxFeatureDocumentRatio: 1,
  topicSimilarityFloor: 0.5,
  topicCompleteLinkFloor: 0.7
});
assert(!chainPreview.topicClusters.some(cluster => cluster.members.length === 3), 'single-link bridges must not merge incoherent endpoints');

const repeatPreview = buildMemoryOrganizationPreview([
  memory('repeat-a', '3月1日早餐吃了三文鱼。', ['早餐', '三文鱼'], starVector, base),
  memory('repeat-b', '3月20日早餐又吃了三文鱼。', ['早餐', '三文鱼'], starVector, base + 19 * day)
], {
  algorithmVersion: 'organization-preview-repeat-test-v2',
  maxFeatureDocumentRatio: 1
});
assert.equal(repeatPreview.eventClusters.length, 0, 'repeated routines outside the event span must not become one event');
assert.equal(repeatPreview.topicClusters.length, 1, 'repeated routines may remain a coherent topic');

for (const cluster of [...preview.eventClusters, ...preview.topicClusters]) {
  assert(cluster.confidence >= 0 && cluster.confidence <= 0.99);
  assert(['candidate'].includes(cluster.subtypeStatus));
  assert(cluster.subtypeConfidence >= 0 && cluster.subtypeConfidence <= 0.95);
}

const typeMember = (content, timestamp, dates = []) => ({ content, timestamp, dates: new Set(dates) });
assert.equal(classifyClusterSubtype('topic', [
  typeMember('每天都会重复做同一件事。', base, ['2026-08-01']),
  typeMember('每次都会按相同方式完成。', base + 20 * day, ['2026-08-21'])
], 0.9).subtype, 'habit_candidate');
assert.equal(classifyClusterSubtype('topic', [
  typeMember('目前一直住在这里。', base),
  typeMember('长期居住地点保持不变。', base + day)
], 0.9).subtype, 'stable_fact_candidate');
assert.equal(classifyClusterSubtype('event', [
  typeMember('这几天持续处理同一件事。', base),
  typeMember('第二天仍在继续处理。', base + 2 * day)
], 0.9).subtype, 'ongoing_episode_candidate');
assert.equal(classifyClusterSubtype('event', [
  typeMember('8月1日当天发生了一件事。', base, ['08-01']),
  typeMember('那晚事情结束。', base, ['08-01'])
], 0.9).subtype, 'event_candidate');
assert.equal(classifyClusterSubtype('event', [
  typeMember('讨论了一个概念。', base),
  typeMember('又提到相关概念。', base + 10 * day)
], 0.8).subtype, 'type_uncertain');

console.log('Memory organization preview tests passed');
