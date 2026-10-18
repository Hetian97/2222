// focus-timer.js - 可恢复、可独立使用的番茄钟与角色陪伴

const FOCUS_SETTINGS_KEY = 'focusTimerSettings';
const FOCUS_ACTIVE_ID = 'main';
const FOCUS_OWNER_KEY = 'focusTimerOwner';
const FOCUS_DEFAULTS = Object.freeze({ focusMinutes: 25, shortBreakMinutes: 5, longBreakMinutes: 15, roundsPerCycle: 4, autoCallInterval: 0, minValidMinutes: 1, autoStartBreak: false, autoStartNext: false, notificationEnabled: true, soundEnabled: true, vibrationEnabled: true, syncToChat: false });

let focusTimer = null;
let focusStartTime = null;
let focusDuration = 25 * 60;
let focusElapsed = 0;
let focusIsRunning = false;
let focusIsBreak = false;
let focusCompanionId = null;
let focusSessionId = null;
let focusGoal = '';
let autoCallTimer = null;
let autoCallInterval = 0;
let focusSettings = loadFocusSettings();
let focusActiveState = null;
let focusCompleting = false;
let focusStarting = false;
let focusAiPending = false;
const focusAiPendingKeys = new Set();
let focusLastFocusedElement = null;
let focusDraftPhase = 'focus';
let focusDraftRound = 1;
const focusOwnerId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const focusChannel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('ephone-focus-timer') : null;
focusDuration = focusSettings.focusMinutes * 60;
autoCallInterval = focusSettings.autoCallInterval;

function showFocusToast(message, type = 'info') {
  if (typeof showToast === 'function') showToast(message, type);
  else if (typeof showCustomAlert === 'function') showCustomAlert(type === 'error' ? '操作失败' : '番茄钟', message);
  else console[type === 'error' ? 'error' : 'log'](`[番茄钟] ${message}`);
}

