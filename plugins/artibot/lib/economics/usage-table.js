/**
 * Usage table — `usage.receipt` ledger rows folded into ONE row per model that
 * actually served: sessions, spawns, the four token columns, and cost.
 *
 * This is the read side of `usage-receipt.js`. That module builds Attempt
 * Receipts from a transcript and `receipt-envelope.js` wraps them for the
 * ledger; nothing summed them by model for a person to read. `/scorecard
 * --compare` folds receipts against `route.bound` (recommended vs served) and
 * `scripts/ledger/session-coverage.mjs` counts sessions; neither prints "which
 * model spent how much" — this does.
 *
 * PURITY (design section 1-8, L2). No file, no clock, no environment, no
 * network. The caller passes ledger lines (`lib/runtime/ledger.js#readLedgerCensus`
 * output, or envelopes built from a transcript) and reads the clock for the
 * timestamp it prints. Every array and every record key in the result is
 * sorted, and the receipts are summed in a total order, so a shuffled input
 * serialises to the same bytes (float addition is not associative — the order
 * of summation is part of the contract, not an accident of file order).
 *
 * WHICH MODEL. The row key is the SERVING model id: `data.model_identity.model_id`,
 * the schema-required original, with the envelope's `model` (an unchecked copy
 * lifted out for indexing) as the fallback — the same precedence
 * `lib/replay/spawn-outcome.js` uses. A legacy id (`MODELS[tier].legacyIds`) is
 * its own row and is marked `legacy`: `claude-opus-5` and `claude-opus-5-5` are
 * different models with different official prices, so merging them would bill
 * one at the other's rate. An id the catalog does not know is its own row with
 * no tier and no price, never a guess from the tier stored on the receipt.
 *
 * COST — TWO NUMBERS, AND WHY THE TABLE SHOWS THE SECOND. Each receipt carries
 * the `cost.total` its writer computed against the price table of THAT day
 * (`cost.pricing_version`). Writers changed, so the ledger mixes tables: at
 * 2026-09-30T02:17Z (a copy, 416 receipt rows) 205 carried the 2026-09-12 stamp,
 * 139 the 2026-09-28 stamp, and 72 were never priced (`total: null`, stamp
 * `unresolved`). A recorded figure is off where its table's row was later
 * corrected — one sonnet receipt recorded at 3/15 $/MTok against 2/10 today;
 * the opus tier row also carried the previous model's price until 2026-09-28,
 * but no receipt on that ledger pairs the current opus id with the old stamp.
 * Summing `cost.total` would mix tables and silently drop the unpriced rows.
 * The table therefore prices MEASURED TOKENS at the CURRENT catalog
 * (`priceUsage`, the writer's own formula, never a second copy) — `cost.usd` —
 * and reports what the receipts recorded beside it: `recorded_usd`, and, for
 * receipts stamped with an older table, the recorded-vs-current pair
 * (`stale_*`). Two consequences are deliberate:
 *   - a model whose catalog row is not `measured` (or that the catalog does not
 *     know) has `usd: null` and `price_status` `unverified` / `unknown-model` —
 *     a number under an unverified price would be a claim nobody checked;
 *   - the figure is tokens x list price, not an invoice, and cache writes are
 *     priced at the 5-minute rate (the transcript carries no TTL), so it is a
 *     lower bound on cache-write spend.
 *
 * WHAT IS NEVER MIXED INTO A MEASURED AGGREGATE. `usage.source` is an
 * allowlist ({@link MEASURED_SOURCES}); a receipt graded `estimate`, or with
 * any source the allowlist does not name, is counted and left out of every sum
 * (schema: "estimate values must never be mixed into a measured aggregate").
 * A receipt with NO `usage.source` at all is counted apart (`source_missing`)
 * and left out of every sum the same way. The schema makes the field mandatory,
 * so such a row is unlabelled, not graded `estimate`: a reader of "estimate
 * grade 3" would take all three for estimates, and none of them was ever graded.
 *
 * DUPLICATES, AND THE CASE THAT LOOKS LIKE ONE BUT IS NOT. The writer's key is
 * (session, run, model). A CONTENT-IDENTICAL repeat of a receipt is a double
 * write and is dropped and counted (`duplicates`). A repeat with DIFFERENT
 * content is kept and counted as `key_collisions`. Measured 2026-09-30T02:17Z on
 * a copy of the live ledger (1 of 416 receipt rows): session 7cc66e45 had two
 * subagents in two different transcript files
 * (`agent-asplit-artibot-receipt-task-model-…-receipt-…` and `…-review-…`), and
 * both were written under the run id `agent-asplit-artibot-receipt-ta[REDACTED_KEY]`
 * — the writer's secret redaction (`lib/learning/ledger/redact.js`) masked the
 * tail of the long name — so two runs with different start times and token
 * counts shared one key. Dropping the second would have deleted real spend. A
 * lost receipt is a permanent hole; a kept duplicate is visible and removable
 * (`scripts/hooks/session-end.js#existingReceiptKeys` makes the same choice).
 *
 * FILTERS. `sessionIds` and `runIds` are lists; an EXPLICIT EMPTY LIST matches
 * nothing (a caller that computed "the sessions of this run" and got none must
 * not be answered with the whole ledger). `since` keeps receipts whose run
 * STARTED at or after it (`timing.started_at`), NOT receipts written after it:
 * the ledger stamps a row when SessionEnd fires, measured a median 12.5 hours
 * after the run's last entry (max 20.8 h, 416 rows, 2026-09-30T02:17Z), so the
 * envelope time says when a session was closed, not when the work happened. A
 * receipt is a per-run AGGREGATE and cannot be split: one that began before
 * `since` and ended after it (`straddling_since`) — typically the leader's main
 * thread — is reported, not silently included or dropped.
 *
 * CONSERVATION. Every `usage.receipt` line lands in exactly one bucket:
 * `seen = malformed + Σ filtered + estimate_grade + source_missing + duplicates + counted`
 * (`key_collisions` is a property of counted receipts, not a bucket).
 *
 * WHAT THIS MODULE CANNOT SEE
 *  - A SESSION THAT HAS NOT ENDED. Receipts are written by the SessionEnd hook
 *    only, so a running session — and every spawn inside it — has no row.
 *    {@link mergeLiveEvents} lets a caller add a session read straight from its
 *    transcript; this module cannot tell whether it should.
 *  - WHETHER THE CATALOG IS RIGHT ON ANY GIVEN DAY. `price_status: verified`
 *    means the catalog row's `priceMeasured` flag is set — the catalog defines
 *    that as "its five price columns were compared with the official page on
 *    `PRICING_VERSION`". Any change after that date is unchecked here.
 *  - WHETHER A SOURCE LABEL IS TRUE. The catalog records, per price row, where
 *    its figures were compared (`priceSource`: kind, label, date, and the columns
 *    computed instead of read - the current sonnet id's input, output and cache
 *    read against a skill price table rather than the page, its cache writes
 *    derived from input), and this module carries that record as
 *    `pricing.models[].price_source`. It is the catalog's statement, typed by
 *    whoever edited it: nothing here re-reads the page or the table, so the
 *    table proves the record was carried, never that it is right. An id priced by
 *    its tier's row shows that row's source, not one made for that id.
 *  - THE 1-HOUR CACHE TTL, THINKING TOKENS AS A SEPARATE COST, and whether a
 *    subscription bills anything at all.
 *
 * @module lib/economics/usage-table
 */

