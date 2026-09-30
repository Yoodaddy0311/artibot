/**
 * Contract for `lib/economics/usage-table.js` — the pure fold that turns
 * `usage.receipt` ledger rows into ONE row per model that actually served.
 *
 * WHAT IS PINNED
 * ---------------------------------------------------------------------------
 *  - one row per SERVING model id (a legacy id is its own row, resolved through
 *    the catalog's `legacyIds`, never merged into its successor);
 *  - sessions (distinct session ids) and spawns (distinct `agent-` runs), with
 *    a grand total that counts each session / run ONCE;
 *  - the four token columns and the cost column, where the cost is the measured
 *    tokens times the CURRENT catalog price (`priceUsage`, the writer's own
 *    formula) and the receipts' recorded `cost.total` rides beside it;
 *  - filters (session list, `since`, run list) and the conservation invariant
 *    `seen = malformed + Σ filtered + estimate_grade + source_missing + duplicates + counted`;
 *  - honesty: zero rows stays zero rows (no total, no 0-cost row), an estimate
 *    grade receipt — and one with no `usage.source` at all, which is a different
 *    finding — is never mixed into a measured aggregate, a same-key receipt
 *    with DIFFERENT content is kept (real ledger: a redacted run id collapsed
 *    two runs into one key), an unverified price is `null` and never a number.
 *
 * WHAT THIS FILE CANNOT SEE (rules section 9 — written beside the gate)
 * ---------------------------------------------------------------------------
 *  - WHETHER LIVE LEDGER ROWS HAVE THIS SHAPE. Every row here is built by a
 *    helper that mirrors `receipt-envelope.js`; `tests/ledger/usage-cost-table-cli.test.js`
 *    seeds through the real writer for that reason.
 *  - WHETHER THE CATALOG PRICES ARE RIGHT. Expected dollars are recomputed from
 *    `getPricing` with the formula spelled out below, so this file goes red on a
 *    formula change but stays green on a price change — the price columns are
 *    `tests/core/model-catalog.test.js`'s to pin.
 *  - FIXTURE SIZE. Rows are a handful; the live ledger held 416 at
 *    2026-09-30T02:17Z. Nothing here says anything about volume.
 *
 * @module tests/economics/usage-table
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CATALOG_VERSION,
  getPricing,
  ID_PRICES,
  MODELS,
  PRICING_SOURCE,
  PRICING_VERSION,
  tierForModelId,
} from '../../lib/core/model-catalog.js';
import { priceUsage } from '../../lib/economics/usage-receipt.js';
import { AGENT_RUN_PREFIX as SPAWN_OUTCOME_PREFIX } from '../../lib/replay/spawn-outcome.js';
import {
  AGENT_RUN_PREFIX,
  foldUsageTable,
  MEASURED_SOURCES,
  mergeLiveEvents,
} from '../../lib/economics/usage-table.js';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const OPUS_NEW = MODELS.opus.id;
const OPUS_OLD = MODELS.opus.legacyIds[0];
const SONNET_NEW = MODELS.sonnet.id;
const SONNET_OLD = MODELS.sonnet.legacyIds[0];
const HAIKU = MODELS.haiku.id;

const minute = (m) => `2026-09-30T00:${String(m).padStart(2, '0')}:00.000Z`;

/**
 * One `usage.receipt` ledger line, shaped like `toUsageReceiptEnvelopes`
 * output plus the `ts`/`v` the writer stamps. `cost` defaults to what the
 * receipt writer itself would record (`priceUsage`), so a default row is a row
 * whose recorded cost equals the current-catalog price.
 */
function receipt(o = {}) {
  const {
    session = 'sess-A',
    run = 'agent-a1',
    model = OPUS_NEW,
    usage = {},
    started = minute(0),
    completed = minute(5),
    source = 'transcript',
    cost,
    omitUsage = false,
  } = o;
  const tier = tierForModelId(model) ?? 'opus';
  const usageBlock = {
    source,
    fresh_input_tokens: 1000,
    cached_input_tokens: 200000,
    cache_creation_tokens: 10000,
    output_tokens: 5000,
    thinking_tokens: 100,
    requests: 3,
    ...usage,
  };
  const data = {
    schema_version: 1,
    run_id: run,
    mission_id: 'M-20260930-Ssessa000',
    model_identity: {
      provider: 'anthropic',
      family: 'claude',
      tier,
      model_id: model,
      version: model,
      catalog_version: CATALOG_VERSION,
    },
    ...(omitUsage ? {} : { usage: usageBlock }),
    timing: {
      started_at: started,
      completed_at: completed,
      latency_ms: Date.parse(completed) - Date.parse(started),
    },
    outcome: { status: 'unknown', accepted: null },
    cost: cost ?? priceUsage(usageBlock, tier, model),
  };
  return {
    v: 1,
    ts: completed,
    event: 'usage.receipt',
    mission_id: data.mission_id,
    session_id: session,
    source: 'hook',
    pid: 1,
    seq: 0,
    run_id: run,
    model,
    idempotency_key: `usage.receipt:${session}:${run}:${model}`,
    data,
  };
}

