const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');

const dbPath = process.env.MEMORY_DB_PATH
  ? path.resolve(process.env.MEMORY_DB_PATH)
  : path.join(__dirname, 'memory.db');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  chatId TEXT,
  content TEXT NOT NULL,
  category TEXT,
  importance INTEGER DEFAULT 5,
  emotionalWeight INTEGER DEFAULT 5,
  tags TEXT,
  memoryTime TEXT,
  createdAt TEXT,
  updatedAt TEXT,
  lastRecalled TEXT,
  recallCount INTEGER DEFAULT 0,
  embedding TEXT,
  embeddingModel TEXT,
  embeddingDim INTEGER DEFAULT 0,
  embeddingUpdatedAt TEXT,
  linkedMemories TEXT,
  source TEXT,
  context TEXT
);

CREATE INDEX IF NOT EXISTS idx_memories_chatId ON memories(chatId);
CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);
CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance);
CREATE INDEX IF NOT EXISTS idx_memories_memoryTime ON memories(memoryTime);

CREATE TABLE IF NOT EXISTS garden_wake_events (
  id TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  createdAt INTEGER NOT NULL,
  claimedAt INTEGER,
  claimedBy TEXT,
  claimToken TEXT,
  completedAt INTEGER,
  lastError TEXT
);

CREATE INDEX IF NOT EXISTS idx_garden_wake_status_created
ON garden_wake_events(status, createdAt);

CREATE TABLE IF NOT EXISTS aisay_wake_events (
  id TEXT PRIMARY KEY,
  externalEventId TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL,
  reason TEXT NOT NULL,
  message TEXT NOT NULL,
  payload TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  createdAt INTEGER NOT NULL,
  claimedAt INTEGER,
  claimedBy TEXT,
  claimToken TEXT,
  completedAt INTEGER,
  lastError TEXT
);

CREATE INDEX IF NOT EXISTS idx_aisay_wake_status_created
ON aisay_wake_events(status, createdAt);
`);

function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  const exists = columns.some(col => col.name === column);

  if (!exists) {
    db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
    console.log(`[memory-server] Added column ${column} to ${table}`);
  }
}

ensureColumn('memories', 'embeddingModel', 'TEXT');
ensureColumn('memories', 'embeddingDim', 'INTEGER DEFAULT 0');
ensureColumn('memories', 'embeddingUpdatedAt', 'TEXT');

function safeJsonStringify(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function safeJsonParse(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalizeMemory(row) {
  if (!row) return null;

  return {
    id: row.id,
    chatId: row.chatId || null,
    content: row.content || '',
    category: row.category || 'E',
    importance: row.importance ?? 5,
    emotionalWeight: row.emotionalWeight ?? 5,
    tags: safeJsonParse(row.tags, []),
    memoryTime: row.memoryTime,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastRecalled: row.lastRecalled ?? 0,
    recallCount: row.recallCount || 0,
    embedding: safeJsonParse(row.embedding, null),
    embeddingModel: row.embeddingModel || '',
    embeddingDim: Number(row.embeddingDim || 0),
    embeddingUpdatedAt: row.embeddingUpdatedAt || '',
    linkedMemories: safeJsonParse(row.linkedMemories, []),
    source: row.source || 'external',
    context: row.context || ''
  };
}

function addMemory(memory) {
  const now = Date.now();

  const normalizedEmbedding =
    Array.isArray(memory.embedding) && memory.embedding.length > 0
      ? memory.embedding
      : null;

  const item = {
    id: memory.id || `mem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    chatId: memory.chatId || null,
    content: memory.content || '',
    category: memory.category || 'E',
    importance: Number(memory.importance ?? 5),
    emotionalWeight: Number(memory.emotionalWeight ?? 5),
    tags: safeJsonStringify(memory.tags || []),
    memoryTime: String(memory.memoryTime ?? now),
    createdAt: String(memory.createdAt ?? now),
    updatedAt: String(memory.updatedAt ?? now),
    lastRecalled: String(memory.lastRecalled ?? 0),
    recallCount: Number(memory.recallCount || 0),
    embedding: safeJsonStringify(normalizedEmbedding),
    embeddingModel: normalizedEmbedding ? (memory.embeddingModel ? String(memory.embeddingModel) : '') : '',
    embeddingDim: normalizedEmbedding ? Number(memory.embeddingDim || normalizedEmbedding.length) : 0,
    embeddingUpdatedAt: normalizedEmbedding ? (memory.embeddingUpdatedAt ? String(memory.embeddingUpdatedAt) : String(Date.now())) : '',
    linkedMemories: safeJsonStringify(memory.linkedMemories || []),
    source: memory.source ? String(memory.source) : 'external',
    context: memory.context ? String(memory.context) : ''
  };

  const stmt = db.prepare(`
    INSERT OR REPLACE INTO memories (
      id, chatId, content, category, importance, emotionalWeight,
      tags, memoryTime, createdAt, updatedAt, lastRecalled,
      recallCount, embedding, embeddingModel, embeddingDim, embeddingUpdatedAt,
      linkedMemories, source, context
    ) VALUES (
      @id, @chatId, @content, @category, @importance, @emotionalWeight,
      @tags, @memoryTime, @createdAt, @updatedAt, @lastRecalled,
      @recallCount, @embedding, @embeddingModel, @embeddingDim, @embeddingUpdatedAt,
      @linkedMemories, @source, @context
    )
  `);

  stmt.run(item);
  return normalizeMemory(db.prepare('SELECT * FROM memories WHERE id = ?').get(item.id));
}