import {
  CATALOG_VERSION,
  getPricing,
  MODELS,
  PRICING_SOURCE,
  PRICING_VERSION,
  tierForModelId,
} from '../core/model-catalog.js';
import { USAGE_RECEIPT_EVENT } from './receipt-envelope.js';
import { priceUsage } from './usage-receipt.js';

/**
 * `run_id` prefix of a SUBAGENT run: the transcript file is named
 * `agent-<agentId>.jsonl` and the receipt's run id is that stem. A run id
 * without it is the main thread (its session id). Spelled here rather than
 * imported from `lib/replay/spawn-outcome.js` — a sibling layer — and pinned to
 * that module's export by `tests/economics/usage-table.test.js`.
 * @type {string}
 */
export const AGENT_RUN_PREFIX = 'agent-';

/**
 * `usage.source` values that count as MEASURED. An allowlist, not a denylist of
 * `estimate`: a source added to the schema tomorrow is excluded until someone
 * decides it is measured. Pinned to `schemas/attempt-receipt.schema.json` (the
 * enum minus `estimate`) by the suite.
 * @type {readonly string[]}
 */
export const MEASURED_SOURCES = Object.freeze(['transcript', 'otlp']);

/** What `cost.usd` is a price OF, printed on the result so it cannot be misread. */
const PRICING_BASIS = 'current-catalog';

