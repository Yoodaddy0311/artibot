/**
 * evaluateRuntimeSuite must not leave its suite-timeout guard armed.
 *
 * The guard is a 120 s setTimeout. While it is pending, the process cannot exit,
 * so the runner (and the CI step that waits on it) sat idle for ~120 s after the
 * suite had already finished in under a second. Deterministic check: fake timers
 * and a pending-timer count, not a wall-clock threshold.
 *
 * Not covered: the end-to-end process exit time (measured by hand, see CHANGELOG).
 *
 * @module tests/evals/runtime-suite-timer-cleanup
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { evaluateRuntimeSuite } from '../../lib/runtime/evaluator.js';

const okScenario = (id) => ({
  id,
  name: id,
  run: async () => ({ ok: true }),
  evaluate: () => [{ name: 'ok', passed: true, detail: 'ok', critical: true }],
});

describe('evaluateRuntimeSuite timeout guard', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('self-check: fake timers count a pending timer', () => {
    const id = setTimeout(() => {}, 1000);
    expect(vi.getTimerCount()).toBe(1);
    clearTimeout(id);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('leaves no pending timer after a successful parallel run', async () => {
    const report = await evaluateRuntimeSuite([okScenario('a'), okScenario('b')], { parallel: true });
    expect(report.total).toBe(2);
    expect(vi.getTimerCount(), 'pending timers after success').toBe(0);
  });

  it('leaves no pending timer when a scenario rejects', async () => {
    const bad = { ...okScenario('bad'), run: async () => { throw new Error('boom'); } };
    await expect(evaluateRuntimeSuite([bad], { parallel: true })).rejects.toThrow('boom');
    expect(vi.getTimerCount(), 'pending timers after rejection').toBe(0);
  });

  it('still cuts off a hung scenario at the timeout', async () => {
    const hung = { ...okScenario('hung'), run: () => new Promise(() => {}) };
    const pending = evaluateRuntimeSuite([hung], { parallel: true, timeout: 5000 });
    const assertion = expect(pending).rejects.toThrow('Suite timeout after 5000ms');
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
    expect(vi.getTimerCount(), 'pending timers after timeout').toBe(0);
  });

  it('sequential mode arms no timer', async () => {
    await evaluateRuntimeSuite([okScenario('a')], { parallel: false });
    expect(vi.getTimerCount()).toBe(0);
  });
});
