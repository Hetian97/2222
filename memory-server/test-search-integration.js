const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-search-test-'));
const dbPath = path.join(testDir, 'memory.db');
const port = 18765 + Math.floor(Math.random() * 1000);

process.env.MEMORY_DB_PATH = dbPath;
const database = require('./db');

database.addMemory({
  id: 'very_old_beijing_trip',
  chatId: 'chat-1',
  content: '北京学术出差将在二十号出发，持续七天',
  tags: ['北京', '学术出差'],
  importance: 8,
  memoryTime: 1
});
database.addMemory({
  id: 'core_beijing',
  chatId: 'chat-1',
  category: 'C',
  content: '北京出差核心常驻记忆',
  tags: ['北京'],
  importance: 10,
  memoryTime: 2
});
database.addMemory({
  id: 'beijing_weather_noise',
  chatId: 'chat-1',
  category: 'E',
  content: '北京今天阳光很好，路边有人买了一瓶水',
  tags: ['北京'],
  importance: 10,
  emotionalWeight: 10,
  memoryTime: 3
});
database.addMemory({
  id: 'arbitrary_phrase_memory',
  chatId: 'chat-1',
  category: 'I',
  content: '她把紫檀书签收进了窗边的蓝色盒子里',
  tags: [],
  importance: 5,
  memoryTime: 4
});

for (let index = 0; index < 30; index++) {
  database.addMemory({
    id: `recent_${index}`,
    chatId: 'chat-1',
    content: `普通日常记忆 ${index}`,
    tags: ['日常'],
    memoryTime: Date.now() + index
  });
}

database.db.close();

function request(method, pathname, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : '';
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: pathname,
      method,
      headers: payload ? {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      } : {}
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function waitForServer(child) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('server startup timed out')), 10000);
    child.stdout.on('data', data => {
      if (String(data).includes('Aion Memory Server running')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.once('exit', code => {
      clearTimeout(timeout);
      reject(new Error(`server exited early with code ${code}`));
    });
  });
}