/** Catalog lookups, injectable so a test can put a row into a state the frozen catalog never is. */
const DEFAULT_PORTS = Object.freeze({ getPricing, priceUsage, tierForModelId });

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' && v.length > 0 ? v : null);
const count = (v) => (Number.isFinite(v) && v >= 0 ? Math.trunc(v) : 0);
const optCount = (v) => (Number.isFinite(v) && v >= 0 ? Math.trunc(v) : null);

/** Stable string order, independent of the host locale. */
function cmp(a, b) {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/** Epoch ms of an ISO string, or null when absent or unparseable. */
function parseMs(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

/**
 * A caller's id list, validated. `null`/`undefined` is "no filter"; anything
 * else must be an array of non-empty strings — a bare string is refused
 * because `'S1'` read as a list of characters would match nothing, quietly.
 *
 * @param {unknown} value
 * @param {string} name
 * @returns {string[]|null} sorted unique ids; `[]` for an explicit empty list.
 */
function listOption(value, name) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string' && v.length > 0)) {
    throw new TypeError(`foldUsageTable: ${name} must be an array of non-empty strings`);
  }
  return [...new Set(value)].sort(cmp);
}

/**
 * `since` as epoch ms. An all-digit STRING is refused: `Date.parse('2026')` is
 * a year and `'1757000000000'` is not a date, so either reading is a guess. A
 * number is epoch ms by definition.
 *
 * @param {unknown} value
 * @returns {number|null}
 */
function sinceOption(value) {
  if (value === undefined || value === null) return null;
  let ms = Number.NaN;
  if (value instanceof Date) ms = value.getTime();
  else if (typeof value === 'number') ms = value;
  else if (typeof value === 'string' && value.trim() !== '' && !/^-?\d+$/.test(value.trim())) {
    ms = Date.parse(value);
  }
  if (!Number.isFinite(ms) || Number.isNaN(new Date(ms).getTime())) {
    throw new TypeError('foldUsageTable: since must be an ISO-8601 string, epoch ms (number) or Date');
  }
  return ms;
}

/**
 * The run ids a filter matches: each id as given AND with the `agent-` prefix
 * toggled, because `route.bound` carries the bare agent id while the receipt's
 * run id carries the prefix.
 *
 * @param {string[]} ids
 * @returns {Set<string>}
 */
function runMatchSet(ids) {
  const set = new Set();
  for (const id of ids) {
    set.add(id);
    set.add(id.startsWith(AGENT_RUN_PREFIX) ? id.slice(AGENT_RUN_PREFIX.length) : `${AGENT_RUN_PREFIX}${id}`);
  }
  return set;
}

/**
 * @param {object} options
 * @returns {{sessionIds: string[]|null, runIds: string[]|null, sinceMs: number|null,
 *   sessionSet: Set<string>|null, runSet: Set<string>|null}}
 */
