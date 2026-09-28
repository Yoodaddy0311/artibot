/**
 * Unit contract for the fold stages that run before `foldOversized`
 * (lib/runtime/ledger-fold.js).
 *
 * Measures lines with the writer's own `lineBytes`, so a byte asserted here is
 * a byte the writer would count. The end-to-end boundary fixtures — sized from
 * lines actually appended, redaction included — live in
 * tests/runtime/event-writer.test.js.
 *
 * ── WHAT THIS SUITE CANNOT SEE (rules §9) ───────────────────────────────────
 *   - WHICH LIVE EVENTS REACH THE FOLD. Every envelope below is invented; how
 *     often a real line is over the cap is a ledger measurement, not a test.
 *   - THE FALLBACK. A null from shrinkToFit hands the line to
 *     `event-writer.js#foldOversized`; that hand-off is exercised through
 *     writeEvent in tests/runtime/event-writer.test.js, not here.
 *
 * @module tests/runtime/ledger-fold
 */

import { describe, expect, it } from 'vitest';
import { lineBytes } from '../../lib/runtime/event-writer.js';
import { FOLD_MARKER_MAX, shrinkToFit } from '../../lib/runtime/ledger-fold.js';

const FIELD = 'evidence_refs';
const SPEC = {
  required: ['kind'],
  fields: { kind: { type: 'string' }, note: { type: 'string' }, evidence_refs: { type: 'array' } },
};
const UNCHANGED = { folded: false, dropped: [], truncated: null };

/** @returns {object} a minimal envelope carrying `data` */
function env(data) {
  return { v: 1, event: 'x.y', data };
}

/** @returns {import('../../lib/runtime/ledger-fold.js').FoldResult|null} */
function shrink(e, maxLineBytes, spec = SPEC, overflowField = FIELD) {
  return shrinkToFit(e, spec, { maxLineBytes, overflowField, measure: lineBytes });
}

/** @returns {string} the stage 2 marker */
function cut(kept, total) {
  return `ledger-fold:${FIELD}-truncated=kept${kept}/total${total}`;
}

describe('shrinkToFit — within the cap', () => {
  it('returns the same envelope, unfolded', () => {
    const e = env({ kind: 'k', extra: 'x', evidence_refs: ['a'] });
    const out = shrink(e, lineBytes(e));
    expect(out).toEqual({ env: e, ...UNCHANGED });
    expect(out.env).toBe(e);
  });
});

describe('shrinkToFit — stage 1, undeclared keys', () => {
  it('drops only undeclared keys when that is enough, and counts them', () => {
    const e = env({ kind: 'k', note: 'n', extra: 'x'.repeat(500), evidence_refs: ['a'] });
    const out = shrink(e, 300);
    expect(out.folded).toBe(true);
    expect(out.dropped).toEqual(['extra']);
    expect(out.truncated).toBeNull();
    expect(out.env.data).toEqual({ kind: 'k', note: 'n', evidence_refs: ['a', 'ledger-fold:dropped=extra'] });
  });

  it('creates the overflow array for its marker when there was none', () => {
    const out = shrink(env({ kind: 'k', extra: 'x'.repeat(500) }), 300);
    expect(out.env.data.evidence_refs).toEqual(['ledger-fold:dropped=extra']);
  });
});

