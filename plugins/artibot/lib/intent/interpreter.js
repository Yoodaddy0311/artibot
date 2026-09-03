/**
 * Intent interpreter — the four runtime-activation axes of Artibot v5.
 *
 * `package/02_PRODUCT_UX_NATURAL_LANGUAGE_RUNTIME.md:53-58` states that the
 * runtime must "infer at least" work purpose, depth, completion expectation and
 * performance preference from natural language. This module is that inference,
 * and nothing else: it is a **pure function**. No clock, no filesystem, no
 * randomness, and no LLM call. Lane 1 section 3.1 fixes that purity rule
 * ("`lib/mission/*` and `lib/intent/{interpreter,confidence}.js` have no clock,
 * no FS, no randomness") because the Observe-phase shadow comparison only means
 * anything if the same input always yields the same contract.
 *
 * WHAT THIS MODULE DOES NOT DO
 * - It does not modify `lib/intent/index.js#detectIntent` or `ambiguity.js`.
 *   Those keep their own vocabulary (`action:*` / `team:*`) and this module
 *   consumes their OUTPUT as one signal among several.
 * - It does not decide topology, model, or command activation. Those are
 *   downstream consumers of the profile this feeds.
 * - It does not ask the user anything. See `lib/planning/question-gate.js`.
 *
 * VOCABULARY PROVENANCE — every value below is copied from a design document.
 * Nothing here is invented; where two documents disagree, the disagreement is
 * recorded in the constant's comment rather than silently resolved.
 *
 * @module lib/intent/interpreter
 */

// ---------------------------------------------------------------------------
// Axis vocabularies
// ---------------------------------------------------------------------------

/**
 * Work purpose — 12 values, verbatim from
 * `package/02_PRODUCT_UX_NATURAL_LANGUAGE_RUNTIME.md:55`:
 *   explain/investigate/design/implement/debug/review/compare/migrate/
 *   refactor/release/document/operate
 *
 * Order is the document's order, kept so a reader can diff the two by eye.
 * @type {readonly string[]}
 */
export const WORK_PURPOSES = Object.freeze([
  'explain',
  'investigate',
  'design',
  'implement',
  'debug',
  'review',
  'compare',
  'migrate',
  'refactor',
  'release',
  'document',
  'operate',
]);

/**
 * Depth — 4 values, verbatim from **P02**`:56`: direct/plan/deep-plan/ultraplan.
 *
 * All four are accepted by the landed execution-profile schema at
 * `schemas/execution-profile.schema.json` (`reasoning.depth`), which also
 * admits a fifth value `deep` from `ADDENDUM-HARDENING.md:119`. `deep` is NOT
 * produced here: P02 is the axis definition and lists four. Emitting a value
 * this module cannot justify from the axis list would be inventing vocabulary.
 * @type {readonly string[]}
 */
export const DEPTHS = Object.freeze(['direct', 'plan', 'deep-plan', 'ultraplan']);

/**
 * Ordering for depth escalation. A prompt that carries cues for several depths
 * resolves to the deepest one — asking for more thought than requested is the
 * recoverable error; asking for less silently under-serves the request.
 * @type {Readonly<Record<string, number>>}
 */
export const DEPTH_RANK = Object.freeze({
  direct: 0,
  plan: 1,
  'deep-plan': 2,
  ultraplan: 3,
});

/**
 * Completion expectation — 7 values, verbatim from **P02**`:57`:
 *   answer/artifact/implement/test/commit/PR/deploy
 *
 * `PR` keeps its upper-case spelling from the document. Downstream consumers
 * that need a lower-case key must map it; this module does not silently
 * normalise a documented token.
 * @type {readonly string[]}
 */
export const COMPLETION_EXPECTATIONS = Object.freeze([
  'answer',
  'artifact',
  'implement',
  'test',
  'commit',
  'PR',
  'deploy',
]);

/**
 * Ordering for completion expectation. The document lists them in increasing
 * reach (an answer changes nothing; a deploy changes production), and the
 * resolved value is the furthest-reaching cue found, because a prompt that says
 * "implement and deploy" expects the deploy.
 * @type {Readonly<Record<string, number>>}
 */