function normalizeFilter(options) {
  const sessionIds = listOption(options.sessionIds, 'sessionIds');
  const runIds = listOption(options.runIds, 'runIds');
  return {
    sessionIds,
    runIds,
    sinceMs: sinceOption(options.since),
    sessionSet: sessionIds === null ? null : new Set(sessionIds),
    runSet: runIds === null ? null : runMatchSet(runIds),
  };
}

// ---------------------------------------------------------------------------
// One receipt
// ---------------------------------------------------------------------------

/**
 * The columns of one `usage.receipt` line, or null when it cannot be a table
 * row: no model, no usage block, no run or no session. The writer's schema makes
 * all four mandatory, so a line without one is malformed by contract and is
 * counted, not repaired.
 *
 * @param {object} e - ledger line whose `event` is `usage.receipt`.
 * @returns {object|null}
 */
function readReceipt(e) {
  const d = isObj(e.data) ? e.data : {};
  const usage = isObj(d.usage) ? d.usage : null;
  const modelId = str(isObj(d.model_identity) ? d.model_identity.model_id : null) ?? str(e.model);
  const runId = str(e.run_id) ?? str(d.run_id);
  const sessionId = str(e.session_id);
  if (usage === null || modelId === null || runId === null || sessionId === null) return null;

  const cost = isObj(d.cost) ? d.cost : {};
  const timing = isObj(d.timing) ? d.timing : {};
  const total = cost.total;
  return {
    sessionId,
    runId,
    modelId,
    isSpawn: runId.startsWith(AGENT_RUN_PREFIX),
    source: str(usage.source),
    fresh: count(usage.fresh_input_tokens),
    cached: count(usage.cached_input_tokens),
    write: count(usage.cache_creation_tokens),
    output: count(usage.output_tokens),
    thinking: optCount(usage.thinking_tokens),
    requests: optCount(usage.requests),
    startedMs: parseMs(timing.started_at),
    completedMs: parseMs(timing.completed_at),
    recorded: typeof total === 'number' && Number.isFinite(total) && total >= 0 ? total : null,
    stamp: str(cost.pricing_version),
    // NUL cannot occur in an id, so no two triples collide by concatenation.
    // Written as the escape, never as a raw byte (a raw NUL makes ripgrep treat
    // the file as binary and stop reporting matches).
    key: `${sessionId}\0${runId}\0${modelId}`,
    body: JSON.stringify(d),
  };
}

/**
 * Which bucket a well-formed receipt falls into, or null when it is counted.
 * Order matters and is the order of the conservation equation: the caller's
 * filters first, then the measurement grade.
 *
 * @param {object} r - {@link readReceipt} result.
 * @param {object} f - {@link normalizeFilter} result.
 * @returns {string|null}
 */
function bucketOf(r, f) {
  if (f.sessionSet !== null && !f.sessionSet.has(r.sessionId)) return 'session';
  if (f.runSet !== null && !f.runSet.has(r.runId)) return 'run';
  if (f.sinceMs !== null) {
    if (r.startedMs === null) return 'no_time';
    if (r.startedMs < f.sinceMs) {
      return r.completedMs !== null && r.completedMs >= f.sinceMs ? 'straddling_since' : 'before_since';
    }
  }
  if (r.source === null) return 'source_missing';
  if (!MEASURED_SOURCES.includes(r.source)) return 'estimate_grade';
  return null;
}

/** A total order over receipts, so the summation order does not depend on input order. */
function compareReceipts(a, b) {
  return cmp(a.modelId, b.modelId)
    || cmp(a.sessionId, b.sessionId)
    || cmp(a.runId, b.runId)
    || (a.startedMs ?? -1) - (b.startedMs ?? -1)
    || cmp(a.body, b.body);
}

/** @returns {object} the bookkeeping block, every counter at 0. */
function emptyTally() {
  return {
    seen: 0,
    malformed: 0,
    filtered: {
      session: 0, run: 0, before_since: 0, straddling_since: 0, no_time: 0,
    },
    estimate_grade: 0,
    source_missing: 0,
    duplicates: 0,
    key_collisions: 0,
    counted: 0,
  };
}

