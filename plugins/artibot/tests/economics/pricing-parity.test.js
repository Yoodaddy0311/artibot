/**
 * Pricing parity gate — one price table, three consumers, same numbers.
 *
 * `lib/core/model-catalog.js` is the single price table. Three modules read it
 * and each one reshapes the numbers on the way out:
 *
 *   - `lib/runtime/middleware/cache-roi.js`   per-MTok, substring model match
 *   - `lib/economics/usage-receipt.js`        per-MTok, exact-id reverse index
 *   - `lib/routing/route-hysteresis.js`       per-TOKEN (per-MTok / 1e6)
 *
 * A reshape is where a second price table grows back. This suite pins every
 * reshape to the catalog row it came from: 4 tiers x 4 price columns for the
 * two per-MTok readers, and both directions (input, output) for the per-token
 * reader. If a literal is edited in one consumer and not the catalog, a row
 * here goes red.
 *
 * 이 게이트가 못 보는 것 / WHAT THIS GATE CANNOT SEE
 * ------------------------------------------------
 * (a) Whether the catalog literals match the LIVE published price page. This
 *     suite proves internal agreement only. Every module could be uniformly
 *     wrong and every assertion here would still pass. The catalog is a pure
 *     local module under a no-outbound data policy
 *     (`tests/ci/data-policy-outbound-guard.test.js`), so nothing in this repo
 *     fetches the page; re-verification is a human act recorded by bumping
 *     `PRICING_VERSION`. A stale stamp reads as green here.
 * (b) 1-HOUR cache writes. `cacheWrite1h` exists in the catalog but neither
 *     cache-roi nor the receipt can reach it: both bill the single
 *     `cache_creation*` counter at `cacheWrite5m` because the usage payload
 *     carries no TTL. Their cache-write spend is a LOWER BOUND (1h is 1.6x the
 *     5m rate), and no test can separate the two from the data available.
 * (c) `lib/routing/route-scorer.js#predictedCost`, which reads
 *     `model.priceInPerMTok` directly. The function is not exported, so it is
 *     not covered here. It is the fourth reader and it is unpinned.
 */

import { describe, expect, it } from 'vitest';

import * as catalog from '../../lib/core/model-catalog.js';
import {
  getCostFactor,
  getPricing,
  getTokenizerCoeff,
  listTiers,
  MODELS,
  PRICING_VERSION,
} from '../../lib/core/model-catalog.js';
import {
  buildUsageReceipts,
  priceUsage,
  PRICING_VERSION_UNRESOLVED,
  resolveModelIdentity,
} from '../../lib/economics/usage-receipt.js';
import {
  freshInputPrice,
  outputPrice,
} from '../../lib/routing/route-hysteresis.js';
import {
  _PRICING,
  _resolvePricing,
  computeCacheMetrics,
} from '../../lib/runtime/middleware/cache-roi.js';

const TIERS = listTiers();

/**
 * Receipt usage counter -> the catalog price column it must bill at.
 * This map IS the claim under test in the receipt section: a receipt that
 * summed correctly while charging cache hits at the fresh-input rate would
 * pass a total-only check and fail here.
 */
const RECEIPT_COLUMN_BY_COUNTER = Object.freeze({
  fresh_input_tokens: 'input',
  cached_input_tokens: 'cacheRead',
  cache_creation_tokens: 'cacheWrite5m',
  output_tokens: 'output',
});

/** One million tokens: makes `tokens * perMTok / 1e6` collapse to `perMTok`. */
const ONE_MTOK = 1e6;

describe('pricing parity: tier coverage', () => {
  it('covers exactly 4 tiers, so a 5th is not silently under-tested', () => {
    // Every table below iterates TIERS. If a tier is added without touching
    // this file, the new tier IS tested — but this assertion still fires, so
    // the author is forced to look at the "cannot see" list above.
    expect(TIERS).toHaveLength(4);
    // Copy before sorting: TIERS is the array every it.each above expanded
    // from, and mutating shared test state is how order-dependent suites start.
    expect([...TIERS].sort()).toEqual(['fable', 'haiku', 'opus', 'sonnet']);
  });
});

