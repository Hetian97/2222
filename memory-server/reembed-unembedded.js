const { db } = require('./db');

const ENDPOINT = (process.env.EMBEDDING_ENDPOINT || '').replace(/\/$/, '');
const API_KEY = process.env.EMBEDDING_API_KEY || '';
const MODEL = process.env.EMBEDDING_MODEL || 'text-embedding-3-small';

const LIMIT = Number(process.env.REEMBED_LIMIT || 3);
const DRY_RUN = process.env.REEMBED_DRY_RUN === 'true';
const DELAY_MS = Number(process.env.REEMBED_DELAY_MS || 800);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getUnembeddedMemories(limit) {
  return db.prepare(`
    SELECT id, content, category, importance, embedding
    FROM memories
    WHERE embedding IS NULL
       OR embedding = ''
       OR embedding = 'null'
       OR embedding = '[]'
    ORDER BY importance DESC, CAST(memoryTime AS INTEGER) DESC, CAST(createdAt AS INTEGER) DESC
    LIMIT ?
  `).all(limit);
}

async function createEmbedding(text) {
  if (!ENDPOINT) {
    throw new Error('Missing EMBEDDING_ENDPOINT');
  }

  if (!API_KEY) {
    throw new Error('Missing EMBEDDING_API_KEY');
  }

  const url = ENDPOINT.endsWith('/v1/embeddings')
    ? ENDPOINT
    : `${ENDPOINT}/v1/embeddings`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${API_KEY}`
    },
    body: JSON.stringify({
      model: MODEL,
      input: text
    })
  });

  if (!response.ok) {
    let errorText = '';
    try {
      errorText = await response.text();
    } catch {}

    throw new Error(`HTTP ${response.status}${errorText ? ': ' + errorText.slice(0, 200) : ''}`);
  }

  const data = await response.json();
  const embedding = data?.data?.[0]?.embedding;

  if (!Array.isArray(embedding) || embedding.length === 0) {
    throw new Error('API returned no valid embedding');
  }

  return embedding;
}

function updateEmbedding(id, embedding) {
  const timestamp = String(Date.now());

  db.prepare(`
    UPDATE memories
    SET embedding = ?,
        embeddingModel = ?,
        embeddingDim = ?,
        embeddingUpdatedAt = ?,
        updatedAt = ?
    WHERE id = ?
  `).run(
    JSON.stringify(embedding),
    MODEL,
    embedding.length,
    timestamp,
    timestamp,
    id
  );
}

async function main() {
  console.log('[reembed] model =', MODEL);
  console.log('[reembed] limit =', LIMIT);
  console.log('[reembed] dry run =', DRY_RUN);
  console.log('[reembed] delay =', DELAY_MS, 'ms');

  const rows = getUnembeddedMemories(LIMIT);

  console.log(`[reembed] found ${rows.length} unembedded memories`);

  if (rows.length === 0) {
    console.log('[reembed] nothing to do');
    return;
  }

  let success = 0;
  let failed = 0;
  let dimension = null;

  for (const [index, row] of rows.entries()) {
    const preview = String(row.content || '').slice(0, 50).replace(/\s+/g, ' ');

    console.log(`\n[${index + 1}/${rows.length}] ${row.id}`);
    console.log('category =', row.category, 'importance =', row.importance);
    console.log('content =', preview);

    try {
      const embedding = await createEmbedding(row.content || '');

      if (dimension === null) {
        dimension = embedding.length;
      } else if (dimension !== embedding.length) {
        throw new Error(`Embedding dimension mismatch: expected ${dimension}, got ${embedding.length}`);
      }

      console.log('embedding dim =', embedding.length);

      if (!DRY_RUN) {
        updateEmbedding(row.id, embedding);
        console.log('saved to SQLite');
      } else {
        console.log('dry run: not saved');
      }

      success++;
    } catch (error) {
      failed++;
      console.error('failed:', error.message);
    }

    if (index < rows.length - 1 && DELAY_MS > 0) {
      await sleep(DELAY_MS);
    }
  }

  console.log('\n[reembed] done');
  console.log('success =', success);
  console.log('failed =', failed);
  console.log('dimension =', dimension);
}

main().catch(error => {
  console.error('[reembed] fatal:', error);
  process.exit(1);
});