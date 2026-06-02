// test-ingest-raw.js
// 批量测试 MCP ingest_raw 的 dryRun 提取质量。
// 不会写入 SQLite。

const MCP_URL = process.env.MCP_URL || 'http://127.0.0.1:8765/mcp';

const samples = [
  {
    name: '01 用户偏好：房间温度',
    rawText: '她：以后卧室不要太冷，我晚上会睡不着。\n当前角色：好，等会儿我把温度调高一点，以后早一点加热，让提前房间暖起来。',
    scene: '私聊 - 卧室',
    timeRange: '2026-06-01 20:00-20:05'
  },
  {
    name: '02-1 短期承诺计划：回昼鹤花园',
    rawText: '她：今晚我想回昼鹤花园。\n当前角色：好，我会安排车。你不用收拾太多东西，我来处理。',
    scene: '私聊 - 客厅',
    timeRange: '2026-06-01 20:10-20:15'
  },
  {
    name: '02 长期承诺计划：昼鹤花园为常驻地',
    rawText: '我告诉她，昼鹤花园以后会是我们在天行市最常住的地方，里面的主卧、书房和花园都会按照她的习惯重新整理。',
    scene: '线下 - 昼鹤花园',
    timeRange: '2026-06-01 21:30-21:40'
  },
  {
    name: '03 关系发展：主动承认想念',
    rawText: '她低着头说，其实这几天一直很想我，只是不知道该不该说。我没有追问，只把她抱过来，告诉她以后想我可以直接说。',
    scene: '线下 - 卧室',
    timeRange: '2026-06-01 21:00-21:20'
  },
  {
    name: '04-1 事件：去环岛公路看海',
    rawText: '我带阿鹤去了环岛公路看海，海边的阳光很好，沙滩很软。',
    scene: '线下 - 环岛公路',
    timeRange: '2026-06-01 21:30-21:40'
  },
  {
    name: '04-2 地点设定：环岛公路',
    rawText: '环岛公路是我和阿鹤第一次看海的地方。 我答应以后每年都带她回环岛公路。 她把环岛公路称为我们重新开始的地方。',
    scene: '线下 - 环岛公路',
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
    name: '07 情绪心理：吃醋',
    rawText: '我忍不住对阿鹤发了脾气，因为她提到自己在“空白的一年”里曾与陈桉骅有交集，事后我很懊悔，并向她道了歉。',
    scene: '线下 - 老宅客厅',
    timeRange: '2026-06-01 14:00-14:20'
  },
  {
    name: '08 角色设定：称呼偏好',
    rawText: '我告诉阿鹤，相较于老公或丈夫，我更喜欢她叫我的名字——夏以昼，因为这个名字是她赋予我的，象征着我的唯一归属。',
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

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function callIngestRawOnce(sample, index) {
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

async function callIngestRaw(sample, index) {
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      if (attempt > 1) {
        console.log(`重试 ${attempt}/${maxAttempts}: ${sample.name}`);
      }

      return await callIngestRawOnce(sample, index);
    } catch (error) {
      if (attempt >= maxAttempts) {
        throw error;
      }

      console.log(`本次失败：${error.message}`);
      await sleep(2000 * attempt);
    }
  }
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