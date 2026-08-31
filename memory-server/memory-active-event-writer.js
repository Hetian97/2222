const crypto = require('crypto');
const TimeZoneUtils = require('./server-time-zone-utils');

const WRITE_VERSION = 'active-event-write-v1';
const CLEAR_FUTURE_CUE = /(?:明天|明早|明晚|后天|大后天|下周|下星期|下个月|下月|月底|年后|过(?:\d{1,3}|[一二两三四五六七八九十百]+)天|(?:\d{1,3}|[一二两三四五六七八九十百]+)天(?:后|之后|以后))/u;
const EXPLICIT_DATE_CUE = /(?:\d{4}[年./-]\d{1,2}(?:[月./-]\d{1,2}日?)?|\d{1,2}月\d{1,2}[日号]|\d{1,2}号|(?:本|这|下)?(?:周|星期)[一二三四五六日天末])/u;

function clampScore(value) {
  return Math.max(0, Math.min(1, Number(value || 0)));
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .slice(0, 240);
}

function parseChineseInteger(value) {
  const source = String(value || '').trim();
  if (/^\d+$/.test(source)) return Number(source);
  const digits = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (source === '十') return 10;
  if (source.includes('百')) {
    const [hundreds, rest = ''] = source.split('百');
    return (digits[hundreds] || 1) * 100 + parseChineseInteger(rest || '0');
  }
  if (source.includes('十')) {
    const [tens, ones = ''] = source.split('十');
    return (tens ? (digits[tens] || 0) : 1) * 10 + (ones ? (digits[ones] || 0) : 0);
  }
  return [...source].reduce((number, character) => number * 10 + (digits[character] ?? 0), 0);
}

function pad(value) {
  return String(value).padStart(2, '0');
}

function localMidnight(parts, timeZone) {
  return TimeZoneUtils.fromDateTimeLocal(
    `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T00:00:00`,
    timeZone
  );
}

function addLocalDays(parts, days) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate()
  };
}

function startOfLocalDay(parts, timeZone) {
  return localMidnight(parts, timeZone);
}

function endOfLocalDay(parts, timeZone) {
  const nextDay = addLocalDays(parts, 1);
  return localMidnight(nextDay, timeZone) - 1;
}

