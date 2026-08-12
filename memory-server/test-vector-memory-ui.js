const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const events = [];
const storage = new Map();
const sandbox = {
  console,
  setTimeout,
  clearTimeout,
  localStorage: {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value))
  },
  CustomEvent: class CustomEvent {
    constructor(type, options = {}) {
      this.type = type;
      this.detail = options.detail;
    }
  },
  window: {
    dispatchEvent: event => events.push(event)
  }
};

const source = fs.readFileSync(path.join(__dirname, '..', 'vector-memory.js'), 'utf8');
vm.runInNewContext(source, sandbox, { filename: 'vector-memory.js' });

async function main() {
  const manager = sandbox.window.vectorMemoryManager;
  const chat = {
    id: 'chat-1',
    history: [],
    variableMemory: {
      fragments: [
        {
          id: 'core',
          category: 'C',
          content: '北京出差核心常驻',
          tags: ['北京'],
          importance: 10,
          emotionalWeight: 10,
          memoryTime: Date.now()
        },
        {
          id: 'dynamic',
          category: 'P',
          content: '北京学术出差将在二十号出发',
          tags: ['北京', '出差'],
          importance: 8,
          emotionalWeight: 5,
          memoryTime: Date.now(),
          recallCount: 0,
          lastRecalled: 0
        }
      ],
      settings: {
        topN: 10,
        scoreWeights: { semantic: 0.4, keyword: 0.3, importance: 0.2, emotion: 0.05, recency: 0.05 },
        retrievalCacheEnabled: false,
        autoExtractionMsgInterval: 20,
        lastExtractedMsgIndex: -1,
        externalMemoryEnabled: false,
        externalMemoryEndpoint: 'http://127.0.0.1:8765',
        externalMemoryBearerToken: ''
      },
      stats: { totalFragments: 2, totalRecalls: 0, lastUpdated: 0 },
      _migrated: true
    }
  };

  const changed = manager.applyExternalRecallUpdates(chat, [{
    id: 'dynamic',
    recallCount: 7,
    lastRecalled: 123456789
  }]);
  assert.equal(changed, 1);
  assert.equal(chat.variableMemory.fragments[1].recallCount, 7);
  assert.equal(chat.variableMemory.fragments[1].lastRecalled, 123456789);
  assert.equal(events[0].type, 'variable-memory-recall-updated');

  manager.getEmbedding = async () => null;
  const recalled = await manager.retrieveRelevant(chat, '北京出差', 10);
  assert(recalled.some(result => result.fragment.id === 'dynamic'));
  assert(!recalled.some(result => result.fragment.category === 'C'));

  console.log('Vector memory UI tests passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
