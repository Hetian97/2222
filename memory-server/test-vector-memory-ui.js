const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const events = [];
const storage = new Map();
const sandbox = {
  console,
  setTimeout,
  clearTimeout,
  localStorage: {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value))
  },
  CustomEvent: class CustomEvent {
    constructor(type, options = {}) {
      this.type = type;
      this.detail = options.detail;
    }
  },
  window: {
    dispatchEvent: event => events.push(event)
  }
};

const source = fs.readFileSync(path.join(__dirname, '..', 'vector-memory.js'), 'utf8');
const timeZoneSource = fs.readFileSync(path.join(__dirname, '..', 'time-zone-utils.js'), 'utf8');
const memorySummarySource = fs.readFileSync(path.join(__dirname, '..', 'modules', 'memory-summary.js'), 'utf8');
const vectorMemoryCss = fs.readFileSync(path.join(__dirname, '..', 'vector-memory.css'), 'utf8');
vm.runInNewContext(timeZoneSource, sandbox, { filename: 'time-zone-utils.js' });
vm.runInNewContext(source, sandbox, { filename: 'vector-memory.js' });

async function main() {
  const manager = sandbox.window.vectorMemoryManager;
  assert.equal(typeof manager.renderOrganizationPreviewUI, 'function');
  assert.equal(typeof manager.loadOrganizationPreviewTab, 'function');
  assert.equal(typeof manager.unloadOrganizationClusterMembers, 'function');
  assert(source.includes('只读预览'));
  assert(source.includes('不会合并原记忆，也不会参与召回或提示词'));
  assert(source.includes('/memory/organization/status'));
  assert(source.includes('/memory/organization/clusters'));
  assert(source.includes('/memory/organization/memories'));
  assert(source.includes("other.open = false"));
  assert(source.includes("card.dataset.requestSequence"));
  assert(!source.includes('/memory/organization/reset`'));
  assert(memorySummarySource.includes('window.renderVectorMemoryView = renderVectorMemoryView'));
  assert(vectorMemoryCss.includes('.vm-view-switcher'));
  assert(vectorMemoryCss.includes('.vm-cluster-card'));
  const chat = {
    id: 'chat-1',
    originalName: '测试角色',
    name: '角色备注名',
    nameHistory: ['角色旧称'],
    settings: { myNickname: '测试用户' },
    history: [],
    variableMemory: {
      fragments: [
        {
          id: 'core',
          category: 'C',
          content: '北京出差核心常驻',
          tags: ['北京'],
          importance: 10,
          emotionalWeight: 10,
          memoryTime: Date.now()
        },
        {
          id: 'dynamic',
          category: 'P',
          content: '北京学术出差将在二十号出发',
          tags: ['北京', '出差'],
          importance: 8,
          emotionalWeight: 5,
          memoryTime: Date.now(),
          recallCount: 0,
          lastRecalled: 0
        }
      ],
      settings: {
        topN: 10,
        scoreWeights: { semantic: 0.4, keyword: 0.3, importance: 0.2, emotion: 0.05, recency: 0.05 },
        retrievalCacheEnabled: false,
        autoExtractionMsgInterval: 20,
        lastExtractedMsgIndex: -1,
        externalMemoryEnabled: false,
        externalMemoryEndpoint: 'http://127.0.0.1:8765',
        externalMemoryBearerToken: ''
      },
      stats: { totalFragments: 2, totalRecalls: 0, lastUpdated: 0 },
      _migrated: true
    }
  };

  sandbox.window.state = {
    activeChatId: chat.id,
    chats: { [chat.id]: chat },
    qzoneSettings: { nickname: '用户全局昵称' }
  };
  assert.deepEqual(
    Array.from(manager.filterMemoryTags(chat, [
      '测试角色', '角色备注名', '角色旧称', '测试用户', '用户全局昵称',
      '乔教授', '海棠树下聊天室', '#乔教授'
    ])),
    ['乔教授', '海棠树下聊天室']
  );
  const parsedTags = manager.parseExtractionResult(JSON.stringify([{
    content: '测试用户在海棠树下聊天室提到了乔教授。',
    tags: ['测试用户', '测试角色', '乔教授', '海棠树下聊天室'],
    category: 'E'
  }]), chat)[0].tags;
  assert.deepEqual(Array.from(parsedTags), ['乔教授', '海棠树下聊天室']);

  const changed = manager.applyExternalRecallUpdates(chat, [{
    id: 'dynamic',
    recallCount: 7,
    lastRecalled: 123456789
  }]);
  assert.equal(changed, 1);
  assert.equal(chat.variableMemory.fragments[1].recallCount, 7);
  assert.equal(chat.variableMemory.fragments[1].lastRecalled, 123456789);
  assert.equal(events[0].type, 'variable-memory-recall-updated');

  manager.getEmbedding = async () => null;
  const recalled = await manager.retrieveRelevant(chat, '北京出差', 10);
  assert(recalled.some(result => result.fragment.id === 'dynamic'));
  assert(!recalled.some(result => result.fragment.category === 'C'));

  let sentBody = null;
  chat.variableMemory.settings.externalMemoryEnabled = true;
  manager.getCurrentEmbeddingModel = () => 'test-model';
  manager.externalMemoryRequest = async (_chat, _path, options) => {
    sentBody = options.body;
    return {
      ok: true,
      memory: {
        id: options.body.id,
        hasEmbedding: true,
        _hasEmbedding: true,
        embeddingModel: 'test-model',
        embeddingDim: 4,
        _embeddingDim: 4,
        embeddingUpdatedAt: 987654321
      }
    };
  };

  const createdId = manager.createFragment(chat, {
    content: '临时向量不得写入前端对象',
    category: 'E',
    embedding: [0.1, 0.2, 0.3, 0.4]
  });
  const created = manager.getFragment(chat, createdId);
  assert.equal(Object.prototype.hasOwnProperty.call(created, 'embedding'), false);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(sentBody.embedding, [0.1, 0.2, 0.3, 0.4]);
  assert.deepEqual(Array.from(sentBody.participantNames), [
    '测试角色', '角色备注名', '角色旧称', '测试用户', '用户全局昵称'
  ]);
  assert.equal(Object.prototype.hasOwnProperty.call(created, 'embedding'), false);
  assert.equal(created.hasEmbedding, true);
  assert.equal(created.embeddingDim, 4);

  manager.getEmbedding = async () => [0.5, 0.6, 0.7, 0.8];
  await manager.editFragment(chat, createdId, { content: '编辑后的正文仍不保存前端向量' });
  assert.equal(Object.prototype.hasOwnProperty.call(created, 'embedding'), false);
  assert.equal(created.hasEmbedding, true);

  const lifecycleCalls = [];
  manager.externalMemoryRequest = async (_chat, requestPath, options) => {
    lifecycleCalls.push({ requestPath, body: options.body });
    if (requestPath === '/memory/search/commit') {
      return { ok: true, log: { status: 'prompt_committed' }, recallUpdates: [] };
    }
    if (requestPath === '/memory/search/generation') {
      return {
        ok: true,
        recallUpdates: options.body.outcome === 'succeeded'
          ? [{ id: 'dynamic', recallCount: 8, lastRecalled: 222 }]
          : []
      };
    }
    return { ok: true };
  };
  chat.history = [
    { role: 'user', content: '旧话题只是上下文', timestamp: 100 },
    { role: 'assistant', content: '回应旧话题', timestamp: 101 },
    { role: 'user', content: '当前用户主问题', timestamp: 102 }
  ];
  manager.externalMemoryRequest = async (_chat, requestPath, options) => {
    lifecycleCalls.push({ requestPath, body: options.body });
    if (requestPath === '/memory/search') return { ok: true, memories: [{ id: 'dynamic', content: '记忆', _searchScore: 0.8 }], searchTraceId: 'trace-retrieve' };
    if (requestPath === '/memory/search/commit') return { ok: true, log: { status: 'prompt_committed' }, recallUpdates: [] };
    if (requestPath === '/memory/search/generation') return { ok: true, recallUpdates: options.body.outcome === 'succeeded' ? [{ id: 'dynamic', recallCount: 8, lastRecalled: 222 }] : [] };
    return { ok: true };
  };
  await manager.retrieveRelevantFromExternalServer(chat, '旧话题只是上下文 当前用户主问题', 12, ['旧话题只是上下文', '当前用户主问题'], {
    primaryQuery: '当前用户主问题',
    actionType: 'regenerate'
  });
  const searchCall = lifecycleCalls.find(call => call.requestPath === '/memory/search');
  assert.equal(searchCall.body.shadowPrimaryQuery, '当前用户主问题');
  assert.deepEqual(searchCall.body.shadowContextQueries, ['旧话题只是上下文']);
  assert.equal(searchCall.body.actionType, 'regenerate');
  assert.equal(typeof searchCall.body.timeZone, 'string');
  assert(searchCall.body.timeZone.length > 0);
  assert.equal(searchCall.body.activeEventSource.type, 'private');
  assert.equal(searchCall.body.activeEventSource.sourceChatId, 'chat-1');
  assert.equal(searchCall.body.activeEventSource.mountedChatId, 'chat-1');

  const groupSource = manager.createActiveEventSourceContext({
    id: 'group-1',
    isGroup: true,
    members: [{ id: 'member-a' }, { id: 'member-b' }]
  }, [
    { role: 'assistant', senderId: 'member-a', content: '第一条' },
    { role: 'user', senderId: 'user', content: '第二条' }
  ], chat);
  assert.equal(groupSource.type, 'group');
  assert.equal(groupSource.sourceChatId, 'group-1');
  assert.equal(groupSource.mountedChatId, 'chat-1');
  assert.equal(groupSource.sourceMessageType, 'mounted_group_context');
  assert.equal(groupSource.latestSpeakerId, 'user');
  assert.deepEqual(Array.from(groupSource.speakerIds), ['member-a', 'user']);
  assert.deepEqual(Array.from(groupSource.participantIds), ['member-a', 'member-b']);
  const recalledAt = sandbox.window.TimeZoneUtils.fromDateTimeLocal('2026-08-26T15:42', 'Asia/Shanghai');
  const timedMemory = {
    id: 'timed-memory',
    category: 'P',
    content: '前天开始准备，昨天发生了重要的事，今天下午复盘，明天继续，今晚早点休息，后天提交。上周三复诊，上个月整理资料，去年夏天独自去医院，今年8月再次检查。',
    memoryTime: recalledAt,
    memoryTimeZone: 'Asia/Shanghai',
    _searchScore: 0.9
  };
  manager.externalMemoryRequest = async (_chat, requestPath) => {
    if (requestPath === '/memory/search') return {
      ok: true,
      memories: [timedMemory],
      searchTraceId: 'trace-timed-memory'
    };
    if (requestPath === '/memory/search/commit') return { ok: true, log: { status: 'prompt_committed' }, recallUpdates: [] };
    return { ok: true, recallUpdates: [] };
  };
  const timedPrompt = await manager.serializeForPrompt(chat, '湖边看日出');
  assert(timedPrompt.includes('[记忆记录基准时间：2026-08-26 15:42｜Asia/Shanghai]'));
  assert(timedPrompt.includes('被记录或叙述时的时间基准'));
  assert(timedPrompt.includes('不保证是正文中所有事件的实际发生时间'));
  assert(timedPrompt.includes('严禁把一条记忆的时间修饰套到另一条记忆的事件上'));
  assert(timedPrompt.includes('2026-08-24（原文称“前天”）开始准备'));
  assert(timedPrompt.includes('2026-08-25（原文称“昨天”）发生了重要的事'));
  assert(timedPrompt.includes('2026-08-26 下午（原文称“今天下午”）复盘'));
  assert(timedPrompt.includes('2026-08-27（原文称“明天”）继续'));
  assert(timedPrompt.includes('2026-08-26 晚上（原文称“今晚”）早点休息'));
  assert(timedPrompt.includes('2026-08-28（原文称“后天”）提交'));
  assert(timedPrompt.includes('2026-08-19（原文称“上周三”）复诊'));
  assert(timedPrompt.includes('2026-07（原文称“上个月”）整理资料'));
  assert(timedPrompt.includes('2025年夏天（原文称“去年夏天”）独自去医院'));
  assert(timedPrompt.includes('2026-08（原文称“今年8月”）再次检查'));
  assert.equal(timedMemory.content, '前天开始准备，昨天发生了重要的事，今天下午复盘，明天继续，今晚早点休息，后天提交。上周三复诊，上个月整理资料，去年夏天独自去医院，今年8月再次检查。');
  manager.externalMemoryRequest = async (_chat, requestPath) => {
    if (requestPath === '/memory/search') return { ok: true, memories: [], searchTraceId: 'trace-zero-recall' };
    if (requestPath === '/memory/search/commit') return { ok: true, log: { status: 'prompt_committed' }, recallUpdates: [] };
    return { ok: true, recallUpdates: [] };
  };
  const zeroRecall = await manager.retrieveRelevantFromExternalServer(chat, 'no reliable memory');
  assert(Array.isArray(zeroRecall));
  assert.equal(zeroRecall.length, 0);
  assert.equal(zeroRecall._searchTraceId, 'trace-zero-recall');
  let localFallbackCalled = false;
  manager.retrieveRelevant = async () => {
    localFallbackCalled = true;
    return [];
  };
  await manager.serializeForPrompt(chat, 'no reliable memory');
  assert.equal(localFallbackCalled, false);
  lifecycleCalls.length = 0;
  manager.externalMemoryRequest = async (_chat, requestPath, options) => {
    lifecycleCalls.push({ requestPath, body: options.body });
    if (requestPath === '/memory/search/commit') return { ok: true, log: { status: 'prompt_committed' }, recallUpdates: [] };
    if (requestPath === '/memory/search/generation') return { ok: true, recallUpdates: options.body.outcome === 'succeeded' ? [{ id: 'dynamic', recallCount: 8, lastRecalled: 222 }] : [] };
    return { ok: true };
  };
  const recallCountBeforeCommit = chat.variableMemory.fragments[1].recallCount;
  await manager.commitExternalMemoryRecall(chat, 'trace-success', ['dynamic']);
  assert.equal(chat.variableMemory.fragments[1].recallCount, recallCountBeforeCommit);
  assert.equal(lifecycleCalls[0].body.lifecycleVersion, 2);
  await manager.finishExternalMemoryGeneration(chat, 'succeeded');
  assert.equal(chat.variableMemory.fragments[1].recallCount, 8);
  assert.equal(lifecycleCalls.at(-1).body.outcome, 'succeeded');

  await manager.commitExternalMemoryRecall(chat, 'trace-failed', ['dynamic']);
  await manager.finishExternalMemoryGeneration(chat, 'failed', 'api timeout');
  assert.equal(chat.variableMemory.fragments[1].recallCount, 8);
  assert.equal(lifecycleCalls.at(-1).body.outcome, 'failed');

  // ---- 计划层常驻注入（A3）----
  // 这里刻意让 /memory/search 返回空数组：计划段必须与「有没有召回到记忆」无关，
  // 否则「今天什么都没想起来」的时候恰恰会把待办丢掉。
  const planNow = Date.now();
  manager.externalMemoryRequest = async (_chat, requestPath) => {
    if (String(requestPath).startsWith('/memory/active-events')) {
      assert(requestPath.includes('chatId=chat-1'), '必须按当前会话查询计划');
      return {
        ok: true,
        events: [
          { id: 'live-1', title: '明天去医院复诊', status: 'planned', startAt: planNow + 86400000, validUntil: planNow + 86400000 * 3 },
          { id: 'expired-1', title: '上个月已经过期的会议', status: 'planned', startAt: planNow - 86400000 * 40, validUntil: planNow - 86400000 * 30 },
          { id: 'done-1', title: '已经完成的事情', status: 'completed', startAt: planNow, validUntil: planNow + 86400000 },
          { id: 'pending-1', title: '还没答应的征询', status: 'candidate', awaitingConfirmation: 1, startAt: planNow + 86400000, validUntil: planNow + 86400000 * 2 },
          { id: 'live-2', title: '下周交材料', status: 'planned', startAt: planNow + 86400000 * 5, validUntil: planNow + 86400000 * 8 }
        ]
      };
    }
    if (requestPath === '/memory/search') return { ok: true, memories: [], searchTraceId: 'trace-plan' };
    if (requestPath === '/memory/search/commit') return { ok: true, log: { status: 'prompt_committed' }, recallUpdates: [] };
    return { ok: true, recallUpdates: [] };
  };

  const planPrompt = await manager.serializeForPrompt(chat, '随便聊两句');
  assert(planPrompt.includes('还没结束的约定与计划'), '零召回时计划段仍必须注入');
  assert(planPrompt.includes('明天去医院复诊'), '未过期的计划必须注入');
  assert(planPrompt.includes('下周交材料'), '未过期的计划必须注入');
  assert(!planPrompt.includes('上个月已经过期的会议'), '过期计划不得注入');
  assert(!planPrompt.includes('已经完成的事情'), '已完成不得注入');
  assert(!planPrompt.includes('还没答应的征询'), '等待 char 确认的征询不得当成计划');
  assert(planPrompt.indexOf('明天去医院复诊') < planPrompt.indexOf('下周交材料'), '计划应按开始时间升序');
  assert(planPrompt.includes('与你是否「想起」无关'), '必须说明计划段与召回无关');

  // 关掉开关后：既不请求也不注入
  chat.variableMemory.settings.planContextEnabled = false;
  let planRequestedWhileDisabled = false;
  manager.externalMemoryRequest = async (_chat, requestPath) => {
    if (String(requestPath).startsWith('/memory/active-events')) planRequestedWhileDisabled = true;
    if (requestPath === '/memory/search') return { ok: true, memories: [], searchTraceId: 'trace-plan-off' };
    if (requestPath === '/memory/search/commit') return { ok: true, log: { status: 'prompt_committed' }, recallUpdates: [] };
    return { ok: true, recallUpdates: [] };
  };
  const planOffPrompt = await manager.serializeForPrompt(chat, '随便聊两句');
  assert.equal(planRequestedWhileDisabled, false, '关掉开关后不应再请求计划接口');
  assert(!planOffPrompt.includes('还没结束的约定与计划'), '关掉开关后不应注入计划段');
  chat.variableMemory.settings.planContextEnabled = true;

  // 计划接口挂掉时，召回必须照常工作，且不能留下半截段落
  const originalWarn = sandbox.console.warn;
  let planWarningCount = 0;
  sandbox.console.warn = (...args) => {
    if (String(args[0] || '').includes('上下文获取失败')) planWarningCount++;
  };
  manager.externalMemoryRequest = async (_chat, requestPath) => {
    if (String(requestPath).startsWith('/memory/active-events')) throw new Error('plan endpoint down');
    if (requestPath === '/memory/search') return { ok: true, memories: [{ id: 'dynamic', content: '记忆', _searchScore: 0.8 }], searchTraceId: 'trace-plan-fail' };
    if (requestPath === '/memory/search/commit') return { ok: true, log: { status: 'prompt_committed' }, recallUpdates: [] };
    return { ok: true, recallUpdates: [] };
  };
  const degradedPrompt = await manager.serializeForPrompt(chat, '随便聊两句');
  sandbox.console.warn = originalWarn;
  assert(degradedPrompt.includes('回闪记忆'), '计划接口失败时召回必须照常');
  assert(!degradedPrompt.includes('还没结束的约定与计划'), '计划接口失败时不应出现空段落');
  assert(planWarningCount >= 1, '计划接口失败时应留下一条 warning 便于排查');

  // ---- 计划与事实管理面板（第三个标签）----
  assert.equal(typeof manager.renderPlanFactPanel, 'function');
  assert.equal(typeof manager.applyPlanPanelAction, 'function');
  assert.equal(typeof manager.applyFactPanelAction, 'function');
  assert(source.includes('data-view="plans"'), '切换器里必须出现「计划与事实」标签');
  assert(source.includes("activeView === 'plans'"), '面板分发必须接上 plans 视图');
  assert(source.includes('这里只管理计划与事实两张表'), '必须向用户说明不会影响向量记忆');

  const panelNow = 1700000000000;
  const rawPlans = [
    { id: 'done', title: '已经完成的', status: 'completed', startAt: panelNow, validUntil: panelNow + 1000 },
    { id: 'expired', title: '已经过期的', status: 'planned', startAt: panelNow, validUntil: panelNow - 1000 },
    { id: 'later', title: '后面的计划', status: 'planned', startAt: panelNow + 90000, validUntil: panelNow + 999000 },
    { id: 'sooner', title: '前面的计划', status: 'active', startAt: panelNow + 1000, validUntil: panelNow + 999000 }
  ];
  const allPlans = manager.normalizePlanPanelList(rawPlans, { includeFinished: true, now: panelNow });
  assert.equal(allPlans.length, 4);
  assert.deepEqual(Array.from(allPlans.slice(0, 2).map(plan => plan.id)), ['sooner', 'later'], '生效中的计划必须按开始时间升序排在前面');
  assert.deepEqual(
    Array.from(new Set(allPlans.slice(2).map(plan => plan.id))).sort(),
    ['done', 'expired'],
    '完成/过期的计划必须排到后面'
  );
  assert.equal(allPlans.find(plan => plan.id === 'expired').expired, true);
  assert.equal(allPlans.find(plan => plan.id === 'done').finished, true);
  const livePlans = manager.normalizePlanPanelList(rawPlans, { now: panelNow });
  assert.deepEqual(Array.from(livePlans.map(plan => plan.id)), ['sooner', 'later'], '默认只保留生效中的计划');
  assert.equal(manager.normalizePlanPanelList(null, { now: panelNow }).length, 0);

  const factGroups = manager.normalizeFactPanelList([
    { id: 'f1', slotKey: 'user.location.current', value: '上海', status: 'superseded', effectiveAt: panelNow },
    { id: 'f2', slotKey: 'user.location.current', value: '杭州', status: 'shadow_candidate', effectiveAt: panelNow + 1000 },
    { id: 'f3', slotKey: 'user.body.head_pain', value: '头疼', status: 'shadow_candidate', effectiveAt: panelNow }
  ]);
  assert.equal(factGroups.length, 2, '同一 slotKey 必须合并成一组');
  const locationGroup = factGroups.find(group => group.slotKey === 'user.location.current');
  assert.equal(locationGroup.current.id, 'f2', '必须取 effectiveAt 最新的一条作为当前值');
  assert.equal(locationGroup.versions.length, 2);
  assert.equal(locationGroup.versions[0].id, 'f2');
  assert.equal(factGroups.find(group => group.slotKey === 'user.body.head_pain').current.id, 'f3');

  const rawEvent = {
    id: 'e1',
    chatId: 'chat-1',
    title: '旧标题',
    summary: '旧摘要',
    status: 'planned',
    startAt: panelNow,
    endAt: panelNow + 3600000,
    validUntil: panelNow + 86400000,
    surfaceMode: 'manual_only',
    aliases: ['旧标题'],
    confidence: 0.8,
    evidence: { writeVersion: 'active-event-write-v1', sourceSearchIds: ['search-1'] },
    createdAt: panelNow - 5000
  };
  const upsertBody = manager.buildPlanUpsertBody(rawEvent, { title: '新标题', startAt: panelNow + 1000 });
  assert.equal(upsertBody.confirm, 'UPSERT_ACTIVE_EVENT');
  assert.equal(upsertBody.event.id, 'e1');
  assert.equal(upsertBody.event.chatId, 'chat-1');
  assert.equal(upsertBody.event.title, '新标题');
  assert.equal(upsertBody.event.startAt, panelNow + 1000);
  assert.equal(upsertBody.event.validUntil, rawEvent.validUntil, '未修改的字段必须原样保留');
  assert.equal(upsertBody.event.createdAt, rawEvent.createdAt, 'createdAt 不能被重置');
  assert.deepEqual(Array.from(upsertBody.event.aliases), ['旧标题']);
  assert.deepEqual(
    manager.buildPlanArchiveBody('e1', 'completed'),
    { confirm: 'ARCHIVE_ACTIVE_EVENT', id: 'e1', status: 'completed' }
  );
  assert.deepEqual(
    manager.buildFactInvalidateBody('f2', 'archived'),
    { confirm: 'INVALIDATE_CURRENT_FACT', id: 'f2', status: 'archived' }
  );
  assert.deepEqual(manager.buildFactPromoteBody('f2'), { confirm: 'PROMOTE_CURRENT_FACT', id: 'f2' });
  assert.equal(
    upsertBody.event.evidence.sourceSearchIds[0],
    'search-1',
    '编辑计划必须原样带回 evidence，否则审计历史会被清空'
  );

  // 手动添加计划（面板「添加计划」按钮）
  const createBody = manager.buildPlanUpsertBody(
    { chatId: 'chat-1', status: 'planned', surfaceMode: 'manual_only', proactiveMention: false, confidence: 0.99 },
    {
      title: '明天去医院复诊',
      summary: '明天去医院复诊',
      status: 'planned',
      startAt: panelNow + 86400000,
      validUntil: panelNow + 86400000 * 3,
      evidence: { writeVersion: 'manual-panel-v1', manual: true, addedAt: panelNow }
    }
  );
  assert.equal(createBody.confirm, 'UPSERT_ACTIVE_EVENT');
  assert.equal(createBody.event.id, '', '新建时不能带 id，必须交给服务器生成');
  assert.equal(createBody.event.chatId, 'chat-1');
  assert.equal(createBody.event.status, 'planned');
  assert.equal(createBody.event.validUntil, panelNow + 86400000 * 3);
  assert.equal(createBody.event.evidence.manual, true);
  assert.equal(createBody.event.createdAt, undefined, '新建时不能带上旧 createdAt');

  // 手动添加的条目标注必须在列表里体现
  const manualPlans = manager.normalizePlanPanelList([
    { id: 'm1', title: '手动加的', status: 'planned', startAt: panelNow + 1000, validUntil: panelNow + 999000, evidence: { manual: true } },
    { id: 'a1', title: '自动抽的', status: 'planned', startAt: panelNow + 2000, validUntil: panelNow + 999000, evidence: { writeVersion: 'active-event-write-v1' } }
  ], { now: panelNow });
  assert.equal(manualPlans.find(plan => plan.id === 'm1').manual, true);
  assert.equal(manualPlans.find(plan => plan.id === 'a1').manual, false);

  assert(source.includes('data-action="add"'), '计划页必须有「添加计划」按钮');
  assert(source.includes('openPlanCreateForm'), '必须存在新建计划表单');
  assert(source.includes('手动添加｜'), '手动添加的计划必须能被标注出来');
  assert(source.includes('data-action="add-fact"'), '事实页必须有「添加事实」按钮');
  assert(source.includes('openFactCreateForm'), '必须存在新建事实表单');
  assert(source.includes('openFactEditForm'), '必须存在编辑事实表单');
  assert(source.includes('记录于 '), '事实必须显示记录时间');

  // 事实归组后必须带 chatId，否则保存时服务端会以 chatId is required 拒绝
  const groupedFacts = manager.normalizeFactPanelList([
    { id: 'g1', chatId: 'chat-1', subjectKey: 'user', slotKey: 'user.residence.current', value: '临空', statement: '我最近住在临空。', status: 'shadow_candidate', confidence: 0.9, effectiveAt: panelNow }
  ]);
  assert.equal(groupedFacts[0].current.chatId, 'chat-1');

  const factEditBody = manager.buildFactUpsertBody(groupedFacts[0].current, { statement: '我最近住在天行。', value: '我最近住在天行。' });
  assert.equal(factEditBody.confirm, 'UPSERT_CURRENT_FACT');
  assert.equal(factEditBody.fact.id, 'g1');
  assert.equal(factEditBody.fact.chatId, 'chat-1');
  assert.equal(factEditBody.fact.slotKey, 'user.residence.current');
  assert.equal(factEditBody.fact.statement, '我最近住在天行。');
  assert.equal(factEditBody.fact.status, 'shadow_candidate', '编辑时必须保留原状态');
  assert.equal(factEditBody.fact.factType, 'current_residence', 'factType 需要按槽位推断出来');

  const factCreateBody = manager.buildFactUpsertBody({ chatId: 'chat-1' }, {
    slotKey: 'user.residence.current',
    statement: '我最近住在云端湖。',
    value: '我最近住在云端湖。',
    status: 'shadow_candidate',
    confidence: 0.99,
    effectiveAt: panelNow,
    evidence: { manual: true }
  });
  assert.equal(factCreateBody.fact.id, '', '新建事实不能带 id');
  assert.equal(factCreateBody.fact.chatId, 'chat-1');
  assert.equal(factCreateBody.fact.factType, 'current_residence');
  assert.equal(factCreateBody.fact.evidence.manual, true);
  assert.equal(factCreateBody.fact.validUntil, null);

  // 撤回：有效期还在未来时原样恢复，不受影响
  const restoreFuture = manager.buildPlanRestoreChanges(
    { id: 'r1', status: 'completed', validUntil: panelNow + 86400000 },
    panelNow
  );
  assert.equal(restoreFuture.changes.status, 'planned');
  assert.equal(restoreFuture.extended, false);
  assert.equal(restoreFuture.changes.validUntil, undefined, '有效期还没过就不该动它');

  // 撤回：有效期已过（或没有）时必须顺延，否则撤回后立刻又算过期、注入不了
  const restorePast = manager.buildPlanRestoreChanges(
    { id: 'r2', status: 'completed', validUntil: panelNow - 1000 },
    panelNow
  );
  assert.equal(restorePast.changes.status, 'planned');
  assert.equal(restorePast.extended, true);
  assert.equal(restorePast.changes.validUntil, panelNow + 86400000 * 2);

  const restoreMissing = manager.buildPlanRestoreChanges({ id: 'r3', status: 'archived' }, panelNow);
  assert.equal(restoreMissing.extended, true, '没有有效期的条目撤回后同样要顺延');

  assert(source.includes('data-action="restore"'), '已完成/已过期的计划必须有「撤回」按钮');
  assert(source.includes("action === 'restore'"), '撤回必须接上事件处理');
  assert(source.includes('不要把「我」当成你自己'), '注入段必须声明条目里的「我」指用户');

  // 防误删：确认框必须是面板内联展开（全局弹窗在 index.html 里有 8 个同 id 元素，不可靠）
  assert.equal(typeof manager.askInlineConfirm, 'function');
  assert.equal(typeof manager.askDeletePlan, 'function');
  assert.equal(typeof manager.askDeleteFact, 'function');
  assert(source.includes('确认要彻底删除这条计划吗'), '删除计划必须说明不可恢复');
  assert(source.includes('确认要彻底删除这条事实吗'), '删除事实必须说明不可恢复');
  assert(source.includes('确认要清理吗'), '「清理过期与已完成」必须有确认文案');
  assert(source.includes('确认要清空已归档吗'), '「清空已归档」必须有确认文案');
  assert(source.includes('data-inline-confirm'), '确认必须内联展开在面板里');
  assert.ok(!source.includes('window.showCustomConfirm('), '不得再调用有 id 冲突的全局弹窗');
  assert.ok(
    (source.match(/this\.askInlineConfirm\(/g) || []).length >= 3,
    '删除计划、删除事实、两个清理动作都要接上内联确认'
  );
  assert(source.includes('getPanelBuildTag'), '面板必须显示实际加载的脚本版本');

  // 归档与删除必须是两个不同动作，且删除走物理删除接口
  assert(source.includes('data-action="archive"'), '生效中的计划必须有「归档」按钮');
  assert(source.includes("'/memory/active-events/delete'"), '计划删除必须走物理删除接口');
  assert(source.includes("'/memory/current-facts/delete'"), '事实删除必须走物理删除接口');
  assert(source.includes("action === 'archive'"), '归档必须接上事件处理');
  assert(source.includes('想保留的话请改用「归档」'), '删除确认里要指引用户改用归档');
  assert(source.includes('清理过期与已完成'), '清理按钮必须改名');
  assert(source.includes('清空已归档'), '必须新增清空已归档');
  assert(source.includes("this.askPurgePlans(chat, body, 'finished'"), '清理过期与已完成 要用 finished 作用域');
  assert(source.includes("this.askPurgePlans(chat, body, 'archived'"), '清空已归档 要用 archived 作用域');
  assert(source.includes('**不含已归档**'), '清理过期与已完成的文案必须说明不含归档');
  assert.ok(!source.includes('/memory/active-events/purge-finished'), '不得再调用旧的 purge-finished 接口');
  assert.ok(!source.includes('purgeFinishedPlans'), '旧的清理方法必须删干净');

  // 已归档的计划必须仍能看到并撤回，不能凭空消失
  const archiveView = manager.normalizePlanPanelList([
    { id: 'a1', title: '被归档的计划', status: 'archived', startAt: panelNow + 1000, validUntil: panelNow + 999000 },
    { id: 'a2', title: '还活着的计划', status: 'planned', startAt: panelNow + 1000, validUntil: panelNow + 999000 }
  ], { includeFinished: true, now: panelNow });
  assert.equal(archiveView.find(plan => plan.id === 'a1').deleted, true, 'archived 必须标记出来');
  assert.equal(archiveView.find(plan => plan.id === 'a2').deleted, false);
  assert(source.includes('已归档（'), '必须有「已归档」分区，归档的才能撤回');

  // 槽位里所有版本都被删除时整组消失；只要还有有效版本，被删的版本不能当当前值
  assert.equal(
    manager.normalizeFactPanelList([
      { id: 'd1', chatId: 'chat-1', slotKey: 'user.body.cough', value: '咳嗽', status: 'archived', effectiveAt: panelNow }
    ]).length,
    0,
    '全被删除的槽位不得再显示'
  );
  const mixedFacts = manager.normalizeFactPanelList([
    { id: 'd2', chatId: 'chat-1', slotKey: 'user.body.cough', value: '咳嗽', status: 'archived', effectiveAt: panelNow + 5000 },
    { id: 'd3', chatId: 'chat-1', slotKey: 'user.body.cough', value: '已经好了', status: 'shadow_candidate', effectiveAt: panelNow }
  ]);
  assert.equal(mixedFacts.length, 1);
  assert.equal(mixedFacts[0].current.id, 'd3', '被删除的版本即使时间更新也不能当当前值');

  // 事实槽位下拉框（手机上下拉框比 datalist 可靠）
  assert.equal(typeof manager.resolveFactSlotKey, 'function');
  assert.equal(manager.resolveFactSlotKey({ type: 'user.residence.current' }), 'user.residence.current');
  assert.equal(manager.resolveFactSlotKey({ type: 'user.task.', taskName: '论文' }), 'user.task.论文');
  assert.equal(manager.resolveFactSlotKey({ type: 'user.body.', bodyKey: 'head_pain' }), 'user.body.head_pain');
  assert.equal(manager.resolveFactSlotKey({ type: '__custom__', customKey: 'user.x.y' }), 'user.x.y');
  assert.equal(manager.resolveFactSlotKey({ type: 'user.task.', taskName: '' }), '', '任务没填名字时不能给出半截槽位');
  assert.equal(manager.resolveFactSlotKey({ type: 'user.body.', bodyKey: '' }), '', '身体没选部位时不能给出半截槽位');

  assert.deepEqual(manager.splitFactSlotKey('user.task.论文'), { type: 'user.task.', taskName: '论文' });
  assert.deepEqual(manager.splitFactSlotKey('user.body.cough'), { type: 'user.body.', bodyKey: 'cough' });
  assert.deepEqual(manager.splitFactSlotKey('user.residence.current'), { type: 'user.residence.current' });
  assert.deepEqual(manager.splitFactSlotKey('user.weird.thing'), { type: '__custom__', customKey: 'user.weird.thing' });

  // 下拉框必须覆盖抽取器会产生的全部 5 类槽位
  const slotTypeValues = manager.getFactSlotTypeOptions().map(option => option.value);
  ['user.residence.current', 'user.location.current', 'user.trip.current', 'user.task.', 'user.body.']
    .forEach(value => assert.ok(slotTypeValues.includes(value), `下拉框必须包含 ${value}`));
  assert.equal(manager.getFactBodyPartOptions().length, 14, '身体部位应列出全部 14 个锚点');

  assert(source.includes('buildFactSlotPickerHtml'), '必须有槽位下拉框');
  assert(source.includes('data-field="slotType"'), '类型必须是真正的 select');
  assert.ok(!source.includes('vm-fact-slot-options'), '旧的 datalist 必须删掉（手机上不弹）');

  // ---- 事实注入：只注入 status === 'current' ----
  const factNow = Date.now();
  const factCalls = [];
  manager.externalMemoryRequest = async (_chat, requestPath, options = {}) => {
    factCalls.push({ requestPath: String(requestPath), body: options?.body });
    if (String(requestPath).startsWith('/memory/active-events')) return { ok: true, events: [] };
    if (String(requestPath).startsWith('/memory/current-facts?')) {
      return {
        ok: true,
        facts: [
          { id: 'f-cur', slotKey: 'user.residence.current', value: '临空', statement: '我最近住在临空。', status: 'current', confidence: 0.99, effectiveAt: factNow },
          { id: 'f-old', slotKey: 'user.residence.current', value: '天行', statement: '我以前住在天行。', status: 'superseded', confidence: 0.9, effectiveAt: factNow - 1000 },
          { id: 'f-task', slotKey: 'user.task.论文', value: '写论文', statement: '论文在为答辩做准备。', status: 'current', confidence: 0.99, effectiveAt: factNow - 500 },
          { id: 'f-cand', slotKey: 'user.body.cough', value: '咳嗽', statement: '我在咳嗽。', status: 'shadow_candidate', confidence: 0.9, effectiveAt: factNow }
        ]
      };
    }
    if (requestPath === '/memory/search') return { ok: true, memories: [], searchTraceId: 'trace-facts' };
    if (requestPath === '/memory/search/commit') return { ok: true, log: { status: 'prompt_committed' }, recallUpdates: [] };
    return { ok: true, recallUpdates: [] };
  };

  const factPrompt = await manager.serializeForPrompt(chat, '随便聊两句');
  assert(factPrompt.includes('当前仍然成立的事实'), 'current 事实必须被注入');
  assert(factPrompt.includes('居住地｜我最近住在临空。'), '事实必须带槽位标签');
  assert(factPrompt.includes('任务：论文｜论文在为答辩做准备。'), '任务槽位标签必须正确');
  assert(!factPrompt.includes('天行'), 'superseded 版本不得注入');
  assert(!factPrompt.includes('我在咳嗽'), '候选态事实不得注入（避免自动抽取的噪音污染）');
  assert(factPrompt.includes('不要把「我」当成你自己'), '事实段也必须带视角声明');

  // 没有 current 事实时不应出现空段落
  manager.externalMemoryRequest = async (_chat, requestPath) => {
    if (String(requestPath).startsWith('/memory/active-events')) return { ok: true, events: [] };
    if (String(requestPath).startsWith('/memory/current-facts?')) {
      return { ok: true, facts: [{ id: 'c1', slotKey: 'user.body.cough', value: '咳嗽', statement: '我在咳嗽。', status: 'shadow_candidate' }] };
    }
    if (requestPath === '/memory/search') return { ok: true, memories: [], searchTraceId: 'trace-nofact' };
    if (requestPath === '/memory/search/commit') return { ok: true, log: { status: 'prompt_committed' }, recallUpdates: [] };
    return { ok: true, recallUpdates: [] };
  };
  const noFactPrompt = await manager.serializeForPrompt(chat, '随便聊两句');
  assert(!noFactPrompt.includes('当前仍然成立的事实'), '没有 current 事实时不应出现事实段');

  // ---- 手动添加事实必须自动设为当前（否则注入不了）----
  manager.externalMemoryRequest = async (_chat, requestPath, options = {}) => {
    factCalls.push({ requestPath: String(requestPath), body: options?.body });
    if (requestPath === '/memory/current-facts/upsert') return { ok: true, fact: { id: 'brand-new-fact' } };
    if (requestPath === '/memory/current-facts/promote') return { ok: true, fact: { id: 'brand-new-fact', status: 'current' } };
    return { ok: true, recallUpdates: [] };
  };
  const originalRenderPanel = manager.renderPlanFactPanel;
  manager.renderPlanFactPanel = async () => {};
  factCalls.length = 0;
  await manager.createFact(chat, {}, { slotKey: 'user.location.current', statement: '我现在在临空。' });
  manager.renderPlanFactPanel = originalRenderPanel;

  const upsertCall = factCalls.find(call => call.requestPath === '/memory/current-facts/upsert');
  const promoteCall = factCalls.find(call => call.requestPath === '/memory/current-facts/promote');
  assert(upsertCall, '必须调用 upsert 写入事实');
  assert.equal(upsertCall.body.fact.slotKey, 'user.location.current');
  assert(promoteCall, '添加后必须自动调用 promote，否则事实永远不会注入');
  assert.equal(promoteCall.body.confirm, 'PROMOTE_CURRENT_FACT');
  assert.equal(promoteCall.body.id, 'brand-new-fact', 'promote 必须针对刚写入的那条');

  // ---- C 阶段：传给服务端的「角色最后一句对话」 ----
  const charMsg = {
    role: 'assistant',
    dialogue: '好啊，那我们周五去看奶奶吧。',
    content: '{"type":"offline_text","content":"「好啊」我们周五去看奶奶吧。"}'
  };
  const userAskMsg = { role: 'user', content: '这周五是中秋节，我们最近要不要去看看奶奶' };
  const askScope = manager.createActiveEventSourceContext(chat, [userAskMsg, charMsg], null);
  assert.equal(askScope.latestAssistantDialogue, '好啊，那我们周五去看奶奶吧。', '必须用结构化的 dialogue 字段');
  assert.ok(!askScope.latestAssistantDialogue.includes('"type"'), '半角引号是 JSON 语法，绝不能当对话内容');
  assert.equal(askScope.latestSpeakerRole, 'assistant');

  // 没有 dialogue 字段时不猜（引号解析方案已放弃）
  const noDialogueScope = manager.createActiveEventSourceContext(chat, [userAskMsg, { role: 'assistant', content: '「走啊」' }], null);
  assert.equal(noDialogueScope.latestAssistantDialogue, '', '没有 dialogue 字段时应留空，不能靠引号猜');

  // ---- 待确认的计划必须单独分组（不能混进「生效中」）----
  const panelPlans = manager.normalizePlanPanelList([
    { id: 'p-ask', title: '要不要去看奶奶', status: 'candidate', awaitingConfirmation: 1, confirmDeadline: Date.now() + 3600000, startAt: Date.now() + 86400000 },
    { id: 'p-live', title: '明天去医院复诊', status: 'planned', startAt: Date.now() + 86400000 }
  ], { includeFinished: true });
  const askPlan = panelPlans.find(plan => plan.id === 'p-ask');
  const livePlan = panelPlans.find(plan => plan.id === 'p-live');
  assert.equal(askPlan.pending, true, 'awaitingConfirmation 的计划必须标记 pending');
  assert.equal(askPlan.deleted, false, '待确认不是归档');
  assert.equal(livePlan.pending, false);
  assert(source.includes('待确认（'), '面板必须有「待确认」分组');
  assert(source.includes('等角色答复后自动定案'), '待确认分组必须有说明');

  // 编辑待确认的计划时，绝不能把「待确认」标记丢掉（否则绕过角色确认直接生效）
  const pendingDeadline = Date.now() + 3600000;
  const pendingUpsert = manager.buildPlanUpsertBody({
    id: 'p-ask',
    chatId: 'chat-1',
    title: '要不要去看奶奶',
    summary: '要不要去看奶奶',
    status: 'candidate',
    awaitingConfirmation: true,
    confirmDeadline: pendingDeadline,
    confidence: 0.5
  }, { title: '要不要周五去看奶奶' });
  assert.equal(pendingUpsert.event.awaitingConfirmation, true, '编辑时必须保留 awaitingConfirmation');
  assert.equal(pendingUpsert.event.confirmDeadline, pendingDeadline, '编辑时必须保留定案截止时间');

  // ---- 服务端分页 + 日期筛选（面板能查到本地缓存之外的老记忆）----
  const pagingCalls = [];
  manager.externalMemoryRequest = async (_chat, requestPath) => {
    pagingCalls.push(String(requestPath));
    if (String(requestPath).startsWith('/memory/list')) {
      return {
        ok: true,
        total: String(requestPath).includes('query=') ? 1 : 5423,
        hasMore: !String(requestPath).includes('offset=100'),
        memories: [
          { id: 'p1', content: '第一页', category: 'E', memoryTime: String(Date.now()), createdAt: String(Date.now()), embedding: [0.1, 0.2] }
        ]
      };
    }
    return { ok: true, recallUpdates: [] };
  };

  assert.deepEqual(
    manager.getActivePanelFilters({ query: '', category: '', minImportance: '', dateFrom: '', dateTo: '' }),
    {},
    '空筛选不能触发服务端查询'
  );
  const filterKeyA = manager.getPanelFilterKey({ query: '奶奶', dateFrom: '2025-12-19' });
  const filterKeyB = manager.getPanelFilterKey({ query: '奶奶', dateFrom: '2025-12-20' });
  assert.notEqual(filterKeyA, filterKeyB, '筛选条件变化必须换 key，否则不会重新查询');

  const dateBounds = manager.getPanelDateBounds({ dateFrom: '2025-12-19', dateTo: '2025-12-19' });
  assert.equal(dateBounds.fromTs, new Date('2025-12-19T00:00:00').getTime());
  assert.equal(dateBounds.toTs, new Date('2025-12-19T23:59:59.999').getTime());

  pagingCalls.length = 0;
  const pagedResult = await manager.fetchMemoryPanelPage(
    chat,
    { dateFrom: '2025-12-19', dateTo: '2025-12-19', query: '奶奶' },
    100,
    100
  );
  const listUrl = pagingCalls[0];
  assert(listUrl.includes('limit=100'), '必须带 limit');
  assert(listUrl.includes('offset=100'), '必须带 offset');
  assert(listUrl.includes('query='), '必须带 query');
  assert(listUrl.includes('fromTs='), '日期必须传毫秒下界');
  assert(listUrl.includes('toTs='), '日期必须传毫秒上界');
  assert(!listUrl.includes('chatId='), '面板一直显示全部记忆，不能按 chat 过滤');
  assert.equal(pagedResult.items[0].embedding, null, 'embedding 不得留在前端');
  assert.equal(pagedResult.total, 1);

  // 分页状态：首屏 + 追加第二页（重复 id 要自动去重）
  const originalRenderMemoryUI = manager.renderMemoryUI;
  manager.renderMemoryUI = () => {};
  manager.getVariableMemory(chat)._memPanel = null;
  await manager.loadMemoryPanelPage(chat, {}, { query: '奶奶' }, 0, {});
  let memPanel = manager.getVariableMemory(chat)._memPanel;
  assert.equal(memPanel.serverMode, true);
  assert.equal(memPanel.items.length, 1);
  await manager.loadMemoryPanelPage(chat, {}, { query: '奶奶' }, 100, { append: true });
  memPanel = manager.getVariableMemory(chat)._memPanel;
  assert.equal(memPanel.items.length, 1, '翻页时重复 id 必须去重');
  manager.renderMemoryUI = originalRenderMemoryUI;

  assert(source.includes('正在从服务器查询'), '必须有"正在查询"的占位提示');
  assert(source.includes('共 ${vm._memTotal} 条'), '必须提示服务端总条数（本地缓存可能不全）');

  console.log('Vector memory UI tests passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