export const COMPLETION_RANK = Object.freeze({
  answer: 0,
  artifact: 1,
  implement: 2,
  test: 3,
  commit: 4,
  PR: 5,
  deploy: 6,
});

/**
 * Performance priority — 5 values.
 *
 * THIS IS THE ONE AXIS WHERE TWO LANDED SOURCES DISAGREE, so read the reason
 * before changing it. **P02**`:58` writes the axis as prose:
 *   `economy/balanced/high-quality/fast/maximum-performance`
 * The landed T-18 schema (`schemas/execution-profile.schema.json`,
 * `performance.priority`) accepts `economy|balanced|quality|fast|
 * maximum_performance` (from `package/schemas/mission-contract.schema.yaml:37`)
 * and **explicitly rejects** the two hyphenated P02 spellings. Its README says
 * so in as many words at `schemas/execution-profile.README.md:86-89`:
 * "Not accepted: `high-quality` and `maximum-performance` from P02:58 ...
 * Consumers that need to read P02 prose must map it, not feed it in raw."
 *
 * This module is such a consumer, so it emits the schema-valid spellings and
 * exposes the mapping as {@link PERFORMANCE_PROSE_ALIASES}. Emitting the P02
 * prose forms would produce an `execution_profile` that fails its own
 * validator; emitting five invented values would be worse still.
 * @type {readonly string[]}
 */
export const PERFORMANCE_PRIORITIES = Object.freeze([
  'economy',
  'balanced',
  'quality',
  'fast',
  'maximum_performance',
]);

/**
 * P02 prose spelling -> schema-valid spelling. Exported so a caller reading the
 * design document directly can translate without re-deriving the mapping.
 * @type {Readonly<Record<string, string>>}
 */
export const PERFORMANCE_PROSE_ALIASES = Object.freeze({
  'high-quality': 'quality',
  'maximum-performance': 'maximum_performance',
});

/**
 * Resolution order when several performance cues fire at once.
 *
 * Ordered to preserve the two rows of the P02 example table (`:70-77`) that
 * would otherwise collide:
 * - "최대한 빨리 정확하게" -> `autopilot --fast`, so a speed cue must beat a
 *   quality cue. Hence `fast` outranks `quality`.
 * - "토큰 아끼지 말고 제대로 처리해" -> high-resource mode, so the
 *   spend-freely phrase must beat everything. Hence `maximum_performance` is
 *   first, and a bare "최대한" is deliberately NOT a cue for it (that word
 *   appears in the `--fast` row).
 * `economy` sits above `fast` because an explicit budget ceiling constrains how
 * fast the runtime is allowed to be, not the other way round.
 * @type {readonly string[]}
 */
export const PERFORMANCE_PRECEDENCE = Object.freeze([
  'maximum_performance',
  'economy',
  'fast',
  'quality',
  'balanced',
]);

// ---------------------------------------------------------------------------
// Lexicons
//
// Keyword-and-pattern based, per the T-24 brief: zero LLM calls. Each axis maps
// a value to the surface cues that evidence it. Korean and English are both
// first-class because the runtime's own users write Korean prompts; the cue
// lists intentionally overlap with `lib/intent/language.js` without importing
// it, since that module's vocabulary is the `action:*` intent space and not
// these four axes.
// ---------------------------------------------------------------------------

