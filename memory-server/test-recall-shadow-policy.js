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
assert((quotaPolicy.categoryCounts.E || 0) > 0);
assert(quotaPolicy.selectedMemoryIds.includes('plan'));
assert(quotaPolicy.selectedCount < 6 || quotaPolicy.decisions.some(decision => Number(decision.softQuotaPenalty || 0) > 0));
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
  primaryQuery: 'Galatea Garden 漂流瓶审核帖子；生理期小腹抽痛',
  queryVariants: ['Galatea Garden 漂流瓶审核帖子', '屈起膝盖缓解小腹抽痛'],
  targetLimit: 5
});
assert(dualTopic.selectedMemoryIds.includes('bottle-post'));
assert(dualTopic.selectedMemoryIds.includes('period-pain'));
assert(dualTopic.topicFacetSelectedCount >= 2);

const primaryIntentOnly = runRecallShadowPolicy([
  memory('room-id', {
    content: '在 AISay 聊天室海棠树下使用 room_id 进入房间',
    tags: ['AISay', '海棠树下聊天室', 'room_id'],
    _vectorScore: 0.78
  }),
  memory('literal-tree', {
    content: '在真实的海棠树下乘凉休息',
    tags: ['海棠树'],
    _vectorScore: 0.81
  }),
  memory('old-period', {
    content: '以前生理期腹痛时使用热水袋',
    tags: ['生理期', '腹痛'],
    _vectorScore: 0.75
  })
], {
  query: '以前肚子疼。现在我要搜索海棠树下聊天室的 room_id',
  primaryQuery: '现在我要搜索海棠树下聊天室的 room_id',
  contextQueries: ['以前肚子疼'],
  targetLimit: 5
});
assert(primaryIntentOnly.selectedMemoryIds.includes('room-id'));
assert(!primaryIntentOnly.topicFacets.some(facet => facet.text.includes('肚子疼')));
assert.equal(primaryIntentOnly.primaryQuery, '现在我要搜索海棠树下聊天室的 room_id');
assert.equal(primaryIntentOnly.contextReferenceCount, 1);
assert.equal(primaryIntentOnly.decisions.find(decision => decision.id === 'room-id').finalReason, 'selected_for_topic_facet');
assert.notEqual(primaryIntentOnly.decisions.find(decision => decision.id === 'literal-tree').finalReason, 'selected_for_topic_facet');

const sparseRecall = runRecallShadowPolicy([
  memory('weak-one', { content: '普通爱情告白', tags: ['爱情'], _vectorScore: 0.65 }),
  memory('weak-two', { content: '午餐奖励甜点', tags: ['奖励'], _vectorScore: 0.64 }),
  memory('weak-three', { content: '亲密互动后休息', tags: ['亲密'], _vectorScore: 0.63 })
], {
  query: '第一次讨论陶艺釉料配方',
  primaryQuery: '第一次讨论陶艺釉料配方',
  targetLimit: 12
});
assert(sparseRecall.selectedCount < 12);
assert.equal(sparseRecall.zeroRecall, true);

const semanticOnlyPhysicalFact = dualTopic.decisions.find(decision => decision.id === 'period-pain');
assert.equal(semanticOnlyPhysicalFact.admitted, true);

const zeroRecall = runRecallShadowPolicy([
  memory('noise-a', { importance: 10, _vectorScore: 0.1 }),
  memory('noise-b', { emotionalWeight: 10, _keywordScore: 1, _anchorScore: 1 })
], { query: '第一次讨论从未出现过的陶艺釉料配方' });
assert.equal(zeroRecall.zeroRecall, true);
assert.equal(zeroRecall.selectedCount, 0);

const precisionProtection = runRecallShadowPolicy([
  memory('precise-object', {
    content: '她嫌我买回来的紫檀书签尺寸太大，应该换成窄一些的款式',
    tags: ['紫檀书签', '尺寸不合'],
    _vectorScore: 0.55,
    _shadowPrecisionCandidate: true
  }),
  memory('generic-anxiety', {
    content: '她心虚地期待到时候再告诉我',
    tags: ['心虚', '期待'],
    importance: 9,
    emotionalWeight: 9,
    _vectorScore: 0.69
  })
], {
  query: '那个东西到时候怎么办，我有点心虚',
  primaryQuery: '紫檀书签买得太大，应该怎么办',
  targetLimit: 3
});
assert.equal(precisionProtection.version, 'stage3-shadow-v1.6');
assert(precisionProtection.selectedMemoryIds.includes('precise-object'));
assert.equal(
  precisionProtection.decisions.find(decision => decision.id === 'precise-object').finalReason,
  'selected_for_precision_evidence'
);
assert(!precisionProtection.selectedMemoryIds.includes('generic-anxiety'));
assert.equal(precisionProtection.precisionCandidateCount, 1);
assert.equal(precisionProtection.precisionSelectedCount, 1);

