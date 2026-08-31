const REFERENCE_CUE = /(?:那件事|这件事|那个(?:安排|计划|约定|地方)?|这个(?:安排|计划|约定)?|不想去|还去吗|要走|快到了|回来(?:以后|之后|再)|改期|改时间|推迟|提前|取消|出发)/u;
const COMMITMENT_CUE = /(?:计划|打算|准备|安排|预约|预订|预定|约好|决定|承诺|答应|要去|要在|要于|将于|将会|会在|预计|必须|需要|截止|出发|启程|动身|返回|回来|开始|继续|提交|参加)/u;
const ONGOING_CUE = /(?:正在|已经开始|还在|仍在|持续到|一直到|直到)/u;
const COMPLETION_CUE = /(?:已经结束|结束了|已经完成|完成了|做完了|办完了|考完了|已经回来|回来了)/u;
const CANCELLATION_CUE = /(?:取消了?|不去了|不再去了?|作废|改期|改时间|延期|推迟)/u;
const QUESTION_CUE = /(?:吗|么|要不要|是否|什么|怎么|哪天|何时|\?|？)/u;
const HYPOTHETICAL_CUE = /(?:如果|假如|假设|比如|可能|也许|或许)/u;
const EXECUTABLE_ACTION_CUE = /(?:做|制作|准备|整理|查看|看完|阅读|复习|检查|提交|发送|交给|参加|出发|启程|动身|返回|回来|搬|购买|买|预约|复诊|开会|考试|训练|处理|完成|开始|继续|去(?:往|到)?)/u;
const CONCRETE_EVENT_CUE = /(?:会议|考试|预约|行程|航班|车次|截止|复诊|检查|训练|活动|出差|旅行|约会|任务|资料|材料)/u;
const SOCIAL_FAREWELL_CUE = /(?:(?:晚安|睡吧|先睡|早点睡).{0,32}(?:明天见|回头见|改天见)|(?:明天见|回头见|改天见).{0,32}(?:晚安|睡吧|先睡|早点睡))/u;
const CURRENT_TIME_CUE = /(?:今天|今日|今晚|今早|现在|目前|本周|这周|本月|这个月)/u;
const FUTURE_TIME_CUE = /(?:明天|明早|明晚|后天|大后天|下周|下星期|下个月|下月|月底|年后|过(?:\d{1,3}|[一二两三四五六七八九十百]+)天|(?:\d{1,3}|[一二两三四五六七八九十百]+)天(?:后|之后|以后))/u;
const PAST_ONLY_CUE = /(?:昨天|昨日|昨晚|前天|大前天|上周|上个月|去年)/u;
const EXPLICIT_DATE_CUE = /(?:\d{4}[年./-]\d{1,2}(?:[月./-]\d{1,2}日?)?|\d{1,2}月\d{1,2}[日号]|\d{1,2}号|(?:本|这|下|上)?(?:周|星期)[一二三四五六日天末])/u;
const TEMPORAL_EVIDENCE_PATTERN = /\d{4}[年./-]\d{1,2}(?:[月./-]\d{1,2}日?)?|\d{1,2}月\d{1,2}[日号]|\d{1,2}号|(?:本|这|下|上)?(?:周|星期)[一二三四五六日天末]|大前天|前天|昨天|昨晚|今天|今晚|今早|明天|明早|明晚|后天|大后天|下个月|下月|月底|过(?:\d{1,3}|[一二两三四五六七八九十百]+)天|(?:\d{1,3}|[一二两三四五六七八九十百]+)天(?:后|之后|以后)/gu;
const ACTIVE_EVENT_SOURCE_TYPES = new Set(['private', 'group', 'system', 'unknown']);

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

function textPieces(value) {
  const normalized = normalizeText(value);
  const pieces = new Set();
  for (const word of String(value || '').toLowerCase().match(/[a-z0-9]{2,}/g) || []) pieces.add(word);
  for (let size = 2; size <= 3; size += 1) {
    for (let index = 0; index <= normalized.length - size; index += 1) pieces.add(normalized.slice(index, index + size));
  }
  return pieces;
}

function overlapScore(query, labels) {
  const queryText = normalizeText(query);
  let exact = 0;
  let best = 0;
  for (const label of labels) {
    const labelText = normalizeText(label);
    if (!labelText) continue;
    if (queryText.includes(labelText) || labelText.includes(queryText)) exact = Math.max(exact, Math.min(1, labelText.length / 6));
    const labelPieces = textPieces(label);
    const queryPieces = textPieces(query);
    if (!labelPieces.size || !queryPieces.size) continue;
    let shared = 0;
    for (const piece of labelPieces) if (queryPieces.has(piece)) shared += 1;
    best = Math.max(best, shared / Math.max(1, Math.min(labelPieces.size, queryPieces.size)));
  }
  return Math.max(exact, best);
}

