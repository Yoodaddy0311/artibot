/**
 * GRPO → Cognitive bridge.
 *
 * Exposes GRPO-learned task/team strategy weights as lightweight bias hints
 * for System 1/2 decisions, orchestrator agent selection, and planner
 * strategy picks. All functions are safe no-ops when GRPO history is empty
 * (fresh install or before the daily pipeline has run), so callers can
 * multiply/consume their results without branching.
 *
 * @module lib/cognitive/grpo-bridge
 */

import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { getGrpoStats, getRecommendation } from '../learning/grpo-optimizer.js';
import { getHomeDir } from '../core/platform.js';

/**
 * Neutral bias returned when GRPO has no data or a read fails. Multiplying
 * a confidence by 1.0 preserves the caller's existing behavior.
 */
export const NEUTRAL_BIAS = 1.0;

/** Clamp range to prevent any single GRPO weight from dominating cognition. */
const BIAS_MIN = 0.5;
const BIAS_MAX = 1.5;

/** Default path to the routing policy file (produced by Phase B policy-updater). */
const DEFAULT_POLICY_PATH = path.join(
  getHomeDir(),
  '.claude',
  'artibot',
  'policies',
  'routing-policy-v1.json',
);

/** Default path to the skill trigger policy file (GRPO v3.5 §5.5). */
const DEFAULT_SKILL_POLICY_PATH = path.join(
  getHomeDir(),
  '.claude',
  'artibot',
  'policies',
  'skill-policy-v1.json',
);

/** TTL for routing-policy memoization (ms). */
const POLICY_TTL_MS = 60_000;

/**
 * Cached policy snapshot. Shared across calls within the TTL window so that
 * a chatty routing loop does not hammer the filesystem. `null` means "no
 * read attempted yet"; an object with `loadedAt: null` means "read failed".
 * @type {{ loadedAt: number|null, policy: object|null, policyPath: string }|null}
 */
let _routingPolicyCache = null;

/**
 * Reset the routing-policy memo. Exposed for test isolation.
 * @returns {void}
 */
export function resetRoutingBiasCache() {
  _routingPolicyCache = null;
}

/**
 * Feature vector used by the linear policy (see design §3.3, d=9 features).
 * @typedef {{
 *   steps?: number,
 *   domains?: number,
 *   uncertainty?: number,
 *   risk?: number,
 *   novelty?: number,
 *   s1SuccessRate?: number,
 *   sessionDepth?: number,
 *   errorRate?: number,
 * }} RoutingFeatures
 */

/** Feature order must stay in sync with the policy file schema. */
const FEATURE_ORDER = Object.freeze([
  'steps',
  'domains',
  'uncertainty',
  'risk',
  'novelty',
  's1SuccessRate',
  'sessionDepth',
  'errorRate',
]);

/** Numerical-stability logistic (sigmoid) that never returns NaN. */
function sigmoid(z) {
  if (!Number.isFinite(z)) return 0.5;
  if (z >= 0) {
    const e = Math.exp(-z);
    return 1 / (1 + e);
  }
  const e = Math.exp(z);
  return e / (1 + e);
}

/**
 * Build a feature vector in the canonical order, filling missing values with
 * 0 and always appending a `bias` constant of 1.0 at the tail. Defensive: any
 * non-finite number is coerced to 0 to keep downstream math safe.
 * @param {RoutingFeatures} features
 * @returns {number[]} length == FEATURE_ORDER.length + 1
 */
function toFeatureVector(features) {
  const safe = features && typeof features === 'object' ? features : {};
  const x = FEATURE_ORDER.map((key) => {
    const v = safe[key];
    return typeof v === 'number' && Number.isFinite(v) ? v : 0;
  });
  x.push(1.0); // bias term
  return x;
}

/**
 * Load the routing policy from disk, memoized for 60s. Never throws — failures
 * return `null`, which tells {@link getRoutingBias} to emit the neutral fallback.
 * @param {string} [policyPath]
 * @returns {Promise<object|null>}
 */
