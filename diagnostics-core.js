// Lightweight diagnostics that survive crashes via localStorage.
(function () {
  'use strict';

  const ERRORS_KEY = 'ephone_diag_errors_v1';
  const SAMPLES_KEY = 'ephone_diag_samples_v1';
  const SESSION_KEY = 'ephone_diag_session_v1';
  const MAX_ERRORS = 100;
  const MAX_SAMPLES = 120;

  const readJson = (key, fallback) => {
    try {
      const value = JSON.parse(localStorage.getItem(key) || 'null');
      return value ?? fallback;
    } catch (_) {
      return fallback;
    }
  };
  const writeJson = (key, value) => {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) {}
  };

  let errors = readJson(ERRORS_KEY, []);
  let samples = readJson(SAMPLES_KEY, []);
  const previousSession = readJson(SESSION_KEY, null);
  const session = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    start: Date.now(),
    last: Date.now(),
    closed: false
  };

  const getHeap = () => {
    const memory = performance.memory;
    if (!memory) return null;
    return {
      used: Number(memory.usedJSHeapSize) || 0,
      total: Number(memory.totalJSHeapSize) || 0,
      limit: Number(memory.jsHeapSizeLimit) || 0
    };
  };

  let activeIntervals = 0;
  let intervalsCreated = 0;
  let intervalsCleared = 0;
  const nativeSetInterval = window.setInterval;
  const nativeClearInterval = window.clearInterval;
  window.setInterval = function (...args) {
    const id = nativeSetInterval.apply(this, args);
    activeIntervals += 1;
    intervalsCreated += 1;
    return id;
  };
  window.clearInterval = function (...args) {
    const result = nativeClearInterval.apply(this, args);
    activeIntervals = Math.max(0, activeIntervals - 1);
    intervalsCleared += 1;
    return result;
  };

  let longTaskCount = 0;
  let longTaskMax = 0;
  let lastLongTask = 0;
  try {
    if (typeof PerformanceObserver === 'function') {
      const observer = new PerformanceObserver(list => {
        list.getEntries().forEach(entry => {
          longTaskCount += 1;
          longTaskMax = Math.max(longTaskMax, Number(entry.duration) || 0);
          lastLongTask = Date.now();
        });
      });
      observer.observe({ entryTypes: ['longtask'] });
    }
  } catch (_) {}

  function snapshot() {
    const screens = Array.from(document.querySelectorAll('.screen'));
    return {
      at: Date.now(),
      heap: getHeap(),
      domNodes: document.getElementsByTagName('*').length,
      activeIntervals,
      intervalsCreated,
      intervalsCleared,
      longTaskCount,
      longTaskMax,
      lastLongTask,
      screens: screens.length,
      visibleScreens: screens.filter(el => el.classList.contains('active') || el.style.display !== 'none').length,
      visibleModals: document.querySelectorAll('.modal.visible').length,
      visibility: document.visibilityState,
      viewport: `${window.innerWidth}x${window.innerHeight}`,
      ua: navigator.userAgent
    };
  }

  function recordError(kind, message, extra = {}) {
    const entry = {
      at: Date.now(),
      kind,
      message: String(message || 'Unknown error').slice(0, 2000),
      ...extra
    };
    errors.push(entry);
    errors = errors.slice(-MAX_ERRORS);
    writeJson(ERRORS_KEY, errors);
    return entry;
  }

  window.addEventListener('error', event => {
    recordError('error', event.message || 'Script error', {
      source: String(event.filename || '').slice(0, 500),
      line: event.lineno || 0,
      column: event.colno || 0,
      stack: String(event.error?.stack || '').slice(0, 3000)
    });
  });

  window.addEventListener('unhandledrejection', event => {
    const reason = event.reason;
    recordError('unhandledrejection', reason?.message || String(reason || 'Unhandled rejection'), {
      stack: String(reason?.stack || '').slice(0, 3000)
    });
  });

  const nativeConsoleError = console.error.bind(console);
  console.error = function (...args) {
    try {
      recordError('console.error', args.map(value => {
        if (value instanceof Error) return `${value.message}\n${value.stack || ''}`;
        if (typeof value === 'string') return value;
        try { return JSON.stringify(value); } catch (_) { return String(value); }
      }).join(' '));
    } catch (_) {}
    nativeConsoleError(...args);
  };

  function saveSession() {
    session.last = Date.now();
    writeJson(SESSION_KEY, session);
  }

  let heartbeatTimer = null;
  function markCleanExit() {
    session.closed = true;
    saveSession();
  }

  window.addEventListener('pagehide', markCleanExit);
  window.addEventListener('beforeunload', markCleanExit);
  document.addEventListener('visibilitychange', saveSession);

  heartbeatTimer = nativeSetInterval(() => {
    saveSession();
    samples.push(snapshot());
    samples = samples.slice(-MAX_SAMPLES);
    writeJson(SAMPLES_KEY, samples);
    if (!getHeap() && samples.length > 20) {
      // Keep storage bounded even when heap info is unavailable.
      samples = samples.slice(-40);
      writeJson(SAMPLES_KEY, samples);
    }
  }, 30000);

  window.EPhoneDiagnostics = {
    getSnapshot: snapshot,
    getErrors: () => errors.slice(),
    getSamples: () => samples.slice(),
    getPreviousSession: () => previousSession,
    recordError,
    clearErrors: () => {
      errors = [];
      writeJson(ERRORS_KEY, errors);
    },
    exportReport: () => ({
      generatedAt: Date.now(),
      appSession: session,
      previousSession,
      snapshot: snapshot(),
      errors: errors.slice(),
      samples: samples.slice()
    }),
    stop: () => nativeClearInterval(heartbeatTimer)
  };

  saveSession();
})();
