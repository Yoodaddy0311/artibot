/**
 * User model-routing overrides — the per-plugin layer ON TOP of the shipped
 * model policy.
 *
 * The shipped policy (`artibot.config.json#/agents/modelPolicy`, read by
 * `model-policy.js#resolveModel`) is replaced on every install/upgrade, so a
 * user's own routing choice cannot live there. It lives in a separate user file,
 * `<resolveArtibotDir()>/model-routing.json`, keyed plugin → agent so the two
 * plugins never share a key:
 *
 *   { schemaVersion: 1,
 *     plugins: { artibot:          { default, agents: {}, phaseRoles: {} },
 *                'artibot-cowork': { default, agents: {} } },
 *     updatedAt? }
 *
 * The file is NEVER merged into `loadConfig()`: CI drift checks and replay
 * baselines read the shipped config, and a developer machine's override must not
 * leak into them. Callers inject the overrides explicitly.
 *
 * {@link resolveEffectiveModel} is the one answer to "which model for this
 * spawn, counting the user's choice". Precedence: user agent > user phase
 * (artibot only) > user plugin default > shipped. The fable gate and
 * `FABLE_DENYLIST` are applied LAST, so no user setting can lift them. With no
 * override in play the artibot answer is `resolveModel(...)` unchanged.
 *
 * `artibot-cowork` has no resolver of its own: its shipped value is its agent
 * frontmatter, which the caller supplies. It is never looked up in the core
 * policy — `model-policy.js` strips the `artibot-cowork:` prefix and would
 * answer with the same-named core agent's policy.
 *
 * Layer 1 (lib/core): imports lib/core only. The only filesystem access is
 * {@link loadOverrides} reading one file. Pure functions return new objects and
 * never mutate their input.
 *
 * @module lib/core/model-overrides
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { resolveArtibotDir } from './config.js';
import { resolveRole } from './model-catalog.js';
import {
  BUILD_ROLES,
  FABLE_DENYLIST,
  isFableAllowed,
  isFableGateEnabled,
  normalizeAgentType,
  resolveModel,
  REVIEW_ROLES,
} from './model-policy.js';

/** Tiers a user may pick without the fable gate. */
export const OVERRIDE_TIERS = Object.freeze(['haiku', 'sonnet', 'opus']);

/** Plugins whose spawns can carry an override. */
export const PLUGIN_NAMES = Object.freeze(['artibot', 'artibot-cowork']);

/** Version of the on-disk shape. Anything else is rejected. */
export const SCHEMA_VERSION = 1;

/** File name inside the artibot state directory. */
export const OVERRIDES_FILENAME = 'model-routing.json';

/**
 * Every tier word a stored override may hold. A loaded file is checked against
 * this vocabulary only; the gate and denylist are applied at resolve time.
 */
const TIER_VOCABULARY = Object.freeze([...OVERRIDE_TIERS, 'fable']);

/** Validation modes: `write` is gate-aware and strict, `load` checks vocabulary. */
const VALIDATION_MODES = Object.freeze(['write', 'load']);

/** Tier every gated-out fable pick is demoted to. */
const FABLE_FALLBACK = 'opus';

/** UTF-8 byte-order mark some Windows editors prepend; stripped before parsing. */
const BOM = 0xfeff;

/** Phase keys the artibot plugin accepts. */
const PHASE_KEYS = Object.freeze(['build', 'review']);

/** Known keys per level — everything else is an error (allowlist). */
const TOP_LEVEL_KEYS = Object.freeze(['schemaVersion', 'plugins', 'updatedAt']);
const PLUGIN_KEYS = Object.freeze({
  artibot: Object.freeze(['default', 'agents', 'phaseRoles']),
  'artibot-cowork': Object.freeze(['default', 'agents']),
});

/** Scopes accepted by {@link setOverride} / {@link clearOverride}. */
const SCOPES = Object.freeze(['agent', 'phase', 'plugin']);

/**
 * Shape of a stored agent key: lowercase, no plugin prefix. Also keeps
 * `__proto__`-style keys out of the file.
 */
const AGENT_KEY_PATTERN = /^[a-z0-9][a-z0-9_.-]*$/;

/** Plugin prefixes {@link qualifyAgent} recognizes. */
const QUALIFIERS = Object.freeze([
  ['artibot-cowork:', 'artibot-cowork'],
  ['artibot:', 'artibot'],
]);

