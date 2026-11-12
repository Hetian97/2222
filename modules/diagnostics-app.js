// In-app diagnostics for mobile use. Data comes from diagnostics-core.js.
(function () {
  'use strict';

  const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));

  function formatBytes(value) {
    const bytes = Number(value) || 0;
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    return `${(bytes / Math.pow(1024, index)).toFixed(index ? 1 : 0)} ${units[index]}`;
  }

  function formatTime(timestamp) {
    const value = Number(timestamp) || 0;
    if (!value) return '—';
    return new Date(value).toLocaleString('zh-CN', { hour12: false });
  }

  function formatUptime(start) {
    const seconds = Math.max(0, Math.floor((Date.now() - (Number(start) || Date.now())) / 1000));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return `${hours} 小时 ${minutes} 分钟`;
  }

  function getDiagnostics() {
    return window.EPhoneDiagnostics || null;
  }

  function renderCards(snapshot) {
    const heap = snapshot.heap;
    const heapText = heap ? `${formatBytes(heap.used)} / ${formatBytes(heap.limit)}` : '不可用（非 Chromium）';
    const heapPercent = heap && heap.limit ? Math.round(heap.used / heap.limit * 100) : 0;
    const cards = [
      ['JS 堆内存', heapText, heap ? `${heapPercent}%` : ''],
      ['DOM 节点', String(snapshot.domNodes || 0), snapshot.domNodes > 10000 ? '偏高' : ''],
      ['活跃定时器', String(snapshot.activeIntervals || 0), `创建 ${snapshot.intervalsCreated || 0} / 清理 ${snapshot.intervalsCleared || 0}`],
      ['长任务', String(snapshot.longTaskCount || 0), snapshot.longTaskMax ? `最长 ${Math.round(snapshot.longTaskMax)} ms` : ''],
      ['屏幕 / 弹窗', `${snapshot.screens || 0} / ${snapshot.visibleModals || 0}`, snapshot.visibility || ''],
      ['视口', snapshot.viewport || '—', '']
    ];
    return cards.map(([label, value, note]) => `
      <div style="padding:10px; border-radius:8px; background:var(--secondary-bg); border:1px solid var(--border-color);">
        <div class="settings-desc">${esc(label)}</div>
        <div style="font-size:16px; font-weight:600; margin-top:3px;">${esc(value)}</div>
        ${note ? `<div class="settings-desc" style="margin-top:2px;">${esc(note)}</div>` : ''}
      </div>`).join('');
  }

  function formatChars(chars) {
    const value = Number(chars) || 0;
    if (value >= 1000000) return `${(value / 1000000).toFixed(1)}M 字符`;
    if (value >= 1000) return `${(value / 1000).toFixed(1)}k 字符`;
    return `${value} 字符`;
  }

  function renderBreakdown(breakdown = {}) {
    const rows = [
      ['聊天数量', `${breakdown.chatCount || 0} 个`],
      ['消息总数', `${breakdown.totalMessages || 0} 条`],
      ['最大历史长度', `${breakdown.largestHistory || 0} 条`],
      ['聊天历史字符', formatChars(breakdown.historyChars)],
      ['结构化记忆', `${breakdown.structuredEntries || 0} 条 / ${formatChars(breakdown.structuredChars)}`],
      ['向量片段', `${breakdown.vectorFragments || 0} 个`],
      ['向量核心 / 时间线', `${breakdown.vectorCoreMemories || 0} / ${breakdown.vectorTimelines || 0}`],
      ['API 历史', `${breakdown.apiHistoryEntries || 0} 条`],
      ['localStorage', formatBytes(breakdown.localStorageBytes)]
    ];
    return `<div style="margin-top:16px;"><div class="settings-desc" style="margin-bottom:4px;">数据分类</div>${rows.map(([label, value]) => `<div style="display:flex; justify-content:space-between; gap:10px; padding:6px 0; border-bottom:1px solid var(--border-color,#eee); font-size:12px;"><span>${esc(label)}</span><span class="settings-desc">${esc(value)}</span></div>`).join('')}</div>`;
  }

  function renderErrors(errors) {
    if (!errors.length) return '<div class="settings-desc" style="padding:12px 0;">还没有记录到错误。</div>';
    return errors.slice(-20).reverse().map(error => `
      <div style="padding:9px 0; border-bottom:1px solid var(--border-color,#eee); font-size:12px; line-height:1.5;">
        <div style="color:#c0392b; font-weight:600;">${esc(error.kind || 'error')} · ${esc(formatTime(error.at))}</div>
        <div style="margin-top:3px; white-space:pre-wrap;">${esc(error.message || '')}</div>
        ${error.source ? `<div class="settings-desc" style="margin-top:2px;">${esc(error.source)}:${esc(error.line || 0)}</div>` : ''}
      </div>`).join('');
  }

  function renderSamples(samples) {
    if (!samples.length) return '<div class="settings-desc" style="padding:12px 0;">还没有采样数据。应用运行 30 秒后会开始记录。</div>';
    const last = samples.slice(-8).reverse();
    return last.map(sample => {
      const heap = sample.heap;
      return `<div style="display:flex; justify-content:space-between; gap:8px; padding:6px 0; border-bottom:1px solid var(--border-color,#eee); font-size:12px;">
        <span>${esc(formatTime(sample.at))}</span>
        <span class="settings-desc">堆 ${heap ? formatBytes(heap.used) : '—'} · DOM ${esc(sample.domNodes)} · 定时器 ${esc(sample.activeIntervals)}</span>
      </div>
      ${sample.memoryBreakdown ? `<div class="settings-desc" style="padding:0 0 6px; font-size:11px;">消息 ${esc(sample.memoryBreakdown.totalMessages)} · 历史 ${formatChars(sample.memoryBreakdown.historyChars)} · 结构化 ${formatChars(sample.memoryBreakdown.structuredChars)} · 向量 ${esc(sample.memoryBreakdown.vectorFragments)}</div>` : ''}`;
    }).join('');
  }

  function render() {
    const container = document.getElementById('diagnostics-content');
    if (!container) return;
    const diagnostics = getDiagnostics();
    if (!diagnostics) {
      container.innerHTML = '<div style="padding:30px; text-align:center; color:#c0392b;">诊断模块未加载。请刷新页面。</div>';
      return;
    }
    const snapshot = diagnostics.getSnapshot();
    const errors = diagnostics.getErrors();
    const samples = diagnostics.getSamples();
    const previous = diagnostics.getPreviousSession();
    const abnormal = previous && !previous.closed;
    container.innerHTML = `
      <div style="padding:14px 0 10px; display:flex; align-items:center; justify-content:space-between;">
        <h2 style="margin:0;">运行诊断</h2>
        <span class="settings-desc">${esc(formatUptime(performance.timeOrigin))}</span>
      </div>
      ${abnormal ? `<div style="padding:10px; margin-bottom:10px; border-radius:8px; background:rgba(192,57,43,.10); color:#c0392b; font-size:12px; line-height:1.6;">上次会话未正常结束：${esc(formatTime(previous.last))}。可能是闪退、系统回收或被强制关闭。</div>` : ''}
      <div style="display:grid; grid-template-columns:repeat(2, minmax(0, 1fr)); gap:8px;">${renderCards(snapshot)}</div>
      ${renderBreakdown(snapshot.memoryBreakdown)}
      <div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:12px;">
        <button type="button" class="settings-mini-btn" id="diagnostics-refresh">刷新</button>
        <button type="button" class="settings-mini-btn" id="diagnostics-export">导出诊断日志</button>
        <button type="button" class="settings-mini-btn" id="diagnostics-clear">清空错误</button>
      </div>
      <div style="margin-top:16px;"><div class="settings-desc" style="margin-bottom:4px;">错误日志（最近 20 条）</div>${renderErrors(errors)}</div>
      <div style="margin-top:16px;"><div class="settings-desc" style="margin-bottom:4px;">内存采样（最近 8 次）</div>${renderSamples(samples)}</div>
      <div class="settings-desc" style="margin-top:16px; line-height:1.6;">诊断数据只保存在本机 localStorage，不会上传。若闪退后重新打开，这里仍能看到之前的记录。</div>`;
    document.getElementById('diagnostics-refresh')?.addEventListener('click', render);
    document.getElementById('diagnostics-export')?.addEventListener('click', exportReport);
    document.getElementById('diagnostics-clear')?.addEventListener('click', () => {
      diagnostics.clearErrors();
      render();
    });
  }

  function exportReport() {
    const diagnostics = getDiagnostics();
    if (!diagnostics) return;
    const report = diagnostics.exportReport();
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `EPhone-Diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  function openDiagnosticsApp() {
    if (typeof showScreen === 'function') showScreen('diagnostics-screen');
    render();
  }

  document.getElementById('diagnostics-refresh-btn')?.addEventListener('click', render);
  window.openDiagnosticsApp = openDiagnosticsApp;
})();