/** The pricing formula, spelled out — an oracle independent of `priceUsage`. */
function oracleUsd(model, u) {
  const p = getPricing(model);
  return (
    (u.fresh * p.input) / 1e6
    + (u.cached * p.cacheRead) / 1e6
    + (u.write * p.cacheWrite5m) / 1e6
    + (u.output * p.output) / 1e6
  );
}

const BASE_USAGE = { fresh: 1000, cached: 200000, write: 10000, output: 5000 };

/**
 * Six receipts over four models, two sessions. Token counts differ per receipt
 * so a column that summed the wrong field cannot pass by coincidence.
 *   S1 main        OPUS_NEW      (main thread)
 *   S1 agent-a1    SONNET_NEW
 *   S1 agent-a2    SONNET_NEW
 *   S2 agent-b1    OPUS_OLD      \ one run that served TWO models
 *   S2 agent-b1    SONNET_NEW    /
 *   S2 main        HAIKU         (main thread)
 */
function multiModelEvents() {
  return [
    receipt({ session: 'S1', run: 'S1', model: OPUS_NEW, usage: { fresh_input_tokens: 11, cached_input_tokens: 1100, cache_creation_tokens: 110, output_tokens: 1 } }),
    receipt({ session: 'S1', run: 'agent-a1', model: SONNET_NEW, usage: { fresh_input_tokens: 22, cached_input_tokens: 2200, cache_creation_tokens: 220, output_tokens: 2 } }),
    receipt({ session: 'S1', run: 'agent-a2', model: SONNET_NEW, usage: { fresh_input_tokens: 33, cached_input_tokens: 3300, cache_creation_tokens: 330, output_tokens: 3 } }),
    receipt({ session: 'S2', run: 'agent-b1', model: OPUS_OLD, usage: { fresh_input_tokens: 44, cached_input_tokens: 4400, cache_creation_tokens: 440, output_tokens: 4 } }),
    receipt({ session: 'S2', run: 'agent-b1', model: SONNET_NEW, usage: { fresh_input_tokens: 55, cached_input_tokens: 5500, cache_creation_tokens: 550, output_tokens: 5 } }),
    receipt({ session: 'S2', run: 'S2', model: HAIKU, usage: { fresh_input_tokens: 66, cached_input_tokens: 6600, cache_creation_tokens: 660, output_tokens: 6 } }),
  ];
}

const rowOf = (table, model) => table.rows.find((r) => r.model_id === model);

