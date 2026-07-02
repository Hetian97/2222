const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, 'memory.db');
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

module.exports = {
  db,
  addMemory,
  listMemories,
  deleteMemory,
  clearAllMemories,
  getMemoryStats,
  listUnembeddedMemories,
  importFromJsonArray
};