/** Count one receipt into the bucket {@link bucketOf} named. */
function record(tally, bucket) {
  if (Object.hasOwn(tally.filtered, bucket)) tally.filtered[bucket] += 1;
  else tally[bucket] += 1;
}

/**
 * Parse, filter, drop content-identical repeats, and order the receipts.
 *
 * @param {unknown} events
 * @param {object} filter
 * @returns {{tally: object, kept: object[]}}
 */
function screen(events, filter) {
  const tally = emptyTally();
  const bodiesByKey = new Map();
  const kept = [];
  for (const e of Array.isArray(events) ? events : []) {
    if (!isObj(e) || e.event !== USAGE_RECEIPT_EVENT) continue;
    tally.seen += 1;
    const r = readReceipt(e);
    const bucket = r === null ? 'malformed' : bucketOf(r, filter);
    if (bucket !== null) {
      record(tally, bucket);
      continue;
    }
    const bodies = bodiesByKey.get(r.key) ?? new Set();
    if (bodies.has(r.body)) {
      tally.duplicates += 1;
      continue;
    }
    bodies.add(r.body);
    bodiesByKey.set(r.key, bodies);
    kept.push(r);
  }
  for (const bodies of bodiesByKey.values()) tally.key_collisions += bodies.size - 1;
  tally.counted = kept.length;
  kept.sort(compareReceipts);
  return { tally, kept };
}

// ---------------------------------------------------------------------------
// Accumulation
// ---------------------------------------------------------------------------

/** @returns {object} an accumulator for one model (or, with a null id, for the total). */
function newGroup(modelId) {
  return {
    modelId,
    sessions: new Set(),
    spawns: new Set(),
    models: new Set(),
    receipts: 0,
    mainReceipts: 0,
    spawnReceipts: 0,
    fresh: 0,
    cached: 0,
    write: 0,
    output: 0,
    thinking: 0,
    thinkingSeen: false,
    requests: 0,
    requestsSeen: false,
    usd: 0,
    unpriced: 0,
    recordedUsd: 0,
    recordedReceipts: 0,
    staleReceipts: 0,
    staleRecorded: 0,
    staleCurrent: 0,
    staleCurrentMissing: false,
    stamps: new Map(),
  };
}

/**
 * Add one receipt to an accumulator.
 *
 * @param {object} g
 * @param {object} r - {@link readReceipt} result.
 * @param {number|null} usd - the receipt priced at the current catalog, or null.
 * @returns {void}
 */
function addReceipt(g, r, usd) {
  g.receipts += 1;
  g.sessions.add(r.sessionId);
  g.models.add(r.modelId);
  if (r.isSpawn) {
    g.spawnReceipts += 1;
    g.spawns.add(`${r.sessionId}\0${r.runId}`);
  } else {
    g.mainReceipts += 1;
  }
  g.fresh += r.fresh;
  g.cached += r.cached;
  g.write += r.write;
  g.output += r.output;
  if (r.thinking !== null) {
    g.thinking += r.thinking;
    g.thinkingSeen = true;
  }
  if (r.requests !== null) {
    g.requests += r.requests;
    g.requestsSeen = true;
  }
  if (usd === null) g.unpriced += 1;
  else g.usd += usd;

  const stamp = r.stamp ?? 'missing';
  g.stamps.set(stamp, (g.stamps.get(stamp) ?? 0) + 1);
  if (r.recorded === null) return;
  g.recordedUsd += r.recorded;
  g.recordedReceipts += 1;
  if (r.stamp === PRICING_VERSION) return;
  g.staleReceipts += 1;
  g.staleRecorded += r.recorded;
  if (usd === null) g.staleCurrentMissing = true;
  else g.staleCurrent += usd;
}

/**
 * One receipt priced at the current catalog, or null when its model has no
 * verified price. `tier` comes from the catalog's exact-id lookup, never from
 * the tier stored on the receipt.
 */