async function readPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const now = Date.now();
  if (
    _routingPolicyCache
    && _routingPolicyCache.policyPath === policyPath
    && _routingPolicyCache.loadedAt !== null
    && now - _routingPolicyCache.loadedAt < POLICY_TTL_MS
  ) {
    return _routingPolicyCache.policy;
  }

  try {
    const raw = await readFile(policyPath, 'utf8');
    const parsed = JSON.parse(raw);
    _routingPolicyCache = { loadedAt: now, policy: parsed, policyPath };
    return parsed;
  } catch {
    // Also cache the miss so a hot loop does not re-stat every turn.
    _routingPolicyCache = { loadedAt: now, policy: null, policyPath };
    return null;
  }
}

/**
 * Clamp a value to [min, max].
 * @param {number} v
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

/**
 * Get a bias multiplier for a strategy label from GRPO-learned weights.
 * Returns {@link NEUTRAL_BIAS} when the strategy is unknown or when the
 * history cannot be read. Callers multiply their existing confidence by
 * the returned value.
 *
 * @param {string} strategy - Strategy label (e.g. `'Bash'`, `'balanced'`, `'fix'`).
 * @returns {Promise<number>} bias in [BIAS_MIN, BIAS_MAX]
 *
 * @example
 * const bias = await getStrategyBias('Bash');
 * const adjustedConfidence = baseConfidence * bias;
 */
export async function getStrategyBias(strategy) {
  if (!strategy || typeof strategy !== 'string') return NEUTRAL_BIAS;
  try {
    const stats = await getGrpoStats({ lookback: 50 });
    const weight = stats?.weights?.[strategy];
    if (typeof weight !== 'number' || !Number.isFinite(weight)) return NEUTRAL_BIAS;
    return clamp(weight, BIAS_MIN, BIAS_MAX);
  } catch {
    return NEUTRAL_BIAS;
  }
}

/**
 * Get the top-ranked strategy from GRPO history with safe fallback.
 * @param {object} [context] - Forwarded to grpo-optimizer.getRecommendation.
 * @returns {Promise<{ recommendation: string|null, weight: number, alternatives: object[] }>}
 *
 * @example
 * const { recommendation } = await getTopStrategy();
 * if (recommendation) useStrategy(recommendation);
 */
export async function getTopStrategy(context = {}) {
  try {
    const rec = await getRecommendation('task', context);
    return {
      recommendation: rec?.recommendation ?? null,
      weight: typeof rec?.weight === 'number' ? rec.weight : NEUTRAL_BIAS,
      alternatives: Array.isArray(rec?.alternatives) ? rec.alternatives : [],
    };
  } catch {
    return { recommendation: null, weight: NEUTRAL_BIAS, alternatives: [] };
  }
}

/**
 * Get the top-ranked team composition for a domain.
 * @param {string} [domain='general']
 * @returns {Promise<{ recommendation: string|null, weight: number, alternatives: object[] }>}
 */
export async function getTopTeam(domain = 'general') {
  try {
    const rec = await getRecommendation('team', { domain });
    return {
      recommendation: rec?.recommendation ?? null,
      weight: typeof rec?.weight === 'number' ? rec.weight : NEUTRAL_BIAS,
      alternatives: Array.isArray(rec?.alternatives) ? rec.alternatives : [],
    };
  } catch {
    return { recommendation: null, weight: NEUTRAL_BIAS, alternatives: [] };
  }
}

/**
 * Summary of how much learned signal is currently available. Consumers can
 * gate optional behavior on `hasData` to avoid acting on sparse history.
 * @returns {Promise<{ hasData: boolean, totalRounds: number, taskRounds: number, teamRounds: number }>}
 */
export async function getLearnedSignalSummary() {
  try {
    const stats = await getGrpoStats({ lookback: 200 });
    return {
      hasData: (stats?.totalRounds ?? 0) > 0,
      totalRounds: stats?.totalRounds ?? 0,
      taskRounds: stats?.taskRounds ?? 0,
      teamRounds: stats?.teamRounds ?? 0,
    };
  } catch {
    return { hasData: false, totalRounds: 0, taskRounds: 0, teamRounds: 0 };
  }
}

