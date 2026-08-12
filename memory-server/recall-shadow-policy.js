const DEFAULT_CATEGORY_QUOTAS = Object.freeze({
  U: 3,
  A: 3,
  R: 3,
  E: 4,
  I: 2,
  L: 2,
  P: 3,
  T: 3,
  M: 3
});

function clamp01(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(1, number));
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

function lexicalTokens(value) {
  const text = String(value || '').normalize('NFKC').toLowerCase();
  const tokens = new Set();

  for (const word of (text.match(/[a-z0-9_][a-z0-9_.:/-]{1,63}/g) || [])) {
    tokens.add(word);
  }

  for (const run of (text.match(/[\u3400-\u9fff]+/g) || [])) {
    if (run.length === 1) tokens.add(run);
    for (const size of [2, 3]) {
      for (let index = 0; index <= run.length - size; index++) {
        tokens.add(run.slice(index, index + size));
      }
    }
  }

  return tokens;
}

function parseTags(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return value.split(/[,，\s]+/).filter(Boolean);
  }
}

function buildQuerySegments(query, queryVariants = []) {
  const values = [query, ...(Array.isArray(queryVariants) ? queryVariants : [])];
  const segments = [];
  const seen = new Set();
  const add = value => {
    const text = String(value || '').normalize('NFKC').trim();
    if (text.length < 2 || text.length > 96) return;
    const key = normalizeText(text);
    if (!key || seen.has(key)) return;
    seen.add(key);
    segments.push(text);
  };

  for (const value of values) {
    const text = String(value || '').normalize('NFKC').trim();
    if (!text) continue;
    if (text.length <= 96) add(text);
    text.split(/[\n\r，,。.!?！？；;：:、|/\\]+/)
      .map(part => part.trim())
      .filter(part => part.length >= 2 && part.length <= 96)
      .slice(-10)
      .forEach(add);
  }
  return segments.slice(0, 18);
}

function buildShadowEvidence(candidates, options = {}) {
  const documents = candidates.map(memory => lexicalTokens([
    memory.content,
    memory.context,
    ...parseTags(memory.tags)
  ].filter(Boolean).join(' ')));
  const documentFrequency = new Map();
  for (const tokens of documents) {
    for (const token of tokens) {
      documentFrequency.set(token, (documentFrequency.get(token) || 0) + 1);
    }
  }

  const total = Math.max(1, candidates.length);
  const segments = buildQuerySegments(options.query, options.queryVariants);
  const segmentTokens = segments.map(segment => lexicalTokens(segment));
  const tagFrequency = new Map();
  for (const memory of candidates) {
    const uniqueTags = new Set(parseTags(memory.tags).map(normalizeText).filter(Boolean));
    for (const tag of uniqueTags) tagFrequency.set(tag, (tagFrequency.get(tag) || 0) + 1);
  }

  return candidates.map((memory, index) => {
    let keyword = 0;
    for (const queryTokens of segmentTokens) {
      const salient = [...queryTokens].filter(token => {
        const frequency = documentFrequency.get(token) || 0;
        return frequency > 0 && (frequency <= Math.max(3, Math.ceil(total * 0.38)) || /[a-z0-9]/i.test(token));
      });
      if (!salient.length) continue;
      let matchedWeight = 0;
      let queryWeight = 0;
      for (const token of salient) {
        const frequency = documentFrequency.get(token) || 0;
        const weight = 1 + Math.log((total + 1) / (frequency + 1));
        queryWeight += weight;
        if (documents[index].has(token)) matchedWeight += weight;
      }
      const coverage = queryWeight > 0 ? matchedWeight / queryWeight : 0;
      keyword = Math.max(keyword, Math.sqrt(coverage) * coverage);
    }

    let anchor = 0;
    let anchorTerm = '';
    const normalizedSegments = segments.map(normalizeText);
    for (const rawTag of parseTags(memory.tags)) {
      const tag = normalizeText(rawTag);
      if (tag.length < 2 || tag.length > 24) continue;
      if (!normalizedSegments.some(segment => segment.includes(tag))) continue;
      const frequency = tagFrequency.get(tag) || total;
      const rarity = Math.min(1, Math.log2((total + 1) / Math.max(1, frequency)) / 4);
      const specificity = tag.length >= 5 ? 1 : tag.length === 4 ? 0.88 : tag.length === 3 ? 0.68 : 0.42;
      const score = specificity * (0.55 + rarity * 0.45);
      if (score > anchor) {
        anchor = score;
        anchorTerm = tag;
      }
    }

    const category = String(memory.category || '').toUpperCase();
    const hasExplicitFact = /(?:\d{1,4}[年/-]|\d{1,2}[月日号天周]|今天|明天|后天|出发|出差|行程|会议|计划|期限)/.test(String(memory.content || ''));
    const protectedEvidence = (keyword >= 0.42 || anchor >= 0.58) && (
      hasExplicitFact || category === 'P' || category === 'T'
    );

    return {
      keyword: clamp01(keyword),
      anchor: clamp01(anchor),
      anchorTerm,
      protectedEvidence
    };
  });
}