/** @type {Readonly<Record<string, readonly string[]>>} */
export const WORK_PURPOSE_CUES = Object.freeze({
  explain: Object.freeze([
    'explain', 'describe', 'what is', 'what does', 'how does', 'walk me through',
    '설명', '알려줘', '이해', '무엇', '뭐야', '뭔지',
  ]),
  investigate: Object.freeze([
    'investigate', 'analyze', 'analyse', 'research', 'look into', 'find out',
    'root cause', 'diagnose',
    '조사', '분석', '파악', '원인', '알아봐', '들여다', '진단',
  ]),
  design: Object.freeze([
    'design', 'architecture', 'architect', 'adr', 'schema', 'data model',
    'boundary',
    '설계', '아키텍처', '구조', '스키마', '경계',
  ]),
  implement: Object.freeze([
    'implement', 'build', 'create', 'add', 'feature', 'write code', 'scaffold',
    '구현', '만들', '추가', '개발', '기능',
  ]),
  debug: Object.freeze([
    'debug', 'fix', 'bug', 'error', 'broken', 'crash', 'failing', 'regression',
    '디버그', '버그', '오류', '에러', '수정', '고쳐', '고쳐줘', '안 돼', '실패',
  ]),
  review: Object.freeze([
    'review', 'audit', 'inspect', 'code review', 'critique',
    '리뷰', '검토', '검수', '감사', '점검',
  ]),
  compare: Object.freeze([
    'compare', 'benchmark', 'versus', ' vs ', 'trade-off', 'tradeoff',
    'alternative', 'which is better',
    '비교', '벤치마크', '대안', '트레이드오프', '나을까', '차이',
  ]),
  migrate: Object.freeze([
    'migrate', 'migration', 'upgrade', 'port to', 'backfill', 'cutover',
    '마이그레이션', '이관', '업그레이드', '이전',
  ]),
  refactor: Object.freeze([
    'refactor', 'cleanup', 'clean up', 'simplify', 'dedupe', 'deduplicate',
    'tidy', 'restructure',
    '리팩터', '리팩토링', '정리', '단순화', '중복 제거',
  ]),
  release: Object.freeze([
    'release', 'deploy', 'ship', 'publish', 'rollout', 'cut a version',
    '배포', '릴리스', '릴리즈', '출시',
  ]),
  document: Object.freeze([
    'document', 'documentation', 'docs', 'readme', 'changelog', 'write up',
    '문서', '문서화', '리드미', '변경이력',
  ]),
  operate: Object.freeze([
    'operate', 'operations', 'monitor', 'monitoring', 'runbook', 'incident',
    'oncall', 'on-call', 'restart', 'rollback',
    '운영', '운용', '모니터링', '장애', '재시작', '롤백',
  ]),
});

/**
 * Depth cues.
 *
 * The `deep-plan` and `plan` rows are taken from the P02 example table
 * (`:70-77`): "간단히 고쳐줘" -> direct or plan-lite; "구조부터 보고 제대로
 * 해줘" -> deep plan; "근본적으로 해결해줘" -> systemic diagnosis.
 * @type {Readonly<Record<string, readonly string[]>>}
 */
export const DEPTH_CUES = Object.freeze({
  direct: Object.freeze([
    'just', 'quickly', 'simple', 'simply', 'one-liner', 'small fix',
    '간단히', '간단하게', '바로', '그냥', '살짝',
  ]),
  plan: Object.freeze([
    'plan', 'planning', 'roadmap', 'break down', 'step by step',
    '계획', '플랜', '단계별', '나눠서',
  ]),
  'deep-plan': Object.freeze([
    'deep plan', 'deep-plan', 'thoroughly', 'structure first', 'from the ground up',
    'systemically', 'properly',
    '깊게', '구조부터', '제대로', '근본적', '꼼꼼하게', '철저히', '빈틈없이',
  ]),
  ultraplan: Object.freeze([
    'ultraplan', 'ultra plan', 'exhaustively', 'every angle',
    '울트라플랜', '최대한 깊게', '완전히 설계', '전방위',
  ]),
});

