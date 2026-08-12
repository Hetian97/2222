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

CREATE TABLE IF NOT EXISTS memory_search_logs (
  id TEXT PRIMARY KEY,
  chatId TEXT,
  source TEXT,
  query TEXT NOT NULL,
  queryVariants TEXT,
  requestedSearchEngine TEXT,
  searchMode TEXT,
  requestedLimit INTEGER DEFAULT 0,
  candidateLimit INTEGER DEFAULT 0,
  resultCount INTEGER DEFAULT 0,
  resultMemoryIds TEXT,
  resultsTop TEXT,
  chroma TEXT,
  fts TEXT,
  status TEXT NOT NULL DEFAULT 'candidates',
  createdAt INTEGER NOT NULL,
  injectedAt INTEGER,
  injectedMemoryIds TEXT,
  injectedCount INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_memory_search_logs_createdAt
ON memory_search_logs(createdAt DESC);

CREATE INDEX IF NOT EXISTS idx_memory_search_logs_chatId_createdAt
ON memory_search_logs(chatId, createdAt DESC);

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

CREATE TABLE IF NOT EXISTS memory_index_meta (
  name TEXT PRIMARY KEY,
  value TEXT,
  updatedAt INTEGER NOT NULL
);
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
ensureColumn('memory_search_logs', 'fts', 'TEXT');

const MEMORY_FTS_SCHEMA_VERSION = '2-cjk-bigram-materialized';
let memoryFtsAvailable = false;
let memoryFtsTokenizer = '';
let memoryFtsStartupError = '';

function setMemoryIndexMeta(name, value) {
  db.prepare(`
    INSERT INTO memory_index_meta (name, value, updatedAt)
    VALUES (?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      value = excluded.value,
      updatedAt = excluded.updatedAt
  `).run(String(name), String(value ?? ''), Date.now());
}

function getMemoryIndexMeta(name) {
  const row = db.prepare('SELECT value, updatedAt FROM memory_index_meta WHERE name = ?').get(String(name));
  return row || null;
}

function createMemoryFtsNgramSchema() {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
      memoryId UNINDEXED,
      chatId UNINDEXED,
      category UNINDEXED,
      importance UNINDEXED,
      terms,
      tokenize='unicode61'
    );

    CREATE TABLE IF NOT EXISTS memory_fts_pending (
      memoryId TEXT PRIMARY KEY,
      operation TEXT NOT NULL,
      createdAt INTEGER NOT NULL
    );

    CREATE TRIGGER IF NOT EXISTS memories_fts_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memory_fts_pending(memoryId, operation, createdAt)
      VALUES (new.id, 'upsert', CAST(strftime('%s','now') AS INTEGER) * 1000)
      ON CONFLICT(memoryId) DO UPDATE SET operation='upsert', createdAt=excluded.createdAt;
    END;

    CREATE TRIGGER IF NOT EXISTS memories_fts_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memory_fts_pending(memoryId, operation, createdAt)
      VALUES (old.id, 'delete', CAST(strftime('%s','now') AS INTEGER) * 1000)
      ON CONFLICT(memoryId) DO UPDATE SET operation='delete', createdAt=excluded.createdAt;
    END;

    CREATE TRIGGER IF NOT EXISTS memories_fts_au AFTER UPDATE OF content, tags, context, source, chatId, category, importance ON memories BEGIN
      INSERT INTO memory_fts_pending(memoryId, operation, createdAt)
      VALUES (new.id, 'upsert', CAST(strftime('%s','now') AS INTEGER) * 1000)
      ON CONFLICT(memoryId) DO UPDATE SET operation='upsert', createdAt=excluded.createdAt;
    END;
  `);

  memoryFtsAvailable = true;
  memoryFtsTokenizer = 'unicode61-cjk-bigram';
}

function expandMemoryFtsTerms(...values) {
  const terms = [];
  const seen = new Set();
  const add = (value) => {
    const term = String(value || '').trim().toLowerCase();
    if (!term || seen.has(term)) return;
    seen.add(term);
    terms.push(term);
  };

  for (const rawValue of values) {
    const text = String(rawValue || '').normalize('NFKC').toLowerCase();
    (text.match(/[a-z0-9_][a-z0-9_.:/-]{1,63}/g) || []).forEach(add);

    for (const run of (text.match(/[\u3400-\u9fff]+/g) || [])) {
      if (run.length === 1) add(run);
      for (const size of [2, 3, 4]) {
        for (let i = 0; i <= run.length - size; i++) add(run.slice(i, i + size));
      }
    }
  }

  return terms.join(' ');
}

function indexMemoryFtsRow(memory) {
  db.prepare('DELETE FROM memory_fts WHERE memoryId = ?').run(String(memory.id));
  db.prepare(`
    INSERT INTO memory_fts(memoryId, chatId, category, importance, terms)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    String(memory.id),
    String(memory.chatId || ''),
    String(memory.category || ''),
    Number(memory.importance || 0),
    expandMemoryFtsTerms(memory.content, memory.tags, memory.context, memory.source)
  );
}

