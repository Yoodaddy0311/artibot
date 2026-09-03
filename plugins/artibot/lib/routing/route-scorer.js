/**
 * Route scorer — RouteUtility per candidate tier (v5 routing, T-27).
 *
 * Given an action class and the tiers policy allows, score each tier and rank
 * them. It SELECTS nothing and it ENFORCES nothing: `adaptive-model-router.js`
 * (T-29) reads the ranking, and the allow-set it passes in already encodes
 * every policy gate (`allowedTiers`, the fable allowlist, the
 * `security-reviewer` denylist, the kill switch). A tier absent from
 * `allowedTiers` is never scored, so no weighting here can produce it.
 *
 * MEASURED vs ESTIMATED — the point of this module's shape. Every one of the
 * eight terms carries `{ value, measured }`, the `cost_term` shape of
 * `schemas/route-receipt.schema.json`. `measured` is true ONLY when the number
 * came from a signal an actual run produced. As of 2026-09-02 the plugin reads
 * no provider usage receipt at all (v5-lane2-routing.md §0-2), so `success`,
 * `reliability`, `latency` and `quality` are constants and report
 * `measured:false`. `cost` is `measured:false` even though it is computed,
 * because the price table it derives from is itself unverified
 * (`model-catalog.js` fable factor 2.6 is explicitly an unmeasured estimate).
 * Do not read a scored route as evidence about a model.
 *
 * LAYER: L2 (auxiliary). The only import is `lib/core/model-catalog.js` (L1),
 * which the layer rule allows (upper imports lower). Pure: no I/O, no config,
 * no module state, never throws.
 *
 * @module lib/routing/route-scorer
 */

import {
  CATALOG_VERSION,
  getCostFactor,
  getModel,
  MODELS,
} from '../core/model-catalog.js';

import { ACTION_CLASS_TIERS, ACTION_CLASSES, isActionClass } from './action-classifier.js';

// ---------------------------------------------------------------------------
// Injected catalog port
// ---------------------------------------------------------------------------

/**
 * Default catalog port: the real `lib/core/model-catalog.js`. Callers may pass
 * their own `catalog` (the §2.2 input contract does) to score against a pinned
 * price table — replaying a stored decision against today's prices would
 * silently rewrite what that decision meant.
 *
 * @type {Readonly<{getModel: Function, getCostFactor: Function, version: string}>}
 */
export const DEFAULT_CATALOG = Object.freeze({
  getModel,
  getCostFactor,
  version: CATALOG_VERSION,
});

/** Tier order, cheapest-capability first. Fixes tie-breaks and taskFit distance. */
const TIER_ORDER = Object.freeze(['haiku', 'sonnet', 'opus', 'fable']);

// ---------------------------------------------------------------------------
// Static tables — all ESTIMATES, all reported measured:false
// ---------------------------------------------------------------------------

/**
 * Relative capability score per tier, 0..1.
 *
 * ESTIMATE, not a benchmark. Grounded only in the repo's own two-tier policy
 * (fable for design and inspection, opus for implementation —
 * `rules/artibot/agent-coordination.md`) and the catalog's price ordering.
 * Replace with eval results before anyone treats these as measurements.
 *
 * @type {Readonly<Record<string, number>>}
 */
export const TIER_QUALITY = Object.freeze({
  haiku: 0.55, sonnet: 0.70, opus: 0.90, fable: 1.00,
});

/**
 * Relative latency index per tier, opus = 1.0.
 *
 * PLACEHOLDER. The repo records no latency anywhere (no usage receipt, no
 * timing ledger), so this is an ordering assumption — bigger model, slower
 * turn — not a measurement. It only ever affects the ranking through the
 * lowest-weighted term.
 *
 * @type {Readonly<Record<string, number>>}
 */
export const TIER_LATENCY_INDEX = Object.freeze({
  haiku: 0.25, sonnet: 0.50, opus: 1.00, fable: 1.90,
});

/**
 * Milliseconds the opus latency index of 1.0 stands for, used to turn the index
 * into the `predicted.latency` the receipt schema wants. PLACEHOLDER until a
 * real timing source exists.
 * @type {number}
 */
export const BASELINE_LATENCY_MS = 8000;

