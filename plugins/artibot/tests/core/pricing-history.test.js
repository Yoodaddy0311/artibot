/**
 * `lib/core/pricing-history.js` — past price tables, looked up by the
 * `PRICING_VERSION` stamp a record carries.
 *
 * The EXPECTED table below is copied from git, not from the module under
 * test, so the module cannot vouch for itself:
 *
 *   2026-09-12  stamp introduced by ebfce23c; the tier price columns did not
 *               move again until 5820948d (checked at ebfce23c, f3f2be19,
 *               f2947713, 43a50018 — same 4 x 5 values at each). Receipts of
 *               that era priced by tier only, so there are no per-id rows.
 *   2026-09-28  stamp set by 5820948d (opus/sonnet official sync + the
 *               claude-opus-5 per-id row); f8b49049 left every price as is.
 *
 * 이 게이트가 못 보는 것 / WHAT THIS GATE CANNOT SEE
 *  (a) Whether any row matches the published price page. Internal agreement
 *      with git only; the page is never fetched (data policy).
 *  (b) A price edit that ALSO rewrites the 2026-09-28 row of EXPECTED below.
 *      That is a visible rewrite of history in review, not a silent one.
 *  (c) Which ids cache-roi priced under a stamp. cache-roi resolves ids with
 *      its own substring rules (f8b49049 changed them under 2026-09-28); this
 *      history mirrors the RECEIPT resolver (exact id -> tier), not cache-roi.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  getPricing,
  ID_PRICES,
  MODELS,
  PRICING_VERSION,
} from '../../lib/core/model-catalog.js';
import {
  getPricingAt,
  PRICING_HISTORY,
  PRICING_VERSIONS,
  pricingForReceipt,
} from '../../lib/core/pricing-history.js';
import {
  buildUsageReceipts,
  PRICING_VERSION_UNRESOLVED,
} from '../../lib/economics/usage-receipt.js';

/** Five price columns + the measured flag, in catalog field names. */
const row = (input, output, cacheRead, cacheWrite5m, cacheWrite1h) => ({
  priceInPerMTok: input,
  priceOutPerMTok: output,
  priceCacheReadPerMTok: cacheRead,
  priceCacheWrite5mPerMTok: cacheWrite5m,
  priceCacheWrite1hPerMTok: cacheWrite1h,
  priceMeasured: true,
});

/** Every row as git recorded it. Keyed by stamp, oldest first. */
const EXPECTED = {
  '2026-09-12': {
    // ebfce23c..43a50018: tier rows unchanged under this stamp.
    tiers: {
      haiku: row(1, 5, 0.1, 1.25, 2),
      sonnet: row(3, 15, 0.3, 3.75, 6),
      opus: row(5, 25, 0.5, 6.25, 10),
      fable: row(10, 50, 0.25, 12.5, 20),
    },
    // Every id the receipt resolver accepted under the stamp: ebfce23c had one
    // id per tier; f2947713 swapped claude-sonnet-4-6 for claude-sonnet-5;
    // 43a50018 made claude-opus-5-5 the opus id and kept claude-opus-5.
    ids: {
      'claude-haiku-4-5': 'haiku',
      'claude-sonnet-4-6': 'sonnet',
      'claude-sonnet-5': 'sonnet',
      'claude-opus-5': 'opus',
      'claude-opus-5-5': 'opus',
      'claude-fable-5-1': 'fable',
    },
    idPrices: {},
  },
  '2026-09-28': {
    // 5820948d; unchanged by f8b49049.
    tiers: {
      haiku: row(1, 5, 0.1, 1.25, 2),
      sonnet: row(2, 10, 0.2, 2.5, 4),
      opus: row(4, 20, 0.2, 5, 8),
      fable: row(10, 50, 0.25, 12.5, 20),
    },
    // claude-sonnet-5-5 joined this id map on 2026-09-29 with no price edit
    // (the tier rows above are untouched), so the stamp did not move. It is
    // the id the host serves for sonnet; receipts for it did not exist before.
    ids: {
      'claude-haiku-4-5': 'haiku',
      'claude-sonnet-5': 'sonnet',
      'claude-sonnet-5-5': 'sonnet',
      'claude-opus-5-5': 'opus',
      'claude-opus-5': 'opus',
      'claude-fable-5-1': 'fable',
    },
    idPrices: {
      'claude-opus-5': row(5, 25, 0.5, 6.25, 10),
    },
  },
};

