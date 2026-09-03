/**
 * Intent confidence — the `intent_confidence` block of the Mission Contract.
 *
 * `package/03_INTENT_MISSION_COMPILER.md:61-69` defines it exactly:
 *
 * ```yaml
 * intent_confidence:
 *   goal: 0.97
 *   scope: 0.81
 *   completion_expectation: 0.93
 *   product_decision_required: false
 * ```
 *
 * Four keys — three numbers and one boolean. The landed T-13 schema
 * (`schemas/mission-contract.schema.json:170-184`) sets
 * `additionalProperties: false` over exactly those four, so a fifth key here
 * would fail validation downstream. {@link computeIntentConfidence} therefore
 * returns those four and nothing else; everything a human or a test wants to
 * know about *why* comes from {@link explainConfidence}, which is a separate
 * function returning a separate object.
 *
 * The document's own instruction about what low confidence means
 * (`:62-63`) is the reason this module does not talk to the user:
 *
 *   > Represent uncertainty rather than hiding it. Low confidence first
 *   > triggers investigation, not a user question.
 *
 * So a low `goal` score is an instruction to go and look, and only the four
 * conjoined conditions in `lib/planning/question-gate.js` can turn
 * `product_decision_required` true.
 *
 * Pure: no clock, no filesystem, no randomness, no LLM call (lane 1 §3.1).
 *
 * @module lib/intent/confidence
 */

import { evaluateQuestionGate, PRODUCT_DECISION } from '../planning/question-gate.js';

/**
 * The four contract keys, in document order. Exported so callers can assert the
 * shape without hardcoding a list that could drift from the schema.
 * @type {readonly string[]}
 */
export const CONFIDENCE_KEYS = Object.freeze([
  'goal',
  'scope',
  'completion_expectation',
  'product_decision_required',
]);

/**
 * Scoring weights, gathered here so the arithmetic can be read in one place and
 * asserted in tests rather than reverse-engineered from the code.
 *
 * These are ADDITIVE TERMS ON A BASE, deliberately, not a learned model. A
 * transparent sum is auditable: given an output the reader can name which terms
 * fired. The numbers themselves are a starting calibration and are NOT measured
 * against any labelled corpus — no such corpus exists in this repository at the
 * time of writing. Treat them as a documented default to be tuned once the
 * Observe phase produces a denominator, not as a validated result.
 * @type {Readonly<Record<string, number>>}
 */
export const CONFIDENCE_WEIGHTS = Object.freeze({
  /** Every axis starts here: an unevidenced axis is a coin flip, slightly pessimistic. */
  base: 0.4,
  /** The axis resolved to a real value rather than falling back to a default. */
  resolved: 0.35,
  /** One value out-evidenced every other value on that axis. */
  dominant: 0.15,
  /** Full ambiguity (`ambiguity.score` 100) costs this much on `goal`. */
  ambiguityPenalty: 0.25,
  /** Full `classifyComplexity` uncertainty factor costs this much on `goal`. */
  uncertaintyPenalty: 0.15,
  /** A concrete named target (path, file, identifier) raises `scope`. */
  concreteTarget: 0.25,
  /** Each further distinct target, capped by `extraTargetCap`. */
  extraTarget: 0.1,
  /** Ceiling on the `extraTarget` contribution. */
  extraTargetCap: 0.2,
  /** A universal quantifier ("everything", "전부") widens scope past what was stated. */
  universalQuantifier: 0.2,
  /** Full `classifyComplexity` domain spread costs this much on `scope`. */
  domainSpreadPenalty: 0.15,
  /** Completion cues that straddle distant tiers (answer AND deploy) cost this. */
  completionSpread: 0.15,
});

/**
 * Cues that widen scope beyond whatever target was named. They are not vague in
 * themselves — "fix everything" is perfectly clear about wanting everything —
 * but they mean the stated target under-describes the work, which is exactly
 * what a low `scope` confidence records.
 * @type {readonly string[]}
 */
export const UNIVERSAL_QUANTIFIER_CUES = Object.freeze([
  'everything', 'all of', 'every file', 'across the board', 'end to end',
  'end-to-end', 'the whole', 'systemically', 'from scratch',
  '전부', '모든', '전체', '싹', '근본적', '통째로', '다 고쳐',
]);