function clampScore(value) {
  return Math.max(0, Math.min(1, Number(value || 0)));
}

function splitEventClauses(query) {
  return String(query || '')
    .split(/[。！？!?；;\n\r]+/u)
    .map(value => value.trim())
    .filter(value => value.length >= 2)
    .slice(0, 8);
}

function extractTemporalEvidence(clause) {
  return [...new Set(String(clause || '').match(TEMPORAL_EVIDENCE_PATTERN) || [])].slice(0, 8);
}

function normalizeStringList(values, limit = 24) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map(value => String(value || '').trim())
    .filter(Boolean))].slice(0, limit);
}

function normalizeSourceScope(input = {}) {
  const requestedType = String(input.type || input.sourceType || 'unknown').trim().toLowerCase();
  const type = ACTIVE_EVENT_SOURCE_TYPES.has(requestedType) ? requestedType : 'unknown';
  return {
    type,
    sourceChatId: String(input.sourceChatId || '').trim(),
    mountedChatId: String(input.mountedChatId || '').trim(),
    sourceMessageType: String(input.sourceMessageType || '').trim(),
    latestSpeakerId: String(input.latestSpeakerId || input.speakerId || '').trim(),
    latestSpeakerRole: String(input.latestSpeakerRole || input.speakerRole || '').trim(),
    speakerIds: normalizeStringList(input.speakerIds),
    participantIds: normalizeStringList(input.participantIds, 50),
    ownershipResolved: false,
    privateMemoryEligible: type === 'private',
    visibilityHint: type === 'group' ? 'source_scope_on_reference' : (type === 'private' ? 'private_chat' : 'source_scope_only')
  };
}

function getClauseSignals(clause) {
  const temporalEvidence = extractTemporalEvidence(clause);
  const hasFutureTime = FUTURE_TIME_CUE.test(clause);
  const hasCurrentTime = CURRENT_TIME_CUE.test(clause);
  const hasExplicitDate = EXPLICIT_DATE_CUE.test(clause);
  return {
    temporalEvidence,
    hasFutureTime,
    hasCurrentTime,
    hasExplicitDate,
    hasPastOnlyTime: PAST_ONLY_CUE.test(clause) && !hasFutureTime && !hasCurrentTime && !hasExplicitDate,
    hasCommitment: COMMITMENT_CUE.test(clause),
    hasOngoing: ONGOING_CUE.test(clause),
    hasCompletion: COMPLETION_CUE.test(clause),
    hasCancellation: CANCELLATION_CUE.test(clause),
    hasQuestion: QUESTION_CUE.test(clause),
    hasHypothetical: HYPOTHETICAL_CUE.test(clause),
    hasActionableContent: EXECUTABLE_ACTION_CUE.test(clause) || CONCRETE_EVENT_CUE.test(clause),
    hasSocialFarewell: SOCIAL_FAREWELL_CUE.test(clause)
  };
}

function hasConflictingTemporalEvidence(baseSignals, adjacentSignals) {
  if (!baseSignals.temporalEvidence.length || !adjacentSignals.temporalEvidence.length) return false;
  const base = new Set(baseSignals.temporalEvidence);
  return adjacentSignals.temporalEvidence.some(value => !base.has(value));
}

function isAdjacentEventSupport(base, adjacent) {
  if (!adjacent || adjacent.clause.length < 4) return false;
  const baseSignals = base.signals;
  const adjacentSignals = adjacent.signals;
  if (adjacentSignals.hasQuestion || adjacentSignals.hasHypothetical || adjacentSignals.hasCompletion || adjacentSignals.hasCancellation) {
    return false;
  }
  if (hasConflictingTemporalEvidence(baseSignals, adjacentSignals)) return false;

  const baseHasSchedule = baseSignals.hasFutureTime || baseSignals.hasExplicitDate;
  const adjacentHasSchedule = adjacentSignals.hasFutureTime || adjacentSignals.hasExplicitDate;
  return (
    (baseHasSchedule && adjacentSignals.hasCommitment) ||
    (baseSignals.hasCommitment && adjacentHasSchedule) ||
    (baseHasSchedule && adjacentSignals.hasOngoing)
  );
}