function jaccardSimilarity(left, right) {
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  for (const value of left) {
    if (right.has(value)) intersection++;
  }
  const union = left.size + right.size - intersection;
  return union > 0 ? intersection / union : 0;
}

function memorySimilarity(left, right) {
  if (!left || !right) return 0;
  const leftText = normalizeText(left.content);
  const rightText = normalizeText(right.content);

  if (leftText && rightText && leftText === rightText) return 1;

  let containment = 0;
  if (leftText.length >= 8 && rightText.length >= 8 && (leftText.includes(rightText) || rightText.includes(leftText))) {
    containment = Math.min(leftText.length, rightText.length) / Math.max(leftText.length, rightText.length);
  }

  const textSimilarity = jaccardSimilarity(
    lexicalTokens([left.content, left.context].filter(Boolean).join(' ')),
    lexicalTokens([right.content, right.context].filter(Boolean).join(' '))
  );
  const leftTags = new Set(parseTags(left.tags).map(normalizeText).filter(Boolean));
  const rightTags = new Set(parseTags(right.tags).map(normalizeText).filter(Boolean));
  const rawTagSimilarity = jaccardSimilarity(leftTags, rightTags);
  // A single broad tag such as “北京” or “亲密” is not enough to declare two
  // memories duplicates. Require multiple shared descriptors for tag-only folding.
  const sharedTags = [...leftTags].filter(tag => rightTags.has(tag));
  const tagSimilarity = sharedTags.length >= 2 ? rawTagSimilarity : 0;

  const dateTokens = value => new Set(String(value?.content || '').match(/\d{1,4}(?:年|月|日|号|天|周)?/g) || []);
  const leftDates = dateTokens(left);
  const rightDates = dateTokens(right);
  const conflictingDates = leftDates.size && rightDates.size && ![...leftDates].some(token => rightDates.has(token));

  let similarity = Math.max(containment, textSimilarity, tagSimilarity * 0.9);
  if (sharedTags.length >= 2 && textSimilarity >= 0.22) similarity = Math.max(similarity, 0.76);
  if (textSimilarity >= 0.38) similarity = Math.max(similarity, 0.74 + Math.min(0.16, (textSimilarity - 0.38) * 0.8));
  if (conflictingDates) similarity = Math.min(similarity, 0.58);

  return clamp01(similarity);
}

function readCandidateSignals(memory, calibratedEvidence = null) {
  return {
    vector: clamp01(memory?._vectorScore),
    keyword: clamp01(calibratedEvidence?.keyword),
    anchor: clamp01(calibratedEvidence?.anchor),
    importance: clamp01(Number(memory?.importance || 0) / 10),
    emotion: clamp01(Number(memory?.emotionalWeight || 0) / 10),
    existingScore: clamp01(memory?._searchScore),
    legacyKeyword: clamp01(memory?._keywordScore),
    legacyAnchor: clamp01(memory?._anchorScore),
    calibratedAnchorTermLength: String(calibratedEvidence?.anchorTerm || '').length,
    legacyAnchorTermLength: String(memory?._anchorMatchedTerm || '').length,
    legacyAnchorMatchedCount: Math.max(0, Number(memory?._anchorMatchedCount || 0)),
    normalizedQueryLength: Math.max(0, Number(memory?._normalizedQueryLength || 0)),
    protectedEvidence: calibratedEvidence?.protectedEvidence ? 1 : 0
  };
}

