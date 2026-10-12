/**
 * The Claude Sonnet 5.5 cache read cut in `lib/core/model-catalog.js`: $0.20 to
 * $0.10 per MTok (announced in the 2026-10-07 release note, entered under the
 * 2026-10-12 PRICING_VERSION stamp).
 *
 * WHY A FILE OF ITS OWN. `tests/core/model-catalog.test.js` pins the spec and price
 * table and sits at the repo's 800-line standard. The pin that says WHY sonnet is a
 * 0.05x cache-read row (and its legacy id is not) is owned here. The five base
 * columns of every row stay pinned in the other file.
 *
 * WHAT THIS FILE CANNOT SEE
 *  1. WHETHER THE NUMBERS EQUAL THE PAGE. They were typed from the rows of the
 *     official pricing page fetched on 2026-10-12 ("Claude Sonnet 5.5", "Claude
 *     Sonnet 5"). No test re-reads the page (data policy: nothing here fetches
 *     anything).
 */

import { describe, expect, it } from 'vitest';
import { getModel, getPricing } from '../../lib/core/model-catalog.js';

describe('sonnet cache reads (cut from $0.20 to $0.10 per MTok on 2026-10-07)', () => {
  it('are 0.05x input like opus, NOT the usual 0.1x', () => {
    // Official footnote 2 covers Claude Opus 5.5 and Claude Sonnet 5.5: "Cache hits
    // and refreshes ... are priced at 0.05x the base input price". The stamp
    // 2026-09-28 row still carries 0.2 (tests/core/pricing-history.test.js freezes
    // it); a "fix" back to the standard 0.1x of input would restore 0.2.
    const sonnet = getModel('sonnet');
    expect(sonnet.priceCacheReadPerMTok).toBe(0.1);
    expect(sonnet.priceCacheReadPerMTok).toBeCloseTo(0.05 * sonnet.priceInPerMTok, 10);
    expect(sonnet.priceCacheReadPerMTok).not.toBeCloseTo(0.1 * sonnet.priceInPerMTok, 10);
  });

  it('did not move for the legacy id claude-sonnet-5, which keeps the standard 0.1x', () => {
    const legacy = getPricing('claude-sonnet-5');
    expect(legacy.cacheRead).toBe(0.2);
    expect(legacy.cacheRead).toBeCloseTo(0.1 * legacy.input, 10);
  });
});
