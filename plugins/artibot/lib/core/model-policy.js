/**
 * Model-policy resolver — the single source of truth for "which model for agent X".
 *
 * Reads `artibot.config.json#/agents/modelPolicy` and answers model-selection
 * questions for any agent. This is the ONE module other code (CI drift
 * validators, SubagentStart hooks) imports to stay consistent. Today the policy
 * is declared but unread; this module makes it authoritative.
 *
 * Design constraints (mirror lib/runtime/agent-resolver.js):
 *   - Zero new deps
 *   - Pure resolution logic, no side effects
 *   - Never throws: returns a safe default/null/[] on any error
 *   - Immutable: config objects are copied (spread), never mutated
 *   - Korean-path safe (relative import of config.js, no pathToFileURL)
 *
 * @module lib/core/model-policy
 */

import { getConfig } from './config.js';

/** Conservative fallback model for agents not listed in any policy bucket. */
export const DEFAULT_MODEL = 'sonnet';

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
 * policy.high.model; // 'opus'
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
 * @returns {'opus'|'sonnet'|null}
 *
 * @example
 * getPolicyModel('artibot:planner'); // 'opus'
 * getPolicyModel('doc-updater'); // 'sonnet'
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
 *   2. `opts.role` 'review'|'inspect' → 'sonnet';
 *      'implementation'|'build' → 'opus' (overrides bucket).
 *   3. Otherwise → getPolicyModel(agentType) ?? DEFAULT_MODEL.
 *
 * Never throws.
 *
 * @param {string} agentType - Agent name (prefixed or bare).
 * @param {object} [opts] - { advisor?:boolean, role?:string }.
 * @param {object} [config] - Explicit config; falls back to getConfig().
 * @returns {'opus'|'sonnet'}
 *
 * @example
 * resolveModel('planner'); // 'opus'
 * resolveModel('planner', { role: 'review' }); // 'sonnet'
 * resolveModel('doc-updater', { advisor: true }); // 'opus' (advisorModel)
 */
export function resolveModel(agentType, opts = {}, config) {
  const options = opts && typeof opts === 'object' ? opts : {};
  const policy = loadModelPolicy(config);

  if (options.advisor === true) {
    const advisor = policy.advisorStrategy;
    if (advisor && advisor.enabled && typeof advisor.advisorModel === 'string') {
      return advisor.advisorModel;
    }
  }

  if (typeof options.role === 'string') {
    const roleModel = resolveModelForPhase(options.role);
    if (options.role !== '' && isKnownPhaseRole(options.role)) return roleModel;
  }

  return getPolicyModel(agentType, config) ?? policy.defaultModel;
}

/** Phase roles mapped to opus (build-side). */
const BUILD_ROLES = new Set(['implementation', 'build', 'impl']);
/** Phase roles mapped to sonnet (review-side). */
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
 *   'review'|'inspect'|'crosscheck' → sonnet; unknown → DEFAULT_MODEL.
 * @returns {'opus'|'sonnet'}
 *
 * @example
 * resolveModelForPhase('build'); // 'opus'
 * resolveModelForPhase('review'); // 'sonnet'
 * resolveModelForPhase('mystery'); // 'sonnet' (DEFAULT_MODEL)
 */
export function resolveModelForPhase(role) {
  if (typeof role !== 'string') return DEFAULT_MODEL;
  if (BUILD_ROLES.has(role)) return 'opus';
  if (REVIEW_ROLES.has(role)) return 'sonnet';
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