function escapeFocusHTML(value) {
  if (typeof escapeHTML === 'function') return escapeHTML(String(value ?? ''));
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function safeFocusUrl(value) {
  const url = String(value || '');
  return /^(https?:|data:image\/)/i.test(url) ? escapeFocusHTML(url) : '';
}

function readFiniteInteger(value, fallback, min, max) {
  const number = Number(value);
  return Number.isFinite(number) && Number.isInteger(number) && number >= min && number <= max ? number : fallback;
}

function loadFocusSettings() {
  let stored = {};
  try { stored = JSON.parse(localStorage.getItem(FOCUS_SETTINGS_KEY) || '{}') || {}; } catch (_) {}
  const legacyDuration = Number(localStorage.getItem('focusDuration'));
  const legacyInterval = Number(localStorage.getItem('autoCallInterval'));
  return {
    ...FOCUS_DEFAULTS, ...stored,
    focusMinutes: readFiniteInteger(stored.focusMinutes ?? legacyDuration / 60, 25, 1, 120),
    shortBreakMinutes: readFiniteInteger(stored.shortBreakMinutes, 5, 1, 60),
    longBreakMinutes: readFiniteInteger(stored.longBreakMinutes, 15, 1, 120),
    roundsPerCycle: readFiniteInteger(stored.roundsPerCycle, 4, 1, 12),
    autoCallInterval: readFiniteInteger(stored.autoCallInterval ?? legacyInterval, 0, 0, 60),
    minValidMinutes: readFiniteInteger(stored.minValidMinutes, 1, 1, 120),
    autoStartBreak: stored.autoStartBreak === true, autoStartNext: stored.autoStartNext === true,
    notificationEnabled: stored.notificationEnabled !== false, soundEnabled: stored.soundEnabled !== false,
    vibrationEnabled: stored.vibrationEnabled !== false, syncToChat: stored.syncToChat === true
  };
}

function persistFocusSettings() {
  localStorage.setItem(FOCUS_SETTINGS_KEY, JSON.stringify(focusSettings));
  localStorage.setItem('focusDuration', String(focusSettings.focusMinutes * 60));
  localStorage.setItem('autoCallInterval', String(focusSettings.autoCallInterval));
}

function parseStoredCompanionId(raw) {
  if (raw === null || raw === '') return null;
  return /^-?\d+$/.test(raw) ? Number(raw) : raw;
}

function localDateKey(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function normalizeLegacyDate(value) {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : localDateKey(date);
}

function phaseLabel(phase = focusActiveState?.phase || focusDraftPhase) { return phase === 'shortBreak' ? '短休息' : phase === 'longBreak' ? '长休息' : phase === 'stopwatch' ? '自由计时' : '专注'; }
function isBreakPhase(phase = focusActiveState?.phase) { return phase === 'shortBreak' || phase === 'longBreak'; }
function isFocusWorkPhase(phase) { return phase === 'focus' || phase === 'stopwatch'; }
function getPhaseDuration(phase) { return (phase === 'shortBreak' ? focusSettings.shortBreakMinutes : phase === 'longBreak' ? focusSettings.longBreakMinutes : phase === 'stopwatch' ? 1440 : focusSettings.focusMinutes) * 60; }

function currentElapsedSeconds(now = Date.now()) {
  if (!focusActiveState) return focusElapsed;
  const base = Number(focusActiveState.elapsedBeforePause) || 0;
  return focusActiveState.status === 'running' ? Math.max(0, Math.floor(base + (now - Number(focusActiveState.runStartedAt || now)) / 1000)) : Math.max(0, Math.floor(base));
}

function acquireFocusOwnership() {
  let owner = null;
  try { owner = JSON.parse(localStorage.getItem(FOCUS_OWNER_KEY) || 'null'); } catch (_) {}
  if (owner && owner.id !== focusOwnerId && Date.now() - Number(owner.updatedAt || 0) < 15000) return false;
  localStorage.setItem(FOCUS_OWNER_KEY, JSON.stringify({ id: focusOwnerId, updatedAt: Date.now() }));
  return true;
}
function hasFocusOwnership() {
  try { return JSON.parse(localStorage.getItem(FOCUS_OWNER_KEY) || 'null')?.id === focusOwnerId; } catch (_) { return false; }
}
function refreshFocusOwnership() { if (focusActiveState?.status === 'running') localStorage.setItem(FOCUS_OWNER_KEY, JSON.stringify({ id: focusOwnerId, updatedAt: Date.now() })); }
function releaseFocusOwnership() { try { const owner = JSON.parse(localStorage.getItem(FOCUS_OWNER_KEY) || 'null'); if (owner?.id === focusOwnerId) localStorage.removeItem(FOCUS_OWNER_KEY); } catch (_) {} }

async function saveActiveState() {
  if (!window.db?.focusActiveState) return;
  if (focusActiveState) await db.focusActiveState.put({ ...focusActiveState, id: FOCUS_ACTIVE_ID, updatedAt: Date.now() });
  else await db.focusActiveState.delete(FOCUS_ACTIVE_ID);
  focusChannel?.postMessage({ type: 'state', ownerId: focusOwnerId });
}

async function openFocusTimer() {
  showScreen('focus-timer-screen');
  focusSettings = loadFocusSettings();
  autoCallInterval = focusSettings.autoCallInterval;
  focusCompanionId = parseStoredCompanionId(localStorage.getItem('focusCompanionId'));
  await restoreFocusState();
  await renderFocusTimer();
  await updateFocusStats();
  if (focusActiveState?.status === 'running') {
    if (acquireFocusOwnership()) startFocusTicker();
    else showFocusToast('番茄钟正在另一个页面计时，本页已保持只读状态');
  }
}

async function restoreFocusState() {
  if (!window.db?.focusActiveState) return;
  const saved = await db.focusActiveState.get(FOCUS_ACTIVE_ID);
  if (!saved || !['running', 'paused'].includes(saved.status)) return;
  focusActiveState = saved;
  focusSessionId = saved.sessionId || null;
  focusCompanionId = saved.companionId ?? focusCompanionId;
  focusGoal = saved.goal || '';
  focusDuration = readFiniteInteger(saved.duration, getPhaseDuration(saved.phase), 1, 86400);
  focusElapsed = currentElapsedSeconds(); focusIsRunning = saved.status === 'running'; focusIsBreak = isBreakPhase(saved.phase); focusStartTime = Number(saved.runStartedAt) || Date.now();
  const ownsTimer = saved.status !== 'running' || acquireFocusOwnership();
  if (focusElapsed >= focusDuration && !saved.settled && ownsTimer) await completeCurrentPhase({ restored: true });
}

async function getAvailableFocusTodos() {
  if (!window.db?.chats) return [];
  const result = [];
  (await db.chats.toArray()).forEach(chat => (chat.todoList || []).forEach(todo => { if (todo.status !== 'completed') result.push({ chatId: chat.id, chatName: chat.name, ...todo }); }));
  return result.slice(0, 100);
}

async function renderFocusTimer() {
  const container = document.getElementById('focus-timer-content');
  if (!container) return;
  const stats = await getFocusStats();
  const todos = await getAvailableFocusTodos();
  const active = Boolean(focusActiveState), breakMode = isBreakPhase();
  const duration = active ? focusActiveState.duration : getPhaseDuration(focusDraftPhase);
  const elapsed = active ? currentElapsedSeconds() : 0;
  const round = readFiniteInteger(focusActiveState?.round ?? focusDraftRound, 1, 1, focusSettings.roundsPerCycle);
  const taskValue = focusActiveState?.taskId ? `${focusActiveState.taskChatId}::${focusActiveState.taskId}` : '';
  const todoOptions = todos.map(todo => `<option value="${escapeFocusHTML(`${todo.chatId}::${todo.id}`)}" ${taskValue === `${todo.chatId}::${todo.id}` ? 'selected' : ''}>${escapeFocusHTML(todo.chatName)} · ${escapeFocusHTML(todo.content)}</option>`).join('');
  container.innerHTML = `
    <main class="focus-timer-main ${breakMode ? 'is-break' : ''}">
      <section class="focus-session-card" aria-label="当前番茄钟">
        <div class="focus-phase-row"><span id="focus-phase-badge" class="focus-phase-badge">${active ? phaseLabel() : `准备${phaseLabel(focusDraftPhase)}`}</span><span class="focus-round-label">第 ${round}/${focusSettings.roundsPerCycle} 轮</span></div>
        <div class="focus-mode-switch" ${active ? 'hidden' : ''}><button type="button" class="${focusDraftPhase === 'focus' ? 'active' : ''}" onclick="setFocusDraftPhase('focus')">专注</button><button type="button" class="${focusDraftPhase === 'shortBreak' ? 'active' : ''}" onclick="setFocusDraftPhase('shortBreak')">短休</button><button type="button" class="${focusDraftPhase === 'longBreak' ? 'active' : ''}" onclick="setFocusDraftPhase('longBreak')">长休</button><button type="button" class="${focusDraftPhase === 'stopwatch' ? 'active' : ''}" onclick="setFocusDraftPhase('stopwatch')">自由计时</button></div>
        <label class="focus-goal-field"><span>本次目标</span><input id="focus-goal-input" type="text" maxlength="120" value="${escapeFocusHTML(active ? focusActiveState.goal || '' : '')}" placeholder="要专注完成什么？（可留空）" ${active ? 'disabled' : ''}></label>
        <label class="focus-task-field"><span>关联待办</span><select id="focus-task-select" ${active ? 'disabled' : ''}><option value="">不关联待办</option>${todoOptions}</select></label>
        <div class="focus-timer-display" role="timer" aria-live="off" aria-label="计时时间"><svg class="focus-timer-circle" viewBox="0 0 200 200" aria-hidden="true"><circle class="focus-timer-bg" cx="100" cy="100" r="90"></circle><circle class="focus-timer-progress" cx="100" cy="100" r="90" id="focus-progress-circle"></circle></svg><div class="focus-timer-center"><div class="focus-timer-time" id="focus-timer-time">${formatFocusDuration((active ? focusActiveState.phase : focusDraftPhase) === 'stopwatch' ? elapsed : Math.max(0, duration - elapsed))}</div><div id="focus-timer-status" class="focus-timer-status">${active ? (focusActiveState.status === 'paused' ? '已暂停' : phaseLabel()) : focusDraftPhase === 'stopwatch' ? '从 00:00 开始' : `${Math.round(duration / 60)} 分钟`}</div></div></div>
        <div class="focus-controls"><button type="button" class="focus-btn focus-btn-primary" id="focus-start-btn" onclick="toggleFocus()">${!active ? `开始${phaseLabel(focusDraftPhase)}` : focusActiveState.status === 'running' ? '暂停' : '继续'}</button><button type="button" class="focus-btn focus-btn-secondary" onclick="resetFocus()">重置</button><button type="button" class="focus-btn focus-btn-secondary" onclick="showFocusSettings()">设置</button></div>
        <div class="focus-running-actions" ${active ? '' : 'hidden'}>${breakMode ? '<button type="button" onclick="skipFocusBreak()">跳过休息</button>' : `<button type="button" onclick="finishFocusEarly()">${focusActiveState?.phase === 'stopwatch' ? '完成计时' : '提前完成'}</button><button type="button" onclick="abandonFocus()">放弃</button>`}</div>
      </section>
      <section class="focus-stats" aria-label="专注统计"><div class="focus-stat-item"><div class="focus-stat-label">今日完成</div><div class="focus-stat-value">${stats.todayCount}个</div></div><div class="focus-stat-item"><div class="focus-stat-label">连续天数</div><div class="focus-stat-value">${stats.streakDays}天</div></div><div class="focus-stat-item"><div class="focus-stat-label">总计</div><div class="focus-stat-value">${stats.totalCount}个</div></div><div class="focus-stat-item"><div class="focus-stat-label">今日时长</div><div class="focus-stat-value">${stats.todayMinutes}分钟</div></div></section>
      <section class="focus-companion-section"><div class="focus-section-heading"><span>陪伴角色</span><span class="focus-section-hint">可选，不影响计时</span></div><button type="button" id="focus-companion-display" class="focus-companion-display" onclick="selectFocusCompanion()">${focusCompanionId ? '' : '<span class="focus-no-companion">选择陪伴角色</span>'}</button></section>
      <section class="focus-messages-section"><div class="focus-messages-header"><span>陪伴动态</span><div class="focus-message-tools"><button type="button" class="focus-view-btn active" data-focus-view="messages" onclick="switchFocusView('messages')">消息</button><button type="button" class="focus-view-btn" data-focus-view="history" onclick="switchFocusView('history')">历史</button><button type="button" class="focus-call-btn" onclick="callFocusCompanion()" ${!focusCompanionId ? 'disabled' : ''}>呼叫TA</button></div></div><div id="focus-messages-list" class="focus-messages-list"><div class="focus-no-messages">暂无消息</div></div><div id="focus-history-list" class="focus-history-list" hidden></div></section>
    </main>`;
  updateFocusProgress(duration ? elapsed / duration * 100 : 0);
  if (focusCompanionId) await renderFocusCompanion();
  await loadFocusMessages();
}

async function renderFocusCompanion() {
  const display = document.getElementById('focus-companion-display');
  if (!display) return;
  if (!focusCompanionId) { display.innerHTML = '<span class="focus-no-companion">选择陪伴角色</span>'; return; }
  const chat = await db.chats.get(focusCompanionId);
  if (!chat) { focusCompanionId = null; localStorage.removeItem('focusCompanionId'); display.innerHTML = '<span class="focus-no-companion">原陪伴角色已不存在，点击重新选择</span>'; return; }
  display.innerHTML = `<span class="focus-companion-card"><img src="${safeFocusUrl(chat.settings?.aiAvatar) || 'icons/icon-192.png'}" class="focus-companion-avatar" alt=""><span class="focus-companion-info"><span class="focus-companion-name">${escapeFocusHTML(chat.name)}</span><span class="focus-companion-status">点击更换</span></span></span>`;
}

async function selectFocusCompanion() {
  if (focusActiveState) { showFocusToast('进行中的会话已固定陪伴角色，结束后可更换'); return; }
  const characters = await db.chats.filter(chat => !chat.isGroup).toArray();
  const list = document.getElementById('focus-companion-list');
  list.innerHTML = characters.length ? characters.map(char => `<button type="button" class="focus-companion-item ${char.id === focusCompanionId ? 'selected' : ''}" data-chat-id="${escapeFocusHTML(char.id)}"><img src="${safeFocusUrl(char.settings?.aiAvatar) || 'icons/icon-192.png'}" class="focus-companion-item-avatar" alt=""><span class="focus-companion-item-info"><span class="focus-companion-item-name">${escapeFocusHTML(char.name)}</span><span class="focus-companion-item-desc">${escapeFocusHTML(char.originalName || '')}</span></span>${char.id === focusCompanionId ? '<span class="focus-companion-item-check">当前</span>' : ''}</button>`).join('') : '<div class="focus-no-messages">还没有可选角色，仍可直接使用番茄钟</div>';
  list.querySelectorAll('.focus-companion-item').forEach(item => item.addEventListener('click', () => confirmFocusCompanion(parseStoredCompanionId(item.dataset.chatId))));
  openFocusModal('focus-companion-modal');
}

async function confirmFocusCompanion(chatId) {
  focusCompanionId = chatId;
  if (chatId === null) localStorage.removeItem('focusCompanionId'); else localStorage.setItem('focusCompanionId', String(chatId));
  closeFocusCompanionModal(); await renderFocusCompanion();
  const callButton = document.querySelector('.focus-call-btn'); if (callButton) callButton.disabled = !chatId;
  await loadFocusMessages(); showFocusToast(chatId === null ? '已关闭陪伴角色，计时功能保持可用' : '已选择陪伴角色');
}

function openFocusModal(id) { const modal = document.getElementById(id); if (!modal) return; focusLastFocusedElement = document.activeElement; modal.style.display = 'flex'; modal.querySelector('[tabindex="-1"]')?.focus(); }
function closeFocusModal(id) { const modal = document.getElementById(id); if (modal) modal.style.display = 'none'; focusLastFocusedElement?.focus?.(); }
function closeFocusCompanionModal() { closeFocusModal('focus-companion-modal'); }

async function toggleFocus() { if (focusStarting || focusCompleting) return; if (!focusActiveState) return startFocus(); if (focusActiveState.status === 'running') return pauseFocus(); return resumeFocus(); }

async function setFocusDraftPhase(phase) {
  if (focusActiveState || !['focus', 'shortBreak', 'longBreak', 'stopwatch'].includes(phase)) return;
  const goal = document.getElementById('focus-goal-input')?.value || '';
  const task = document.getElementById('focus-task-select')?.value || '';
  focusDraftPhase = phase;
  await renderFocusTimer();
  const input = document.getElementById('focus-goal-input');
  if (input) input.value = goal;
  const select = document.getElementById('focus-task-select');
  if (select && [...select.options].some(option => option.value === task)) select.value = task;
}

function readSelectedTask() {
  const select = document.getElementById('focus-task-select'); const raw = select?.value || '';
  if (!raw.includes('::')) return {};
  const separator = raw.lastIndexOf('::');
  return { taskChatId: parseStoredCompanionId(raw.slice(0, separator)), taskId: parseStoredCompanionId(raw.slice(separator + 2)), taskTitle: select.selectedOptions?.[0]?.textContent || '' };
}

async function startFocus(options = {}) {
  if (focusStarting || focusActiveState) return false;
  if (!acquireFocusOwnership()) { showFocusToast('另一个页面正在运行番茄钟，请回到该页面操作', 'error'); return false; }
  focusStarting = true;
  try {
    const phase = options.phase || focusDraftPhase; const duration = readFiniteInteger(options.duration, getPhaseDuration(phase), 1, 86400);
    const goal = isFocusWorkPhase(phase) ? String(options.goal ?? document.getElementById('focus-goal-input')?.value ?? '').trim().slice(0, 120) : '';
    const task = isFocusWorkPhase(phase) ? readSelectedTask() : {}; const round = readFiniteInteger(options.round ?? focusDraftRound, 1, 1, focusSettings.roundsPerCycle); const now = Date.now();
    const companionSnapshot = focusCompanionId;
    focusSessionId = await db.focusSessions.add({ companionId: companionSnapshot, startTime: new Date(now).toISOString(), duration, completed: false, stage: 'running', phase, goal, round, ...task, elapsedSeconds: 0, pauseCount: 0, createdAt: now });
    focusActiveState = { id: FOCUS_ACTIVE_ID, sessionId: focusSessionId, phase, status: 'running', duration, elapsedBeforePause: 0, runStartedAt: now, startedAt: now, goal, companionId: companionSnapshot, round, ...task, settled: false, eventKeys: [] };
    focusDuration = duration; focusElapsed = 0; focusGoal = goal; focusIsBreak = isBreakPhase(phase); focusIsRunning = true; focusStartTime = now;
    await saveActiveState(); await renderFocusTimer(); startFocusTicker();
    if (companionSnapshot) callFocusCompanionAuto(phase === 'focus' ? 'start' : 'break');
    return true;
  } catch (error) { releaseFocusOwnership(); console.error('[番茄钟] 启动失败:', error); showFocusToast('无法开始计时，请检查本地存储后重试', 'error'); return false; }
  finally { focusStarting = false; }
}

async function pauseFocus() {
  if (!focusActiveState || focusActiveState.status !== 'running') return;
  if (!hasFocusOwnership() && !acquireFocusOwnership()) { showFocusToast('当前计时由另一个页面控制', 'error'); return; }
  focusElapsed = currentElapsedSeconds(); focusActiveState.elapsedBeforePause = focusElapsed; focusActiveState.status = 'paused'; focusActiveState.pausedAt = Date.now(); focusIsRunning = false;
  stopFocusTicker(); stopAutoCallTimer(); releaseFocusOwnership(); focusActiveState.pauseCount = (focusActiveState.pauseCount || 0) + 1;
  await db.focusSessions.update(focusSessionId, { stage: 'paused', elapsedSeconds: focusElapsed, pauseCount: focusActiveState.pauseCount }); await saveActiveState(); updateFocusControls();
}

async function resumeFocus() {
  if (!focusActiveState || focusActiveState.status !== 'paused') return;
  if (!acquireFocusOwnership()) { showFocusToast('另一个页面正在运行番茄钟，请回到该页面操作', 'error'); return; }
  focusActiveState.status = 'running'; focusActiveState.runStartedAt = Date.now(); delete focusActiveState.pausedAt; focusStartTime = focusActiveState.runStartedAt; focusIsRunning = true;
  await db.focusSessions.update(focusSessionId, { stage: 'running' }); await saveActiveState(); startFocusTicker(); updateFocusControls();
}

function startFocusTicker() { stopFocusTicker(); focusTimer = setInterval(updateFocusTimer, 1000); updateFocusTimer(); startAutoCallTimer(); }
function stopFocusTicker() { if (focusTimer) clearInterval(focusTimer); focusTimer = null; }
function updateFocusTimer() { if (!focusActiveState || focusActiveState.status !== 'running') return; refreshFocusOwnership(); focusElapsed = currentElapsedSeconds(); const stopwatch = focusActiveState.phase === 'stopwatch', remaining = Math.max(0, focusActiveState.duration - focusElapsed); updateFocusDisplay(stopwatch ? focusElapsed : remaining); updateFocusProgress(stopwatch ? 0 : focusActiveState.duration ? focusElapsed / focusActiveState.duration * 100 : 0); if (!stopwatch && remaining <= 0) completeCurrentPhase(); }
function formatFocusDuration(seconds) { const safe = Math.max(0, Math.floor(Number(seconds) || 0)), hours = Math.floor(safe / 3600), minutes = Math.floor(safe % 3600 / 60), secs = safe % 60; return hours ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}` : `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`; }
function updateFocusDisplay(seconds) { const display = document.getElementById('focus-timer-time'); if (display) display.textContent = formatFocusDuration(seconds); document.title = focusActiveState ? `${formatFocusDuration(seconds)} · ${phaseLabel()} · EPhone` : 'EPhone'; }
function updateFocusProgress(percent) { const circle = document.getElementById('focus-progress-circle'); if (!circle) return; const circumference = 2 * Math.PI * 90, safePercent = Math.min(100, Math.max(0, Number(percent) || 0)); circle.style.strokeDasharray = `${circumference} ${circumference}`; circle.style.strokeDashoffset = String(circumference - safePercent / 100 * circumference); }
function updateFocusControls() { const button = document.getElementById('focus-start-btn'), status = document.getElementById('focus-timer-status'); if (button) button.textContent = !focusActiveState ? '开始专注' : focusActiveState.status === 'running' ? '暂停' : '继续'; if (status) status.textContent = focusActiveState?.status === 'paused' ? '已暂停' : focusActiveState ? phaseLabel() : `${focusSettings.focusMinutes} 分钟`; }

async function completeCurrentPhase(options = {}) {
  if (!focusActiveState || focusActiveState.settled || focusCompleting) return;
  if (focusActiveState.status === 'running' && !hasFocusOwnership() && !acquireFocusOwnership()) { showFocusToast('当前计时由另一个页面控制', 'error'); return; }
  focusCompleting = true; const finished = { ...focusActiveState, settled: true }; focusActiveState.settled = true; stopFocusTicker(); stopAutoCallTimer(); releaseFocusOwnership();
  try {
    const actualSeconds = Math.min(finished.duration, currentElapsedSeconds());
    await db.focusSessions.update(finished.sessionId, { endTime: new Date().toISOString(), completed: true, stage: 'completed', elapsedSeconds: actualSeconds, completionReason: options.early ? 'early' : options.skipped ? 'skipped' : 'timer', review: options.note || '' });
    if (isFocusWorkPhase(finished.phase)) { await incrementFocusStats(finished.sessionId); if (finished.companionId) callFocusCompanionAuto('complete', { ...finished, elapsedSeconds: actualSeconds }); }
    await clearCurrentFocusState(); notifyFocusFinished(finished.phase);
    if (finished.phase === 'focus') {
      const nextBreak = finished.round >= focusSettings.roundsPerCycle ? 'longBreak' : 'shortBreak';
      focusDraftPhase = nextBreak; focusDraftRound = finished.round;
      if (focusSettings.autoStartBreak) await startFocus({ phase: nextBreak, round: finished.round }); else { await renderFocusTimer(); showFocusToast(`专注完成，可以开始${phaseLabel(nextBreak)}`); }
    } else if (finished.phase === 'stopwatch') {
      focusDraftPhase = 'focus'; await renderFocusTimer(); showFocusToast('自由计时已完成并记录');
    } else {
      const nextRound = finished.phase === 'longBreak' ? 1 : Math.min(focusSettings.roundsPerCycle, finished.round + 1);
      focusDraftPhase = 'focus'; focusDraftRound = nextRound;
      if (focusSettings.autoStartNext) await startFocus({ phase: 'focus', round: nextRound }); else { await renderFocusTimer(); showFocusToast(options.skipped ? '已跳过休息' : '休息结束，准备下一轮专注'); }
    }
  } catch (error) { focusActiveState = { ...finished, settled: false }; await saveActiveState().catch(() => {}); console.error('[番茄钟] 结算失败:', error); showFocusToast('本次记录尚未结算，请重新打开番茄钟重试', 'error'); }
  finally { focusCompleting = false; }
}

async function clearCurrentFocusState() { focusActiveState = null; focusSessionId = null; focusGoal = ''; focusElapsed = 0; focusIsRunning = false; focusIsBreak = false; focusDuration = focusSettings.focusMinutes * 60; document.title = 'EPhone'; await saveActiveState(); }

async function resetFocus() {
  if (!focusActiveState) { focusElapsed = 0; updateFocusDisplay(focusSettings.focusMinutes * 60); updateFocusProgress(0); return; }
  const confirmed = typeof showCustomConfirm === 'function' ? await showCustomConfirm('重置番茄钟', isBreakPhase() ? '确定结束当前休息并回到准备状态吗？' : '确定放弃当前专注并重置吗？') : false;
  if (confirmed) await abandonCurrentSession('reset', '用户重置');
}

async function abandonCurrentSession(reason = 'abandoned', note = '') {
  if (!focusActiveState) return;
  if (focusActiveState.status === 'running' && !hasFocusOwnership() && !acquireFocusOwnership()) { showFocusToast('当前计时由另一个页面控制', 'error'); return; }
  const finished = { ...focusActiveState }, elapsed = currentElapsedSeconds(); stopFocusTicker(); stopAutoCallTimer(); releaseFocusOwnership();
  await db.focusSessions.update(finished.sessionId, { endTime: new Date().toISOString(), completed: false, stage: reason, elapsedSeconds: elapsed, review: note }); await clearCurrentFocusState(); await renderFocusTimer();
  if (isFocusWorkPhase(finished.phase) && finished.companionId) callFocusCompanionAuto('giveup', { ...finished, elapsedSeconds: elapsed });
}

function showFocusActionModal(mode) {
  if (!focusActiveState || isBreakPhase()) return; const early = mode === 'complete';
  document.getElementById('focus-action-title').textContent = early ? '提前完成' : '放弃专注'; document.getElementById('focus-action-description').textContent = early ? '确认后会按实际专注时长记录本次完成。' : '本次会保留为中断记录，不计入完成次数。'; document.getElementById('focus-action-note').value = '';
  document.getElementById('focus-action-confirm').onclick = async () => { const note = document.getElementById('focus-action-note').value.trim(); closeFocusActionModal(); if (early) { if (currentElapsedSeconds() < focusSettings.minValidMinutes * 60) { showFocusToast(`至少专注 ${focusSettings.minValidMinutes} 分钟后才能记为完成`, 'error'); return; } await completeCurrentPhase({ early: true, note }); } else await abandonCurrentSession('abandoned', note); };
  openFocusModal('focus-action-modal');
}
function closeFocusActionModal() { closeFocusModal('focus-action-modal'); }
function finishFocusEarly() { showFocusActionModal('complete'); }
function abandonFocus() { showFocusActionModal('abandon'); }
async function skipFocusBreak() { if (isBreakPhase()) await completeCurrentPhase({ skipped: true }); }
async function onFocusComplete() { return completeCurrentPhase(); }
async function startBreak() { return startFocus({ phase: 'shortBreak', round: focusActiveState?.round || 1 }); }

async function getWorldBookContentForFocus(chat) {
  try { const ids = [...(chat.settings?.linkedWorldBookIds || [])]; (await db.worldBooks.toArray()).forEach(book => { if (book.isGlobal && !ids.includes(book.id)) ids.push(book.id); }); if (!ids.length) return ''; const books = await db.worldBooks.where('id').anyOf(ids).toArray(); return books.flatMap(book => Array.isArray(book.entries) ? book.entries.map(entry => entry.content) : typeof book.content === 'string' ? [book.content] : []).filter(Boolean).join('\n\n'); }
  catch (error) { console.error('[番茄钟] 获取世界书失败:', error); return ''; }
}

async function getRecentMessagesForFocus(chat, limit = 20) { return Array.isArray(chat.history) ? chat.history.slice(-limit) : []; }

async function buildFocusPrompt(stage, focusData, companionId = focusCompanionId) {
  const chat = await db.chats.get(companionId); if (!chat) return null;
  const myNickname = chat.settings?.myNickname || localStorage.getItem('myNickname') || '我', worldBookContent = await getWorldBookContentForFocus(chat);
  let memoryText = '- (暂无)'; try { memoryText = typeof getMemoryContextForPromptAsync === 'function' ? await getMemoryContextForPromptAsync(chat, { queryText: focusData.goal || '专注陪伴' }) : typeof getMemoryContextForPrompt === 'function' ? getMemoryContextForPrompt(chat) : memoryText; } catch (_) {}
  const history = (await getRecentMessagesForFocus(chat, 20)).map(msg => `${msg.role === 'user' || msg.sender === 'user' ? myNickname : chat.name}: ${typeof msg.content === 'string' ? msg.content : '[非文本消息]'}`).join('\n');
  const goalLine = focusData.goal ? `\n- 本次目标：${focusData.goal}` : '';
  const prompts = { start: `${myNickname} 刚开始 ${focusData.duration} 分钟的专注。${goalLine}\n请简短鼓励 TA 开始。`, during: `${myNickname} 正在专注，已进行 ${focusData.elapsedMinutes} 分钟，还剩 ${focusData.remainingMinutes} 分钟。${goalLine}\n请自然陪伴，不要制造压力。`, complete: `${myNickname} 完成了本次专注。${goalLine}\n今日已完成 ${focusData.todayCount} 次，请肯定这次投入。`, giveup: `${myNickname} 在专注 ${focusData.elapsedMinutes} 分钟后结束计时。${goalLine}\n请自然回应，不要责备。`, break: `${myNickname} 进入 ${focusData.duration} 分钟的休息，请提醒 TA 放松。`, idle: `${myNickname} 打开了番茄钟，还没有开始计时，请简短回应。` };
  return `# 番茄钟专注陪伴\n\n你是：${chat.originalName || chat.name}\n角色设定：${chat.settings?.aiPersona || ''}\n用户设定：${chat.settings?.myPersona || ''}\n\n世界书：\n${worldBookContent || '(无)'}\n\n长期记忆：\n${memoryText || '(无)'}\n\n当前情景：\n${prompts[stage] || prompts.idle}\n\n最近聊天：\n${history || '(无)'}\n\n请直接回复陪伴内容，允许使用 Markdown，不要解释任务。`;
}

function buildFocusData(stateOverride = focusActiveState) { const duration = Number(stateOverride?.duration || focusSettings.focusMinutes * 60), elapsed = stateOverride?.elapsedSeconds ?? currentElapsedSeconds(); return { duration: Math.max(1, Math.round(duration / 60)), elapsedMinutes: Math.max(0, Math.floor(elapsed / 60)), remainingMinutes: Math.max(0, Math.ceil((duration - elapsed) / 60)), goal: stateOverride?.goal || focusGoal, round: stateOverride?.round || 1 }; }

async function callFocusCompanionAuto(stage, stateOverride = focusActiveState) {
  const companionId = stateOverride?.companionId ?? focusCompanionId;
  const eventKey = `${stateOverride?.sessionId || 'idle'}:${stage}`;
  if (!companionId || focusAiPendingKeys.has(eventKey)) return;
  if (stage !== 'during' && stage !== 'idle' && stateOverride?.eventKeys?.includes(eventKey)) return;
  focusAiPendingKeys.add(eventKey); focusAiPending = true; updateFocusCallButton();
  try {
    const stats = await getFocusStats(), data = { ...buildFocusData(stateOverride), ...stats }, prompt = await buildFocusPrompt(stage, data, companionId); if (!prompt) return;
    const response = await callFocusAPI(prompt, companionId); if (!String(response || '').trim()) throw new Error('API 返回了空内容');
    const messageId = await saveFocusMessage(stage, response, { sessionId: stateOverride?.sessionId || focusSessionId, companionId }); displayFocusMessage(response, { stage, timestamp: new Date().toISOString(), id: messageId });
    if (focusSettings.syncToChat) await syncFocusMessageToChat(companionId, response, stage, stateOverride?.sessionId || focusSessionId);
    if (focusActiveState && stage !== 'during' && stage !== 'idle') { focusActiveState.eventKeys = [...new Set([...(focusActiveState.eventKeys || []), eventKey])]; await saveActiveState(); }
  } catch (error) { console.error('[番茄钟] 呼叫角色失败:', error); if (stage === 'idle') showFocusToast(error.message || '呼叫失败，请重试', 'error'); }
  finally { focusAiPendingKeys.delete(eventKey); focusAiPending = focusAiPendingKeys.size > 0; updateFocusCallButton(); }
}

async function callFocusCompanion() { if (!focusCompanionId) { showFocusToast('请先选择陪伴角色', 'error'); return; } if (focusAiPending) return; showFocusToast('正在呼叫…'); await callFocusCompanionAuto(focusActiveState?.status === 'running' ? 'during' : 'idle', focusActiveState || { companionId: focusCompanionId, goal: document.getElementById('focus-goal-input')?.value || '' }); }

function getFocusApiConfig(chat, stored) { const globalConfig = window.state?.apiConfig || stored || {}, override = chat?.apiOverride || {}; return { proxyUrl: override.proxyUrl || globalConfig.proxyUrl, apiKey: override.apiKey || globalConfig.apiKey, model: override.model || globalConfig.model }; }

async function callFocusAPI(prompt, companionId = focusCompanionId) {
  const chat = await db.chats.get(companionId), stored = await db.apiConfig.get('main'), { proxyUrl, apiKey, model } = getFocusApiConfig(chat, stored);
  if (!proxyUrl || !apiKey || !model) throw new Error('请先在设置中配置可用的 API、密钥和模型');
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 45000);
  try {
    const isGemini = /generativelanguage\.googleapis\.com/i.test(proxyUrl); let url, body, headers = { 'Content-Type': 'application/json' };
    if (isGemini) { const base = proxyUrl.replace(/\/+$/, ''); url = `${base}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`; body = { contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { temperature: 0.8 } }; }
    else { url = `${proxyUrl.replace(/\/+$/, '')}/v1/chat/completions`; headers.Authorization = `Bearer ${apiKey}`; body = { model, messages: [{ role: 'user', content: prompt }], temperature: 0.8 }; }
    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal }); if (!response.ok) throw new Error(`API 调用失败（${response.status}）`);
    const data = await response.json(); return isGemini ? data.candidates?.[0]?.content?.parts?.map(part => part.text || '').join('') : data.choices?.[0]?.message?.content;
  } catch (error) { if (error.name === 'AbortError') throw new Error('呼叫超时，请稍后重试'); throw error; } finally { clearTimeout(timeout); }
}

