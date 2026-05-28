const fs = require('fs');
const path = require('path');
const { importFromJsonArray } = require('./db');

const jsonPath = path.join(__dirname, 'memory.json');

if (!fs.existsSync(jsonPath)) {
  console.log('memory.json not found. Nothing to migrate.');
  process.exit(0);
}

const raw = fs.readFileSync(jsonPath, 'utf8');
const parsed = JSON.parse(raw);

let memories = null;

if (Array.isArray(parsed)) {
  memories = parsed;
} else if (Array.isArray(parsed.memories)) {
  memories = parsed.memories;
} else if (Array.isArray(parsed.data)) {
  memories = parsed.data;
} else if (Array.isArray(parsed.items)) {
  memories = parsed.items;
} else {
  console.error('Cannot find memory array in memory.json.');
  console.error('Top-level keys:', Object.keys(parsed));
  process.exit(1);
}

const count = importFromJsonArray(memories);

console.log(`Migrated ${count} memories into memory.db`);