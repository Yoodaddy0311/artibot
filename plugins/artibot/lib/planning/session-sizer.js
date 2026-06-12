/**
 * Session sizer — pure heuristic estimator that sizes a plan to the autopilot
 * "real build time" band (2–4h). This is NOT a human-effort estimate; it models
 * "how long autopilot runs while burning tokens".
 *
 * Anchor (from artibot.config.json autopilot.limits): maxBudget 2,000,000 tokens
 * over maxDuration "4h" ⇒ ≈ 500,000 tokens/hour autonomous throughput. The
 * token→hour conversion is intrinsically imprecise (model speed, tool latency,
 * retries, context churn all vary), so confidence is always 'low'..'medium' and
 * every constant is exported/overridable. Do NOT treat the hours as a promise.
 *
 * Design rules (mirrors lib/planning/artifacts.js house style):
 *   - Pure functions, no LLM/IO, zero dependencies.
 *   - All tuning constants exported so callers can recalibrate.
 *   - throughput / per-task tokens overridable via `opts`.
 *   - Safe on empty/unknown input (empty → 0 tokens, 'quick'/'expand';
 *     unknown task type → 'other' fallback).
 *
 * @module lib/planning/session-sizer
 */

import { getTokenizerCoeff } from '../core/model-catalog.js';

/**
 * Autopilot autonomous throughput in tokens/hour. Derived from the config
 * anchor 2M tokens / 4h. Override via `opts.throughput` to recalibrate against
 * observed runs.
 * @type {number}
 */
export const THROUGHPUT_TOKENS_PER_HOUR = 500000;

/**
 * Baseline token cost per task type (at 'medium' complexity). Heuristic only —
 * impl is the heaviest, docs the lightest, `other` the catch-all fallback.
 * @type {Readonly<Record<string, number>>}
 */
export const PER_TASK_TOKENS = Object.freeze({
  impl: 120000,
  test: 70000,
  review: 50000,
  docs: 40000,
  other: 60000,
});

/**
 * Complexity multipliers applied to the per-task baseline.
 * @type {Readonly<Record<string, number>>}
 */
export const COMPLEXITY_MULT = Object.freeze({
  low: 0.6,
  medium: 1,
  high: 1.6,
});

/**
 * Default autopilot session band (hours) — the target "session" window.
 * @type {Readonly<{ minHours: number, maxHours: number }>}
 */
export const SESSION_BAND = Object.freeze({ minHours: 2, maxHours: 4 });

/** Hard cap on any budget hint (mirrors autopilot.limits.maxBudget = 2M). */
export const MAX_BUDGET_TOKENS = 2000000;

const DEFAULT_TYPE = 'other';
const DEFAULT_COMPLEXITY = 'medium';

/** Default tokenizer coefficient (baseline = Opus 4.8 tokens-per-content). */
const DEFAULT_TOKENIZER_COEFF = 1.0;

// ---------------------------------------------------------------------------
// Internal helpers (small, pure)
// ---------------------------------------------------------------------------

/**
 * Resolve the autonomous throughput (tokens/hour) from `opts`. Accepts either
 * `opts.throughput` or its alias `opts.throughputTokensPerHour`; the former
 * wins. Non-finite / ≤ 0 values fall back to the default constant.
 *
 * @param {object} opts
 * @returns {number} Throughput in tokens/hour (> 0).
 */
function resolveThroughput(opts) {
  const primary = opts?.throughput;
  if (typeof primary === 'number' && Number.isFinite(primary) && primary > 0) {
    return primary;
  }
  const alias = opts?.throughputTokensPerHour;
  if (typeof alias === 'number' && Number.isFinite(alias) && alias > 0) {
    return alias;
  }
  return THROUGHPUT_TOKENS_PER_HOUR;
}

