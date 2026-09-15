/**
 * `lib/mission/outcome-gate-census.js` — the Shadow metric for `outcome.md`.
 *
 * The number this fold produces is "of the missions that DECLARED completion,
 * how many would the artifact gates have stopped, and why". Two properties are
 * load-bearing and both are pinned here:
 *
 *   1. **An empty denominator is `null`, never 0.** A `blocked_ratio` of 0 reads
 *      as "nothing was blocked" — a measurement. `null` reads as "nothing was
 *      measured". Same rule, same reason as
 *      `lib/replay/session-coverage.js:218` (`coverage: ended.size === 0 ? null
 *      : …`), whose header spells out why a measuring tool must not report an
 *      absent observation as a zero.
 *   2. **The block-code vocabulary does not drift, and is not closed.** The
 *      module deliberately does NOT import `BlockCode` (L2 must not import L5),
 *      and since the leader ruling of 2026-09-15 it does not check the value
 *      against any list or shape either: the hook classifies cases the gates
 *      never see (a plan.md that is absent, one that will not parse) and those
 *      codes must be counted like any other. This suite imports the real enum
 *      and asserts every landed member survives the fold as its own key — so a
 *      new gate code lands here as a failure rather than silently never
 *      appearing in a census — and separately asserts that a code OUTSIDE the
 *      enum is counted rather than rejected.
 */

import { describe, expect, it } from 'vitest';

import {
  emptyOutcomeGateCensus,
  foldOutcomeGateCensus,
} from '../../lib/mission/outcome-gate-census.js';
import { BlockCode } from '../../lib/runtime/artifact-lifecycle-gates.js';

const CODES = Object.values(BlockCode);

function entry(n, over = {}) {
  return {
    missionId: `M-20260915-${String(n).padStart(3, '0')}`,
    declared: true,
    blockCode: null,
    wouldWrite: false,
    ...over,
  };
}

/**
 * 21 missions: one per block code (8), six that would write, three declared
 * whose write `plan()` produced no candidate for, and four never declared.
 */
function fixture() {
  const rows = [];
  let n = 0;
  for (const code of CODES) rows.push(entry((n += 1), { blockCode: code }));
  for (let i = 0; i < 6; i += 1) rows.push(entry((n += 1), { wouldWrite: true }));
  for (let i = 0; i < 3; i += 1) rows.push(entry((n += 1)));
  for (let i = 0; i < 4; i += 1) rows.push(entry((n += 1), { declared: false }));
  return rows;
}

describe('foldOutcomeGateCensus — counts', () => {
  it('counts missions, declarations, blocks and writes separately', () => {
    const census = foldOutcomeGateCensus(fixture());
    expect(census.missions).toBe(21);
    expect(census.declared).toBe(17);
    expect(census.blocked).toBe(8);
    expect(census.would_write).toBe(6);
  });

  it('divides blocks by declarations, not by missions', () => {
    const census = foldOutcomeGateCensus(fixture());
    expect(census.blocked_ratio).toBeCloseTo(8 / 17, 12);
    expect(census.blocked_ratio).not.toBeCloseTo(8 / 21, 6);
  });

  it('excludes undeclared missions from every count but the total', () => {
    const declaredOnly = fixture().filter((e) => e.declared);
    const full = foldOutcomeGateCensus(fixture());
    const trimmed = foldOutcomeGateCensus(declaredOnly);
    expect(trimmed.missions).toBe(17);
    expect(full.missions).toBe(21);
    for (const key of ['declared', 'blocked', 'would_write', 'blocked_ratio']) {
      expect(full[key]).toEqual(trimmed[key]);
    }
    expect(full.by_block_code).toEqual(trimmed.by_block_code);
  });

  it('counts a declared mission that produced no write as neither blocked nor writing', () => {
    const census = foldOutcomeGateCensus([entry(1), entry(2, { wouldWrite: true })]);
    expect(census.declared).toBe(2);
    expect(census.blocked).toBe(0);
    expect(census.would_write).toBe(1);
    expect(census.blocked_ratio).toBe(0);
  });
});

