/**
 * Model-policy resolver — the single source of truth for "which model for agent X".
 *
 * Reads `artibot.config.json#/agents/modelPolicy` and answers model-selection
 * questions for any agent. This is the ONE module other code (CI drift
 * validators, SubagentStart hooks) imports to stay consistent. Today the policy
 * is declared but unread; this module makes it authoritative.
 *
 * Design constraints:
 *   - Zero new deps
 *   - Pure resolution logic, no side effects
 *   - Never throws: returns a safe default/null/[] on any error
 *   - Immutable: config objects are copied (spread), never mutated
 *   - Korean-path safe (relative import of config.js, no pathToFileURL)
 *
 * @module lib/core/model-policy
 */

import { getConfig } from './config.js';
import { resolveRole } from './model-catalog.js';

/**
 * Fallback model for agents not listed in any policy bucket. Opus (not fable)
 * so unlisted agents never route to the gated premium tier by accident.
 */
export const DEFAULT_MODEL = 'opus';

/** Tier every blocked/un-opted fable request is demoted to. */
const FABLE_FALLBACK_MODEL = 'opus';

/**
 * Agents that must NEVER run on fable, even if an operator lists them in the
 * fable allowlist. Fable's always-on refusal/cyber classifier produces
 * false-positive refusals on legitimate security-review work, so these agents
 * are hard-pinned to opus. Both the bare and `artibot:`-prefixed forms are
 * listed so a raw (un-normalized) lookup is also covered.
 *
 * @type {readonly string[]}
 */
export const FABLE_DENYLIST = Object.freeze([
  'security-reviewer',
  'artibot:security-reviewer',
]);

/**
 * Bare (normalized) denylist names for membership checks. Computed lazily on
 * first use so it does not touch `normalizeAgentType` (which closes over the
 * `AGENT_PREFIXES` const) during the module-init temporal dead zone.
 *
 * @type {string[]|null}
 */
let fableDenylistNormalized = null;

/**
 * @returns {string[]} Normalized denylist names (memoized).
 */
function getFableDenylistNormalized() {
  if (fableDenylistNormalized === null) {
    fableDenylistNormalized = FABLE_DENYLIST.map((n) =>
      normalizeAgentType(n),
    ).filter((n) => n !== '');
  }
  return fableDenylistNormalized;
}

/**
 * Load and normalize the opt-in fable gate config from `agents.modelPolicy.fable`.
 * Never throws; returns a disabled, empty gate if anything is missing or malformed
 * so the absence of a fable block is byte-identical to legacy behavior.
 *
 * @param {object} [config] - Explicit config; falls back to getConfig().
 * @returns {{ enabled: boolean, allowlist: string[] }}
 */
function loadFableGate(config) {
  let src = config;
  if (!src || typeof src !== 'object') {
    try {
      src = getConfig();
    } catch {
      src = null;
    }
  }
  const fable = src && src.agents && src.agents.modelPolicy && src.agents.modelPolicy.fable;
  if (!fable || typeof fable !== 'object') {
    return { enabled: false, allowlist: [] };
  }
  const enabled = fable.enabled === true;
  const rawAllow = Array.isArray(fable.allowlist) ? fable.allowlist : [];
  const allowlist = rawAllow
    .filter((a) => typeof a === 'string')
    .map((a) => normalizeAgentType(a))
    .filter((a) => a !== '');
  return { enabled, allowlist };
}

/**
 * Decide whether an agent is permitted to run on the fable tier. Returns true
 * ONLY when the gate is enabled, the (normalized) agent is in the allowlist, and
 * the agent is not on the security denylist. Every other case is false →
 * caller must demote to opus. Never throws.
 *
 * @param {string} agentType - Agent name (prefixed or bare).
 * @param {object} [config] - Explicit config; falls back to getConfig().
 * @returns {boolean}
 *
 * @example
 * isFableAllowed('architect', cfg); // true  (if enabled + allowlisted)
 * isFableAllowed('security-reviewer', cfg); // false (denylisted, always)
 */
export function isFableAllowed(agentType, config) {
  const name = normalizeAgentType(agentType);
  if (name === '') return false;
  if (getFableDenylistNormalized().includes(name)) return false;
  const gate = loadFableGate(config);
  if (!gate.enabled) return false;
  return gate.allowlist.includes(name);
}

/** Prefixes stripped from agent names before lookup. */
const AGENT_PREFIXES = ['artibot:', 'artibot-cowork:'];

/**
 * Strip a known plugin prefix (`artibot:` / `artibot-cowork:`) and trim.
 * Returns `''` for non-string input so callers never crash on bad data.
 *
 * @param {string} name - Raw agent name, possibly prefixed.
 * @returns {string} Normalized agent name, or '' if input is not a string.
 *
 * @example
 * normalizeAgentType('artibot:planner'); // 'planner'
 * normalizeAgentType('  orchestrator '); // 'orchestrator'
 * normalizeAgentType(42); // ''
 */
