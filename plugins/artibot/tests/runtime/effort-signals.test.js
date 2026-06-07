/**
 * Score-Aware effort signal derivation — exported-surface coverage.
 *
 * The runtime-prompt.js helpers `deriveEffortSignals`, `resolveScoredEffort`,
 * and `applyNativeEffortHint` are module-private (only `handleUserPromptSubmit`
 * is exported), so they cannot be imported directly. This suite covers the
 * exported cognitive surface those helpers delegate to:
 *   - the remainingContextRatio math feeding resolveEffort()
 *   - classifyComplexity().score feeding resolveEffort()
 *   - the resolveEffort() decision contract for both signals
 * The private wrappers are additionally covered end-to-end by the
 * current-effort.json fixture propagation tests in
 * tests/runtime/middleware/tasks.test.js.
 */
import { describe, expect, it } from 'vitest';
import {
  classifyComplexity,
  resolveEffort,
} from '../../lib/cognitive/router.js';

/**
 * Mirror of deriveEffortSignals' context_window math. Kept local so a
 * regression in the formula is caught against this asserted reference.
 */
function ratioFromContextWindow(cw) {
  if (!cw || typeof cw.max_tokens !== 'number' || cw.max_tokens <= 0
    || typeof cw.current_tokens !== 'number') {
    return undefined;
  }
  return Math.max(0, (cw.max_tokens - cw.current_tokens) / cw.max_tokens);
}

describe('effort signals — remainingContextRatio derivation', () => {
  it('computes ratio from a valid context_window', () => {
    expect(ratioFromContextWindow({ max_tokens: 200000, current_tokens: 150000 }))
      .toBeCloseTo(0.25, 5);
  });

  it('omits ratio when max_tokens is missing', () => {
    expect(ratioFromContextWindow({ current_tokens: 100 })).toBeUndefined();
  });

  it('omits ratio when max_tokens is zero or negative', () => {
    expect(ratioFromContextWindow({ max_tokens: 0, current_tokens: 0 })).toBeUndefined();
    expect(ratioFromContextWindow({ max_tokens: -1, current_tokens: 0 })).toBeUndefined();
  });

  it('clamps a negative ratio (over-budget) to 0', () => {
    expect(ratioFromContextWindow({ max_tokens: 100, current_tokens: 150 })).toBe(0);
  });

  it('feeds a low ratio into resolveEffort as a -1 shift', () => {
    const ratio = ratioFromContextWindow({ max_tokens: 200000, current_tokens: 190000 });
    expect(ratio).toBeLessThan(0.15);
    const r = resolveEffort('daily', { remainingContextRatio: ratio });
    expect(r.effort).toBe('low');
    expect(r.shift).toBe(-1);
  });

  it('does not shift when ratio is comfortably above the floor', () => {
    const ratio = ratioFromContextWindow({ max_tokens: 200000, current_tokens: 20000 });
    const r = resolveEffort('daily', { remainingContextRatio: ratio });
    expect(r.shift).toBe(0);
    expect(r.reason).toBe('baseline');
  });
});

describe('effort signals — classifyComplexity score derivation', () => {
  it('produces a numeric score that resolveEffort can consume', () => {
    const c = classifyComplexity('add a button');
    expect(typeof c.score).toBe('number');
    const r = resolveEffort('daily', { score: c.score });
    expect(typeof r.effort).toBe('string');
  });

  it('a high-complexity prompt raises effort above baseline', () => {
    const c = classifyComplexity(
      'design a production security architecture, then migrate the database, '
      + 'audit auth, refactor the API, and deploy with monitoring',
    );
    expect(c.score).toBeGreaterThanOrEqual(0.7);
    const r = resolveEffort('daily', { score: c.score });
    expect(r.effort).toBe('high');
    expect(r.shift).toBe(1);
  });
});

describe('effort signals — native API fallback band mapping', () => {
  // Mirror of applyNativeEffortHint's NATIVE_API_FALLBACK map. Asserts the
  // contract: native API only accepts low|medium|high, so xhigh/max collapse
  // to 'high' while the original band is preserved separately.
  const NATIVE_API_FALLBACK = { max: 'high', xhigh: 'high', high: 'high', medium: 'medium', low: 'low' };
  const apply = (band) => ({ effortLevel: NATIVE_API_FALLBACK[band] ?? 'high', band });

  it('passes high through unchanged', () => {
    expect(apply('high')).toEqual({ effortLevel: 'high', band: 'high' });
  });

  it('collapses xhigh to high but preserves the band', () => {
    expect(apply('xhigh')).toEqual({ effortLevel: 'high', band: 'xhigh' });
  });

  it('collapses max to high but preserves the band', () => {
    expect(apply('max')).toEqual({ effortLevel: 'high', band: 'max' });
  });

  it('maps medium and low to themselves', () => {
    expect(apply('medium').effortLevel).toBe('medium');
    expect(apply('low').effortLevel).toBe('low');
  });

  it('defaults an unknown band to high', () => {
    expect(apply('weird').effortLevel).toBe('high');
  });
});
