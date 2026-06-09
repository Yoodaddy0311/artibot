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

// ---------------------------------------------------------------------------
// Internal helpers (small, pure)
// ---------------------------------------------------------------------------

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
 * @param {Record<string, number>} [opts.perTaskTokens=PER_TASK_TOKENS]
 * @param {Record<string, number>} [opts.complexityMult=COMPLEXITY_MULT]
 * @returns {{ tokens: number, hours: number, tier: 'simple'|'moderate'|'complex',
 *   confidence: 'low'|'medium', perTask: Array<object> }}
 */
export function estimateFootprint(tasks, opts = {}) {
  const list = Array.isArray(tasks) ? tasks : [];
  const table = opts.perTaskTokens || PER_TASK_TOKENS;
  const mults = opts.complexityMult || COMPLEXITY_MULT;
  const throughput = typeof opts.throughput === 'number' && opts.throughput > 0
    ? opts.throughput
    : THROUGHPUT_TOKENS_PER_HOUR;

  const resolved = list.map((task) => {
    const type = resolveType(task?.type, table);
    const complexity = resolveComplexity(task?.complexity, mults);
    const tokens = Math.round(table[type] * mults[complexity]);
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
  const throughput = typeof opts.throughput === 'number' && opts.throughput > 0
    ? opts.throughput
    : THROUGHPUT_TOKENS_PER_HOUR;

  const bandMax = sizing.target.maxHours;
  const budgetHint = Math.min(
    MAX_BUDGET_TOKENS,
    Math.round(bandMax * throughput),
  );
  const maxHint = `${bandMax}h`;

  return { footprint, sizing, autopilot: { maxHint, budgetHint } };
}