function mergeAdjacentProposalContext(assessments) {
  return assessments.map((assessment, index) => {
    if (!assessment.proposed) return assessment;
    const adjacentIndexes = [];
    // Prefer the following clause because natural Chinese often states the date or
    // promise first, then supplies the concrete action/object in the next sentence.
    for (const candidateIndex of [index + 1, index - 1]) {
      const adjacent = assessments[candidateIndex];
      if (!isAdjacentEventSupport(assessment, adjacent)) continue;
      const candidateIndexes = [...adjacentIndexes, candidateIndex].sort((a, b) => a - b);
      const combinedLength = [index, ...candidateIndexes]
        .sort((a, b) => a - b)
        .map(clauseIndex => assessments[clauseIndex].clause)
        .join('。').length;
      if (combinedLength > 240) continue;
      adjacentIndexes.push(candidateIndex);
      break;
    }
    if (!adjacentIndexes.length) return assessment;
    const sourceClauseIndexes = [index, ...adjacentIndexes].sort((a, b) => a - b);
    const mergedClause = sourceClauseIndexes.map(clauseIndex => assessments[clauseIndex].clause).join('。');
    return {
      ...assessment,
      clause: mergedClause,
      titlePreview: mergedClause.slice(0, 160),
      sourceClauseIndexes,
      mergedFromAdjacentClauses: true,
      reasons: [...new Set([...assessment.reasons, 'adjacent_clause_context'])]
    };
  });
}

function findReferencedEvent(clause, eligibleEvents) {
  const scored = eligibleEvents
    .map(event => ({
      event,
      score: overlapScore(clause, [event.title, ...(Array.isArray(event.aliases) ? event.aliases : [])])
    }))
    .sort((a, b) => b.score - a.score);
  if (scored[0]?.score >= 0.3) return { ...scored[0], route: 'direct_reference' };
  if (REFERENCE_CUE.test(clause) && eligibleEvents.length === 1) {
    return { event: eligibleEvents[0], score: scored[0]?.score || 0, route: 'single_event_indirect_reference' };
  }
  return null;
}

function runActiveEventExtractionShadow(events, options = {}) {
  const now = Number(options.now || Date.now());
  const query = String(options.query || '').trim();
  const timeZone = String(options.timeZone || 'UTC');
  const sourceScope = normalizeSourceScope(options.sourceScope || options.activeEventSource || {});
  const writesEnabled = options.writesEnabled === true;
  const eligibleEvents = (Array.isArray(events) ? events : []).filter(event =>
    event && ['candidate', 'planned', 'active'].includes(String(event.status)) &&
    (!event.validUntil || Number(event.validUntil) >= now)
  );
  const assessments = splitEventClauses(query).map((clause, index) => {
    const signals = getClauseSignals(clause);
    const {
      temporalEvidence, hasFutureTime, hasCurrentTime, hasExplicitDate, hasPastOnlyTime,
      hasCommitment, hasOngoing, hasCompletion, hasCancellation, hasQuestion, hasHypothetical,
      hasActionableContent, hasSocialFarewell
    } = signals;
    const referenced = findReferencedEvent(clause, eligibleEvents);
    const reasons = [];
    if (hasFutureTime) reasons.push('future_time_evidence');
    if (hasCurrentTime) reasons.push('current_time_evidence');
    if (hasExplicitDate) reasons.push('explicit_date_evidence');
    if (hasCommitment) reasons.push('commitment_language');
    if (hasOngoing) reasons.push('ongoing_language');
    if (hasCompletion) reasons.push('completion_language');
    if (hasCancellation) reasons.push('cancellation_language');
    if (referenced) reasons.push(referenced.route);
    if (hasQuestion) reasons.push('question_or_uncertainty');
    if (hasHypothetical) reasons.push('hypothetical_language');
    if (hasActionableContent) reasons.push('actionable_event_content');
    if (hasSocialFarewell) reasons.push('social_farewell_not_active');

    let action = 'none';
    if (hasCancellation) action = 'cancel_candidate';
    else if (hasCompletion) action = 'complete_candidate';
    else if (referenced && (hasCommitment || hasOngoing || hasFutureTime || hasCurrentTime || hasExplicitDate)) action = 'update_candidate';
    else if (
      !hasSocialFarewell &&
      (hasFutureTime || hasExplicitDate) &&
      (hasCommitment || hasActionableContent) &&
      !hasPastOnlyTime
    ) action = 'create_candidate';

    let confidence = 0.18;
    if (hasFutureTime) confidence += 0.24;
    if (hasCurrentTime) confidence += 0.08;
    if (hasExplicitDate) confidence += 0.18;
    if (hasCommitment) confidence += 0.22;
    if (hasOngoing) confidence += 0.16;
    if (hasCompletion || hasCancellation) confidence += 0.2;
    if (referenced) confidence += referenced.route === 'direct_reference' ? 0.16 : 0.1;
    if (hasQuestion) confidence -= 0.12;
    if (hasHypothetical) confidence -= 0.18;
    if (hasActionableContent) confidence += 0.16;
    if (hasSocialFarewell) confidence -= 0.3;
    if (hasPastOnlyTime && !hasCompletion && !hasCancellation) confidence -= 0.2;
    if ((hasCompletion || hasCancellation) && !referenced) {
      confidence -= 0.16;
      reasons.push('unresolved_lifecycle_reference');
    }
    confidence = clampScore(confidence);
    const proposed = action !== 'none' && confidence >= 0.42;
    if (!proposed) {
      if (hasPastOnlyTime && !hasCompletion && !hasCancellation) reasons.push('past_only_not_active');
      else if (action === 'none') reasons.push('insufficient_event_structure');
      else reasons.push('below_proposal_floor');
    }

    return {
      clauseIndex: index,
      clause,
      proposed,
      action,
      titlePreview: clause.slice(0, 120),
      confidence: Number(confidence.toFixed(6)),
      targetEventId: referenced?.event?.id || null,
      referenceRoute: referenced?.route || 'none',
      referenceScore: Number((referenced?.score || 0).toFixed(6)),
      temporalEvidence,
      reasons: [...new Set(reasons)],
      signals
    };
  });
  let decisions = mergeAdjacentProposalContext(assessments).map(item => {
    const { signals, ...publicDecision } = item;
    return {
      ...publicDecision,
      sourceClauseIndexes: Array.isArray(publicDecision.sourceClauseIndexes)
        ? publicDecision.sourceClauseIndexes
        : [publicDecision.clauseIndex],
      mergedFromAdjacentClauses: Boolean(publicDecision.mergedFromAdjacentClauses)
    };
  });
  if (!sourceScope.privateMemoryEligible) {
    decisions = decisions.map(item => ({
      ...item,
      proposed: false,
      action: 'none',
      reasons: [...new Set([...item.reasons, 'non_private_source_excluded'])]
    }));
  }
  const proposals = decisions.filter(item => item.proposed).slice(0, 4);
  return {
    mode: 'shadow',
    version: 'active-event-extraction-write-only-v1',
    behaviorChanged: false,
    writesEnabled,
    writeTiming: 'generation_succeeded_only',
    query,
    timeZone,
    sourceScope,
    clauseCount: decisions.length,
    proposalCount: proposals.length,
    proposals,
    decisions,
    stopReason: proposals.length
      ? 'shadow_proposals_recorded'
      : (!sourceScope.privateMemoryEligible ? 'non_private_source_excluded' : 'no_supported_event_proposal')
  };
}

