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
 * Price readers (no second table of CURRENT prices may exist anywhere else):
 *   - `lib/runtime/middleware/cache-roi.js` — cache read/write break-even math
 *   - `lib/economics/usage-receipt.js` — per-call cost stamped onto receipts
 *   - `lib/core/pricing-history.js` — rows of PAST {@link PRICING_VERSION}
 *     stamps, frozen from git; its current row is read from here
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
 * 2026-09-28 bump: opus `thinkingMode` moved from `adaptive` to `always-on`
 * (Opus 5.5 thinking cannot be disabled). Prices changed the same day and are
 * stamped separately by {@link PRICING_VERSION}. Same day, same stamp: haiku
 * `thinkingMode` moved to `extended` (budget_tokens only, no adaptive) and
 * sonnet `outLimit` moved from 64_000 to 128_000, both per the claude-api skill.
 *
 * 2026-09-29 bump: sonnet `id` moved to `claude-sonnet-5-5`, the id the host
 * serves, and `claude-sonnet-5` became its legacy id - the move opus made on
 * 2026-09-23. The first edit of that day only listed `claude-sonnet-5-5` as a
 * legacy id and left this stamp alone; this bump covers both. No price
 * changed (the Sonnet 5.5 input / output / cache read figures equal Sonnet
 * 5's), so {@link PRICING_VERSION} did not move.
 *
 * @type {string}
 */
export const CATALOG_VERSION = '2026-09-29';

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
 * than no stamp, because consumers trust it. `tests/core/pricing-history.test.js`
 * enforces the coupling: a bump without a `lib/core/pricing-history.js` entry,
 * or a price edit that keeps the stamp, goes red there (limits in that file's
 * header).
 *
 * 2026-09-28 bump: opus and sonnet rows moved to the Opus 5.5 / Sonnet 5
 * official prices (read off {@link PRICING_SOURCE} that day). haiku and fable
 * were re-read the same day and already matched, so their values did not move.
 * The same read added the per-id row in {@link ID_PRICES} (Claude Opus 5).
 * {@link CATALOG_VERSION} moved that day too, for a non-price edit of its own.
 *
 * 2026-09-29, NO bump: the sonnet tier id moved to Sonnet 5.5. Its input,
 * output and cache-read figures were compared with the claude-api skill price
 * table (cached 2026-09-25, not {@link PRICING_SOURCE}) and equal the Sonnet 5
 * row, so no price moved. That table lists no cache-write prices, so the sonnet
 * row's 2.5 / 4 stay the standard 1.25x / 2x of input and were not read for 5.5.
 *
 * @type {string}
 */
export const PRICING_VERSION = '2026-09-28';

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
 * footnotes two cache-read exceptions: Claude Fable 5.1 is priced at 0.025x
 * the base input price, and Claude Opus 5.5 at 0.05x; the other catalog
 * models use the standard 0.1x multiplier. A single "10% of input" rule would
 * overcharge fable cache reads by 4x and opus cache reads by 2x. Write-price
 * multipliers (1.25x for the 5-minute TTL, 2x for the 1-hour TTL) are uniform
 * today, but they are pinned as literals too so a future per-model exception
 * lands as a value edit, not a formula rewrite.
 *
 * Two measurement flags travel with the data so consumers can tell a verified
 * number from an estimate: `priceMeasured` (true = all five price columns of
 * that row were compared against {@link PRICING_SOURCE} on
 * {@link PRICING_VERSION} and match it) and `tokenizerCoeffMeasured` (see
 * {@link getCostFactor} — currently false).
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
 * `thinkingMode` names the request shape a tier accepts: `adaptive` =
 * `{type:'adaptive'}` and thinking can be disabled; `always-on` = adaptive
 * only, disabling and `budget_tokens` are rejected; `extended` =
 * `{type:'enabled', budget_tokens}` only, no adaptive. The set is pinned in
 * `tests/core/model-catalog.test.js`.
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
 *   thinkingMode: 'adaptive'|'always-on'|'extended',
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
    // Haiku 4.5 has no adaptive thinking: {type:'enabled', budget_tokens} only
    // (claude-api skill, Thinking & Effort).
    thinkingMode: 'extended',
    promptStyle: 'prescriptive',
    constraints: [],
  },
  sonnet: {
    // 2026-09-29: id moved to Sonnet 5.5, the id the host serves for this tier
    // (it was `claude-sonnet-5` since 2026-09-15, O2). Until the catalog knew
    // it, every such transcript entry was tallied as an unresolved model and
    // dropped (live: session.ended 8ce16014), so sonnet usage never reached
    // the ledger. claude-sonnet-5 stays resolvable as a legacy id so pre-switch
    // transcripts and ledger rows keep tier sonnet.
    id: 'claude-sonnet-5-5',
    legacyIds: ['claude-sonnet-5'],
    // Where the price columns come from. Sonnet 5 official pricing page row,
    // fetched 2026-09-28 KST: the page footnotes $2 / $10 as the confirmed
    // standard price (the increase that had been scheduled for 9/1 was
    // cancelled); cache read is the standard 0.1x of input.
    // Sonnet 5.5: input $2 / output $10 / cache read $0.20 per MTok are the
    // claude-api skill price table (cached 2026-09-25) - identical to Sonnet 5,
    // so this one row prices both ids and claude-sonnet-5 needs no ID_PRICES
    // row (a pin in tests/core/model-catalog.test.js goes red if the two ever
    // differ). That table does not list cache writes: 2.5 / 4 are the standard
    // 1.25x / 2x multiples of input, derived and not read for 5.5.
    // `priceMeasured` therefore means: compared with PRICING_SOURCE for Sonnet
    // 5, and with the skill table (not the page) for Sonnet 5.5.
    priceInPerMTok: 2,
    priceOutPerMTok: 10,
    priceCacheReadPerMTok: 0.2,
    priceCacheWrite5mPerMTok: 2.5,
    priceCacheWrite1hPerMTok: 4,
    priceMeasured: true,
    tokenizerCoeff: 1.0,
    tokenizerCoeffMeasured: false,
    // ctxLimit, outLimit, thinkingMode and promptStyle are the values the
    // catalog carried for Sonnet 5 (outLimit per the claude-api skill,
    // 2026-09-28). They were carried over when the id moved to 5.5; nobody
    // re-read them for 5.5.
    ctxLimit: 1_000_000,
    // 128K max output (claude-api skill shared/models.md, Sonnet 5 row).
    outLimit: 128_000,
    thinkingMode: 'adaptive',
    promptStyle: 'prescriptive',
    constraints: [],
  },
  opus: {
    // 2026-09-23: id moved to Opus 5.5; claude-opus-5 stays resolvable as a
    // legacy id so pre-switch transcripts keep tier opus.
    id: 'claude-opus-5-5',
    legacyIds: ['claude-opus-5'],
    // Opus 5.5 official pricing page row, fetched 2026-09-28 KST (replaces
    // the claude-opus-5 row 5 / 25 / 0.5 / 6.25 / 10). opus is BASELINE_TIER,
    // so this input price is the divisor of every getCostFactor.
    priceInPerMTok: 4,
    priceOutPerMTok: 20,
    // 0.05x input, NOT the standard 0.1x — official footnote.
    priceCacheReadPerMTok: 0.2,
    priceCacheWrite5mPerMTok: 5,
    priceCacheWrite1hPerMTok: 8,
    priceMeasured: true,
    tokenizerCoeff: 1.0,
    tokenizerCoeffMeasured: false,
    ctxLimit: 1_000_000,
    outLimit: 128_000,
    // Opus 5.5: thinking cannot be disabled — {type:'disabled'} and
    // budget_tokens return 400 at every effort (claude-api skill, Migrating to
    // Claude Opus 5.5, cached 2026-06-24).
    thinkingMode: 'always-on',
    promptStyle: 'prescriptive',
    constraints: [],
  },
  fable: {
    id: 'claude-fable-5-1',
    legacyIds: [],
    priceInPerMTok: 10,
    priceOutPerMTok: 50,
    // 0.025x input, NOT the standard 0.1x (opus is the other exception, at
    // 0.05x) — official footnote.
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
 * Per-MODEL-ID price rows, for a legacy id whose official price differs from
 * the current row of the tier it resolves to. {@link getPricing} reads a row
 * here before the tier row, so a transcript line written against an older id
 * is billed at the price that id actually had — not at its successor's.
 *
 * Only PRICES live here. Which tier an id belongs to stays in
 * `MODELS[tier].legacyIds` (the tier resolution and its "no id in two tiers"
 * rule are untouched); every key here must be one of those legacy ids, never a
 * current `id` (that would be a second price for the tier's own row) and never
 * an id no tier resolves. Same five price columns and `priceMeasured` flag as
 * {@link MODELS}, same {@link PRICING_VERSION} stamp. Both rules are pinned in
 * `tests/core/model-catalog.test.js`.
 *
 * @type {Readonly<Record<string, Readonly<{
 *   priceInPerMTok: number,
 *   priceOutPerMTok: number,
 *   priceCacheReadPerMTok: number,
 *   priceCacheWrite5mPerMTok: number,
 *   priceCacheWrite1hPerMTok: number,
 *   priceMeasured: boolean
 * }>>>}
 */
export const ID_PRICES = deepFreeze({
  'claude-opus-5': {
    // Official pricing page row (Claude Opus 5), fetched 2026-09-28 KST. The
    // opus tier row moved to Opus 5.5 the same day; this id keeps its own.
    priceInPerMTok: 5,
    priceOutPerMTok: 25,
    priceCacheReadPerMTok: 0.5,
    priceCacheWrite5mPerMTok: 6.25,
    priceCacheWrite1hPerMTok: 10,
    priceMeasured: true,
  },
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
 * Tier of an exact model id — a tier's current `id` or one of its
 * `legacyIds`. Tier names and role aliases are NOT model ids and return null,
 * as do near-misses: there is no prefix, qualifier or case tolerance (callers
 * strip `[1m]` / snapshot suffixes themselves). Never throws.
 *
 * @param {string} modelId - Exact model id, e.g. 'claude-opus-5'.
 * @returns {string|null} Tier key, or null.
 *
 * @example
 * tierForModelId('claude-opus-5'); // 'opus'  (legacy id)
 * tierForModelId('opus'); // null  (a tier name, not an id)
 */
export function tierForModelId(modelId) {
  if (typeof modelId !== 'string' || modelId.length === 0) return null;
  for (const [tier, spec] of Object.entries(MODELS)) {
    if (spec.id === modelId || spec.legacyIds.includes(modelId)) return tier;
  }
  return null;
}

/**
 * Per-MTok pricing for a role, tier or model id, in one flat shape for cost
 * math. The single lookup every price consumer should use — reading
 * `MODELS[tier]` fields directly spreads the field names across modules.
 *
 * A role or tier resolves through {@link resolveRole} (`'frontier'` and
 * `'opus'` both work) and reports the tier's current `id`, exactly as before
 * per-id rows existed. A model id resolves through {@link tierForModelId}; it
 * prices at its own {@link ID_PRICES} row when it has one, else at its tier's
 * row, and `id` is the id that was asked for. Returns null (never throws) for
 * unknown or non-string input.
 *
 * @param {string} key - A ROLE_ALIASES key, a tier key, or an exact model id.
 * @returns {Readonly<{
 *   tier: string, id: string, input: number, output: number,
 *   cacheRead: number, cacheWrite5m: number, cacheWrite1h: number,
 *   measured: boolean, version: string
 * }>|null} Frozen pricing record, or null if unresolvable.
 *
 * @example
 * getPricing('frontier'); // { tier: 'opus', id: 'claude-opus-5-5', input: 4, cacheRead: 0.2, ... }
 * getPricing('claude-opus-5'); // { tier: 'opus', id: 'claude-opus-5', input: 5, cacheRead: 0.5, ... }
 * getPricing('nope'); // null
 */
export function getPricing(key) {
  const roleTier = resolveRole(key);
  const tier = roleTier ?? tierForModelId(key);
  const spec = getModel(tier);
  if (!spec) return null;
  const id = roleTier === null ? key : spec.id;
  const row = Object.prototype.hasOwnProperty.call(ID_PRICES, id) ? ID_PRICES[id] : spec;
  return Object.freeze({
    tier,
    id,
    input: row.priceInPerMTok,
    output: row.priceOutPerMTok,
    cacheRead: row.priceCacheReadPerMTok,
    cacheWrite5m: row.priceCacheWrite5mPerMTok,
    cacheWrite1h: row.priceCacheWrite1hPerMTok,
    measured: row.priceMeasured,
    version: PRICING_VERSION,
  });
}

/**
 * Effective cost factor of a tier relative to the baseline
 * `MODELS[BASELINE_TIER]` (the `opus` tier — `claude-opus-5-5`, priced at the
 * Opus 5.5 official row since {@link PRICING_VERSION} 2026-09-28): the
 * input-price ratio multiplied by the tokenizer coefficient (more tokens per
 * unit of content = more spend even at the same per-token price). Unknown
 * tiers and a missing/invalid baseline return 1.0.
 *
 * **The factor is UNMEASURED while `tokenizerCoeffMeasured` is false on the
 * tiers involved — which is every tier today.** The price ratio half is
 * verified; the tokenizer half is not. The official pricing page states that
 * Claude 4.7 and later models use a newer tokenizer producing roughly 30% more
 * tokens, while Sonnet 4.6 and earlier use the previous one — so the baseline
 * `opus` (claude-opus-5-5) and `fable` (claude-fable-5-1) are on the SAME
 * tokenizer, which makes the shipped `fable: 1.3` relative to opus an
 * unverified carry-over and the resulting 3.25 an estimate, not a measurement.
 * Changing the coefficient (and therefore this factor) is an owner decision
 * pending a real token-count measurement; this note flags it only.
 *
 * @param {string} tier - Tier alias.
 * @returns {number} Cost factor; e.g. fable = (10/4) * 1.3 = 3.25 (estimate).
 *
 * @example
 * getCostFactor('fable'); // 3.25
 * getCostFactor('sonnet'); // 0.5
 * getCostFactor('opus'); // 1
 * getCostFactor('unknown'); // 1.0
 */
export function getCostFactor(tier) {
  const model = getModel(tier);
  const baseline = getModel(BASELINE_TIER);
  if (!model || !baseline || !(baseline.priceInPerMTok > 0)) return 1.0;
  return (model.priceInPerMTok / baseline.priceInPerMTok) * model.tokenizerCoeff;
}