function flushMemoryFtsPending(limit = 10000) {
  if (!memoryFtsAvailable) return { processed: 0 };
  const safeLimit = Math.min(50000, Math.max(1, Number(limit) || 10000));
  const rows = db.prepare(`
    SELECT memoryId, operation FROM memory_fts_pending
    ORDER BY createdAt ASC LIMIT ?
  `).all(safeLimit);

  const applyPending = db.transaction((items) => {
    for (const item of items) {
      if (item.operation === 'delete') {
        db.prepare('DELETE FROM memory_fts WHERE memoryId = ?').run(item.memoryId);
      } else {
        const memory = db.prepare('SELECT * FROM memories WHERE id = ?').get(item.memoryId);
        if (memory) indexMemoryFtsRow(memory);
        else db.prepare('DELETE FROM memory_fts WHERE memoryId = ?').run(item.memoryId);
      }
      db.prepare('DELETE FROM memory_fts_pending WHERE memoryId = ?').run(item.memoryId);
    }
  });

  applyPending(rows);
  return { processed: rows.length };
}

function rebuildMemoryFts() {
  if (!memoryFtsAvailable) {
    throw new Error(memoryFtsStartupError || 'FTS5 is unavailable');
  }

  const startedAt = Date.now();
  const rows = db.prepare('SELECT * FROM memories ORDER BY rowid ASC').all();
  const rebuild = db.transaction((memories) => {
    db.prepare('DELETE FROM memory_fts').run();
    db.prepare('DELETE FROM memory_fts_pending').run();
    for (const memory of memories) indexMemoryFtsRow(memory);
  });
  rebuild(rows);

  const total = rows.length;
  setMemoryIndexMeta('memory_fts_schema_version', MEMORY_FTS_SCHEMA_VERSION);
  setMemoryIndexMeta('memory_fts_tokenizer', memoryFtsTokenizer);
  setMemoryIndexMeta('memory_fts_indexed_count', total);
  setMemoryIndexMeta('memory_fts_last_rebuilt_at', Date.now());

  return {
    ok: true,
    available: true,
    tokenizer: memoryFtsTokenizer,
    total,
    durationMs: Date.now() - startedAt
  };
}