function getMemoryById(id) {
  if (!id) return null;
  return normalizeMemory(db.prepare('SELECT * FROM memories WHERE id = ?').get(String(id)));
}

function listMemories(filters = {}) {
  if (typeof filters === 'string') {
    filters = { chatId: filters };
  }

  const params = [];
  const where = [];

  if (filters.chatId) {
    where.push('chatId = ?');
    params.push(String(filters.chatId));
  }

  if (filters.category) {
    where.push('category = ?');
    params.push(String(filters.category).trim().toUpperCase());
  }

  if (filters.minImportance !== undefined && filters.minImportance !== null && filters.minImportance !== '') {
    where.push('importance >= ?');
    params.push(Number(filters.minImportance));
  }

  if (filters.maxImportance !== undefined && filters.maxImportance !== null && filters.maxImportance !== '') {
    where.push('importance <= ?');
    params.push(Number(filters.maxImportance));
  }

  if (filters.query) {
    where.push('(content LIKE ? OR tags LIKE ? OR context LIKE ? OR source LIKE ?)');
    const q = `%${String(filters.query).trim()}%`;
    params.push(q, q, q, q);
  }

  const safeLimit = Math.min(10000, Math.max(1, Number(filters.limit) || 500));
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const rows = db.prepare(`
    SELECT * FROM memories
    ${whereSql}
    ORDER BY CAST(memoryTime AS INTEGER) DESC, CAST(createdAt AS INTEGER) DESC
    LIMIT ?
  `).all(...params, safeLimit);

  return rows.map(normalizeMemory);
}

function deleteMemory(id) {
  const result = db.prepare('DELETE FROM memories WHERE id = ?').run(id);
  return result.changes > 0;
}

function clearAllMemories() {
  const result = db.prepare('DELETE FROM memories').run();
  return result.changes;
}

