/**
 * Tests for lib/learning/memory/metrics.js — per-layer hit-rate telemetry.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const stores = {};

vi.mock('../../../lib/core/file.js', () => ({
  atomicWriteJson: vi.fn(async (p, data) => { stores[p] = data; }),
  readJsonFile: vi.fn(async (p) => (stores[p] ? JSON.parse(JSON.stringify(stores[p])) : null)),
}));

const METRICS_PATH = '/tmp/artibot-test/runtime/memory-metrics.json';

async function makeRecorder(clockMs = 1_700_000_000_000) {
  const { createMetricsRecorder } = await import('../../../lib/learning/memory/metrics.js');
  return createMetricsRecorder({ metricsPath: METRICS_PATH, now: () => clockMs });
}

function clearStores() {
  for (const k of Object.keys(stores)) delete stores[k];
}

describe('memory/metrics', () => {
  beforeEach(() => {
    clearStores();
    vi.clearAllMocks();
  });

  it('factory rejects missing metricsPath', async () => {
    const { createMetricsRecorder } = await import('../../../lib/learning/memory/metrics.js');
    expect(() => createMetricsRecorder({})).toThrow(/metricsPath/);
  });

  it('snapshot starts with zero counters for all layers', async () => {
    const rec = await makeRecorder();
    const snap = rec.snapshot();
    for (const layer of ['working', 'episodic', 'semantic']) {
      expect(snap[layer]).toEqual({ hits: 0, queries: 0, rate: 0 });
    }
    expect(snap.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('recordQuery increments queries and recomputes rate', async () => {
    const rec = await makeRecorder();
    rec.recordQuery('semantic', 1);
    rec.recordQuery('semantic', 0);
    const snap = rec.snapshot();
    expect(snap.semantic.queries).toBe(2);
    expect(snap.semantic.hits).toBe(1);
    expect(snap.semantic.rate).toBeCloseTo(0.5, 6);
  });

  it('recordHit increments hit count without affecting queries', async () => {
    const rec = await makeRecorder();
    rec.recordQuery('episodic', 0);
    rec.recordHit('episodic');
    const snap = rec.snapshot();
    expect(snap.episodic.hits).toBe(1);
    expect(snap.episodic.queries).toBe(1);
    expect(snap.episodic.rate).toBeCloseTo(1.0, 6);
  });

  it('ignores unknown layers', async () => {
    const rec = await makeRecorder();
    rec.recordQuery('bogus', 5);
    rec.recordHit('bogus');
    const snap = rec.snapshot();
    expect(snap.working.queries).toBe(0);
    expect(snap.episodic.queries).toBe(0);
    expect(snap.semantic.queries).toBe(0);
  });

  it('snapshot is frozen (immutable)', async () => {
    const rec = await makeRecorder();
    const snap = rec.snapshot();
    expect(Object.isFrozen(snap)).toBe(true);
    expect(Object.isFrozen(snap.working)).toBe(true);
  });

  it('rollup persists current snapshot to disk', async () => {
    const rec = await makeRecorder();
    rec.recordQuery('working', 1);
    const written = await rec.rollup();
    expect(stores[METRICS_PATH]).toBeDefined();
    expect(stores[METRICS_PATH].working.hits).toBe(1);
    expect(written.date).toBe(stores[METRICS_PATH].date);
  });

  it('rollup with explicit date resets counters when date differs', async () => {
    const rec = await makeRecorder();
    rec.recordQuery('semantic', 1);
    await rec.rollup('2024-01-01');
    expect(stores[METRICS_PATH].date).toBe('2024-01-01');
    // In-RAM state was reset
    const snap = rec.snapshot();
    expect(snap.semantic.queries).toBe(0);
  });

  it('resetDaily flushes old snapshot when clock advances', async () => {
    const { createMetricsRecorder } = await import('../../../lib/learning/memory/metrics.js');
    let clock = Date.UTC(2024, 0, 1, 12);
    const rec = createMetricsRecorder({ metricsPath: METRICS_PATH, now: () => clock });
    rec.recordQuery('semantic', 1);
    clock = Date.UTC(2024, 0, 2, 12); // advance one day
    await rec.resetDaily();
    // Old day's data persisted
    expect(stores[METRICS_PATH].date).toBe('2024-01-01');
    expect(stores[METRICS_PATH].semantic.queries).toBe(1);
    // In-RAM reset to new day
    const snap = rec.snapshot();
    expect(snap.date).toBe('2024-01-02');
    expect(snap.semantic.queries).toBe(0);
  });

  it('load restores prior-day counters from disk', async () => {
    const rec = await makeRecorder();
    const date = rec.snapshot().date;
    stores[METRICS_PATH] = {
      date,
      working: { hits: 3, queries: 5, rate: 0.6 },
      episodic: { hits: 2, queries: 4, rate: 0.5 },
      semantic: { hits: 1, queries: 3, rate: 0.333 },
    };
    await rec.load();
    const snap = rec.snapshot();
    expect(snap.working.hits).toBe(3);
    expect(snap.working.queries).toBe(5);
    expect(snap.episodic.rate).toBeCloseTo(0.5, 3);
  });

  it('load ignores disk snapshot from a different date', async () => {
    const rec = await makeRecorder();
    stores[METRICS_PATH] = {
      date: '1999-01-01',
      working: { hits: 99, queries: 100, rate: 0.99 },
      episodic: { hits: 0, queries: 0, rate: 0 },
      semantic: { hits: 0, queries: 0, rate: 0 },
    };
    await rec.load();
    const snap = rec.snapshot();
    expect(snap.working.hits).toBe(0);
  });

  it('exposes metricsPath for caller introspection', async () => {
    const rec = await makeRecorder();
    expect(rec.metricsPath).toBe(METRICS_PATH);
  });
});