function evaluateAdmission(memory, calibratedEvidence = null) {
  const signals = readCandidateSignals(memory, calibratedEvidence);
  const supportingSignals = [
    signals.keyword >= 0.12,
    signals.anchor >= 0.3
  ].filter(Boolean).length;
  const anchorIsSpecific = signals.anchor >= 0.58;

  let admitted = false;
  let route = 'rejected';
  let reason = 'insufficient_relevance_evidence';

  if (anchorIsSpecific) {
    admitted = true;
    route = 'explicit_anchor';
    reason = 'rare_exact_anchor';
  } else if (signals.keyword >= 0.58) {
    admitted = true;
    route = 'explicit_anchor';
    reason = 'strong_keyword_evidence';
  } else if (signals.vector >= 0.78) {
    admitted = true;
    route = 'composite_semantic';
    reason = 'very_high_semantic_match';
  } else if (signals.vector >= 0.68 && supportingSignals >= 1) {
    admitted = true;
    route = 'composite_semantic';
    reason = 'semantic_match_with_support';
  } else if (signals.vector >= 0.64 && signals.importance >= 0.8 && signals.emotion >= 0.7) {
    admitted = true;
    route = 'composite_semantic';
    reason = 'salient_semantic_match';
  } else if (signals.keyword >= 0.3 && signals.vector >= 0.5) {
    admitted = true;
    route = 'composite_semantic';
    reason = 'combined_keyword_semantic_match';
  } else if (signals.keyword >= 0.32 && signals.anchor >= 0.42) {
    admitted = true;
    route = 'explicit_anchor';
    reason = 'moderate_anchor_keyword_match';
  } else if (signals.importance >= 0.8 || signals.emotion >= 0.8) {
    reason = 'importance_or_emotion_without_relevance';
  }

  const admissionScore = clamp01(
    Math.max(signals.anchor, signals.vector, signals.keyword) * 0.72 +
    signals.vector * 0.12 +
    signals.keyword * 0.08 +
    signals.anchor * 0.08
  );

  return {
    id: String(memory?.id || ''),
    category: String(memory?.category || ''),
    admitted,
    route,
    reason,
    admissionScore: Number(admissionScore.toFixed(6)),
    signals: Object.fromEntries(Object.entries(signals).map(([key, value]) => [
      key,
      Number.isInteger(value) ? value : Number(value.toFixed(6))
    ]))
  };
}