async function saveFocusMessage(stage, message, options = {}) { return db.focusMessages.add({ sessionId: options.sessionId ?? focusSessionId, companionId: options.companionId ?? focusCompanionId, stage, message: String(message), rawContent: String(message), format: 'markdown', renderSchemaVersion: 1, timestamp: new Date().toISOString() }); }
async function syncFocusMessageToChat(companionId, message, stage, sessionId = focusSessionId) { const chat = await db.chats.get(companionId); if (!chat) return; if (!Array.isArray(chat.history)) chat.history = []; chat.history.push({ role: 'assistant', content: String(message), type: 'focus_companion', focusStage: stage, focusSessionId: sessionId, timestamp: Date.now() }); await db.chats.put(chat); if (window.state?.chats?.[companionId]) window.state.chats[companionId] = chat; }
function focusStageText(stage) { return ({ start: '开始', during: '途中', complete: '完成', giveup: '结束', break: '休息', manual: '手动呼叫', idle: '陪伴' })[stage] || '陪伴'; }

function displayFocusMessage(message, meta = {}) {
  const list = document.getElementById('focus-messages-list'); if (!list) return; list.querySelector('.focus-no-messages')?.remove();
  const item = document.createElement('article'); item.className = 'focus-message-item'; item.innerHTML = `<div class="focus-message-meta"><span>${escapeFocusHTML(focusStageText(meta.stage))}</span><time>${escapeFocusHTML(formatFocusMessageTime(meta.timestamp || Date.now()))}</time></div><div class="focus-message-content">${typeof window.renderSafeRichText === 'function' ? window.renderSafeRichText(String(message)) : escapeFocusHTML(message).replace(/\n/g, '<br>')}</div>`; list.appendChild(item); list.scrollTop = list.scrollHeight;
}
function formatFocusMessageTime(value) { const date = new Date(value); return Number.isNaN(date.getTime()) ? '' : date.toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }

