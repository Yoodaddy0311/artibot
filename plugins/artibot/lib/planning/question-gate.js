/**
 * Human question gate — judgment only.
 *
 * `ADDENDUM-HARDENING.md:659-677` ("Human Question Gate를 Execution Profile과
 * 연결") opens with the constraint that drives this whole module:
 *
 *   > 질문 여부는 단순 confidence threshold만으로 결정하면 안 된다.
 *
 * and then names four conditions that must hold *together* (`:663-673`):
 *
 *   Human value judgment required
 *   + Material downstream impact
 *   + Evidence cannot decide
 *   + Cost of wrong assumption is meaningful
 *
 * The `+` is a conjunction, not a score. Three of four is not three quarters of
 * a reason to interrupt someone — it is a reason to keep working. So
 * {@link requiresQuestion} is a plain AND, and the accompanying test walks all
 * sixteen combinations to prove only `1111` opens the gate.
 *
 * THIS MODULE DOES NOT WRITE QUESTIONS. It returns `{required, kind, reason}`
 * and stops. Lane 1 section 3.6 (`:233`) fixes that boundary: "`question-gate`
 * 는 질문을 만들지 않고 판정만 반환합니다". A pure module that reaches for a
 * tool stops being testable, and `package/15_DECISION_REGISTER.md` D09 already
 * pins the *timing* of asking to the start of ADR work — which is a scheduling
 * decision, handled here by {@link planQuestionBatch}, not a phrasing one.
 *
 * WHICH GATE THIS IS. Lane 1 section 3.6 lists four human gates and puts only
 * one of them in the compiler: the product-decision gate. Destructive work,
 * deployment, and external writes are enforced at `PreToolUse` against real
 * arguments, because judging destructiveness from prompt text is bypassed by
 * rewording the sentence. Do not add those three here.
 *
 * Pure: no clock, no filesystem, no randomness (lane 1 section 3.1).
 *
 * @module lib/planning/question-gate
 */

import {
  COMPLETION_EXPECTATIONS,
  COMPLETION_RANK,
  cueMatches,
} from '../intent/interpreter.js';

/**
 * The four condition keys, in the order `ADDENDUM-HARDENING.md:665-671` lists
 * them. Exported so a caller can enumerate them without hardcoding strings.
 * @type {readonly string[]}
 */
export const GATE_CONDITIONS = Object.freeze([
  'valueJudgmentRequired',
  'materialDownstreamImpact',
  'evidenceCannotDecide',
  'costOfWrongAssumptionMeaningful',
]);

/**
 * The only `kind` this gate can return. The other three human gates named in
 * lane 1 section 3.6 belong to `PreToolUse`, so they never appear here.
 * @type {string}
 */
export const PRODUCT_DECISION = 'product_decision';

/**
 * Where a fired gate's question should be asked.
 *
 * `ADDENDUM-HARDENING.md:673-677`: "ADR 초기에는 필요한 질문을 빠르게 모아서
 * 한 번에 제시하는 방식을 우선한다. 질문을 여러 차례 산발적으로 던지는 것은
 * 피한다." The batching point is therefore a property of the system, not of any
 * one verdict, which is why it is a constant here rather than a fourth key on
 * the verdict object.
 * @type {string}
 */
export const QUESTION_BATCH_POINT = 'adr_start';

// ---------------------------------------------------------------------------
// Condition cues
// ---------------------------------------------------------------------------

/**
 * Condition 1 — the request turns on a human's values: a preference, a product
 * call, a naming or priority choice. Nothing in the repository can settle these
 * because they are not facts about the repository.
 * @type {readonly string[]}
 */
export const VALUE_JUDGMENT_CUES = Object.freeze([
  'which should', 'which one', 'should we', 'do you prefer', 'prefer',
  'pick one', 'decide', 'decision', 'naming', 'name it', 'priority',
  'prioritise', 'prioritize', 'policy', 'trade-off', 'tradeoff',
  'option a', 'option b', 'either way',
  '어느 걸로', '어느 쪽', '뭐가 나을까', '나을까', '선택', '골라',
  '정책', '우선순위', '네이밍', '이름을', '방향을', '결정',
]);