/**
 * Absolute path of the overrides file. `resolveArtibotDir()` is called on every
 * call (never the import-time `ARTIBOT_DIR` constant) so tests can isolate it.
 *
 * @param {string} [dir] - State directory; defaults to `resolveArtibotDir()`.
 * @returns {string}
 */
export function overridesPath(dir = resolveArtibotDir()) {
  return path.resolve(dir, OVERRIDES_FILENAME);
}

/**
 * A fresh, override-free document. `artibot-cowork` has no `phaseRoles`.
 *
 * @returns {object}
 */
export function emptyOverrides() {
  return {
    schemaVersion: SCHEMA_VERSION,
    plugins: {
      artibot: { default: null, agents: {}, phaseRoles: {} },
      'artibot-cowork': { default: null, agents: {} },
    },
  };
}

/**
 * Split a possibly-qualified agent name into plugin and agent.
 *
 * @param {string} name - `artibot:x`, `artibot-cowork:x` or bare `x`.
 * @returns {{ plugin: string|null, agent: string, qualified: boolean }|null}
 *   null for non-strings, empty names, or any other prefix.
 *
 * @example
 * qualifyAgent('artibot-cowork:planner'); // { plugin: 'artibot-cowork', agent: 'planner', qualified: true }
 * qualifyAgent('planner'); // { plugin: null, agent: 'planner', qualified: false }
 * qualifyAgent('other:planner'); // null
 */
export function qualifyAgent(name) {
  if (typeof name !== 'string') return null;
  const trimmed = name.trim();
  for (const [prefix, plugin] of QUALIFIERS) {
    if (trimmed.startsWith(prefix)) {
      const agent = trimmed.slice(prefix.length).trim().toLowerCase();
      if (agent === '' || agent.includes(':')) return null;
      return { plugin, agent, qualified: true };
    }
  }
  if (trimmed === '' || trimmed.includes(':')) return null;
  return { plugin: null, agent: trimmed.toLowerCase(), qualified: false };
}

/**
 * True when `agent` (bare or prefixed) is on the security denylist.
 *
 * @param {string} agent
 * @returns {boolean}
 */
function isDenylisted(agent) {
  const name = normalizeAgentType(agent).toLowerCase();
  return FABLE_DENYLIST.some((entry) => normalizeAgentType(entry) === name);
}

/**
 * Tiers a user may WRITE under `config`. Fable is admitted only when an
 * explicit config has the kill-switch on — no fallback to the module config
 * cache.
 *
 * @param {object} [config]
 * @returns {string[]} A fresh array.
 *
 * @example
 * allowedTiersFor(shippedConfig); // ['haiku', 'sonnet', 'opus'] (gate off)
 */
export function allowedTiersFor(config) {
  const gateOn = config !== null && typeof config === 'object' && isFableGateEnabled(config);
  return gateOn ? [...OVERRIDE_TIERS, 'fable'] : [...OVERRIDE_TIERS];
}

/**
 * @param {*} tier
 * @returns {boolean} True when `tier` is exactly one of the stored-tier
 *   vocabulary (OVERRIDE_TIERS plus 'fable'), case-sensitive.
 */
function isTierWord(tier) {
  return typeof tier === 'string' && TIER_VOCABULARY.includes(tier);
}

/**
 * @param {*} value
 * @returns {boolean} True for a non-null, non-array object.
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Validate one tier value and collect an error when it is not allowed.
 *
 * @param {*} tier
 * @param {string} where - Dotted path for the message.
 * @param {string[]} allowed
 * @param {string[]} errors - Collected in place (local accumulator).
 */
function checkTier(tier, where, allowed, errors) {
  if (typeof tier !== 'string' || !allowed.includes(tier)) {
    errors.push(`${where}: tier ${JSON.stringify(tier)} is not one of ${allowed.join('|')}`);
  }
}

/**
 * Validate the `agents` map of one plugin.
 *
 * @param {*} agents
 * @param {string} where
 * @param {{ allowed: string[], strict: boolean }} rules - `strict` also
 *   rejects fable on a denylisted agent (write mode).
 * @param {string[]} errors
 */
function checkAgents(agents, where, rules, errors) {
  if (!isPlainObject(agents)) {
    errors.push(`${where}: must be an object`);
    return;
  }
  for (const [key, tier] of Object.entries(agents)) {
    if (!AGENT_KEY_PATTERN.test(key)) {
      errors.push(`${where}: agent key ${JSON.stringify(key)} must be a bare lowercase name`);
      continue;
    }
    checkTier(tier, `${where}.${key}`, rules.allowed, errors);
    if (rules.strict && tier === 'fable' && isDenylisted(key)) {
      errors.push(`${where}.${key}: ${key} is on FABLE_DENYLIST and can never run on fable`);
    }
  }
}

