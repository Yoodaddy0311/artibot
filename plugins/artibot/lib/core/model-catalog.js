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
 * 2026-09-30 bump: every row of {@link MODELS} and {@link ID_PRICES} gained
 * `priceSource` (kind, ref, checkedAt, derivedColumns) and {@link getPricing}
 * reports it as `source`. It is the provenance the notes in this file already
 * gave, written as data; no price was read or changed, so
 * {@link PRICING_VERSION} did not move.
 *
 * 2026-10-12 bump: the `priceSource` values changed with that day's re-read of
 * the official page, whose price edits are stamped separately by
 * {@link PRICING_VERSION}. The sonnet row went from `skill-table` to
 * `official-table` (its `ref` is now {@link PRICING_SOURCE}) and its
 * `derivedColumns` from the two cache-write columns to none, and `checkedAt` was
 * re-dated to 2026-10-12 on every row that was re-read. claude-sonnet-5 gained an
 * {@link ID_PRICES} row, which carries a `priceSource` of its own. That edit
 * changed no id, limit, coefficient or constraint; the one below did.
 *
 * 2026-10-12, same day and same stamp: the haiku tier moved from Claude Haiku 4.5
 * to Claude Haiku 5.5. Its `id` is now `claude-haiku-5-5` and `claude-haiku-4-5` its
 * legacy id (the move opus made on 2026-09-23 and sonnet on 2026-09-29); `ctxLimit`
 * went from 200_000 to 1_000_000, `outLimit` from 64_000 to 128_000 and
 * `thinkingMode` from `extended` to `adaptive`, all read off the models overview
 * and the thinking page that day (`{type:'enabled', budget_tokens}` now returns 400
 * on Haiku 5.5). Every row of {@link MODELS} and {@link ID_PRICES} gained
 * `priceMaxPromptTokens`, which {@link getPricing} reports as `maxPromptTokens`.
 * The stamp stayed. The commit that set it, 4980e43f, is in the release tag v4.71.7
 * (tag commit 3d0a4c0a): `git tag --contains 4980e43f` printed only `v4.71.7` on
 * 2026-10-13, where it had been empty on 2026-10-12 (latest tag then v4.71.6), and the
 * file at that tag carries the same stamp. Before the tag the commit had been on
 * origin/master, the branch the marketplace entry `./plugins/artibot` is installed
 * from, since the push of 2026-10-12 16:31 KST (the commit is dated 16:17), so an
 * install taken from master in that window, or a v4.71.7 install, could have stamped
 * records with it. A haiku receipt stamped that way names `claude-haiku-4-5`, which
 * the new {@link ID_PRICES} row replays at the price that billed it; a record that
 * names only the tier would replay at the new tier row (the residual, pinned in
 * `tests/core/pricing-history.test.js`). The price edits of this move are noted at
 * {@link PRICING_VERSION}.
 *
 * @type {string}
 */
