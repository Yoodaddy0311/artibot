/**
 * Model catalog — the single source of truth for Claude model SPECS.
 *
 * Where `model-policy.js` answers "which model for agent X" (reads
 * `artibot.config.json`), this module answers "what ARE the models" — their
 * IDs, prices, context/output limits, tokenizer coefficients, and behavioral
 * constraints. It is a pure data module: no config, no I/O, no other lib
 * imports. Docs (`scripts/gen-model-catalog-docs.js`) and any cost/budget math
 * derive from here so the numbers live in exactly one place.
 *
 * Design constraints (mirror lib/core/model-policy.js):
 *   - Zero deps; imports NO other lib module (one-way: nothing flows in)
 *   - Pure lookup logic, no side effects, no console output
 *   - Never throws: returns a safe null/1.0/[] on any bad input
 *   - Immutable: every exported object is deep-frozen
 *   - Functions < 50 lines, file < 800 lines
 *
 * @module lib/core/model-catalog
 */

/**
 * Recursively freeze an object and all nested objects/arrays so the catalog is
 * tamper-proof at runtime (callers can read but never mutate the source data).
 *
 * @param {*} obj - Value to deep-freeze (non-objects pass through).
 * @returns {*} The same reference, now deeply frozen.
 */
function deepFreeze(obj) {
  if (obj === null || typeof obj !== 'object' || Object.isFrozen(obj)) {
    return obj;
  }
  for (const value of Object.values(obj)) {
    deepFreeze(value);
  }
  return Object.freeze(obj);
}

/** Reference tier all cost factors are measured against. */
export const BASELINE_TIER = 'opus';

/**
 * Version stamp of the catalog DATA below (IDs, prices, limits, coefficients).
 * Emitted alongside routing/cost records so a stored decision can be replayed
 * against the exact price table that produced it — without it, a later price
 * edit silently rewrites the meaning of every past record.
 *
 * Date-shaped (`YYYY-MM-DD`), not semver: it marks *when the numbers were last
 * verified*, which is the question a replay actually asks. Bump it in the same
 * commit that changes any value inside {@link MODELS}; leaving it stale is
 * worse than having no stamp, because consumers trust it.
 *
 * Producer only — no consumer reads it as of 2026-09-02 (the routing/economics
 * modules that will emit it are not written yet). Do not infer from its
 * presence that any record currently carries a catalog version.
 *
 * @type {string}
 */
export const CATALOG_VERSION = '2026-09-02';

/**
 * Model specs keyed by Artibot tier alias. These are the tier enums the Claude
 * Code Agent/Task `model` parameter accepts (`sonnet|opus|haiku|fable`), each
 * mapped to its current underlying model ID and verified specs.
 *
 * @type {Readonly<Record<string, Readonly<{
 *   id: string,
 *   priceInPerMTok: number,
 *   priceOutPerMTok: number,
 *   tokenizerCoeff: number,
 *   ctxLimit: number,
 *   outLimit: number,
 *   thinkingMode: 'adaptive'|'always-on',
 *   promptStyle: 'prescriptive'|'declarative',
 *   constraints: readonly string[]
 * }>>>}
 */
export const MODELS = deepFreeze({
  haiku: {
    id: 'claude-haiku-4-5',
    priceInPerMTok: 1,
    priceOutPerMTok: 5,
    tokenizerCoeff: 1.0,
    ctxLimit: 200_000,
    outLimit: 64_000,
    thinkingMode: 'adaptive',
    promptStyle: 'prescriptive',
    constraints: [],
  },
  sonnet: {
    id: 'claude-sonnet-4-6',
    priceInPerMTok: 3,
    priceOutPerMTok: 15,
    tokenizerCoeff: 1.0,
    ctxLimit: 1_000_000,
    outLimit: 64_000,
    thinkingMode: 'adaptive',
    promptStyle: 'prescriptive',
    constraints: [],
  },
  opus: {
    id: 'claude-opus-5',
    priceInPerMTok: 5,
    priceOutPerMTok: 25,
    tokenizerCoeff: 1.0,
    ctxLimit: 1_000_000,
    outLimit: 128_000,
    thinkingMode: 'adaptive',
    promptStyle: 'prescriptive',
    constraints: [],
  },
  fable: {
    id: 'claude-fable-5-1',
    priceInPerMTok: 10,
    priceOutPerMTok: 50,
    tokenizerCoeff: 1.3,
    ctxLimit: 1_000_000,
    outLimit: 128_000,
    thinkingMode: 'always-on',
    promptStyle: 'declarative',
    constraints: [
      'refusal-classifier',
      'no-prefill',
      'retention-30d',
      'task-budget-min-20k',
      'opt-in-only',
    ],
  },
});