export function normalizeAgentType(name) {
  if (typeof name !== 'string') return '';
  let out = name.trim();
  for (const prefix of AGENT_PREFIXES) {
    if (out.startsWith(prefix)) {
      out = out.slice(prefix.length).trim();
      break;
    }
  }
  return out;
}

/** Safe empty-ish policy returned when config/policy is missing or malformed. */
const EMPTY_POLICY = Object.freeze({
  high: Object.freeze({ model: 'opus', agents: Object.freeze([]) }),
  medium: Object.freeze({ model: 'sonnet', agents: Object.freeze([]) }),
  advisorStrategy: null,
  defaultModel: DEFAULT_MODEL,
});

/**
 * Normalize a single policy bucket into `{ model, agents[] }`.
 *
 * @param {*} bucket - Raw bucket from config (may be undefined/malformed).
 * @param {string} fallbackModel - Model name to use if bucket lacks one.
 * @returns {{ model: string, agents: string[] }}
 */
function normalizeBucket(bucket, fallbackModel) {
  const model =
    bucket && typeof bucket.model === 'string' ? bucket.model : fallbackModel;
  const rawAgents = bucket && Array.isArray(bucket.agents) ? bucket.agents : [];
  const agents = rawAgents
    .filter((a) => typeof a === 'string')
    .map((a) => normalizeAgentType(a))
    .filter((a) => a !== '');
  return { model, agents };
}

/**
 * Load and normalize the model policy from the given config (or cached config).
 * Never throws; returns {@link EMPTY_POLICY}-shaped data if anything is missing.
 *
 * @param {object} [config] - Explicit config; falls back to getConfig().
 * @returns {{ high:{model:string,agents:string[]}, medium:{model:string,agents:string[]}, advisorStrategy:object|null, defaultModel:string }}
 *
 * @example
 * const policy = loadModelPolicy();
 * policy.high.model; // 'fable'
 */
export function loadModelPolicy(config) {
  let src = config;
  if (!src || typeof src !== 'object') {
    try {
      src = getConfig();
    } catch {
      src = null;
    }
  }
  const policy = src && src.agents && src.agents.modelPolicy;
  if (!policy || typeof policy !== 'object') {
    return { ...EMPTY_POLICY };
  }
  const advisor =
    policy.advisorStrategy && typeof policy.advisorStrategy === 'object'
      ? { ...policy.advisorStrategy }
      : null;
  return {
    high: normalizeBucket(policy.high, 'opus'),
    medium: normalizeBucket(policy.medium, 'sonnet'),
    advisorStrategy: advisor,
    defaultModel: DEFAULT_MODEL,
  };
}

/**
 * Strict bucket lookup: return the policy model for an agent, or null if the
 * agent is not listed in any bucket. Input is normalized first.
 *
 * @param {string} agentType - Agent name (prefixed or bare).
 * @param {object} [config] - Explicit config; falls back to getConfig().
 * @returns {string|null} Raw bucket model ('fable'|'opus'|...), or null if unlisted.
 *   NOTE: this is the UNGATED bucket value — a denylisted agent in a fable
 *   bucket still returns 'fable' here; use resolveModel for the effective tier.
 *
 * @example
 * getPolicyModel('artibot:planner'); // 'fable'
 * getPolicyModel('doc-updater'); // 'opus'
 * getPolicyModel('unknown'); // null
 */
export function getPolicyModel(agentType, config) {
  const name = normalizeAgentType(agentType);
  if (name === '') return null;
  const policy = loadModelPolicy(config);
  if (policy.high.agents.includes(name)) return policy.high.model;
  if (policy.medium.agents.includes(name)) return policy.medium.model;
  return null;
}

/**
 * Resolve the effective model for an agent, honoring role/advisor overrides.
 *
 * Precedence:
 *   1. `opts.advisor === true` → advisorStrategy.advisorModel (if enabled),
 *      else fall through to bucket/default.
 *   2. `opts.role` 'review'|'inspect' → 'opus';
 *      'implementation'|'build' → 'opus' (overrides bucket).
 *   3. Otherwise → getPolicyModel(agentType) ?? DEFAULT_MODEL.
 *
 * Never throws.
 *
 * Precedence:
 * 0. Role-alias / raw-tier input (frontier|deep-async|balanced|fast or a tier
 *    name) — resolved immediately via the catalog; `opts.advisor` and
 *    `opts.role` are IGNORED on this path (the caller asked for a tier family,
 *    not an agent). Fable still passes the opt-in gate.
 * 1. opts.advisor — advisorStrategy.advisorModel.
 * 2. opts.role — phase-role mapping (implementation/review/...).
 * 3. Policy bucket lookup, then defaultModel.
 *
 * @param {string} agentType - Agent name (prefixed or bare).
 * @param {object} [opts] - { advisor?:boolean, role?:string }.
 * @param {object} [config] - Explicit config; falls back to getConfig().
 * @returns {'fable'|'opus'|'sonnet'|'haiku'}
 *
 * @example
 * resolveModel('planner'); // 'fable' (high bucket, allowlisted)
 * resolveModel('security-reviewer'); // 'opus' (denylisted, never fable)
 * resolveModel('planner', { role: 'review' }); // 'opus'
 * resolveModel('doc-updater', { advisor: true }); // 'opus' (advisorModel)
 * resolveModel('frontier'); // 'opus'  (role alias)
 * resolveModel('deep-async'); // 'opus' unless fable gate opts the agent in
 * resolveModel('deep-async', { role: 'review' }); // 'opus' — alias wins, role ignored
 */