/**
 * Validate the `phaseRoles` map of the artibot plugin.
 *
 * @param {*} phases
 * @param {string} where
 * @param {string[]} allowed
 * @param {string[]} errors
 */
function checkPhases(phases, where, allowed, errors) {
  if (!isPlainObject(phases)) {
    errors.push(`${where}: must be an object`);
    return;
  }
  for (const [key, tier] of Object.entries(phases)) {
    if (!PHASE_KEYS.includes(key)) {
      errors.push(`${where}: unknown phase ${JSON.stringify(key)} (allowed: ${PHASE_KEYS.join('|')})`);
      continue;
    }
    checkTier(tier, `${where}.${key}`, allowed, errors);
  }
}

/**
 * Validate one plugin block.
 *
 * @param {string} plugin
 * @param {*} block
 * @param {{ allowed: string[], strict: boolean }} rules
 * @param {string[]} errors
 */
function checkPlugin(plugin, block, rules, errors) {
  const where = `plugins.${plugin}`;
  if (!isPlainObject(block)) {
    errors.push(`${where}: must be an object`);
    return;
  }
  for (const key of Object.keys(block)) {
    if (!PLUGIN_KEYS[plugin].includes(key)) {
      errors.push(`${where}: unknown key ${JSON.stringify(key)}`);
    }
  }
  if (Object.hasOwn(block, 'default') && block.default !== null) {
    checkTier(block.default, `${where}.default`, rules.allowed, errors);
  }
  if (Object.hasOwn(block, 'agents')) checkAgents(block.agents, `${where}.agents`, rules, errors);
  if (Object.hasOwn(block, 'phaseRoles') && PLUGIN_KEYS[plugin].includes('phaseRoles')) {
    checkPhases(block.phaseRoles, `${where}.phaseRoles`, rules.allowed, errors);
  }
}

/**
 * Validate an overrides document against the allowlist schema. Unknown keys,
 * plugins, phases and tiers are errors (fail-closed). Never throws.
 *
 * Two modes:
 * - `write` (default) — what a setter may store: tiers from
 *   {@link allowedTiersFor}(config), so fable only with an explicit config
 *   whose gate is on, and never fable on a FABLE_DENYLIST agent.
 * - `load` — what a stored file may hold: tier words from the full vocabulary
 *   (haiku|sonnet|opus|fable), whatever the gate says today. A gate flipped
 *   on→off must not turn a whole file malformed and drop unrelated overrides;
 *   {@link resolveEffectiveModel} demotes gated picks and reports the reason.
 *
 * @param {*} obj
 * @param {{ config?: object, mode?: 'write'|'load' }} [options]
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateOverrides(obj, { config, mode = 'write' } = {}) {
  if (!VALIDATION_MODES.includes(mode)) {
    return { ok: false, errors: [`mode: ${JSON.stringify(mode)} is not one of ${VALIDATION_MODES.join('|')}`] };
  }
  const errors = [];
  if (!isPlainObject(obj)) return { ok: false, errors: ['document: must be a JSON object'] };
  for (const key of Object.keys(obj)) {
    if (!TOP_LEVEL_KEYS.includes(key)) errors.push(`document: unknown key ${JSON.stringify(key)}`);
  }
  if (obj.schemaVersion !== SCHEMA_VERSION) {
    errors.push(`schemaVersion: expected ${SCHEMA_VERSION}, got ${JSON.stringify(obj.schemaVersion)}`);
  }
  if (Object.hasOwn(obj, 'updatedAt') && typeof obj.updatedAt !== 'string') {
    errors.push('updatedAt: must be a string');
  }
  if (!isPlainObject(obj.plugins)) {
    errors.push('plugins: must be an object');
    return { ok: false, errors };
  }
  const rules = mode === 'load'
    ? { allowed: [...TIER_VOCABULARY], strict: false }
    : { allowed: allowedTiersFor(config), strict: true };
  for (const [plugin, block] of Object.entries(obj.plugins)) {
    if (!PLUGIN_NAMES.includes(plugin)) {
      errors.push(`plugins: unknown plugin ${JSON.stringify(plugin)} (allowed: ${PLUGIN_NAMES.join('|')})`);
      continue;
    }
    checkPlugin(plugin, block, rules, errors);
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Read and validate the overrides file. Never throws.
 *
 * - `absent`     — no file; `overrides` is {@link emptyOverrides}.
 * - `ok`         — parsed and valid.
 * - `malformed`  — bad JSON or failed validation; `overrides` is null.
 * - `unreadable` — any other read error; `overrides` is null.
 *
 * A null `overrides` means "use the shipped policy and warn" — the caller must
 * surface the errors, or a broken file silently reads as "no settings".
 *
 * Validation runs in `load` mode (tier vocabulary only), so the result does
 * not depend on today's fable gate; a stored fable pick the gate refuses is
 * demoted by {@link resolveEffectiveModel} with a reason. `config` is accepted
 * for call-site symmetry and not consulted.
 *
 * @param {{ dir?: string, config?: object }} [options]
 * @returns {{ status: string, overrides: object|null, path: string, errors: string[] }}
 */
