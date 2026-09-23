/**
 * Model catalog — the single source of truth for Claude model SPECS **and
 * PRICES**.
 *
 * Where `model-policy.js` answers "which model for agent X" (reads
 * `artibot.config.json`), this module answers "what ARE the models" — their
 * IDs, prices, context/output limits, tokenizer coefficients, and behavioral
 * constraints. It is a pure data module: no config, no I/O, no other lib
 * imports. Docs (`scripts/gen-model-catalog-docs.js`) and any cost/budget math
 * derive from here so the numbers live in exactly one place.
 *
 * Price readers (no second price table may exist anywhere else):
 *   - `lib/runtime/middleware/cache-roi.js` — cache read/write break-even math
 *   - `lib/economics/usage-receipt.js` — per-call cost stamped onto receipts
 * Routing readers (specs + cost factor, not the cache columns):
 *   - `lib/routing/route-scorer.js`
 *   - `lib/routing/route-hysteresis.js`
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
 * Version stamp of the catalog DATA below (IDs, limits, coefficients,
 * constraints). The PRICE columns are stamped separately by
 * {@link PRICING_VERSION} — this stamp does not claim to cover them.
 * Emitted alongside routing/cost records so a stored decision can be replayed
 * against the exact catalog that produced it — without it, a later spec edit
 * silently rewrites the meaning of every past record.
 *
 * Date-shaped (`YYYY-MM-DD`), not semver: it marks *when the numbers were last
 * verified*, which is the question a replay actually asks. Bump it in the same
 * commit that changes any non-price value inside {@link MODELS}; leaving it
 * stale is worse than having no stamp, because consumers trust it.
 *
 * Consumers (grep of `lib/`, 2026-09-23): `lib/economics/usage-receipt.js`
 * stamps it as `model_identity.catalog_version` on every receipt, and
 * `lib/routing/route-scorer.js#DEFAULT_CATALOG` carries it as `version`.
 *
 * 2026-09-23 bump: opus `id` moved to `claude-opus-5-5` and every tier gained
 * `legacyIds`. No price changed, so {@link PRICING_VERSION} did not move.
 *
 * @type {string}
 */
export const CATALOG_VERSION = '2026-09-23';

/**
 * Version stamp of the PRICE COLUMNS ONLY — `priceInPerMTok`,
 * `priceOutPerMTok`, and the three `priceCache*PerMTok` fields. Those five
 * numbers were verified against {@link PRICING_SOURCE} on this date.
 *
 * Deliberately separate from {@link CATALOG_VERSION}: that stamp covers the
 * whole catalog (IDs, limits, coefficients, constraints), so folding prices
 * into it would make every unrelated limit edit claim "prices re-verified".
 * A cost record needs to know when the PRICE it used was last checked.
 *
 * Date-shaped (`YYYY-MM-DD`), not semver — it answers "when were the numbers
 * last verified", which is the question a replayed cost record actually asks.
 * **Bump it in the same commit as any price change.** A stale stamp is worse
 * than no stamp, because consumers trust it. Nothing machine-enforces that
 * coupling today (see `tests/core/model-catalog-version.test.js` header).
 *
 * @type {string}
 */
export const PRICING_VERSION = '2026-09-12';

/**
 * Where the price columns came from: the official Anthropic pricing page.
 *
 * **Scheme-less on purpose.** `tests/ci/data-policy-outbound-guard.test.js`
 * scans this file's raw source and fails it on any `http`/`https` URL literal
 * anywhere — comments included — to enforce the Artibot DATA POLICY (model
 * economy modules are pure local computation, no outbound anything). So the
 * source is cited as a bare path; never add a scheme to this string or write
 * one in any comment in this file.
 *
 * @type {string}
 */
export const PRICING_SOURCE =
  'platform.claude.com/docs/en/about-claude/pricing';

