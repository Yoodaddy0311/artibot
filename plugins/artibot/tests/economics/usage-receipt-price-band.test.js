/**
 * Prompt-band accounting in `lib/economics/usage-receipt.js`: Claude Haiku 5.5 is
 * priced by prompt length (a request whose prompt is over 100,000 tokens pays 5x
 * every column), the catalog stores only the lower list and the boundary, and the
 * receipt writer COUNTS the requests over the boundary in
 * `meta.overPriceBandRequests`. It does not re-price them.
 *
 * WHY A FILE OF ITS OWN. `tests/economics/usage-receipt.test.js` is past the repo's
 * 800-line standard. Every fixture here is synthesized, as there.
 *
 * WHAT THIS FILE CANNOT SEE
 *  1. THAT THE COUNT IS PERSISTED OR SURFACED. It is a call-time statistic: the two
 *     callers of `buildUsageReceipts` (`scripts/hooks/session-end.js`,
 *     `scripts/ledger/usage-cost-table.mjs`) store none of it, so no ledger row has
 *     it. `usage-cost-table.mjs` prints it for a `--live-session` read (pinned in
 *     `tests/ledger/usage-cost-table-price-band.test.js`); `session-end.js` does not
 *     read it. A green run here says the writer counts correctly, not that anyone is
 *     told.
 *  2. THAT A COUNTED REQUEST WAS BILLED AT THE HIGHER LIST. The 100,000 boundary and
 *     the 5x factor come from the official pricing page as read on 2026-10-12 (see
 *     `tests/core/model-catalog-price-band.test.js`); no test re-reads the page, and the
 *     transcript carries no cost field to compare with.
 *  3. THAT A TRANSCRIPT ENTRY IS ONE API REQUEST. Entries repeating a `requestId` are
 *     de-duplicated before counting, as the other counters do; an entry without a
 *     `requestId` is counted on its own.
 */

import { describe, expect, it } from 'vitest';

import { PRICING_VERSION } from '../../lib/core/model-catalog.js';
import {
  buildUsageReceipts,
  emptyResult,
  priceUsage,
} from '../../lib/economics/usage-receipt.js';

const MAIN = '/fake/projects/slug/sess-band.jsonl';
const SUB = '/fake/projects/slug/sess-band/subagents/agent-band1.jsonl';

/** One assistant transcript entry; `usage` overrides are shallow-merged. */
function entry({ model = 'claude-haiku-5-5', requestId = 'req-1', usage = {} } = {}) {
  return {
    type: 'assistant',
    requestId,
    timestamp: '2026-10-12T06:00:00.000Z',
    effort: 'medium',
    message: {
      model,
      role: 'assistant',
      content: [{ type: 'text', text: 'x' }],
      usage: {
        input_tokens: 100,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        output_tokens: 20,
        ...usage,
      },
    },
  };
}

const jsonl = (entries) => entries.map((e) => JSON.stringify(e)).join('\n');

/** Fold a main-thread transcript (and optionally one subagent file) in memory. */
function fold(main, subagent = []) {
  return buildUsageReceipts({
    transcriptPath: MAIN,
    missionId: 'm-band',
    readTranscript: (p) => {
      if (p === MAIN) return jsonl(main);
      if (p === SUB) return jsonl(subagent);
      throw new Error(`ENOENT ${p}`);
    },
    listSubagentTranscripts: () => (subagent.length > 0 ? [SUB] : []),
  });
}

/** Over-band count of one Haiku 5.5 request with the given usage. */
async function overBand(usage, model = 'claude-haiku-5-5') {
  const { meta } = await fold([entry({ model, usage })]);
  return meta.overPriceBandRequests;
}

