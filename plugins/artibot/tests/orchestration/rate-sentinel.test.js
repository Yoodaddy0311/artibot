import { beforeEach, describe, expect, it } from 'vitest';
import { createRateSentinel, SlidingWindow } from '../../lib/orchestration/rate-sentinel.js';

describe('SlidingWindow', () => {
  const fixedNow = () => 100_000;

  it('starts empty', () => {
    const win = new SlidingWindow(60_000, { now: fixedNow });
    expect(win.sum()).toEqual({ requests: 0, tokens: 0 });
    expect(win.length).toBe(0);
  });

  it('tracks pushed entries', () => {
    const win = new SlidingWindow(60_000, { now: fixedNow });
    win.push(100_000, 500);
    win.push(100_000, 300);
    expect(win.sum()).toEqual({ requests: 2, tokens: 800 });
    expect(win.length).toBe(2);
  });

  it('trims entries older than window', () => {
    let t = 0;
    const win = new SlidingWindow(60_000, { now: () => t });
    t = 10_000;
    win.push(10_000, 100);
    t = 30_000;
    win.push(30_000, 200);
    t = 80_000; // 10_000 is now older than 80_000 - 60_000 = 20_000
    expect(win.sum()).toEqual({ requests: 1, tokens: 200 });
  });

  it('auto-trims on push', () => {
    const win = new SlidingWindow(60_000, { now: () => 100_000 });
    win.push(30_000, 100); // older than 100_000 - 60_000 = 40_000
    win.push(100_000, 200);
    expect(win.length).toBe(1);
    expect(win.sum()).toEqual({ requests: 1, tokens: 200 });
  });

  it('returns frozen sum', () => {
    const win = new SlidingWindow(60_000, { now: fixedNow });
    const result = win.sum();
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('reset clears all entries', () => {
    const win = new SlidingWindow(60_000, { now: fixedNow });
    win.push(100_000, 500);
    win.push(100_000, 300);
    win.reset();
    expect(win.sum()).toEqual({ requests: 0, tokens: 0 });
    expect(win.length).toBe(0);
  });

  it('push with zero tokens', () => {
    const win = new SlidingWindow(60_000, { now: fixedNow });
    win.push(100_000);
    expect(win.sum()).toEqual({ requests: 1, tokens: 0 });
  });
});

describe('createRateSentinel', () => {
  let sentinel;
  let clock;

  beforeEach(() => {
    clock = 100_000;
    sentinel = createRateSentinel({
      models: {
        opus: { rpm: 10, tpm: 1000 },
        sonnet: { rpm: 20, tpm: 5000 },
      },
      throttleAt: 0.8,
      maxRetries: 3,
      baseDelay: 1000,
      maxDelay: 60_000,
      now: () => clock,
    });
  });

  describe('acquire()', () => {
    it('allows when under threshold', () => {
      const result = sentinel.acquire('opus', 100);
      expect(result.allowed).toBe(true);
      expect(result.waitMs).toBe(0);
      expect(result.reason).toBeNull();
    });

    it('returns frozen result', () => {
      const result = sentinel.acquire('opus');
      expect(Object.isFrozen(result)).toBe(true);
    });

    it('throttles when RPM reaches 80%', () => {
      // opus rpm=10, throttleAt=0.8 -> threshold=8
      for (let i = 0; i < 8; i++) sentinel.record('opus', 10);
      const result = sentinel.acquire('opus');
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('rpm_throttle');
      expect(result.waitMs).toBeGreaterThan(0);
    });

    it('throttles when TPM reaches 80%', () => {
      // opus tpm=1000, throttleAt=0.8 -> threshold=800
      sentinel.record('opus', 750);
      const result = sentinel.acquire('opus', 100); // 750+100=850 >= 800
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('tpm_throttle');
      expect(result.waitMs).toBeGreaterThan(0);
    });

    it('allows unknown model with defaults', () => {
      const result = sentinel.acquire('unknown-model', 100);
      expect(result.allowed).toBe(true);
    });

    it('RPM check takes priority over TPM', () => {
      // Fill RPM to threshold first
      for (let i = 0; i < 8; i++) sentinel.record('opus', 10);
      const result = sentinel.acquire('opus', 500);
      expect(result.reason).toBe('rpm_throttle');
    });

    it('allows after window expires', () => {
      for (let i = 0; i < 8; i++) sentinel.record('opus', 10);
      expect(sentinel.acquire('opus').allowed).toBe(false);
      clock += 61_000; // advance past 1-minute window
      expect(sentinel.acquire('opus').allowed).toBe(true);
    });
  });

  describe('record()', () => {
    it('updates capacity after recording', () => {
      sentinel.record('opus', 500);
      const cap = sentinel.getCapacity('opus');
      expect(cap.rpm.used).toBe(1);
      expect(cap.tpm.used).toBe(500);
    });

    it('tracks multiple models independently', () => {
      sentinel.record('opus', 100);
      sentinel.record('sonnet', 200);
      sentinel.record('sonnet', 300);
      expect(sentinel.getCapacity('opus').rpm.used).toBe(1);
      expect(sentinel.getCapacity('sonnet').rpm.used).toBe(2);
      expect(sentinel.getCapacity('sonnet').tpm.used).toBe(500);
    });

    it('resets retry attempts on successful record', () => {
      sentinel.onError('opus', 429);
      sentinel.onError('opus', 429);
      expect(sentinel.onError('opus', 429).attempt).toBe(3);
      sentinel.record('opus', 100); // success resets attempts
      expect(sentinel.onError('opus', 429).attempt).toBe(1);
    });
  });

  describe('onError()', () => {
    it('returns backoff for 429', () => {
      const r1 = sentinel.onError('opus', 429);
      expect(r1.attempt).toBe(1);
      expect(r1.retryAfterMs).toBe(1000); // baseDelay * 2^0
      expect(r1.exhausted).toBe(false);
    });

    it('exponential backoff increases', () => {
      sentinel.onError('opus', 429); // attempt 1: 1000ms
      const r2 = sentinel.onError('opus', 429); // attempt 2: 2000ms
      expect(r2.retryAfterMs).toBe(2000);
      const r3 = sentinel.onError('opus', 429); // attempt 3: 4000ms
      expect(r3.retryAfterMs).toBe(4000);
    });

    it('marks exhausted after maxRetries', () => {
      sentinel.onError('opus', 429); // 1
      sentinel.onError('opus', 429); // 2
      sentinel.onError('opus', 429); // 3
      const r4 = sentinel.onError('opus', 429); // 4 > maxRetries(3)
      expect(r4.exhausted).toBe(true);
      expect(r4.retryAfterMs).toBe(0);
      expect(r4.attempt).toBe(4);
    });

    it('ignores non-429 errors', () => {
      const result = sentinel.onError('opus', 500);
      expect(result.attempt).toBe(0);
      expect(result.retryAfterMs).toBe(0);
      expect(result.exhausted).toBe(false);
    });

    it('caps delay at maxDelay', () => {
      const s = createRateSentinel({
        maxRetries: 20,
        baseDelay: 10_000,
        maxDelay: 60_000,
        now: () => clock,
      });
      for (let i = 0; i < 5; i++) s.onError('opus', 429);
      const r = s.onError('opus', 429); // 10000 * 2^5 = 320000 -> capped to 60000
      expect(r.retryAfterMs).toBeLessThanOrEqual(60_000);
    });

    it('returns frozen result', () => {
      const result = sentinel.onError('opus', 429);
      expect(Object.isFrozen(result)).toBe(true);
    });

    it('tracks models independently', () => {
      sentinel.onError('opus', 429);
      sentinel.onError('opus', 429);
      const r = sentinel.onError('sonnet', 429);
      expect(r.attempt).toBe(1); // sonnet is independent
    });
  });

  describe('getCapacity()', () => {
    it('returns zero usage initially', () => {
      const cap = sentinel.getCapacity('opus');
      expect(cap.rpm).toEqual({ used: 0, limit: 10, pct: 0 });
      expect(cap.tpm).toEqual({ used: 0, limit: 1000, pct: 0 });
    });

    it('reflects recorded usage', () => {
      sentinel.record('opus', 500);
      sentinel.record('opus', 200);
      const cap = sentinel.getCapacity('opus');
      expect(cap.rpm.used).toBe(2);
      expect(cap.rpm.pct).toBe(0.2);
      expect(cap.tpm.used).toBe(700);
      expect(cap.tpm.pct).toBe(0.7);
    });

    it('returns frozen result', () => {
      const cap = sentinel.getCapacity('opus');
      expect(Object.isFrozen(cap)).toBe(true);
      expect(Object.isFrozen(cap.rpm)).toBe(true);
      expect(Object.isFrozen(cap.tpm)).toBe(true);
    });

    it('uses default limits for unknown model', () => {
      const cap = sentinel.getCapacity('gpt-5');
      expect(cap.rpm.limit).toBe(50); // default
      expect(cap.tpm.limit).toBe(100_000); // default
    });
  });

  describe('reset()', () => {
    it('clears all state', () => {
      sentinel.record('opus', 500);
      sentinel.record('sonnet', 300);
      sentinel.onError('opus', 429);
      sentinel.reset();

      expect(sentinel.getCapacity('opus').rpm.used).toBe(0);
      expect(sentinel.getCapacity('sonnet').tpm.used).toBe(0);
      expect(sentinel.onError('opus', 429).attempt).toBe(1); // fresh start
    });
  });
});
