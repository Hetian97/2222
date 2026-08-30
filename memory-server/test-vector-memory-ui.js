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

  console.log('Vector memory UI tests passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