function currentUsd(r, tier, ports) {
  const { total } = ports.priceUsage({
    fresh_input_tokens: r.fresh,
    cached_input_tokens: r.cached,
    cache_creation_tokens: r.write,
    output_tokens: r.output,
  }, tier, r.modelId);
  return typeof total === 'number' && Number.isFinite(total) ? total : null;
}

/** Fresh accumulator for one bucket of the main-thread / spawn split. */
const newKind = () => ({ receipts: 0, usd: 0, unpriced: 0 });

/**
 * Fold the ordered receipts into per-model groups, one total group, and the
 * main-thread / spawn split.
 */
function accumulate(kept, ports) {
  const byModel = new Map();
  const all = newGroup(null);
  const kinds = { main: newKind(), spawn: newKind() };
  for (const r of kept) {
    let group = byModel.get(r.modelId);
    if (group === undefined) {
      group = newGroup(r.modelId);
      group.tier = ports.tierForModelId(r.modelId);
      byModel.set(r.modelId, group);
    }
    const usd = currentUsd(r, group.tier, ports);
    addReceipt(group, r, usd);
    addReceipt(all, r, usd);
    const kind = kinds[r.isSpawn ? 'spawn' : 'main'];
    kind.receipts += 1;
    if (usd === null) kind.unpriced += 1;
    else kind.usd += usd;
  }
  const groups = [...byModel.values()].sort((a, b) => cmp(a.modelId, b.modelId));
  return { groups, all, kinds };
}

// ---------------------------------------------------------------------------
// Output shape
// ---------------------------------------------------------------------------

/** A Map as a key-sorted plain object (`Object.fromEntries` defines own keys, so `__proto__` is a bucket, not a prototype). */
function sortedObject(map) {
  return Object.fromEntries([...map.entries()].sort((a, b) => cmp(a[0], b[0])));
}

/** `verified` | `unverified` | `unknown-model`, from the catalog row of this id. */
function priceStatus(modelId, ports) {
  if (modelId === null) return 'none';
  const pricing = ports.getPricing(modelId);
  if (pricing === null || pricing === undefined) return 'unknown-model';
  return pricing.measured === true ? 'verified' : 'unverified';
}

/** `current` for the tier's own id, `legacy` for a `legacyIds` entry, `unknown` otherwise. */
function idStatus(modelId, tier) {
  if (tier === null || tier === undefined) return 'unknown';
  return MODELS[tier]?.id === modelId ? 'current' : 'legacy';
}

/** The token block; `thinking_tokens` and `requests` stay `null` when no receipt reported them (absent is not 0). */
function usageBlock(g) {
  return {
    fresh_input_tokens: g.fresh,
    cached_input_tokens: g.cached,
    cache_creation_tokens: g.write,
    output_tokens: g.output,
    thinking_tokens: g.thinkingSeen ? g.thinking : null,
    requests: g.requestsSeen ? g.requests : null,
  };
}

/** The recorded-vs-current part of a cost block, shared by model rows and the total. */
function recordedBlock(g) {
  return {
    recorded_usd: g.recordedReceipts > 0 ? g.recordedUsd : null,
    recorded_receipts: g.recordedReceipts,
    unrecorded_receipts: g.receipts - g.recordedReceipts,
    stale_receipts: g.staleReceipts,
    stale_recorded_usd: g.staleReceipts > 0 ? g.staleRecorded : null,
    stale_current_usd: g.staleReceipts > 0 && !g.staleCurrentMissing ? g.staleCurrent : null,
    stamps: sortedObject(g.stamps),
  };
}

/** One model's row. */
function modelRow(g, ports) {
  const tier = g.tier ?? null;
  const priced = g.receipts > 0 && g.unpriced === 0;
  return {
    model_id: g.modelId,
    tier,
    id_status: idStatus(g.modelId, tier),
    sessions: g.sessions.size,
    spawns: g.spawns.size,
    main_receipts: g.mainReceipts,
    spawn_receipts: g.spawnReceipts,
    receipts: g.receipts,
    usage: usageBlock(g),
    cost: {
      usd: priced ? g.usd : null,
      price_status: priceStatus(g.modelId, ports),
      ...recordedBlock(g),
    },
  };
}

