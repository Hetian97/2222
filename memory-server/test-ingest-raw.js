// test-ingest-raw.js
// 批量测试 MCP ingest_raw 的 dryRun 提取质量。
// 不会写入 SQLite。

const MCP_URL = process.env.MCP_URL || 'http://127.0.0.1:8765/mcp';

const samples = [
  {
    name: '01 用户偏好：房间温度',
    rawText: '她：以后卧室不要太冷，我晚上会睡不着。\n当前角色：好，我会把温度调高一点，也会提前让房间暖起来。',
    scene: '私聊 - 卧室',
    timeRange: '2026-06-01 20:00-20:05'
  },
  {
    name: '02 承诺计划：回昼鹤花园',
    rawText: '她：今晚我想回昼鹤花园。\n当前角色：好，我会安排车。你不用收拾太多东西，我来处理。',
    scene: '私聊 - 客厅',
    timeRange: '2026-06-01 20:10-20:15'
  },
  {
    name: '03 关系发展：主动承认想念',
    rawText: '她低着头说，其实这几天一直很想我，只是不知道该不该说。我没有追问，只把她抱过来，告诉她以后想我可以直接说。',
    scene: '线下 - 卧室',
    timeRange: '2026-06-01 21:00-21:20'
  },
  {
    name: '04 地点设定：昼鹤花园',
    rawText: '我告诉她，昼鹤花园以后会是我们在天行市最常住的地方，里面的主卧、书房和花园都会按照她的习惯重新整理。',
    scene: '线下 - 昼鹤花园',
    timeRange: '2026-06-01 21:30-21:40'
  },
  {
    name: '05 禁忌规则：不在外人面前提',
    rawText: '她认真说，不希望我在外人面前提她之前崩溃过的事情。我答应她，以后这件事只会在我们两个人之间说。',
    scene: '私聊 - 书房',
    timeRange: '2026-06-01 22:00-22:10'
  },
  {
    name: '06 物品礼物：围巾',
    rawText: '我把那条红色围巾给她围上。她摸了很久，说这个颜色很像我之前说过的那种冬天。',
    scene: '线下 - 玄关',
    timeRange: '2026-06-01 22:20-22:30'
  },
  {
    name: '07 情绪心理：害怕陌生人',
    rawText: '裁缝进门后，她明显往我身后躲了一下，手指一直抓着我的袖口。我让林曳带人先在客厅等着，自己带她回主卧换衣服。',
    scene: '线下 - 老宅客厅与主卧',
    timeRange: '2026-06-01 14:00-14:20'
  },
  {
    name: '08 角色设定：限制他人接触私人物品',
    rawText: '我决定以后不再让林曳或其他人直接接触她的贴身衣物和私人物品。需要处理时，我会亲自确认。',
    scene: '线下 - 主卧',
    timeRange: '2026-06-01 14:30-14:35'
  },
  {
    name: '09 多人场景：林曳送文件',
    rawText: '林曳把文件送到书房，确认我已经签完后就离开了。她只在门口看了一眼，没有参与我们的谈话。',
    scene: '线下 - 书房',
    timeRange: '2026-06-01 15:00-15:10'
  },
  {
    name: '10 无意义日常：应该少提取或不提取',
    rawText: '她：吃了吗？\n当前角色：吃了。\n她：哦。\n当前角色：嗯。',
    scene: '私聊',
    timeRange: '2026-06-01 16:00-16:02'
  }
];

async function callIngestRaw(sample, index) {
  const body = {
    jsonrpc: '2.0',
    id: index + 1,
    method: 'tools/call',
    params: {
      name: 'ingest_raw',
      arguments: {
        rawText: sample.rawText,
        scene: sample.scene,
        timeRange: sample.timeRange,
        source: 'test',
        dryRun: true,
        roleName: '当前角色',
        userName: '她'
      }
    }
  };

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
    throw new Error(`返回不是 JSON：${text.slice(0, 500)}`);
  }

  if (!response.ok || data.error) {
    throw new Error(JSON.stringify(data.error || data, null, 2));
  }

  return data.result;
}

function printResult(sample, result) {
  const structured = result.structuredContent || {};
  const items = structured.extractedItems || [];

  console.log('\n============================================================');
  console.log(sample.name);
  console.log('------------------------------------------------------------');
  console.log('原文：');
  console.log(sample.rawText);
  console.log('------------------------------------------------------------');
  console.log(`提取条数：${items.length}`);

  if (items.length === 0) {
    console.log('提取结果：[]');
    return;
  }

  console.log('提取结果：');
  items.forEach((item, i) => {
    console.log(`${i + 1}. [${item.category}] ${item.content}`);
    console.log(`   tags: ${(item.tags || []).join(', ')}`);
    console.log(`   importance: ${item.importance}; emotionalWeight: ${item.emotionalWeight}`);
  });
}

async function main() {
  console.log(`MCP_URL = ${MCP_URL}`);
  console.log('开始批量 dryRun ingest_raw 测试。不会写入 SQLite。');

  for (let i = 0; i < samples.length; i += 1) {
    const sample = samples[i];

    try {
      const result = await callIngestRaw(sample, i);
      printResult(sample, result);
    } catch (error) {
      console.log('\n============================================================');
      console.log(sample.name);
      console.log('ERROR:');
      console.log(error.message);
    }
  }

  console.log('\n全部测试完成。');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});