describe('foldOutcomeGateCensus — the empty denominator', () => {
  it('returns null, not 0, when nothing declared completion', () => {
    const census = foldOutcomeGateCensus([
      entry(1, { declared: false }),
      entry(2, { declared: false }),
    ]);
    expect(census.missions).toBe(2);
    expect(census.declared).toBe(0);
    expect(census.blocked_ratio).toBeNull();
    expect(census.blocked_ratio).not.toBe(0);
  });

  it('returns null for no entries at all', () => {
    expect(foldOutcomeGateCensus([]).blocked_ratio).toBeNull();
  });

  it('agrees with emptyOutcomeGateCensus on the zero shape', () => {
    expect(foldOutcomeGateCensus([])).toEqual(emptyOutcomeGateCensus());
    expect(emptyOutcomeGateCensus()).toEqual({
      missions: 0,
      declared: 0,
      blocked: 0,
      would_write: 0,
      by_block_code: {},
      blocked_ratio: null,
    });
  });

  it('hands back a fresh object each call', () => {
    const a = emptyOutcomeGateCensus();
    a.blocked = 99;
    expect(emptyOutcomeGateCensus().blocked).toBe(0);
  });
});

describe('foldOutcomeGateCensus — by_block_code', () => {
  it('carries every landed BlockCode member as its own key', () => {
    const census = foldOutcomeGateCensus(fixture());
    expect(CODES).toHaveLength(8);
    for (const code of CODES) expect(census.by_block_code[code]).toBe(1);
    expect(Object.keys(census.by_block_code)).toHaveLength(8);
  });

  it('omits codes nobody hit rather than emitting zeros', () => {
    const census = foldOutcomeGateCensus([
      entry(1, { blockCode: BlockCode.UNMEASURED_VERIFICATION }),
    ]);
    expect(census.by_block_code).toEqual({ UNMEASURED_VERIFICATION: 1 });
  });

  it('tallies repeats', () => {
    const rows = [1, 2, 3].map((n) =>
      entry(n, { blockCode: BlockCode.UNMEASURED_VERIFICATION }));
    rows.push(entry(4, { blockCode: BlockCode.PLAN_STALE }));
    const census = foldOutcomeGateCensus(rows);
    expect(census.by_block_code.UNMEASURED_VERIFICATION).toBe(3);
    expect(census.by_block_code.PLAN_STALE).toBe(1);
    expect(census.blocked).toBe(4);
  });

  it('orders keys the same way whatever order the entries arrived in', () => {
    const forward = fixture();
    const reversed = [...forward].reverse();
    expect(Object.keys(foldOutcomeGateCensus(reversed).by_block_code))
      .toEqual(Object.keys(foldOutcomeGateCensus(forward).by_block_code));
    expect(Object.keys(foldOutcomeGateCensus(forward).by_block_code))
      .toEqual([...CODES].sort());
  });

  it('serializes identically for the same counts in a different order', () => {
    const forward = fixture();
    const reversed = [...forward].reverse();
    expect(JSON.stringify(foldOutcomeGateCensus(reversed)))
      .toBe(JSON.stringify(foldOutcomeGateCensus(forward)));
  });

  it('never aliases the caller entries', () => {
    const rows = fixture();
    const census = foldOutcomeGateCensus(rows);
    rows[0].blockCode = 'MUTATED';
    expect(census.by_block_code.MUTATED).toBeUndefined();
  });
});