/**
 * Resolve the tokenizer coefficient from `opts`. Precedence:
 *   1. explicit numeric `opts.tokenizerCoeff` (finite, > 0) wins,
 *   2. else `opts.modelTier` is looked up in the model catalog (lazy, safe),
 *   3. else 1.0.
 * Any non-finite / ≤ 0 value degrades to 1.0 (never-throw house style). The
 * catalog import is lazy + guarded so the planning→core edge is one-way and a
 * missing/broken catalog can never break sizing.
 *
 * @param {object} opts
 * @returns {number} Coefficient (>= a small positive number); 1.0 on any issue.
 */
function resolveTokenizerCoeff(opts) {
  const explicit = opts?.tokenizerCoeff;
  if (typeof explicit === 'number' && Number.isFinite(explicit) && explicit > 0) {
    return explicit;
  }
  const tier = opts?.modelTier;
  if (typeof tier === 'string' && tier) {
    const coeff = lookupCatalogCoeff(tier);
    if (typeof coeff === 'number' && Number.isFinite(coeff) && coeff > 0) {
      return coeff;
    }
  }
  return DEFAULT_TOKENIZER_COEFF;
}

/**
 * Resolve a tier's tokenizer coefficient via the model catalog. The catalog is
 * a pure, zero-dep, never-throw core module (allowed planning→core downward
 * edge); the lookup is only invoked when a caller supplies `opts.modelTier`, so
 * the default code path never touches it. Guarded so any unexpected failure
 * degrades to 1.0 instead of throwing.
 *
 * @param {string} tier
 * @returns {number}
 */
function lookupCatalogCoeff(tier) {
  try {
    return getTokenizerCoeff(tier);
  } catch {
    return DEFAULT_TOKENIZER_COEFF;
  }
}

/**
 * Resolve a task type to a known key, falling back to 'other'.
 * @param {string} type
 * @param {Record<string, number>} table - per-task token table.
 * @returns {string}
 */
function resolveType(type, table) {
  return Object.prototype.hasOwnProperty.call(table, type) ? type : DEFAULT_TYPE;
}

/**
 * Resolve a complexity level to a known multiplier key, falling back to medium.
 * @param {string} complexity
 * @param {Record<string, number>} mults
 * @returns {string}
 */
function resolveComplexity(complexity, mults) {
  return Object.prototype.hasOwnProperty.call(mults, complexity)
    ? complexity
    : DEFAULT_COMPLEXITY;
}

/**
 * Derive a coarse tier from the task complexity distribution. Any 'high' task
 * makes the whole plan 'complex'; an all-'low' set is 'simple'; else 'moderate'.
 * Empty input → 'simple'.
 * @param {Array<{ complexity: string }>} resolved - tasks with resolved keys.
 * @returns {'simple'|'moderate'|'complex'}
 */
