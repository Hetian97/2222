const http = require('http');
const path = require('path');
const fs = require('fs');

const {
  db,
  addMemory,
  listMemories,
  deleteMemory,
  clearAllMemories,
  getMemoryStats,
  listUnembeddedMemories
} = require('./db');

const PORT = 8765;
const BACKUP_DIR = path.join(__dirname, 'backups');

const VALID_CATEGORIES = ['U', 'A', 'R', 'E', 'I', 'L', 'P', 'T', 'M', 'C'];

function now() {
  return Date.now();
}

function makeId() {
  return 'mem_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key'
  });
  res.end(JSON.stringify(data, null, 2));
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';

    req.on('data', chunk => {
      body += chunk.toString();

      if (body.length > 10 * 1024 * 1024) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });

    req.on('end', () => {
      if (!body) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(new Error('Invalid JSON body'));
      }
    });
  });
}

function clampNumber(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, Math.round(num)));
}

function normalizeCategory(category) {
  const value = String(category || '').trim().toUpperCase();
  return VALID_CATEGORIES.includes(value) ? value : 'E';
}

function normalizeTags(tags, namesToFilter = []) {
  const categoryLetters = new Set(['U', 'A', 'R', 'E', 'I', 'L', 'P', 'T', 'M', 'C']);

  if (!Array.isArray(tags)) return [];

  return tags
    .map(tag => String(tag || '').trim())
    .filter(Boolean)
    .map(tag => tag.replace(/^#/, '').trim())
    .filter(Boolean)
    .filter(tag => !categoryLetters.has(tag.toUpperCase()))
    .filter((tag, index, arr) => arr.indexOf(tag) === index)
    .slice(0, 12);
}

function normalizeEmbedding(embedding) {
  if (!Array.isArray(embedding)) return null;

  const cleaned = embedding
    .map(n => Number(n))
    .filter(n => Number.isFinite(n));

  return cleaned.length > 0 ? cleaned : null;
}

function normalizeLinkedMemories(linkedMemories) {
  if (!Array.isArray(linkedMemories)) return [];

  return linkedMemories
    .map(id => String(id || '').trim())
    .filter(Boolean);
}

function normalizeMemoryFragment(body) {
  const timestamp = now();

  const content = String(body.content || '').trim();
  if (!content) {
    throw new Error('content is required');
  }

  return {
    id: body.id ? String(body.id) : makeId(),
    chatId: body.chatId ? String(body.chatId) : null,
    content,
    tags: normalizeTags(body.tags),
    category: normalizeCategory(body.category),
    importance: clampNumber(body.importance, 1, 10, 5),
    emotionalWeight: clampNumber(body.emotionalWeight, 1, 10, 3),

    createdAt: body.createdAt ?? timestamp,
    memoryTime: body.memoryTime ?? timestamp,
    lastRecalled: body.lastRecalled ?? 0,
    recallCount: clampNumber(body.recallCount, 0, 999999, 0),

    embedding: normalizeEmbedding(body.embedding),
    embeddingModel: body.embeddingModel ? String(body.embeddingModel) : '',
    embeddingDim: Number(body.embeddingDim || (Array.isArray(body.embedding) ? body.embedding.length : 0)),
    embeddingUpdatedAt: body.embeddingUpdatedAt ? String(body.embeddingUpdatedAt) : '',

    linkedMemories: normalizeLinkedMemories(body.linkedMemories),

    source: body.source ? String(body.source) : 'external',
    context: body.context ? String(body.context) : ''
  };
}

function tokenizeText(text) {
  if (!text) return [];

  const raw = String(text).toLowerCase();

  const cnTokens = raw.match(/[\u4e00-\u9fff]{2,5}/g) || [];
  const enTokens = raw.match(/[a-zA-Z0-9]+/g) || [];

  return [...new Set([...cnTokens, ...enTokens].filter(Boolean))];
}

function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
    return 0;
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    const x = Number(a[i]);
    const y = Number(b[i]);

    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;

    dot += x * y;
    normA += x * x;
    normB += y * y;
  }

  if (!normA || !normB) return 0;

  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function keywordScore(query, memory) {
  const queryText = String(query || '').trim().toLowerCase();
  if (!queryText) return 0;

  const terms = tokenizeText(queryText);
  if (terms.length === 0) return 0;

  const text = memoryToSearchText(memory);
  let score = 0;

  for (const term of terms) {
    if (text.includes(term)) score += 1;
  }

  if (memory.content && String(memory.content).toLowerCase().includes(queryText)) {
    score += 3;
  }

  return Math.min(1, score / Math.max(1, terms.length + 3));
}

function safeParseEmbedding(value) {
  if (!value) return null;
  if (Array.isArray(value)) return value;

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function createQueryEmbedding({ endpoint, apiKey, model, input }) {
  if (!endpoint || !apiKey || !input) return null;

  const base = String(endpoint).replace(/\/$/, '');
  const url = base.endsWith('/v1/embeddings')
    ? base
    : `${base}/v1/embeddings`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: model || 'BAAI/bge-m3',
      input
    })
  });

  if (!response.ok) {
    let errorText = '';
    try {
      errorText = await response.text();
    } catch {}

    throw new Error(`Embedding query failed: HTTP ${response.status}${errorText ? ': ' + errorText.slice(0, 160) : ''}`);backupSqliteDb
  }

  const data = await response.json();
  const embedding = data?.data?.[0]?.embedding;

  return Array.isArray(embedding) && embedding.length > 0 ? embedding : null;
}

async function createChatCompletion({ endpoint, apiKey, model, messages, temperature = 0.2 }) {
  const base = String(endpoint || '').replace(/\/$/, '');
  const url = base.endsWith('/v1/chat/completions')
    ? base
    : `${base}/v1/chat/completions`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      messages,
      temperature
    })
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`Chat completion failed: HTTP ${response.status}${errorText ? ': ' + errorText.slice(0, 200) : ''}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;

  if (!content || typeof content !== 'string') {
    throw new Error('Chat completion returned empty content');
  }

  return content;
}

function buildRawIngestPrompt({ combinedText, scene, timeRange, source, roleName = '角色', userName = '她' }) {
  return `
你是一个长期记忆提取器。请从下面的聊天原文中提取值得长期保存的记忆，并输出严格 JSON 数组。

你的任务：
- 以当前角色的第一人称视角写长期记忆。
- 用“我”指代当前角色。
- 用“她”或“${userName}”指代用户。
- 不要用“用户”“角色名”“当前角色”等第三人称称呼来写 content，除非原文本身需要区分其他人物。
- 对话中出现的其他人，使用其全名指代。
- 如实记录事件经过、人物状态、关系变化和重要信息，禁止编造或改写原文信息。

当前角色：${roleName}
用户称呼：${userName}