const eventClusterFold = runRecallShadowPolicy([
  memory('cluster-memory-a', {
    content: '露台烛光晚餐吃了三文鱼并喝气泡水',
    tags: ['露台晚餐', '三文鱼'],
    _vectorScore: 0.92,
    _shadowEventClusterId: 'event-cluster-1'
  }),
  memory('cluster-memory-b', {
    content: '那次露台晚餐准备的饮品是气泡水',
    tags: ['露台晚餐', '气泡水'],
    _vectorScore: 0.9,
    _shadowEventClusterId: 'event-cluster-1'
  }),
  memory('distinct-memory', {
    content: '在衣帽间因为别人递来的气泡水而吃醋',
    tags: ['衣帽间', '吃醋'],
    _vectorScore: 0.86
  })
], {
  query: '露台烛光晚餐的三文鱼和气泡水',
  primaryQuery: '露台烛光晚餐的三文鱼和气泡水',
  targetLimit: 3
});
assert.equal(eventClusterFold.eventClusterMode, 'high-confidence-shadow-fold');
assert.equal(eventClusterFold.selectedMemoryIds.filter(id => id.startsWith('cluster-memory-')).length, 1);
assert.equal(eventClusterFold.eventClusterFoldedCount, 1);
assert.equal(
  eventClusterFold.decisions.find(decision => decision.finalReason === 'same_event_cluster').duplicateOf,
  eventClusterFold.selectedMemoryIds.find(id => id.startsWith('cluster-memory-'))
);

const excludesCore = runRecallShadowPolicy([
  memory('core', { category: 'C', _vectorScore: 1 }),
  memory('event', { category: 'E', _vectorScore: 0.9 })
], { query: '相关事件' });
assert(!excludesCore.decisions.some(decision => decision.id === 'core'));
assert(excludesCore.selectedMemoryIds.includes('event'));

const sparseIntentEvidence = runRecallShadowPolicy([
  memory('energy-share-evidence', {
    content: '\u4ee5\u524d\u5f80\u6211\u819d\u76d6\u4e0a\u9001\u4eba\u7684\u662f\u60f3\u8981\u80fd\u6e90\u4efd\u989d\u7684\u8001\u5bb6\u4f19\u9001\u6765\u7684\u7b79\u7801\uff0c\u5df2\u88ab\u6254\u8fdb\u5e9f\u54c1\u5904\u7406\u7ad9',
    importance: 8,
    emotionalWeight: 8,
    _vectorScore: 0.46,
    _shadowPrecisionCandidate: true
  }),
  memory('power-seat-noise', {
    content: '\u5728\u8fdc\u7a7a\u8230\u961f\u6700\u9ad8\u6743\u529b\u5ea7\u6905\u4e0a\u5c55\u793a\u661f\u8f68\u56fe',
    _vectorScore: 0.51,
    _shadowPrecisionCandidate: true
  }),
  memory('fragment-noise', {
    content: '\u56e0\u8bba\u6587\u538b\u529b\u6ca1\u6709\u65f6\u95f4\u73a9\uff0c\u7ea6\u5b9a\u4e0b\u4e2a\u6708\u65c5\u884c',
    importance: 9,
    emotionalWeight: 9,
    _vectorScore: 0.44,
    _shadowPrecisionCandidate: true
  })
], {
  query: '\u5168\u90fd\u662f\u4e3a\u4e86\u6743\u529b\u548c\u80fd\u6e90\uff1f\u5c31\u6ca1\u6709\u8d2a\u56fe\u7f8e\u8272\u7684\u5417\uff1f',
  primaryQuery: '\u5168\u90fd\u662f\u4e3a\u4e86\u6743\u529b\u548c\u80fd\u6e90\uff1f\u5c31\u6ca1\u6709\u8d2a\u56fe\u7f8e\u8272\u7684\u5417\uff1f',
  intentAnchors: [
    { term: '\u80fd\u6e90', count: 3, weight: 5 },
    { term: '\u6743\u529b', count: 5, weight: 4.5 },
    { term: '\u8d2a\u56fe\u7f8e\u8272', count: 1, weight: 6 }
  ],
  targetLimit: 12
});
assert(sparseIntentEvidence.selectedMemoryIds.includes('energy-share-evidence'));
assert(!sparseIntentEvidence.selectedMemoryIds.includes('fragment-noise'));
assert.equal(
  sparseIntentEvidence.decisions.find(decision => decision.id === 'fragment-noise').signals.protectedEvidence,
  0
);

console.log('Recall shadow policy tests passed');