describe('meta.overPriceBandRequests', () => {
  it('is part of the empty result shape, at zero', () => {
    expect(emptyResult().meta.overPriceBandRequests).toBe(0);
  });

  it('counts a Haiku 5.5 request whose prompt is 100,001 tokens, not one of exactly 100,000', async () => {
    expect(await overBand({ input_tokens: 100_000 })).toBe(0);
    expect(await overBand({ input_tokens: 100_001 })).toBe(1);
  });

  it('counts the prompt as input + cache reads + cache writes together', async () => {
    // A request that is almost all cache hits is still a long prompt (the page: "a
    // request over the threshold pays the higher prices even when part of its prompt
    // is a cache hit").
    const parts = (cacheCreation) => ({
      input_tokens: 40_000,
      cache_read_input_tokens: 40_000,
      cache_creation_input_tokens: cacheCreation,
    });
    expect(await overBand(parts(20_000))).toBe(0);
    expect(await overBand(parts(20_001))).toBe(1);
    expect(await overBand({ input_tokens: 10, cache_read_input_tokens: 100_000 })).toBe(1);
    expect(await overBand({ input_tokens: 0, cache_creation_input_tokens: 100_001 })).toBe(1);
    // Output tokens are not part of the prompt.
    expect(await overBand({ input_tokens: 1, output_tokens: 500_000 })).toBe(0);
  });

  it('counts requests, not receipts: a repeated requestId once, a subagent file too', async () => {
    const long = { input_tokens: 150_000 };
    const { receipts, meta } = await fold(
      [
        entry({ requestId: 'req-a', usage: long }),
        entry({ requestId: 'req-a', usage: long }),
        entry({ requestId: 'req-b', usage: { input_tokens: 99_999 } }),
        entry({ requestId: 'req-c', usage: { input_tokens: 100_001 } }),
      ],
      [entry({ requestId: 'req-d', usage: { input_tokens: 250_000 } })],
    );
    expect(meta.duplicateRequestIds).toBe(1);
    expect(receipts).toHaveLength(2);
    expect(meta.overPriceBandRequests).toBe(3);
  });

  it('never counts a model that has one price at any prompt length', async () => {
    const huge = { input_tokens: 500_000 };
    expect(await overBand(huge, 'claude-haiku-4-5')).toBe(0);
    expect(await overBand(huge, 'claude-haiku-4-5-20251001')).toBe(0);
    for (const model of ['claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5', 'claude-fable-5-1']) {
      expect(await overBand(huge, model), model).toBe(0);
    }
  });

  it('does not change a receipt: the same schema keys, priced at the stored (up to 100,000) columns', async () => {
    // KNOWN LIMITATION, pinned so a change of it is deliberate: the page bills a
    // request over the boundary at 5x every column, and the writer prices it at the
    // stored ones, so this total is a lower bound. attempt-receipt.schema.json has
    // additionalProperties:false on `usage`, hence no field for the count.
    const inBand = (await fold([entry({ usage: { input_tokens: 50_000, output_tokens: 1_000 } })])).receipts[0];
    const over = await fold([entry({ usage: { input_tokens: 150_000, output_tokens: 1_000 } })]);
    expect(over.meta.overPriceBandRequests).toBe(1);
    const [receipt] = over.receipts;
    expect(Object.keys(receipt).sort()).toEqual(Object.keys(inBand).sort());
    expect(Object.keys(receipt.usage).sort()).toEqual(Object.keys(inBand.usage).sort());
    expect(Object.keys(receipt.cost).sort()).toEqual(Object.keys(inBand.cost).sort());
    expect(receipt.cost.pricing_version).toBe(PRICING_VERSION);
    // 150,000 x $0.10 + 1,000 x $0.50, per MTok.
    expect(receipt.cost.total).toBeCloseTo(0.015 + 0.0005, 10);
  });
});

describe('the two haiku ids are priced per id', () => {
  const usage = {
    fresh_input_tokens: 50_000,
    cached_input_tokens: 0,
    cache_creation_tokens: 0,
    output_tokens: 50_000,
  };

  it('prices claude-haiku-4-5 at $1 in / $5 out', () => {
    // 50,000 x $1 + 50,000 x $5, per MTok = 0.05 + 0.25.
    expect(priceUsage(usage, 'haiku', 'claude-haiku-4-5').total).toBeCloseTo(0.3, 10);
  });

  it('prices claude-haiku-5-5 at $0.10 in / $0.50 out, and so does the tier alone', () => {
    // 50,000 x $0.10 + 50,000 x $0.50, per MTok = 0.005 + 0.025.
    expect(priceUsage(usage, 'haiku', 'claude-haiku-5-5').total).toBeCloseTo(0.03, 10);
    expect(priceUsage(usage, 'haiku').total).toBeCloseTo(0.03, 10);
  });

  it('prices a built receipt by the model id its transcript named, snapshot suffix or not', async () => {
    const old = await fold([
      entry({ model: 'claude-haiku-4-5-20251001', usage: { input_tokens: 50_000, output_tokens: 50_000 } }),
    ]);
    const current = await fold([
      entry({ model: 'claude-haiku-5-5', usage: { input_tokens: 50_000, output_tokens: 50_000 } }),
    ]);
    expect(old.receipts[0].model_identity).toMatchObject({
      tier: 'haiku', model_id: 'claude-haiku-4-5', version: '20251001',
    });
    expect(current.receipts[0].model_identity).toMatchObject({
      tier: 'haiku', model_id: 'claude-haiku-5-5', version: 'claude-haiku-5-5',
    });
    expect(old.receipts[0].cost.total).toBeCloseTo(0.3, 10);
    expect(current.receipts[0].cost.total).toBeCloseTo(0.03, 10);
    expect(old.meta.unresolvedModels).toEqual({});
    expect(current.meta.unresolvedModels).toEqual({});
  });
});