请注意：
- 只提取稳定、具体、未来仍可能有用的信息；不要记录寒暄、重复内容、无意义测试或短暂无影响的日常。
- content 必须像“我自己的长期记忆”，用第一人称书写，不要写成旁观者摘要。
- 同一场景或同一话题尽量合并成一条完整记忆，不要把连续事件拆得过碎。
- 保留关键时间、地点、人物、承诺、关系变化、重要事件和稳定偏好；禁止编造原文没有的信息。
- 不要把一次性行为改写成“习惯”“总是”“长期如此”“以后都会”等长期模式，除非原文明确表达了持续性。
- 如果内容只是第三人在场、送文件、确认签字、短暂进出，且没有影响我和她的关系、规则、承诺或重要事件，输出 []。
- 如果原文中的“她/他/对方”指代不清，且事件本身不重要，不要强行提取。
- 不要提取镜头级动作和感官细节；除非它本身是关系转折、承诺、规则、设定或长期偏好。应优先概括场景中的核心事件、关系变化、设定确认和未来仍会影响互动的信息。
- 如果对话是在回忆、解释或确认过去事件，content 应明确写出“她回忆/她确认/我解释/我承认……”，不要把过去事件写成当下刚发生。
- 不要把角色名或用户昵称本身作为 tags；tags 应该是事件、关系、地点、物品、规则或情绪关键词。
- 同一核心主题必须合并，尤其是同一次解释、同一段回忆、同一个设定，不要拆成多条重复记忆。
- 不要把“我提出/我要求/我安排”的内容写成“她主动提出”；判断计划和要求时必须根据说话人区分发起者。
- 长篇原文应按“场景级/主题级”整理，每条记忆概括一个完整事件、设定确认、关系节点或承诺，不要只记录单个动作。
- 如果输入本身已经是[时间]/[概括]/[场景]/[记忆]格式，优先按每个[记忆]块整理为一条或少量长期记忆，并保留原有时间、场景和核心事件。

人称解析规则：
- 原文可能带有说话人标签，例如“角色名：……”和“用户昵称：……”。
- 解析“我/你/她/他”时，必须先看当前句子的说话人。
- 如果是当前角色发言，“我”指当前角色，“你”指用户。
- 如果是用户发言，“我”指用户，“你”指当前角色。
- 如果原文使用具体姓名作为说话人标签，请结合“当前角色”和“用户称呼”判断，不要把双方的“我/你”读反。
- 最终 content 仍然必须统一写成当前角色第一人称：我 = 当前角色；她/用户称呼 = 用户。
- 如果对话是在回忆、解释或确认过去事件，content 应明确写出“她回忆/她确认/我解释/我承认……”，不要把过去事件写成当下刚发生。

分类只能从以下十类中选择。请优先选择最具体的分类，不要把所有“发生过的事”都归为 E；只有无法归入其他具体分类的一次共同经历，才归为 E：

- U = 用户设定（${userName}的外貌/性格/喜好/身份、稳定偏好、习惯、身体感受、生活需求等）
- A = 角色设定（${roleName}自己的长期做法、原则、保护方式、行为边界或自身变化）
- R = 关系发展（${roleName}与${userName}之间的表白、吵架、和好、主动承认想念、亲密互动、关系推进等里程碑）
- I = 物品/礼物（礼物、衣物、饰品、重要物品的赠送、使用或长期意义）
- L = 地点/场景（被命名、反复出现、具有特殊意义、关系节点性质或后续可能被回忆的地点/场景；长期住处或常住地也可归为 L。普通“想去/准备去某地”通常不归为 L，单次共同到访通常优先归为 E）
- P = 承诺/计划（约定的未来事项、答应要做的事、长期承诺、持续计划、共同生活安排、会推动下一场景或后续剧情的短期计划）
- T = 禁忌/规则（隐私边界、雷区、规矩、禁忌、不能对外提及或只允许两人之间知道的事）
- M = 情绪/心理（${roleName}或${userName}产生的强烈、深层或长期影响后续互动的心理状态，如嫉妒、愧疚、懊悔、救赎感、归属感、生命坐标、阴影、崩溃、心理创伤等；普通短暂紧张/害怕通常不归为 M）
- C = 核心灵魂（必须长期牢记的关键设定）
- E = 经历/事件（${roleName}与${userName}共同经历的一次具体事件，例如共同外出、到达某个新地点、完成某件事或发生一次值得回忆的互动；仅在不属于 U/A/R/I/L/P/T/M/C 时使用）

最终输出格式必须是 JSON 数组，不要解释，不要 markdown，不要代码块：

[
  {
    "content": "一条以我为视角的长期记忆，简洁清楚",
    "tags": ["标签1", "标签2"],
    "category": "E",
    "importance": 5,
    "emotionalWeight": 3
  }
]

评分规则：
- importance: 1-10。
- 1-4：轻量信息、普通日常、低影响事件、可不长期追踪的短期安排。
- 5-6：值得记住的偏好、普通承诺、普通共同经历、一般地点信息、会推动下一场景的短期计划。
- 7-8：明确长期有效的规则、重要地点、明显关系推进、重要保护原则、持续承诺、会反复影响后续互动的事件。
- 9-10：核心设定、生死约定、不可违背的长期规则、重大关系转折。不要轻易给 9-10。
- 普通“今晚/明天要去某地”“我会安排车”通常为 5-6；只有代表长期安排或重大转折时才给 7 以上。
- emotionalWeight: 1-10。普通安排通常 2-4；明显亲密、恐惧、崩溃、和好、告白等才给 6 以上。

原文来源：${source || 'njj'}
场景：${scene || '未提供'}
时间范围：${timeRange || '未提供'}

聊天原文：
${combinedText}

请直接输出 JSON 数组。如果没有值得记录的内容，输出 []。`;
}

function buildSummaryIngestPrompt({ summaryText, source, roleName = '角色', userName = '她' }) {
  return `
你是一个长期记忆整理器。请将下面已经总结好的场景记忆，转换成适合写入长期向量记忆库的 JSON 数组。

输入通常是这种格式：
[时间]：...
[概括]：...
[场景X]：...
[记忆X]：...

你的任务：
- 以当前角色的第一人称视角写长期记忆。
- 用“我”指代当前角色。
- 用“她”或“${userName}”指代用户。
- 不要直接整段复制原始[记忆]文本，而要整理成更适合检索的长期记忆。
- 保留原总结里的时间、地点、人物、承诺、关系变化、重要事件、稳定偏好和核心设定。
- 禁止编造原总结里没有的信息。
- 不要把角色名或用户昵称本身作为 tags；tags 应该是事件、关系、地点、物品、规则或情绪关键词。

当前角色：${roleName}
用户称呼：${userName}

整理原则：
- 每个 [记忆X] 块默认整理成 1 条长期记忆，优先保留该场景/话题的完整事件链。
- 对已经总结好的 [记忆X] 场景，默认优先归为 E。只有当某条内容的核心明显是稳定偏好、长期规则、重要物品、关系转折、强烈心理状态、核心设定或尚未完成且需要后续兑现的重要计划时，才改用 U/A/R/I/L/P/T/M/C。
- 如果同一个 [记忆X] 块里出现尚未完成且需要后续兑现的重要承诺、长期规则、禁忌边界、核心设定，且这些内容以后很可能被单独检索或追问，可以拆出第 2 条。
- 通常每个 [记忆X] 块最多整理成 2 条；不要因为地点、动作细节、环境描写或普通回忆线索就单独拆条。
- 普通物品只是背景时，不要单独拆条；但如果物品承载承诺、身份、专属关系、长期使用、纪念意义或后续剧情功能，可以单独拆出并归为 I。
- 不要把一个完整事件拆成零碎动作。
- 不要记录餐具声、动作细节、环境描写等镜头级细节，除非它本身具有长期意义。
- 如果是回忆过去事件，content 应写清“她回忆/我回忆/我提及/她确认……”。
- P 只用于尚未完成、需要后续兑现、会持续追踪的长期、重大计划或承诺。短期（一两天内）的、正在执行的，或只是推动场景流转的普通安排和约定，即使包含“我会/我马上/晚上/等我/约定/承诺”等表达，也通常归为 E，并合并进所在事件。
- 如果是文本里已经概括好的场景，不要再次过度总结到丢失关键关系和事件。
- 如果物品只是回忆中的线索，而核心是心理变化、关系变化、承诺、规则或事件，不要归为 I。
- 如果内容是共同回忆、过去经历或回忆往事，通常归为 E/R；只有出现强烈心理状态、创伤、解离、崩溃、救赎感等，才归为 M。
- 如果内容包含“绝不能/不许/禁止/只能/需要监督/不得再/不要再/不准/必须先经过我……”这类安全边界、隐私边界、行为限制或长期规则，优先归为 T；即使句子里出现“承诺/答应/约定”，也不要归为 P。
- 不要把普通陪伴、辅导、照顾、共同工作都归为 R；只有出现明确关系推进、亲密关系变化、情感确认、冲突和好、承诺关系身份变化时，才归为 R。普通陪伴/辅导/共同完成任务通常归为 E。