/**
 * A named target: a path, a dotted or slashed module id, a file with an
 * extension, a `backticked` identifier, or a CamelCase / kebab-case symbol.
 * Matching these is what separates "fix the login bug" (scope unclear) from
 * "fix `lib/auth/session.js`" (scope stated).
 * @type {RegExp}
 */
export const CONCRETE_TARGET_RE =
  /`[^`]+`|\b[\w.-]+\/[\w./-]+\b|\b\w+\.(?:js|mjs|ts|tsx|jsx|json|yaml|yml|md|py|go|rs|sql)\b|\b[a-z]+[A-Z]\w*\b/g;

/**
 * Clamp to [0, 1] and round to two decimals, matching the precision the design
 * document writes its example values at (`0.97`, `0.81`, `0.93`).
 * @param {number} n
 * @returns {number}
 */
export function clamp01(n) {
  // NaN maps to 0 rather than escaping into the contract as a NaN. Infinity
  // falls through to the clamp, which is exactly what a clamp is for.
  const value = Number(n);
  if (Number.isNaN(value)) return 0;
  return Math.round(Math.min(1, Math.max(0, value)) * 100) / 100;
}

/**
 * Count distinct concrete targets named in the prompt.
 * @param {string} prompt
 * @returns {string[]} Distinct matches, lower-cased.
 */
export function findConcreteTargets(prompt) {
  const matches = String(prompt ?? '').match(CONCRETE_TARGET_RE) ?? [];
  return [...new Set(matches.map((m) => m.toLowerCase()))];
}

/**
 * @param {string} haystack
 * @param {readonly string[]} cues
 * @returns {boolean}
 */
function hasAnyCue(haystack, cues) {
  return cues.some((cue) => haystack.includes(cue));
}

/**
 * Did one value out-evidence every other value on this axis?
 * @param {object|null} interpretation
 * @param {string} axis - `work_purpose` or `completion_expectation`.
 * @returns {boolean}
 */
function isDominant(interpretation, axis) {
  const counts = new Map();
  for (const e of interpretation?.evidence ?? []) {
    if (e.axis !== axis) continue;
    counts.set(e.value, (counts.get(e.value) ?? 0) + 1);
  }
  if (counts.size <= 1) return counts.size === 1;
  const sorted = [...counts.values()].sort((a, b) => b - a);
  return sorted[0] > sorted[1];
}

/**
 * @typedef {object} ConfidenceExplanation
 * @property {{ value: number, terms: Array<{ name: string, delta: number }> }} goal
 * @property {{ value: number, terms: Array<{ name: string, delta: number }> }} scope
 * @property {{ value: number, terms: Array<{ name: string, delta: number }> }} completion_expectation
 * @property {import('../planning/question-gate.js').GateVerdict} gate
 */

/**
 * Score the three numeric axes and show the arithmetic.
 *
 * Kept separate from {@link computeIntentConfidence} because the contract block
 * is closed at four keys: the explanation cannot ride along inside it, and
 * losing the explanation entirely would make a score unauditable.
 *
 * @param {object} [input]
 * @param {string} [input.prompt]
 * @param {object} [input.intent] - `detectIntent()` output; `ambiguity.score` is read.
 * @param {object} [input.classification] - `classifyComplexity()` output;
 *   `factors.uncertainty` and `factors.domains` are read.
 * @param {object} [input.interpretation] - `interpretIntent()` output.
 * @param {object} [input.config] - Explicit settings, forwarded to the question gate.
 * @returns {ConfidenceExplanation}
 */
export function explainConfidence(input = {}) {
  const { prompt = '', intent = null, classification = null, interpretation = null } = input;
  const axis = (terms) => ({
    value: clamp01(terms.reduce((acc, t) => acc + t.delta, 0)),
    terms,
  });

  return {
    goal: axis(goalTerms(interpretation, intent, classification)),
    scope: axis(scopeTerms(prompt, classification)),
    completion_expectation: axis(completionTerms(interpretation)),
    gate: evaluateQuestionGate(input),
  };
}

/**
 * @param {object|null} interpretation
 * @param {object|null} intent
 * @param {object|null} classification
 * @returns {Array<{name: string, delta: number}>}
 */
function goalTerms(interpretation, intent, classification) {
  const W = CONFIDENCE_WEIGHTS;
  const terms = [{ name: 'base', delta: W.base }];
  if (interpretation?.work_purpose) {
    terms.push({ name: 'resolved:work_purpose', delta: W.resolved });
    if (isDominant(interpretation, 'work_purpose')) {
      terms.push({ name: 'dominant:work_purpose', delta: W.dominant });
    }
  }
  const ambiguity = Number(intent?.ambiguity?.score ?? 0);
  if (ambiguity > 0) {
    terms.push({
      name: 'ambiguity',
      delta: -(W.ambiguityPenalty * Math.min(1, ambiguity / 100)),
    });
  }
  const uncertainty = Number(classification?.factors?.uncertainty ?? 0);
  if (uncertainty > 0) {
    terms.push({
      name: 'classification:uncertainty',
      delta: -(W.uncertaintyPenalty * Math.min(1, uncertainty)),
    });
  }
  return terms;
}

/**
 * @param {string} prompt
 * @param {object|null} classification
 * @returns {Array<{name: string, delta: number}>}
 */
function scopeTerms(prompt, classification) {
  const W = CONFIDENCE_WEIGHTS;
  const haystack = String(prompt ?? '').toLowerCase();
  const terms = [{ name: 'base', delta: W.base }];
  const targets = findConcreteTargets(prompt);
  if (targets.length > 0) {
    terms.push({ name: 'concrete_target', delta: W.concreteTarget });
    const extra = Math.min(W.extraTargetCap, (targets.length - 1) * W.extraTarget);
    if (extra > 0) terms.push({ name: 'extra_targets', delta: extra });
  }
  if (hasAnyCue(haystack, UNIVERSAL_QUANTIFIER_CUES)) {
    terms.push({ name: 'universal_quantifier', delta: -W.universalQuantifier });
  }
  const domains = Number(classification?.factors?.domains ?? 0);
  if (domains > 0) {
    terms.push({
      name: 'classification:domains',
      delta: -(W.domainSpreadPenalty * Math.min(1, domains)),
    });
  }
  return terms;
}

/**
 * @param {object|null} interpretation
 * @returns {Array<{name: string, delta: number}>}
 */
function completionTerms(interpretation) {
  const W = CONFIDENCE_WEIGHTS;
  const terms = [{ name: 'base', delta: W.base }];
  const defaulted = new Set(interpretation?.defaulted ?? []);
  if (!defaulted.has('completion_expectation')) {
    terms.push({ name: 'resolved:completion', delta: W.resolved });
    if (isDominant(interpretation, 'completion_expectation')) {
      terms.push({ name: 'dominant:completion', delta: W.dominant });
    }
  }
  // Cues spanning distant tiers mean the prompt asked for two different endings
  // ("explain it, and ship it"), which is exactly the uncertainty this records.
  const tiers = interpretation?.completion_expectations ?? [];
  const reachesWrite = tiers.some((t) => t === 'commit' || t === 'PR' || t === 'deploy');
  if (tiers.includes('answer') && reachesWrite) {
    terms.push({ name: 'completion_spread', delta: -W.completionSpread });
  }
  return terms;
}

/**
 * Build the `intent_confidence` block of the Mission Contract.
 *
 * Returns EXACTLY the four keys the design document names. Do not add a fifth:
 * `schemas/mission-contract.schema.json:170-184` closes the object, so an extra
 * key turns a valid contract into an invalid one. Reasons belong in
 * {@link explainConfidence}.
 *
 * `product_decision_required` is not computed here. It is the verdict of
 * `lib/planning/question-gate.js#evaluateQuestionGate`, which owns the four
 * conjoined conditions from `ADDENDUM-HARDENING.md:663-673`. Lane 1 §3.6 draws
 * exactly that arrow: the gate judges, and the result "결과가
 * `intent_confidence.product_decision_required` 로 계약에 실립니다". Duplicating
 * the judgment here would give the system two evaluators that can disagree.
 *
 * @param {object} [input] - Same shape as {@link explainConfidence}.
 * @returns {{ goal: number, scope: number, completion_expectation: number, product_decision_required: boolean }}
 */
export function computeIntentConfidence(input = {}) {
  const detail = explainConfidence(input);
  return {
    goal: detail.goal.value,
    scope: detail.scope.value,
    completion_expectation: detail.completion_expectation.value,
    product_decision_required:
      detail.gate.required && detail.gate.kind === PRODUCT_DECISION,
  };
}
