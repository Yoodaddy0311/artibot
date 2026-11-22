/**
 * Tests for tool-history.js — persistence and scoring helpers.
 *
 * @module tests/learning/tool-history
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock node:fs/promises before importing the module
vi.mock('node:fs/promises', () => ({
  default: {
    readFile: vi.fn(() => Promise.reject(Object.assign(new Error('not found'), { code: 'ENOENT' }))),
    writeFile: vi.fn(() => Promise.resolve()),
    mkdir: vi.fn(() => Promise.resolve()),
  },
}));

const fsModule = await import('node:fs/promises');
const fs = fsModule.default;

// saveHistory writes through lib/core/file.js#atomicWriteJsonSync under a file
// lock (M2, 2026-11-21), not through fs/promises. The spy records the exact
// bytes the real writer would produce, so assertions read the same JSON text.
const { writeSpy } = vi.hoisted(() => ({ writeSpy: vi.fn() }));
vi.mock('../../lib/core/file.js', async (importOriginal) => ({
  ...(await importOriginal()),
  atomicWriteJsonSync: (p, data) => writeSpy(p, `${JSON.stringify(data, null, 2)}\n`),
}));

import {
  clampScore,
  clearCache,
  clearDirtyState,
  computeToolScores,
  createEmptyHistory,
  FLUSH_INTERVAL_MS,
  getBufferState,
  getConfidence,
  getDirtyState,
  getHistoryPath,
  loadHistory,
  markDirty,
  MIN_SAMPLES,
  notePendingRecord,
  notePrune,
  rebuildAggregates,
  saveHistory,
  setHistory,
  suggestFromRelated,
  updateAggregate,
} from '../../lib/learning/tool-history.js';

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------
beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  clearCache();
  fs.readFile.mockRejectedValue(Object.assign(new Error('not found'), { code: 'ENOENT' }));
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
describe('constants', () => {
  it('MIN_SAMPLES is a positive integer', () => {
    expect(MIN_SAMPLES).toBeGreaterThan(0);
    expect(Number.isInteger(MIN_SAMPLES)).toBe(true);
  });

  it('FLUSH_INTERVAL_MS is a positive number', () => {
    expect(FLUSH_INTERVAL_MS).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// createEmptyHistory()
// ---------------------------------------------------------------------------
describe('createEmptyHistory()', () => {
  it('returns a valid v2 history object', () => {
    const h = createEmptyHistory();
    expect(h.version).toBe(2);
    expect(h.contexts).toEqual({});
    expect(h.aggregates).toEqual({});
    expect(h.grpoGroups).toBeUndefined();
    expect(h.grpoScores).toBeUndefined();
    expect(h.lastUpdated).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// loadHistory()
// ---------------------------------------------------------------------------
describe('loadHistory()', () => {
  it('returns empty history when file does not exist', async () => {
    const h = await loadHistory();
    expect(h.version).toBe(2);
    expect(h.contexts).toEqual({});
  });

  it('returns cached history on second call', async () => {
    const h1 = await loadHistory();
    const h2 = await loadHistory();
    expect(h1).toBe(h2);
  });

  it('parses valid JSON from disk', async () => {
    const saved = { version: 2, contexts: { x: [] }, aggregates: {}, lastUpdated: 1 };
    fs.readFile.mockResolvedValueOnce(JSON.stringify(saved));
    clearCache();
    const h = await loadHistory();
    expect(h.version).toBe(2);
    expect(h.contexts).toEqual({ x: [] });
  });

  it('loads a v1 history without injecting GRPO fields', async () => {
    const v1 = { version: 1, contexts: {}, aggregates: {}, lastUpdated: 1 };
    fs.readFile.mockResolvedValueOnce(JSON.stringify(v1));
    clearCache();
    const h = await loadHistory();
    // GRPO comparison storage was retired — load must not synthesize it.
    expect(h.grpoGroups).toBeUndefined();
    expect(h.grpoScores).toBeUndefined();
    expect(h.contexts).toEqual({});
  });

  it('resets to empty when version < 1', async () => {
    fs.readFile.mockResolvedValueOnce(JSON.stringify({ version: 0, contexts: { a: [1] } }));
    clearCache();
    const h = await loadHistory();
    expect(h.version).toBe(2);
    expect(h.contexts).toEqual({});
  });

  // loadHistory and the locked re-read (readDiskHistory) share one validation.
  // loadHistory used to keep any TRUTHY contexts/aggregates, so a number or a
  // string survived the load and the next recordUsage threw a TypeError
  // assigning a property to a primitive (ESM is strict mode).
  for (const [label, bad] of [['a number', 5], ['a string', 'x'], ['true', true]]) {
    it(`replaces contexts/aggregates that are ${label} with empty objects`, async () => {
      fs.readFile.mockResolvedValueOnce(JSON.stringify({ version: 2, contexts: bad, aggregates: bad, lastUpdated: 1 }));
      clearCache();
      const h = await loadHistory();
      expect(h.version).toBe(2);
      expect(h.contexts).toEqual({});
      expect(h.aggregates).toEqual({});
      expect(() => { h.contexts['read:js:file'] = []; }).not.toThrow();
    });
  }

  it('keeps the other top-level fields of a valid history', async () => {
    const saved = { version: 2, contexts: { x: [] }, aggregates: { Read: { totalUses: 1 } }, lastUpdated: 7, extra: 'kept' };
    fs.readFile.mockResolvedValueOnce(JSON.stringify(saved));
    clearCache();
    expect(await loadHistory()).toEqual(saved);
  });

  it('starts empty on any read error, not only ENOENT (read-only load; unchanged)', async () => {
    fs.readFile.mockRejectedValueOnce(Object.assign(new Error('busy'), { code: 'EBUSY' }));
    clearCache();
    const h = await loadHistory();
    expect(h.contexts).toEqual({});
  });

  it('starts empty on content that is not a history (null, array, unparseable)', async () => {
    for (const text of ['null', '[]', '{ half-written', '"x"']) {
      fs.readFile.mockResolvedValueOnce(text);
      clearCache();
      const h = await loadHistory();
      expect(h.version, text).toBe(2);
      expect(h.contexts, text).toEqual({});
    }
  });
});

// ---------------------------------------------------------------------------
// saveHistory()
// ---------------------------------------------------------------------------
describe('saveHistory()', () => {
  it('writes JSON to disk', async () => {
    await loadHistory();
    expect(await saveHistory()).toBe(true);
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(writeSpy.mock.calls[0][0]).toBe(getHistoryPath());
  });

  it('does nothing if history is not loaded', async () => {
    await saveHistory();
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('updates lastUpdated timestamp', async () => {
    const h = await loadHistory();
    const before = h.lastUpdated;
    vi.advanceTimersByTime(100);
    await saveHistory();
    expect(h.lastUpdated).toBeGreaterThanOrEqual(before);
  });
});

// ---------------------------------------------------------------------------
// saveHistory() merge under the file lock (M2, 2026-11-21)
//
// The real file at getHistoryPath() lives in the per-worker state dir that
// tests/setup/state-dir.js points ARTIBOT_STATE_DIR at; only the WRITE is
// spied, so the re-read under the lock sees whatever these tests put there.
// ---------------------------------------------------------------------------
describe('saveHistory() merges onto the latest file on disk', () => {
  const rec = (tool, context, timestamp) => ({ tool, context, score: 1, timestamp });

  /** Write a history file as another process would have. */
  function seedDisk(contexts) {
    mkdirSync(path.dirname(getHistoryPath()), { recursive: true });
    writeFileSync(getHistoryPath(), JSON.stringify({ version: 2, contexts, aggregates: {}, lastUpdated: 1 }));
  }

  beforeEach(() => { rmSync(getHistoryPath(), { force: true }); });
  afterEach(() => { rmSync(getHistoryPath(), { force: true }); });

  it('adds only this process\'s pending rows to rows another process wrote', async () => {
    const h = await loadHistory(); // fs/promises mock: ENOENT -> empty
    const mine = rec('Grep', 'search:any', Date.now());
    h.contexts['search:any'] = [mine];
    notePendingRecord(mine);
    seedDisk({ 'search:any': [rec('Read', 'search:any', 5)], 'read:js:file': [rec('Read', 'read:js:file', 6)] });

    expect(await saveHistory()).toBe(true);

    const written = JSON.parse(writeSpy.mock.calls[0][1]);
    expect(written.contexts['search:any'].map((r) => r.tool)).toEqual(['Read', 'Grep']);
    expect(written.contexts['read:js:file']).toHaveLength(1);
    expect(written.aggregates.Grep.totalUses).toBe(1);
  });

  it('does not add the same pending row twice across two saves', async () => {
    const h = await loadHistory();
    const mine = rec('Grep', 'search:any', Date.now());
    h.contexts['search:any'] = [mine];
    notePendingRecord(mine);
    seedDisk({});
    await saveHistory();
    // The second save re-reads the file the first one "wrote".
    writeFileSync(getHistoryPath(), writeSpy.mock.calls[0][1]);
    await saveHistory();
    expect(JSON.parse(writeSpy.mock.calls[1][1]).contexts['search:any']).toHaveLength(1);
  });

  it('writes the in-memory history whole after setHistory (reset), ignoring disk', async () => {
    seedDisk({ 'search:any': [rec('Read', 'search:any', 5)] });
    setHistory(createEmptyHistory());
    await saveHistory();
    expect(JSON.parse(writeSpy.mock.calls[0][1]).contexts).toEqual({});
  });

  it('re-applies a prune cutoff to rows on disk', async () => {
    await loadHistory();
    seedDisk({ old: [rec('Read', 'old', 10)], fresh: [rec('Read', 'fresh', 5_000)] });
    notePrune(1_000);
    await saveHistory();
    const written = JSON.parse(writeSpy.mock.calls[0][1]);
    expect(Object.keys(written.contexts)).toEqual(['fresh']);
    expect(written.aggregates.Read.totalUses).toBe(1);
  });

  it('returns false and writes nothing when the lock is held past its wait', async () => {
    vi.useRealTimers(); // the lock's wait is wall-clock; frozen Date.now never times out
    await loadHistory();
    const lockPath = `${getHistoryPath()}.lock`;
    mkdirSync(path.dirname(lockPath), { recursive: true });
    // A live holder on this host (our own pid, fresh timestamp) is never stale.
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, host: hostname(), token: 'other', timestamp: Date.now() }));
    try {
      expect(await saveHistory()).toBe(false);
      expect(writeSpy).not.toHaveBeenCalled();
    } finally {
      rmSync(lockPath, { force: true });
    }
  }, 10_000);
});

