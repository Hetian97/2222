const CURRENT_FACT_VERSION = 'current-fact-shadow-v1';

const FIRST_PERSON_CUE = /(?:^|[，。！？；\s])(?:我|本人)/u;
const CURRENT_CUE = /(?:现在|目前|这会儿|此刻|今天|今日|已经|还在|仍然|刚刚|刚才|刚到|刚回|正在)/u;
const PAST_ONLY_CUE = /(?:去年|前年|上个月|上月|上周|以前|曾经|当时|那次|小时候|多年前|之前)/u;
const FUTURE_CUE = /(?:明天|后天|下周|下个月|将来|以后|准备|打算|计划|预计|到时候)/u;
const HYPOTHETICAL_CUE = /(?:如果|假如|假设|比如|可能|也许|或许)/u;
const QUESTION_CUE = /(?:吗|么|是不是|是否|什么|哪里|哪儿|怎么|为何|为什么|\?|？)/u;
const RESIDENCE_CUE = /(?:住在|住到了|搬到|搬回|定居在|长期住在)/u;
const TRIP_CUE = /(?:出差|旅行|旅程|行程|返程|启程|出发|到达|抵达|回程)/u;
const TRIP_STATE_CUE = /(?:正在|还在|仍在|已经|刚刚|刚|到了|到达|抵达|出发|启程|回来|返回|结束)/u;
const BODY_STATE_CUE = /(?:现在|目前|今天|还在|仍然|刚刚|刚|已经|开始|结束|过去|好了|恢复|不再|没有|又)/u;
const TASK_OBJECT = /(?:任务|项目|工作|报告|材料|论文|申请|手续|课程|训练|检查|治疗)/u;
const TASK_STATE_CUE = /(?:正在|还在|仍在|已经|刚刚|刚|完成|提交|处理|进行|暂停|结束|取消)/u;
const LOCATION_PATTERN = /(?:我|本人)(?:(?:现在|目前|这会儿|此刻|已经|刚刚|刚)){0,3}(?:人)?(?:正在)?(?:不在|在|到了|到达|抵达|回到|来到)\s*([^，。！？；]{1,30})/u;
const NON_LOCATION_ACTION = /(?:吃|喝|做|看|读|写|睡|洗|穿|买|聊|说|想|觉得|需要|准备|工作|学习|训练|治疗|检查|等待|等候|陪|帮|收拾|整理|处理|使用|休息|拥抱)/u;
const BODY_ANCHORS = [
  { key: 'menstrual_cycle', pattern: /(?:生理期|经期|月经)/u },
  { key: 'allergy', pattern: /过敏/u },
  { key: 'asthma', pattern: /哮喘/u },
  { key: 'cold', pattern: /感冒/u },
  { key: 'fever', pattern: /(?:发烧|低烧|高烧|发热)/u },
  { key: 'cough', pattern: /咳嗽/u },
  { key: 'head_pain', pattern: /(?:偏头痛|头(?:部)?[^，。！？；]{0,4}(?:疼|痛))/u },
  { key: 'abdominal_pain', pattern: /(?:腹痛|肚子[^，。！？；]{0,4}(?:疼|痛))/u },
  { key: 'stomach_pain', pattern: /(?:胃[^，。！？；]{0,4}(?:疼|痛))/u },
  { key: 'chest_tightness', pattern: /胸闷/u },
  { key: 'hypoxia', pattern: /缺氧/u },
  { key: 'dizziness', pattern: /头晕/u },
  { key: 'nausea', pattern: /恶心/u },
  { key: 'general_discomfort', pattern: /(?:身体不舒服|很不舒服|身体已经恢复|已经康复|已经痊愈)/u }
];

function clampScore(value) {
  return Math.max(0, Math.min(1, Number(value || 0)));
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 500);
}

function normalizeKey(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .slice(0, 120);
}

function splitClauses(query) {
  return normalizeText(query)
    .split(/[。！？!?；;\n\r]+/u)
    .map(value => value.trim())
    .filter(value => value.length >= 3)
    .slice(0, 10);
}

function normalizeSourceScope(input = {}) {
  const type = ['private', 'group', 'system', 'unknown'].includes(String(input.type || input.sourceType || '').toLowerCase())
    ? String(input.type || input.sourceType).toLowerCase()
    : 'unknown';
  return {
    type,
    sourceChatId: String(input.sourceChatId || '').trim(),
    mountedChatId: String(input.mountedChatId || '').trim(),
    latestSpeakerId: String(input.latestSpeakerId || input.speakerId || '').trim(),
    latestSpeakerRole: String(input.latestSpeakerRole || input.speakerRole || '').trim().toLowerCase(),
    privateMemoryEligible: type === 'private'
  };
}

function findCurrentFact(facts, slotKey) {
  return (Array.isArray(facts) ? facts : [])
    .filter(fact => fact && fact.slotKey === slotKey && ['current', 'shadow_candidate'].includes(String(fact.status)))
    .sort((a, b) => Number(b.effectiveAt || b.updatedAt || 0) - Number(a.effectiveAt || a.updatedAt || 0))[0] || null;
}

function addCandidate(candidates, facts, clause, input) {
  const slotKey = String(input.slotKey || '').trim();
  if (!slotKey || candidates.some(item => item.slotKey === slotKey)) return;
  const existing = findCurrentFact(facts, slotKey);
  const value = normalizeText(input.value || clause);
  const sameValue = existing && normalizeKey(existing.value || existing.statement) === normalizeKey(value);
  candidates.push({
    action: sameValue ? 'repeat_candidate' : (existing ? 'supersede_candidate' : 'create_candidate'),
    factType: input.factType,
    subjectKey: 'user',
    slotKey,
    value,
    statement: clause,
    confidence: Number(clampScore(input.confidence).toFixed(6)),
    targetFactId: existing?.id || null,
    reasons: [...new Set(input.reasons || [])],
    effectiveAtEvidence: 'generation_completed_at'
  });
}

