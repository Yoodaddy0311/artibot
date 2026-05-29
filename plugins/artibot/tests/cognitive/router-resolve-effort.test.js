import { describe, expect, it } from 'vitest';
import {
  EFFORT_BANDS,
  EFFORT_POLICY,
  getEffortForCommand,
  resolveEffort,
} from '../../lib/cognitive/router.js';

describe('EFFORT_BANDS (re-export)', () => {
  it('is frozen', () => {
    expect(Object.isFrozen(EFFORT_BANDS)).toBe(true);
  });

  it('has 5 ordered bands ascending in effort', () => {
    expect(EFFORT_BANDS).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });
});

describe('resolveEffort() — baseline preservation (no signals)', () => {
  it('implement -> xhigh, shift 0, reason baseline', () => {
    expect(resolveEffort('implement')).toEqual({
      effort: 'xhigh', baseline: 'xhigh', shift: 0, reason: 'baseline',
    });
  });

  it('code-review -> high', () => {
    expect(resolveEffort('code-review').effort).toBe('high');
  });

  it('is byte-identical to getEffortForCommand for every EFFORT_POLICY key with no signals', () => {
    for (const key of Object.keys(EFFORT_POLICY)) {
      const r = resolveEffort(key, {});
      expect(r.effort, `key=${key}`).toBe(getEffortForCommand(key));
      expect(r.shift, `key=${key}`).toBe(0);
      expect(r.reason, `key=${key}`).toBe('baseline');
    }
  });
});

describe('resolveEffort() — +1 shift on high score', () => {
  it('medium baseline -> high (score 0.8)', () => {
    const r = resolveEffort('daily', { score: 0.8 });
    expect(r.effort).toBe('high');
    expect(r.shift).toBe(1);
    expect(r.reason).toContain('score>=0.7 (+1)');
  });

  it('xhigh baseline -> max (score 0.8)', () => {
    expect(resolveEffort('implement', { score: 0.8 }).effort).toBe('max');
  });
});

describe('resolveEffort() — -1 shift on low score', () => {
  it('medium baseline -> low (score 0.2)', () => {
    const r = resolveEffort('daily', { score: 0.2 });
    expect(r.effort).toBe('low');
    expect(r.shift).toBe(-1);
    expect(r.reason).toContain('score<=0.25 (-1)');
  });

  it('high baseline -> medium (score 0.2)', () => {
    expect(resolveEffort('code-review', { score: 0.2 }).effort).toBe('medium');
  });
});

describe('resolveEffort() — remaining context ratio', () => {
  it('ratio < 0.15 forces -1', () => {
    const r = resolveEffort('daily', { remainingContextRatio: 0.1 });
    expect(r.effort).toBe('low');
    expect(r.shift).toBe(-1);
    expect(r.reason).toContain('ctx<0.15 (-1)');
  });

  it('high score + low ctx nets 0 (medium stays medium)', () => {
    const r = resolveEffort('daily', { score: 0.8, remainingContextRatio: 0.1 });
    expect(r.effort).toBe('medium');
    expect(r.shift).toBe(0);
  });

  it('low score + low ctx clamps to -1 (raw -2)', () => {
    const r = resolveEffort('daily', { score: 0.2, remainingContextRatio: 0.1 });
    expect(r.effort).toBe('low');
    expect(r.shift).toBe(-1);
  });
});

describe('resolveEffort() — clamping at band edges', () => {
  it('max baseline + high score stays max with [clamped]', () => {
    const r = resolveEffort('orchestrate', { score: 0.9 });
    expect(r.effort).toBe('max');
    expect(r.reason).toContain('[clamped]');
  });

  it('low baseline + low score stays low with [clamped]', () => {
    const r = resolveEffort('quickstart', { score: 0.1 });
    expect(r.effort).toBe('low');
    expect(r.reason).toContain('[clamped]');
  });
});

describe('resolveEffort() — hysteresis', () => {
  it('holds when score near boundary and prevEffort==baseline', () => {
    const r = resolveEffort('daily', { score: 0.72, prevEffort: 'medium' });
    expect(r.effort).toBe('medium');
    expect(r.shift).toBe(0);
    expect(r.reason).toBe('hysteresis-hold');
  });

  it('allows shift when prevEffort != baseline', () => {
    const r = resolveEffort('daily', { score: 0.72, prevEffort: 'high' });
    expect(r.effort).toBe('high');
    expect(r.shift).toBe(1);
  });

  it('allows shift when score is outside the hysteresis band', () => {
    const r = resolveEffort('daily', { score: 0.8, prevEffort: 'medium' });
    expect(r.effort).toBe('high');
    expect(r.shift).toBe(1);
  });
});

describe('resolveEffort() — edge cases', () => {
  it('score exactly 0.7 triggers +1', () => {
    expect(resolveEffort('daily', { score: 0.7 }).shift).toBe(1);
  });

  it('score exactly 0.25 triggers -1', () => {
    expect(resolveEffort('daily', { score: 0.25 }).shift).toBe(-1);
  });

  it('ratio exactly 0.15 does NOT trigger (strict <)', () => {
    const r = resolveEffort('daily', { remainingContextRatio: 0.15 });
    expect(r.shift).toBe(0);
    expect(r.reason).toBe('baseline');
  });

  it('NaN score is ignored (no signal -> baseline)', () => {
    const r = resolveEffort('daily', { score: NaN });
    expect(r.shift).toBe(0);
    expect(r.reason).toBe('baseline');
  });

  it('handles leading slash', () => {
    expect(resolveEffort('/implement', { score: 0.8 }).effort).toBe('max');
  });

  it('unknown command uses medium baseline', () => {
    const r = resolveEffort('totally-unknown', { score: 0.8 });
    expect(r.baseline).toBe('medium');
    expect(r.effort).toBe('high');
  });
});
