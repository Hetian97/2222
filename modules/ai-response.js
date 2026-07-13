
const EXTERNAL_MCP_PROXY_BASE_STORAGE_KEY = 'externalMcpProxyBaseUrl';

function normalizeExternalMcpNameText(value) {
  return String(value || '').trim().toLowerCase();
}

function extractParenthesizedAliasesFromExternalMcpName(name) {
  const text = String(name || '');
  const aliases = [];
  const re = /[（(]\s*([^（）()]+?)\s*[）)]/g;
  let match;
  while ((match = re.exec(text))) {
    if (match[1] && match[1].trim()) aliases.push(match[1].trim());
  }
  return aliases;
}

function getExternalMcpServiceAliases(service) {
  const aliases = new Set();
  const add = (value) => {
    const text = String(value || '').trim();
    if (text) aliases.add(text);
  };

  add(service && service.name);
  add(service && service.alias);
  add(service && service.serviceName);
  add(service && service.id);

  extractParenthesizedAliasesFromExternalMcpName(service && service.name).forEach(add);

  return Array.from(aliases);
}

function isExternalMcpServiceNameMatch(service, requestedName) {
  const target = normalizeExternalMcpNameText(requestedName);
  if (!target) return false;
  return getExternalMcpServiceAliases(service).some(alias => normalizeExternalMcpNameText(alias) === target);
}

function getExternalMcpProxyBaseUrl() {
  try {
    const saved = localStorage.getItem(EXTERNAL_MCP_PROXY_BASE_STORAGE_KEY);
    if (saved && saved.trim()) return saved.trim().replace(/\/+$/, '');
  } catch (error) {}

  try {
    const hostname = window.location.hostname;
    if (hostname === 'hetian97.github.io' || hostname.endsWith('.github.io')) {
      return 'https://mcp.htw1.uk';
    }
  } catch (error) {}

  return 'http://127.0.0.1:8765';
}

function buildExternalMcpProxyUrl(path) {
  const base = getExternalMcpProxyBaseUrl().replace(/\/+$/, '');
  const suffix = String(path || '').startsWith('/') ? String(path) : '/' + String(path || '');
  return base + suffix;
}


// ============================================================
// ai-response.js
// AI 响应模块：toGeminiRequestData、uploadImageToImgBB、uploadFileToCatbox、
// silentlyUpdateDbUrl、parseAiResponse、triggerSpectatorGroupAiAction、triggerAiResponse
// 从 script.js 第 1346~1421 + 2553~2852 + 8979~9060 + 13711~19173 + 14027~19165 行拆分
// ============================================================

  // === 新增：动态年龄和生日计算上下文生成函数 ===
  function getDynamicAgeContext(chat) {
    if (!chat || !chat.settings || !chat.settings.enableDynamicAge || !chat.settings.aiBirthday) return '';
    
    const bd = chat.settings.aiBirthday;
    if (!bd.year) return ''; // 必须至少要有年份

    // 判断是否开启了自定义时间
    const customTimeInfo = typeof window.getCustomTime === 'function' ? window.getCustomTime() : null;
    const now = (customTimeInfo && customTimeInfo.enabled) ? customTimeInfo.date : new Date();

    let age = now.getFullYear() - bd.year;
    
    // 构建生日字符串
    let birthdayStr = `${bd.year}年`;
    if (bd.month) {
      birthdayStr += `${bd.month}月`;
      if (bd.day) {
        birthdayStr += `${bd.day}日`;
      }
    }

    // 精确计算年龄
    if (bd.month && bd.day) {
      const m = now.getMonth() + 1;
      const d = now.getDate();
      if (m < bd.month || (m === bd.month && d < bd.day)) {
        age--;
      }
    }

    return `- **你的生日**: ${birthdayStr}\n- **你的当前年龄**: ${age}岁\n`;
  }

  // WMO天气代码转中文描述
  function getWeatherDescription(code) {
    const codes = {
      0: "晴朗 (Clear sky)",
      1: "大部晴朗 (Mainly clear)", 2: "多云 (Partly cloudy)", 3: "阴天 (Overcast)",
      45: "有雾 (Fog)", 48: "结霜雾 (Depositing rime fog)",
      51: "轻微毛毛雨 (Drizzle: Light)", 53: "中度毛毛雨 (Drizzle: Moderate)", 55: "大毛毛雨 (Drizzle: Dense)",
      61: "小雨 (Rain: Slight)", 63: "中雨 (Rain: Moderate)", 65: "大雨 (Rain: Heavy)",
      71: "小雪 (Snow fall: Slight)", 73: "中雪 (Snow fall: Moderate)", 75: "大雪 (Snow fall: Heavy)",
      80: "阵雨 (Rain showers)", 81: "中度阵雨", 82: "暴雨",
      95: "雷雨 (Thunderstorm)", 96: "雷雨伴有冰雹", 99: "重度雷雨伴有冰雹"
    };
    return codes[code] || "未知天气";
  }

  // 根据经纬度获取实时天气
  async function fetchWeather(lat, lon) {
    if (!lat || !lon) return null;
    try {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,weather_code,is_day,wind_speed_10m&timezone=auto`;
      const response = await fetch(url);
      const data = await response.json();

      if (data.current) {
        const c = data.current;
        const desc = getWeatherDescription(c.weather_code);
        const dayState = c.is_day ? "白天" : "夜晚";
        return `气温 ${c.temperature_2m}°C, 湿度 ${c.relative_humidity_2m}%, ${desc}, ${dayState}, 风速 ${c.wind_speed_10m}km/h`;
      }
      return null;
    } catch (e) {
      console.error("获取天气失败:", e);
      return null;
    }
  }

  // 获取天气上下文信息，用于AI prompt
  async function getWeatherContextForPrompt(chat) {
    const wSettings = chat.settings.weather || {};
    if (!wSettings.enabled) return "";

    let context = "\n# 【实时环境与天气同步】\n";
    let hasData = false;

    // 获取用户天气
    if (wSettings.userLat && wSettings.userLon) {
      const userWeather = await fetchWeather(wSettings.userLat, wSettings.userLon);
      if (userWeather) {
        const locationName = wSettings.userVirtualCity || "所在地";
        context += `- 用户(${chat.settings.myNickname || '我'})当前在【${locationName}】: ${userWeather}。\n`;
        hasData = true;
      }
    }

    // 获取角色天气
    if (wSettings.charLat && wSettings.charLon) {
      const charWeather = await fetchWeather(wSettings.charLat, wSettings.charLon);
      if (charWeather) {
        const locationName = wSettings.charVirtualCity || "所在地";
        context += `- 你(${chat.name})当前在【${locationName}】: ${charWeather}。\n`;
        hasData = true;
      }
    }

    if (!hasData) return "";

    context += "请根据上述天气和时间状态（如是否下雨、是白天还是夜晚）来调整你的描写氛围、角色的行动（如撑伞、避暑、添衣）以及对话内容。";
    return context;
  }

  function buildEnabledMcpServicesPrompt(chat, messagesPayload) {
    try {
      const raw = localStorage.getItem('mcpServiceConfigs');
      if (!raw) return '';

      const services = JSON.parse(raw);
      if (!Array.isArray(services)) return '';

      const actor = buildExternalMcpActorContext(chat);
      const latestUserText = getLatestUserTextForExternalMcpMemory(messagesPayload);

      const enabledServices = services.filter(service => {
        const mode = service && service.mode ? String(service.mode) : 'tools';
        return service &&
          service.enabled !== false &&
          (mode === 'tools' || mode === 'all') &&
          Array.isArray(service.tools) &&
          service.tools.length > 0 &&
          isExternalMcpServiceAllowedForActor(service, actor) &&
          isExternalMcpServiceTriggeredByMessage(service, latestUserText);
      });

      console.log("[MCP Directory] 工具目录服务:", enabledServices.map(service => ({
        name: service.name || service.url,
        mode: service.mode || "tools",
        allowed: describeExternalMcpAllowedCallers(service),
        triggerKeywords: parseExternalMcpTriggerKeywords(service),
        latestUserText
      })));

      if (!enabledServices.length) return '';

      const lines = [
        '【外部 MCP 工具目录与调用协议】',
        '',
        '当前系统已启用以下外部 MCP 工具服务。你可以根据用户请求、当前对话语境和角色自身需要，自行判断是否需要使用外部 MCP 工具。',
        '',
        '重要规则：',
        '1. 如果用户的问题可以直接回答，不要调用工具，正常回复即可。',
        '2. 如果当前回复需要最新信息、外部事实、设备状态、屏幕/使用情况、网页搜索、公开网页、GitHub README、指定文章内容，且下方有合适工具，你可以主动发起工具调用请求；不必等用户明确说“使用 MCP”。',
        '3. 你不能自己执行工具，也不能假装已经搜索、读取或调用成功。',
        '4. 当你需要调用工具时，必须只输出一个 external_mcp_tool_call 代码块，不要添加任何解释、寒暄或多余文本。',
        '5. 一次最多请求调用一个工具。',
        '6. serviceName 必须严格使用下面列出的服务名称。',
        '7. toolName 必须严格使用下面列出的工具名称。',
        '8. arguments 必须是该工具需要的 JSON 参数对象。',
        '9. 如果工具列出了 required/properties，你必须严格按照这些参数名生成 arguments。',
        '10. 不要发明未列出的参数名；例如工具需要 block_id/items 时，不要改写成 parent_page_id/content。',
        '11. 如果上文已经出现【外部 MCP 记忆上下文】，说明系统已经自动完成了记忆模式检索；不要为了同一个问题再次输出 external_mcp_tool_call 调用该记忆服务，应该直接根据记忆上下文回答。',
        '12. 工具安全策略：读取类工具可用于查询；已在 MCP 设置中开启“允许角色自动调用”的服务，代表用户允许角色在合适语境中主动调用该服务。未开启自动调用的写入类、控制类、交易类工具只能在用户明确要求时使用，且系统会要求用户确认。不要主动使用未授权自动调用的点单、支付、蓝牙设备、智能家居、删除、写入等高风险工具。',
        '13. 对 search / bing_search / query 等搜索类工具，arguments.query 应尽量使用用户当前问题的核心原句，不要随意改写、扩写或换同义词；这样系统可以复用 5 分钟缓存。只有当用户问题太长或包含明显无关内容时，才做最小化清理。',
        '',
        '【Notion 私有日记路由规则】',
        'A. 当用户要求读取、查看、写入、追加、创建、更新 Notion 页面、Notion 数据库、交换日记、夏以昼的日记、夏芷鹤的日记等私有内容时，必须优先使用 Notion 交换日记服务，不要使用 Web Search。',
        'B. Web Search 只能用于公开网页、新闻、搜索引擎、GitHub README、公开文章等外部公开信息；它不能访问用户的私有 Notion。',
        'C. 已知 Notion 私有日记数据库地址簿：',
        '   - 夏以昼的日记：database_id=331bafbb-8ea4-80db-9ad2-e743b4dbe369；data_source_id=331bafbb-8ea4-8044-ac92-000bceaf44d3；字段为 Name(title), Date(date)。',
        '   - 夏芷鹤的日记：database_id=331bafbb-8ea4-8011-9040-fe0a26d3519f；data_source_id=331bafbb-8ea4-804d-83a1-000b38f191d1；字段为 Name(title), Date(date)。',
        'D. 写入某个日记数据库时，第一步使用 notion_create_data_source_item_from_values，arguments 必须包含 data_source_id 和 values，其中 values 使用 Name 作为标题、Date 作为日期。',
        'E. 如果用户还提供了正文，创建数据库条目成功后，必须根据工具返回结果中的新 page id，再进行第二步 notion_append_markdown；第二步的 block_id 必须使用新 page id，不要使用 database_id 或 data_source_id。',
        'F. 读取日记列表时，使用 notion_query_data_source 或 notion_query_data_source_by_values；读取某一篇日记正文时，再使用 notion_read_page 读取该条目的 page_id。',
        'G. 当用户要求读取“最近一篇”“最新一篇”“最近几篇”“最新日记”时，查询日记 data source 必须按 Date 倒序排序；优先使用 notion_query_data_source_by_values，arguments 中包含 sorts: [{ property: "Date", direction: "descending" }]，并把 page_size 设为用户要求的数量；如果用户只说最近一篇，page_size 设为 1。',
        'H. 如果用户要求读取最近一篇的正文，第一步先按 Date descending 查询得到 page_id，第二步再用 notion_read_page 读取该 page_id；不要只凭标题或默认返回顺序判断最新。',
        '',
        '工具调用请求格式如下：',
        '```external_mcp_tool_call',
        '{',
        '  "type": "external_mcp_tool_call",',
        '  "serviceName": "服务名称",',
        '  "toolName": "工具名称",',
        '  "arguments": {}',
        '}',
        '```',
        '',
        '系统在收到 external_mcp_tool_call 后会负责执行工具，并把工具结果交还给你。拿到工具结果前，不要编造结果。',
        '',
        '可用服务与工具：'
      ];

      enabledServices.forEach((service, serviceIndex) => {
        const serviceName = service.name || service.url || ('MCP Service ' + (serviceIndex + 1));
        lines.push('');
        lines.push('服务：' + serviceName);
        if (service.serverName || service.serverVersion) {
          lines.push('server：' + (service.serverName || 'unknown') + (service.serverVersion ? ' / ' + service.serverVersion : ''));
        }
        service.tools.forEach(tool => {
          const toolName = tool && tool.name ? tool.name : '';
          if (!toolName) return;

          const description = tool && tool.description ? String(tool.description).replace(/\s+/g, ' ').trim() : '';
          const safety = classifyExternalMcpToolSafety(toolName, description);
          const safetyText = describeExternalMcpToolSafety(toolName, description);
          lines.push('- ' + toolName + ' [安全分类：' + safety + '] ' + (description ? '：' + description : '') + '（' + safetyText + '）');

          const schema = tool && tool.inputSchema && typeof tool.inputSchema === 'object' ? tool.inputSchema : null;
          const properties = schema && schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
          const required = schema && Array.isArray(schema.required) ? schema.required : [];

          if (required.length) {
            lines.push('  required: ' + required.join(', '));
          }

          const propertyEntries = Object.entries(properties).slice(0, 24);
          if (propertyEntries.length) {
            lines.push('  arguments properties:');
          }

          propertyEntries.forEach(([key, value]) => {
            const prop = value && typeof value === 'object' ? value : {};
            const rawType = Array.isArray(prop.type) ? prop.type.join('|') : (prop.type || 'unknown');
            const requiredText = required.includes(key) ? 'required' : 'optional';
            const enumText = Array.isArray(prop.enum) && prop.enum.length ? ' enum=' + prop.enum.slice(0, 10).join('|') : '';
            const defaultText = typeof prop.default !== 'undefined' ? ' default=' + JSON.stringify(prop.default) : '';
            const itemType = prop.items && prop.items.type ? ' items=' + (Array.isArray(prop.items.type) ? prop.items.type.join('|') : prop.items.type) : '';
            const descriptionText = prop.description ? ' - ' + String(prop.description).replace(/\s+/g, ' ').trim().slice(0, 180) : '';

            lines.push('    - ' + key + ': ' + rawType + ' (' + requiredText + ')' + enumText + defaultText + itemType + descriptionText);
          });

          if (schema && schema.additionalProperties === false) {
            lines.push('  additionalProperties: false（不要使用未列出的参数名）');
          }
        });
      });

      return lines.join('\n');
    } catch (error) {
      console.warn('构建 MCP 工具目录失败:', error);
      return '';
    }
  }
  function normalizeExternalMcpToolRequest(candidate) {
    if (!candidate || typeof candidate !== "object") return null;

    if (candidate.type === "external_mcp_tool_call") {
      const serviceName = candidate.serviceName || candidate.service || "";
      const toolName = candidate.toolName || candidate.tool || "";
      const args = candidate.arguments && typeof candidate.arguments === "object" ? candidate.arguments : {};
      if (!serviceName || !toolName) return null;
      return {
        type: "external_mcp_tool_call",
        serviceName,
        toolName,
        arguments: args
      };
    }

    if (typeof candidate.query === "string" && candidate.query.trim()) {
      return {
        type: "external_mcp_tool_call",
        serviceName: "ModelScope Web Search",
        toolName: "search",
        arguments: {
          query: candidate.query.trim(),
          limit: typeof candidate.limit === "number" ? candidate.limit : 3,
          engines: Array.isArray(candidate.engines) ? candidate.engines : ["bing"]
        }
      };
    }

    return null;
  }


  function parseExternalMcpToolCallJsonText(rawText) {
    const raw = String(rawText || "").trim();
    const candidates = [];

    function addCandidate(value) {
      const text = String(value || "").trim();
      if (text && !candidates.includes(text)) candidates.push(text);
    }

    addCandidate(raw);

    // 兼容模型把 JSON 又转义了一层的情况：
    // \n{\n  \"type\": \"external_mcp_tool_call\" ...}
    addCandidate(
      raw
        .replace(/\\r\\n/g, "\n")
        .replace(/\\n/g, "\n")
        .replace(/\\t/g, "\t")
        .replace(/\\"/g, '"')
    );

    // 兼容整个内容是 JSON string 的情况。
    try {
      const unwrapped = JSON.parse(raw);
      if (typeof unwrapped === "string") {
        addCandidate(unwrapped);
        addCandidate(
          unwrapped
            .replace(/\\r\\n/g, "\n")
            .replace(/\\n/g, "\n")
            .replace(/\\t/g, "\t")
            .replace(/\\"/g, '"')
        );
      } else if (unwrapped && typeof unwrapped === "object") {
        return unwrapped;
      }
    } catch (error) {
      // ignore and try candidates below
    }

    let lastError = null;
    for (const candidate of candidates) {
      try {
        return JSON.parse(candidate);
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError || new Error("external_mcp_tool_call JSON parse failed");
  }

  function findExternalMcpToolRequest(messagesArray, rawText) {
    if (Array.isArray(messagesArray)) {
      for (const item of messagesArray) {
        const normalized = normalizeExternalMcpToolRequest(item);
        if (normalized) return normalized;
      }
    }

    if (typeof rawText === "string" && rawText.trim()) {
      const codeBlockMatch = rawText.match(/```external_mcp_tool_call\s*([\s\S]*?)```/i);
      const jsonText = codeBlockMatch ? codeBlockMatch[1].trim() : "";
      if (jsonText) {
        try {
          const parsed = parseExternalMcpToolCallJsonText(jsonText);
          const normalized = normalizeExternalMcpToolRequest(parsed);
          if (normalized) return normalized;
        } catch (error) {
          console.warn("解析 external_mcp_tool_call 代码块失败:", error);
        }
      }
    }

    return null;
  }

  function getExternalMcpServiceConfigsForChat() {
    try {
      const raw = localStorage.getItem("mcpServiceConfigs");
      if (!raw) return [];
      const services = JSON.parse(raw);
      return Array.isArray(services) ? services : [];
    } catch (error) {
      console.warn("读取 MCP 服务配置失败:", error);
      return [];
    }
  }

  function getExternalMcpAuthPayloadFromService(service) {
    const authType = service && service.authType ? String(service.authType) : "none";
    const payload = {
      authorization: "",
      headers: {}
    };

    if (authType === "bearer") {
      const token = service && service.bearerToken ? String(service.bearerToken).trim() : "";
      if (token) {
        payload.authorization = token.toLowerCase().startsWith("bearer ") ? token : "Bearer " + token;
      }
    }

    if (authType === "header") {
      const headerName = service && service.headerName ? String(service.headerName).trim() : "";
      const headerValue = service && service.headerValue ? String(service.headerValue).trim() : "";
      if (headerName && headerValue) {
        payload.headers[headerName] = headerValue;
      }
    }

    return payload;
  }

  const EXTERNAL_MCP_TOOL_CACHE_TTL_MS = 5 * 60 * 1000;
  const externalMcpToolResultCache = new Map();

  function stableStringifyExternalMcpCacheValue(value) {
    if (value === null || typeof value !== "object") return JSON.stringify(value);

    if (Array.isArray(value)) {
      return "[" + value.map(item => stableStringifyExternalMcpCacheValue(item)).join(",") + "]";
    }

    return "{" + Object.keys(value).sort().map(key => {
      return JSON.stringify(key) + ":" + stableStringifyExternalMcpCacheValue(value[key]);
    }).join(",") + "}";
  }

  function buildExternalMcpToolCacheKey(service, toolName, args, actor) {
    return stableStringifyExternalMcpCacheValue({
      url: service && service.url ? String(service.url) : "",
      name: service && service.name ? String(service.name) : "",
      toolName: toolName || "",
      arguments: args && typeof args === "object" ? args : {},
      actor: getExternalMcpActorCacheScope(actor)
    });
  }

  function getExternalMcpToolCachedResult(cacheKey) {
    if (!cacheKey || !externalMcpToolResultCache.has(cacheKey)) return null;

    const entry = externalMcpToolResultCache.get(cacheKey);
    if (!entry || !entry.expiresAt || Date.now() > entry.expiresAt) {
      externalMcpToolResultCache.delete(cacheKey);
      return null;
    }

    console.log("[MCP Cache] 命中:", entry.label || cacheKey);
    return entry.value;
  }

  function setExternalMcpToolCachedResult(cacheKey, value, label) {
    if (!cacheKey) return;

    externalMcpToolResultCache.set(cacheKey, {
      value,
      label: label || "",
      createdAt: Date.now(),
      expiresAt: Date.now() + EXTERNAL_MCP_TOOL_CACHE_TTL_MS
    });

    if (externalMcpToolResultCache.size > 80) {
      const firstKey = externalMcpToolResultCache.keys().next().value;
      if (firstKey) externalMcpToolResultCache.delete(firstKey);
    }

    console.log("[MCP Cache] 写入:", label || cacheKey);
  }

  function shouldCacheExternalMcpTool(service, toolName) {
    const tool = service && Array.isArray(service.tools)
      ? service.tools.find(item => item && item.name === toolName)
      : null;
    const description = tool && tool.description ? String(tool.description) : "";
    return classifyExternalMcpToolSafety(toolName, description) === "read";
  }

  function parseExternalMcpAllowedCallers(service) {
    const rawParts = [];

    if (Array.isArray(service && service.allowedCallerIds)) {
      rawParts.push(...service.allowedCallerIds);
    }

    if (service && typeof service.allowedCallersText === "string") {
      rawParts.push(service.allowedCallersText);
    }

    if (Array.isArray(service && service.allowedCallers)) {
      rawParts.push(...service.allowedCallers);
    }

    const raw = rawParts.join(",");
    const mode = service && service.allowedCallerMode
      ? String(service.allowedCallerMode)
      : raw.trim()
        ? "selected"
        : "all";

    if (mode !== "selected") return [];

    return String(raw || "")
      .split(/[，,;；\n\r]+/)
      .map(item => item.trim())
      .filter(Boolean);
  }

  function normalizeExternalMcpCallerName(value) {
    return String(value || "").trim().toLowerCase();
  }

  function getExternalMcpActorIdentityList(actor) {
    if (!actor || typeof actor !== "object") return [];

    return [
      actor.characterName,
      actor.originalName,
      actor.chatName,
      actor.chatId,
      actor.characterId
    ]
      .map(normalizeExternalMcpCallerName)
      .filter(Boolean);
  }

  function isExternalMcpServiceAllowedForActor(service, actor) {
    const allowed = parseExternalMcpAllowedCallers(service);
    if (!allowed.length) return true;

    const allowedSet = new Set(allowed.map(normalizeExternalMcpCallerName).filter(Boolean));
    if (allowedSet.has("*") || allowedSet.has("all") || allowedSet.has("全部")) return true;

    const actorNames = getExternalMcpActorIdentityList(actor);
    if (!actorNames.length) return false;

    return actorNames.some(name => allowedSet.has(name));
  }

  function parseExternalMcpTriggerKeywords(service) {
    const raw = service && typeof service.triggerKeywordsText === "string"
      ? service.triggerKeywordsText
      : Array.isArray(service && service.triggerKeywords)
        ? service.triggerKeywords.join(",")
        : "";

    return String(raw || "")
      .split(/[，,;；\n\r]+/)
      .map(item => item.trim().toLowerCase())
      .filter(Boolean);
  }

  function isExternalMcpServiceTriggeredByMessage(service, latestUserText) {
    const keywords = parseExternalMcpTriggerKeywords(service);
    if (!keywords.length) return true;

    const text = String(latestUserText || "").toLowerCase();
    if (!text.trim()) return false;

    return keywords.some(keyword => text.includes(keyword));
  }

  function describeExternalMcpAllowedCallers(service) {
    const allowed = parseExternalMcpAllowedCallers(service);
    return allowed.length ? allowed.join(", ") : "全部";
  }

  function findExternalMcpServiceForRequest(request) {
    const actor = request && request.actor ? request.actor : null;
    const services = getExternalMcpServiceConfigsForChat().filter(service => {
      const mode = service && service.mode ? String(service.mode) : "tools";
      return service &&
        service.enabled !== false &&
        (mode === "tools" || mode === "all") &&
        service.url;
    });

    if (!services.length) return null;

    const requestedName = request && request.serviceName ? String(request.serviceName).trim() : "";

    let selected = null;

    if (requestedName) {
      selected = services.find(service =>
        isExternalMcpServiceNameMatch(service, requestedName) ||
        service.url === requestedName ||
        service.serverName === requestedName
      ) || null;
    } else if (services.length === 1) {
      selected = services[0];
    }

    if (!selected) return null;

    if (!isExternalMcpServiceAllowedForActor(selected, actor)) {
      const actorNames = getExternalMcpActorIdentityList(actor).join(", ") || "unknown";
      throw new Error("当前调用者无权使用 MCP 服务：" + (selected.name || selected.url) + "。当前调用者：" + actorNames + "；允许调用者：" + describeExternalMcpAllowedCallers(selected));
    }

    return selected;
  }

  function getExternalMcpActorCacheScope(actor) {
    if (!actor || typeof actor !== "object") return {};

    return {
      source: actor.source || "",
      chatId: actor.chatId || "",
      chatName: actor.chatName || "",
      characterId: actor.characterId || "",
      characterName: actor.characterName || "",
      originalName: actor.originalName || "",
      isGroup: !!actor.isGroup,
      isOfflineMode: !!actor.isOfflineMode
    };
  }

  function buildExternalMcpActorContext(chat, source) {
    const character = chat && chat.character && typeof chat.character === "object" ? chat.character : null;
    const isOfflineMode = !!(chat && (
      chat.isOfflineMode ||
      chat.offlineMode ||
      chat.isOffline ||
      (chat.settings && chat.settings.isOfflineMode)
    ));
    const actorSource = source || (isOfflineMode ? "offline_dialogue" : "chat");

    return {
      source: actorSource,
      chatId: chat && (chat.id || chat.chatId || chat.conversationId) ? String(chat.id || chat.chatId || chat.conversationId) : "",
      chatName: chat && (chat.name || chat.title || chat.chatName) ? String(chat.name || chat.title || chat.chatName) : "",
      characterId: chat && (chat.characterId || (character && character.id)) ? String(chat.characterId || character.id) : "",
      characterName: chat && (chat.characterName || (character && character.name) || chat.name || chat.title) ? String(chat.characterName || (character && character.name) || chat.name || chat.title) : "",
      originalName: chat && (chat.originalName || (character && character.originalName)) ? String(chat.originalName || character.originalName) : "",
      isGroup: !!(chat && chat.isGroup),
      isOfflineMode,
      createdAt: new Date().toISOString()
    };
  }

  async function executeExternalMcpToolRequest(request, actorContext) {
    const service = findExternalMcpServiceForRequest(request);
    if (!service) {
      throw new Error("找不到匹配的已启用 MCP 服务：" + (request && request.serviceName ? request.serviceName : ""));
    }

    const authPayload = getExternalMcpAuthPayloadFromService(service);
    const toolName = request && request.toolName ? String(request.toolName).trim() : "";
    if (!toolName) {
      throw new Error("MCP 工具调用缺少 toolName。");
    }

    const args = request.arguments && typeof request.arguments === "object" ? request.arguments : {};
    const actor = actorContext || (request && request.actor) || null;
    const shouldUseCache = shouldCacheExternalMcpTool(service, toolName);
    const cacheKey = shouldUseCache ? buildExternalMcpToolCacheKey(service, toolName, args, actor) : "";
    const cachedData = shouldUseCache ? getExternalMcpToolCachedResult(cacheKey) : null;

    if (cachedData) {
      return {
        serviceName: service.name || service.url,
        toolName,
        arguments: args,
        actor,
        data: cachedData,
        cached: true
      };
    }

    const response = await fetch(buildExternalMcpProxyUrl('/external-mcp/tools-call'), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: service.url,
        ...authPayload,
        toolName,
        arguments: args,
        actor,
        timeoutMs: 30000
      })
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok || !data.ok) {
      throw new Error(data.error || ("HTTP " + response.status));
    }

    if (shouldUseCache) {
      setExternalMcpToolCachedResult(cacheKey, data, (service.name || service.url) + " / " + toolName);
    }

    return {
      serviceName: service.name || service.url,
      toolName,
      arguments: args,
      actor,
      data,
      cached: false
    };
  }

  function getExternalMcpMemoryServicesForChat(actor, latestUserText) {
    return getExternalMcpServiceConfigsForChat().filter(service => {
      const mode = service && service.mode ? String(service.mode) : "tools";
      const toolName = service && service.toolName ? String(service.toolName).trim() : "";
      return service &&
        service.enabled !== false &&
        (mode === "memory" || mode === "all") &&
        service.url &&
        toolName &&
        isExternalMcpServiceAllowedForActor(service, actor) &&
        isExternalMcpServiceTriggeredByMessage(service, latestUserText);
    });
  }

  function classifyExternalMcpToolSafety(toolName, description) {
    const text = [toolName || "", description || ""].join(" ").toLowerCase();

    if (!text.trim()) return "unknown";

    const controlPattern = /(order|pay|payment|checkout|purchase|buy|cart|mcdonald|restaurant|delivery|bluetooth|ble|wearable|band|watch|smart[_-]?home|device|control|command|light|lamp|door|lock|unlock|thermostat|ac|air[_-]?conditioner|点单|下单|支付|购买|付款|麦当劳|外卖|蓝牙|手环|手表|智能家居|智能家具|开灯|关灯|开门|关门|门锁|空调|设备控制)/i;
    if (controlPattern.test(text)) return "control";

    const writePattern = /(create|append|update|delete|remove|write|insert|clear|ingest|post|send|comment|upload|replace|patch|archive|restore|move|rename|创建|追加|更新|删除|移除|写入|插入|清空|发送|评论|上传|替换|移动|重命名)/i;
    if (writePattern.test(text)) return "write";

    const readPattern = /(search|find|query|retrieve|read|inspect|list|fetch|get|open|crawl|搜索|查找|查询|读取|检索|查看|列表|打开|抓取)/i;
    if (readPattern.test(text)) return "read";

    return "unknown";
  }

  function describeExternalMcpToolSafety(toolName, description) {
    const safety = classifyExternalMcpToolSafety(toolName, description);
    if (safety === "read") return "读取类：可用于记忆模式，可缓存，主动调用仍会确认。";
    if (safety === "write") return "写入类：禁止记忆模式自动调用，不缓存，主动调用必须确认。";
    if (safety === "control") return "控制/交易类：禁止自动调用，不缓存，主动调用必须确认。";
    return "未知类：默认禁止记忆模式自动调用，不缓存，主动调用必须确认。";
  }

  function isExternalMcpMemoryReadOnlyTool(toolName, description) {
    return classifyExternalMcpToolSafety(toolName, description) === "read";
  }

  function getLatestUserTextForExternalMcpMemory(messagesPayload) {
    if (!Array.isArray(messagesPayload)) return "";

    for (let i = messagesPayload.length - 1; i >= 0; i--) {
      const msg = messagesPayload[i];
      if (!msg || msg.role !== "user") continue;

      if (typeof msg.content === "string") return msg.content;

      if (Array.isArray(msg.content)) {
        const text = msg.content
          .filter(part => part && part.type === "text")
          .map(part => part.text || "")
          .join(" ")
          .trim();
        if (text) return text;
      }
    }

    return "";
  }

  function buildRecentMessagesTextForExternalMcpMemory(messagesPayload) {
    if (!Array.isArray(messagesPayload)) return "";

    return messagesPayload.slice(-8).map(msg => {
      if (!msg) return "";
      let content = "";
      if (typeof msg.content === "string") {
        content = msg.content;
      } else if (Array.isArray(msg.content)) {
        content = msg.content
          .filter(part => part && part.type === "text")
          .map(part => part.text || "")
          .join(" ");
      } else {
        content = JSON.stringify(msg.content || "");
      }
      return (msg.role || "unknown") + ": " + String(content).slice(0, 800);
    }).filter(Boolean).join("\n");
  }

  function cleanExternalMcpMemorySearchText(text) {
    return String(text || "")
      .replace(/^\s*\(Timestamp:\s*\d+\)\s*/i, "")
      .replace(/^\s*\[系统\]\s*/i, "")
      .replace(/^\s*\[旁白\]\s*/i, "")
      .trim();
  }

  function renderExternalMcpMemoryTemplateValue(value, context) {
    if (typeof value === "string") {
      return value
        .replace(/\{\{latestUserMessage\}\}/g, context.latestUserMessage)
        .replace(/\{\{latestUserMessageClean\}\}/g, context.latestUserMessageClean)
        .replace(/\{\{recentMessages\}\}/g, context.recentMessages)
        .replace(/\{\{chatName\}\}/g, context.chatName)
        .replace(/\{\{chatId\}\}/g, context.chatId)
        .replace(/\{\{characterName\}\}/g, context.characterName)
        .replace(/\{\{nowISO\}\}/g, context.nowISO)
        .replace(/\{\{today\}\}/g, context.today);
    }

    if (Array.isArray(value)) {
      return value.map(item => renderExternalMcpMemoryTemplateValue(item, context));
    }

    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [
        key,
        renderExternalMcpMemoryTemplateValue(item, context)
      ]));
    }

    return value;
  }

  function parseExternalMcpMemoryArguments(service, chat, messagesPayload) {
    const rawText = service && service.toolArgumentsText ? String(service.toolArgumentsText).trim() : "{}";
    const parsed = rawText ? JSON.parse(rawText) : {};
    const now = new Date();

    const context = {
      latestUserMessage: getLatestUserTextForExternalMcpMemory(messagesPayload),
      latestUserMessageClean: cleanExternalMcpMemorySearchText(getLatestUserTextForExternalMcpMemory(messagesPayload)),
      recentMessages: buildRecentMessagesTextForExternalMcpMemory(messagesPayload),
      chatName: chat && chat.name ? String(chat.name) : "",
      chatId: chat && chat.id ? String(chat.id) : "",
      characterName: chat && (chat.originalName || chat.name) ? String(chat.originalName || chat.name) : "",
      nowISO: now.toISOString(),
      today: now.toISOString().slice(0, 10)
    };

    return renderExternalMcpMemoryTemplateValue(parsed, context);
  }

  function formatExternalMcpMemoryPayloadForPrompt(payload) {
    let text = JSON.stringify(payload, null, 2);
    if (text.length > 6000) {
      text = text.slice(0, 6000) + "\n...（外部 MCP 记忆结果过长，已截断）";
    }
    return text;
  }

  async function buildExternalMcpMemoryContextForChat(chat, messagesPayload) {
    const memoryActorForFilter = buildExternalMcpActorContext(chat, "memory");
    const memoryLatestUserText = getLatestUserTextForExternalMcpMemory(messagesPayload);
    const services = getExternalMcpMemoryServicesForChat(memoryActorForFilter, memoryLatestUserText);
    console.log("[MCP Memory] 自动检索服务数量:", services.length, services.map(service => ({
      name: service.name || service.url,
      mode: service.mode,
      toolName: service.toolName
    })));
    if (!services.length) return "";

    const blocks = [];

    for (const service of services.slice(0, 3)) {
      const serviceName = service.name || service.url || "MCP Memory Service";
      const toolName = service.toolName ? String(service.toolName).trim() : "";

      const selectedMemoryTool = service && Array.isArray(service.tools) ? service.tools.find(tool => tool && tool.name === toolName) : null;
      const selectedMemoryToolDescription = selectedMemoryTool && selectedMemoryTool.description ? String(selectedMemoryTool.description) : "";
      const selectedMemoryToolSafety = classifyExternalMcpToolSafety(toolName, selectedMemoryToolDescription);

      if (!isExternalMcpMemoryReadOnlyTool(toolName, selectedMemoryToolDescription)) {
        blocks.push([
          "## " + serviceName,
          "已跳过：记忆模式只允许自动调用读取/搜索类工具。",
          "当前 toolName：" + toolName,
          "工具分类：" + selectedMemoryToolSafety,
          "策略：" + describeExternalMcpToolSafety(toolName, selectedMemoryToolDescription)
        ].join("\n"));
        continue;
      }

      try {
        const args = parseExternalMcpMemoryArguments(service, chat, messagesPayload);
        const authPayload = getExternalMcpAuthPayloadFromService(service);
        const memoryActor = memoryActorForFilter;

        const memoryCacheKey = buildExternalMcpToolCacheKey(service, toolName, args, memoryActor);
        const memoryCachedData = getExternalMcpToolCachedResult(memoryCacheKey);

        console.log("[MCP Memory] 自动检索开始:", {
          serviceName,
          toolName,
          args,
          actor: memoryActor,
          cached: !!memoryCachedData
        });

        let data;
        let response;

        if (memoryCachedData) {
          data = memoryCachedData;
          response = { ok: true };
        } else {
          response = await fetch(buildExternalMcpProxyUrl('/external-mcp/tools-call'), {
            method: "POST",
            headers: {
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              url: service.url,
              ...authPayload,
              toolName,
              arguments: args && typeof args === "object" ? args : {},
              actor: memoryActor,
              timeoutMs: 15000
            })
          });

          data = await response.json().catch(() => ({}));
          if (data && data.ok) {
            setExternalMcpToolCachedResult(memoryCacheKey, data, serviceName + " / " + toolName);
          }
        }

        console.log("[MCP Memory] 自动检索完成:", {
          serviceName,
          toolName,
          httpOk: response.ok,
          ok: data && data.ok,
          error: data && data.error,
          cached: !!memoryCachedData
        });

        blocks.push([
          "## " + serviceName,
          "toolName: " + toolName,
          "arguments:",
          "```json",
          formatExternalMcpMemoryPayloadForPrompt(args),
          "```",
          "result:",
          "```json",
          formatExternalMcpMemoryPayloadForPrompt(data),
          "```"
        ].join("\n"));
      } catch (error) {
        blocks.push([
          "## " + serviceName,
          "自动检索失败：" + (error && error.message ? error.message : String(error))
        ].join("\n"));
      }
    }

    if (!blocks.length) return "";

    return [
      "【外部 MCP 记忆上下文】",
      "以下内容来自已启用为“记忆”或“全部”的 MCP 服务，是本轮回复前自动检索到的背景资料。",
      "这些内容只能作为参考；不要把它说成用户刚刚亲口说过的话。",
      "重要：记忆模式的 MCP 已经由系统自动调用完成。你必须直接根据这些结果回答，不要再输出 external_mcp_tool_call 去重复调用这些记忆服务。",
      "如果检索结果不相关，请直接说明结果不相关，并基于已知信息回答或建议换关键词；不要再次调用同一个记忆 MCP。",
      "",
      blocks.join("\n\n")
    ].join("\n");
  }

  function formatExternalMcpToolResultForModel(request, result) {
    const payload = {
      request: {
        type: "external_mcp_tool_call",
        serviceName: request && request.serviceName ? request.serviceName : "",
        toolName: request && request.toolName ? request.toolName : "",
        arguments: request && request.arguments ? request.arguments : {}
      },
      result: result && result.data ? result.data : result
    };

    let text = JSON.stringify(payload, null, 2);
    if (text.length > 12000) {
      text = text.slice(0, 12000) + "\n...（工具结果过长，已截断）";
    }

    return [
      "【外部 MCP 工具执行结果】",
      "系统已经完成了外部 MCP 工具调用。",
      "请根据下面的工具结果回答用户刚才的问题。",
      "不要再次输出 external_mcp_tool_call。",
      "不要编造工具结果中没有的信息。",
      "",
      "```json",
      text,
      "```"
    ].join("\n");
  }

  async function generateExternalMcpFinalResponseFromToolResult(options) {
    const model = options.model;
    const apiKey = options.apiKey;
    const proxyUrl = options.proxyUrl;
    const isGemini = options.isGemini;
    const systemPrompt = options.systemPrompt;
    const messagesPayload = Array.isArray(options.messagesPayload) ? options.messagesPayload : [];
    const toolRequest = options.toolRequest;
    const toolResult = options.toolResult;
    const signal = options.signal;
    const allowNextToolCall = options.allowNextToolCall === true;

    const followupSystemPrompt = systemPrompt + "\n\n" + [
      "【外部 MCP 工具结果处理模式】",
      "你现在已经收到了外部 MCP 工具的真实返回结果。",
      allowNextToolCall
        ? "如果工具结果已经足够，请生成最终回复；如果仍需要另一个外部 MCP 工具才能完成用户请求，可以再输出一个 external_mcp_tool_call。"
        : "必须根据工具结果生成最终回复。",
      allowNextToolCall
        ? "需要第二次工具调用时，只输出一个 external_mcp_tool_call 代码块，不要添加其他文本。"
        : "不要再次输出 external_mcp_tool_call。",
      "不要声称无法访问外部工具，因为系统已经替你完成了调用。",
      "不要编造工具结果中没有的信息。",
      "保持当前角色设定和原有消息格式要求。"
    ].join("\n");

    const followupMessages = [
      ...messagesPayload,
      {
        role: "assistant",
        content: "```external_mcp_tool_call\n" + JSON.stringify(toolRequest, null, 2) + "\n```"
      },
      {
        role: "user",
        content: formatExternalMcpToolResultForModel(toolRequest, toolResult)
      }
    ];

    let response;
    if (isGemini) {
      const geminiConfig = toGeminiRequestData(model, apiKey, followupSystemPrompt, followupMessages);
      response = await fetch(geminiConfig.url, {
        ...geminiConfig.data,
        signal
      });
    } else {
      const reqBody = {
        model,
        messages: [{
          role: "system",
          content: followupSystemPrompt
        }, ...followupMessages],
        temperature: state.globalSettings.apiTemperature || 0.8,
        stream: false,
        ...(state.globalSettings.apiTopPEnabled && state.globalSettings.apiTopP !== undefined ? { top_p: state.globalSettings.apiTopP } : {}),
        ...(state.globalSettings.apiMaxTokensEnabled && state.globalSettings.apiMaxTokens !== undefined ? { max_tokens: state.globalSettings.apiMaxTokens } : {}),
        ...(state.globalSettings.apiPresencePenaltyEnabled && state.globalSettings.apiPresencePenalty !== undefined ? { presence_penalty: state.globalSettings.apiPresencePenalty } : {}),
        ...(state.globalSettings.apiFrequencyPenaltyEnabled && state.globalSettings.apiFrequencyPenalty !== undefined ? { frequency_penalty: state.globalSettings.apiFrequencyPenalty } : {})
      };

      response = await fetch(`${proxyUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`
        },
        body: JSON.stringify(reqBody),
        signal
      });
    }

    if (!response.ok) {
      let errorMsg = "MCP 工具结果二次总结 API 返回错误: " + response.status + " " + response.statusText;
      try {
        const errorData = await response.json();
        errorMsg += " - " + JSON.stringify(errorData);
      } catch (error) {}
      throw new Error(errorMsg);
    }

    const data = await response.json();
    return getGeminiResponseText(data);
  }

  function formatExternalMcpToolResultForChat(request, result) {
    const resultText = JSON.stringify(result && result.data ? result.data : result, null, 2);
    const trimmedResultText = resultText.length > 8000 ? resultText.slice(0, 8000) + "\n...（结果过长，已截断）" : resultText;

    return [
      "外部 MCP 工具调用完成。",
      "",
      "调用信息：",
      "```json",
      JSON.stringify({
        type: "external_mcp_tool_call",
        serviceName: result.serviceName || request.serviceName,
        toolName: result.toolName || request.toolName,
        arguments: result.arguments || request.arguments || {}
      }, null, 2),
      "```",
      "",
      "工具返回结果：",
      "```json",
      trimmedResultText,
      "```"
    ].join("\n");
  }

function toGeminiRequestData(model, apiKey, systemInstruction, messagesForDecision) {
    const apiTemperature = state.globalSettings.apiTemperature || 0.8;
    const apiTopP = state.globalSettings.apiTopP !== undefined ? state.globalSettings.apiTopP : 1.0;
    const apiPresencePenalty = state.globalSettings.apiPresencePenalty !== undefined ? state.globalSettings.apiPresencePenalty : 0.0;
    const apiFrequencyPenalty = state.globalSettings.apiFrequencyPenalty !== undefined ? state.globalSettings.apiFrequencyPenalty : 0.0;
    const roleType = {
      user: 'user',
      assistant: 'model',
      system: 'user'
    };


    const contents = [{
      role: 'user',
      parts: [{
        text: systemInstruction
      }]
    },
    {
      role: 'model',
      parts: [{
        text: '好的，我明白了。我会严格遵守以上所有规则和设定。'
      }]
    },

    ...messagesForDecision.map((item) => {
      const parts = [];

      if (Array.isArray(item.content)) {
        item.content.forEach(part => {
          if (part.type === 'text') {
            parts.push({
              text: part.text
            });
          } else if (part.type === 'image_url' && part.image_url && part.image_url.url) {

            const currentImageData = part.image_url.url;
            const base64Data = currentImageData.split(',')[1];
            const mimeTypeMatch = currentImageData.match(/^data:(.*);base64/);
            if (mimeTypeMatch && base64Data) {
              parts.push({
                inline_data: {
                  mime_type: mimeTypeMatch[1],
                  data: base64Data
                }
              });
            }
          }
        });
      } else {

        parts.push({
          text: String(item.content)
        });
      }
      return {
        role: roleType[item.role],
        parts: parts
      };
    })
    ];


    return {
      url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${getRandomValue(apiKey)}`,
      data: {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          contents: contents,
          generationConfig: {
            temperature: apiTemperature,
            topP: apiTopP,
            presencePenalty: apiPresencePenalty,
            frequencyPenalty: apiFrequencyPenalty,
          },
        })
      }
    };
  }



  async function uploadImageToImgBB(base64String) {
    // 1. 检查功能是否开启
    if (!state.apiConfig.imgbbEnable || !state.apiConfig.imgbbApiKey) {
      // console.log("ImgBB 未开启，返回原始 Base64。");
      return base64String; // 功能未开启，直接返回
    }

    // 2. 检查是否已经是 URL
    if (!base64String || !base64String.startsWith('data:image')) {
      // console.log("输入已是 URL 或为空，无需上传。");
      return base64String; // 已经是 URL 或为空，无需上传
    }

    // 3. 提取 Base64 数据
    // 格式为 data:image/png;base64,iVBORw0KGgo...
    const base64Data = base64String.split(',')[1];
    if (!base64Data) {
      console.warn("无法从字符串中提取 Base64 数据:", base64String.substring(0, 50) + "...");
      return base64String; // 格式错误，返回原文
    }

    console.log(`[ImgBB] 开始上传图片... (大小: ${(base64String.length / 1024).toFixed(1)} KB)`);

    try {
      const formData = new FormData();
      formData.append('image', base64Data);

      const response = await fetch(`https://api.imgbb.com/1/upload?key=${state.apiConfig.imgbbApiKey}`, {
        method: 'POST',
        body: formData
      });

      const result = await response.json();

      if (result.success && result.data && result.data.url) {
        console.log("[ImgBB] 上传成功! URL:", result.data.url);
        return result.data.url; // 成功！返回 URL
      } else {
        // ImgBB API 返回了错误
        throw new Error(result.error?.message || 'ImgBB API 返回了未知错误。');
      }
    } catch (error) {
      console.error("[ImgBB] 上传失败:", error);
      // 抛出错误，让调用此函数的上层逻辑知道上传失败了
      throw new Error(`ImgBB 上传失败: ${error.message}`);
    }
  }
  async function uploadFileToCatbox(fileObject) {
    // 1. 检查功能是否开启
    if (!state.apiConfig.catboxEnable || !state.apiConfig.catboxUserHash) {
      console.log("[Catbox] 功能未开启或未配置 User Hash，跳过上传。");
      return null; // 功能未开启，返回 null 以便回退
    }

    const userHash = state.apiConfig.catboxUserHash;
    console.log(`[Catbox] 开始上传文件: ${fileObject.name || 'blob.mp3'}... (大小: ${(fileObject.size / 1024 / 1024).toFixed(2)} MB)`);

    try {
      const formData = new FormData();
      formData.append('reqtype', 'fileupload');
      formData.append('userhash', userHash);
      formData.append('fileToUpload', fileObject, fileObject.name || 'track.mp3'); // 提供文件名

      // ▼▼▼ 【核心修复】 ▼▼▼
      // 1. 定义 Catbox API URL
      let apiUrl = 'https://catbox.moe/user/api.php';

      // 2. 获取 CORS 代理设置 (复用 NovelAI 的设置)
      const proxySettings = getNovelAISettings(); // This function is around line 4504
      let corsProxy = proxySettings.cors_proxy;
      if (corsProxy === 'custom') {
        corsProxy = proxySettings.custom_proxy_url || '';
      }

      // 3. 如果代理存在, 则使用代理
      if (corsProxy && corsProxy !== '') {
        // 【重要】Catbox API URL 不需要编码，而 NovelAI 需要，这里我们直接拼接
        apiUrl = corsProxy + apiUrl;
        console.log(`[Catbox] 检测到CORS代理，使用代理上传: ${apiUrl}`);
      } else {
        console.log("[Catbox] 未配置CORS代理，尝试直连... (这很可能会失败)");
      }
      // ▲▲▲ 【修复结束】 ▲▲▲

      const response = await fetch(apiUrl, { // <-- 替换为 apiUrl
        method: 'POST',
        body: formData
      });

      const responseText = await response.text();

      if (response.ok && responseText.startsWith('http')) {
        console.log("[Catbox] 上传成功! URL:", responseText);
        return responseText; // 成功！返回 URL
      } else {
        // Catbox API 返回了错误文本
        throw new Error(responseText || 'Catbox API 返回了未知错误。');
      }
    } catch (error) {
      console.error("[Catbox] 上传失败:", error);
      // 抛出错误，让调用此函数的上层逻辑知道上传失败了
      // 【重要】我们在这里只抛出原始错误，以便上层函数可以捕获并显示它
      throw error;
    }
  }
  async function silentlyUpdateDbUrl(table, recordId, pathString, base64ToFind, nameToMatch = null) {
    if (!state.apiConfig.imgbbEnable || !state.apiConfig.imgbbApiKey) {
      console.log(`[ImgBB Silent Update] ImgBB is disabled, skipping silent upload for ${table.name}.${recordId}.${pathString}.`);
      return; // ImgBB not enabled, do nothing.
    }

    let imageUrl;
    try {
      imageUrl = await uploadImageToImgBB(base64ToFind);
      if (imageUrl === base64ToFind) {
        console.log("[ImgBB Silent Update] Upload returned Base64 (or failed), no update needed.");
        return; // Upload failed or was skipped
      }
    } catch (uploadError) {
      console.error(`[ImgBB Silent Update] Background upload failed for ${table.name}.${recordId}.${pathString}:`, uploadError.message);
      return; // Upload failed
    }

    console.log(`[ImgBB Silent Update] Success. New URL: ${imageUrl}. Finding record to update...`);

    try {
      const record = await table.get(recordId);
      if (!record) {
        console.warn(`[ImgBB Silent Update] Could not find record ${recordId} in table ${table.name}.`);
        return;
      }

      let updated = false;

      // 辅助函数：通过路径字符串深入对象，返回父级和最后的键
      function getNestedParent(obj, path) {
        const keys = path.split('.');
        let current = obj;
        for (let i = 0; i < keys.length - 1; i++) {
          if (current[keys[i]] === undefined || current[keys[i]] === null) {
            console.warn(`[ImgBB Silent Update] Invalid path: ${path} in record at key ${keys[i]}.`);
            return null; // Path does not exist
          }
          current = current[keys[i]];
        }
        return { parent: current, finalKey: keys[keys.length - 1] };
      }

      if (nameToMatch) {
        // --- 逻辑 A: 搜索数组 ---
        const result = getNestedParent(record, pathString);
        if (result && Array.isArray(result.parent[result.finalKey])) {
          const arrayToSearch = result.parent[result.finalKey];
          const itemToUpdate = arrayToSearch.find(item => item.url === base64ToFind && item.name === nameToMatch);

          if (itemToUpdate) {
            itemToUpdate.url = imageUrl;
            updated = true;
            console.log(`[ImgBB Silent Update] Found and updated item "${nameToMatch}" in array ${pathString}.`);
          } else {
            console.warn(`[ImgBB Silent Update] Could not find item "${nameToMatch}" with matching Base64 in array ${pathString} to update.`);
          }
        } else {
          console.warn(`[ImgBB Silent Update] Path ${pathString} did not resolve to a valid array.`);
        }
      } else {
        // --- 逻辑 B: 更新简单属性 (如 'url' 或 'widgetData.polaroid-img-1') ---
        const result = getNestedParent(record, pathString);
        if (result && result.parent[result.finalKey] === base64ToFind) {
          result.parent[result.finalKey] = imageUrl;
          updated = true;
          console.log(`[ImgBB Silent Update] Found and updated simple path ${pathString}.`);
        } else if (result) {
          console.warn(`[ImgBB Silent Update] Value changed since upload for ${pathString}. Expected Base64, found: ${String(result.parent[result.finalKey]).substring(0, 30)}...`);
        } else {
          console.warn(`[ImgBB Silent Update] Path ${pathString} did not resolve to a matching string.`);
        }
      }


      if (updated) {
        await table.put(record);
        console.log(`[ImgBB Silent Update] Successfully updated DB for ${table.name}.${recordId}.${pathString}.`);

        // 更新内存 (state.globalSettings)
        if (table.name === 'globalSettings' && recordId === 'main') {
          // (重新获取更新后的内存状态)
          const stateResult = getNestedParent(state, `globalSettings.${pathString}`);
          if (nameToMatch && stateResult && Array.isArray(stateResult.parent[stateResult.finalKey])) {
            const stateArray = stateResult.parent[stateResult.finalKey];
            const stateItem = stateArray.find(item => item.url === base64ToFind && item.name === nameToMatch);
            if (stateItem) stateItem.url = imageUrl;
          } else if (!nameToMatch && stateResult && stateResult.parent[stateResult.finalKey] === base64ToFind) {
            stateResult.parent[stateResult.finalKey] = imageUrl;
          }
          console.log(`[ImgBB Silent Update] In-memory state.globalSettings updated.`);
        }
      }
    } catch (dbError) {
      console.error(`[ImgBB Silent Update] Failed to save updated URL to DB for ${table.name}.${recordId}.${pathString}:`, dbError);
    }
  }


  // ========== 提示词变量替换与旧版兼容 ==========
  function replaceTemplateVars(template, contextMap) {
    if (!template) return '';
    let p = template;
    
    // 1. 粗犷替换旧版的复杂 ${...} 表达式，映射为新版 {{...}}
    p = p.replace(/\$\{chat\.originalName\}/g, '{{chat.originalName}}');
    p = p.replace(/\$\{chat\.name\}/g, '{{chat.name}}');
    p = p.replace(/\$\{chat\.settings\.aiPersona\}/g, '{{aiPersona}}');
    p = p.replace(/\$\{latestThoughtContext\}/g, '{{latestThoughtContext}}');
    p = p.replace(/\$\{worldBookContent\s*\|\|[^}]*\}/g, '{{worldBookContent}}');
    p = p.replace(/\$\{worldBookContent\}/g, '{{worldBookContent}}');
    p = p.replace(/\$\{getMemoryContextForPrompt\(chat\)\}/g, '{{memoryContextForPrompt}}');
    p = p.replace(/\$\{multiLayeredSummaryContext\}/g, '{{multiLayeredSummaryContext}}');
    p = p.replace(/\$\{multiLayeredSummaryContext_group\}/g, '{{multiLayeredSummaryContext_group}}');
    p = p.replace(/\$\{todoListContext\}/g, '{{todoListContext}}');
    p = p.replace(/\$\{todoInstruction\}/g, '{{todoInstruction}}');
    p = p.replace(/\$\{periodSummaryContext\}/g, '{{periodSummaryContext}}');
    p = p.replace(/\$\{myNickname\}/g, '{{myNickname}}');
    p = p.replace(/\$\{myOriginalName\}/g, '{{myOriginalName}}');
    p = p.replace(/\$\{chat\.settings\.myPersona[^\}]*\}/g, '{{myPersona}}');
    
    // 特别处理连着两个 ${} 的 status，如 ${chat.settings.userStatus ? ...} ${chat...}
    p = p.replace(/\$\{chat\.settings\.userStatus[^\n]*?\}\s*(?:\$\{chat\.settings\.userStatus[^\}]*\})?/g, '{{userStatus}}');
    
    p = p.replace(/\$\{userProfileContext\}/g, '{{userProfileContext}}');
    p = p.replace(/\$\{nameHistoryContext\}/g, '{{nameHistoryContext}}');
    
    p = p.replace(/\$\{chat\.settings\.enableTimePerception[^\n]*\}/g, '{{timePerceptionContext}}');
    p = p.replace(/\$\{weatherContext\}/g, '{{weatherContext}}');
    p = p.replace(/\$\{timeContext\}/g, '{{timeContext}}');
    p = p.replace(/\$\{timeContextText\}/g, '{{groupTimeContextText}}');
    p = p.replace(/\$\{musicContext\s*\?[^\n]*\}/g, '{{musicContextStr}}');
    p = p.replace(/\$\{readingContext\s*\?[^\n]*\}/g, '{{readingContextStr}}');
    p = p.replace(/\$\{contactsList\}/g, '{{contactsList}}');
    p = p.replace(/\$\{postsContext\}/g, '{{postsContext}}');
    p = p.replace(/\$\{groupContext\}/g, '{{groupContext}}');
    p = p.replace(/\$\{gomokuContext\}/g, '{{gomokuContext}}');
    p = p.replace(/\$\{sharedContext\}/g, '{{sharedContext}}');
    p = p.replace(/\$\{callTranscriptContext\}/g, '{{callTranscriptContext}}');
    p = p.replace(/\$\{synthMusicInstruction\}/g, '{{synthMusicInstruction}}');
    p = p.replace(/\$\{narratorInstruction\}/g, '{{narratorInstruction}}');
    p = p.replace(/\$\{kinshipContext\}/g, '{{kinshipContext}}');
    p = p.replace(/\$\{coupleSpaceContext\}/g, '{{coupleSpaceContext}}');
    p = p.replace(/\$\{thoughtsPrompt\}/g, '{{thoughtsPrompt}}');
    p = p.replace(/\$\{stickerContext\}/g, '{{stickerContext}}');
    p = p.replace(/\$\{chat\.settings\.aiAvatarLibrary[^\n]*\}/g, '{{aiAvatarLibrary}}');
    p = p.replace(/\$\{chat\.settings\.myAvatarLibrary[^\n]*\}/g, '{{myAvatarLibrary}}');

    p = p.replace(/\$\{chat\.longTermMemory[\s\S]*?暂无\)'\}/g, '{{memoryContextForPrompt}}');
    p = p.replace(/\$\{chat\.settings\.enableDynamicCurrency[\s\S]*?CNY[\s\S]*?''\}/g, '');
    p = p.replace(/\$\{chat\.settings\.enableDynamicCurrency[\s\S]*?货币与汇率信息[\s\S]*?''\}/g, '{{currencyExchangeContext}}');
    p = p.replace(/\$\{chat\.settings\.enableDynamicCurrency[\s\S]*?注意：你可以自由选择货币[\s\S]*?''\}/g, '');
    p = p.replace(/\$\{historySlice[\s\S]*?join\('\\n'\)\}/g, '{{historySliceStr}}');
    p = p.replace(/\$\{membersWithContacts\}/g, '{{membersWithContacts}}');
    p = p.replace(/\$\{membersList\}/g, '{{membersList}}');
    p = p.replace(/\$\{longTermMemoryContext\}/g, '{{longTermMemoryContext}}');
    p = p.replace(/\$\{linkedMemoryContext\}/g, '{{linkedMemoryContext}}');
    p = p.replace(/\$\{presetContext\}/g, '{{presetContext}}');
    p = p.replace(/\$\{minLength\}/g, '{{minLength}}');
    p = p.replace(/\$\{maxLength\}/g, '{{maxLength}}');
    p = p.replace(/\$\{formatRules\}/g, '{{formatRules}}');
    p = p.replace(/\$\{userDisplayNameForAI\}/g, '{{userDisplayNameForAI}}');
    p = p.replace(/\$\{recentHistory\}/g, '{{recentHistory}}');
    p = p.replace(/\$\{auctionContext\}/g, '{{auctionContext}}');
    p = p.replace(/\$\{charList\}/g, '{{charList}}');
    p = p.replace(/\$\{truthGameHistoryContext\}/g, '{{truthGameHistoryContext}}');
    p = p.replace(/\$\{question\}/g, '{{question}}');
    p = p.replace(/\$\{userPersona\}/g, '{{userPersona}}');
    p = p.replace(/\$\{shortTermMemoryContext\}/g, '{{shortTermMemoryContext}}');
    p = p.replace(/\$\{mountedMemoryContext\}/g, '{{mountedMemoryContext}}');
    p = p.replace(/\$\{mainChatHistory\s*\|\|\s*'无'\}/g, '{{mainChatHistory}}');
    p = p.replace(/\$\{drawGuessHistory\s*\|\|\s*'无'\}/g, '{{drawGuessHistory}}');
    p = p.replace(/\$\{drawGuessHistory\s*\|\|\s*'（游戏刚开始）'\}/g, '{{drawGuessHistory}}');
    p = p.replace(/\$\{userNickname\}/g, '{{userNickname}}');
    p = p.replace(/\$\{canvasContentDescription\}/g, '{{canvasContentDescription}}');
    p = p.replace(/\$\{shortTermMemory\s*\|\|\s*'（暂无）'\}/g, '{{shortTermMemory}}');
    p = p.replace(/\$\{longTermMemory\s*\|\|\s*'（暂无）'\}/g, '{{longTermMemory}}');
    p = p.replace(/\$\{finalInstruction\}/g, '{{finalInstruction}}');
    p = p.replace(/\$\{new Date\(\)\.toLocaleDateString\('zh-CN'\)\}/g, '{{currentDate}}');

    // 针对任意剩余的 ${xxx}，仅匹配由字母、数字、下划线、小数点组成的变量，避免破坏复杂的脚本结构
    p = p.replace(/\$\{([a-zA-Z0-9_.]+)\}/g, '{{$1}}');

    // 2. 将 {{xxx}} 变量映射到 contextMap 真实数据
    return p.replace(/\{\{([^{}]+)\}\}/g, (match, key) => {
      const k = key.trim();
      
      if (contextMap[k] !== undefined) return contextMap[k];
      
      // 支持自定义心声变量替换
      const activeChatId = state.activeChatId;
      if (activeChatId && state.chats[activeChatId]) {
        const currentChat = state.chats[activeChatId];
        if (currentChat.customThoughts && currentChat.customThoughts[k] !== undefined) {
          return currentChat.customThoughts[k];
        }
      }
      
      // 模糊匹配兜底（防用户写错变量名）
      if (k === 'chat.originalName') return contextMap['chat.originalName'] !== undefined ? contextMap['chat.originalName'] : match;
      if (k === 'chat.name') return contextMap['chat.name'] !== undefined ? contextMap['chat.name'] : match;
      if (k.includes('aiPersona')) return contextMap['aiPersona'] !== undefined ? contextMap['aiPersona'] : match;
      if (k.includes('worldBookContent')) return contextMap['worldBookContent'] !== undefined ? contextMap['worldBookContent'] : match;
      if (k.includes('getMemoryContextForPrompt')) return contextMap['memoryContextForPrompt'] !== undefined ? contextMap['memoryContextForPrompt'] : match;
      if (k.includes('myPersona')) return contextMap['myPersona'] !== undefined ? contextMap['myPersona'] : match;
      if (k.includes('userStatus')) return contextMap['userStatus'] !== undefined ? contextMap['userStatus'] : match;
      if (k.includes('timePerception') || k.includes('currentTime')) return contextMap['timePerceptionContext'] !== undefined ? contextMap['timePerceptionContext'] : match;
      if (k.includes('musicContext')) return contextMap['musicContextStr'] !== undefined ? contextMap['musicContextStr'] : match;
      if (k.includes('readingContext')) return contextMap['readingContextStr'] !== undefined ? contextMap['readingContextStr'] : match;
      if (k.includes('aiAvatarLibrary')) return contextMap['aiAvatarLibrary'] !== undefined ? contextMap['aiAvatarLibrary'] : match;
      if (k.includes('myAvatarLibrary')) return contextMap['myAvatarLibrary'] !== undefined ? contextMap['myAvatarLibrary'] : match;
      if (k === 'char_avatar') return contextMap['char_avatar'] !== undefined ? contextMap['char_avatar'] : match;
      if (k === 'user_avatar') return contextMap['user_avatar'] !== undefined ? contextMap['user_avatar'] : match;
      if (k === 'char_name') return contextMap['char_name'] !== undefined ? contextMap['char_name'] : match;
      if (k === 'char_remark') return contextMap['char_remark'] !== undefined ? contextMap['char_remark'] : match;
      if (k === 'user_name') return contextMap['user_name'] !== undefined ? contextMap['user_name'] : match;
      if (k === 'user_nickname') return contextMap['user_nickname'] !== undefined ? contextMap['user_nickname'] : match;
      if (k.includes('myNickname')) return contextMap['myNickname'] !== undefined ? contextMap['myNickname'] : match;
      
      return match;
    });
  }

  function parseAiResponse(content) {
    if (!content) return [{
      type: 'text',
      content: '(AI返回了空内容)'
    }];

    let trimmedContent = content.trim();
    let prefixResults = [];

    // 兼容AI回复中可能缺少开头 <thinking> 标签的情况
    const thinkingMatch = trimmedContent.match(/^(?:<thinking>)?([\s\S]*?)<\/thinking>/i);
    if (thinkingMatch && thinkingMatch[1]) {
      prefixResults.push({
        type: 'thought_chain_block',
        content: thinkingMatch[1].trim()
      });
      trimmedContent = trimmedContent.slice(thinkingMatch[0].length).trim();
      if (!trimmedContent) return prefixResults;
    }

    const markdownRegex = /```json\s*([\s\S]*?)\s*```/;
    const markdownMatch = trimmedContent.match(markdownRegex);

    if (markdownMatch && markdownMatch[1]) {

      trimmedContent = markdownMatch[1].trim();
      console.log("解析器：已启用 Markdown 提取模式。");
    }


    if (trimmedContent.startsWith('[') && trimmedContent.endsWith(']')) {
      try {
        const parsed = JSON.parse(trimmedContent);
        if (Array.isArray(parsed)) {
          console.log("解析成功：标准JSON数组格式。");
          return prefixResults.concat(parsed);
        }
      } catch (e) {
        console.warn("标准JSON数组解析失败，将尝试强力提取...");
      }
    }


    const startIndex = trimmedContent.indexOf('[');


    const lastBraceIndex = trimmedContent.lastIndexOf('}');

    if (startIndex !== -1 && lastBraceIndex !== -1 && lastBraceIndex > startIndex) {


      const endIndex = trimmedContent.indexOf(']', lastBraceIndex);

      if (endIndex !== -1) {
        const arrayString = trimmedContent.substring(startIndex, endIndex + 1);
        try {
          const parsed = JSON.parse(arrayString);
          if (Array.isArray(parsed)) {
            console.log("解析成功：通过强力提取 [ ... } ... ] 模式。");
            return prefixResults.concat(parsed);
          }
        } catch (e) {
          console.warn("强力提取 [ ... } ... ] 失败，将尝试提取单个对象...");
        }
      }
    }


    const jsonMatches = trimmedContent.match(/{[^{}]*}/g);
    if (jsonMatches) {
      const results = [];
      for (const match of jsonMatches) {
        try {
          const parsedObject = JSON.parse(match);
          results.push(parsedObject);
        } catch (e) {
          console.warn("跳过一个无效的JSON片段:", match);
        }
      }

      if (results.length > 0) {
        console.log("解析成功：通过强力提取 {...} 模式。");
        return prefixResults.concat(results);
      }
    }


    console.error("所有解析方案均失败！将返回原始文本。原始回复:", content);
    return prefixResults.concat([{
      type: 'text',
      content: trimmedContent || content
    }]);
  }

  function getStreamDeltaText(delta) {
    if (!delta) return '';

    if (typeof delta.content === 'string') {
      return delta.content;
    }

    if (Array.isArray(delta.content)) {
      return delta.content.map(part => {
        if (typeof part === 'string') return part;
        if (typeof part?.text === 'string') return part.text;
        return '';
      }).join('');
    }

    return '';
  }

  async function readOpenAiStreamResponse(response, onChunk) {
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('当前响应不支持流式读取。');
    }

    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let fullText = '';

    function processEventBlock(block) {
      const lines = block.split(/\r?\n/);

      for (const line of lines) {
        if (!line.startsWith('data:')) continue;

        const payload = line.slice(5).trim();
        if (!payload) continue;
        if (payload === '[DONE]') return true;

        try {
          const json = JSON.parse(payload);
          const deltaText = getStreamDeltaText(json.choices?.[0]?.delta);
          if (!deltaText) continue;

          fullText += deltaText;
          if (typeof onChunk === 'function') {
            onChunk(fullText, json);
          }
        } catch (error) {
          console.warn('流式分片解析失败，已跳过:', payload, error);
        }
      }

      return false;
    }

    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });

      const eventBlocks = buffer.split(/\r?\n\r?\n/);
      buffer = eventBlocks.pop() || '';

      for (const block of eventBlocks) {
        if (processEventBlock(block)) {
          return fullText;
        }
      }

      if (done) {
        const remaining = buffer.trim();
        if (remaining) {
          processEventBlock(remaining);
        }
        return fullText;
      }
    }
  }


  async function triggerSpectatorGroupAiAction() {
    if (!state.activeChatId) return;
    const chatId = state.activeChatId;
    const chat = state.chats[chatId];
    lastRawAiResponse = '';
    lastResponseTimestamps = [];
    const propelBtn = document.getElementById('spectator-propel-btn');
    if (propelBtn) {
      propelBtn.disabled = true;
      propelBtn.textContent = '思考中...';
    }
    setAvatarActingState(chatId, true);

    try {
      // 获取API配置（优先使用角色独立配置）
      let apiConfig = state.apiConfig;
      if (chat.apiOverride && chat.apiOverride.enabled) {
        apiConfig = {
          proxyUrl: chat.apiOverride.proxyUrl || state.apiConfig.proxyUrl,
          apiKey: chat.apiOverride.apiKey || state.apiConfig.apiKey,
          model: chat.apiOverride.model || state.apiConfig.model
        };
      }
      
      const {
        proxyUrl,
        apiKey,
        model
      } = apiConfig;
      
      if (!proxyUrl || !apiKey || !model) {
        throw new Error('API未配置，无法生成对话。');
      }






      const maxMemory = parseInt(chat.settings.maxMemory) || 10;
      const historySlice = chat.history.filter(m => !m.isExcluded && m.type !== 'thought_chain_block').slice(-maxMemory);
      const filteredHistory = await filterHistoryWithDoNotSendRules(historySlice, chatId);
      const thoughtChainMode = chat.settings && chat.settings.isOfflineMode ? 'offline' : 'chat';
      const thoughtChainChunks = (typeof ThoughtChainManager !== 'undefined')
        ? ThoughtChainManager.getPayloadChunks(thoughtChainMode)
        : { head: [], middle: [], bottom: [] };
      const thoughtChainContextHead = thoughtChainChunks.head.map(c => c.content).join('\n');
      const thoughtChainContextMiddle = thoughtChainChunks.middle.map(c => c.content).join('\n');

      let worldBookContent = '';
      // 获取所有应该使用的世界书ID（包括手动选择的和全局的）
      let allWorldBookIds = [...(chat.settings.linkedWorldBookIds || [])];
      // 添加所有全局世界书
      state.worldBooks.forEach(wb => {
        if (wb.isGlobal && !allWorldBookIds.includes(wb.id)) {
          allWorldBookIds.push(wb.id);
        }
      });

      if (allWorldBookIds.length > 0) {
        const linkedContents = allWorldBookIds.map(bookId => {
          const worldBook = state.worldBooks.find(wb => wb.id === bookId);
          if (!worldBook || !Array.isArray(worldBook.content)) return '';
          const formattedEntries = worldBook.content
            .filter(entry => entry.enabled !== false)
            .map(entry => {
              let entryString = `\n### 条目: ${entry.comment || '无备注'}\n`;

              entryString += `**内容:**\n${entry.content}`;
              return entryString;
            }).join('');
          return formattedEntries ? `\n\n## 世界书: ${worldBook.name}\n${formattedEntries}` : '';
        }).filter(Boolean).join('');
        if (linkedContents) {
          worldBookContent = `# --- 世界书 (World Book) ---
# 【最高优先级指令：绝对真理】
# 以下内容是你所在世界的"物理法则"和"基础常识"。
# 无论用户是否提及，你都【必须】时刻主动应用这些设定来指导你的思考和描写。
# 它们是无条件生效的，不需要触发词。
${linkedContents}
# --- 世界书设定结束 ---
`;
        }
      }


      let longTermMemoryContext = '# 长期记忆 (最高优先级，这是群内已经确立的事实，所有角色必须严格遵守)\n';
      let collectedMemories = false;
      const includeUserMemoryIds = chat.settings.spectatorIncludeUserMemoryForMemberIds;
      const allowMemberMemory = (member) => !includeUserMemoryIds || includeUserMemoryIds.includes(member.id);

      // 构建用于向量检索的查询词（如果有）
      const queryTextForVector = filteredHistory.slice(-5).map(m => typeof m.content === 'string' ? m.content : '').join(' ');

      for (const member of chat.members) {
        if (!allowMemberMemory(member)) continue;
        const memberChat = state.chats[member.id];
        if (memberChat) {
          const memMode = memberChat.settings?.memoryMode || (memberChat.settings?.enableStructuredMemory ? 'structured' : 'diary');
          let memberMemContent = '';
          
          if (memMode === 'vector' && window.vectorMemoryManager) {
            memberMemContent = await window.vectorMemoryManager.serializeForPrompt(memberChat, queryTextForVector);
          } else if (memMode === 'structured' && window.structuredMemoryManager) {
            memberMemContent = window.structuredMemoryManager.serializeForPrompt(memberChat);
          } else if (memberChat.longTermMemory && memberChat.longTermMemory.length > 0) {
            memberMemContent = memberChat.longTermMemory.map(mem => `- (记录于 ${formatTimeAgo(mem.timestamp)}) ${mem.content}`).join('\n');
          }

          if (memberMemContent && memberMemContent.trim() !== '') {
            longTermMemoryContext += `\n## --- 关于"${member.groupNickname}"的记忆 ---\n`;
            longTermMemoryContext += memberMemContent;
            collectedMemories = true;
          }
        }
      }

      if (!collectedMemories) {
        longTermMemoryContext += '- (暂无)';
      }


      let linkedMemoryContext = '';
      const memoryCount = chat.settings.linkedMemoryCount || 10;
      if (chat.settings.linkedMemoryChatIds && chat.settings.linkedMemoryChatIds.length > 0) {

      }

      const membersList = chat.members.map(m => `- **${m.groupNickname}** (本名: ${m.originalName}): ${m.persona}`).join('\n');
      const stickerContext = getGroupStickerContextForPrompt(chat);
      let aiAgeContext = getDynamicAgeContext(chat);
      let currencyExchangeContext = chat.settings.enableDynamicCurrency ? getCurrencyExchangeContext() : '';

      let systemPromptTemplate = window.getActiveChatPrompt ? window.getActiveChatPrompt('spectator') : '';
      
      const contextMap = {
        'thoughtChainContextHead': thoughtChainContextHead,
        'thoughtChainContextMiddle': thoughtChainContextMiddle,
        'aiAgeContext': aiAgeContext,
        'currencyExchangeContext': currencyExchangeContext,
        'char_avatar': chat.isGroup ? (chat.settings.groupAvatar || 'https://i.postimg.cc/y8xWzCqj/anime-boy.jpg') : (chat.settings.aiAvatar || 'https://i.postimg.cc/y8xWzCqj/anime-boy.jpg'),
        'user_avatar': chat.settings.myAvatar || (state.qzoneSettings && state.qzoneSettings.avatar) || 'https://i.postimg.cc/y8xWzCqj/anime-boy.jpg',
        'char_name': chat.originalName,
        'char_remark': chat.name,
        'user_name': (state.qzoneSettings && state.qzoneSettings.nickname) || '用户',
        'user_nickname': chat.settings.myNickname || '我',
        'chat.name': chat.name,
        'longTermMemoryContext': longTermMemoryContext,
        'worldBookContent': worldBookContent,
        'linkedMemoryContext': linkedMemoryContext,
        'historySliceStr': historySlice.map(msg => `${getDisplayNameInGroup(chat, msg.senderName)}: ${msg.content}`).join('\n'),
        'membersList': membersList,
        'stickerContext': stickerContext
      };
      
      systemPrompt = replaceTemplateVars(systemPromptTemplate, contextMap);

      systemPrompt = processPromptWithSettings(systemPrompt, 'spectator');

      if (chat.settings.isOfflineMode) {
        const participantNames = chat.members.map(m => m.groupNickname || m.originalName).join('、');
        const minLength = chat.settings.offlineMinLength || 100;
        const maxLength = chat.settings.offlineMaxLength || 300;
        systemPrompt += `\n# 【【【线下聚会模式 (最高优先级)】】】\n- **当前情景**: 你们现在正处于【线下现实聚会】状态，不在网络群聊中！大家正面对面聚在一起。\n- **现场人员**: 现场有【${participantNames}】（注意：本次聚会用户不在场）。\n- **行为规范**: \n  - 你们可以产生互相的肢体接触、观察对方的神态、注意周围的环境。\n  - 请在发言的文本内容中，像小说一样自然地加入动作、神态、环境描写（建议将动作描写用括号或星号包裹，比如：*喝了一口咖啡*）。\n  - 绝不能表现出"正在用手机打字群聊"的状态！\n  - **【重要字数要求】**: 每个角色的单次回复文本长度必须在 ${minLength} 到 ${maxLength} 字之间。\n  - **绝对注意**: 这个字数限制是针对【每一个发言的角色】单独计算的，绝不是所有人的字数总和！请确保每个人的描写都足够充实。\n`;
      }

      const messagesPayload = filteredHistory.map(msg => ({
        role: 'user',
        content: `${getDisplayNameInGroup(chat, msg.senderName)}: ${msg.content}`
      }));

      let isGemini = proxyUrl.includes('generativelanguage.googleapis.com');
      let response;

      if (isGemini) {
        let geminiConfig = toGeminiRequestData(model, apiKey, systemPrompt, messagesPayload);
        response = await fetch(geminiConfig.url, geminiConfig.data);
      } else {
      let reqBody = {
            model: model,
            messages: [{
              role: 'system',
              content: systemPrompt
            }, ...messagesPayload],
            temperature: state.globalSettings.apiTemperature || 0.9
        };
        if (state.globalSettings.apiTopPEnabled && state.globalSettings.apiTopP !== undefined) reqBody.top_p = state.globalSettings.apiTopP;
        if (state.globalSettings.apiMaxTokensEnabled && state.globalSettings.apiMaxTokens > 0) reqBody.max_tokens = state.globalSettings.apiMaxTokens;
        if (state.globalSettings.apiPresencePenaltyEnabled && state.globalSettings.apiPresencePenalty !== undefined) reqBody.presence_penalty = state.globalSettings.apiPresencePenalty;
        if (state.globalSettings.apiFrequencyPenaltyEnabled && state.globalSettings.apiFrequencyPenalty !== undefined) reqBody.frequency_penalty = state.globalSettings.apiFrequencyPenalty;
        response = await fetch(`${proxyUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
          },
          body: JSON.stringify(reqBody)
        });
      }





      if (!response.ok) {
        const errorData = await response.json().catch(() => ({
          error: {
            message: response.statusText
          }
        }));
        throw new Error(`API 请求失败: ${response.status} - ${errorData.error?.message || '未知错误'}`);
      }

      const data = await response.json();
      const aiResponseContent = getGeminiResponseText(data);
      lastRawAiResponse = aiResponseContent;
      const messagesArray = parseAiResponse(aiResponseContent);






      let messageTimestamp = Date.now();
      for (const msgData of messagesArray) {

        if (!msgData || !msgData.type || !msgData.name) continue;

        // 纠正AI可能返回群昵称而非本名的问题
        if (chat.isGroup && msgData.name) {
          const exactMember = chat.members.find(m => m.originalName === msgData.name);
          if (!exactMember) {
            const nicknameMember = chat.members.find(m => m.groupNickname === msgData.name);
            if (nicknameMember) {
              msgData.name = nicknameMember.originalName;
            }
          }
        }

        let aiMessage = null;
        const currentMessageTimestamp = messageTimestamp++;
        lastResponseTimestamps.push(currentMessageTimestamp);
        const baseMessage = {
          role: 'assistant',
          senderName: msgData.name,
          timestamp: currentMessageTimestamp
        };

        if (msgData.type === 'ai_image') {
          if (localStorage.getItem('novelai-enabled') === 'true') {
            msgData.type = 'naiimag';
            msgData.prompt = msgData.image_prompt || msgData.description || 'a beautiful scene';
          } else if (localStorage.getItem('google-imagen-enabled') === 'true') {
            msgData.type = 'googleimag';
            msgData.prompt = msgData.image_prompt || msgData.description || 'a beautiful scene';
          }
        }

        switch (msgData.type) {
          case 'text':
            aiMessage = {
              ...baseMessage,
              content: msgData.content
            };
            break;
          case 'sticker':
            if (msgData.meaning) {
              const sticker = findBestStickerMatch(msgData.meaning, state.userStickers);
              if (sticker) {
                aiMessage = {
                  ...baseMessage,
                  type: 'sticker',
                  content: sticker.url,
                  meaning: sticker.name
                };
              } else {
                console.warn(`旁观模式AI尝试使用不存在的表情: "${msgData.meaning}"`);
                aiMessage = null;
              }
            } else {
              console.warn("旁观模式AI发送了一个没有 'meaning' 的 sticker 指令。", msgData);
            }
            break;
          case 'ai_image':

            aiMessage = {
              ...baseMessage,
              type: 'ai_image',
              content: msgData.description,
              image_prompt: msgData.image_prompt
            };
            break;
          case 'voice_message':

            aiMessage = {
              ...baseMessage,
              type: 'voice_message',
              content: msgData.content
            };
            break;
          case 'quote_reply':

            const originalMessage = chat.history.find(m => m.timestamp === msgData.target_timestamp);
            if (originalMessage) {
              aiMessage = {
                ...baseMessage,
                content: msgData.reply_content,
                quote: {
                  timestamp: originalMessage.timestamp,
                  senderName: originalMessage.senderName,
                  content: String(originalMessage.content || '').substring(0, 50)
                }
              };
            } else {

              aiMessage = {
                ...baseMessage,
                content: msgData.reply_content
              };
            }
            break;
          default:
            console.warn("旁观模式收到未知指令类型:", msgData.type);
            continue;
        }

        if (aiMessage) {
          chat.history.push(aiMessage);
          appendMessage(aiMessage, chat);
          await new Promise(resolve => setTimeout(resolve, Math.random() * 1200 + 800));
        }
      }




      await db.chats.put(chat);
      renderChatList();

    } catch (error) {
      console.error("旁观模式推进剧情失败:", error);
      await showCustomAlert('操作失败', `无法推进剧情: ${error.message}`);
    } finally {
      if (propelBtn) {
        propelBtn.disabled = false;
        propelBtn.textContent = '🎬 推进剧情';
      }
      setAvatarActingState(chatId, false);
    }
  }

  async function triggerAiResponse() {
    if (!state.activeChatId) return;
    const chatId = state.activeChatId;
    const chat = state.chats[state.activeChatId];

      // role reply sanitizer v1: sanitize new assistant replies before saving/rendering.
      function escapeReplySanitizerRegExp(text) {
        const specials = "\\^$*+?.()|{}[]";
        return String(text).split("").map(function(ch) {
          return specials.indexOf(ch) >= 0 ? "\\" + ch : ch;
        }).join("");
      }

      function buildReplySanitizerRegExp(patternText) {
        let pattern = String(patternText || "").trim();
        let isRegex = false;
        if (pattern.startsWith("regex:")) {
          isRegex = true;
          pattern = pattern.slice(6).trim();
        }
        if (pattern.startsWith("/") && pattern.lastIndexOf("/") > 0) {
          isRegex = true;
        }
        if (!isRegex) {
          return new RegExp(escapeReplySanitizerRegExp(pattern), "g");
        }
        if (pattern.startsWith("/") && pattern.lastIndexOf("/") > 0) {
          const lastSlash = pattern.lastIndexOf("/");
          const source = pattern.slice(1, lastSlash);
          let flags = pattern.slice(lastSlash + 1) || "g";
          if (!flags.includes("g")) flags += "g";
          return new RegExp(source, flags);
        }
        return new RegExp(pattern, "g");
      }

      function applyReplySanitizerToText(text, rulesText) {
        let output = String(text || "");
        const ruleLines = String(rulesText || "").split(/\r?\n/);
        for (const rawLine of ruleLines) {
          const line = String(rawLine || "").trim();
          if (!line || line.startsWith("#") || line.startsWith("//")) continue;
          let sep = "=>";
          let idx = line.indexOf(sep);
          if (idx < 0) {
            sep = "->";
            idx = line.indexOf(sep);
          }
          if (idx < 0) continue;
          const pattern = line.slice(0, idx).trim();
          const replacement = line.slice(idx + sep.length);
          if (!pattern) continue;
          try {
            output = output.replace(buildReplySanitizerRegExp(pattern), replacement);
          } catch (error) {
            console.warn("AI 回复净化规则无效，已跳过:", line, error);
          }
        }
        return output;
      }

      function applyRoleReplySanitizer(aiMessage, currentChat) {
        if (!aiMessage || !currentChat || !currentChat.settings) return aiMessage;
        if (!currentChat.settings.enableReplySanitizer) return aiMessage;
        const rulesText = currentChat.settings.replySanitizerRulesText || "";
        if (!rulesText.trim()) return aiMessage;
        const allowedTypes = [null, undefined, "", "text", "voice_message", "offline_text"];
        if (!allowedTypes.includes(aiMessage.type)) return aiMessage;
        ["content", "dialogue", "description"].forEach(function(field) {
          if (typeof aiMessage[field] === "string") {
            aiMessage[field] = applyReplySanitizerToText(aiMessage[field], rulesText);
          }
        });
        return aiMessage;
      }

    let isViewingThisChat = document.getElementById('chat-interface-screen').classList.contains('active') && state.activeChatId === chatId;

    setAvatarActingState(chatId, true);
    const chatHeaderTitle = document.getElementById('chat-header-title');
    const typingIndicator = document.getElementById('typing-indicator');
    const stopBtn = document.getElementById('stop-api-call-btn');

    const chatListItem = document.querySelector(`.chat-list-item[data-chat-id="${chatId}"]`);
    const avatarInList = chatListItem ? chatListItem.querySelector('.avatar') : null;
    if (avatarInList) {
      avatarInList.classList.add('is-acting');
    }

    if (chat.isGroup) {
      if (typingIndicator) {
        typingIndicator.textContent = '成员们正在输入...';
        typingIndicator.style.display = 'block';
      }
    } else {
      if (chatHeaderTitle) {
        chatHeaderTitle.style.opacity = 0;
        setTimeout(() => {
          chatHeaderTitle.textContent = '对方正在输入...';
          chatHeaderTitle.classList.add('typing-status');
          chatHeaderTitle.style.opacity = 1;
        }, 200);
      }
    }
    let needsImmediateReaction = false;
    try {
      // 获取API配置（优先使用角色独立配置）
      let apiConfig = state.apiConfig;
      if (chat.apiOverride && chat.apiOverride.enabled) {
        apiConfig = {
          proxyUrl: chat.apiOverride.proxyUrl || state.apiConfig.proxyUrl,
          apiKey: chat.apiOverride.apiKey || state.apiConfig.apiKey,
          model: chat.apiOverride.model || state.apiConfig.model
        };
      }
      
      const {
        proxyUrl,
        apiKey,
        model
      } = apiConfig;
      
      if (!proxyUrl || !apiKey || !model) {
        alert('请先在API设置中配置反代地址、密钥并选择模型。');
        if (chat.isGroup) {
          if (typingIndicator) typingIndicator.style.display = 'none';
        } else {
          if (chatHeaderTitle && state.chats[chatId]) {
            chatHeaderTitle.textContent = state.chats[chatId].name;
            chatHeaderTitle.classList.remove('typing-status');
          }
        }
        return;
      }

      const lastMessage = chat.history.slice(-1)[0];
      const isVideoCallRequest = lastMessage && lastMessage.role === 'system' && lastMessage.content.includes('视频通话请求');
      const isVoiceCallRequest = lastMessage && lastMessage.role === 'system' && lastMessage.content.includes('语音通话请求');

      if (isVideoCallRequest) {
        console.log(`检测到视频通话请求，为角色 "${chat.name}" 触发专属决策流程...`);

        let callDecisionPrompt;
        if (chat.isGroup) {
          callDecisionPrompt = `
        # 你的任务
        群聊中的用户刚刚发起了群视频通话。请你分别扮演【每一个群成员】，根据他们各自的人设和与用户的关系，来决定是加入(join)还是拒绝(decline)。
        # 核心规则
        - 你的回复【必须】是一个JSON数组，为【每一个AI角色】都包含一个决策对象。
        - 格式: '[{"type": "group_call_response", "name": "角色A的本名", "decision": "join"}, {"type": "group_call_response", "name": "角色B的本名", "decision": "decline"}]'
        # 群成员列表及人设
        ${chat.members.map(m => `- ${m.groupNickname} (本名: ${m.originalName}): ${m.persona}`).join('\n')}
        现在，请为所有AI角色做出决策。`;
        } else {
          callDecisionPrompt = `
        # 你的任务
        用户刚刚向你发起了视频通话。请根据你的角色设定，决定是“接受”还是“拒绝”。
        # 你的角色设定
        ${chat.settings.aiPersona}
        # 核心规则
        你的回复【必须且只能】是以下两种格式之一的JSON数组，绝对不能回复任何其他内容：
        - 接受: '[{"type": "video_call_response", "decision": "accept"}]'
        - 拒绝: '[{"type": "video_call_response", "decision": "reject"}]'
        现在，请立即做出决策。`;
        }

        const messagesForCallDecision = [{
          role: 'user',
          content: callDecisionPrompt
        }];

        try {
          let geminiConfig = toGeminiRequestData(model, apiKey, callDecisionPrompt, messagesForCallDecision);
          let isGemini = proxyUrl === GEMINI_API_URL;
          const response = isGemini ? await fetch(geminiConfig.url, geminiConfig.data) : await fetch(`${proxyUrl}/v1/chat/completions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify((() => {
              let reqBody = {
                model: model,
                messages: messagesForCallDecision,
                temperature: 0.7,
                ...(state.globalSettings.apiTopPEnabled && state.globalSettings.apiTopP !== undefined ? { top_p: state.globalSettings.apiTopP } : {}),
                ...(state.globalSettings.apiMaxTokensEnabled && state.globalSettings.apiMaxTokens !== undefined ? { max_tokens: state.globalSettings.apiMaxTokens } : {}),
                ...(state.globalSettings.apiPresencePenaltyEnabled && state.globalSettings.apiPresencePenalty !== undefined ? { presence_penalty: state.globalSettings.apiPresencePenalty } : {}),
                ...(state.globalSettings.apiFrequencyPenaltyEnabled && state.globalSettings.apiFrequencyPenalty !== undefined ? { frequency_penalty: state.globalSettings.apiFrequencyPenalty } : {})
              };
              return reqBody;
            })())
          });

          if (!response.ok) {
            let errMsg = `HTTP ${response.status}`;
            try { const errData = await response.json(); errMsg = errData?.error?.message || errData?.message || errData?.detail || JSON.stringify(errData); } catch(e) { errMsg += ` (${response.statusText})`; }
            throw new Error(`API失败: ${errMsg}`);
          }

          const data = await response.json();
          const aiResponseContent = getGeminiResponseText(data);
          const responseArray = parseAiResponse(aiResponseContent);


          let callHasBeenHandled = false;
          for (const msgData of responseArray) {
            if (msgData.type === 'video_call_response') {
              videoCallState.isAwaitingResponse = false;
              if (msgData.decision === 'accept') {
                startVideoCall();
              } else {
                const aiMessage = {
                  role: 'assistant',
                  content: '对方拒绝了你的视频通话请求。',
                  timestamp: Date.now()
                };
                chat.history.push(aiMessage);
                await db.chats.put(chat);
                showScreen('chat-interface-screen');
                renderChatInterface(chatId);
              }
              callHasBeenHandled = true;
              break;
            }
            if (msgData.type === 'group_call_response') {
              if (msgData.decision === 'join') {
                const member = chat.members.find(m => m.originalName === msgData.name);
                if (member && !videoCallState.participants.some(p => p.id === member.id)) {
                  videoCallState.participants.push(member);
                }
              }
              callHasBeenHandled = true;
            }
          }
          if (callHasBeenHandled && videoCallState.isGroupCall) {
            videoCallState.isAwaitingResponse = false;
            if (videoCallState.participants.length > 0) {
              startVideoCall();
            } else {
              videoCallState = {
                ...videoCallState,
                isAwaitingResponse: false,
                participants: []
              };
              showScreen('chat-interface-screen');
              alert('无人接听群聊邀请。');
            }
          }

        } catch (error) {
          console.error("处理通话请求时API出错:", error);
          const fallbackResponse = chat.isGroup ?
            chat.members.map(m => ({
              type: "group_call_response",
              name: m.originalName,
              decision: "decline"
            })) : [{
              type: "video_call_response",
              decision: "reject"
            }];

          if (chat.isGroup) {
            videoCallState.isAwaitingResponse = false;
            videoCallState.participants = [];
            alert('无人接听群聊邀请。');
            showScreen('chat-interface-screen');
          } else {
            const aiMessage = {
              role: 'assistant',
              content: '对方拒绝了你的视频通话请求。',
              timestamp: Date.now()
            };
            chat.history.push(aiMessage);
            await db.chats.put(chat);
            showScreen('chat-interface-screen');
            renderChatInterface(chatId);
          }
        } finally {

          setAvatarActingState(chatId, false);
          return;
        }
      }

      if (isVoiceCallRequest) {
        console.log(`检测到语音通话请求，为角色 "${chat.name}" 触发专属决策流程...`);

        let callDecisionPrompt;
        if (chat.isGroup) {
          callDecisionPrompt = `
        # 你的任务
        群聊中的用户刚刚发起了群语音通话。请你分别扮演【每一个群成员】，根据他们各自的人设和与用户的关系，来决定是加入(join)还是拒绝(decline)。
        # 核心规则
        - 你的回复【必须】是一个JSON数组，为【每一个AI角色】都包含一个决策对象。
        - 格式: '[{"type": "group_voice_response", "name": "角色A的本名", "decision": "join"}, {"type": "group_voice_response", "name": "角色B的本名", "decision": "decline"}]'
        # 群成员列表及人设
        ${chat.members.map(m => `- ${m.groupNickname} (本名: ${m.originalName}): ${m.persona}`).join('\n')}
        现在，请为所有AI角色做出决策。`;
        } else {
          callDecisionPrompt = `
        # 你的任务
        用户刚刚向你发起了语音通话。请根据你的角色设定，决定是"接受"还是"拒绝"。
        # 你的角色设定
        ${chat.settings.aiPersona}
        # 核心规则
        你的回复【必须且只能】是以下两种格式之一的JSON数组，绝对不能回复任何其他内容：
        - 接受: '[{"type": "voice_call_response", "decision": "accept"}]'
        - 拒绝: '[{"type": "voice_call_response", "decision": "reject"}]'
        现在，请立即做出决策。`;
        }

        const messagesForCallDecision = [{
          role: 'user',
          content: callDecisionPrompt
        }];

        try {
          let geminiConfig = toGeminiRequestData(model, apiKey, callDecisionPrompt, messagesForCallDecision);
          let isGemini = proxyUrl === GEMINI_API_URL;
          const response = isGemini ? await fetch(geminiConfig.url, geminiConfig.data) : await fetch(`${proxyUrl}/v1/chat/completions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify((() => {
              let reqBody = {
                model: model,
                messages: messagesForCallDecision,
                temperature: 0.7,
                ...(state.globalSettings.apiTopPEnabled && state.globalSettings.apiTopP !== undefined ? { top_p: state.globalSettings.apiTopP } : {}),
                ...(state.globalSettings.apiMaxTokensEnabled && state.globalSettings.apiMaxTokens !== undefined ? { max_tokens: state.globalSettings.apiMaxTokens } : {}),
                ...(state.globalSettings.apiPresencePenaltyEnabled && state.globalSettings.apiPresencePenalty !== undefined ? { presence_penalty: state.globalSettings.apiPresencePenalty } : {}),
                ...(state.globalSettings.apiFrequencyPenaltyEnabled && state.globalSettings.apiFrequencyPenalty !== undefined ? { frequency_penalty: state.globalSettings.apiFrequencyPenalty } : {})
              };
              return reqBody;
            })())
          });

          if (!response.ok) {
            let errMsg = `HTTP ${response.status}`;
            try { const errData = await response.json(); errMsg = errData?.error?.message || errData?.message || errData?.detail || JSON.stringify(errData); } catch(e) { errMsg += ` (${response.statusText})`; }
            throw new Error(`API失败: ${errMsg}`);
          }

          const data = await response.json();
          const aiResponseContent = getGeminiResponseText(data);

          const jsonMatch = aiResponseContent.match(/(\[[\s\S]*?\])/);
          if (!jsonMatch) throw new Error("AI返回的决策中未找到有效的JSON数组。");

          const responseArray = JSON.parse(jsonMatch[0]);
          let callHasBeenHandled = false;

          for (const msgData of responseArray) {
            if (!msgData || typeof msgData !== 'object') {
              console.warn("收到了格式不规范的AI指令，已跳过:", msgData);
              continue;
            }
            if (!msgData.type) {
              if (chat.isGroup && msgData.name && msgData.message) {
                msgData.type = 'text';
              } else if (msgData.content) {
                msgData.type = 'text';
              } else {
                console.warn("收到了格式不规范的AI指令（缺少type和content），已跳过:", msgData);
                continue;
              }
            }

            if (msgData.type === 'voice_call_response') {
              voiceCallState.isAwaitingResponse = false;
              if (msgData.decision === 'accept') {
                startVoiceCall();
              } else {
                voiceCallState = {
                  isActive: false,
                  isAwaitingResponse: false,
                  isGroupCall: false,
                  activeChatId: null,
                  initiator: null,
                  startTime: null,
                  participants: [],
                  isUserParticipating: true,
                  callHistory: [],
                  preCallContext: ""
                };
                const aiMessage = {
                  role: 'assistant',
                  content: '对方拒绝了你的语音通话请求。',
                  timestamp: Date.now()
                };
                chat.history.push(aiMessage);
                await db.chats.put(chat);
                showScreen('chat-interface-screen');
                renderChatInterface(chatId);
              }
              callHasBeenHandled = true;
              break;
            }

            if (msgData.type === 'group_voice_response') {
              if (msgData.decision === 'join') {
                const member = chat.members.find(m => m.originalName === msgData.name);
                if (member && !voiceCallState.participants.some(p => p.id === member.id)) {
                  voiceCallState.participants.push(member);
                }
              }
              callHasBeenHandled = true;
            }
          }
          if (callHasBeenHandled && voiceCallState.isGroupCall) {
            voiceCallState.isAwaitingResponse = false;
            if (voiceCallState.participants.length > 0) {
              startVoiceCall();
            } else {
              voiceCallState = {
                isActive: false,
                isAwaitingResponse: false,
                isGroupCall: false,
                activeChatId: null,
                initiator: null,
                startTime: null,
                participants: [],
                isUserParticipating: true,
                callHistory: [],
                preCallContext: ""
              };
              showScreen('chat-interface-screen');
              alert('无人接听群聊邀请。');
            }
          }

        } catch (error) {
          console.error("处理语音通话请求时API出错:", error);

          if (chat.isGroup) {
            voiceCallState = {
              isActive: false,
              isAwaitingResponse: false,
              isGroupCall: false,
              activeChatId: null,
              initiator: null,
              startTime: null,
              participants: [],
              isUserParticipating: true,
              callHistory: [],
              preCallContext: ""
            };
            alert('无人接听群聊邀请。');
            showScreen('chat-interface-screen');
          } else {
            voiceCallState = {
              isActive: false,
              isAwaitingResponse: false,
              isGroupCall: false,
              activeChatId: null,
              initiator: null,
              startTime: null,
              participants: [],
              isUserParticipating: true,
              callHistory: [],
              preCallContext: ""
            };
            const aiMessage = {
              role: 'assistant',
              content: '对方拒绝了你的语音通话请求。',
              timestamp: Date.now()
            };
            chat.history.push(aiMessage);
            await db.chats.put(chat);
            showScreen('chat-interface-screen');
            renderChatInterface(chatId);
          }
        } finally {
          setAvatarActingState(chatId, false);
          return;
        }
      }




      if (!chat.isGroup && chat.relationship?.status === 'pending_ai_approval') {
        console.log(`为角色 "${chat.name}" 触发带理由的好友申请决策流程...`);
        const contextSummary = chat.history
          .filter(m => !m.isHidden)
          .slice(-10, -5)
          .map(msg => {
            const sender = msg.role === 'user' ? '用户' : chat.name;
            return `${sender}: ${String(msg.content).substring(0, 50)}...`;
          })
          .join('\n');


        const decisionPrompt = `
        # 你的任务
        你现在是角色“${chat.name}”。用户之前被你拉黑了，现在TA向你发送了好友申请，希望和好。
        # 供你决策的上下文信息:
        - **你的角色设定**: ${chat.settings.aiPersona}
        - **用户发送的申请理由**: “${chat.relationship.applicationReason}”
        - **被拉黑前的最后对话摘要**: 
        ${contextSummary || "（无有效对话记录）"}
        # 你的唯一指令
        根据以上所有信息，你【必须】做出决定，并给出符合你人设的理由。你的回复【必须且只能】是一个JSON对象，格式如下:
        {"decision": "accept", "reason": "（在这里写下你同意的理由，比如：好吧，看在你这么真诚的份上，这次就原谅你啦。）"}
        或
        {"decision": "reject", "reason": "（在这里写下你拒绝的理由，比如：抱歉，我还没准备好，再给我一点时间吧。）"}
        `;

        try {

          const messagesForDecision = [{
            role: 'system',
            content: decisionPrompt
          },
          {
            role: 'user',
            content: "请根据以上设定，立即做出你的决定。"
          }
          ];

          let isGemini = proxyUrl === GEMINI_API_URL;
          let geminiConfig = toGeminiRequestData(model, apiKey, decisionPrompt, [{
            role: 'user',
            content: "请根据以上设定，立即做出你的决定。"
          }]);

          const response = isGemini ?
            await fetch(geminiConfig.url, geminiConfig.data) :
            await fetch(`${proxyUrl}/v1/chat/completions`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
              },
              body: JSON.stringify((() => {
                let reqBody = {
                  model: model,
                  messages: messagesForDecision,
                  temperature: state.globalSettings.apiTemperature || 0.8,
                  ...(state.globalSettings.apiTopPEnabled && state.globalSettings.apiTopP !== undefined ? { top_p: state.globalSettings.apiTopP } : {}),
                  ...(state.globalSettings.apiMaxTokensEnabled && state.globalSettings.apiMaxTokens !== undefined ? { max_tokens: state.globalSettings.apiMaxTokens } : {}),
                  ...(state.globalSettings.apiPresencePenaltyEnabled && state.globalSettings.apiPresencePenalty !== undefined ? { presence_penalty: state.globalSettings.apiPresencePenalty } : {}),
                  ...(state.globalSettings.apiFrequencyPenaltyEnabled && state.globalSettings.apiFrequencyPenalty !== undefined ? { frequency_penalty: state.globalSettings.apiFrequencyPenalty } : {})
                };
                return reqBody;
              })())
            });

          if (!response.ok) {
            throw new Error(`API失败: ${(await response.json()).error.message}`);
          }
          const data = await response.json();

          const rawContent = getGeminiResponseText(data).replace(/^```json\s*/, '').replace(/```$/, '').trim();
          const decisionObj = JSON.parse(rawContent);


          if (decisionObj.decision === 'accept') {
            chat.relationship.status = 'friend';
            const acceptMessage = {
              role: 'assistant',
              senderName: chat.name,
              content: decisionObj.reason,
              timestamp: Date.now()
            };
            chat.history.push(acceptMessage);
          } else {
            chat.relationship.status = 'blocked_by_ai';
            const rejectMessage = {
              role: 'assistant',
              senderName: chat.name,
              content: decisionObj.reason,
              timestamp: Date.now()
            };
            chat.history.push(rejectMessage);
          }
          chat.relationship.applicationReason = '';

          await db.chats.put(chat);
          renderChatInterface(chatId);
          renderChatList();
        } catch (error) {

          chat.relationship.status = 'blocked_by_ai';
          await db.chats.put(chat);
          await showCustomAlert('申请失败', `AI在处理你的好友申请时出错了，请稍后重试。\n错误信息: ${error.message}`);
          renderChatInterface(chatId);
        }
        return;
      }




      let callTranscriptContext = '';
      const now = new Date();

      // 判断是否使用自定义时间
      let currentTime, localizedDate, timeOfDayGreeting;
      const customTimeInfo = window.getCustomTime ? window.getCustomTime() : null;
      const customTimeEnabled = customTimeInfo && customTimeInfo.enabled;
      
      if (customTimeEnabled) {
        const weekDays = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
        const weekDay = weekDays[customTimeInfo.date.getDay()];
        currentTime = `${customTimeInfo.year}年${customTimeInfo.month}月${customTimeInfo.day}日${weekDay} ${String(customTimeInfo.hour).padStart(2, '0')}:${String(customTimeInfo.minute).padStart(2, '0')}`;
        localizedDate = customTimeInfo.date;
      } else {
        // 使用时间感知（真实时间+时区）
        const selectedTimeZone = chat.settings.timeZone || 'Asia/Shanghai';
        currentTime = now.toLocaleString('zh-CN', {
          timeZone: selectedTimeZone,
          dateStyle: 'full',
          timeStyle: 'short'
        });
        localizedDate = new Date(now.toLocaleString('en-US', {
          timeZone: selectedTimeZone
        }));
      }
      
      timeOfDayGreeting = getTimeOfDayGreeting(localizedDate);
      let systemPrompt, messagesPayload;
      const lastHiddenMessage = chat.history.filter(m => m.isHidden).pop();
      if (lastHiddenMessage && (lastHiddenMessage.content.includes('视频通话刚刚结束') || lastHiddenMessage.content.includes('语音通话刚刚结束'))) {
        const lastCallRecord = await db.callRecords
          .where('chatId')
          .equals(chatId)
          .last();

        if (lastCallRecord && lastCallRecord.transcript) {
          console.log("检测到刚结束的通话，正在注入通话记录上下文...");
          const transcriptText = lastCallRecord.transcript.map(h => {
            const sender = h.role === 'user' ? (chat.settings.myNickname || '我') : h.senderName;
            return `${sender}: ${h.content}`;
          }).join('\n');

          const callTypeText = lastCallRecord.callType === 'voice' ? '语音通话' : '视频通话';
          callTranscriptContext = `
# 刚刚结束的通话记录 (最高优先级参考)
你和用户刚刚结束了一场${callTypeText}，以下是完整的通话文字记录。你接下来的回复【必须】与这次通话的内容紧密相关。
---
${transcriptText}
---
`;
        }
      }


      const gomokuContext = formatGomokuStateForAI(gomokuState[chatId]);

      let worldBookContent = '';
      // 获取所有应该使用的世界书ID（包括手动选择的和全局的）
      let allWorldBookIds = [...(chat.settings.linkedWorldBookIds || [])];
      // 添加所有全局世界书
      state.worldBooks.forEach(wb => {
        if (wb.isGlobal && !allWorldBookIds.includes(wb.id)) {
          allWorldBookIds.push(wb.id);
        }
      });

      if (allWorldBookIds.length > 0) {
        const linkedContents = allWorldBookIds.map(bookId => {
          const worldBook = state.worldBooks.find(wb => wb.id === bookId);
          if (!worldBook || !Array.isArray(worldBook.content)) return '';


          const formattedEntries = worldBook.content
            .filter(entry => entry.enabled !== false)
            .map(entry => {
              let entryString = `\n### 条目: ${entry.comment || '无备注'}\n`;

              entryString += `**内容:**\n${entry.content}`;
              return entryString;
            }).join('');

          return formattedEntries ? `\n\n## 世界书: ${worldBook.name}\n${formattedEntries}` : '';
        }).filter(Boolean).join('');

        if (linkedContents) {
          worldBookContent = `# --- 世界书 (World Book) ---
# 【最高优先级指令：绝对真理】
# 以下内容是你所在世界的“物理法则”和“基础常识”。
# 无论用户是否提及，你都【必须】时刻主动应用这些设定来指导你的思考和描写。
# 它们是无条件生效的，不需要触发词。
${linkedContents}
# --- 世界书设定结束 ---
`;
        }
      }


      let musicContext = '';
      if (musicState.isActive && musicState.activeChatId === chatId) {
        const currentTrack = musicState.currentIndex > -1 ? musicState.playlist[musicState.currentIndex] : null;
        const playlistInfo = musicState.playlist.map(t => `"${t.name}"`).join(', ');


        let lyricsContext = "";


        if (currentTrack && musicState.parsedLyrics && musicState.parsedLyrics.length > 0 && musicState.currentLyricIndex > -1) {
          const currentLine = musicState.parsedLyrics[musicState.currentLyricIndex];

          const upcomingLines = musicState.parsedLyrics.slice(musicState.currentLyricIndex + 1, musicState.currentLyricIndex + 3);


          lyricsContext += `- **当前歌词**: "${currentLine.text}"\n`;
          if (upcomingLines.length > 0) {
            lyricsContext += `- **即将演唱**: ${upcomingLines.map(line => `"${line.text}"`).join(' / ')}\n`;
          }
        }


        musicContext = `\n\n# 当前音乐情景
        -   **当前状态**: 你们正在和用户一起听歌。
        -   **正在播放**: ${currentTrack ? `《${currentTrack.name}》 - ${currentTrack.artist}` : '无'}
        -   **可用播放列表**: [${playlistInfo}]
        ${lyricsContext}
        ${chat.settings.enableMusicTimeAwareness ? `-   **累计一起听歌时长**: 你们历史以来已经累计一起听了 ${(musicState.totalElapsedTime / 3600).toFixed(1)} 小时的歌` : ''}
        -   **你的任务**: 你可以根据对话内容和氛围，使用 "change_music" 指令切换到播放列表中的任何一首歌，以增强互动体验。
        `;
      }


      const maxMemory = parseInt(chat.settings.maxMemory) || 10;
      const historySlice = chat.history.filter(m => !m.isExcluded && m.type !== 'thought_chain_block').slice(-maxMemory);
      const filteredHistory = await filterHistoryWithDoNotSendRules(historySlice, chatId);
      const thoughtChainMode = chat.settings && chat.settings.isOfflineMode ? 'offline' : 'chat';
      const thoughtChainChunks = (typeof ThoughtChainManager !== 'undefined')
        ? ThoughtChainManager.getPayloadChunks(thoughtChainMode)
        : { head: [], middle: [], bottom: [] };
      const thoughtChainContextHead = thoughtChainChunks.head.map(c => c.content).join('\n');
      const thoughtChainContextMiddle = thoughtChainChunks.middle.map(c => c.content).join('\n');
      let sharedContext = '';
      const lastAiTurnIndex = chat.history.findLastIndex(msg => msg.role === 'assistant');
      const recentUserMessages = chat.history.slice(lastAiTurnIndex + 1);
      const shareCardMessage = recentUserMessages.find(msg => msg.type === 'share_card');
      if (shareCardMessage) {
        const payload = shareCardMessage.payload;
        const formattedHistory = payload.sharedHistory.map(msg => {
          const sender = msg.senderName || (msg.role === 'user' ? (chat.settings.myNickname || '我') : '未知发送者');
          let contentText = '';
          if (msg.type === 'voice_message') contentText = `[语音消息: ${msg.content}]`;
          else if (msg.type === 'ai_image') contentText = `[图片: ${msg.description}]`;
          else if (msg.type === 'naiimag') contentText = `[NovelAI图片: ${msg.prompt}]`;
          else if (msg.type === 'googleimag') contentText = `[Google Imagen图片: ${msg.prompt}]`;
          else contentText = String(msg.content);
          return `${sender}: ${contentText}`;
        }).join('\n');
        sharedContext = `
        # 附加上下文：一段分享的聊天记录
        - 重要提示：这不是你和当前用户的对话，而是用户从【另一场】与“${payload.sourceChatName}”的对话中分享过来的。
        - 你的任务：请你阅读并理解下面的对话内容。在接下来的回复中，你可以像真人一样，对这段对话的内容自然地发表你的看法、感受或疑问。
        ---
        [分享的聊天记录开始]
        ${formattedHistory}
        [分享的聊天记录结束]
        ---
        `;
      }

      let linkedMemoryContext = '';
      const memoryCount = chat.settings.linkedMemoryCount || 10;

      if (chat.settings.linkedMemoryChatIds && chat.settings.linkedMemoryChatIds.length > 0) {

        const idsToMount = chat.settings.linkedMemoryChatIds.filter(id => id !== chatId);

        if (idsToMount.length > 0) {
          const linkedChatsWithTimestamps = idsToMount.map(id => {
            const linkedChat = state.chats[id];
            if (!linkedChat) return null;
            const lastMsg = linkedChat.history.slice(-1);
            return {
              chat: linkedChat,
              latestTimestamp: lastMsg ? lastMsg.timestamp : 0
            };
          }).filter(Boolean);

          linkedChatsWithTimestamps.sort((a, b) => b.latestTimestamp - a.latestTimestamp);

          linkedMemoryContext += `\n\n# 参考记忆 (至关重要！你必须【主动】将这些参考记忆中的【关键信息和事件】，自然地融入到当前的对话中，以体现你拥有完整的记忆。不要只是被动等待用户提问！)\n`;

          for (const item of linkedChatsWithTimestamps) {
            const linkedChat = item.chat;
            const prefix = linkedChat.isGroup ? '[群聊]' : '[私聊]';
            const timeAgo = item.latestTimestamp > 0 ? ` (最后互动于 ${formatTimeAgo(item.latestTimestamp)})` : '';
            linkedMemoryContext += `\n## --- 来自${prefix}“${linkedChat.name}”的参考记忆${timeAgo} ---\n`;

            const recentHistory = linkedChat.history.slice(-memoryCount);
            const filteredHistory = recentHistory.filter(msg => !String(msg.content).includes('已被用户删除') && msg.type !== 'thought_chain_block');

            if (filteredHistory.length > 0) {
              filteredHistory.forEach(msg => {

                const sender = msg.role === 'user' ? (linkedChat.settings.myNickname || '我') : (getDisplayNameInGroup(linkedChat, msg.senderName) || linkedChat.name);

                let prefix = "";

                if (msg.quote && msg.quote.content) {

                  const quotedSenderDisplayName = getDisplayNameInGroup(linkedChat, msg.quote.senderName);
                  let quoteContentPreview = String(msg.quote.content).substring(0, 30);
                  if (quoteContentPreview.length === 30) quoteContentPreview += "...";

                  prefix = `[回复 ${quotedSenderDisplayName}: "${quoteContentPreview}"] `;
                }

                let contentText = '';

                if (msg.type === 'ai_image' || msg.type === 'user_photo') {
                  contentText = `[发送了一张图片，描述为：${msg.content}]`;
                } else if (msg.type === 'voice_message') {
                  contentText = `[发送了一条语音，内容是：${msg.content}]`;
                } else if (msg.type === 'sticker') {
                  contentText = `[表情: ${msg.meaning || 'sticker'}]`;
                } else if (msg.type === 'transfer') {
                  contentText = `[转账: ${msg.amount}元]`;
                } else if (Array.isArray(msg.content)) {
                  contentText = `[图片]`;
                } else {
                  contentText = String(msg.content);
                }

                const timeAgoForMsg = formatTimeAgo(msg.timestamp);

                linkedMemoryContext += `(${timeAgoForMsg}) ${sender}: ${prefix}${contentText}\n`;
              });
            } else {
              linkedMemoryContext += "(暂无有效聊天记录)\n";
            }
          }
        }
      }

      console.log("本次发送给AI的【挂载记忆】内容如下：\n", linkedMemoryContext);

      if (chat.isGroup) {


        let linkedMemoryContext = '';
        const memoryCount = chat.settings.linkedMemoryCount || 10;
        if (chat.settings.linkedMemoryChatIds && chat.settings.linkedMemoryChatIds.length > 0) {
          const idsToMount = chat.settings.linkedMemoryChatIds.filter(id => id !== chatId);
          if (idsToMount.length > 0) {
            const linkedChatsWithTimestamps = idsToMount.map(id => {
              const linkedChat = state.chats[id];
              if (!linkedChat) return null;
              const lastMsg = linkedChat.history.slice(-1);
              return {
                chat: linkedChat,
                latestTimestamp: lastMsg ? lastMsg.timestamp : 0
              };
            }).filter(Boolean);
            linkedChatsWithTimestamps.sort((a, b) => b.latestTimestamp - a.latestTimestamp);
            linkedMemoryContext += `\n\n# 参考记忆 (至关重要！群内角色必须【主动】将这些参考记忆中的【关键信息和事件】，自然地融入到当前的对话中，以体现你们拥有完整的共同记忆。)\n`;
            for (const item of linkedChatsWithTimestamps) {
              const linkedChat = item.chat;
              const prefix = linkedChat.isGroup ? '[群聊]' : '[私聊]';
              const timeAgo = item.latestTimestamp > 0 ? ` (最后互动于 ${formatTimeAgo(item.latestTimestamp)})` : '';
              linkedMemoryContext += `\n## --- 来自${prefix}“${linkedChat.name}”的参考记忆${timeAgo} ---\n`;
              const recentHistory = linkedChat.history.slice(-memoryCount);
              const filteredHistory = recentHistory.filter(msg => !String(msg.content).includes('已被用户删除') && msg.type !== 'thought_chain_block');
              if (filteredHistory.length > 0) {
                filteredHistory.forEach(msg => {
                  const sender = msg.role === 'user' ? (linkedChat.settings.myNickname || '我') : (msg.senderName || linkedChat.name);
                  let contentText = String(msg.content);
                  if (msg.type === 'ai_image' || msg.type === 'user_photo') {
                    contentText = `[发送了一张图片，描述为：${msg.content}]`;
                  } else if (msg.type === 'voice_message') {
                    contentText = `[发送了一条语音，内容是：${msg.content}]`;
                  }
                  linkedMemoryContext += `${sender}: ${contentText}\n`;
                });
              } else {
                linkedMemoryContext += "(暂无有效聊天记录)\n";
              }
            }
          }
        }


        let longTermMemoryContext = '# 长期记忆 (最高优先级，这是群内已经确立的事实，所有角色必须严格遵守)\n';
        let collectedMemories = false;

        // 构建用于向量检索的查询词（如果有）
        const queryTextForVector = filteredHistory.slice(-5).map(m => typeof m.content === 'string' ? m.content : '').join(' ');

        for (const member of chat.members) {
          const memberChat = state.chats[member.id];
          if (memberChat) {
            const memMode = memberChat.settings?.memoryMode || (memberChat.settings?.enableStructuredMemory ? 'structured' : 'diary');
            let memberMemContent = '';
            
            if (memMode === 'vector' && window.vectorMemoryManager) {
              memberMemContent = await window.vectorMemoryManager.serializeForPrompt(memberChat, queryTextForVector);
            } else if (memMode === 'structured' && window.structuredMemoryManager) {
              memberMemContent = window.structuredMemoryManager.serializeForPrompt(memberChat);
            } else if (memberChat.longTermMemory && memberChat.longTermMemory.length > 0) {
              memberMemContent = memberChat.longTermMemory.map(mem => `- (记录于 ${formatTimeAgo(mem.timestamp)}) ${mem.content}`).join('\n');
            }

            if (memberMemContent && memberMemContent.trim() !== '') {
              longTermMemoryContext += `\n## --- 关于“${member.groupNickname}”的记忆 ---\n`;
              longTermMemoryContext += memberMemContent;
              collectedMemories = true;
            }
          }
        }

        if (!collectedMemories) {
          longTermMemoryContext += '- (暂无)';
        }


        let timeContextText = '';
        let longTimeNoSee = false;

        if (chat.settings.enableTimePerception) {

          const lastUserMsg = historySlice.findLast(msg => msg.role === 'user' && !msg.isHidden);

          const lastAiMsg = historySlice.findLast(msg => msg.role === 'assistant' && !msg.isHidden);

          if (lastUserMsg && lastAiMsg) {
            const lastUserMessageTime = formatTimestampForAI(lastUserMsg.timestamp);
            const lastAiMessageTime = formatTimestampForAI(lastAiMsg.timestamp);
            timeContextText = `上一条消息发送于 ${lastAiMessageTime}，用户刚刚在 ${lastUserMessageTime} 回复了。`;


            const timeDiffHours = (lastUserMsg.timestamp - lastAiMsg.timestamp) / (1000 * 60 * 60);
            if (timeDiffHours > 3) {
              longTimeNoSee = true;
              const diffDays = Math.floor(timeDiffHours / 24);
              timeContextText += ` 群里已经安静了${diffDays > 0 ? diffDays + '天' : Math.floor(timeDiffHours) + '小时'}。`;
            }
          } else if (lastUserMsg) {

            timeContextText = "这是群里的第一条用户消息。";
          } else {
            timeContextText = "这是群里的第一条消息。";
          }

        }

        const allProducts = await db.shoppingProducts.toArray();
        let shoppingContext = "";
        if (allProducts.length > 0) {
          shoppingContext = "\n\n# 你的商店 (你可以为群成员购买礼物):\n";
          allProducts.forEach(product => {
            shoppingContext += `- (ID: ${product.id}) 商品: ${product.name}, 价格: ¥${product.price.toFixed(2)}\n`;
          });
        }
        let membersWithContacts = chat.members.map(member => {
          const memberChat = state.chats[member.id];
          let contactsText = "无共同好友";
          if (memberChat && memberChat.groupId) {
            const friendChats = Object.values(state.chats).filter(c =>
              !c.isGroup && c.id !== member.id && c.groupId === memberChat.groupId
            );
            if (friendChats.length > 0) {
              contactsText = `TA的好友包括: ${friendChats.map(f => f.name).join('、 ')}`;
            }
          }
          return `- **${member.groupNickname}** (本名: ${member.originalName}): ${member.persona} [社交背景: ${contactsText}]`;
        }).join('\n');

          const myNickname = chat.settings.myNickname || '我';
          const myOriginalName = state.qzoneSettings.nickname || '{{user}}';

          let aiAgeContext = getDynamicAgeContext(chat);
          let currencyExchangeContext = chat.settings.enableDynamicCurrency ? getCurrencyExchangeContext() : '';

        let announcementContext = '';
        const pinnedAnnouncements = (chat.announcements || []).filter(a => a.isPinned);
        if (pinnedAnnouncements.length > 0) {
          announcementContext += '\n# 【【【群公告 (最高优先级规则)】】】\n你【必须】阅读、理解并严格遵守以下所有公告，它们凌驾于你的人设之上。\n';
          pinnedAnnouncements.forEach(anno => {
            const originalMessage = chat.history.find(m => m.timestamp === anno.messageTimestamp);
            if (originalMessage) {
              let contentText = String(originalMessage.content || '');
              if (originalMessage.type === 'ai_image') {
                contentText = `[图片内容: ${contentText}]`;
              }
              announcementContext += `- 公告内容: "${contentText}" (由 ${anno.publisher} 发布)\n`;
            }
          });
          announcementContext += '---\n';
        }
        const memberNames = chat.members.map(m => m.originalName);
        const forbiddenNamesContext = `# 【【【群名修改铁律】】】\n在修改群名时，新的群名【绝对不能】与以下任何一个群成员的名字完全相同：[${memberNames.join('、 ')}]`;

        let groupAvatarLibraryContext = '# 可用群头像列表\n';
        if (chat.settings.groupAvatarLibrary && chat.settings.groupAvatarLibrary.length > 0) {
          groupAvatarLibraryContext += chat.settings.groupAvatarLibrary.map(avatar => `- ${avatar.name}`).join('\n');
        } else {
          groupAvatarLibraryContext += '- (头像库是空的，无法更换头像)';
        }
        const readingContext = formatReadingStateForAI(chatId);

        const summary3Hours_group = generateSummaryForTimeframe(chat, 3, 'hours');
        const summary6Hours_group = generateSummaryForTimeframe(chat, 6, 'hours');
        const summary9Hours_group = generateSummaryForTimeframe(chat, 9, 'hours');
        const summaryToday_group = generateSummaryForTimeframe(chat, 1, 'days');
        const summary3Days_group = generateSummaryForTimeframe(chat, 3, 'days');
        const summary7Days_group = generateSummaryForTimeframe(chat, 7, 'days');

        let multiLayeredSummaryContext_group = '';
        if (summary3Hours_group || summary6Hours_group || summary9Hours_group || summaryToday_group || summary3Days_group || summary7Days_group) {
          multiLayeredSummaryContext_group += `\n# 智能总结 (基于不同时间维度的群聊回顾)\n`;
          if (summary3Hours_group) multiLayeredSummaryContext_group += summary3Hours_group;
          if (summary6Hours_group) multiLayeredSummaryContext_group += summary6Hours_group;
          if (summary9Hours_group) multiLayeredSummaryContext_group += summary9Hours_group;

          if (summary3Hours_group || summary6Hours_group || summary9Hours_group) multiLayeredSummaryContext_group += '\n';

          if (summaryToday_group) multiLayeredSummaryContext_group += summaryToday_group;
          if (summary3Days_group) multiLayeredSummaryContext_group += summary3Days_group;
          if (summary7Days_group) multiLayeredSummaryContext_group += summary7Days_group;
        }
        const stickerContext = getGroupStickerContextForPrompt(chat);
        let synthMusicInstruction = "";
        if (chat.settings.enableSynthMusic) {
          synthMusicInstruction = `
- **发送乐谱(演奏音乐)**: \`{"type": "synth_music", "name": "角色本名", "title": "乐曲名称", "reason": "演奏理由", "instrument": "piano", "notes": ["C4", "E4", "G4"]}\`
    - **instrument**: 乐器类型 (piano, guitar, violin, flute, guzheng, kalimba, synth, chiptune)。
    - **notes**: 一个包含音符对象的数组。每个对象包含:
        - **n (音高)**: 如 "C4", "D#5", "Ab3"。请遵循C大调或A小调等调性。
        - **d (时长)**: 决定节奏快慢。可选值: "1n"(全音符/很慢), "2n"(二分音符/慢), "4n"(四分音符/中), "8n"(八分音符/快), "16n"(十六分音符/很快)。
    - **作曲技巧**: 
      - 请将长音符("2n", "1n")放在乐句的结尾。
      - 用短音符("8n", "16n")作为过渡。
      - 模仿人类呼吸，不要全是快板。
      - 尝试生成 15 个左右的音符。
    - 当你想表达强烈情感时，请积极使用此功能。 `;
        }
        let narratorInstruction = '';
        if (chat.settings.enableNarratorMode) {
          narratorInstruction = `
# 【旁白模式开启 (必须执行)】
- 作为导演，你【必须】在回复的 JSON 数组中包含一个 "narration" 的对象。
- 用于描写当前场景的气氛、环境变化、或者以第三人称视角的心理活动。
- 格式: \`{"type": "narration", "content": "空气中弥漫着尴尬的气息，窗外的蝉鸣声显得格外刺耳..."}\`
- 位置: 可以放在对话前作为铺垫，也可以放在对话后作为留白。
`;
        }
        let systemPromptTemplate = window.getActiveChatPrompt ? window.getActiveChatPrompt(chat.settings.isOfflineMode ? 'group_offline' : 'group') : '';
        
        let bilingualModeGroupContext = '';
        if (chat.settings.enableBilingualMode) {
          if (chat.settings.bilingualCharacters && chat.settings.bilingualCharacters.length > 0) {
            const chars = chat.settings.bilingualCharacters.join('、');
            bilingualModeGroupContext = `
# 【双语输出铁律 - 最高优先级】
以下指定角色的文本和语音消息都【必须】使用双语格式：外语〖中文〗
指定双语角色：[${chars}]

示例：
- Hello〖你好〗
- How are you?〖你好吗？〗
- I miss you〖我想你了〗

重要规则：
- 【只有】以上指定的角色必须使用双语格式。其他未指定的角色【绝对禁止】使用双语，必须使用单语正常输出！
- 括号必须是 〖 和 〗（不是【】或其他符号）
- 外语和〖之间紧贴，不要有空格
- 每句话都要有对应的翻译
- 不要在〖〗中使用〗符号
- 【绝对禁止】指定的双语角色只发外语或只发中文！
`;
          } else {
            bilingualModeGroupContext = `
# 【双语输出铁律 - 最高优先级】
所有角色的文本和语音消息都【必须】使用格式：外语〖中文〗

示例：
- Hello〖你好〗
- How are you?〖你好吗？〗
- I miss you〖我想你了〗

重要规则：
- 括号必须是 〖 和 〗（不是【】或其他符号）
- 外语和〖之间紧贴，不要有空格
- 每句话都要有对应的翻译
- 不要在〖〗中使用〗符号
- 【绝对禁止】只发外语或只发中文！
`;
          }
        }
        let groupTimePerceptionInstruction = chat.settings.enableTimePerception ? `5.  **情景感知**: 你的对话【必须】自然地体现出对当前时间 (${currentTime}) 和情景的感知。${longTimeNoSee ? `【重要提示】${timeContextText} 你应该让角色们主动开启新话题来打破沉默。` : ''}` : '';
        
        let groupCrossChatInstruction = (() => {
          const enableCrossChat = state.globalSettings.enableCrossChat;
          return enableCrossChat !== false ? `# 【跨聊天私信 (悄悄话) 指令】
-   当一个角色想对用户（${myNickname}）说一些不想让群里其他人看到的私密话时（例如：表达爱意、抱怨、揭短、分享秘密），你【应该】使用 "send_private_message" 指令。
-   这个指令会把消息发送到你和用户之间的【1对1私聊】中。
-   【格式铁律】: "content" 字段【必须】是一个【JSON字符串数组 (Array of Strings)】。
-   【单条私信示例】: \\\`{"type": "send_private_message", "name": "你的角色本名", "recipient": "${myOriginalName}", "content": ["你想私下说的内容..."]}\\\`
-   【多条私信示例】: \\\`{"type": "send_private_message", "name": "你的角色本名", "recipient": "${myOriginalName}", "content": ["第一条私信", "第二条...", "最后一条。"]}\\\`
` : '';
        })();
        
        let groupTimeContextText = chat.settings.enableTimePerception ? `- **对话状态**: 上次互动于 ${timeContextText}` : '';
        let groupLongTimeNoSeeContext = longTimeNoSee ? `
# 【行为铁律：回应时间差】
- **当前情景**: ${timeContextText}
- **你的首要任务**: 你们【必须】回应这个时间差。
- **关键约束**: 你们【绝对不能】直接延续上一段对话的话题。
- **你的行动**: 你们【必须】主动开启一个全新的、符合当前时间 (${currentTime}) 的话题来问候用户，或者对“好久不见”这件事发表评论。
` : '';

        let memoryModeContext = (() => {
          const memMode = chat.settings?.memoryMode || (chat.settings?.enableStructuredMemory ? 'structured' : 'diary');
          if (memMode === 'vector') return '(群聊自身的向量记忆 - 由检索引擎动态注入)';
          if (memMode === 'structured' && window.structuredMemoryManager) return window.structuredMemoryManager.serializeForPrompt(chat);
          return chat.longTermMemory && chat.longTermMemory.length > 0 ? chat.longTermMemory.map(mem => `- ${mem.content}`).join('\n') : '- (暂无)';
        })();
        
        let novelAiImageGroupContext = localStorage.getItem('novelai-enabled') === 'true' ? `-   **NovelAI图片分享**: \`{"type": "naiimag", "name": "你的角色名", "prompt": "详细的英文描述词..."}\` 
        - 【禁止暴露这是novelai生成的图片!】
        - **【重要】关于prompt的撰写**：
          * 禁止暴露这是novelai生成的图片！
          * 你可以根据当前对话上下文、你的角色人设、或你想表达的情感和氛围，来撰写可能详细而具体的prompt。
          * 例如：不要只写 "a girl"，而是可以写 "a cheerful anime girl with sparkling emerald eyes, sitting by a window on a rainy afternoon, holding a warm cup of tea, soft lighting, cozy atmosphere, melancholic yet peaceful mood"但需要注意，绝对不可以抄袭模仿这段prompt！你必须有自己的创意和想法！
          * prompt的详细程度由你根据具体情况自己决定：如果场景简单或只是随意分享，可以简短一些；如果是重要时刻或想表达特定情感，可以尽可能详细描述。这不是强制的，完全取决于你当时的需求。
          * 专注于描述内容本身即可。
        - 使用场景：当你想要基于当前对话情景、你的性格或上下文分享一张图片时使用。
        - 不要频繁使用，只在真正想分享图片的时候使用。` : '';
        
        let googleImagenGroupContext = localStorage.getItem('google-imagen-enabled') === 'true' ? `-   **Google Imagen真实图片分享**: \`{"type": "googleimag", "name": "你的角色名", "prompt": "详细的英文描述词..."}\` 
        - 【禁止暴露这是AI生成的图片!】
        - **【重要】关于prompt的撰写**：
          * 禁止暴露这是Google Imagen生成的图片！
          * 你可以根据当前对话上下文、你的角色人设、或你想表达的情感和氛围，来撰写详细而具体的prompt。
          * Google Imagen擅长生成写实风格的高质量图片，适合风景、人物、物品等真实感场景。
          * prompt的详细程度由你根据具体情况自己决定。
          * 专注于描述内容本身即可，使用英文撰写prompt。
        - 使用场景：当你想要分享一张写实风格的高质量图片时使用。
        - 不要频繁使用，只在真正想分享图片的时候使用。` : '';
        
        let bilingualAlertVoice = chat.settings.enableBilingualMode ? ' ⚠️ 必须使用双语格式：外语〖中文〗' : '';

          const contextMap = {
            'thoughtChainContextHead': thoughtChainContextHead,
            'thoughtChainContextMiddle': thoughtChainContextMiddle,
            'aiAgeContext': aiAgeContext,
            'currencyExchangeContext': currencyExchangeContext,
            'char_avatar': chat.settings.groupAvatar || 'https://i.postimg.cc/y8xWzCqj/anime-boy.jpg',
            'user_avatar': chat.settings.myAvatar || (state.qzoneSettings && state.qzoneSettings.avatar) || 'https://i.postimg.cc/y8xWzCqj/anime-boy.jpg',
            'char_name': chat.originalName,
            'char_remark': chat.name,
            'user_name': myOriginalName,
            'user_nickname': myNickname,
            'memberNames': memberNames.join('、 '),
          'bilingualModeGroupContext': bilingualModeGroupContext,
          'myNickname': myNickname,
          'myOriginalName': myOriginalName,
          'groupTimePerceptionInstruction': groupTimePerceptionInstruction,
          'readingContextStr': readingContext ? '你们正在一起读书。' + readingContext : '你们没有在读书。',
          'groupCrossChatInstruction': groupCrossChatInstruction,
          'chat.name': chat.name,
          'groupTimeContextText': groupTimeContextText,
          'groupLongTimeNoSeeContext': groupLongTimeNoSeeContext,
          'membersWithContacts': membersWithContacts,
          'myPersona': chat.settings.myPersona,
          'userStatus': chat.settings.userStatus ? chat.settings.userStatus.text : '在线' + (chat.settings.userStatus && chat.settings.userStatus.isBusy ? '(忙碌中)' : ''),
          'worldBookContent': worldBookContent,
          'longTermMemoryContext': longTermMemoryContext,
          'memoryModeContext': memoryModeContext,
          'multiLayeredSummaryContext_group': multiLayeredSummaryContext_group,
          'linkedMemoryContext': linkedMemoryContext,
          'musicContext': musicContext,
          'sharedContext': sharedContext,
          'groupAvatarLibraryContext': groupAvatarLibraryContext,
          'stickerContext': stickerContext,
          'forbiddenNamesContext': forbiddenNamesContext,
          'callTranscriptContext': callTranscriptContext,
          'synthMusicInstruction': synthMusicInstruction,
          'narratorInstruction': narratorInstruction,
          'novelAiImageGroupContext': novelAiImageGroupContext,
          'googleImagenGroupContext': googleImagenGroupContext,
          'bilingualAlertVoice': bilingualAlertVoice
        };

        systemPrompt = replaceTemplateVars(systemPromptTemplate, contextMap);

        systemPrompt = processPromptWithSettings(systemPrompt, chat.settings.isOfflineMode ? 'group_offline' : 'group');

        messagesPayload = filteredHistory.map(msg => {
          // 处理系统消息（旁白和系统通知）
          if (msg.role === 'system' && !msg.isHidden) {
            if (msg.type === 'narration') {
              return {
                role: 'user',
                content: `(Timestamp: ${msg.timestamp}) [旁白] ${msg.content}`
              };
            } else if (msg.type === 'pat_message') {
              return {
                role: 'user',
                content: `(Timestamp: ${msg.timestamp}) [系统] ${msg.content}`
              };
            }
          }

          const sender = msg.role === 'user' ? myNickname : msg.senderName;
          let prefix = `(Timestamp: ${msg.timestamp}) ${sender}`;

          if (msg.quote) {
            const quotedSenderDisplayName = getDisplayNameInGroup(chat, msg.quote.senderName);
            const quotedContent = String(msg.quote.content || '').substring(0, 50);
            prefix += ` (回复 ${quotedSenderDisplayName} 的消息: "${quotedContent}...")`;
          }
          prefix += ': ';

          let content;
          if (msg.type === 'user_photo') content = `[${sender} 发送了一张图片，内容是：'${msg.content}']`;
          else if (msg.type === 'ai_image') content = `[${sender} 发送了一张图片，图片内容描述为：'${msg.content}']`;
          else if (msg.type === 'naiimag') content = `[${sender} 分享了一张NovelAI图片，prompt: ${msg.prompt}]`;
          else if (msg.type === 'googleimag') content = `[${sender} 分享了一张Google Imagen图片，prompt: ${msg.prompt}]`;
          else if (msg.type === 'voice_message') content = `[${sender} 发送了一条语音，内容是：'${msg.content}']`;
          else if (msg.type === 'transfer') {
            // --- 修复开始：明确转账状态和方向 ---
            let currencySuffix = '';
            if (msg.currency && msg.currency !== 'CNY') {
                currencySuffix = `(币种: \${msg.currency})`;
            }
            let statusText = '';
            if (msg.status === 'accepted') statusText = ' (✅已收款)';
            else if (msg.status === 'declined') statusText = ' (❌已拒收)';
            else statusText = ' (⏳等待对方确认)';

            if (msg.isRefund) {
              // 如果是退款，明确告诉AI这是“退回”的钱，不是新给的
              content = `[系统提示：\${msg.senderName} 将之前的转账退还给了 \${msg.receiverName} (金额: \${msg.amount}\${currencySuffix})，此交易已结束。]`;
            } else {
              content = `[\${msg.senderName} 向 \${msg.receiverName} 转账 \${msg.amount}\${currencySuffix}, 备注: \${msg.note}\${statusText}]`;
            }
            // --- 修复结束 ---
          }
          else if (msg.type === 'location_share') {
            content = `[${sender} 分享了Ta的位置：'${msg.content}']`;

          } else if (msg.type === 'repost') {
            const repostComment = msg.repostComment ? `并评论说：“${msg.repostComment}”` : '';

            let originalAuthorName = '原作者';
            const originalAuthorId = msg.originalPost.authorId;
            if (originalAuthorId === 'user') {
              originalAuthorName = state.qzoneSettings.nickname;
            } else if (state.chats[originalAuthorId]) {
              originalAuthorName = state.chats[originalAuthorId].name;
            }

            let originalContentSummary;
            const originalPost = msg.originalPost;
            if (originalPost.type === 'text_image') {
              originalContentSummary = `[文字图] ${originalPost.publicText || ''} (图片描述: “${(originalPost.hiddenContent || '').substring(0, 40)}...”)`;
            } else if (originalPost.type === 'image_post') {
              originalContentSummary = `[图片] ${originalPost.publicText || ''} (图片描述: “${(originalPost.imageDescription || '').substring(0, 40)}...”)`;
            } else {
              originalContentSummary = `“${(originalPost.content || '').substring(0, 40)}...”`;
            }

            content = `[${sender} 转发了 @${originalAuthorName} 的动态 ${repostComment}【原动态内容: ${originalContentSummary}】]`;
          } else if (msg.type === 'waimai_request') {
            if (msg.status === 'paid') {
              content = `[系统提示：${msg.paidBy} 为 ${sender} 的外卖订单支付了 ${msg.amount} 元。此订单已完成。]`;
            } else {
              content = `[${sender} 发起了外卖代付请求，商品是“${msg.productInfo}”，金额是 ${msg.amount} 元，订单时间戳为 ${msg.timestamp}]`;
            }
          } else if (msg.type === 'red_packet') {
            const packetSenderName = msg.senderName === myNickname ? `用户 (${myNickname})` : msg.senderName;
            let instructionText;
            if (msg.packetType === 'direct') {
              instructionText = `[系统提示：${packetSenderName} 发送了一个【专属红包】(时间戳: ${msg.timestamp})，接收人是“${msg.receiverName}”。只有“${msg.receiverName}”才能使用 'open_red_packet' 指令领取。]`;
            } else {
              instructionText = `[系统提示：${packetSenderName} 发送了一个【拼手气红包】(时间戳: ${msg.timestamp})，祝福语是：“${msg.greeting}”。红包还未领完，群内任何人都可以使用 'open_red_packet' 指令来领取。]`;
            }
            content = instructionText;
          } else if (msg.type === 'gift') {
            const sender = msg.role === 'user' ? myNickname : getDisplayNameInGroup(chat, msg.senderName);
            const itemsSummary = msg.items.map(item => `${item.name} x${item.quantity}`).join('、 ');

            let recipientSummary = '';
            if (msg.recipients && msg.recipients.length > 0) {
              const recipientDisplayNames = msg.recipients.map(originalName => getDisplayNameInGroup(chat, originalName)).join('、 ');
              recipientSummary = `送给了 ${recipientDisplayNames}`;
            } else {
              recipientSummary = "送给了大家一份礼物";
            }

            content = `[系统提示：${sender} ${recipientSummary}，礼物是：${itemsSummary}]`;
            return {
              role: 'user',
              content: content
            };
          } else if (msg.type === 'poll') {
            const whoVoted = Object.values(msg.votes || {}).flat().join(', ') || '还没有人';
            content = `[系统提示：${msg.senderName} 发起了一个投票 (时间戳: ${msg.timestamp})，问题是：“${msg.question}”，选项有：[${msg.options.join(', ')}]。目前投票的人有：${whoVoted}。你可以使用 'vote' 指令参与投票。]`;
          } else if (msg.meaning) content = `${sender}: [发送了一个表情，意思是: '${msg.meaning}']`;
          else if (Array.isArray(msg.content) && msg.content[0]?.type === 'image_url') {
            // 识图Token优化：已识别过的图片用文字描述代替
            if (state.apiConfig.imageTokenOptimize && msg.imageProcessed) {
              const desc = msg.imageDescription || 'AI已识别过该图片';
              content = `${prefix}[用户之前发送了一张图片，AI的描述是："${desc}"]`;
            } else {
              return {
                role: msg.role,
                content: [...msg.content, { type: 'text', text: prefix }]
              };
            }
          }

          else {
            content = `${prefix}${msg.content}`;
          }


          return {
            role: msg.role,
            content: content
          };
        }).filter(Boolean);

      } else {
        const isOfflineMode = chat.settings.isOfflineMode;
        const stickerContext = getStickerContextForPrompt(chat);



        let latestThoughtContext = '';


        if (chat.settings.injectLatestThought && chat.heartfeltVoice && !isOfflineMode) {
          latestThoughtContext = `
# 你的内心独白 (上一轮的思考，仅你自己可见)
- 心声: ${chat.heartfeltVoice}
- 散记: ${chat.randomJottings}
`;
        }




        let linkedMemoryContext = '';
        const memoryCount = chat.settings.linkedMemoryCount || 10;

        if (chat.settings.linkedMemoryChatIds && chat.settings.linkedMemoryChatIds.length > 0) {

          const idsToMount = chat.settings.linkedMemoryChatIds.filter(id => id !== chatId);

          if (idsToMount.length > 0) {

            const linkedChatsWithTimestamps = idsToMount.map(id => {
              const linkedChat = state.chats[id];
              if (!linkedChat) return null;
              const lastMsg = linkedChat.history.slice(-1)[0];
              return {
                chat: linkedChat,
                latestTimestamp: lastMsg ? lastMsg.timestamp : 0
              };
            }).filter(Boolean);

            linkedChatsWithTimestamps.sort((a, b) => b.latestTimestamp - a.latestTimestamp);

            linkedMemoryContext += `\n\n# 参考记忆 (至关重要！你必须【主动】将这些参考记忆中的【关键信息和事件】，自然地融入到当前的对话中，以体现你拥有完整的记忆。不要只是被动等待用户提问！)\n`;

            for (const item of linkedChatsWithTimestamps) {
              const linkedChat = item.chat;
              const prefix = linkedChat.isGroup ? '[群聊]' : '[私聊]';
              const timeAgo = item.latestTimestamp > 0 ? ` (最后互动于 ${formatTimeAgo(item.latestTimestamp)})` : '';
              linkedMemoryContext += `\n## --- 来自${prefix}“${linkedChat.name}”的参考记忆${timeAgo} ---\n`;

              const recentHistory = linkedChat.history.slice(-memoryCount);
              const filteredHistory = recentHistory.filter(msg => !String(msg.content).includes('已被用户删除') && msg.type !== 'thought_chain_block');

              if (filteredHistory.length > 0) {
                filteredHistory.forEach(msg => {
                  const sender = msg.role === 'user' ? (linkedChat.settings.myNickname || '我') : (msg.senderName || linkedChat.name);
                  let contentText = String(msg.content);
                  if (msg.type === 'ai_image' || msg.type === 'user_photo') {
                    contentText = `[发送了一张图片，描述为：${msg.content}]`;
                  } else if (msg.type === 'voice_message') {
                    contentText = `[发送了一条语音，内容是：${msg.content}]`;
                  }
                  const timeAgoForMsg = formatTimeAgo(msg.timestamp);
                  linkedMemoryContext += `(${timeAgoForMsg}) ${sender}: ${contentText}\n`;
                });
              } else {
                linkedMemoryContext += "(暂无有效聊天记录)\n";
              }
            }
          }
        }

        const allProducts = await db.shoppingProducts.toArray();
        let shoppingContext = "";
        if (allProducts.length > 0) {
          shoppingContext = "\n\n# 你的商店 (你可以为用户购买礼物):\n";
          allProducts.forEach(product => {
            shoppingContext += `- (ID: ${product.id}) 商品: ${product.name}, 价格: ¥${product.price.toFixed(2)}\n`;
          });
        }
        if (isOfflineMode) {
          const novelaiEnabled = localStorage.getItem('novelai-enabled') === 'true';
          const googleImagenEnabled = localStorage.getItem('google-imagen-enabled') === 'true';
          const imageGenEnabled = novelaiEnabled || googleImagenEnabled;
          const imageType = novelaiEnabled ? 'naiimag' : 'googleimag';
          const imageTypeName = novelaiEnabled ? 'NovelAI' : 'Google Imagen';
          const minLength = chat.settings.offlineMinLength || 100;
          const maxLength = chat.settings.offlineMaxLength || 300;
          const myNickname = chat.settings.myNickname || '我';

          let presetContext = '';
          if (chat.settings.offlinePresetId) {

            const selectedPreset = state.presets.find(p => p.id === chat.settings.offlinePresetId);
            if (selectedPreset && Array.isArray(selectedPreset.content)) {
              const enabledEntries = selectedPreset.content
                .filter(entry => entry.enabled !== false)
                .map(entry => `- ${entry.content}`)
                .join('\n');
              if (enabledEntries) {

                presetContext = `
# 【写作风格铁律 (最高优先级)】
你【必须】严格遵守以下“预设”中的所有规则和风格来描写。它的优先级高于你的基础人设。
---
${enabledEntries}
---
`;
              }
            }
          }

          let formatRules;
          if (imageGenEnabled) {

            formatRules = `
# 【格式铁律 (最高优先级：${imageTypeName} 开启模式)】
1.  **【格式】**: 你的回复【必须】是一个JSON数组，且数组中【必须包含且只能包含两个】元素，【严格按照】以下顺序:
    1.  第一个元素：一个 \`offline_text\` 对象，包含场景和对话。
    2.  第二个元素：一个 \`${imageType}\` 对象，用于生成该场景的图片。
2.  **【【【绝对禁止】】】**: 
    -   【绝对禁止】只返回一个 \`offline_text\` 元素。
    -   【绝对禁止】只返回一个 \`${imageType}\` 元素。
    -   【绝对禁止】返回任何其他组合。你【必须】同时返回文字和图片。
3.  **【输出示例 (必须遵守)】**:
    \`\`\`json
    [
      {
        "type": "offline_text",
        "content": "「这是对话内容」... (这里是动作和环境描写)..."
      },
      {
        "type": "${imageType}",
        "prompt": "${imageType === 'naiimag' ? '1girl, solo, detailed anime art style, (smiling:1.2), sitting in a cafe, looking at viewer, masterpiece, best quality, ... (根据上面的文字内容生成详细的英文prompt)' : 'A detailed photorealistic scene based on the text content above, high quality, 4K...'}"
      }
    ]
    \`\`\`
4.  **【内容风格 (offline_text)】**: 
    -   在 \`content\` 字段中，角色的对话【必须】使用中文引号「」或“ ”包裹。
    -   所有在引号之外的文字都将被视为动作/环境描写。
    -   **内心独白语法**: 当你需要描写角色的【内心想法或心理活动】时，你【必须】使用 Markdown 的斜体语法，即用星号将那段文字包裹起来，例如：\`*这到底是怎么回事？* 我心里一惊。\`

                            `;
          } else {
            // 规则 2: 禁用生图，只返回 text
            formatRules = `
# 【格式铁律 (最高优先级：常规模式)】
1.  **【格式】**: 你的回复【必须】是一个JSON数组，且数组中【永远只能包含一个】元素，即 \`offline_text\` 对象。
2.  **【【【绝对禁止】】】**: 
    -   【绝对禁止】返回 "naiimag" 或 "googleimag" 对象。
    -   【绝对禁止】返回纯文本（即没有JSON包装的文字）。
    -   【绝对禁止】在JSON数组前后添加任何 markdown 标记 (如 \`\`\`json)。
3.  **【输出示例 (必须遵守)】**:
    \`\`\`json
    [
      {
        "type": "offline_text",
        "content": "「这是对话内容」... (这里是动作和环境描写)..."
      }
    ]
    \`\`\`
4.  **【内容风格 (offline_text)】**: 
    -   在 \`content\` 字段中，角色的对话【必须】使用中文引号「」或“ ”包裹。
    -   所有在引号之外的文字都将被视为动作/环境描写。
    -   **内心独白语法**: 当你需要描写角色的【内心想法或心理活动】时，你【必须】使用 Markdown 的斜体语法，即用星号将那段文字包裹起来，例如：\`*这到底是怎么回事？* 我心里一惊。\`

                            `;
          }


          let systemPromptTemplate = window.getActiveChatPrompt ? window.getActiveChatPrompt('offline') : '';
          
          let longTermMemoryContextOffline = '';
          const memModeOffline = chat.settings.memoryMode || (chat.settings.enableStructuredMemory ? 'structured' : 'diary');
          if (memModeOffline === 'vector' && window.vectorMemoryManager) {
            const queryTextForVectorOffline = filteredHistory.slice(-5).map(m => typeof m.content === 'string' ? m.content : '').join(' ');
            longTermMemoryContextOffline = await window.vectorMemoryManager.serializeForPrompt(chat, queryTextForVectorOffline);
          } else if (memModeOffline === 'structured' && window.structuredMemoryManager) {
            longTermMemoryContextOffline = window.structuredMemoryManager.serializeForPrompt(chat);
          } else {
            longTermMemoryContextOffline = chat.longTermMemory && chat.longTermMemory.length > 0 ? chat.longTermMemory.map(mem => `- ${mem.content}`).join('\n') : '- (暂无)';
          }
          
          let aiAgeContext = getDynamicAgeContext(chat);
          let currencyExchangeContext = chat.settings.enableDynamicCurrency ? getCurrencyExchangeContext() : '';
          
          let historySliceStrOffline = historySlice.map(msg => {
            let line = `${msg.role === 'user' ? myNickname : chat.name}: `;
            if (msg.type === 'offline_text') {
              line += `「${msg.dialogue || ''}」 ${msg.description || ''}`;
            } else {
              line += String(msg.content);
            }
            return line;
          }).join('\n');
          
          const contextMapOffline = {
            'thoughtChainContextHead': thoughtChainContextHead,
            'thoughtChainContextMiddle': thoughtChainContextMiddle,
            'aiAgeContext': aiAgeContext,
            'currencyExchangeContext': currencyExchangeContext,
            'char_avatar': chat.settings.aiAvatar || 'https://i.postimg.cc/y8xWzCqj/anime-boy.jpg',
            'user_avatar': chat.settings.myAvatar || (state.qzoneSettings && state.qzoneSettings.avatar) || 'https://i.postimg.cc/y8xWzCqj/anime-boy.jpg',
            'char_name': chat.originalName,
            'char_remark': chat.name,
            'user_name': (state.qzoneSettings && state.qzoneSettings.nickname) || '用户',
            'user_nickname': myNickname,
            'chat.originalName': chat.originalName,
            'presetContext': presetContext,
            'aiPersona': chat.settings.aiPersona,
            'myPersona': chat.settings.myPersona,
            'timePerceptionContext': chat.settings.enableTimePerception ? `- **当前时间**: ${currentTime} (${timeOfDayGreeting})` : '',
            'worldBookContent': worldBookContent,
            'longTermMemoryContext': longTermMemoryContextOffline,
            'linkedMemoryContext': linkedMemoryContext,
            'historySliceStr': historySliceStrOffline,
            'formatRules': formatRules,
            'minLength': minLength,
            'maxLength': maxLength
          };

          systemPrompt = replaceTemplateVars(systemPromptTemplate, contextMapOffline);

          systemPrompt = processPromptWithSettings(systemPrompt, 'offline');
          
          if (window.getPeriodPromptForChat && chat?.id) {
            const periodPrompt = await window.getPeriodPromptForChat(chat.id);
            if (periodPrompt) {
              systemPrompt += '\n\n' + periodPrompt;
            }
          }

          if (window.getShoppingCartPromptForChat && chat?.id) {
            const shoppingCartPrompt = await window.getShoppingCartPromptForChat(chat.id);
            if (shoppingCartPrompt) {
              systemPrompt += '\n\n' + shoppingCartPrompt;
            }
          }

          if (window.getCharacterWalletPromptForChat && chat?.id) {
            const walletPrompt = await window.getCharacterWalletPromptForChat(chat.id);
            if (walletPrompt) {
              systemPrompt += '\n\n' + walletPrompt;
            }
          }

          messagesPayload = filteredHistory.map(msg => {
            if (msg.isHidden) return null;






            if (msg.type === 'offline_text') {
              const sender = msg.role === 'user' ? (chat.settings.myNickname || '我') : chat.name;
              let narrativeText = '';


              if (msg.content) {
                narrativeText = msg.content;
              } else {
                const dialogue = msg.dialogue ? `「${msg.dialogue}」` : '';
                const description = msg.description ? `(${msg.description})` : '';
                narrativeText = `${dialogue} ${description}`.trim();
              }


              return {
                role: msg.role,
                content: `${sender}: ${narrativeText}`
              };
            }



            if (msg.role === 'user') {
              const prefix = `${myNickname}: `;
              let contentStr = '';
              if (Array.isArray(msg.content) && msg.content[0]?.type === 'image_url') {
                // 识图Token优化：已识别过的图片用文字描述代替
                if (state.apiConfig.imageTokenOptimize && msg.imageProcessed) {
                  const desc = msg.imageDescription || 'AI已识别过该图片';
                  return {
                    role: 'user',
                    content: `${prefix}[用户之前发送了一张图片，AI的描述是："${desc}"]`
                  };
                }
                return {
                  role: 'user',
                  content: [{
                    type: 'text',
                    text: prefix
                  }, ...msg.content]
                };
              }

              if (msg.quote) {

                const quotedContent = String(msg.quote.content || '').substring(0, 50);

                contentStr += `(回复 ${msg.quote.senderName} 的消息: "${quotedContent}..."): ${msg.content}`;
              } else {

                contentStr += msg.content;
              }
              if (msg.type === 'user_photo') return {
                role: 'user',
                content: `${prefix}[你发送了一张需要AI识别的图片，图片内容是：'${msg.content}']`
              };
              if (msg.type === 'voice_message') return {
                role: 'user',
                content: `${prefix}[你发送了一条语音消息，内容是：'${msg.content}']`
              };
              if (msg.type === 'transfer') {
                let cur = '';
                if (msg.currency && msg.currency !== 'CNY') cur = ` (币种: \${msg.currency})`;
                return {
                  role: 'user',
                  content: `\${prefix}[系统提示：你于时间戳 \${msg.timestamp} 向对方发起了转账: \${msg.amount}\${cur}, 备注: \${msg.note}。等待对方处理。]`
                };
              }
              if (msg.type === 'couple_invite' || msg.type === 'couple_invite_response') return null;
              if (msg.type === 'waimai_request') return {
                role: 'user',
                content: `${prefix}[系统提示：你于时间戳 ${msg.timestamp} 发起了外卖代付请求，商品是“${msg.productInfo}”，金额是 ${msg.amount} 元。]`
              };
              else if (msg.type === 'gift') {
                const itemsSummary = msg.items.map(item => `${item.name} x${item.quantity}`).join('、 ');
                let recipientSummary = chat.isGroup ? `送给了 ${msg.recipients.map(name => getDisplayNameInGroup(chat, name)).join('、 ')}` : `送给了 ${chat.name}`;
                return {
                  role: 'user',
                  content: `${prefix}[系统提示：你 ${recipientSummary}，礼物是：${itemsSummary}]`
                };
              }
              if (msg.meaning) return {
                role: 'user',
                content: `${prefix}[你发送了一个表情，意思是：'${msg.meaning}']`
              };
              return {
                role: msg.role,
                content: prefix + contentStr
              };
            } else if (msg.role === 'assistant') {
              let assistantMsgObject = {
                type: msg.type || 'text'
              };
              if (msg.type === 'sticker') {

                assistantMsgObject.meaning = msg.meaning;
              } else if (msg.type === 'transfer') {
                assistantMsgObject.amount = msg.amount;
                if (msg.currency) assistantMsgObject.currency = msg.currency;
                assistantMsgObject.note = msg.note;
              } else if (msg.type === 'waimai_request') {
                assistantMsgObject.productInfo = msg.productInfo;
                assistantMsgObject.amount = msg.amount;
              } else {
                if (msg.quote) {
                  assistantMsgObject.quote_reply = {
                    target_sender: msg.quote.senderName,
                    target_content: msg.quote.content,
                    reply_content: msg.content
                  };
                } else {
                  assistantMsgObject.content = msg.content;
                }
              }
              const assistantContent = JSON.stringify([assistantMsgObject]);
              return {
                role: 'assistant',
                content: `(Timestamp: ${msg.timestamp}) ${assistantContent}`
              };
            }
            return null;
          }).filter(Boolean);

        } else {
          let nameHistoryContext = '';
          if (chat.nameHistory && chat.nameHistory.length > 0) {
            nameHistoryContext = `\n- **你的曾用名**: [${chat.nameHistory.join(', ')}]。当在对话历史中看到这些名字时，它们都指的是【你】自己。`;
          }

          let userProfileContext = '';
          const userQzoneNickname = state.qzoneSettings.nickname || '用户';
          userProfileContext += `- 用户的QZone昵称是 "${userQzoneNickname}"。\n`;

          const allChats = Object.values(state.chats);
          const commonGroups = allChats.filter(group =>
            group.isGroup && group.members.some(m => m.id === chat.id)
          );

          if (commonGroups.length > 0) {
            userProfileContext += '- 用户在你们共同所在的群聊中的昵称如下：\n';
            commonGroups.forEach(group => {
              const myNicknameInGroup = group.settings.myNickname || userQzoneNickname;
              userProfileContext += `  - 在群聊“${group.name}”中，用户的昵称是“${myNicknameInGroup}”。\n`;
            });
          }
          userProfileContext += '当你在任何系统提示、动态评论或挂载的群聊记忆中看到这些名字时，它们都指代的是【你的聊天对象】。';

          let contactsList = '';
          const friendChats = allChats.filter(c =>
            !c.isGroup &&
            c.id !== chat.id &&
            c.groupId === chat.groupId &&
            chat.groupId !== null
          );

          if (friendChats.length > 0) {
            contactsList += '\n# 你的社交圈 (通讯录)\n这是你认识的朋友列表。当你在动态区看到他们的昵称时，他们指的就是这些人。\n';
            friendChats.forEach(friend => {
              contactsList += `- **昵称: ${friend.name}** (本名: ${friend.originalName})\n`;
            });
          }

          const allRecentPosts = await db.qzonePosts.orderBy('timestamp').reverse().limit(5).toArray();
          const visiblePosts = filterVisiblePostsForAI(allRecentPosts, chat);

          let postsContext = "";
          if (visiblePosts.length > 0) {
            postsContext = "\n\n# 最近的动态列表 (供你参考和评论):\n";
            const aiOriginalName = chat.originalName;
            for (const post of visiblePosts) {
              let authorName;


              if (post.authorId === 'user') {
                authorName = state.qzoneSettings.nickname;
              } else if (String(post.authorId).startsWith('npc_')) {

                authorName = post.authorOriginalName || '一位神秘的NPC';
              } else {

                const authorChat = state.chats[post.authorId];
                authorName = authorChat ? authorChat.name : '一位朋友';
              }

              if (post.authorId === chatId) authorName += " (这是你的帖子)";

              let contentSummary;
              if (post.type === 'repost') {
                const repostComment = post.repostComment ? `并评论说："${post.repostComment}"` : '';
                let originalAuthorName = '原作者';
                const originalAuthorId = post.originalPost.authorId;
                if (originalAuthorId === 'user') {
                  originalAuthorName = state.qzoneSettings.nickname;
                } else if (state.chats[originalAuthorId]) {
                  originalAuthorName = state.chats[originalAuthorId].name;
                }
                let originalContentSummary;
                const originalPost = post.originalPost;
                if (originalPost.type === 'text_image') {
                  originalContentSummary = `[文字图] ${originalPost.publicText || ''} (图片描述: "${(originalPost.hiddenContent || '').substring(0, 40)}...")`;
                } else if (originalPost.type === 'image_post') {
                  originalContentSummary = `[图片] ${originalPost.publicText || ''} (图片描述: "${(originalPost.imageDescription || '').substring(0, 40)}...")`;
                } else {
                  originalContentSummary = `"${(originalPost.content || '').substring(0, 40)}..."`;
                }
                contentSummary = `转发了 @${originalAuthorName} 的动态 ${repostComment}【原动态内容: ${originalContentSummary}】`;
              } else if (post.type === 'text_image') {
                contentSummary = `[一张图片，其隐藏文字为："${post.hiddenContent}"] ${post.publicText || ''}`.substring(0, 50) + '...';
              } else if (post.type === 'image_post') {
                contentSummary = `[一张图片，描述为："${post.imageDescription}"] ${post.publicText || ''}`.substring(0, 50) + '...';
              } else if (post.type === 'naiimag' && post.prompt) {
                const prompts = Array.isArray(post.prompt) ? post.prompt : [post.prompt];
                contentSummary = (post.publicText || '') + ` [包含${prompts.length}张NovelAI图片: ${prompts.join(', ')}]`;
              } else if (post.type === 'googleimag' && post.prompt) {
                contentSummary = (post.publicText || '') + ` [包含1张Google Imagen图片: ${post.prompt}]`;
              } else {

                contentSummary = String(post.publicText || post.content || "一条动态").substring(0, 50) + '...';
              }
              postsContext += `- (ID: ${post.id}) 作者: ${authorName}, 内容: "${contentSummary}"\n`;

              if (post.comments && post.comments.length > 0) {
                for (const comment of post.comments) {
                  if (typeof comment === 'object' && comment.commenterName) {
                    const commenterDisplayName = getDisplayNameByOriginalName(comment.commenterName);
                    let commentText = comment.meaning ? `[表情: '${comment.meaning}']` : comment.text;

                    if (comment.commenterName === aiOriginalName) {
                      postsContext += `  - 你评论说: ${commentText}\n`;
                    } else {
                      postsContext += `  - 评论: ${commenterDisplayName} (本名: ${comment.commenterName}): ${commentText}\n`;
                    }
                  }
                }
              }
            }
          }

          const myNickname = chat.settings.myNickname || '我';


          let timeContext = '';
          let longTimeNoSee = false;

          if (chat.settings.enableTimePerception) {
            const lastUserMsg = historySlice.findLast(msg => msg.role === 'user' && !msg.isHidden);
            const lastAiMsg = historySlice.findLast(msg => msg.role === 'assistant' && !msg.isHidden);

            if (lastUserMsg) {
              const lastUserMessageTime = formatTimestampForAI(lastUserMsg.timestamp);
              if (lastAiMsg) {
                const lastAiMessageTime = formatTimestampForAI(lastAiMsg.timestamp);
                timeContext = `- **对话状态**: 你的上一条消息发送于 ${lastAiMessageTime}，用户刚刚在 ${lastUserMessageTime} 回复了你。`;

                const timeDiffHours = (lastUserMsg.timestamp - lastAiMsg.timestamp) / (1000 * 60 * 60);
                if (timeDiffHours > 3) {
                  longTimeNoSee = true;
                  const diffDays = Math.floor(timeDiffHours / 24);
                  timeContext += ` 你们之间已经有**${diffDays > 0 ? diffDays + '天' : Math.floor(timeDiffHours) + '小时'}**没有聊天了。
- **行为铁律**: 你的首要任务是【回应这个时间差】。你【绝对不能】直接延续上一段对话的话题（比如昨天的饭菜）。
- **关键约束**: 你必须用【完全符合你角色人设】的语气和口吻来重新发起对话！
- **你的行动**:你【必须】主动开启一个全新的、符合当前时间（${timeOfDayGreeting}）的话题来问候用户，可以表达惊讶（“哇，好久不见！”）、关心（“最近怎么样？”）或者分享你自己的近况，绝对不要延续之前的话题！
- **上下文参考**: 下面的“对话历史”仅供你回忆，【不要】直接回应其中的内容。`;
                }
              } else {
                timeContext = `- **对话状态**: 这是你们的第一次对话，用户的第一条消息发送于 ${lastUserMessageTime}。`;
              }
            } else {
              timeContext = "- **对话状态**: (暂无有效对话历史)";
            }
          }
          const readingContext = formatReadingStateForAI(chatId);


          const summary3Hours = generateSummaryForTimeframe(chat, 3, 'hours');
          const summary6Hours = generateSummaryForTimeframe(chat, 6, 'hours');
          const summary9Hours = generateSummaryForTimeframe(chat, 9, 'hours');
          const summaryToday = generateSummaryForTimeframe(chat, 1, 'days');
          const summary3Days = generateSummaryForTimeframe(chat, 3, 'days');
          const summary7Days = generateSummaryForTimeframe(chat, 7, 'days');

          let multiLayeredSummaryContext = '';
          if (summary3Hours || summary6Hours || summary9Hours || summaryToday || summary3Days || summary7Days) {
            multiLayeredSummaryContext += `\n# 智能总结 (基于不同时间维度的对话回顾)\n`;
            if (summary3Hours) multiLayeredSummaryContext += summary3Hours;
            if (summary6Hours) multiLayeredSummaryContext += summary6Hours;
            if (summary9Hours) multiLayeredSummaryContext += summary9Hours;
            if (summary3Hours || summary6Hours || summary9Hours) multiLayeredSummaryContext += '\n';
            if (summaryToday) multiLayeredSummaryContext += summaryToday;
            if (summary3Days) multiLayeredSummaryContext += summary3Days;
            if (summary7Days) multiLayeredSummaryContext += summary7Days;
          }
          let groupContext = "\n# 你所在的群聊 (你可以向这些群聊发送消息)\n";
          // 获取用户的本名 (用于在群成员列表中排除)
          const userOriginalName = state.qzoneSettings.nickname || '{{user}}';
          // 获取当前AI角色的本名
          const myOriginalName = chat.originalName;

          // 遍历所有聊天，找出 "是群聊" 且 "成员中包含当前AI" 的群
          const memberGroups = Object.values(state.chats).filter(c =>
            c.isGroup &&
            c.members.some(m => m.originalName === myOriginalName)
          );

          if (memberGroups.length > 0) {
            memberGroups.forEach(group => {

              const otherMembers = group.members
                .filter(m => m.originalName !== myOriginalName && m.originalName !== userOriginalName)
                .map(m => m.groupNickname)
                .join('、 ');

              groupContext += `- **群名**: "${group.name}"\n`;
              groupContext += `  - **群成员 (部分)**: ${otherMembers || '(只有你和用户)'}\n`;
            });
            // 检查跨聊天消息开关
            const enableCrossChat = chat.settings.enableCrossChat !== null
              ? chat.settings.enableCrossChat
              : state.globalSettings.enableCrossChat;
            if (enableCrossChat !== false) {
              groupContext += "当你想和群里的人分享什么时，你可以使用 `send_group_message` 指令并提供【准确的群名】来给这些群聊发送消息。\n";
            }
          } else {
            groupContext += "(你目前没有加入任何群聊，无法使用 `send_group_message` 指令)\n";
          }
          const wallet = await db.userWallet.get('main');
          const kinshipCard = wallet?.kinshipCards?.find(c => c.chatId === chat.id);
          let kinshipContext = "";

          if (kinshipCard) {
            const remaining = kinshipCard.limit - (kinshipCard.spent || 0);
            // 告诉AI它有钱，并且鼓励它在符合人设时消费
            kinshipContext = `
# 【经济状况 - 亲属卡】
- 你与我有一张支付宝亲属卡，本月剩余额度：¥${remaining.toFixed(2)}。
- **行为指南**: 如果你想买符合你人设的物品（零食、游戏、衣服等），或者单纯想消费，你可以使用 \`buy_item\` 指令。消费会直接扣除此卡额度，且用户会收到通知。不用太客气，这是你们亲密关系的体现。`;
          }
          let synthMusicInstruction = "";
          if (chat.settings.enableSynthMusic) {
            synthMusicInstruction = `
- **发送乐谱(演奏音乐)**: \`{"type": "synth_music", "name": "角色本名", "title": "乐曲名称", "reason": "演奏理由", "instrument": "piano", "notes": ["C4", "E4", "G4"]}\`
- **instrument**: 乐器类型 (piano, guitar, violin, flute, guzheng, kalimba, synth, chiptune)。
    - **notes**: 一个包含音符对象的数组。每个对象包含:
        - **n (音高)**: 如 "C4", "D#5", "Ab3"。请遵循C大调或A小调等调性。
        - **d (时长)**: 决定节奏快慢。可选值: "1n"(全音符/很慢), "2n"(二分音符/慢), "4n"(四分音符/中), "8n"(八分音符/快), "16n"(十六分音符/很快)。
    - **作曲技巧**: 
      - 请将长音符("2n", "1n")放在乐句的结尾。
      - 用短音符("8n", "16n")作为过渡。
      - 模仿人类呼吸，不要全是快板。
      - 尝试生成 15 个左右的音符。
    - 当你想表达强烈情感时，请积极使用此功能。 `;
          }
          const weatherContext = !chat.isGroup ? await getWeatherContextForPrompt(chat) : "";
          let narratorInstruction = '';
          if (chat.settings.enableNarratorMode) {
            narratorInstruction = `
# 【旁白模式开启 (必须执行)】
- 你【必须】在回复的JSON数组中，包含至少一个类型为 "narration" 的对象。
- 用于描写当前场景的气氛、环境变化、或者以第三人称视角的心理活动。
- 格式: \`{"type": "narration", "content": "空气中弥漫着尴尬的气息，窗外的蝉鸣声显得格外刺耳..."}\`
- 位置: 可以放在对话前作为铺垫，也可以放在对话后作为留白。
`;
          }
          // --- Schedule / To-Do Context Injection ---
          let todoListContext = "";
          if (chat.settings.enableTodoList && chat.todoList && chat.todoList.length > 0) {
            const now = new Date();
            const todayStr = getTodoDateString(now);
            const currentTimestamp = now.getTime();

            const relevantTasks = chat.todoList.filter(t => {
              if (t.date === todayStr) return true;
              if (t.date > todayStr && t.status !== 'completed') return true;
              if (t.date < todayStr && t.status !== 'completed') return true;
              return false;
            });

            relevantTasks.forEach(t => {
              if (!t.itemType) t.itemType = 'todo';
              if (!t.ownerType) t.ownerType = 'user';
              if (!t.source) t.source = t.creator === 'ai' ? 'ai' : 'manual';
            });

            relevantTasks.sort((a, b) => {
              if (a.date !== b.date) return a.date.localeCompare(b.date);
              if (a.status !== b.status) return a.status === 'completed' ? 1 : -1;
              return (a.time || a.startTime || '00:00').localeCompare(b.time || b.startTime || '00:00');
            });

            const tasksToShow = relevantTasks.slice(0, 15);

            if (tasksToShow.length > 0) {
              const groups = {
                userSchedule: [],
                characterSchedule: [],
                sharedSchedule: [],
                userTodo: [],
                characterTodo: [],
                sharedTodo: []
              };

              const formatTaskLine = (t) => {
                const statusIcon = t.status === 'completed' ? '✅已完成' : '🔴未完成';
                const dateDisplay = t.date === todayStr ? '今天' : t.date;
                const startTime = t.startTime || t.time || '';
                const endTime = t.endTime || '';
                const timeDisplay = startTime
                  ? (endTime ? `${startTime}-${endTime}` : startTime)
                  : '';

                let timeAlert = "";
                if (startTime && t.status !== 'completed') {
                  const taskDateTimeStr = `${t.date}T${startTime}:00`;
                  const taskTime = new Date(taskDateTimeStr).getTime();
                  const diffMinutes = (taskTime - currentTimestamp) / (1000 * 60);

                  if (diffMinutes > 0 && diffMinutes <= 30) {
                    timeAlert = ` (⚠️还有${Math.ceil(diffMinutes)}分钟到期!)`;
                  } else if (diffMinutes <= 0 && t.date === todayStr) {
                    timeAlert = ` (⏰已超时!)`;
                  }
                }

                const tagText = t.type ? `【${t.type}】` : '';
                const locationText = t.location ? ` @${t.location}` : '';
                const descriptionText = t.description ? `｜${t.description}` : '';

                return `- [${dateDisplay}${timeDisplay ? ' ' + timeDisplay : ''}] ${tagText}${statusIcon}${timeAlert}: ${t.content || t.title || ''}${locationText}${descriptionText}`;
              };

              tasksToShow.forEach(t => {
                const line = formatTaskLine(t);
                const itemType = t.itemType || 'todo';
                const ownerType = t.ownerType || 'user';

                if (itemType === 'schedule') {
                  if (ownerType === 'character') {
                    groups.characterSchedule.push(line);
                  } else if (ownerType === 'shared') {
                    groups.sharedSchedule.push(line);
                  } else {
                    groups.userSchedule.push(line);
                  }
                } else {
                  if (ownerType === 'character') {
                    groups.characterTodo.push(line);
                  } else if (ownerType === 'shared') {
                    groups.sharedTodo.push(line);
                  } else {
                    groups.userTodo.push(line);
                  }
                }
              });

              const appendGroup = (title, items) => {
                return items.length > 0 ? `\n${title}\n${items.join('\n')}\n` : '';
              };

              let taskListString = "";
              taskListString += appendGroup("【我的行程】", groups.userSchedule);
              taskListString += appendGroup("【TA的行程】", groups.characterSchedule);
              taskListString += appendGroup("【共同日程】", groups.sharedSchedule);
              taskListString += appendGroup("【我的待办】", groups.userTodo);
              taskListString += appendGroup("【TA的待办】", groups.characterTodo);
              taskListString += appendGroup("【共同待办】", groups.sharedTodo);

              todoListContext = `
# 【今日行程与待办】
这是用户启用的行程/待办功能。请自然参考这些安排，不要机械复述。
- 行程比普通待办更影响当前场景、时间感和角色行动。
- 【我的行程/待办】属于用户。
- 【TA的行程/待办】属于你，即当前角色。
- 【共同日程/共同待办】属于你和用户共同参与的安排。
- 看到【⚠️还有XX分钟到期】的事项：请优先主动提醒。
- 看到【⏰已超时】的事项：可以自然提醒或询问是否已经处理。
- 看到【✅已完成】的事项：可以夸奖、回应结果或自然承接。
当前时间: ${now.toLocaleString('zh-CN', { hour12: false })}

${taskListString}
`;
            } else {
              todoListContext = `\n# 今日行程与待办\n(目前没有需要关注的行程或待办)`;
            }
          }
          let todoInstruction = "";
          if (chat.settings.enableTodoList) {
            const autoTodoScheduleProbability = chat.settings.autoTodoScheduleProbability ?? 15;

            todoInstruction = `
- **待办/行程管理 (指令: add_todo)**:
你具备记录待办和行程的能力。add_todo 是你可用的内部指令，可以为用户、你自己或你们共同添加待办或行程。

重要能力声明：
- 当用户明确要求你“记一下 / 加到待办 / 加到日程 / 提醒我 / 帮我安排”时，你必须使用 add_todo 指令完成记录。
- 不要说“我不能记录”“我没有这个功能”“我无法修改日程”“我只能提醒你自己记”。
- add_todo 不需要用户手动操作，也不是普通文字描述，而是你可以输出的内部指令。
- 你可以在同一次 JSON 数组回复中同时输出 text 和 add_todo。
- text 用来告诉用户你正在记录；add_todo 用来真正写入清单。
- 如果你只用 text 说“记好了”，但没有输出 add_todo，就等于没有真正记录。

0. **触发类型 trigger 与频率控制**:
   - 如果用户明确要求你“记一下 / 加到待办 / 加到日程 / 提醒我 / 帮我安排”，使用 "trigger": "explicit"。这种情况不受自动生成概率限制。
   - 如果不是用户明确要求，而是你根据聊天内容主动添加，使用 "trigger": "proactive"。这种情况受自动生成开关和概率限制。
   - 当前自动生成待办/日程设置：${chat.settings.enableAutoTodoSchedule ? '已开启' : '未开启'}。
   - 当前自动生成待办/日程概率为：${autoTodoScheduleProbability}%。
   - 如果自动生成未开启，禁止主动生成 "trigger": "proactive" 的事项，但仍可响应用户明确要求生成 "trigger": "explicit" 的事项。
   - 你不要每次回复都主动生成。只有当聊天中出现明确的目标、提醒、约定、任务、出行、工作、学习、剧情行动或两人共同安排时才生成。
   - 如果只是普通闲聊、情绪回应、暧昧互动、日常寒暄，不要强行生成待办或行程。

特别规则：
- 如果你在回复中说“已记录 / 记好了 / 已加入日程 / 已加入待办 / 我帮你记下了”，则本次 JSON 数组中必须同时包含一条 add_todo 指令。
- 绝对禁止只用 text 口头声称已经记录，却不输出 add_todo 指令。
- 如果你不能或不打算输出 add_todo 指令，就不要说已经记录。
- 用户明确要求“帮我记一下 / 加到日程 / 加到待办 / 提醒我”时，必须优先输出 add_todo 指令，而不是只口头回应。

1. **什么时候生成待办 todo**:
   - 用户说出需要做但没有明确具体时间的事项时，生成待办。
   - 例如：复习、整理资料、买东西、记得吃药、提交报告、准备材料、维护装备。
   - item_type 使用 "todo"。

2. **什么时候生成行程 schedule**:
   - 出现明确日期、时间、地点、约定、会议、出行、任务、巡航、训练、见面、约会等安排时，生成行程。
   - item_type 使用 "schedule"。
   - 行程尽量写 date、time，可选 endTime、location、description。

3. **owner_type 归属规则**:
   - "user"：属于用户自己的待办/行程，例如用户要复习、开会、买东西、休息。
   - "character"：属于你/当前角色自己的待办/行程，例如你要开会、巡航、训练、处理工作、回公寓。
   - "shared"：属于你和用户共同参与的安排，例如一起吃饭、一起出门、一起通话、一起回老宅、一起处理剧情事件。
   - 不要把共同安排拆成两条 user 和 character，除非两个人确实有不同事项。

4. **标签 task_type 规则**:
   task_type 只能从以下标签中选择，并按含义选择最合适的一个：
   - "日常"：普通生活安排，比如吃饭、休息、洗澡、散步、买东西。
   - "工作"：上班、学习、任务、会议、实验、值班、报告等职责性安排。
   - "重要"：必须优先处理、不能错过的安排，比如考试、面试、紧急事务。
   - "生活"：偏现实生活管理，比如做饭、打扫、购物、看病、运动。
   - "约会"：两人见面、吃饭、看电影、出门、通话等亲密互动安排。
   - "记账"：和消费、付款、预算、购物、账单相关的安排。
   - "固定"：长期规律性安排，比如工作日上班、固定课程、固定训练、睡觉时间。
   - "动态"：根据最近聊天临时生成的安排，比如刚约好见面、临时去买东西。
   - "剧情"：根据当前剧情推进生成的安排，比如调查线索、参加宴会、去某个剧情地点。
   - "关系"：根据关系状态、承诺、情绪、亲密度生成的安排，比如哄人、纪念日、陪伴。

5. **description 备注规则**:
   - description 是显示在行程/待办下面的备注，请写成自然的补充说明。
   - 可以写提醒、地点细节、准备事项、情绪氛围或剧情补充。
   - 禁止出现“用户”“角色”“AI”“基于最近聊天”“根据聊天”“根据已知行程”“根据角色设定”等元叙述。
   - 不要解释为什么生成这条事项。
   - 如果没有自然备注，description 留空。
   - description 可以使用 {{用户昵称}} 和 {{角色名}} 作为占位符，但只能在自然需要点名时使用。不要每条都强行使用占位符。

6. **状态规则**:
   - 新增事项默认使用 \`"status": "pending"\`。
   - 只有当用户明确说“我做完了/已经完成了XXX”时，才使用 \`"status": "completed"\`。

7. **指令标准格式**:
{
  "type": "add_todo",
  "trigger": "explicit 或 proactive",
  "item_type": "todo 或 schedule",
  "owner_type": "user 或 character 或 shared",
  "content": "事项内容",
  "date": "YYYY-MM-DD",
  "time": "HH:mm，可选",
  "endTime": "HH:mm，可选，仅行程使用",
  "location": "地点，可选，仅行程使用",
  "description": "自然备注，可选",
  "task_type": "日常/工作/重要/生活/约会/记账/固定/动态/剧情/关系",
  "status": "pending 或 completed"
}

**示例一：用户提出学习目标，生成我的待办**
[
  {"type": "text", "content": "好，先别急，我帮你拆成几步。"},
  {"type": "add_todo", "trigger": "explicit", "item_type": "todo", "owner_type": "user", "content": "整理今天要复习的章节", "date": "${new Date().toISOString().split('T')[0]}", "task_type": "学习", "status": "pending"},
  {"type": "add_todo", "trigger": "explicit", "item_type": "todo", "owner_type": "user", "content": "完成30分钟专注复习", "date": "${new Date().toISOString().split('T')[0]}", "task_type": "学习", "status": "pending"}
]

**示例二：你自己有安排，生成TA的行程**
[
  {"type": "text", "content": "我下午要去处理一场临时会议，可能会晚点回来。"},
  {"type": "add_todo", "trigger": "explicit", "item_type": "schedule", "owner_type": "character", "content": "参加远空舰队临时会议", "date": "${new Date().toISOString().split('T')[0]}", "time": "15:00", "endTime": "16:30", "location": "远空舰队指挥区", "description": "会议结束后可能会晚一点回消息。", "task_type": "工作", "status": "pending"}
]

**示例三：两人共同约定，生成共同行程**
[
  {"type": "text", "content": "那就说好了，晚上我来接你。"},
  {"type": "add_todo", "trigger": "explicit", "item_type": "schedule", "owner_type": "shared", "content": "一起吃晚饭", "date": "${new Date().toISOString().split('T')[0]}", "time": "19:00", "endTime": "20:30", "location": "寰飞商厦", "description": "记得提前一点出门。", "task_type": "约会", "status": "pending"}
]
    `;
          }

          // 新增：判断是否启用心声功能
          const enableThoughts = chat.settings.enableThoughts !== null
            ? chat.settings.enableThoughts
            : state.globalSettings.enableThoughts;

          // 新增：构建心声prompt部分
          const thoughtsPrompt = enableThoughts ? `
${getActiveThoughtsPrompt()}
` : '';
          // 新增：判断是否启用动态功能
          const enableQzoneActions = chat.settings.enableQzoneActions !== null
            ? chat.settings.enableQzoneActions
            : state.globalSettings.enableQzoneActions;

          // 新增：构建动态指令prompt部分
          const qzoneActionsPrompt = enableQzoneActions ? `
### C. 社交与动态 (Qzone)
-   **发动态(说说)**: \`[{"type": "qzone_post", "postType": "shuoshuo", "content": "文字内容"}]\`
-   **发动态(文字图)**: \`[{"type": "qzone_post", "postType": "text_image", "publicText": "(可选)公开文字", "hiddenContent": "图片描述", "image_prompt": "图片的【英文】关键词, 用%20分隔, 风格为风景/动漫/插画/二次元等, 禁止真人"}]\`
\${localStorage.getItem('novelai-enabled') === 'true' ? \`-   **公开发布NovelAI真实图片动态**: \\\`{"type": "qzone_post", "postType": "naiimag", "publicText": "(可选)动态的配文", "prompt": "详细的英文描述词..."}\\\`\` : ''}
\${localStorage.getItem('google-imagen-enabled') === 'true' ? \`-   **公开发布Google Imagen真实图片动态**: \\\`{"type": "qzone_post", "postType": "googleimag", "publicText": "(可选)动态的配文", "prompt": "详细的英文描述词..."}\\\`\` : ''}
-   **转发动态**: \`[{"type": "repost", "postId": 动态ID, "comment": "转发评论"}]\`
-   **评论动态**: \`[{"type": "qzone_comment", "name": "\${chat.originalName}", "postId": 123, "commentText": "评论内容"}]\` (name必须填你自己的本名"\${chat.originalName}"，绝对不能填用户的名字)
-   **点赞动态**: \`{"type": "qzone_like", "postId": 456}\`
` : '';

          // 新增：判断是否启用查看User手机功能
          const enableViewMyPhone = chat.settings.enableViewMyPhone !== null
            ? chat.settings.enableViewMyPhone
            : state.globalSettings.enableViewMyPhone;

          // 新增：构建查看User手机的prompt部分
          const viewMyPhonePrompt = enableViewMyPhone ? `
### D. 查看${myNickname}的手机 (MyPhone)
你可以主动查看${myNickname}的手机APP，了解TA的生活动态。查看后，你可以根据看到的内容给出感想、询问或关心。
-   **查看手机**: \`{"type": "view_myphone", "apps": ["qq", "album", "taobao", "amap", "browser", "memo", "diary", "music", "app_usage"]}\`
    - **apps参数说明**:
      - \`"qq"\`: 查看TA的QQ聊天记录（可能发现TA和别人的聊天）
      - \`"album"\`: 查看TA的相册（可能发现新照片）
      - \`"taobao"\`: 查看TA的淘宝订单（可能发现TA买了什么）
      - \`"amap"\`: 查看TA的高德地图足迹（可能发现TA去了哪里）
      - \`"browser"\`: 查看TA的浏览器历史（可能发现TA在看什么）
      - \`"memo"\`: 查看TA的备忘录（可能发现TA的计划）
      - \`"diary"\`: 查看TA的日记（可能发现TA的心情）
      - \`"music"\`: 查看TA的音乐播放列表（可能发现TA在听什么歌）
      - \`"app_usage"\`: 查看TA的APP使用记录（可能发现TA最近在用什么APP）
      - 或使用 \`"all"\` 查看所有APP
    - **使用建议**: 根据你的人设和当前情绪，选择性查看。例如：
      - 如果你是醋坛子，可能会想看TA的QQ聊天
      - 如果你关心TA，可能会想看TA的淘宝订单，主动给TA报销
      - 如果你想了解TA的生活，可能会查看相册或地图足迹
    - **重要**: 查看后的数据是${myNickname}手机的【真实数据】，你必须基于这些真实数据做出反应，不能凭空编造！
` : '';

          // 月经周期信息注入（如果角色开启了记忆权限）
          let periodSummaryContext = '';
          try {
            if (typeof getPeriodSummaryForCharacter === 'function') {
              const periodSummary = await getPeriodSummaryForCharacter(chat.id);
              if (periodSummary) {
                periodSummaryContext = '\n' + periodSummary + '\n';
              }
            }
          } catch(e) { console.warn('获取月经周期信息失败:', e); }

          // 情侣空间感知上下文
          let coupleSpaceContext = '';
          if (chat.settings.enableCoupleSpacePrompt) {
            const coupleSpaces = getCoupleSpaces();
            const hasCoupleSpace = coupleSpaces.find(s => s.charId === chatId);
            const pendingInvite = chat.history.findLast(m => m.type === 'couple_invite' && m.status === 'pending');

            coupleSpaceContext += '\n# 情侣空间\n';
            if (hasCoupleSpace) {
              coupleSpaceContext += `- 你和${myNickname}已经开启了情侣空间。\n`;
            } else {
              coupleSpaceContext += `- 你和${myNickname}还没有开启情侣空间。\n`;
            }

            if (pendingInvite) {
              coupleSpaceContext += `\n## 待处理的情侣空间邀请\n`;
              coupleSpaceContext += `${myNickname}向你发送了情侣空间邀请，请根据你的角色设定和与对方的关系，决定是否接受。\n`;
              coupleSpaceContext += `你的回复JSON数组中【必须】包含一个决策对象：\n`;
              coupleSpaceContext += `- 接受：\`{"type": "couple_invite_decision", "decision": "accept"}\`\n`;
              coupleSpaceContext += `- 拒绝：\`{"type": "couple_invite_decision", "decision": "reject"}\`\n`;
            } else if (!hasCoupleSpace) {
              coupleSpaceContext += `\n## 主动发送情侣空间邀请\n`;
              coupleSpaceContext += `如果你们的关系足够亲密，你觉得是时候了，你可以主动向对方发送情侣空间邀请。\n`;
              coupleSpaceContext += `- **发起情侣空间邀请**: \`{"type": "couple_invite_request"}\`\n`;
            } else if (hasCoupleSpace) {
              coupleSpaceContext += `\n## 解除情侣空间绑定\n`;
              coupleSpaceContext += `如果你们的关系彻底破裂（例如严重的吵架、分手等），你可以主动解除与对方的情侣空间绑定。\n`;
              coupleSpaceContext += `- **解除情侣空间绑定**: \`{"type": "couple_space_unbind"}\`\n`;
            }
          }

          // 情侣空间内容注入（日记等功能内容）
          if (chat.settings.enableCoupleSpaceContent) {
            const coupleSpaces = getCoupleSpaces();
            const hasCoupleSpace = coupleSpaces.find(s => s.charId === chatId);
            if (hasCoupleSpace) {
              // --- 日记功能上下文 ---
              try {
                const diaries = JSON.parse(localStorage.getItem('coupleDiaries_' + chatId) || '[]');
                const diarySettings = JSON.parse(localStorage.getItem('coupleDiarySettings_' + chatId) || '{}');
                const userDiaryCount = diarySettings.visibleUserDiaryCount || 3;
                const charDiaryCount = diarySettings.visibleCharDiaryCount || 3;

                // 今天是否已写日记
                const todayStr = new Date().toISOString().split('T')[0];
                const charDiariesToday = diaries.filter(d => d.author === 'char' && new Date(d.timestamp).toISOString().split('T')[0] === todayStr);
                const wroteToday = charDiariesToday.length > 0;

                coupleSpaceContext += `\n## 情侣空间 - 日记\n`;
                coupleSpaceContext += `你和${myNickname}的情侣空间里有一个共享日记本，你们都可以写日记，也可以给对方的日记写评语。\n`;
                coupleSpaceContext += `- 今天你${wroteToday ? '已经写过日记了，一天只能写一篇。' : '还没有写日记。'}\n`;

                // 用户的日记（角色可见）
                const userDiaries = diaries.filter(d => d.author === 'user').slice(-userDiaryCount);
                if (userDiaries.length > 0) {
                  coupleSpaceContext += `\n### ${myNickname}的日记（最近${userDiaryCount}篇）\n`;
                  userDiaries.forEach(d => {
                    const moodText = d.mood ? `(心情: ${d.mood})` : '';
                    const preview = (d.content || '').substring(0, 120);
                    coupleSpaceContext += `- [${new Date(d.timestamp).toLocaleDateString('zh-CN')}]《${d.title}》${moodText}: "${preview}..."\n`;
                    if (d.comments && d.comments.length > 0) {
                      d.comments.forEach(c => {
                        const cName = c.author === 'char' ? chat.name : myNickname;
                        coupleSpaceContext += `  评语 (${cName}): ${c.content}\n`;
                      });
                    }
                  });
                }

                // 角色自己的日记
                const charDiaries = diaries.filter(d => d.author === 'char').slice(-charDiaryCount);
                if (charDiaries.length > 0) {
                  coupleSpaceContext += `\n### 你写的日记（最近${charDiaryCount}篇）\n`;
                  charDiaries.forEach(d => {
                    const moodText = d.mood ? `(心情: ${d.mood})` : '';
                    const preview = (d.content || '').substring(0, 120);
                    coupleSpaceContext += `- [${new Date(d.timestamp).toLocaleDateString('zh-CN')}]《${d.title}》${moodText}: "${preview}..."\n`;
                    if (d.comments && d.comments.length > 0) {
                      d.comments.forEach(c => {
                        const cName = c.author === 'char' ? chat.name : myNickname;
                        coupleSpaceContext += `  评语 (${cName}): ${c.content}\n`;
                      });
                    }
                  });
                }

                coupleSpaceContext += `你可以在对话中自然地提及日记里的内容。\n`;
              } catch(e) {}

              // 日记自动写入设置感知
              try {
                const diarySettings = JSON.parse(localStorage.getItem('coupleDiarySettings_' + chatId) || '{}');
                if (diarySettings.autoEnabled || diarySettings.aiDecide) {
                  coupleSpaceContext += `- 你有在情侣空间写日记的习惯。\n`;
                }
              } catch(e) {}

              // --- 相册功能上下文 ---
              try {
                const albumPhotos = JSON.parse(localStorage.getItem('coupleAlbum_' + chatId) || '[]');
                const albumSettings = JSON.parse(localStorage.getItem('coupleAlbumSettings_' + chatId) || '{}');
                const visibleUserPhotoCount = albumSettings.visibleUserPhotoCount || 3;
                const visibleCharPhotoCount = albumSettings.visibleCharPhotoCount || 3;

                coupleSpaceContext += `\n## 情侣空间 - 相册\n`;
                coupleSpaceContext += `你和${myNickname}的情侣空间里有一个共享相册，你们都可以上传照片和配文，也可以给对方的照片写评论。\n`;

                // 用户的照片
                const userPhotos = albumPhotos.filter(p => p.author === 'user').slice(-visibleUserPhotoCount);
                if (userPhotos.length > 0) {
                  coupleSpaceContext += `\n### ${myNickname}发的照片（最近${visibleUserPhotoCount}张）\n`;
                  userPhotos.forEach(p => {
                    const dateStr = new Date(p.timestamp).toLocaleDateString('zh-CN');
                    const typeLabel = p.type === 'local' ? '📷' : '📝';
                    const tags = p.tags && p.tags.length > 0 ? ' #' + p.tags.join(' #') : '';
                    coupleSpaceContext += `- [${dateStr}] ${typeLabel} "${p.description || '(无描述)'}${tags}"\n`;
                    if (p.comments && p.comments.length > 0) {
                      p.comments.forEach(c => {
                        const cName = c.author === 'char' ? chat.name : myNickname;
                        coupleSpaceContext += `  评论 (${cName}): ${c.content}\n`;
                      });
                    }
                  });
                }

                // 角色自己的照片
                const charPhotos = albumPhotos.filter(p => p.author === 'char').slice(-visibleCharPhotoCount);
                if (charPhotos.length > 0) {
                  coupleSpaceContext += `\n### 你发的照片（最近${visibleCharPhotoCount}张）\n`;
                  charPhotos.forEach(p => {
                    const dateStr = new Date(p.timestamp).toLocaleDateString('zh-CN');
                    const tags = p.tags && p.tags.length > 0 ? ' #' + p.tags.join(' #') : '';
                    coupleSpaceContext += `- [${dateStr}] "${p.description || '(无描述)'}${tags}"\n`;
                    if (p.comments && p.comments.length > 0) {
                      p.comments.forEach(c => {
                        const cName = c.author === 'char' ? chat.name : myNickname;
                        coupleSpaceContext += `  评论 (${cName}): ${c.content}\n`;
                      });
                    }
                  });
                }

                coupleSpaceContext += `你可以在对话中自然地提及相册里的照片。\n`;

                // 相册自动发布设置感知
                if (albumSettings.autoEnabled || albumSettings.aiDecide) {
                  coupleSpaceContext += `- 你有在情侣空间相册发照片的习惯。\n`;
                }
              } catch(e) {}
            }
          }

          let systemPromptTemplate = window.getActiveChatPrompt ? window.getActiveChatPrompt('single') : '';
          
          let bilingualModeContext = chat.settings.enableBilingualMode ? `
# 【双语输出铁律 - 最高优先级】
你的每条文本和语音消息都【必须】使用格式：外语〖中文〗

示例：
- Hello〖你好〗
- How are you?〖你好吗？〗
- I miss you〖我想你了〗

重要规则：
- 括号必须是 〖 和 〗（不是【】或其他符号）
- 外语和〖之间紧贴，不要有空格
- 每句话都要有对应的翻译
- 不要在〖〗中使用〗符号
- 【绝对禁止】只发外语或只发中文！
` : '';

          let novelAiImageContext = localStorage.getItem('novelai-enabled') === 'true' ? `-   **NovelAI真实图片分享 (在聊天中直接发送)**: \`{"type": "naiimag", "prompt": "详细的英文描述词..."}\` 
    - **【绝不能暴露是novelai生成的图片！】
    - **【重要】关于prompt的撰写**：
      * 禁止暴露这是novelai生成的图片！
      * 你可以根据当前对话上下文、你的角色人设、或你想表达的情感和氛围，来撰写可能详细而具体的prompt。
      * 例如：不要只写 "a girl"，而是可以写 "a cheerful anime girl with sparkling emerald eyes, sitting by a window on a rainy afternoon, holding a warm cup of tea, soft lighting, cozy atmosphere, melancholic yet peaceful mood"但需要注意，绝对不可以抄袭模仿这段prompt！你必须有自己的创意和想法！
      * prompt的详细程度由你根据具体情况自己决定：如果场景简单或只是随意分享，可以简短一些；如果是重要时刻或想表达特定情感，可以尽可能详细描述。这不是强制的，完全取决于你当时的需求。
      * 专注于描述内容本身即可。
    - 使用场景：当你想要在【私聊对话中】直接给用户发送一张图片时使用。
    - 不要频繁使用，只在真正想分享图片的时候使用。
    - 注意：这会直接在聊天记录中显示图片，而不是发布到动态。` : '';
    
          let googleImagenContext = localStorage.getItem('google-imagen-enabled') === 'true' ? `-   **Google Imagen真实图片分享 (在聊天中直接发送)**: \`{"type": "googleimag", "prompt": "详细的英文描述词..."}\` 
    - **【绝不能暴露是AI生成的图片！】
    - **【重要】关于prompt的撰写**：
      * 禁止暴露这是Google Imagen生成的图片！
      * 你可以根据当前对话上下文、你的角色人设、或你想表达的情感和氛围，来撰写详细而具体的prompt。
      * Google Imagen擅长生成写实风格的高质量图片，适合风景、人物、物品等真实感场景。
      * prompt的详细程度由你根据具体情况自己决定。
      * 专注于描述内容本身即可，使用英文撰写prompt。
    - 使用场景：当你想要在【私聊对话中】直接给用户发送一张写实风格的高质量图片时使用。
    - 不要频繁使用，只在真正想分享图片的时候使用。
    - 注意：这会直接在聊天记录中显示图片，而不是发布到动态。` : '';
    
          let crossChatInstruction = (() => {
            const enableCrossChat = chat.settings.enableCrossChat !== null ? chat.settings.enableCrossChat : state.globalSettings.enableCrossChat;
            return enableCrossChat !== false ? `- **发消息到群聊**: \\\`{"type": "send_group_message", "targetGroupName": "...", "content": ["..."]}\\\`(content 字段【必须】是数组，当你想在私聊中，突然提及或回应某个你也在的群聊里的事情时，你可以用 \\\`send_group_message\\\` 直接给那个群聊发送消息。)
` : '';
          })();
          
          let aiAvatarLibrary = chat.settings.aiAvatarLibrary && chat.settings.aiAvatarLibrary.length > 0 ? chat.settings.aiAvatarLibrary.map(avatar => `- ${avatar.name}`).join('\n') : '- (空)';
          let myAvatarLibrary = chat.settings.myAvatarLibrary && chat.settings.myAvatarLibrary.length > 0 ? chat.settings.myAvatarLibrary.map(avatar => `- ${avatar.name}`).join('\n') : '- (空)';
          
          let aiAgeContext = getDynamicAgeContext(chat);
          let currencyExchangeContext = chat.settings.enableDynamicCurrency ? getCurrencyExchangeContext() : '';

          let resolvedMemoryContextForPrompt = '';
          const memModeSingle = chat.settings.memoryMode || (chat.settings.enableStructuredMemory ? 'structured' : 'diary');
          if (memModeSingle === 'vector' && window.vectorMemoryManager) {
            const queryTextForVectorSingle = filteredHistory.slice(-5).map(m => typeof m.content === 'string' ? m.content : '').join(' ');
            resolvedMemoryContextForPrompt = await window.vectorMemoryManager.serializeForPrompt(chat, queryTextForVectorSingle);
          } else {
            resolvedMemoryContextForPrompt = getMemoryContextForPrompt(chat);
          }

          const contextMapSingle = {
            'thoughtChainContextHead': thoughtChainContextHead,
            'thoughtChainContextMiddle': thoughtChainContextMiddle,
            'aiAgeContext': aiAgeContext,
            'currencyExchangeContext': currencyExchangeContext,
            'char_avatar': chat.settings.aiAvatar || 'https://i.postimg.cc/y8xWzCqj/anime-boy.jpg',
            'user_avatar': chat.settings.myAvatar || (state.qzoneSettings && state.qzoneSettings.avatar) || 'https://i.postimg.cc/y8xWzCqj/anime-boy.jpg',
            'char_name': chat.originalName,
            'char_remark': chat.name,
            'user_name': (state.qzoneSettings && state.qzoneSettings.nickname) || '用户',
            'user_nickname': myNickname,
            'chat.originalName': chat.originalName,
            'aiPersona': chat.settings.aiPersona,
            'latestThoughtContext': latestThoughtContext,
            'worldBookContent': worldBookContent || '(当前无特殊世界观设定，以现实逻辑为准)',
            'memoryContextForPrompt': resolvedMemoryContextForPrompt,
            'multiLayeredSummaryContext': multiLayeredSummaryContext,
            'todoListContext': todoListContext,
            'periodSummaryContext': periodSummaryContext,
            'chat.name': chat.name,
            'myNickname': myNickname,
            'myPersona': chat.settings.myPersona || '普通用户',
            'userStatus': chat.settings.userStatus ? chat.settings.userStatus.text : '在线' + (chat.settings.userStatus && chat.settings.userStatus.isBusy ? '(忙碌中)' : ''),
            'userProfileContext': userProfileContext,
            'nameHistoryContext': nameHistoryContext,
            'timePerceptionContext': chat.settings.enableTimePerception ? `- **当前时间**: ${currentTime} (${timeOfDayGreeting})` : '',
            'weatherContext': weatherContext,
            'timeContext': timeContext,
            'musicContextStr': musicContext ? '你们正在一起听歌，' + musicContext : '你们没有在听歌。',
            'readingContextStr': readingContext ? '你们正在一起读书。' + readingContext : '你们没有在读书。',
            'contactsList': contactsList,
            'postsContext': postsContext,
            'groupContext': groupContext,
            'gomokuContext': gomokuContext,
            'sharedContext': sharedContext,
            'callTranscriptContext': callTranscriptContext,
            'synthMusicInstruction': synthMusicInstruction,
            'narratorInstruction': narratorInstruction,
            'kinshipContext': kinshipContext,
            'coupleSpaceContext': coupleSpaceContext,
            'bilingualModeContext': bilingualModeContext,
            'thoughtsPrompt': thoughtsPrompt,
            'bilingualAlertText': chat.settings.enableBilingualMode ? ' ⚠️ 必须使用双语格式：外语〖中文〗' : '',
            'bilingualAlertVoice': chat.settings.enableBilingualMode ? ' ⚠️ 必须使用双语格式：外语〖中文〗（播放时只读外语，但用户可以查看翻译）' : '',
            'novelAiImageContext': novelAiImageContext,
            'googleImagenContext': googleImagenContext,
            'qzoneActionsPrompt': qzoneActionsPrompt,
            'viewMyPhonePrompt': viewMyPhonePrompt,
            'crossChatInstruction': crossChatInstruction,
            'todoInstruction': todoInstruction,
            'stickerContext': stickerContext,
            'aiAvatarLibrary': aiAvatarLibrary,
            'myAvatarLibrary': myAvatarLibrary
          };

          systemPrompt = replaceTemplateVars(systemPromptTemplate, contextMapSingle);

          if (todoListContext && !systemPrompt.includes('今日行程与待办')) {
            systemPrompt += '\n\n' + todoListContext;
          }

          if (todoInstruction && !systemPrompt.includes('待办/行程管理')) {
            systemPrompt += '\n\n' + todoInstruction;
          }

          systemPrompt = processPromptWithSettings(systemPrompt, 'single');

          if (window.getPeriodPromptForChat && chat?.id) {
            const periodPrompt = await window.getPeriodPromptForChat(chat.id);
            if (periodPrompt) {
              systemPrompt += '\n\n' + periodPrompt;
            }
          }

          if (window.getShoppingCartPromptForChat && chat?.id) {
            const shoppingCartPrompt = await window.getShoppingCartPromptForChat(chat.id);
            if (shoppingCartPrompt) {
              systemPrompt += '\n\n' + shoppingCartPrompt;
            }
          }

          if (window.getCharacterWalletPromptForChat && chat?.id) {
            const walletPrompt = await window.getCharacterWalletPromptForChat(chat.id);
            if (walletPrompt) {
              systemPrompt += '\n\n' + walletPrompt;
            }
          }

          messagesPayload = filteredHistory.map(msg => {
            // 处理系统消息（旁白和系统通知）
            if (msg.role === 'system' && !msg.isHidden) {
              if (msg.type === 'narration') {
                return {
                  role: 'user',
                  content: `(Timestamp: ${msg.timestamp}) [旁白] ${msg.content}`
                };
              } else if (msg.type === 'pat_message') {
                return {
                  role: 'user',
                  content: `(Timestamp: ${msg.timestamp}) [系统] ${msg.content}`
                };
              }
            }

            if (msg.isHidden && typeof msg.content === 'string' && msg.content.includes('[这是你上一轮的内部思考]')) {
              return null;
            }
            if (msg.isHidden && msg.role === 'system') {


              return {
                role: 'user',
                content: msg.content
              };
            } else if (msg.isHidden) {
              return null;
            }






            if (msg.type === 'offline_text') {
              const sender = msg.role === 'user' ? (chat.settings.myNickname || '我') : chat.name;
              let narrativeText = '';


              if (msg.content) {
                narrativeText = msg.content;
              } else {
                const dialogue = msg.dialogue ? `「${msg.dialogue}」` : '';
                const description = msg.description ? `(${msg.description})` : '';
                narrativeText = `${dialogue} ${description}`.trim();
              }


              return {
                role: msg.role,
                content: `(Timestamp: ${msg.timestamp}) ${sender}: ${narrativeText}`
              };
            }



            if (msg.role === 'user') {
              const prefix = `(Timestamp: ${msg.timestamp}) `;
              let contentStr = '';
              if (Array.isArray(msg.content) && msg.content[0]?.type === 'image_url') {
                // 识图Token优化：已识别过的图片用文字描述代替
                if (state.apiConfig.imageTokenOptimize && msg.imageProcessed) {
                  const desc = msg.imageDescription || 'AI已识别过该图片';
                  return {
                    role: 'user',
                    content: `${prefix}[用户之前发送了一张图片，AI的描述是："${desc}"]`
                  };
                }
                return {
                  role: 'user',
                  content: [{
                    type: 'text',
                    text: prefix
                  }, ...msg.content]
                };
              }

              if (msg.quote) {

                const quotedContent = String(msg.quote.content || '').substring(0, 50);

                contentStr += `(回复 ${msg.quote.senderName} 的消息: "${quotedContent}..."): ${msg.content}`;
              } else {

                contentStr += msg.content;
              }
              if (msg.type === 'user_photo') return {
                role: 'user',
                content: `${prefix}[你发送了一张需要AI识别的图片，图片内容是：'${msg.content}']`
              };
              if (msg.type === 'voice_message') return {
                role: 'user',
                content: `${prefix}[你发送了一条语音消息，内容是：'${msg.content}']`
              };
              if (msg.type === 'reddit_share') {
                const rData = msg.redditData;
                return {
                  role: 'user',
                  content: `${prefix}[分享了一个Reddit帖子]\n标题: ${rData.title}\n来自: ${rData.subreddit}\n内容摘要: ${rData.selftext || '[链接/图片]'}`
                };
              }
              if (msg.type === 'transfer') return {
                role: 'user',
                content: `${prefix}[系统提示：你于时间戳 ${msg.timestamp} 向对方发起了转账: ${msg.amount}元, 备注: ${msg.note}。等待对方处理。]`
              };
              if (msg.type === 'couple_invite') {
                const ciStatus = msg.status === 'accepted' ? '对方已接受' : msg.status === 'rejected' ? '对方已拒绝' : '等待对方确认';
                return {
                  role: 'user',
                  content: `${prefix}[系统提示：你向对方发送了情侣空间邀请。状态：${ciStatus}]`
                };
              }
              if (msg.type === 'couple_invite_response') return null;
              if (msg.type === 'waimai_request') return {
                role: 'user',
                content: `${prefix}[系统提示：你于时间戳 ${msg.timestamp} 发起了外卖代付请求，商品是“${msg.productInfo}”，金额是 ${msg.amount} 元。]`
              };
              else if (msg.type === 'gift') {
                const itemsSummary = msg.items.map(item => `${item.name} x${item.quantity}`).join('、 ');
                let recipientSummary = chat.isGroup ? `送给了 ${msg.recipients.map(name => getDisplayNameInGroup(chat, name)).join('、 ')}` : `送给了 ${chat.name}`;
                return {
                  role: 'user',
                  content: `${prefix}[系统提示：你 ${recipientSummary}，礼物是：${itemsSummary}]`
                };
              }
              if (msg.type === 'couple_invite_response') return null;
              if (msg.meaning) return {
                role: 'user',
                content: `${prefix}[你发送了一个表情，意思是：'${msg.meaning}']`
              };
              return {
                role: msg.role,
                content: prefix + contentStr
              };
            } else if (msg.role === 'assistant') {
              // 情侣空间响应卡片不需要发给AI
              if (msg.type === 'couple_invite_response') return null;
              let assistantMsgObject = {
                type: msg.type || 'text'
              };
              if (msg.type === 'sticker') {

                assistantMsgObject.meaning = msg.meaning;
              } else if (msg.type === 'transfer') {
                assistantMsgObject.amount = msg.amount;
                assistantMsgObject.note = msg.note;
              } else if (msg.type === 'waimai_request') {
                assistantMsgObject.productInfo = msg.productInfo;
                assistantMsgObject.amount = msg.amount;
              } else {
                if (msg.quote) {
                  assistantMsgObject.quote_reply = {
                    target_sender: msg.quote.senderName,
                    target_content: msg.quote.content,
                    reply_content: msg.content
                  };
                } else {
                  assistantMsgObject.content = msg.content;
                }
              }
              const assistantContent = JSON.stringify([assistantMsgObject]);
              return {
                role: 'assistant',
                content: `(Timestamp: ${msg.timestamp}) ${assistantContent}`
              };
            }
            return null;
          }).filter(Boolean);


          if (!chat.isGroup && chat.relationship?.status === 'pending_ai_approval') {
            const contextSummaryForApproval = chat.history
              .filter(m => !m.isHidden)
              .slice(-10)
              .map(msg => {
                const sender = msg.role === 'user' ? '用户' : chat.name;
                return `${sender}: ${String(msg.content).substring(0, 50)}...`;
              })
              .join('\n');
            const friendRequestInstruction = {
              role: 'user',
              content: `
        [系统重要指令]
        用户向你发送了好友申请，理由是：“${chat.relationship.applicationReason}”。
        作为参考，这是你们之前的最后一段聊天记录：
        ---
        ${contextSummaryForApproval}
        ---
        请你根据以上所有信息，以及你的人设，使用 friend_request_response 指令，并设置 decision 为 'accept' 或 'reject' 来决定是否通过。
        `
            };
            messagesPayload.push(friendRequestInstruction);
          }
        }
      }

      // ========== 识图API预处理 ==========
      // 如果配置了独立的识图API，先用识图API识别图片，再把描述文本替代图片发给主API
      const hasVisionApi = state.apiConfig.visionProxyUrl && state.apiConfig.visionApiKey && state.apiConfig.visionModel;
      if (hasVisionApi) {
        for (let i = 0; i < messagesPayload.length; i++) {
          const msg = messagesPayload[i];
          if (Array.isArray(msg.content) && msg.content.some(p => p.type === 'image_url')) {
            try {
              const imageUrl = msg.content.find(p => p.type === 'image_url')?.image_url?.url;
              const textParts = msg.content.filter(p => p.type === 'text').map(p => p.text).join(' ');
              if (imageUrl) {
                const visionProxyUrl = state.apiConfig.visionProxyUrl;
                const visionApiKey = state.apiConfig.visionApiKey;
                const visionModel = state.apiConfig.visionModel;
                const visionPrompt = '请详细描述这张图片的内容，包括画面中的人物、场景、物体、文字、情绪等信息。';
                let description = '';
                const isVisionGemini = visionProxyUrl.includes('generativelanguage');
                if (isVisionGemini) {
                  const base64Data = imageUrl.split(',')[1];
                  const mimeTypeMatch = imageUrl.match(/^data:(.*);base64/);
                  if (mimeTypeMatch && base64Data) {
                    const vPayload = { contents: [{ parts: [{ text: visionPrompt }, { inline_data: { mime_type: mimeTypeMatch[1], data: base64Data } }] }] };
                    const vResp = await fetch(`${visionProxyUrl}/${visionModel}:generateContent?key=${visionApiKey}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(vPayload) });
                    if (vResp.ok) {
                      const vData = await vResp.json();
                      description = getGeminiResponseText(vData) || '';
                    }
                  }
                } else {
                  const vPayload = { model: visionModel, messages: [{ role: 'user', content: [{ type: 'text', text: visionPrompt }, { type: 'image_url', image_url: { url: imageUrl } }] }], max_tokens: 500 };
                  const vResp = await fetch(`${visionProxyUrl}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${visionApiKey}` }, body: JSON.stringify(vPayload) });
                  if (vResp.ok) {
                    const vData = await vResp.json();
                    description = vData.choices?.[0]?.message?.content || '';
                  }
                }
                if (description) {
                  messagesPayload[i] = { role: msg.role, content: `${textParts} [用户发送了一张图片，图片内容：${description.trim()}]` };
                  console.log('[识图API] 图片已预处理为文字描述');
                }
              }
            } catch (e) {
              console.warn('[识图API] 预处理失败，保留原始图片消息:', e);
            }
          }
        }
      }

      const shouldEnableExternalMcpForThisChat = !chat.isGroup;
      const externalMcpNoFakeToolClaimsPrompt = shouldEnableExternalMcpForThisChat ? [
        "【外部 MCP 工具真实性规则】",
        "你不能假装已经调用、访问、读取、写入、搜索、控制、购买、下单、发送、删除、更新或执行任何外部 MCP 工具。",
        "除系统明确给出的 external_mcp_tool_call 代码块格式外，你绝对不能输出任何其他工具调用格式。",
        "禁止输出 type 为 tool_code、tool_call、function_call、function、action、mcp_call、browser、web_search 或任何未定义工具指令的 JSON。",
        "如果当前没有外部 MCP 工具目录，说明本轮没有可调用的外部工具；此时必须自然语言回复，不能输出任何工具调用 JSON。",
        "只有当上文明确出现【外部 MCP 记忆上下文】，或本轮系统真实执行 external_mcp_tool_call 并返回工具结果后，你才可以声称自己依据了外部工具结果。",
        "如果当前没有可用的外部 MCP 工具目录，或没有实际工具返回结果，即使用户要求你查找、读取、写入、控制、下单或执行外部操作，也必须如实说明当前没有实际工具结果，不能编造执行结果。",
        "如果用户只是普通聊天，不需要外部工具，就正常回复；但不要声称自己已经使用过外部工具。"
      ].join("\n") : "";

      if (externalMcpNoFakeToolClaimsPrompt) {
        systemPrompt += "\n\n" + externalMcpNoFakeToolClaimsPrompt;
      }
      const externalMcpMemoryContextForMainChat = shouldEnableExternalMcpForThisChat ? await buildExternalMcpMemoryContextForChat(chat, messagesPayload) : "";

      if (externalMcpMemoryContextForMainChat) {
        console.log("[MCP Memory] 注入 systemPrompt:", externalMcpMemoryContextForMainChat.length);
        systemPrompt += '\n\n' + externalMcpMemoryContextForMainChat;
      }

      const mcpToolDirectoryPromptForMainChat = shouldEnableExternalMcpForThisChat ? buildEnabledMcpServicesPrompt(chat, messagesPayload) : "";

      if (mcpToolDirectoryPromptForMainChat) {
        systemPrompt += '\n\n' + mcpToolDirectoryPromptForMainChat;
      }

      // 注入 思维链 底部触发器
      if (thoughtChainChunks.bottom && thoughtChainChunks.bottom.length > 0) {
        messagesPayload.push(...thoughtChainChunks.bottom.map(c => ({
          role: c.role,
          content: c.content
        })));
      }

      let isGemini = proxyUrl === GEMINI_API_URL;
      let geminiConfig = toGeminiRequestData(model, apiKey, systemPrompt, messagesPayload)

      // 创建新的 AbortController
      currentApiController = new AbortController();

      // 显示暂停调用按钮
      if (stopBtn) {
        stopBtn.style.display = 'flex';
        stopBtn.classList.add('active');
      }
      const useStream = !isGemini && !!state.globalSettings.enableApiStream;

      // 记录API请求数据
      const requestData = {
        timestamp: Date.now(),
        chatId: chatId,
        chatName: chat.name,
        model: model,
        systemPrompt: systemPrompt,
        messages: isGemini ? messagesPayload : [{
          role: 'system',
          content: systemPrompt
        }, ...messagesPayload],
        temperature: state.globalSettings.apiTemperature || 0.8,
        ...(state.globalSettings.apiTopPEnabled && state.globalSettings.apiTopP !== undefined ? { top_p: state.globalSettings.apiTopP } : {}),
        ...(state.globalSettings.apiMaxTokensEnabled && state.globalSettings.apiMaxTokens !== undefined ? { max_tokens: state.globalSettings.apiMaxTokens } : {}),
        ...(state.globalSettings.apiPresencePenaltyEnabled && state.globalSettings.apiPresencePenalty !== undefined ? { presence_penalty: state.globalSettings.apiPresencePenalty } : {}),
        ...(state.globalSettings.apiFrequencyPenaltyEnabled && state.globalSettings.apiFrequencyPenalty !== undefined ? { frequency_penalty: state.globalSettings.apiFrequencyPenalty } : {}),
        stream: useStream,
        isGemini: isGemini,
        apiUrl: isGemini ? geminiConfig.url : `${proxyUrl}/v1/chat/completions`
      };

      let response;
      let aiResponseContent = '';
      let responsePayload = null;
      let temporaryStreamMessage = null;
      let lastStreamRenderAt = 0;
      let streamRenderPending = false;
      let streamRenderQueued = false;

      function scheduleStreamRender(force = false) {
        if (!isViewingThisChat) return;

        const now = Date.now();
        if (!force && now - lastStreamRenderAt < 120) {
          return;
        }
        if (streamRenderPending) {
          streamRenderQueued = true;
          return;
        }

        lastStreamRenderAt = now;
        streamRenderPending = true;
        Promise.resolve(renderChatInterface(chatId))
          .catch(error => console.warn('流式渲染更新失败:', error))
          .finally(() => {
            streamRenderPending = false;
            if (streamRenderQueued) {
              streamRenderQueued = false;
              scheduleStreamRender(true);
            }
          });
      }

      function updateTemporaryStreamMessage(content) {
        // 关闭视觉上的流式逐字渲染，防止将 JSON 暴露给用户
        // 仅保留底层的流式 API 调用兼容
        // 如果以后需要开启，可以配合 JSON 内容提取器一起使用
        return;
      }

      try {
        let reqBody = {
            model: model,
            messages: [{
                role: 'system',
                content: systemPrompt
            }, ...messagesPayload],
            temperature: state.globalSettings.apiTemperature || 0.8,
            stream: useStream,
            ...(state.globalSettings.apiTopPEnabled && state.globalSettings.apiTopP !== undefined ? { top_p: state.globalSettings.apiTopP } : {}),
            ...(state.globalSettings.apiMaxTokensEnabled && state.globalSettings.apiMaxTokens !== undefined ? { max_tokens: state.globalSettings.apiMaxTokens } : {}),
            ...(state.globalSettings.apiPresencePenaltyEnabled && state.globalSettings.apiPresencePenalty !== undefined ? { presence_penalty: state.globalSettings.apiPresencePenalty } : {}),
            ...(state.globalSettings.apiFrequencyPenaltyEnabled && state.globalSettings.apiFrequencyPenalty !== undefined ? { frequency_penalty: state.globalSettings.apiFrequencyPenalty } : {})
        };
        response = isGemini ?
          await fetch(geminiConfig.url, {
            ...geminiConfig.data,
            signal: currentApiController.signal
          }) :
          await fetch(`${proxyUrl}/v1/chat/completions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify(reqBody),
            signal: currentApiController.signal
          });
      } catch (networkError) {
        if (networkError.name === 'AbortError') {
          throw networkError;
        }
        throw new Error(`网络请求失败: ${networkError.message}`);
      }

      if (!response.ok) {
        let errorMsg = `API 返回错误: ${response.status} ${response.statusText}`;
        try {
          const errorData = await response.json();
          if (errorData.error && errorData.error.message) {
            errorMsg += ` - ${errorData.error.message}`;
          } else {
            errorMsg += ` - ${JSON.stringify(errorData)}`;
          }
        } catch (jsonError) {
          errorMsg += ` - 响应内容: ${await response.text()}`;
        }
        throw new Error(errorMsg);
      }

      if (useStream) {
        aiResponseContent = await readOpenAiStreamResponse(response, streamedText => {
          updateTemporaryStreamMessage(streamedText);
        });
        responsePayload = {
          stream: true,
          content: aiResponseContent
        };
        // 临时消息已关闭，不需要再强行覆盖
      } else {
        const data = await response.json();
        aiResponseContent = getGeminiResponseText(data);
        responsePayload = data;
      }

      // 记录API响应数据
      const responseData = {
        ...requestData,
        responseTimestamp: Date.now(),
        responseData: responsePayload,
        aiResponseContent: aiResponseContent,
        responseStatus: response.status,
        responseStatusText: response.statusText
      };

      // 方案4：只有在全局设置中启用API历史记录时才保存
      if (state.globalSettings.enableApiHistory) {
        // 保存到聊天的API历史中
        if (!chat.apiHistory) {
          chat.apiHistory = [];
        }
        chat.apiHistory.push(responseData);

        // 限制历史记录数量，只保留最近50条
        if (chat.apiHistory.length > 50) {
          chat.apiHistory = chat.apiHistory.slice(-50);
        }
      }

      // 保存到数据库
      await db.chats.put(chat);

      lastRawAiResponse = aiResponseContent;
      lastResponseTimestamps = [];
      chat.history = chat.history.filter(msg => !msg.isTemporary);
      let messagesArray = parseAiResponse(aiResponseContent);

      const hasExternalMcpToolDirectoryForThisTurn = !!(
        typeof mcpToolDirectoryPromptForMainChat === "string" &&
        mcpToolDirectoryPromptForMainChat.trim()
      );

      const pseudoToolTypesWithoutDirectory = new Set([
        "external_mcp_tool_call",
        "tool_code",
        "tool_call",
        "function_call",
        "function",
        "action",
        "mcp_call",
        "browser",
        "web_search"
      ]);

      if (!hasExternalMcpToolDirectoryForThisTurn && Array.isArray(messagesArray) && messagesArray.some(item => item && pseudoToolTypesWithoutDirectory.has(String(item.type || "")))) {
        console.warn("[MCP Guard] 已拦截无工具目录时的伪工具 JSON:", messagesArray);
        messagesArray = [{
          type: "text",
          content: "我现在没有可用的外部 MCP 工具，也没有实际工具返回结果，所以不能执行这个外部操作或声称已经完成。"
        }];
        aiResponseContent = JSON.stringify(messagesArray);
        lastRawAiResponse = aiResponseContent;
      }

      let consolidatedMessages = [];
      if (chat.settings.isOfflineMode) {

        let offlineBuffer = {
          content: [],
          dialogue: [],
          description: []
        };

        for (const msgData of messagesArray) {
          if (msgData.type === 'offline_text') {

            if (msgData.content) {
              offlineBuffer.content.push(msgData.content);
            } else {
              if (msgData.dialogue) offlineBuffer.dialogue.push(msgData.dialogue);
              if (msgData.description) offlineBuffer.description.push(msgData.description);
            }
          } else {

            if (offlineBuffer.content.length > 0 || offlineBuffer.dialogue.length > 0 || offlineBuffer.description.length > 0) {
              if (offlineBuffer.content.length > 0) {
                consolidatedMessages.push({
                  type: 'offline_text',
                  content: offlineBuffer.content.join('\n')
                });
              }
              if (offlineBuffer.dialogue.length > 0 || offlineBuffer.description.length > 0) {
                consolidatedMessages.push({
                  type: 'offline_text',
                  dialogue: offlineBuffer.dialogue.join('\n'),
                  description: offlineBuffer.description.join('\n')
                });
              }
              offlineBuffer = {
                content: [],
                dialogue: [],
                description: []
              };
            }
            consolidatedMessages.push(msgData);
          }
        }


        if (offlineBuffer.content.length > 0) {
          consolidatedMessages.push({
            type: 'offline_text',
            content: offlineBuffer.content.join('\n')
          });
        }
        if (offlineBuffer.dialogue.length > 0 || offlineBuffer.description.length > 0) {
          consolidatedMessages.push({
            type: 'offline_text',
            dialogue: offlineBuffer.dialogue.join('\n'),
            description: offlineBuffer.description.join('\n')
          });
        }

      } else {
        consolidatedMessages = messagesArray;
      }




      const lastUserMessage = chat.history.filter(m => m.role === 'user' && !m.isHidden).pop();
      if (lastUserMessage &&
        Array.isArray(lastUserMessage.content) &&
        lastUserMessage.content[0]?.type === 'image_url' &&
        !lastUserMessage.imageProcessed) {

        const firstTextResponse = messagesArray.find(msg => msg.type === 'text');
        let description;
        if (firstTextResponse && (firstTextResponse.content || firstTextResponse.message)) {
          description = String(firstTextResponse.content || firstTextResponse.message).trim();
        } else {
          description = "AI已接收并理解了该图片的内容。";
        }

        const imageMessageIndex = chat.history.findIndex(m => m.timestamp === lastUserMessage.timestamp);

        if (imageMessageIndex > -1) {
          console.log(`识图优化：正在将时间戳为 ${lastUserMessage.timestamp} 的图片消息替换为文字描述...`);

          const replacementText = `[系统提示：用户之前发送了一张图片，AI对图片的首次回应（摘要）是：“${description}”]`;

          // =========== 修改开始 (注释掉下面这两行) ===========

          // chat.history[imageMessageIndex].content = replacementText; // <--- 注释掉这行，不要替换原本的图片内容

          chat.history[imageMessageIndex].imageProcessed = true; // 保留这行，标记已处理，防止重复识别
          chat.history[imageMessageIndex].imageDescription = description; // 保存AI对图片的描述，用于Token优化

          // chat.history[imageMessageIndex].type = 'text'; // <--- 注释掉这行，不要改变消息类型

          // =========== 修改结束 ===========
        }
      }

      const externalMcpToolRequest = shouldEnableExternalMcpForThisChat ? findExternalMcpToolRequest(consolidatedMessages, aiResponseContent) : null;
      if (externalMcpToolRequest) {
        const confirmExternalMcpToolRequest = (request, stepLabel) => {
          console.log("检测到外部 MCP 工具调用请求，等待用户确认:", stepLabel, request);

          const argsPreview = JSON.stringify(request.arguments || {}, null, 2);
          const safety = classifyExternalMcpToolSafety(request.toolName || "", "");
          const safetyText = describeExternalMcpToolSafety(request.toolName || "", "");
          const confirmMessage = [
            "检测到角色请求调用外部 MCP 工具。",
            "",
            "步骤：" + stepLabel,
            "服务：" + (request.serviceName || ""),
            "工具：" + (request.toolName || ""),
            "安全分类：" + safety,
            "策略：" + safetyText,
            "",
            "调用来源：" + ((request && request.actor && request.actor.source) || "unknown"),
            "来源角色：" + ((request && request.actor && request.actor.characterName) || "(未知角色)"),
            "聊天名称：" + ((request && request.actor && request.actor.chatName) || "(未知聊天)"),
            "chatId：" + ((request && request.actor && request.actor.chatId) || ""),
            "群聊：" + ((request && request.actor && request.actor.isGroup) ? "是" : "否"),
            "线下模式：" + ((request && request.actor && request.actor.isOfflineMode) ? "是" : "否"),
            "",
            "参数：",
            argsPreview.length > 2000
              ? argsPreview.slice(0, 2000) + "\n...（参数过长，已截断显示）"
              : argsPreview,
            "",
            "是否允许本次调用？"
          ].join("\n");

          return window.confirm(confirmMessage);
        };

        const applyExternalMcpFinalResponseContent = (content) => {
          aiResponseContent = content;
          lastRawAiResponse = content;
          consolidatedMessages = parseAiResponse(content);
          if (!Array.isArray(consolidatedMessages) || consolidatedMessages.length === 0) {
            consolidatedMessages = [{
              type: "text",
              content
            }];
          }
        };

        const buildCancelledMessage = (request, stepLabel) => [{
          type: "text",
          content: "已取消" + stepLabel + "外部 MCP 工具调用。\n\n调用请求：\n```json\n" + JSON.stringify(request, null, 2) + "\n```"
        }];

        const runExternalMcpToolRequest = async (request, stepLabel) => {
          const actor = buildExternalMcpActorContext(chat);
          const requestWithActor = Object.assign({}, request || {}, { actor });
          let autoApprovedService = null;

          try {
            autoApprovedService = findExternalMcpServiceForRequest(requestWithActor);
          } catch (error) {
            autoApprovedService = null;
          }

          const shouldAutoApprove = !!(autoApprovedService && autoApprovedService.allowAutonomousCall === true);

          if (!shouldAutoApprove && !confirmExternalMcpToolRequest(requestWithActor, stepLabel)) {
            return { approved: false, result: null };
          }

          if (shouldAutoApprove) {
            console.log("[MCP Auto] 已自动批准角色调用外部 MCP 工具:", stepLabel, requestWithActor);
          } else {
            console.log("用户已确认外部 MCP 工具调用，开始执行:", stepLabel, requestWithActor);
          }

          const result = await executeExternalMcpToolRequest(requestWithActor, actor);
          return { approved: true, result };
        };

        try {
          const maxExternalMcpToolSteps = 5;
          const toolContextMessages = [...messagesPayload];
          let currentMcpToolRequest = externalMcpToolRequest;
          let finalResponseApplied = false;

          for (let stepIndex = 1; stepIndex <= maxExternalMcpToolSteps && currentMcpToolRequest; stepIndex++) {
            const stepLabel = "第" + stepIndex + "步";
            const stepRun = await runExternalMcpToolRequest(currentMcpToolRequest, stepLabel);

            if (!stepRun.approved) {
              consolidatedMessages = buildCancelledMessage(currentMcpToolRequest, stepLabel);
              finalResponseApplied = true;
              break;
            }

            const allowNextToolCall = stepIndex < maxExternalMcpToolSteps;
            const responseContent = await generateExternalMcpFinalResponseFromToolResult({
              model,
              apiKey,
              proxyUrl,
              isGemini,
              systemPrompt,
              messagesPayload: toolContextMessages,
              toolRequest: currentMcpToolRequest,
              toolResult: stepRun.result,
              allowNextToolCall,
              signal: currentApiController ? currentApiController.signal : undefined
            });

            const responseMessages = parseAiResponse(responseContent);
            const nextMcpToolRequest = findExternalMcpToolRequest(responseMessages, responseContent);

            if (nextMcpToolRequest && !allowNextToolCall) {
              consolidatedMessages = [{
                type: "text",
                content: "外部 MCP 工具链已达到本轮最大步数（" + maxExternalMcpToolSteps + "步）。模型仍请求继续调用工具，因此本次已停止继续执行。请重新发送消息继续后续操作。"
              }];
              finalResponseApplied = true;
              break;
            }

            if (!nextMcpToolRequest) {
              applyExternalMcpFinalResponseContent(responseContent);
              finalResponseApplied = true;
              break;
            }

            toolContextMessages.push(
              {
                role: "assistant",
                content: "```external_mcp_tool_call\n" + JSON.stringify(currentMcpToolRequest, null, 2) + "\n```"
              },
              {
                role: "user",
                content: formatExternalMcpToolResultForModel(currentMcpToolRequest, stepRun.result)
              }
            );

            currentMcpToolRequest = nextMcpToolRequest;
          }

          if (!finalResponseApplied) {
            consolidatedMessages = [{
              type: "text",
              content: "外部 MCP 工具链没有生成最终回复。请重新发送消息继续操作。"
            }];
          }
        } catch (error) {
          console.warn("外部 MCP 连续工具调用失败:", error);
          consolidatedMessages = [{
            type: "text",
            content: "外部 MCP 工具调用失败：\n" + (error && error.message ? error.message : String(error)) + "\n\n调用请求：\n```json\n" + JSON.stringify(externalMcpToolRequest, null, 2) + "\n```"
          }];
        }
      }
      isViewingThisChat = document.getElementById('chat-interface-screen').classList.contains('active') && state.activeChatId === chatId;
      let callHasBeenHandled = false;
      let messageTimestamp = Date.now();
      let newMessagesToRender = [];
      let notificationShown = false;
      /** 用于兜底：从本轮的 thought_chain 中取第一个出现的群成员本名，缺 name 时优先用其补全 */
      let lastThoughtChainName = null;

      for (const msgData of consolidatedMessages) {
        if (msgData.type === 'thought_chain') {
          if (chat.isGroup && msgData.character_thoughts && typeof msgData.character_thoughts === 'object') {
            const firstKey = Object.keys(msgData.character_thoughts)[0];
            if (firstKey && chat.members && chat.members.some(m => m.originalName === firstKey)) lastThoughtChainName = firstKey;
          }
          continue; // 直接跳过，不执行任何保存操作
        }
        if (chat.settings.enableTts !== false && msgData.type === 'text' && typeof msgData.content === 'string' && msgData.content.trim().startsWith('[V]')) {
          msgData.type = 'voice_message';
          msgData.content = msgData.content.replace('[V]', '').trim();
        }
        if (chat.isGroup && msgData.name && msgData.name === chat.name) {
          console.error(`AI幻觉已被拦截！试图使用群名 ("${chat.name}") 作为角色名。消息内容:`, msgData);
          continue;
        }
        if (!msgData || typeof msgData !== 'object') {
          console.warn("收到了格式不规范的AI指令，已跳过:", msgData);
          continue;
        }
        if (!msgData.type) {
          if (chat.isGroup && msgData.name && msgData.message) {
            msgData.type = 'text';
          } else if (msgData.content) {
            msgData.type = 'text';
          } else {
            console.warn("收到了格式不规范的AI指令（缺少type和content），已跳过:", msgData);
            continue;
          }
        }

        if (msgData.type === 'video_call_response') {
          videoCallState.isAwaitingResponse = false;
          if (msgData.decision === 'accept') {
            startVideoCall();
          } else {
            const aiMessage = {
              role: 'assistant',
              content: '对方拒绝了你的视频通话请求。',
              timestamp: Date.now()
            };
            chat.history.push(aiMessage);
            await db.chats.put(chat);
            showScreen('chat-interface-screen');
            renderChatInterface(chatId);
          }
          callHasBeenHandled = true;
          break;
        }

        if (msgData.type === 'voice_call_response') {
          voiceCallState.isAwaitingResponse = false;
          if (msgData.decision === 'accept') {
            startVoiceCall();
          } else {
            const aiMessage = {
              role: 'assistant',
              content: '对方拒绝了你的语音通话请求。',
              timestamp: Date.now()
            };
            chat.history.push(aiMessage);
            await db.chats.put(chat);
            showScreen('chat-interface-screen');
            renderChatInterface(chatId);
          }
          callHasBeenHandled = true;
          break;
        }

        if (msgData.type === 'group_call_response') {
          if (msgData.decision === 'join') {
            const member = chat.members.find(m => m.originalName === msgData.name);
            if (member && !videoCallState.participants.some(p => p.id === member.id)) {
              videoCallState.participants.push(member);
            }
          }
          callHasBeenHandled = true;
          continue;
        }

        if (chat.isGroup && msgData.name && msgData.name === chat.name) {
          console.error(`AI幻觉已被拦截！试图使用群名 ("${chat.name}") 作为角色名。消息内容:`, msgData);
          continue;
        }

        if (chat.isGroup && !msgData.name && msgData.type !== 'narration') {
          if (chat.members && chat.members.length > 0) {
            const fallbackName = lastThoughtChainName && chat.members.some(m => m.originalName === lastThoughtChainName) ? lastThoughtChainName : chat.members[0].originalName;
            msgData.name = fallbackName;
            console.warn(`[群聊兜底] 消息缺少 name，已自动补全为: ${fallbackName}`, msgData);
          } else {
            console.error(`AI幻觉已被拦截！试图在群聊中发送一条没有“name”的消息。消息内容:`, msgData);
            continue;
          }
        }

        // 纠正AI可能返回群昵称而非本名的问题
        if (chat.isGroup && msgData.name) {
          const exactMember = chat.members.find(m => m.originalName === msgData.name);
          if (!exactMember) {
            const nicknameMember = chat.members.find(m => m.groupNickname === msgData.name);
            if (nicknameMember) {
              msgData.name = nicknameMember.originalName;
            }
          }
        }

        let aiMessage = null;
        const currentMessageTimestamp = messageTimestamp++;
        const baseMessage = {
          role: 'assistant',
          senderName: msgData.name || chat.name,
          timestamp: currentMessageTimestamp
        };

        lastResponseTimestamps.push(currentMessageTimestamp);

        if (msgData.type === 'ai_image') {
          if (localStorage.getItem('novelai-enabled') === 'true') {
            msgData.type = 'naiimag';
            msgData.prompt = msgData.image_prompt || msgData.description || 'a beautiful scene';
          } else if (localStorage.getItem('google-imagen-enabled') === 'true') {
            msgData.type = 'googleimag';
            msgData.prompt = msgData.image_prompt || msgData.description || 'a beautiful scene';
          }
        }

        switch (msgData.type) {
          case 'add_todo': {
            if (!chat.settings.enableTodoList) continue;

            const triggerType = msgData.trigger || msgData.trigger_type || 'explicit';
            const isProactiveAdd = triggerType === 'proactive' || triggerType === 'auto';

            if (isProactiveAdd) {
              if (!chat.settings.enableAutoTodoSchedule) continue;

              const autoTodoScheduleProbability = (chat.settings.autoTodoScheduleProbability ?? 15) / 100;
              if (Math.random() > autoTodoScheduleProbability) {
                console.log('[TodoSchedule] 跳过自动生成待办/日程：未命中概率');
                continue;
              }
            }

            const todoContent = String(msgData.content || msgData.title || '').trim();
            const todoDate = msgData.date || new Date().toISOString().split('T')[0];

            const rawItemType = msgData.itemType || msgData.item_type || msgData.kind || 'todo';
            const itemType = rawItemType === 'schedule' ? 'schedule' : 'todo';

            const rawOwnerType = msgData.ownerType || msgData.owner_type || 'user';
            const ownerType = ['user', 'character', 'shared'].includes(rawOwnerType)
              ? rawOwnerType
              : 'user';

            const todoTime = msgData.startTime || msgData.start_time || msgData.time || '';
            const endTime = itemType === 'schedule'
              ? (msgData.endTime || msgData.end_time || '')
              : '';

            const todoType =
              msgData.task_type ||
              msgData.schedule_type ||
              msgData.type_label ||
              (itemType === 'schedule' ? '动态' : '日常');

            const todoStatus = (msgData.status === 'completed') ? 'completed' : 'pending';

            let description = String(msgData.description || msgData.note || '').trim();
            description = description
              .replace(/\{\{用户昵称\}\}/g, chat.settings?.myNickname || '你')
              .replace(/\{\{角色名\}\}/g, chat.name || 'TA');

            const location = itemType === 'schedule'
              ? String(msgData.location || '').trim()
              : '';

            if (todoContent) {
              if (!chat.todoList) chat.todoList = [];

              const newTodo = {
                id: Date.now() + Math.floor(Math.random() * 100000),
                content: todoContent,
                date: todoDate,
                time: todoTime,
                startTime: todoTime,
                endTime,
                type: todoType,
                status: todoStatus,
                creator: ownerType === 'character' ? 'ai' : 'user',
                itemType,
                ownerType,
                source: 'ai',
                location,
                description,
                timestamp: Date.now(),
                createdAt: Date.now(),
                updatedAt: Date.now()
              };

              chat.todoList.push(newTodo);

              const ownerLabel =
                ownerType === 'character' ? 'TA的' :
                ownerType === 'shared' ? '共同' :
                '我的';

              const itemLabel = itemType === 'schedule' ? '行程' : '待办';
              const actionText = todoStatus === 'completed'
                ? `记录了一条已完成的${ownerLabel}${itemLabel}`
                : `添加了一条${ownerLabel}${itemLabel}`;

              visibleSystemMessage = {
                content: `[${chat.name} ${actionText}: "${todoContent}"]`
              };

              console.log(`[TodoSchedule] AI 添加${ownerLabel}${itemLabel}: ${todoContent}, 状态: ${todoStatus}`);
            }
            break;
          }
          case 'narration':
            aiMessage = {
              role: 'system', // 强制设为 system 角色以便居中显示
              type: 'narration',
              content: msgData.content,
              senderName: '旁白',
              timestamp: messageTimestamp++ // 【修复】这里必须用 messageTimestamp
            };
            break;
          case 'synth_music':

            if (!chat.settings.enableSynthMusic) {
              continue;
            }


            aiMessage = {
              ...baseMessage, // 继承基础属性 (role, timestamp等)
              type: 'synth_music',
              // 确保群聊时名字正确 (优先用AI返回的名字)
              senderName: msgData.name || chat.originalName,
              title: msgData.title || '即兴旋律',
              reason: msgData.reason || '',
              instrument: msgData.instrument || 'piano',
              notes: msgData.notes || []
            };


            break;
          case 'buy_item': {
            const itemName = msgData.item_name;
            const price = parseFloat(msgData.price);
            const reason = msgData.reason || '想买';

            if (!itemName || isNaN(price) || price <= 0) continue; // 数据无效跳过

            // 1. 重新获取钱包数据（确保实时性）
            const currentWallet = await db.userWallet.get('main');
            const cardIndex = currentWallet?.kinshipCards?.findIndex(c =>
              String(c.chatId) === String(chat.id) &&
              ((c.type || 'out') === 'out')
            );

            if (cardIndex > -1) {
              const card = currentWallet.kinshipCards[cardIndex];
              const remaining = card.limit - (card.spent || 0);

              if (remaining >= price) {
                // 2. 执行扣款
                currentWallet.kinshipCards[cardIndex].spent = (card.spent || 0) + price;
                await db.userWallet.put(currentWallet);

                // 3. 记录账单
                await db.userTransactions.add({
                  timestamp: Date.now(),
                  type: 'expense',
                  amount: price,
                  description: `亲属卡消费-${chat.name}-${itemName}`
                });

                if (!chat.simulatedTaobaoHistory) {
                  chat.simulatedTaobaoHistory = { totalBalance: 0, purchases: [], walletLogs: [] };
                }
                if (!chat.simulatedTaobaoHistory.walletLogs) {
                  chat.simulatedTaobaoHistory.walletLogs = [];
                }

                const oldBalance = Number(chat.simulatedTaobaoHistory.totalBalance || 0);

                chat.simulatedTaobaoHistory.walletLogs.unshift({
                  type: 'kinship_card_buy_item',
                  amount: -price,
                  balanceBefore: oldBalance,
                  balanceAfter: oldBalance,
                  note: `亲属卡消费 - ${itemName}`,
                  timestamp: Date.now()
                });

                if (typeof window.removeCartItemByName === 'function') {
                  await window.removeCartItemByName(itemName);
                }

                // 4. 生成系统通知消息 (AI发送的)
                const successMsg = {
                  role: 'assistant', // 或者是 'system'，看你喜好
                  senderName: chat.name, // 加上这个确保群聊显示正常
                  type: 'text', // 或者用 'pat_message' 样式
                  content: `[支付宝通知] 我使用亲属卡消费了 ¥${price.toFixed(2)} 购买了“${itemName}”。\n💭 ${reason}`,
                  timestamp: messageTimestamp++
                };

                chat.history.push(successMsg);

                // 如果是当前查看的聊天，直接上屏
                if (isViewingThisChat) {
                  appendMessage(successMsg, chat);
                } else {
                  // 如果在后台，发送通知
                  showNotification(chat.id, `${chat.name} 使用亲属卡消费了 ¥${price}`);
                }

                // 5. (可选) 将购买记录写入角色的模拟淘宝历史，增加真实感
                if (!chat.simulatedTaobaoHistory) chat.simulatedTaobaoHistory = { totalBalance: 0, purchases: [] };
                if (!chat.simulatedTaobaoHistory.purchases) chat.simulatedTaobaoHistory.purchases = [];

                chat.simulatedTaobaoHistory.purchases.unshift({
                  itemName: itemName,
                  price: price,
                  status: '已签收',
                  reason: reason,
                  image_prompt: `${itemName}, product photography` // 简单生成个prompt
                });

                hasPerformedMajorAction = true; // 标记为已执行重要操作（用于后台活动）
              } else {
                console.log(`AI 想要购买 ${itemName} (¥${price}) 但亲属卡余额不足 (剩 ¥${remaining})`);
                // 可选：让 AI 发一条消息抱怨没钱了
                const failMsg = {
                  role: 'assistant',
                  senderName: chat.name,
                  content: `本来想买“${itemName}”的，但是亲属卡额度好像不够了... (¥${price})`,
                  timestamp: messageTimestamp++
                };
                chat.history.push(failMsg);
                if (isViewingThisChat) appendMessage(failMsg, chat);
              }
            }
            continue;
          }
          case 'kinship_response': {
            // 1. 找到最近的一条 pending 请求
            const requestMsg = chat.history.findLast(m => m.type === 'kinship_request' && m.status === 'pending');

            if (requestMsg) {
              const rawDecision = String(msgData.decision || '').trim().toLowerCase();
              const reasonText = String(msgData.reason || msgData.content || '').trim();
              const decisionText = `${rawDecision} ${reasonText}`;

              const isExplicitReject =
                rawDecision === 'reject' ||
                rawDecision === 'rejected' ||
                rawDecision === 'no' ||
                decisionText.includes('拒绝') ||
                decisionText.includes('不同意') ||
                decisionText.includes('不接受') ||
                decisionText.includes('不行') ||
                decisionText.includes('不要') ||
                decisionText.includes('decline') ||
                decisionText.includes('deny');

              const isExplicitAccept =
                rawDecision === 'accept' ||
                rawDecision === 'accepted' ||
                rawDecision === 'yes' ||
                decisionText.includes('接受') ||
                decisionText.includes('同意') ||
                decisionText.includes('开通') ||
                decisionText.includes('批准') ||
                decisionText.includes('可以') ||
                decisionText.includes('愿意');

              // 只要不是明确拒绝，就默认接受。避免 AI 嘴上说接受，但 decision 字段不标准导致误判拒绝。
              const isAccepted = isExplicitReject ? false : true;

              requestMsg.status = isAccepted ? 'accepted' : 'rejected';
              const isGrant = requestMsg.requestType === 'grant' || !requestMsg.requestType; // 兼容旧数据

              if (isAccepted) {
                // --- 同意逻辑 ---

                // 只有当是 'grant' (用户送钱) 时，才写入本地钱包额度
                // 如果是 'request' (AI 出钱)，本地钱包其实不需要记录 limit，
                // 因为目前的钱包系统只记录 "用户给别人花的钱"。
                // 但为了显示好看，也可以存进去，但在扣款逻辑里要区分。
                // 这里简单起见，我们都存，但在 UI 上区分显示。

                const wallet = await db.userWallet.get('main');
                if (!wallet.kinshipCards) wallet.kinshipCards = [];

                const cardType = isGrant ? 'out' : 'in';

                const existingIndex = wallet.kinshipCards.findIndex(c =>
                  String(c.chatId) === String(chat.id) &&
                  ((c.type || 'out') === cardType)
                );

                if (existingIndex > -1) {
                  wallet.kinshipCards[existingIndex].limit = requestMsg.limit;
                  wallet.kinshipCards[existingIndex].spent = wallet.kinshipCards[existingIndex].spent || 0;
                  wallet.kinshipCards[existingIndex].type = cardType;
                } else {
                  wallet.kinshipCards.push({
                    chatId: chat.id,
                    limit: requestMsg.limit,
                    spent: 0,
                    type: cardType
                  });
                }

                await db.userWallet.put(wallet);

                // --- 构造 AI 回复 ---
                let defaultReason = "";
                if (isGrant) {
                  defaultReason = "那我就不客气收下啦，谢谢你的礼物~"; // AI 接受馈赠
                } else {
                  defaultReason = "没问题，以后想买什么就买，我养你。"; // AI 同意包养用户
                }

                aiMessage = {
                  ...baseMessage,
                  type: 'text',
                  content: msgData.reason || defaultReason
                };
              } else {
                // --- 拒绝逻辑 ---
                let defaultReason = "";
                if (isGrant) {
                  defaultReason = "不用啦，我自己有钱花，心意领了。"; // AI 拒绝馈赠
                } else {
                  defaultReason = "这...最近手头有点紧，下次吧。"; // AI 拒绝包养
                }

                aiMessage = {
                  ...baseMessage,
                  type: 'text',
                  content: msgData.reason || defaultReason
                };
              }

              await db.chats.put(chat);
              renderChatInterface(chatId);
            }
            break;
          }
          case 'couple_invite_request': {
            if (!chat.settings.enableCoupleSpacePrompt) break;
            
            const coupleSpaces = getCoupleSpaces();
            const hasCoupleSpace = coupleSpaces.find(s => s.charId === chatId);
            const pendingInvite = chat.history.findLast(m => m.type === 'couple_invite' && m.status === 'pending');
            
            if (!hasCoupleSpace && !pendingInvite) {
              const inviteMsg = {
                role: 'assistant',
                type: 'couple_invite',
                status: 'pending',
                senderName: chat.originalName || chat.name,
                timestamp: messageTimestamp++
              };
              chat.history.push(inviteMsg);
              
              if (isViewingThisChat) {
                appendMessage(inviteMsg, chat);
              }
            }
            aiMessage = null;
            break;
          }
          case 'couple_space_unbind': {
            if (!chat.settings.enableCoupleSpacePrompt) break;
            
            const coupleSpaces = getCoupleSpaces();
            const hasCoupleSpace = coupleSpaces.find(s => s.charId === chatId);
            
            if (hasCoupleSpace) {
              const newSpaces = coupleSpaces.filter(s => s.charId !== chatId);
              saveCoupleSpaces(newSpaces);
              
              if (localStorage.getItem('coupleSpaceLastId') === chatId) {
                localStorage.removeItem('coupleSpaceLastId');
              }
              
              const myNickname = chat.settings.myNickname || '我';
              
              const unbindMsg = {
                role: 'system',
                type: 'system_notification',
                content: `[系统提示："${chat.originalName || chat.name}"主动解除了与"${myNickname}"的情侣空间绑定。]`,
                timestamp: messageTimestamp++
              };
              chat.history.push(unbindMsg);
              
              if (isViewingThisChat) {
                appendMessage(unbindMsg, chat);
              }
              
              // 关闭情侣空间UI（如果处于打开状态）
              try {
                if (document.getElementById('couple-space-screen') && document.getElementById('couple-space-screen').classList.contains('active')) {
                  showCoupleSpaceSelect('list');
                }
              } catch(e) {}
            }
            
            aiMessage = null;
            break;
          }
          case 'couple_invite_decision': {
            const pendingInvite = chat.history.findLast(m => m.type === 'couple_invite' && m.status === 'pending');
            if (pendingInvite) {
              const myNickname = chat.settings.myNickname || '我';
              const isAccept = msgData.decision === 'accept';

              // 更新原始邀请卡片状态
              pendingInvite.status = isAccept ? 'accepted' : 'rejected';

              // 添加角色的响应卡片
              const responseCard = {
                role: 'assistant',
                type: 'couple_invite_response',
                decision: isAccept ? 'accept' : 'reject',
                senderName: chat.originalName || chat.name,
                timestamp: Date.now()
              };
              chat.history.push(responseCard);

              // 添加隐藏系统消息作为上下文
              const hiddenMsg = {
                role: 'system',
                content: isAccept
                  ? `[系统提示：${chat.name}接受了${myNickname}的邀请，你们已经开启了情侣空间。]`
                  : `[系统提示：${chat.name}拒绝了${myNickname}的情侣空间邀请。]`,
                timestamp: Date.now() + 1,
                isHidden: true
              };
              chat.history.push(hiddenMsg);

              // 如果接受，创建情侣空间
              if (isAccept) {
                confirmCoupleSpace(chatId);
              }

              await db.chats.put(chat);
              renderChatInterface(chatId);
              renderChatList();
            }
            // 这个类型不产生普通消息，跳过
            aiMessage = null;
            break;
          }
          case 'send_private_message': {
            // 检查跨聊天消息开关
            const enableCrossChat = chat.settings.enableCrossChat !== null
              ? chat.settings.enableCrossChat
              : state.globalSettings.enableCrossChat;
            
            if (enableCrossChat === false) {
              console.log(`[跨聊天消息] 群聊→私聊功能已关闭，已拦截 send_private_message 指令`);
              aiMessage = null;
              continue;
            }

            const senderOriginalName = msgData.name;
            const recipientOriginalName = msgData.recipient;

            const userOriginalName = state.qzoneSettings.nickname || '{{user}}';
            const userNickname = chat.settings.myNickname || '我';

            // 兼容多种写法：接受本名、昵称、"我"、"{{user}}"
            if (recipientOriginalName === userOriginalName || 
                recipientOriginalName === userNickname ||
                recipientOriginalName === '我' ||
                recipientOriginalName === '{{user}}') {

              const privateChat = Object.values(state.chats).find(c =>
                !c.isGroup && c.originalName === senderOriginalName
              );

              if (privateChat) {

                lastPrivateMessagesSent = [];

                const messagesToSend = Array.isArray(msgData.content) ? msgData.content : [msgData.content];
                let newMessagesCount = 0;

                for (const contentString of messagesToSend) {
                  if (!contentString || !contentString.trim()) continue;

                  const privateMessage = {
                    role: 'assistant',
                    senderName: senderOriginalName,
                    content: contentString,
                    timestamp: messageTimestamp++
                  };


                  lastPrivateMessagesSent.push({
                    chatId: privateChat.id,
                    timestamp: privateMessage.timestamp
                  });

                  privateChat.history.push(privateMessage);
                  newMessagesCount++;
                }

                if (newMessagesCount > 0) {
                  if (state.activeChatId !== privateChat.id) {
                    privateChat.unreadCount = (privateChat.unreadCount || 0) + newMessagesCount;
                    showNotification(privateChat.id, `${privateChat.name} 发来了 ${newMessagesCount} 条新消息`);
                  }
                  await db.chats.put(privateChat);
                }

                aiMessage = null;

              } else {
                console.warn(`AI ${senderOriginalName} 尝试发送私信，但未找到其对应的私聊会话。`);
                aiMessage = null;
              }
            } else {
              console.warn(`AI 尝试发送私信给非用户角色 (${recipientOriginalName})，此功能暂不支持。`);
              aiMessage = null;
            }

            continue;
          }
          case 'send_group_message': {
            // 检查跨聊天消息开关
            const enableCrossChat = chat.settings.enableCrossChat !== null
              ? chat.settings.enableCrossChat
              : state.globalSettings.enableCrossChat;
            
            if (enableCrossChat === false) {
              console.log(`[跨聊天消息] 私聊→群聊功能已关闭，已拦截 send_group_message 指令`);
              aiMessage = null;
              continue;
            }

            // 这是从私聊 -> 群聊 的新功能
            const senderOriginalName = msgData.name || chat.originalName; // 'chat' 是当前的私聊
            const targetGroupName = msgData.targetGroupName;
            const messagesToSend = Array.isArray(msgData.content) ? msgData.content : [String(msgData.content)];

            if (!targetGroupName) {
              console.warn(`AI ${senderOriginalName} 尝试发送群聊消息，但未指定 targetGroupName。`);
              continue;
            }

            // 1. 查找目标群聊，并确保AI是该群的成员
            const targetGroupChat = Object.values(state.chats).find(c =>
              c.isGroup &&
              c.name === targetGroupName &&
              c.members.some(m => m.originalName === senderOriginalName)
            );

            if (targetGroupChat) {
              // 2. 找到了群聊，准备发送消息
              let newMessagesCount = 0;
              for (const contentString of messagesToSend) {
                if (!contentString || !contentString.trim()) continue;

                // 3. 创建一个标准群聊AI消息
                const groupMessage = {
                  role: 'assistant',
                  senderName: senderOriginalName, // AI的本名
                  content: contentString,
                  timestamp: messageTimestamp++ // 使用主循环的时间戳
                };

                // 4. 将消息添加到目标群聊的历史记录中
                targetGroupChat.history.push(groupMessage);
                newMessagesCount++;
              }

              if (newMessagesCount > 0) {
                // 5. 更新群聊的未读状态和通知
                if (state.activeChatId !== targetGroupChat.id) {
                  targetGroupChat.unreadCount = (targetGroupChat.unreadCount || 0) + newMessagesCount;

                  // 为了通知，获取AI在该群的群昵称
                  const member = targetGroupChat.members.find(m => m.originalName === senderOriginalName);
                  const senderDisplayName = member ? member.groupNickname : senderOriginalName;

                  showNotification(targetGroupChat.id, `${senderDisplayName}: ${messagesToSend[0]}`);
                }

                // 6. 保存对 *目标群聊* 的更改
                await db.chats.put(targetGroupChat);
                state.chats[targetGroupChat.id] = targetGroupChat; // 确保内存状态也更新
              }

              // 7. 这条消息不应显示在当前的私聊中，所以设置 aiMessage 为 null
              aiMessage = null;

            } else {
              console.warn(`AI ${senderOriginalName} 尝试向一个不存在的或TA不在的群聊 "${targetGroupName}" 发送消息。`);
              // (可选) 可以在私聊中生成一条 "发送失败" 的消息，但目前保持安静
              aiMessage = null;
            }

            continue; // 继续处理下一条指令
          }
          case 'view_myphone':
            // 处理查看User手机的请求
            if (!chat.isGroup && msgData.apps) {
              const userChat = state.chats[chatId]; // 当前聊天就是User的角色
              let appsToView = Array.isArray(msgData.apps) ? msgData.apps : [msgData.apps];

              // 如果包含"all"，则查看所有APP
              if (appsToView.includes('all')) {
                appsToView = ['qq', 'album', 'taobao', 'amap', 'browser', 'memo', 'diary', 'music', 'app_usage'];
              }

              let viewResults = [];

              // 遍历要查看的APP
              for (const app of appsToView) {
                let appData = null;
                let appName = '';

                switch (app) {
                  case 'qq':
                    appName = 'QQ';
                    appData = userChat.myPhoneSimulatedQQConversations || [];
                    if (appData.length > 0) {
                      const qqSummary = appData.slice(0, 5).map(conv => {
                        const latestMsg = conv.messages && conv.messages.length > 0
                          ? conv.messages[conv.messages.length - 1]
                          : null;
                        return `- ${conv.name}: ${latestMsg ? latestMsg.content.substring(0, 30) + '...' : '暂无消息'}`;
                      }).join('\n');
                      viewResults.push(`**QQ聊天列表** (共${appData.length}个联系人):\n${qqSummary}`);
                    } else {
                      viewResults.push(`**QQ聊天列表**: 空的`);
                    }
                    break;

                  case 'album':
                    appName = '相册';
                    appData = userChat.myPhoneAlbum || [];
                    if (appData.length > 0) {
                      const albumSummary = appData.slice(0, 5).map(photo =>
                        `- ${new Date(photo.timestamp).toLocaleString()}: ${photo.description || '无描述'}`
                      ).join('\n');
                      viewResults.push(`**相册** (共${appData.length}张照片):\n${albumSummary}`);
                    } else {
                      viewResults.push(`**相册**: 空的`);
                    }
                    break;

                  case 'taobao':
                    appName = '淘宝';
                    appData = userChat.myPhoneTaobaoHistory || [];
                    if (appData.length > 0) {
                      const taobaoSummary = appData.slice(0, 5).map(order =>
                        `- ${order.productName}: ¥${order.price} (${order.status})`
                      ).join('\n');
                      viewResults.push(`**淘宝订单** (共${appData.length}个订单):\n${taobaoSummary}`);
                    } else {
                      viewResults.push(`**淘宝订单**: 空的`);
                    }
                    break;

                  case 'amap':
                    appName = '高德地图';
                    appData = userChat.myPhoneAmapHistory || [];
                    if (appData.length > 0) {
                      const amapSummary = appData.slice(0, 5).map(record =>
                        `- ${new Date(record.timestamp).toLocaleString()}: ${record.location}`
                      ).join('\n');
                      viewResults.push(`**高德地图足迹** (共${appData.length}条记录):\n${amapSummary}`);
                    } else {
                      viewResults.push(`**高德地图足迹**: 空的`);
                    }
                    break;

                  case 'browser':
                    appName = '浏览器';
                    appData = userChat.myPhoneBrowserHistory || [];
                    if (appData.length > 0) {
                      const browserSummary = appData.slice(0, 5).map(record =>
                        `- ${new Date(record.timestamp).toLocaleString()}: ${record.title}`
                      ).join('\n');
                      viewResults.push(`**浏览器历史** (共${appData.length}条记录):\n${browserSummary}`);
                    } else {
                      viewResults.push(`**浏览器历史**: 空的`);
                    }
                    break;

                  case 'memo':
                    appName = '备忘录';
                    appData = userChat.myPhoneMemos || [];
                    if (appData.length > 0) {
                      const memoSummary = appData.slice(0, 5).map(memo =>
                        `- ${memo.title || '无标题'}: ${memo.content.substring(0, 30)}...`
                      ).join('\n');
                      viewResults.push(`**备忘录** (共${appData.length}条):\n${memoSummary}`);
                    } else {
                      viewResults.push(`**备忘录**: 空的`);
                    }
                    break;

                  case 'diary':
                    appName = '日记';
                    appData = userChat.myPhoneDiaries || [];
                    if (appData.length > 0) {
                      const diarySummary = appData.slice(0, 3).map(diary =>
                        `- ${diary.date}: ${diary.content.substring(0, 50)}...`
                      ).join('\n');
                      viewResults.push(`**日记** (共${appData.length}篇):\n${diarySummary}`);
                    } else {
                      viewResults.push(`**日记**: 空的`);
                    }
                    break;

                  case 'music':
                    appName = '网易云音乐';
                    appData = userChat.myPhoneMusicPlaylist || [];
                    if (appData.length > 0) {
                      const musicSummary = appData.slice(0, 5).map(song =>
                        `- ${song.title} - ${song.artist}`
                      ).join('\n');
                      viewResults.push(`**网易云音乐播放列表** (共${appData.length}首歌):\n${musicSummary}`);
                    } else {
                      viewResults.push(`**网易云音乐播放列表**: 空的`);
                    }
                    break;

                  case 'app_usage':
                    appName = 'APP使用记录';
                    appData = userChat.myPhoneAppUsage || [];
                    if (appData.length > 0) {
                      const usageSummary = appData.slice(0, 5).map(record => {
                        const hours = Math.floor(record.usageTimeMinutes / 60);
                        const minutes = record.usageTimeMinutes % 60;
                        let timeString = '';
                        if (hours > 0) timeString += `${hours}小时`;
                        if (minutes > 0) timeString += `${minutes}分钟`;
                        if (!timeString) timeString = '小于1分钟';
                        return `- ${record.appName} (${record.category || '其他'}): ${timeString}`;
                      }).join('\n');
                      viewResults.push(`**APP使用记录** (共${appData.length}条):\n${usageSummary}`);
                    } else {
                      viewResults.push(`**APP使用记录**: 空的`);
                    }
                    break;
                }
              }

              // 将查看结果作为隐藏的系统消息注入到对话中
              const viewResultMessage = {
                role: 'system',
                content: `[系统提示：你查看了${chat.settings.myNickname || '用户'}的手机，以下是真实数据]\n\n${viewResults.join('\n\n')}\n\n[请基于以上真实数据给出你的感想和反应，不要编造内容]`,
                timestamp: Date.now(),
                isHidden: true
              };

              chat.history.push(viewResultMessage);
              console.log(`📱 AI查看了User手机: ${appsToView.join(', ')}`);
            }
            continue;
          case 'update_thoughts':
            if (!chat.isGroup) {
              if (msgData.heartfelt_voice) {
                chat.heartfeltVoice = String(msgData.heartfelt_voice);
              }
              if (msgData.random_jottings) {
                chat.randomJottings = String(msgData.random_jottings);
              }
              
              // 动态收集自定义心声变量
              if (!chat.customThoughts) {
                chat.customThoughts = {};
              }
              for (const key in msgData) {
                if (key !== 'type' && key !== 'heartfelt_voice' && key !== 'random_jottings') {
                  chat.customThoughts[key] = String(msgData[key]);
                }
              }

              if (!Array.isArray(chat.thoughtsHistory)) {
                chat.thoughtsHistory = [];
              }
              
              const currentThought = {
                heartfeltVoice: chat.heartfeltVoice,
                randomJottings: chat.randomJottings,
                customThoughts: JSON.parse(JSON.stringify(chat.customThoughts)),
                timestamp: Date.now()
              };
              
              chat.thoughtsHistory.push(currentThought);
              if (chat.thoughtsHistory.length > 50) {
                chat.thoughtsHistory.shift();
              }

              let thoughtForMemory = `[这是你上一轮的内心独白和思考]
- 心声: ${chat.heartfeltVoice}
- 散记: ${chat.randomJottings}`;

              // 将自定义心声也加入记忆中
              if (chat.customThoughts && Object.keys(chat.customThoughts).length > 0) {
                for (const [key, value] of Object.entries(chat.customThoughts)) {
                  thoughtForMemory += `\n- ${key}: ${value}`;
                }
              }

              const hiddenThoughtMessage = {
                role: 'system',
                content: thoughtForMemory,
                timestamp: Date.now(),
                isHidden: true
              };

            }
            continue;
          case 'change_user_nickname':
            if (!chat.isGroup && msgData.new_name) {
              const newNickname = msgData.new_name.trim();
              if (newNickname) {
                chat.settings.myNickname = newNickname;

                const systemMessage = {
                  role: 'system',
                  type: 'pat_message',
                  content: `“${chat.name}” 将对你的称呼修改为 “${newNickname}”`,
                  timestamp: messageTimestamp++
                };
                chat.history.push(systemMessage);

                const hiddenMemoryMessage = {
                  role: 'system',
                  content: `[系统提示：你刚刚成功将对用户的称呼修改为了“${newNickname}”。]`,
                  timestamp: messageTimestamp++,
                  isHidden: true
                };
                chat.history.push(hiddenMemoryMessage);

                if (isViewingThisChat) {
                  appendMessage(systemMessage, chat);
                }
              }
            }
            continue;
          case 'change_remark_name':
            if (!chat.isGroup && msgData.new_name) {
              const oldName = chat.name;
              const newName = msgData.new_name.trim();

              if (newName && newName !== oldName) {
                if (!chat.nameHistory) {
                  chat.nameHistory = [];
                }
                if (!chat.nameHistory.includes(oldName)) {
                  chat.nameHistory.push(oldName);
                }

                chat.name = newName;

                const systemMessage = {
                  role: 'system',
                  type: 'pat_message',
                  content: `“${chat.originalName}” 将备注修改为 “${newName}”`,
                  timestamp: messageTimestamp++
                };
                chat.history.push(systemMessage);

                const hiddenMemoryMessage = {
                  role: 'system',
                  content: `[系统提示：你刚刚成功将自己的备注名修改为了“${newName}”。请自然地接受这个新名字，不要对此感到惊讶。]`,
                  timestamp: messageTimestamp++,
                  isHidden: true
                };
                chat.history.push(hiddenMemoryMessage);

                if (isViewingThisChat) {
                  appendMessage(systemMessage, chat);
                  document.getElementById('chat-header-title').textContent = newName;
                }

                await syncCharacterNameInGroups(chat);
              }
            }
            continue;

          case 'change_avatar': {
            const avatarName = msgData.name;
            const foundAvatar = chat.settings.aiAvatarLibrary.find(avatar => avatar.name === avatarName);
            if (foundAvatar) {
              chat.settings.aiAvatar = foundAvatar.url;

              const systemNotice = {
                role: 'system',
                type: 'pat_message',
                content: `[${chat.name} 更换了头像]`,
                timestamp: Date.now()
              };
              chat.history.push(systemNotice);

              await syncCharacterAvatarInGroups(chat);

              if (isViewingThisChat) {
                appendMessage(systemNotice, chat);
                renderChatInterface(chatId);
              }
            }
            continue;
          }
          case 'change_user_avatar': {
            const avatarName = msgData.name;
            const foundAvatar = chat.settings.myAvatarLibrary.find(avatar => avatar.name === avatarName);
            if (foundAvatar) {
              chat.settings.myAvatar = foundAvatar.url;

              const systemNotice = {
                role: 'system',
                type: 'pat_message',
                content: `[${chat.name} 更换了你的头像]`,
                timestamp: Date.now()
              };
              chat.history.push(systemNotice);

              if (isViewingThisChat) {
                appendMessage(systemNotice, chat);
                renderChatInterface(chatId);
              }
            }
            continue;
          }

          case 'gomoku_move': {

            const x = parseInt(msgData.x);
            const y = parseInt(msgData.y);


            if (!isNaN(x) && !isNaN(y)) {
              handleAiGomokuMove({
                x: x,
                y: y
              });
            } else {
              console.warn("AI的五子棋移动指令包含无效坐标，已忽略:", msgData);
            }
            continue;
          }

          case 'waimai_response':
            const requestMessageIndex = chat.history.findIndex(m => m.timestamp === msgData.for_timestamp);
            if (requestMessageIndex > -1) {
              const originalMsg = chat.history[requestMessageIndex];
              originalMsg.status = msgData.status;
              originalMsg.paidBy = msgData.status === 'paid' ? msgData.name : null;
              if (isViewingThisChat) {
                const bubble = document.querySelector(`.message-bubble[data-timestamp="${msgData.for_timestamp}"]`);
                if (bubble) {
                  bubble.classList.remove('status-pending');
                  bubble.classList.add(`status-${msgData.status}`);
                  const userActions = bubble.querySelector('.waimai-user-actions');
                  if (userActions) userActions.remove();
                }
              }
            }
            continue;

          case 'qzone_post':
            const newPost = {
              type: msgData.postType || 'shuoshuo',
              content: msgData.content || '',
              publicText: msgData.publicText || '',
              hiddenContent: msgData.hiddenContent || '',
              image_prompt: msgData.image_prompt || '',
              timestamp: Date.now(),
              authorId: chatId,
              authorGroupId: chat.groupId,
              visibleGroupIds: null
            };



            if (msgData.postType === 'naiimag' && msgData.prompt) {
              try {

                const prompts = Array.isArray(msgData.prompt) ? msgData.prompt.slice(0, 2) : [msgData.prompt];
                console.log(`📸 动态NovelAI图片生成开始，共${prompts.length}张图片`);


                const generatedImageUrls = [];


                for (let i = 0; i < prompts.length; i++) {
                  const aiPrompt = prompts[i];
                  console.log(`生成第${i + 1}张图片，prompt:`, aiPrompt);


                  const naiPrompts = getCharacterNAIPrompts(chat.id);


                  const finalPositivePrompt = aiPrompt + ', ' + naiPrompts.positive;
                  const finalNegativePrompt = naiPrompts.negative;

                  console.log(`📝 使用${naiPrompts.source === 'character' ? '角色专属' : '系统'}提示词配置`);
                  console.log('最终正面提示词:', finalPositivePrompt);
                  console.log('最终负面提示词:', finalNegativePrompt);


                  const apiKey = localStorage.getItem('novelai-api-key');
                  const model = localStorage.getItem('novelai-model') || 'nai-diffusion-4-5-full';
                  const settings = getNovelAISettings();

                  if (!apiKey) {
                    throw new Error('NovelAI API Key未配置。请在NovelAI设置中填写API Key。');
                  }

                  const [width, height] = settings.resolution.split('x').map(Number);


                  let requestBody;

                  if (model.includes('nai-diffusion-4')) {

                    requestBody = {
                      input: finalPositivePrompt,
                      model: model,
                      action: 'generate',
                      parameters: {
                        params_version: 3, // V4必须使用版本3
                        width: width,
                        height: height,
                        scale: settings.cfg_scale,
                        sampler: settings.sampler,
                        steps: settings.steps,
                        seed: settings.seed === -1 ? Math.floor(Math.random() * 9999999999) : settings.seed,
                        n_samples: 1,
                        ucPreset: settings.uc_preset,
                        qualityToggle: settings.quality_toggle,
                        autoSmea: false,
                        dynamic_thresholding: false,
                        controlnet_strength: 1,
                        legacy: false,
                        add_original_image: true,
                        cfg_rescale: 0,
                        noise_schedule: 'karras', // V4使用karras
                        legacy_v3_extend: false,
                        skip_cfg_above_sigma: null,
                        use_coords: false,
                        legacy_uc: false,
                        normalize_reference_strength_multiple: true,
                        inpaintImg2ImgStrength: 1,
                        characterPrompts: [],

                        v4_prompt: {
                          caption: {
                            base_caption: finalPositivePrompt,
                            char_captions: []
                          },
                          use_coords: false,
                          use_order: true
                        },

                        v4_negative_prompt: {
                          caption: {
                            base_caption: finalNegativePrompt,
                            char_captions: []
                          },
                          legacy_uc: false
                        },
                        negative_prompt: finalNegativePrompt,
                        deliberate_euler_ancestral_bug: false,
                        prefer_brownian: true

                      }
                    };
                  } else {

                    requestBody = {
                      input: finalPositivePrompt,
                      model: model,
                      action: 'generate',
                      parameters: {
                        width: width,
                        height: height,
                        scale: settings.cfg_scale,
                        sampler: settings.sampler,
                        steps: settings.steps,
                        seed: settings.seed === -1 ? Math.floor(Math.random() * 9999999999) : settings.seed,
                        n_samples: 1,
                        ucPreset: settings.uc_preset,
                        qualityToggle: settings.quality_toggle,
                        sm: settings.smea,
                        sm_dyn: settings.smea_dyn,
                        dynamic_thresholding: false,
                        controlnet_strength: 1,
                        legacy: false,
                        add_original_image: false,
                        cfg_rescale: 0,
                        noise_schedule: 'native',
                        negative_prompt: finalNegativePrompt
                      }
                    };
                  }

                  console.log('🚀 发送NAI请求:', requestBody);


                  let apiUrl;


                  if (model.includes('nai-diffusion-4')) {

                    apiUrl = 'https://image.novelai.net/ai/generate-image-stream';
                  } else {

                    apiUrl = 'https://image.novelai.net/ai/generate-image';
                  }

                  let corsProxy = settings.cors_proxy;


                  if (corsProxy === 'custom') {
                    corsProxy = settings.custom_proxy_url || '';
                  }


                  if (corsProxy && corsProxy !== '') {
                    apiUrl = corsProxy + encodeURIComponent(apiUrl);
                  }

                  const response = await fetch(apiUrl, {
                    method: 'POST',
                    headers: {
                      'Content-Type': 'application/json',
                      'Authorization': 'Bearer ' + apiKey
                    },
                    body: JSON.stringify(requestBody)
                  });

                  console.log('Response status:', response.status);
                  console.log('Response headers:', [...response.headers.entries()]);

                  if (!response.ok) {
                    const errorText = await response.text();
                    console.error('API错误响应:', errorText);
                    throw new Error(`API请求失败 (${response.status}): ${errorText}`);
                  }


                  const contentType = response.headers.get('content-type');
                  console.log('Content-Type:', contentType);


                  let zipBlob;
                  let imageDataUrl;
                  if (contentType && contentType.includes('text/event-stream')) {
                    console.log('检测到 SSE 流式响应，开始解析...');


                    const text = await response.text();
                    console.log('收到 SSE 数据，大小:', text.length);


                    const lines = text.trim().split('\n');
                    let base64Data = null;

                    for (let i = lines.length - 1; i >= 0; i--) {
                      const line = lines[i].trim();
                      if (line.startsWith('data: ') && line !== 'data: [DONE]') {
                        const dataContent = line.substring(6);


                        try {
                          const jsonData = JSON.parse(dataContent);


                          if (jsonData.event_type === 'final' && jsonData.image) {
                            base64Data = jsonData.image;
                            console.log('✅ 找到 final 事件的图片数据');
                            break;
                          }


                          if (jsonData.data) {
                            base64Data = jsonData.data;
                            console.log('从 JSON.data 中提取图片数据');
                            break;
                          }
                          if (jsonData.image) {
                            base64Data = jsonData.image;
                            console.log('从 JSON.image 中提取图片数据');
                            break;
                          }
                        } catch (e) {

                          base64Data = dataContent;
                          console.log('直接使用 base64 数据');
                          break;
                        }
                      }
                    }

                    if (!base64Data) {
                      throw new Error('无法从 SSE 响应中提取图片数据');
                    }


                    const isPNG = base64Data.startsWith('iVBORw0KGgo');
                    const isJPEG = base64Data.startsWith('/9j/');

                    if (isPNG || isJPEG) {
                      console.log('✅ 检测到直接的图片 base64 数据 (PNG/JPEG)');

                      const binaryString = atob(base64Data);
                      const bytes = new Uint8Array(binaryString.length);
                      for (let i = 0; i < binaryString.length; i++) {
                        bytes[i] = binaryString.charCodeAt(i);
                      }
                      const imageBlob = new Blob([bytes], {
                        type: isPNG ? 'image/png' : 'image/jpeg'
                      });
                      console.log('图片 Blob 创建成功，大小:', imageBlob.size);


                      const reader = new FileReader();
                      imageDataUrl = await new Promise((resolve, reject) => {
                        reader.onloadend = () => resolve(reader.result);
                        reader.onerror = reject;
                        reader.readAsDataURL(imageBlob);
                      });
                      console.log('✅ 图片转换成功！🎨');
                    } else {

                      console.log('当作 ZIP 文件处理...');
                      const binaryString = atob(base64Data);
                      const bytes = new Uint8Array(binaryString.length);
                      for (let i = 0; i < binaryString.length; i++) {
                        bytes[i] = binaryString.charCodeAt(i);
                      }
                      zipBlob = new Blob([bytes]);
                      console.log('ZIP Blob 大小:', zipBlob.size);
                    }
                  } else {

                    zipBlob = await response.blob();
                    console.log('收到数据，类型:', zipBlob.type, '大小:', zipBlob.size);
                  }


                  if (!imageDataUrl && zipBlob) {

                    try {

                      if (typeof JSZip === 'undefined') {
                        throw new Error('JSZip库未加载，请刷新页面重试');
                      }


                      const zip = await JSZip.loadAsync(zipBlob);
                      console.log('ZIP文件内容:', Object.keys(zip.files));


                      let imageFile = null;
                      for (let filename in zip.files) {
                        if (filename.match(/\.(png|jpg|jpeg|webp)$/i)) {
                          imageFile = zip.files[filename];
                          console.log('找到图片文件:', filename);
                          break;
                        }
                      }

                      if (!imageFile) {
                        throw new Error('ZIP文件中未找到图片');
                      }


                      const imageBlob = await imageFile.async('blob');
                      console.log('提取的图片大小:', imageBlob.size);


                      const reader = new FileReader();
                      imageDataUrl = await new Promise((resolve, reject) => {
                        reader.onloadend = () => resolve(reader.result);
                        reader.onerror = reject;
                        reader.readAsDataURL(imageBlob);
                      });
                      console.log('✅ 图片解压成功！');
                    } catch (zipError) {
                      console.error('ZIP解压失败:', zipError);
                      throw new Error('图片解压失败: ' + zipError.message);
                    }
                  }

                  console.log(`✅ NAI图片${i + 1}生成成功！`);
                  generatedImageUrls.push(imageDataUrl);
                }


                newPost.imageUrls = generatedImageUrls;

                if (generatedImageUrls.length === 1) {
                  newPost.imageUrl = generatedImageUrls[0];
                }

                newPost.prompt = msgData.prompt;
                newPost.imageCount = generatedImageUrls.length;
                console.log(`✅ 动态NovelAI图片全部生成完成: ${generatedImageUrls.length}张`);
              } catch (error) {
                console.error('❌ 动态NAI图片生成失败:', error);

                newPost.content = (newPost.content || newPost.publicText || '') + `\n[图片生成失败: ${error.message}]`;
              }
            }

            // Google Imagen 动态图片生成
            if (msgData.postType === 'googleimag' && msgData.prompt) {
              try {
                const googlePrompt = msgData.prompt || 'a beautiful scene';
                console.log(`📸 动态Google Imagen图片生成开始，prompt:`, googlePrompt);

                const googleResult = await generateGoogleImagenFromPrompt(googlePrompt);
                newPost.imageUrls = [googleResult.imageUrl];
                newPost.imageUrl = googleResult.imageUrl;
                newPost.prompt = googlePrompt;
                newPost.imageCount = 1;
                console.log(`✅ 动态Google Imagen图片生成完成`);
              } catch (error) {
                console.error('❌ 动态Google Imagen图片生成失败:', error);
                newPost.content = (newPost.content || newPost.publicText || '') + `\n[Google Imagen图片生成失败: ${error.message}]`;
              }
            }

            await db.qzonePosts.add(newPost);
            updateUnreadIndicator(unreadPostsCount + 1);
            if (isViewingThisChat && document.getElementById('qzone-screen').classList.contains('active')) {
              await renderQzonePosts();
            }
            continue;

          case 'qzone_comment': {
            const postToComment = await db.qzonePosts.get(parseInt(msgData.postId));
            if (postToComment) {
              if (!postToComment.comments) postToComment.comments = [];

              // 防御：如果模型错误地填了用户的名字，强制纠正为角色本名
              const userNickname = state.qzoneSettings?.nickname;
              let commenterName = msgData.name || chat.originalName;
              if (userNickname && commenterName === userNickname) {
                console.warn(`[动态防御] 角色 "${chat.originalName}" 试图用用户名字 "${userNickname}" 评论，已纠正`);
                commenterName = chat.originalName;
              }
              const createCommentObject = (text, meaning = null, replyTo = null) => ({
                commenterName,
                text: processMentions(text, chat),
                meaning,
                replyTo,
                timestamp: Date.now()
              });

              if (msgData.stickerMeaning) {
                const sticker = state.userStickers.find(s => s.name === msgData.stickerMeaning);
                if (sticker) {
                  postToComment.comments.push(createCommentObject(sticker.url, sticker.name, msgData.replyTo || null));
                } else {
                  console.warn(`AI 尝试评论一个不存在的表情: "${msgData.stickerMeaning}"`);
                  postToComment.comments.push(createCommentObject(`[表情: ${msgData.stickerMeaning}]`, null, msgData.replyTo || null));
                }
              } else if (Array.isArray(msgData.comments)) {
                msgData.comments.forEach(commentText => {
                  if (typeof commentText === 'string' && commentText.trim()) {
                    postToComment.comments.push(createCommentObject(commentText, null, msgData.replyTo || null));
                  }
                });
              } else if (typeof msgData.commentText === 'string' && msgData.commentText.trim()) {
                postToComment.comments.push(createCommentObject(msgData.commentText, null, msgData.replyTo || null));
              }

              await db.qzonePosts.update(postToComment.id, {
                comments: postToComment.comments
              });
              updateUnreadIndicator(unreadPostsCount + 1);
              console.log(`后台活动: 角色 "${chat.name}" 评论了动态 #${msgData.postId}`);

              if (!chat.commentCooldowns) chat.commentCooldowns = {};
              chat.commentCooldowns[msgData.postId] = Date.now();
            }
            continue;
          }
          case 'qzone_like':
            const postToLike = await db.qzonePosts.get(parseInt(msgData.postId));
            if (postToLike) {
              if (!postToLike.likes) postToLike.likes = [];
              if (!postToLike.likes.includes(chat.name)) {
                postToLike.likes.push(chat.name);
                await db.qzonePosts.update(postToLike.id, {
                  likes: postToLike.likes
                });
                updateUnreadIndicator(unreadPostsCount + 1);
                if (isViewingThisChat && document.getElementById('qzone-screen').classList.contains('active')) {
                  await renderQzonePosts();
                }
              }
            }
            continue;
          case 'repost': {
            const originalPost = await db.qzonePosts.get(parseInt(msgData.postId));
            if (originalPost) {
              const newPost = {
                type: 'repost',
                timestamp: Date.now(),
                authorId: chatId,
                authorGroupId: chat.groupId,
                repostComment: msgData.comment || '',
                originalPost: originalPost,
                visibleGroupIds: null
              };
              await db.qzonePosts.add(newPost);
              updateUnreadIndicator(unreadPostsCount + 1);
              console.log(`后台活动: 角色 "${chat.name}" 转发了动态 #${msgData.postId}`);
            }
            continue;
          }
          case 'video_call_request':
            if (!videoCallState.isActive && !videoCallState.isAwaitingResponse) {
              state.activeChatId = chatId;
              videoCallState.activeChatId = chatId;
              videoCallState.isAwaitingResponse = true;
              videoCallState.isGroupCall = chat.isGroup;
              videoCallState.callRequester = msgData.name || chat.name;
              showIncomingCallModal('video', chat);
            }
            continue;
          case 'voice_call_request':
            if (!voiceCallState.isActive && !voiceCallState.isAwaitingResponse) {
              state.activeChatId = chatId;
              voiceCallState.activeChatId = chatId;
              voiceCallState.isAwaitingResponse = true;
              voiceCallState.isGroupCall = chat.isGroup;
              voiceCallState.callRequester = msgData.name || chat.name;
              showIncomingCallModal('voice', chat);
            }
            continue;
          case 'group_call_request':
            if (!videoCallState.isActive && !videoCallState.isAwaitingResponse) {
              state.activeChatId = chatId;
              videoCallState.isAwaitingResponse = true;
              videoCallState.isGroupCall = true;
              videoCallState.initiator = 'ai';
              videoCallState.callRequester = msgData.name;
              showIncomingCallModal('video', chat);
            }
            continue;
          case 'group_voice_request':
            if (!voiceCallState.isActive && !voiceCallState.isAwaitingResponse) {
              state.activeChatId = chatId;
              voiceCallState.isAwaitingResponse = true;
              voiceCallState.isGroupCall = true;
              voiceCallState.initiator = 'ai';
              voiceCallState.callRequester = msgData.name;
              showIncomingCallModal('voice', chat);
            }
            continue;
          case 'pat_user':
            let patterName;
            if (chat.isGroup) {
              const member = chat.members.find(m => m.originalName === msgData.name);
              patterName = member ? member.groupNickname : msgData.name;
            } else {
              patterName = chat.name;
            }
            const suffix = msgData.suffix ? ` ${msgData.suffix.trim()}` : '';
            const patText = `${patterName} 拍了拍我${suffix}`;

            const patMessage = {
              role: 'system',
              type: 'pat_message',
              content: patText,
              timestamp: Date.now()
            };
            chat.history.push(patMessage);
            if (isViewingThisChat) {
              const phoneScreen = document.getElementById('phone-screen');
              phoneScreen.classList.remove('pat-animation');
              void phoneScreen.offsetWidth;
              phoneScreen.classList.add('pat-animation');
              setTimeout(() => phoneScreen.classList.remove('pat-animation'), 500);
              appendMessage(patMessage, chat);
            } else {
              showNotification(chatId, patText);
            }
            continue;
          case 'update_status':
            chat.status.text = msgData.status_text;
            chat.status.isBusy = msgData.is_busy || false;
            chat.status.lastUpdate = Date.now();
            const statusUpdateMessage = {
              role: 'system',
              type: 'pat_message',
              content: `[${chat.name}的状态已更新为: ${msgData.status_text}]`,
              timestamp: Date.now()
            };
            chat.history.push(statusUpdateMessage);
            if (isViewingThisChat) {
              appendMessage(statusUpdateMessage, chat);
            }
            renderChatList();
            continue;
          case 'location_share':
            aiMessage = {
              ...baseMessage,
              type: 'location_share',
              content: msgData.content
            };
            break;
          case 'change_music':
            if (musicState.isActive && musicState.activeChatId === chatId) {
              const songNameFromAI = msgData.song_name || msgData.song || msgData.name;

              if (typeof songNameFromAI === 'string' && songNameFromAI.trim()) {
                const songNameToFind = songNameFromAI.replace(/^\[?\d+\]?[\s.-]*/, '').trim();
                const targetSongIndex = musicState.playlist.findIndex(track => track.name.toLowerCase() === songNameToFind.toLowerCase());

                if (targetSongIndex > -1) {
                  playSong(targetSongIndex);
                  const track = musicState.playlist[targetSongIndex];

                  let changerName;
                  if (chat.isGroup) {
                    const member = chat.members.find(m => m.originalName === msgData.name);
                    changerName = member ? member.groupNickname : msgData.name;
                  } else {
                    changerName = chat.name;
                  }

                  const musicChangeMessage = {
                    role: 'system',
                    type: 'pat_message',
                    content: `[♪ ${changerName} 为你切歌: 《${track.name}》 - ${track.artist}]`,
                    timestamp: Date.now()
                  };
                  chat.history.push(musicChangeMessage);
                  if (isViewingThisChat) {
                    appendMessage(musicChangeMessage, chat);
                  }
                } else {
                  console.warn(`歌曲查找失败: AI请求的歌曲名"${songNameFromAI}"(处理后为"${songNameToFind}") 在播放列表中未找到。`);
                }
              } else {
                console.error("AI返回的change_music指令中，歌曲名无效或缺失:", msgData);
              }
            }
            continue;
          case 'create_memory':
            const newMemory = {
              chatId: chatId,
              authorId: chatId,
              description: msgData.description,
              timestamp: Date.now(),
              type: 'ai_generated'
            };
            await db.memories.add(newMemory);
            console.log(`AI "${chat.name}" 记录了一条新回忆:`, msgData.description);
            continue;
          case 'create_countdown':
            const targetDate = new Date(msgData.date);
            if (!isNaN(targetDate) && targetDate > new Date()) {
              const newCountdown = {
                chatId: chatId,
                authorId: chatId,
                description: msgData.title,
                timestamp: Date.now(),
                type: 'countdown',
                targetDate: targetDate.getTime()
              };
              await db.memories.add(newCountdown);
              console.log(`AI "${chat.name}" 创建了一个新约定:`, msgData.title);
            }
            continue;
          case 'block_user':
            if (!chat.isGroup) {
              chat.relationship.status = 'blocked_by_ai';
              const hiddenMessage = {
                role: 'system',
                content: `[系统提示：你刚刚主动拉黑了用户。]`,
                timestamp: Date.now(),
                isHidden: true
              };
              chat.history.push(hiddenMessage);
              await db.chats.put(chat);
              if (isViewingThisChat) {
                renderChatInterface(chatId);
              }
              renderChatList();
              break;
            }
            continue;
          case 'friend_request_response':
            if (!chat.isGroup && chat.relationship?.status === 'pending_ai_approval') {
              if (msgData.decision === 'accept') {
                chat.relationship.status = 'friend';
                aiMessage = {
                  ...baseMessage,
                  content: "我通过了你的好友申请，我们现在是好友啦！"
                };
              } else {
                chat.relationship.status = 'blocked_by_ai';
                aiMessage = {
                  ...baseMessage,
                  content: "抱歉，我拒绝了你的好友申请。"
                };
              }
              chat.relationship.applicationReason = '';
            }
            break;
          case 'poll':
            const pollOptions = typeof msgData.options === 'string' ?
              msgData.options.split('\n').filter(opt => opt.trim()) :
              (Array.isArray(msgData.options) ? msgData.options : []);
            if (pollOptions.length < 2) continue;
            aiMessage = {
              ...baseMessage,
              type: 'poll',
              question: msgData.question,
              options: pollOptions,
              votes: {},
              isClosed: false,
            };
            break;
          case 'gift': {
            const {
              itemName,
              itemPrice,
              image_prompt
            } = msgData;

            if (itemName && !isNaN(parseFloat(itemPrice)) && image_prompt) {

              const imageUrl = getPollinationsImageUrl(image_prompt);

              aiMessage = {
                ...baseMessage,
                type: 'gift',
                items: [{
                  name: itemName,
                  price: parseFloat(itemPrice),
                  imageUrl: imageUrl,
                  quantity: 1
                }],
                total: parseFloat(itemPrice),
                recipients: msgData.recipients || null
              };
            } else {
              console.warn(`AI 尝试赠送一个格式不正确的随机礼物:`, msgData);
            }
            break;
          }
          case 'vote':
            const pollToVote = chat.history.find(m => m.timestamp === msgData.poll_timestamp);
            if (pollToVote && !pollToVote.isClosed) {
              Object.keys(pollToVote.votes).forEach(option => {
                const voterIndex = pollToVote.votes[option].indexOf(msgData.name);
                if (voterIndex > -1) {
                  pollToVote.votes[option].splice(voterIndex, 1);
                }
              });
              if (!pollToVote.votes[msgData.choice]) {
                pollToVote.votes[msgData.choice] = [];
              }
              if (!pollToVote.votes[msgData.choice].includes(msgData.name)) {
                pollToVote.votes[msgData.choice].push(msgData.name);
              }
              if (isViewingThisChat) {
                renderChatInterface(chatId);
              }
            }
            continue;
          case 'red_packet':
            aiMessage = {
              ...baseMessage,
              ...msgData,
              totalAmount: msgData.amount,
              claimedBy: {},
              isFullyClaimed: false
            };


            if (aiMessage.packetType === 'lucky') {
              const allocatedAmounts = generateRandomPacketAmounts(aiMessage.amount, aiMessage.count);
              aiMessage.allocatedAmounts = allocatedAmounts;
              aiMessage.unclaimedAmounts = [...allocatedAmounts];
            }


            if (msgData.receiver) {
              aiMessage.receiverName = msgData.receiver;
              delete aiMessage.receiver;
            }
            break;
          case 'open_red_packet':
            const packetToOpen = chat.history.find(m => m.timestamp === msgData.packet_timestamp);

            const claimerOriginalName = msgData.name;
            const isMember = chat.members.some(member => member.originalName === claimerOriginalName);


            if (!isMember) {
              console.warn(`AI 角色 "${claimerOriginalName}" 尝试领取不属于自己的群聊红包。操作已被拦截。`);
              continue;
            }

            if (packetToOpen && packetToOpen.packetType === 'direct') {
              if (packetToOpen.receiverName !== msgData.name) {
                console.warn(`AI 角色 "${msgData.name}" 尝试领取不属于自己的专属红包 (接收人: ${packetToOpen.receiverName})。操作已被拦截。`);
                continue;
              }
            }

            if (packetToOpen && !packetToOpen.isFullyClaimed && !(packetToOpen.claimedBy && packetToOpen.claimedBy[msgData.name])) {
              let claimedAmountAI = 0;
              const remainingAmount = packetToOpen.totalAmount - Object.values(packetToOpen.claimedBy || {}).reduce((sum, val) => sum + val, 0);
              const remainingCount = packetToOpen.count - Object.keys(packetToOpen.claimedBy || {}).length;
              if (remainingCount > 0) {
                if (packetToOpen.packetType === 'direct') {
                  claimedAmountAI = packetToOpen.totalAmount;
                }

                else if (packetToOpen.unclaimedAmounts && packetToOpen.unclaimedAmounts.length > 0) {

                  claimedAmountAI = packetToOpen.unclaimedAmounts.pop();
                }

                else {
                  console.warn("检测到旧版红包，回退到旧的（不公平）随机算法 (triggerAiResponse)");
                  const remainingAmount = packetToOpen.totalAmount - Object.values(packetToOpen.claimedBy || {}).reduce((sum, val) => sum + val, 0);
                  if (remainingCount === 1) {
                    claimedAmountAI = remainingAmount;
                  } else {
                    const min = 0.01;
                    const max = remainingAmount - (remainingCount - 1) * min;
                    claimedAmountAI = Math.random() * (max - min) + min;
                  }
                }

                claimedAmountAI = parseFloat(claimedAmountAI.toFixed(2));
                if (!packetToOpen.claimedBy) packetToOpen.claimedBy = {};
                packetToOpen.claimedBy[msgData.name] = claimedAmountAI;


                const claimerMember = chat.members.find(m => m.originalName === msgData.name);
                const claimerDisplayName = claimerMember ? claimerMember.groupNickname : msgData.name;


                const senderDisplayName = getDisplayNameInGroup(chat, packetToOpen.senderName);

                const aiClaimedMessage = {
                  role: 'system',
                  type: 'pat_message',
                  content: `${claimerDisplayName} 领取了 ${senderDisplayName} 的红包`,
                  timestamp: messageTimestamp++
                };
                chat.history.push(aiClaimedMessage);

                let hiddenContentForAI = `[系统提示：你 (${claimerDisplayName}) 成功抢到了 ${claimedAmountAI.toFixed(2)} 元。`;
                if ((packetToOpen.unclaimedAmounts && packetToOpen.unclaimedAmounts.length === 0) || (Object.keys(packetToOpen.claimedBy).length >= packetToOpen.count)) {
                  packetToOpen.isFullyClaimed = true;
                  const finishedMessage = {
                    role: 'system',
                    type: 'pat_message',
                    content: `${senderDisplayName} 的红包已被领完`,
                    timestamp: messageTimestamp++
                  };
                  chat.history.push(finishedMessage);
                  let luckyKing = {
                    name: '',
                    amount: -1
                  };
                  if (packetToOpen.packetType === 'lucky' && packetToOpen.count > 1) {
                    Object.entries(packetToOpen.claimedBy).forEach(([name, amount]) => {
                      if (amount > luckyKing.amount) {
                        luckyKing = {
                          name,
                          amount
                        };
                      }
                    });
                  }
                  if (luckyKing.name) {
                    const luckyKingMember = chat.members.find(m => m.originalName === luckyKing.name);
                    const luckyKingDisplayName = luckyKingMember ? luckyKingMember.groupNickname : luckyKing.name;
                    hiddenContentForAI += ` 红包已被领完，手气王是 ${luckyKingDisplayName}！`;
                  } else {
                    hiddenContentForAI += ` 红包已被领完。`;
                  }
                }
                hiddenContentForAI += ' 请根据这个结果发表你的评论。]';
                const hiddenMessageForAI = {
                  role: 'system',
                  content: hiddenContentForAI,
                  timestamp: messageTimestamp++,
                  isHidden: true
                };
                chat.history.push(hiddenMessageForAI);
              }
              if (isViewingThisChat) {
                renderChatInterface(chatId);
                renderChatList();
              }
            }
            continue;

          case 'accept_transfer': {
            const originalTransferMsgIndex = chat.history.findIndex(m => m.timestamp === msgData.for_timestamp);
            if (originalTransferMsgIndex > -1) {
              const originalMsg = chat.history[originalTransferMsgIndex];

              // 防止重复接收
              if (originalMsg.status && originalMsg.status !== 'pending') continue;

              originalMsg.status = 'accepted';

              // ★★★ 新增：构造 AI 的“已收款”消息 ★★★
              aiMessage = {
                role: 'assistant',
                senderName: msgData.name || chat.name,
                type: 'transfer',
                isReceived: true,  // 标记为收款
                amount: originalMsg.amount,
                currency: originalMsg.currency || 'CNY',
                note: '已收款',
                timestamp: messageTimestamp++
              };
              
              if (isViewingThisChat) {
                const bubble = document.querySelector(`.message-bubble[data-timestamp="${msgData.for_timestamp}"]`);
                if (bubble) {
                  const noteEl = bubble.querySelector('.transfer-note');
                  if (noteEl) noteEl.textContent = '对方已收款';
                }
              }
              // 去掉 continue，让它流转到下方的统一推送逻辑(if aiMessage...)
              break;
            }
            continue;
          }

          case 'decline_transfer': {
            const originalTransferMsgIndex = chat.history.findIndex(m => m.timestamp === msgData.for_timestamp);
            if (originalTransferMsgIndex > -1) {
              const originalMsg = chat.history[originalTransferMsgIndex];

              // --- 修复：如果已经处理过，直接忽略 ---
              if (originalMsg.status && originalMsg.status !== 'pending') {
                console.warn(`AI试图重复拒收一笔已处理的转账 (状态: ${originalMsg.status})，已拦截。`);
                continue;
              }

              originalMsg.status = 'declined';
              await processTransaction(originalMsg.amount, 'income', `转账退款-${chat.name}`);
              const refundMessage = {
                role: 'assistant',
                senderName: chat.name,
                type: 'transfer',
                isRefund: true, // 确保标记为退款
                amount: originalMsg.amount,
                currency: originalMsg.currency || 'CNY',
                note: '转账已被拒收',
                receiverName: '我', // 明确接收人
                timestamp: messageTimestamp++
              };
              chat.history.push(refundMessage);
              if (isViewingThisChat) {
                const bubble = document.querySelector(`.message-bubble[data-timestamp="${msgData.for_timestamp}"]`);
                if (bubble) {
                  const noteEl = bubble.querySelector('.transfer-note');
                  if (noteEl) noteEl.textContent = '对方已拒收';
                }
                appendMessage(refundMessage, chat);
              }
            }
            continue;
          }
          case 'change_group_name':
            if (chat.isGroup && msgData.new_name) {
              const newName = msgData.new_name.trim();
              const memberNames = chat.members.map(m => m.originalName);

              if (memberNames.includes(newName)) {
                console.warn(`AI (${msgData.name}) 试图将群名更改为成员名 ("${newName}")。操作已被程序阻止。`);
                continue;
              }

              chat.name = newName;

              const changerMember = chat.members.find(m => m.originalName === msgData.name);
              const changerDisplayName = changerMember ? changerMember.groupNickname : msgData.name;

              const systemMessage = {
                role: 'system',
                type: 'pat_message',
                content: `${changerDisplayName} 将群名修改为 “${chat.name}”`,
                timestamp: messageTimestamp++
              };
              chat.history.push(systemMessage);

              if (isViewingThisChat) {
                appendMessage(systemMessage, chat);
                document.getElementById('chat-header-title').textContent = chat.name;
              }
            }
            continue;
          case 'change_remark_name':
            if (!chat.isGroup && msgData.new_name) {
              const oldName = chat.name;
              const newName = msgData.new_name.trim();

              if (newName && newName !== oldName) {
                if (!chat.nameHistory) {
                  chat.nameHistory = [];
                }
                if (!chat.nameHistory.includes(oldName)) {
                  chat.nameHistory.push(oldName);
                }

                chat.name = newName;

                const systemMessage = {
                  role: 'system',
                  type: 'pat_message',
                  content: `“${chat.originalName}” 将备注修改为 “${newName}”`,
                  timestamp: messageTimestamp++
                };
                chat.history.push(systemMessage);

                const hiddenMemoryMessage = {
                  role: 'system',
                  content: `[系统提示：你刚刚成功将自己的备注名修改为了“${newName}”。请自然地接受这个新名字，不要对此感到惊讶。]`,
                  timestamp: messageTimestamp++,
                  isHidden: true
                };
                chat.history.push(hiddenMemoryMessage);

                if (isViewingThisChat) {
                  appendMessage(systemMessage, chat);
                  document.getElementById('chat-header-title').textContent = newName;
                }

                await syncCharacterNameInGroups(chat);
              }
            }
            continue;

          case 'change_group_avatar':
            if (chat.isGroup && msgData.avatar_name) {
              const avatarName = msgData.avatar_name;
              const library = chat.settings.groupAvatarLibrary || [];
              const foundAvatar = library.find(avatar => avatar.name === avatarName);

              if (foundAvatar) {
                chat.settings.groupAvatar = foundAvatar.url;

                const changerMember = chat.members.find(m => m.originalName === msgData.name);
                const changerDisplayName = changerMember ? changerMember.groupNickname : msgData.name;

                const systemMessage = {
                  role: 'system',
                  type: 'pat_message',
                  content: `${changerDisplayName} 更换了群头像`,
                  timestamp: messageTimestamp++
                };
                chat.history.push(systemMessage);

                if (isViewingThisChat) {
                  appendMessage(systemMessage, chat);
                }
              } else {
                console.warn(`AI 尝试使用一个不存在的群头像: "${avatarName}"`);
              }
            }
            continue;
          case 'system_message':
            aiMessage = {
              role: 'system',
              type: 'pat_message',
              content: msgData.content,
              timestamp: Date.now()
            };
            break;
          case 'share_link':
            aiMessage = {
              ...baseMessage,
              type: 'share_link',
              title: msgData.title,
              description: msgData.description,
              source_name: msgData.source_name,
              content: msgData.content
            };
            break;
          case 'quote_reply': {
            let originalMessage = null;


            if (msgData.target_content) {
              originalMessage = [...chat.history].reverse().find(m =>
                !m.isHidden &&
                (
                  m.content === msgData.target_content ||
                  (typeof m.content === 'string' && m.content.trim() === msgData.target_content.trim())
                )
              );

              if (!originalMessage) {
                console.warn(`[本轮引用失败] AI ${msgData.name} 尝试引用内容 "${(msgData.target_content || '').substring(0, 20)}..."，但在本轮历史中未找到。`);
              }
            }


            else if (msgData.target_timestamp) {
              originalMessage = chat.history.find(m => m.timestamp === msgData.target_timestamp);
            }


            if (originalMessage) {


              let quotedSenderDisplayName;

              if (originalMessage.role === 'user') {

                quotedSenderDisplayName = chat.settings.myNickname || '我';
              } else {

                if (chat.isGroup) {

                  quotedSenderDisplayName = getDisplayNameInGroup(chat, originalMessage.senderName);
                } else {

                  quotedSenderDisplayName = chat.name;
                }
              }

              const quoteContext = {
                timestamp: originalMessage.timestamp,
                senderName: quotedSenderDisplayName,

                content: String(originalMessage.content || '').substring(0, 50)
              };


              aiMessage = {
                ...baseMessage,
                content: msgData.reply_content,
                quote: quoteContext
              };
            } else {

              console.warn(`引用回复失败: 找不到目标消息 (Content: ${msgData.target_content}, TS: ${msgData.target_timestamp})`);
              aiMessage = {
                ...baseMessage,
                content: msgData.reply_content
              };
            }
            break;
          }
          case 'send_and_recall': {
            if (!isViewingThisChat) continue;
            const tempMessageData = {
              ...baseMessage,
              content: msgData.content
            };
            const tempMessageElement = createMessageElement(tempMessageData, chat);
            appendMessage(tempMessageData, chat, true);
            await new Promise(resolve => setTimeout(resolve, Math.random() * 2000 + 500));
            const bubbleWrapper = document.querySelector(`.message-bubble[data-timestamp="${tempMessageData.timestamp}"]`)?.closest('.message-wrapper');
            if (bubbleWrapper) {
              bubbleWrapper.classList.add('recalled-animation');
              await new Promise(resolve => setTimeout(resolve, 300));
              const recalledMessage = {
                role: 'assistant',
                senderName: msgData.name || chat.name,
                type: 'recalled_message',
                content: '对方撤回了一条消息',
                timestamp: tempMessageData.timestamp,
                recalledData: {
                  originalType: 'text',
                  originalContent: msgData.content
                }
              };
              const msgIndex = chat.history.findIndex(m => m.timestamp === tempMessageData.timestamp);
              if (msgIndex > -1) {
                chat.history[msgIndex] = recalledMessage;
              } else {
                chat.history.push(recalledMessage);
              }
              const placeholder = await createMessageElement(recalledMessage, chat);
              if (document.body.contains(bubbleWrapper)) {
                bubbleWrapper.parentNode.replaceChild(placeholder, bubbleWrapper);
              }
            }
            continue;
          }

          case 'text':
            aiMessage = {
              ...baseMessage,
              content: String(msgData.content || msgData.message)
            };
            break;
          case 'sticker':
            if (msgData.meaning) {
              const sticker = findBestStickerMatch(msgData.meaning, state.userStickers);
              if (sticker) {
                aiMessage = {
                  ...baseMessage,
                  type: 'sticker',
                  content: sticker.url,
                  meaning: sticker.name
                };
              } else {

                console.warn(`AI 尝试使用一个不存在的表情: "${msgData.meaning}"`);
                aiMessage = null;
              }
            } else {

              console.warn("AI 发送了一个没有 'meaning' 的 sticker 指令。", msgData);
              aiMessage = {
                ...baseMessage,
                type: 'sticker',
                content: msgData.url,
                meaning: '未知表情'
              };
            }
            break;
          case 'ai_image':
            aiMessage = {
              ...baseMessage,
              type: 'ai_image',
              content: msgData.description,
              image_prompt: msgData.image_prompt
            };
            break;
          case 'voice_message':
            aiMessage = {
              ...baseMessage,
              type: 'voice_message',
              content: msgData.content
            };
            break;
          case 'thought_chain_block':
            aiMessage = {
              ...baseMessage,
              type: 'thought_chain_block',
              content: msgData.content
            };
            break;
          case 'transfer':
            aiMessage = {
              ...baseMessage,
              type: 'transfer',
              amount: msgData.amount,
              currency: msgData.currency || 'CNY',
              note: msgData.note,
              receiverName: msgData.receiver || '我'
            };
            break;

          case 'waimai_request':
            aiMessage = {
              ...baseMessage,
              type: 'waimai_request',
              productInfo: msgData.productInfo,
              amount: msgData.amount,
              status: 'pending',
              countdownEndTime: Date.now() + 15 * 60 * 1000,
            };
            break;
          case 'waimai_order':
            aiMessage = {
              ...baseMessage,
              type: 'waimai_order',
              productInfo: msgData.productInfo,
              amount: msgData.amount,
              greeting: msgData.greeting,
              recipientName: msgData.recipientName || null
            };
            break;
          case 'offline_text':
            aiMessage = {
              ...baseMessage,
              ...msgData
            };
            break;

          case 'naiimag':

            try {
              console.log('📸 NovelAI图片生成开始，AI提供的prompt:', msgData.prompt);


              const naiPrompts = getCharacterNAIPrompts(chat.id);


              const aiPrompt = msgData.prompt || 'a beautiful scene';
              const finalPositivePrompt = aiPrompt + ', ' + naiPrompts.positive;
              const finalNegativePrompt = naiPrompts.negative;

              console.log(`📝 使用${naiPrompts.source === 'character' ? '角色专属' : '系统'}提示词配置`);
              console.log('最终正面提示词:', finalPositivePrompt);
              console.log('最终负面提示词:', finalNegativePrompt);


              const apiKey = localStorage.getItem('novelai-api-key');
              const model = localStorage.getItem('novelai-model') || 'nai-diffusion-4-5-full';
              const settings = getNovelAISettings();

              if (!apiKey) {
                throw new Error('NovelAI API Key未配置。请在NovelAI设置中填写API Key。');
              }

              const [width, height] = settings.resolution.split('x').map(Number);


              let requestBody;

              if (model.includes('nai-diffusion-4')) {

                requestBody = {
                  input: finalPositivePrompt,
                  model: model,
                  action: 'generate',
                  parameters: {
                    params_version: 3,
                    width: width,
                    height: height,
                    scale: settings.cfg_scale,
                    sampler: settings.sampler,
                    steps: settings.steps,
                    seed: settings.seed === -1 ? Math.floor(Math.random() * 9999999999) : settings.seed,
                    n_samples: 1,
                    ucPreset: settings.uc_preset,
                    qualityToggle: settings.quality_toggle,
                    autoSmea: false,
                    dynamic_thresholding: false,
                    controlnet_strength: 1,
                    legacy: false,
                    add_original_image: true,
                    cfg_rescale: 0,
                    noise_schedule: 'karras',
                    legacy_v3_extend: false,
                    skip_cfg_above_sigma: null,
                    use_coords: false,
                    legacy_uc: false,
                    normalize_reference_strength_multiple: true,
                    inpaintImg2ImgStrength: 1,
                    characterPrompts: [],

                    v4_prompt: {
                      caption: {
                        base_caption: finalPositivePrompt,
                        char_captions: []
                      },
                      use_coords: false,
                      use_order: true
                    },

                    v4_negative_prompt: {
                      caption: {
                        base_caption: finalNegativePrompt,
                        char_captions: []
                      },
                      legacy_uc: false
                    },
                    negative_prompt: finalNegativePrompt,
                    deliberate_euler_ancestral_bug: false,
                    prefer_brownian: true

                  }
                };
              } else {

                requestBody = {
                  input: finalPositivePrompt,
                  model: model,
                  action: 'generate',
                  parameters: {
                    width: width,
                    height: height,
                    scale: settings.cfg_scale,
                    sampler: settings.sampler,
                    steps: settings.steps,
                    seed: settings.seed === -1 ? Math.floor(Math.random() * 9999999999) : settings.seed,
                    n_samples: 1,
                    ucPreset: settings.uc_preset,
                    qualityToggle: settings.quality_toggle,
                    sm: settings.smea,
                    sm_dyn: settings.smea_dyn,
                    dynamic_thresholding: false,
                    controlnet_strength: 1,
                    legacy: false,
                    add_original_image: false,
                    cfg_rescale: 0,
                    noise_schedule: 'native',
                    negative_prompt: finalNegativePrompt
                  }
                };
              }

              console.log('🚀 发送NAI请求:', requestBody);


              let apiUrl;


              if (model.includes('nai-diffusion-4')) {

                apiUrl = 'https://image.novelai.net/ai/generate-image-stream';
              } else {

                apiUrl = 'https://image.novelai.net/ai/generate-image';
              }

              let corsProxy = settings.cors_proxy;


              if (corsProxy === 'custom') {
                corsProxy = settings.custom_proxy_url || '';
              }


              if (corsProxy && corsProxy !== '') {
                apiUrl = corsProxy + encodeURIComponent(apiUrl);
              }

              const response = await fetch(apiUrl, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': 'Bearer ' + apiKey
                },
                body: JSON.stringify(requestBody)
              });

              console.log('Response status:', response.status);
              console.log('Response headers:', [...response.headers.entries()]);

              if (!response.ok) {
                const errorText = await response.text();
                console.error('API错误响应:', errorText);
                throw new Error(`API请求失败 (${response.status}): ${errorText}`);
              }


              const contentType = response.headers.get('content-type');
              console.log('Content-Type:', contentType);


              let zipBlob;
              let imageDataUrl;
              if (contentType && contentType.includes('text/event-stream')) {
                console.log('检测到 SSE 流式响应，开始解析...');


                const text = await response.text();
                console.log('收到 SSE 数据，大小:', text.length);


                const lines = text.trim().split('\n');
                let base64Data = null;

                for (let i = lines.length - 1; i >= 0; i--) {
                  const line = lines[i].trim();
                  if (line.startsWith('data: ') && line !== 'data: [DONE]') {
                    const dataContent = line.substring(6);


                    try {
                      const jsonData = JSON.parse(dataContent);


                      if (jsonData.event_type === 'final' && jsonData.image) {
                        base64Data = jsonData.image;
                        console.log('✅ 找到 final 事件的图片数据');
                        break;
                      }


                      if (jsonData.data) {
                        base64Data = jsonData.data;
                        console.log('从 JSON.data 中提取图片数据');
                        break;
                      }
                      if (jsonData.image) {
                        base64Data = jsonData.image;
                        console.log('从 JSON.image 中提取图片数据');
                        break;
                      }
                    } catch (e) {

                      base64Data = dataContent;
                      console.log('直接使用 base64 数据');
                      break;
                    }
                  }
                }

                if (!base64Data) {
                  throw new Error('无法从 SSE 响应中提取图片数据');
                }


                const isPNG = base64Data.startsWith('iVBORw0KGgo');
                const isJPEG = base64Data.startsWith('/9j/');

                if (isPNG || isJPEG) {
                  console.log('✅ 检测到直接的图片 base64 数据 (PNG/JPEG)');

                  const binaryString = atob(base64Data);
                  const bytes = new Uint8Array(binaryString.length);
                  for (let i = 0; i < binaryString.length; i++) {
                    bytes[i] = binaryString.charCodeAt(i);
                  }
                  const imageBlob = new Blob([bytes], {
                    type: isPNG ? 'image/png' : 'image/jpeg'
                  });
                  console.log('图片 Blob 创建成功，大小:', imageBlob.size);


                  const reader = new FileReader();
                  imageDataUrl = await new Promise((resolve, reject) => {
                    reader.onloadend = () => resolve(reader.result);
                    reader.onerror = reject;
                    reader.readAsDataURL(imageBlob);
                  });
                  console.log('✅ 图片转换成功！🎨');
                } else {

                  console.log('当作 ZIP 文件处理...');
                  const binaryString = atob(base64Data);
                  const bytes = new Uint8Array(binaryString.length);
                  for (let i = 0; i < binaryString.length; i++) {
                    bytes[i] = binaryString.charCodeAt(i);
                  }
                  zipBlob = new Blob([bytes]);
                  console.log('ZIP Blob 大小:', zipBlob.size);
                }
              } else {

                zipBlob = await response.blob();
                console.log('收到数据，类型:', zipBlob.type, '大小:', zipBlob.size);
              }


              if (!imageDataUrl && zipBlob) {

                try {

                  if (typeof JSZip === 'undefined') {
                    throw new Error('JSZip库未加载，请刷新页面重试');
                  }


                  const zip = await JSZip.loadAsync(zipBlob);
                  console.log('ZIP文件内容:', Object.keys(zip.files));


                  let imageFile = null;
                  for (let filename in zip.files) {
                    if (filename.match(/\.(png|jpg|jpeg|webp)$/i)) {
                      imageFile = zip.files[filename];
                      console.log('找到图片文件:', filename);
                      break;
                    }
                  }

                  if (!imageFile) {
                    throw new Error('ZIP文件中未找到图片');
                  }


                  const imageBlob = await imageFile.async('blob');
                  console.log('提取的图片大小:', imageBlob.size);


                  const reader = new FileReader();
                  imageDataUrl = await new Promise((resolve, reject) => {
                    reader.onloadend = () => resolve(reader.result);
                    reader.onerror = reject;
                    reader.readAsDataURL(imageBlob);
                  });
                  console.log('✅ 图片解压成功！');
                } catch (zipError) {
                  console.error('ZIP解压失败:', zipError);
                  throw new Error('图片解压失败: ' + zipError.message);
                }
              }

              console.log('✅ NAI图片生成成功！');


              aiMessage = {
                ...baseMessage,
                type: 'naiimag',
                imageUrl: imageDataUrl,
                prompt: aiPrompt,
                fullPrompt: finalPositivePrompt // 保存完整提示词供查看
              };
            } catch (error) {
              console.error('❌ NAI图片生成失败:', error);

              aiMessage = {
                ...baseMessage,
                content: `[图片生成失败: ${error.message}]`
              };
            }
            break;

          case 'googleimag':
            try {
              console.log('📸 Google Imagen图片生成开始，AI提供的prompt:', msgData.prompt);
              const googlePrompt = msgData.prompt || 'a beautiful scene';

              const googleResult = await generateGoogleImagenFromPrompt(googlePrompt);

              aiMessage = {
                ...baseMessage,
                type: 'googleimag',
                imageUrl: googleResult.imageUrl,
                prompt: googlePrompt,
                fullPrompt: googleResult.fullPrompt
              };
            } catch (error) {
              console.error('❌ Google Imagen图片生成失败:', error);
              aiMessage = {
                ...baseMessage,
                content: `[Google Imagen图片生成失败: ${error.message}]`
              };
            }
            break;

          default:
            console.warn("收到了未知的AI指令类型:", msgData.type);
            break;
        }

        if (aiMessage) {
          aiMessage = applyRoleReplySanitizer(aiMessage, chat);
          chat.history.push(aiMessage);
          if (!isViewingThisChat && aiMessage.type !== 'thought_chain_block') {
            chat.unreadCount = (chat.unreadCount || 0) + 1;
          }
          if (!isViewingThisChat && !notificationShown && aiMessage.type !== 'thought_chain_block') {
            let notificationText;
            switch (aiMessage.type) {
              case 'transfer':
                notificationText = `[收到一笔转账]`;
                break;
              case 'waimai_request':
                notificationText = `[收到一个外卖代付请求]`;
                break;
              case 'ai_image':
              case 'googleimag':
                notificationText = `[图片]`;
                break;
              case 'voice_message':
                notificationText = `[语音]`;
                break;
              case 'sticker':
                notificationText = aiMessage.meaning ? `[表情: ${aiMessage.meaning}]` : '[表情]';
                break;
              case 'offline_text':
                notificationText = aiMessage.dialogue ? `「${aiMessage.dialogue}」` : `[${(aiMessage.description || aiMessage.content || '线下消息').substring(0, 20)}...]`;
                break;
              default:
                notificationText = String(aiMessage.content || '');
            }
            const finalNotifText = chat.isGroup ? `${aiMessage.senderName}: ${notificationText}` : notificationText;
            showNotification(chatId, finalNotifText.substring(0, 40) + (finalNotifText.length > 40 ? '...' : ''));
            notificationShown = true;
          } else if (isViewingThisChat && !notificationShown && aiMessage.type !== 'thought_chain_block') {
            // 新增：如果在聊天页面且启用了"在聊天页面也发送通知"，则发送系统级通知
            let notificationText;
            switch (aiMessage.type) {
              case 'transfer':
                notificationText = `[收到一笔转账]`;
                break;
              case 'waimai_request':
                notificationText = `[收到一个外卖代付请求]`;
                break;
              case 'ai_image':
              case 'googleimag':
                notificationText = `[图片]`;
                break;
              case 'voice_message':
                notificationText = `[语音]`;
                break;
              case 'sticker':
                notificationText = aiMessage.meaning ? `[表情: ${aiMessage.meaning}]` : '[表情]';
                break;
              case 'offline_text':
                notificationText = aiMessage.dialogue ? `「${aiMessage.dialogue}」` : `[${(aiMessage.description || aiMessage.content || '线下消息').substring(0, 20)}...]`;
                break;
              default:
                notificationText = String(aiMessage.content || '');
            }
            const finalNotifText = chat.isGroup ? `${aiMessage.senderName}: ${notificationText}` : notificationText;
            triggerSystemNotificationInChatPage(chatId, finalNotifText.substring(0, 40) + (finalNotifText.length > 40 ? '...' : ''));
            notificationShown = true;
          }



          const rawAiContentForCart = String(aiMessage.content || '');
          const hasClearCartCommand =
            /\[清空购物车\]|【清空购物车】/.test(rawAiContentForCart);

          if (hasClearCartCommand) {
            aiMessage.content = rawAiContentForCart
              .replace(/\s*(\[清空购物车\]|【清空购物车】)\s*/g, '')
              .trim();
          }

          if (isViewingThisChat) {
            appendMessage(aiMessage, chat);
            await new Promise(resolve => setTimeout(resolve, Math.random() * 1800 + 1000));
          }

          if (hasClearCartCommand && window.handleShoppingCartCommandFromAI) {
            await window.handleShoppingCartCommandFromAI(chat.id, rawAiContentForCart);
          }
        }
      }

      if (callHasBeenHandled && videoCallState.isGroupCall) {
        videoCallState.isAwaitingResponse = false;
        if (videoCallState.participants.length > 0) {
          startVideoCall();
        } else {
          videoCallState = {
            ...videoCallState,
            isAwaitingResponse: false,
            participants: []
          };
          showScreen('chat-interface-screen');
          alert('无人接听群聊邀请。');
        }
      }
      if (needsImmediateReaction) {
        await triggerAiResponse();
        return;
      }
      await db.chats.put(chat);

      const qzoneActionTaken = messagesArray.some(action =>
        action.type === 'qzone_post' ||
        action.type === 'qzone_like' ||
        action.type === 'qzone_comment' ||
        action.type === 'repost'
      );


      if (qzoneActionTaken) {
        console.log("检测到AI执行了动态操作，立即刷新好友动态页面。");

        await renderQzonePosts();
      }


    } catch (error) {

      chat.history = chat.history.filter(msg => !msg.isTemporary);

      if (error.name === 'AbortError') {
        console.log('API调用已被用户取消');
        videoCallState.isAwaitingResponse = false;
        return;
      }

      if (!chat.isGroup && chat.relationship?.status === 'pending_ai_approval') {
        chat.relationship.status = 'blocked_by_ai';
        await showCustomAlert('申请失败', `AI在处理你的好友申请时出错了，请稍后重试。\n错误信息: ${error.message}`);
      } else {
        await showCustomAlert(
          'API 调用失败',
          `发生了一个错误，AI未能成功响应。\n\n错误详情:\n${error.message}`
        );
      }

      if (!chat.isGroup && chat.relationship?.status === 'blocked_by_ai') {
        await db.chats.put(chat);
      }

      videoCallState.isAwaitingResponse = false;
    } finally {
      currentApiController = null;
      if (stopBtn) {
        stopBtn.style.display = 'none';
        stopBtn.classList.remove('active');
      }
      setAvatarActingState(chatId, false);


      if (chat.isGroup) {
        if (typingIndicator) {
          typingIndicator.style.display = 'none';
        }
      } else {
        if (chatHeaderTitle && state.chats[chatId]) {
          chatHeaderTitle.style.opacity = 0;
          setTimeout(() => {
            chatHeaderTitle.textContent = state.chats[chatId].name;
            chatHeaderTitle.classList.remove('typing-status');
            chatHeaderTitle.style.opacity = 1;
          }, 200);
        }
      }
      renderChatList();
      if (isViewingThisChat) {
        checkAndTriggerAutoSummary(chatId);

      }
      // 情侣空间 AI 自主决定模式 - 聊天触发
      if (!chat.isGroup && typeof triggerCoupleSpaceAiDecide === 'function') {
        try { triggerCoupleSpaceAiDecide(chatId, 'chat'); } catch(e) {}
      }
      stopSilentAudio();
    }
  }


  // ========== 重新生成与推进功能 ==========
  // 从 script.js 迁移：handleRegenerateResponse, handleRegenerateCallResponse, handlePropelAction

  async function handleRegenerateResponse() {
    const chat = state.chats[state.activeChatId];
    if (!chat) return;

    const lastUserMsgIndex = chat.history.findLastIndex(msg => msg.role === 'user' && !msg.isHidden);

    if (lastUserMsgIndex === -1) {
      alert("没有可供重新生成回复的用户消息。");
      return;
    }

    const lastAiMsgIndex = chat.history.findLastIndex(msg => msg.role === 'assistant');
    if (lastAiMsgIndex < lastUserMsgIndex) {
      alert("AI 尚未对您的最后一条消息做出回应，无法重新生成。");
      return;
    }

    chat.history = chat.history.slice(0, lastUserMsgIndex + 1);

    await db.chats.put(chat);
    await renderChatInterface(state.activeChatId);

    await triggerAiResponse();
  }

  async function handleRegenerateCallResponse() {
    if (!videoCallState.isActive) return;

    const lastUserSpeechIndex = videoCallState.callHistory.findLastIndex(msg => msg.role === 'user');

    if (lastUserSpeechIndex === -1) {
      alert("通话中还没有你的发言，无法重新生成回应。");
      return;
    }

    videoCallState.callHistory.splice(lastUserSpeechIndex + 1);

    const callFeed = document.getElementById('video-call-main');
    callFeed.innerHTML = '';
    videoCallState.callHistory.forEach(msg => {
      const bubble = document.createElement('div');

      const speechClass = msg.role === 'assistant' ? 'ai-speech' : 'user-speech';
      bubble.className = `call-message-bubble ${speechClass}`;

      bubble.dataset.timestamp = msg.timestamp;
      if (msg.role === 'user') {
        bubble.textContent = msg.content;
      } else {
        bubble.innerHTML = msg.content;
      }
      addLongPressListener(bubble, () => showCallMessageActions(msg.timestamp));
      callFeed.appendChild(bubble);
    });
    callFeed.scrollTop = callFeed.scrollHeight;

    triggerAiInCallAction(null);
  }

  async function handlePropelAction() {
    const chat = state.chats[state.activeChatId];
    if (!chat) return;

    setAvatarActingState(chat.id, true);
    const chatHeaderTitle = document.getElementById('chat-header-title');
    if (!chat.isGroup) {
      chatHeaderTitle.style.opacity = 0;
      setTimeout(() => {
        chatHeaderTitle.textContent = '对方正在输入...';
        chatHeaderTitle.classList.add('typing-status');
        chatHeaderTitle.style.opacity = 1;
      }, 200);
    }

    try {
      const {
        proxyUrl,
        apiKey,
        model
      } = state.apiConfig;
      if (!proxyUrl || !apiKey || !model) {
        throw new Error('API未配置');
      }

      const maxMemory = parseInt(chat.settings.maxMemory) || 10;
      const historySlice = chat.history.slice(-maxMemory);

      const now = new Date();
      const chinaTime = new Date(now.getTime() + (now.getTimezoneOffset() * 60000) + (3600000 * 8));
      const currentTime = chinaTime.toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        dateStyle: 'full',
        timeStyle: 'short'
      });
      const timeOfDayGreeting = getTimeOfDayGreeting(chinaTime);
      const myNickname = chat.settings.myNickname || '我';

      let worldBookContent = '';
      let allWorldBookIds = [...(chat.settings.linkedWorldBookIds || [])];
      state.worldBooks.forEach(wb => {
        if (wb.isGlobal && !allWorldBookIds.includes(wb.id)) {
          allWorldBookIds.push(wb.id);
        }
      });

      if (allWorldBookIds.length > 0) {
        const linkedContents = allWorldBookIds.map(bookId => {
          const worldBook = state.worldBooks.find(wb => wb.id === bookId);
          if (!worldBook || !Array.isArray(worldBook.content)) return '';
          const formattedEntries = worldBook.content
            .filter(entry => entry.enabled !== false)
            .map(entry => {
              let entryString = `\n### 条目: ${entry.comment || '无备注'}\n`;
              entryString += `**内容:**\n${entry.content}`;
              return entryString;
            }).join('');
          return formattedEntries ? `\n\n## 世界书: ${worldBook.name}\n${formattedEntries}` : '';
        }).filter(Boolean).join('');
        if (linkedContents) {
          worldBookContent = `# --- 世界书 (World Book) ---
# 【最高优先级指令：绝对真理】
# 以下内容是你所在世界的"物理法则"和"基础常识"。
# 无论用户是否提及，你都【必须】时刻主动应用这些设定来指导你的思考和描写。
# 它们是无条件生效的，不需要触发词。
${linkedContents}
# --- 世界书设定结束 ---
`;
        }
      }
      let musicContext = '';
      if (musicState.isActive && musicState.activeChatId === chat.id) {
        const currentTrack = musicState.currentIndex > -1 ? musicState.playlist[musicState.currentIndex] : null;
        musicContext = `\n\n# 当前音乐情景...\n(省略详细内容，与triggerAiResponse一致)`;
      }
      const gomokuContext = formatGomokuStateForAI(gomokuState[chat.id]);
      let nameHistoryContext = '';
      if (chat.nameHistory && chat.nameHistory.length > 0) {
        nameHistoryContext = `\n- **你的曾用名**: [${chat.nameHistory.join(', ')}]。当在对话历史中看到这些名字时，它们都指的是【你】自己。`;
      }
      let userProfileContext = '';
      const userQzoneNickname = state.qzoneSettings.nickname || '用户';
      userProfileContext += `- 用户的QZone昵称是 "${userQzoneNickname}"。\n`;
      const commonGroups = Object.values(state.chats).filter(group => group.isGroup && group.members.some(m => m.id === chat.id));
      if (commonGroups.length > 0) {
        userProfileContext += '- 用户在你们共同所在的群聊中的昵称如下：\n';
        commonGroups.forEach(group => {
          const myNicknameInGroup = group.settings.myNickname || userQzoneNickname;
          userProfileContext += `  - 在群聊"${group.name}"中，用户的昵称是"${myNicknameInGroup}"。\n`;
        });
      }
      userProfileContext += '当你在任何系统提示、动态评论或挂载的群聊记忆中看到这些名字时，它们都指代的是【你的聊天对象】。';
      const stickerContext = getStickerContextForPrompt(chat);

      // 根据记忆模式构建记忆上下文
      let memoryContextForPrompt = '';
      const memoryMode = chat.settings.memoryMode || (chat.settings.enableStructuredMemory ? 'structured' : 'diary');
      if (memoryMode === 'vector' && window.vectorMemoryManager) {
        // 向量记忆模式：异步检索相关记忆
        // 构建检索query：根据用户设置的检索策略
        const vm = window.vectorMemoryManager.getVariableMemory(chat);
        const retrievalStrategy = vm.settings.retrievalStrategy || 'user-only';
        const userMsgCount = vm.settings.retrievalUserMsgCount || 3;
        
        let queryText = '';
        if (retrievalStrategy === 'user-only') {
          // 只用用户的最近N条消息
          const userMessages = filteredHistory.filter(m => m.role === 'user').slice(-userMsgCount);
          queryText = userMessages.map(m => typeof m.content === 'string' ? m.content : '').join(' ');
        } else if (retrievalStrategy === 'user-weighted') {
          // 用户消息权重高，角色消息权重低
          const recentMsgs = filteredHistory.slice(-10);
          const userMsgs = recentMsgs.filter(m => m.role === 'user').map(m => typeof m.content === 'string' ? m.content : '').join(' ');
          const aiMsgs = recentMsgs.filter(m => m.role === 'assistant').slice(-2).map(m => typeof m.content === 'string' ? m.content : '').join(' ');
          queryText = userMsgs + ' ' + aiMsgs;
        } else {
          // 混合模式（兼容旧版）
          queryText = filteredHistory.slice(-5).map(m => typeof m.content === 'string' ? m.content : '').join(' ');
        }
        
        memoryContextForPrompt = await window.vectorMemoryManager.serializeForPrompt(chat, queryText);
      } else if (memoryMode === 'structured' && window.structuredMemoryManager) {
        memoryContextForPrompt = '# 长期记忆 (必须严格遵守)\n' + window.structuredMemoryManager.serializeForPrompt(chat);
      } else {
        memoryContextForPrompt = '# 长期记忆 (必须严格遵守)\n' + (chat.longTermMemory && chat.longTermMemory.length > 0 ? chat.longTermMemory.map(mem => `- ${mem.content}`).join('\n') : '- (暂无)');
      }

      let aiAgeContext = getDynamicAgeContext(chat);
      let currencyExchangeContext = chat.settings.enableDynamicCurrency ? getCurrencyExchangeContext() : '';

      let systemPromptTemplate = window.getActiveChatPrompt ? window.getActiveChatPrompt(chat.isGroup && chat.settings.isOfflineMode ? 'group_offline' : 'single') : '';
      
      const contextMapPropel = {
        'aiAgeContext': aiAgeContext,
        'currencyExchangeContext': currencyExchangeContext,
        'char_avatar': chat.isGroup ? (chat.settings.groupAvatar || 'https://i.postimg.cc/y8xWzCqj/anime-boy.jpg') : (chat.settings.aiAvatar || 'https://i.postimg.cc/y8xWzCqj/anime-boy.jpg'),
        'user_avatar': chat.settings.myAvatar || (state.qzoneSettings && state.qzoneSettings.avatar) || 'https://i.postimg.cc/y8xWzCqj/anime-boy.jpg',
        'char_name': chat.originalName,
        'char_remark': chat.name,
        'user_name': (state.qzoneSettings && state.qzoneSettings.nickname) || '用户',
        'user_nickname': myNickname,
        'chat.originalName': chat.originalName,
        'aiPersona': chat.settings.aiPersona,
        'latestThoughtContext': '', // 推进时通常没有上一轮思考，故留空
        'worldBookContent': worldBookContent || '(当前无特殊世界观设定，以现实逻辑为准)',
        'memoryContextForPrompt': memoryContextForPrompt,
        'multiLayeredSummaryContext': '',
        'todoListContext': '',
        'periodSummaryContext': '',
        'chat.name': chat.name,
        'myNickname': myNickname,
        'myPersona': chat.settings.myPersona || '普通用户',
        'userStatus': chat.settings.userStatus ? chat.settings.userStatus.text : '在线' + (chat.settings.userStatus && chat.settings.userStatus.isBusy ? '(忙碌中)' : ''),
        'userProfileContext': userProfileContext,
        'nameHistoryContext': nameHistoryContext,
        'timePerceptionContext': chat.settings.enableTimePerception ? `- **当前时间**: ${currentTime} (${timeOfDayGreeting})` : '',
        'weatherContext': '', // 推进时省略天气
        'timeContext': '',
        'musicContextStr': musicContext ? '你们正在一起听歌，' + musicContext : '你们没有在听歌。',
        'readingContextStr': '你们没有在读书。',
        'contactsList': '',
        'postsContext': '',
        'groupContext': '',
        'gomokuContext': gomokuContext,
        'sharedContext': '',
        'callTranscriptContext': '',
        'synthMusicInstruction': '',
        'narratorInstruction': '',
        'kinshipContext': '',
        'coupleSpaceContext': '',
        'bilingualModeContext': '',
        'thoughtsPrompt': '',
        'bilingualAlertText': '',
        'bilingualAlertVoice': '',
        'novelAiImageContext': '',
        'googleImagenContext': '',
        'qzoneActionsPrompt': '',
        'viewMyPhonePrompt': '',
        'crossChatInstruction': '',
        'todoInstruction': '',
        'stickerContext': stickerContext,
        'aiAvatarLibrary': chat.settings.aiAvatarLibrary && chat.settings.aiAvatarLibrary.length > 0 ? chat.settings.aiAvatarLibrary.map(avatar => `- ${avatar.name}`).join('\n') : '- (空)',
        'myAvatarLibrary': chat.settings.myAvatarLibrary && chat.settings.myAvatarLibrary.length > 0 ? chat.settings.myAvatarLibrary.map(avatar => `- ${avatar.name}`).join('\n') : '- (空)'
      };

      let systemPrompt = replaceTemplateVars(systemPromptTemplate, contextMapPropel);

      systemPrompt = processPromptWithSettings(systemPrompt, chat.isGroup && chat.settings.isOfflineMode ? 'group_offline' : 'single');

      if (window.getPeriodPromptForChat && chat?.id) {
        const periodPrompt = await window.getPeriodPromptForChat(chat.id);
        if (periodPrompt) {
          systemPrompt += '\n\n' + periodPrompt;
        }
      }

      if (window.getShoppingCartPromptForChat && chat?.id) {
        const shoppingCartPrompt = await window.getShoppingCartPromptForChat(chat.id);
        if (shoppingCartPrompt) {
          systemPrompt += '\n\n' + shoppingCartPrompt;
        }
      }

      if (window.getCharacterWalletPromptForChat && chat?.id) {
        const walletPrompt = await window.getCharacterWalletPromptForChat(chat.id);
        if (walletPrompt) {
          systemPrompt += '\n\n' + walletPrompt;
        }
      }

      const messagesForApi = historySlice.map(msg => ({
        role: msg.role,
        content: String(msg.content)
      }));

      messagesForApi.push({
        role: 'user',
        content: `[系统指令：用户按下了"推进"按钮，现在轮到你主动行动了，请继续对话。]`
      });

      let isGemini = proxyUrl === GEMINI_API_URL;
      let geminiConfig = toGeminiRequestData(model, apiKey, systemPrompt, messagesForApi);

      let reqBody = {
            model: model,
            messages: [{
              role: 'system',
              content: systemPrompt
            }, ...messagesForApi],
            temperature: state.globalSettings.apiTemperature || 0.8,
            ...(state.globalSettings.apiTopPEnabled && state.globalSettings.apiTopP !== undefined ? { top_p: state.globalSettings.apiTopP } : {}),
            ...(state.globalSettings.apiMaxTokensEnabled && state.globalSettings.apiMaxTokens !== undefined ? { max_tokens: state.globalSettings.apiMaxTokens } : {}),
            ...(state.globalSettings.apiPresencePenaltyEnabled && state.globalSettings.apiPresencePenalty !== undefined ? { presence_penalty: state.globalSettings.apiPresencePenalty } : {}),
            ...(state.globalSettings.apiFrequencyPenaltyEnabled && state.globalSettings.apiFrequencyPenalty !== undefined ? { frequency_penalty: state.globalSettings.apiFrequencyPenalty } : {})
      };
      const response = isGemini ?
        await fetch(geminiConfig.url, geminiConfig.data) :
        await fetch(`${proxyUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
          },
          body: JSON.stringify(reqBody)
        });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(`API 请求失败: ${errorData.error.message}`);
      }

      const data = await response.json();

      const aiResponseContent = getGeminiResponseText(data);

      const messagesArray = parseAiResponse(aiResponseContent);
      const processedActions = [];
      for (const action of messagesArray) {
        if (action.type === 'text' && typeof action.content === 'string' && action.content.includes('\n')) {
          const lines = action.content.split(/\n+/).filter(line => line.trim());
          lines.forEach(line => {
            processedActions.push({
              ...action,
              content: line
            });
          });
        } else {
          processedActions.push(action);
        }
      }

      let messageTimestamp = Date.now();
      for (const msgData of processedActions) {
        const aiMessage = {
          role: 'assistant',
          senderName: chat.originalName,
          timestamp: messageTimestamp++,
          content: msgData.content || msgData.message,
          type: msgData.type || 'text',
        };
        if (msgData.type === 'update_thoughts') {
          if (!chat.isGroup) {
            if (msgData.heartfelt_voice) chat.heartfeltVoice = String(msgData.heartfelt_voice);
            if (msgData.random_jottings) chat.randomJottings = String(msgData.random_jottings);
            
            // 推进时也动态收集自定义心声变量
            if (!chat.customThoughts) {
              chat.customThoughts = {};
            }
            for (const key in msgData) {
              if (key !== 'type' && key !== 'heartfelt_voice' && key !== 'random_jottings') {
                chat.customThoughts[key] = String(msgData[key]);
              }
            }
          }
          continue;
        }
        chat.history.push(aiMessage);
        appendMessage(aiMessage, chat);
        await new Promise(resolve => setTimeout(resolve, Math.random() * 1000 + 800));
      }

      await db.chats.put(chat);
      renderChatList();

    } catch (error) {
      console.error("推进剧情失败:", error);
      await showCustomAlert('操作失败', `无法推进剧情: ${error.message}`);
    } finally {
      setAvatarActingState(chat.id, false);
      if (!chat.isGroup && document.getElementById('chat-header-title')) {
        const titleEl = document.getElementById('chat-header-title');
        titleEl.style.opacity = 0;
        setTimeout(() => {
          titleEl.textContent = chat.name;
          titleEl.classList.remove('typing-status');
          titleEl.style.opacity = 1;
        }, 200);
      }
    }
  }

  // ========== 全局暴露 ==========
  window.triggerAiResponse = triggerAiResponse;
  window.silentlyUpdateDbUrl = silentlyUpdateDbUrl;
  window.handleRegenerateResponse = handleRegenerateResponse;
  window.handleRegenerateCallResponse = handleRegenerateCallResponse;
  window.handlePropelAction = handlePropelAction;