function initializeMemoryFts() {
  try {
    const existingTable = db.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory_fts'
    `).get();
    const existingColumns = existingTable
      ? db.prepare('PRAGMA table_info(memory_fts)').all().map(column => column.name)
      : [];

    if (existingTable && (!existingColumns.includes('memoryId') || !existingColumns.includes('terms'))) {
      db.exec(`
        DROP TRIGGER IF EXISTS memories_fts_ai;
        DROP TRIGGER IF EXISTS memories_fts_ad;
        DROP TRIGGER IF EXISTS memories_fts_au;
        DROP TABLE IF EXISTS memory_fts;
        DROP TABLE IF EXISTS memory_fts_pending;
      `);
    }

    createMemoryFtsNgramSchema();
  } catch (error) {
    memoryFtsStartupError = error.message || String(error);
    console.warn('[memory-server] FTS5 unavailable; recent-memory fallback remains enabled:', memoryFtsStartupError);
    return;
  }

  const schemaMeta = getMemoryIndexMeta('memory_fts_schema_version');
  const tokenizerMeta = getMemoryIndexMeta('memory_fts_tokenizer');

  if (!schemaMeta || schemaMeta.value !== MEMORY_FTS_SCHEMA_VERSION || tokenizerMeta?.value !== memoryFtsTokenizer) {
    const result = rebuildMemoryFts();
    console.log(`[memory-server] FTS5 index initialized: ${result.total} memories in ${result.durationMs}ms (${result.tokenizer})`);
  } else {
    const status = getMemoryFtsStatus({ integrityCheck: true });
    if (status.integrity !== 'ok') {
      const result = rebuildMemoryFts();
      console.warn(`[memory-server] FTS5 mismatch repaired: ${result.total} memories in ${result.durationMs}ms`);
    }
  }
}

initializeMemoryFts();

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
    INSERT INTO memories (
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
    ON CONFLICT(id) DO UPDATE SET
      chatId = excluded.chatId,
      content = excluded.content,
      category = excluded.category,
      importance = excluded.importance,
      emotionalWeight = excluded.emotionalWeight,
      tags = excluded.tags,
      memoryTime = excluded.memoryTime,
      createdAt = excluded.createdAt,
      updatedAt = excluded.updatedAt,
      lastRecalled = excluded.lastRecalled,
      recallCount = excluded.recallCount,
      embedding = excluded.embedding,
      embeddingModel = excluded.embeddingModel,
      embeddingDim = excluded.embeddingDim,
      embeddingUpdatedAt = excluded.embeddingUpdatedAt,
      linkedMemories = excluded.linkedMemories,
      source = excluded.source,
      context = excluded.context
  `);

  stmt.run(item);
  flushMemoryFtsPending();
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

  const excludedCategories = [...new Set(
    (Array.isArray(filters.excludeCategories) ? filters.excludeCategories : [])
      .map(value => String(value || '').trim().toUpperCase())
      .filter(Boolean)
  )];
  if (excludedCategories.length) {
    where.push(`COALESCE(category, '') NOT IN (${excludedCategories.map(() => '?').join(', ')})`);
    params.push(...excludedCategories);
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
  flushMemoryFtsPending();
  return result.changes > 0;
}

function clearAllMemories() {
  const result = db.prepare('DELETE FROM memories').run();
  flushMemoryFtsPending(50000);
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

function getMemoriesByIds(ids, filters = {}) {
  const safeIds = [...new Set(
    (Array.isArray(ids) ? ids : [])
      .map(value => String(value || '').trim())
      .filter(Boolean)
  )].slice(0, 2000);

  if (!safeIds.length) return [];

  const params = [...safeIds];
  const where = [`id IN (${safeIds.map(() => '?').join(', ')})`];

  if (filters.chatId) {
    where.push('chatId = ?');
    params.push(String(filters.chatId));
  }

  if (filters.category) {
    where.push('category = ?');
    params.push(String(filters.category).trim().toUpperCase());
  }

  const excludedCategories = [...new Set(
    (Array.isArray(filters.excludeCategories) ? filters.excludeCategories : [])
      .map(value => String(value || '').trim().toUpperCase())
      .filter(Boolean)
  )];
  if (excludedCategories.length) {
    where.push(`COALESCE(category, '') NOT IN (${excludedCategories.map(() => '?').join(', ')})`);
    params.push(...excludedCategories);
  }

  if (filters.minImportance !== undefined && filters.minImportance !== null && filters.minImportance !== '') {
    where.push('importance >= ?');
    params.push(Number(filters.minImportance));
  }

  if (filters.maxImportance !== undefined && filters.maxImportance !== null && filters.maxImportance !== '') {
    where.push('importance <= ?');
    params.push(Number(filters.maxImportance));
  }

  const rows = db.prepare(`SELECT * FROM memories WHERE ${where.join(' AND ')}`).all(...params);
  const byId = new Map(rows.map(row => [String(row.id), normalizeMemory(row)]));
  return safeIds.map(id => byId.get(id)).filter(Boolean);
}

function buildMemoryFtsMatchQuery(queries) {
  const values = Array.isArray(queries) ? queries : [queries];
  const terms = [];
  const seen = new Set();

  const add = (value) => {
    const term = String(value || '').trim().toLowerCase();
    if (term.length < 2 || seen.has(term)) return;
    seen.add(term);
    terms.push(term);
  };

  for (const value of values.slice(0, 12)) {
    const text = String(value || '').normalize('NFKC');
    const latinTerms = text.match(/[a-zA-Z0-9_][a-zA-Z0-9_.:/-]{2,63}/g) || [];
    latinTerms.forEach(add);

    const cjkRuns = text.match(/[\u3400-\u9fff]{2,32}/g) || [];
    for (const run of cjkRuns) {
      if (run.length <= 8) add(run);

      for (const windowSize of [2, 3, 4]) {
        for (let i = 0; i <= run.length - windowSize && terms.length < 96; i++) {
          add(run.slice(i, i + windowSize));
        }
      }
    }

    if (terms.length >= 64) break;
  }

  return terms.slice(0, 96).map(term => `"${term.replace(/"/g, '""')}"`).join(' OR ');
}

function searchMemoriesFts(queries, filters = {}) {
  if (!memoryFtsAvailable) {
    return {
      available: false,
      attempted: false,
      fallback: true,
      error: memoryFtsStartupError || 'FTS5 is unavailable',
      matchQuery: '',
      memories: []
    };
  }

  const matchQuery = buildMemoryFtsMatchQuery(queries);
  if (!matchQuery) {
    return {
      available: true,
      attempted: false,
      fallback: true,
      error: 'No FTS5 term with at least 2 characters',
      matchQuery: '',
      memories: []
    };
  }

  flushMemoryFtsPending();

  const params = [matchQuery];
  const where = ['memory_fts MATCH ?'];

  if (filters.chatId) {
    where.push('memory_fts.chatId = ?');
    params.push(String(filters.chatId));
  }

  if (filters.category) {
    where.push('memory_fts.category = ?');
    params.push(String(filters.category).trim().toUpperCase());
  }

  const excludedCategories = [...new Set(
    (Array.isArray(filters.excludeCategories) ? filters.excludeCategories : [])
      .map(value => String(value || '').trim().toUpperCase())
      .filter(Boolean)
  )];
  if (excludedCategories.length) {
    where.push(`COALESCE(memory_fts.category, '') NOT IN (${excludedCategories.map(() => '?').join(', ')})`);
    params.push(...excludedCategories);
  }

  if (filters.minImportance !== undefined && filters.minImportance !== null && filters.minImportance !== '') {
    where.push('CAST(memory_fts.importance AS INTEGER) >= ?');
    params.push(Number(filters.minImportance));
  }

  if (filters.maxImportance !== undefined && filters.maxImportance !== null && filters.maxImportance !== '') {
    where.push('CAST(memory_fts.importance AS INTEGER) <= ?');
    params.push(Number(filters.maxImportance));
  }

  const safeLimit = Math.min(2000, Math.max(10, Number(filters.limit) || 200));
  params.push(safeLimit);

  try {
    const rows = db.prepare(`
      SELECT m.*, bm25(memory_fts, 0.0, 0.0, 0.0, 0.0, 1.0) AS ftsRank
      FROM memory_fts
      JOIN memories m ON m.id = memory_fts.memoryId
      WHERE ${where.join(' AND ')}
      ORDER BY ftsRank ASC, m.importance DESC, CAST(m.memoryTime AS INTEGER) DESC
      LIMIT ?
    `).all(...params);

    return {
      available: true,
      attempted: true,
      fallback: false,
      error: null,
      matchQuery,
      memories: rows.map(row => ({
        ...normalizeMemory(row),
        _ftsRank: Number(row.ftsRank || 0),
        _searchMode: 'fts5-keyword-candidate'
      }))
    };
  } catch (error) {
    return {
      available: true,
      attempted: true,
      fallback: true,
      error: error.message || String(error),
      matchQuery,
      memories: []
    };
  }
}

function getMemoryFtsStatus(options = {}) {
  const total = db.prepare('SELECT COUNT(*) AS count FROM memories').get().count;
  let integrity = null;
  let error = memoryFtsStartupError || null;

  if (memoryFtsAvailable && options.integrityCheck !== false) {
    try {
      flushMemoryFtsPending();
      const ftsCount = db.prepare('SELECT COUNT(*) AS count FROM memory_fts').get().count;
      const pendingCount = db.prepare('SELECT COUNT(*) AS count FROM memory_fts_pending').get().count;
      const orphanCount = db.prepare(`
        SELECT COUNT(*) AS count FROM memory_fts f
        LEFT JOIN memories m ON m.id = f.memoryId
        WHERE m.id IS NULL
      `).get().count;
      const missingCount = db.prepare(`
        SELECT COUNT(*) AS count FROM memories m
        LEFT JOIN memory_fts f ON f.memoryId = m.id
        WHERE f.memoryId IS NULL
      `).get().count;
      integrity = Number(ftsCount) === Number(total) &&
        Number(pendingCount) === 0 &&
        Number(orphanCount) === 0 &&
        Number(missingCount) === 0
        ? 'ok'
        : 'mismatch';
      if (integrity !== 'ok') {
        error = `FTS5 mismatch: memories=${total}, indexed=${ftsCount}, pending=${pendingCount}, orphan=${orphanCount}, missing=${missingCount}`;
      }
    } catch (integrityError) {
      integrity = 'error';
      error = integrityError.message || String(integrityError);
    }
  }

  const lastRebuilt = getMemoryIndexMeta('memory_fts_last_rebuilt_at');
  const indexedCount = getMemoryIndexMeta('memory_fts_indexed_count');

  return {
    available: memoryFtsAvailable,
    tokenizer: memoryFtsTokenizer,
    schemaVersion: getMemoryIndexMeta('memory_fts_schema_version')?.value || '',
    totalMemories: Number(total || 0),
    indexedCountAtLastRebuild: Number(indexedCount?.value || 0),
    lastRebuiltAt: Number(lastRebuilt?.value || 0),
    integrity,
    error
  };
}

function normalizeMemorySearchLog(row) {
  if (!row) return null;

  const createdAt = Number(row.createdAt || 0);
  const injectedAt = Number(row.injectedAt || 0);

  return {
    id: row.id,
    at: createdAt,
    atISO: createdAt ? new Date(createdAt).toISOString() : '',
    chatId: row.chatId || '',
    source: row.source || '',
    query: row.query || '',
    queryPreview: String(row.query || '').replace(/\s+/g, ' ').slice(0, 80),
    queryVariants: safeJsonParse(row.queryVariants, []),
    requestedSearchEngine: row.requestedSearchEngine || '',
    searchMode: row.searchMode || '',
    limit: Number(row.requestedLimit || 0),
    candidateLimit: Number(row.candidateLimit || 0),
    resultCount: Number(row.resultCount || 0),
    resultMemoryIds: safeJsonParse(row.resultMemoryIds, []),
    resultsTop: safeJsonParse(row.resultsTop, []),
    chroma: safeJsonParse(row.chroma, { attempted: false }),
    fts: safeJsonParse(row.fts, { attempted: false }),
    status: row.status || 'candidates',
    injectedAt: injectedAt || null,
    injectedAtISO: injectedAt ? new Date(injectedAt).toISOString() : '',
    injectedMemoryIds: safeJsonParse(row.injectedMemoryIds, []),
    injectedCount: Number(row.injectedCount || 0)
  };
}

function createMemorySearchLog(info = {}) {
  const now = Date.now();
  const results = Array.isArray(info.results) ? info.results : [];
  const resultMemoryIds = [...new Set(
    results.map(item => String(item?.id || '').trim()).filter(Boolean)
  )];
  const id = info.id || `search_${now}_${crypto.randomBytes(4).toString('hex')}`;

  db.prepare(`
    INSERT INTO memory_search_logs (
      id, chatId, source, query, queryVariants, requestedSearchEngine,
      searchMode, requestedLimit, candidateLimit, resultCount,
      resultMemoryIds, resultsTop, chroma, fts, status, createdAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'candidates', ?)
  `).run(
    id,
    String(info.chatId || ''),
    String(info.source || ''),
    String(info.query || '').slice(0, 4000),
    safeJsonStringify(Array.isArray(info.queryVariants) ? info.queryVariants.slice(0, 10) : []),
    String(info.requestedSearchEngine || ''),
    String(info.searchMode || ''),
    Number(info.limit || 0),
    Number(info.candidateLimit || 0),
    Number(info.resultCount ?? results.length),
    safeJsonStringify(resultMemoryIds),
    safeJsonStringify(Array.isArray(info.resultsTop) ? info.resultsTop.slice(0, 10) : []),
    safeJsonStringify(info.chroma || { attempted: false }),
    safeJsonStringify(info.fts || { attempted: false }),
    now
  );

  const keepLimit = Math.min(50000, Math.max(100, Number(process.env.MEMORY_SEARCH_LOG_LIMIT || 5000) || 5000));
  db.prepare(`
    DELETE FROM memory_search_logs
    WHERE id IN (
      SELECT id FROM memory_search_logs
      ORDER BY createdAt DESC
      LIMIT -1 OFFSET ?
    )
  `).run(keepLimit);

  return normalizeMemorySearchLog(
    db.prepare('SELECT * FROM memory_search_logs WHERE id = ?').get(id)
  );
}

function getLatestMemorySearchLog() {
  return normalizeMemorySearchLog(
    db.prepare('SELECT * FROM memory_search_logs ORDER BY createdAt DESC LIMIT 1').get()
  );
}

function commitMemorySearchInjection(searchId, requestedMemoryIds = []) {
  const safeSearchId = String(searchId || '').trim();
  if (!safeSearchId) throw new Error('searchId is required');

  return db.transaction(() => {
    const row = db.prepare('SELECT * FROM memory_search_logs WHERE id = ?').get(safeSearchId);
    if (!row) throw new Error('Memory search log not found');

    if (row.injectedAt) {
      return {
        committed: false,
        alreadyCommitted: true,
        log: normalizeMemorySearchLog(row)
      };
    }

    const allowedIds = new Set(safeJsonParse(row.resultMemoryIds, []).map(String));
    const injectedMemoryIds = [...new Set(
      (Array.isArray(requestedMemoryIds) ? requestedMemoryIds : [])
        .map(value => String(value || '').trim())
        .filter(value => value && allowedIds.has(value))
    )].slice(0, 200);
    const recalledAt = Date.now();
    const updateMemory = db.prepare(`
      UPDATE memories
      SET recallCount = COALESCE(recallCount, 0) + 1,
          lastRecalled = ?
      WHERE id = ?
    `);

    for (const memoryId of injectedMemoryIds) {
      updateMemory.run(String(recalledAt), memoryId);
    }

    db.prepare(`
      UPDATE memory_search_logs
      SET status = 'injected', injectedAt = ?, injectedMemoryIds = ?, injectedCount = ?
      WHERE id = ?
    `).run(
      recalledAt,
      safeJsonStringify(injectedMemoryIds),
      injectedMemoryIds.length,
      safeSearchId
    );

    return {
      committed: true,
      alreadyCommitted: false,
      log: normalizeMemorySearchLog(
        db.prepare('SELECT * FROM memory_search_logs WHERE id = ?').get(safeSearchId)
      )
    };
  })();
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
  getMemoriesByIds,
  searchMemoriesFts,
  getMemoryFtsStatus,
  rebuildMemoryFts,
  deleteMemory,
  clearAllMemories,
  getMemoryStats,
  listUnembeddedMemories,
  createMemorySearchLog,
  getLatestMemorySearchLog,
  commitMemorySearchInjection,
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