/** Keys that must behave the same through getPricing and getPricingAt(current). */
const LOOKUP_KEYS = [
  'haiku', 'sonnet', 'opus', 'fable',
  'frontier', 'deep-async', 'balanced', 'fast',
  'claude-haiku-4-5', 'claude-sonnet-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-opus-5',
  'claude-fable-5-1', 'claude-sonnet-4-6', 'claude-opus-4-8', 'gpt-4',
  '', 'toString', '__proto__', null, undefined, 42, {},
];

/** Per version, only the named fields of each history entry. */
const historyView = (history, fields) => Object.fromEntries(
  Object.entries(history).map(([version, entry]) => [
    version,
    Object.fromEntries(fields.map((field) => [field, entry?.[field]])),
  ]),
);

const pick = (src) => row(
  src.priceInPerMTok,
  src.priceOutPerMTok,
  src.priceCacheReadPerMTok,
  src.priceCacheWrite5mPerMTok,
  src.priceCacheWrite1hPerMTok,
);

describe('pricing history gate', () => {
  it('the current PRICING_VERSION is the newest listed version', () => {
    // Bumping PRICING_VERSION without appending it here goes red.
    expect(PRICING_VERSIONS.at(-1)).toBe(PRICING_VERSION);
  });

  it('every listed version has a row, and there is no row outside the list', () => {
    // Appending a new version without freezing the previous one leaves that
    // previous version with no row: red here.
    for (const version of PRICING_VERSIONS) {
      expect(PRICING_HISTORY[version], version).toBeTruthy();
    }
    expect(Object.keys(PRICING_HISTORY)).toEqual([...PRICING_VERSIONS]);
  });

  it('versions are unique, ascending, real calendar dates', () => {
    expect(new Set(PRICING_VERSIONS).size).toBe(PRICING_VERSIONS.length);
    expect([...PRICING_VERSIONS].sort()).toEqual([...PRICING_VERSIONS]);
    for (const version of PRICING_VERSIONS) {
      expect(version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(new Date(`${version}T00:00:00Z`).toISOString().slice(0, 10)).toBe(version);
    }
  });

  it('the "unresolved" sentinel is never a version', () => {
    expect(PRICING_VERSIONS).not.toContain(PRICING_VERSION_UNRESOLVED);
  });

  it('the current row is the catalog, column for column', () => {
    const current = PRICING_HISTORY[PRICING_VERSION];
    for (const [tier, spec] of Object.entries(MODELS)) {
      expect(current.tiers[tier], tier).toEqual(pick(spec));
      for (const id of [spec.id, ...spec.legacyIds]) {
        expect(current.ids[id], id).toBe(tier);
      }
    }
    expect(Object.keys(current.tiers)).toEqual(Object.keys(MODELS));
    expect(Object.keys(current.idPrices)).toEqual(Object.keys(ID_PRICES));
    for (const [id, idRow] of Object.entries(ID_PRICES)) {
      expect(current.idPrices[id], id).toEqual(pick(idRow));
    }
  });

  it('every row prices exactly as git recorded under that stamp', () => {
    // A price edit that keeps the stamp changes the derived 2026-09-28 row
    // and goes red here. Deleting an ID_PRICES row counts: past receipts of
    // that id would silently re-price if EXPECTED were edited to match.
    for (const version of PRICING_VERSIONS) {
      expect(Object.keys(PRICING_HISTORY[version]).sort(), version).toEqual(['idPrices', 'ids', 'tiers']);
    }
    expect(
      historyView(PRICING_HISTORY, ['tiers', 'idPrices']),
      'price rows changed: bump PRICING_VERSION and freeze the outgoing row in '
        + 'lib/core/pricing-history.js. Do not edit EXPECTED in place.',
    ).toEqual(historyView(EXPECTED, ['tiers', 'idPrices']));
  });

  it('every row maps ids to tiers as git recorded under that stamp', () => {
    // Id and limit edits do not bump the stamp (CATALOG_VERSION covers them),
    // so the current row's id map may move without a price change.
    expect(
      historyView(PRICING_HISTORY, ['ids']),
      'only the id -> tier map changed (the current row reads it from MODELS '
        + 'id/legacyIds): updating EXPECTED in place is fine. A frozen past row never changes.',
    ).toEqual(historyView(EXPECTED, ['ids']));
  });

  it('the history is deep-frozen', () => {
    expect(Object.isFrozen(PRICING_VERSIONS)).toBe(true);
    expect(Object.isFrozen(PRICING_HISTORY)).toBe(true);
    for (const version of PRICING_VERSIONS) {
      const entry = PRICING_HISTORY[version];
      expect(Object.isFrozen(entry)).toBe(true);
      expect(Object.isFrozen(entry.tiers.opus)).toBe(true);
      expect(Object.isFrozen(entry.ids)).toBe(true);
      expect(Object.isFrozen(entry.idPrices)).toBe(true);
    }
  });
});

describe('getPricingAt()', () => {
  it('at the current version returns exactly what getPricing returns', () => {
    for (const key of LOOKUP_KEYS) {
      expect(getPricingAt(PRICING_VERSION, key), String(key)).toStrictEqual(getPricing(key));
    }
  });

  it('prices a tier at 2026-09-12 with that stamp\'s row and no id', () => {
    // The opus tier pointed at claude-opus-5 and then claude-opus-5-5 under
    // this one stamp, so a tier lookup cannot name a single id.
    expect(getPricingAt('2026-09-12', 'opus')).toStrictEqual({
      tier: 'opus',
      id: null,
      input: 5,
      output: 25,
      cacheRead: 0.5,
      cacheWrite5m: 6.25,
      cacheWrite1h: 10,
      measured: true,
      version: '2026-09-12',
    });
    expect(getPricingAt('2026-09-12', 'balanced')).toMatchObject({ tier: 'sonnet', input: 3, output: 15 });
  });

  it('prices an id at the rate it was billed at under 2026-09-12', () => {
    // claude-opus-5-5 was billed at the opus tier row (5/25) from 43a50018
    // until 5820948d moved the row to 4/20 and the stamp to 2026-09-28.
    expect(getPricingAt('2026-09-12', 'claude-opus-5-5')).toMatchObject({
      tier: 'opus', id: 'claude-opus-5-5', input: 5, output: 25, cacheRead: 0.5,
    });
    // A retired id that the current catalog no longer resolves.
    expect(getPricing('claude-sonnet-4-6')).toBeNull();
    expect(getPricingAt('2026-09-12', 'claude-sonnet-4-6')).toMatchObject({
      tier: 'sonnet', id: 'claude-sonnet-4-6', input: 3, output: 15, version: '2026-09-12',
    });
  });

  it('returns frozen records', () => {
    expect(Object.isFrozen(getPricingAt('2026-09-12', 'fable'))).toBe(true);
  });

  it('never falls back to current prices for a version it does not hold', () => {
    const versions = [
      PRICING_VERSION_UNRESOLVED, '2026-09-11', '2026-01-01', '2026-09-12 ', '',
      'toString', '__proto__', undefined, null, 20260912, {},
    ];
    for (const version of versions) {
      for (const key of ['opus', 'claude-opus-5-5', 'frontier']) {
        expect(getPricingAt(version, key), `${String(version)} / ${key}`).toBeNull();
      }
    }
  });

  it('returns null for a key the stamp did not know', () => {
    // claude-sonnet-5-5 is in the CURRENT row's id map; the frozen 2026-09-12
    // row must not learn it (that would price a receipt no one wrote at a rate
    // no one billed).
    for (const key of ['claude-opus-4-8', 'claude-sonnet-5-5', 'gpt-4', 'mystery', '', 'toString', null, 42]) {
      expect(getPricingAt('2026-09-12', key), String(key)).toBeNull();
    }
  });
});

describe('getPricingAt() past rows do not depend on the current catalog', () => {
  const CATALOG = '../../lib/core/model-catalog.js';

  afterEach(() => {
    vi.doUnmock(CATALOG);
    vi.resetModules();
  });

  it('still prices a tier that the current catalog dropped', async () => {
    // Simulate a future catalog without fable (tier, alias and resolver all
    // agree), then load a fresh pricing-history against it.
    vi.resetModules();
    vi.doMock(CATALOG, async (importOriginal) => {
      const actual = await importOriginal();
      const without = (obj, drop) => Object.fromEntries(
        Object.entries(obj).filter(([key, value]) => key !== drop && value !== drop),
      );
      const models = without(actual.MODELS, 'fable');
      const aliases = without(actual.ROLE_ALIASES, 'fable');
      const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
      const resolveRole = (key) => {
        if (typeof key !== 'string') return null;
        if (has(aliases, key)) return aliases[key];
        return has(models, key) ? key : null;
      };
      return { ...actual, MODELS: models, ROLE_ALIASES: aliases, resolveRole };
    });
    const history = await import('../../lib/core/pricing-history.js');

    // Control: the mock reached the module (its current row has no fable).
    expect(history.PRICING_HISTORY[PRICING_VERSION].tiers.fable).toBeUndefined();
    expect(history.getPricingAt('2026-09-12', 'fable')).toMatchObject({
      tier: 'fable', id: null, input: 10, output: 50, cacheRead: 0.25, version: '2026-09-12',
    });
    expect(history.getPricingAt('2026-09-12', 'claude-fable-5-1')).toMatchObject({
      tier: 'fable', id: 'claude-fable-5-1', input: 10,
    });
  });
});

describe('pricingForReceipt()', () => {
  const receipt = (pricingVersion, tier, modelId) => ({
    cost: { total: 1, pricing_version: pricingVersion },
    model_identity: { tier, model_id: modelId },
  });

  it('resolves a past receipt to its own stamp, not today\'s prices', () => {
    const replayed = pricingForReceipt(receipt('2026-09-12', 'opus', 'claude-opus-5-5'));
    expect(replayed).toMatchObject({ tier: 'opus', input: 5, output: 25, version: '2026-09-12' });
    expect(replayed.input).not.toBe(getPricing('claude-opus-5-5').input);
  });

  it('replays a retired id by the tier the receipt recorded, not today\'s resolver', () => {
    // Today's tierForModelId('claude-sonnet-4-6') is null; the receipt was
    // written under 2026-09-12 when that id was the sonnet id.
    expect(pricingForReceipt(receipt('2026-09-12', 'sonnet', 'claude-sonnet-4-6'))).toMatchObject({
      tier: 'sonnet', id: 'claude-sonnet-4-6', input: 3, output: 15, version: '2026-09-12',
    });
  });

  it('uses the id row only when the id belongs to the receipt tier (as priceUsage does)', () => {
    expect(pricingForReceipt(receipt(PRICING_VERSION, 'opus', 'claude-opus-5'))).toStrictEqual(
      getPricing('claude-opus-5'),
    );
    // An id of another tier, or a role name in the id slot, is ignored.
    expect(pricingForReceipt(receipt(PRICING_VERSION, 'opus', 'claude-fable-5-1'))).toStrictEqual(
      getPricing('opus'),
    );
    expect(pricingForReceipt(receipt(PRICING_VERSION, 'opus', 'frontier'))).toStrictEqual(
      getPricing('opus'),
    );
    expect(pricingForReceipt(receipt('2026-09-12', 'sonnet', undefined))).toMatchObject({
      tier: 'sonnet', id: null, input: 3,
    });
  });

  it('replays a freshly built receipt to the row that priced it', async () => {
    const main = '/fake/projects/slug/sess-history.jsonl';
    const usage = {
      input_tokens: 100,
      cache_read_input_tokens: 900,
      cache_creation_input_tokens: 50,
      output_tokens: 20,
    };
    const { receipts } = await buildUsageReceipts({
      transcriptPath: main,
      missionId: 'm-history',
      readTranscript: (p) => {
        if (p !== main) throw new Error(`ENOENT ${p}`);
        return JSON.stringify({
          type: 'assistant',
          requestId: 'req-history-1',
          timestamp: '2026-09-28T00:00:00.000Z',
          message: { model: 'claude-opus-5', role: 'assistant', content: [], usage },
        });
      },
      listSubagentTranscripts: () => [],
    });

    expect(receipts).toHaveLength(1);
    const [built] = receipts;
    const replayed = pricingForReceipt(built);
    expect(replayed).toStrictEqual(getPricing('claude-opus-5'));
    const recomputed =
      built.usage.fresh_input_tokens * replayed.input / 1e6
      + built.usage.cached_input_tokens * replayed.cacheRead / 1e6
      + built.usage.cache_creation_tokens * replayed.cacheWrite5m / 1e6
      + built.usage.output_tokens * replayed.output / 1e6;
    expect(recomputed).toBe(built.cost.total);
  });

  it('replays a freshly built claude-sonnet-5-5 receipt to the row that priced it', async () => {
    const main = '/fake/projects/slug/sess-history-sonnet55.jsonl';
    const usage = {
      input_tokens: 100,
      cache_read_input_tokens: 900,
      cache_creation_input_tokens: 50,
      output_tokens: 20,
    };
    const { receipts, meta } = await buildUsageReceipts({
      transcriptPath: main,
      missionId: 'm-history-sonnet55',
      readTranscript: (p) => {
        if (p !== main) throw new Error(`ENOENT ${p}`);
        return JSON.stringify({
          type: 'assistant',
          requestId: 'req-history-sonnet55',
          timestamp: '2026-09-29T00:00:00.000Z',
          message: { model: 'claude-sonnet-5-5', role: 'assistant', content: [], usage },
        });
      },
      listSubagentTranscripts: () => [],
    });

    // Before the id resolved, this entry produced no receipt and was tallied
    // in meta.unresolvedModels instead (live: session.ended 8ce16014).
    expect(meta.unresolvedModels).toEqual({});
    expect(receipts).toHaveLength(1);
    const [built] = receipts;
    expect(built.model_identity).toMatchObject({ tier: 'sonnet', model_id: 'claude-sonnet-5-5' });
    expect(built.cost.pricing_version).toBe(PRICING_VERSION);
    const replayed = pricingForReceipt(built);
    expect(replayed).toStrictEqual(getPricing('claude-sonnet-5-5'));
    const recomputed =
      built.usage.fresh_input_tokens * replayed.input / 1e6
      + built.usage.cached_input_tokens * replayed.cacheRead / 1e6
      + built.usage.cache_creation_tokens * replayed.cacheWrite5m / 1e6
      + built.usage.output_tokens * replayed.output / 1e6;
    expect(recomputed).toBe(built.cost.total);
  });

  it('returns null for unresolved, unknown, missing or malformed input', () => {
    const cases = [
      receipt(PRICING_VERSION_UNRESOLVED, 'opus', 'claude-opus-5-5'),
      receipt('2026-01-01', 'opus', 'claude-opus-5-5'),
      receipt(undefined, 'opus', 'claude-opus-5-5'),
      receipt(20260928, 'opus', 'claude-opus-5-5'),
      receipt('2026-09-12', undefined, 'claude-opus-5-5'),
      receipt('2026-09-12', '', 'claude-opus-5-5'),
      receipt('2026-09-12', 'mystery', 'mystery'),
      { cost: { pricing_version: '2026-09-12' } },
      { model_identity: { tier: 'opus' } },
      {},
      null,
      undefined,
      'receipt',
    ];
    for (const input of cases) {
      expect(pricingForReceipt(input), JSON.stringify(input) ?? String(input)).toBeNull();
    }
  });
});