async function loadFocusMessages() {
  const list = document.getElementById('focus-messages-list'); if (!list) return;
  if (!focusCompanionId) { list.innerHTML = '<div class="focus-no-messages">选择陪伴角色后，可在这里查看消息；计时本身不受影响</div>'; return; }
  const messages = await db.focusMessages.where('companionId').equals(focusCompanionId).reverse().limit(30).toArray(); list.innerHTML = '';
  if (!messages.length) list.innerHTML = '<div class="focus-no-messages">暂无消息</div>'; else messages.reverse().forEach(message => displayFocusMessage(message.rawContent ?? message.message, message));
}

async function switchFocusView(view) { document.querySelectorAll('.focus-view-btn').forEach(button => button.classList.toggle('active', button.dataset.focusView === view)); const messages = document.getElementById('focus-messages-list'), history = document.getElementById('focus-history-list'); messages.hidden = view !== 'messages'; history.hidden = view !== 'history'; if (view === 'history') await loadFocusHistory(); }
async function loadFocusHistory() { const container = document.getElementById('focus-history-list'); if (!container) return; const sessions = (await db.focusSessions.orderBy('startTime').reverse().limit(50).toArray()).filter(session => ['focus', 'stopwatch'].includes(session.phase || 'focus')); container.innerHTML = sessions.length ? sessions.map(session => { const elapsed = Number(session.elapsedSeconds ?? session.duration ?? 0), status = session.completed ? '已完成' : ['running', 'paused'].includes(session.stage) ? '异常中断' : '已中断'; return `<article class="focus-history-item"><div class="focus-history-main"><strong>${escapeFocusHTML(session.goal || session.taskTitle || '未填写目标')}</strong><span>${escapeFocusHTML(status)} · ${Math.max(0, Math.round(elapsed / 60))} 分钟</span></div><time>${escapeFocusHTML(formatFocusMessageTime(session.startTime))}</time>${session.review ? `<p>${escapeFocusHTML(session.review)}</p>` : ''}</article>`; }).join('') : '<div class="focus-no-messages">还没有专注记录</div>'; }