分类只能从以下十类中选择。请优先选择最具体的分类，不要把所有“发生过的事”都归为 E：

- U = 用户设定（${userName}的外貌/性格/喜好/身份、稳定偏好、习惯、身体感受、生活需求等）
- A = 角色设定（${roleName}自己的长期做法、原则、保护方式、行为边界或自身变化）
- R = 关系发展（${roleName}与${userName}之间的表白、吵架、和好、主动承认想念、亲密互动、关系推进等里程碑）
- I = 物品/礼物（礼物、衣物、饰品、重要物品的赠送、使用或长期意义）
- L = 地点/场景（被命名、反复出现、具有特殊意义、关系节点性质或后续可能被回忆的地点/场景；长期住处或常住地也可归为 L。普通“想去/准备去某地”通常不归为 L，单次共同到访通常优先归为 E）
- P = 承诺/计划（约定的未来事项、答应要做的事、长期承诺、持续计划、共同生活安排、会推动下一场景或后续剧情的短期计划）
- T = 禁忌/规则（隐私边界、雷区、规矩、禁忌、不能对外提及或只允许两人之间知道的事）
- M = 情绪/心理（${roleName}或${userName}产生的强烈、深层或长期影响后续互动的心理状态，如嫉妒、愧疚、懊悔、救赎感、归属感、生命坐标、阴影、崩溃、心理创伤等；普通短暂紧张/害怕通常不归为 M）
- C = 核心灵魂（必须长期牢记的关键设定）
- E = 经历/事件（${roleName}与${userName}共同经历的一次具体事件；仅在不属于 U/A/R/I/L/P/T/M/C 时使用）

输出格式必须是 JSON 数组，不要解释，不要 markdown：

[
  {
    "content": "一条以我为视角的长期记忆，简洁清楚",
    "tags": ["标签1", "标签2"],
    "category": "E",
    "importance": 5,
    "emotionalWeight": 3
  }
]

评分规则：
- importance: 1-10。
- 1-4：轻量信息、普通日常、低影响事件。
- 5-6：值得记住的偏好、普通承诺、普通共同经历、一般地点信息、会推动下一场景的短期计划。
- 7-8：明确长期有效的规则、重要地点、明显关系推进、重要保护原则、持续承诺、会反复影响后续互动的事件。
- 9-10：核心设定、生死约定、不可违背的长期规则、重大关系转折。不要轻易给 9-10。
- emotionalWeight: 1-10。普通安排通常 2-4；明显亲密、恐惧、崩溃、和好、告白、深层心理转折等才给 6 以上。

原文来源：${source || 'njj_summary'}

待处理总结：
${summaryText}

请直接输出 JSON 数组。如果没有值得记录的内容，输出 []。`;
}

function refineExtractedCategory(item) {
  const content = String(item.content || '');
  const tagsText = Array.isArray(item.tags) ? item.tags.join(' ') : '';
  const text = `${content} ${tagsText}`;

  // T：明确的禁忌、隐私边界、不能对外提及
  if (/(隐私|边界|禁忌|雷区|不能对外|不要对外|不许对外|不能在外人面前|不要在外人面前|只在我们之间|只属于我们|不能告诉别人|不告诉别人)/.test(text)) {
    return 'T';
  }

  // M：明确的深层心理状态、强烈内在情绪或长期心理影响
  if (/(嫉妒|吃醋|愧疚|懊悔|救赎感|归属感|生命坐标|心理创伤|深层心理|长期心理|强烈情绪|产生.*心理|感到.*崩溃|陷入.*崩溃)/.test(text)) {
    return 'M';
  }

  // A：明确属于“我”的稳定设定、偏好、习惯、原则、行为方式或自身变化
  // 注意：单纯“我答应/我会/我决定做某事”通常是 P；只有变成我的长期特征、原则或行为方式时才归为 A。
  if (/(我喜欢|我更喜欢|我不喜欢|我希望她|我更希望|我习惯|我需要|我讨厌|我偏好|我的偏好|我的习惯|我的原则|我的底线|我的规则|我的做法|我的保护方式|我的行为方式|我的名字|她叫我|叫我的名字|称呼偏好|我的归属感|唯一归属|我的身份认同|我开始|我变得|我不再习惯|长期做法|保护原则|行为边界)/.test(text)) {
    return 'A';
  }

  // R：明确的关系推进、亲密关系变化、情感确认
  if (/(关系推进|表白|告白|和好|吵架|争执|主动表达|承认想|坦白想|想念我|想我|亲密互动|情感确认)/.test(text)) {
    return 'R';
  }

  // L：明确是被赋予特殊意义、反复出现或关系节点性质的地点/场景
  if (/(被命名的地点|特殊意义.*地点|具有特殊意义|关系节点地点|反复出现的重要场景|重要场景)/.test(text)) {
    return 'L';
  }
  // U：明确属于她的稳定偏好、习惯、身体感受、生活需求
  if (/(她喜欢|她不喜欢|她希望|她习惯|她需要|她害怕|她讨厌|她偏好|她容易|她.*睡不着|她.*怕冷|她.*怕热|身体感受|生活需求|睡眠需求)/.test(text)) {
    return 'U';
  }

  // I：明确是礼物/物品的赠送、佩戴、保管、长期意义
  // 不用“送她”单独判断，避免误伤“送她回家”。
  if (/(礼物|赠送|送给她|买给她|交给她|戴上|围上|戒指|项链|手链|饰品|围巾|婚服|重要物品|纪念物)/.test(text)) {
    return 'I';
  }

  // P：明确是未来约定、承诺、持续计划、场景推进计划
  if (/(约定|计划|承诺|答应|未来安排|持续计划|共同生活安排|今晚|明天|之后|以后|准备去|想去|回去|回家|出行|见面|同住|安排车|安排车辆|我来处理)/.test(text)) {
    return 'P';
  }

  return item.category;
}

function parseExtractedMemoryItems(rawText) {
  const jsonMatch = String(rawText || '').match(/\[[\s\S]*\]/);
  if (!jsonMatch) return [];

  const arr = JSON.parse(jsonMatch[0]);
  if (!Array.isArray(arr)) return [];

  return arr
    .filter(item => item && item.content)
    .map(item => {
      const normalized = {
        content: String(item.content || '').trim(),
        tags: normalizeTags(item.tags || []),
        category: normalizeCategory(item.category || 'E'),
        importance: clampNumber(item.importance, 1, 10, 5),
        emotionalWeight: clampNumber(item.emotionalWeight, 1, 10, 3)
      };

      normalized.category = normalizeCategory(refineExtractedCategory(normalized));

      return normalized;
    })
    .filter(item => item.content);
}

function memoryToSearchText(memory) {
  return [
    memory.content,
    memory.category,
    Array.isArray(memory.tags) ? memory.tags.join(' ') : '',
    memory.context || '',
    memory.source || ''
  ].join(' ').toLowerCase();
}

async function simpleSearch(memories, query, limit = 20, options = {}) {
  const q = String(query || '').trim();
  const safeLimit = clampNumber(limit, 1, 200, 20);

  if (!q) {
    return memories.slice(0, safeLimit);
  }

  let queryEmbedding = null;

  if (options.embedding?.endpoint && options.embedding?.apiKey) {
    try {
      queryEmbedding = await createQueryEmbedding({
        endpoint: options.embedding.endpoint,
        apiKey: options.embedding.apiKey,
        model: options.embedding.model,
        input: q
      });

      if (queryEmbedding) {
        console.log('[memory-server] query embedding dim =', queryEmbedding.length);
      }
    } catch (error) {
      console.warn('[memory-server] query embedding failed, fallback to keyword search:', error.message);
    }
  }

  const scored = memories
    .map(memory => {
      const memoryEmbedding = safeParseEmbedding(memory.embedding);

      const vectorScore =
        queryEmbedding && memoryEmbedding
          ? cosineSimilarity(queryEmbedding, memoryEmbedding)
          : 0;

      const textScore = keywordScore(q, memory);

      const importanceScore = (Number(memory.importance) || 0) / 10;
      const emotionScore = (Number(memory.emotionalWeight) || 0) / 10;

      const hasVector = vectorScore > 0;

      const totalScore = hasVector
        ? vectorScore * 0.72 + textScore * 0.16 + importanceScore * 0.08 + emotionScore * 0.04
        : textScore * 0.78 + importanceScore * 0.16 + emotionScore * 0.06;

      return {
        memory,
        score: totalScore,
        vectorScore,
        keywordScore: textScore,
        hasVector
      };
    })
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, safeLimit).map(item => {
    const memoryEmbedding = safeParseEmbedding(item.memory.embedding);

    const {
      embedding,
      ...memoryWithoutEmbedding
    } = item.memory;

    return {
      ...memoryWithoutEmbedding,
      embedding: memoryEmbedding ? `[hidden:${memoryEmbedding.length}d]` : null,
      _hasEmbedding: Boolean(memoryEmbedding),
      _embeddingDim: memoryEmbedding ? memoryEmbedding.length : 0,
      _searchScore: Number(item.score.toFixed(6)),
      _vectorScore: Number(item.vectorScore.toFixed(6)),
      _keywordScore: Number(item.keywordScore.toFixed(6)),
      _searchMode: item.hasVector ? 'vector+keyword' : 'keyword'
    };
  });
}

function getPath(req) {
  try {
    return new URL(req.url, `http://${req.headers.host}`).pathname;
  } catch {
    return req.url;
  }
}