/**
 * Condition 1, negative side. A factual lookup is NOT a value judgment, however
 * uncertain the asker is. The T-24 brief calls this case out by name: a
 * fact-finding question must return `required: false`. These cues veto
 * condition 1 unless a value cue is also present.
 * @type {readonly string[]}
 */
export const FACTUAL_QUESTION_CUES = Object.freeze([
  'where is', 'what does', 'how does', 'what is the', 'show me', 'find the',
  'list the', 'look up',
  '어디 있', '어디에 있', '어떻게 동작', '무슨 뜻', '뭐 하는', '찾아줘',
  '알려줘', '보여줘',
]);

/**
 * Condition 2 — the answer propagates. Contracts, schemas, public surfaces and
 * migrations are the documented shape of "material downstream impact"; so is
 * any completion expectation that reaches a commit or beyond, since that is the
 * point at which the choice leaves the working tree.
 * @type {readonly string[]}
 */
export const DOWNSTREAM_IMPACT_CUES = Object.freeze([
  'public api', 'api contract', 'contract', 'schema', 'data model', 'migration',
  'breaking change', 'breaking', 'irreversible', 'architecture', 'system-wide',
  'across the', 'every caller', 'downstream',
  '공개 api', '계약', '스키마', '데이터 모델', '마이그레이션',
  '아키텍처', '전역', '전체에', '하위 호환', '되돌릴 수',
]);

/**
 * Condition 3 — no evidence available to the agent can decide it. Business
 * goals, product strategy and taste live outside the repository.
 * @type {readonly string[]}
 */
export const EVIDENCE_CANNOT_DECIDE_CUES = Object.freeze([
  'business', 'product decision', 'strategy', 'roadmap', 'stakeholder',
  'user expectation', 'brand', 'taste', 'up to you', 'no right answer',
  '비즈니스', '사업', '제품 방향', '전략', '로드맵', '이해관계자',
  '취향', '선호', '우리가 원하는', '정답이 없',
]);

/**
 * Condition 3, negative side. If the prompt points at something measurable,
 * evidence CAN decide it, and the correct move is to go measure. This encodes
 * `package/03_INTENT_MISSION_COMPILER.md:61-62`: "Low confidence first triggers
 * investigation, not a user question."
 * @type {readonly string[]}
 */
export const MEASURABLE_CUES = Object.freeze([
  'benchmark', 'measure', 'profile', 'the logs', 'the test', 'the tests',
  'reproduce', 'stack trace', 'coverage report',
  '벤치마크', '측정', '실측', '로그를', '테스트를', '재현', '프로파일',
]);

/**
 * Condition 4 — being wrong costs something worth an interruption. Rework,
 * irreversibility, and blast radius are the documented shapes.
 * @type {readonly string[]}
 */
export const WRONG_ASSUMPTION_COST_CUES = Object.freeze([
  'rework', 'expensive', 'costly', 'risky', 'risk', 'hard to undo',
  'hard to reverse', 'irreversible', 'large refactor', 'wide blast',
  'production', 'customers',
  '재작업', '되돌리기 어렵', '비용이', '리스크', '위험', '전면',
  '대규모', '운영 환경', '고객',
]);

/**
 * The completion tier at which a wrong assumption stops being cheap: at a
 * commit it has left the working tree, and everything past a commit is further
 * out still. Naming the floor rather than the members is what lets the set be
 * derived instead of copied.
 * @type {string}
 */
export const ESCALATION_FLOOR = 'commit';

/**
 * Completion expectations at or past {@link ESCALATION_FLOOR}, at which a wrong
 * assumption has left the working tree — making conditions 2 and 4 true on
 * their own.
 *
 * DERIVED, not copied. This used to be a hand-written `['commit','PR','deploy']`
 * beside a seven-value vocabulary it had to stay in step with, which is a
 * silent-drift shape: the interpreter's list could gain or reorder a tier and
 * nothing here would notice.
 *
 * Derived BY RANK rather than by position. A positional `slice(-3)` would look
 * equivalent today and fail in a specific, quiet way: append one tier past
 * `deploy` and the last three become `['PR','deploy',<new>]`, silently dropping
 * `commit` from the gate and admitting a value nobody vetted. Filtering on
 * `COMPLETION_RANK >= COMPLETION_RANK[ESCALATION_FLOOR]` says what the set
 * MEANS, so a tier added above the floor joins correctly and one added below it
 * stays out. The accompanying test still pins the resulting members, so any
 * vocabulary change surfaces in review rather than changing gate behaviour on
 * its own.
 * @type {readonly string[]}
 */
