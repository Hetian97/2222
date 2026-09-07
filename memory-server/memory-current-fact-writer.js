const crypto = require('crypto');

const CURRENT_FACT_WRITE_VERSION = 'current-fact-write-v1';

function normalizeKey(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .slice(0, 240);
}

function deterministicFactId(chatId, slotKey, value) {
  const digest = crypto.createHash('sha256')
    .update(`${chatId}\n${slotKey}\n${normalizeKey(value)}`)
    .digest('hex')
    .slice(0, 20);
  return `current_fact_${digest}`;
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
    writeVersion: CURRENT_FACT_WRITE_VERSION,
    sourceType: 'private',
    sourceSearchIds,
    history: [...history, addition].slice(-50)
  };
}

function planCurrentFactWrites(log, existingFacts = [], options = {}) {
  const writesEnabled = options.writesEnabled === true;
  const shadow = log?.currentFactShadow || {};
  const sourceScope = shadow.sourceScope || {};
  const chatId = String(log?.chatId || '').trim();
  const sourceChatId = String(sourceScope.sourceChatId || '').trim();
  const base = {
    version: CURRENT_FACT_WRITE_VERSION,
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
  if (sourceScope.type !== 'private' || sourceScope.privateMemoryEligible !== true) return { ...base, reason: 'non_private_source' };
  if (!chatId || !sourceChatId || sourceChatId !== chatId) return { ...base, reason: 'private_source_chat_mismatch' };

  const factsById = new Map((Array.isArray(existingFacts) ? existingFacts : []).map(fact => [String(fact.id), fact]));
  const operations = [];
  const skipped = [];
  for (const candidate of (Array.isArray(shadow.candidates) ? shadow.candidates : []).slice(0, 6)) {
    const confidence = Math.max(0, Math.min(1, Number(candidate.confidence || 0)));
    const slotKey = String(candidate.slotKey || '').trim();
    const value = String(candidate.value || '').trim().slice(0, 500);
    const statement = String(candidate.statement || value).trim().slice(0, 500);
    if (!slotKey || !value || confidence < 0.78) {
      skipped.push({ slotKey, value, reason: 'candidate_below_write_requirements' });
      continue;
    }
    const target = factsById.get(String(candidate.targetFactId || '')) || null;
    const id = candidate.action === 'repeat_candidate' && target
      ? target.id
      : deterministicFactId(chatId, slotKey, value);
    const existing = factsById.get(id) || null;
    const effectiveAt = Number(log.generationCompletedAt || log.createdAt || Date.now());
    const auditEntry = {
      at: Date.now(),
      searchTraceId: String(log.id || ''),
      turnId: String(log.turnId || ''),
      attemptId: String(log.attemptId || ''),
      actionType: String(log.actionType || 'reply'),
      candidateAction: String(candidate.action || 'create_candidate'),
      statement,
      slotKey,
      confidence,
      reasons: Array.isArray(candidate.reasons) ? candidate.reasons : [],
      sourceScope: {
        type: 'private',
        sourceChatId,
        mountedChatId: String(sourceScope.mountedChatId || '')
      }
    };
    operations.push({
      action: existing ? 'update_candidate' : 'create_candidate',
      id,
      fact: {
        ...(existing || {}),
        id,
        chatId,
        subjectKey: String(candidate.subjectKey || 'user'),
        factType: String(candidate.factType || 'type_uncertain'),
        slotKey,
        value,
        statement,
        status: 'shadow_candidate',
        effectiveAt: Number(existing?.effectiveAt || effectiveAt),
        validUntil: existing?.validUntil || null,
        supersedesFactId: candidate.action === 'supersede_candidate' ? (target?.id || null) : (existing?.supersedesFactId || null),
        supersededByFactId: null,
        sourceSearchId: String(log.id || ''),
        evidence: mergeEvidence(existing?.evidence, auditEntry),
        confidence: Math.max(Number(existing?.confidence || 0), confidence),
        surfaceMode: 'manual_only'
      },
      reason: candidate.action === 'supersede_candidate'
        ? 'shadow_supersede_candidate_recorded'
        : (existing ? 'shadow_candidate_evidence_updated' : 'shadow_candidate_recorded')
    });
  }

  return {
    ...base,
    status: operations.length ? 'ready' : 'no_operations',
    reason: operations.length ? 'private_current_fact_candidates_ready' : 'no_eligible_current_fact_candidate',
    operationCount: operations.length,
    operations,
    skipped
  };
}

module.exports = {
  CURRENT_FACT_WRITE_VERSION,
  deterministicFactId,
  planCurrentFactWrites
};
