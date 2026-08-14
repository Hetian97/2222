const REFERENCE_CUE = /(?:那件事|这件事|那个(?:安排|计划|约定|地方)?|这个(?:安排|计划|约定)?|不想去|还去吗|要走|快到了|回来(?:以后|之后|再)|改期|改时间|推迟|提前|取消|出发)/u;

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

module.exports = { runActiveEventShadow };
