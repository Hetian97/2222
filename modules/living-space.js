// 生活空间第一版：仅保存用户主动收录的聊天快照与地点备注。
// 不读取、写入或触发任一长期记忆模式。
(function () {
  let characterId = null;
  let spaceId = null;
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
    el.innerHTML = `<div class="living-space-shell"><div class="living-space-actions"><button class="secondary" id="living-spaces">居所列表</button><button class="secondary" id="living-edit-space">编辑居所</button><button class="danger" id="living-delete-space">删除居所</button><button id="living-add-corner">添加角落</button></div><h3 style="margin:8px 0 4px;">${esc(item.name)}</h3><p class="living-space-note">${esc(item.description || '尚未填写地点档案。')}</p><div class="living-space-corner-grid">${cornerList.map(corner => `<div class="living-space-corner" data-corner="${esc(corner.id)}"><strong>${esc(corner.name)}</strong><small>${esc(corner.description || '尚未填写角落备注')}</small><div class="living-space-card-actions"><button class="secondary" data-edit-corner="${esc(corner.id)}">编辑</button><button class="danger" data-delete-corner="${esc(corner.id)}">删除</button></div></div>`).join('')}</div>${cornerList.length ? '<div class="living-space-actions"><button id="living-capture-chat">收录一段聊天</button><button class="secondary" id="living-add-note">写一条角落备注</button></div>' : '<p class="living-space-empty">先添加一个角落，例如厨房、窗边或旧钢琴旁。</p>'}<div id="living-memory-list">${memoryMarkup(await memories(item.id), cornerList)}</div></div>`;
    document.getElementById('living-spaces').onclick = renderSpaces;
    document.getElementById('living-edit-space').onclick = () => editSpace(item);
    document.getElementById('living-delete-space').onclick = () => deleteSpace(item);
    document.getElementById('living-add-corner').onclick = () => addCorner(item);
    bindMemoryActions(item, cornerList);
    if (cornerList.length) {
      document.getElementById('living-capture-chat').onclick = () => showCaptureForm(item, cornerList, false);
      document.getElementById('living-add-note').onclick = () => showCaptureForm(item, cornerList, true);
      el.querySelectorAll('[data-corner]').forEach(card => card.onclick = () => showCornerMemories(item, cornerList, card.dataset.corner));
      el.querySelectorAll('[data-edit-corner]').forEach(button => button.onclick = event => { event.stopPropagation(); editCorner(item, button.dataset.editCorner); });
      el.querySelectorAll('[data-delete-corner]').forEach(button => button.onclick = event => { event.stopPropagation(); deleteCorner(item, button.dataset.deleteCorner); });
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
    await db.transaction('rw', db.livingSpaces, db.livingSpaceMemories, async () => {
      const records = await db.livingSpaceMemories.where('spaceId').equals(item.id).toArray();
      await db.livingSpaceMemories.bulkDelete(records.map(record => record.id));
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
    await db.transaction('rw', db.livingSpaces, db.livingSpaceMemories, async () => {
      await db.livingSpaces.update(space.id, { corners: space.corners.filter(item => item.id !== cornerId), updatedAt: Date.now() });
      await db.livingSpaceMemories.bulkDelete(related.map(item => item.id));
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
})();
