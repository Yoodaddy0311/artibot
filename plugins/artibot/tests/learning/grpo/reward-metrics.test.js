import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// File-system mock — in-memory store keyed by absolute path.
// ---------------------------------------------------------------------------

const diskMap = new Map();

vi.mock('../../../lib/core/file.js', () => ({
  readJsonFile: vi.fn(async (p) => {
    if (!diskMap.has(p)) return null;
    return JSON.parse(diskMap.get(p));
  }),
  atomicWriteJson: vi.fn(async (p, data) => {
    diskMap.set(p, JSON.stringify(data));
  }),
}));

let createRewardMetrics;

beforeEach(async () => {
  diskMap.clear();
  vi.resetModules();
  ({ createRewardMetrics } = await import('../../../lib/learning/grpo/reward-metrics.js'));
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createRewardMetrics()', () => {
  it('throws when metricsPath is missing', () => {
    expect(() => createRewardMetrics()).toThrow();
    expect(() => createRewardMetrics({})).toThrow();
  });

  it('returns a frozen API surface', () => {
    const api = createRewardMetrics({ metricsPath: '/tmp/rm.json' });
    expect(Object.isFrozen(api)).toBe(true);
    expect(typeof api.recordReward).toBe('function');
    expect(typeof api.snapshot).toBe('function');
    expect(typeof api.rollup).toBe('function');
  });
});