async function main() {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: __dirname,
    env: {
      ...process.env,
      PORT: String(port),
      MEMORY_DB_PATH: dbPath,
      MEMORY_SEARCH_ENGINE: 'hybrid',
      EMBEDDING_ENDPOINT: '',
      EMBEDDING_API_KEY: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  try {
    await waitForServer(child);

    const status = await request('GET', '/memory/fts/status');
    assert.equal(status.status, 200);
    assert.equal(status.body.fts.integrity, 'ok');
    assert.equal(status.body.fts.totalMemories, 34);

    const arbitraryPhraseSearch = await request('POST', '/memory/search', {
      query: '窗边那个紫檀书签放在哪里了',
      searchEngine: 'sqlite',
      chatId: 'chat-1',
      excludeCategories: ['C'],
      limit: 3
    });
    assert.equal(arbitraryPhraseSearch.status, 200);
    assert.equal(arbitraryPhraseSearch.body.memories[0].id, 'arbitrary_phrase_memory');

    const participantTagSave = await request('POST', '/memory/add', {
      id: 'participant_tag_filter',
      chatId: 'chat-1',
      content: '与乔教授在海棠树下聊天室讨论定位信标',
      tags: ['夏以昼', '阿鹤', '夏太太', '乔教授', '海棠树下聊天室', '定位信标'],
      participantNames: ['夏以昼', '阿鹤', '夏太太'],
      category: 'E'
    });
    assert.equal(participantTagSave.status, 200);
    assert.deepEqual(participantTagSave.body.memory.tags, ['乔教授', '海棠树下聊天室', '定位信标']);

    const search = await request('POST', '/memory/search', {
      query: '北京出差',
      queryVariants: ['二十号出发'],
      shadowPrimaryQuery: '二十号出发',
      shadowContextQueries: ['北京出差'],
      actionType: 'reply',
      searchEngine: 'hybrid',
      chatId: 'chat-1',
      excludeCategories: ['C'],
      limit: 5,
      candidateLimit: 10,
      diagnostic: true
    });

    assert.equal(search.status, 200);
    assert.equal(search.body.fts.attempted, true);
    assert(search.body.memories.some(memory => memory.id === 'very_old_beijing_trip'));
    assert(!search.body.memories.some(memory => memory.category === 'C'));
    assert.equal(search.body.shadowPolicy.mode, 'shadow');
    assert.equal(search.body.shadowPolicy.version, 'stage3-shadow-v1.4');
    assert.equal(search.body.shadowPolicy.behaviorChanged, false);
    assert.equal(search.body.shadowPolicy.primaryQuery, '二十号出发');
    assert.equal(search.body.shadowPolicy.evidenceMode, 'primary-intent-context-reference');
    assert(search.body.shadowPolicy.candidateCount >= search.body.memories.length);
    assert(search.body.memories.some(memory => memory.id === 'beijing_weather_noise'));

    const realSearch = await request('POST', '/memory/search', {
      query: '北京出差',
      searchEngine: 'hybrid',
      chatId: 'chat-1',
      turnId: 'turn-stage3-lifecycle',
      attemptId: 'attempt-stage3-success',
      excludeCategories: ['C'],
      limit: 5
    });
    assert(realSearch.body.searchTraceId);
    assert(realSearch.body.memories.length > 0 && realSearch.body.memories.length <= 5);

    const persistedShadow = await request('GET', '/memory/search/last');
    assert.equal(persistedShadow.body.lastSearch.shadowPolicy.mode, 'shadow');
    assert.equal(persistedShadow.body.lastSearch.shadowPolicy.version, 'stage3-shadow-v1.4');
    assert.equal(persistedShadow.body.lastSearch.shadowPolicy.behaviorChanged, false);
    assert.equal(persistedShadow.body.lastSearch.turnId, 'turn-stage3-lifecycle');
    assert.equal(persistedShadow.body.lastSearch.attemptId, 'attempt-stage3-success');
    assert.equal(persistedShadow.body.lastSearch.actionType, 'reply');
    assert(Array.isArray(persistedShadow.body.lastSearch.shadowPolicy.decisions));
    assert(persistedShadow.body.lastSearch.resultsTop.some(item => item.shadow));
    const noiseDecision = persistedShadow.body.lastSearch.shadowPolicy.decisions
      .find(decision => decision.id === 'beijing_weather_noise');
    assert(noiseDecision);
    assert.equal(noiseDecision.admitted, false, JSON.stringify(noiseDecision));
    assert(noiseDecision.signals.keyword < noiseDecision.signals.legacyKeyword);
    assert(persistedShadow.body.lastSearch.resultMemoryIds.includes('beijing_weather_noise'));

    const firstCommit = await request('POST', '/memory/search/commit', {
      searchTraceId: realSearch.body.searchTraceId,
      memoryIds: ['very_old_beijing_trip'],
      lifecycleVersion: 2
    });
    assert.equal(firstCommit.body.committed, true);
    assert.equal(firstCommit.body.recallDeferred, true);
    assert.equal(firstCommit.body.log.status, 'prompt_committed');
    assert.deepEqual(firstCommit.body.recallUpdates, [{
      id: 'very_old_beijing_trip',
      recallCount: 0,
      lastRecalled: 0
    }]);

    const generationSuccess = await request('POST', '/memory/search/generation', {
      searchTraceId: realSearch.body.searchTraceId,
      outcome: 'succeeded'
    });
    assert.equal(generationSuccess.body.finalized, true);
    assert.equal(generationSuccess.body.recallApplied, true);
    assert.equal(generationSuccess.body.log.status, 'generation_succeeded');
    assert.equal(generationSuccess.body.recallUpdates[0].recallCount, 1);
    assert(generationSuccess.body.recallUpdates[0].lastRecalled > 0);

    const repeatedGenerationSuccess = await request('POST', '/memory/search/generation', {
      searchTraceId: realSearch.body.searchTraceId,
      outcome: 'succeeded'
    });
    assert.equal(repeatedGenerationSuccess.body.alreadyFinalized, true);
    assert.equal(repeatedGenerationSuccess.body.recallApplied, false);
    assert.equal(repeatedGenerationSuccess.body.recallUpdates.length, 0);

    const repeatedCommit = await request('POST', '/memory/search/commit', {
      searchTraceId: realSearch.body.searchTraceId,
      memoryIds: ['very_old_beijing_trip']
    });
    assert.equal(repeatedCommit.body.alreadyCommitted, true);
    assert.equal(repeatedCommit.body.recallUpdates[0].recallCount, 1);

    const failedSearch = await request('POST', '/memory/search', {
      query: '北京出差', searchEngine: 'hybrid', chatId: 'chat-1', excludeCategories: ['C'], limit: 5
    });
    await request('POST', '/memory/search/commit', {
      searchTraceId: failedSearch.body.searchTraceId,
      memoryIds: ['very_old_beijing_trip'],
      lifecycleVersion: 2
    });
    const generationFailure = await request('POST', '/memory/search/generation', {
      searchTraceId: failedSearch.body.searchTraceId,
      outcome: 'failed',
      error: 'test failure'
    });
    assert.equal(generationFailure.body.recallApplied, false);
    assert.equal(generationFailure.body.log.status, 'generation_failed');
    assert.equal(generationFailure.body.recallUpdates.length, 0);

    const legacySearch = await request('POST', '/memory/search', {
      query: '北京出差', searchEngine: 'hybrid', chatId: 'chat-1', excludeCategories: ['C'], limit: 5
    });
    const legacyCommit = await request('POST', '/memory/search/commit', {
      searchTraceId: legacySearch.body.searchTraceId,
      memoryIds: ['very_old_beijing_trip']
    });
    assert.equal(legacyCommit.body.committed, true);
    assert.equal(legacyCommit.body.recallDeferred, false);
    assert.equal(legacyCommit.body.log.status, 'generation_succeeded');
    assert.equal(legacyCommit.body.recallUpdates[0].recallCount, 2);

    const vectorCreate = await request('POST', '/memory/add', {
      id: 'metadata_edit_vector',
      chatId: 'chat-1',
      content: '带有服务端向量的记忆',
      category: 'E',
      embedding: [0.1, 0.2, 0.3],
      embeddingModel: 'test-model',
      embeddingDim: 3
    });
    assert.equal(vectorCreate.body.memory.hasEmbedding, true);
    assert.equal(Object.prototype.hasOwnProperty.call(vectorCreate.body.memory, 'embedding'), false);

    const metadataOnlyEdit = await request('POST', '/memory/add', {
      id: 'metadata_edit_vector',
      chatId: 'chat-1',
      content: '带有服务端向量的记忆',
      category: 'R',
      tags: ['仅修改分类和标签']
    });
    assert.equal(metadataOnlyEdit.body.memory.hasEmbedding, true);
    assert.equal(metadataOnlyEdit.body.memory.embeddingDim, 3);
    assert.equal(Object.prototype.hasOwnProperty.call(metadataOnlyEdit.body.memory, 'embedding'), false);

    const clearVector = await request('POST', '/memory/add', {
      id: 'metadata_edit_vector',
      chatId: 'chat-1',
      content: '正文改变但向量化失败',
      category: 'R',
      clearEmbedding: true
    });
    assert.equal(clearVector.body.memory.hasEmbedding, false);
    assert.equal(clearVector.body.memory.embeddingDim, 0);

    const rebuild = await request('POST', '/memory/fts/rebuild');
    assert.equal(rebuild.status, 200);
    assert.equal(rebuild.body.fts.integrity, 'ok');

    console.log('Search integration tests passed');
  } finally {
    child.kill();
    await new Promise(resolve => child.once('exit', resolve));
    fs.rmSync(testDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