/** @type {Readonly<Record<string, readonly string[]>>} */
export const COMPLETION_CUES = Object.freeze({
  answer: Object.freeze([
    'tell me', 'what is', 'why', 'how does', 'answer',
    '알려줘', '설명해', '뭐야', '왜',
  ]),
  artifact: Object.freeze([
    'write a doc', 'draft', 'report', 'summary', 'spec', 'proposal', 'adr',
    '문서', '리포트', '보고서', '초안', '산출물', '정리해줘',
  ]),
  implement: Object.freeze([
    'implement', 'code it', 'apply', 'make the change', 'patch',
    '구현', '코드', '적용', '반영',
  ]),
  test: Object.freeze([
    'test', 'tests', 'coverage', 'verify', 'regression',
    '테스트', '검증', '커버리지',
  ]),
  commit: Object.freeze([
    'commit', 'check in',
    '커밋',
  ]),
  PR: Object.freeze([
    'pull request', 'pr', 'merge request',
    '풀리퀘', '풀 리퀘스트', '피알',
  ]),
  deploy: Object.freeze([
    'deploy', 'release', 'ship it', 'rollout', 'publish',
    '배포', '릴리스', '릴리즈', '출시',
  ]),
});

/** @type {Readonly<Record<string, readonly string[]>>} */
export const PERFORMANCE_CUES = Object.freeze({
  economy: Object.freeze([
    'cheap', 'cheaply', 'economy', 'save tokens', 'low budget', 'budget',
    '토큰 아껴', '아껴서', '저렴', '싸게', '비용 아껴',
  ]),
  balanced: Object.freeze([
    'balanced', 'reasonable',
    '균형', '적당히',
  ]),
  quality: Object.freeze([
    'high quality', 'high-quality', 'quality', 'thorough', 'rigorous',
    'meticulous', 'careful',
    '품질', '정확하게', '완성도', '빈틈없', '꼼꼼',
  ]),
  fast: Object.freeze([
    'fast', 'quickly', 'asap', 'as fast as', 'hurry', 'in a hurry',
    '빨리', '빠르게', '서둘러', '급해',
  ]),
  maximum_performance: Object.freeze([
    'maximum performance', 'max performance', 'all out', 'no expense',
    "don't spare", 'spare no',
    '토큰 아끼지 말고', '아끼지 말고', '최대 성능', '최고 품질', '자원 아끼지',
  ]),
});

/**
 * `detectIntent` intent tokens that evidence a work purpose.
 *
 * Only the unambiguous rows are mapped. `action:test` and `action:deploy` are
 * deliberately absent here and appear in {@link INTENT_TO_COMPLETION} instead —
 * "run the tests" states a completion expectation, not a work purpose.
 * `action:plan` is absent from both: planning is the depth axis.
 * @type {Readonly<Record<string, string>>}
 */
export const INTENT_TO_PURPOSE = Object.freeze({
  'action:build': 'implement',
  'action:implement': 'implement',
  'action:fix': 'debug',
  'action:review': 'review',
  'action:refactor': 'refactor',
  'action:deploy': 'release',
  'action:document': 'document',
  'action:analyze': 'investigate',
  'action:explain': 'explain',
  'action:design': 'design',
});

/** @type {Readonly<Record<string, string>>} */
export const INTENT_TO_COMPLETION = Object.freeze({
  'action:test': 'test',
  'action:deploy': 'deploy',
  'action:document': 'artifact',
  'action:explain': 'answer',
});

/**
 * Defaults used when an axis has no cue at all.
 *
 * Each default is chosen to fail toward doing LESS, so that a missed cue
 * under-serves rather than over-reaches:
 * - `depth: direct` — the least reasoning, so nothing is spent on a request
 *   that never asked for planning.
 * - `completion_expectation: answer` — the only value that implies no
 *   repository write at all.
 * - `performance: balanced` — the mission contract's own default
 *   (`package/03_INTENT_MISSION_COMPILER.md:32-33`,
 *   `performance: { priority: balanced }`).
 *
 * `work_purpose` has NO default and resolves to `null` when nothing matched.
 * The twelve purposes have no "least" member, so any default would be a guess,
 * and `confidence.js` needs to see the absence in order to score `goal` low.
 * @type {Readonly<{depth: string, completion_expectation: string, performance: string}>}
 */
export const AXIS_DEFAULTS = Object.freeze({
  depth: 'direct',
  completion_expectation: 'answer',
  performance: 'balanced',
});

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

const ASCII_ONLY = /^[\x20-\x7E]+$/;