/** Success probability of a perfectly fitted tier, before any penalty. ESTIMATE. */
const BASE_SUCCESS = 0.8;
/** Reliability of a healthy tier. ESTIMATE — no provider health data exists yet. */
const BASE_RELIABILITY = 0.9;
/** Success lost per retry already spent on this action. ESTIMATE. */
const RETRY_PENALTY = 0.1;
/** taskFit lost per tier step ABOVE the preferred tier (waste, still capable). */
const OVERSHOOT_PENALTY = 0.10;
/**
 * taskFit lost per tier step BELOW the preferred tier.
 *
 * Sized so a tier at the far end of {@link TIER_ORDER} from the preferred one
 * scores exactly 0: three steps under is not a cheaper option, it is the wrong
 * tool. It is also the smallest value at which the class→tier anchor survives
 * the cost term — measured 2026-09-02, a penalty of 0.30 let haiku outrank
 * sonnet by 0.002 utility for the sonnet-preferred classes (`explore`,
 * `edit-routine`) under {@link DEFAULT_WEIGHTS}, which would have made
 * ACTION_CLASS_TIERS decorative for those two. The invariant it restores —
 * the preferred tier wins when no signal argues otherwise — is pinned per
 * class in tests/routing/route-scorer.test.js.
 */
const UNDERSHOOT_PENALTY = 1 / 3;
/** Neutral value for a term whose signal was not supplied. */
const NEUTRAL = 0.5;

/**
 * RouteUtility weights for the `balanced` execution profile. Sum = 1.0, so
 * utility lands in 0..1 and two rankings are comparable.
 *
 * §4.3 changes these per performance profile — `maximum` and `split` zero the
 * cost weight — which is why {@link scoreRoutes} takes a `weights` override
 * instead of hardcoding them. The override is renormalised, so a caller cannot
 * accidentally inflate utility past 1 by passing weights that sum to more.
 *
 * @type {Readonly<Record<string, number>>}
 */
export const DEFAULT_WEIGHTS = Object.freeze({
  quality: 0.20,
  taskFit: 0.25,
  success: 0.15,
  reliability: 0.10,
  ctxAffinity: 0.05,
  cacheAffinity: 0.05,
  cost: 0.15,
  latency: 0.05,
});

/** The eight RouteUtility term names, in receipt order. @type {readonly string[]} */
export const TERM_NAMES = Object.freeze([
  'quality', 'taskFit', 'success', 'reliability',
  'ctxAffinity', 'cacheAffinity', 'cost', 'latency',
]);

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/**
 * Clamp a number into [min, max]; non-finite input returns `min`.
 * @param {number} n - Value.
 * @param {number} [min] - Lower bound.
 * @param {number} [max] - Upper bound.
 * @returns {number} Clamped value.
 */