export const ESCALATING_COMPLETIONS = Object.freeze(
  COMPLETION_EXPECTATIONS.filter(
    (tier) => COMPLETION_RANK[tier] >= COMPLETION_RANK[ESCALATION_FLOOR],
  ),
);

/**
 * Work purposes whose output is, by definition, a durable structural
 * commitment: a design decision, a migration, or a release.
 * @type {readonly string[]}
 */
export const STRUCTURAL_PURPOSES = Object.freeze(['design', 'migrate', 'release']);

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/**
 * Which cue fired first?
 *
 * The per-cue decision is `lib/intent/interpreter.js#cueMatches` — boundary
 * anchored for ASCII, plain substring for Korean, which is written without
 * spacing between a stem and its particles. This file used to reimplement that
 * rule (its own `ASCII_ONLY` and `escapeRe`, same regex spelled out again). Two
 * copies of a matcher is two matchers to keep identical, and the copy here had
 * already drifted: it lacked the empty-cue guard, so a `''` slipping into any
 * cue list would have matched every prompt and pinned a condition true.
 * Delegating fixes that and leaves one place to change the rule.
 *
 * @param {string} haystack - Lower-cased prompt.
 * @param {readonly string[]} cues
 * @returns {string|null} The first cue that matched, or `null`.
 */
export function firstCue(haystack, cues) {
  return cues.find((cue) => cueMatches(haystack, cue)) ?? null;
}

/**
 * Is this prompt a fact-finding question rather than a decision?
 *
 * True when the prompt asks where something is, what it does, or what it means,
 * and carries no cue that a human's values are in play. Such a request never
 * opens the gate: condition 1 is false, so the conjunction is false. Exported
 * so that property can be asserted head-on rather than read off a `false`.
 *
 * @param {string} [prompt]
 * @returns {boolean}
 */
