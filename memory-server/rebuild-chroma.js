#!/usr/bin/env node
/**
 * rebuild-chroma.js —— 从 SQLite 重建 Chroma 向量索引
 *
 * 为什么需要它：
 *   memories.embedding 存的是 4096 维向量的 JSON 文本（在 DB 里），
 *   chroma-data 只是加速语义检索的索引副本。
 *   所以只要 DB 备份在，索引随时能重建 —— chroma-data 不必单独备份。
 *
 * 用法（在 VPS 的 /root/memory-server 里执行）：
 *   node rebuild-chroma.js --dry-run        # 只统计，不写库
 *   node rebuild-chroma.js                  # 真正重建（默认每批 100 条）
 *   node rebuild-chroma.js --batch 50       # 改批大小
 *   node rebuild-chroma.js --verify-only    # 只做自检（抽查一条能否查回来）
 *
 * 前置条件：chroma 服务在跑（pm2 list 里 chroma 应为 online）
 * 安全性：只往 chroma upsert，不修改 SQLite 任何数据
 */
'use strict';

const { listMemories, getMemoryEmbeddingCounts } = require('./db');
const {
  chromaHeartbeat,
  upsertMemoriesToChroma,
  queryChromaByEmbedding
} = require('./chroma-client');

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) {
    const value = Number(process.argv[index + 1]);
    if (Number.isFinite(value) && value > 0) return Math.floor(value);
  }
  return fallback;
}

async function checkChroma() {
  try {
    const beat = await chromaHeartbeat();
    return { ok: true, beat };
  } catch (error) {
    return { ok: false, error: error && error.message ? error.message : String(error) };
  }
}

async function verifyOne(memories) {
  if (!memories.length) {
    console.log('[verify] 没有带向量的记忆，跳过');
    return false;
  }
  const probe = memories[memories.length - 1];
  console.log(`[verify] 抽查记忆 ${probe.id}（${String(probe.content || '').slice(0, 30)}…）`);
  const result = await queryChromaByEmbedding(probe.embedding, { nResults: 5 });
  const ids = (result && result.ids && result.ids[0]) || [];
  const hit = ids.includes(String(probe.id));
  console.log(`[verify] chroma 返回前 ${ids.length} 个 id，自身${hit ? '命中 ✓' : '未命中 ✗'}`);
  if (!hit) console.log(`        返回: ${ids.join(', ')}`);
  return hit;
}

async function main() {
  const dryRun = hasFlag('--dry-run');
  const verifyOnly = hasFlag('--verify-only');
  const batchSize = argValue('--batch', 100);

  const counts = getMemoryEmbeddingCounts();
  console.log(`[info] SQLite 记忆总数 ${counts.total}，带向量 ${counts.withEmbedding}，无向量 ${counts.withoutEmbedding}`);

  const chroma = await checkChroma();
  if (!chroma.ok) {
    console.error('[error] 连不上 chroma，请先启动：pm2 start chroma');
    console.error(`        详情: ${chroma.error}`);
    process.exitCode = 1;
    return;
  }
  console.log('[info] chroma 在线 ✓');

  const all = listMemories({ limit: 10000 });
  const eligible = all.filter(memory => Array.isArray(memory.embedding) && memory.embedding.length > 0);
  console.log(`[info] 本次可重建 ${eligible.length} 条（DB 里共 ${all.length} 条）`);
  if (eligible.length !== counts.withEmbedding) {
    console.log(`[warn] 与 SQL 统计略有差异（${eligible.length} vs ${counts.withEmbedding}），可能是 limit 上限导致，仅影响 10000 条以上的库`);
  }

  if (verifyOnly) {
    await verifyOne(eligible);
    return;
  }

  if (dryRun) {
    console.log('[dry-run] 不会写入任何数据。去掉 --dry-run 才会真正重建。');
    return;
  }

  console.log(`[write] 开始 upsert（每批 ${batchSize} 条）…`);
  const startedAt = Date.now();
  const result = await upsertMemoriesToChroma(eligible, { batchSize });
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`[write] 完成：${JSON.stringify(result)}，耗时 ${seconds}s`);

  await verifyOne(eligible);
  console.log('[done] 重建结束。可再跑一次 --verify-only 复检。');
}

main().catch(error => {
  console.error('[fatal]', error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
