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
  const leftTags = new Set((Array.isArray(left.tags) ? left.tags : []).map(normalizeText).filter(Boolean));
  const rightTags = new Set((Array.isArray(right.tags) ? right.tags : []).map(normalizeText).filter(Boolean));
  const rawTagSimilarity = jaccardSimilarity(leftTags, rightTags);
  // A single broad tag such as “北京” or “亲密” is not enough to declare two
  // memories duplicates. Require multiple shared descriptors for tag-only folding.
  const tagSimilarity = Math.min(leftTags.size, rightTags.size) >= 2 ? rawTagSimilarity : 0;

  return clamp01(Math.max(containment, textSimilarity, tagSimilarity * 0.9));
}

function readCandidateSignals(memory) {
  return {
    vector: clamp01(memory?._vectorScore),
    keyword: clamp01(memory?._keywordScore),
    anchor: clamp01(memory?._anchorScore),
    importance: clamp01(Number(memory?.importance || 0) / 10),
    emotion: clamp01(Number(memory?.emotionalWeight || 0) / 10),
    existingScore: clamp01(memory?._searchScore),
    anchorTermLength: String(memory?._anchorMatchedTerm || '').length,
    anchorMatchedCount: Math.max(0, Number(memory?._anchorMatchedCount || 0)),
    normalizedQueryLength: Math.max(0, Number(memory?._normalizedQueryLength || 0))
  };
}

function evaluateAdmission(memory) {
  const signals = readCandidateSignals(memory);
  const supportingSignals = [
    signals.keyword >= 0.1,
    signals.importance >= 0.8,
    signals.emotion >= 0.7
  ].filter(Boolean).length;
  const anchorIsSpecific = signals.anchor >= 0.5 && (
    signals.anchorMatchedCount >= 2 ||
    signals.anchorTermLength >= 3 ||
    (
      signals.anchorTermLength >= 2 &&
      signals.normalizedQueryLength > 0 &&
      signals.normalizedQueryLength <= signals.anchorTermLength + 1
    ) ||
    signals.vector >= 0.45
  );

  let admitted = false;
  let route = 'rejected';
  let reason = 'insufficient_relevance_evidence';

  if (anchorIsSpecific) {
    admitted = true;
    route = 'explicit_anchor';
    reason = 'rare_exact_anchor';
  } else if (signals.keyword >= 0.55 && signals.anchor < 0.5) {
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
  } else if (signals.vector >= 0.56 && supportingSignals >= 2) {
    admitted = true;
    route = 'composite_semantic';
    reason = 'multi_signal_semantic_match';
  } else if (signals.keyword >= 0.34 && signals.vector >= 0.45) {
    admitted = true;
    route = 'composite_semantic';
    reason = 'combined_keyword_semantic_match';
  } else if (signals.keyword >= 0.38 && signals.anchor >= 0.22 && anchorIsSpecific) {
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

  const decisions = safeCandidates.map(memory => ({
    memory,
    ...evaluateAdmission(memory),
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
      if ((categoryCounts.get(category) || 0) >= quota) {
        decision.finalReason = 'category_quota';
        continue;
      }

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

      const mmrScore = mmrLambda * decision.admissionScore - (1 - mmrLambda) * maxSimilarity;
      if (!best || mmrScore > best.mmrScore) {
        best = { decision, mmrScore, maxSimilarity };
      }
    }

    if (!best) break;
    best.decision.selected = true;
    best.decision.finalReason = 'selected_by_shadow';
    best.decision.mmrScore = Number(best.mmrScore.toFixed(6));
    best.decision.maxSimilarity = Number(best.maxSimilarity.toFixed(6));
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

  return {
    mode: 'shadow',
    version: 'stage3-shadow-v1',
    behaviorChanged: false,
    candidateCount: safeCandidates.length,
    admittedCount: compactDecisions.filter(decision => decision.admitted).length,
    rejectedCount: compactDecisions.filter(decision => !decision.admitted).length,
    selectedCount: selected.length,
    zeroRecall: selected.length === 0,
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
