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
vm.runInNewContext(source, sandbox, { filename: 'vector-memory.js' });

async function main() {
  const manager = sandbox.window.vectorMemoryManager;
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
  lifecycleCalls.length = 0;
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
