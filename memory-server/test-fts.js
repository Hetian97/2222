const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-fts-test-'));
process.env.MEMORY_DB_PATH = path.join(testDir, 'memory.db');

const {
  db,
  addMemory,
  deleteMemory,
  getMemoryById,
  getMemoryFtsStatus,
  rebuildMemoryFts,
  searchMemoriesFts
} = require('./db');

function ids(result) {
  return result.memories.map(memory => memory.id);
}

try {
  const startupStatus = getMemoryFtsStatus();
  assert.equal(startupStatus.available, true);
  assert.equal(startupStatus.integrity, 'ok');

  addMemory({
    id: 'old_trip',
    chatId: 'chat-1',
    content: '北京学术出差将在二十号出发',
    tags: ['北京', '出差'],
    context: '行程计划',
    importance: 8
  });
  addMemory({
    id: 'core_memory',
    chatId: 'chat-1',
    category: 'C',
    content: '北京出差核心常驻设定',
    tags: ['北京'],
    importance: 10
  });
  addMemory({
    id: 'risk_memory',
    chatId: 'chat-1',
    content: '她尝试通过共鸣连接记忆芯片，存在神经元烧毁风险',
    tags: ['共鸣', '芯片风险'],
    importance: 9
  });
  addMemory({
    id: 'other_chat',
    chatId: 'chat-2',
    content: '北京出差是另一个角色的记忆',
    tags: ['北京'],
    importance: 10
  });

  const trip = searchMemoriesFts(['20号就要走了', '北京出差'], {
    chatId: 'chat-1',
    excludeCategories: ['C'],
    limit: 20
  });
  assert.equal(trip.attempted, true);
  assert.deepEqual(ids(trip), ['old_trip']);

  const withoutCore = searchMemoriesFts(['北京出差'], {
    chatId: 'chat-1',
    excludeCategories: ['C'],
    limit: 20
  });
  assert(ids(withoutCore).includes('old_trip'));
  assert(!ids(withoutCore).includes('core_memory'));

  const risk = searchMemoriesFts(['共鸣连接有风险'], {
    chatId: 'chat-1',
    limit: 20
  });
  assert(ids(risk).includes('risk_memory'));
  assert(!ids(risk).includes('other_chat'));

  addMemory({
    ...getMemoryById('old_trip'),
    content: '上海学术会议已经取消',
    tags: ['上海', '取消']
  });
  assert(!ids(searchMemoriesFts(['北京出差'], { chatId: 'chat-1' })).includes('old_trip'));
  assert(ids(searchMemoriesFts(['上海会议取消'], { chatId: 'chat-1' })).includes('old_trip'));

  assert.equal(deleteMemory('risk_memory'), true);
  assert(!ids(searchMemoriesFts(['神经元烧毁风险'], { chatId: 'chat-1' })).includes('risk_memory'));

  const rebuild = rebuildMemoryFts();
  assert.equal(rebuild.total, 3);
  assert.equal(getMemoryFtsStatus().integrity, 'ok');

  console.log('FTS5 tests passed');
} finally {
  db.close();
  fs.rmSync(testDir, { recursive: true, force: true });
}
