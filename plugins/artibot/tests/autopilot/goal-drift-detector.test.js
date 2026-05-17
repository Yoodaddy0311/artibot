/**
 * Unit tests for lib/autopilot/goal-drift-detector.js
 *
 * Covers:
 *   - extractGoalFields: deliverables[], requiredFiles[], stoppingCondition file:<path>
 *   - extractGoalFields: null / non-object → empty set
 *   - extractPhaseFields: deliverables[], changedFiles[], artifacts[]
 *   - canonicalization (case, spaces, underscores)
 *   - computeDrift: perfect match → 0%
 *   - computeDrift: half missing → 50%
 *   - computeDrift: full miss → 100%
 *   - computeDrift: empty goal + extras → 100% (pure scope creep)
 *   - computeDrift: empty goal + empty actuals → 0%
 *   - computeDrift: scope creep flagged in `extra`
 *   - computeDrift: pre-extracted Set input also accepted
 *   - computeDrift: sorts missing/extra/inScope deterministically
 *   - computeDrift: handles array of phase outputs (merge)
 */
import { describe, expect, it } from 'vitest';
import {
  computeDrift,
  extractGoalFields,
  extractPhaseFields,
} from '../../lib/autopilot/goal-drift-detector.js';

describe('extractGoalFields', () => {
  it('returns empty Set for null / non-object input', () => {
    expect(extractGoalFields(null).size).toBe(0);
    expect(extractGoalFields(undefined).size).toBe(0);
    expect(extractGoalFields('contract').size).toBe(0);
    expect(extractGoalFields(42).size).toBe(0);
  });

  it('collects deliverables[] and requiredFiles[]', () => {
    const set = extractGoalFields({
      deliverables: ['lib/foo.js', 'lib/bar.js'],
      requiredFiles: ['tests/foo.test.js'],
    });
    expect(set.has('lib/foo.js'.toLowerCase().replace(/[\s_.-]+/g, '-'))).toBe(true);
    expect(set.size).toBe(3);
  });

  it('canonicalizes case + underscores + spaces', () => {
    const set = extractGoalFields({
      deliverables: ['Lib Foo', 'lib_foo', 'LIB-FOO'],
    });
    expect(set.size).toBe(1);
  });

  it('extracts paths from stoppingCondition "file: <path>" matches', () => {
    const set = extractGoalFields({
      stoppingCondition: 'when file: lib/x.js exists AND file: tests/x.test.js exists',
    });
    expect(set.size).toBe(2);
  });

  it('ignores non-string entries in deliverables', () => {
    const set = extractGoalFields({
      deliverables: ['lib/a.js', null, 42, { foo: 'bar' }],
    });
    expect(set.size).toBe(1);
  });
});

describe('extractPhaseFields', () => {
  it('returns empty Set for null / non-object input', () => {
    expect(extractPhaseFields(null).size).toBe(0);
    expect(extractPhaseFields(7).size).toBe(0);
  });

  it('collects deliverables + changedFiles + artifacts', () => {
    const set = extractPhaseFields({
      deliverables: ['feature-a'],
      changedFiles: ['lib/a.js', 'lib/b.js'],
      artifacts: ['build-artifact'],
    });
    expect(set.size).toBe(4);
  });

  it('canonicalizes consistently with extractGoalFields', () => {
    const goal = extractGoalFields({ deliverables: ['Lib_Foo.js'] });
    const actual = extractPhaseFields({ changedFiles: ['lib-foo.js'] });
    const [g] = [...goal];
    expect(actual.has(g)).toBe(true);
  });
});

describe('computeDrift — perfect match', () => {
  it('returns driftPct=0 + inScope filled when goal === actuals', () => {
    const result = computeDrift(
      { deliverables: ['a', 'b', 'c'] },
      { changedFiles: ['a', 'b', 'c'] },
    );
    expect(result.driftPct).toBe(0);
    expect(result.missing).toEqual([]);
    expect(result.extra).toEqual([]);
    expect(result.inScope.sort()).toEqual(['a', 'b', 'c']);
    expect(result.goalCount).toBe(3);
    expect(result.actualCount).toBe(3);
  });
});

describe('computeDrift — partial drift', () => {
  it('returns 50% when half of goal items missing', () => {
    const result = computeDrift(
      { deliverables: ['a', 'b', 'c', 'd'] },
      { changedFiles: ['a', 'b'] },
    );
    expect(result.driftPct).toBe(50);
    expect(result.missing.sort()).toEqual(['c', 'd']);
    expect(result.inScope.sort()).toEqual(['a', 'b']);
    expect(result.extra).toEqual([]);
  });

  it('returns 100% when no goal items present in actuals', () => {
    const result = computeDrift(
      { deliverables: ['x', 'y'] },
      { changedFiles: ['unrelated'] },
    );
    expect(result.driftPct).toBe(100);
    expect(result.missing).toEqual(['x', 'y']);
    expect(result.extra).toEqual(['unrelated']);
  });

  it('rounds to one decimal place', () => {
    const result = computeDrift(
      { deliverables: ['a', 'b', 'c'] },
      { changedFiles: ['a'] },
    );
    // 2/3 = 66.666… → 66.7
    expect(result.driftPct).toBe(66.7);
  });
});

describe('computeDrift — scope creep', () => {
  it('flags actuals not in goal as extra', () => {
    const result = computeDrift(
      { deliverables: ['a'] },
      { changedFiles: ['a', 'b', 'c'] },
    );
    expect(result.extra.sort()).toEqual(['b', 'c']);
    expect(result.driftPct).toBe(0); // all goal items delivered
  });

  it('returns 100% drift for empty goal + extras present (pure scope creep)', () => {
    const result = computeDrift({}, { changedFiles: ['extra1', 'extra2'] });
    expect(result.driftPct).toBe(100);
    expect(result.extra.sort()).toEqual(['extra1', 'extra2']);
  });

  it('returns 0% drift when both goal and actuals are empty', () => {
    const result = computeDrift({}, {});
    expect(result.driftPct).toBe(0);
    expect(result.missing).toEqual([]);
    expect(result.extra).toEqual([]);
  });
});

describe('computeDrift — input flexibility', () => {
  it('accepts pre-extracted Set for goal and actuals', () => {
    const result = computeDrift(
      new Set(['a', 'b']),
      new Set(['a', 'c']),
    );
    expect(result.driftPct).toBe(50);
    expect(result.missing).toEqual(['b']);
    expect(result.extra).toEqual(['c']);
  });

  it('merges array of phase outputs', () => {
    const result = computeDrift(
      { deliverables: ['a', 'b', 'c'] },
      [
        { changedFiles: ['a'] },
        { artifacts: ['b'] },
        { deliverables: ['c'] },
      ],
    );
    expect(result.driftPct).toBe(0);
    expect(result.inScope.sort()).toEqual(['a', 'b', 'c']);
  });

  it('returns sorted arrays for deterministic output', () => {
    const result = computeDrift(
      { deliverables: ['zeta', 'alpha', 'mu'] },
      { changedFiles: ['mu'] },
    );
    expect(result.missing).toEqual(['alpha', 'zeta']);
  });
});
