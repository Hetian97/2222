const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');
const {
  DEFAULT_INCREMENTAL_OPTIONS,
  decideIncrementalOrganization,
  createIncrementalClusterId
} = require('./memory-organization-incremental');

const dbPath = process.env.MEMORY_DB_PATH
  ? path.resolve(process.env.MEMORY_DB_PATH)
  : path.join(__dirname, 'memory.db');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

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
  shadowPolicy TEXT,
  turnId TEXT,
  attemptId TEXT,
  actionType TEXT,
  status TEXT NOT NULL DEFAULT 'candidates',
  createdAt INTEGER NOT NULL,
  injectedAt INTEGER,
  injectedMemoryIds TEXT,
  injectedCount INTEGER DEFAULT 0,
  generationCompletedAt INTEGER,
  generationError TEXT
);

CREATE INDEX IF NOT EXISTS idx_memory_search_logs_createdAt
ON memory_search_logs(createdAt DESC);

CREATE INDEX IF NOT EXISTS idx_memory_search_logs_chatId_createdAt
ON memory_search_logs(chatId, createdAt DESC);

-- Structured conversational continuity overlay. It never rewrites source memories.
CREATE TABLE IF NOT EXISTS memory_active_events (
  id TEXT PRIMARY KEY,
  chatId TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT,
  status TEXT NOT NULL DEFAULT 'candidate',
  startAt INTEGER,
  endAt INTEGER,
  validUntil INTEGER,
  surfaceMode TEXT NOT NULL DEFAULT 'on_reference',
  proactiveMention INTEGER NOT NULL DEFAULT 0,
  aliases TEXT,
  sourceMemoryIds TEXT,
  evidence TEXT,
  confidence REAL NOT NULL DEFAULT 0,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  archivedAt INTEGER
);

CREATE INDEX IF NOT EXISTS idx_memory_active_events_chat_status
ON memory_active_events(chatId, status, updatedAt DESC);

CREATE INDEX IF NOT EXISTS idx_memory_active_events_valid_until
ON memory_active_events(validUntil);

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

