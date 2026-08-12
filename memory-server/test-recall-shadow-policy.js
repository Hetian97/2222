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

const explicit = evaluateAdmission(memory('explicit', {
  content: '北京学术出差将在二十号出发',
  _anchorScore: 0.82,
  _anchorMatchedTerm: 'trip',
  _anchorMatchedCount: 1,
  _normalizedQueryLength: 10,
  _keywordScore: 0.61
}));
assert.equal(explicit.admitted, true);
assert.equal(explicit.route, 'explicit_anchor');

const exactTwoCharacterAnchor = evaluateAdmission(memory('exact-two-character-anchor', {
  _anchorScore: 0.9,
  _anchorMatchedTerm: 'xx',
  _anchorMatchedCount: 1,
  _normalizedQueryLength: 2,
  _keywordScore: 0.9
}));
assert.equal(exactTwoCharacterAnchor.admitted, true);

const subtleComposite = evaluateAdmission(memory('subtle', {
  content: '她曾尝试共鸣连接记忆芯片，存在神经元风险',
  importance: 9,
  emotionalWeight: 8,
  _vectorScore: 0.61,
  _keywordScore: 0.04
}));
assert.equal(subtleComposite.admitted, true);
assert.equal(subtleComposite.route, 'composite_semantic');
assert.equal(subtleComposite.reason, 'multi_signal_semantic_match');

const irrelevantImportant = evaluateAdmission(memory('irrelevant-important', {
  importance: 10,
  emotionalWeight: 10,
  _vectorScore: 0.18,
  _keywordScore: 0.02
}));
assert.equal(irrelevantImportant.admitted, false);
assert.equal(irrelevantImportant.reason, 'importance_or_emotion_without_relevance');

assert(memorySimilarity(
  memory('duplicate-a', { content: '她答应北京出差回来后一起去看海', tags: ['北京出差', '看海', '承诺'] }),
  memory('duplicate-b', { content: '她承诺从北京回来以后会和我一起看海', tags: ['北京出差', '看海', '承诺'] })
) >= 0.72);

assert(memorySimilarity(
  memory('same-place-a', { content: '北京出差二十号出发', tags: ['北京'] }),
  memory('same-place-b', { content: '北京浴室里的亲密互动', tags: ['北京'] })
) < 0.72);

const duplicatePolicy = runRecallShadowPolicy([
  memory('duplicate-a', {
    content: '她答应北京出差回来后一起去看海',
    tags: ['北京出差', '看海', '承诺'],
    _anchorScore: 0.9,
    _anchorMatchedTerm: 'trip',
    _anchorMatchedCount: 1,
    _normalizedQueryLength: 10,
    _keywordScore: 0.7
  }),
  memory('duplicate-b', {
    content: '她承诺从北京回来以后会和我一起看海',
    tags: ['北京出差', '看海', '承诺'],
    _anchorScore: 0.8,
    _anchorMatchedTerm: 'trip',
    _anchorMatchedCount: 1,
    _normalizedQueryLength: 10,
    _keywordScore: 0.65
  }),
  memory('different', {
    category: 'P',
    content: '定位信标需要在离开前完成校准',
    _vectorScore: 0.82
  })
], { targetLimit: 5 });
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
  memory('plan', { category: 'P', content: '北京行程计划', _vectorScore: 0.79 })
], { targetLimit: 6, categoryQuotas: { E: 2 } });
assert.equal(quotaPolicy.categoryCounts.E, 2);
assert(quotaPolicy.selectedMemoryIds.includes('plan'));
assert(quotaPolicy.decisions.some(decision => decision.finalReason === 'category_quota'));

const zeroRecall = runRecallShadowPolicy([
  memory('noise-a', { importance: 10, _vectorScore: 0.1 }),
  memory('noise-b', { emotionalWeight: 10, _keywordScore: 0.04 })
]);
assert.equal(zeroRecall.zeroRecall, true);
assert.equal(zeroRecall.selectedCount, 0);

const excludesCore = runRecallShadowPolicy([
  memory('core', { category: 'C', _vectorScore: 1 }),
  memory('event', { category: 'E', _vectorScore: 0.9 })
]);
assert(!excludesCore.decisions.some(decision => decision.id === 'core'));
assert(excludesCore.selectedMemoryIds.includes('event'));

console.log('Recall shadow policy tests passed');