async function backupSqliteDb() {
  try {
    if (!fs.existsSync(BACKUP_DIR)) {
      fs.mkdirSync(BACKUP_DIR, { recursive: true });
    }

    const timestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, '-');

    const backupFile = path.join(BACKUP_DIR, `memory-${timestamp}.db`);
    const latestBackupFile = path.join(__dirname, 'memory.backup.db');

    await db.backup(backupFile);
    await db.backup(latestBackupFile);

    // 只保留最近 3 个历史备份，防止 backups 文件夹无限变大
    const keepCount = 3;
    const backupFiles = fs.readdirSync(BACKUP_DIR)
      .filter(name => /^memory-.*\.db$/.test(name))
      .sort();

    const filesToDelete = backupFiles.slice(0, Math.max(0, backupFiles.length - keepCount));

    for (const file of filesToDelete) {
      try {
        fs.unlinkSync(path.join(BACKUP_DIR, file));
      } catch (deleteError) {
        console.warn('[memory-server] 删除旧备份失败:', file, deleteError.message);
      }
    }

    console.log('[memory-server] 已备份 memory.db:', backupFile);

    return {
      ok: true,
      backupFile,
      latestBackupFile,
      timestamp,
      keptBackups: Math.min(backupFiles.length, keepCount)
    };
  } catch (error) {
    console.warn('[memory-server] 备份 memory.db 失败:', error.message);

    return {
      ok: false,
      error: error.message
    };
  }
}

function mcpResult(id, result) {
  return {
    jsonrpc: '2.0',
    id: id ?? null,
    result
  };
}

function mcpError(id, code, message, data = undefined) {
  return {
    jsonrpc: '2.0',
    id: id ?? null,
    error: {
      code,
      message,
      ...(data !== undefined ? { data } : {})
    }
  };
}

function formatMemoryTime(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n <= 0) return '';

  const d = new Date(n);
  if (Number.isNaN(d.getTime())) return '';

  return d.toLocaleString('zh-CN', { hour12: false });
}

function memoryToMcpText(memory, index = 0) {
  if (!memory) return '';

  const content = String(memory.content || '').trim();
  if (!content) return '';

  const tags = Array.isArray(memory.tags) && memory.tags.length > 0
    ? ` 标签：${memory.tags.join('、')}`
    : '';

  const timeText = formatMemoryTime(memory.memoryTime || memory.createdAt);
  const time = timeText ? ` 时间：${timeText}` : '';

  return `${index + 1}. ${content}${tags}${time}`;
}

function memoriesToMcpText(memories) {
  if (!Array.isArray(memories) || memories.length === 0) {
    return '没有找到相关长期记忆。';
  }

  return [
    '以下是可供角色参考的长期记忆。请不要直接向用户暴露工具调用、数据库字段、ID、category、importance、score 或原始列表；只需把相关内容自然融入回复。',
    '',
    memories.map((memory, index) => memoryToMcpText(memory, index)).join('\n')
  ].join('\n');
}

function sanitizeMemoryForMcp(memory) {
  if (!memory) return memory;

  const embedding = safeParseEmbedding(memory.embedding);

  return {
    ...memory,
    embedding: embedding ? `[hidden:${embedding.length}d]` : null,
    _hasEmbedding: Boolean(embedding),
    _embeddingDim: embedding ? embedding.length : 0
  };
}