function getMemoryStats() {
  const embeddingWhere = `
    embedding IS NOT NULL
    AND embedding != ''
    AND embedding != 'null'
    AND embedding != '[]'
  `;

  const total = db.prepare(`
    SELECT COUNT(*) AS count FROM memories
  `).get().count;

  const byCategory = db.prepare(`
    SELECT COALESCE(NULLIF(category, ''), 'unknown') AS category, COUNT(*) AS count
    FROM memories
    GROUP BY COALESCE(NULLIF(category, ''), 'unknown')
    ORDER BY category
  `).all();

  const bySource = db.prepare(`
    SELECT COALESCE(NULLIF(source, ''), 'unknown') AS source, COUNT(*) AS count
    FROM memories
    GROUP BY COALESCE(NULLIF(source, ''), 'unknown')
    ORDER BY count DESC
  `).all();

  const byEmbeddingModel = db.prepare(`
    SELECT
      COALESCE(NULLIF(embeddingModel, ''), 'unknown') AS model,
      COUNT(*) AS count
    FROM memories
    WHERE ${embeddingWhere}
    GROUP BY COALESCE(NULLIF(embeddingModel, ''), 'unknown')
    ORDER BY count DESC
  `).all();

  const byEmbeddingDim = db.prepare(`
    SELECT
      COALESCE(embeddingDim, 0) AS dim,
      COUNT(*) AS count
    FROM memories
    WHERE ${embeddingWhere}
    GROUP BY COALESCE(embeddingDim, 0)
    ORDER BY count DESC
  `).all();

  const withEmbedding = db.prepare(`
    SELECT COUNT(*) AS count
    FROM memories
    WHERE ${embeddingWhere}
  `).get().count;

  const withoutEmbedding = total - withEmbedding;

  const important = db.prepare(`
    SELECT COUNT(*) AS count
    FROM memories
    WHERE importance >= 8
  `).get().count;

  const core = db.prepare(`
    SELECT COUNT(*) AS count
    FROM memories
    WHERE category = 'C'
  `).get().count;

  const latestRow = db.prepare(`
    SELECT
      id,
      chatId,
      content,
      category,
      importance,
      emotionalWeight,
      tags,
      memoryTime,
      createdAt,
      updatedAt,
      lastRecalled,
      recallCount,
      embeddingModel,
      embeddingDim,
      embeddingUpdatedAt,
      linkedMemories,
      source,
      context,
      CASE WHEN ${embeddingWhere} THEN 1 ELSE 0 END AS hasEmbedding
    FROM memories
    ORDER BY CAST(createdAt AS INTEGER) DESC
    LIMIT 1
  `).get();

  const latest = latestRow ? {
    id: latestRow.id,
    chatId: latestRow.chatId || null,
    content: latestRow.content || '',
    category: latestRow.category || 'E',
    importance: latestRow.importance ?? 5,
    emotionalWeight: latestRow.emotionalWeight ?? 5,
    tags: safeJsonParse(latestRow.tags, []),
    memoryTime: latestRow.memoryTime,
    createdAt: latestRow.createdAt,
    updatedAt: latestRow.updatedAt,
    lastRecalled: latestRow.lastRecalled ?? 0,
    recallCount: latestRow.recallCount || 0,
    embeddingModel: latestRow.embeddingModel || '',
    embeddingDim: Number(latestRow.embeddingDim || 0),
    embeddingUpdatedAt: latestRow.embeddingUpdatedAt || '',
    linkedMemories: safeJsonParse(latestRow.linkedMemories, []),
    source: latestRow.source || 'external',
    context: latestRow.context || '',
    hasEmbedding: latestRow.hasEmbedding === 1,
    _hasEmbedding: latestRow.hasEmbedding === 1,
    _embeddingDim: latestRow.hasEmbedding === 1 ? Number(latestRow.embeddingDim || 0) : 0
  } : null;

  return {
    total,
    byCategory,
    bySource,
    byEmbeddingModel,
    byEmbeddingDim,
    withEmbedding,
    withoutEmbedding,
    vectorCount: withEmbedding,
    bm25Count: withoutEmbedding,
    important,
    core,
    latest
  };
}
function listUnembeddedMemories(limit = 100) {
  const safeLimit = Math.min(500, Math.max(1, Number(limit) || 100));

  const rows = db.prepare(`
    SELECT * FROM memories
    WHERE embedding IS NULL
       OR embedding = ''
       OR embedding = 'null'
       OR embedding = '[]'
    ORDER BY importance DESC, CAST(memoryTime AS INTEGER) DESC, CAST(createdAt AS INTEGER) DESC
    LIMIT ?
  `).all(safeLimit);

  return rows.map(normalizeMemory);
}