export function loadOverrides({ dir } = {}) {
  let filePath;
  try {
    filePath = overridesPath(dir);
  } catch (err) {
    return { status: 'unreadable', overrides: null, path: '', errors: [String(err?.message ?? err)] };
  }
  let text;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') {
      return { status: 'absent', overrides: emptyOverrides(), path: filePath, errors: [] };
    }
    return { status: 'unreadable', overrides: null, path: filePath, errors: [`${err?.code ?? 'error'}: ${err?.message ?? err}`] };
  }
  let parsed;
  try {
    parsed = JSON.parse(text.charCodeAt(0) === BOM ? text.slice(1) : text);
  } catch (err) {
    return { status: 'malformed', overrides: null, path: filePath, errors: [`invalid JSON: ${err.message}`] };
  }
  const { ok, errors } = validateOverrides(parsed, { mode: 'load' });
  if (!ok) return { status: 'malformed', overrides: null, path: filePath, errors };
  return { status: 'ok', overrides: parsed, path: filePath, errors: [] };
}

/**
 * Deep copy of the known fields into the full shape (both plugins, every key).
 * Input is assumed validated; unknown fields are dropped.
 *
 * @param {object|null} overrides
 * @returns {object}
 */
function cloneOverrides(overrides) {
  const out = emptyOverrides();
  if (!isPlainObject(overrides)) return out;
  if (typeof overrides.updatedAt === 'string') out.updatedAt = overrides.updatedAt;
  const plugins = isPlainObject(overrides.plugins) ? overrides.plugins : {};
  for (const plugin of PLUGIN_NAMES) {
    const src = isPlainObject(plugins[plugin]) ? plugins[plugin] : {};
    const dst = out.plugins[plugin];
    dst.default = typeof src.default === 'string' ? src.default : null;
    if (isPlainObject(src.agents)) dst.agents = { ...src.agents };
    if ('phaseRoles' in dst && isPlainObject(src.phaseRoles)) dst.phaseRoles = { ...src.phaseRoles };
  }
  return out;
}

/**
 * Check `scope` / `plugin` and return the normalized key, or throw TypeError.
 *
 * @param {string} scope
 * @param {string} plugin
 * @param {*} key
 * @returns {string|null} Agent key, phase key, or null for plugin scope.
 */
function checkTarget(scope, plugin, key) {
  if (!SCOPES.includes(scope)) {
    throw new TypeError(`unknown scope ${JSON.stringify(scope)} (allowed: ${SCOPES.join('|')})`);
  }
  if (!PLUGIN_NAMES.includes(plugin)) {
    throw new TypeError(`unknown plugin ${JSON.stringify(plugin)} (allowed: ${PLUGIN_NAMES.join('|')})`);
  }
  if (scope === 'plugin') return null;
  if (scope === 'phase') {
    if (plugin !== 'artibot') throw new TypeError(`phase overrides exist only for plugin "artibot", not ${JSON.stringify(plugin)}`);
    if (!PHASE_KEYS.includes(key)) throw new TypeError(`unknown phase ${JSON.stringify(key)} (allowed: ${PHASE_KEYS.join('|')})`);
    return key;
  }
  const agent = typeof key === 'string' ? key.trim().toLowerCase() : '';
  if (!AGENT_KEY_PATTERN.test(agent)) {
    throw new TypeError(`agent key ${JSON.stringify(key)} must be a bare agent name (no plugin prefix)`);
  }
  return agent;
}

