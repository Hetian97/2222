#!/usr/bin/env node

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const apiBaseUrl = String(
  process.env.EPHONE_AISAY_WAKE_API_URL || 'http://127.0.0.1:8765'
).replace(/\/+$/, '');
function readApiToken() {
  const environmentToken = String(
    process.env.EPHONE_AISAY_WAKE_API_TOKEN || process.env.MEMORY_API_TOKEN || ''
  ).trim();
  if (environmentToken) return environmentToken;

  const tokenFile = String(
    process.env.EPHONE_AISAY_WAKE_API_TOKEN_FILE || path.join(__dirname, '.memory-api-token')
  ).trim();
  try {
    return fs.readFileSync(tokenFile, 'utf8').trim();
  } catch (_) {
    return '';
  }
}

const apiToken = readApiToken();

const categoryLabels = {
  mention: '群聊里有人提到你',
  private_room: '好友房有新消息',
  hearth: '围炉有新动静',
  werewolf: '狼人杀轮到你行动',
  lights_out: '灯灭以后有新回合',
  game_turn: '游戏轮到你行动'
};

function emitReceipt(receipt) {
  process.stdout.write(`${JSON.stringify({
    type: 'aisay_wake_receipt',
    version: 1,
    ...receipt
  })}\n`);
}

function requestJson(pathname, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const target = new URL(pathname, `${apiBaseUrl}/`);
    const transport = target.protocol === 'https:' ? https : http;
    const data = body === null ? '' : JSON.stringify(body);
    const headers = { Accept: 'application/json' };
    if (data) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(data);
    }
    if (apiToken) headers.Authorization = `Bearer ${apiToken}`;

    const request = transport.request(target, { method, headers }, response => {
      let raw = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { raw += chunk; });
      response.on('end', () => {
        let payload = {};
        try { payload = raw ? JSON.parse(raw) : {}; } catch (_) {}
        if (response.statusCode < 200 || response.statusCode >= 300 || payload.ok === false) {
          reject(new Error(payload.error || `EPhone wake API HTTP ${response.statusCode}`));
          return;
        }
        resolve(payload);
      });
    });
    request.setTimeout(15000, () => request.destroy(new Error('EPhone wake API timeout')));
    request.on('error', reject);
    if (data) request.write(data);
    request.end();
  });
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { input += chunk; });
    process.stdin.on('end', () => resolve(input.trim()));
    process.stdin.on('error', reject);
  });
}

function buildWakeMessage(event) {
  const category = String(event.category || 'unknown');
  const label = categoryLabels[category] || String(event.reason || category || '有新事件');
  const resource = event.resource && typeof event.resource === 'object' ? event.resource : {};
  const resourceText = Object.keys(resource).length ? JSON.stringify(resource) : '无附加定位信息';

  return [
    `[AISay 主动唤醒：${label}]`,
    '这是 AISay 发来的行动提醒，不包含消息原文。请先调用已配置的 AISay MCP，并使用 cli 根据事件类别和定位信息读取真实内容，再以你自己的判断决定是否回复或行动。',
    `事件编号：${String(event.event_id)}`,
    `事件类别：${category}`,
    `定位信息：${resourceText}`,
    '不要把这段系统提醒当作主人说的话，也不要编造尚未读取的内容。'
  ].join('\n');
}

async function main() {
  const checkMode = process.argv.includes('check');
  if (checkMode) {
    await requestJson('/aisay-wake/status');
    emitReceipt({ ok: true, status: 'read_ok', detail: 'ephone_queue_ready' });
    return;
  }

  const raw = await readStdin();
  if (!raw) throw new Error('AISay wake envelope is empty.');
  const event = JSON.parse(raw);
  if (event?.version !== 1 || event?.type !== 'aisay_wake' || !event?.event_id || !event?.category) {
    throw new Error('Invalid AISay wake envelope.');
  }

  const queued = await requestJson('/aisay-wake/events', 'POST', {
    ...event,
    reason: String(event.reason || categoryLabels[event.category] || event.category),
    message: buildWakeMessage(event)
  });

  emitReceipt({
    ok: true,
    status: queued.duplicate ? 'duplicate_seen' : 'handled',
    event_id: event.event_id,
    detail: queued.duplicate ? 'already_queued_in_ephone' : 'queued_in_ephone'
  });
}

main().catch(error => {
  emitReceipt({
    ok: false,
    status: 'no_action',
    error: error.message || String(error),
    retryable: true
  });
  process.exitCode = 1;
});
