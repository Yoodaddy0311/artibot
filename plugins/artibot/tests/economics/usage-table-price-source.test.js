/**
 * Contract for the price SOURCE that `lib/economics/usage-table.js` carries to the
 * table: `pricing.models[].price_source`, the catalog's `priceSource` of the row
 * that prices each model, in the table's snake_case.
 *
 * WHY A FILE OF ITS OWN. `tests/economics/usage-table.test.js` pins the fold's
 * counting and pricing; this is one added field on the pricing block. It is also
 * the field `usage-table-render.js` reads, so the renderer's per-model source line
 * is only as good as what these cases pin.
 *
 * WHAT IS PINNED
 * ---------------------------------------------------------------------------
 *  - each model's `price_source` is the catalog's record for the row that prices
 *    it (`getPricing(id).source`): a current id its tier row, `claude-opus-5` its
 *    own ID_PRICES row;
 *  - a model the catalog does not know, or whose row records no source, has
 *    `price_source: null` — never a guess, never a thrown error;
 *  - the block is a COPY: a caller that holds or mutates it cannot reach the
 *    frozen catalog;
 *  - nothing else in the pricing block moved (`per_mtok`, `price_status`).
 *
 * WHAT THIS FILE CANNOT SEE
 * ---------------------------------------------------------------------------
 *  - WHETHER THE CATALOG'S RECORD IS TRUE. The kind, label and date are typed by
 *    whoever edits the catalog (see tests/core/model-catalog.test.js 'priceSource');
 *    this file proves the table carries that record faithfully.
 *  - ANY PAST PRICE STAMP. The block describes the CURRENT catalog row, like
 *    `per_mtok` does; a receipt recorded under an older stamp is not re-sourced.
 *
 * @module tests/economics/usage-table-price-source
 */

import { describe, expect, it } from 'vitest';
import { getPricing, ID_PRICES, MODELS, tierForModelId } from '../../lib/core/model-catalog.js';
import { priceUsage } from '../../lib/economics/usage-receipt.js';
import { foldUsageTable } from '../../lib/economics/usage-table.js';

const HAIKU = MODELS.haiku.id;
const SONNET = MODELS.sonnet.id;
const OPUS = MODELS.opus.id;
const OPUS_LEGACY = MODELS.opus.legacyIds[0];
const FABLE = MODELS.fable.id;

/** One measured `usage.receipt` ledger line for `model`, priced the way the writer prices it. */
function receipt(model, run) {
  const tier = tierForModelId(model) ?? 'opus';
  const usage = {
    source: 'transcript',
    fresh_input_tokens: 1000,
    cached_input_tokens: 0,
    cache_creation_tokens: 0,
    output_tokens: 100,
    thinking_tokens: 0,
    requests: 1,
  };
  return {
    v: 1,
    ts: '2026-09-30T00:05:00.000Z',
    event: 'usage.receipt',
    session_id: 'S1',
    run_id: run,
    model,
    data: {
      run_id: run,
      model_identity: { tier, model_id: model },
      usage,
      timing: { started_at: '2026-09-30T00:00:00.000Z', completed_at: '2026-09-30T00:05:00.000Z', latency_ms: 300000 },
      cost: priceUsage(usage, tier, model),
    },
  };
}

const foldOf = (models, options) => foldUsageTable(models.map((m, i) => receipt(m, `agent-${i}`)), options);
const entryOf = (table, id) => table.pricing.models.find((m) => m.model_id === id);

/** The catalog's camelCase record as the table spells it. */
const snake = (source) => ({
  kind: source.kind,
  ref: source.ref,
  checked_at: source.checkedAt,
  derived_columns: [...source.derivedColumns],
});