function clamp(n, min = 0, max = 1) {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

/**
 * Build one `{ value, measured }` term.
 * @param {number} value - Term magnitude.
 * @param {boolean} measured - True only for values from a real measurement.
 * @returns {{value: number, measured: boolean}} Cost term.
 */
function term(value, measured) {
  return { value, measured };
}

/**
 * A finite non-negative number, or null.
 * @param {*} n - Candidate.
 * @returns {number|null} The number, or null when unusable.
 */
function count(n) {
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Task fit of a tier for an action class: 1.0 at the class's preferred tier
 * ({@link ACTION_CLASS_TIERS}), decaying with distance. Asymmetric on purpose —
 * an over-capable model wastes money but still does the job, while an
 * under-capable one may not, so undershoot is penalised three times as hard.
 *
 * @param {string} actionClass - One of {@link ACTION_CLASSES}.
 * @param {string} tier - Candidate tier.
 * @returns {number} Fit in 0..1.
 */
export function taskFitFor(actionClass, tier) {
  const preferred = ACTION_CLASS_TIERS[actionClass];
  const from = TIER_ORDER.indexOf(preferred);
  const to = TIER_ORDER.indexOf(tier);
  if (from < 0 || to < 0) return NEUTRAL;
  const steps = to - from;
  const penalty = steps >= 0 ? steps * OVERSHOOT_PENALTY : -steps * UNDERSHOOT_PENALTY;
  return clamp(1 - penalty);
}

/**
 * Normalise `allowedTiers` (Set or array) to catalog-known tiers, in
 * {@link TIER_ORDER} order so the output is deterministic.
 *
 * @param {Set<string>|readonly string[]} allowedTiers - Policy allow-set.
 * @param {object} catalog - Catalog port.
 * @returns {string[]} Known tiers, possibly empty.
 */
function normaliseTiers(allowedTiers, catalog) {
  const raw = allowedTiers instanceof Set ? [...allowedTiers] : allowedTiers;
  if (!Array.isArray(raw)) return [];
  const seen = new Set(raw.filter((t) => typeof t === 'string' && catalog.getModel(t)));
  return TIER_ORDER.filter((t) => seen.has(t));
}

// ---------------------------------------------------------------------------
// Per-tier terms
// ---------------------------------------------------------------------------

/**
 * Context affinity: how much headroom the tier's context window has left after
 * this action's context. 1.0 = empty window, 0 = at or past the limit.
 *
 * `measured:true` when `contextTokens` was supplied, because that number comes
 * from the host's own `context_window.current_tokens` via `context-tracker.js`
 * rather than from a table here.
 *
 * @param {number|null} contextTokens - Current context size, or null.
 * @param {object} model - Catalog model spec.
 * @returns {{value: number, measured: boolean}} ctxAffinity term.
 */
function ctxAffinityTerm(contextTokens, model) {
  if (contextTokens === null || !model || !(model.ctxLimit > 0)) {
    return term(NEUTRAL, false);
  }
  return term(clamp(1 - contextTokens / model.ctxLimit), true);
}

/**
 * Cache affinity: the share of the current context already served from prompt
 * cache.
 *
 * TIER-INDEPENDENT by construction — every candidate gets the same value. The
 * scorer is not told which tier holds that cache, so it cannot say which
 * candidate would keep it. Discriminating between tiers on cache is
 * `route-hysteresis.js` (T-28), which is given the incumbent tier; the term
 * exists here so the receipt's eight terms are all present.
 *
 * @param {number|null} cacheReadTokens - Tokens served from cache last turn.
 * @param {number|null} contextTokens - Current context size.
 * @returns {{value: number, measured: boolean}} cacheAffinity term.
 */
function cacheAffinityTerm(cacheReadTokens, contextTokens) {
  if (cacheReadTokens === null || contextTokens === null || contextTokens === 0) {
    return term(NEUTRAL, false);
  }
  return term(clamp(cacheReadTokens / contextTokens), true);
}

/**
 * Reliability: `BASE_RELIABILITY` scaled by provider health for this tier.
 * `signals.providerHealth` is a `{ tier: 0..1 }` map, 1 = healthy; an entry
 * present for this tier makes the term measured, since it can only come from
 * observed refusals or errors.
 *
 * @param {object|undefined} providerHealth - Health map.
 * @param {string} tier - Candidate tier.
 * @returns {{value: number, measured: boolean}} reliability term.
 */
function reliabilityTerm(providerHealth, tier) {
  const health = providerHealth && typeof providerHealth === 'object'
    ? providerHealth[tier]
    : undefined;
  if (!Number.isFinite(health)) return term(BASE_RELIABILITY, false);
  return term(clamp(BASE_RELIABILITY * clamp(health)), true);
}

/**
 * Predicted success: base rate shaped by task fit, provider health and retries
 * already spent. Always `measured:false` — no outcome labels exist in the repo
 * (v5-lane2-routing.md §2.5 lists PredictedSuccessRate as 불가).
 *
 * @param {number} taskFit - Task fit 0..1.
 * @param {number} reliability - Reliability term value.
 * @param {number} retriesSoFar - Retries already spent on this action.
 * @returns {number} Success probability 0..1.
 */
function successValue(taskFit, reliability, retriesSoFar) {
  const fitted = BASE_SUCCESS * (0.5 + 0.5 * taskFit) * (reliability / BASE_RELIABILITY);
  return clamp(fitted - RETRY_PENALTY * retriesSoFar);
}

/**
 * Predicted cost of the action on this tier, in USD.
 *
 * INPUT SIDE ONLY, therefore a LOWER BOUND: output and thinking tokens cannot
 * be predicted without historical usage, which the repo does not collect.
 * Derived from the catalog price table, which is itself unverified — the
 * caveat rides on `terms.cost.measured === false`. Returns 0 when
 * `contextTokens` was not supplied; 0 here means "unknown", not "free".
 *
 * @param {number|null} contextTokens - Current context size.
 * @param {object} model - Catalog model spec.
 * @returns {number} USD, >= 0.
 */
function predictedCost(contextTokens, model) {
  if (contextTokens === null || !model) return 0;
  const tokens = contextTokens * (model.tokenizerCoeff ?? 1);
  return (tokens / 1_000_000) * (model.priceInPerMTok ?? 0);
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Score every allowed tier for an action class and rank them by utility.
 *
 * Cost and latency are scored RELATIVE TO THE CANDIDATE SET: the cheapest
 * allowed tier gets `cost.value === 1`, the fastest gets `latency.value === 1`.
 * That is the decision actually on the table — "which of these" — and it keeps
 * the terms comparable when policy narrows the allow-set to a single tier.
 *
 * @param {object} input - Scoring input (§2.2 contract).
 * @param {string} input.actionClass - One of {@link ACTION_CLASSES}.
 * @param {Set<string>|readonly string[]} input.allowedTiers - Tiers policy permits.
 * @param {object} [input.catalog] - Catalog port; defaults to {@link DEFAULT_CATALOG}.
 * @param {object} [input.signals] - Runtime signals.
 * @param {number} [input.signals.contextTokens] - Current context size in tokens.
 * @param {number} [input.signals.cacheReadTokens] - Tokens served from cache last turn.
 * @param {number} [input.signals.retriesSoFar] - Retries already spent on this action.
 * @param {Record<string, number>} [input.signals.providerHealth] - Tier → health 0..1.
 * @param {object} [options] - Scoring options.
 * @param {Record<string, number>} [options.weights] - Term weight override,
 *   renormalised to sum 1 (§4.3 profile weighting).
 * @returns {Array<{tier: string, utility: number, terms: Record<string, {value: number, measured: boolean}>, predicted: {success: number, cost: number, latency: number, retry_probability: number}}>}
 *   Ranked descending by utility, ties broken by cheaper tier then
 *   {@link TIER_ORDER}. EMPTY ARRAY when `actionClass` is not one of the eight
 *   or when no allowed tier is known to the catalog — a near-miss such as
 *   `complex-debugging` (the advisor trigger in `artibot.config.json:61`)
 *   yields no route rather than a plausible-looking one.
 *
 * @example
 * scoreRoutes({ actionClass: 'status', allowedTiers: ['haiku', 'opus'] })[0].tier;
 * // 'haiku'
 *
 * @example
 * scoreRoutes({ actionClass: 'complex-debugging', allowedTiers: ['opus'] });
 * // [] — not an action class
 */
export function scoreRoutes(input = {}, options = {}) {
  const src = input && typeof input === 'object' ? input : {};
  if (!isActionClass(src.actionClass)) return [];

  const catalog = src.catalog && typeof src.catalog.getModel === 'function'
    ? src.catalog
    : DEFAULT_CATALOG;
  const tiers = normaliseTiers(src.allowedTiers, catalog);
  if (tiers.length === 0) return [];

  const signals = src.signals && typeof src.signals === 'object' ? src.signals : {};
  const weights = normaliseWeights(options.weights);
  const factors = tiers.map((t) => resolveCostFactor(catalog, t));
  const indices = tiers.map((t) => TIER_LATENCY_INDEX[t] ?? 1);
  const bestFactor = Math.min(...factors);
  const bestIndex = Math.min(...indices);

  const rows = tiers.map((tier, i) => buildRow({
    tier,
    actionClass: src.actionClass,
    model: catalog.getModel(tier),
    signals,
    weights,
    costEfficiency: factors[i] > 0 ? bestFactor / factors[i] : NEUTRAL,
    latencyEfficiency: indices[i] > 0 ? bestIndex / indices[i] : NEUTRAL,
    costFactor: factors[i],
  }));

  return rows.sort(compareRows);
}

/**
 * Cost factor of a tier through the injected catalog, falling back to 1.0 when
 * the port does not expose `getCostFactor` (a caller may inject a pinned price
 * table that only implements `getModel`).
 *
 * @param {object} catalog - Catalog port.
 * @param {string} tier - Tier key.
 * @returns {number} Cost factor > 0.
 */
function resolveCostFactor(catalog, tier) {
  const factor = typeof catalog.getCostFactor === 'function'
    ? catalog.getCostFactor(tier)
    : 1;
  return Number.isFinite(factor) && factor > 0 ? factor : 1;
}

/**
 * Renormalise a weight override so the weights always sum to 1. Unknown keys
 * are dropped and missing ones default to {@link DEFAULT_WEIGHTS}; an override
 * summing to 0 (every weight zeroed) falls back to the defaults rather than
 * dividing by zero.
 *
 * @param {Record<string, number>|undefined} override - Caller weights.
 * @returns {Record<string, number>} Weights summing to 1.
 */
function normaliseWeights(override) {
  if (!override || typeof override !== 'object') return { ...DEFAULT_WEIGHTS };
  const merged = {};
  for (const name of TERM_NAMES) {
    const w = override[name];
    merged[name] = Number.isFinite(w) && w >= 0 ? w : DEFAULT_WEIGHTS[name];
  }
  const total = TERM_NAMES.reduce((s, n) => s + merged[n], 0);
  if (!(total > 0)) return { ...DEFAULT_WEIGHTS };
  for (const name of TERM_NAMES) merged[name] /= total;
  return merged;
}

/**
 * Build one scored row: the eight terms, the weighted utility, and the four
 * `predicted` values the RouteReceipt schema requires.
 *
 * @param {object} ctx - Everything the row needs, pre-resolved by the caller.
 * @returns {{tier: string, utility: number, terms: object, predicted: object, costFactor: number}}
 *   `costFactor` is carried for the tie-break and stripped by nothing — it is
 *   part of the returned row so a caller can order without re-deriving it.
 */
function buildRow(ctx) {
  const contextTokens = count(ctx.signals.contextTokens);
  const cacheReadTokens = count(ctx.signals.cacheReadTokens);
  const retries = count(ctx.signals.retriesSoFar) ?? 0;

  const fit = taskFitFor(ctx.actionClass, ctx.tier);
  const reliability = reliabilityTerm(ctx.signals.providerHealth, ctx.tier);
  const success = successValue(fit, reliability.value, retries);

  const terms = {
    quality: term(TIER_QUALITY[ctx.tier] ?? NEUTRAL, false),
    taskFit: term(fit, false),
    success: term(success, false),
    reliability,
    ctxAffinity: ctxAffinityTerm(contextTokens, ctx.model),
    cacheAffinity: cacheAffinityTerm(cacheReadTokens, contextTokens),
    cost: term(ctx.costEfficiency, false),
    latency: term(ctx.latencyEfficiency, false),
  };

  const utility = TERM_NAMES.reduce((sum, n) => sum + terms[n].value * ctx.weights[n], 0);

  return {
    tier: ctx.tier,
    utility: clamp(utility),
    terms,
    predicted: {
      success,
      cost: predictedCost(contextTokens, ctx.model),
      latency: (TIER_LATENCY_INDEX[ctx.tier] ?? 1) * BASELINE_LATENCY_MS,
      retry_probability: clamp(1 - success),
    },
    costFactor: ctx.costFactor,
  };
}

/**
 * Deterministic ranking: higher utility first, then cheaper, then
 * {@link TIER_ORDER}. Total and stable, so the same input always ranks the
 * same way — a routing decision that flips between identical inputs is a
 * defect, not a preference.
 *
 * @param {object} a - Left row.
 * @param {object} b - Right row.
 * @returns {number} Comparator result.
 */
function compareRows(a, b) {
  if (b.utility !== a.utility) return b.utility - a.utility;
  if (a.costFactor !== b.costFactor) return a.costFactor - b.costFactor;
  return TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier);
}

/**
 * Every tier the catalog knows, for callers that need the universe rather than
 * a policy allow-set. This is NOT an allow-set: passing it to
 * {@link scoreRoutes} scores tiers policy may forbid.
 *
 * @returns {string[]} Tier keys in {@link TIER_ORDER}.
 */
export function allCatalogTiers() {
  return TIER_ORDER.filter((t) => Object.prototype.hasOwnProperty.call(MODELS, t));
}

export { ACTION_CLASSES };
