/**
 * Contract for the PRICE-BAND line of `lib/economics/usage-table-render.js` - the
 * one line under the usage table that says how many requests of the current session
 * had a prompt over their model's price band (`meta.overPriceBandRequests` of
 * `buildUsageReceipts`, handed over as `live.over_price_band_requests` by
 * `scripts/ledger/usage-cost-table.mjs`).
 *
 * WHAT IS PINNED
 *  - the line says the count, WHAT IT COVERS (the current session's transcript only,
 *    a ledger receipt does not store it) and, when the count is above 0, that the cost
 *    of the model is a floor because those requests were priced at the lower list;
 *  - a measured 0 is printed as `0건` and claims no floor;
 *  - the line appears only when a live read put its receipts in the table
 *    (`status: 'ok'`) AND the block carries a real count. A count that was not
 *    measured (`null`, missing, not a non-negative integer) prints nothing, never a 0;
 *  - it sits under the live note, above the limit line that always closes the block,
 *    and not on a zero-row report.
 *
 * WHY A FILE OF ITS OWN. `tests/economics/usage-table-render.test.js` is past the
 * repo's 800-line standard (904 lines when this file was written).
 *
 * WHAT THIS FILE CANNOT SEE
 *  1. THAT THE SCRIPT HANDS THE COUNT OVER. The `live` blocks here are built by hand;
 *     `tests/ledger/usage-cost-table-price-band.test.js` runs the real script.
 *  2. THAT THE WORDING IS RIGHT. Only load-bearing tokens are pinned (the count, the
 *     scope, the storage limit, `하한`); a reworded sentence that keeps them stays green.
 *  3. WHICH MODEL THE COUNT BELONGS TO. The block carries one number for the session,
 *     not one per model, so the line cannot name the model whose cost is a floor.
 *
 * @module tests/economics/usage-table-render-price-band
 */

import { describe, expect, it } from 'vitest';
import { MODELS, tierForModelId } from '../../lib/core/model-catalog.js';
import { priceUsage } from '../../lib/economics/usage-receipt.js';
import { foldUsageTable } from '../../lib/economics/usage-table.js';
import { formatUsageTableMarkdown } from '../../lib/economics/usage-table-render.js';

const HAIKU = MODELS.haiku.id;
const SONNET = MODELS.sonnet.id;

const CTX = {
  measuredAt: '2026-10-13T02:30:00.000Z',
  ledgerPath: '/repo/.git/artibot/ledger.jsonl',
  ledgerState: 'ok',
};

function receipt({ session = 'S1', run = 'agent-a1', model = HAIKU } = {}) {
  const tier = tierForModelId(model) ?? 'haiku';
  const usage = {
    source: 'transcript',
    fresh_input_tokens: 1000,
    cached_input_tokens: 200000,
    cache_creation_tokens: 10000,
    output_tokens: 5000,
    thinking_tokens: 100,
    requests: 3,
  };
  return {
    v: 1,
    ts: '2026-10-13T00:05:00.000Z',
    event: 'usage.receipt',
    session_id: session,
    run_id: run,
    model,
    data: {
      run_id: run,
      model_identity: { tier, model_id: model },
      usage,
      timing: { started_at: '2026-10-13T00:00:00.000Z', completed_at: '2026-10-13T00:05:00.000Z', latency_ms: 300000 },
      cost: priceUsage(usage, tier, model),
    },
  };
}

/** A table with a banded model (haiku) and one without a band (sonnet). */
const table = () => foldUsageTable([
  receipt({ run: 'S1', model: SONNET }),
  receipt({ run: 'agent-a1', model: HAIKU }),
]);

/** A `live` block as `scripts/ledger/usage-cost-table.mjs` builds it, with a count of 3. */
const liveBlock = (o = {}) => ({
  requested: true,
  status: 'ok',
  session_id: '64753a4c-d89c-4ced-a076-9f1e0a2f2d55',
  files: 3,
  receipts: 4,
  unreadable_files: 0,
  replaced_ledger_receipts: 0,
  kept_ledger_receipts: null,
  unresolved_models: [],
  searched: null,
  over_price_band_requests: 3,
  ...o,
});