/**
 * Model specs keyed by Artibot tier alias. These are the tier enums the Claude
 * Code Agent/Task `model` parameter accepts (`sonnet|opus|haiku|fable`), each
 * mapped to its current underlying model ID and verified specs.
 *
 * **Cache prices are stored as literals, never derived.** The official page
 * footnotes that cache hits and refreshes on Claude Fable 5.1 are priced at
 * 0.025x the base input price while all other models use the standard 0.1x
 * multiplier — so a single "10% of input" rule would overcharge fable cache
 * reads by 4x. Write-price multipliers (1.25x for the 5-minute TTL, 2x for the
 * 1-hour TTL) are uniform today, but they are pinned as literals too so a
 * future per-model exception lands as a value edit, not a formula rewrite.
 *
 * Two measurement flags travel with the data so consumers can tell a verified
 * number from an estimate: `priceMeasured` (the five price columns, checked
 * against {@link PRICING_SOURCE} on {@link PRICING_VERSION}) and
 * `tokenizerCoeffMeasured` (see {@link getCostFactor} — currently false).
 *
 * `legacyIds` lists older model ids that must still resolve to the tier, so a
 * transcript or ledger row written before an id change keeps its tier instead
 * of falling to "unknown model". It is present on EVERY tier (`[]` when there
 * is none) so the frozen shape is the same everywhere and readers never branch
 * on a missing key. It is an exact-string list, not a prefix rule. `id` stays
 * the one current id: {@link getPricing} reports `id`, never a legacy one. No
 * id may appear twice across all tiers' `id` + `legacyIds` (pinned in
 * `tests/core/model-catalog.test.js`).
 *
 * @type {Readonly<Record<string, Readonly<{
 *   id: string,
 *   legacyIds: readonly string[],
 *   priceInPerMTok: number,
 *   priceOutPerMTok: number,
 *   priceCacheReadPerMTok: number,
 *   priceCacheWrite5mPerMTok: number,
 *   priceCacheWrite1hPerMTok: number,
 *   priceMeasured: boolean,
 *   tokenizerCoeff: number,
 *   tokenizerCoeffMeasured: boolean,
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
    legacyIds: [],
    priceInPerMTok: 1,
    priceOutPerMTok: 5,
    priceCacheReadPerMTok: 0.1,
    priceCacheWrite5mPerMTok: 1.25,
    priceCacheWrite1hPerMTok: 2,
    priceMeasured: true,
    tokenizerCoeff: 1.0,
    tokenizerCoeffMeasured: false,
    ctxLimit: 200_000,
    outLimit: 64_000,
    thinkingMode: 'adaptive',
    promptStyle: 'prescriptive',
    constraints: [],
  },
  sonnet: {
    // 2026-09-15 O2: id 갱신, 가격 계수는 미검증(I1).
    id: 'claude-sonnet-5',
    legacyIds: [],
    priceInPerMTok: 3,
    priceOutPerMTok: 15,
    priceCacheReadPerMTok: 0.3,
    priceCacheWrite5mPerMTok: 3.75,
    priceCacheWrite1hPerMTok: 6,
    priceMeasured: true,
    tokenizerCoeff: 1.0,
    tokenizerCoeffMeasured: false,
    ctxLimit: 1_000_000,
    outLimit: 64_000,
    thinkingMode: 'adaptive',
    promptStyle: 'prescriptive',
    constraints: [],
  },
  opus: {
    // 2026-09-23: id moved to Opus 5.5; claude-opus-5 stays resolvable as a
    // legacy id so pre-switch transcripts keep tier opus.
    id: 'claude-opus-5-5',
    legacyIds: ['claude-opus-5'],
    // Prices below are the claude-opus-5 row, NOT Opus 5.5's. Opus 5.5 official
    // is $4 in / $20 out, cache read $0.20 per MTok (claude-api skill cached
    // table, 2026-06-24) — deliberately not applied here. opus is BASELINE_TIER,
    // so moving its input price would shift every getCostFactor at once.
    // Deferred to follow-up limb catalog-pricing-sync, together with the
    // sonnet row (Sonnet 5 there is $2 / $10 vs this catalog's 3 / 15).
    priceInPerMTok: 5,
    priceOutPerMTok: 25,
    priceCacheReadPerMTok: 0.5,
    priceCacheWrite5mPerMTok: 6.25,
    priceCacheWrite1hPerMTok: 10,
    priceMeasured: true,
    tokenizerCoeff: 1.0,
    tokenizerCoeffMeasured: false,
    ctxLimit: 1_000_000,
    outLimit: 128_000,
    thinkingMode: 'adaptive',
    promptStyle: 'prescriptive',
    constraints: [],
  },
  fable: {
    id: 'claude-fable-5-1',
    legacyIds: [],
    priceInPerMTok: 10,
    priceOutPerMTok: 50,
    // 0.025x input, NOT the 0.1x every other tier uses — official footnote.
    priceCacheReadPerMTok: 0.25,
    priceCacheWrite5mPerMTok: 12.5,
    priceCacheWrite1hPerMTok: 20,
    priceMeasured: true,
    tokenizerCoeff: 1.3,
    tokenizerCoeffMeasured: false,
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
 * Per-MTok pricing for a role or tier, in one flat shape for cost math. The
 * single lookup every price consumer should use — reading `MODELS[tier]`
 * fields directly spreads the field names across modules.
 *
 * Resolves through {@link resolveRole}, so `'frontier'` and `'opus'` both
 * work. Returns null (never throws) for unknown or non-string input.
 *
 * @param {string} roleOrTier - A ROLE_ALIASES key or a tier key.
 * @returns {Readonly<{
 *   tier: string, id: string, input: number, output: number,
 *   cacheRead: number, cacheWrite5m: number, cacheWrite1h: number,
 *   measured: boolean, version: string
 * }>|null} Frozen pricing record, or null if unresolvable.
 *
 * @example
 * getPricing('frontier'); // { tier: 'opus', input: 5, cacheRead: 0.5, ... }
 * getPricing('nope'); // null
 */