function extractBodyAnchor(clause) {
  for (const anchor of BODY_ANCHORS) {
    const label = clause.match(anchor.pattern)?.[0];
    if (label) return { key: anchor.key, label };
  }
  return null;
}

function extractTaskAnchor(clause) {
  return clause.match(TASK_OBJECT)?.[0] || '';
}

function extractLocationValue(clause) {
  const match = clause.match(LOCATION_PATTERN);
  if (!match) return '';
  const negative = /(?:我|本人)(?:(?:现在|目前|这会儿|此刻|已经|刚刚|刚)){0,3}(?:人)?(?:正在)?不在/u.test(clause);
  const place = match[1]
    .replace(/(?:出差|旅行|开会|办事)(?:中|期间)?$/u, '')
    .replace(/(?:了|呢|呀|啊)$/u, '')
    .trim();
  const value = negative ? `不在${place}` : place;
  if (!value || value.length > 24 || NON_LOCATION_ACTION.test(value)) return '';
  return value;
}

function assessClause(clause, facts) {
  const reasons = [];
  const candidates = [];
  const firstPerson = FIRST_PERSON_CUE.test(` ${clause}`);
  const current = CURRENT_CUE.test(clause);
  const pastOnly = PAST_ONLY_CUE.test(clause) && !current;
  const future = FUTURE_CUE.test(clause) && !current;
  const hypothetical = HYPOTHETICAL_CUE.test(clause);
  const question = QUESTION_CUE.test(clause);
  if (!firstPerson) reasons.push('no_explicit_user_subject');
  if (pastOnly) reasons.push('past_only_statement');
  if (future) reasons.push('future_plan_not_current_fact');
  if (hypothetical) reasons.push('hypothetical_statement');
  if (question) reasons.push('question_not_assertion');

  const eligible = firstPerson && !pastOnly && !future && !hypothetical && !question;
  if (eligible && RESIDENCE_CUE.test(clause) && current) {
    addCandidate(candidates, facts, clause, {
      factType: 'current_residence',
      slotKey: 'user.residence.current',
      value: clause,
      confidence: 0.9,
      reasons: ['explicit_user_subject', 'current_time_evidence', 'residence_state_language']
    });
  }

  if (eligible && TRIP_CUE.test(clause) && TRIP_STATE_CUE.test(clause)) {
    addCandidate(candidates, facts, clause, {
      factType: 'current_trip_state',
      slotKey: 'user.trip.current',
      value: clause,
      confidence: current ? 0.9 : 0.82,
      reasons: ['explicit_user_subject', 'current_trip_state_language']
    });
  }

  const bodyAnchor = extractBodyAnchor(clause);
  if (eligible && bodyAnchor && BODY_STATE_CUE.test(clause)) {
    addCandidate(candidates, facts, clause, {
      factType: 'current_body_state',
      slotKey: `user.body.${bodyAnchor.key}`,
      value: clause,
      confidence: 0.88,
      reasons: ['explicit_user_subject', 'current_body_state_language', `state_anchor:${bodyAnchor.label}`]
    });
  }

  const locationValue = extractLocationValue(clause);
  if (eligible && locationValue && current) {
    addCandidate(candidates, facts, clause, {
      factType: 'current_location',
      slotKey: 'user.location.current',
      value: locationValue,
      confidence: 0.9,
      reasons: ['explicit_user_subject', 'current_time_evidence', 'location_state_language']
    });
  }

  const taskAnchor = extractTaskAnchor(clause);
  if (eligible && taskAnchor && TASK_STATE_CUE.test(clause)) {
    addCandidate(candidates, facts, clause, {
      factType: 'current_task_state',
      slotKey: `user.task.${normalizeKey(taskAnchor)}`,
      value: clause,
      confidence: 0.82,
      reasons: ['explicit_user_subject', 'current_task_state_language', `state_anchor:${taskAnchor}`]
    });
  }

  if (!candidates.length && !reasons.length) reasons.push('no_supported_current_fact_structure');
  return { clause, proposed: candidates.length > 0, candidates, reasons };
}

function runCurrentFactShadow(facts, options = {}) {
  const query = normalizeText(options.query);
  const sourceScope = normalizeSourceScope(options.sourceScope || {});
  const writesEnabled = options.writesEnabled === true;
  let decisions = splitClauses(query).map(clause => assessClause(clause, facts));
  const speakerIsUser = !sourceScope.latestSpeakerRole || ['user', 'human'].includes(sourceScope.latestSpeakerRole);
  if (!sourceScope.privateMemoryEligible || !speakerIsUser) {
    const reason = !sourceScope.privateMemoryEligible ? 'non_private_source_excluded' : 'non_user_speaker_excluded';
    decisions = decisions.map(item => ({ ...item, proposed: false, candidates: [], reasons: [...new Set([...item.reasons, reason])] }));
  }
  const candidates = decisions.flatMap(item => item.candidates).slice(0, 6);
  return {
    mode: 'shadow',
    version: CURRENT_FACT_VERSION,
    behaviorChanged: false,
    injectionEnabled: false,
    writesEnabled,
    writeTiming: 'generation_succeeded_only',
    query,
    sourceScope,
    candidateCount: candidates.length,
    candidates,
    decisions,
    stopReason: candidates.length
      ? 'shadow_candidates_recorded'
      : (!sourceScope.privateMemoryEligible ? 'non_private_source_excluded' : (!speakerIsUser ? 'non_user_speaker_excluded' : 'no_supported_current_fact'))
  };
}

module.exports = {
  CURRENT_FACT_VERSION,
  runCurrentFactShadow
};
