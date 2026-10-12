/**
 * The Claude Haiku 5.5 price band in `lib/core/model-catalog.js`: the official page
 * prices the model per request by prompt length, and the catalog stores only the
 * "up to 100,000 tokens" list plus the boundary it applies to
 * (`priceMaxPromptTokens`, reported by `getPricing` as `maxPromptTokens`).
 *
 * WHY A FILE OF ITS OWN. `tests/core/model-catalog.test.js` pins the spec and price
 * table and is past the repo's 800-line standard; the band facts are owned here. The
 * five base columns of the haiku tier row and of the claude-haiku-4-5 row stay pinned
 * in the other file.
 *
 * WHAT THIS FILE CANNOT SEE
 *  1. WHETHER THE NUMBERS EQUAL THE PAGE. The over-100,000 list below was typed from
 *     the rows of the official pricing page fetched on 2026-10-12 ("Claude Haiku 5.5
 *     (for prompts over 100,000 tokens)"). No test re-reads the page (data policy:
 *     nothing here fetches anything).
 *  2. WHETHER A READER APPLIES THE BAND. The catalog does not store the second price
 *     list, so no reader can; the receipt writer only counts the requests over the
 *     boundary (`meta.overPriceBandRequests`, pinned in
 *     `tests/economics/usage-receipt.test.js`). cache-roi and the router price at the
 *     stored columns at any prompt length, which understates a request over the
 *     boundary by 5x. That is a known limitation of the catalog, not a property this
 *     file blesses.
 */

import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  getModel,
  getPricing,
  ID_PRICES,
  listTiers,
  PRICING_VERSION,
} from '../../lib/core/model-catalog.js';
import { getPricingAt, PRICING_HISTORY } from '../../lib/core/pricing-history.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const catalogSrc = await readFile(path.join(HERE, '..', '..', 'lib', 'core', 'model-catalog.js'), 'utf8');

/**
 * The page's "for prompts over 100,000 tokens" list for Claude Haiku 5.5, fetched
 * 2026-10-12: $0.50 in / $0.625 5m write / $1 1h write / $0.05 cache hit / $2.50 out.
 * Typed here and NOT stored in the catalog.
 */
const OVER_BAND = {
  input: 0.5,
  cacheWrite5m: 0.625,
  cacheWrite1h: 1,
  cacheRead: 0.05,
  output: 2.5,
};

describe('priceMaxPromptTokens (the prompt length a row\'s price columns apply to)', () => {
  it('is declared by every tier row and every ID_PRICES row, as a positive integer or null', () => {
    const rows = [
      ...listTiers().map((tier) => [`tier ${tier}`, getModel(tier)]),
      ...Object.entries(ID_PRICES).map(([id, row]) => [`id ${id}`, row]),
    ];
    expect(rows).toHaveLength(7);
    for (const [label, row] of rows) {
      expect(Object.hasOwn(row, 'priceMaxPromptTokens'), label).toBe(true);
      const value = row.priceMaxPromptTokens;
      expect(value === null || (Number.isInteger(value) && value > 0), label).toBe(true);
    }
  });

  it('is set only on the haiku tier row (100_000); every other row has one price at any length', () => {
    expect(Object.fromEntries(listTiers().map((tier) => [tier, getModel(tier).priceMaxPromptTokens])))
      .toEqual({ haiku: 100_000, sonnet: null, opus: null, fable: null });
    for (const [id, row] of Object.entries(ID_PRICES)) {
      expect(row.priceMaxPromptTokens, id).toBeNull();
    }
  });

  it('is reported by getPricing as maxPromptTokens: 100_000 for haiku, null for everything else', () => {
    for (const key of ['haiku', 'fast', 'claude-haiku-5-5']) {
      expect(getPricing(key).maxPromptTokens, key).toBe(100_000);
    }
    for (const key of ['sonnet', 'opus', 'fable', 'frontier', 'claude-sonnet-5-5', 'claude-opus-5',
      'claude-sonnet-5', 'claude-haiku-4-5']) {
      expect(getPricing(key).maxPromptTokens, key).toBeNull();
    }
  });

  it('is typed number|null in both JSDoc typedefs (MODELS and ID_PRICES)', () => {
    const typedefs = catalogSrc.match(/priceMaxPromptTokens: number\|null/g) ?? [];
    expect(typedefs).toHaveLength(2);
  });

  it('is not a price column: the frozen price history carries prices and nothing else', () => {
    expect(Object.keys(PRICING_HISTORY[PRICING_VERSION].tiers.haiku)).not.toContain('priceMaxPromptTokens');
    // A past stamp reports no band, like it reports no source; the current stamp is getPricing.
    expect(getPricingAt('2026-09-28', 'haiku')).not.toHaveProperty('maxPromptTokens');
    expect(getPricingAt(PRICING_VERSION, 'haiku')).toStrictEqual(getPricing('haiku'));
  });
});

describe('the stored Claude Haiku 5.5 columns are the "up to 100,000 tokens" list', () => {
  it('is 5x below the over-100,000 list on every column, which is the 5x the catalog and receipt docs quote', () => {
    const stored = getPricing('haiku');
    for (const [column, over] of Object.entries(OVER_BAND)) {
      expect(over / stored[column], column).toBeCloseTo(5, 10);
    }
  });

  it('keeps the cache columns at the standard multiples of input in both bands (1.25x, 2x, 0.1x)', () => {
    // So a break-even ratio computed from the stored columns holds above the
    // boundary too; only the absolute dollar figures change with the band.
    const stored = getPricing('haiku');
    for (const list of [stored, OVER_BAND]) {
      expect(list.cacheWrite5m / list.input).toBeCloseTo(1.25, 10);
      expect(list.cacheWrite1h / list.input).toBeCloseTo(2, 10);
      expect(list.cacheRead / list.input).toBeCloseTo(0.1, 10);
    }
  });
});