/**
 * Return a NEW document with one override set. Never mutates `overrides`.
 *
 * @param {object|null} overrides - Current document (null = empty).
 * @param {{ scope: 'agent'|'phase'|'plugin', plugin: string, key?: string, tier: string, config?: object }} target
 *   `config` is the shipped config; fable is accepted only when it is given and
 *   its kill-switch is on.
 * @returns {object}
 * @throws {TypeError} Unknown scope/plugin/phase, malformed agent key, disallowed
 *   tier, or fable on a denylisted agent.
 */
export function setOverride(overrides, { scope, plugin, key, tier, config } = {}) {
  const target = checkTarget(scope, plugin, key);
  const allowed = allowedTiersFor(config);
  if (typeof tier !== 'string' || !allowed.includes(tier)) {
    throw new TypeError(`tier ${JSON.stringify(tier)} is not one of ${allowed.join('|')}`);
  }
  if (scope === 'agent' && tier === 'fable' && isDenylisted(target)) {
    throw new TypeError(`${target} is on FABLE_DENYLIST and can never run on fable`);
  }
  const out = cloneOverrides(overrides);
  const block = out.plugins[plugin];
  if (scope === 'plugin') block.default = tier;
  else if (scope === 'phase') block.phaseRoles = { ...block.phaseRoles, [target]: tier };
  else block.agents = { ...block.agents, [target]: tier };
  return out;
}

/**
 * Return a NEW document with one override removed. Never mutates `overrides`.
 * Clearing something that is not set is a no-op copy.
 *
 * @param {object|null} overrides
 * @param {{ scope: 'agent'|'phase'|'plugin', plugin: string, key?: string }} target
 * @returns {object}
 * @throws {TypeError} Unknown scope/plugin/phase or malformed agent key.
 */
export function clearOverride(overrides, { scope, plugin, key } = {}) {
  const target = checkTarget(scope, plugin, key);
  const out = cloneOverrides(overrides);
  const block = out.plugins[plugin];
  if (scope === 'plugin') {
    block.default = null;
    return out;
  }
  const field = scope === 'phase' ? 'phaseRoles' : 'agents';
  block[field] = Object.fromEntries(Object.entries(block[field]).filter(([k]) => k !== target));
  return out;
}

/**
 * A document with every override removed.
 *
 * @returns {object}
 */
export function clearAll() {
  return emptyOverrides();
}

/**
 * Own-property tier lookup in a possibly-missing map. Anything that is not
 * exactly a tier word ('FABLE', 'Opus', 'deep-async', 42, ...) reads as unset,
 * so an unvalidated injected document can never smuggle a value past
 * {@link applyGates}.
 *
 * @param {*} map
 * @param {string} key
 * @returns {string|null}
 */
function lookupTier(map, key) {
  if (!isPlainObject(map) || !Object.hasOwn(map, key)) return null;
  return isTierWord(map[key]) ? map[key] : null;
}

/**
 * Phase key (`build`/`review`) for a role, or null.
 *
 * @param {*} role
 * @returns {string|null}
 */
function phaseKeyFor(role) {
  if (typeof role !== 'string') return null;
  if (BUILD_ROLES.has(role)) return 'build';
  if (REVIEW_ROLES.has(role)) return 'review';
  return null;
}

/**
 * The user's pick for one agent, most specific first, or null. A layer whose
 * value is not a tier word is skipped and the next layer is tried.
 *
 * @param {object|null} overrides
 * @param {string} plugin
 * @param {string} agent
 * @param {object} opts
 * @returns {{ model: string, source: string, scope: string }|null}
 */
function pickOverride(overrides, plugin, agent, opts) {
  const block = isPlainObject(overrides?.plugins) ? overrides.plugins[plugin] : null;
  if (!isPlainObject(block)) return null;
  const byAgent = lookupTier(block.agents, agent);
  if (byAgent !== null) return { model: byAgent, source: 'override-agent', scope: 'agent' };
  if (plugin === 'artibot') {
    const phase = phaseKeyFor(opts.role);
    const byPhase = phase === null ? null : lookupTier(block.phaseRoles, phase);
    if (byPhase !== null) return { model: byPhase, source: 'override-phase', scope: 'phase' };
  }
  if (isTierWord(block.default)) return { model: block.default, source: 'override-plugin', scope: 'plugin' };
  return null;
}

/**
 * Apply the fable gate and the denylist to a picked tier. Runs LAST, so no
 * user setting gets past it. The fable allowlist names core agents only, so a
 * cowork agent is never fable-allowed.
 *
 * @param {string|null} model
 * @param {string} plugin
 * @param {string} agent
 * @param {object} [config]
 * @returns {{ model: string|null, reason: string|null }}
 */
