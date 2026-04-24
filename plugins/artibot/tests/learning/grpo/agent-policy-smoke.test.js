import { describe, it, expect } from 'vitest';
import {
  softmax,
  clipWeights,
  computeAdvantages,
  klFromPrev,
  klTotal,
  baselineAgentFor,
  DEFAULTS,
} from '../../../lib/learning/grpo/agent-policy.js';

describe('agent-policy pure helpers (smoke)', () => {
  describe('softmax', () => {
    it('empty input returns empty array', () => {
      expect(softmax([])).toEqual([]);
    });

    it('sums to 1 for finite weights', () => {
      const p = softmax([1, 2, 3]);
      const sum = p.reduce((a, b) => a + b, 0);
      expect(sum).toBeCloseTo(1.0, 10);
      expect(p.length).toBe(3);
    });

    it('higher weight -> higher probability', () => {
      const [a, b, c] = softmax([0, 1, 5]);
      expect(c).toBeGreaterThan(b);
      expect(b).toBeGreaterThan(a);
    });

    it('uniform weights -> uniform distribution', () => {
      const p = softmax([0, 0, 0, 0]);
      for (const x of p) expect(x).toBeCloseTo(0.25, 10);
    });

    it('handles non-finite entries as zero', () => {
      const p = softmax([NaN, 0, 0]);
      const sum = p.reduce((a, b) => a + b, 0);
      expect(sum).toBeCloseTo(1.0, 10);
    });
  });

  describe('clipWeights', () => {
    it('clips values outside [-range, +range]', () => {
      expect(clipWeights([10, -10, 0, 3], 5)).toEqual([5, -5, 0, 3]);
    });

    it('uses DEFAULTS.clipRange when omitted', () => {
      const out = clipWeights([100, -100]);
      expect(out[0]).toBeLessThanOrEqual(DEFAULTS.clipRange);
      expect(out[1]).toBeGreaterThanOrEqual(-DEFAULTS.clipRange);
    });

    it('replaces non-finite with 0', () => {
      expect(clipWeights([NaN, Infinity, -Infinity, 1])).toEqual([0, 0, 0, 1]);
    });
  });

  describe('computeAdvantages', () => {
    it('empty -> empty', () => {
      expect(computeAdvantages([])).toEqual([]);
    });

    it('singleton -> zero', () => {
      expect(computeAdvantages([1.5])).toEqual([0]);
    });

    it('is mean-zero for symmetric rewards', () => {
      const adv = computeAdvantages([1, 2, 3, 4, 5]);
      const sum = adv.reduce((a, b) => a + b, 0);
      expect(sum).toBeCloseTo(0, 10);
    });

    it('positive rewards above mean produce positive advantage', () => {
      const adv = computeAdvantages([1, 2, 3]);
      expect(adv[2]).toBeGreaterThan(0);
      expect(adv[0]).toBeLessThan(0);
    });
  });

  describe('klFromPrev', () => {
    it('zero for identical vectors', () => {
      expect(klFromPrev([1, 2, 3], [1, 2, 3])).toBe(0);
    });

    it('length mismatch yields 0', () => {
      expect(klFromPrev([1, 2], [1, 2, 3])).toBe(0);
    });

    it('sums squared differences', () => {
      expect(klFromPrev([1, 0, 0], [0, 0, 0])).toBe(1);
    });
  });

  describe('klTotal', () => {
    it('returns 0 for null/non-object', () => {
      expect(klTotal(null, {})).toBe(0);
      expect(klTotal({}, null)).toBe(0);
    });

    it('sums per-family L2 across union of keys', () => {
      const total = klTotal(
        { fam1: { agentA: 1, agentB: 0 } },
        { fam1: { agentA: 0, agentB: 0 } },
      );
      expect(total).toBe(1);
    });

    it('handles new families vs prev=empty', () => {
      const total = klTotal({ famX: { a: 1 } }, {});
      expect(total).toBe(1);
    });
  });

  describe('baselineAgentFor', () => {
    it('returns null when config missing', () => {
      expect(baselineAgentFor(null, 'code review')).toBeNull();
      expect(baselineAgentFor({}, 'code review')).toBeNull();
    });

    it('returns mapped agent when present', () => {
      const config = { agents: { taskBased: { 'code review': 'code-reviewer' } } };
      expect(baselineAgentFor(config, 'code review')).toBe('code-reviewer');
    });

    it('returns null when family not in map', () => {
      const config = { agents: { taskBased: { 'frontend': 'frontend-developer' } } };
      expect(baselineAgentFor(config, 'code review')).toBeNull();
    });

    it('returns null when taskFamily empty/undefined', () => {
      const config = { agents: { taskBased: { 'x': 'y' } } };
      expect(baselineAgentFor(config, '')).toBeNull();
      expect(baselineAgentFor(config, undefined)).toBeNull();
    });
  });

  describe('DEFAULTS shape', () => {
    it('exposes expected keys as a frozen object', () => {
      expect(Object.isFrozen(DEFAULTS)).toBe(true);
      expect(DEFAULTS.learningRate).toBeGreaterThan(0);
      expect(DEFAULTS.klPenalty).toBeGreaterThan(0);
      expect(DEFAULTS.clipRange).toBeGreaterThan(0);
      expect(DEFAULTS.snapshotCount).toBeGreaterThanOrEqual(1);
    });
  });
});