/**
 * Human-facing role names → tier aliases. Lets callers ask for a capability
 * ("frontier", "fast") without hardcoding which model currently fills it.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const ROLE_ALIASES = deepFreeze({
  frontier: 'opus',
  'deep-async': 'fable',
  balanced: 'sonnet',
  fast: 'haiku',
});

/**
 * Look up the full spec for a tier. Never throws.
 *
 * @param {string} tier - Tier alias ('sonnet'|'opus'|'haiku'|'fable').
 * @returns {Readonly<object>|null} Frozen model spec, or null if unknown.
 *
 * @example
 * getModel('fable').id; // 'claude-fable-5-1'
 * getModel('mystery'); // null
 */
export function getModel(tier) {
  if (typeof tier !== 'string') return null;
  return Object.prototype.hasOwnProperty.call(MODELS, tier)
    ? MODELS[tier]
    : null;
}

/**
 * Resolve a role alias OR a raw tier to a tier key. Returns null for unknown or
 * non-string input (never throws) so callers can fall back safely.
 *
 * @param {string} roleOrTier - A ROLE_ALIASES key or a tier key.
 * @returns {string|null} Tier key, or null if unresolvable.
 *
 * @example
 * resolveRole('frontier'); // 'opus'
 * resolveRole('fable'); // 'fable'  (already a tier)
 * resolveRole('nope'); // null
 */
export function resolveRole(roleOrTier) {
  if (typeof roleOrTier !== 'string') return null;
  if (Object.prototype.hasOwnProperty.call(ROLE_ALIASES, roleOrTier)) {
    return ROLE_ALIASES[roleOrTier];
  }
  if (Object.prototype.hasOwnProperty.call(MODELS, roleOrTier)) {
    return roleOrTier;
  }
  return null;
}

/**
 * List every known tier key.
 *
 * @returns {string[]} A fresh array of tier keys (caller may mutate freely).
 *
 * @example
 * listTiers(); // ['haiku', 'sonnet', 'opus', 'fable']
 */
export function listTiers() {
  return Object.keys(MODELS);
}

/**
 * Tokenizer coefficient for a tier (tokens-per-content relative to baseline).
 * Unknown tiers return 1.0 so budget math degrades safely.
 *
 * @param {string} tier - Tier alias.
 * @returns {number} Coefficient (>= 1.0); 1.0 for unknown tiers.
 *
 * @example
 * getTokenizerCoeff('fable'); // 1.3
 * getTokenizerCoeff('opus'); // 1.0
 * getTokenizerCoeff('???'); // 1.0
 */
export function getTokenizerCoeff(tier) {
  const model = getModel(tier);
  return model ? model.tokenizerCoeff : 1.0;
}

/**
 * Effective cost factor of a tier relative to the baseline (Opus 4.8): the
 * input-price ratio multiplied by the tokenizer coefficient (more tokens per
 * unit of content = more spend even at the same per-token price). Unknown tiers
 * and a missing/invalid baseline return 1.0.
 *
 * @param {string} tier - Tier alias.
 * @returns {number} Cost factor; e.g. fable = (10/5) * 1.3 = 2.6.
 *
 * @example
 * getCostFactor('fable'); // 2.6
 * getCostFactor('opus'); // 1
 * getCostFactor('unknown'); // 1.0
 */
export function getCostFactor(tier) {
  const model = getModel(tier);
  const baseline = getModel(BASELINE_TIER);
  if (!model || !baseline || !(baseline.priceInPerMTok > 0)) return 1.0;
  return (model.priceInPerMTok / baseline.priceInPerMTok) * model.tokenizerCoeff;
}
