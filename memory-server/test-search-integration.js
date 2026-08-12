const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-search-test-'));
const dbPath = path.join(testDir, 'memory.db');
const port = 18765 + Math.floor(Math.random() * 1000);

process.env.MEMORY_DB_PATH = dbPath;
const database = require('./db');

database.addMemory({
  id: 'very_old_beijing_trip',
  chatId: 'chat-1',
  content: '北京学术出差将在二十号出发，持续七天',
  tags: ['北京', '学术出差'],
  importance: 8,
  memoryTime: 1
});

for (let index = 0; index < 30; index++) {
  database.addMemory({
    id: `recent_${index}`,
    chatId: 'chat-1',
    content: `普通日常记忆 ${index}`,
    tags: ['日常'],
    memoryTime: Date.now() + index
  });
}

database.db.close();

function request(method, pathname, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : '';
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: pathname,
      method,
      headers: payload ? {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      } : {}
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function waitForServer(child) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('server startup timed out')), 10000);
    child.stdout.on('data', data => {
      if (String(data).includes('Aion Memory Server running')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.once('exit', code => {
      clearTimeout(timeout);
      reject(new Error(`server exited early with code ${code}`));
    });
  });
}

async function main() {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: __dirname,
    env: {
      ...process.env,
      PORT: String(port),
      MEMORY_DB_PATH: dbPath,
      MEMORY_SEARCH_ENGINE: 'hybrid',
      EMBEDDING_ENDPOINT: '',
      EMBEDDING_API_KEY: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  try {
    await waitForServer(child);

    const status = await request('GET', '/memory/fts/status');
    assert.equal(status.status, 200);
    assert.equal(status.body.fts.integrity, 'ok');
    assert.equal(status.body.fts.totalMemories, 31);

    const search = await request('POST', '/memory/search', {
      query: '北京出差',
      queryVariants: ['二十号出发'],
      searchEngine: 'hybrid',
      chatId: 'chat-1',
      limit: 5,
      candidateLimit: 10,
      diagnostic: true
    });

    assert.equal(search.status, 200);
    assert.equal(search.body.fts.attempted, true);
    assert(search.body.memories.some(memory => memory.id === 'very_old_beijing_trip'));

    const rebuild = await request('POST', '/memory/fts/rebuild');
    assert.equal(rebuild.status, 200);
    assert.equal(rebuild.body.fts.integrity, 'ok');

    console.log('Search integration tests passed');
  } finally {
    child.kill();
    await new Promise(resolve => child.once('exit', resolve));
    fs.rmSync(testDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