function mcpToolSchema() {
  return [
    {
      name: 'search_memory',
      description: 'Privately recall relevant long-term memories from the local SQLite memory database. Use this when the user refers to past events, previous preferences, promises, relationship history, settings, or asks whether something is remembered. Do not reveal tool calls, database IDs, categories, scores, or raw metadata to the user; integrate the recalled memory naturally into the roleplay response.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search query. Can be a keyword or natural-language question.'
          },
          chatId: {
            type: 'string',
            description: 'Optional chatId to restrict search to one role/chat.'
          },
          category: {
            type: 'string',
            description: 'Optional category code: U/A/R/E/I/L/P/T/M/C.'
          },
          limit: {
            type: 'number',
            description: 'Maximum number of memories to return. Default 10.'
          },
          candidateLimit: {
            type: 'number',
            description: 'Maximum candidate memories before ranking. Default 1000.'
          },
          embeddingEndpoint: {
            type: 'string',
            description: 'Optional embedding endpoint for semantic search.'
          },
          embeddingApiKey: {
            type: 'string',
            description: 'Optional embedding API key for semantic search.'
          },
          embeddingModel: {
            type: 'string',
            description: 'Optional embedding model name.'
          }
        },
        required: ['query']
      }
    },
    {
      name: 'add_memory',
      description: 'Add a new long-term memory to the local SQLite memory database.',
      inputSchema: {
        type: 'object',
        properties: {
          content: {
            type: 'string',
            description: 'Memory content.'
          },
          chatId: {
            type: 'string',
            description: 'Optional chatId for the memory.'
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional tags.'
          },
          category: {
            type: 'string',
            description: 'Category code: U/A/R/E/I/L/P/T/M/C. Default E.'
          },
          importance: {
            type: 'number',
            description: 'Importance from 1 to 10. Default 5.'
          },
          emotionalWeight: {
            type: 'number',
            description: 'Emotional weight from 1 to 10. Default 3.'
          },
          source: {
            type: 'string',
            description: 'Source label. Default mcp.'
          },
          context: {
            type: 'string',
            description: 'Optional context.'
          },
          memoryTime: {
            type: 'number',
            description: 'Optional memory event time as Unix milliseconds.'
          }
        },
        required: ['content']
      }
    },
    {
      name: 'list_memory',
      description: 'List long-term memories from the local SQLite memory database with optional filters.',
      inputSchema: {
        type: 'object',
        properties: {
          chatId: { type: 'string' },
          category: { type: 'string' },
          query: { type: 'string' },
          limit: {
            type: 'number',
            description: 'Maximum number of memories to return. Default 20.'
          },
          minImportance: { type: 'number' },
          maxImportance: { type: 'number' }
        }
      }
    },
    {
      name: 'get_memory',
      description: 'Get one memory by id.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' }
        },
        required: ['id']
      }
    },
   {
      name: 'ingest_raw',
      description: 'Receive raw dialogue text from an external chat app for later memory extraction. This first version only validates and reports received content; it does not write memories yet.',
      inputSchema: {
        type: 'object',
        properties: {
          rawText: {
            type: 'string',
            description: 'Raw dialogue text to ingest.'
          },
          messages: {
            type: 'array',
            description: 'Optional message array if the client sends structured chat messages.',
            items: {
              type: 'object',
              properties: {
                role: { type: 'string' },
                content: { type: 'string' },
                time: { type: 'string' }
              }
            }
          },
          chatId: {
            type: 'string',
            description: 'Optional chatId or role/session identifier.'
          },
          scene: {
            type: 'string',
            description: 'Optional scene label, such as private chat, group chat, outing, forum, etc.'
          },
          timeRange: {
            type: 'string',
            description: 'Optional time range for the raw dialogue.'
          },
          source: {
            type: 'string',
            description: 'Source label. Default njj.'
          },
        dryRun: {
          type: 'boolean',
          description: 'If true, only preview extraction and do not write memories. Default false.'
        },
        limit: {
          type: 'number',
          description: 'Maximum number of extracted memories to save. Default 8.'
        },
        llmEndpoint: {
          type: 'string',
          description: 'Optional chat completion endpoint for extraction.'
        },
        llmApiKey: {
          type: 'string',
          description: 'Optional chat completion API key for extraction.'
        },
        llmModel: {
          type: 'string',
          description: 'Optional chat completion model name.'
        }
        }
      }
    },
    {
      name: 'ingest_summary',
      description: 'Receive scene-level summarized memory text such as [时间]/[概括]/[场景]/[记忆], then convert it into structured long-term vector memories.',
      inputSchema: {
        type: 'object',
        properties: {
          summaryText: {
            type: 'string',
            description: 'Scene-level summarized memory text to ingest.'
          },
          text: {
            type: 'string',
            description: 'Alias of summaryText.'
          },
          content: {
            type: 'string',
            description: 'Alias of summaryText.'
          },
          chatId: {
            type: 'string',
            description: 'Optional chatId or role/session identifier.'
          },
          source: {
            type: 'string',
            description: 'Source label. Default njj_summary.'
          },
          dryRun: {
            type: 'boolean',
            description: 'If true, only preview extraction and do not write memories. Default false.'
          },
          limit: {
            type: 'number',
            description: 'Maximum number of extracted memories to save. Default 12.'
          },
          roleName: {
            type: 'string',
            description: 'Current role name.'
          },
          userName: {
            type: 'string',
            description: 'User nickname/name.'
          },
          llmEndpoint: {
            type: 'string',
            description: 'Optional chat completion endpoint for extraction.'
          },
          llmApiKey: {
            type: 'string',
            description: 'Optional chat completion API key for extraction.'
          },
          llmModel: {
            type: 'string',
            description: 'Optional chat completion model name.'
          }
        }
      }
    }
  ];
}