export const CATALOG_VERSION = '2026-10-12';

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
 * **When you bump it, re-date only what you re-read.** Move a row's
 * `priceSource.checkedAt` to the new stamp ONLY for a row actually re-read against
 * its source that day; never copy the new date onto the rest. An `official-table`
 * row that was NOT re-read (a legacy {@link ID_PRICES} row included) cannot keep
 * `priceMeasured: true`, which means "compared against {@link PRICING_SOURCE} on
 * this stamp": set it to `false`. The receipt writer then leaves that model
 * unpriced and the usage table shows it as unverified, instead of a fresh stamp
 * vouching for a price nobody looked at. `tests/core/model-catalog.test.js`
 * ('priceSource') is red for a measured `official-table` row whose date is not the
 * stamp.
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
 * 2026-09-30, NO bump: `priceSource` was added to every price row. It records
 * where the figures came from, as the notes above and on the rows say; no figure
 * was re-read, so this stamp keeps the date of the last read.
 *
 * 2026-10-12 bump: every row was re-read off {@link PRICING_SOURCE} that day
 * (fetched 2026-10-12 KST), after one official change: the Claude Sonnet 5.5
 * cache read fell from $0.20 to $0.10 per MTok (0.05x input; announced in the
 * 2026-10-07 release note). The stamp is the day the page was read, not the day the
 * change took effect (2026-10-07), because `checkedAt` has to equal it. The haiku,
 * opus 5.5, claude-opus-5 and fable rows already matched. The page also lists the
 * Sonnet 5.5 cache writes (2.50 / 4), so the sonnet row reads them instead of
 * deriving them and is an `official-table` row with nothing derived.
 * claude-sonnet-5 keeps its $0.20 cache read: it got an {@link ID_PRICES} row so it
 * is not billed at its successor's rate. {@link CATALOG_VERSION} moved that day
 * too, for the `priceSource` edits of its own.
 *
 * 2026-10-12, same day and same stamp: the haiku tier row moved to Claude Haiku
 * 5.5, read off the two "Claude Haiku 5.5" rows of {@link PRICING_SOURCE} that day.
 * The row holds the "up to 100,000 tokens" prices, $0.10 in / $0.50 out, cache read
 * 0.01, cache writes 0.125 and 0.20; the over-100,000 list (0.50 / 2.50, 0.05, 0.625
 * and 1) is not stored, see the haiku row. claude-haiku-4-5 gained an
 * {@link ID_PRICES} row with the $1 / $5 / 0.10 / 1.25 / 2 it was billed at (its
 * page row, also read that day, still matches). The stamp stayed; see
 * {@link CATALOG_VERSION} for where it has been published. A haiku receipt written
 * under it before this move names model_id `claude-haiku-4-5`, which that row replays
 * at the same prices; only a record that names the tier alone (a tier-level lookup of
 * `haiku`) reads the new row, and that is the residual.
 *
 * @type {string}
 */