export function getPricing(roleOrTier) {
  const tier = resolveRole(roleOrTier);
  const spec = getModel(tier);
  if (!spec) return null;
  return Object.freeze({
    tier,
    id: spec.id,
    input: spec.priceInPerMTok,
    output: spec.priceOutPerMTok,
    cacheRead: spec.priceCacheReadPerMTok,
    cacheWrite5m: spec.priceCacheWrite5mPerMTok,
    cacheWrite1h: spec.priceCacheWrite1hPerMTok,
    measured: spec.priceMeasured,
    version: PRICING_VERSION,
  });
}

/**
 * Effective cost factor of a tier relative to the baseline
 * `MODELS[BASELINE_TIER]` (the `opus` tier — its id is `claude-opus-5-5` since
 * 2026-09-23, but its price row is still the `claude-opus-5` one; see the
 * note on `MODELS.opus`): the input-price ratio multiplied
 * by the tokenizer coefficient (more tokens per unit of content = more spend
 * even at the same per-token price). Unknown tiers and a missing/invalid
 * baseline return 1.0.
 *
 * **The factor is UNMEASURED while `tokenizerCoeffMeasured` is false on the
 * tiers involved — which is every tier today.** The price ratio half is
 * verified; the tokenizer half is not. The official pricing page states that
 * Claude 4.7 and later models use a newer tokenizer producing roughly 30% more
 * tokens, while Sonnet 4.6 and earlier use the previous one — so the baseline
 * `opus` (claude-opus-5-5) and `fable` (claude-fable-5-1) are on the SAME
 * tokenizer, which makes the shipped `fable: 1.3` relative to opus an
 * unverified carry-over and the resulting 2.6 an estimate, not a measurement.
 * Changing the coefficient (and therefore this factor) is an owner decision
 * pending a real token-count measurement; this note flags it only.
 *
 * @param {string} tier - Tier alias.
 * @returns {number} Cost factor; e.g. fable = (10/5) * 1.3 = 2.6 (estimate).
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