async function getFocusStats() {
  let stats = await db.focusStats.get('main'); if (!stats) stats = { id: 'main', todayCount: 0, totalCount: 0, streakDays: 0, lastFocusDate: null, settledSessionIds: [] };
  const today = localDateKey(); if (normalizeLegacyDate(stats.lastFocusDate) !== today) stats.todayCount = 0;
  const sessions = await db.focusSessions.toArray(); const todayMinutes = sessions.filter(session => session.completed && ['focus', 'stopwatch'].includes(session.phase || 'focus') && localDateKey(session.endTime || session.startTime) === today).reduce((sum, session) => sum + Number(session.elapsedSeconds ?? session.duration ?? 0), 0);
  return { ...stats, todayMinutes: Math.round(todayMinutes / 60) };
}
async function updateFocusStats() { const stats = await getFocusStats(); document.querySelectorAll('.focus-stat-value').forEach((element, index) => { element.textContent = index === 0 ? `${stats.todayCount}个` : index === 1 ? `${stats.streakDays}天` : index === 2 ? `${stats.totalCount}个` : `${stats.todayMinutes}分钟`; }); }

async function incrementFocusStats(sessionId = focusSessionId) {
  const stats = await db.focusStats.get('main') || { id: 'main', todayCount: 0, totalCount: 0, streakDays: 0, lastFocusDate: null, settledSessionIds: [] }, settled = Array.isArray(stats.settledSessionIds) ? stats.settledSessionIds : [];
  if (sessionId && settled.includes(sessionId)) return;
  const today = localDateKey(), last = normalizeLegacyDate(stats.lastFocusDate); if (last !== today) stats.todayCount = 0; stats.todayCount = Number(stats.todayCount || 0) + 1; stats.totalCount = Number(stats.totalCount || 0) + 1;
  if (!last) stats.streakDays = 1; else if (last !== today) { const diff = Math.round((new Date(`${today}T12:00:00`) - new Date(`${last}T12:00:00`)) / 86400000); stats.streakDays = diff === 1 ? Number(stats.streakDays || 0) + 1 : 1; }
  stats.lastFocusDate = today; if (sessionId) stats.settledSessionIds = [...settled.slice(-199), sessionId]; await db.focusStats.put(stats); await updateFocusStats();
}