describe('pricing parity: catalog <-> cache-roi', () => {
  it.each(TIERS)(
    '%s: _resolvePricing(catalog id) returns the catalog row verbatim',
    (tier) => {
      expect(_resolvePricing(MODELS[tier].id)).toEqual(getPricing(tier));
    },
  );

  it.each(TIERS)(
    '%s: _resolvePricing(bare tier alias) resolves to the same row',
    (tier) => {
      expect(_resolvePricing(tier)).toEqual(getPricing(tier));
    },
  );

  it.each(TIERS)(
    '%s: the _PRICING compat view reshapes the same 4 columns, no literals',
    (tier) => {
      const row = getPricing(tier);
      expect(_PRICING[tier]).toEqual({
        input: row.input,
        output: row.output,
        cacheRead: row.cacheRead,
        // Historical key name; the compat view flattens 5m/1h down to the 5m
        // rate, which is exactly the limitation noted in (b) above.
        cacheWrite: row.cacheWrite5m,
      });
    },
  );
});

describe('pricing parity: catalog <-> usage receipt', () => {
  for (const [counter, column] of Object.entries(RECEIPT_COLUMN_BY_COUNTER)) {
    it.each(TIERS)(
      `%s: 1 MTok of ${counter} costs exactly the ${column} rate`,
      (tier) => {
        // Single-column probe: every other counter is absent (normalised to 0),
        // so the total IS that one column's per-MTok rate. A sum-only check
        // cannot tell a right total from two compensating column swaps.
        const priced = priceUsage({ [counter]: ONE_MTOK }, tier);
        expect(priced.total).toBe(getPricing(tier)[column]);
        expect(priced.pricing_version).toBe(PRICING_VERSION);
      },
    );
  }
});

describe('pricing parity: catalog <-> route hysteresis', () => {
  it.each(TIERS)(
    '%s: freshInputPrice/outputPrice are the catalog rates per TOKEN',
    (tier) => {
      // The real catalog module is passed as the injected `{getModel}` port —
      // a stub port would test the stub, not the parity.
      expect(freshInputPrice(catalog, tier) * ONE_MTOK).toBeCloseTo(
        getPricing(tier).input,
        9,
      );
      expect(outputPrice(catalog, tier) * ONE_MTOK).toBeCloseTo(
        getPricing(tier).output,
        9,
      );
    },
  );
});

describe('pricing parity: same input -> same tier', () => {
  it('every catalog id resolves to the same tier in cache-roi and the receipt', () => {
    const conflicts = TIERS.filter(
      (tier) =>
        _resolvePricing(MODELS[tier].id).tier !==
        resolveModelIdentity(MODELS[tier].id)?.tier,
    );
    expect(conflicts).toEqual([]);
  });

  it('they diverge ONLY off-catalog, by design: ledger fails closed, roll-up fails open', () => {
    // A retired id. The receipt is the ledger writer: an unknown id yields no
    // identity at all rather than a plausible guess, so no ledger row can carry
    // a price nobody verified. cache-roi is a session roll-up: it matches the
    // substring and keeps accounting. Both behaviours are correct FOR THEIR
    // MODULE — this `it` exists so a reader does not "fix" one to match the
    // other. See cache-roi.js#resolvePricing JSDoc.
    expect(resolveModelIdentity('claude-opus-4-8')).toBeNull();
    expect(_resolvePricing('claude-opus-4-8').tier).toBe('opus');

    // A non-Anthropic id: the receipt still refuses, cache-roi falls back to
    // UNKNOWN_FALLBACK_TIER ('sonnet'). The fallback picks a TIER; it never
    // invents a price, because the price still comes from the catalog row.
    expect(resolveModelIdentity('gpt-4')).toBeNull();
    expect(_resolvePricing('gpt-4').tier).toBe('sonnet');
  });
});

