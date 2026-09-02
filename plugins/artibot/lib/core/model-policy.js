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
 * Resolve the policy source object from an explicit config or the cached one.
 * Never throws; returns null when nothing usable is available.
 *
 * @param {object} [config] - Explicit config; falls back to getConfig().
 * @returns {object|null}
 */
function resolveConfigSource(config) {
  if (config && typeof config === 'object') return config;
  try {
    return getConfig();
  } catch {
    return null;
  }
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
  const src = resolveConfigSource(config);
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
 * True when the fable kill-switch (`agents.modelPolicy.fable.enabled`) is on.
 * This is the gate WITHOUT the per-agent allowlist/denylist — use it only for
 * requests that carry no agent identity (role aliases, bare phase roles).
 * Never throws.
 *
 * @param {object} [config] - Explicit config; falls back to getConfig().
 * @returns {boolean}
 *
 * @example
 * isFableGateEnabled({ agents: { modelPolicy: { fable: { enabled: true } } } }); // true
 * isFableGateEnabled({}); // false
 */
export function isFableGateEnabled(config) {
  return loadFableGate(config).enabled;
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
 * NOTE: `fable.enabled` is the kill-switch. When it is false this returns false
 * for EVERY agent regardless of the allowlist (single-tier opus fleet).
 *
 * @example
 * isFableAllowed('architect', cfg); // true  (only if enabled + allowlisted)
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
  const src = resolveConfigSource(config);
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
 * 0. Role-alias / raw-tier input (frontier|deep-async|balanced|fast or a tier
 *    name) — resolved immediately via the catalog; `opts.advisor` and
 *    `opts.role` are IGNORED on this path (the caller asked for a tier family,
 *    not an agent). A fable result still passes the opt-in gate: when
 *    `opts.agentType` names the calling agent, its allowlist/denylist status
 *    decides; without it only the kill-switch (`fable.enabled`) is consulted
 *    because there is no agent to check (see {@link gateFableTier}).
 * 1. opts.advisor — advisorStrategy.advisorModel, gated for `agentType`.
 * 2. opts.role — phase-role mapping from `agents.modelPolicy.phaseRoles`
 *    (build-side / review-side; see {@link resolveModelForPhase}), gated for
 *    `agentType` so a non-allowlisted agent in a fable phase still lands on opus.
 * 3. Policy bucket lookup, then defaultModel — gated for `agentType`.
 *
 * Never throws.
 *
 * @param {string} agentType - Agent name (prefixed or bare) OR a role alias / tier.
 * @param {object} [opts] - { advisor?:boolean, role?:string, agentType?:string }.
 *   `opts.agentType` is only meaningful on the alias path (step 0), where the
 *   first argument is not an agent name.
 * @param {object} [config] - Explicit config; falls back to getConfig().
 * @returns {'fable'|'opus'|'sonnet'|'haiku'}
 *
 * @example
 * resolveModel('architect'); // 'fable' (gate on + allowlisted)
 * resolveModel('backend-developer'); // 'opus' (high bucket, but not allowlisted)
 * resolveModel('security-reviewer'); // 'opus' (denylisted, never fable)
 * resolveModel('code-reviewer', { role: 'review' }); // 'fable' (phaseRoles.review)
 * resolveModel('backend-developer', { role: 'build' }); // 'opus' (phaseRoles.build)
 * resolveModel('doc-updater', { advisor: true }); // 'opus' (advisorModel)
 * resolveModel('frontier'); // 'opus' (role alias)
 * resolveModel('deep-async', { agentType: 'planner' }); // 'fable' (allowlisted caller)
 * resolveModel('deep-async', { agentType: 'backend-developer' }); // 'opus'
 * resolveModel('deep-async'); // 'fable' iff the kill-switch is on (no agent to check)
 * resolveModel('deep-async', { role: 'review' }); // alias wins, role ignored
 */
export function resolveModel(agentType, opts = {}, config) {
  const options = opts && typeof opts === 'object' ? opts : {};
  const policy = loadModelPolicy(config);

  // Role-alias fast path: if the input is a capability alias (frontier /
  // deep-async / balanced / fast) or a raw tier, resolve it via the catalog
  // BEFORE any bucket logic — this is an independent tier lookup, not an agent
  // name. The catalog import is one-way (model-catalog imports nothing), so no
  // cycle. The gate is applied against the CALLING agent when the caller
  // supplies one (`opts.agentType`); the alias string itself is never an
  // allowlist key.
  const aliasTier = resolveRole(agentType);
  if (aliasTier !== null) {
    const caller = normalizeAgentType(options.agentType);
    return gateFableTier(aliasTier, caller === '' ? null : caller, config);
  }

  if (options.advisor === true) {
    const advisor = policy.advisorStrategy;
    if (advisor && advisor.enabled && typeof advisor.advisorModel === 'string') {
      return gateFableTier(advisor.advisorModel, agentType, config);
    }
  }

  if (typeof options.role === 'string' && options.role !== '' && isKnownPhaseRole(options.role)) {
    return gateFableTier(resolvePhaseTierRaw(options.role, config), agentType, config);
  }

  const bucketModel = getPolicyModel(agentType, config) ?? policy.defaultModel;
  return gateFableTier(bucketModel, agentType, config);
}

/**
 * Enforce the fable opt-in gate on a resolved tier. Any non-fable tier passes
 * through unchanged. For 'fable':
 *   - with an agent name → {@link isFableAllowed} (kill-switch + allowlist +
 *     denylist);
 *   - without one (null/'' — role aliases, bare phase roles) → only the
 *     kill-switch ({@link isFableGateEnabled}). The allowlist and the security
 *     denylist CANNOT be applied here because there is no agent identity to
 *     check; callers that know the agent must pass it.
 * Never throws.
 *
 * @param {string} tier - The tier resolved by alias/bucket/advisor/phase logic.
 * @param {string|null} agentType - Agent name for the allowlist/denylist check, or null.
 * @param {object} [config] - Explicit config; falls back to getConfig().
 * @returns {string} The tier, or FABLE_FALLBACK_MODEL ('opus') if fable is gated out.
 */
function gateFableTier(tier, agentType, config) {
  if (tier !== 'fable') return tier;
  const name = normalizeAgentType(agentType);
  if (name === '') {
    return isFableGateEnabled(config) ? 'fable' : FABLE_FALLBACK_MODEL;
  }
  return isFableAllowed(name, config) ? 'fable' : FABLE_FALLBACK_MODEL;
}

/** Phase roles mapped to the build-side tier (`phaseRoles.build`). */
const BUILD_ROLES = new Set(['implementation', 'build', 'impl']);
/** Phase roles mapped to the review-side tier (`phaseRoles.review`). */
const REVIEW_ROLES = new Set(['review', 'inspect', 'crosscheck']);

/**
 * Defaults for `agents.modelPolicy.phaseRoles`. Both sides opus = the
 * pre-phaseRoles behavior, so a config without the key is byte-identical to
 * the previous hardcoded mapping.
 */
const DEFAULT_PHASE_ROLES = Object.freeze({ build: 'opus', review: 'opus' });

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
 * Load `agents.modelPolicy.phaseRoles` merged over {@link DEFAULT_PHASE_ROLES}.
 * A side is taken from config only when it is a known tier or role alias
 * (resolved through the catalog); anything else keeps the default. Never throws.
 *
 * @param {object} [config] - Explicit config; falls back to getConfig().
 * @returns {{ build: string, review: string }} Tier keys (not aliases).
 */
function loadPhaseRoles(config) {
  const src = resolveConfigSource(config);
  const raw = src && src.agents && src.agents.modelPolicy && src.agents.modelPolicy.phaseRoles;
  const out = { ...DEFAULT_PHASE_ROLES };
  if (!raw || typeof raw !== 'object') return out;
  for (const side of ['build', 'review']) {
    const tier = typeof raw[side] === 'string' ? resolveRole(raw[side].trim()) : null;
    if (tier !== null) out[side] = tier;
  }
  return out;
}

/**
 * Ungated phase tier for a role: `phaseRoles.build` for build-side roles,
 * `phaseRoles.review` for review-side roles, DEFAULT_MODEL otherwise.
 *
 * @param {string} role
 * @param {object} [config]
 * @returns {string}
 */
function resolvePhaseTierRaw(role, config) {
  if (typeof role !== 'string') return DEFAULT_MODEL;
  const phases = loadPhaseRoles(config);
  if (BUILD_ROLES.has(role)) return phases.build;
  if (REVIEW_ROLES.has(role)) return phases.review;
  return DEFAULT_MODEL;
}

/**
 * Map a team phase-role to a model, decoupled from any specific agent. The
 * mapping is read from `artibot.config.json#/agents/modelPolicy/phaseRoles`
 * (`{ build, review }`); a missing key defaults both sides to opus.
 *
 * **Called without an agent name, this function CANNOT see `fable.allowlist`
 * or `FABLE_DENYLIST` — a fable side passes on the kill-switch alone (see
 * {@link gateFableTier}). Do NOT use it to pick a teammate's tier:
 * `resolveModelForPhase('review')` returns 'fable' even for `security-reviewer`
 * or a non-allowlisted implementation agent. For teammate assignment always
 * call `resolveModel(agentName, { role })`, which applies the same phaseRoles
 * map AND the per-agent allowlist/denylist.** This agent-less form exists for
 * "what does the review phase default to" questions (docs, dashboards); as of
 * 2026-09-02 no lib/ or scripts/ code calls it.
 *
 * @param {string} role - 'implementation'|'build'|'impl' → phaseRoles.build;
 *   'review'|'inspect'|'crosscheck' → phaseRoles.review; unknown → DEFAULT_MODEL.
 * @param {object} [config] - Explicit config; falls back to getConfig().
 * @returns {string}
 *
 * @example
 * resolveModelForPhase('build', cfg); // 'opus'  (phaseRoles.build)
 * resolveModelForPhase('review', cfg); // 'fable' (phaseRoles.review, gate on)
 * resolveModelForPhase('mystery', cfg); // 'opus' (DEFAULT_MODEL)
 */
export function resolveModelForPhase(role, config) {
  return gateFableTier(resolvePhaseTierRaw(role, config), null, config);
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