/**
 * Synchronous peek at the most recently memoized policy. Returns the same
 * `{ p_s2, confidence, source }` shape as {@link getRoutingBias} but never
 * awaits IO — if the memo is cold or stale beyond TTL, returns the neutral
 * fallback. Intended for the sync hot path inside `router.classifyComplexity`.
 *
 * @param {RoutingFeatures} features
 * @returns {{ p_s2: number, confidence: number, source: 'policy'|'fallback' }}
 */
export function getCachedRoutingBias(features) {
  const fallback = { p_s2: 0.5, confidence: 0, source: 'fallback' };
  const now = Date.now();
  if (
    !_routingPolicyCache
    || _routingPolicyCache.loadedAt === null
    || now - _routingPolicyCache.loadedAt >= POLICY_TTL_MS
  ) {
    return fallback;
  }
  const policy = _routingPolicyCache.policy;
  if (!policy || !Array.isArray(policy.theta)) return fallback;

  try {
    const theta = policy.theta;
    const x = toFeatureVector(features);
    if (theta.length !== x.length) return fallback;
    let z = 0;
    for (let i = 0; i < theta.length; i++) {
      const t = theta[i];
      if (typeof t !== 'number' || !Number.isFinite(t)) return fallback;
      z += t * x[i];
    }
    const p = sigmoid(z);
    if (!Number.isFinite(p)) return fallback;
    const confidence = Math.max(0, Math.min(1, Math.abs(p - 0.5) * 2));
    return { p_s2: p, confidence, source: 'policy' };
  } catch {
    return fallback;
  }
}

/**
 * Prefetch and memoize the routing policy. Fire-and-forget; safe to ignore
 * the returned promise. After resolution the sync {@link getCachedRoutingBias}
 * will serve bias reads for the next 60 seconds.
 * @param {{ policyPath?: string }} [options]
 * @returns {Promise<void>}
 */
export async function primeRoutingBiasCache(options = {}) {
  try {
    await readPolicy(options.policyPath ?? DEFAULT_POLICY_PATH);
  } catch {
    // swallow
  }
}

/**
 * Read the GRPO routing policy and compute the probability of routing to
 * System 2 for the supplied feature vector. Always safe: when the policy file
 * is missing, malformed, or the feature vector is invalid, returns a neutral
 * reading (`p_s2: 0.5, confidence: 0`). Memoized for 60s across calls.
 *
 * Contract:
 *   - Never throws.
 *   - `p_s2` is always a finite number in [0, 1].
 *   - `confidence` is 0 when fallback is used, otherwise proportional to how
 *     far `p_s2` sits from 0.5 (edge confidence = 1).
 *
 * @param {RoutingFeatures} features - Pre-execution routing features.
 * @param {object} [options]
 * @param {string} [options.policyPath] - Override path (defaults to ~/.claude/artibot/policies/routing-policy-v1.json).
 * @returns {Promise<{ p_s2: number, confidence: number, source: 'policy'|'fallback' }>}
 *
 * @example
 * const bias = await getRoutingBias({ steps: 0.4, domains: 0.3, risk: 0.2 });
 * if (bias.confidence > 0.3) useBiasedRouting(bias.p_s2);
 */
export async function getRoutingBias(features, options = {}) {
  const fallback = { p_s2: 0.5, confidence: 0, source: 'fallback' };
  try {
    const policy = await readPolicy(options.policyPath ?? DEFAULT_POLICY_PATH);
    if (!policy || !Array.isArray(policy.theta)) return fallback;

    const theta = policy.theta;
    const x = toFeatureVector(features);
    if (theta.length !== x.length) return fallback;

    let z = 0;
    for (let i = 0; i < theta.length; i++) {
      const t = theta[i];
      if (typeof t !== 'number' || !Number.isFinite(t)) return fallback;
      z += t * x[i];
    }

    const p = sigmoid(z);
    if (!Number.isFinite(p)) return fallback;
    // Distance-from-0.5 maps to confidence; clamp to [0, 1].
    const confidence = Math.max(0, Math.min(1, Math.abs(p - 0.5) * 2));
    return { p_s2: p, confidence, source: 'policy' };
  } catch {
    return fallback;
  }
}