export function isFactualLookup(prompt = '') {
  const haystack = String(prompt ?? '').toLowerCase();
  return Boolean(firstCue(haystack, FACTUAL_QUESTION_CUES))
    && !firstCue(haystack, VALUE_JUDGMENT_CUES);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * @typedef {object} GateConditions
 * @property {boolean} valueJudgmentRequired
 * @property {boolean} materialDownstreamImpact
 * @property {boolean} evidenceCannotDecide
 * @property {boolean} costOfWrongAssumptionMeaningful
 */

/**
 * @typedef {object} GateVerdict
 * @property {boolean} required - True only when all four conditions hold.
 * @property {string|null} kind - {@link PRODUCT_DECISION} when required, else `null`.
 * @property {string} reason - Which conditions held and which did not.
 */

/**
 * The conjunction itself, isolated so it can be tested exhaustively.
 *
 * Written as an explicit `every` over {@link GATE_CONDITIONS} rather than four
 * chained `&&`s: a fifth condition added to that list then fails closed here
 * automatically, instead of being silently ignored by a hardcoded expression.
 *
 * @param {Partial<GateConditions>} conditions
 * @returns {boolean}
 */
export function requiresQuestion(conditions) {
  if (!conditions || typeof conditions !== 'object') return false;
  return GATE_CONDITIONS.every((key) => conditions[key] === true);
}

/**
 * Evaluate the four conditions against a prompt and its interpretation.
 *
 * @param {object} [input]
 * @param {string} [input.prompt] - Raw user text.
 * @param {object} [input.intent] - `detectIntent()` output. Unused today; taken
 *   so the signature matches the other pure intent modules and so a future
 *   signal has a home that does not change every call site.
 * @param {object} [input.classification] - `classifyComplexity()` output. Only
 *   `factors.risk` is read, and only to strengthen condition 4.
 * @param {object} [input.interpretation] - `interpretIntent()` output.
 * @param {object} [input.config] - Explicit settings. `config.question_gate.force`
 *   pins a condition to a value; see the property docs on the return.
 * @returns {GateConditions}
 */
export function evaluateConditions(input = {}) {
  const { prompt = '', classification = null, interpretation = null, config = null } = input;
  const haystack = String(prompt ?? '').toLowerCase();

  const completion = interpretation?.completion_expectation ?? null;
  const purpose = interpretation?.work_purpose ?? null;
  const escalating = ESCALATING_COMPLETIONS.includes(completion);
  const structural = STRUCTURAL_PURPOSES.includes(purpose);

  // 1. Human value judgment required.
  //
  // A fact-finding question is not a value judgment, however uncertain the
  // asker is, and the T-24 brief requires those to return `required: false`.
  // The mechanism is simply that a factual lookup carries no value cue — which
  // is what `isFactualLookup` names, so the case can be asserted directly
  // instead of being inferred from a false. A prompt carrying both ("어느 쪽이
  // 나을지 알려줘") is a value judgment: the value cue is the specific signal
  // and the factual phrasing is only how the request was worded.
  const valueJudgmentRequired = Boolean(firstCue(haystack, VALUE_JUDGMENT_CUES));

  // 2. Material downstream impact.
  const impactCue = firstCue(haystack, DOWNSTREAM_IMPACT_CUES);
  const materialDownstreamImpact = Boolean(impactCue) || escalating || structural;

  // 3. Evidence cannot decide.
  const outsideCue = firstCue(haystack, EVIDENCE_CANNOT_DECIDE_CUES);
  const measurableCue = firstCue(haystack, MEASURABLE_CUES);
  const evidenceCannotDecide = Boolean(outsideCue) && !measurableCue;

  // 4. Cost of a wrong assumption is meaningful.
  const costCue = firstCue(haystack, WRONG_ASSUMPTION_COST_CUES);
  const riskFactor = Number(classification?.factors?.risk ?? 0);
  const costOfWrongAssumptionMeaningful =
    Boolean(costCue) || escalating || structural || riskFactor >= 0.5;

  /** @type {GateConditions} */
  const conditions = {
    valueJudgmentRequired,
    materialDownstreamImpact,
    evidenceCannotDecide,
    costOfWrongAssumptionMeaningful,
  };

  const forced = config?.question_gate?.force;
  if (forced && typeof forced === 'object') {
    for (const key of GATE_CONDITIONS) {
      if (typeof forced[key] === 'boolean') conditions[key] = forced[key];
    }
  }
  return conditions;
}

/**
 * Judge whether this request needs a human product decision.
 *
 * Returns judgment only — never a question. The caller decides what to do with
 * a `required: true`, and {@link QUESTION_BATCH_POINT} says when.
 *
 * @param {object} [input] - Same shape as {@link evaluateConditions}.
 * @returns {GateVerdict}
 */
export function evaluateQuestionGate(input = {}) {
  const conditions = evaluateConditions(input);
  const required = requiresQuestion(conditions);
  const held = GATE_CONDITIONS.filter((k) => conditions[k]);
  const missing = GATE_CONDITIONS.filter((k) => !conditions[k]);

  const reason = required
    ? `all four gate conditions hold: ${held.join(', ')}`
    : missing.length === GATE_CONDITIONS.length
      ? 'no gate condition holds'
      : `held: ${held.join(', ')}; not met: ${missing.join(', ')}`;

  return {
    required,
    kind: required ? PRODUCT_DECISION : null,
    reason,
  };
}

/**
 * Collapse several verdicts into one batching decision.
 *
 * This is the scheduling half of `ADDENDUM-HARDENING.md:673-677`: gather the
 * questions that fired and present them together at the start of ADR work,
 * rather than interrupting repeatedly. It returns a plan, not questions —
 * writing the questions is still the caller's job.
 *
 * @param {GateVerdict[]} [verdicts]
 * @returns {{ ask: boolean, at: string, count: number, kinds: string[] }}
 */
export function planQuestionBatch(verdicts = []) {
  const firing = (Array.isArray(verdicts) ? verdicts : []).filter((v) => v?.required);
  return {
    ask: firing.length > 0,
    at: QUESTION_BATCH_POINT,
    count: firing.length,
    kinds: [...new Set(firing.map((v) => v.kind).filter(Boolean))],
  };
}