describe('foldUsageTable: one row per serving model', () => {
  it('folds a multi-model ledger into rows sorted by model id, with a grand total', () => {
    const table = foldUsageTable(multiModelEvents());

    expect(table.rows.map((r) => r.model_id)).toEqual([HAIKU, OPUS_OLD, OPUS_NEW, SONNET_NEW]);
    expect(table.receipts.counted).toBe(6);

    const sonnet = rowOf(table, SONNET_NEW);
    expect(sonnet.usage).toMatchObject({
      fresh_input_tokens: 22 + 33 + 55,
      cached_input_tokens: 2200 + 3300 + 5500,
      cache_creation_tokens: 220 + 330 + 550,
      output_tokens: 2 + 3 + 5,
    });
    expect(sonnet.receipts).toBe(3);

    const total = table.total;
    expect(total.receipts).toBe(6);
    expect(total.usage.fresh_input_tokens).toBe(11 + 22 + 33 + 44 + 55 + 66);
    expect(total.usage.cached_input_tokens).toBe(1100 + 2200 + 3300 + 4400 + 5500 + 6600);
    expect(total.usage.cache_creation_tokens).toBe(110 + 220 + 330 + 440 + 550 + 660);
    expect(total.usage.output_tokens).toBe(1 + 2 + 3 + 4 + 5 + 6);
    expect(total.models).toBe(4);
  });

  it('counts sessions and spawns per row, and each session / run ONCE in the total', () => {
    const table = foldUsageTable(multiModelEvents());

    const sonnet = rowOf(table, SONNET_NEW);
    expect(sonnet.sessions).toBe(2);
    expect(sonnet.spawns).toBe(3);
    expect(sonnet.main_receipts).toBe(0);
    expect(sonnet.spawn_receipts).toBe(3);

    // The main thread is a session, not a spawn.
    const opusNew = rowOf(table, OPUS_NEW);
    expect(opusNew.sessions).toBe(1);
    expect(opusNew.spawns).toBe(0);
    expect(opusNew.main_receipts).toBe(1);

    // agent-b1 served two models: one spawn in EACH model row, one in the total.
    expect(rowOf(table, OPUS_OLD).spawns).toBe(1);
    expect(table.total.sessions).toBe(2);
    expect(table.total.spawns).toBe(3);
    // Summing the rows would say 1 + 0 + 3 + 0 = 4 spawns; the run is not 2 runs.
    expect(table.rows.reduce((n, r) => n + r.spawns, 0)).toBe(4);
  });

  it('keeps a legacy id as its own row, resolved through the catalog, priced at ITS id row', () => {
    const table = foldUsageTable([
      receipt({ model: OPUS_OLD, run: 'agent-o1' }),
      receipt({ model: OPUS_NEW, run: 'agent-o2' }),
      receipt({ model: SONNET_OLD, run: 'agent-s1' }),
    ]);

    const old = rowOf(table, OPUS_OLD);
    const current = rowOf(table, OPUS_NEW);
    const sonnetOld = rowOf(table, SONNET_OLD);
    expect(old.tier).toBe('opus');
    expect(old.id_status).toBe('legacy');
    expect(current.tier).toBe('opus');
    expect(current.id_status).toBe('current');
    expect(sonnetOld.id_status).toBe('legacy');

    // Not merged: two opus rows, and they differ in price because the legacy id
    // keeps its own per-id price row (ID_PRICES) — a merge would bill one of
    // them at the other's rate.
    expect(ID_PRICES[OPUS_OLD]).toBeDefined();
    expect(old.cost.usd).toBeCloseTo(oracleUsd(OPUS_OLD, BASE_USAGE), 9);
    expect(current.cost.usd).toBeCloseTo(oracleUsd(OPUS_NEW, BASE_USAGE), 9);
    expect(old.cost.usd).not.toBe(current.cost.usd);
    // Sonnet's legacy id has no per-id row: the tier row prices both ids.
    expect(sonnetOld.cost.usd).toBeCloseTo(oracleUsd(SONNET_OLD, BASE_USAGE), 9);
  });

  it('keeps an id the catalog does not know as its own row: no tier, no price, never a guess', () => {
    const table = foldUsageTable([receipt({ model: 'claude-mystery-9', run: 'agent-m1' })]);

    const row = rowOf(table, 'claude-mystery-9');
    expect(row.tier).toBeNull();
    expect(row.id_status).toBe('unknown');
    expect(row.cost.usd).toBeNull();
    expect(row.cost.price_status).toBe('unknown-model');
    // The tokens are still measured and still shown.
    expect(row.usage.output_tokens).toBe(5000);
    // A total priced at zero would read as a measured floor.
    expect(table.total.cost.usd).toBeNull();
    expect(table.total.cost.unpriced_models).toEqual(['claude-mystery-9']);
  });

  it('prefers data.model_identity.model_id and falls back to the envelope model', () => {
    const viaEnvelope = receipt({ model: SONNET_NEW });
    delete viaEnvelope.data.model_identity;
    const table = foldUsageTable([viaEnvelope]);
    expect(table.rows.map((r) => r.model_id)).toEqual([SONNET_NEW]);

    const disagree = receipt({ model: SONNET_NEW });
    disagree.model = OPUS_NEW;
    expect(foldUsageTable([disagree]).rows.map((r) => r.model_id)).toEqual([SONNET_NEW]);
  });
});

