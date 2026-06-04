const fs = require('fs');
const path = require('path');

const MCP_URL = process.env.MCP_URL || 'http://127.0.0.1:8765/mcp';
const SUMMARY_FILE = process.env.SUMMARY_FILE || path.join(__dirname, 'raw-test.txt');

async function main() {
  if (!fs.existsSync(SUMMARY_FILE)) {
    throw new Error(`找不到测试文件：${SUMMARY_FILE}`);
  }

  const summaryText = fs.readFileSync(SUMMARY_FILE, 'utf8').trim();

  if (!summaryText) {
    throw new Error(`测试文件是空的：${SUMMARY_FILE}`);
  }

  const body = {
    jsonrpc: '2.0',
    id: 501,
    method: 'tools/call',
    params: {
      name: 'ingest_summary',
      arguments: {
        summaryText,
        dryRun: true,
        source: 'summary-file-test',
        roleName: '夏以昼',
        userName: '芷鹤'
      }
    }
  };

  console.log(`MCP_URL = ${MCP_URL}`);
  console.log(`SUMMARY_FILE = ${SUMMARY_FILE}`);
  console.log(`字符数 = ${summaryText.length}`);
  console.log('开始 dryRun ingest_summary。不会写入 SQLite。');

  const response = await fetch(MCP_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  const text = await response.text();

  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    console.log('返回不是 JSON：');
    console.log(text);
    throw error;
  }

  if (!response.ok || data.error) {
    console.log(JSON.stringify(data, null, 2));
    throw new Error('MCP 请求失败');
  }

  const result = data.result || {};
  const structured = result.structuredContent || {};
  const items = structured.extractedItems || [];

  console.log('\n============================================================');
  console.log('提取结果');
  console.log('------------------------------------------------------------');
  console.log(`提取条数：${items.length}`);

  if (items.length === 0) {
    console.log('[]');
    return;
  }

  items.forEach((item, index) => {
    console.log(`${index + 1}. [${item.category}] ${item.content}`);
    console.log(`   tags: ${(item.tags || []).join(', ')}`);
    console.log(`   importance: ${item.importance}; emotionalWeight: ${item.emotionalWeight}`);
  });

  console.log('\n完整 text 返回：');
  console.log(result.content?.[0]?.text || '');
}

main().catch(error => {
  console.error('\nERROR:');
  console.error(error.message);
  process.exit(1);
});