/**
 * Escape a literal for use inside a RegExp.
 * @param {string} s
 * @returns {string}
 */
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Does `haystack` contain `cue`?
 *
 * ASCII cues are matched with alphanumeric boundaries so that `test` does not
 * fire inside `latest` and `pr` does not fire inside `prompt`. Non-ASCII cues
 * (Korean here) are matched as plain substrings, because Korean is written
 * without spaces between a stem and its particles and a boundary assertion
 * would reject every inflected form.
 *
 * @param {string} haystack - Lower-cased prompt.
 * @param {string} cue
 * @returns {boolean}
 */
export function cueMatches(haystack, cue) {
  if (!cue) return false;
  if (!ASCII_ONLY.test(cue)) return haystack.includes(cue);
  const body = escapeRe(cue.toLowerCase());
  return new RegExp(`(?<![a-z0-9])${body}(?![a-z0-9])`).test(haystack);
}

/**
 * Count how many distinct cues of each value fired.
 * @param {string} haystack
 * @param {Readonly<Record<string, readonly string[]>>} lexicon
 * @returns {{ hits: Record<string, number>, cues: Record<string, string[]> }}
 */
function scoreLexicon(haystack, lexicon) {
  /** @type {Record<string, number>} */
  const hits = {};
  /** @type {Record<string, string[]>} */
  const cues = {};
  for (const [value, list] of Object.entries(lexicon)) {
    for (const cue of list) {
      if (!cueMatches(haystack, cue)) continue;
      hits[value] = (hits[value] ?? 0) + 1;
      (cues[value] ??= []).push(cue);
    }
  }
  return { hits, cues };
}

/**
 * Pick the winner of a hit table by count, breaking ties with `order`.
 * @param {Record<string, number>} hits
 * @param {readonly string[]} order - Tie-break precedence, first wins.
 * @returns {string|null}
 */
