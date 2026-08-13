const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const Database = require('better-sqlite3');

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-organization-api-test-'));
const dbPath = path.join(testDir, 'memory.db');
const backupDir = path.join(testDir, 'backups');
const port = 21765 + Math.floor(Math.random() * 1000);
const token = 'organization-api-test-token';

process.env.MEMORY_DB_PATH = dbPath;
const database = require('./db');
database.addMemory({ id: 'api-memory-a', chatId: 'chat-1', content: '保留原文一。' });
database.addMemory({ id: 'api-memory-b', chatId: 'chat-1', content: '保留原文二。' });
database.db.close();

function request(method, pathname, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : '';
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: pathname,
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(payload ? {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        } : {})
      }
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        try {
          resolve({
            status: res.statusCode,
            body: JSON.parse(Buffer.concat(chunks).toString('utf8'))
          });
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
      reject(new Error(`server exited before startup: ${code}`));
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
      MEMORY_BACKUP_DIR: backupDir,
      MEMORY_API_TOKEN: token,
      MEMORY_ORGANIZATION_INCREMENTAL_ENABLED: 'false',
      EMBEDDING_ENDPOINT: '',
      EMBEDDING_API_KEY: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  try {
    await waitForServer(child);

    const initial = await request('GET', '/memory/organization/status');
    assert.equal(initial.status, 200);
    assert.equal(initial.body.organization.totalMemories, 2);
    assert.equal(initial.body.organization.trackedCount, 0);

    const rejectedReset = await request('POST', '/memory/organization/reset', { confirm: 'wrong' });
    assert.equal(rejectedReset.status, 400);
    assert.equal(fs.existsSync(backupDir), false);

    const initialized = await request('POST', '/memory/organization/initialize', {
      algorithmVersion: 'organization-api-test-v1'
    });
    assert.equal(initialized.status, 200);
    assert.equal(initialized.body.organization.trackedCount, 2);
    assert.equal(initialized.body.organization.coverage, 1);
    assert.equal(initialized.body.organization.organizationCoverage, 0);
    assert.equal(initialized.body.backup.ok, true);
    assert.equal(fs.existsSync(initialized.body.backup.backupFile), true);
    assert(initialized.body.backup.latestBackupFile.startsWith(testDir));

    const preview = await request('POST', '/memory/organization/preview', {
      confirm: 'RUN_ORGANIZATION_PREVIEW',
      algorithmVersion: 'organization-api-preview-test-v1'
    });
    assert.equal(preview.status, 200);
    assert.equal(preview.body.preview.behaviorChanged, false);
    assert.equal(preview.body.preview.sourceMemoryCount, 2);
    assert.equal(preview.body.preview.processedCount, 2);
    assert.equal(preview.body.preview.independentCount, 2);
    assert.equal(preview.body.organization.organizationCoverage, 1);

    const independent = await request('GET', '/memory/organization/memories?status=preview_independent&limit=1&offset=0');
    assert.equal(independent.status, 200);
    assert.equal(independent.body.total, 2);
    assert.equal(independent.body.entries.length, 1);
    assert.equal(independent.body.hasMore, true);
    assert.equal(Object.prototype.hasOwnProperty.call(independent.body.entries[0], 'embedding'), false);
    const secondPage = await request('GET', '/memory/organization/memories?status=preview_independent&limit=1&offset=1');
    assert.equal(secondPage.status, 200);
    assert.equal(secondPage.body.entries.length, 1);
    assert.equal(secondPage.body.hasMore, false);

    const clusters = await request('GET', '/memory/organization/clusters?limit=10&memberLimit=10');
    assert.equal(clusters.status, 200);
    assert.equal(clusters.body.count, 0);

    const reset = await request('POST', '/memory/organization/reset', {
      confirm: 'RESET_ORGANIZATION_OVERLAY'
    });
    assert.equal(reset.status, 200);
    assert.equal(reset.body.organization.after.totalMemories, 2);
    assert.equal(reset.body.organization.after.trackedCount, 0);
  } finally {
    child.kill();
    await new Promise(resolve => child.once('exit', resolve));
  }

  const verificationDb = new Database(dbPath, { readonly: true });
  try {
    const memories = verificationDb.prepare('SELECT id, content FROM memories ORDER BY id').all();
    assert.deepEqual(memories, [
      { id: 'api-memory-a', content: '保留原文一。' },
      { id: 'api-memory-b', content: '保留原文二。' }
    ]);
  } finally {
    verificationDb.close();
  }

  console.log('Memory organization API tests passed');
}

main()
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });
