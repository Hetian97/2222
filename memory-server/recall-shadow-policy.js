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

function longestCjkOverlap(leftValue, rightValue) {
  const leftRuns = String(leftValue || '').normalize('NFKC').toLowerCase().match(/[\u3400-\u9fff]+/g) || [];
  const right = normalizeText(rightValue);
  let longest = 0;
  for (const run of leftRuns) {
    const maximum = Math.min(12, run.length);
    for (let size = maximum; size >= 2 && size > longest; size--) {
      let matched = false;
      for (let index = 0; index <= run.length - size; index++) {
        if (right.includes(run.slice(index, index + size))) {
          longest = size;
          matched = true;
          break;
        }
      }
      if (matched) break;
    }
  }
  return longest;
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

function buildQuerySegments(query) {
  const values = [query];
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
    const parts = text.split(/[\n\r，,。.!?！？；;：:、|/\\]+/)
      .map(part => part.trim())
      .filter(part => part.length >= 2 && part.length <= 96)
      .slice(-10);
    if (parts.length <= 1 && text.length <= 96) add(text);
    parts.forEach(add);
  }
  return segments.slice(0, 18);
}

function buildQueryFacets(segments, documentFrequency, total) {
  const candidates = [];
  const structuralReferencePattern = /(?:\d{1,4}(?:[-/.年月日号时点]|$)|[a-z][a-z0-9_.:/-]{2,})/iu;

  for (const segment of segments) {
    const tokens = [...lexicalTokens(segment)].filter(token => {
      const frequency = documentFrequency.get(token) || 0;
      return frequency > 0 && (frequency <= Math.max(4, Math.ceil(total * 0.45)) || /[a-z0-9]/i.test(token));
    });
    if (!tokens.length) continue;

    const normalized = normalizeText(segment);
    const supportedRareTokens = tokens.filter(token => (documentFrequency.get(token) || total) <= Math.max(3, Math.ceil(total * 0.22)));
    const hasStructuralReference = structuralReferencePattern.test(segment);
    // Facets are evidence-driven rather than topic-word driven: a clause must contain
    // several candidate-supported rare n-grams, or a generic date/identifier shape.
    // No character name, place, event, emotion, or domain vocabulary is hard-coded here.
    const minimumRareTokens = normalized.length >= 8 ? 3 : 4;
    if (!hasStructuralReference && supportedRareTokens.length < minimumRareTokens) continue;

    const tokenSet = new Set(tokens);
    const specificity = tokens.reduce((sum, token) => {
      const frequency = documentFrequency.get(token) || 0;
      return sum + 1 + Math.log((total + 1) / (frequency + 1));
    }, 0) / Math.sqrt(tokens.length);
    candidates.push({
      id: `facet_${candidates.length + 1}`,
      text: segment,
      tokens: tokenSet,
      specificity
    });
  }

  const selected = [];
  for (const candidate of candidates.sort((a, b) => b.specificity - a.specificity)) {
    const overlapsExisting = selected.some(existing => {
      const similarity = jaccardSimilarity(candidate.tokens, existing.tokens);
      const left = normalizeText(candidate.text);
      const right = normalizeText(existing.text);
      return similarity >= 0.55 || (left.length >= 5 && right.length >= 5 && (left.includes(right) || right.includes(left)));
    });
    if (!overlapsExisting) selected.push(candidate);
    if (selected.length >= 4) break;
  }

  return selected.map((facet, index) => ({ ...facet, id: `facet_${index + 1}` }));
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
  const primaryQuery = String(options.primaryQuery || options.query || '').trim();
  const intentAnchors = (Array.isArray(options.intentAnchors) ? options.intentAnchors : [])
    .map(item => ({
      term: normalizeText(item?.term),
      weight: Math.max(0, Number(item?.weight || 0)),
      count: Math.max(0, Number(item?.count || 0))
    }))
    .filter(item => item.term.length >= 2 && item.weight > 0);
  const intentAnchorWeight = intentAnchors.reduce((sum, item) => sum + item.weight, 0);
  const segments = buildQuerySegments(primaryQuery);
  const segmentTokens = segments.map(segment => lexicalTokens(segment));
  const facets = buildQueryFacets(segments, documentFrequency, total);
  const tagFrequency = new Map();
  for (const memory of candidates) {
    const uniqueTags = new Set(parseTags(memory.tags).map(normalizeText).filter(Boolean));
    for (const tag of uniqueTags) tagFrequency.set(tag, (tagFrequency.get(tag) || 0) + 1);
  }

  const evidence = candidates.map((memory, index) => {
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

    const searchableText = [memory.content, memory.context, ...parseTags(memory.tags)].filter(Boolean).join(' ');
    const longestPhraseOverlap = segments.reduce(
      (maximum, segment) => Math.max(maximum, longestCjkOverlap(segment, searchableText)),
      0
    );
    const normalizedSearchableText = normalizeText(searchableText);
    const matchedIntentAnchors = intentAnchors.filter(item => normalizedSearchableText.includes(item.term));
    const matchedIntentWeight = matchedIntentAnchors.reduce((sum, item) => sum + item.weight, 0);
    const intentAnchorCoverage = intentAnchorWeight > 0 ? matchedIntentWeight / intentAnchorWeight : 0;
    const longestIntentAnchor = matchedIntentAnchors.reduce(
      (maximum, item) => Math.max(maximum, item.term.length),
      0
    );
    const intentAnchorScore = matchedIntentAnchors.length
      ? clamp01(0.44 + intentAnchorCoverage * 0.28 + Math.min(0.16, longestIntentAnchor * 0.035) + Math.min(0.08, (matchedIntentAnchors.length - 1) * 0.04))
      : 0;
    // A lone two-character overlap is often conversational glue rather than evidence.
    // Cap it generically; longer contiguous phrases, identifiers and exact tags can still pass.
    if (longestPhraseOverlap < 3 && !/[a-z][a-z0-9_.:/-]{2,}/iu.test(primaryQuery)) {
      keyword = Math.min(keyword, 0.28);
    } else if (longestPhraseOverlap === 3) {
      keyword = Math.min(keyword, 0.62);
    } else if (longestPhraseOverlap === 4) {
      keyword = Math.min(keyword, 0.78);
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
    const hasExplicitFact = /(?:\d{1,4}(?:[-/.年月日号时点]|$)|[a-z][a-z0-9_.:/-]{2,})/iu.test(String(memory.content || ''));
    const protectedEvidence = intentAnchorCoverage >= 0.55 || matchedIntentAnchors.length >= 2 || anchor >= 0.58 || (
      keyword >= 0.58 && (hasExplicitFact || category === 'P' || category === 'T' || longestPhraseOverlap >= 5)
    );

    const normalizedTags = parseTags(memory.tags).map(normalizeText).filter(Boolean);
    const facetScores = facets.map(facet => {
      let matchedWeight = 0;
      let facetWeight = 0;
      for (const token of facet.tokens) {
        const frequency = documentFrequency.get(token) || 0;
        const weight = 1 + Math.log((total + 1) / (frequency + 1));
        facetWeight += weight;
        if (documents[index].has(token)) matchedWeight += weight;
      }
      const coverage = facetWeight > 0 ? matchedWeight / facetWeight : 0;
      const normalizedFacet = normalizeText(facet.text);
      const exactEntityAnchor = normalizedTags.some(tag => tag.length >= 4 && normalizedFacet.includes(tag));
      return {
        id: facet.id,
        score: clamp01(Math.max(Math.sqrt(coverage) * coverage, exactEntityAnchor ? Math.max(0.45, coverage) : 0)),
        exactEntityAnchor
      };
    });
    const bestFacet = [...facetScores].sort((a, b) => b.score - a.score)[0] || { id: '', score: 0 };

    return {
      keyword: clamp01(keyword),
      anchor: clamp01(anchor),
      anchorTerm,
      longestPhraseOverlap,
      intentAnchorCount: matchedIntentAnchors.length,
      intentAnchorCoverage,
      intentAnchorScore,
      longestIntentAnchor,
      protectedEvidence,
      bestFacetId: bestFacet.id,
      bestFacetScore: bestFacet.score,
      facetScores
    };
  });
  evidence.facets = facets.map(facet => ({ id: facet.id, text: facet.text }));
  evidence.primaryQuery = primaryQuery;
  return evidence;
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
  // A single broad tag is not enough to declare two memories duplicates.
  // Require multiple shared descriptors for tag-only folding.
  const sharedTags = [...leftTags].filter(tag => rightTags.has(tag));
  const tagSimilarity = sharedTags.length >= 2 ? rawTagSimilarity : 0;
  const preciseSharedTag = sharedTags.some(tag => tag.length >= 4);

  const dateTokens = value => new Set(String(value?.content || '').match(/\d{1,4}(?:年|月|日|号|天|周)?/g) || []);
  const leftDates = dateTokens(left);
  const rightDates = dateTokens(right);
  const conflictingDates = leftDates.size && rightDates.size && ![...leftDates].some(token => rightDates.has(token));

  let similarity = Math.max(containment, textSimilarity, tagSimilarity * 0.9);
  if (sharedTags.length >= 2 && textSimilarity >= 0.12) similarity = Math.max(similarity, 0.76);
  if (preciseSharedTag && textSimilarity >= 0.18) similarity = Math.max(similarity, 0.73);
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
    intentAnchorCount: Math.max(0, Number(calibratedEvidence?.intentAnchorCount || 0)),
    intentAnchorCoverage: clamp01(calibratedEvidence?.intentAnchorCoverage),
    intentAnchorScore: clamp01(calibratedEvidence?.intentAnchorScore),
    longestIntentAnchor: Math.max(0, Number(calibratedEvidence?.longestIntentAnchor || 0)),
    protectedEvidence: calibratedEvidence?.protectedEvidence ? 1 : 0
  };
}