describe('foldUsageTable: zero rows stay zero rows', () => {
  it('reports no rows and NO total for an empty input — never a 0-cost row', () => {
    const table = foldUsageTable([]);
    expect(table.rows).toEqual([]);
    expect(table.total).toBeNull();
    expect(table.receipts.seen).toBe(0);
    expect(table.receipts.counted).toBe(0);
    expect(table.by_kind.main.receipts).toBe(0);
    expect(table.by_kind.main.usd).toBeNull();
    expect(table.by_kind.spawn.usd).toBeNull();
  });

  it('ignores every event that is not a usage.receipt and does not count it as seen', () => {
    const table = foldUsageTable([
      { event: 'session.ended', session_id: 'S1', data: {} },
      { event: 'route.bound', session_id: 'S1', data: {} },
      null,
      'not an object',
      42,
    ]);
    expect(table.receipts.seen).toBe(0);
    expect(table.rows).toEqual([]);
    expect(table.total).toBeNull();
  });

  it('accepts a non-array input as an empty ledger instead of throwing', () => {
    expect(foldUsageTable(undefined).rows).toEqual([]);
    expect(foldUsageTable(null).total).toBeNull();
  });

  it('keeps the cost of a fully filtered-out ledger null, not 0', () => {
    const table = foldUsageTable(multiModelEvents(), { sessionIds: ['no-such-session'] });
    expect(table.rows).toEqual([]);
    expect(table.total).toBeNull();
    expect(table.receipts.seen).toBe(6);
    expect(table.receipts.filtered.session).toBe(6);
  });
});

describe('foldUsageTable: filters', () => {
  it('filters by session id list', () => {
    const table = foldUsageTable(multiModelEvents(), { sessionIds: ['S1'] });
    expect(table.receipts.counted).toBe(3);
    expect(table.receipts.filtered.session).toBe(3);
    expect(table.total.sessions).toBe(1);
    expect(table.filter.session_ids).toEqual(['S1']);
  });

  it('treats an EXPLICIT empty list as "match nothing", not "match everything"', () => {
    // An empty list computed by a caller ("the sessions of this run") means no
    // sessions took part. Reading it as "no filter" would print the whole ledger.
    expect(foldUsageTable(multiModelEvents(), { sessionIds: [] }).receipts.counted).toBe(0);
    expect(foldUsageTable(multiModelEvents(), { runIds: [] }).receipts.counted).toBe(0);
    // Absent / null is the no-filter spelling.
    expect(foldUsageTable(multiModelEvents(), { sessionIds: null }).receipts.counted).toBe(6);
    expect(foldUsageTable(multiModelEvents(), {}).receipts.counted).toBe(6);
  });

  it('filters by run id, with or without the agent- prefix (a bind carries the bare id)', () => {
    const withPrefix = foldUsageTable(multiModelEvents(), { runIds: ['agent-a1'] });
    const bare = foldUsageTable(multiModelEvents(), { runIds: ['a1'] });
    expect(withPrefix.receipts.counted).toBe(1);
    expect(bare.receipts.counted).toBe(1);
    expect(bare.rows.map((r) => r.model_id)).toEqual([SONNET_NEW]);
    expect(bare.receipts.filtered.run).toBe(5);
    // A main-thread run id (the session id) matches as itself.
    expect(foldUsageTable(multiModelEvents(), { runIds: ['S2'] }).rows.map((r) => r.model_id))
      .toEqual([HAIKU]);
  });

  it('keeps runs that STARTED at or after `since`, and says what it left out', () => {
    const events = [
      receipt({ run: 'agent-before', started: minute(0), completed: minute(4) }),
      receipt({ run: 'agent-straddle', started: minute(1), completed: minute(20) }),
      receipt({ run: 'agent-exact', started: minute(10), completed: minute(12) }),
      receipt({ run: 'agent-after', started: minute(15), completed: minute(18) }),
    ];
    const table = foldUsageTable(events, { since: minute(10) });

    // started_at >= since: the boundary instant itself is kept.
    expect(table.receipts.counted).toBe(2);
    expect(table.receipts.filtered.before_since).toBe(1);
    // A receipt is a per-run AGGREGATE: one that began before the cutoff and ended
    // after it cannot be split, so it is reported, not silently included.
    expect(table.receipts.filtered.straddling_since).toBe(1);
    expect(table.filter.since).toBe(minute(10));
  });

  it('accepts since as epoch ms, ISO string or Date, and normalises all to one ISO string', () => {
    const ms = Date.parse(minute(10));
    const a = foldUsageTable([], { since: ms });
    const b = foldUsageTable([], { since: minute(10) });
    const c = foldUsageTable([], { since: new Date(ms) });
    expect(a.filter.since).toBe(minute(10));
    expect(b.filter.since).toBe(minute(10));
    expect(c.filter.since).toBe(minute(10));
  });

  it('cannot window a receipt with no usable start time, and counts it instead of guessing', () => {
    const noTime = receipt({ run: 'agent-x' });
    noTime.data.timing.started_at = 'not a time';
    const table = foldUsageTable([noTime], { since: minute(0) });
    expect(table.receipts.filtered.no_time).toBe(1);
    expect(table.receipts.counted).toBe(0);
    // Without a window the same receipt is perfectly countable.
    expect(foldUsageTable([noTime]).receipts.counted).toBe(1);
  });

  it('conserves every receipt: seen = malformed + filtered + estimate + source_missing + duplicates + counted', () => {
    const events = [
      ...multiModelEvents(),
      receipt({ session: 'S3', run: 'agent-e1', source: 'estimate' }),
      receipt({ session: 'S3', run: 'agent-ns', source: null }),
      receipt({ session: 'S3', run: 'agent-dup' }),
      receipt({ session: 'S3', run: 'agent-dup' }),
      receipt({ session: 'S3', run: 'agent-m', omitUsage: true }),
    ];
    const table = foldUsageTable(events, { sessionIds: ['S1', 'S3'] });
    const r = table.receipts;
    const filtered = Object.values(r.filtered).reduce((n, v) => n + v, 0);
    expect(r.seen).toBe(11);
    expect(r.seen).toBe(r.malformed + filtered + r.estimate_grade + r.source_missing + r.duplicates + r.counted);
    expect(r.malformed).toBe(1);
    expect(r.estimate_grade).toBe(1);
    expect(r.source_missing).toBe(1);
    expect(r.duplicates).toBe(1);
    expect(filtered).toBe(3); // the three S2 rows
    expect(r.counted).toBe(4); // S1 x3 + one agent-dup
  });

  it('throws on invalid ARGUMENTS but never on transcript CONTENT', () => {
    expect(() => foldUsageTable([], { since: 'not a time' })).toThrow(TypeError);
    // An all-digit string is ambiguous (year? epoch?) and is refused, not guessed.
    expect(() => foldUsageTable([], { since: '2026' })).toThrow(TypeError);
    expect(() => foldUsageTable([], { since: Number.NaN })).toThrow(TypeError);
    expect(() => foldUsageTable([], { sessionIds: 'S1' })).toThrow(TypeError);
    expect(() => foldUsageTable([], { sessionIds: [1] })).toThrow(TypeError);
    expect(() => foldUsageTable([], { runIds: [''] })).toThrow(TypeError);
  });
});

