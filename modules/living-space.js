// 生活空间第一版：仅保存用户主动收录的聊天快照与地点备注。
// 不读取、写入或触发任一长期记忆模式。
(function () {
  let characterId = null;
  let spaceId = null;
  let extractSource = null;
  let isManagingCorners = false;
  let managedCornerIds = new Set();
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
  async function currentLocation(id = characterId) {
    if (!id) return null;
    const all = await db.livingSpaces.where('characterId').equals(id).toArray();
    const space = all.find(item => item.isCurrentLocation);
    if (!space) return null;
    const corner = (space.corners || []).find(item => item.id === space.currentCornerId) || null;
    return { space, corner };
  }

  function cleanCornerName(value) {
    return String(value || '')
      .replace(/^\s*(?:第?\d+[章节、.．]?[：: ]*|[一二三四五六七八九十]+[、.．]?[：: ]*)/, '')
      .replace(/[（(].*?[)）]/g, '')
      .replace(/[：:：\-—].*$/, '')
      .replace(/[“”"'`*_#]/g, '')
      .trim();
  }

  function layoutCornersFromEntry(book, entry, index) {
    const content = String(entry.content || '').replace(/\r/g, '');
    const matches = [];
    // 只把三级及更深的 Markdown 标题或编号小节视为“角落”。二级标题通常只是“场景”或“空间装饰”总标题；
    // 行首加粗的物件/设施说明（例如散尾葵、智能灯）
    // 仍属于所属角落的描述，不能与客厅、书房等空间并列。
    const pattern = /^(?:#{3,6}\s*|\s*(?:\d+|[一二三四五六七八九十]+)[、.．]\s*)(.+?)\s*$/gm;
    let match;
    while ((match = pattern.exec(content))) {
      const name = cleanCornerName(match[1]);
      if (!name || name.length > 24) continue;
      matches.push({ name, start: match.index, markerEnd: pattern.lastIndex });
    }
    const unique = [];
    const seen = new Set();
    matches.forEach(item => {
      const normalized = item.name.toLocaleLowerCase();
      if (!seen.has(normalized)) {
        seen.add(normalized);
        unique.push(item);
      }
    });
    return unique.map((item, partIndex) => ({
      id: `${book.id}:${index}:${partIndex}`,
      bookName: book.name,
      sourceTitle: String(entry.comment || entry.keys?.[0] || '地点布局').trim(),
      name: item.name,
      content: content.slice(item.markerEnd, unique[partIndex + 1]?.start || content.length).trim()
    }));
  }

  function worldBookEntries(space) {
    const ids = space.originWorldBookIds || (space.originWorldBookId ? [space.originWorldBookId] : []);
    return (state.worldBooks || []).filter(book => ids.includes(book.id)).flatMap(book =>
      (book.content || []).filter(entry => entry.enabled !== false).flatMap((entry, index) => layoutCornersFromEntry(book, entry, index))
    );
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
    el.innerHTML = `<div class="living-space-shell"><div class="living-space-actions"><button class="secondary" id="living-characters">选择角色</button><button id="living-add-space">新建居所</button></div><p class="living-space-note">${esc(current.name)} 的居所可以有多个；地点档案和收录内容完全由你掌控。</p><div class="living-space-space-list">${list.map(item => `<button class="living-space-space" data-space="${esc(item.id)}"><strong>${esc(item.name)}${item.isCurrentLocation ? ' · 当前所在' : ''}</strong><span>${esc(item.description || '尚未填写地点档案')}</span></button>`).join('') || '<p class="living-space-empty">还没有居所。可以从“卫岛公寓”或“花浦区老宅”开始。</p>'}</div></div>`;
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

  function bindMemoryActions(space, corners, list = document.getElementById('living-memory-list')) {
    if (!list) return;
    list.querySelectorAll('[data-edit-memory]').forEach(button => button.onclick = () => editMemory(button.dataset.editMemory));
    list.querySelectorAll('[data-delete-memory]').forEach(button => button.onclick = () => deleteMemory(button.dataset.deleteMemory, space, corners));
  }

  function bindTraceActions(space, corners, list) {
    if (!list) return;
    list.querySelectorAll('[data-view-trace-sources]').forEach(button => button.onclick = () => viewTraceSources(button.dataset.viewTraceSources));
    list.querySelectorAll('[data-edit-trace]').forEach(button => button.onclick = () => editTrace(button.dataset.editTrace));
    list.querySelectorAll('[data-delete-trace]').forEach(button => button.onclick = () => deleteTrace(button.dataset.deleteTrace, space, corners));
  }

  function timelineTime(value) {
    if (!value) return '未记录时间';
    return new Date(value).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  async function showCornerTimeline(space, corners, cornerId) {
    const list = document.getElementById('living-memory-list');
    const corner = corners.find(item => item.id === cornerId);
    if (!list || !corner) return;
    const entries = [
      ...(await memories(space.id, cornerId)).map(item => ({ ...item, type: 'memory', timestamp: item.createdAt })),
      ...(await traces(space.id, cornerId)).map(item => ({ ...item, type: 'trace', timestamp: item.createdAt }))
    ].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    const timeline = entries.length ? entries.map(item => item.type === 'trace'
      ? `<article class="living-space-trace"><div class="living-space-memory-meta">近期生活痕迹 · ${esc(timelineTime(item.timestamp))} · 依据 ${item.sourceMemoryIds?.length || 0} 条摘录</div><p>${esc(item.content)}</p><div class="living-space-card-actions"><button class="secondary" data-view-trace-sources="${esc(item.id)}">查看依据</button><button class="secondary" data-edit-trace="${esc(item.id)}">编辑</button><button class="danger" data-delete-trace="${esc(item.id)}">删除</button></div></article>`
      : `<article class="living-space-memory"><div class="living-space-memory-meta">${esc(item.sourceLabel === '地点备注' ? '角落备注' : (item.sourceLabel || '聊天摘录'))} · ${esc(timelineTime(item.timestamp))}</div><p>${esc(item.content)}</p>${item.tags?.length ? `<div class="living-space-memory-meta">${item.tags.map(esc).join(' · ')}</div>` : ''}<div class="living-space-card-actions"><button class="secondary" data-edit-memory="${esc(item.id)}">编辑</button><button class="danger" data-delete-memory="${esc(item.id)}">删除</button></div></article>`
    ).join('') : '<p class="living-space-empty">这个角落还没有摘录或近期生活痕迹。</p>';
    list.innerHTML = `<h4 class="living-space-section-title">${corner.icon ? `<span class="living-space-corner-icon">${esc(corner.icon)}</span>` : ''}${esc(corner.name)} · 空间记录</h4><p class="living-space-note">按时间汇总本角落的聊天摘录、角落备注与近期生活痕迹。</p><div class="living-space-actions"><button class="secondary" id="living-close-corner-timeline">返回全部记录</button></div>${timeline}`;
    document.getElementById('living-close-corner-timeline').onclick = renderSpace;
    bindMemoryActions(space, corners, list);
    bindTraceActions(space, corners, list);
    list.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function showCornerManager(space) {
    if (!(space.corners || []).length) return alert('这个居所还没有可管理的角落。');
    isManagingCorners = true;
    managedCornerIds = new Set();
    renderSpace();
  }

  async function bindCornerManager(space, corners) {
    const destinations = (await spaces()).filter(item => item.id !== space.id);
    const count = document.getElementById('living-manage-count');
    const syncSelection = () => {
      const checkboxes = [...document.querySelectorAll('[data-manage-corner]')];
      managedCornerIds = new Set(checkboxes.filter(input => input.checked).map(input => input.value));
      count.textContent = `已选 ${managedCornerIds.size} 个角落`;
    };
    document.querySelectorAll('[data-manage-corner]').forEach(input => input.onchange = event => { event.stopPropagation(); syncSelection(); });
    document.getElementById('living-manage-select-all').onclick = () => {
      document.querySelectorAll('[data-manage-corner]').forEach(input => { input.checked = true; });
      syncSelection();
    };
    document.getElementById('living-manage-deselect-all').onclick = () => {
      document.querySelectorAll('[data-manage-corner]').forEach(input => { input.checked = false; });
      syncSelection();
    };
    document.getElementById('living-manage-finish').onclick = () => { isManagingCorners = false; managedCornerIds = new Set(); renderSpace(); };
    document.getElementById('living-manage-delete').onclick = async () => {
      const ids = new Set(managedCornerIds);
      if (!ids.size) return alert('请先选择要删除的角落。');
      const chosen = corners.filter(corner => ids.has(corner.id));
      const affectedMemories = (await db.livingSpaceMemories.where('spaceId').equals(space.id).toArray()).filter(record => ids.has(record.cornerId));
      if (!confirm(`删除 ${chosen.length} 个角落吗？其中 ${affectedMemories.length} 条摘录和相关生活痕迹也会被永久删除。`)) return;
      await db.transaction('rw', db.livingSpaces, db.livingSpaceMemories, db.livingSpaceTraces, async () => {
        const tracesToDelete = (await db.livingSpaceTraces.where('spaceId').equals(space.id).toArray()).filter(record => ids.has(record.cornerId));
        await db.livingSpaceMemories.bulkDelete(affectedMemories.map(record => record.id));
        await db.livingSpaceTraces.bulkDelete(tracesToDelete.map(record => record.id));
        await db.livingSpaces.update(space.id, { corners: corners.filter(corner => !ids.has(corner.id)), isCurrentLocation: space.isCurrentLocation && ids.has(space.currentCornerId) ? false : space.isCurrentLocation, currentCornerId: ids.has(space.currentCornerId) ? null : space.currentCornerId, updatedAt: Date.now() });
      });
      managedCornerIds = new Set();
      renderSpace();
    };
    const moveButton = document.getElementById('living-manage-move');
    if (moveButton) moveButton.onclick = async () => {
      const ids = new Set(managedCornerIds);
      const destinationId = document.getElementById('living-manage-destination').value;
      if (!ids.size) return alert('请先选择要移动的角落。');
      if (!destinationId) return alert('请选择目标居所。');
      const destination = await db.livingSpaces.get(destinationId);
      if (!destination) return alert('目标居所不存在，请刷新后重试。');
      const chosen = corners.filter(corner => ids.has(corner.id));
      const destinationNames = new Set((destination.corners || []).map(corner => corner.name.trim().toLocaleLowerCase()));
      const conflicts = chosen.filter(corner => destinationNames.has(corner.name.trim().toLocaleLowerCase()));
      if (conflicts.length) return alert(`目标居所已有同名角落：${conflicts.map(corner => corner.name).join('、')}。请先改名或取消这些选择。`);
      if (!confirm(`将 ${chosen.length} 个角落及其所有摘录、备注和生活痕迹移动到“${destination.name}”吗？`)) return;
      await db.transaction('rw', db.livingSpaces, db.livingSpaceMemories, db.livingSpaceTraces, async () => {
        const now = Date.now();
        const movesCurrentLocation = space.isCurrentLocation && ids.has(space.currentCornerId);
        await db.livingSpaces.update(space.id, { corners: corners.filter(corner => !ids.has(corner.id)), isCurrentLocation: movesCurrentLocation ? false : space.isCurrentLocation, currentCornerId: movesCurrentLocation ? null : space.currentCornerId, updatedAt: now });
        await db.livingSpaces.update(destination.id, { corners: [...(destination.corners || []), ...chosen], isCurrentLocation: movesCurrentLocation ? true : destination.isCurrentLocation, currentCornerId: movesCurrentLocation ? space.currentCornerId : destination.currentCornerId, updatedAt: now });
        await db.livingSpaceMemories.where('spaceId').equals(space.id).filter(record => ids.has(record.cornerId)).modify({ spaceId: destination.id });
        await db.livingSpaceTraces.where('spaceId').equals(space.id).filter(record => ids.has(record.cornerId)).modify({ spaceId: destination.id });
      });
      managedCornerIds = new Set();
      renderSpace();
    };
    const destinationSelect = document.getElementById('living-manage-destination');
    if (destinationSelect && !destinations.length) destinationSelect.disabled = true;
  }

  async function renderSpace() {
    const el = content();
    const item = await db.livingSpaces.get(spaceId);
    if (!item) return renderSpaces();
    const cornerList = item.corners || [];
    const allTraces = await traces(item.id);
    const latestTraceByCorner = new Map();
    allTraces.forEach(trace => {
      if (!latestTraceByCorner.has(trace.cornerId)) latestTraceByCorner.set(trace.cornerId, trace);
    });
    const locationText = item.isCurrentLocation ? `当前所在：${item.name}${cornerList.find(corner => corner.id === item.currentCornerId) ? ' / ' + cornerList.find(corner => corner.id === item.currentCornerId).name : ''}` : '尚未设为当前所在地点';
    const destinations = isManagingCorners ? (await spaces()).filter(space => space.id !== item.id) : [];
    const managerToolbar = isManagingCorners ? `<div class="living-space-corner-manager"><div><strong>管理角落</strong><span id="living-manage-count">已选 ${managedCornerIds.size} 个角落</span></div><p>直接勾选卡片；移动会一并迁移摘录、备注和近期生活痕迹。</p><div class="living-space-actions"><button class="secondary" id="living-manage-select-all">全选</button><button class="secondary" id="living-manage-deselect-all">取消全选</button><button class="secondary" id="living-manage-finish">完成</button></div>${destinations.length ? `<label>移动到居所<select id="living-manage-destination"><option value="">请选择目标居所</option>${destinations.map(space => `<option value="${esc(space.id)}">${esc(space.name)}</option>`).join('')}</select></label><div class="living-space-actions"><button id="living-manage-move">移动选中角落</button><button class="danger" id="living-manage-delete">删除选中角落</button></div>` : '<p class="living-space-note">当前角色只有这一处居所；可删除选中角落。</p><div class="living-space-actions"><button class="danger" id="living-manage-delete">删除选中角落</button></div>'}</div>` : '';
    el.innerHTML = `<div class="living-space-shell"><div class="living-space-actions"><button class="secondary" id="living-spaces">居所列表</button><button class="secondary" id="living-edit-space">编辑居所</button><button class="danger" id="living-delete-space">删除居所</button><button id="living-add-corner">添加角落</button></div><h3 style="margin:8px 0 4px;">${esc(item.name)}</h3><p class="living-space-note">${esc(item.description || '尚未填写地点档案。')}</p><p class="living-space-note" id="living-current-location-note">${esc(locationText)}。仅用于生活空间摘录的自动预选，不会发送给 AI。</p>${managerToolbar}<div class="living-space-corner-grid">${cornerList.map(corner => { const latestTrace = latestTraceByCorner.get(corner.id); const selection = isManagingCorners ? `<label class="living-space-corner-select"><input type="checkbox" data-manage-corner value="${esc(corner.id)}"${managedCornerIds.has(corner.id) ? ' checked' : ''}>选择</label>` : ''; const actions = isManagingCorners ? '' : `<div class="living-space-card-actions"><button class="secondary" data-view-corner="${esc(corner.id)}">查看记录</button><button class="secondary" data-organize-corner="${esc(corner.id)}">生成近期痕迹</button><button class="secondary" data-edit-corner="${esc(corner.id)}">编辑</button><button class="danger" data-delete-corner="${esc(corner.id)}">删除</button></div>`; return `<div class="living-space-corner${isManagingCorners ? ' managing' : ''}" data-corner="${esc(corner.id)}">${selection}<strong>${corner.icon ? `<span class="living-space-corner-icon">${esc(corner.icon)}</span>` : ''}${esc(corner.name)}</strong><div class="living-space-corner-section"><span>固定档案</span><small>${esc(corner.description || '尚未填写角落备注')}</small></div><div class="living-space-corner-section recent"><span>最近状态</span><small>${esc(latestTrace?.content || '尚无近期生活痕迹')}</small></div>${actions}</div>`; }).join('')}</div>${cornerList.length && !isManagingCorners ? '<div class="living-space-actions"><button id="living-capture-chat">收录一段聊天</button><button class="secondary" id="living-add-note">写一条角落备注</button></div>' : (!cornerList.length ? '<p class="living-space-empty">先添加一个角落，例如厨房、窗边或旧钢琴旁。</p>' : '')}<div id="living-memory-list"></div></div>`;
    document.getElementById('living-spaces').onclick = () => { isManagingCorners = false; managedCornerIds = new Set(); renderSpaces(); };
    const originButton = document.createElement('button');
    originButton.className = 'secondary';
    originButton.textContent = '关联地点原典';
    originButton.onclick = () => showOriginPicker(item);
    document.getElementById('living-edit-space').after(originButton);
    const locationButton = document.createElement('button');
    locationButton.className = 'secondary';
    locationButton.textContent = '设为当前所在地点';
    locationButton.onclick = () => showCurrentLocationPicker(item);
    originButton.after(locationButton);
    const importCornersButton = document.createElement('button');
    importCornersButton.className = 'secondary';
    importCornersButton.textContent = '从地点原典创建角落';
    importCornersButton.onclick = () => showOriginCornerPicker(item);
    locationButton.after(importCornersButton);
    const manageCornersButton = document.createElement('button');
    manageCornersButton.className = 'secondary';
    manageCornersButton.textContent = isManagingCorners ? '完成管理' : '管理角落';
    manageCornersButton.onclick = () => {
      if (isManagingCorners) {
        isManagingCorners = false;
        managedCornerIds = new Set();
        renderSpace();
      } else {
        showCornerManager(item);
      }
    };
    importCornersButton.after(manageCornersButton);
    renderOrigin(item, el.querySelector('.living-space-corner-grid'));
    document.getElementById('living-edit-space').onclick = () => editSpace(item);
    document.getElementById('living-delete-space').onclick = () => deleteSpace(item);
    document.getElementById('living-add-corner').onclick = () => addCorner(item);
    if (cornerList.length) {
      if (isManagingCorners) {
        bindCornerManager(item, cornerList);
      } else {
        document.getElementById('living-capture-chat').onclick = () => showCaptureForm(item, cornerList, false);
        document.getElementById('living-add-note').onclick = () => showCaptureForm(item, cornerList, true);
        el.querySelectorAll('[data-corner]').forEach(card => card.onclick = () => showCornerTimeline(item, cornerList, card.dataset.corner));
        el.querySelectorAll('[data-view-corner]').forEach(button => button.onclick = event => { event.stopPropagation(); showCornerTimeline(item, cornerList, button.dataset.viewCorner); });
        el.querySelectorAll('[data-edit-corner]').forEach(button => button.onclick = event => { event.stopPropagation(); editCorner(item, button.dataset.editCorner); });
        el.querySelectorAll('[data-delete-corner]').forEach(button => button.onclick = event => { event.stopPropagation(); deleteCorner(item, button.dataset.deleteCorner); });
        el.querySelectorAll('[data-organize-corner]').forEach(button => button.onclick = event => { event.stopPropagation(); showTraceSelector(item, cornerList, button.dataset.organizeCorner); });
      }
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
    const icon = prompt('角落图标（可选，例如：🛋️、📚、🌿；留空则不显示）') || '';
    await db.livingSpaces.update(item.id, { corners: [...(item.corners || []), { id: uid(), name: name.trim(), description: description.trim(), icon: icon.trim() }], updatedAt: Date.now() });
    renderSpace();
  }

  function showCurrentLocationPicker(space) {
    const corners = space.corners || [];
    if (!corners.length) return alert('请先添加至少一个角落。');
    const target = document.getElementById('living-memory-list');
    target.innerHTML = `<div class="living-space-form"><strong>当前所在地点</strong><p class="living-space-note">只用于生活空间摘录时自动预选居所和角落，不会发送给 AI。</p><label>当前角落</label><select id="living-current-corner">${corners.map(corner => `<option value="${esc(corner.id)}"${space.isCurrentLocation && corner.id === space.currentCornerId ? ' selected' : ''}>${esc(space.name)} / ${esc(corner.name)}</option>`).join('')}</select><div class="living-space-actions"><button id="living-save-current-location">保存地点</button><button class="secondary" id="living-clear-current-location">清除地点</button><button class="secondary" id="living-cancel-current-location">取消</button></div></div>`;
    document.getElementById('living-cancel-current-location').onclick = renderSpace;
    document.getElementById('living-save-current-location').onclick = async () => {
      const all = await db.livingSpaces.where('characterId').equals(space.characterId).toArray();
      await db.transaction('rw', db.livingSpaces, async () => {
        await Promise.all(all.filter(item => item.isCurrentLocation && item.id !== space.id).map(item => db.livingSpaces.update(item.id, { isCurrentLocation: false, currentCornerId: null, updatedAt: Date.now() })));
        await db.livingSpaces.update(space.id, { isCurrentLocation: true, currentCornerId: document.getElementById('living-current-corner').value, updatedAt: Date.now() });
      });
      renderSpace();
    };
    document.getElementById('living-clear-current-location').onclick = async () => {
      const all = await db.livingSpaces.where('characterId').equals(space.characterId).toArray();
      await Promise.all(all.filter(item => item.isCurrentLocation).map(item => db.livingSpaces.update(item.id, { isCurrentLocation: false, currentCornerId: null, updatedAt: Date.now() })));
      renderSpace();
    };
  }

  function showOriginCornerPicker(space) {
    const entries = worldBookEntries(space);
    if (!entries.length) return alert('没有识别到可创建的布局小节。无需拆分成多个世界书条目；请在布局条目中用“### 餐厅”或“1. 餐厅”这类小标题标出角落。');
    const target = document.getElementById('living-memory-list');
    const existing = new Set((space.corners || []).map(corner => corner.name.trim().toLocaleLowerCase()));
    target.innerHTML = `<div class="living-space-form"><strong>从地点原典创建角落</strong><p class="living-space-note">只识别布局条目中的三级标题或编号小节（例如“### 客厅”“1. 餐厅”）；“## 场景”这类总标题不会成为角落。陈设、植物和设备仍会保留在所属角落的说明中，不会被创建成同级角落；已有同名角落会跳过。</p><div class="living-space-actions"><button class="secondary" id="living-select-all-origin-corners">全选可创建项</button><button class="secondary" id="living-deselect-all-origin-corners">取消全选</button></div>${entries.map(entry => `<label class="living-space-source-option"><input type="checkbox" value="${esc(entry.id)}"${existing.has(entry.name.toLocaleLowerCase()) ? ' disabled' : ''}><span><strong>${esc(entry.name)}</strong> · ${esc(entry.sourceTitle || entry.bookName)}${existing.has(entry.name.toLocaleLowerCase()) ? '（已有）' : ''}<br><small>${esc(entry.content.slice(0, 140) || '无该小节说明')}</small></span></label>`).join('')}<div class="living-space-actions"><button id="living-create-origin-corners">创建选中角落</button><button class="secondary" id="living-cancel-origin-corners">取消</button></div></div>`;
    document.getElementById('living-cancel-origin-corners').onclick = renderSpace;
    document.getElementById('living-select-all-origin-corners').onclick = () => target.querySelectorAll('input[type="checkbox"]:not(:disabled)').forEach(input => { input.checked = true; });
    document.getElementById('living-deselect-all-origin-corners').onclick = () => target.querySelectorAll('input[type="checkbox"]:not(:disabled)').forEach(input => { input.checked = false; });
    document.getElementById('living-create-origin-corners').onclick = async () => {
      const selected = new Set([...target.querySelectorAll('input:checked')].map(input => input.value));
      const additions = [];
      entries.forEach(entry => {
        const normalizedName = entry.name.toLocaleLowerCase();
        if (selected.has(entry.id) && !existing.has(normalizedName)) {
          additions.push({ id: uid(), name: entry.name, description: entry.content, originWorldBookName: entry.bookName });
          existing.add(normalizedName);
        }
      });
      if (!additions.length) return alert('请选择至少一个尚未创建的布局项。');
      await db.livingSpaces.update(space.id, { corners: [...(space.corners || []), ...additions], updatedAt: Date.now() });
      if (typeof showToast === 'function') showToast(`已创建 ${additions.length} 个角落`);
      renderSpace();
    };
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
    const icon = prompt('角落图标（可选，例如：🛋️、📚、🌿；留空可清除）', corner.icon || '');
    const corners = space.corners.map(item => item.id === cornerId ? { ...item, name: name.trim(), description: description === null ? item.description : description.trim(), icon: icon === null ? item.icon || '' : icon.trim() } : item);
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
      await db.livingSpaces.update(space.id, { corners: space.corners.filter(item => item.id !== cornerId), isCurrentLocation: space.isCurrentLocation && space.currentCornerId === cornerId ? false : space.isCurrentLocation, currentCornerId: space.currentCornerId === cornerId ? null : space.currentCornerId, updatedAt: Date.now() });
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
    showCornerTimeline(space, corners, item.cornerId);
  }

  async function showTraceSelector(space, corners, cornerId) {
    const corner = corners.find(item => item.id === cornerId);
    const sourceItems = await memories(space.id, cornerId);
    const target = document.getElementById('living-memory-list');
    if (!sourceItems.length) {
      target.innerHTML = '<p class="living-space-empty">这个角落还没有可选择的摘录。先用“收录一段聊天”或“写一条角落备注”保存素材，再在这里生成近期生活痕迹。</p>';
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
    const location = await currentLocation(sourceChat.id);
    extractSource = { chat: sourceChat, message, spaces: availableSpaces, location };
    document.getElementById('living-extract-content').value = text(message);
    document.getElementById('living-extract-tags').value = '';
    const spaceSelect = document.getElementById('living-extract-space');
    spaceSelect.innerHTML = availableSpaces.map(item => `<option value="${esc(item.id)}">${esc(item.name)}</option>`).join('');
    if (location && availableSpaces.some(item => item.id === location.space.id)) spaceSelect.value = location.space.id;
    renderExtractCorners();
    document.getElementById('living-space-extract-modal').classList.add('visible');
  }

  function renderExtractCorners() {
    if (!extractSource) return;
    const selectedId = document.getElementById('living-extract-space').value;
    const selectedSpace = extractSource.spaces.find(item => item.id === selectedId);
    const cornerSelect = document.getElementById('living-extract-corner');
    cornerSelect.innerHTML = (selectedSpace?.corners || []).map(item => `<option value="${esc(item.id)}">${esc(item.name)}</option>`).join('');
    if (extractSource.location?.space.id === selectedId && selectedSpace?.corners.some(item => item.id === extractSource.location.corner?.id)) cornerSelect.value = extractSource.location.corner.id;
    renderExtractLocationHint();
  }

  function renderExtractLocationHint() {
    const hint = document.getElementById('living-extract-location-hint');
    if (!hint || !extractSource) return;
    const selectedSpace = extractSource.spaces.find(item => item.id === document.getElementById('living-extract-space').value);
    const selectedCorner = selectedSpace?.corners.find(item => item.id === document.getElementById('living-extract-corner').value);
    const location = extractSource.location;
    if (location?.corner && selectedSpace?.id === location.space.id && selectedCorner?.id === location.corner.id) {
      hint.textContent = `已按当前所在预选：${location.space.name} / ${location.corner.name}。可在下方直接切换。`;
    } else if (location?.corner) {
      hint.textContent = `当前所在为：${location.space.name} / ${location.corner.name}；本次将保存到：${selectedSpace?.name || '未选择居所'} / ${selectedCorner?.name || '未选择角落'}。`;
    } else {
      hint.textContent = '尚未设置当前所在地点；请选择本次摘录的居所和角落。';
    }
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
  document.getElementById('living-extract-corner')?.addEventListener('change', renderExtractLocationHint);
  document.getElementById('living-extract-cancel')?.addEventListener('click', closeLivingSpaceExtract);
  document.getElementById('living-extract-save')?.addEventListener('click', saveLivingSpaceExtract);
})();