/** `verified` when every row is, `none` when no row is, `partial` between. */
function totalPriceStatus(rows) {
  const verified = rows.filter((r) => r.cost.price_status === 'verified' && r.cost.usd !== null).length;
  if (verified === rows.length) return 'verified';
  return verified === 0 ? 'none' : 'partial';
}

/** The grand-total row; sessions and spawns are distinct across ALL models, not the sum of the rows. */
function totalRow(all, rows) {
  const priced = rows.filter((r) => r.cost.usd !== null);
  return {
    models: all.models.size,
    sessions: all.sessions.size,
    spawns: all.spawns.size,
    main_receipts: all.mainReceipts,
    spawn_receipts: all.spawnReceipts,
    receipts: all.receipts,
    usage: usageBlock(all),
    cost: {
      usd: priced.length === 0 ? null : priced.reduce((sum, r) => sum + r.cost.usd, 0),
      price_status: totalPriceStatus(rows),
      unpriced_models: rows.filter((r) => r.cost.usd === null).map((r) => r.model_id),
      ...recordedBlock(all),
    },
  };
}

/** The main-thread / spawn split; `usd` is null when nothing in the bucket could be priced. */
function kindBlock(kind) {
  return {
    receipts: kind.receipts,
    usd: kind.receipts - kind.unpriced === 0 ? null : kind.usd,
    unpriced: kind.unpriced,
  };
}

/**
 * The catalog's structured source of one price row (`getPricing(id).source`), in
 * this table's snake_case, or `null` when the model is unknown or its row records
 * none - or something that is not the record: a source with no kind, label or
 * date says nothing, and is not passed on as if it did. A COPY: the catalog's own
 * object is frozen and shared, and this result is plain data a caller may hold or
 * change.
 */
function priceSourceBlock(pricing) {
  const s = pricing?.source;
  if (!isObj(s) || str(s.kind) === null || str(s.ref) === null || str(s.checkedAt) === null) return null;
  return {
    kind: s.kind,
    ref: s.ref,
    checked_at: s.checkedAt,
    derived_columns: Array.isArray(s.derivedColumns) ? [...s.derivedColumns] : [],
  };
}

