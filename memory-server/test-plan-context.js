const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-plan-context-'));
process.env.MEMORY_DB_PATH = path.join(testDir, 'memory.db');

const {
  db,
  createMemorySearchLog,
  commitMemorySearchInjection,
  finishMemorySearchGeneration,
  applyMemoryActiveEventWrites,
  applyMemoryCurrentFactWrites,
  upsertMemoryActiveEvent,
  upsertMemoryCurrentFact,
  listMemoryActiveEvents,
  deleteMemoryActiveEvent,
  purgeFinishedMemoryActiveEvents,
  purgeMemoryActiveEvents,
  promoteMemoryCurrentFact,
  invalidateMemoryCurrentFact,
  deleteMemoryCurrentFact,
  listMemoryCurrentFacts,
  listActivePlanContext
} = require('./db');
const { runCurrentFactShadow } = require('./memory-current-fact-shadow');
const { runActiveEventExtractionShadow } = require('./memory-active-event-shadow');
const { resolveCrossDayWindow } = require('./memory-active-event-writer');

const privateUser = {
  type: 'private',
  sourceChatId: 'chat-1',
  mountedChatId: 'chat-1',
  latestSpeakerRole: 'user'
};

function succeededSearch(id, query, extra = {}) {
  const log = createMemorySearchLog({
    id,
    chatId: 'chat-1',
    source: '/memory/search',
    query,
    results: [],
    ...extra
  });
  commitMemorySearchInjection(log.id, []);
  finishMemorySearchGeneration(log.id, 'succeeded');
  return log.id;
}