function showFocusSettings() {
  const set = (id, value) => { const element = document.getElementById(id); if (element) element.value = String(value); }, check = (id, value) => { const element = document.getElementById(id); if (element) element.checked = Boolean(value); };
  set('focus-duration-input', focusSettings.focusMinutes); set('focus-short-break-input', focusSettings.shortBreakMinutes); set('focus-long-break-input', focusSettings.longBreakMinutes); set('focus-rounds-input', focusSettings.roundsPerCycle); set('auto-call-interval-input', focusSettings.autoCallInterval); set('focus-min-valid-input', focusSettings.minValidMinutes);
  check('focus-auto-break-input', focusSettings.autoStartBreak); check('focus-auto-next-input', focusSettings.autoStartNext); check('focus-notification-input', focusSettings.notificationEnabled); check('focus-sound-input', focusSettings.soundEnabled); check('focus-vibration-input', focusSettings.vibrationEnabled); check('focus-sync-chat-input', focusSettings.syncToChat);
  document.getElementById('focus-settings-error').textContent = ''; openFocusModal('focus-settings-modal');
}
function closeFocusSettings() { closeFocusModal('focus-settings-modal'); }

async function saveFocusSettings() {
  const error = document.getElementById('focus-settings-error');
  const integer = (id, label, min, max) => { const raw = document.getElementById(id).value.trim(), number = Number(raw); if (raw === '' || !Number.isFinite(number) || !Number.isInteger(number) || number < min || number > max) throw new Error(`${label}请输入 ${min}-${max} 之间的整数`); return number; };
  try {
    const next = { focusMinutes: integer('focus-duration-input', '专注时长', 1, 120), shortBreakMinutes: integer('focus-short-break-input', '短休息', 1, 60), longBreakMinutes: integer('focus-long-break-input', '长休息', 1, 120), roundsPerCycle: integer('focus-rounds-input', '每组专注次数', 1, 12), autoCallInterval: integer('auto-call-interval-input', '定时呼叫间隔', 0, 60), minValidMinutes: integer('focus-min-valid-input', '有效专注最低时长', 1, 120), autoStartBreak: document.getElementById('focus-auto-break-input').checked, autoStartNext: document.getElementById('focus-auto-next-input').checked, notificationEnabled: document.getElementById('focus-notification-input').checked, soundEnabled: document.getElementById('focus-sound-input').checked, vibrationEnabled: document.getElementById('focus-vibration-input').checked, syncToChat: document.getElementById('focus-sync-chat-input').checked };
    if (next.minValidMinutes > next.focusMinutes) throw new Error('有效专注最低时长不能大于专注时长');
    if (next.notificationEnabled && typeof Notification !== 'undefined' && Notification.permission === 'default') {
      try { await Notification.requestPermission(); } catch (_) {}
    }
    focusSettings = next; focusDuration = focusActiveState?.duration || next.focusMinutes * 60; autoCallInterval = next.autoCallInterval; persistFocusSettings(); closeFocusSettings(); if (!focusActiveState) await renderFocusTimer(); else if (focusActiveState.status === 'running') startAutoCallTimer(); showFocusToast(next.notificationEnabled && typeof Notification !== 'undefined' && Notification.permission === 'denied' ? '设置已保存；系统通知权限未开启，仍会使用页面内提醒' : '设置已保存');
  } catch (exception) { error.textContent = exception.message; }
}