-- Rebuildable organization overlay. These tables never replace or rewrite memories.
CREATE TABLE IF NOT EXISTS memory_clusters (
  id TEXT PRIMARY KEY,
  chatId TEXT,
  kind TEXT NOT NULL CHECK(kind IN ('event', 'topic')),
  title TEXT NOT NULL,
  summary TEXT,
  representativeMemoryId TEXT,
  status TEXT NOT NULL DEFAULT 'preview',
  confidence REAL NOT NULL DEFAULT 0,
  timeStart INTEGER,
  timeEnd INTEGER,
  memberCount INTEGER NOT NULL DEFAULT 0,
  algorithmVersion TEXT,
  subtype TEXT NOT NULL DEFAULT 'type_uncertain',
  subtypeStatus TEXT NOT NULL DEFAULT 'candidate',
  subtypeConfidence REAL NOT NULL DEFAULT 0,
  subtypeReasons TEXT,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  FOREIGN KEY(representativeMemoryId) REFERENCES memories(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_clusters_chat_kind
ON memory_clusters(chatId, kind, updatedAt DESC);

CREATE TABLE IF NOT EXISTS memory_cluster_members (
  clusterId TEXT NOT NULL,
  memoryId TEXT NOT NULL,
  membershipRole TEXT NOT NULL DEFAULT 'member',
  confidence REAL NOT NULL DEFAULT 0,
  reason TEXT,
  source TEXT NOT NULL DEFAULT 'auto',
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  PRIMARY KEY(clusterId, memoryId),
  FOREIGN KEY(clusterId) REFERENCES memory_clusters(id) ON DELETE CASCADE,
  FOREIGN KEY(memoryId) REFERENCES memories(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_memory_cluster_members_memory
ON memory_cluster_members(memoryId);

CREATE TABLE IF NOT EXISTS memory_organization (
  memoryId TEXT PRIMARY KEY,
  chatId TEXT,
  status TEXT NOT NULL DEFAULT 'unreviewed',
  primaryEventClusterId TEXT,
  confidence REAL NOT NULL DEFAULT 0,
  reason TEXT,
  contentHash TEXT,
  algorithmVersion TEXT,
  reviewedBy TEXT,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  FOREIGN KEY(memoryId) REFERENCES memories(id) ON DELETE CASCADE,
  FOREIGN KEY(primaryEventClusterId) REFERENCES memory_clusters(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_organization_chat_status
ON memory_organization(chatId, status, updatedAt DESC);

CREATE TABLE IF NOT EXISTS memory_organization_runs (
  id TEXT PRIMARY KEY,
  chatId TEXT,
  mode TEXT NOT NULL DEFAULT 'preview',
  status TEXT NOT NULL DEFAULT 'pending',
  algorithmVersion TEXT NOT NULL,
  sourceMemoryCount INTEGER NOT NULL DEFAULT 0,
  processedCount INTEGER NOT NULL DEFAULT 0,
  clusteredCount INTEGER NOT NULL DEFAULT 0,
  independentCount INTEGER NOT NULL DEFAULT 0,
  compositeCount INTEGER NOT NULL DEFAULT 0,
  conflictCount INTEGER NOT NULL DEFAULT 0,
  lowConfidenceCount INTEGER NOT NULL DEFAULT 0,
  checkpoint TEXT,
  error TEXT,
  startedAt INTEGER,
  completedAt INTEGER,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_organization_queue (
  memoryId TEXT PRIMARY KEY,
  operation TEXT NOT NULL DEFAULT 'upsert',
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  availableAt INTEGER NOT NULL,
  lastError TEXT,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  FOREIGN KEY(memoryId) REFERENCES memories(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_memory_organization_queue_status
ON memory_organization_queue(status, availableAt, updatedAt);

CREATE TRIGGER IF NOT EXISTS memory_cluster_members_ai AFTER INSERT ON memory_cluster_members BEGIN
  UPDATE memory_clusters
  SET memberCount = (SELECT COUNT(*) FROM memory_cluster_members WHERE clusterId = new.clusterId),
      updatedAt = MAX(updatedAt, new.updatedAt)
  WHERE id = new.clusterId;
END;

CREATE TRIGGER IF NOT EXISTS memory_cluster_members_ad AFTER DELETE ON memory_cluster_members BEGIN
  UPDATE memory_clusters
  SET memberCount = (SELECT COUNT(*) FROM memory_cluster_members WHERE clusterId = old.clusterId),
      updatedAt = CAST(strftime('%s','now') AS INTEGER) * 1000
  WHERE id = old.clusterId;
END;

CREATE TRIGGER IF NOT EXISTS memories_organization_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memory_organization_queue(memoryId, operation, status, attempts, availableAt, createdAt, updatedAt)
  VALUES (new.id, 'upsert', 'pending', 0, CAST(strftime('%s','now') AS INTEGER) * 1000,
          CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000)
  ON CONFLICT(memoryId) DO UPDATE SET operation='upsert', status='pending', availableAt=excluded.availableAt,
    updatedAt=excluded.updatedAt;
END;

CREATE TRIGGER IF NOT EXISTS memories_organization_au AFTER UPDATE OF content, tags, category, memoryTime ON memories BEGIN
  INSERT INTO memory_organization_queue(memoryId, operation, status, attempts, availableAt, createdAt, updatedAt)
  VALUES (new.id, 'upsert', 'pending', 0, CAST(strftime('%s','now') AS INTEGER) * 1000,
          CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000)
  ON CONFLICT(memoryId) DO UPDATE SET operation='upsert', status='pending', attempts=0,
    availableAt=excluded.availableAt, updatedAt=excluded.updatedAt;
END;
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
ensureColumn('memory_search_logs', 'shadowPolicy', 'TEXT');
ensureColumn('memory_search_logs', 'turnId', 'TEXT');
ensureColumn('memory_search_logs', 'attemptId', 'TEXT');
ensureColumn('memory_search_logs', 'actionType', 'TEXT');
ensureColumn('memory_search_logs', 'generationCompletedAt', 'INTEGER');
ensureColumn('memory_search_logs', 'generationError', 'TEXT');
ensureColumn('memory_search_logs', 'activeEventShadow', 'TEXT');
ensureColumn('memory_organization_runs', 'chatId', 'TEXT');
ensureColumn('memory_clusters', 'subtype', "TEXT NOT NULL DEFAULT 'type_uncertain'");
ensureColumn('memory_clusters', 'subtypeStatus', "TEXT NOT NULL DEFAULT 'candidate'");
ensureColumn('memory_clusters', 'subtypeConfidence', 'REAL NOT NULL DEFAULT 0');
ensureColumn('memory_clusters', 'subtypeReasons', 'TEXT');

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
  db.prepare('DELETE FROM memory_clusters WHERE memberCount = 0').run();
  flushMemoryFtsPending();
  return result.changes > 0;
}

function clearAllMemories() {
  const result = db.prepare('DELETE FROM memories').run();
  db.prepare('DELETE FROM memory_clusters WHERE memberCount = 0').run();
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

function getMemoryFtsTermDocumentCounts(terms, filters = {}) {
  if (!memoryFtsAvailable) return [];
  flushMemoryFtsPending();
  const safeTerms = [...new Set((Array.isArray(terms) ? terms : [])
    .map(value => String(value || '').normalize('NFKC').trim().toLowerCase())
    .filter(value => value.length >= 2 && value.length <= 12))].slice(0, 80);
  const excludedCategories = [...new Set(
    (Array.isArray(filters.excludeCategories) ? filters.excludeCategories : [])
      .map(value => String(value || '').trim().toUpperCase())
      .filter(Boolean)
  )];
  const results = [];
  for (const term of safeTerms) {
    const params = [`"${term.replace(/"/g, '""')}"`];
    const where = ['memory_fts MATCH ?'];
    if (filters.chatId) {
      where.push('memory_fts.chatId = ?');
      params.push(String(filters.chatId));
    }
    if (excludedCategories.length) {
      where.push(`COALESCE(memory_fts.category, '') NOT IN (${excludedCategories.map(() => '?').join(', ')})`);
      params.push(...excludedCategories);
    }
    try {
      const row = db.prepare(`SELECT COUNT(*) AS count FROM memory_fts WHERE ${where.join(' AND ')}`).get(...params);
      results.push({ term, count: Number(row?.count || 0) });
    } catch {}
  }
  return results;
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
    shadowPolicy: safeJsonParse(row.shadowPolicy, null),
    activeEventShadow: safeJsonParse(row.activeEventShadow, null),
    turnId: row.turnId || '',
    attemptId: row.attemptId || '',
    actionType: row.actionType || 'reply',
    status: row.status || 'candidates',
    injectedAt: injectedAt || null,
    injectedAtISO: injectedAt ? new Date(injectedAt).toISOString() : '',
    injectedMemoryIds: safeJsonParse(row.injectedMemoryIds, []),
    injectedCount: Number(row.injectedCount || 0),
    generationCompletedAt: Number(row.generationCompletedAt || 0) || null,
    generationError: row.generationError || ''
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
      resultMemoryIds, resultsTop, chroma, fts, shadowPolicy, activeEventShadow,
      turnId, attemptId, actionType, status, createdAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'candidates', ?)
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
    safeJsonStringify(info.shadowPolicy || null),
    safeJsonStringify(info.activeEventShadow || null),
    String(info.turnId || ''),
    String(info.attemptId || ''),
    String(info.actionType || 'reply'),
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
    const promptCommittedAt = Date.now();

    db.prepare(`
      UPDATE memory_search_logs
      SET status = 'prompt_committed', injectedAt = ?, injectedMemoryIds = ?, injectedCount = ?
      WHERE id = ?
    `).run(
      promptCommittedAt,
      safeJsonStringify(injectedMemoryIds),
      injectedMemoryIds.length,
      safeSearchId
    );

    return {
      committed: true,
      alreadyCommitted: false,
      recallDeferred: true,
      log: normalizeMemorySearchLog(
        db.prepare('SELECT * FROM memory_search_logs WHERE id = ?').get(safeSearchId)
      )
    };
  })();
}

function finishMemorySearchGeneration(searchId, outcome = 'succeeded', errorText = '') {
  const safeSearchId = String(searchId || '').trim();
  if (!safeSearchId) throw new Error('searchId is required');
  const safeOutcome = outcome === 'failed' ? 'failed' : 'succeeded';

  return db.transaction(() => {
    const row = db.prepare('SELECT * FROM memory_search_logs WHERE id = ?').get(safeSearchId);
    if (!row) throw new Error('Memory search log not found');
    if (row.status === 'generation_succeeded' || row.status === 'generation_failed') {
      return {
        finalized: false,
        alreadyFinalized: true,
        recallApplied: false,
        log: normalizeMemorySearchLog(row)
      };
    }
    if (!row.injectedAt) throw new Error('Memory search prompt has not been committed');

    const completedAt = Date.now();
    const injectedMemoryIds = safeJsonParse(row.injectedMemoryIds, []).map(String);
    const updateMemory = db.prepare(`
      UPDATE memories
      SET recallCount = COALESCE(recallCount, 0) + 1,
          lastRecalled = ?
      WHERE id = ?
    `);
    if (safeOutcome === 'succeeded') {
      for (const memoryId of injectedMemoryIds) updateMemory.run(String(completedAt), memoryId);
    }

    db.prepare(`
      UPDATE memory_search_logs
      SET status = ?, generationCompletedAt = ?, generationError = ?
      WHERE id = ?
    `).run(
      safeOutcome === 'succeeded' ? 'generation_succeeded' : 'generation_failed',
      completedAt,
      safeOutcome === 'failed' ? String(errorText || '').slice(0, 500) : '',
      safeSearchId
    );

    return {
      finalized: true,
      alreadyFinalized: false,
      recallApplied: safeOutcome === 'succeeded',
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

function getMemoryOrganizationStatus(chatId = '') {
  const params = [];
  const memoryWhere = chatId ? 'WHERE chatId = ?' : '';
  if (chatId) params.push(String(chatId));
  const totalMemories = Number(db.prepare(`SELECT COUNT(*) AS count FROM memories ${memoryWhere}`).get(...params).count || 0);
  const organizationWhere = chatId ? 'WHERE chatId = ?' : '';
  const organizationRows = db.prepare(`
    SELECT status, COUNT(*) AS count
    FROM memory_organization
    ${organizationWhere}
    GROUP BY status
  `).all(...params);
  const byStatus = Object.fromEntries(organizationRows.map(row => [row.status, Number(row.count || 0)]));
  const trackedCount = organizationRows.reduce((sum, row) => sum + Number(row.count || 0), 0);
  const organizedCount = organizationRows
    .filter(row => !['unreviewed', 'pending', 'failed'].includes(String(row.status || '')))
    .reduce((sum, row) => sum + Number(row.count || 0), 0);
  const clusterRows = db.prepare(`
    SELECT kind, status, COUNT(*) AS count, COALESCE(SUM(memberCount), 0) AS members
    FROM memory_clusters
    ${organizationWhere}
    GROUP BY kind, status
  `).all(...params);
  const subtypeRows = db.prepare(`
    SELECT subtype, subtypeStatus, COUNT(*) AS count
    FROM memory_clusters
    ${organizationWhere}
    GROUP BY subtype, subtypeStatus
  `).all(...params);
  const queueParams = [];
  const queueJoin = chatId ? 'JOIN memories m ON m.id = q.memoryId WHERE m.chatId = ?' : '';
  if (chatId) queueParams.push(String(chatId));
  const queueRows = db.prepare(`
    SELECT q.status, COUNT(*) AS count
    FROM memory_organization_queue q
    ${queueJoin}
    GROUP BY q.status
  `).all(...queueParams);
  const latestRun = chatId
    ? db.prepare('SELECT * FROM memory_organization_runs WHERE chatId = ? ORDER BY createdAt DESC LIMIT 1').get(String(chatId)) || null
    : db.prepare('SELECT * FROM memory_organization_runs ORDER BY createdAt DESC LIMIT 1').get() || null;

  return {
    overlayVersion: 'organization-v1',
    behaviorChanged: false,
    totalMemories,
    trackedCount,
    organizedCount,
    untrackedCount: Math.max(0, totalMemories - trackedCount),
    coverage: totalMemories > 0 ? Number((trackedCount / totalMemories).toFixed(6)) : 1,
    organizationCoverage: totalMemories > 0 ? Number((organizedCount / totalMemories).toFixed(6)) : 1,
    byStatus,
    clusters: clusterRows,
    subtypes: subtypeRows,
    queue: Object.fromEntries(queueRows.map(row => [row.status, Number(row.count || 0)])),
    latestRun
  };
}

function initializeMemoryOrganizationCoverage(options = {}) {
  const algorithmVersion = String(options.algorithmVersion || 'organization-v1');
  const chatId = String(options.chatId || '');
  const timestamp = Date.now();
  const memories = chatId
    ? db.prepare('SELECT id, chatId, content FROM memories WHERE chatId = ? ORDER BY id').all(chatId)
    : db.prepare('SELECT id, chatId, content FROM memories ORDER BY id').all();
  const runId = `organization_init_${timestamp}_${crypto.randomBytes(4).toString('hex')}`;
  const insertRun = db.prepare(`
    INSERT INTO memory_organization_runs (
      id, chatId, mode, status, algorithmVersion, sourceMemoryCount,
      processedCount, startedAt, completedAt, createdAt, updatedAt
    ) VALUES (?, ?, 'coverage', 'completed', ?, ?, ?, ?, ?, ?, ?)
  `);
  const upsert = db.prepare(`
    INSERT INTO memory_organization (
      memoryId, chatId, status, confidence, reason, contentHash,
      algorithmVersion, createdAt, updatedAt
    ) VALUES (?, ?, 'unreviewed', 0, 'awaiting_preview_organization', ?, ?, ?, ?)
    ON CONFLICT(memoryId) DO UPDATE SET
      chatId=excluded.chatId,
      contentHash=excluded.contentHash,
      algorithmVersion=CASE
        WHEN memory_organization.status='unreviewed' THEN excluded.algorithmVersion
        ELSE memory_organization.algorithmVersion
      END,
      updatedAt=excluded.updatedAt
  `);
  const apply = db.transaction(items => {
    for (const memory of items) {
      const hash = crypto.createHash('sha256').update(String(memory.content || ''), 'utf8').digest('hex');
      upsert.run(memory.id, memory.chatId || '', hash, algorithmVersion, timestamp, timestamp);
    }
    insertRun.run(
      runId,
      chatId || null,
      algorithmVersion,
      items.length,
      items.length,
      timestamp,
      timestamp,
      timestamp,
      timestamp
    );
  });
  apply(memories);
  return {
    runId,
    ...getMemoryOrganizationStatus(chatId)
  };
}

function resetMemoryOrganizationOverlay(options = {}) {
  if (String(options.confirm || '') !== 'RESET_ORGANIZATION_OVERLAY') {
    throw new Error('Explicit confirmation is required to reset the organization overlay');
  }

  const before = getMemoryOrganizationStatus('');
  const reset = db.transaction(() => {
    db.prepare('DELETE FROM memory_organization_queue').run();
    db.prepare('DELETE FROM memory_organization').run();
    db.prepare('DELETE FROM memory_cluster_members').run();
    db.prepare('DELETE FROM memory_clusters').run();
    db.prepare('DELETE FROM memory_organization_runs').run();
  });
  reset();

  return {
    reset: true,
    behaviorChanged: false,
    before,
    after: getMemoryOrganizationStatus('')
  };
}

function getMemoryOrganizationPreviewInputs(chatId = '') {
  const where = chatId ? 'WHERE chatId = ?' : '';
  const params = chatId ? [String(chatId)] : [];
  return db.prepare(`
    SELECT id, chatId, content, category, importance, emotionalWeight,
           tags, memoryTime, createdAt, embedding, embeddingModel, embeddingDim
    FROM memories
    ${where}
    ORDER BY chatId, CAST(memoryTime AS INTEGER), id
  `).iterate(...params);
}

function saveMemoryOrganizationPreview(preview, options = {}) {
  if (!preview || !Array.isArray(preview.organizations)) {
    throw new Error('A valid organization preview is required');
  }
  if (String(options.confirm || '') !== 'SAVE_ORGANIZATION_PREVIEW') {
    throw new Error('Explicit confirmation is required to save the organization preview');
  }

  const timestamp = Date.now();
  const runId = `organization_preview_${timestamp}_${crypto.randomBytes(4).toString('hex')}`;
  const clusters = [
    ...(Array.isArray(preview.eventClusters) ? preview.eventClusters : []),
    ...(Array.isArray(preview.topicClusters) ? preview.topicClusters : [])
  ];
  const insertCluster = db.prepare(`
    INSERT INTO memory_clusters (
      id, chatId, kind, title, summary, representativeMemoryId, status,
      confidence, timeStart, timeEnd, memberCount, algorithmVersion,
      subtype, subtypeStatus, subtypeConfidence, subtypeReasons, createdAt, updatedAt
    ) VALUES (?, ?, ?, ?, ?, ?, 'preview', ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertMember = db.prepare(`
    INSERT INTO memory_cluster_members (
      clusterId, memoryId, membershipRole, confidence, reason, source, createdAt, updatedAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const updateOrganization = db.prepare(`
    INSERT INTO memory_organization (
      memoryId, chatId, status, primaryEventClusterId, confidence, reason,
      contentHash, algorithmVersion, reviewedBy, createdAt, updatedAt
    ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?)
    ON CONFLICT(memoryId) DO UPDATE SET
      chatId=excluded.chatId,
      status=CASE WHEN memory_organization.reviewedBy IS NULL THEN excluded.status ELSE memory_organization.status END,
      primaryEventClusterId=CASE WHEN memory_organization.reviewedBy IS NULL THEN excluded.primaryEventClusterId ELSE memory_organization.primaryEventClusterId END,
      confidence=CASE WHEN memory_organization.reviewedBy IS NULL THEN excluded.confidence ELSE memory_organization.confidence END,
      reason=CASE WHEN memory_organization.reviewedBy IS NULL THEN excluded.reason ELSE memory_organization.reason END,
      algorithmVersion=CASE WHEN memory_organization.reviewedBy IS NULL THEN excluded.algorithmVersion ELSE memory_organization.algorithmVersion END,
      updatedAt=excluded.updatedAt
  `);
  const insertRun = db.prepare(`
    INSERT INTO memory_organization_runs (
      id, chatId, mode, status, algorithmVersion, sourceMemoryCount, processedCount,
      clusteredCount, independentCount, compositeCount, conflictCount, lowConfidenceCount,
      checkpoint, startedAt, completedAt, createdAt, updatedAt
    ) VALUES (?, ?, 'preview', 'completed', ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?)
  `);

  const save = db.transaction(() => {
    db.prepare(`
      DELETE FROM memory_clusters
      WHERE status = 'preview' AND (? = '' OR chatId = ?)
    `).run(String(options.chatId || ''), String(options.chatId || ''));

    for (const cluster of clusters) {
      insertCluster.run(
        cluster.id,
        cluster.chatId || '',
        cluster.kind,
        cluster.title,
        cluster.summary || '',
        cluster.representativeMemoryId || null,
        Number(cluster.confidence || 0),
        cluster.timeStart || null,
        cluster.timeEnd || null,
        cluster.algorithmVersion || preview.algorithmVersion,
        cluster.subtype || 'type_uncertain',
        cluster.subtypeStatus || 'candidate',
        Number(cluster.subtypeConfidence || 0),
        JSON.stringify(cluster.subtypeReasons || []),
        timestamp,
        timestamp
      );
      for (const member of cluster.members || []) {
        insertMember.run(
          cluster.id,
          member.memoryId,
          member.membershipRole || 'member',
          Number(member.confidence || 0),
          member.reason || '',
          member.source || 'auto_preview',
          timestamp,
          timestamp
        );
      }
    }

    for (const organization of preview.organizations) {
      updateOrganization.run(
        organization.memoryId,
        organization.chatId || '',
        organization.status,
        organization.primaryEventClusterId || null,
        Number(organization.confidence || 0),
        organization.reason || '',
        organization.algorithmVersion || preview.algorithmVersion,
        timestamp,
        timestamp
      );
    }

    const checkpoint = JSON.stringify({
      eventClusterCount: preview.eventClusters?.length || 0,
      topicClusterCount: preview.topicClusters?.length || 0,
      candidatePairCount: preview.diagnostics?.candidatePairCount || 0,
      acceptedPairCount: preview.diagnostics?.acceptedPairCount || 0
    });
    insertRun.run(
      runId,
      String(options.chatId || '') || null,
      preview.algorithmVersion,
      Number(preview.sourceMemoryCount || 0),
      Number(preview.processedCount || 0),
      Number(preview.clusteredCount || 0),
      Number(preview.independentCount || 0),
      clusters.length,
      checkpoint,
      timestamp,
      timestamp,
      timestamp,
      timestamp
    );
  });
  save();

  return {
    runId,
    behaviorChanged: false,
    eventClusterCount: preview.eventClusters?.length || 0,
    topicClusterCount: preview.topicClusters?.length || 0,
    ...getMemoryOrganizationStatus(String(options.chatId || ''))
  };
}

function getReliableEventClusterMap(memoryIds, options = {}) {
  const ids = [...new Set((Array.isArray(memoryIds) ? memoryIds : []).map(String).filter(Boolean))];
  if (!ids.length) return {};
  const minimumConfidence = Number(options.minimumConfidence ?? 0.84);
  const maximumMembers = Number(options.maximumMembers ?? 6);
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT cm.memoryId, c.id AS clusterId, c.confidence, c.memberCount
    FROM memory_cluster_members cm
    JOIN memory_clusters c ON c.id = cm.clusterId
    WHERE cm.memoryId IN (${placeholders})
      AND c.kind = 'event'
      AND c.status = 'preview'
      AND c.confidence >= ?
      AND c.memberCount BETWEEN 2 AND ?
      AND (c.timeStart IS NULL OR c.timeEnd IS NULL OR c.timeEnd - c.timeStart <= ?)
    ORDER BY c.confidence DESC
  `).all(...ids, minimumConfidence, maximumMembers, 14 * 24 * 60 * 60 * 1000);
  const result = {};
  for (const row of rows) {
    if (!result[row.memoryId]) result[row.memoryId] = row.clusterId;
  }
  return result;
}

function loadIncrementalEventClusters(chatId, excludedMemoryId, candidateIds = []) {
  const ids = [...new Set(candidateIds.map(String).filter(Boolean))];
  if (!ids.length) return [];
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT c.id AS clusterId, c.confidence AS clusterConfidence,
           m.id, m.chatId, m.content, m.category, m.tags, m.memoryTime,
           m.createdAt, m.embedding
    FROM memory_clusters c
    JOIN memory_cluster_members cm ON cm.clusterId = c.id
    JOIN memories m ON m.id = cm.memoryId
    WHERE c.chatId = ? AND c.kind = 'event' AND c.status = 'preview'
      AND c.confidence >= 0.84 AND c.memberCount BETWEEN 2 AND 6
      AND m.id != ?
      AND c.id IN (
        SELECT DISTINCT clusterId FROM memory_cluster_members
        WHERE memoryId IN (${placeholders})
      )
    ORDER BY c.id, cm.confidence DESC
  `).all(String(chatId || ''), String(excludedMemoryId || ''), ...ids);
  const clusters = new Map();
  for (const row of rows) {
    if (!clusters.has(row.clusterId)) {
      clusters.set(row.clusterId, { id: row.clusterId, confidence: row.clusterConfidence, members: [] });
    }
    clusters.get(row.clusterId).members.push(row);
  }
  return [...clusters.values()];
}

function loadIncrementalIndependentMemories(chatId, excludedMemoryId, candidateIds = []) {
  const ids = [...new Set(candidateIds.map(String).filter(Boolean))];
  if (!ids.length) return [];
  const placeholders = ids.map(() => '?').join(',');
  return db.prepare(`
    SELECT m.id, m.chatId, m.content, m.category, m.tags, m.memoryTime,
           m.createdAt, m.embedding
    FROM memories m
    LEFT JOIN memory_organization o ON o.memoryId = m.id
    WHERE m.chatId = ? AND m.id != ? AND UPPER(COALESCE(m.category, 'E')) != 'C'
      AND m.id IN (${placeholders})
      AND (o.primaryEventClusterId IS NULL OR o.primaryEventClusterId = '')
    ORDER BY CAST(m.memoryTime AS INTEGER) DESC, m.id DESC
  `).all(String(chatId || ''), String(excludedMemoryId || ''), ...ids);
}

function processOneMemoryOrganizationQueue(memoryId, suppliedOptions = {}) {
  const options = { ...DEFAULT_INCREMENTAL_OPTIONS, ...suppliedOptions };
  const timestamp = Date.now();
  return db.transaction(() => {
    const memory = db.prepare('SELECT * FROM memories WHERE id = ?').get(String(memoryId));
    if (!memory) {
      db.prepare('DELETE FROM memory_organization_queue WHERE memoryId = ?').run(String(memoryId));
      return { memoryId, action: 'missing' };
    }
    const existingOrganization = db.prepare(
      'SELECT reviewedBy FROM memory_organization WHERE memoryId = ?'
    ).get(memory.id);
    if (existingOrganization?.reviewedBy) {
      db.prepare('DELETE FROM memory_organization_queue WHERE memoryId = ?').run(memory.id);
      return { memoryId: memory.id, action: 'manual_review_preserved' };
    }

    const affectedMemoryIds = db.prepare(`
      SELECT DISTINCT sibling.memoryId
      FROM memory_cluster_members target
      JOIN memory_cluster_members sibling ON sibling.clusterId = target.clusterId
      WHERE target.memoryId = ? AND sibling.memoryId != ?
    `).all(memory.id, memory.id).map(row => row.memoryId);
    db.prepare('DELETE FROM memory_cluster_members WHERE memoryId = ?').run(memory.id);
    db.prepare("DELETE FROM memory_clusters WHERE status = 'preview' AND memberCount < 2").run();
    const selectEventCluster = db.prepare(`
      SELECT c.id
      FROM memory_cluster_members cm
      JOIN memory_clusters c ON c.id = cm.clusterId
      WHERE cm.memoryId = ? AND c.kind = 'event' AND c.status = 'preview'
      ORDER BY c.confidence DESC LIMIT 1
    `);
    const hasAnyCluster = db.prepare(`
      SELECT 1 AS present
      FROM memory_cluster_members cm
      JOIN memory_clusters c ON c.id = cm.clusterId
      WHERE cm.memoryId = ? AND c.status = 'preview'
      LIMIT 1
    `);
    const updateAffectedOrganization = db.prepare(`
      UPDATE memory_organization
      SET status = ?, primaryEventClusterId = ?, reason = 'cluster_membership_revalidated', updatedAt = ?
      WHERE memoryId = ? AND reviewedBy IS NULL
    `);
    for (const affectedMemoryId of affectedMemoryIds) {
      const eventCluster = selectEventCluster.get(affectedMemoryId);
      const clustered = Boolean(hasAnyCluster.get(affectedMemoryId));
      updateAffectedOrganization.run(
        clustered ? 'preview_clustered' : 'preview_independent',
        eventCluster?.id || null,
        timestamp,
        affectedMemoryId
      );
    }

    const tags = safeJsonParse(memory.tags, []);
    const candidateSearch = searchMemoriesFts(
      [memory.content || '', ...(Array.isArray(tags) ? tags : [])],
      { chatId: memory.chatId || '', excludeCategories: ['C'], limit: 80 }
    );
    const candidateIds = (candidateSearch.memories || [])
      .map(item => String(item.id || ''))
      .filter(id => id && id !== memory.id);
    const eventClusters = loadIncrementalEventClusters(memory.chatId, memory.id, candidateIds);
    const independent = loadIncrementalIndependentMemories(memory.chatId, memory.id, candidateIds);
    const decision = decideIncrementalOrganization(memory, eventClusters, independent, options);
    let primaryEventClusterId = null;

    if (decision.action === 'attach_event') {
      primaryEventClusterId = decision.clusterId;
      db.prepare(`
        INSERT INTO memory_cluster_members (
          clusterId, memoryId, membershipRole, confidence, reason, source, createdAt, updatedAt
        ) VALUES (?, ?, 'member', ?, ?, 'incremental_preview', ?, ?)
      `).run(primaryEventClusterId, memory.id, decision.confidence, decision.reason, timestamp, timestamp);
      db.prepare(`
        UPDATE memory_clusters
        SET confidence = MIN(confidence, ?),
            timeStart = CASE WHEN timeStart IS NULL THEN ? ELSE MIN(timeStart, ?) END,
            timeEnd = CASE WHEN timeEnd IS NULL THEN ? ELSE MAX(timeEnd, ?) END,
            updatedAt = ?
        WHERE id = ?
      `).run(
        decision.confidence,
        Number(memory.memoryTime || memory.createdAt) || timestamp,
        Number(memory.memoryTime || memory.createdAt) || timestamp,
        Number(memory.memoryTime || memory.createdAt) || timestamp,
        Number(memory.memoryTime || memory.createdAt) || timestamp,
        timestamp,
        primaryEventClusterId
      );
    } else if (decision.action === 'create_event') {
      primaryEventClusterId = createIncrementalClusterId([memory.id, decision.partnerMemoryId], options.algorithmVersion);
      const partner = db.prepare('SELECT * FROM memories WHERE id = ?').get(decision.partnerMemoryId);
      const times = [memory, partner].map(item => Number(item?.memoryTime || item?.createdAt)).filter(Number.isFinite);
      db.prepare(`
        INSERT INTO memory_clusters (
          id, chatId, kind, title, summary, representativeMemoryId, status,
          confidence, timeStart, timeEnd, memberCount, algorithmVersion,
          subtype, subtypeStatus, subtypeConfidence, subtypeReasons, createdAt, updatedAt
        ) VALUES (?, ?, 'event', '待确认记忆组', '由新增记忆的高置信度匹配形成，只用于预览。', ?, 'preview',
                  ?, ?, ?, 0, ?, 'type_uncertain', 'candidate', 0, '[]', ?, ?)
      `).run(
        primaryEventClusterId, memory.chatId || '', partner.id, decision.confidence,
        times.length ? Math.min(...times) : null, times.length ? Math.max(...times) : null,
        options.algorithmVersion, timestamp, timestamp
      );
      const insertMember = db.prepare(`
        INSERT INTO memory_cluster_members (
          clusterId, memoryId, membershipRole, confidence, reason, source, createdAt, updatedAt
        ) VALUES (?, ?, ?, ?, ?, 'incremental_preview', ?, ?)
      `);
      insertMember.run(primaryEventClusterId, partner.id, 'representative', 1, decision.reason, timestamp, timestamp);
      insertMember.run(primaryEventClusterId, memory.id, 'member', decision.confidence, decision.reason, timestamp, timestamp);
      db.prepare(`
        INSERT INTO memory_organization (
          memoryId, chatId, status, primaryEventClusterId, confidence, reason,
          contentHash, algorithmVersion, createdAt, updatedAt
        ) VALUES (?, ?, 'preview_clustered', ?, ?, ?, NULL, ?, ?, ?)
        ON CONFLICT(memoryId) DO UPDATE SET
          status='preview_clustered', primaryEventClusterId=excluded.primaryEventClusterId,
          confidence=excluded.confidence, reason=excluded.reason,
          algorithmVersion=excluded.algorithmVersion, updatedAt=excluded.updatedAt
      `).run(partner.id, partner.chatId || '', primaryEventClusterId, decision.confidence, decision.reason, options.algorithmVersion, timestamp, timestamp);
    }

    const status = decision.action === 'protected_core'
      ? 'preview_protected_core'
      : primaryEventClusterId ? 'preview_clustered' : 'preview_independent';
    const contentHash = crypto.createHash('sha256').update(String(memory.content || ''), 'utf8').digest('hex');
    db.prepare(`
      INSERT INTO memory_organization (
        memoryId, chatId, status, primaryEventClusterId, confidence, reason,
        contentHash, algorithmVersion, createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(memoryId) DO UPDATE SET
        chatId=excluded.chatId, status=excluded.status,
        primaryEventClusterId=excluded.primaryEventClusterId,
        confidence=excluded.confidence, reason=excluded.reason,
        contentHash=excluded.contentHash, algorithmVersion=excluded.algorithmVersion,
        updatedAt=excluded.updatedAt
    `).run(
      memory.id, memory.chatId || '', status, primaryEventClusterId,
      decision.confidence, decision.reason, contentHash, options.algorithmVersion,
      timestamp, timestamp
    );
    db.prepare('DELETE FROM memory_organization_queue WHERE memoryId = ?').run(memory.id);
    return { memoryId: memory.id, ...decision, status, primaryEventClusterId };
  })();
}

function processMemoryOrganizationQueue(options = {}) {
  const limit = Math.min(100, Math.max(1, Number(options.limit || 20)));
  const rows = db.prepare(`
    SELECT memoryId, attempts
    FROM memory_organization_queue
    WHERE status = 'pending' AND availableAt <= ?
    ORDER BY createdAt ASC
    LIMIT ?
  `).all(Date.now(), limit);
  const results = [];
  for (const row of rows) {
    try {
      results.push(processOneMemoryOrganizationQueue(row.memoryId, options));
    } catch (error) {
      const attempts = Number(row.attempts || 0) + 1;
      const delay = Math.min(60 * 60 * 1000, 1000 * (2 ** Math.min(attempts, 10)));
      db.prepare(`
        UPDATE memory_organization_queue
        SET status='pending', attempts=?, availableAt=?, lastError=?, updatedAt=?
        WHERE memoryId=?
      `).run(attempts, Date.now() + delay, String(error.message || error).slice(0, 1000), Date.now(), row.memoryId);
      results.push({ memoryId: row.memoryId, action: 'failed', error: error.message || String(error) });
    }
  }
  return {
    behaviorChanged: false,
    algorithmVersion: String(options.algorithmVersion || DEFAULT_INCREMENTAL_OPTIONS.algorithmVersion),
    processedCount: results.filter(item => item.action !== 'failed').length,
    failedCount: results.filter(item => item.action === 'failed').length,
    results,
    organization: getMemoryOrganizationStatus(String(options.chatId || ''))
  };
}

function listMemoryClusters(filters = {}) {
  const where = [];
  const params = [];
  if (filters.chatId) {
    where.push('c.chatId = ?');
    params.push(String(filters.chatId));
  }
  if (filters.kind) {
    where.push('c.kind = ?');
    params.push(String(filters.kind));
  }
  if (filters.status) {
    where.push('c.status = ?');
    params.push(String(filters.status));
  }
  if (filters.clusterId) {
    where.push('c.id = ?');
    params.push(String(filters.clusterId));
  }
  if (filters.subtype) {
    where.push('c.subtype = ?');
    params.push(String(filters.subtype));
  }
  const limit = Math.min(1000, Math.max(1, Number(filters.limit || 100)));
  const memberLimit = Math.min(1000, Math.max(1, Number(filters.memberLimit || 200)));
  params.push(limit);
  const rows = db.prepare(`
    SELECT c.*
    FROM memory_clusters c
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY c.updatedAt DESC, c.confidence DESC
    LIMIT ?
  `).all(...params);
  const memberQuery = db.prepare(`
    SELECT cm.memoryId, cm.membershipRole, cm.confidence, cm.reason, cm.source,
           m.content, m.category, m.tags, m.memoryTime, m.importance, m.emotionalWeight
    FROM memory_cluster_members cm
    JOIN memories m ON m.id = cm.memoryId
    WHERE cm.clusterId = ?
    ORDER BY cm.confidence DESC, CAST(m.memoryTime AS INTEGER) ASC
    LIMIT ?
  `);
  return rows.map(row => {
    if (filters.includeMembers === false) {
      return {
        ...row,
        subtypeReasons: safeJsonParse(row.subtypeReasons, []),
        returnedMemberCount: 0,
        hasMoreMembers: Number(row.memberCount || 0) > 0,
        members: []
      };
    }
    const members = memberQuery.all(row.id, memberLimit);
    return {
      ...row,
      subtypeReasons: safeJsonParse(row.subtypeReasons, []),
      returnedMemberCount: members.length,
      hasMoreMembers: Number(row.memberCount || 0) > members.length,
      members
    };
  });
}

function listMemoryOrganizationEntries(filters = {}) {
  const where = [];
  const params = [];
  if (filters.chatId) {
    where.push('o.chatId = ?');
    params.push(String(filters.chatId));
  }
  if (filters.status) {
    where.push('o.status = ?');
    params.push(String(filters.status));
  }
  const limit = Math.min(200, Math.max(1, Number(filters.limit || 50)));
  const offset = Math.max(0, Number(filters.offset || 0));
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = Number(db.prepare(`
    SELECT COUNT(*) AS count
    FROM memory_organization o
    ${whereSql}
  `).get(...params).count || 0);
  const rows = db.prepare(`
    SELECT o.memoryId, o.status, o.confidence, o.reason, o.algorithmVersion,
           m.chatId, m.content, m.category, m.importance, m.emotionalWeight,
           m.tags, m.memoryTime, m.createdAt, m.updatedAt
    FROM memory_organization o
    JOIN memories m ON m.id = o.memoryId
    ${whereSql}
    ORDER BY CAST(m.memoryTime AS INTEGER) DESC, m.id DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset).map(row => ({
    ...row,
    tags: safeJsonParse(row.tags, [])
  }));
  return {
    total,
    offset,
    limit,
    hasMore: offset + rows.length < total,
    entries: rows
  };
}

function normalizeActiveEvent(row) {
  if (!row) return null;
  return {
    ...row,
    proactiveMention: Boolean(row.proactiveMention),
    aliases: safeJsonParse(row.aliases, []),
    sourceMemoryIds: safeJsonParse(row.sourceMemoryIds, []),
    evidence: safeJsonParse(row.evidence, {}),
    confidence: Number(row.confidence || 0)
  };
}

function listMemoryActiveEvents(filters = {}) {
  const where = [];
  const params = [];
  if (filters.chatId) {
    where.push('chatId = ?');
    params.push(String(filters.chatId));
  }
  if (filters.status) {
    where.push('status = ?');
    params.push(String(filters.status));
  } else if (!filters.includeArchived) {
    where.push("status NOT IN ('completed', 'cancelled', 'archived')");
  }
  const limit = Math.min(200, Math.max(1, Number(filters.limit || 50)));
  params.push(limit);
  return db.prepare(`
    SELECT * FROM memory_active_events
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY COALESCE(startAt, validUntil, updatedAt) ASC, updatedAt DESC
    LIMIT ?
  `).all(...params).map(normalizeActiveEvent);
}

function upsertMemoryActiveEvent(input = {}) {
  const now = Date.now();
  const chatId = String(input.chatId || '').trim();
  const title = String(input.title || '').trim();
  if (!chatId) throw new Error('chatId is required');
  if (!title) throw new Error('title is required');
  const allowedStatuses = new Set(['candidate', 'planned', 'active', 'completed', 'cancelled', 'archived']);
  const allowedSurfaceModes = new Set(['on_reference', 'always_context', 'manual_only']);
  const status = allowedStatuses.has(String(input.status || 'candidate')) ? String(input.status || 'candidate') : 'candidate';
  const surfaceMode = allowedSurfaceModes.has(String(input.surfaceMode || 'on_reference'))
    ? String(input.surfaceMode || 'on_reference')
    : 'on_reference';
  const id = String(input.id || `active_event_${now}_${crypto.randomBytes(4).toString('hex')}`);
  const aliases = [...new Set((Array.isArray(input.aliases) ? input.aliases : [])
    .map(value => String(value || '').trim()).filter(Boolean))].slice(0, 24);
  const sourceMemoryIds = [...new Set((Array.isArray(input.sourceMemoryIds) ? input.sourceMemoryIds : [])
    .map(value => String(value || '').trim()).filter(Boolean))].slice(0, 100);
  const archivedAt = ['completed', 'cancelled', 'archived'].includes(status) ? Number(input.archivedAt || now) : null;
  db.prepare(`
    INSERT INTO memory_active_events (
      id, chatId, title, summary, status, startAt, endAt, validUntil,
      surfaceMode, proactiveMention, aliases, sourceMemoryIds, evidence,
      confidence, createdAt, updatedAt, archivedAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      chatId=excluded.chatId, title=excluded.title, summary=excluded.summary,
      status=excluded.status, startAt=excluded.startAt, endAt=excluded.endAt,
      validUntil=excluded.validUntil, surfaceMode=excluded.surfaceMode,
      proactiveMention=excluded.proactiveMention, aliases=excluded.aliases,
      sourceMemoryIds=excluded.sourceMemoryIds, evidence=excluded.evidence,
      confidence=excluded.confidence, updatedAt=excluded.updatedAt,
      archivedAt=excluded.archivedAt
  `).run(
    id, chatId, title, String(input.summary || ''), status,
    Number(input.startAt || 0) || null, Number(input.endAt || 0) || null,
    Number(input.validUntil || 0) || null, surfaceMode, input.proactiveMention === true ? 1 : 0,
    safeJsonStringify(aliases), safeJsonStringify(sourceMemoryIds), safeJsonStringify(input.evidence || {}),
    Math.max(0, Math.min(1, Number(input.confidence || 0))),
    Number(input.createdAt || now), now, archivedAt
  );
  return normalizeActiveEvent(db.prepare('SELECT * FROM memory_active_events WHERE id = ?').get(id));
}

function archiveMemoryActiveEvent(id, status = 'archived') {
  const safeId = String(id || '').trim();
  if (!safeId) throw new Error('id is required');
  const safeStatus = ['completed', 'cancelled', 'archived'].includes(String(status)) ? String(status) : 'archived';
  const now = Date.now();
  db.prepare(`
    UPDATE memory_active_events
    SET status = ?, archivedAt = ?, updatedAt = ?
    WHERE id = ?
  `).run(safeStatus, now, now, safeId);
  return normalizeActiveEvent(db.prepare('SELECT * FROM memory_active_events WHERE id = ?').get(safeId));
}

module.exports = {
  db,
  addMemory,
  listMemories,
  getMemoryById,
  getMemoriesByIds,
  searchMemoriesFts,
  getMemoryFtsTermDocumentCounts,
  getMemoryFtsStatus,
  rebuildMemoryFts,
  deleteMemory,
  clearAllMemories,
  getMemoryStats,
  listUnembeddedMemories,
  createMemorySearchLog,
  getLatestMemorySearchLog,
  commitMemorySearchInjection,
  finishMemorySearchGeneration,
  importFromJsonArray,
  addGardenWakeEvent,
  claimGardenWakeEvent,
  finishGardenWakeEvent,
  getGardenWakeStats,
  addAisayWakeEvent,
  claimAisayWakeEvent,
  finishAisayWakeEvent,
  getAisayWakeStats,
  getMemoryOrganizationStatus,
  initializeMemoryOrganizationCoverage,
  resetMemoryOrganizationOverlay,
  getMemoryOrganizationPreviewInputs,
  saveMemoryOrganizationPreview,
  getReliableEventClusterMap,
  processMemoryOrganizationQueue,
  listMemoryClusters,
  listMemoryOrganizationEntries,
  listMemoryActiveEvents,
  upsertMemoryActiveEvent,
  archiveMemoryActiveEvent
};
