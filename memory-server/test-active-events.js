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
const { runActiveEventShadow } = require('./memory-active-event-shadow');

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