function evaluateAdmission(memory, calibratedEvidence = null) {
  const signals = readCandidateSignals(memory, calibratedEvidence);
  const supportingSignals = [
    signals.keyword >= 0.12,
    signals.anchor >= 0.3,
    signals.intentAnchorScore >= 0.58
  ].filter(Boolean).length;
  const anchorIsSpecific = signals.anchor >= 0.58;
  const intentAnchorIsSupported = signals.intentAnchorScore >= 0.58 && signals.vector >= 0.4;

  let admitted = false;
  let route = 'rejected';
  let reason = 'insufficient_relevance_evidence';

  if (anchorIsSpecific) {
    admitted = true;
    route = 'explicit_anchor';
    reason = 'rare_exact_anchor';
  } else if (intentAnchorIsSupported) {
    admitted = true;
    route = 'explicit_anchor';
    reason = 'rare_intent_anchor_with_semantic_support';
  } else if (signals.keyword >= 0.58) {
    admitted = true;
    route = 'explicit_anchor';
    reason = 'strong_keyword_evidence';
  } else if (signals.vector >= 0.72) {
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
    Math.max(signals.anchor, signals.vector, signals.keyword, intentAnchorIsSupported ? signals.intentAnchorScore : 0) * 0.72 +
    signals.vector * 0.12 +
    signals.keyword * 0.08 +
    signals.anchor * 0.08 +
    signals.importance * 0.04 +
    signals.emotion * 0.02
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
    eventClusterId: String(memory?._shadowEventClusterId || ''),
    precisionCandidate: Boolean(memory?._shadowPrecisionCandidate),
    calibratedAnchorTerm: calibratedEvidence[index]?.anchorTerm || '',
    bestFacetId: calibratedEvidence[index]?.bestFacetId || '',
    bestFacetScore: Number((calibratedEvidence[index]?.bestFacetScore || 0).toFixed(6)),
    facetScores: (calibratedEvidence[index]?.facetScores || []).map(facet => ({
      id: facet.id,
      score: Number(facet.score.toFixed(6)),
      exactEntityAnchor: Boolean(facet.exactEntityAnchor)
    })),
    selected: false,
    finalReason: ''
  }));
  const admitted = decisions
    .filter(decision => decision.admitted)
    .sort((left, right) => right.admissionScore - left.admissionScore);
  const selected = [];
  const selectedEventClusters = new Map();
  const categoryCounts = new Map();
  let selectionStopReason = '';

  const selectDecision = (decision, meta = {}) => {
    decision.selected = true;
    decision.finalReason = meta.finalReason || 'selected_by_shadow';
    decision.mmrScore = Number((meta.mmrScore ?? decision.admissionScore).toFixed(6));
    decision.maxSimilarity = Number((meta.maxSimilarity || 0).toFixed(6));
    decision.softQuotaPenalty = Number((meta.softQuotaPenalty || 0).toFixed(6));
    if (meta.facetId) decision.reservedForFacet = meta.facetId;
    selected.push(decision);
    if (decision.eventClusterId) selectedEventClusters.set(decision.eventClusterId, decision.id);
    const category = String(decision.category || 'E').toUpperCase();
    categoryCounts.set(category, (categoryCounts.get(category) || 0) + 1);
  };

  // Candidate generation may explicitly reserve exact full-store FTS hits for Shadow.
  // They still need admission evidence; this only prevents an admitted precise hit from
  // being crowded out by the mixed-rank top 60 before diversity selection runs.
  for (const decision of admitted.filter(item =>
    item.precisionCandidate &&
    item.signals.protectedEvidence > 0 &&
    item.admissionScore >= 0.58
  ).slice(0, Math.min(4, targetLimit))) {
    if (decision.eventClusterId && selectedEventClusters.has(decision.eventClusterId)) {
      decision.finalReason = 'same_event_cluster';
      decision.duplicateOf = selectedEventClusters.get(decision.eventClusterId);
      continue;
    }
    const maxSimilarity = selected.reduce((maximum, selectedDecision) => Math.max(
      maximum,
      memorySimilarity(decision.memory, selectedDecision.memory)
    ), 0);
    if (maxSimilarity >= duplicateThreshold) continue;
    selectDecision(decision, {
      finalReason: 'selected_for_precision_evidence',
      mmrScore: decision.admissionScore,
      maxSimilarity
    });
  }

  const facetIds = [...new Set(decisions.flatMap(decision => decision.facetScores.map(facet => facet.id)))];
  for (const facetId of facetIds) {
    if (selected.length >= targetLimit) break;
    const facetCandidate = admitted
      .filter(decision => !decision.selected && !decision.finalReason)
      .filter(decision => !decision.eventClusterId || !selectedEventClusters.has(decision.eventClusterId))
      .map(decision => ({
        decision,
        facetScore: decision.facetScores.find(facet => facet.id === facetId)?.score || 0,
        exactEntityAnchor: Boolean(decision.facetScores.find(facet => facet.id === facetId)?.exactEntityAnchor),
        maxSimilarity: selected.reduce((maximum, selectedDecision) => Math.max(
          maximum,
          memorySimilarity(decision.memory, selectedDecision.memory)
        ), 0)
      }))
      .filter(item => item.maxSimilarity < duplicateThreshold)
      .filter(item => item.facetScore >= 0.55 && item.decision.admissionScore >= 0.55)
      .sort((left, right) => {
        const leftExact = left.decision.facetScores.find(facet => facet.id === facetId)?.exactEntityAnchor ? 0.18 : 0;
        const rightExact = right.decision.facetScores.find(facet => facet.id === facetId)?.exactEntityAnchor ? 0.18 : 0;
        const leftScore = left.facetScore * 0.62 + left.decision.admissionScore * 0.38 + leftExact;
        const rightScore = right.facetScore * 0.62 + right.decision.admissionScore * 0.38 + rightExact;
        return rightScore - leftScore;
      })[0];
    if (facetCandidate) {
      selectDecision(facetCandidate.decision, {
        finalReason: 'selected_for_topic_facet',
        facetId,
        mmrScore: facetCandidate.facetScore * 0.62 + facetCandidate.decision.admissionScore * 0.38,
        maxSimilarity: facetCandidate.maxSimilarity
      });
    }
  }

  while (selected.length < targetLimit) {
    let best = null;

    for (const decision of admitted) {
      if (decision.selected || decision.finalReason) continue;

      if (decision.eventClusterId && selectedEventClusters.has(decision.eventClusterId)) {
        decision.finalReason = 'same_event_cluster';
        decision.duplicateOf = selectedEventClusters.get(decision.eventClusterId);
        continue;
      }

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

    if (!best) {
      if (selected.length < targetLimit && admitted.some(decision => !decision.selected)) {
        selectionStopReason = 'no_distinct_candidate';
      }
      break;
    }
    const minimumSelectionScore = selected.length === 0 ? 0.42 : selected.length < 7 ? 0.59 : 0.64;
    if (best.mmrScore < minimumSelectionScore) {
      best.decision.finalReason = 'below_selection_floor';
      selectionStopReason = 'below_selection_floor';
      break;
    }
    selectDecision(best.decision, best);
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
    version: 'stage3-shadow-v1.6',
    behaviorChanged: false,
    evidenceMode: 'primary-intent-context-reference',
    primaryQuery: calibratedEvidence.primaryQuery || '',
    contextReferenceCount: Array.isArray(options.contextQueries) ? options.contextQueries.length : 0,
    topicFacets: calibratedEvidence.facets || [],
    topicFacetCount: facetIds.length,
    topicFacetSelectedCount: compactDecisions.filter(decision => decision.reservedForFacet).length,
    categoryQuotaMode: 'soft-penalty',
    eventClusterMode: 'high-confidence-shadow-fold',
    eventClusterFoldedCount: compactDecisions.filter(decision => decision.finalReason === 'same_event_cluster').length,
    candidateCount: safeCandidates.length,
    precisionCandidateCount: compactDecisions.filter(decision => decision.precisionCandidate).length,
    precisionSelectedCount: compactDecisions.filter(decision => decision.finalReason === 'selected_for_precision_evidence').length,
    admittedCount: compactDecisions.filter(decision => decision.admitted).length,
    rejectedCount: compactDecisions.filter(decision => !decision.admitted).length,
    selectedCount: selected.length,
    selectionStopReason,
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