function pickByCount(hits, order) {
  let best = null;
  let bestCount = 0;
  for (const value of order) {
    const count = hits[value] ?? 0;
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Pick the highest-ranked value that fired at all, ignoring hit counts.
 * @param {Record<string, number>} hits
 * @param {Readonly<Record<string, number>>} rank
 * @returns {string|null}
 */
function pickByRank(hits, rank) {
  let best = null;
  for (const value of Object.keys(hits)) {
    if (best === null || rank[value] > rank[best]) best = value;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * @typedef {object} InterpreterEvidence
 * @property {string} axis - One of `work_purpose`|`depth`|`completion_expectation`|`performance`.
 * @property {string} value - The axis value this evidence supports.
 * @property {string} cue - The surface token, intent id, or setting path observed.
 * @property {'prompt'|'intent'|'classification'|'explicit_setting'} source
 */

/**
 * @typedef {object} Interpretation
 * @property {string|null} work_purpose - Resolved purpose, or `null` when unevidenced.
 * @property {string[]} work_purposes - Every purpose with at least one cue, most-evidenced first.
 * @property {string} depth - One of {@link DEPTHS}.
 * @property {string} completion_expectation - Furthest-reaching of {@link COMPLETION_EXPECTATIONS}.
 * @property {string[]} completion_expectations - Every completion tier with a cue, in document order.
 * @property {string} performance - One of {@link PERFORMANCE_PRIORITIES}.
 * @property {string[]} defaulted - Axis names that fell back to {@link AXIS_DEFAULTS}.
 * @property {InterpreterEvidence[]} evidence - Every observation, in axis order.
 */

/**
 * Interpret a prompt into the four runtime-activation axes.
 *
 * Pure: the result is a function of the arguments alone. Calling it twice with
 * the same input returns equal objects, which is what makes the Observe-phase
 * shadow comparison meaningful.
 *
 * @param {object} [input]
 * @param {string} [input.prompt] - Raw user text.
 * @param {object} [input.intent] - `detectIntent()` output; only `intents` and
 *   `ambiguity` are read, and both are optional.
 * @param {object} [input.classification] - `classifyComplexity()` output. Only
 *   `system` is read here: system 2 is the document's "deep path", so it raises
 *   the depth floor to `plan`. The `factors` breakdown is consumed by
 *   `confidence.js`, not by this module.
 * @param {object} [input.config] - Explicit settings. `config.execution_profile`
 *   is honoured as the "Explicit Setting" input of the four-way funnel drawn at
 *   `ADDENDUM-HARDENING.md:104-110`, and an explicit value overrides inference.
 * @returns {Interpretation}
 */
export function interpretIntent(input = {}) {
  const { prompt = '', intent = null, classification = null, config = null } = input;
  const haystack = String(prompt ?? '').toLowerCase();

  /** @type {InterpreterEvidence[]} */
  const evidence = [];
  /** @type {string[]} */
  const defaulted = [];

  const purpose = resolveWorkPurpose(haystack, intent, evidence);
  let depth = resolveDepth(haystack, classification, evidence, defaulted);
  const completion = resolveCompletion(haystack, intent, evidence, defaulted);
  let performance = resolvePerformance(haystack, evidence, defaulted);

  // Explicit settings win. `ADDENDUM-HARDENING.md:104-110` draws four inputs
  // feeding one execution profile — natural language, command, skill, explicit
  // setting — and a setting the user wrote down is not an inference to be
  // overruled by one this module made.
  depth = applyExplicitDepth(depth, config, evidence, defaulted);
  performance = applyExplicitPerformance(performance, config, evidence, defaulted);

  return {
    work_purpose: purpose.resolved,
    work_purposes: purpose.ranked,
    depth,
    completion_expectation: completion.resolved,
    completion_expectations: completion.tiers,
    performance,
    defaulted,
    evidence,
  };
}

/**
 * Remove the first occurrence of `value` from `list`, in place.
 * @param {string[]} list
 * @param {string} value
 * @returns {void}
 */
function removeFrom(list, value) {
  const i = list.indexOf(value);
  if (i >= 0) list.splice(i, 1);
}

// ---------------------------------------------------------------------------
// Per-axis resolution
//
// One function per axis. They append to the shared `evidence` and `defaulted`
// arrays rather than returning them, so that the evidence stays in axis order
// and `interpretIntent` remains a short, readable sequence.
// ---------------------------------------------------------------------------

/**
 * @param {string} haystack
 * @param {object|null} intent
 * @param {InterpreterEvidence[]} evidence
 * @returns {{ resolved: string|null, ranked: string[] }}
 */
function resolveWorkPurpose(haystack, intent, evidence) {
  const scored = scoreLexicon(haystack, WORK_PURPOSE_CUES);
  for (const [value, list] of Object.entries(scored.cues)) {
    for (const cue of list) evidence.push({ axis: 'work_purpose', value, cue, source: 'prompt' });
  }
  for (const id of intent?.intents ?? []) {
    const mapped = INTENT_TO_PURPOSE[id];
    if (!mapped) continue;
    scored.hits[mapped] = (scored.hits[mapped] ?? 0) + 1;
    evidence.push({ axis: 'work_purpose', value: mapped, cue: id, source: 'intent' });
  }
  const ranked = Object.keys(scored.hits).sort(
    (a, b) => scored.hits[b] - scored.hits[a]
      || WORK_PURPOSES.indexOf(a) - WORK_PURPOSES.indexOf(b),
  );
  // No default: the twelve purposes have no "least" member, so `null` is the
  // honest answer and `confidence.js` scores `goal` low on the strength of it.
  return { resolved: pickByCount(scored.hits, ranked) ?? null, ranked };
}

/**
 * @param {string} haystack
 * @param {object|null} classification
 * @param {InterpreterEvidence[]} evidence
 * @param {string[]} defaulted
 * @returns {string}
 */
function resolveDepth(haystack, classification, evidence, defaulted) {
  const scored = scoreLexicon(haystack, DEPTH_CUES);
  for (const [value, list] of Object.entries(scored.cues)) {
    for (const cue of list) evidence.push({ axis: 'depth', value, cue, source: 'prompt' });
  }
  let depth = pickByRank(scored.hits, DEPTH_RANK);
  // `classifyComplexity` calls system 2 the "deep path" (lib/cognitive/router.js
  // :292-296), so it raises the floor — it never lowers a deeper cue.
  if (classification?.system === 2 && DEPTH_RANK[depth ?? 'direct'] < DEPTH_RANK.plan) {
    depth = 'plan';
    evidence.push({ axis: 'depth', value: 'plan', cue: 'system=2', source: 'classification' });
  }
  if (depth === null) {
    defaulted.push('depth');
    return AXIS_DEFAULTS.depth;
  }
  return depth;
}

/**
 * @param {string} haystack
 * @param {object|null} intent
 * @param {InterpreterEvidence[]} evidence
 * @param {string[]} defaulted
 * @returns {{ resolved: string, tiers: string[] }}
 */
function resolveCompletion(haystack, intent, evidence, defaulted) {
  const scored = scoreLexicon(haystack, COMPLETION_CUES);
  for (const [value, list] of Object.entries(scored.cues)) {
    for (const cue of list) {
      evidence.push({ axis: 'completion_expectation', value, cue, source: 'prompt' });
    }
  }
  for (const id of intent?.intents ?? []) {
    const mapped = INTENT_TO_COMPLETION[id];
    if (!mapped) continue;
    scored.hits[mapped] = (scored.hits[mapped] ?? 0) + 1;
    evidence.push({ axis: 'completion_expectation', value: mapped, cue: id, source: 'intent' });
  }
  const tiers = COMPLETION_EXPECTATIONS.filter((v) => scored.hits[v]);
  const resolved = pickByRank(scored.hits, COMPLETION_RANK);
  if (resolved === null) {
    defaulted.push('completion_expectation');
    return { resolved: AXIS_DEFAULTS.completion_expectation, tiers };
  }
  return { resolved, tiers };
}

/**
 * @param {string} haystack
 * @param {InterpreterEvidence[]} evidence
 * @param {string[]} defaulted
 * @returns {string}
 */
function resolvePerformance(haystack, evidence, defaulted) {
  const scored = scoreLexicon(haystack, PERFORMANCE_CUES);
  for (const [value, list] of Object.entries(scored.cues)) {
    for (const cue of list) evidence.push({ axis: 'performance', value, cue, source: 'prompt' });
  }
  for (const value of PERFORMANCE_PRECEDENCE) {
    if (scored.hits[value]) return value;
  }
  defaulted.push('performance');
  return AXIS_DEFAULTS.performance;
}

/**
 * @param {string} depth - Inferred depth.
 * @param {object|null} config
 * @param {InterpreterEvidence[]} evidence
 * @param {string[]} defaulted
 * @returns {string}
 */
function applyExplicitDepth(depth, config, evidence, defaulted) {
  const explicit = config?.execution_profile?.reasoning?.depth;
  if (!DEPTHS.includes(explicit)) return depth;
  removeFrom(defaulted, 'depth');
  evidence.push({
    axis: 'depth',
    value: explicit,
    cue: 'execution_profile.reasoning.depth',
    source: 'explicit_setting',
  });
  return explicit;
}

/**
 * @param {string} performance - Inferred priority.
 * @param {object|null} config
 * @param {InterpreterEvidence[]} evidence
 * @param {string[]} defaulted
 * @returns {string}
 */
function applyExplicitPerformance(performance, config, evidence, defaulted) {
  const explicit = config?.execution_profile?.performance?.priority;
  // A caller quoting P02 prose gets it translated rather than dropped, per
  // schemas/execution-profile.README.md:86-89.
  const normalised = PERFORMANCE_PROSE_ALIASES[explicit] ?? explicit;
  if (!PERFORMANCE_PRIORITIES.includes(normalised)) return performance;
  removeFrom(defaulted, 'performance');
  evidence.push({
    axis: 'performance',
    value: normalised,
    cue: 'execution_profile.performance.priority',
    source: 'explicit_setting',
  });
  return normalised;
}