describe('shrinkToFit — stage 2, prefix of the overflow array', () => {
  it('keeps the longest prefix that fits, every declared key intact', () => {
    const refs = Array.from({ length: 10 }, (_, i) => `ref-${i}-${'r'.repeat(20)}`);
    const e = env({ kind: 'k', note: 'kept', evidence_refs: refs });
    const cap = lineBytes(e) - 60;
    const out = shrink(e, cap);
    const { kept } = out.truncated;
    expect(out).toMatchObject({ folded: true, dropped: [], truncated: { field: FIELD, total: 10 } });
    expect(out.env.data).toEqual({
      kind: 'k', note: 'kept', evidence_refs: [...refs.slice(0, kept), cut(kept, 10)],
    });
    expect(lineBytes(out.env)).toBeLessThanOrEqual(cap);
    const oneMore = env({ ...e.data, evidence_refs: [...refs.slice(0, kept + 1), cut(kept + 1, 10)] });
    expect(lineBytes(oneMore)).toBeGreaterThan(cap);
  });

  it('cuts one giant element whole rather than splitting it', () => {
    const out = shrink(env({ kind: 'k', note: 'kept', evidence_refs: ['g'.repeat(5000)] }), 400);
    expect(out.truncated).toEqual({ field: FIELD, kept: 0, total: 1 });
    expect(out.env.data.evidence_refs).toEqual([cut(0, 1)]);
  });

  it('runs after stage 1 and keeps its dropped marker last', () => {
    const refs = Array.from({ length: 30 }, (_, i) => `ref-${i}-${'r'.repeat(40)}`);
    const out = shrink(env({ kind: 'k', extra: 'x', evidence_refs: refs }), 600);
    expect(out.dropped).toEqual(['extra']);
    expect(out.truncated.total).toBe(30);
    const tail = out.env.data.evidence_refs.slice(-2);
    expect(tail).toEqual([cut(out.truncated.kept, 30), 'ledger-fold:dropped=extra']);
  });

  it('never cuts an earlier truncation marker and leaves it out of the total', () => {
    const earlier = 'someone:refs-truncated=kept5/total77';
    const refs = [...Array.from({ length: 5 }, (_, i) => `ref-${i}-${'r'.repeat(80)}`), earlier];
    const out = shrink(env({ kind: 'k', evidence_refs: refs }), 300);
    expect(out.truncated.total).toBe(5);
    expect(out.env.data.evidence_refs.slice(-2)).toEqual([earlier, cut(out.truncated.kept, 5)]);
  });

  it('does not pin a string that merely ends like a marker but is longer than one', () => {
    const long = `${'z'.repeat(FOLD_MARKER_MAX)}truncated=kept1/total2`;
    const out = shrink(env({ kind: 'k', evidence_refs: [long] }), 200);
    expect(out.truncated).toEqual({ field: FIELD, kept: 0, total: 1 });
  });

  it('takes stage 2 exactly when its marker alone fits, across a sweep of caps', () => {
    const refs = Array.from({ length: 40 }, (_, i) => `r${i}:${'x'.repeat(i * 7)}`);
    const e = env({ kind: 'k', note: 'n'.repeat(300), evidence_refs: refs });
    const markerOnly = env({ ...e.data, evidence_refs: [cut(0, 40)] });
    let truncatedCount = 0;
    for (let cap = 200; cap < lineBytes(e); cap += 37) {
      const out = shrink(e, cap);
      expect(out !== null).toBe(lineBytes(markerOnly) <= cap);
      if (out) {
        truncatedCount += 1;
        expect(lineBytes(out.env)).toBeLessThanOrEqual(cap);
        expect(out.env.data.note).toBe(e.data.note);
      }
    }
    expect(truncatedCount).toBeGreaterThan(10);
  });
});

describe('shrinkToFit — hands the line to foldOversized (null)', () => {
  it('when the marker alone does not fit beside the declared keys', () => {
    expect(shrink(env({ kind: 'k', note: 'n'.repeat(5000), evidence_refs: ['a'] }), 400)).toBeNull();
  });

  it('when stage 1 is not enough and there is no array to cut', () => {
    expect(shrink(env({ kind: 'k', note: 'n'.repeat(5000), extra: 'x' }), 400)).toBeNull();
  });

  it('for a data_schema event', () => {
    const e = env({ junk: 'z'.repeat(5000), evidence_refs: ['a', 'b'] });
    expect(shrink(e, 400, { data_schema: 'usage-receipt.schema.json' })).toBeNull();
  });

  it('when the overflow field holds something other than an array', () => {
    expect(shrink(env({ kind: 'k', evidence_refs: 'e'.repeat(5000) }), 400)).toBeNull();
  });

  it('when the allowlist names no overflow field', () => {
    const e = env({ kind: 'k', extra: 'x'.repeat(5000), evidence_refs: ['a'] });
    for (const overflowField of [undefined, '', 7]) {
      expect(shrinkToFit(e, SPEC, { maxLineBytes: 400, overflowField, measure: lineBytes }))
        .toBeNull();
    }
  });
});

describe('shrinkToFit — purity', () => {
  it('leaves the input envelope unmodified', () => {
    const data = { kind: 'k', note: 'n', extra: 'x'.repeat(300), evidence_refs: ['a', 'b'] };
    const before = JSON.stringify(data);
    shrink(env(data), 120);
    shrink(env(data), 60);
    expect(JSON.stringify(data)).toBe(before);
  });
});
