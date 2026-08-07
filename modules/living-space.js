// 生活空间第一版：仅保存用户主动收录的聊天快照与地点备注。
// 不读取、写入或触发任一长期记忆模式。
(function () {
  let characterId = null;
  let spaceId = null;
  let extractSource = null;
  const uid = () => crypto.randomUUID ? crypto.randomUUID() : `living-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  const text = message => typeof message?.content === 'string' ? message.content : (message?.content?.text || '');
  const content = () => document.getElementById('living-space-content');
  const chats = () => Object.values(window.state?.chats || {}).filter(chat => !chat.isGroup);
  const chat = () => window.state?.chats?.[characterId];
  const byNewest = (items, key) => items.sort((a, b) => (b[key] || 0) - (a[key] || 0));

  async function spaces() {
    return characterId ? byNewest(await db.livingSpaces.where('characterId').equals(characterId).toArray(), 'updatedAt') : [];
  }
  async function memories(id, cornerId) {
    const all = byNewest(await db.livingSpaceMemories.where('spaceId').equals(id).toArray(), 'createdAt');
    return cornerId ? all.filter(item => item.cornerId === cornerId) : all;
  }
  async function traces(id, cornerId) {
    const all = byNewest(await db.livingSpaceTraces.where('spaceId').equals(id).toArray(), 'createdAt');
    return cornerId ? all.filter(item => item.cornerId === cornerId) : all;
  }

  function renderOrigin(space, container) {
    const ids = space.originWorldBookIds || (space.originWorldBookId ? [space.originWorldBookId] : []);
    const books = (state.worldBooks || []).filter(item => ids.includes(item.id));
    if (!books.length) return;
    const wrapper = document.createElement('section');
    wrapper.className = 'living-space-origin';
    const heading = document.createElement('h4');
    heading.textContent = '地点原典';
    const hint = document.createElement('p');
    hint.className = 'living-space-note';
    hint.textContent = '只读参考；不会写入聊天提示词，也不会覆盖生活空间内容。';
    wrapper.append(heading, hint);
    books.forEach(book => {
      const group = document.createElement('div');
      group.className = 'living-space-origin-book';
      const name = document.createElement('strong');
      name.textContent = book.name;
      group.appendChild(name);
      (book.content || []).filter(entry => entry.enabled !== false).forEach(entry => {
        const details = document.createElement('details');
        const summary = document.createElement('summary');
        summary.textContent = entry.comment || (entry.keys || []).join('、') || '世界书条目';
        const body = document.createElement('div');
        body.textContent = entry.content || '';
        details.append(summary, body);
        group.appendChild(details);
      });
      wrapper.appendChild(group);
    });
    container.before(wrapper);
  }

  function showOriginPicker(space) {
    const books = state.worldBooks || [];
    if (!books.length) return alert('还没有可关联的世界书。');
    const target = document.getElementById('living-memory-list');
    target.innerHTML = '';
    const form = document.createElement('div');
    form.className = 'living-space-form';
    const title = document.createElement('strong');
    title.textContent = '关联地点原典';
    const hint = document.createElement('p');
    hint.className = 'living-space-note';
    hint.textContent = '只建立生活空间内的只读关联，不会改变聊天当前绑定的世界书。';
    const selectedIds = new Set(space.originWorldBookIds || (space.originWorldBookId ? [space.originWorldBookId] : []));
    const choices = document.createElement('div');
    choices.className = 'living-space-origin-choices';
    books.forEach(book => {
      const label = document.createElement('label');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.value = book.id;
      checkbox.checked = selectedIds.has(book.id);
      const name = document.createElement('span');
      name.textContent = book.name;
      label.append(checkbox, name);
      choices.appendChild(label);
    });
    const actions = document.createElement('div');
    actions.className = 'living-space-actions';
    const save = document.createElement('button');
    save.textContent = '保存关联';
    const unlink = document.createElement('button');
    unlink.className = 'secondary';
    unlink.textContent = '解除关联';
    const cancel = document.createElement('button');
    cancel.className = 'secondary';
    cancel.textContent = '取消';
    actions.append(save, unlink, cancel);
    form.append(title, hint, choices, actions);
    target.appendChild(form);
    save.onclick = async () => {
      const ids = [...choices.querySelectorAll('input:checked')].map(input => input.value);
      await db.livingSpaces.update(space.id, { originWorldBookIds: ids, originWorldBookId: null, updatedAt: Date.now() });
      renderSpace();
    };
    unlink.onclick = async () => {
      await db.livingSpaces.update(space.id, { originWorldBookIds: [], originWorldBookId: null, updatedAt: Date.now() });
      renderSpace();
    };
    cancel.onclick = renderSpace;
  }

  async function renderCharacters() {
    const el = content();
    if (!el) return;
    el.innerHTML = `<div class="living-space-shell"><p class="living-space-note">这里仅保存你主动收录的聊天片段和手写备注，不会读取或改变当前的长期记忆模式。</p><div class="living-space-character-list">${chats().map(item => `<button class="living-space-character" data-character="${esc(item.id)}"><img src="${esc(item.settings?.aiAvatar || '')}" alt=""><span>${esc(item.name || '未命名角色')}</span></button>`).join('') || '<p class="living-space-empty">先创建一个角色，再为 TA 建立居所。</p>'}</div></div>`;
    el.querySelectorAll('[data-character]').forEach(button => button.onclick = () => { characterId = button.dataset.character; spaceId = null; renderSpaces(); });
  }

  async function renderSpaces() {
    const el = content();
    const current = chat();
    if (!current) return renderCharacters();
    const list = await spaces();
    el.innerHTML = `<div class="living-space-shell"><div class="living-space-actions"><button class="secondary" id="living-characters">选择角色</button><button id="living-add-space">新建居所</button></div><p class="living-space-note">${esc(current.name)} 的居所可以有多个；地点档案和收录内容完全由你掌控。</p><div class="living-space-space-list">${list.map(item => `<button class="living-space-space" data-space="${esc(item.id)}"><strong>${esc(item.name)}</strong><span>${esc(item.description || '尚未填写地点档案')}</span></button>`).join('') || '<p class="living-space-empty">还没有居所。可以从“卫岛公寓”或“花浦区老宅”开始。</p>'}</div></div>`;
    document.getElementById('living-characters').onclick = () => { characterId = null; renderCharacters(); };
    document.getElementById('living-add-space').onclick = addSpace;
    el.querySelectorAll('[data-space]').forEach(button => button.onclick = () => { spaceId = button.dataset.space; renderSpace(); });
  }

  async function addSpace() {
    const name = prompt('居所名称，例如：卫岛公寓');
    if (!name?.trim()) return;
    const description = prompt('地点档案（可选）：这里是什么地方？有什么固定氛围或重要设定？') || '';
    const now = Date.now();
    const item = { id: uid(), characterId, name: name.trim(), description: description.trim(), corners: [], createdAt: now, updatedAt: now };
    await db.livingSpaces.add(item);
    spaceId = item.id;
    renderSpace();
  }

  function memoryMarkup(list, corners) {
    if (!list.length) return '<p class="living-space-empty">这里还没有收录的记忆。</p>';
    const cornerNames = Object.fromEntries(corners.map(item => [item.id, item.name]));
    return list.map(item => `<article class="living-space-memory"><div class="living-space-memory-meta">${esc(cornerNames[item.cornerId] || '未分类')} · ${esc(item.sourceLabel === '地点备注' ? '角落备注' : (item.sourceLabel || '角落备注'))}</div><p>${esc(item.content)}</p>${item.tags?.length ? `<div class="living-space-memory-meta">${item.tags.map(esc).join(' · ')}</div>` : ''}<div class="living-space-card-actions"><button class="secondary" data-edit-memory="${esc(item.id)}">编辑</button><button class="danger" data-delete-memory="${esc(item.id)}">删除</button></div></article>`).join('');
  }

  function bindMemoryActions(space, corners) {
    const list = document.getElementById('living-memory-list');
    if (!list) return;
    list.querySelectorAll('[data-edit-memory]').forEach(button => button.onclick = () => editMemory(button.dataset.editMemory));
    list.querySelectorAll('[data-delete-memory]').forEach(button => button.onclick = () => deleteMemory(button.dataset.deleteMemory, space, corners));
  }

  function traceMarkup(list, corners) {
    if (!list.length) return '';
    const cornerNames = Object.fromEntries(corners.map(item => [item.id, item.name]));
    return `<h4 class="living-space-section-title">近期生活痕迹</h4>${list.map(item => `<article class="living-space-trace"><div class="living-space-memory-meta">${esc(cornerNames[item.cornerId] || '未分类')} · 依据 ${item.sourceMemoryIds?.length || 0} 条摘录</div><p>${esc(item.content)}</p><div class="living-space-card-actions"><button class="secondary" data-view-trace-sources="${esc(item.id)}">查看依据</button><button class="secondary" data-edit-trace="${esc(item.id)}">编辑</button><button class="danger" data-delete-trace="${esc(item.id)}">删除</button></div></article>`).join('')}`;
  }
  function bindTraceActions(space, corners) {
    const list = document.getElementById('living-trace-list');
    if (!list) return;
    list.querySelectorAll('[data-view-trace-sources]').forEach(button => button.onclick = () => viewTraceSources(button.dataset.viewTraceSources));
    list.querySelectorAll('[data-edit-trace]').forEach(button => button.onclick = () => editTrace(button.dataset.editTrace));
    list.querySelectorAll('[data-delete-trace]').forEach(button => button.onclick = () => deleteTrace(button.dataset.deleteTrace, space, corners));
  }

  async function showCornerMemories(space, corners, cornerId) {
    const list = document.getElementById('living-memory-list');
    if (!list) return;
    list.innerHTML = memoryMarkup(await memories(space.id, cornerId), corners);
    bindMemoryActions(space, corners);
  }

  async function renderSpace() {
    const el = content();
    const item = await db.livingSpaces.get(spaceId);
    if (!item) return renderSpaces();
    const cornerList = item.corners || [];
    el.innerHTML = `<div class="living-space-shell"><div class="living-space-actions"><button class="secondary" id="living-spaces">居所列表</button><button class="secondary" id="living-edit-space">编辑居所</button><button class="danger" id="living-delete-space">删除居所</button><button id="living-add-corner">添加角落</button></div><h3 style="margin:8px 0 4px;">${esc(item.name)}</h3><p class="living-space-note">${esc(item.description || '尚未填写地点档案。')}</p><div class="living-space-corner-grid">${cornerList.map(corner => `<div class="living-space-corner" data-corner="${esc(corner.id)}"><strong>${esc(corner.name)}</strong><small>${esc(corner.description || '尚未填写角落备注')}</small><div class="living-space-card-actions"><button class="secondary" data-organize-corner="${esc(corner.id)}">整理</button><button class="secondary" data-edit-corner="${esc(corner.id)}">编辑</button><button class="danger" data-delete-corner="${esc(corner.id)}">删除</button></div></div>`).join('')}</div>${cornerList.length ? '<div class="living-space-actions"><button id="living-capture-chat">收录一段聊天</button><button class="secondary" id="living-add-note">写一条角落备注</button></div>' : '<p class="living-space-empty">先添加一个角落，例如厨房、窗边或旧钢琴旁。</p>'}<div id="living-memory-list">${memoryMarkup(await memories(item.id), cornerList)}</div><div id="living-trace-list">${traceMarkup(await traces(item.id), cornerList)}</div></div>`;
    document.getElementById('living-spaces').onclick = renderSpaces;
    const originButton = document.createElement('button');
    originButton.className = 'secondary';
    originButton.textContent = '关联地点原典';
    originButton.onclick = () => showOriginPicker(item);
    document.getElementById('living-edit-space').after(originButton);
    renderOrigin(item, el.querySelector('.living-space-corner-grid'));
    document.getElementById('living-edit-space').onclick = () => editSpace(item);
    document.getElementById('living-delete-space').onclick = () => deleteSpace(item);
    document.getElementById('living-add-corner').onclick = () => addCorner(item);
    bindMemoryActions(item, cornerList);
    bindTraceActions(item, cornerList);
    if (cornerList.length) {
      document.getElementById('living-capture-chat').onclick = () => showCaptureForm(item, cornerList, false);
      document.getElementById('living-add-note').onclick = () => showCaptureForm(item, cornerList, true);
      el.querySelectorAll('[data-corner]').forEach(card => card.onclick = () => showCornerMemories(item, cornerList, card.dataset.corner));
      el.querySelectorAll('[data-edit-corner]').forEach(button => button.onclick = event => { event.stopPropagation(); editCorner(item, button.dataset.editCorner); });
      el.querySelectorAll('[data-delete-corner]').forEach(button => button.onclick = event => { event.stopPropagation(); deleteCorner(item, button.dataset.deleteCorner); });
      el.querySelectorAll('[data-organize-corner]').forEach(button => button.onclick = event => { event.stopPropagation(); showTraceSelector(item, cornerList, button.dataset.organizeCorner); });
    }
  }

  async function editSpace(item) {
    const name = prompt('居所名称', item.name);
    if (!name?.trim()) return;
    const description = prompt('地点档案', item.description || '');
    await db.livingSpaces.update(item.id, { name: name.trim(), description: description === null ? item.description : description.trim(), updatedAt: Date.now() });
    renderSpace();
  }
  async function addCorner(item) {
    const name = prompt('角落名称，例如：厨房、窗边、旧钢琴旁');
    if (!name?.trim()) return;
    const description = prompt('角落备注（可选）') || '';
    await db.livingSpaces.update(item.id, { corners: [...(item.corners || []), { id: uid(), name: name.trim(), description: description.trim() }], updatedAt: Date.now() });
    renderSpace();
  }

  async function deleteSpace(item) {
    const related = await db.livingSpaceMemories.where('spaceId').equals(item.id).count();
    if (!confirm(`删除“${item.name}”吗？其中 ${item.corners?.length || 0} 个角落和 ${related} 条已收录记忆也会被永久删除。`)) return;
    await db.transaction('rw', db.livingSpaces, db.livingSpaceMemories, db.livingSpaceTraces, async () => {
      const records = await db.livingSpaceMemories.where('spaceId').equals(item.id).toArray();
      const tracesToDelete = await db.livingSpaceTraces.where('spaceId').equals(item.id).toArray();
      await db.livingSpaceMemories.bulkDelete(records.map(record => record.id));
      await db.livingSpaceTraces.bulkDelete(tracesToDelete.map(record => record.id));
      await db.livingSpaces.delete(item.id);
    });
    spaceId = null;
    renderSpaces();
  }

  async function editCorner(space, cornerId) {
    const corner = (space.corners || []).find(item => item.id === cornerId);
    if (!corner) return;
    const name = prompt('角落名称', corner.name);
    if (!name?.trim()) return;
    const description = prompt('角落备注', corner.description || '');
    const corners = space.corners.map(item => item.id === cornerId ? { ...item, name: name.trim(), description: description === null ? item.description : description.trim() } : item);
    await db.livingSpaces.update(space.id, { corners, updatedAt: Date.now() });
    renderSpace();
  }

  async function deleteCorner(space, cornerId) {
    const corner = (space.corners || []).find(item => item.id === cornerId);
    if (!corner) return;
    const related = (await db.livingSpaceMemories.where('spaceId').equals(space.id).toArray()).filter(item => item.cornerId === cornerId);
    if (!confirm(`删除角落“${corner.name}”吗？其中 ${related.length} 条已收录记忆也会被永久删除。`)) return;
    await db.transaction('rw', db.livingSpaces, db.livingSpaceMemories, db.livingSpaceTraces, async () => {
      const tracesToDelete = (await db.livingSpaceTraces.where('spaceId').equals(space.id).toArray()).filter(item => item.cornerId === cornerId);
      await db.livingSpaces.update(space.id, { corners: space.corners.filter(item => item.id !== cornerId), updatedAt: Date.now() });
      await db.livingSpaceMemories.bulkDelete(related.map(item => item.id));
      await db.livingSpaceTraces.bulkDelete(tracesToDelete.map(item => item.id));
    });
    renderSpace();
  }

  async function editMemory(memoryId) {
    const item = await db.livingSpaceMemories.get(memoryId);
    if (!item) return;
    const memoryContent = prompt('记忆内容', item.content);
    if (!memoryContent?.trim()) return;
    const tagText = prompt('标签（以逗号分隔）', (item.tags || []).join(', '));
    await db.livingSpaceMemories.update(memoryId, { content: memoryContent.trim(), tags: tagText === null ? item.tags || [] : tagText.split(/[,，]/).map(tag => tag.trim()).filter(Boolean) });
    renderSpace();
  }

  async function deleteMemory(memoryId, space, corners) {
    const item = await db.livingSpaceMemories.get(memoryId);
    if (!item || !confirm('删除这条已收录记忆吗？此操作无法撤销。')) return;
    await db.livingSpaceMemories.delete(memoryId);
    await db.livingSpaces.update(space.id, { updatedAt: Date.now() });
    showCornerMemories(space, corners, item.cornerId);
  }

  async function showTraceSelector(space, corners, cornerId) {
    const corner = corners.find(item => item.id === cornerId);
    const sourceItems = await memories(space.id, cornerId);
    const target = document.getElementById('living-memory-list');
    if (!sourceItems.length) {
      target.innerHTML = '<p class="living-space-empty">这个角落还没有可选择的摘录。</p>';
      return;
    }
    target.innerHTML = '';
    const form = document.createElement('div');
    form.className = 'living-space-form';
    const title = document.createElement('strong');
    title.textContent = '整理「' + (corner ? corner.name : '角落') + '」的生活痕迹';
    const hint = document.createElement('p');
    hint.className = 'living-space-note';
    hint.textContent = '默认不勾选。AI 只会读取本次勾选的摘录、地点档案和角落备注。';
    form.append(title, hint);
    sourceItems.forEach(item => {
      const label = document.createElement('label');
      label.className = 'living-space-source-option';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.value = item.id;
      const textNode = document.createElement('span');
      textNode.textContent = (item.sourceLabel || '摘录') + '：' + item.content;
      label.append(checkbox, textNode);
      form.appendChild(label);
    });
    const actions = document.createElement('div');
    actions.className = 'living-space-actions';
    const generate = document.createElement('button');
    generate.textContent = '生成 1–3 条生活痕迹';
    const cancel = document.createElement('button');
    cancel.className = 'secondary';
    cancel.textContent = '取消';
    actions.append(generate, cancel);
    form.appendChild(actions);
    target.appendChild(form);
    cancel.onclick = renderSpace;
    generate.onclick = async () => {
      const ids = [...form.querySelectorAll('input:checked')].map(input => input.value);
      if (!ids.length) return alert('请至少勾选一条摘录。');
      await generateTraces(space, corner, sourceItems.filter(item => ids.includes(item.id)), ids, generate);
    };
  }

  async function generateTraces(space, corner, selected, sourceMemoryIds, button) {
    const { proxyUrl, apiKey, model } = state.apiConfig || {};
    if (!proxyUrl || !apiKey || !model) return alert('请先配置 API。');
    const evidence = selected.map((item, index) => (index + 1) + '. ' + item.content + (item.tags?.length ? '（标签：' + item.tags.join('、') + '）' : '')).join('\n');
    const prompt = '你是生活空间整理助手。只能依据以下地点档案、角落备注和用户勾选的摘录，生成1到3条简短、具体、克制的“近期生活痕迹”。不得补充素材中没有的事实，不得提及AI、摘录或聊天。每条25到70字。只返回 JSON 数组，例如：[{"content":"窗边还留着……"}]。\n\n居所：' + space.name + '\n地点档案：' + (space.description || '无') + '\n角落：' + corner.name + '\n角落备注：' + (corner.description || '无') + '\n\n本次勾选的摘录：\n' + evidence;
    button.disabled = true;
    button.textContent = '正在整理…';
    try {
      const messages = [{ role: 'user', content: '请整理生活痕迹。' }];
      let response;
      if (proxyUrl.includes('generativelanguage')) {
        const request = toGeminiRequestData(model, apiKey, prompt, messages);
        response = await fetch(request.url, request.data);
      } else {
        response = await fetch(proxyUrl + '/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey }, body: JSON.stringify({ model, messages: [{ role: 'system', content: prompt }, ...messages], temperature: state.globalSettings?.apiTemperature || 0.7 }) });
      }
      if (!response.ok) throw new Error('API 请求失败：' + response.status);
      let raw = getGeminiResponseText(await response.json()).trim();
      const start = raw.indexOf('['), end = raw.lastIndexOf(']');
      const output = JSON.parse(start >= 0 && end >= start ? raw.slice(start, end + 1) : raw);
      const records = output.slice(0, 3).map(item => ({ id: uid(), spaceId: space.id, cornerId: corner.id, characterId, content: String(item.content || '').trim(), sourceMemoryIds, createdAt: Date.now() })).filter(item => item.content);
      if (!records.length) throw new Error('未得到可保存的生活痕迹。');
      await db.livingSpaceTraces.bulkAdd(records);
      await db.livingSpaces.update(space.id, { updatedAt: Date.now() });
      renderSpace();
    } catch (error) {
      alert('整理失败：' + error.message);
      button.disabled = false;
      button.textContent = '生成 1–3 条生活痕迹';
    }
  }

  async function editTrace(traceId) {
    const item = await db.livingSpaceTraces.get(traceId);
    const value = item && prompt('生活痕迹', item.content);
    if (!value?.trim()) return;
    await db.livingSpaceTraces.update(traceId, { content: value.trim() });
    renderSpace();
  }

  async function viewTraceSources(traceId) {
    const trace = await db.livingSpaceTraces.get(traceId);
    if (!trace) return;
    const records = await db.livingSpaceMemories.bulkGet(trace.sourceMemoryIds || []);
    const lines = (trace.sourceMemoryIds || []).map((id, index) => {
      const item = records[index];
      if (!item) return (index + 1) + '. （这条原始摘录已被删除）';
      const tags = item.tags?.length ? '\n标签：' + item.tags.join('、') : '';
      return (index + 1) + '. ' + (item.sourceLabel || '摘录') + '\n' + item.content + tags;
    });
    showCustomAlert('本次整理依据', esc(lines.join('\n\n')));
  }

  async function deleteTrace(traceId, space) {
    if (!confirm('删除这条生活痕迹吗？')) return;
    await db.livingSpaceTraces.delete(traceId);
    await db.livingSpaces.update(space.id, { updatedAt: Date.now() });
    renderSpace();
  }

  async function openLivingSpaceExtract(sourceChat, message) {
    const availableSpaces = (await db.livingSpaces.where('characterId').equals(sourceChat.id).toArray()).filter(item => (item.corners || []).length > 0);
    if (!availableSpaces.length) {
      alert('请先在这个角色的生活空间中创建至少一个居所和角落，再从聊天中摘录。');
      return;
    }
    extractSource = { chat: sourceChat, message, spaces: availableSpaces };
    document.getElementById('living-extract-content').value = text(message);
    document.getElementById('living-extract-tags').value = '';
    const spaceSelect = document.getElementById('living-extract-space');
    spaceSelect.innerHTML = availableSpaces.map(item => `<option value="${esc(item.id)}">${esc(item.name)}</option>`).join('');
    renderExtractCorners();
    document.getElementById('living-space-extract-modal').classList.add('visible');
  }

  function renderExtractCorners() {
    if (!extractSource) return;
    const selectedId = document.getElementById('living-extract-space').value;
    const selectedSpace = extractSource.spaces.find(item => item.id === selectedId);
    const cornerSelect = document.getElementById('living-extract-corner');
    cornerSelect.innerHTML = (selectedSpace?.corners || []).map(item => `<option value="${esc(item.id)}">${esc(item.name)}</option>`).join('');
  }

  function closeLivingSpaceExtract() {
    document.getElementById('living-space-extract-modal').classList.remove('visible');
    extractSource = null;
  }

  async function saveLivingSpaceExtract() {
    if (!extractSource) return;
    const extractedContent = document.getElementById('living-extract-content').value.trim();
    const selectedSpaceId = document.getElementById('living-extract-space').value;
    const selectedCornerId = document.getElementById('living-extract-corner').value;
    if (!extractedContent || !selectedSpaceId || !selectedCornerId) return;
    const tags = document.getElementById('living-extract-tags').value.split(/[,，]/).map(tag => tag.trim()).filter(Boolean);
    const { chat: sourceChat, message } = extractSource;
    await db.livingSpaceMemories.add({
      id: uid(), spaceId: selectedSpaceId, cornerId: selectedCornerId, characterId: sourceChat.id,
      content: extractedContent, sourceChatId: sourceChat.id, sourceMessageTimestamp: message.timestamp || null,
      sourceLabel: message.role === 'user' ? '我说' : `${sourceChat.name}说`, tags, createdAt: Date.now()
    });
    await db.livingSpaces.update(selectedSpaceId, { updatedAt: Date.now() });
    closeLivingSpaceExtract();
    if (typeof showToast === 'function') showToast('已摘录到生活空间');
  }

  function showCaptureForm(space, corners, noteOnly) {
    // 思维链虽可在聊天页显示，但它是模型内部推理，不属于可收藏的剧情/生活片段。
    const recent = (chat()?.history || []).filter(message => !message.isHidden && !message.isExcluded && message.type !== 'thought_chain_block' && text(message).trim()).slice(-30).reverse();
    const target = document.getElementById('living-memory-list');
    target.innerHTML = `<div class="living-space-form"><strong>${noteOnly ? '写一条角落备注' : '收录一段最近聊天'}</strong><label>归属角落</label><select id="living-memory-corner">${corners.map(item => `<option value="${esc(item.id)}">${esc(item.name)}</option>`).join('')}</select>${noteOnly ? '<label>内容</label><textarea id="living-memory-note" rows="4" placeholder="写下地点相关的事实、旧物或重要片段…"></textarea>' : `<label>聊天片段</label><select id="living-memory-source">${recent.map((message, index) => `<option value="${index}">${esc(message.role === 'user' ? '我' : (chat().name || '角色'))}：${esc(text(message).slice(0, 80))}</option>`).join('')}</select>`}<label>标签（可选，以逗号分隔）</label><input id="living-memory-tags" placeholder="共同晚餐, 物件"><div class="living-space-actions"><button id="living-save-memory">保存</button><button class="secondary" id="living-cancel-memory">取消</button></div></div>`;
    document.getElementById('living-cancel-memory').onclick = renderSpace;
    document.getElementById('living-save-memory').onclick = async () => {
      const index = Number(document.getElementById('living-memory-source')?.value || 0);
      const source = noteOnly ? document.getElementById('living-memory-note').value.trim() : text(recent[index]).trim();
      if (!source) return;
      const message = noteOnly ? null : recent[index];
      const tags = document.getElementById('living-memory-tags').value.split(/[,，]/).map(tag => tag.trim()).filter(Boolean);
      await db.livingSpaceMemories.add({ id: uid(), spaceId: space.id, cornerId: document.getElementById('living-memory-corner').value, characterId, content: source, sourceChatId: noteOnly ? null : characterId, sourceMessageTimestamp: message?.timestamp || null, sourceLabel: noteOnly ? '角落备注' : (message?.role === 'user' ? '我说' : `${chat().name}说`), tags, createdAt: Date.now() });
      await db.livingSpaces.update(space.id, { updatedAt: Date.now() });
      renderSpace();
    };
  }

  window.openLivingSpace = () => { characterId = null; spaceId = null; window.showScreen('living-space-screen'); renderCharacters(); };
  window.openLivingSpaceExtract = openLivingSpaceExtract;

  document.getElementById('living-extract-space')?.addEventListener('change', renderExtractCorners);
  document.getElementById('living-extract-cancel')?.addEventListener('click', closeLivingSpaceExtract);
  document.getElementById('living-extract-save')?.addEventListener('click', saveLivingSpaceExtract);
})();