function runActiveEventShadow(events, options = {}) {
  const now = Number(options.now || Date.now());
  const query = String(options.query || '').trim();
  const maxSelected = Math.max(0, Math.min(3, Number(options.maxSelected || 2)));
  const eligible = (Array.isArray(events) ? events : []).filter(event =>
    event && ['candidate', 'planned', 'active'].includes(String(event.status)) &&
    event.surfaceMode !== 'manual_only' &&
    (!event.validUntil || Number(event.validUntil) >= now)
  );
  const hasReferenceCue = REFERENCE_CUE.test(query);
  const scored = eligible.map(event => {
    const labels = [event.title, ...(Array.isArray(event.aliases) ? event.aliases : [])].filter(Boolean);
    const score = overlapScore(query, labels);
    const direct = score >= 0.3;
    return { event, score, direct };
  });
  const directMatches = scored.filter(item => item.direct).sort((a, b) => b.score - a.score);
  const indirectAllowed = hasReferenceCue && directMatches.length === 0 && eligible.length === 1;
  const selected = directMatches.slice(0, maxSelected);
  if (indirectAllowed && maxSelected > 0) selected.push(scored[0]);
  const selectedIds = new Set(selected.map(item => item.event.id));
  const decisions = scored.map(item => {
    const selectedItem = selectedIds.has(item.event.id);
    let reason = 'no_current_reference';
    let route = 'none';
    if (selectedItem && item.direct) {
      reason = 'direct_event_reference';
      route = 'direct_reference';
    } else if (selectedItem) {
      reason = 'single_active_event_indirect_reference';
      route = 'indirect_reference';
    } else if (hasReferenceCue && eligible.length > 1 && !directMatches.length) {
      reason = 'ambiguous_indirect_reference';
    } else if (item.direct) {
      reason = 'selection_limit';
      route = 'direct_reference';
    }
    return {
      id: item.event.id,
      title: item.event.title,
      selected: selectedItem,
      reason,
      route,
      score: Number(item.score.toFixed(6)),
      status: item.event.status,
      surfaceMode: item.event.surfaceMode,
      proactiveMention: Boolean(item.event.proactiveMention)
    };
  });
  return {
    mode: 'shadow',
    version: 'active-events-shadow-v1',
    behaviorChanged: false,
    injectionEnabled: false,
    query,
    eligibleCount: eligible.length,
    referencedCount: directMatches.length + (indirectAllowed ? 1 : 0),
    selectedCount: selectedIds.size,
    selectedEventIds: [...selectedIds],
    selectionStopReason: selectedIds.size ? 'shadow_reference_detected' : (hasReferenceCue && eligible.length > 1 ? 'ambiguous_reference' : 'no_reference'),
    decisions
  };
}

module.exports = { runActiveEventShadow, runActiveEventExtractionShadow };
