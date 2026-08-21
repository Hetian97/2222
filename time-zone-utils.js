(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TimeZoneUtils = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const LEGACY_TIME_ZONE = 'Europe/London';
  const validTimeZones = new Set(['UTC', LEGACY_TIME_ZONE]);
  const invalidTimeZones = new Set();

  function isValidTimeZone(value) {
    const timeZone = String(value || '').trim();
    if (!timeZone) return false;
    if (validTimeZones.has(timeZone)) return true;
    if (invalidTimeZones.has(timeZone)) return false;
    try {
      new Intl.DateTimeFormat('en-US', { timeZone }).format(0);
      validTimeZones.add(timeZone);
      return true;
    } catch (_) {
      invalidTimeZones.add(timeZone);
      return false;
    }
  }

  function getCurrentTimeZone() {
    const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return isValidTimeZone(detected) ? detected : 'UTC';
  }

  function normalizeTimeZone(value, fallback = LEGACY_TIME_ZONE) {
    if (isValidTimeZone(value)) return String(value).trim();
    return isValidTimeZone(fallback) ? String(fallback).trim() : 'UTC';
  }

  function getParts(value, timeZone) {
    const timestamp = Number(value);
    if (!Number.isFinite(timestamp)) return null;
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: normalizeTimeZone(timeZone),
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hourCycle: 'h23'
    });
    const parts = Object.fromEntries(
      formatter.formatToParts(new Date(timestamp))
        .filter(part => part.type !== 'literal')
        .map(part => [part.type, part.value])
    );
    return {
      year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
      hour: Number(parts.hour), minute: Number(parts.minute), second: Number(parts.second)
    };
  }

  function format(value, timeZone, options = {}) {
    const timestamp = Number(value);
    if (!Number.isFinite(timestamp) || timestamp <= 0) return '';
    const p = getParts(timestamp, timeZone);
    if (!p) return '';
    const pad = number => String(number).padStart(2, '0');
    const date = `${p.year}-${pad(p.month)}-${pad(p.day)}`;
    const clock = `${pad(p.hour)}:${pad(p.minute)}${options.seconds ? `:${pad(p.second)}` : ''}`;
    if (options.dateOnly) return date;
    if (options.timeOnly) return clock;
    return `${date} ${clock}`;
  }

  function toDateTimeLocal(value, timeZone) {
    return format(value, timeZone).replace(' ', 'T');
  }

  function fromDateTimeLocal(value, timeZone) {
    const match = String(value || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
    if (!match) return NaN;
    const desired = {
      year: Number(match[1]), month: Number(match[2]), day: Number(match[3]),
      hour: Number(match[4]), minute: Number(match[5]), second: Number(match[6] || 0)
    };
    let guess = Date.UTC(desired.year, desired.month - 1, desired.day, desired.hour, desired.minute, desired.second);
    const zone = normalizeTimeZone(timeZone);
    for (let index = 0; index < 3; index += 1) {
      const actual = getParts(guess, zone);
      if (!actual) return NaN;
      const desiredUtc = Date.UTC(desired.year, desired.month - 1, desired.day, desired.hour, desired.minute, desired.second);
      const actualUtc = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second);
      const difference = desiredUtc - actualUtc;
      guess += difference;
      if (!difference) break;
    }
    const verified = getParts(guess, zone);
    return verified && Object.keys(desired).every(key => verified[key] === desired[key]) ? guess : NaN;
  }

  function stampMessage(message, fallback = getCurrentTimeZone()) {
    if (!message || !Number.isFinite(Number(message.timestamp))) return false;
    if (isValidTimeZone(message.timestampTimeZone)) return false;
    message.timestampTimeZone = normalizeTimeZone(fallback);
    return true;
  }

  function stampMemory(memory, fallback = getCurrentTimeZone()) {
    if (!memory) return false;
    let changed = false;
    const zone = normalizeTimeZone(fallback);
    const fields = [
      ['memoryTime', 'memoryTimeZone'], ['createdAt', 'createdAtTimeZone'],
      ['updatedAt', 'updatedAtTimeZone'], ['embeddingUpdatedAt', 'embeddingUpdatedAtTimeZone'],
      ['lastRecalled', 'lastRecalledTimeZone']
    ];
    fields.forEach(([valueField, zoneField]) => {
      if (Number(memory[valueField] || 0) > 0 && !isValidTimeZone(memory[zoneField])) {
        memory[zoneField] = zone;
        changed = true;
      }
    });
    return changed;
  }

  function stampChat(chat, fallback = getCurrentTimeZone()) {
    if (!chat) return false;
    let changed = false;
    (Array.isArray(chat.history) ? chat.history : []).forEach(message => {
      changed = stampMessage(message, fallback) || changed;
    });
    const fragments = chat.variableMemory?.fragments || chat.vectorMemory?.fragments || [];
    fragments.forEach(memory => { changed = stampMemory(memory, fallback) || changed; });
    return changed;
  }

  return {
    LEGACY_TIME_ZONE, isValidTimeZone, getCurrentTimeZone, normalizeTimeZone,
    getParts, format, toDateTimeLocal, fromDateTimeLocal, stampMessage, stampMemory, stampChat
  };
});