const lines = (md) => md.split('\n');
const bandLine = (md) => lines(md).find((l) => l.startsWith('- 가격 구간 초과 요청:'));
const render = (live) => formatUsageTableMarkdown(table(), { ...CTX, live });

describe('formatUsageTableMarkdown: the price-band line', () => {
  it('says how many requests were over a band, what the count covers, and that the model cost is a floor', () => {
    const line = bandLine(render(liveBlock({ over_price_band_requests: 3 })));

    expect(line).toBeDefined();
    expect(line).toContain('3건');
    expect(line).toContain('현재 세션 transcript');
    expect(line).toContain('원장 영수증은 이 수를 저장하지 않는다');
    expect(line).toContain('하한');
  });

  it('prints a measured 0 as 0건 and claims no floor', () => {
    const line = bandLine(render(liveBlock({ over_price_band_requests: 0 })));

    expect(line).toBeDefined();
    expect(line).toContain('0건');
    expect(line).toContain('현재 세션 transcript');
    expect(line).not.toContain('하한');
  });

  it('separates thousands like every other count', () => {
    expect(bandLine(render(liveBlock({ over_price_band_requests: 1234 })))).toContain('1,234건');
  });

  it('sits under the live note and above the limit line, which still closes the block', () => {
    const all = lines(render(liveBlock()));
    const band = all.findIndex((l) => l.startsWith('- 가격 구간 초과 요청:'));
    const liveNote = all.findIndex((l) => l.includes('64753a4c'));

    expect(band).toBeGreaterThan(all.findIndex((l) => l.includes('**합계**')));
    expect(band).toBeGreaterThan(liveNote);
    expect(band).toBeLessThan(all.findIndex((l) => l.includes('한계:')));
    expect(all.at(-1)).toMatch(/^- 한계:/);
    // One line, once.
    expect(all.filter((l) => l.includes('가격 구간 초과'))).toHaveLength(1);
  });

  it('leaves the live note beside it as it was', () => {
    const note = lines(render(liveBlock())).find((l) => l.includes('64753a4c'));

    expect(note).toContain('transcript 직접 집계');
    expect(note).toContain('영수증 4건(파일 3개)');
    expect(note).not.toContain('가격 구간');
  });
});

describe('formatUsageTableMarkdown: when the price-band line is not printed', () => {
  it.each([
    'incomplete', 'empty', 'not-found', 'blank-session-id', 'invalid-session-id', 'read-failed',
  ])('prints nothing when the live read is %s, even with a number on the block', (status) => {
    // Only a read that put its receipts in the table says anything about the table.
    expect(bandLine(render(liveBlock({ status, over_price_band_requests: 5 })))).toBeUndefined();
  });

  it.each([
    ['no live block', undefined],
    ['a null live block', null],
    ['a live block that was not requested', { requested: false }],
  ])('prints nothing with %s', (_label, live) => {
    expect(bandLine(render(live))).toBeUndefined();
  });

  it.each([
    ['missing', undefined],
    ['null (nothing was counted)', null],
    ['negative', -1],
    ['fractional', 1.5],
    ['a string', '3'],
    ['NaN', Number.NaN],
  ])('prints nothing, not a 0, when the count is %s', (_label, count) => {
    const md = render(liveBlock({ over_price_band_requests: count }));

    expect(bandLine(md)).toBeUndefined();
    expect(md).not.toContain('가격 구간 초과');
  });

  it('prints nothing on a zero-row report: there is no table for the count to qualify', () => {
    const md = formatUsageTableMarkdown(foldUsageTable([]), { ...CTX, live: liveBlock() });

    expect(md).toContain('영수증 0행');
    expect(bandLine(md)).toBeUndefined();
  });
});