function importFromJsonArray(memories) {
  if (!Array.isArray(memories)) return 0;

  const insertMany = db.transaction((items) => {
    for (const item of items) {
      if (item && item.content) {
        addMemory(item);
      }
    }
  });

  insertMany(memories);
  return memories.filter(item => item && item.content).length;
}

function addGardenWakeEvent(event) {
  const now = Date.now();
  const item = {
    id: String(event.id || `garden_wake_${now}_${Math.random().toString(36).slice(2, 10)}`),
    reason: String(event.reason || '').trim(),
    message: String(event.message || '').trim(),
    status: 'pending',
    createdAt: now
  };

  if (!item.reason || !item.message) {
    throw new Error('Garden wake reason and message are required.');
  }

  db.prepare(`
    INSERT INTO garden_wake_events (id, reason, message, status, createdAt)
    VALUES (@id, @reason, @message, @status, @createdAt)
  `).run(item);

  return db.prepare('SELECT * FROM garden_wake_events WHERE id = ?').get(item.id);
}

function claimGardenWakeEvent(clientId, leaseMs = 5 * 60 * 1000) {
  const safeClientId = String(clientId || '').trim();
  if (!safeClientId) throw new Error('Garden wake clientId is required.');

  const now = Date.now();
  const safeLeaseMs = Math.min(30 * 60 * 1000, Math.max(30 * 1000, Number(leaseMs) || 5 * 60 * 1000));
  const claimToken = crypto.randomUUID();

  return db.transaction(() => {
    db.prepare(`
      UPDATE garden_wake_events
      SET status = 'pending', claimedAt = NULL, claimedBy = NULL, claimToken = NULL
      WHERE status = 'processing' AND claimedAt < ?
    `).run(now - safeLeaseMs);

    const row = db.prepare(`
      SELECT * FROM garden_wake_events
      WHERE status = 'pending'
      ORDER BY createdAt ASC
      LIMIT 1
    `).get();

    if (!row) return null;

    const updated = db.prepare(`
      UPDATE garden_wake_events
      SET status = 'processing', claimedAt = ?, claimedBy = ?, claimToken = ?
      WHERE id = ? AND status = 'pending'
    `).run(now, safeClientId, claimToken, row.id);

    if (!updated.changes) return null;
    return db.prepare('SELECT * FROM garden_wake_events WHERE id = ?').get(row.id);
  })();
}

function finishGardenWakeEvent(id, claimToken, status, errorMessage = '') {
  const safeId = String(id || '').trim();
  const safeClaimToken = String(claimToken || '').trim();
  const safeStatus = status === 'completed' ? 'completed' : 'failed';
  if (!safeId || !safeClaimToken) return false;

  const result = db.prepare(`
    UPDATE garden_wake_events
    SET status = ?, completedAt = ?, lastError = ?
    WHERE id = ? AND status = 'processing' AND claimToken = ?
  `).run(safeStatus, Date.now(), String(errorMessage || '').slice(0, 1000), safeId, safeClaimToken);

  return result.changes > 0;
}

function getGardenWakeStats() {
  const rows = db.prepare(`
    SELECT status, COUNT(*) AS count
    FROM garden_wake_events
    GROUP BY status
  `).all();
  return Object.fromEntries(rows.map(row => [row.status, row.count]));
}

function normalizeAisayWakeEvent(row) {
  if (!row) return null;
  return {
    ...row,
    payload: safeJsonParse(row.payload, {})
  };
}