function applyGates(model, plugin, agent, config) {
  if (model !== 'fable') return { model, reason: null };
  if (isDenylisted(agent)) return { model: FABLE_FALLBACK, reason: 'denylist' };
  const allowed = plugin === 'artibot' && isFableAllowed(agent, config);
  return allowed ? { model, reason: null } : { model: FABLE_FALLBACK, reason: 'fable-gate' };
}

/**
 * Effective model for one spawn, counting the user's overrides.
 *
 * Precedence: user agent > user phase (artibot only; `opts.role` mapped via
 * BUILD_ROLES / REVIEW_ROLES) > user plugin default > shipped. Shipped for
 * artibot is `resolveModel(qualifiedName, opts, config)` unchanged; shipped for
 * artibot-cowork is its frontmatter value, never the core policy. The fable gate
 * and FABLE_DENYLIST are applied last.
 *
 * A bare name is treated as `artibot:<name>`. On the artibot side, names the
 * catalog reads as a role alias or tier (`deep-async`, `opus`) and names
 * {@link qualifyAgent} rejects skip the overrides and go to `resolveModel`
 * as-is. On the cowork side there is no such fast path: every
 * `artibot-cowork:` name — alias-shaped or unparseable included — is answered
 * from the cowork layers only, never from the core policy. Override values
 * and frontmatter values that are not exactly a tier word are ignored.
 * `overrides === null` (e.g. a malformed file) means shipped; the caller
 * warns. Never throws on well-typed input.
 *
 * @param {string} qualifiedName - `artibot:x`, `artibot-cowork:x` or bare `x`.
 * @param {object} [opts] - Same options as `resolveModel` (`role`, `advisor`, `agentType`).
 * @param {{ config?: object, overrides?: object|null, coworkFrontmatter?: Record<string,string>|null }} [ctx]
 * @returns {{ model: string|null, source: string, reason: string|null, requested: string|null, scope: string|null }}
 *   `source` ∈ override-agent | override-phase | override-plugin | shipped |
 *   cowork-frontmatter | cowork-frontmatter-unknown; `reason` ∈ null |
 *   fable-gate | denylist; `requested` = the picked value before the gates
 *   (override or cowork frontmatter; null for shipped/unknown); `scope` ∈
 *   agent | phase | plugin | null (null unless an override was picked).
 */
export function resolveEffectiveModel(qualifiedName, opts = {}, { config, overrides = null, coworkFrontmatter = null } = {}) {
  const options = isPlainObject(opts) ? opts : {};
  const q = qualifyAgent(qualifiedName);
  const plugin = q === null ? pluginOfUnparsed(qualifiedName) : (q.plugin ?? 'artibot');
  if (plugin === 'artibot' && (q === null || resolveRole(q.agent) !== null)) {
    return shippedResult(resolveModel(qualifiedName, opts, config));
  }
  if (q === null) return { ...UNKNOWN_COWORK };
  const picked = pickOverride(overrides, plugin, q.agent, options);
  if (picked !== null) {
    const gated = applyGates(picked.model, plugin, q.agent, config);
    return { ...gated, source: picked.source, requested: picked.model, scope: picked.scope };
  }
  if (plugin === 'artibot') return shippedResult(resolveModel(qualifiedName, opts, config));
  const shipped = lookupTier(coworkFrontmatter, q.agent);
  if (shipped === null) return { ...UNKNOWN_COWORK };
  const gated = applyGates(shipped, plugin, q.agent, config);
  return { ...gated, source: 'cowork-frontmatter', requested: shipped, scope: null };
}

/** Result for a cowork agent whose shipped value is not known. */
const UNKNOWN_COWORK = Object.freeze({
  model: null,
  source: 'cowork-frontmatter-unknown',
  reason: null,
  requested: null,
  scope: null,
});

/**
 * @param {string} model - The unchanged `resolveModel` answer.
 * @returns {{ model: string, source: 'shipped', reason: null, requested: null, scope: null }}
 */
function shippedResult(model) {
  return { model, source: 'shipped', reason: null, requested: null, scope: null };
}

/**
 * Plugin of a name {@link qualifyAgent} rejected: `artibot-cowork` when it
 * carries that prefix (so it never reaches the core policy), else `artibot`.
 *
 * @param {*} name
 * @returns {'artibot'|'artibot-cowork'}
 */
function pluginOfUnparsed(name) {
  return typeof name === 'string' && name.trim().startsWith('artibot-cowork:') ? 'artibot-cowork' : 'artibot';
}