function runRecallShadowPolicy(candidates, options = {}) {
  const safeCandidates = (Array.isArray(candidates) ? candidates : [])
    .filter(candidate => candidate && candidate.id && String(candidate.category || '').toUpperCase() !== 'C')
    .slice(0, Math.max(1, Number(options.candidateLimit || 60)));
  const targetLimit = Math.max(1, Math.min(30, Number(options.targetLimit || 12)));
  const duplicateThreshold = clamp01(options.duplicateThreshold ?? 0.72);
  const mmrLambda = clamp01(options.mmrLambda ?? 0.76);
  const quotas = { ...DEFAULT_CATEGORY_QUOTAS, ...(options.categoryQuotas || {}) };

  const calibratedEvidence = buildShadowEvidence(safeCandidates, options);
  const decisions = safeCandidates.map((memory, index) => ({
    memory,
    ...evaluateAdmission(memory, calibratedEvidence[index]),
    calibratedAnchorTerm: calibratedEvidence[index]?.anchorTerm || '',
    selected: false,
    finalReason: ''
  }));
  const admitted = decisions
    .filter(decision => decision.admitted)
    .sort((left, right) => right.admissionScore - left.admissionScore);
  const selected = [];
  const categoryCounts = new Map();

  while (selected.length < targetLimit) {
    let best = null;

    for (const decision of admitted) {
      if (decision.selected || decision.finalReason) continue;

      const category = String(decision.category || 'E').toUpperCase();
      const quota = Math.max(1, Number(quotas[category] || 3));
      const categoryExcess = Math.max(0, (categoryCounts.get(category) || 0) - quota + 1);
      const protectedEvidence = decision.signals.protectedEvidence > 0;
      const softQuotaPenalty = protectedEvidence ? 0 : Math.min(0.16, categoryExcess * 0.045);

      let maxSimilarity = 0;
      let duplicateOf = '';
      for (const selectedDecision of selected) {
        const similarity = memorySimilarity(decision.memory, selectedDecision.memory);
        if (similarity > maxSimilarity) {
          maxSimilarity = similarity;
          duplicateOf = selectedDecision.id;
        }
      }

      if (maxSimilarity >= duplicateThreshold) {
        decision.finalReason = 'near_duplicate';
        decision.duplicateOf = duplicateOf;
        decision.maxSimilarity = Number(maxSimilarity.toFixed(6));
        continue;
      }

      const mmrScore = mmrLambda * decision.admissionScore - (1 - mmrLambda) * maxSimilarity - softQuotaPenalty;
      if (!best || mmrScore > best.mmrScore) {
        best = { decision, mmrScore, maxSimilarity, softQuotaPenalty };
      }
    }

    if (!best) break;
    best.decision.selected = true;
    best.decision.finalReason = 'selected_by_shadow';
    best.decision.mmrScore = Number(best.mmrScore.toFixed(6));
    best.decision.maxSimilarity = Number(best.maxSimilarity.toFixed(6));
    best.decision.softQuotaPenalty = Number(best.softQuotaPenalty.toFixed(6));
    selected.push(best.decision);
    const category = String(best.decision.category || 'E').toUpperCase();
    categoryCounts.set(category, (categoryCounts.get(category) || 0) + 1);
  }

  for (const decision of admitted) {
    if (!decision.selected && !decision.finalReason) {
      decision.finalReason = selected.length >= targetLimit ? 'shadow_limit' : 'not_selected';
    }
  }

  for (const decision of decisions) {
    if (!decision.admitted) decision.finalReason = decision.reason;
  }

  const compactDecisions = decisions.map(({ memory, ...decision }) => decision);
  const routeCounts = compactDecisions.reduce((counts, decision) => {
    counts[decision.route] = (counts[decision.route] || 0) + 1;
    return counts;
  }, {});
  const legacySaturatedCount = compactDecisions.filter(decision =>
    decision.signals.legacyKeyword >= 0.99 || decision.signals.legacyAnchor >= 0.99
  ).length;
  const calibratedSaturatedCount = compactDecisions.filter(decision =>
    decision.signals.keyword >= 0.99 || decision.signals.anchor >= 0.99
  ).length;

  return {
    mode: 'shadow',
    version: 'stage3-shadow-v1.1',
    behaviorChanged: false,
    evidenceMode: 'short-query-candidate-idf',
    categoryQuotaMode: 'soft-penalty',
    candidateCount: safeCandidates.length,
    admittedCount: compactDecisions.filter(decision => decision.admitted).length,
    rejectedCount: compactDecisions.filter(decision => !decision.admitted).length,
    selectedCount: selected.length,
    zeroRecall: selected.length === 0,
    legacySaturatedCount,
    calibratedSaturatedCount,
    selectedMemoryIds: selected.map(decision => decision.id),
    routeCounts,
    categoryCounts: Object.fromEntries(categoryCounts),
    decisions: compactDecisions
  };
}

module.exports = {
  DEFAULT_CATEGORY_QUOTAS,
  evaluateAdmission,
  memorySimilarity,
  runRecallShadowPolicy
};
