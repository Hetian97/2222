const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const tz = require('../time-zone-utils');

const summer = Date.UTC(2026, 7, 20, 19, 17, 59);
assert.strictEqual(tz.format(summer, 'Europe/London'), '2026-08-20 20:17');
assert.strictEqual(tz.format(summer, 'Asia/Shanghai'), '2026-08-21 03:17');
assert.strictEqual(tz.fromDateTimeLocal('2026-08-20T20:17', 'Europe/London'), Date.UTC(2026, 7, 20, 19, 17));
assert.strictEqual(tz.fromDateTimeLocal('2026-08-21T03:17', 'Asia/Shanghai'), Date.UTC(2026, 7, 20, 19, 17));

const winter = Date.UTC(2026, 11, 20, 20, 17);
assert.strictEqual(tz.format(winter, 'Europe/London'), '2026-12-20 20:17');
assert.strictEqual(tz.fromDateTimeLocal('2026-12-20T20:17', 'Europe/London'), winter);

const chat = { history: [{ timestamp: summer }], variableMemory: { fragments: [{ memoryTime: summer, createdAt: summer }] } };
assert.strictEqual(tz.stampChat(chat, 'Europe/London'), true);
assert.strictEqual(chat.history[0].timestampTimeZone, 'Europe/London');
assert.strictEqual(chat.variableMemory.fragments[0].memoryTimeZone, 'Europe/London');
assert.strictEqual(chat.history[0].timestamp, summer);
assert.strictEqual(chat.variableMemory.fragments[0].memoryTime, summer);
assert.strictEqual(tz.stampChat(chat, 'Asia/Shanghai'), false, 'existing zones must never be overwritten');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-time-zone-'));
const dbPath = path.join(tempDir, 'test.db');
const seedScript = `
  const Database = require(${JSON.stringify(require.resolve('better-sqlite3'))});
  const db = new Database(${JSON.stringify(dbPath)});
  db.exec(\`CREATE TABLE memories (
    id TEXT PRIMARY KEY, chatId TEXT, content TEXT NOT NULL, category TEXT,
    importance INTEGER DEFAULT 5, emotionalWeight INTEGER DEFAULT 5, tags TEXT,
    memoryTime TEXT, createdAt TEXT, updatedAt TEXT, lastRecalled TEXT,
    recallCount INTEGER DEFAULT 0, embedding TEXT, embeddingModel TEXT,
    embeddingDim INTEGER DEFAULT 0, embeddingUpdatedAt TEXT, linkedMemories TEXT,
    source TEXT, context TEXT
  )\`);
  db.prepare('INSERT INTO memories (id, content, memoryTime, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)').run('legacy', 'unchanged', '${summer}', '${summer}', '${summer}');
  db.close();
`;
assert.strictEqual(spawnSync(process.execPath, ['-e', seedScript], { cwd: __dirname }).status, 0);

const previousPath = process.env.MEMORY_DB_PATH;
process.env.MEMORY_DB_PATH = dbPath;
delete require.cache[require.resolve('./db')];
const { db } = require('./db');
const row = db.prepare('SELECT * FROM memories WHERE id = ?').get('legacy');
assert.strictEqual(row.content, 'unchanged');
assert.strictEqual(row.memoryTime, String(summer));
assert.strictEqual(row.memoryTimeZone, 'Europe/London');
assert.strictEqual(row.createdAtTimeZone, 'Europe/London');
db.close();
if (previousPath === undefined) delete process.env.MEMORY_DB_PATH;
else process.env.MEMORY_DB_PATH = previousPath;
fs.rmSync(tempDir, { recursive: true, force: true });

console.log('Time-zone stability tests passed');