function startAutoCallTimer() { stopAutoCallTimer(); const interval = Number(focusSettings.autoCallInterval); if (!focusActiveState || focusActiveState.status !== 'running' || isBreakPhase() || !focusCompanionId || !Number.isFinite(interval) || !Number.isInteger(interval) || interval < 1 || interval > 60) return; autoCallTimer = setInterval(() => { if (focusActiveState?.status === 'running' && !focusAiPending) callFocusCompanionAuto('during'); }, interval * 60000); }
function stopAutoCallTimer() { if (autoCallTimer) clearInterval(autoCallTimer); autoCallTimer = null; }
function updateFocusCallButton() { const button = document.querySelector('.focus-call-btn'); if (!button) return; button.disabled = !focusCompanionId || focusAiPending; button.textContent = focusAiPending ? '呼叫中…' : '呼叫TA'; }

function notifyFocusFinished(phase) {
  const work = isFocusWorkPhase(phase), title = work ? '专注完成' : '休息结束', body = work ? '做得很好，记得让自己休息一下。' : '准备好后可以开始下一轮专注。';
  if (focusSettings.notificationEnabled && typeof Notification !== 'undefined' && Notification.permission === 'granted') { try { new Notification(title, { body, icon: 'icons/icon-192.png', tag: `focus-${phase}` }); } catch (_) {} }
  if (focusSettings.vibrationEnabled && navigator.vibrate) navigator.vibrate([120, 80, 120]); if (focusSettings.soundEnabled) playFocusSound(); showFocusToast(`${title}：${body}`);
}
function playFocusSound() { try { const Context = window.AudioContext || window.webkitAudioContext; if (!Context) return; const context = new Context(), oscillator = context.createOscillator(), gain = context.createGain(); oscillator.frequency.value = 660; gain.gain.setValueAtTime(0.0001, context.currentTime); gain.gain.exponentialRampToValueAtTime(0.12, context.currentTime + 0.02); gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.45); oscillator.connect(gain).connect(context.destination); oscillator.start(); oscillator.stop(context.currentTime + 0.46); oscillator.onended = () => context.close(); } catch (_) {} }

