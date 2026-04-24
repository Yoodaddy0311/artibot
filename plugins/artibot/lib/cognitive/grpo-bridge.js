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

/** Default path to the agent-selection policy file (GRPO v3.5 §5.4). */
const DEFAULT_AGENT_POLICY_PATH = path.join(
  getHomeDir(),
  '.claude',
  'artibot',
  'policies',
  'agent-policy-v1.json',
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
 * Memoization cache for skill-policy reads. Same TTL semantics as the
 * routing policy cache; keyed independently because the two policies live
 * in separate JSON files.
 * @type {{ loadedAt: number|null, policy: object|null, policyPath: string }|null}
 */
let _skillPolicyCache = null;

/**
 * Memoization cache for per-(intent, candidates) skill trigger biases.
 * Separate from the policy cache above so scoring can short-circuit without
 * re-reading the JSON when the same candidates keep appearing turn-to-turn.
 * @type {Map<string, { loadedAt: number, value: Record<string, number> }>}
 */
const _skillBiasMemo = new Map();

/**
 * Reset the routing-policy memo. Exposed for test isolation.
 * @returns {void}
 */
export function resetRoutingBiasCache() {
  _routingPolicyCache = null;
}

/**
 * Reset the skill-policy memos. Exposed for test isolation.
 * @returns {void}
 */
export function resetSkillBiasCache() {
  _skillPolicyCache = null;
  _skillBiasMemo.clear();
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

// ---------------------------------------------------------------------------
// Skill trigger bias (v3.5 §5.5)
// ---------------------------------------------------------------------------

/**
 * Read the skill-trigger policy from disk, memoized for 60s. Never throws.
 * @param {string} [policyPath]
 * @returns {Promise<object|null>}
 */
async function readSkillPolicy(policyPath = DEFAULT_SKILL_POLICY_PATH) {
  const now = Date.now();
  if (
    _skillPolicyCache
    && _skillPolicyCache.policyPath === policyPath
    && _skillPolicyCache.loadedAt !== null
    && now - _skillPolicyCache.loadedAt < POLICY_TTL_MS
  ) {
    return _skillPolicyCache.policy;
  }

  try {
    const raw = await readFile(policyPath, 'utf8');
    const parsed = JSON.parse(raw);
    _skillPolicyCache = { loadedAt: now, policy: parsed, policyPath };
    return parsed;
  } catch {
    _skillPolicyCache = { loadedAt: now, policy: null, policyPath };
    return null;
  }
}

function memoKey(intent, candidates) {
  const safeIntent = typeof intent === 'string' ? intent : '';
  const names = Array.isArray(candidates)
    ? [...candidates].filter((c) => typeof c === 'string').sort().join('|')
    : '';
  return `${safeIntent}::${names}`;
}

function scoreFromPolicy(policy, intent, candidates) {
  const skills = policy?.skills;
  if (!skills || typeof skills !== 'object') return null;
  const out = Object.create(null);
  const tokens = [];
  const seen = new Set();
  const add = (raw) => {
    if (typeof raw !== 'string') return;
    for (const t of raw.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
      if (!t || t.length < 2 || seen.has(t)) continue;
      seen.add(t);
      tokens.push(t);
    }
  };
  add(intent);

  for (const name of candidates) {
    const entry = skills[name];
    if (!entry || typeof entry !== 'object') {
      out[name] = null; // neutral — caller falls back to regex
      continue;
    }
    const w = entry.triggerWeights ?? {};
    let z = Number.isFinite(entry.baseline_bias) ? entry.baseline_bias : 0;
    for (const t of tokens) {
      const v = w[t];
      if (typeof v === 'number' && Number.isFinite(v)) z += v;
    }
    out[name] = sigmoid(z);
  }
  return out;
}

/**
 * Get a per-skill invoke bias for the supplied intent + candidate set. When
 * the skill policy file is missing, malformed, or the candidate has no
 * trained entry, that candidate's bias is `null` (caller keeps regex
 * decision). Memoized for 60s per (intent, sorted-candidates) key.
 *
 * Contract:
 *   - Never throws.
 *   - Returns `null` when the whole policy is unavailable — the middleware
 *     treats this as "fall back to regex across the board".
 *   - Per-candidate `null` preserves the baseline for that skill only.
 *
 * @param {string} intent
 * @param {string[]} candidates
 * @param {object} [options]
 * @param {string} [options.policyPath]
 * @returns {Promise<Record<string, number|null>|null>}
 *
 * @example
 * const bias = await getSkillTriggerBias('refactor foo.js', ['tdd-workflow', 'copywriting']);
 * if (bias && bias['tdd-workflow'] != null && bias['tdd-workflow'] > 0.5) {
 *   triggerSkill('tdd-workflow');
 * }
 */
export async function getSkillTriggerBias(intent, candidates, options = {}) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  const safeCandidates = candidates.filter((c) => typeof c === 'string' && c);
  if (safeCandidates.length === 0) return null;

  const key = memoKey(intent, safeCandidates);
  const now = Date.now();
  const cached = _skillBiasMemo.get(key);
  if (cached && now - cached.loadedAt < POLICY_TTL_MS) {
    return cached.value;
  }

  try {
    const policy = await readSkillPolicy(options.policyPath ?? DEFAULT_SKILL_POLICY_PATH);
    if (!policy) {
      _skillBiasMemo.set(key, { loadedAt: now, value: null });
      return null;
    }
    const scores = scoreFromPolicy(policy, intent, safeCandidates);
    if (!scores) {
      _skillBiasMemo.set(key, { loadedAt: now, value: null });
      return null;
    }
    _skillBiasMemo.set(key, { loadedAt: now, value: scores });
    return scores;
  } catch {
    _skillBiasMemo.set(key, { loadedAt: now, value: null });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Agent-selection policy bridge (GRPO v3.5 §5.4)
// ---------------------------------------------------------------------------

/**
 * Memoization cache for agent-policy reads. Same TTL as the other caches.
 * @type {{ loadedAt: number|null, policy: object|null, policyPath: string }|null}
 */
let _agentPolicyCache = null;

/**
 * Reset the agent-policy memo. Exposed for test isolation.
 * @returns {void}
 */
export function resetAgentPolicyCache() {
  _agentPolicyCache = null;
}

/**
 * Load the agent-selection policy JSON from disk, memoized for 60s.
 * Returns `null` on missing/malformed file (caller falls back to baseline).
 *
 * @param {string} [policyPath]
 * @returns {Promise<object|null>}
 */
async function readAgentPolicy(policyPath = DEFAULT_AGENT_POLICY_PATH) {
  const now = Date.now();
  if (
    _agentPolicyCache
    && _agentPolicyCache.policyPath === policyPath
    && _agentPolicyCache.loadedAt !== null
    && now - _agentPolicyCache.loadedAt < POLICY_TTL_MS
  ) {
    return _agentPolicyCache.policy;
  }
  try {
    const raw = await readFile(policyPath, 'utf8');
    const parsed = JSON.parse(raw);
    _agentPolicyCache = { loadedAt: now, policy: parsed, policyPath };
    return parsed;
  } catch {
    _agentPolicyCache = { loadedAt: now, policy: null, policyPath };
    return null;
  }
}

/**
 * Recommend an agent for a task family using the learned softmax policy.
 *
 * Safe by construction:
 *   - Never throws.
 *   - Returns `{ recommendation: null, source: 'fallback' }` when no policy
 *     file exists AND no baseline map was provided. The middleware should
 *     fall back to `artibot.config.json`'s `agents.taskBased` map.
 *   - When the family has insufficient learned evidence, returns the baseline
 *     with `source = 'baseline'`.
 *   - When learned, returns `source = 'policy'` + confidence + top-K alternatives.
 *
 * Memoized for 60s.
 *
 * @param {string} taskFamily
 * @param {object} [context]
 * @param {object} [context.config] - full artibot config for taskBased baseline
 * @param {string[]} [context.candidates] - explicit candidate list override
 * @param {number} [context.temperature=1.0]
 * @param {number} [context.topK=3]
 * @param {string} [context.policyPath]
 * @returns {Promise<{
 *   recommendation: string|null,
 *   confidence: number,
 *   source: 'policy'|'baseline'|'fallback',
 *   alternatives: Array<{ agent: string, prob: number, weight: number }>,
 * }>}
 */
export async function getAgentRecommendation(taskFamily, context = {}) {
  const fallback = { recommendation: null, confidence: 0, source: 'fallback', alternatives: [] };
  if (typeof taskFamily !== 'string' || taskFamily.length === 0) return fallback;
  try {
    const mod = await import('../learning/grpo/agent-policy.js');
    const getAgentRec = mod.getRecommendation;
    const policy = await readAgentPolicy(context.policyPath ?? DEFAULT_AGENT_POLICY_PATH);
    const weights = policy?.weights ?? {};
    const out = getAgentRec(weights, taskFamily, {
      candidates: context.candidates,
      temperature: context.temperature,
      config: context.config,
      topK: context.topK,
    });
    return {
      recommendation: out?.recommendation ?? null,
      confidence: typeof out?.confidence === 'number' ? out.confidence : 0,
      source: out?.source ?? 'fallback',
      alternatives: Array.isArray(out?.alternatives) ? out.alternatives : [],
    };
  } catch {
    return fallback;
  }
}