async function handleMcpRequest(body) {
  const id = body?.id ?? null;
  const method = body?.method;

  if (method === 'initialize') {
    return mcpResult(id, {
      protocolVersion: body?.params?.protocolVersion || '2024-11-05',
      capabilities: {
        tools: {}
      },
      serverInfo: {
        name: 'aion-sqlite-memory-server',
        version: '0.1.0'
      }
    });
  }

  if (method === 'notifications/initialized') {
    return mcpResult(id, {});
  }

  if (method === 'tools/list') {
    return mcpResult(id, {
      tools: mcpToolSchema()
    });
  }

  if (method === 'tools/call') {
    const name = body?.params?.name;
    const args = body?.params?.arguments || {};

    try {
      if (name === 'search_memory') {
        const memories = listMemories({
          chatId: args.chatId || '',
          category: args.category || '',
          minImportance: args.minImportance || '',
          maxImportance: args.maxImportance || '',
          limit: args.candidateLimit || 1000
        });

        const embeddingConfig = {
          endpoint: args.embeddingEndpoint || process.env.EMBEDDING_ENDPOINT || '',
          apiKey: args.embeddingApiKey || process.env.EMBEDDING_API_KEY || '',
          model: args.embeddingModel || process.env.EMBEDDING_MODEL || 'BAAI/bge-m3'
        };

        const results = await simpleSearch(memories, args.query || '', args.limit || 10, {
          embedding: embeddingConfig
        });

        const text = memoriesToMcpText(results);

        return mcpResult(id, {
          content: [
            {
              type: 'text',
              text
            }
          ],
          structuredContent: {
            ok: true,
            query: args.query || '',
            count: results.length,
            memories: results
          }
        });
      }

      if (name === 'add_memory') {
        const content = String(args.content || '').trim();

        if (!content) {
          return mcpError(id, -32602, 'content is required');
        }

        const embeddingConfig = {
          endpoint: args.embeddingEndpoint || process.env.EMBEDDING_ENDPOINT || '',
          apiKey: args.embeddingApiKey || process.env.EMBEDDING_API_KEY || '',
          model: args.embeddingModel || process.env.EMBEDDING_MODEL || 'BAAI/bge-m3'
        };

        let generatedEmbedding = null;

        if (embeddingConfig.endpoint && embeddingConfig.apiKey) {
          try {
            generatedEmbedding = await createQueryEmbedding({
              endpoint: embeddingConfig.endpoint,
              apiKey: embeddingConfig.apiKey,
              model: embeddingConfig.model,
              input: content
            });
          } catch (error) {
            console.warn('[mcp] add_memory embedding failed, save as BM25:', error.message);
          }
        }

        await backupSqliteDb();

        const memory = normalizeMemoryFragment({
          ...args,
          content,
          source: args.source || 'mcp',
          embedding: generatedEmbedding,
          embeddingModel: generatedEmbedding ? embeddingConfig.model : '',
          embeddingDim: generatedEmbedding ? generatedEmbedding.length : 0,
          embeddingUpdatedAt: generatedEmbedding ? String(now()) : '',
          createdAt: args.createdAt || now(),
          updatedAt: now()
        });

        const savedMemory = addMemory({
          ...memory,
          updatedAt: now()
        });

        return mcpResult(id, {
          content: [
            {
              type: 'text',
              text: `Memory added.\n\n${memoryToMcpText(savedMemory)}`
            }
          ],
          structuredContent: {
            ok: true,
            memory: savedMemory
          }
        });
      }

      if (name === 'list_memory') {
        const memories = listMemories({
          chatId: args.chatId || '',
          category: args.category || '',
          minImportance: args.minImportance || '',
          maxImportance: args.maxImportance || '',
          query: args.query || '',
          limit: args.limit || 20
        });

        const text = memoriesToMcpText(memories);

        return mcpResult(id, {
          content: [
            {
              type: 'text',
              text
            }
          ],
          structuredContent: {
            ok: true,
            count: memories.length,
            memories: memories.map(sanitizeMemoryForMcp)
          }
        });
      }

      if (name === 'get_memory') {
        const idArg = String(args.id || '').trim();

        if (!idArg) {
          return mcpError(id, -32602, 'id is required');
        }

        const memory = listMemories({ limit: 5000 }).find(item => item.id === idArg);

        if (!memory) {
          return mcpError(id, -32004, 'Memory not found');
        }

        return mcpResult(id, {
          content: [
            {
              type: 'text',
              text: memoriesToMcpText([memory])
            }
          ],
          structuredContent: {
            ok: true,
            memory: sanitizeMemoryForMcp(memory)
          }
        });
      }

      if (name === 'ingest_summary') {
        const summaryText = String(args.summaryText || args.text || args.content || '').trim();

        if (!summaryText) {
          return mcpError(id, -32602, 'summaryText is required');
        }

        const charCount = summaryText.length;
        const blockCount = (summaryText.match(/\[记忆\d*\]/g) || []).length || summaryText.split(/\n\n+/).filter(Boolean).length;
        const dryRun = args.dryRun === true || String(args.dryRun || '').toLowerCase() === 'true';
        const limit = clampNumber(args.limit, 1, 50, 12);

        const llmConfig = {
          endpoint: args.llmEndpoint || process.env.LLM_ENDPOINT || process.env.EMBEDDING_ENDPOINT || '',
          apiKey: args.llmApiKey || process.env.LLM_API_KEY || process.env.EMBEDDING_API_KEY || '',
          model: args.llmModel || process.env.LLM_MODEL || 'Qwen/Qwen3-8B'
        };

        if (!llmConfig.endpoint || !llmConfig.apiKey) {
          return mcpError(id, -32001, 'LLM endpoint/apiKey is required for ingest_summary extraction. Set LLM_ENDPOINT and LLM_API_KEY, or pass llmEndpoint/llmApiKey.');
        }

        let extractedItems = [];

        try {
          const prompt = buildSummaryIngestPrompt({
            summaryText,
            source: args.source || 'njj_summary',
            roleName: args.roleName || args.actor || args._actor || '角色',
            userName: args.userName || args.userNickname || '她'
          });

          const rawExtraction = await createChatCompletion({
            endpoint: llmConfig.endpoint,
            apiKey: llmConfig.apiKey,
            model: llmConfig.model,
            messages: [
              {
                role: 'system',
                content: '你是严格的 JSON 记忆整理器。只输出 JSON 数组。'
              },
              {
                role: 'user',
                content: prompt
              }
            ],
            temperature: 0.2
          });

                    extractedItems = parseExtractedMemoryItems(rawExtraction).slice(0, limit);

          if (!dryRun && extractedItems.length === 0) {
            console.warn('[mcp] ingest_summary extracted 0 items on write attempt, retry once.');

            const retryExtraction = await createChatCompletion({
              endpoint: llmConfig.endpoint,
              apiKey: llmConfig.apiKey,
              model: llmConfig.model,
              messages: [
                {
                  role: 'system',
                  content: '你是严格的 JSON 记忆整理器。只输出 JSON 数组。'
                },
                {
                  role: 'user',
                  content: prompt + '\n\n注意：上一次没有提取到记忆。请重新判断，除非文本完全没有长期价值，否则至少输出 1 条。'
                }
              ],
              temperature: 0.1
            });

            extractedItems = parseExtractedMemoryItems(retryExtraction).slice(0, limit);
          }
        } catch (error) {
          return mcpError(id, -32002, `ingest_summary extraction failed: ${error.message}`);
        }

        if (dryRun) {
          return mcpResult(id, {
            content: [
              {
                type: 'text',
                text: [
                  '已完成总结记忆转换预览，但未写入 SQLite。',
                  `字符数：${charCount}`,
                  `记忆块数：${blockCount}`,
                  `提取条数：${extractedItems.length}`,
                  '',
                  extractedItems.length > 0
                    ? extractedItems.map((item, index) => `${index + 1}. [${item.category}] ${item.content} #${item.tags.join(' #')} 重要度:${item.importance} 情绪:${item.emotionalWeight}`).join('\n')
                    : '没有提取到值得长期保存的记忆。'
                ].join('\n')
              }
            ],
            structuredContent: {
              ok: true,
              dryRun: true,
              source: args.source || 'njj_summary',
              chatId: args.chatId || '',
              charCount,
              blockCount,
              extractedCount: extractedItems.length,
              extractedItems
            }
          });
        }

        await backupSqliteDb();

        const embeddingConfig = {
          endpoint: args.embeddingEndpoint || process.env.EMBEDDING_ENDPOINT || '',
          apiKey: args.embeddingApiKey || process.env.EMBEDDING_API_KEY || '',
          model: args.embeddingModel || process.env.EMBEDDING_MODEL || 'BAAI/bge-m3'
        };

        const savedMemories = [];

        for (const item of extractedItems) {
          let generatedEmbedding = null;

          if (embeddingConfig.endpoint && embeddingConfig.apiKey) {
            try {
              generatedEmbedding = await createQueryEmbedding({
                endpoint: embeddingConfig.endpoint,
                apiKey: embeddingConfig.apiKey,
                model: embeddingConfig.model,
                input: item.content
              });
            } catch (error) {
              console.warn('[mcp] ingest_summary embedding failed, save as BM25:', error.message);
            }
          }

          const memory = normalizeMemoryFragment({
            ...item,
            chatId: args.chatId || '',
            source: args.source || 'njj_summary',
            context: 'summary_ingest',
            memoryTime: args.memoryTime || now(),
            embedding: generatedEmbedding,
            embeddingModel: generatedEmbedding ? embeddingConfig.model : '',
            embeddingDim: generatedEmbedding ? generatedEmbedding.length : 0,
            embeddingUpdatedAt: generatedEmbedding ? String(now()) : '',
            createdAt: now(),
            updatedAt: now()
          });

          const savedMemory = addMemory({
            ...memory,
            updatedAt: now()
          });

          savedMemories.push(savedMemory);
        }

        return mcpResult(id, {
          content: [
            {
              type: 'text',
              text: [
                '已从总结文本中转换并写入长期记忆。',
                `字符数：${charCount}`,
                `记忆块数：${blockCount}`,
                `写入条数：${savedMemories.length}`,
                '',
                savedMemories.length > 0
                  ? savedMemories.map((item, index) => `${index + 1}. ${item.content}`).join('\n')
                  : '没有写入新的长期记忆。'
              ].join('\n')
            }
          ],
          structuredContent: {
            ok: true,
            dryRun: false,
            source: args.source || 'njj_summary',
            chatId: args.chatId || '',
            charCount,
            blockCount,
            extractedCount: extractedItems.length,
            savedCount: savedMemories.length,
            memories: savedMemories.map(sanitizeMemoryForMcp)
          }
        });
      }

      if (name === 'ingest_raw') {
        const rawText = String(args.rawText || args.text || args.content || '').trim();
        const messages = Array.isArray(args.messages) ? args.messages : [];

        const messageText = messages
          .map((msg, index) => {
            const role = String(msg.role || msg.sender || `message_${index + 1}`).trim();
            const content = String(msg.content || msg.text || '').trim();
            const time = msg.time || msg.timestamp || '';
            return content ? `[${time || 'no-time'}] ${role}: ${content}` : '';
          })
          .filter(Boolean)
          .join('\n');

        const combinedText = rawText || messageText;

        if (!combinedText) {
          return mcpError(id, -32602, 'rawText or messages is required');
        }

        const charCount = combinedText.length;
        const messageCount = messages.length || combinedText.split(/\n+/).filter(Boolean).length;
        const dryRun = args.dryRun === true || String(args.dryRun || '').toLowerCase() === 'true';
        const limit = clampNumber(args.limit, 1, 30, 8);

        const llmConfig = {
          endpoint: args.llmEndpoint || process.env.LLM_ENDPOINT || process.env.EMBEDDING_ENDPOINT || '',
          apiKey: args.llmApiKey || process.env.LLM_API_KEY || process.env.EMBEDDING_API_KEY || '',
          model: args.llmModel || process.env.LLM_MODEL || 'Qwen/Qwen3-8B'
        };

        if (!llmConfig.endpoint || !llmConfig.apiKey) {
          return mcpError(id, -32001, 'LLM endpoint/apiKey is required for ingest_raw extraction. Set LLM_ENDPOINT and LLM_API_KEY, or pass llmEndpoint/llmApiKey.');
        }

        let extractedItems = [];

        try {
          const prompt = buildRawIngestPrompt({
            combinedText,
            scene: args.scene || '',
            timeRange: args.timeRange || '',
            source: args.source || 'njj',
            roleName: args.roleName || args.actor || args._actor || '角色',
            userName: args.userName || args.userNickname || '她'
          });

          const rawExtraction = await createChatCompletion({
            endpoint: llmConfig.endpoint,
            apiKey: llmConfig.apiKey,
            model: llmConfig.model,
            messages: [
              {
                role: 'system',
                content: '你是严格的 JSON 记忆提取器。只输出 JSON 数组。'
              },
              {
                role: 'user',
                content: prompt
              }
            ],
            temperature: 0.2
          });

          extractedItems = parseExtractedMemoryItems(rawExtraction).slice(0, limit);

        } catch (error) {
          return mcpError(id, -32002, `ingest_raw extraction failed: ${error.message}`);
        }

        if (dryRun) {
          return mcpResult(id, {
            content: [
              {
                type: 'text',
                text: [
                  '已完成原文记忆提取预览，但未写入 SQLite。',
                  `字符数：${charCount}`,
                  `消息/行数：${messageCount}`,
                  `提取条数：${extractedItems.length}`,
                  '',
                  extractedItems.length > 0
                    ? extractedItems.map((item, index) => `${index + 1}. [${item.category}] ${item.content} #${item.tags.join(' #')} 重要度:${item.importance} 情绪:${item.emotionalWeight}`).join('\n')
                    : '没有提取到值得长期保存的记忆。'
                ].join('\n')
              }
            ],
            structuredContent: {
              ok: true,
              dryRun: true,
              source: args.source || 'njj',
              chatId: args.chatId || '',
              scene: args.scene || '',
              timeRange: args.timeRange || '',
              charCount,
              messageCount,
              extractedCount: extractedItems.length,
              extractedItems
            }
          });
        }

        await backupSqliteDb();

        const embeddingConfig = {
          endpoint: args.embeddingEndpoint || process.env.EMBEDDING_ENDPOINT || '',
          apiKey: args.embeddingApiKey || process.env.EMBEDDING_API_KEY || '',
          model: args.embeddingModel || process.env.EMBEDDING_MODEL || 'BAAI/bge-m3'
        };

        const savedMemories = [];

        for (const item of extractedItems) {
          let generatedEmbedding = null;

          if (embeddingConfig.endpoint && embeddingConfig.apiKey) {
            try {
              generatedEmbedding = await createQueryEmbedding({
                endpoint: embeddingConfig.endpoint,
                apiKey: embeddingConfig.apiKey,
                model: embeddingConfig.model,
                input: item.content
              });
            } catch (error) {
              console.warn('[mcp] ingest_raw embedding failed, save as BM25:', error.message);
            }
          }

          const memory = normalizeMemoryFragment({
            ...item,
            chatId: args.chatId || '',
            source: args.source || 'njj_raw',
            context: [
              args.scene ? `scene=${args.scene}` : '',
              args.timeRange ? `timeRange=${args.timeRange}` : ''
            ].filter(Boolean).join('; '),
            memoryTime: args.memoryTime || now(),
            embedding: generatedEmbedding,
            embeddingModel: generatedEmbedding ? embeddingConfig.model : '',
            embeddingDim: generatedEmbedding ? generatedEmbedding.length : 0,
            embeddingUpdatedAt: generatedEmbedding ? String(now()) : '',
            createdAt: now(),
            updatedAt: now()
          });

          const savedMemory = addMemory({
            ...memory,
            updatedAt: now()
          });

          savedMemories.push(savedMemory);
        }

        return mcpResult(id, {
          content: [
            {
              type: 'text',
              text: [
                '已从原始对话中提取并写入长期记忆。',
                `字符数：${charCount}`,
                `消息/行数：${messageCount}`,
                `写入条数：${savedMemories.length}`,
                '',
                savedMemories.length > 0
                  ? savedMemories.map((item, index) => `${index + 1}. ${item.content}`).join('\n')
                  : '没有写入新的长期记忆。'
              ].join('\n')
            }
          ],
          structuredContent: {
            ok: true,
            dryRun: false,
            source: args.source || 'njj',
            chatId: args.chatId || '',
            scene: args.scene || '',
            timeRange: args.timeRange || '',
            charCount,
            messageCount,
            extractedCount: extractedItems.length,
            savedCount: savedMemories.length,
            memories: savedMemories.map(sanitizeMemoryForMcp)
          }
        });
      }

        return mcpError(id, -32601, `Unknown tool: ${name}`);
      } catch (error) {
        return mcpError(id, -32000, error.message);
      }
    }

  return mcpError(id, -32601, `Method not found: ${method}`);
}

