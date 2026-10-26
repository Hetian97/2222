// Google Imagen / GPT 生图预设与角色聊天绑定
(function () {
  'use strict';

  const selectedPresetIds = { imagen: null, openai: null };
  const labels = { imagen: 'Google Imagen', openai: 'GPT 生图' };

  async function loadImagePresetDropdown(provider) {
    const select = document.getElementById(`${provider === 'imagen' ? 'imagen' : 'openai'}-preset-select`);
    if (!select) return;
    const presets = (await db.imagePresets.where('provider').equals(provider).toArray())
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
    select.innerHTML = '<option value="">-- 当前临时设置 --</option>' +
      presets.map(preset => `<option value="${preset.id}">${escapeHtml(preset.name)}</option>`).join('');
    if (selectedPresetIds[provider]) select.value = String(selectedPresetIds[provider]);
    updatePresetButtons(provider);
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }

  function updatePresetButtons(provider) {
    const has = !!selectedPresetIds[provider];
    const updateBtn = document.getElementById(`update-${provider}-preset-btn`);
    const deleteBtn = document.getElementById(`delete-${provider}-preset-btn`);
    const saveBtn = document.getElementById(`save-${provider}-preset-btn`);
    if (updateBtn) updateBtn.style.display = has ? 'inline-flex' : 'none';
    if (deleteBtn) deleteBtn.style.display = has ? 'inline-flex' : 'none';
    if (saveBtn) saveBtn.textContent = has ? '另存' : '新增';
  }

  function gatherPresetSettings(provider) {
    if (provider === 'imagen') {
      return {
        model: document.getElementById('google-imagen-model')?.value || 'imagen-4.0-generate-001',
        endpoint: document.getElementById('google-imagen-endpoint')?.value.trim() || 'https://generativelanguage.googleapis.com',
        aspectRatio: document.getElementById('google-imagen-aspect-ratio')?.value || '1:1',
        positivePrompt: document.getElementById('google-imagen-positive')?.value.trim() || '',
        negativePrompt: document.getElementById('google-imagen-negative')?.value.trim() || ''
      };
    }
    return {
      model: document.getElementById('openai-image-model')?.value || 'gpt-image-2',
      endpoint: document.getElementById('openai-image-endpoint')?.value.trim() || 'https://api.openai.com',
      size: document.getElementById('openai-image-size')?.value || 'auto',
      quality: document.getElementById('openai-image-quality')?.value || 'auto',
      outputFormat: document.getElementById('openai-image-output-format')?.value || 'png',
      outputCompression: Number(document.getElementById('openai-image-compression')?.value ?? 100),
      background: document.getElementById('openai-image-background')?.value || 'auto',
      moderation: document.getElementById('openai-image-moderation')?.value || 'auto',
      positivePrompt: document.getElementById('openai-image-positive')?.value.trim() || '',
      negativePrompt: document.getElementById('openai-image-negative')?.value.trim() || ''
    };
  }

  function setSelectValue(id, value) {
    const select = document.getElementById(id);
    if (!select || !value) return;
    if (![...select.options].some(option => option.value === value)) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = value;
      select.appendChild(option);
    }
    select.value = value;
  }

  function applyPresetSettings(provider, settings) {
    if (!settings) return;
    if (provider === 'imagen') {
      setSelectValue('google-imagen-model', settings.model);
      if (document.getElementById('google-imagen-endpoint')) document.getElementById('google-imagen-endpoint').value = settings.endpoint || 'https://generativelanguage.googleapis.com';
      if (document.getElementById('google-imagen-aspect-ratio')) document.getElementById('google-imagen-aspect-ratio').value = settings.aspectRatio || '1:1';
      if (document.getElementById('google-imagen-positive')) document.getElementById('google-imagen-positive').value = settings.positivePrompt || '';
      if (document.getElementById('google-imagen-negative')) document.getElementById('google-imagen-negative').value = settings.negativePrompt || '';
      return;
    }
    setSelectValue('openai-image-model', settings.model);
    if (document.getElementById('openai-image-endpoint')) document.getElementById('openai-image-endpoint').value = settings.endpoint || 'https://api.openai.com';
    if (document.getElementById('openai-image-size')) document.getElementById('openai-image-size').value = settings.size || 'auto';
    if (document.getElementById('openai-image-quality')) document.getElementById('openai-image-quality').value = settings.quality || 'auto';
    if (document.getElementById('openai-image-output-format')) document.getElementById('openai-image-output-format').value = settings.outputFormat || 'png';
    if (document.getElementById('openai-image-compression')) document.getElementById('openai-image-compression').value = String(settings.outputCompression ?? 100);
    if (document.getElementById('openai-image-background')) document.getElementById('openai-image-background').value = settings.background || 'auto';
    if (document.getElementById('openai-image-moderation')) document.getElementById('openai-image-moderation').value = settings.moderation || 'auto';
    if (document.getElementById('openai-image-positive')) document.getElementById('openai-image-positive').value = settings.positivePrompt || '';
    if (document.getElementById('openai-image-negative')) document.getElementById('openai-image-negative').value = settings.negativePrompt || '';
  }

  async function handlePresetChange(provider, value) {
    selectedPresetIds[provider] = value ? Number(value) : null;
    if (!value) {
      updatePresetButtons(provider);
      return;
    }
    const preset = await db.imagePresets.get(Number(value));
    if (preset?.settings) applyPresetSettings(provider, preset.settings);
    updatePresetButtons(provider);
  }

  async function savePreset(provider, isUpdate) {
    const settings = gatherPresetSettings(provider);
    if (isUpdate && selectedPresetIds[provider]) {
      const confirmed = await showCustomConfirm('更新预设', `确定覆盖当前 ${labels[provider]} 预设吗？`);
      if (!confirmed) return;
      await db.imagePresets.update(selectedPresetIds[provider], { settings });
      alert('预设已更新');
    } else {
      const name = await showCustomPrompt('新建预设', `请输入 ${labels[provider]} 预设名称：`);
      if (!name || !name.trim()) return;
      const id = await db.imagePresets.add({ provider, name: name.trim(), settings });
      selectedPresetIds[provider] = id;
      alert('预设已创建');
    }
    await loadImagePresetDropdown(provider);
  }

  async function deletePreset(provider) {
    if (!selectedPresetIds[provider]) return;
    const confirmed = await showCustomConfirm('删除预设', '确定删除此预设吗？绑定它的角色会回退到全局设置。', { confirmButtonClass: 'btn-danger' });
    if (!confirmed) return;
    const id = selectedPresetIds[provider];
    await db.imagePresets.delete(id);
    const field = provider === 'imagen' ? 'imagenPresetId' : 'openaiImagePresetId';
    const chats = await db.chats.toArray();
    for (const chat of chats) {
      if (chat.settings?.[field] === id) {
        delete chat.settings[field];
        await db.chats.put(chat);
      }
    }
    selectedPresetIds[provider] = null;
    await loadImagePresetDropdown(provider);
  }

  async function loadChatImagePresetBindings(chat) {
    if (!chat) return;
    const naiSelect = document.getElementById('chat-nai-preset-select');
    const imagenSelect = document.getElementById('chat-imagen-preset-select');
    const openaiSelect = document.getElementById('chat-openai-preset-select');
    if (naiSelect) {
      const presets = await db.naiPresets.toArray();
      naiSelect.innerHTML = '<option value="">不绑定</option>' +
        presets.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');
      naiSelect.value = chat.settings?.naiPresetId ? String(chat.settings.naiPresetId) : '';
    }
    if (imagenSelect) {
      const presets = await db.imagePresets.where('provider').equals('imagen').toArray();
      imagenSelect.innerHTML = '<option value="">不绑定</option>' +
        presets.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');
      imagenSelect.value = chat.settings?.imagenPresetId ? String(chat.settings.imagenPresetId) : '';
    }
    if (openaiSelect) {
      const presets = await db.imagePresets.where('provider').equals('openai').toArray();
      openaiSelect.innerHTML = '<option value="">不绑定</option>' +
        presets.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');
      openaiSelect.value = chat.settings?.openaiImagePresetId ? String(chat.settings.openaiImagePresetId) : '';
    }
  }

  async function saveChatImagePresetBinding(field, value) {
    if (!state.activeChatId) return;
    const chat = state.chats[state.activeChatId];
    if (!chat) return;
    if (value) chat.settings[field] = Number(value);
    else delete chat.settings[field];
    await db.chats.put(chat);
  }

  function bindPresetUi(provider) {
    const prefix = provider === 'imagen' ? 'imagen' : 'openai';
    document.getElementById(`${prefix}-preset-select`)?.addEventListener('change', event => handlePresetChange(provider, event.target.value));
    document.getElementById(`save-${prefix}-preset-btn`)?.addEventListener('click', () => savePreset(provider, false));
    document.getElementById(`update-${prefix}-preset-btn`)?.addEventListener('click', () => savePreset(provider, true));
    document.getElementById(`delete-${prefix}-preset-btn`)?.addEventListener('click', () => deletePreset(provider));
  }

  function bindChatPresetUi() {
    document.getElementById('chat-nai-preset-select')?.addEventListener('change', e => saveChatImagePresetBinding('naiPresetId', e.target.value));
    document.getElementById('chat-imagen-preset-select')?.addEventListener('change', e => saveChatImagePresetBinding('imagenPresetId', e.target.value));
    document.getElementById('chat-openai-preset-select')?.addEventListener('change', e => saveChatImagePresetBinding('openaiImagePresetId', e.target.value));
  }

  function initImagePresetUi() {
    bindPresetUi('imagen');
    bindPresetUi('openai');
    bindChatPresetUi();
    loadImagePresetDropdown('imagen');
    loadImagePresetDropdown('openai');
  }

  window.loadImagePresetDropdown = loadImagePresetDropdown;
  window.loadChatImagePresetBindings = loadChatImagePresetBindings;
  window.initImagePresetUi = initImagePresetUi;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initImagePresetUi);
  } else {
    initImagePresetUi();
  }
})();