export const PRICING_VERSION = '2026-10-12';

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
 * the base input price, and Claude Opus 5.5 and Claude Sonnet 5.5 at 0.05x; the
 * other catalog models use the standard 0.1x multiplier. A single "10% of input"
 * rule would overcharge fable cache reads by 4x and opus / sonnet cache reads by
 * 2x. Write-price multipliers (1.25x for the 5-minute TTL, 2x for the 1-hour TTL)
 * are uniform today, but they are pinned as literals too so a future per-model
 * exception lands as a value edit, not a formula rewrite.
 *
 * Two measurement flags travel with the data so consumers can tell a verified
 * number from an estimate: `priceMeasured` (true = all five price columns of
 * that row were compared against {@link PRICING_SOURCE} on
 * {@link PRICING_VERSION} and match it) and `tokenizerCoeffMeasured` (see
 * {@link getCostFactor} — currently false).
 *
 * `priceSource` says what stands behind `priceMeasured`, as data instead of a
 * comment: `kind` is the class of source (`official-table` = the official pricing
 * page, cited by {@link PRICING_SOURCE}; `skill-table` = the claude-api skill
 * price table, which no row uses since the 2026-10-12 read), `ref` its label
 * (scheme-less, for the reason PRICING_SOURCE is), `checkedAt` the `YYYY-MM-DD`
 * day the row was compared with it, and `derivedColumns` the price columns that
 * were NOT read there but computed from input (none today: the sonnet row's two
 * cache-write columns were, at the standard 1.25x / 2x, until that read). Every
 * value is what this file's own notes already said; typing it here re-verifies
 * nothing. An id priced by its tier's row (every current id, and a legacy id with
 * no {@link ID_PRICES} row) reports the TIER row's source: that row's latest
 * comparison, not necessarily one made for that id. What a
 * {@link PRICING_VERSION} bump must do to `checkedAt` and `priceMeasured` is
 * written at that constant. Shape and vocabulary are pinned in
 * `tests/core/model-catalog.test.js`.
 *
 * `priceMaxPromptTokens` is the largest prompt, in tokens, that the five price
 * columns of a row apply to; `null` means one price at any prompt length. A
 * request's prompt counts its input, cache-read and cache-write tokens together
 * (the pricing page's own definition). Only Claude Haiku 5.5 is banded, so only its
 * row holds a number (100_000), and the page's higher price list for a longer prompt
 * is NOT stored: no reader applies it, so a request over the boundary is priced at
 * the stored columns, which understates it (see the haiku row).
 * {@link getPricing} reports the field as `maxPromptTokens`. It is not a price
 * column, so `lib/core/pricing-history.js` does not freeze it.
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
 * `tests/core/model-catalog.test.js`. No tier carries `extended` since the haiku
 * tier moved to Haiku 5.5 (2026-10-12); the value stays in the closed vocabulary.
 * Sonnet 5.5 is `adaptive` here because the official models overview labels it
 * `Adaptive`; it also rejects `{type:'disabled'}` and takes `{type:'between_tools'}`,
 * a shape this vocabulary has no value for (see the sonnet row).
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
 *   priceSource: Readonly<{
 *     kind: 'official-table'|'skill-table',
 *     ref: string,
 *     checkedAt: string,
 *     derivedColumns: readonly string[]
 *   }>,
 *   priceMaxPromptTokens: number|null,
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
    // 2026-10-12: the tier moved from Claude Haiku 4.5 to Claude Haiku 5.5, the move
    // opus made on 2026-09-23 and sonnet on 2026-09-29. claude-haiku-4-5 stays
    // resolvable as a legacy id and keeps its own ID_PRICES row, so older
    // transcripts and ledger rows keep tier haiku and the $1 / $5 they were billed at.
    id: 'claude-haiku-5-5',
    legacyIds: ['claude-haiku-4-5'],
    // Official pricing page rows "Claude Haiku 5.5 (for prompts up to 100,000
    // tokens)", fetched 2026-10-12 KST: $0.10 / $0.125 / $0.20 / $0.01 / $0.50 per
    // MTok (input / 5m write / 1h write / cache hit / output). The cache hit is the
    // standard 0.1x of input.
    //
    // ONLY THAT BAND IS STORED. The page prices Haiku 5.5 per request by prompt
    // length, where the prompt counts input, cache reads and cache writes together:
    // a request over 100,000 tokens pays $0.50 / $0.625 / $1 / $0.05 / $2.50, which
    // is 5x every column. Nothing here or in a reader applies that second list
    // (`priceMaxPromptTokens` names the boundary; the receipt writer counts the
    // requests over it in `meta.overPriceBandRequests` and still prices them at the
    // columns below), so a request over 100K prompt tokens is under-priced by 5x and
    // a receipt that sums such requests by up to 5x.
    priceInPerMTok: 0.1,
    priceOutPerMTok: 0.5,
    priceCacheReadPerMTok: 0.01,
    priceCacheWrite5mPerMTok: 0.125,
    priceCacheWrite1hPerMTok: 0.2,
    priceMeasured: true,
    // The two page rows above, read on 2026-10-12.
    priceSource: {
      kind: 'official-table',
      ref: PRICING_SOURCE,
      checkedAt: '2026-10-12',
      derivedColumns: [],
    },
    priceMaxPromptTokens: 100_000,
    // tokenizerCoeff, tokenizerCoeffMeasured and promptStyle are the values the
    // Haiku 4.5 row carried; nobody re-verified them for 5.5 (the coefficient is an
    // estimate on every tier, see getCostFactor).
    tokenizerCoeff: 1.0,
    tokenizerCoeffMeasured: false,
    // Models overview, Haiku 5.5 column, read 2026-10-12: context window 1M tokens,
    // max output 128K tokens.
    ctxLimit: 1_000_000,
    outLimit: 128_000,
    // Haiku 5.5 takes {type:'adaptive'}, which is also what it does when no
    // `thinking` field is sent. {type:'enabled', budget_tokens} returns 400, and
    // {type:'disabled'} is accepted at effort `high` or below (400 at `xhigh` or
    // `max`), so thinking CAN be turned off here, unlike on opus and fable (thinking
    // page, table "Configuring thinking", read 2026-10-12).
    thinkingMode: 'adaptive',
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
    // Official pricing page row "Claude Sonnet 5.5", fetched 2026-10-12 KST:
    // $2 / $2.50 / $4 / $0.10 / $10 per MTok (input / 5m write / 1h write / cache
    // hit / output). The cache hit is 0.05x of input (the page's footnote 2, shared
    // with Opus 5.5), cut from $0.20 by the 2026-10-07 release note; every other
    // column is unchanged. Until 2026-10-12 this row was priced from the
    // claude-api skill price table (cached 2026-09-25) with the cache writes
    // derived from input; the page now lists all five, so nothing is derived.
    // claude-sonnet-5 is NOT priced by this row any more: its cache hit stayed at
    // $0.20, so it has its own ID_PRICES row.
    priceInPerMTok: 2,
    priceOutPerMTok: 10,
    priceCacheReadPerMTok: 0.1,
    priceCacheWrite5mPerMTok: 2.5,
    priceCacheWrite1hPerMTok: 4,
    priceMeasured: true,
    // The page row above, read on 2026-10-12.
    priceSource: {
      kind: 'official-table',
      ref: PRICING_SOURCE,
      checkedAt: '2026-10-12',
      derivedColumns: [],
    },
    priceMaxPromptTokens: null,
    tokenizerCoeff: 1.0,
    tokenizerCoeffMeasured: false,
    // ctxLimit, outLimit, thinkingMode and promptStyle are the values the
    // catalog carried for Sonnet 5 (outLimit per the claude-api skill,
    // 2026-09-28). They were carried over when the id moved to 5.5. On 2026-10-12
    // the models overview was read for 5.5: it agrees on ctxLimit (1M), outLimit
    // (128K) and the `Adaptive` label that `thinkingMode` uses. The thinking page
    // adds a nuance this vocabulary has no value for: Sonnet 5.5 rejects
    // {type:'disabled'} (400) and takes {type:'between_tools'} as its lowest
    // setting. promptStyle was not re-read.
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
    // the claude-opus-5 row 5 / 25 / 0.5 / 6.25 / 10) and read again on
    // 2026-10-12, when it still matched. opus is BASELINE_TIER, so this input
    // price is the divisor of every getCostFactor.
    priceInPerMTok: 4,
    priceOutPerMTok: 20,
    // 0.05x input, NOT the standard 0.1x — official footnote.
    priceCacheReadPerMTok: 0.2,
    priceCacheWrite5mPerMTok: 5,
    priceCacheWrite1hPerMTok: 8,
    priceMeasured: true,
    // The official page row named in the comment above, last read on 2026-10-12.
    priceSource: {
      kind: 'official-table',
      ref: PRICING_SOURCE,
      checkedAt: '2026-10-12',
      derivedColumns: [],
    },
    priceMaxPromptTokens: null,
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
    // 0.025x input, NOT the standard 0.1x (opus and sonnet 5.5 are the other
    // exception, at 0.05x) — official footnote.
    priceCacheReadPerMTok: 0.25,
    priceCacheWrite5mPerMTok: 12.5,
    priceCacheWrite1hPerMTok: 20,
    priceMeasured: true,
    // Re-read on 2026-10-12 and already matched (the PRICING_VERSION notes), so
    // the figures above did not move; `priceMeasured` defines that read as against
    // PRICING_SOURCE on PRICING_VERSION, and the 0.025x footnote above is that page's.
    priceSource: {
      kind: 'official-table',
      ref: PRICING_SOURCE,
      checkedAt: '2026-10-12',
      derivedColumns: [],
    },
    priceMaxPromptTokens: null,
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
 * an id no tier resolves. Same five price columns, `priceMeasured` flag,
 * `priceSource` and `priceMaxPromptTokens` as {@link MODELS}, same
 * {@link PRICING_VERSION} stamp. Both rules are pinned in
 * `tests/core/model-catalog.test.js`.
 *
 * @type {Readonly<Record<string, Readonly<{
 *   priceInPerMTok: number,
 *   priceOutPerMTok: number,
 *   priceCacheReadPerMTok: number,
 *   priceCacheWrite5mPerMTok: number,
 *   priceCacheWrite1hPerMTok: number,
 *   priceMeasured: boolean,
 *   priceSource: Readonly<{
 *     kind: 'official-table'|'skill-table',
 *     ref: string,
 *     checkedAt: string,
 *     derivedColumns: readonly string[]
 *   }>,
 *   priceMaxPromptTokens: number|null
 * }>>>}
 */
export const ID_PRICES = deepFreeze({
  'claude-opus-5': {
    // Official pricing page row (Claude Opus 5), fetched 2026-09-28 KST. The
    // opus tier row moved to Opus 5.5 the same day; this id keeps its own. Read
    // again on 2026-10-12, when it still matched.
    priceInPerMTok: 5,
    priceOutPerMTok: 25,
    priceCacheReadPerMTok: 0.5,
    priceCacheWrite5mPerMTok: 6.25,
    priceCacheWrite1hPerMTok: 10,
    priceMeasured: true,
    // The same official page row, last read on 2026-10-12 (the comment above).
    priceSource: {
      kind: 'official-table',
      ref: PRICING_SOURCE,
      checkedAt: '2026-10-12',
      derivedColumns: [],
    },
    priceMaxPromptTokens: null,
  },
  'claude-sonnet-5': {
    // Official pricing page row "Claude Sonnet 5", fetched 2026-10-12 KST:
    // $2 / $2.50 / $4 / $0.20 / $10 per MTok. The sonnet tier row (Sonnet 5.5)
    // cut its cache hit to $0.10 on the 2026-10-07 release note; this id did not,
    // and until then the tier row priced both. The $2 / $10 are the standard price
    // (footnote 3: the increase to $3 / $15 scheduled for 2026-09-01 did not occur).
    priceInPerMTok: 2,
    priceOutPerMTok: 10,
    priceCacheReadPerMTok: 0.2,
    priceCacheWrite5mPerMTok: 2.5,
    priceCacheWrite1hPerMTok: 4,
    priceMeasured: true,
    // The page row above, read on 2026-10-12.
    priceSource: {
      kind: 'official-table',
      ref: PRICING_SOURCE,
      checkedAt: '2026-10-12',
      derivedColumns: [],
    },
    priceMaxPromptTokens: null,
  },
  'claude-haiku-4-5': {
    // Official pricing page row "Claude Haiku 4.5", fetched 2026-10-12 KST:
    // $1 / $1.25 / $2 / $0.10 / $5 per MTok. The haiku tier row moved to Haiku 5.5
    // the same day (its price list is a tenth of this one); this id keeps the price
    // it was billed at. One price at any prompt length, so no band.
    priceInPerMTok: 1,
    priceOutPerMTok: 5,
    priceCacheReadPerMTok: 0.1,
    priceCacheWrite5mPerMTok: 1.25,
    priceCacheWrite1hPerMTok: 2,
    priceMeasured: true,
    // The page row above, read on 2026-10-12.
    priceSource: {
      kind: 'official-table',
      ref: PRICING_SOURCE,
      checkedAt: '2026-10-12',
      derivedColumns: [],
    },
    priceMaxPromptTokens: null,
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
 * `source` is the `priceSource` of the row that priced the key (see
 * {@link MODELS}: an id priced by its tier's row reports the tier row's), or null
 * if a row records none. It exists only on a lookup against the CURRENT catalog:
 * `lib/core/pricing-history.js#getPricingAt` reports none for a past stamp, whose
 * frozen rows hold prices and nothing about where they came from.
 *
 * `maxPromptTokens` is the row's `priceMaxPromptTokens`: the largest prompt the
 * five price columns apply to, or null when the model has one price at any prompt
 * length. A caller that prices a request whose prompt is over it is using columns
 * that do not apply (see {@link MODELS}); this function does not hold the other
 * list. Like `source`, a past stamp reports none.
 *
 * @param {string} key - A ROLE_ALIASES key, a tier key, or an exact model id.
 * @returns {Readonly<{
 *   tier: string, id: string, input: number, output: number,
 *   cacheRead: number, cacheWrite5m: number, cacheWrite1h: number,
 *   measured: boolean, version: string,
 *   source: Readonly<{
 *     kind: string, ref: string, checkedAt: string, derivedColumns: readonly string[]
 *   }>|null,
 *   maxPromptTokens: number|null
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
    source: row.priceSource ?? null,
    maxPromptTokens: row.priceMaxPromptTokens ?? null,
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