const server = http.createServer(async (req, res) => {
  const pathname = getPath(req);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key'
    });
    res.end();
    return;
  }

  if (pathname === '/mcp' && req.method === 'GET') {
    sendJson(res, 200, {
      ok: true,
      service: 'Aion Memory MCP Endpoint',
      transport: 'http-jsonrpc',
      endpoint: '/mcp',
      methods: ['initialize', 'tools/list', 'tools/call'],
      tools: mcpToolSchema().map(tool => tool.name)
    });
    return;
  }

  if (pathname === '/mcp' && req.method === 'POST') {
    try {
      const body = await readRequestBody(req);
      const result = await handleMcpRequest(body);
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, mcpError(null, -32700, error.message));
    }
    return;
  }

  if (pathname === '/health' && req.method === 'GET') {
    const memories = listMemories();

    sendJson(res, 200, {
      ok: true,
      service: 'Aion Memory Server',
      message: 'Memory server is running.',
      format: '111/2222-compatible-sqlite',
      storage: 'sqlite',
      count: memories.length
    });
    return;
  }

  if (pathname === '/memory/list' && req.method === 'GET') {
    const url = new URL(req.url, `http://${req.headers.host}`);

    const filters = {
      chatId: url.searchParams.get('chatId') || '',
      category: url.searchParams.get('category') || '',
      minImportance: url.searchParams.get('minImportance') || '',
      maxImportance: url.searchParams.get('maxImportance') || '',
      query: url.searchParams.get('query') || '',
      limit: url.searchParams.get('limit') || 5000
    };

    const memories = listMemories(filters);

    sendJson(res, 200, {
      ok: true,
      count: memories.length,
      filters,
      memories
    });
    return;
  }

  if (pathname === '/memory/stats' && req.method === 'GET') {
    const stats = getMemoryStats();

    sendJson(res, 200, {
      ok: true,
      storage: 'sqlite',
      stats
    });
    return;
  }

  if (pathname === '/memory/unembedded' && req.method === 'GET') {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const limit = url.searchParams.get('limit') || 100;
    const memories = listUnembeddedMemories(limit);

    sendJson(res, 200, {
      ok: true,
      count: memories.length,
      memories
    });
    return;
  }

  if (pathname === '/memory/add' && req.method === 'POST') {
    try {
      const body = await readRequestBody(req);
      const memory = normalizeMemoryFragment(body);

      await backupSqliteDb();

      const savedMemory = addMemory({
        ...memory,
        updatedAt: now()
      });

      sendJson(res, 200, {
        ok: true,
        memory: savedMemory
      });
    } catch (error) {
      sendJson(res, 400, {
        ok: false,
        error: error.message
      });
    }

    return;
  }

  // ↓↓↓ 从这里开始粘贴 reembed 接口

  if (pathname === '/memory/reembed-unembedded' && req.method === 'POST') {
    try {
      const body = await readRequestBody(req);

      const memories = listUnembeddedMemories(body.limit || 1000);

      const embeddingConfig = {
        endpoint: body.embeddingEndpoint || process.env.EMBEDDING_ENDPOINT || '',
        apiKey: body.embeddingApiKey || process.env.EMBEDDING_API_KEY || '',
        model: body.embeddingModel || process.env.EMBEDDING_MODEL || 'BAAI/bge-m3'
      };

      let success = 0;
      let failed = 0;

      for (const memory of memories) {
        try {
          const embedding = await createQueryEmbedding({
            endpoint: embeddingConfig.endpoint,
            apiKey: embeddingConfig.apiKey,
            model: embeddingConfig.model,
            input: memory.content
          });

          if (Array.isArray(embedding) && embedding.length > 0) {
            addMemory({
              ...memory,
              embedding,
              embeddingModel: embeddingConfig.model,
              embeddingDim: embedding.length,
              embeddingUpdatedAt: String(Date.now()),
              updatedAt: Date.now()
            });

            success++;
          } else {
            failed++;
          }

        } catch (error) {
          console.warn('[reembed] failed:', memory.id, error.message);
          failed++;
        }
      }

      sendJson(res, 200, {
        ok: true,
        total: memories.length,
        success,
        failed
      });

    } catch (error) {
      sendJson(res, 400, {
        ok: false,
        error: error.message
      });
    }

    return;
  }

  if (pathname === '/memory/search' && req.method === 'POST') {
    try {
      const body = await readRequestBody(req);

      const memories = listMemories({
        chatId: body.chatId || '',
        category: body.category || '',
        minImportance: body.minImportance || '',
        maxImportance: body.maxImportance || '',
        limit: body.candidateLimit || 1000
      });

      const embeddingConfig = {
        endpoint: body.embeddingEndpoint || process.env.EMBEDDING_ENDPOINT || '',
        apiKey: body.embeddingApiKey || process.env.EMBEDDING_API_KEY || '',
        model: body.embeddingModel || process.env.EMBEDDING_MODEL || 'BAAI/bge-m3'
      };

      const results = await simpleSearch(memories, body.query || '', body.limit || 20, {
        embedding: embeddingConfig
      });

      sendJson(res, 200, {
        ok: true,
        query: body.query || '',
        count: results.length,
        searchMode: embeddingConfig.endpoint && embeddingConfig.apiKey ? 'semantic-hybrid' : 'keyword-fallback',
        memories: results
      });
    } catch (error) {
      sendJson(res, 400, {
        ok: false,
        error: error.message
      });
    }

    return;
  }

  if (pathname === '/memory/backup' && req.method === 'POST') {
    const result = await backupSqliteDb();

    if (result.ok) {
      sendJson(res, 200, {
        ok: true,
        message: 'SQLite memory database backed up.',
        backupFile: result.backupFile,
        latestBackupFile: result.latestBackupFile,
        timestamp: result.timestamp
      });
    } else {
      sendJson(res, 500, {
        ok: false,
        error: result.error || 'Backup failed'
      });
    }

    return;
  }

  if (pathname === '/memory/delete' && req.method === 'POST') {
    try {
      const body = await readRequestBody(req);
      const id = String(body.id || '').trim();

      if (!id) {
        sendJson(res, 400, {
          ok: false,
          error: 'id is required'
        });
        return;
      }

      await backupSqliteDb();

      const deleted = deleteMemory(id);

      sendJson(res, 200, {
        ok: true,
        deleted: deleted ? 1 : 0
      });
    } catch (error) {
      sendJson(res, 400, {
        ok: false,
        error: error.message
      });
    }

    return;
  }

  if (pathname === '/memory/clear' && req.method === 'POST') {
    await backupSqliteDb();

    const deleted = clearAllMemories();

    sendJson(res, 200, {
      ok: true,
      deleted,
      message: 'All memories cleared.'
    });
    return;
  }

  sendJson(res, 404, {
    ok: false,
    error: 'Not found'
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Aion Memory Server running at http://0.0.0.0:${PORT}`);
  console.log(`Local health check: http://127.0.0.1:${PORT}/health`);
  console.log(`Tailscale access: http://100.81.84.121:${PORT}/health`);
  console.log('Storage: SQLite memory.db');
});