function addAisayWakeEvent(event) {
  const now = Date.now();
  const externalEventId = String(event.externalEventId || event.event_id || event.id || '').trim();
  const item = {
    id: `aisay_wake_${externalEventId}`,
    externalEventId,
    category: String(event.category || 'unknown').trim(),
    reason: String(event.reason || event.category || 'aisay_wake').trim(),
    message: String(event.message || '').trim(),
    payload: safeJsonStringify(event.payload || event),
    status: 'pending',
    createdAt: Number(event.createdAt) || now
  };

  if (!item.externalEventId || !item.category || !item.message) {
    throw new Error('AISay wake event_id, category and message are required.');
  }

  const result = db.prepare(`
    INSERT INTO aisay_wake_events (
      id, externalEventId, category, reason, message, payload, status, createdAt
    ) VALUES (
      @id, @externalEventId, @category, @reason, @message, @payload, @status, @createdAt
    )
    ON CONFLICT(externalEventId) DO NOTHING
  `).run(item);

  return {
    event: normalizeAisayWakeEvent(
      db.prepare('SELECT * FROM aisay_wake_events WHERE externalEventId = ?').get(item.externalEventId)
    ),
    duplicate: result.changes === 0
  };
}

function claimAisayWakeEvent(clientId, leaseMs = 5 * 60 * 1000) {
  const safeClientId = String(clientId || '').trim();
  if (!safeClientId) throw new Error('AISay wake clientId is required.');

  const now = Date.now();
  const safeLeaseMs = Math.min(30 * 60 * 1000, Math.max(30 * 1000, Number(leaseMs) || 5 * 60 * 1000));
  const claimToken = crypto.randomUUID();

  return db.transaction(() => {
    db.prepare(`
      UPDATE aisay_wake_events
      SET status = 'pending', claimedAt = NULL, claimedBy = NULL, claimToken = NULL
      WHERE status = 'processing' AND claimedAt < ?
    `).run(now - safeLeaseMs);

    const row = db.prepare(`
      SELECT * FROM aisay_wake_events
      WHERE status = 'pending'
      ORDER BY createdAt ASC
      LIMIT 1
    `).get();

    if (!row) return null;

    const updated = db.prepare(`
      UPDATE aisay_wake_events
      SET status = 'processing', claimedAt = ?, claimedBy = ?, claimToken = ?
      WHERE id = ? AND status = 'pending'
    `).run(now, safeClientId, claimToken, row.id);

    if (!updated.changes) return null;
    return normalizeAisayWakeEvent(
      db.prepare('SELECT * FROM aisay_wake_events WHERE id = ?').get(row.id)
    );
  })();
}

function finishAisayWakeEvent(id, claimToken, status, errorMessage = '') {
  const safeId = String(id || '').trim();
  const safeClaimToken = String(claimToken || '').trim();
  const safeStatus = status === 'completed' ? 'completed' : 'failed';
  if (!safeId || !safeClaimToken) return false;

  const result = db.prepare(`
    UPDATE aisay_wake_events
    SET status = ?, completedAt = ?, lastError = ?
    WHERE id = ? AND status = 'processing' AND claimToken = ?
  `).run(safeStatus, Date.now(), String(errorMessage || '').slice(0, 1000), safeId, safeClaimToken);

  return result.changes > 0;
}

function getAisayWakeStats() {
  const rows = db.prepare(`
    SELECT status, COUNT(*) AS count
    FROM aisay_wake_events
    GROUP BY status
  `).all();
  return Object.fromEntries(rows.map(row => [row.status, row.count]));
}

module.exports = {
  db,
  addMemory,
  listMemories,
  getMemoryById,
  deleteMemory,
  clearAllMemories,
  getMemoryStats,
  listUnembeddedMemories,
  importFromJsonArray,
  addGardenWakeEvent,
  claimGardenWakeEvent,
  finishGardenWakeEvent,
  getGardenWakeStats,
  addAisayWakeEvent,
  claimAisayWakeEvent,
  finishAisayWakeEvent,
  getAisayWakeStats
};