function handleFocusKeydown(event) { if (event.key !== 'Escape') return; if (document.getElementById('focus-action-modal')?.style.display === 'flex') closeFocusActionModal(); else if (document.getElementById('focus-settings-modal')?.style.display === 'flex') closeFocusSettings(); else if (document.getElementById('focus-companion-modal')?.style.display === 'flex') closeFocusCompanionModal(); }

focusChannel?.addEventListener('message', async event => { if (event.data?.type !== 'state' || event.data.ownerId === focusOwnerId || !window.db?.focusActiveState) return; const saved = await db.focusActiveState.get(FOCUS_ACTIVE_ID); if (saved) { focusActiveState = saved; focusSessionId = saved.sessionId; focusIsRunning = saved.status === 'running'; focusIsBreak = isBreakPhase(saved.phase); } else { focusActiveState = null; focusSessionId = null; focusIsRunning = false; focusIsBreak = false; stopFocusTicker(); stopAutoCallTimer(); } if (document.getElementById('focus-timer-screen')?.classList.contains('active')) await renderFocusTimer(); });
window.addEventListener('storage', event => { if (event.key !== FOCUS_OWNER_KEY || focusActiveState?.status !== 'running') return; try { const owner = JSON.parse(event.newValue || 'null'); if (owner && owner.id !== focusOwnerId) { stopFocusTicker(); stopAutoCallTimer(); focusIsRunning = false; showFocusToast('计时已在另一个页面接管', 'error'); } } catch (_) {} });
window.addEventListener('beforeunload', releaseFocusOwnership);
document.addEventListener('keydown', handleFocusKeydown);
