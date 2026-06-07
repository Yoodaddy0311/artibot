/**
 * Direct-module tests for lib/cognitive/effort-resolver.js.
 *
 * The comprehensive contract suite lives in router-resolve-effort.test.js
 * (which imports via the router.js re-export). This file imports the module
 * DIRECTLY to (1) verify it works without the router re-export indirection and
 * (2) prove the P3 learned-overlay path is dormant by default — overlay cold/
 * disabled must yield byte-identical results to the P1 heuristic.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { EFFORT_BANDS, resolveEffort } from '../../lib/cognitive/effort-resolver.js';
import { getEffortForCommand } from '../../lib/cognitive/router.js';
import {
  __setCachedOverlayForTests,
  resetEffortPolicyConfigCache,
} from '../../lib/cognitive/effort-policy-config.js';

describe('effort-resolver (direct import)', () => {
  it('exports EFFORT_BANDS frozen, 5 levels ascending', () => {
    expect(Object.isFrozen(EFFORT_BANDS)).toBe(true);
    expect(EFFORT_BANDS).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });

  describe('no-signal baseline (overlay dormant by default)', () => {
    it('returns the command baseline with shift 0 / reason baseline', () => {
      expect(resolveEffort('implement', {})).toEqual({
        effort: 'xhigh', baseline: 'xhigh', shift: 0, reason: 'baseline',
      });
    });

    it('is byte-identical to getEffortForCommand for representative commands', () => {
      for (const cmd of ['implement', 'code-review', 'orchestrate', 'social', 'quickstart']) {
        expect(resolveEffort(cmd, {}).effort).toBe(getEffortForCommand(cmd));
      }
    });
  });

  describe('heuristic shifts (overlay dormant)', () => {
    it('+1 on high complexity score', () => {
      expect(resolveEffort('content', { score: 0.8 }).effort).toBe('high'); // medium -> high
    });

    it('-1 on trivial score', () => {
      expect(resolveEffort('implement', { score: 0.2 }).effort).toBe('high'); // xhigh -> high
    });

    it('clamps at the max ceiling', () => {
      const r = resolveEffort('orchestrate', { score: 0.9 }); // max baseline
      expect(r.effort).toBe('max');
      expect(r.reason).toContain('[clamped]');
    });

    it('context pressure cancels a +1 score shift (net 0)', () => {
      expect(resolveEffort('content', { score: 0.8, remainingContextRatio: 0.1 }).effort).toBe('medium');
    });
  });

  describe('P3 dormant guarantee', () => {
    it('with the learned overlay disabled (default), no learnedShift appears in reason', () => {
      resetEffortPolicyConfigCache();
      const r = resolveEffort('implement', { score: 0.8 });
      expect(r.reason).not.toContain('learnedShift');
      // identical to the heuristic-only result
      expect(r.effort).toBe('max'); // xhigh +1
    });

    it('never throws when the overlay cache is cold', () => {
      resetEffortPolicyConfigCache();
      expect(() => resolveEffort('plan', { score: 0.5 })).not.toThrow();
    });
  });

  // The hysteresis-hold path has a learned sub-branch (effort-resolver.js:79-81):
  // when score is in the hysteresis dead-band AND prevEffort==baseline, the
  // heuristic shift is suppressed — but a NON-ZERO learned overlay shift still
  // overrides the hold. Exercising it requires an enabled overlay, injected via
  // the sync test seam. afterEach MUST reset so the enabled overlay does not leak
  // into the dormant-by-default assumptions of router-resolve-effort.test.js.
  describe('hysteresis-hold x learnedShift override (overlay injected)', () => {
    afterEach(() => {
      // CRITICAL: clear the injected overlay so other suites stay dormant.
      resetEffortPolicyConfigCache();
    });

    it('applies the learned shift instead of holding when learned !== 0', () => {
      // content baseline = medium (idx 1). score 0.72 -> heuristic +1, but
      // |0.72-0.7| = 0.02 <= 0.05 hysteresis band, prevEffort == baseline ->
      // hysteresis would hold at medium. Enabled overlay biases content +1.
      __setCachedOverlayForTests({ version: 1, bandShifts: { content: 1 }, budgetMultipliers: {} });
      const r = resolveEffort('content', { score: 0.72, prevEffort: 'medium' });
      expect(r.baseline).toBe('medium');
      expect(r.effort).toBe('high'); // medium + learned(+1), NOT held at medium
      expect(r.shift).toBe(1);
      expect(r.reason).toContain('hysteresis-hold');
      expect(r.reason).toContain('learnedShift (+1)');
    });

    it('holds at baseline (pure hysteresis-hold) when overlay disabled', () => {
      resetEffortPolicyConfigCache(); // overlay dormant -> learned == 0
      const r = resolveEffort('content', { score: 0.72, prevEffort: 'medium' });
      expect(r.effort).toBe('medium'); // held at baseline
      expect(r.shift).toBe(0);
      expect(r.reason).toBe('hysteresis-hold');
      expect(r.reason).not.toContain('learnedShift');
    });

    it('holds at baseline when overlay enabled but learned == 0 for the command', () => {
      // Overlay enabled, but no bandShift for `content` -> learnedShiftFor == 0.
      __setCachedOverlayForTests({ version: 1, bandShifts: { implement: 1 }, budgetMultipliers: {} });
      const r = resolveEffort('content', { score: 0.72, prevEffort: 'medium' });
      expect(r.effort).toBe('medium');
      expect(r.reason).toBe('hysteresis-hold');
    });
  });
});