// ---------------------------------------------------------------------------
// markDirty() / getDirtyState() / clearDirtyState()
// ---------------------------------------------------------------------------
describe('dirty state management', () => {
  it('markDirty sets dirty flag and schedules flush', () => {
    const flushFn = vi.fn();
    markDirty(flushFn);
    const state = getDirtyState();
    expect(state.dirty).toBe(true);
    expect(state.timer).not.toBeNull();
  });

  it('markDirty does not schedule second timer', () => {
    const flushFn = vi.fn();
    markDirty(flushFn);
    markDirty(flushFn);
    vi.advanceTimersByTime(FLUSH_INTERVAL_MS + 100);
    expect(flushFn).toHaveBeenCalledTimes(1);
  });

  it('clearDirtyState resets both dirty and timer', () => {
    markDirty(vi.fn());
    clearDirtyState();
    const state = getDirtyState();
    expect(state.dirty).toBe(false);
    expect(state.timer).toBeNull();
  });

  it('getBufferState returns dirty and hasTimer', () => {
    const state = getBufferState();
    expect(state).toEqual({ dirty: false, hasTimer: false });
    markDirty(vi.fn());
    const state2 = getBufferState();
    expect(state2.dirty).toBe(true);
    expect(state2.hasTimer).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// setHistory()
// ---------------------------------------------------------------------------
describe('setHistory()', () => {
  it('replaces in-memory history', async () => {
    await loadHistory();
    const custom = { ...createEmptyHistory(), contexts: { test: [] } };
    setHistory(custom);
    const h = await loadHistory();
    expect(h.contexts).toEqual({ test: [] });
  });
});

// ---------------------------------------------------------------------------
// updateAggregate()
// ---------------------------------------------------------------------------
describe('updateAggregate()', () => {
  it('creates new aggregate for unseen tool', () => {
    const h = createEmptyHistory();
    updateAggregate(h, 'Read', { tool: 'Read', score: 0.8, timestamp: Date.now() });
    expect(h.aggregates.Read).toBeDefined();
    expect(h.aggregates.Read.totalUses).toBe(1);
    expect(h.aggregates.Read.avgScore).toBeCloseTo(0.8, 1);
  });

  it('updates existing aggregate incrementally', () => {
    const h = createEmptyHistory();
    updateAggregate(h, 'Read', { tool: 'Read', score: 0.8, timestamp: Date.now() });
    updateAggregate(h, 'Read', { tool: 'Read', score: 0.6, timestamp: Date.now() });
    expect(h.aggregates.Read.totalUses).toBe(2);
    expect(h.aggregates.Read.avgScore).toBeCloseTo(0.7, 1);
  });

  it('updates lastUsed timestamp', () => {
    const h = createEmptyHistory();
    const ts = Date.now();
    updateAggregate(h, 'Grep', { tool: 'Grep', score: 1.0, timestamp: ts });
    expect(h.aggregates.Grep.lastUsed).toBe(ts);
  });
});

// ---------------------------------------------------------------------------
// rebuildAggregates()
// ---------------------------------------------------------------------------
describe('rebuildAggregates()', () => {
  it('rebuilds all aggregates from contexts', () => {
    const h = createEmptyHistory();
    h.contexts = {
      ctx1: [
        { tool: 'Read', score: 0.8, timestamp: 1000 },
        { tool: 'Read', score: 0.6, timestamp: 2000 },
      ],
      ctx2: [
        { tool: 'Write', score: 0.9, timestamp: 3000 },
      ],
    };
    rebuildAggregates(h);
    expect(h.aggregates.Read.totalUses).toBe(2);
    expect(h.aggregates.Write.totalUses).toBe(1);
  });

  it('clears previous aggregates before rebuilding', () => {
    const h = createEmptyHistory();
    h.aggregates = { OldTool: { totalUses: 5 } };
    h.contexts = {};
    rebuildAggregates(h);
    expect(h.aggregates.OldTool).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// computeToolScores()
// ---------------------------------------------------------------------------
describe('computeToolScores()', () => {
  it('returns empty array for empty records', () => {
    expect(computeToolScores([])).toEqual([]);
  });

  it('computes scores for single tool', () => {
    const records = [
      { tool: 'Read', score: 0.8, timestamp: Date.now() },
    ];
    const result = computeToolScores(records);
    expect(result).toHaveLength(1);
    expect(result[0].tool).toBe('Read');
    expect(result[0].weightedScore).toBeGreaterThan(0);
    expect(result[0].samples).toBe(1);
  });

  it('sorts by weighted score descending', () => {
    const now = Date.now();
    const records = [
      { tool: 'Bad', score: 0.2, timestamp: now },
      { tool: 'Good', score: 0.9, timestamp: now },
    ];
    const result = computeToolScores(records);
    expect(result[0].tool).toBe('Good');
  });

  it('applies time decay to older records', () => {
    const now = Date.now();
    const recent = [{ tool: 'A', score: 0.8, timestamp: now }];
    const old = [{ tool: 'A', score: 0.8, timestamp: now - 30 * 24 * 60 * 60 * 1000 }];
    const recentScores = computeToolScores(recent);
    const oldScores = computeToolScores(old);
    expect(recentScores[0].weightedScore).toBeGreaterThanOrEqual(oldScores[0].weightedScore);
  });

  it('includes confidence level', () => {
    const now = Date.now();
    const records = Array.from({ length: 5 }, (_, i) => ({
      tool: 'Read', score: 0.8, timestamp: now - i * 1000,
    }));
    const result = computeToolScores(records);
    expect(result[0].confidence).toBe('medium');
  });
});

// ---------------------------------------------------------------------------
// suggestFromRelated()
// ---------------------------------------------------------------------------
describe('suggestFromRelated()', () => {
  it('returns empty for single-part context', () => {
    const h = createEmptyHistory();
    expect(suggestFromRelated(h, 'nocolon', 5, 0.5)).toEqual([]);
  });

  it('returns empty when no related contexts exist', () => {
    const h = createEmptyHistory();
    expect(suggestFromRelated(h, 'search:new', 5, 0.5)).toEqual([]);
  });

  it('suggests tools from related contexts', () => {
    const h = createEmptyHistory();
    const now = Date.now();
    h.contexts = {
      'search:a': Array.from({ length: 5 }, () => ({ tool: 'Read', score: 0.9, timestamp: now })),
    };
    const result = suggestFromRelated(h, 'search:new', 5, 0.5);
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].confidence).toBe('low');
  });

  it('respects limit parameter', () => {
    const h = createEmptyHistory();
    const now = Date.now();
    h.contexts = {
      'op:a': [
        ...Array.from({ length: 5 }, () => ({ tool: 'T1', score: 0.9, timestamp: now })),
        ...Array.from({ length: 5 }, () => ({ tool: 'T2', score: 0.8, timestamp: now })),
        ...Array.from({ length: 5 }, () => ({ tool: 'T3', score: 0.7, timestamp: now })),
      ],
    };
    const result = suggestFromRelated(h, 'op:new', 2, 0.5);
    expect(result.length).toBeLessThanOrEqual(2);
  });

  it('filters by minScore', () => {
    const h = createEmptyHistory();
    const now = Date.now();
    h.contexts = {
      'op:a': Array.from({ length: 5 }, () => ({ tool: 'Low', score: 0.2, timestamp: now })),
    };
    const result = suggestFromRelated(h, 'op:new', 5, 0.5);
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// clampScore()
// ---------------------------------------------------------------------------
describe('clampScore()', () => {
  it('clamps to 0 for negative', () => {
    expect(clampScore(-1)).toBe(0);
  });

  it('clamps to 1 for values above 1', () => {
    expect(clampScore(2)).toBe(1);
  });

  it('returns value in range', () => {
    expect(clampScore(0.5)).toBe(0.5);
  });

  it('returns 0 for NaN', () => {
    expect(clampScore(NaN)).toBe(0);
  });

  it('returns 0 for non-numeric string', () => {
    expect(clampScore('abc')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// getConfidence()
// ---------------------------------------------------------------------------
describe('getConfidence()', () => {
  it('returns low for count < MIN_SAMPLES', () => {
    expect(getConfidence(0)).toBe('low');
    expect(getConfidence(1)).toBe('low');
    expect(getConfidence(2)).toBe('low');
  });

  it('returns medium for count >= MIN_SAMPLES and < 20', () => {
    expect(getConfidence(MIN_SAMPLES)).toBe('medium');
    expect(getConfidence(10)).toBe('medium');
    expect(getConfidence(19)).toBe('medium');
  });

  it('returns high for count >= 20', () => {
    expect(getConfidence(20)).toBe('high');
    expect(getConfidence(100)).toBe('high');
  });
});

// ---------------------------------------------------------------------------
// clearCache()
// ---------------------------------------------------------------------------
describe('clearCache()', () => {
  it('resets all internal state', async () => {
    await loadHistory();
    markDirty(vi.fn());
    clearCache();
    const state = getBufferState();
    expect(state.dirty).toBe(false);
    expect(state.hasTimer).toBe(false);
  });
});