describe('foldUsageTable: what is never mixed into a measured aggregate', () => {
  it('excludes an estimate-grade receipt from every sum and counts it', () => {
    const table = foldUsageTable([
      receipt({ run: 'agent-ok' }),
      receipt({ run: 'agent-est', source: 'estimate', usage: { output_tokens: 999999 } }),
      receipt({ run: 'agent-odd', source: 'mystery-source' }),
    ]);
    expect(table.receipts.counted).toBe(1);
    // Allowlist, not denylist: an unknown source string is excluded like `estimate`.
    expect(table.receipts.estimate_grade).toBe(2);
    expect(table.receipts.source_missing).toBe(0);
    expect(table.total.usage.output_tokens).toBe(5000);
  });

  it('counts a receipt with no usage.source as source_missing — not as estimate grade — and sums nothing of it', () => {
    // The schema makes `usage.source` mandatory, so a row without one is not a
    // receipt somebody graded `estimate`: it is a row nobody labelled. Naming it
    // an estimate would put a claim on it that nothing recorded.
    const absent = receipt({ run: 'agent-absent', usage: { output_tokens: 999999 } });
    delete absent.data.usage.source;
    const table = foldUsageTable([
      receipt({ run: 'agent-ok' }),
      absent,
      receipt({ run: 'agent-null', source: null, usage: { output_tokens: 999999 } }),
      receipt({ run: 'agent-empty', source: '', usage: { output_tokens: 999999 } }),
      receipt({ run: 'agent-est', source: 'estimate', usage: { output_tokens: 999999 } }),
    ]);

    expect(table.receipts.counted).toBe(1);
    expect(table.receipts.source_missing).toBe(3);
    expect(table.receipts.estimate_grade).toBe(1);
    expect(table.total.usage.output_tokens).toBe(5000);
  });

  it('pins the measured-source allowlist to the schema enum minus `estimate`', () => {
    const schema = JSON.parse(readFileSync(
      path.join(PLUGIN_ROOT, 'schemas', 'attempt-receipt.schema.json'), 'utf-8',
    ));
    const declared = schema.properties.usage.properties.source.enum;
    expect([...MEASURED_SOURCES].sort()).toEqual(declared.filter((s) => s !== 'estimate').sort());
  });

  it('counts a receipt with no model, usage block, run or session as malformed and sums nothing of it', () => {
    const noModel = receipt();
    delete noModel.data.model_identity;
    delete noModel.model;
    const noUsage = receipt({ run: 'agent-2', omitUsage: true });
    const noRun = receipt({ run: 'agent-3' });
    delete noRun.run_id;
    delete noRun.data.run_id;
    const noSession = receipt({ run: 'agent-4' });
    delete noSession.session_id;
    const table = foldUsageTable([noModel, noUsage, noRun, noSession]);
    expect(table.receipts.malformed).toBe(4);
    expect(table.rows).toEqual([]);
    expect(table.total).toBeNull();
  });

  it('drops a CONTENT-IDENTICAL repeat (a double write) but keeps a same-key receipt that differs', () => {
    const first = receipt({ session: 'S1', run: 'agent-r', usage: { output_tokens: 10 } });
    const repeat = receipt({ session: 'S1', run: 'agent-r', usage: { output_tokens: 10 } });
    repeat.ts = '2030-01-01T00:00:00.000Z'; // the envelope stamp differs; the receipt does not
    const collision = receipt({
      session: 'S1', run: 'agent-r', usage: { output_tokens: 20 }, started: minute(7), completed: minute(9),
    });
    const table = foldUsageTable([first, repeat, collision]);

    expect(table.receipts.duplicates).toBe(1);
    // Real ledger (copy, 2026-09-30T02:17Z): the writer's redaction turned two
    // different subagents' run ids into one string, so two DIFFERENT runs shared
    // one idempotency key. Dropping the second would delete real spend.
    expect(table.receipts.key_collisions).toBe(1);
    expect(table.receipts.counted).toBe(2);
    expect(table.total.usage.output_tokens).toBe(30);
  });
});

