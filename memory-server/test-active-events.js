const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-active-events-'));
process.env.MEMORY_DB_PATH = path.join(testDir, 'memory.db');

const {
  db,
  listMemoryActiveEvents,
  upsertMemoryActiveEvent,
  archiveMemoryActiveEvent
} = require('./db');
const { runActiveEventShadow, runActiveEventExtractionShadow } = require('./memory-active-event-shadow');

try {
  const event = upsertMemoryActiveEvent({
    id: 'event-trip',
    chatId: 'chat-1',
    title: '学术会议行程',
    aliases: ['二十号出发', '北京会议'],
    status: 'planned',
    validUntil: Date.now() + 86400000,
    confidence: 0.9
  });
  assert.strictEqual(event.surfaceMode, 'on_reference');
  assert.strictEqual(event.proactiveMention, false);

  let events = listMemoryActiveEvents({ chatId: 'chat-1' });
  assert.strictEqual(events.length, 1);

  const unrelated = runActiveEventShadow(events, { query: '我去浴室洗漱，然后下楼吃早饭' });
  assert.strictEqual(unrelated.selectedCount, 0);
  assert.strictEqual(unrelated.behaviorChanged, false);
  assert.strictEqual(unrelated.injectionEnabled, false);

  const direct = runActiveEventShadow(events, { query: '二十号出发的安排还照旧吗？' });
  assert.deepStrictEqual(direct.selectedEventIds, ['event-trip']);
  assert.strictEqual(direct.decisions[0].route, 'direct_reference');

  const indirect = runActiveEventShadow(events, { query: '我突然不想去了，怎么办？' });
  assert.deepStrictEqual(indirect.selectedEventIds, ['event-trip']);
  assert.strictEqual(indirect.decisions[0].route, 'indirect_reference');

  const futureProposal = runActiveEventExtractionShadow([], {
    query: '八天之后要出发，会议材料需要提前准备好。',
    timeZone: 'Asia/Shanghai',
    sourceScope: {
      type: 'private',
      sourceChatId: 'chat-1',
      mountedChatId: 'chat-1',
      latestSpeakerRole: 'user'
    }
  });
  assert.strictEqual(futureProposal.version, 'active-event-extraction-shadow-v2');
  assert.strictEqual(futureProposal.writesEnabled, false);
  assert.strictEqual(futureProposal.proposalCount, 1);
  assert.strictEqual(futureProposal.proposals[0].action, 'create_candidate');
  assert.ok(futureProposal.proposals[0].temporalEvidence.includes('八天之后'));
  assert.strictEqual(futureProposal.sourceScope.type, 'private');
  assert.strictEqual(futureProposal.sourceScope.privateMemoryEligible, true);

  const adjacentDetails = runActiveEventExtractionShadow([], {
    query: '今天已经来不及了。明天需要兑现先前的约定。之前答应共同整理项目材料。',
    timeZone: 'Asia/Shanghai',
    sourceScope: {
      type: 'group',
      sourceChatId: 'group-7',
      mountedChatId: 'chat-1',
      speakerIds: ['member-a', 'member-b'],
      participantIds: ['member-a', 'member-b', 'chat-1']
    }
  });
  assert.strictEqual(adjacentDetails.proposalCount, 1);
  assert.strictEqual(adjacentDetails.proposals[0].mergedFromAdjacentClauses, true);
  assert.deepStrictEqual(adjacentDetails.proposals[0].sourceClauseIndexes, [1, 2]);
  assert.ok(adjacentDetails.proposals[0].clause.includes('共同整理项目材料'));
  assert.ok(adjacentDetails.proposals[0].reasons.includes('adjacent_clause_context'));
  assert.strictEqual(adjacentDetails.sourceScope.type, 'group');
  assert.strictEqual(adjacentDetails.sourceScope.sourceChatId, 'group-7');
  assert.strictEqual(adjacentDetails.sourceScope.mountedChatId, 'chat-1');
  assert.strictEqual(adjacentDetails.sourceScope.privateMemoryEligible, false);
  assert.strictEqual(adjacentDetails.sourceScope.visibilityHint, 'source_scope_on_reference');

  const sameDayScene = runActiveEventExtractionShadow([], {
    query: '今晚要吃完饭再去散步。',
    timeZone: 'Asia/Shanghai',
    sourceScope: { type: 'private', sourceChatId: 'chat-1' }
  });
  assert.strictEqual(sameDayScene.proposalCount, 0);

  const pastOnly = runActiveEventExtractionShadow([], {
    query: '昨天在家吃了一个苹果。',
    timeZone: 'Asia/Shanghai'
  });
  assert.strictEqual(pastOnly.proposalCount, 0);
  assert.ok(pastOnly.decisions[0].reasons.includes('past_only_not_active'));

  const uncertainQuestion = runActiveEventExtractionShadow([], {
    query: '如果明天下雨，吃什么比较好？',
    timeZone: 'Asia/Shanghai'
  });
  assert.strictEqual(uncertainQuestion.proposalCount, 0);

  const referencedUpdate = runActiveEventExtractionShadow(events, {
    query: '二十号出发的安排继续照旧。',
    timeZone: 'Asia/Shanghai'
  });
  assert.strictEqual(referencedUpdate.proposals[0].action, 'update_candidate');
  assert.strictEqual(referencedUpdate.proposals[0].targetEventId, 'event-trip');

  const referencedCancellation = runActiveEventExtractionShadow(events, {
    query: '那件事取消了。',
    timeZone: 'Asia/Shanghai'
  });
  assert.strictEqual(referencedCancellation.proposals[0].action, 'cancel_candidate');
  assert.strictEqual(referencedCancellation.proposals[0].targetEventId, 'event-trip');

  upsertMemoryActiveEvent({
    id: 'event-dinner',
    chatId: 'chat-1',
    title: '朋友晚餐约定',
    status: 'planned'
  });
  events = listMemoryActiveEvents({ chatId: 'chat-1' });
  const ambiguous = runActiveEventShadow(events, { query: '那件事怎么办？' });
  assert.strictEqual(ambiguous.selectedCount, 0);
  assert.strictEqual(ambiguous.selectionStopReason, 'ambiguous_reference');

  upsertMemoryActiveEvent({
    id: 'event-expired',
    chatId: 'chat-1',
    title: '已经过期的安排',
    status: 'planned',
    validUntil: Date.now() - 1000
  });
  const expired = runActiveEventShadow(listMemoryActiveEvents({ chatId: 'chat-1' }), { query: '已经过期的安排' });
  assert.ok(!expired.selectedEventIds.includes('event-expired'));

  const archived = archiveMemoryActiveEvent('event-dinner', 'completed');
  assert.strictEqual(archived.status, 'completed');
  assert.ok(!listMemoryActiveEvents({ chatId: 'chat-1' }).some(item => item.id === 'event-dinner'));
  assert.ok(listMemoryActiveEvents({ chatId: 'chat-1', includeArchived: true }).some(item => item.id === 'event-dinner'));

  console.log('Active event shadow tests passed.');
} finally {
  db.close();
  fs.rmSync(testDir, { recursive: true, force: true });
}