describe('pricing.models[].price_source', () => {
  it('is the catalog source of the row that prices each model', () => {
    const table = foldOf([HAIKU, SONNET, OPUS, OPUS_LEGACY, FABLE]);

    for (const id of [HAIKU, SONNET, OPUS, OPUS_LEGACY, FABLE]) {
      expect(entryOf(table, id).price_source, id).toEqual(snake(getPricing(id).source));
    }
    // The two rows that differ in KIND: sonnet reads the skill table and computes its cache writes.
    expect(entryOf(table, SONNET).price_source.kind).toBe('skill-table');
    expect(entryOf(table, SONNET).price_source.derived_columns).toEqual(MODELS.sonnet.priceSource.derivedColumns);
    expect(entryOf(table, OPUS).price_source.kind).toBe('official-table');
    expect(entryOf(table, OPUS).price_source.derived_columns).toEqual([]);
  });

  it('reads a legacy id from its own ID_PRICES row, not from its tier', () => {
    const table = foldOf([OPUS_LEGACY]);
    expect(entryOf(table, OPUS_LEGACY).price_source).toEqual(snake(ID_PRICES[OPUS_LEGACY].priceSource));
  });

  it('is null for a model the catalog does not know, exactly where per_mtok is null', () => {
    const table = foldOf(['claude-mystery-9', OPUS]);
    const unknown = entryOf(table, 'claude-mystery-9');

    expect(unknown.per_mtok).toBeNull();
    expect(unknown.price_source).toBeNull();
    expect(entryOf(table, OPUS).price_source).not.toBeNull();
  });

  it('is null, and never throws, when the catalog row records no source or a malformed one', () => {
    const malformed = [
      null, undefined, 'official-table', 42, [], ['official-table'],
      // An object that is not a whole record: a source with no kind, label or date says nothing.
      {},
      { kind: 'official-table' },
      { kind: 'official-table', ref: 'x' },
      { kind: 'official-table', ref: '', checkedAt: '2026-09-28', derivedColumns: [] },
      { kind: 7, ref: 'x', checkedAt: '2026-09-28', derivedColumns: [] },
    ];
    for (const source of malformed) {
      const ports = {
        getPricing: (key) => {
          const real = getPricing(key);
          return real === null ? null : { ...real, source };
        },
      };
      const table = foldOf([OPUS], { ports });
      expect(entryOf(table, OPUS).price_source, JSON.stringify(source)).toBeNull();
      // The rest of the row is untouched: the source is additive information, not a price input.
      expect(entryOf(table, OPUS).price_status).toBe('verified');
      expect(entryOf(table, OPUS).per_mtok).not.toBeNull();
    }
  });

  it('is a copy: holding or mutating it cannot reach the frozen catalog', () => {
    const table = foldOf([SONNET]);
    const block = entryOf(table, SONNET).price_source;

    expect(Object.isFrozen(block)).toBe(false);
    expect(Object.isFrozen(block.derived_columns)).toBe(false);
    expect(block.derived_columns).not.toBe(MODELS.sonnet.priceSource.derivedColumns);
    block.derived_columns.push('mutated');
    block.kind = 'mutated';
    expect(MODELS.sonnet.priceSource.derivedColumns).not.toContain('mutated');
    expect(MODELS.sonnet.priceSource.kind).toBe('skill-table');
  });

  it('survives a JSON round trip and leaves the rest of the pricing block as it was', () => {
    const table = foldOf([OPUS, SONNET]);
    expect(JSON.parse(JSON.stringify(table.pricing))).toEqual(table.pricing);
    expect(Object.keys(entryOf(table, OPUS)).sort()).toEqual(
      ['id_status', 'model_id', 'per_mtok', 'price_source', 'price_status', 'tier'],
    );
    expect(entryOf(table, OPUS).per_mtok).toEqual({
      input: getPricing(OPUS).input,
      output: getPricing(OPUS).output,
      cache_read: getPricing(OPUS).cacheRead,
      cache_write_5m: getPricing(OPUS).cacheWrite5m,
    });
  });

  it('does not depend on the order the receipts arrive in', () => {
    const events = [HAIKU, SONNET, OPUS, FABLE].map((m, i) => receipt(m, `agent-${i}`));
    const forward = foldUsageTable(events);
    const backward = foldUsageTable([...events].reverse());
    expect(JSON.stringify(backward.pricing)).toBe(JSON.stringify(forward.pricing));
  });
});