function monthLength(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function resolveDayOfMonth(referenceParts, day) {
  let year = referenceParts.year;
  let month = referenceParts.month;
  if (day < 1 || day > monthLength(year, month)) return null;
  if (day <= referenceParts.day) {
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  if (day > monthLength(year, month)) return null;
  return { year, month, day };
}

function resolveWeekday(referenceParts, marker, weekdayCharacter) {
  const weekdayMap = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7, 末: 6 };
  const targetIsoDay = weekdayMap[weekdayCharacter];
  if (!targetIsoDay) return null;
  const currentDate = new Date(Date.UTC(referenceParts.year, referenceParts.month - 1, referenceParts.day));
  const currentIsoDay = currentDate.getUTCDay() || 7;
  let delta = targetIsoDay - currentIsoDay;
  if (marker === '下') delta += delta >= 0 ? 7 : 14;
  else if (!['本', '这'].includes(marker) && delta <= 0) delta += 7;
  return addLocalDays(referenceParts, delta);
}

function resolveCrossDayWindow(text, referenceTime = Date.now(), requestedTimeZone = 'UTC') {
  const source = String(text || '');
  const timeZone = TimeZoneUtils.normalizeTimeZone(requestedTimeZone, 'UTC');
  const referenceParts = TimeZoneUtils.getParts(referenceTime, timeZone);
  if (!referenceParts) return null;
  const tomorrow = addLocalDays(referenceParts, 1);
  const tomorrowStart = startOfLocalDay(tomorrow, timeZone);
  let target = null;
  let rangeDays = 1;
  let evidence = '';

  const fullDate = source.match(/(\d{4})[年./-](\d{1,2})(?:[月./-](\d{1,2})日?)?/u);
  const monthDay = source.match(/(\d{1,2})月(\d{1,2})[日号]/u);
  const dayOnly = source.match(/(?:^|[^\d月])(\d{1,2})号/u);
  const weekday = source.match(/(本|这|下)?(?:周|星期)([一二三四五六日天末])/u);
  const daysLater = source.match(/(?:过)?(\d{1,3}|[一二两三四五六七八九十百]+)天(?:后|之后|以后)?/u);

  if (/大后天/u.test(source)) {
    target = addLocalDays(referenceParts, 3);
    evidence = '大后天';
  } else if (/后天/u.test(source)) {
    target = addLocalDays(referenceParts, 2);
    evidence = '后天';
  } else if (/明天|明早|明晚/u.test(source)) {
    target = tomorrow;
    evidence = source.match(/明天|明早|明晚/u)?.[0] || '明天';
  } else if (weekday) {
    target = resolveWeekday(referenceParts, weekday[1] || '', weekday[2]);
    evidence = weekday[0];
  } else if (/下周|下星期/u.test(source)) {
    const currentDate = new Date(Date.UTC(referenceParts.year, referenceParts.month - 1, referenceParts.day));
    const currentIsoDay = currentDate.getUTCDay() || 7;
    target = addLocalDays(referenceParts, 8 - currentIsoDay);
    rangeDays = 7;
    evidence = source.match(/下周|下星期/u)?.[0] || '下周';
  } else if (/下个月|下月/u.test(source)) {
    const month = referenceParts.month === 12 ? 1 : referenceParts.month + 1;
    const year = referenceParts.month === 12 ? referenceParts.year + 1 : referenceParts.year;
    target = { year, month, day: 1 };
    rangeDays = monthLength(year, month);
    evidence = source.match(/下个月|下月/u)?.[0] || '下个月';
  } else if (/月底/u.test(source)) {
    target = { year: referenceParts.year, month: referenceParts.month, day: monthLength(referenceParts.year, referenceParts.month) };
    if (startOfLocalDay(target, timeZone) < tomorrowStart) {
      const month = referenceParts.month === 12 ? 1 : referenceParts.month + 1;
      const year = referenceParts.month === 12 ? referenceParts.year + 1 : referenceParts.year;
      target = { year, month, day: monthLength(year, month) };
    }
    evidence = '月底';
  } else if (/年后/u.test(source)) {
    target = { year: referenceParts.year + 1, month: 1, day: 1 };
    rangeDays = 31;
    evidence = '年后';
  } else if (daysLater && /过|后|之后|以后/u.test(daysLater[0])) {
    const count = Math.min(365, Math.max(1, parseChineseInteger(daysLater[1])));
    target = addLocalDays(referenceParts, count);
    evidence = daysLater[0];
  } else if (fullDate && fullDate[3]) {
    target = { year: Number(fullDate[1]), month: Number(fullDate[2]), day: Number(fullDate[3]) };
    evidence = fullDate[0];
  } else if (monthDay) {
    let year = referenceParts.year;
    target = { year, month: Number(monthDay[1]), day: Number(monthDay[2]) };
    if (startOfLocalDay(target, timeZone) < tomorrowStart) target.year += 1;
    evidence = monthDay[0];
  } else if (dayOnly) {
    target = resolveDayOfMonth(referenceParts, Number(dayOnly[1]));
    evidence = dayOnly[0].trim();
  }

  if (!target) return null;
  if (target.month < 1 || target.month > 12 || target.day < 1 || target.day > monthLength(target.year, target.month)) return null;
  const startAt = startOfLocalDay(target, timeZone);
  if (!Number.isFinite(startAt) || startAt < tomorrowStart) return null;
  const endParts = addLocalDays(target, Math.max(1, rangeDays) - 1);
  return {
    timeZone,
    evidence,
    startAt,
    endAt: endOfLocalDay(endParts, timeZone),
    validUntil: endOfLocalDay(addLocalDays(endParts, 2), timeZone),
    precision: rangeDays > 1 ? 'range' : 'day'
  };
}

function mergeEvidence(existingEvidence, addition) {
  const current = existingEvidence && typeof existingEvidence === 'object' ? existingEvidence : {};
  const history = Array.isArray(current.history) ? current.history : [];
  const sourceSearchIds = [...new Set([
    ...(Array.isArray(current.sourceSearchIds) ? current.sourceSearchIds : []),
    addition.searchTraceId
  ].filter(Boolean))].slice(-50);
  return {
    ...current,
    writeVersion: WRITE_VERSION,
    sourceType: 'private',
    sourceSearchIds,
    history: [...history, addition].slice(-50)
  };
}

function deterministicEventId(chatId, clause, window) {
  const digest = crypto.createHash('sha256')
    .update(`${chatId}\n${normalizeText(clause)}\n${window?.startAt || 0}`)
    .digest('hex')
    .slice(0, 20);
  return `active_event_${digest}`;
}

function planActiveEventWrites(log, existingEvents = [], options = {}) {
  const writesEnabled = options.writesEnabled === true;
  const extraction = log?.activeEventShadow?.extraction || {};
  const sourceScope = extraction.sourceScope || {};
  const chatId = String(log?.chatId || '').trim();
  const sourceChatId = String(sourceScope.sourceChatId || '').trim();
  const base = {
    version: WRITE_VERSION,
    enabled: writesEnabled,
    injectionEnabled: false,
    searchTraceId: String(log?.id || ''),
    status: 'skipped',
    operationCount: 0,
    operations: [],
    skipped: []
  };
  if (!writesEnabled) return { ...base, reason: 'writes_disabled' };
  if (String(log?.status || '') !== 'generation_succeeded') return { ...base, reason: 'generation_not_succeeded' };
  if (sourceScope.type !== 'private' || sourceScope.privateMemoryEligible !== true) {
    return { ...base, reason: 'non_private_source' };
  }
  if (!chatId || !sourceChatId || sourceChatId !== chatId) {
    return { ...base, reason: 'private_source_chat_mismatch' };
  }

  const eventsById = new Map((Array.isArray(existingEvents) ? existingEvents : []).map(event => [event.id, event]));
  const proposals = Array.isArray(extraction.proposals) ? extraction.proposals.slice(0, 4) : [];
  const operations = [];
  const skipped = [];
  for (const proposal of proposals) {
    const action = String(proposal.action || 'none');
    const clause = String(proposal.clause || proposal.titlePreview || '').trim().slice(0, 500);
    const confidence = clampScore(proposal.confidence);
    const temporalWindow = resolveCrossDayWindow(clause, Number(log.createdAt || log.at || Date.now()), extraction.timeZone || 'UTC');
    const auditEntry = {
      at: Date.now(),
      searchTraceId: String(log.id || ''),
      turnId: String(log.turnId || ''),
      attemptId: String(log.attemptId || ''),
      actionType: String(log.actionType || 'reply'),
      proposalAction: action,
      clause,
      confidence,
      temporalEvidence: Array.isArray(proposal.temporalEvidence) ? proposal.temporalEvidence : [],
      resolvedWindow: temporalWindow,
      sourceScope: {
        type: 'private',
        sourceChatId,
        mountedChatId: String(sourceScope.mountedChatId || '')
      }
    };

    if (action === 'create_candidate') {
      if (!CLEAR_FUTURE_CUE.test(clause) && !EXPLICIT_DATE_CUE.test(clause)) {
        skipped.push({ action, clause, reason: 'cross_day_evidence_missing' });
        continue;
      }
      if (!temporalWindow) {
        skipped.push({ action, clause, reason: 'future_time_unresolved_or_not_cross_day' });
        continue;
      }
      const id = deterministicEventId(chatId, clause, temporalWindow);
      const existing = eventsById.get(id);
      operations.push({
        action: existing ? 'update' : 'create',
        id,
        event: {
          ...(existing || {}),
          id,
          chatId,
          title: clause.slice(0, 160),
          summary: clause,
          status: existing?.status && !['completed', 'cancelled', 'expired', 'archived'].includes(existing.status)
            ? existing.status
            : 'planned',
          startAt: temporalWindow.startAt,
          endAt: temporalWindow.endAt,
          validUntil: temporalWindow.validUntil,
          surfaceMode: 'manual_only',
          proactiveMention: false,
          aliases: [...new Set([...(existing?.aliases || []), clause.slice(0, 160)])].slice(0, 24),
          sourceMemoryIds: existing?.sourceMemoryIds || [],
          evidence: mergeEvidence(existing?.evidence, auditEntry),
          confidence: Math.max(Number(existing?.confidence || 0), confidence)
        },
        reason: existing ? 'deterministic_repeat_update' : 'private_cross_day_plan_created'
      });
      continue;
    }

    if (['update_candidate', 'complete_candidate', 'cancel_candidate'].includes(action)) {
      const targetId = String(proposal.targetEventId || '').trim();
      const existing = eventsById.get(targetId);
      if (!existing) {
        skipped.push({ action, clause, reason: 'referenced_event_missing' });
        continue;
      }
      const status = action === 'complete_candidate'
        ? 'completed'
        : (action === 'cancel_candidate' ? 'cancelled' : (existing.status === 'candidate' ? 'planned' : existing.status));
      operations.push({
        action: action === 'update_candidate' ? 'update' : (status === 'completed' ? 'complete' : 'cancel'),
        id: targetId,
        event: {
          ...existing,
          status,
          startAt: temporalWindow?.startAt || existing.startAt,
          endAt: temporalWindow?.endAt || existing.endAt,
          validUntil: temporalWindow?.validUntil || existing.validUntil,
          surfaceMode: 'manual_only',
          proactiveMention: false,
          aliases: [...new Set([...(existing.aliases || []), clause.slice(0, 160)])].slice(0, 24),
          evidence: mergeEvidence(existing.evidence, auditEntry),
          confidence: Math.max(Number(existing.confidence || 0), confidence)
        },
        reason: `private_plan_${action.replace('_candidate', '')}`
      });
    }
  }

  return {
    ...base,
    status: operations.length ? 'ready' : 'no_operations',
    reason: operations.length ? 'private_cross_day_operations_ready' : 'no_eligible_private_cross_day_operation',
    operationCount: operations.length,
    operations,
    skipped
  };
}

module.exports = {
  WRITE_VERSION,
  resolveCrossDayWindow,
  planActiveEventWrites
};
