// ========== 字体预设管理 ==========

  async function loadFontPresetsDropdown() {
    const selectEl = document.getElementById('font-preset-select');
    if (!selectEl) return;
    const presets = await db.appearancePresets.where('type').equals('font').toArray();
    selectEl.innerHTML = '<option value="">-- 选择一个预设 --</option>';
    presets.forEach(preset => {
      const option = document.createElement('option');
      option.value = preset.id;
      option.textContent = preset.name;
      selectEl.appendChild(option);
    });
  }


  async function handleFontPresetSelectionChange() {
    const selectEl = document.getElementById('font-preset-select');
    const selectedId = parseInt(selectEl.value);
    if (isNaN(selectedId)) return;

    const generation = ++fontDraftGeneration;
    let preset;
    try { preset = await db.appearancePresets.get(selectedId); }
    catch (_) { fontNotice('字体预设读取失败，请重试。', 'error'); return; }
    if (generation !== fontDraftGeneration) return;
    if (preset) {
      if (fontBusy || fontReading) return;
      const draft = getFontDraft();
      if (preset.value && typeof preset.value === 'object') {
        Object.assign(draft, normalizeFontSettings(preset.value));
      } else {
        // 旧链接预设只替换来源，保留当前字号和范围。
        draft.fontUrl = String(preset.value || '');
        draft.fontSourceMode = draft.fontUrl ? 'url' : 'default';
      }
      syncFontDraftUI();
      setFontStatus('字体预设已载入编辑区；保存并应用后生效。');
      await updateFontPreview();
    }
  }


  async function saveFontPreset() {
    if (fontBusy || fontReading) { fontNotice('请等待当前字体操作完成。'); return; }
    const value = normalizeFontSettings(getFontDraft());
    const name = await showCustomPrompt('保存字体预设', '请输入预设名称（保存来源、字号和范围）');
    if (!name || !name.trim()) return;

    try {
    const existingPreset = await db.appearancePresets.where({
      name: name.trim(),
      type: 'font'
    }).first();
    if (existingPreset) {
      const confirmed = await showCustomConfirm('覆盖预设', `名为 "${name.trim()}" 的预设已存在。要覆盖它吗？`, {
        confirmButtonClass: 'btn-danger'
      });
      if (!confirmed) return;

      await db.appearancePresets.update(existingPreset.id, {
        value
      });
    } else {
      await db.appearancePresets.add({
        name: name.trim(),
        type: 'font',
        value
      });
    }

    await loadFontPresetsDropdown();
    fontNotice('字体预设已保存，正式界面设置未改变。', 'success');
    } catch (_) { fontNotice('字体预设保存失败，请重试。', 'error'); }
  }


  async function deleteFontPreset() {
    const selectEl = document.getElementById('font-preset-select');
    const selectedId = parseInt(selectEl.value);

    if (isNaN(selectedId)) {
      fontNotice('请先选择一个要删除的预设。');
      return;
    }

    let preset;
    try { preset = await db.appearancePresets.get(selectedId); }
    catch (_) { fontNotice('字体预设读取失败，请重试。', 'error'); return; }
    if (!preset) return;

    const confirmed = await showCustomConfirm('删除预设', `确定要删除预设 "${preset.name}" 吗？`, {
      confirmButtonClass: 'btn-danger'
    });
    if (confirmed) {
      try {
        await db.appearancePresets.delete(selectedId);
        await loadFontPresetsDropdown();
        fontNotice('预设已删除，当前字体设置保留。', 'success');
      } catch (_) { fontNotice('预设删除失败，请重试。', 'error'); }
    }
  }