try {
  // 1. 没有 chatId 时必须是空结构，而不是抛错
  const anonymous = listActivePlanContext({ chatId: '' });
  assert.strictEqual(anonymous.eventCount, 0);
  assert.strictEqual(anonymous.factCount, 0);
  assert.deepStrictEqual(anonymous.events, []);
  assert.deepStrictEqual(anonymous.facts, []);

  // 2. 事实层：走真实链路 shadow -> write -> 聚合
  const locationShadow = runCurrentFactShadow([], {
    query: '我现在在上海。',
    sourceScope: privateUser,
    writesEnabled: true
  });
  const factLogId = succeededSearch('plan-fact-1', '我现在在上海。', { currentFactShadow: locationShadow });
  const factWrite = applyMemoryCurrentFactWrites(factLogId, { writesEnabled: true });
  assert.strictEqual(factWrite.applied, true);
  assert.strictEqual(factWrite.facts[0].status, 'shadow_candidate');

  let context = listActivePlanContext({ chatId: 'chat-1' });
  // 关键：current facts 没有 promote 出口，聚合必须接受 shadow_candidate，
  // 否则这一层永远不会出现在提示词里。
  assert.strictEqual(context.factCount, 1);
  assert.strictEqual(context.facts[0].slotKey, 'user.location.current');
  assert.strictEqual(context.facts[0].value, '上海');
  assert.strictEqual(context.facts[0].status, 'shadow_candidate');
  assert.strictEqual(context.eventCount, 0);

  // 3. 同一 slotKey 只保留最新一条（避免「先在上海、后到杭州」两条同时常驻）
  upsertMemoryCurrentFact({
    id: 'fact-newer',
    chatId: 'chat-1',
    slotKey: 'user.location.current',
    value: '杭州',
    statement: '我现在在杭州。',
    status: 'shadow_candidate',
    confidence: 0.9,
    effectiveAt: Date.now() + 1000
  });
  context = listActivePlanContext({ chatId: 'chat-1' });
  assert.strictEqual(context.facts.length, 1);
  assert.strictEqual(context.facts[0].value, '杭州');

  // 4. 低置信度候选不得进入提示词
  upsertMemoryCurrentFact({
    id: 'fact-low-confidence',
    chatId: 'chat-1',
    slotKey: 'user.residence.current',
    value: '住在某处',
    statement: '我目前住在某处。',
    status: 'shadow_candidate',
    confidence: 0.5,
    effectiveAt: Date.now()
  });
  context = listActivePlanContext({ chatId: 'chat-1' });
  assert.ok(!context.facts.some(fact => fact.id === 'fact-low-confidence'));
  assert.strictEqual(context.facts.length, 1);

  // 5. 已作废的事实（superseded/archived 等）不得进入
  upsertMemoryCurrentFact({
    id: 'fact-superseded',
    chatId: 'chat-1',
    slotKey: 'user.trip.current',
    value: '在出差',
    statement: '我现在还在出差。',
    status: 'superseded',
    confidence: 0.95,
    effectiveAt: Date.now()
  });
  context = listActivePlanContext({ chatId: 'chat-1' });
  assert.ok(!context.facts.some(fact => fact.id === 'fact-superseded'));

  // 6. 计划层：走真实链路 extraction -> write -> 聚合
  const extraction = runActiveEventExtractionShadow([], {
    query: '我明天要去医院复诊。',
    timeZone: 'Asia/Shanghai',
    sourceScope: privateUser,
    writesEnabled: true
  });
  assert.strictEqual(extraction.proposalCount, 1);
  const eventLogId = succeededSearch('plan-event-1', '我明天要去医院复诊。', {
    activeEventShadow: { extraction, sourceScope: extraction.sourceScope, timeZone: 'Asia/Shanghai' }
  });
  const eventWrite = applyMemoryActiveEventWrites(eventLogId, { writesEnabled: true });
  assert.strictEqual(eventWrite.applied, true);
  assert.strictEqual(eventWrite.events.length, 1);
  assert.strictEqual(eventWrite.events[0].status, 'planned');

  context = listActivePlanContext({ chatId: 'chat-1' });
  assert.strictEqual(context.eventCount, 1);
  assert.strictEqual(context.events[0].status, 'planned');
  assert.ok(context.events[0].title.includes('复诊'));
  assert.ok(context.events[0].startAt > Date.now());
  // 聚合结果是要进提示词的，不得泄漏 evidence 等内部审计字段
  assert.ok(!('evidence' in context.events[0]));
  assert.ok(!('aliases' in context.events[0]));

  // 7. 已过期（validUntil 在过去）的事件必须被过滤掉：
  //    listMemoryActiveEvents 本身不按 validUntil 过滤，所以这是聚合层的职责。
  upsertMemoryActiveEvent({
    id: 'event-expired',
    chatId: 'chat-1',
    title: '上个月就该结束的会议',
    status: 'planned',
    startAt: Date.now() - 86400000 * 40,
    validUntil: Date.now() - 86400000 * 30
  });
  context = listActivePlanContext({ chatId: 'chat-1' });
  assert.ok(!context.events.some(event => event.id === 'event-expired'));

  // 8. 已完成 / 已取消的事件不得进入
  upsertMemoryActiveEvent({
    id: 'event-completed',
    chatId: 'chat-1',
    title: '已经做完的检查',
    status: 'completed',
    startAt: Date.now(),
    validUntil: Date.now() + 86400000
  });
  upsertMemoryActiveEvent({
    id: 'event-cancelled',
    chatId: 'chat-1',
    title: '已经取消的预约',
    status: 'cancelled',
    startAt: Date.now(),
    validUntil: Date.now() + 86400000
  });
  context = listActivePlanContext({ chatId: 'chat-1' });
  assert.strictEqual(context.eventCount, 1);

  // 9. 多个未来事件按开始时间升序，保证提示词里时间顺序自然
  upsertMemoryActiveEvent({
    id: 'event-later',
    chatId: 'chat-1',
    title: '下周的考试',
    status: 'planned',
    startAt: Date.now() + 86400000 * 10,
    validUntil: Date.now() + 86400000 * 15
  });
  upsertMemoryActiveEvent({
    id: 'event-sooner',
    chatId: 'chat-1',
    title: '后天要交材料',
    status: 'planned',
    startAt: Date.now() + 86400000 * 2,
    validUntil: Date.now() + 86400000 * 5
  });
  context = listActivePlanContext({ chatId: 'chat-1' });
  const order = context.events.map(event => event.id);
  assert.ok(order.indexOf('event-sooner') < order.indexOf('event-later'));

  // 10. 条数上限生效（防止提示词被大量条目淹没）
  assert.strictEqual(listActivePlanContext({ chatId: 'chat-1', eventLimit: 2 }).events.length, 2);
  assert.strictEqual(listActivePlanContext({ chatId: 'chat-1', factLimit: 1 }).facts.length, 1);

  // 11. 会话隔离：别的 chatId 不应看到这些内容
  const otherChat = listActivePlanContext({ chatId: 'chat-2' });
  assert.strictEqual(otherChat.eventCount, 0);
  assert.strictEqual(otherChat.factCount, 0);

  // 12. 回归：抽取层曾出现过的具体误判（句子全部取自线上真实数据）
  const bodyCases = [
    {
      why: '「肩头」不是头：「肩头轻微的刺痛」曾被抽成 head_pain',
      query: '我彻底瘫软在你怀里,几乎在下一秒就要昏睡过去,肩头轻微的刺痛感将我拉回了现实',
      expectCount: 0
    },
    {
      why: '半角逗号不得跨标点匹配：「头,而后又痛心疾首」曾被抽成 head_pain',
      query: '\u201d 我乖乖点了点头,而后又痛心疾首地看向你',
      expectCount: 0
    },
    {
      why: '否定必须记成缓解：「肚子已经不疼了」曾被反向存成 abdominal_pain 疼痛',
      query: '\u201c可是太远了......我看不清......而且我今天肚子已经不疼了......\u201d 我不甘心地嘟囔道',
      expectSlotKey: 'user.body.abdominal_pain',
      expectValueIncludes: '不疼'
    },
    {
      why: '程度词不能漏抽：「我有点头疼」曾被整句漏掉',
      query: '我有点头疼。',
      expectSlotKey: 'user.body.head_pain'
    },
    {
      why: '「点了点头痛」不能被当成头疼',
      query: '我点了点头痛得厉害。',
      expectCount: 0
    },
    {
      why: '正常的疼痛描述必须保留',
      query: '我现在头很痛，已经吃了药。',
      expectSlotKey: 'user.body.head_pain'
    },
    {
      why: '生理期相关既有行为不能被破坏',
      query: '我的生理期已经结束了。',
      expectSlotKey: 'user.body.menstrual_cycle'
    }
  ];
  for (const item of bodyCases) {
    const shadow = runCurrentFactShadow([], { query: item.query, sourceScope: privateUser });
    if (item.expectCount !== undefined) {
      assert.strictEqual(shadow.candidateCount, item.expectCount, item.why);
      continue;
    }
    assert.strictEqual(shadow.candidateCount, 1, item.why);
    assert.strictEqual(shadow.candidates[0].slotKey, item.expectSlotKey, item.why);
    if (item.expectValueIncludes) {
      assert.ok(shadow.candidates[0].value.includes(item.expectValueIncludes), item.why);
    }
  }

  // 13. 回归：过去时间前缀不得被解析成未来计划
  assert.strictEqual(
    resolveCrossDayWindow('反正肯定是去年11月17号到1月19号这段时间', Date.now(), 'Asia/Shanghai'),
    null,
    '「去年11月17号」曾被解析成未来的计划'
  );
  assert.strictEqual(
    resolveCrossDayWindow('上周五我们一起吃饭', Date.now(), 'Asia/Shanghai'),
    null,
    '「上周五」曾被推到未来的周五'
  );
  assert.ok(resolveCrossDayWindow('明天去医院复诊', Date.now(), 'Asia/Shanghai'), '明天的计划必须能解析');
  assert.ok(resolveCrossDayWindow('下周五交材料', Date.now(), 'Asia/Shanghai'), '下周五必须能解析');

  // 14. 管理面板用到的写操作：删除单条、清理已结束、事实层 upsert / promote / invalidate
  upsertMemoryActiveEvent({
    id: 'panel-plan-live',
    chatId: 'chat-1',
    title: '还生效的计划',
    status: 'planned',
    startAt: Date.now() + 86400000,
    validUntil: Date.now() + 86400000 * 3
  });
  upsertMemoryActiveEvent({
    id: 'panel-plan-done',
    chatId: 'chat-1',
    title: '已完成的计划',
    status: 'completed',
    startAt: Date.now(),
    validUntil: Date.now() + 86400000
  });
  upsertMemoryActiveEvent({
    id: 'panel-plan-other-chat',
    chatId: 'chat-2',
    title: '别的会话的已取消计划',
    status: 'cancelled',
    startAt: Date.now(),
    validUntil: Date.now() + 86400000
  });

  const purgeScoped = purgeFinishedMemoryActiveEvents({ chatId: 'chat-1' });
  assert.ok(purgeScoped.deleted >= 1, '至少要清理掉本会话的已结束计划');
  const chatOneEvents = listMemoryActiveEvents({ chatId: 'chat-1', includeArchived: true });
  assert.ok(!chatOneEvents.some(event => event.id === 'panel-plan-done'), '已完成的计划必须被清理');
  assert.ok(chatOneEvents.some(event => event.id === 'panel-plan-live'), '生效中的计划不能被清理');
  assert.ok(
    listMemoryActiveEvents({ chatId: 'chat-2', includeArchived: true }).some(event => event.id === 'panel-plan-other-chat'),
    '清理必须限定在指定会话内'
  );

  const deleteResult = deleteMemoryActiveEvent('panel-plan-live');
  assert.strictEqual(deleteResult.deleted, true);
  assert.strictEqual(deleteMemoryActiveEvent('panel-plan-live').deleted, false, '重复删除必须返回 false');
  assert.throws(() => deleteMemoryActiveEvent(''), /id is required/);

  const editableFact = upsertMemoryCurrentFact({
    id: 'panel-fact',
    chatId: 'chat-1',
    slotKey: 'user.residence.current',
    value: '临空',
    statement: '我最近住在临空。',
    status: 'shadow_candidate',
    confidence: 0.9,
    effectiveAt: Date.now()
  });
  assert.strictEqual(editableFact.id, 'panel-fact');
  const editedFact = upsertMemoryCurrentFact({
    ...editableFact,
    value: '天行',
    statement: '我最近住在天行。',
    evidence: editableFact.evidence
  });
  assert.strictEqual(editedFact.value, '天行');
  assert.strictEqual(
    listMemoryCurrentFacts({ chatId: 'chat-1', includeInactive: true }).filter(fact => fact.id === 'panel-fact').length,
    1,
    '编辑事实必须是更新而不是新增一条'
  );
  const promotedFact = promoteMemoryCurrentFact('panel-fact');
  assert.strictEqual(promotedFact.status, 'current');
  const invalidatedFact = invalidateMemoryCurrentFact('panel-fact', 'archived');
  assert.strictEqual(invalidatedFact.status, 'archived');
  // 服务端用「返回值没有 id」来判断不存在，所以这里必须是 null（或至少没有 id）
  assert.strictEqual(invalidateMemoryCurrentFact('not-exist-fact', 'archived'), null);

  // 15. 回归：本轮新增的抽取规则（E 贴近锚点 / A 否定反转 / B 认知回忆 / D 语气助词收尾）
  // 判定基准全部来自线上真实数据（见 memory-fact-plan-misextraction-audit.md）
  const auditScope = {
    type: 'private',
    sourceChatId: 'chat-1',
    mountedChatId: 'chat-1',
    latestSpeakerRole: 'user'
  };
  const planCount = query => runActiveEventExtractionShadow([], {
    query, timeZone: 'Asia/Shanghai', sourceScope: auditScope
  }).proposalCount;

  // A 否定反转：不是计划
  assert.strictEqual(planCount('我们在天行，明天又不会去临空'), 0, '否定句不得成为计划');
  assert.strictEqual(
    planCount('至少明天，我哪儿都不去，老老实实在家呆着，总行了吧'), 0, '否定句不得成为计划'
  );
  // B 认知/回忆/反事实：不是计划
  assert.strictEqual(planCount('我以为是明天去呢'), 0, '回忆句不得成为计划');
  assert.strictEqual(planCount('这……要去也是明早去就行来得及啊'), 0, '反事实句不得成为计划');
  // D 语气助词收尾的感叹/状态陈述：不是计划
  assert.strictEqual(
    planCount('明天是第四天了，就可以不做\u2018废人\u2019了吧'), 0, '纯感叹不得成为计划'
  );
  assert.strictEqual(planCount('晚安老公……明天早上我们还要一起做早餐呢'), 0, '语气助词收尾不得成为计划');
  // 真计划必须保留（防止规则误杀）
  assert.strictEqual(planCount('我不行了……明天我们还要去陵园，再做我真起不来了'), 1, '真计划不能被误杀');
  assert.strictEqual(planCount('这还差不多……晚安，明天我们一起去看湖边秋景'), 1, '真计划不能被误杀');
  assert.strictEqual(planCount('明天去湖边小镇的超市，周一去舰队，你敢应我就敢叫'), 1, '真计划不能被误杀');
  assert.strictEqual(
    planCount('然后……然后下周就不能再围着答辩打转了，开始写期刊文章'), 1, '真计划不能被误杀'
  );
  // 既有行为不得回归：条件句只降权、同日安排不算跨天计划
  assert.strictEqual(planCount('你要是感冒了，明天谁来做布丁和海棠糕？'), 1, '条件疑问句仍应能成计划');
  assert.strictEqual(planCount('今晚要吃完饭再去散步。'), 0, '同一天的安排不算跨天计划');

  // 事实层：E 状态词必须贴近锚点 / A 否定不算状态
  const factFor = query => runCurrentFactShadow([], { query, sourceScope: auditScope });
  assert.strictEqual(factFor('我从酒店\u2018独自\u2019出发去酒吧').candidateCount, 0, '动作启动词不再是行程状态');
  assert.strictEqual(factFor('我们找衣服去吃饭,然后赶紧出发').candidateCount, 0, '动作启动词不再是行程状态');
  assert.strictEqual(
    factFor('我摇摇头,忍着咳嗽接过水杯,喝了几口水,喉咙里那阵又干又痒的感觉才稍微缓解一些').candidateCount,
    0,
    '状态词离锚点太远不得成候选'
  );
  assert.strictEqual(factFor('我没有过敏').candidateCount, 0, '否定状态不得记成有这个状态');
  assert.strictEqual(factFor('我不头疼').candidateCount, 0, '否定状态不得记成有这个状态');
  assert.strictEqual(factFor('我现在还在出差').candidateCount, 1, '真正的行程状态必须保留');
  assert.strictEqual(
    factFor('我的生理期已经结束了，今天感觉好多了').candidateCount,
    1,
    '长一些但状态词贴近锚点的必须保留'
  );
  // 注意：这里的句子必须与线上原文逐字一致——改写会悄悄丢掉规则依赖的信号词
  assert.strictEqual(
    factFor('我又不是从零开始写,我只是要捋顺已经写完了的毕业论文的逻辑而已,为答辩做准备嘛').candidateCount,
    1,
    '任务事实必须保留'
  );

  // 16. 部署前补齐的两个接口：按作用域清理 + 事实物理删除
  upsertMemoryActiveEvent({
    id: 'purge-archived-1', chatId: 'chat-1', title: '已归档的',
    status: 'archived', startAt: Date.now(), validUntil: Date.now() + 86400000
  });
  upsertMemoryActiveEvent({
    id: 'purge-done-1', chatId: 'chat-1', title: '已完成的',
    status: 'completed', startAt: Date.now(), validUntil: Date.now() + 86400000
  });
  upsertMemoryActiveEvent({
    id: 'purge-planned-1', chatId: 'chat-1', title: '生效中的',
    status: 'planned', startAt: Date.now() + 86400000, validUntil: Date.now() + 86400000 * 3
  });

  // 「清理过期与已完成」**绝不能碰归档**（归档必须保持可撤回）
  const finishedPurge = purgeMemoryActiveEvents({ chatId: 'chat-1', scope: 'finished' });
  assert.deepEqual(finishedPurge.statuses, ['completed', 'cancelled', 'expired']);
  const afterFinishedPurge = listMemoryActiveEvents({ chatId: 'chat-1', includeArchived: true }).map(e => e.id);
  assert.ok(!afterFinishedPurge.includes('purge-done-1'), '已完成的应被清理');
  assert.ok(afterFinishedPurge.includes('purge-archived-1'), '已归档的必须保留');
  assert.ok(afterFinishedPurge.includes('purge-planned-1'), '生效中的不能被清理');

  // 「清空已归档」只清归档
  const archivedPurge = purgeMemoryActiveEvents({ chatId: 'chat-1', scope: 'archived' });
  assert.strictEqual(archivedPurge.deleted, 1);
  assert.deepEqual(archivedPurge.statuses, ['archived']);
  const afterArchivedPurge = listMemoryActiveEvents({ chatId: 'chat-1', includeArchived: true }).map(e => e.id);
  assert.ok(!afterArchivedPurge.includes('purge-archived-1'), '已归档的应被清空');
  assert.ok(afterArchivedPurge.includes('purge-planned-1'), '生效中的不能被清空');

  // 事实物理删除
  upsertMemoryCurrentFact({
    id: 'fact-to-delete', chatId: 'chat-1', slotKey: 'user.body.cough',
    value: '咳嗽', statement: '我在咳嗽。', status: 'shadow_candidate',
    confidence: 0.9, effectiveAt: Date.now()
  });
  assert.strictEqual(deleteMemoryCurrentFact('fact-to-delete').deleted, true);
  assert.strictEqual(deleteMemoryCurrentFact('fact-to-delete').deleted, false, '重复删除必须返回 false');
  assert.throws(() => deleteMemoryCurrentFact(''), /id is required/);
  assert.strictEqual(
    listMemoryCurrentFacts({ chatId: 'chat-1', includeInactive: true }).filter(f => f.id === 'fact-to-delete').length,
    0,
    '物理删除后不应还能查到'
  );

  // ==================== C 阶段：征询句两轮确认 ====================
  // 征询句（"要不要…？"）不是计划：先建「待确认」候选，等角色答复再定案。

  const askClause = '这周五是中秋节，我们最近要不要去看看奶奶';
  const askShadow = runActiveEventExtractionShadow([], {
    query: askClause,
    timeZone: 'Asia/Shanghai',
    sourceScope: privateUser,
    writesEnabled: true
  });
  assert.strictEqual(askShadow.proposalCount, 1, '征询句必须留下候选，而不是被否定规则直接丢掉');
  assert.strictEqual(askShadow.proposals[0].awaitingConfirmation, true, '征询句必须标记 awaitingConfirmation');

  const askLogId = succeededSearch('c-ask-1', askClause, {
    activeEventShadow: { extraction: askShadow, sourceScope: askShadow.sourceScope, timeZone: 'Asia/Shanghai' }
  });
  const askWrite = applyMemoryActiveEventWrites(askLogId, { writesEnabled: true });
  assert.strictEqual(askWrite.applied, true);
  const pendingEvent = askWrite.events[0];
  assert.strictEqual(pendingEvent.status, 'candidate', '待确认期间必须是 candidate，不能立刻 planned');
  assert.strictEqual(pendingEvent.awaitingConfirmation, true);
  assert.ok(Number(pendingEvent.confirmDeadline || 0) > Date.now(), '必须设定案截止时间');

  // 待确认期间不得注入提示词
  assert.ok(
    !listActivePlanContext({ chatId: 'chat-1' }).events.some(event => event.id === pendingEvent.id),
    '待确认的征询不能注入提示词'
  );

  // 角色答应 → planned
  const acceptScope = { ...privateUser, latestAssistantDialogue: '好啊，那我们周五去看奶奶吧。' };
  const acceptShadow = runActiveEventExtractionShadow([], {
    query: '嗯，那就这么定了。',
    timeZone: 'Asia/Shanghai',
    sourceScope: acceptScope,
    writesEnabled: true
  });
  const acceptLogId = succeededSearch('c-ask-2', '嗯，那就这么定了。', {
    activeEventShadow: { extraction: acceptShadow, sourceScope: acceptShadow.sourceScope, timeZone: 'Asia/Shanghai' }
  });
  applyMemoryActiveEventWrites(acceptLogId, { writesEnabled: true });
  const accepted = listMemoryActiveEvents({ chatId: 'chat-1', includeArchived: true, limit: 50 })
    .find(event => event.id === pendingEvent.id);
  assert.strictEqual(accepted.status, 'planned', '角色答应后必须转为 planned');
  assert.strictEqual(accepted.awaitingConfirmation, false);
  assert.ok(
    listActivePlanContext({ chatId: 'chat-1' }).events.some(event => event.id === pendingEvent.id),
    '角色答应后应重新进入注入列表'
  );

  // 角色拒绝 → cancelled
  const ask2 = runActiveEventExtractionShadow([], {
    query: '明天去舰队吗？',
    timeZone: 'Asia/Shanghai',
    sourceScope: privateUser,
    writesEnabled: true
  });
  const ask2LogId = succeededSearch('c-ask-3', '明天去舰队吗？', {
    activeEventShadow: { extraction: ask2, sourceScope: ask2.sourceScope, timeZone: 'Asia/Shanghai' }
  });
  const pending2 = applyMemoryActiveEventWrites(ask2LogId, { writesEnabled: true }).events[0];
  assert.strictEqual(pending2.awaitingConfirmation, true);

  const declineScope = { ...privateUser, latestAssistantDialogue: '算了，太远了，改天吧。' };
  const declineShadow = runActiveEventExtractionShadow([], {
    query: '那算了吧。',
    timeZone: 'Asia/Shanghai',
    sourceScope: declineScope,
    writesEnabled: true
  });
  const declineLogId = succeededSearch('c-ask-4', '那算了吧。', {
    activeEventShadow: { extraction: declineShadow, sourceScope: declineShadow.sourceScope, timeZone: 'Asia/Shanghai' }
  });
  applyMemoryActiveEventWrites(declineLogId, { writesEnabled: true });
  const declined = listMemoryActiveEvents({ chatId: 'chat-1', includeArchived: true, limit: 50 })
    .find(event => event.id === pending2.id);
  assert.strictEqual(declined.status, 'cancelled', '角色拒绝后必须取消');

  // 超时未答复 → expired
  const stalePending = upsertMemoryActiveEvent({
    chatId: 'chat-1',
    title: '过期征询：明早体检',
    status: 'candidate',
    awaitingConfirmation: true,
    confirmDeadline: Date.now() - 1000,
    confidence: 0.5
  });
  assert.strictEqual(stalePending.awaitingConfirmation, true);
  const silentShadow = runActiveEventExtractionShadow([], {
    query: '今天好热。',
    timeZone: 'Asia/Shanghai',
    sourceScope: privateUser,
    writesEnabled: true
  });
  const silentLogId = succeededSearch('c-ask-5', '今天好热。', {
    activeEventShadow: { extraction: silentShadow, sourceScope: silentShadow.sourceScope, timeZone: 'Asia/Shanghai' }
  });
  applyMemoryActiveEventWrites(silentLogId, { writesEnabled: true });
  const staleAfter = listMemoryActiveEvents({ chatId: 'chat-1', includeArchived: true, limit: 200 })
    .find(event => event.id === stalePending.id);
  assert.strictEqual(staleAfter.status, 'expired', '超过截止时间未答复必须过期');

  // 普通陈述句不能被误判成待确认
  const plainShadow = runActiveEventExtractionShadow([], {
    query: '我明天要去医院复诊。',
    timeZone: 'Asia/Shanghai',
    sourceScope: privateUser,
    writesEnabled: true
  });
  assert.strictEqual(plainShadow.proposals[0].awaitingConfirmation, false, '陈述句不是征询，必须直接成计划');

  console.log('Active plan context tests passed.');
} finally {
  db.close();
  fs.rmSync(testDir, { recursive: true, force: true });
}
