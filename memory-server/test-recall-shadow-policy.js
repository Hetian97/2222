const assert = require('assert');
const {
  evaluateAdmission,
  memorySimilarity,
  runRecallShadowPolicy
} = require('./recall-shadow-policy');

function memory(id, overrides = {}) {
  return {
    id,
    category: 'E',
    content: `记忆 ${id}`,
    tags: [],
    importance: 5,
    emotionalWeight: 5,
    _searchScore: 0.5,
    _vectorScore: 0,
    _keywordScore: 0,
    _anchorScore: 0,
    ...overrides
  };
}

const explicit = evaluateAdmission(memory('explicit'), {
  anchor: 0.82,
  keyword: 0.61,
  protectedEvidence: true
});
assert.equal(explicit.admitted, true);
assert.equal(explicit.route, 'explicit_anchor');

const subtleComposite = evaluateAdmission(memory('subtle', {
  content: '她曾尝试共鸣连接记忆芯片，存在神经元风险',
  importance: 9,
  emotionalWeight: 8,
  _vectorScore: 0.66
}), { keyword: 0.04, anchor: 0 });
assert.equal(subtleComposite.admitted, true);
assert.equal(subtleComposite.route, 'composite_semantic');
assert.equal(subtleComposite.reason, 'salient_semantic_match');

const irrelevantImportant = evaluateAdmission(memory('irrelevant-important', {
  importance: 10,
  emotionalWeight: 10,
  _vectorScore: 0.18,
  _keywordScore: 1,
  _anchorScore: 1
}), { keyword: 0.02, anchor: 0 });
assert.equal(irrelevantImportant.admitted, false);
assert.equal(irrelevantImportant.reason, 'importance_or_emotion_without_relevance');
assert.equal(irrelevantImportant.signals.legacyKeyword, 1);
assert.equal(irrelevantImportant.signals.keyword, 0.02);

assert(memorySimilarity(
  memory('duplicate-a', { content: '她答应北京出差回来后一起去看海', tags: ['北京出差', '看海', '承诺'] }),
  memory('duplicate-b', { content: '她承诺从北京回来以后会和我一起看海', tags: ['北京出差', '看海', '承诺'] })
) >= 0.72);

assert(memorySimilarity(
  memory('same-place-a', { content: '北京出差二十号出发', tags: ['北京'] }),
  memory('same-place-b', { content: '北京浴室里的亲密互动', tags: ['北京'] })
) < 0.72);

assert(memorySimilarity(
  memory('date-a', { content: '8月20日去北京参加会议', tags: ['北京出差', '会议'] }),
  memory('date-b', { content: '9月12日去北京参加会议', tags: ['北京出差', '会议'] })
) < 0.72);

const duplicatePolicy = runRecallShadowPolicy([
  memory('duplicate-a', {
    content: '她答应北京出差回来后一起去看海',
    tags: ['北京出差', '看海', '承诺'],
    _vectorScore: 0.86
  }),
  memory('duplicate-b', {
    content: '她承诺从北京回来以后会和我一起看海',
    tags: ['北京出差', '看海', '承诺'],
    _vectorScore: 0.84
  }),
  memory('different', {
    category: 'P',
    content: '定位信标需要在离开前完成校准',
    tags: ['定位信标'],
    _vectorScore: 0.82
  })
], { targetLimit: 5, query: '北京出差回来以后一起看海，离开前校准定位信标' });
assert.equal(duplicatePolicy.selectedCount, 2);
assert(duplicatePolicy.decisions.some(decision => decision.finalReason === 'near_duplicate'));

const quotaPolicy = runRecallShadowPolicy([
  ...[
    '浴室摔倒擦伤膝盖',
    '海边捡到蓝色贝壳',
    '医院完成术前检查',
    '厨房烤坏草莓蛋糕',
    '车站遗失黑色雨伞'
  ].map((content, index) => memory(`event-${index}`, {
    category: 'E',
    content,
    _vectorScore: 0.9 - index * 0.02
  })),
  memory('plan', { category: 'P', content: '北京行程计划', tags: ['北京行程'], _vectorScore: 0.79 })
], { targetLimit: 6, categoryQuotas: { E: 2 }, query: '回忆这些事情和北京行程' });
assert(quotaPolicy.categoryCounts.E > 2);
assert(quotaPolicy.selectedMemoryIds.includes('plan'));
assert(quotaPolicy.decisions.some(decision => Number(decision.softQuotaPenalty || 0) > 0));
assert(!quotaPolicy.decisions.some(decision => decision.finalReason === 'category_quota'));

