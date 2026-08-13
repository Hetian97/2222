const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-organization-test-'));
process.env.MEMORY_DB_PATH = path.join(testDir, 'memory.db');

const {
  db,
  addMemory,
  deleteMemory,
  getMemoryOrganizationStatus,
  initializeMemoryOrganizationCoverage,
  resetMemoryOrganizationOverlay,
  saveMemoryOrganizationPreview,
  listMemoryClusters
} = require('./db');

function memoryFingerprint() {
  return db.prepare(`
    SELECT id, content, embedding
    FROM memories
    ORDER BY id
  `).all();
}

try {
  addMemory({
    id: 'memory-a',
    chatId: 'chat-1',
    content: '第一次在露台看星星。',
    tags: ['露台', '星星'],
    embedding: [0.1, 0.2, 0.3]
  });
  addMemory({
    id: 'memory-b',
    chatId: 'chat-1',
    content: '后来又在露台聊起那晚的星星。',
    tags: ['露台', '星星']
  });
  addMemory({
    id: 'memory-c',
    chatId: 'chat-2',
    content: '另一段独立记忆。'
  });

  const original = memoryFingerprint();
  const initial = getMemoryOrganizationStatus();
  assert.equal(initial.totalMemories, 3);
  assert.equal(initial.trackedCount, 0);
  assert.equal(initial.untrackedCount, 3);
  assert.equal(initial.queue.pending, 3);
  assert.equal(initial.behaviorChanged, false);

  const initialized = initializeMemoryOrganizationCoverage({
    algorithmVersion: 'organization-test-v1'
  });
  assert.equal(initialized.totalMemories, 3);
  assert.equal(initialized.trackedCount, 3);
  assert.equal(initialized.untrackedCount, 0);
  assert.equal(initialized.coverage, 1);
  assert.equal(initialized.organizationCoverage, 0);
  assert(initialized.runId.startsWith('organization_init_'));
  assert.deepEqual(memoryFingerprint(), original);

  const now = Date.now();
  db.prepare(`
    INSERT INTO memory_clusters (
      id, chatId, kind, title, summary, representativeMemoryId,
      status, confidence, memberCount, algorithmVersion, createdAt, updatedAt
    ) VALUES (?, ?, 'event', ?, ?, ?, 'preview', ?, 2, ?, ?, ?)
  `).run(
    'cluster-1',
    'chat-1',
    '露台看星星',
    '两条原始记忆的可逆预览分组。',
    'memory-a',
    0.92,
    'organization-test-v1',
    now,
    now
  );
  const insertMember = db.prepare(`
    INSERT INTO memory_cluster_members (
      clusterId, memoryId, membershipRole, confidence, reason, source, createdAt, updatedAt
    ) VALUES ('cluster-1', ?, ?, ?, ?, 'auto', ?, ?)
  `);
  insertMember.run('memory-a', 'representative', 0.96, 'same_episode', now, now);
  insertMember.run('memory-b', 'member', 0.89, 'same_episode', now, now);

  const savedPreview = saveMemoryOrganizationPreview({
    algorithmVersion: 'organization-preview-test-v1',
    sourceMemoryCount: 3,
    processedCount: 3,
    clusteredCount: 2,
    independentCount: 1,
    eventClusters: [{
      id: 'preview-cluster-1',
      chatId: 'chat-1',
      kind: 'event',
      title: 'preview event',
      summary: 'preview only',
      representativeMemoryId: 'memory-a',
      confidence: 0.9,
      subtype: 'habit_candidate',
      subtypeStatus: 'candidate',
      subtypeConfidence: 0.86,
      subtypeReasons: ['repeated_occurrence_language'],
      algorithmVersion: 'organization-preview-test-v1',
      members: [
        { memoryId: 'memory-a', membershipRole: 'representative', confidence: 1, reason: 'test' },
        { memoryId: 'memory-b', membershipRole: 'member', confidence: 0.8, reason: 'test' }
      ]
    }],
    topicClusters: [],
    organizations: [
      { memoryId: 'memory-a', chatId: 'chat-1', status: 'preview_clustered', primaryEventClusterId: 'preview-cluster-1', confidence: 0.9, reason: 'test', algorithmVersion: 'organization-preview-test-v1' },
      { memoryId: 'memory-b', chatId: 'chat-1', status: 'preview_clustered', primaryEventClusterId: 'preview-cluster-1', confidence: 0.8, reason: 'test', algorithmVersion: 'organization-preview-test-v1' },
      { memoryId: 'memory-c', chatId: 'chat-2', status: 'preview_independent', primaryEventClusterId: null, confidence: 0.65, reason: 'test', algorithmVersion: 'organization-preview-test-v1' }
    ],
    diagnostics: { candidatePairCount: 1, acceptedPairCount: 1 }
  }, {
    confirm: 'SAVE_ORGANIZATION_PREVIEW'
  });
  assert(savedPreview.runId.startsWith('organization_preview_'));
  assert.equal(savedPreview.organizationCoverage, 1);
  assert.deepEqual(memoryFingerprint(), original);

  const clusters = listMemoryClusters({ chatId: 'chat-1', kind: 'event' });
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].members.length, 2);
  assert.equal(clusters[0].subtype, 'habit_candidate');
  assert.deepEqual(clusters[0].subtypeReasons, ['repeated_occurrence_language']);
  assert.equal(clusters[0].members[0].content, '第一次在露台看星星。');
  assert.equal(memoryFingerprint().length, 3);

  assert.throws(
    () => resetMemoryOrganizationOverlay({ confirm: 'wrong' }),
    /Explicit confirmation/
  );
  assert.equal(listMemoryClusters({}).length, 1);

  assert.equal(deleteMemory('memory-b'), true);
  assert.equal(listMemoryClusters({})[0].members.length, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM memory_organization WHERE memoryId = ?').get('memory-b').count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM memory_organization_queue WHERE memoryId = ?').get('memory-b').count, 0);

  const beforeReset = memoryFingerprint();
  const reset = resetMemoryOrganizationOverlay({ confirm: 'RESET_ORGANIZATION_OVERLAY' });
  assert.equal(reset.reset, true);
  assert.equal(reset.after.totalMemories, 2);
  assert.equal(reset.after.trackedCount, 0);
  assert.equal(reset.after.untrackedCount, 2);
  assert.equal(listMemoryClusters({}).length, 0);
  assert.deepEqual(memoryFingerprint(), beforeReset);

  console.log('Memory organization overlay tests passed');
} finally {
  db.close();
  fs.rmSync(testDir, { recursive: true, force: true });
}