describe('recordReward()', () => {
  it('ignores non-finite rewards', async () => {
    const m = createRewardMetrics({
      metricsPath: '/tmp/rm1.json',
      now: () => Date.parse('2026-04-23T12:00:00Z'),
    });
    expect(await m.recordReward('s', NaN)).toBeNull();
    expect(await m.recordReward('s', Infinity)).toBeNull();
    const snap = await m.snapshot();
    expect(Object.keys(snap.dailyRollups)).toHaveLength(0);
  });

  it('records a reward into the current-date bucket', async () => {
    const m = createRewardMetrics({
      metricsPath: '/tmp/rm2.json',
      now: () => Date.parse('2026-04-23T12:00:00Z'),
    });
    await m.recordReward('s1', 0.5, { toolSuccess: 0.2 });
    const snap = await m.snapshot();
    expect(snap.dailyRollups['2026-04-23']).toBeDefined();
    expect(snap.dailyRollups['2026-04-23'].count).toBe(1);
    expect(snap.dailyRollups['2026-04-23'].sum).toBe(0.5);
    expect(snap.dailyRollups['2026-04-23'].mean).toBe(0.5);
  });

  it('accumulates multiple rewards into the same bucket', async () => {
    const m = createRewardMetrics({
      metricsPath: '/tmp/rm3.json',
      now: () => Date.parse('2026-04-23T12:00:00Z'),
    });
    await m.recordReward('s', 0.5);
    await m.recordReward('s', 0.3);
    await m.recordReward('s', -0.2);
    const bucket = await m.rollup('2026-04-23');
    expect(bucket.count).toBe(3);
    expect(bucket.sum).toBeCloseTo(0.6, 6);
    expect(bucket.mean).toBeCloseTo(0.2, 6);
    expect(bucket.positive).toBe(2);
    expect(bucket.negative).toBe(1);
    expect(bucket.zero).toBe(0);
  });

  it('tracks min and max per bucket', async () => {
    const m = createRewardMetrics({
      metricsPath: '/tmp/rm4.json',
      now: () => Date.parse('2026-04-23T12:00:00Z'),
    });
    await m.recordReward('s', 0.4);
    await m.recordReward('s', -0.9);
    await m.recordReward('s', 1.1);
    const bucket = await m.rollup('2026-04-23');
    expect(bucket.min).toBe(-0.9);
    expect(bucket.max).toBe(1.1);
  });

  it('counts clipped rewards (at REWARD_CLIP bounds)', async () => {
    const m = createRewardMetrics({
      metricsPath: '/tmp/rm5.json',
      now: () => Date.parse('2026-04-23T12:00:00Z'),
    });
    await m.recordReward('s', -1.5);
    await m.recordReward('s', 1.2);
    await m.recordReward('s', 0.3);
    const bucket = await m.rollup('2026-04-23');
    expect(bucket.clipped).toBe(2);
  });

  it('zero reward increments the zero counter', async () => {
    const m = createRewardMetrics({
      metricsPath: '/tmp/rm6.json',
      now: () => Date.parse('2026-04-23T12:00:00Z'),
    });
    await m.recordReward('s', 0);
    const bucket = await m.rollup('2026-04-23');
    expect(bucket.zero).toBe(1);
  });

  it('uses separate buckets per date', async () => {
    let t = Date.parse('2026-04-23T12:00:00Z');
    const m = createRewardMetrics({
      metricsPath: '/tmp/rm7.json',
      now: () => t,
    });
    await m.recordReward('s', 0.5);
    t = Date.parse('2026-04-24T12:00:00Z');
    await m.recordReward('s', 0.7);
    const snap = await m.snapshot();
    expect(Object.keys(snap.dailyRollups).sort()).toEqual(['2026-04-23', '2026-04-24']);
  });

  it('accumulates component sums', async () => {
    const m = createRewardMetrics({
      metricsPath: '/tmp/rm8.json',
      now: () => Date.parse('2026-04-23T12:00:00Z'),
    });
    await m.recordReward('s', 0.5, { toolSuccess: 0.2, errors: -0.1 });
    await m.recordReward('s', 0.3, { toolSuccess: 0.1, tests: 0.25 });
    const bucket = await m.rollup('2026-04-23');
    expect(bucket.componentSums.toolSuccess).toBeCloseTo(0.3, 6);
    expect(bucket.componentSums.errors).toBeCloseTo(-0.1, 6);
    expect(bucket.componentSums.tests).toBeCloseTo(0.25, 6);
  });

  it('caps recentEpisodes to 100 entries', async () => {
    const m = createRewardMetrics({
      metricsPath: '/tmp/rm9.json',
      now: () => Date.parse('2026-04-23T12:00:00Z'),
    });
    for (let i = 0; i < 150; i += 1) {
      await m.recordReward(`s${i}`, 0.01 * i);
    }
    const snap = await m.snapshot();
    expect(snap.recentEpisodes).toHaveLength(100);
    // Newest last — should contain s149
    expect(snap.recentEpisodes[snap.recentEpisodes.length - 1].sessionId).toBe('s149');
  });

  it('writes via atomicWriteJson each recordReward', async () => {
    const { atomicWriteJson } = await import('../../../lib/core/file.js');
    const m = createRewardMetrics({
      metricsPath: '/tmp/rm10.json',
      now: () => Date.parse('2026-04-23T12:00:00Z'),
    });
    await m.recordReward('s', 0.5);
    await m.recordReward('s', 0.6);
    expect(atomicWriteJson).toHaveBeenCalledTimes(2);
  });

  it('sets updatedAt ISO string', async () => {
    const m = createRewardMetrics({
      metricsPath: '/tmp/rm11.json',
      now: () => Date.parse('2026-04-23T12:34:56.000Z'),
    });
    await m.recordReward('s', 0.1);
    const snap = await m.snapshot();
    expect(snap.updatedAt).toBe('2026-04-23T12:34:56.000Z');
  });
});

describe('snapshot() / rollup()', () => {
  it('snapshot on empty store returns empty schema', async () => {
    const m = createRewardMetrics({
      metricsPath: '/tmp/rm-empty.json',
      now: () => Date.parse('2026-04-23T00:00:00Z'),
    });
    const snap = await m.snapshot();
    expect(snap.dailyRollups).toEqual({});
    expect(snap.recentEpisodes).toEqual([]);
  });

  it('rollup() on missing date returns empty bucket', async () => {
    const m = createRewardMetrics({
      metricsPath: '/tmp/rm-miss.json',
      now: () => Date.parse('2026-04-23T00:00:00Z'),
    });
    const bucket = await m.rollup('2000-01-01');
    expect(bucket.count).toBe(0);
    expect(bucket.sum).toBe(0);
  });

  it('coerces corrupt disk state to empty schema', async () => {
    const { atomicWriteJson } = await import('../../../lib/core/file.js');
    await atomicWriteJson('/tmp/rm-corrupt.json', { garbage: 'yes' });
    const m = createRewardMetrics({
      metricsPath: '/tmp/rm-corrupt.json',
      now: () => Date.parse('2026-04-23T00:00:00Z'),
    });
    const snap = await m.snapshot();
    expect(snap.dailyRollups).toEqual({});
    expect(snap.recentEpisodes).toEqual([]);
  });
});