export function resolveModel(agentType, opts = {}, config) {
  const options = opts && typeof opts === 'object' ? opts : {};
  const policy = loadModelPolicy(config);

  // Role-alias fast path: if the input is a capability alias (frontier /
  // deep-async / balanced / fast) or a raw tier, resolve it via the catalog
  // BEFORE any bucket logic — this is an independent tier lookup, not an agent
  // name. The catalog import is one-way (model-catalog imports nothing), so no
  // cycle. Fable still passes the opt-in gate below.
  const aliasTier = resolveRole(agentType);
  if (aliasTier !== null) {
    return gateFableTier(aliasTier, agentType, config);
  }

  if (options.advisor === true) {
    const advisor = policy.advisorStrategy;
    if (advisor && advisor.enabled && typeof advisor.advisorModel === 'string') {
      return gateFableTier(advisor.advisorModel, agentType, config);
    }
  }

  if (typeof options.role === 'string') {
    const roleModel = resolveModelForPhase(options.role);
    if (options.role !== '' && isKnownPhaseRole(options.role)) return roleModel;
  }

  const bucketModel = getPolicyModel(agentType, config) ?? policy.defaultModel;
  return gateFableTier(bucketModel, agentType, config);
}

/**
 * Enforce the fable opt-in gate on a resolved tier. If `tier` is 'fable' and the
 * agent is not explicitly opted in (and not denylisted), demote to opus.
 * Any non-fable tier passes through unchanged. Never throws.
 *
 * @param {string} tier - The tier resolved by alias/bucket/advisor logic.
 * @param {string} agentType - Agent name used for the allowlist/denylist check.
 * @param {object} [config] - Explicit config; falls back to getConfig().
 * @returns {string} The tier, or FABLE_FALLBACK_MODEL ('opus') if fable is gated out.
 */
function gateFableTier(tier, agentType, config) {
  if (tier !== 'fable') return tier;
  return isFableAllowed(agentType, config) ? 'fable' : FABLE_FALLBACK_MODEL;
}

/** Phase roles mapped to opus (build-side). */
const BUILD_ROLES = new Set(['implementation', 'build', 'impl']);
/** Phase roles mapped to opus (review-side; formerly sonnet pre-fable-migration). */
const REVIEW_ROLES = new Set(['review', 'inspect', 'crosscheck']);

/**
 * True if `role` is a recognized phase role (build- or review-side).
 *
 * @param {string} role
 * @returns {boolean}
 */
function isKnownPhaseRole(role) {
  return BUILD_ROLES.has(role) || REVIEW_ROLES.has(role);
}

/**
 * Map a team phase-role to a model, decoupled from any specific agent.
 *
 * @param {string} role - 'implementation'|'build'|'impl' → opus;
 *   'review'|'inspect'|'crosscheck' → opus; unknown → DEFAULT_MODEL.
 * @returns {string}
 *
 * @example
 * resolveModelForPhase('build'); // 'opus'
 * resolveModelForPhase('review'); // 'opus'
 * resolveModelForPhase('mystery'); // 'opus' (DEFAULT_MODEL)
 */
export function resolveModelForPhase(role) {
  if (typeof role !== 'string') return DEFAULT_MODEL;
  if (BUILD_ROLES.has(role)) return 'opus';
  if (REVIEW_ROLES.has(role)) return 'opus';
  return DEFAULT_MODEL;
}

/**
 * List every agent assigned to the given model in the policy (normalized).
 *
 * @param {string} model - 'opus' or 'sonnet'.
 * @param {object} [config] - Explicit config; falls back to getConfig().
 * @returns {string[]} Copy of the matching bucket's agent names (never the original array).
 *
 * @example
 * listAgentsByModel('opus'); // ['orchestrator', 'architect', ...]
 */
export function listAgentsByModel(model, config) {
  if (typeof model !== 'string') return [];
  const policy = loadModelPolicy(config);
  const out = [];
  if (policy.high.model === model) out.push(...policy.high.agents);
  if (policy.medium.model === model) out.push(...policy.medium.agents);
  return out;
}

/**
 * True if the agent appears in any policy bucket.
 *
 * @param {string} agentType - Agent name (prefixed or bare).
 * @param {object} [config] - Explicit config; falls back to getConfig().
 * @returns {boolean}
 *
 * @example
 * isKnownAgent('planner'); // true
 * isKnownAgent('nobody'); // false
 */
export function isKnownAgent(agentType, config) {
  return getPolicyModel(agentType, config) !== null;
}
