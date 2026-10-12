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

  console.log('Active plan context tests passed.');
} finally {
  db.close();
  fs.rmSync(testDir, { recursive: true, force: true });
}
