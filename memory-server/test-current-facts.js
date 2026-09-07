const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-current-facts-'));
process.env.MEMORY_DB_PATH = path.join(testDir, 'memory.db');

const {
  db,
  createMemorySearchLog,
  commitMemorySearchInjection,
  finishMemorySearchGeneration,
  listMemoryCurrentFacts,
  applyMemoryCurrentFactWrites,
  promoteMemoryCurrentFact,
  invalidateMemoryCurrentFact
} = require('./db');
const { runCurrentFactShadow } = require('./memory-current-fact-shadow');
const { planCurrentFactWrites } = require('./memory-current-fact-writer');

const privateUser = {
  type: 'private',
  sourceChatId: 'chat-1',
  mountedChatId: 'chat-1',
  latestSpeakerRole: 'user'
};

function createSucceededSearch(query, shadow, id) {
  const log = createMemorySearchLog({
    id,
    chatId: 'chat-1',
    source: '/memory/search',
    query,
    currentFactShadow: shadow,
    results: []
  });
  commitMemorySearchInjection(log.id, []);
  finishMemorySearchGeneration(log.id, 'succeeded');
  return log.id;
}

try {
  const locationShadow = runCurrentFactShadow([], {
    query: '我现在在上海。',
    sourceScope: privateUser,
    writesEnabled: true
  });
  assert.strictEqual(locationShadow.version, 'current-fact-shadow-v1');
  assert.strictEqual(locationShadow.behaviorChanged, false);
  assert.strictEqual(locationShadow.injectionEnabled, false);
  assert.strictEqual(locationShadow.candidateCount, 1);
  assert.strictEqual(locationShadow.candidates[0].factType, 'current_location');
  assert.strictEqual(locationShadow.candidates[0].slotKey, 'user.location.current');
  assert.strictEqual(locationShadow.candidates[0].value, '上海');

  const negativeLocation = runCurrentFactShadow(locationShadow.candidates.map((candidate, index) => ({
    id: `location-${index}`,
    slotKey: candidate.slotKey,
    value: candidate.value,
    statement: candidate.statement,
    status: 'shadow_candidate',
    effectiveAt: Date.now()
  })), {
    query: '我现在已经不在上海了。',
    sourceScope: privateUser
  });
  assert.strictEqual(negativeLocation.candidates[0].value, '不在上海');
  assert.strictEqual(negativeLocation.candidates[0].action, 'supersede_candidate');

  const residenceShadow = runCurrentFactShadow([], {
    query: '我目前住在云端湖附近。',
    sourceScope: privateUser
  });
  assert.strictEqual(residenceShadow.candidates[0].factType, 'current_residence');

  const bodyShadow = runCurrentFactShadow([], {
    query: '我的生理期已经结束了。',
    sourceScope: privateUser
  });
  assert.strictEqual(bodyShadow.candidates[0].factType, 'current_body_state');
  assert.strictEqual(bodyShadow.candidates[0].slotKey, 'user.body.menstrual_cycle');

  const bodyResolution = runCurrentFactShadow(bodyShadow.candidates.map((candidate, index) => ({
    id: `body-${index}`,
    slotKey: candidate.slotKey,
    value: candidate.value,
    statement: candidate.statement,
    status: 'shadow_candidate',
    effectiveAt: Date.now()
  })), {
    query: '我的生理期现在已经过去了。',
    sourceScope: privateUser
  });
  assert.strictEqual(bodyResolution.candidates[0].action, 'supersede_candidate');
  assert.strictEqual(bodyResolution.candidates[0].slotKey, 'user.body.menstrual_cycle');

  const tripShadow = runCurrentFactShadow([], {
    query: '我现在还在出差，明晚才回去。',
    sourceScope: privateUser
  });
  assert.strictEqual(tripShadow.candidateCount, 1);
  assert.strictEqual(tripShadow.candidates[0].factType, 'current_trip_state');

  const taskShadow = runCurrentFactShadow([], {
    query: '我现在还在处理项目材料。',
    sourceScope: privateUser
  });
  assert.strictEqual(taskShadow.candidates[0].factType, 'current_task_state');

  const historical = runCurrentFactShadow([], {
    query: '我去年在上海住过一阵。',
    sourceScope: privateUser
  });
  assert.strictEqual(historical.candidateCount, 0);
  assert.ok(historical.decisions[0].reasons.includes('past_only_statement'));

  const future = runCurrentFactShadow([], {
    query: '我明天准备去上海。',
    sourceScope: privateUser
  });
  assert.strictEqual(future.candidateCount, 0);

  const group = runCurrentFactShadow([], {
    query: '我现在在上海。',
    sourceScope: { ...privateUser, type: 'group' }
  });
  assert.strictEqual(group.candidateCount, 0);
  assert.strictEqual(group.stopReason, 'non_private_source_excluded');

  const assistant = runCurrentFactShadow([], {
    query: '我现在在上海。',
    sourceScope: { ...privateUser, latestSpeakerRole: 'assistant' }
  });
  assert.strictEqual(assistant.candidateCount, 0);
  assert.strictEqual(assistant.stopReason, 'non_user_speaker_excluded');

  const disabledPlan = planCurrentFactWrites({
    id: 'disabled-search',
    chatId: 'chat-1',
    status: 'generation_succeeded',
    currentFactShadow: locationShadow
  }, [], { writesEnabled: false });
  assert.strictEqual(disabledPlan.operationCount, 0);
  assert.strictEqual(disabledPlan.reason, 'writes_disabled');

  const firstSearchId = createSucceededSearch('我现在在上海。', locationShadow, 'search-current-fact-1');
  const firstWrite = applyMemoryCurrentFactWrites(firstSearchId, { writesEnabled: true });
  assert.strictEqual(firstWrite.applied, true);
  assert.strictEqual(firstWrite.facts.length, 1);
  assert.strictEqual(firstWrite.facts[0].status, 'shadow_candidate');
  assert.strictEqual(firstWrite.facts[0].surfaceMode, 'manual_only');
  assert.strictEqual(firstWrite.facts[0].supersedesFactId, null);
  const repeatedApply = applyMemoryCurrentFactWrites(firstSearchId, { writesEnabled: true });
  assert.strictEqual(repeatedApply.alreadyApplied, true);
  assert.strictEqual(listMemoryCurrentFacts({ chatId: 'chat-1' }).length, 1);

  const firstFact = firstWrite.facts[0];
  const movedShadow = runCurrentFactShadow([firstFact], {
    query: '我现在在杭州。',
    sourceScope: privateUser,
    writesEnabled: true
  });
  assert.strictEqual(movedShadow.candidates[0].action, 'supersede_candidate');
  assert.strictEqual(movedShadow.candidates[0].targetFactId, firstFact.id);
  const secondSearchId = createSucceededSearch('我现在在杭州。', movedShadow, 'search-current-fact-2');
  const secondWrite = applyMemoryCurrentFactWrites(secondSearchId, { writesEnabled: true });
  assert.strictEqual(secondWrite.facts[0].supersedesFactId, firstFact.id);
  assert.strictEqual(listMemoryCurrentFacts({ chatId: 'chat-1' }).length, 2);

  promoteMemoryCurrentFact(firstFact.id);
  const promoted = promoteMemoryCurrentFact(secondWrite.facts[0].id);
  assert.strictEqual(promoted.status, 'current');
  assert.strictEqual(promoted.supersedesFactId, firstFact.id);
  const allVersions = listMemoryCurrentFacts({ chatId: 'chat-1', includeInactive: true });
  const oldVersion = allVersions.find(item => item.id === firstFact.id);
  assert.strictEqual(oldVersion.status, 'superseded');
  assert.strictEqual(oldVersion.supersededByFactId, promoted.id);

  const invalidated = invalidateMemoryCurrentFact(promoted.id, 'retracted');
  assert.strictEqual(invalidated.status, 'retracted');
  assert.ok(invalidated.invalidatedAt);

  const failedLog = createMemorySearchLog({
    id: 'search-current-fact-failed',
    chatId: 'chat-1',
    source: '/memory/search',
    query: '我现在在苏州。',
    currentFactShadow: runCurrentFactShadow([], {
      query: '我现在在苏州。',
      sourceScope: privateUser,
      writesEnabled: true
    }),
    results: []
  });
  commitMemorySearchInjection(failedLog.id, []);
  finishMemorySearchGeneration(failedLog.id, 'failed', 'cancelled');
  const failedWrite = applyMemoryCurrentFactWrites(failedLog.id, { writesEnabled: true });
  assert.strictEqual(failedWrite.applied, false);
  assert.strictEqual(failedWrite.result.reason, 'generation_not_succeeded');

  console.log('Current fact shadow tests passed.');
} finally {
  db.close();
  fs.rmSync(testDir, { recursive: true, force: true });
}