describe('foldUsageTable: cost honesty', () => {
  it('prices from measured tokens at the CURRENT catalog, and matches the writer on a current stamp', () => {
    const events = multiModelEvents();
    const table = foldUsageTable(events);
    for (const row of table.rows) {
      const own = events.filter((e) => e.data.model_identity.model_id === row.model_id);
      const expected = own.reduce((sum, e) => sum + e.data.cost.total, 0);
      expect(row.cost.usd).toBeCloseTo(expected, 9);
      expect(row.cost.recorded_usd).toBeCloseTo(expected, 9);
      expect(row.cost.stale_receipts).toBe(0);
      expect(row.cost.unrecorded_receipts).toBe(0);
    }
    expect(table.total.cost.usd).toBeCloseTo(
      events.reduce((sum, e) => sum + e.data.cost.total, 0), 9,
    );
    expect(table.total.cost.price_status).toBe('verified');
  });

  it('reports a receipt recorded under an OLD price stamp: recorded vs current, per row', () => {
    // A receipt written when the opus row still carried the previous model's
    // (higher) price: its recorded total is bigger than today's price for the
    // same tokens. The table shows today's price and shows the gap.
    const usage = { fresh_input_tokens: 1000, cached_input_tokens: 200000, cache_creation_tokens: 10000, output_tokens: 5000 };
    const oldRecorded = (1000 * 5) / 1e6 + (200000 * 0.5) / 1e6 + (10000 * 6.25) / 1e6 + (5000 * 25) / 1e6;
    const stale = receipt({
      model: OPUS_NEW, run: 'agent-old', usage, cost: { total: oldRecorded, pricing_version: '2026-09-12' },
    });
    const table = foldUsageTable([stale]);
    const row = rowOf(table, OPUS_NEW);

    expect(row.cost.usd).toBeCloseTo(oracleUsd(OPUS_NEW, BASE_USAGE), 9);
    expect(row.cost.recorded_usd).toBeCloseTo(oldRecorded, 9);
    expect(row.cost.stale_receipts).toBe(1);
    expect(row.cost.stale_recorded_usd).toBeCloseTo(oldRecorded, 9);
    expect(row.cost.stale_current_usd).toBeCloseTo(oracleUsd(OPUS_NEW, BASE_USAGE), 9);
    expect(row.cost.stale_recorded_usd).toBeGreaterThan(row.cost.stale_current_usd);
    expect(row.cost.stamps).toEqual({ '2026-09-12': 1 });
    expect(table.total.cost.stale_receipts).toBe(1);
  });

  it('fills an unpriced receipt (cost.total null, stamp unresolved) from tokens and says so', () => {
    const unpriced = receipt({
      run: 'agent-u', cost: { total: null, pricing_version: 'unresolved' },
    });
    const table = foldUsageTable([unpriced]);
    const row = rowOf(table, OPUS_NEW);

    expect(row.cost.usd).toBeCloseTo(oracleUsd(OPUS_NEW, BASE_USAGE), 9);
    // Nothing was recorded, and the recorded sum must say so with null, not 0.
    expect(row.cost.recorded_usd).toBeNull();
    expect(row.cost.recorded_receipts).toBe(0);
    expect(row.cost.unrecorded_receipts).toBe(1);
    expect(row.cost.stamps).toEqual({ unresolved: 1 });
    // An unpriced receipt is not a stale-stamp receipt.
    expect(row.cost.stale_receipts).toBe(0);
  });

  it('shows `null`, never a number, for a model whose catalog price is not verified', () => {
    const ports = {
      getPricing: (key) => {
        const real = getPricing(key);
        return real === null ? null : { ...real, measured: false };
      },
      priceUsage: () => ({ total: null, pricing_version: 'unresolved' }),
    };
    const table = foldUsageTable([receipt({ run: 'agent-v' })], { ports });
    const row = rowOf(table, OPUS_NEW);

    expect(row.cost.usd).toBeNull();
    expect(row.cost.price_status).toBe('unverified');
    expect(table.total.cost.usd).toBeNull();
    expect(table.total.cost.price_status).toBe('none');
    expect(table.total.cost.unpriced_models).toEqual([OPUS_NEW]);
    expect(table.pricing.models[0].price_status).toBe('unverified');
    // The recorded total (what the writer stamped) is still reported.
    expect(row.cost.recorded_usd).not.toBeNull();
  });

  it('marks a partly verified ledger `partial` and leaves the unverified model out of the total', () => {
    const ports = {
      getPricing: (key) => {
        const real = getPricing(key);
        if (real === null) return null;
        return real.tier === 'haiku' ? { ...real, measured: false } : real;
      },
      priceUsage: (usage, tier, modelId) => (tier === 'haiku'
        ? { total: null, pricing_version: 'unresolved' }
        : priceUsage(usage, tier, modelId)),
    };
    const events = [
      receipt({ run: 'agent-h', model: HAIKU }),
      receipt({ run: 'agent-o', model: OPUS_NEW }),
    ];
    const table = foldUsageTable(events, { ports });

    expect(table.total.cost.price_status).toBe('partial');
    expect(table.total.cost.unpriced_models).toEqual([HAIKU]);
    expect(table.total.cost.usd).toBeCloseTo(oracleUsd(OPUS_NEW, BASE_USAGE), 9);
  });

  it('names the price source, its date and the unit prices it used', () => {
    const table = foldUsageTable(multiModelEvents());
    expect(table.pricing.source).toBe(PRICING_SOURCE);
    expect(table.pricing.version).toBe(PRICING_VERSION);
    expect(table.pricing.catalog_version).toBe(CATALOG_VERSION);
    expect(table.pricing.basis).toBe('current-catalog');

    const opusOld = table.pricing.models.find((m) => m.model_id === OPUS_OLD);
    expect(opusOld.per_mtok).toEqual({
      input: ID_PRICES[OPUS_OLD].priceInPerMTok,
      output: ID_PRICES[OPUS_OLD].priceOutPerMTok,
      cache_read: ID_PRICES[OPUS_OLD].priceCacheReadPerMTok,
      cache_write_5m: ID_PRICES[OPUS_OLD].priceCacheWrite5mPerMTok,
    });
    expect(table.pricing.models.map((m) => m.model_id)).toEqual(table.rows.map((r) => r.model_id));
  });

  it('splits main-thread spend from spawn spend', () => {
    const table = foldUsageTable(multiModelEvents());
    expect(table.by_kind.main.receipts).toBe(2);
    expect(table.by_kind.spawn.receipts).toBe(4);
    expect(table.by_kind.main.usd + table.by_kind.spawn.usd).toBeCloseTo(table.total.cost.usd, 9);
  });
});