function deriveTier(resolved) {
  if (resolved.length === 0) return 'simple';
  let high = 0;
  let nonLow = 0;
  for (const t of resolved) {
    if (t.complexity === 'high') high += 1;
    if (t.complexity !== 'low') nonLow += 1;
  }
  if (high > 0) return 'complex';
  if (nonLow === 0) return 'simple';
  return 'moderate';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Estimate the autopilot token/time footprint of a task list.
 *
 * tokens = Σ PER_TASK_TOKENS[type] × COMPLEXITY_MULT[complexity].
 * hours  = tokens / throughput. confidence is heuristic ('low' by default,
 * 'medium' only for small well-typed plans) — the conversion is approximate.
 *
 * @param {Array<{ type?: string, complexity?: string }>} tasks
 * @param {object} [opts]
 * @param {number} [opts.throughput=THROUGHPUT_TOKENS_PER_HOUR]
 * @param {number} [opts.throughputTokensPerHour] - alias for `opts.throughput`.
 * @param {Record<string, number>} [opts.perTaskTokens=PER_TASK_TOKENS]
 * @param {Record<string, number>} [opts.complexityMult=COMPLEXITY_MULT]
 * @param {number} [opts.tokenizerCoeff=1.0] - per-task token multiplier; non-finite/≤0 → 1.0.
 * @param {string} [opts.modelTier] - tier whose catalog coefficient applies when
 *   `opts.tokenizerCoeff` is absent (e.g. 'fable' → 1.3). Explicit coeff wins.
 * @returns {{ tokens: number, hours: number, tier: 'simple'|'moderate'|'complex',
 *   confidence: 'low'|'medium', perTask: Array<object> }}
 */
export function estimateFootprint(tasks, opts = {}) {
  const list = Array.isArray(tasks) ? tasks : [];
  const table = opts.perTaskTokens || PER_TASK_TOKENS;
  const mults = opts.complexityMult || COMPLEXITY_MULT;
  const throughput = resolveThroughput(opts);
  const coeff = resolveTokenizerCoeff(opts);

  const resolved = list.map((task) => {
    const type = resolveType(task?.type, table);
    const complexity = resolveComplexity(task?.complexity, mults);
    const tokens = Math.round(table[type] * mults[complexity] * coeff);
    return { type, complexity, tokens };
  });

  const tokens = resolved.reduce((sum, t) => sum + t.tokens, 0);
  const hours = tokens / throughput;
  const tier = deriveTier(resolved);
  // Heuristic confidence: small, well-typed plans get 'medium'; everything
  // else stays 'low' to signal the token→time conversion is approximate.
  const confidence = list.length > 0 && list.length <= 4 && tier !== 'complex'
    ? 'medium'
    : 'low';

  return { tokens, hours, tier, confidence, perTask: resolved };
}

/**
 * Classify an estimated duration into a sizing band relative to the session
 * target window.
 *
 * - hours < minHours → band 'quick',   recommendation 'expand'.
 * - minHours..maxHours → band 'session', recommendation 'ok'.
 * - hours > maxHours → band 'epic',     recommendation 'split'
 *   (splitInto = ceil(hours / maxHours)).
 *
 * @param {number} hours
 * @param {object} [opts]
 * @param {{ minHours: number, maxHours: number }} [opts.band=SESSION_BAND]
 * @returns {{ band: 'quick'|'session'|'epic', target: { minHours: number,
 *   maxHours: number }, recommendation: 'expand'|'ok'|'split', splitInto: number }}
 */
export function classifySize(hours, opts = {}) {
  const band = opts.band || SESSION_BAND;
  const { minHours, maxHours } = band;
  const h = typeof hours === 'number' && hours > 0 ? hours : 0;
  const target = Object.freeze({ minHours, maxHours });

  if (h < minHours) {
    return { band: 'quick', target, recommendation: 'expand', splitInto: 1 };
  }
  if (h > maxHours) {
    const splitInto = Math.ceil(h / maxHours);
    return { band: 'epic', target, recommendation: 'split', splitInto };
  }
  return { band: 'session', target, recommendation: 'ok', splitInto: 1 };
}

/**
 * Combine estimateFootprint + classifySize and emit an autopilot handoff hint
 * ready for `/autopilot --max <maxHint> --budget <budgetHint>`.
 *
 * budgetHint = band upper bound (hours) × throughput, capped at MAX_BUDGET_TOKENS
 * (2M, matching autopilot.limits.maxBudget). maxHint is the band's max as a
 * "Nh" string.
 *
 * @param {Array<{ type?: string, complexity?: string }>} tasks
 * @param {object} [opts] - forwarded to estimateFootprint & classifySize.
 * @returns {{ footprint: object, sizing: object,
 *   autopilot: { maxHint: string, budgetHint: number } }}
 */
export function sizePlan(tasks, opts = {}) {
  const footprint = estimateFootprint(tasks, opts);
  const sizing = classifySize(footprint.hours, opts);
  const throughput = resolveThroughput(opts);

  const bandMax = sizing.target.maxHours;
  const budgetHint = Math.min(
    MAX_BUDGET_TOKENS,
    Math.round(bandMax * throughput),
  );
  const maxHint = `${bandMax}h`;

  return { footprint, sizing, autopilot: { maxHint, budgetHint } };
}
