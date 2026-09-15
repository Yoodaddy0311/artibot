/**
 * Tests for route-hysteresis §30 residency REASON CODES — the distinction
 * between a measured shortfall and an absent counter.
 *
 * WHY A SECOND FILE: `hysteresis.test.js` covers the §28/§29/§30 arithmetic.
 * This file exists because the Stop coverage gate credits only
 * `route-hysteresis*.test.js` as cover for `lib/routing/route-hysteresis.js`
 * (prefix-form stems such as `hysteresis.test.js` are not credited), and
 * because the residency vocabulary is a contract with the scorecard
 * allowlist rather than a formula.
 *
 * WHAT THESE TESTS CANNOT SEE: nothing here proves the router ever passes
 * `actionsSinceSwitch`, nor how often the absent case fires in live receipts.
 * The live rate of `residency-unknown` is unmeasured. These tests pin only
 * that an absent counter is reported as unknown rather than as a shortfall.
 *
 * @module tests/routing/route-hysteresis
 */

import { describe, expect, it } from 'vitest';

import { getModel } from '../../lib/core/model-catalog.js';
import { evaluateSwitch, residencyBarrier } from '../../lib/routing/route-hysteresis.js';

/** Real catalog, injected as a port (the module imports nothing). */
const catalog = { getModel };

/** A transition the catalog can price on both sides. */
const transition = { from: 'opus', to: 'haiku', catalog };

describe('evaluateSwitch — §30 residency reason codes', () => {
  it('reports residency-unknown when the counter is absent', () => {
    const r = evaluateSwitch({ ...transition });
    expect(r.hold).toBe(true);
    expect(r.reason).toEqual(['residency-unknown']);
    expect(r.residency.actionsSinceSwitch).toBeNull();
    expect(r.residency.satisfied).toBe(false);
  });

  it('reports minimum-residency when a measured count is below the barrier', () => {
    const r = evaluateSwitch({ ...transition, actionsSinceSwitch: 2 });
    expect(r.hold).toBe(true);
    expect(r.reason).toEqual(['minimum-residency']);
    expect(r.residency).toMatchObject({ actionsSinceSwitch: 2, satisfied: false });
  });

  it('reports minimum-residency for a measured zero, which is not an absent counter', () => {
    const r = evaluateSwitch({ ...transition, actionsSinceSwitch: 0 });
    expect(r.hold).toBe(true);
    expect(r.reason).toEqual(['minimum-residency']);
    expect(r.residency.actionsSinceSwitch).toBe(0);
  });

  it('carries no residency code once the barrier is met', () => {
    const r = evaluateSwitch({ ...transition, actionsSinceSwitch: residencyBarrier({}) });
    expect(r.residency.satisfied).toBe(true);
    expect(r.reason).not.toContain('minimum-residency');
    expect(r.reason).not.toContain('residency-unknown');
  });

  it('treats an unusable counter as unknown rather than as a shortfall', () => {
    // `nonNegative` collapses negatives and non-numbers to null, so neither
    // reaches the comparison as a measurement. Both are absences of a usable
    // count, and both must say so rather than claim a measured shortfall.
    for (const actionsSinceSwitch of [-1, '10', Number.NaN, null, undefined]) {
      const r = evaluateSwitch({ ...transition, actionsSinceSwitch });
      expect(r.hold).toBe(true);
      expect(r.reason).toEqual(['residency-unknown']);
      expect(r.residency.actionsSinceSwitch).toBeNull();
    }
  });

  it('lets a recognised override skip the unknown counter, as it skips a shortfall', () => {
    const r = evaluateSwitch({ ...transition, override: 'user_override' });
    expect(r.reason).not.toContain('residency-unknown');
    expect(r.reason).not.toContain('minimum-residency');
  });
});