describe('foldUsageTable: determinism and purity', () => {
  it('serialises to the same bytes for any input order', () => {
    const events = multiModelEvents();
    const forward = JSON.stringify(foldUsageTable(events));
    const reversed = JSON.stringify(foldUsageTable([...events].reverse()));
    const shuffled = JSON.stringify(foldUsageTable([events[3], events[0], events[5], events[2], events[4], events[1]]));
    expect(reversed).toBe(forward);
    expect(shuffled).toBe(forward);
  });

  it('sums in a fixed order, even where the input order would change the float sum', () => {
    // 0.1 + 0.2 + 0.3 is 0.6000000000000001 left to right and 0.6 right to left,
    // so a fold that summed in file order would print two different totals for
    // the same three receipts.
    expect((0.1 + 0.2) + 0.3).not.toBe((0.3 + 0.2) + 0.1);
    const ports = {
      priceUsage: (usage) => ({ total: usage.fresh_input_tokens / 10, pricing_version: PRICING_VERSION }),
    };
    const mk = (run, fresh) => receipt({
      run, usage: { fresh_input_tokens: fresh }, cost: { total: fresh / 10, pricing_version: PRICING_VERSION },
    });
    const [a, b, c] = [mk('agent-a', 1), mk('agent-b', 2), mk('agent-c', 3)];

    const forward = foldUsageTable([a, b, c], { ports });
    const backward = foldUsageTable([c, b, a], { ports });

    expect(backward.rows[0].cost.usd).toBe(forward.rows[0].cost.usd);
    expect(JSON.stringify(backward)).toBe(JSON.stringify(forward));
  });

  it('does not mutate its input', () => {
    const events = multiModelEvents();
    const before = JSON.stringify(events);
    foldUsageTable(events, { sessionIds: ['S1'], since: minute(0) });
    expect(JSON.stringify(events)).toBe(before);
  });

  it('reads no file, clock, environment or network of its own', () => {
    const source = readFileSync(path.join(PLUGIN_ROOT, 'lib', 'economics', 'usage-table.js'), 'utf-8');
    expect(source).not.toMatch(/node:(fs|os|child_process|http|https|net)/);
    expect(source).not.toMatch(/\bprocess\./);
    expect(source).not.toMatch(/Date\.now\(|new Date\(\)/);
    expect(source).not.toMatch(/\bfetch\s*\(/);
  });

  it('spells the agent run prefix the way the spawn-outcome fold does', () => {
    expect(AGENT_RUN_PREFIX).toBe(SPAWN_OUTCOME_PREFIX);
  });
});

describe('mergeLiveEvents: a live session replaces its own ledger rows, never adds to them', () => {
  it('drops ledger receipts of the live session and keeps everything else', () => {
    const ledger = [
      receipt({ session: 'LIVE', run: 'agent-old', model: SONNET_NEW }),
      receipt({ session: 'OTHER', run: 'agent-x', model: HAIKU }),
      { event: 'session.ended', session_id: 'LIVE', data: {} },
    ];
    const live = [
      receipt({ session: 'LIVE', run: 'agent-old', model: SONNET_NEW, usage: { output_tokens: 9999 } }),
      receipt({ session: 'LIVE', run: 'agent-new', model: OPUS_NEW }),
    ];
    const merged = mergeLiveEvents(ledger, live);

    expect(merged.replaced).toBe(1);
    const table = foldUsageTable(merged.events);
    // 2 live + 1 other-session receipt; the stale ledger copy of the live session is gone.
    expect(table.receipts.counted).toBe(3);
    expect(rowOf(table, SONNET_NEW).usage.output_tokens).toBe(9999);
    // Non-receipt ledger lines pass through untouched.
    expect(merged.events.some((e) => e.event === 'session.ended')).toBe(true);
  });

  it('replaces nothing when there are no live receipts', () => {
    const ledger = [receipt({ session: 'LIVE' })];
    const merged = mergeLiveEvents(ledger, []);
    expect(merged.replaced).toBe(0);
    expect(merged.events).toEqual(ledger);
  });
});
