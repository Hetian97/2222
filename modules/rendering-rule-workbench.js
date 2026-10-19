(function () {
  'use strict';
  const engine = window.RenderingRuleEngine;
  const $ = id => document.getElementById(id);
  const esc = engine.escapeHtml;
  const clone = value => JSON.parse(JSON.stringify(value));
  const actionNames = { replace: '固定 / 模板替换', delete: '删除匹配内容', random: '随机替换', map: '对照替换', format: '格式整理', prefix: '前面添加', suffix: '后面添加', wrap: '前后添加', highlight: '文字高亮', badge: '状态标签', note: '提示框', fold: '折叠区', quote: '引用块', card: '键值卡片', table: '简单表格', mask: '遮罩', extract: '提取内容', html: 'HTML 展示模板', exclude: '排除整条消息' };
  const matchNames = { regex: '正则表达式', text: '普通文字', keywords: '多个关键词', word: '整词匹配', line: '包含文字的整行', markers: '起止标记' };
  let loaded = null, optionsDirty = false, metadataDirty = false;
  let list = [], undo = [], pendingSnapshot = null, previewTimer, previewSequence = 0, previewNonce = 0;
  let paused = false;
  try { paused = localStorage.getItem('ephone-rendering-rules-paused') === 'true'; } catch (_) {}

  const select = (id, label, values) => `<label class="rr-field">${label}<select id="rr-${id}">${Object.entries(values).map(([value, text]) => `<option value="${value}">${text}</option>`).join('')}</select></label>`;
  const input = (id, label, type = 'text', placeholder = '') => `<label class="rr-field">${label}<input id="rr-${id}" type="${type}" placeholder="${esc(placeholder)}"></label>`;
  const area = (id, label, placeholder = '') => `<label class="rr-field">${label}<textarea id="rr-${id}" rows="3" placeholder="${esc(placeholder)}"></textarea></label>`;
  const check = (id, label) => `<label class="rr-check"><input id="rr-${id}" type="checkbox"><span>${label}</span></label>`;
  const help = text => `<p class="rr-help">${text}</p>`;
  const detail = (title, body, open = false) => `<details class="rr-section"${open ? ' open' : ''}><summary>${title}</summary><div class="rr-section-body">${body}</div></details>`;

  function init() {
    const modal = $('rule-editor-modal');
    const screen = $('rendering-rules-screen');
    if (!modal || !screen) return;
    const toolbar = document.createElement('div');
    toolbar.className = 'rr-toolbar'; toolbar.id = 'rr-toolbar';
    toolbar.innerHTML = `<div class="rr-search-row"><input id="rr-search" aria-label="搜索规则" placeholder="搜索名称、标签、查找内容"><button type="button" class="settings-mini-btn" id="rr-pause">${paused ? '恢复规则' : '暂时停用'}</button></div>${detail('筛选与管理', `<div class="rr-grid">${select('group-filter', '规则组', { '': '全部规则组' })}${select('state-filter', '状态', { '': '全部状态', enabled: '已启用', disabled: '已停用' })}</div><div class="rr-buttons"><button type="button" class="settings-mini-btn" id="rr-undo">撤销最近修改</button><button type="button" class="settings-mini-btn" id="rr-export-tests">导出测试样本</button></div>${help('长按规则可批量管理。规则上的顺序按钮与拖动手柄用于调整执行顺序。')}<div class="rr-grid">${select('bulk-operation', '已选规则', { enable: '启用', disable: '停用', group: '设置规则组', scope: '追加绑定范围' })}${input('bulk-value', '规则组 / 聊天 ID', 'text', '范围填写 global 或聊天 ID')}</div><button type="button" class="settings-mini-btn" id="rr-bulk-apply">应用到已选规则</button>`)}<p id="rr-list-status" class="rr-help" role="status"></p>`;
    screen.insertBefore(toolbar, $('rules-tabs'));

    const advanced = document.createElement('div');
    advanced.id = 'rr-editor-tools';
    advanced.innerHTML = `${help('留空可删除；普通文字可固定替换；随机示例：{{random::晴朗::多云::小雨}}。原始聊天记录保留。')}
      <div class="rr-grid">${select('match-mode', '匹配方式', matchNames)}${select('action', '处理动作', actionNames)}</div>
      <div class="rr-when" data-match="markers"><div class="rr-grid">${input('start-marker', '起始标记')}${input('end-marker', '结束标记')}</div>${help('标记之间的内容保存在 $1 中；查找框在此方式下不参与匹配。')}</div>
      <div class="rr-when" data-action="random">${area('candidates', '候选项，每行一项', '晴朗\n多云\n[2] 小雨')}${help('可用 [数字] 设置权重；空行是删除选项。随机允许碰巧重复。')}${select('selection', '候选选择', { independent: '每处独立选择', message: '同一消息共用选择', 'no-repeat': '消息内避免连续重复', cycle: '消息内轮流使用' })}</div>
      <div class="rr-when" data-action="map">${area('mapping', '对照表，每行一项', '待处理 → 处理中\n未填写 → 暂无信息')}${help('使用 → 或 => 分隔；目标留空表示删除；长词优先，一次替换。')}</div>
      <div class="rr-when" data-action="wrap">${input('suffix', '末尾添加内容')}${help('前面添加的内容使用原有替换框。')}</div>
      <div class="rr-when" data-action="highlight badge note fold quote card table mask html">${input('title', '折叠标题', 'text', '查看内容')}<div class="rr-grid">${input('color', '强调色', 'text', '#007aff')}${input('font-size', '展示字号（10～20）', 'number')}</div>${input('radius', '展示圆角（0～20）', 'number')}${help('内置组件自动处理捕获文字；HTML 模板支持 $1、$2，新增模板使用安全展示范围。')}</div>
      <div class="rr-when" data-action="mask">${input('mask-text', '遮罩文字', 'text', '•••')}${check('reveal', '允许点击查看原文')}</div>
      <div class="rr-when" data-action="format">${detail('格式整理项目', `<div class="rr-check-grid">${check('fmt-trim', '去掉首尾空白')}${check('fmt-spaces', '合并连续空格')}${check('fmt-trailingSpace', '清理行尾空格')}${check('fmt-blankLines', '最多保留一个空行')}${check('fmt-newlines', '统一换行')}${check('fmt-duplicateLines', '删除重复非空行')}${check('fmt-invisible', '清理零宽字符')}</div>${select('punctuation', '标点形式', { '': '保持原样', full: '转为全角', half: '转为半角' })}<div class="rr-grid">${input('indent', '每段缩进')}${input('list-prefix', '列表前缀')}</div>`, true)}</div>
      ${detail('匹配与保护', `<div class="rr-grid">${input('flags', '正则标志', 'text', 'g / gi / gms')}${input('max-matches', '最多处理次数', 'number', '留空处理全部')}</div><div class="rr-check-grid">${check('first-only', '只处理首次匹配')}${check('protect-code', '保护代码块与行内代码')}${check('protect-links', '保护链接地址')}${check('protect-html', '保护 HTML 标签属性')}</div><div class="rr-grid">${input('protect-start', '保护区域起始标记')}${input('protect-end', '保护区域结束标记')}</div>${select('region', '文字区域', { all: '全文', dialogue: '引号内的对话', description: '引号外的描写' })}${select('random-mode', '随机结果', { stable: '同一消息保持结果', reroll: '重新显示时重抽' })}${help('g 处理全部匹配，i 忽略大小写，m 按行匹配，s 允许点号跨行。random 的候选语法兼容，默认结果随消息固定；pick 始终保持结果。')}`)}
      ${detail('范围、阶段与条件', `<div class="rr-grid">${select('role', '消息来源', { '': '全部来源', user: '用户', assistant: '角色', system: '系统' })}${select('type', '内容类型', { '': '全部类型', text: '普通消息', offline_text: '线下文本', thoughts: '心声 / 散记' })}${select('field', '文本字段', { '': '全部字段', content: '正文', heartfeltVoice: '心声', randomJottings: '散记', custom: '自定义心声' })}${select('chat-kind', '聊天类型', { '': '全部聊天', single: '单聊', group: '群聊' })}</div>${input('after', '仅处理此时间之后的消息', 'datetime-local')}<div class="rr-check-grid">${check('stage-display', '显示时处理')}${check('stage-context', '发送给 AI 前处理')}${check('stage-copy', '复制时处理')}${check('stage-export', '文本导出时处理')}</div>${help('未开启的阶段保持原来的行为。完整 JSON 备份始终保留原文。上下文删除开关仍独立保留，并优先执行删除片段。')}<div class="rr-grid">${input('condition-contains', '原文必须包含')}${input('condition-excludes', '原文不能包含')}${input('min-length', '原文最小长度', 'number')}</div>${check('use-else', '条件不满足时使用替代模板')}${area('else-template', '条件不满足时的替代模板')}`)}
      ${detail('规则信息与执行', `<div class="rr-grid">${input('group', '规则组')}${input('tags', '标签，用逗号分隔')}${input('order', '执行顺序', 'number')}${select('stop', '命中后', { '': '继续执行', group: '停止当前规则组', stage: '停止当前处理阶段' })}</div>${area('description', '规则说明')}${input('author', '作者署名')}${input('source-url', '来源链接', 'url')}${input('license', '使用许可')}${help('导入、复制与导出会保留来源信息。系统不将外部规则设为默认示例。')}`)}
      ${detail('辅助编辑', `${area('macro-candidates', '插入随机表达式，每行一个候选项', '晴朗\n多云\n小雨')}<div class="rr-buttons"><button type="button" class="settings-mini-btn" id="rr-insert-random">插入随机表达式</button><button type="button" class="settings-mini-btn" id="rr-toggle-json">高级配置</button></div><div id="rr-json-wrap" hidden>${area('json', '高级配置 JSON（保留无法表单化的字段）')}<button type="button" class="settings-mini-btn" id="rr-apply-json">应用配置到表单</button></div>`)}
      ${detail('测试与预览', `${area('test-input', '测试原文', '今日天气：晴朗')}<div class="rr-grid">${select('test-role', '测试来源', { assistant: '角色', user: '用户', system: '系统' })}${select('test-type', '测试类型', { text: '普通消息', offline_text: '线下文本', thoughts: '心声 / 散记' })}${select('test-stage', '测试阶段', { display: '显示', context: 'AI 上下文', copy: '复制', export: '文本导出' })}${select('test-target', '测试范围', { current: '当前规则', all: '整个规则链' })}</div>${select('test-chat', '测试聊天', { global: '公用测试' })}<div class="rr-buttons"><button type="button" class="settings-mini-btn" id="rr-test">测试</button><button type="button" class="settings-mini-btn" id="rr-reroll">再抽一次</button></div><p id="rr-test-status" class="rr-help" role="status"></p><div id="rr-test-match" class="rr-test-output" aria-label="匹配位置"></div><div id="rr-test-output" class="rr-test-output" aria-label="处理结果"></div><pre id="rr-test-trace" class="rr-test-trace"></pre><div class="rr-buttons"><button type="button" class="settings-mini-btn" id="rr-save-sample">保存测试样本</button><button type="button" class="settings-mini-btn" id="rr-test-samples">运行样本</button></div>${area('samples', '测试样本 JSON（原文、预期结果与测试环境）', '[{"input":"待处理","expected":"处理中","stage":"display"}]')}`)}
      <p id="rr-editor-status" class="rr-help" role="status"></p>`;
    const body = modal.querySelector('.modal-body');
    const basic = document.createElement('div'); basic.id = 'rr-editor-basic';
    basic.appendChild(advanced.querySelector('.rr-grid'));
    body.insertBefore(basic, body.children[2]);
    advanced.innerHTML = detail('更多功能与测试', advanced.innerHTML);
    body.appendChild(advanced);
    basic.addEventListener('input', event => editorChanged(event));
    basic.addEventListener('change', event => editorChanged(event));
    advanced.addEventListener('input', event => editorChanged(event));
    advanced.addEventListener('change', event => editorChanged(event));
    for (const id of ['rule-regex-input', 'rule-template-input', 'rule-enabled-switch', 'rule-do-not-send-switch']) $(id).addEventListener('input', () => schedulePreview());
    $('rr-test').addEventListener('click', () => test());
    $('rr-reroll').addEventListener('click', () => { previewNonce++; test(); });
    $('rr-insert-random').addEventListener('click', insertRandom);
    $('rr-toggle-json').addEventListener('click', () => { $('rr-json-wrap').hidden = !$('rr-json-wrap').hidden; $('rr-json').value = JSON.stringify(readOptions() || {}, null, 2); });
    $('rr-apply-json').addEventListener('click', () => {
      try {
        const options = JSON.parse($('rr-json').value);
        if (!options || Array.isArray(options) || typeof options !== 'object') throw new Error('配置必须是 JSON 对象');
        loaded = { ...(loaded || {}), options }; fillOptions(options); optionsDirty = true; updateConditional(); schedulePreview();
        $('rr-editor-status').textContent = '配置已载入表单，保存规则后生效。';
      } catch (error) { $('rr-editor-status').textContent = `配置未应用：${error.message}`; }
    });
    $('rr-save-sample').addEventListener('click', () => saveSample());
    $('rr-test-samples').addEventListener('click', () => testSamples());
    $('rr-search').addEventListener('input', filterCards);
    $('rr-group-filter').addEventListener('change', filterCards);
    $('rr-state-filter').addEventListener('change', filterCards);
    $('rr-pause').addEventListener('click', () => {
      paused = !paused;
      try { localStorage.setItem('ephone-rendering-rules-paused', String(paused)); } catch (_) {}
      window.invalidateRenderingRuleCache(); updateList(list);
    });
    $('rr-undo').addEventListener('click', () => undoMutation());
    $('rr-bulk-apply').addEventListener('click', () => bulkApply());
    $('rr-export-tests').addEventListener('click', () => download({ type: 'EPhoneRenderingRuleTests', rules: list.filter(rule => rule.options?.samples?.length).map(rule => ({ name: rule.name, samples: rule.options.samples })) }, 'RenderingRuleTests.json'));
  }

  function editorChanged(event) {
    const id = event.target.id;
    if (['rr-author', 'rr-source-url', 'rr-license', 'rr-description'].includes(id)) metadataDirty = true;
    else if (!id.startsWith('rr-test-') && !['rr-macro-candidates', 'rr-json'].includes(id)) optionsDirty = true;
    if (id === 'rr-action' && event.target.value === 'format' && !loaded?.options?.format) {
      $('rr-fmt-newlines').checked = true; $('rr-fmt-trailingSpace').checked = true; $('rr-fmt-blankLines').checked = true; $('rr-protect-code').checked = true;
    }
    if (id === 'rr-action' || id === 'rr-match-mode') $('rr-editor-tools').querySelector('.rr-section').open = value('action') !== 'replace' || value('match-mode') === 'markers';
    updateConditional(); schedulePreview();
  }

  function schedulePreview() {
    clearTimeout(previewTimer);
    if ($('rr-test-input')?.value) previewTimer = setTimeout(() => test(), 300);
  }

  function updateConditional() {
    const action = $('rr-action').value, match = $('rr-match-mode').value;
    for (const element of $('rr-editor-tools').querySelectorAll('.rr-when')) {
      element.hidden = !!(element.dataset.action && !element.dataset.action.split(' ').includes(action) || element.dataset.match && element.dataset.match !== match);
    }
    const regexLabel = document.querySelector('label[for="rule-regex-input"]');
    regexLabel.textContent = match === 'regex' ? '正则表达式 (使用 g 处理全部匹配)' : match === 'markers' ? '查找内容（起止标记方式无需填写）' : '查找内容';
    $('rr-editor-status').textContent = ['map', 'format'].includes(action) ? '此动作无需填写查找框。替换框及其他旧配置仍保留。' : '';
  }

  const optionFields = { 'match-mode': 'matchMode', action: 'action', flags: 'flags', 'start-marker': 'startMarker', 'end-marker': 'endMarker', candidates: 'candidates', mapping: 'mapping', selection: 'selection', suffix: 'suffix', title: 'title', color: 'color', 'font-size': 'fontSize', radius: 'radius', 'mask-text': 'maskText', reveal: 'reveal', 'first-only': 'firstOnly', 'max-matches': 'maxMatches', 'protect-code': 'protectCode', 'protect-links': 'protectLinks', 'protect-html': 'protectHtml', 'protect-start': 'protectStart', 'protect-end': 'protectEnd', region: 'region', 'random-mode': 'randomMode', 'chat-kind': 'chatKind', group: 'group', order: 'order', stop: 'stop' };
  const defaults = { matchMode: 'regex', action: 'replace', flags: 'g', selection: 'independent', region: 'all', randomMode: 'stable', candidates: '晴朗\n多云\n小雨', fontSize: 14, radius: 6 };
  const formatKeys = ['trim', 'spaces', 'trailingSpace', 'blankLines', 'newlines', 'duplicateLines', 'invisible'];
  function setValue(id, value) { const element = $('rr-' + id); if (!element) return; if (element.type === 'checkbox') element.checked = !!value; else element.value = value ?? ''; }
  function value(id) { const element = $('rr-' + id); return element.type === 'checkbox' ? element.checked : element.value; }

  function fillOptions(options = {}) {
    for (const [id, key] of Object.entries(optionFields)) setValue(id, options[key] ?? defaults[key]);
    for (const key of formatKeys) setValue('fmt-' + key, options.format?.[key]);
    setValue('punctuation', options.format?.punctuation); setValue('indent', options.format?.indent); setValue('list-prefix', options.format?.listPrefix);
    setValue('role', options.roles?.length === 1 ? options.roles[0] : '');
    setValue('type', options.types?.length === 1 ? options.types[0] : '');
    setValue('field', options.fields?.length === 1 ? options.fields[0] : '');
    setValue('after', options.after ? new Date(Number(options.after) - new Date(Number(options.after)).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '');
    for (const stage of ['display', 'context', 'copy', 'export']) setValue('stage-' + stage, (options.stages || ['display']).includes(stage));
    setValue('condition-contains', options.condition?.contains); setValue('condition-excludes', options.condition?.excludes); setValue('min-length', options.condition?.minLength);
    setValue('use-else', options.condition?.useElse); setValue('else-template', options.elseTemplate);
    setValue('tags', (options.tags || []).join(', ')); setValue('samples', JSON.stringify(options.samples || [], null, 2));
  }

  function readOptions() {
    if (!optionsDirty) return loaded?.options ? clone(loaded.options) : undefined;
    const options = { ...(loaded?.options || {}) };
    if (loaded && !loaded.options) options.legacySlashFallback = true;
    for (const [id, key] of Object.entries(optionFields)) {
      const result = value(id);
      if (['fontSize', 'radius', 'maxMatches', 'order'].includes(key)) { if (result !== '') options[key] = Number(result); else delete options[key]; }
      else options[key] = result;
    }
    options.format = { ...(options.format || {}) };
    for (const key of formatKeys) options.format[key] = value('fmt-' + key);
    Object.assign(options.format, { punctuation: value('punctuation'), indent: value('indent'), listPrefix: value('list-prefix') });
    // Preserve multi-value configurations unless the corresponding form selector changes.
    for (const [id, key] of [['role', 'roles'], ['type', 'types'], ['field', 'fields']]) {
      const selected = value(id);
      options[key] = selected ? [selected] : loaded?.options?.[key]?.length > 1 ? [...loaded.options[key]] : [];
    }
    options.after = value('after') ? new Date(value('after')).getTime() : null;
    options.stages = ['display', 'context', 'copy', 'export'].filter(stage => value('stage-' + stage));
    options.condition = { ...(options.condition || {}), contains: value('condition-contains'), excludes: value('condition-excludes'), minLength: Number(value('min-length')) || 0, useElse: value('use-else') };
    options.elseTemplate = value('else-template');
    options.tags = value('tags').split(/[,，]/).map(tag => tag.trim()).filter(Boolean);
    options.samples = JSON.parse(value('samples') || '[]');
    if (!Array.isArray(options.samples)) throw new Error('测试样本必须是 JSON 数组');
    return options;
  }

  function readMetadata() {
    if (!metadataDirty) return {};
    return { author: value('author'), sourceUrl: value('source-url'), license: value('license'), description: value('description') };
  }

  function openEditor(rule) {
    clearTimeout(previewTimer); previewSequence++;
    loaded = rule ? clone(rule) : null; optionsDirty = false; metadataDirty = false; previewNonce = 0;
    fillOptions(rule?.options);
    $('rr-editor-tools').querySelector('.rr-section').open = !!rule?.options && (rule.options.action !== 'replace' && !!rule.options.action || rule.options.matchMode === 'markers');
    for (const [id, key] of [['author', 'author'], ['source-url', 'sourceUrl'], ['license', 'license'], ['description', 'description']]) setValue(id, rule?.[key]);
    setValue('test-input', ''); setValue('macro-candidates', '晴朗\n多云\n小雨');
    for (const id of ['rr-test-status', 'rr-test-output', 'rr-test-trace', 'rr-test-match']) $(id).textContent = '';
    $('rr-json-wrap').hidden = true;
    $('rr-test-chat').innerHTML = `<option value="global">公用测试</option>${Object.values(state.chats || {}).map(chat => `<option value="${esc(chat.id)}">${esc(chat.name)}</option>`).join('')}`;
    if (state.activeChatId && state.chats[state.activeChatId]) $('rr-test-chat').value = state.activeChatId;
    updateConditional();
    if (rule?.importNotes) $('rr-editor-status').textContent = rule.importNotes;
    if (rule?.options && ((rule.options.roles?.length || 0) > 1 || (rule.options.types?.length || 0) > 1 || (rule.options.fields?.length || 0) > 1)) $('rr-editor-status').textContent = '此规则包含多个来源、类型或字段，已保留；可在高级配置中编辑。';
  }

  function currentRule() {
    const scope = [...document.querySelectorAll('.rule-scope-cb:checked')].map(element => element.value);
    const options = readOptions();
    return { ...(loaded || {}), name: $('rule-name-input').value || '未命名规则', regex: $('rule-regex-input').value.trim(), template: $('rule-template-input').value, chatId: scope, isEnabled: $('rule-enabled-switch').checked, doNotSend: $('rule-do-not-send-switch').checked, options, ...(options ? { executionOrder: options.order } : {}), ...readMetadata() };
  }

  async function test(override) {
    const seq = ++previewSequence;
    const inputText = override?.input ?? value('test-input');
    const meta = { messageId: 'preview', previewNonce, timestamp: Date.now(), role: override?.role || value('test-role'), type: override?.type || value('test-type'), field: override?.field || (value('test-type') === 'thoughts' ? 'heartfeltVoice' : 'content'), isGroup: !!state.chats[value('test-chat')]?.isGroup };
    const stage = override?.stage || value('test-stage');
    $('rr-test-status').textContent = '正在测试…';
    try {
      const rule = currentRule();
      engine.compileRule(rule);
      let rules = [rule];
      if (value('test-target') === 'all') {
        rules = await db.renderingRules.toArray();
        const index = rules.findIndex(item => item.id === loaded?.id);
        if (index < 0) rules.push(rule); else rules[index] = rule;
      }
      const result = await window.RenderingRuleRuntime.run(inputText, rules, value('test-chat'), meta, stage, true);
      if (seq !== previewSequence) return result;
      const matched = result.trace.reduce((sum, item) => sum + item.matched, 0);
      $('rr-test-status').textContent = result.warnings.length ? result.warnings.join('；') : `${matched} 处匹配${result.excluded ? '，整条消息已排除' : ''}。${matched ? '处理结果如下。' : '请查看规则状态、范围、条件和执行记录。'}`;
      $('rr-test-output').innerHTML = result.isHtml ? window.RenderingRuleRuntime.sanitizeNewHtml(result.content) : esc(result.content).replace(/\n/g, '<br>');
      $('rr-test-trace').textContent = result.trace.map(item => `${item.name}：${item.reason}（${item.matched} 处）${item.selections?.length ? '\n候选编号：' + item.selections.join(', ') : ''}${item.before !== undefined ? '\n处理前：' + item.before + '\n处理后：' + item.after : ''}`).join('\n\n');
      await highlightMatches(inputText, rule, seq);
      return result;
    } catch (error) {
      if (seq === previewSequence) { $('rr-test-status').textContent = error.message; $('rr-test-output').textContent = ''; $('rr-test-match').textContent = ''; $('rr-test-trace').textContent = ''; }
      return null;
    }
  }

  async function highlightMatches(text, rule, seq) {
    // Use the same interruptible executor; avoid a second regex scan on the UI thread.
    const markerRule = { ...rule, isEnabled: true, doNotSend: false, chatId: ['global'], template: '$&', options: { ...(rule.options || {}), action: 'highlight', stages: ['display'], stop: '', roles: [], types: [], fields: [], after: null, chatKind: '', condition: {} } };
    if (['map', 'format'].includes(rule.options?.action)) { $('rr-test-match').textContent = text; return; }
    const result = await window.RenderingRuleRuntime.run(text, [markerRule], 'global', {}, 'display', true);
    if (seq === previewSequence) $('rr-test-match').innerHTML = result.isHtml ? window.RenderingRuleRuntime.sanitizeNewHtml(result.content) : esc(text).replace(/\n/g, '<br>');
  }

  function insertRandom() {
    const items = value('macro-candidates').split('\n').map(item => item.replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}').replace(/::/g, '\\:\\:'));
    const target = $('rule-template-input');
    const start = target.selectionStart ?? target.value.length, end = target.selectionEnd ?? start;
    const macro = `{{random::${items.join('::')}}}`;
    target.value = target.value.slice(0, start) + macro + target.value.slice(end);
    target.focus(); target.setSelectionRange(start + macro.length, start + macro.length);
    schedulePreview();
  }

  async function saveSample() {
    const result = await test();
    if (!result || result.warnings.length) return;
    try {
      const samples = JSON.parse(value('samples') || '[]');
      samples.push({ input: value('test-input'), expected: result.content, role: value('test-role'), type: value('test-type'), stage: value('test-stage'), chatId: value('test-chat'), previewNonce });
      setValue('samples', JSON.stringify(samples, null, 2)); optionsDirty = true;
      $('rr-test-status').textContent = '样本已加入，保存规则后保留。';
    } catch (error) { $('rr-test-status').textContent = error.message; }
  }

  async function testSamples() {
    try {
      const samples = JSON.parse(value('samples') || '[]');
      const rule = currentRule(), lines = [];
      for (const [index, sample] of samples.entries()) {
        const result = await window.RenderingRuleRuntime.run(String(sample.input ?? ''), [rule], sample.chatId || 'global', { messageId: 'preview', role: sample.role || 'assistant', type: sample.type || 'text', field: sample.field || 'content', timestamp: sample.timestamp || Date.now(), previewNonce: sample.previewNonce || 0 }, sample.stage || 'display', true);
        lines.push(`样本 ${index + 1}：${result.content === sample.expected && !result.warnings.length ? '通过' : '未通过'}${result.warnings.length ? ' — ' + result.warnings.join('；') : ''}`);
      }
      $('rr-test-status').textContent = samples.length ? lines.join('；') : '尚未添加样本。';
    } catch (error) { $('rr-test-status').textContent = error.message; }
  }

  function updateList(rules) {
    list = rules;
    if (!$('rr-group-filter')) return;
    const selected = value('group-filter');
    $('rr-group-filter').innerHTML = `<option value="">全部规则组</option>${[...new Set(rules.map(rule => rule.options?.group).filter(Boolean))].map(group => `<option value="${esc(group)}">${esc(group)}</option>`).join('')}`;
    setValue('group-filter', selected);
    $('rr-pause').textContent = paused ? '恢复规则' : '暂时停用';
    $('rr-undo').disabled = !undo.length;
    $('rr-list-status').textContent = paused ? '全部规则暂时停用，包括显示、上下文、复制和文本导出。预览仍可使用。' : `${rules.length} 条规则，原有范围绑定与批量管理均可继续使用。`;
    requestAnimationFrame(filterCards);
  }

  function filterCards() {
    const query = ($('rr-search')?.value || '').trim().toLowerCase(), group = $('rr-group-filter')?.value || '', status = $('rr-state-filter')?.value || '';
    for (const card of document.querySelectorAll('#rules-content-container .rule-card')) {
      const rule = list.find(item => String(item.id) === card.dataset.ruleId);
      if (!rule) continue;
      const searchable = [rule.name, rule.regex, rule.description, rule.author, rule.options?.group, ...(rule.options?.tags || [])].filter(Boolean).join(' ').toLowerCase();
      card.hidden = !!(query && !searchable.includes(query) || group && rule.options?.group !== group || status && (status === 'enabled') !== !!rule.isEnabled);
    }
  }

  function decorateCard(card, rule) {
    const title = card.querySelector('.card-title');
    if (title) title.textContent = rule.name;
    const row = document.createElement('div'); row.className = 'rr-card-tools';
    row.innerHTML = `<span class="rr-card-meta" title="${esc(rule.description || '')}">${esc(actionNames[rule.options?.action || 'replace'])}${rule.options?.group ? ' · ' + esc(rule.options.group) : ''}${rule.author ? ' · ' + esc(rule.author) : ''}${rule.options?.stages ? ' · ' + esc(rule.options.stages.map(stage => ({ display: '显示', context: '上下文', copy: '复制', export: '导出' }[stage] || stage)).join('/')) : ''}</span><button type="button" class="rr-icon-btn rr-drag" draggable="true" aria-label="拖动排序">↕</button><button type="button" class="rr-icon-btn" data-operation="up" aria-label="向前移动">↑</button><button type="button" class="rr-icon-btn" data-operation="down" aria-label="向后移动">↓</button><button type="button" class="rr-icon-btn" data-operation="copy" aria-label="复制规则">⧉</button><button type="button" class="rr-icon-btn" data-operation="toggle" aria-label="${rule.isEnabled ? '停用' : '启用'}规则">${rule.isEnabled ? '开' : '关'}</button>`;
    row.addEventListener('click', async event => {
      event.stopPropagation();
      const operation = event.target.closest('[data-operation]')?.dataset.operation;
      if (!operation) return;
      try {
        if (operation === 'up' || operation === 'down') { await moveRule(rule.id, operation === 'up' ? -1 : 1); return; }
        await beforeMutation();
        if (operation === 'toggle') await db.renderingRules.update(rule.id, { isEnabled: !rule.isEnabled });
        if (operation === 'copy') {
          const copied = clone(rule); delete copied.id; copied.name += ' (副本)';
          const id = await db.renderingRules.add(copied); await afterMutation(); window.invalidateRenderingRuleCache(); await window.renderRulesList(); await window.openRuleEditor(id); return;
        }
        await afterMutation(); window.invalidateRenderingRuleCache(); await window.renderRulesList();
      } catch (error) { await showCustomAlert('操作未完成', error.message); }
    });
    row.addEventListener('pointerdown', event => event.stopPropagation());
    row.querySelector('.rr-drag').addEventListener('dragstart', event => { event.stopPropagation(); event.dataTransfer.setData('application/x-ephone-rule', String(rule.id)); });
    card.addEventListener('dragover', event => { if ([...event.dataTransfer.types].includes('application/x-ephone-rule')) event.preventDefault(); });
    card.addEventListener('drop', async event => {
      const source = event.dataTransfer.getData('application/x-ephone-rule'); if (!source) return;
      event.preventDefault(); event.stopPropagation(); await reorder(source, rule.id);
    });
    card.appendChild(row);
  }

  function sortedRules() { return list.map((rule, index) => ({ rule, index })).sort((a, b) => (a.rule.executionOrder ?? a.rule.options?.order ?? a.index) - (b.rule.executionOrder ?? b.rule.options?.order ?? b.index)).map(item => item.rule); }
  async function moveRule(id, offset) {
    const rules = sortedRules(); const from = rules.findIndex(rule => rule.id === id), to = from + offset;
    if (to < 0 || to >= rules.length) return;
    await reorder(id, rules[to].id);
  }
  async function reorder(sourceId, targetId) {
    const rules = sortedRules(), from = rules.findIndex(rule => String(rule.id) === String(sourceId)), to = rules.findIndex(rule => String(rule.id) === String(targetId));
    if (from < 0 || to < 0 || from === to) return;
    const [item] = rules.splice(from, 1); rules.splice(to, 0, item);
    await beforeMutation();
    for (const [order, rule] of rules.entries()) await db.renderingRules.update(rule.id, { executionOrder: order, ...(rule.options ? { options: { ...rule.options, order } } : {}) });
    await afterMutation(); window.invalidateRenderingRuleCache(); await window.renderRulesList();
  }

  async function beforeMutation() { pendingSnapshot = clone(await db.renderingRules.toArray()); }
  async function afterMutation() {
    if (!pendingSnapshot) return;
    const after = clone(await db.renderingRules.toArray());
    if (JSON.stringify(after) !== JSON.stringify(pendingSnapshot)) { undo.push({ before: pendingSnapshot, after }); if (undo.length > 10) undo.shift(); }
    pendingSnapshot = null;
  }
  async function undoMutation() {
    const item = undo[undo.length - 1]; if (!item) return;
    const current = await db.renderingRules.toArray();
    if (JSON.stringify(current) !== JSON.stringify(item.after)) { await showCustomAlert('无法撤销', '规则已在其他操作中变化，撤销会覆盖这些变化，因此没有执行。'); return; }
    await db.transaction('rw', db.renderingRules, async () => { await db.renderingRules.clear(); await db.renderingRules.bulkPut(item.before); });
    undo.pop(); window.invalidateRenderingRuleCache(); await window.renderRulesList();
    $('rr-list-status').textContent = '最近一次规则修改已撤销。';
  }

  async function bulkApply() {
    const ids = [...new Set([...document.querySelectorAll('.rule-select-checkbox:checked')].map(element => Number(element.closest('.rule-card').dataset.ruleId)))];
    if (!ids.length) { await showCustomAlert('尚未选择', '请长按规则进入批量管理，并选择需要操作的规则。'); return; }
    const operation = value('bulk-operation'), inputText = value('bulk-value').trim();
    if (operation === 'scope' && inputText !== 'global' && !state.chats[inputText]) { await showCustomAlert('范围不存在', '请输入 global 或已有聊天的 ID。'); return; }
    await beforeMutation();
    for (const id of ids) {
      const rule = await db.renderingRules.get(id); if (!rule) continue;
      if (operation === 'enable' || operation === 'disable') await db.renderingRules.update(id, { isEnabled: operation === 'enable' });
      else if (operation === 'scope') await db.renderingRules.update(id, { chatId: [...new Set([...(Array.isArray(rule.chatId) ? rule.chatId : [rule.chatId]), inputText])] });
      else await db.renderingRules.update(id, { options: { ...(rule.options || {}), group: inputText } });
    }
    await afterMutation(); window.invalidateRenderingRuleCache(); await window.renderRulesList(); $('rr-list-status').textContent = `已处理 ${ids.length} 条规则。`;
  }

  function download(data, filename) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.click(); URL.revokeObjectURL(url);
  }

  async function importRules(data) {
    const external = Array.isArray(data) ? data : data.findRegex !== undefined ? [data] : null;
    const incoming = external || (data.type === 'EPhoneRenderingRules' && Array.isArray(data.rules) ? data.rules : null);
    if (!incoming) throw new Error('文件不是可识别的渲染规则文件');
    const existing = await db.renderingRules.toArray(), errors = [], duplicates = [], prepared = [], unsupported = [];
    for (const [index, original] of incoming.entries()) {
      const rule = clone(original); delete rule.id;
      if (external) {
        rule.name = rule.scriptName || rule.name || `导入规则 ${index + 1}`;
        rule.regex = rule.findRegex; rule.template = rule.replaceString ?? ''; rule.chatId = ['global']; rule.isEnabled = !rule.disabled;
        if (rule.placement || rule.markdownOnly || rule.promptOnly || rule.trimStrings?.length || rule.substituteRegex || rule.minDepth !== undefined || rule.maxDepth !== undefined) {
          unsupported.push(rule.name); rule.isEnabled = false;
          rule.importNotes = '外部范围、阶段或特殊配置尚未映射，规则已停用，请核对后自行开启。';
        }
      } else { rule.name = String(rule.name || `导入规则 ${index + 1}`); rule.chatId ||= ['global']; rule.isEnabled = rule.isEnabled !== false; }
      rule.name += ' (导入)';
      try { engine.compileRule(rule); } catch (error) { errors.push(`${rule.name}：${error.message}`); rule.isEnabled = false; rule.importNotes = error.message; }
      const duplicate = existing.find(item => engine.fingerprint(item) === engine.fingerprint(rule));
      if (duplicate) duplicates.push(rule.name);
      prepared.push({ rule, duplicate });
    }
    const summary = [`共 ${prepared.length} 条规则`, duplicates.length ? `${duplicates.length} 条重复` : '', errors.length ? `${errors.length} 条格式错误，将保留但停用` : '', unsupported.length ? `${unsupported.length} 条外部配置需要核对，将停用` : ''].filter(Boolean).join('；');
    const choice = await showChoiceModal('导入规则检查', [
      { text: `${summary} · 保留两份`, value: 'keep' },
      { text: '跳过重复规则', value: 'skip' },
      { text: '合并重复规则（保留原范围与状态）', value: 'merge' }
    ]);
    if (!choice) return;
    await beforeMutation(); let added = 0, merged = 0;
    await db.transaction('rw', db.renderingRules, async () => {
      for (const { rule, duplicate } of prepared) {
        if (duplicate && choice === 'skip') continue;
        if (duplicate && choice === 'merge') {
          await db.renderingRules.update(duplicate.id, { ...rule, name: duplicate.name, chatId: duplicate.chatId, isEnabled: rule.importNotes ? false : duplicate.isEnabled }); merged++;
        } else { await db.renderingRules.add(rule); added++; }
      }
    });
    await afterMutation(); window.invalidateRenderingRuleCache(); await window.renderRulesList();
    await showCustomAlert('导入完成', `新增 ${added} 条，合并 ${merged} 条。${errors.length || unsupported.length ? '\n\n' + [...errors, ...unsupported.map(name => `${name}：外部特殊配置请核对`)].join('\n') : ''}`);
  }

  window.areRenderingRulesPaused = () => paused;
  window.RenderingRuleWorkbench = { openEditor, readOptions, readMetadata, updateList, decorateCard, importRules, beforeMutation, afterMutation };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
