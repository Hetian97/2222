const CHROMA_URL = process.env.CHROMA_URL || 'http://127.0.0.1:8001';
const CHROMA_COLLECTION = process.env.CHROMA_COLLECTION || 'ephone_memories';

let chromaModulePromise = null;
let clientPromise = null;
let collectionPromise = null;

function parseChromaUrl(urlText) {
  const url = new URL(urlText);
  return {
    host: url.hostname,
    port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)),
    ssl: url.protocol === 'https:'
  };
}

async function loadChromaModule() {
  if (!chromaModulePromise) {
    chromaModulePromise = import('chromadb');
  }
  return chromaModulePromise;
}

async function getChromaClient() {
  if (!clientPromise) {
    clientPromise = (async () => {
      const { ChromaClient } = await loadChromaModule();
      const config = parseChromaUrl(CHROMA_URL);
      return new ChromaClient(config);
    })();
  }
  return clientPromise;
}

async function getChromaCollection() {
  if (!collectionPromise) {
    collectionPromise = (async () => {
      const client = await getChromaClient();

      return client.getOrCreateCollection({
        name: CHROMA_COLLECTION,
        metadata: {
          source: '2222EPhone memory-server',
          embeddingModel: process.env.EMBEDDING_MODEL || '',
          embeddingDim: '4096'
        }
      });
    })();
  }
  return collectionPromise;
}

async function chromaHeartbeat() {
  const client = await getChromaClient();
  return client.heartbeat();
}

function sanitizeMetadataValue(value) {
  if (value === undefined || value === null) return '';
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function memoryToChromaItem(memory) {
  if (!memory || !memory.id) return null;

  const embedding = Array.isArray(memory.embedding) && memory.embedding.length > 0
    ? memory.embedding
    : null;

  if (!embedding) return null;

  return {
    id: String(memory.id),
    document: String(memory.content || ''),
    embedding,
    metadata: {
      chatId: sanitizeMetadataValue(memory.chatId),
      category: sanitizeMetadataValue(memory.category),
      importance: Number(memory.importance || 0),
      emotionalWeight: Number(memory.emotionalWeight || 0),
      tags: sanitizeMetadataValue(memory.tags),
      memoryTime: sanitizeMetadataValue(memory.memoryTime),
      createdAt: sanitizeMetadataValue(memory.createdAt),
      updatedAt: sanitizeMetadataValue(memory.updatedAt),
      source: sanitizeMetadataValue(memory.source),
      context: sanitizeMetadataValue(memory.context),
      embeddingModel: sanitizeMetadataValue(memory.embeddingModel),
      embeddingDim: Number(memory.embeddingDim || embedding.length)
    }
  };
}

async function upsertMemoriesToChroma(memories, options = {}) {
  const batchSize = Number(options.batchSize || 100);
  const collection = await getChromaCollection();

  const items = (memories || [])
    .map(memoryToChromaItem)
    .filter(Boolean);

  let upserted = 0;

  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);

    await collection.upsert({
      ids: batch.map(item => item.id),
      documents: batch.map(item => item.document),
      embeddings: batch.map(item => item.embedding),
      metadatas: batch.map(item => item.metadata)
    });

    upserted += batch.length;
  }

  return {
    ok: true,
    collection: CHROMA_COLLECTION,
    received: memories.length,
    eligible: items.length,
    upserted
  };
}

async function getChromaStatus() {
  const heartbeat = await chromaHeartbeat();
  const collection = await getChromaCollection();

  let count = null;
  if (collection && typeof collection.count === 'function') {
    count = await collection.count();
  }

  return {
    ok: true,
    url: CHROMA_URL,
    collection: CHROMA_COLLECTION,
    heartbeat,
    count
  };
}

module.exports = {
  CHROMA_URL,
  CHROMA_COLLECTION,
  chromaHeartbeat,
  getChromaClient,
  getChromaCollection,
  getChromaStatus,
  upsertMemoriesToChroma
};