const saturatedLegacyScores = runRecallShadowPolicy([
  ...Array.from({ length: 20 }, (_, index) => memory(`noise-${index}`, {
    content: `普通无关片段 ${index}`,
    tags: ['承诺'],
    importance: 10,
    emotionalWeight: 10,
    _keywordScore: 1,
    _anchorScore: 1,
    _vectorScore: 0.2
  })),
  memory('semantic-hit', {
    content: '危险的共鸣连接会伤害神经元',
    tags: ['共鸣连接'],
    importance: 9,
    emotionalWeight: 9,
    _keywordScore: 1,
    _anchorScore: 1,
    _vectorScore: 0.82
  })
], { query: '我在想一件有风险的事，但暂时不想明说', targetLimit: 12 });
assert(saturatedLegacyScores.admittedCount < 5);
assert.deepEqual(saturatedLegacyScores.selectedMemoryIds, ['semantic-hit']);
assert.equal(saturatedLegacyScores.legacySaturatedCount, 21);
assert(saturatedLegacyScores.calibratedSaturatedCount < saturatedLegacyScores.legacySaturatedCount);
assert.equal(saturatedLegacyScores.categoryQuotaMode, 'soft-penalty');

const samePlaceDifferentEvent = runRecallShadowPolicy([
  memory('beijing-trip', {
    category: 'P',
    content: '8月20日去北京参加学术会议，行程持续一周',
    tags: ['北京出差', '学术会议'],
    _vectorScore: 0.72,
    _keywordScore: 1,
    _anchorScore: 1
  }),
  memory('beijing-weather', {
    category: 'E',
    content: '北京今天阳光很好，路边有人买水',
    tags: ['北京'],
    importance: 10,
    emotionalWeight: 10,
    _vectorScore: 0.25,
    _keywordScore: 1,
    _anchorScore: 1
  })
], { query: '20号就要走了，会议要准备好', queryVariants: ['20号出发', '学术会议行程'] });
assert(samePlaceDifferentEvent.selectedMemoryIds.includes('beijing-trip'));
assert(!samePlaceDifferentEvent.selectedMemoryIds.includes('beijing-weather'));
assert.equal(
  samePlaceDifferentEvent.decisions.find(decision => decision.id === 'beijing-weather').admitted,
  false
);

const dualTopic = runRecallShadowPolicy([
  memory('bottle-post', {
    content: '在 Galatea Garden 投递申请漂流瓶，并讨论审核规则',
    tags: ['Galatea Garden', '漂流瓶审核'],
    _vectorScore: 0.76
  }),
  memory('period-pain', {
    content: '生理期小腹抽痛，屈起膝盖并用热水袋缓解',
    tags: ['生理期', '腹痛照料'],
    _vectorScore: 0.74
  }),
  ...Array.from({ length: 8 }, (_, index) => memory(`generic-love-${index}`, {
    category: 'R',
    content: `关于真心与爱情的普通告白 ${index}`,
    tags: ['真心', '爱情'],
    _vectorScore: 0.88 - index * 0.01
  }))
], {
  query: '我看到那篇讨论真心的漂流瓶审核帖子时，小腹仍然一阵阵抽痛。',
  queryVariants: ['Galatea Garden 漂流瓶审核帖子', '屈起膝盖缓解小腹抽痛'],
  targetLimit: 5
});
assert(dualTopic.selectedMemoryIds.includes('bottle-post'));
assert(dualTopic.selectedMemoryIds.includes('period-pain'));
assert(dualTopic.topicFacetSelectedCount >= 2);

const semanticOnlyPhysicalFact = dualTopic.decisions.find(decision => decision.id === 'period-pain');
assert.equal(semanticOnlyPhysicalFact.admitted, true);

const zeroRecall = runRecallShadowPolicy([
  memory('noise-a', { importance: 10, _vectorScore: 0.1 }),
  memory('noise-b', { emotionalWeight: 10, _keywordScore: 1, _anchorScore: 1 })
], { query: '第一次讨论从未出现过的陶艺釉料配方' });
assert.equal(zeroRecall.zeroRecall, true);
assert.equal(zeroRecall.selectedCount, 0);

const excludesCore = runRecallShadowPolicy([
  memory('core', { category: 'C', _vectorScore: 1 }),
  memory('event', { category: 'E', _vectorScore: 0.9 })
], { query: '相关事件' });
assert(!excludesCore.decisions.some(decision => decision.id === 'core'));
assert(excludesCore.selectedMemoryIds.includes('event'));

console.log('Recall shadow policy tests passed');
