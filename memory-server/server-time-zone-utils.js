const validTimeZones = new Set(['UTC']);
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

function normalizeTimeZone(value, fallback = 'UTC') {
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

module.exports = {
  isValidTimeZone,
  normalizeTimeZone,
  getParts,
  fromDateTimeLocal
};