describe('foldOutcomeGateCensus — codes the gates never produce', () => {
  // Leader ruling, 2026-09-15: the hook classifies two cases BEFORE it calls
  // `plan()` — a mission whose plan.md/review.md is ABSENT (the emitter never
  // reached it, which is every live mission today) versus PRESENT BUT
  // UNPARSEABLE (an emitter defect). Neither is a `BlockCode`, both have to
  // reach `by_block_code`, and the names are the hook's to choose.
  const HOOK_CODES = ['ARTIFACT_ABSENT', 'ARTIFACT_BROKEN'];

  it('counts a code outside BlockCode rather than rejecting it', () => {
    const census = foldOutcomeGateCensus([entry(1, { blockCode: 'ARTIFACT_ABSENT' })]);
    expect(CODES).not.toContain('ARTIFACT_ABSENT');
    expect(census.by_block_code).toEqual({ ARTIFACT_ABSENT: 1 });
    expect(census.blocked).toBe(1);
    expect(census.blocked_ratio).toBe(1);
  });

  it('tallies hook codes and gate codes side by side, in one sorted key set', () => {
    const rows = [
      entry(1, { blockCode: HOOK_CODES[0] }),
      entry(2, { blockCode: HOOK_CODES[0] }),
      entry(3, { blockCode: HOOK_CODES[1] }),
      entry(4, { blockCode: BlockCode.UNMEASURED_VERIFICATION }),
      entry(5, { wouldWrite: true }),
    ];
    const census = foldOutcomeGateCensus(rows);
    expect(census.by_block_code).toEqual({
      ARTIFACT_ABSENT: 2,
      ARTIFACT_BROKEN: 1,
      UNMEASURED_VERIFICATION: 1,
    });
    expect(Object.keys(census.by_block_code)).toEqual([
      'ARTIFACT_ABSENT', 'ARTIFACT_BROKEN', 'UNMEASURED_VERIFICATION',
    ]);
    expect(census.blocked).toBe(4);
    expect(census.would_write).toBe(1);
    expect(census.blocked_ratio).toBeCloseTo(4 / 5, 12);
  });

  it('accepts whatever spelling the hook picks, since the names are still TBD', () => {
    const spellings = ['artifact_absent', 'artifact-absent', 'Artifact.Absent', 'x'];
    for (const code of spellings) {
      expect(foldOutcomeGateCensus([entry(1, { blockCode: code })]).by_block_code)
        .toEqual({ [code]: 1 });
    }
  });

  it('counts free text too — the closed vocabulary is the CALLER obligation', () => {
    // Pinned as a consequence, not as a feature. Any non-empty string is a key
    // now, so a code built from a path or a message would land in the census
    // and in whatever prints it. Nothing downstream of this fold can put that
    // back; the hook must pick from its own fixed list.
    const census = foldOutcomeGateCensus([entry(1, { blockCode: 'BLOCKED: /home/u/x' })]);
    expect(census.by_block_code).toEqual({ 'BLOCKED: /home/u/x': 1 });
  });
});

describe('foldOutcomeGateCensus — malformed input is a caller bug', () => {
  const bad = [
    ['a non-array', {}],
    ['null', null],
    ['undefined', undefined],
    ['a non-object entry', ['M-20260915-001']],
    ['a null entry', [null]],
    ['a missing missionId', [{ declared: true, blockCode: null, wouldWrite: false }]],
    ['an empty missionId', [entry(1, { missionId: '' })]],
    ['a non-string missionId', [entry(1, { missionId: 7 })]],
    ['a duplicate missionId', [entry(1), entry(1)]],
    ['a non-boolean declared', [entry(1, { declared: 'yes' })]],
    ['a missing declared', [{ missionId: 'M-1', blockCode: null, wouldWrite: false }]],
    ['a non-boolean wouldWrite', [entry(1, { wouldWrite: 1 })]],
    ['an undefined blockCode', [{ missionId: 'M-1', declared: true, wouldWrite: false }]],
    ['a non-string blockCode', [entry(1, { blockCode: 7 })]],
    ['an empty blockCode', [entry(1, { blockCode: '' })]],
    ['a block that would also write', [entry(1, { blockCode: BlockCode.PLAN_STALE, wouldWrite: true })]],
    ['an undeclared mission with a block code', [entry(1, { declared: false, blockCode: BlockCode.PLAN_STALE })]],
    ['an undeclared mission that would write', [entry(1, { declared: false, wouldWrite: true })]],
  ];

  for (const [label, value] of bad) {
    it(`throws TypeError on ${label}`, () => {
      expect(() => foldOutcomeGateCensus(value)).toThrow(TypeError);
    });
  }

  it('names the offending mission so the caller can find it', () => {
    expect(() => foldOutcomeGateCensus([entry(1), entry(2, { declared: 'yes' })]))
      .toThrow(/M-20260915-002/);
  });

  it('throws before producing a partial census', () => {
    let census;
    try {
      census = foldOutcomeGateCensus([entry(1, { wouldWrite: true }), entry(2, { declared: 1 })]);
    } catch {
      census = undefined;
    }
    expect(census).toBeUndefined();
  });
});