describe('pricing parity: version stamp', () => {
  it('cache-roi stamps the catalog PRICING_VERSION on every metric', () => {
    expect(computeCacheMetrics({}, 'opus').pricingVersion).toBe(PRICING_VERSION);
  });

  it('priceUsage stamps the catalog PRICING_VERSION on a priced result', () => {
    expect(priceUsage({}, 'opus').pricing_version).toBe(PRICING_VERSION);
  });

  it('the UNPRICED default of buildUsageReceipts stays "unresolved", not a date', async () => {
    // Pinned by tests/firewall/usage-receipt-schema-guard.test.js too. Repeated
    // here because this suite is where someone wiring a new consumer will look:
    // a version stamp on an unpriced row would claim a table was consulted.
    const main = '/fake/projects/slug/sess-parity.jsonl';
    const entry = {
      type: 'assistant',
      requestId: 'req-parity-1',
      timestamp: '2026-09-12T00:00:00.000Z',
      effort: 'high',
      message: {
        model: 'claude-opus-5',
        role: 'assistant',
        content: [{ type: 'text', text: 'x' }],
        usage: {
          input_tokens: 100,
          cache_read_input_tokens: 900,
          cache_creation_input_tokens: 50,
          output_tokens: 20,
        },
      },
    };
    const { receipts } = await buildUsageReceipts({
      transcriptPath: main,
      missionId: 'm-parity',
      readTranscript: (p) => {
        if (p !== main) throw new Error(`ENOENT ${p}`);
        return JSON.stringify(entry);
      },
      listSubagentTranscripts: () => [],
    });

    expect(receipts).toHaveLength(1);
    expect(receipts[0].cost).toEqual({
      total: null,
      pricing_version: PRICING_VERSION_UNRESOLVED,
    });
  });
});

describe('pricing parity: the two cost axes are different questions', () => {
  it('price ratio 2.0 (per-token, usage axis) and cost factor 2.6 (prediction axis) are not the same number', () => {
    // AXIS 1 — USAGE. 2.0 is the fable/opus ratio of an already-counted token.
    // True wherever tokens are counted after the fact: cache-roi's
    // savedCostUsd/spentCostUsd and the receipt's cost.total. MEASURED.
    expect(getPricing('fable').input / getPricing('opus').input).toBe(2);

    // AXIS 2 — PREDICTION. 2.6 multiplies a CONTENT-SIZE estimate made BEFORE
    // tokenization, so it folds in a tokenizer coefficient on top of the price
    // ratio. True in route-scorer#predictedCost and anywhere getCostFactor is
    // used to forecast spend. It is NOT the ratio of two invoices.
    expect(getCostFactor('fable')).toBeCloseTo(2.6, 10);
    expect(getCostFactor('fable')).toBe(2 * getTokenizerCoeff('fable'));

    // And the tokenizer half is UNMEASURED. opus and fable are documented as
    // sharing a tokenizer, which makes the shipped fable coefficient 1.3 a
    // carry-over — so 2.6 is an estimate pending the Wave 9
    // `tokenizer-rebaseline` measurement. This assertion is the tripwire: when
    // someone measures it and flips the flag, this line fails and forces the
    // 2.6 comments above to be revisited in the same commit.
    for (const tier of TIERS) {
      expect(MODELS[tier].tokenizerCoeffMeasured).toBe(false);
    }
  });
});

describe('pricing parity: measured flag keeps the pricing path live', () => {
  it.each(TIERS)('%s: priceMeasured is true', (tier) => {
    // priceUsage returns {total: null} for any tier whose row is not measured
    // (usage-receipt.js#priceUsage). So flipping one flag to false would not
    // fail the parity checks above by itself — it would silently stop pricing
    // that tier. This assertion is what makes that visible.
    expect(getPricing(tier).measured).toBe(true);
  });
});