/** What the numbers were priced with: source, its date, and the unit prices and source per model. */
function pricingBlock(rows, ports) {
  return {
    basis: PRICING_BASIS,
    source: PRICING_SOURCE,
    version: PRICING_VERSION,
    catalog_version: CATALOG_VERSION,
    cache_write: '5m-rate',
    models: rows.map((r) => {
      const p = ports.getPricing(r.model_id);
      return {
        model_id: r.model_id,
        tier: r.tier,
        id_status: r.id_status,
        price_status: r.cost.price_status,
        per_mtok: p === null || p === undefined ? null : {
          input: p.input,
          output: p.output,
          cache_read: p.cacheRead,
          cache_write_5m: p.cacheWrite5m,
        },
        price_source: priceSourceBlock(p),
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fold `usage.receipt` ledger lines into the per-model usage and cost table.
 *
 * Never throws on ledger CONTENT: a malformed line is a counter. Invalid
 * ARGUMENTS do throw — an answer computed under a filter the caller did not
 * mean is worse than no answer.
 *
 * @param {unknown} events - ledger lines, any event kinds; only `usage.receipt`
 *   is read. Anything that is not an array is an empty ledger.
 * @param {object} [options]
 * @param {readonly string[]} [options.sessionIds] - keep these sessions only;
 *   an explicit `[]` keeps nothing.
 * @param {readonly string[]} [options.runIds] - keep these runs only, with or
 *   without the `agent-` prefix; an explicit `[]` keeps nothing.
 * @param {number|string|Date} [options.since] - keep receipts whose run STARTED
 *   at or after this instant (epoch ms number, ISO string or Date).
 * @param {{getPricing?: Function, priceUsage?: Function, tierForModelId?: Function}} [options.ports]
 *   - Catalog lookups; a test seam. Defaults to the real catalog.
 * @returns {{event: string, filter: object, receipts: object, rows: object[],
 *   total: object|null, by_kind: object, pricing: object}} `total` is null when
 *   no receipt was counted — zero rows are not a row of zeros.
 * @throws {TypeError} When `sessionIds`/`runIds` is not an array of non-empty
 *   strings or `since` is not a time.
 *
 * @example
 * const { rows, total } = foldUsageTable(events, { since: '2026-09-30T00:00:00Z' });
 * total === null; // true when nothing matched
 */
export function foldUsageTable(events, options = {}) {
  const opts = options ?? {};
  const filter = normalizeFilter(opts);
  const ports = { ...DEFAULT_PORTS, ...(opts.ports ?? {}) };
  const { tally, kept } = screen(events, filter);
  const { groups, all, kinds } = accumulate(kept, ports);
  const rows = groups.map((g) => modelRow(g, ports));

  return {
    event: USAGE_RECEIPT_EVENT,
    filter: {
      session_ids: filter.sessionIds,
      run_ids: filter.runIds,
      since: filter.sinceMs === null ? null : new Date(filter.sinceMs).toISOString(),
    },
    receipts: tally,
    rows,
    total: rows.length === 0 ? null : totalRow(all, rows),
    by_kind: { main: kindBlock(kinds.main), spawn: kindBlock(kinds.spawn) },
    pricing: pricingBlock(rows, ports),
  };
}

/** Is this ledger line a `usage.receipt`? */
const isReceiptEvent = (e) => isObj(e) && e.event === USAGE_RECEIPT_EVENT;

/**
 * Combine ledger lines with receipts read straight from a live session's
 * transcript, WITHOUT double counting.
 *
 * A session that is still running has no `usage.receipt` row: SessionEnd is the
 * only writer. A caller that reads it from the transcript gets receipts for the
 * same (session, run, model) triples a later SessionEnd will write — and, if
 * the session ended once before and was resumed, an EARLIER, smaller snapshot
 * of them may already be in the ledger. Adding both would count that session
 * twice, so every ledger receipt of a live session is REPLACED by the live copy
 * (the transcript only grows, so the live copy is the superset). A live session
 * with no receipts replaces nothing: an empty read is not a measurement that
 * the ledger's rows are wrong.
 *
 * "The live copy is the superset" holds only for a COMPLETE read. A read that
 * could not open every transcript file is a subset, and replacing a fuller
 * ledger copy with it would drop spend without a trace — so a caller passes NO
 * live events for such a read (`scripts/ledger/usage-cost-table.mjs#collectLive`
 * does, and says so). This function cannot tell a partial read from a whole one.
 *
 * @param {unknown} ledgerEvents - lines from the ledger.
 * @param {unknown} liveEvents - `usage.receipt` envelopes built from a transcript
 *   (`receipt-envelope.js#toUsageReceiptEnvelopes`).
 * @returns {{events: object[], replaced: number}} the merged lines, and how many
 *   ledger receipts were replaced.
 */
export function mergeLiveEvents(ledgerEvents, liveEvents) {
  const ledger = Array.isArray(ledgerEvents) ? ledgerEvents : [];
  const live = Array.isArray(liveEvents) ? liveEvents : [];
  const liveSessions = new Set(
    live.filter(isReceiptEvent).map((e) => str(e.session_id)).filter((s) => s !== null),
  );
  let replaced = 0;
  const events = [];
  for (const e of ledger) {
    if (isReceiptEvent(e) && liveSessions.has(str(e.session_id))) {
      replaced += 1;
      continue;
    }
    events.push(e);
  }
  events.push(...live);
  return { events, replaced };
}
