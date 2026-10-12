# 事实/计划层（Current Facts + Active Events）接线改造方案

> 目标：让「当前有效的事实」和「还没结束的约定/计划」成为**每轮无条件注入**的常驻上下文，
> 而不是依赖向量相似度被动召回。
>
> 本文只描述改造方案，未改动任何代码。所有行号对应 2026-09-07 的 `stable` 分支（HEAD `d00b0da`）。

---

## 0. 现状结论（为什么现在完全没效果）

代码里已经存在两层结构，但**四道闸门全关**，属于纯影子运行，连数据库表都还没建出来：

| 闸门 | 位置 | 现状 |
|---|---|---|
| 写入开关 | [server.js:243](memory-server/server.js#L243)、[:253](memory-server/server.js#L253) | env 默认 `'false'`，启动脚本未设置 → 永远 `writes_disabled` |
| 行为标记 | [memory-current-fact-shadow.js:211](memory-server/memory-current-fact-shadow.js#L211)、[memory-active-event-shadow.js:288](memory-server/memory-active-event-shadow.js#L288) | 硬编码 `behaviorChanged: false`、`injectionEnabled: false` |
| 数据状态 | [memory-current-fact-writer.js:105](memory-server/memory-current-fact-writer.js#L105) | 写入即 `shadow_candidate` + `surfaceMode: 'manual_only'`，且无 promote 接口 |
| 注入通道 | [vector-memory.js:1108](vector-memory.js#L1108)、[:1410](vector-memory.js#L1410) | 前端只取 `result.memories`，`serializeForPrompt` 只拼「核心设定 + 回闪记忆」 |

实机核对：`memory-server/memory.db`（3554 条记忆）中 **不存在** `memory_active_events`、`memory_current_facts` 两张表，
`memory_search_logs` 为 0 行且没有 shadow 相关列 → 该库从未被这套新代码打开过。

**根因**：计划类内容其实已经被存成普通记忆条目（[vector-memory.js:1506](vector-memory.js#L1506) 的提取提示词明确要求记录「承诺」），
但召回是「内容相似」而非「仍然待办」，所以不会被唤醒；本可兜底的事件层则一条数据都没有、也没有出口。

---

## 部署拓扑与发布流程（必读）

改动会落到两个不同的地方，必须分别发布：

| 组件 | 实际位置 | 发布方式 |
|---|---|---|
| memory-server | VPS，域名 `https://mcp.htw1.uk`（带 Bearer 鉴权） | 待定，见 [check-vps-state.sh](memory-server/deploy/check-vps-state.sh) 自查结果 |
| 前端（`vector-memory.js` 等） | GitHub Pages：`https://hetian97.github.io/2222/` | 推送到 **`stable`** 分支，Pages 自动重建 |

> 依据：`GET https://mcp.htw1.uk/health` 返回 `401 {"ok":false,"error":"Unauthorized"}`（memory-server 自己的 JSON 格式与鉴权闸门，[server.js:3404](memory-server/server.js#L3404)）；
> Pages 上的 `memory-server/package.json` 已包含 `test-active-events.js`/`test-current-facts.js`（8/29、9/7 才加入），说明 **Pages 构建自 `stable`，不是旧的 `main`**。

**三个容易踩的发布细节：**

1. **推到功能分支不会更新手机**。Pages 只服务 `stable`，`feat/*` 分支上的前端改动手机上看不到。想先在手机上试，有两条路：
   - 用 Tailscale 跑本地前端（[start-2222-tailscale.bat](start-2222-tailscale.bat) 的 8000 端口），手机里填的外部 memory-server 仍是 `https://mcp.htw1.uk`；
   - 或者直接把功能分支合并进 `stable` 再测（回滚靠 revert）。
2. **必须同步 bump Service Worker 缓存**：[sw.js:5](sw.js#L5) 当前 `CACHE_VERSION = 'v0.0.72'`。改了前端 JS 却不改版本号，手机很可能继续吃旧缓存，表现为「代码改了但没生效」。
3. **VPS 上的环境变量必须在 VPS 上设**。本地 [start-2222-tailscale.bat](start-2222-tailscale.bat) 只影响本地跑的那份 —— 这是下面 A1 的重点，也是原方案写错的地方。

---

## 1. 分层改造路线

| 阶段 | 内容 | 预期效果 | 工作量 |
|---|---|---|---|
| **A** | 打开写入 + 服务端聚合 + 前端注入 | 计划/事实真正进入提示词 | 1~2 小时 |
| **B** | 过期归档、promote 接口、管理面板、群聊放开 | 长期稳定、不出错、可人工修 | 半天 |
| **C** | LLM 抽取替代正则、与记忆条目去重 | 抽取覆盖率与准确性 | 1 天+ |

建议按 A → 手测一周 → B → C 推进，每阶段可独立回滚。

---

## 2. A 阶段：最小可用接线

### A1. 打开写入并建表（改的是 VPS，不是本地脚本）

**⚠️ 千万不要只改本地 [start-2222-tailscale.bat](start-2222-tailscale.bat)** —— 线上跑在 VPS 上，本地那份改了不会有任何效果（原方案在这里写错了）。

按 [check-vps-state.sh](memory-server/deploy/check-vps-state.sh) 第 3/9 节的结论二选一：

- **systemd 服务**：在 unit 的 `[Service]` 段加两行，或写进它的 `EnvironmentFile`，然后重载重启：
  ```ini
  Environment=MEMORY_ACTIVE_EVENT_WRITES_ENABLED=true
  Environment=MEMORY_CURRENT_FACT_WRITES_ENABLED=true
  ```
  ```bash
  systemctl daemon-reload && systemctl restart <unit 名>
  ```
- **手动启动（nohup / tmux）**：先杀掉旧进程，再带变量重启：
  ```bash
  cd <VPS 上的 memory-server 目录>
  MEMORY_ACTIVE_EVENT_WRITES_ENABLED=true MEMORY_CURRENT_FACT_WRITES_ENABLED=true \
    nohup node server.js > memory-server.log 2>&1 &
  ```
- 备选：直接改 [server.js:244](memory-server/server.js#L244)/[:254](memory-server/server.js#L254) 的默认值为 `'true'`，不受启动方式影响，但语义更隐晦。
- 只有本地/Tailscale 调试那份才改 [start-2222-tailscale.bat](start-2222-tailscale.bat)；Windows `set VAR=value&&` 里 `&` 前**不能有空格**。

⚠️ **先确认 VPS 上真正在用的库**：未必是代码目录下的 `memory.db`（[db.js:16](memory-server/db.js#L16) 支持 `MEMORY_DB_PATH`）。自查脚本第 8/10 节会打印实际路径与行数，以那个为准。

- 重启后 `db.js` 会自动建表并补列（`CREATE TABLE IF NOT EXISTS` + [ensureColumn db.js:365](memory-server/db.js#L365)）。
- **动手前先备份**：已有 `POST /memory/backup`（[server.js:4742](memory-server/server.js#L4742)），会同时写 `memory.backup.db` 与带时间戳的备份。

**验收**（在电脑上，带上 Bearer token）：
```bash
curl -H "Authorization: Bearer <token>" "https://mcp.htw1.uk/memory/current-facts?includeInactive=true&limit=5"
```
应返回 `mode: 'shadow'` 且 `writesEnabled: true`（[server.js:3823](memory-server/server.js#L3823)）。

### A2. 服务端聚合「有效事实 + 有效计划」

**新增 db.js 函数** `listActivePlanContext({ chatId, now, eventLimit, factLimit })`：

- **事件**：复用 `listMemoryActiveEvents({ chatId, limit: 50 })`（[db.js:2356](memory-server/db.js#L2356)），
  它默认已排除 `completed/cancelled/expired/archived`（[db.js:2366](memory-server/db.js#L2366)），
  再在 JS 里过滤 `!validUntil || validUntil >= now`，按 `COALESCE(startAt, validUntil)` 升序取前 8 条。
- **事实**：`listMemoryCurrentFacts({ chatId })`（[db.js:2242](memory-server/db.js#L2242)），
  同一 `slotKey` 只保留 `effectiveAt` 最新的一条（与 [memory-current-fact-shadow.js:75](memory-server/memory-current-fact-shadow.js#L75) 的 `findCurrentFact` 逻辑一致），取前 8 条。
- 返回结构化对象，**只暴露注入所需字段**，避免把 `evidence` 等内部审计数据带进提示词：

```js
{
  generatedAt, chatId,
  events: [{ id, title, summary, status, startAt, endAt, validUntil }],
  facts:  [{ id, slotKey, factType, value, statement, status, confidence, effectiveAt }]
}
```

**server.js 改动**：

- 新增开关 `planInjectionEnabled()`（env `MEMORY_PLAN_INJECTION_ENABLED`，默认 `'false'`），
  与现有 shadow 开关风格一致（[server.js:243](memory-server/server.js#L243)）。
- 在 `/memory/search` 的 `responsePayload`（[server.js:4687](memory-server/server.js#L4687)）加 `activePlanContext` 字段。
- 同步传进 `updateLastMemorySearchState`（[server.js:4709](memory-server/server.js#L4709)），便于事后从 `memory_search_logs` 回查「当时注入了什么」。
- 开关关闭时字段为 `null`（而非空数组），方便前端区分「服务端未启用」与「当前确实没有计划」。

> 鉴权无需额外处理：请求处理入口已全局校验 Bearer token（[server.js:3404](memory-server/server.js#L3404)，token 文件 `.memory-api-token`）。

**关于 current facts 只能停在 `shadow_candidate`** —— 必须做一次取舍：

| 方式 | 做法 | 评价 |
|---|---|---|
| 方式 1（推荐） | 注入时接受 `shadow_candidate`，但每 slot 只取最新一条且要求 `confidence >= 0.85` | 零额外改动，风险可控 |
| 方式 2 | 写入时直接置 `current`：新增 `POST /memory/current-facts/promote`（仿 [server.js:3852](memory-server/server.js#L3852) 的 confirm 模式），复用已写好的 `promoteMemoryCurrentFact`（[db.js:2310](memory-server/db.js#L2310)） | 语义更正确，但要同时改 [db.js:2304](memory-server/db.js#L2304) 硬编码的 `surfaceMode: 'manual_only'` |

### A3. 前端注入（vector-memory.js，两处改动）

**(1) 透传字段** —— 在 `retrieveRelevantFromExternalServer` 里，像 `_searchTraceId` 那样挂载（[vector-memory.js:1147](vector-memory.js#L1147)）：

```js
memories._activePlanContext = result.activePlanContext || null;
```

⚠️ **必须同时改零召回早返回分支**（[vector-memory.js:1119-1123](vector-memory.js#L1119)）。
该分支现在直接 `return emptyMemories`，若不挂载，「这轮没有任何记忆被召回」时计划段会整段丢失——
而这恰恰是待办最需要出现的场景。

**(2) 新增注入段落** —— 在「回闪记忆」块结束之后（[vector-memory.js:1460](vector-memory.js#L1460)）追加：

```
## 仍然生效的事实与待办
> 以下内容由系统维护，与你是否记得无关；已完成、已取消、已过期的条目不在其中。
> 不要把它们当成刚发生的事，它们描述的是「当前状态」和「还没发生的事」。
- [事实｜居住地] 我目前住在杭州（自 2026-09-07）
- [待办｜2026-09-08] 明天去医院复诊（状态：planned）
```

- 时间用 `window.TimeZoneUtils.format(ts, tz)`，与 [vector-memory.js:1450](vector-memory.js#L1450) 保持一致。
- 段落只在 `_activePlanContext` 非空且含条目时输出，避免空段污染提示词。
- **入口唯一**：向量模式下所有调用（[ai-response.js:4750](modules/ai-response.js#L4750)、[:8803](modules/ai-response.js#L8803)、[ai-group.js:1736](modules/ai-group.js#L1736) 等）都汇聚到 `serializeForPrompt`，改一处即可全端生效。

**(3) 设置项** —— 新增 `planContextEnabled`（默认 `true`）：

- 默认值加在 [vector-memory.js:39](vector-memory.js#L39) 的 settings 块；老数据补默认值写在 [:75](vector-memory.js#L75) 附近的 `undefined` 兜底区。
- toggle 加在「使用外部 memory-server」开关附近（[vector-memory.js:2396](vector-memory.js#L2396)），id 建议 `vm-plan-context-enabled`。
- 保存逻辑加在 [vector-memory.js:2490](vector-memory.js#L2490) 附近，与 `externalMemoryEndpoint` 同一处。

---

## 3. B 阶段：可靠性与可控性

- **B1 过期归档**：新增 `expireMemoryActiveEvents(now, graceMs)`，
  把 `status IN ('candidate','planned','active') AND validUntil < now - grace` 置为 `expired` 并写 `archivedAt`（字段已在 [db.js:2396](memory-server/db.js#L2396) 支持）。
  在 `/memory/search` 里惰性调用（例如距上次执行超过 10 分钟才跑一次），
  否则「去年的计划」会永久常驻提示词。注意 `validUntil` 已自带 +2 天缓冲（[memory-active-event-writer.js:206](memory-server/memory-active-event-writer.js#L206)）。
- **B2 管理与人工修正**：读接口已就绪（`GET /memory/active-events` [server.js:3797](memory-server/server.js#L3797)、`GET /memory/current-facts`），
  只需补 promote / invalidate 写接口，并在变量记忆设置页加一个「事实与计划」面板（可参照现有列表渲染风格）。
- **B3 群聊与角色侧**：目前 `privateMemoryEligible` 仅对私聊为真，群聊提取被显式排除（[memory-active-event-shadow.js:277](memory-server/memory-active-event-shadow.js#L277)）。
  若希望「角色记得和用户约了下周见面」，需要放开 sourceScope —— `mountedChatId` 字段已在采集（[memory-active-event-shadow.js:80](memory-server/memory-active-event-shadow.js#L80)），具备条件。

---

## 4. C 阶段：抽取质量

- **C1 抽取升级**：现有抽取是纯正则，且 `create_candidate` 强制要求跨天时间字面证据（[memory-active-event-writer.js:289](memory-server/memory-active-event-writer.js#L289)）。
  「我周三要交论文」这类没有「下周/明天」字面词的表达会直接漏掉。
  建议在回复生成成功后复用一次小模型抽取（可沿用 [vector-memory.js:1480](vector-memory.js#L1480) 的 prompt 组织方式），输出 event/fact JSON 再走同一写入门槛。
- **C2 去重**：记忆提取提示词要求记录「承诺」（[vector-memory.js:1506](vector-memory.js#L1506)），
  同一件事会同时是记忆条目与事件条目。建议注入时以事件层为准，或让记忆提取跳过计划类内容。
  否则 AI 会同时看到「待办：明天复诊」和「记忆：她说明天要复诊」，时间语气容易打架。
- **C3 冲突消解**：同一 slot 多来源冲突时按 `effectiveAt` 取最新，现有 `findCurrentFact` 已实现该策略，聚合时沿用即可。

---

## 5. 测试与验收

- **服务端**：仿 [test-current-facts.js](memory-server/test-current-facts.js) / [test-active-events.js](memory-server/test-active-events.js)
  （临时目录 + `MEMORY_DB_PATH`）新增 `test-plan-context.js`，断言「影子 → 写入 → 聚合 → 响应字段」整链。
- **前端**：仿 [test-vector-memory-ui.js](memory-server/test-vector-memory-ui.js) 的伪 DOM 模式，
  **必须补一条「零召回时仍携带 activePlanContext」的用例**（对应 A3 的坑）。
- **端到端手测**：
  1. 说「我明天要去医院复诊」→ `GET /memory/active-events?chatId=...` 应出现 `planned` 条目；
  2. 隔天聊一句完全无关的话 → 提示词里应出现「待办」段；
  3. 说「我回来了」→ 条目转 `completed`，且**不再**出现在注入段。
- **回归**：`npm test`（[memory-server/package.json](memory-server/package.json) 的 12 个测试）须全绿。

---

## 6. 回滚与风险

**回滚**：A1 改回 env `false`；A2 字段对老客户端无影响；A3 关掉设置项即恢复原状。
新增表/列不影响老代码（`IF NOT EXISTS` + `ensureColumn`）。

| 风险 | 影响 | 对策 |
|---|---|---|
| 计划条目常驻不消失 | 提示词长期被过期项污染 | B1 过期归档 |
| 正则误抽 | AI 说出没发生过的事 | 注入按 confidence 阈值 + 上限 8 条；预留 `MEMORY_PLAN_INJECTION_MAX_ITEMS` |
| 每轮 token 增加 | 成本上升 | 段落限条数（100~300 字量级），可按需裁剪 summary |
| 只对私聊生效 | 群聊里以为「没生效」 | A 阶段先用私聊验收，群聊留到 B3 |
| 与普通记忆条目重复 | 时间语气冲突 | C2 去重 |

---

## 7. 建议的最小落地顺序

0. 在 VPS 上跑 [check-vps-state.sh](memory-server/deploy/check-vps-state.sh)（**只读，不改任何东西**），把部署方式、代码版本、两个写入开关、数据库真实路径一次查清 → 以此决定 A1 的具体写法。
1. A1 打开写入 → 重启 VPS 上的 memory-server → 用两三轮对话确认库里出现数据（先只看，不注入）。
2. A2 + A3 一起上：VPS 更新 memory-server 代码；前端合并进 `stable` 并 **bump [sw.js](sw.js#L5) 的 `CACHE_VERSION`** → 手机刷新 → 按第 5 节三步手测。
3. 观察一周：计划是否只在「该出现的时候」出现、完成/取消是否被正确捕获。
4. 视情况决定 B1（强烈建议）与 C1/C2。

---

## 8. 决策记录（2026-10-12 已拍板）

| 议题 | 决定 |
|---|---|
| 过期策略 | **选 A：归档 + 一键清理**。过期只标 `expired`（保留可回溯），管理面板提供「清理过期项」按钮做物理删除 |
| v1 注入范围 | **只注入计划**（active events）。事实层暂不注入，等正则 + TTL 稳定后再开 |
| 身体状态 | 仍然**写入**事实层（`current_body_state`，13 个锚点），但 v1 **不注入** |
| 删表安全性 | 已核实：`memory_active_events` 无任何外键，`memory_current_facts` 只自引用，Chroma 只索引 `memories` → **删计划/事实不可能影响 5180 条记忆与向量索引** |
| VPS 部署方式 | 文件上传（`/root/memory-server` **不是** git 仓库），不是 git pull |
| systemd | 暂缓，见第 11 节；先把主链路验证完再动 |

---

## 9. 征询句的两轮确认（设计定稿）

**问题**：`这周五是中秋节，我们最近要不要去看看奶奶` / `明天不是都要开始体能训练了吗` —— 是不是有效计划**取决于 char 的回答**。
现在抽取器只看 user 的文本（这是对的：char 每轮 100-400 字，用它抽新条目会把噪音放大一个数量级）。疑问/假设只扣 0.12 分而不排除，结果是把反问句也建成了 `planned`。

**方案：char 的回答只参与「确认/否决」，绝不参与「新建」。**

1. user 说征询句（要不要/好吗/行不行/是不是/哪天…）**且带跨天时间词** → 建 `candidate` + `awaitingConfirmation = 1` + `confirmDeadline = 现在 + 24h`（不直接建 `planned`）。
2. 下一轮检索时，前端把 **char 上一条回复**塞进 `activeEventSource.latestAssistantText`。
3. **只从中文字符串引号内取文本**（`“…”`、`「…」`、`『…』`、`"…"`）：环境描写、动作神态一律忽略。这条对计划层尤其重要——**计划只会出现在对话里**。
   - 引号内**没有**信号时：默认**不放行**（保守）。宁可不记，也不要记错。
   - 待观察项：角色扮演里「他笑着点了点头」这种**引号外的接受**很常见。若实测漏得多，再考虑加一条受限兜底（仅接受 点头/答应/好 这类强信号，且周围无否定/反问）。
4. 信号表（只在 char 回复**开头 60 字**内扫描，进一步降噪）：
   - 接受：好 / 行 / 嗯 / 可以 / 没问题 / 那就 / 走吧 / 听你的 / 答应你 / 当然 / 说定了 / 一言为定
   - 拒绝：不 / 算了 / 改天 / 再说 / 太远 / 不行 / 没空 / 不要 / 别
5. user 自己的确认同样算数（user 下一轮说「那就去吧」→ 也判定为接受）。
6. 落地：接受 → `planned`；拒绝 → `cancelled`；超过 `confirmDeadline` 无信号 → `expired`。

**需要新增**：`memory_active_events` 两列（`awaitingConfirmation`、`confirmDeadline`，走现成的 `ensureColumn`）+ 前端多传一个字段 + **一次 VPS 重启**。
**已知代价**：有一轮延迟（user 问完当轮不算数，等 char 答完、user 下一条消息触发检索时才定案）。这符合直觉——还没答应的事本来就不该当成计划。

> 复用价值：`extractQuotedDialogue()` 这个 helper 以后若要放开「char 主动提出的安排」，可直接用来降噪。

---

## 10. 居所清单（解决「char 记不住现在住哪个家」）

**现状**：代码里**没有**针对「多个居所」的任何专门机制，只有两个窄条件：

| 槽位 | 触发 | 覆盖不到的情况 |
|---|---|---|
| `user.residence.current` | (住在/住到了/搬到/搬回/定居在/长期住在) **且** 有当前时间词 | 「我现在在老宅」「这周住临空那边」——**没有"住"字就抓不到** |
| `user.location.current` | `我(现在/已经/刚)(在/到了/回到)X` | 能抓到「我在老宅」，但只当**位置**，不当**居所** |

「我有三个居所 + 一个临时落脚点」属于**用户的世界知识**，正则再怎么写也猜不到「云端湖 / 天行 / 临空」是家。所以：

**方案**：管理面板里加一份「居所 / 常驻地点」清单（用户自己填名字与别名），抽取器命中清单中的名字时直接建/更新 `user.residence.current`（置信度 0.9），注入时优先展示。

**任务进行到哪**：目前确实有在记，但很稀疏——7 条事实里只有 1 条 `user.task.论文`；体能训练、答辩等则以**计划事件**形式存在。而且**没有进度维度**：整句话被存成 `value`，没有「论文改到第几章」这种结构化表达。要更可靠，可参照居所清单的思路，让用户维护「长期任务清单」。

---

## 11. 运维加固：把 memory-server 交给 systemd（可选，含回滚）

**先分清两种故障模式**（原文表述容易混淆）：

| 故障 | 症状 | 后果 |
|---|---|---|
| ① 进程没起来 | 手机端**整个记忆功能不可用**（召回为空/报错） | 明显，容易发现 |
| ② 进程起来了但漏了 `*_WRITES_ENABLED` | **召回一切正常**，事实/计划层静默停写 | 隐蔽，几周都不会发现 |

现状：`8606 → npm start → sh -c node server.js → node server.js`，**不在 systemd 里**，4 个环境变量也不在 `.bashrc`/`.profile`/`/etc/profile`/`/etc/environment` 里（启动时临时给的）。

⚠️ **数据本身不会丢**：5180 条记忆在磁盘上的 `memory.db` 文件里，进程重启不影响数据。所谓「不会自己回来」指的是**进程**，不是数据。

**systemd 是什么**：Linux 的服务管理器。把一个 `.service` 文件放进 `/etc/systemd/system/`，它就能开机自启、崩溃自动拉起、`systemctl status` 看状态、环境变量写在 unit 里永不遗漏。VPS 上另外三个服务（`aisay-wake`、`ephone-health-mcp`、`notion-mcp`）就是这么跑的。

参考 unit（**切换前先 `which node` 确认 ExecStart 路径**）：

```ini
[Unit]
Description=EPhone memory-server
After=network.target

[Service]
Type=simple
WorkingDirectory=/root/memory-server
Environment=MEMORY_ORGANIZATION_INCREMENTAL_ENABLED=true
Environment=MEMORY_RECALL_GATE_ENABLED=false
Environment=MEMORY_ACTIVE_EVENT_WRITES_ENABLED=true
Environment=MEMORY_CURRENT_FACT_WRITES_ENABLED=true
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

**切换步骤（必须先备份）**：

```bash
cd /root/memory-server
sqlite3 memory.db ".backup '/root/memory-before-systemd.db'"      # WAL 库的正确备份方式
sqlite3 memory.db "select count(*) from memories;"                # 记下这个数字
which node                                                       # 填进 ExecStart
# 写好 unit 后：
systemctl daemon-reload
pkill -f 'node server\.js'                                       # 释放 8765 端口，几秒中断
systemctl enable --now ephone-memory
systemctl status ephone-memory --no-pager
sqlite3 memory.db "select count(*) from memories;"                # 必须与上面一致
tr '\0' '\n' < /proc/$(pgrep -f 'node server\.js')/environ | grep -E '^MEMORY_'
```

**回滚**：

```bash
systemctl disable --now ephone-memory
bash /root/memory-server/start-memory-server.sh
```

**路径风险很低**：`db.js` 用的是 `__dirname`（脚本所在目录）而不是当前工作目录，所以只要 `ExecStart` 指向 `/root/memory-server/server.js`，数据库路径就一定是 `/root/memory-server/memory.db`，不会凭空新建空库。仍然建议切换后立刻核对上面的行数。

---

## 12. 管理面板（已实现，2026-10-12）

「变量记忆」面板现在有第三个标签：**单条记忆 / 记忆簇预览 / 计划与事实**。
新增的这个只读写 `memory_active_events` 与 `memory_current_facts`，**与 memories 表和 Chroma 向量没有任何关系**
（表结构层面已确认无外键，Chroma 只索引 memories），所以这里的增删改都不会影响向量记忆。

**现在就能用（不需要动 VPS）**
- 列出**生效中的计划**（未过期、未完成），另有折叠的「已完成 / 已过期」历史区
- 计划：编辑（标题 / 开始时间 / 有效至）、标记完成、删除（归档）
  —— 走的是既有接口 `POST /memory/active-events/upsert`、`POST /memory/active-events/archive`
- 列出**事实**：同一 `slotKey` 只显示最新一条，历史版本折叠

**需要下次 VPS 更新后才生效（服务端代码已写好，前端会自动识别 404 并明确提示）**

| 新接口 | 用途 |
|---|---|
| `POST /memory/active-events/delete` | 物理删除单条计划 |
| `POST /memory/active-events/purge-finished` | 「清理已结束」按钮：批量删除完成/取消/过期/归档 |
| `POST /memory/current-facts/upsert` | 编辑事实 |
| `POST /memory/current-facts/invalidate` | 删除事实 |
| `POST /memory/current-facts/promote` | 设为当前 |

前端在旧服务端上点击这些操作时，会提示「需要 memory-server 更新后才支持」，**不会静默失败**。

> 注意：面板是前端功能，要在手机上看到必须先让前端更新（合并进 `stable` 或切换 Pages 发布分支）。
> 按用户的决定，这些改动攒到一次合并。

### ⚠️ 前端 JS 的缓存铁律（2026-10-12 踩过的坑）

Service Worker 对 JS/CSS 用的是**「缓存优先 + 后台更新」**（[sw.js:148](sw.js#L148)），HTML 才是网络优先。
所以**只要改了前端 JS，必须同时做两件事**，否则手机上第一次打开一定是旧脚本：

1. `sw.js` 的 `CACHE_VERSION` 加一（让新 SW 安装时清掉旧缓存）
2. `index.html` 里该文件的 `?v=` 参数加一（**URL 变了才会缓存未命中，第一次打开就是新版**）

历史上 `vector-memory.js?v=0.0.56` 长期没更新，导致「代码明明推上去了、手机上界面没变」。
另外 `force-update.js` 的 `FILES_TO_UPDATE` 里**缺少 `vector-memory.js`**，那个「强制更新」功能也刷不到它。
