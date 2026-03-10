/**
 * Tests for tool-history.js — persistence, scoring, and GRPO helpers.
 *
 * @module tests/learning/tool-history
 */

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

import {
  clampScore,
  clearCache,
  clearDirtyState,
  computeGrpoComposite,
  computeToolScores,
  countGrpoComparisons,
  createEmptyHistory,
  FLUSH_INTERVAL_MS,
  gatherRelatedTools,
  getBufferState,
  getConfidence,
  getDirtyState,
  GRPO_LEARNING_RATE,
  GRPO_WEIGHTS,
  loadHistory,
  makeGrpoKey,
  markDirty,
  MAX_GRPO_GROUPS_PER_KEY,
  MIN_SAMPLES,
  rebuildAggregates,
  saveHistory,
  setHistory,
  splitGrpoKey,
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

  it('GRPO_WEIGHTS sum to 1.0', () => {
    const sum = Object.values(GRPO_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1.0, 5);
  });

  it('GRPO_LEARNING_RATE is between 0 and 1', () => {
    expect(GRPO_LEARNING_RATE).toBeGreaterThan(0);
    expect(GRPO_LEARNING_RATE).toBeLessThanOrEqual(1);
  });

  it('MAX_GRPO_GROUPS_PER_KEY is a positive number', () => {
    expect(MAX_GRPO_GROUPS_PER_KEY).toBeGreaterThan(0);
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
    expect(h.grpoGroups).toEqual({});
    expect(h.grpoScores).toEqual({});
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
    const saved = { version: 2, contexts: { x: [] }, aggregates: {}, grpoGroups: {}, grpoScores: {}, lastUpdated: 1 };
    fs.readFile.mockResolvedValueOnce(JSON.stringify(saved));
    clearCache();
    const h = await loadHistory();
    expect(h.version).toBe(2);
    expect(h.contexts).toEqual({ x: [] });
  });

  it('migrates v1 to v2 by adding GRPO fields', async () => {
    const v1 = { version: 1, contexts: {}, aggregates: {}, lastUpdated: 1 };
    fs.readFile.mockResolvedValueOnce(JSON.stringify(v1));
    clearCache();
    const h = await loadHistory();
    expect(h.version).toBe(2);
    expect(h.grpoGroups).toEqual({});
    expect(h.grpoScores).toEqual({});
  });

  it('resets to empty when version < 1', async () => {
    fs.readFile.mockResolvedValueOnce(JSON.stringify({ version: 0, contexts: { a: [1] } }));
    clearCache();
    const h = await loadHistory();
    expect(h.version).toBe(2);
    expect(h.contexts).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// saveHistory()
// ---------------------------------------------------------------------------
describe('saveHistory()', () => {
  it('writes JSON to disk', async () => {
    await loadHistory();
    await saveHistory();
    expect(fs.mkdir).toHaveBeenCalled();
    expect(fs.writeFile).toHaveBeenCalledTimes(1);
  });

  it('does nothing if history is not loaded', async () => {
    await saveHistory();
    expect(fs.writeFile).not.toHaveBeenCalled();
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
// computeGrpoComposite()
// ---------------------------------------------------------------------------
describe('computeGrpoComposite()', () => {
  it('returns 1.0 for perfect result in single-member group', () => {
    const result = { success: true, durationMs: 100, accuracy: 1.0, brevity: 1.0 };
    const score = computeGrpoComposite(result, [result]);
    expect(score).toBeCloseTo(1.0, 2);
  });

  it('returns lower score for failed result', () => {
    const fail = { success: false, durationMs: 100, accuracy: 0.5, brevity: 0.5 };
    const pass = { success: true, durationMs: 100, accuracy: 0.5, brevity: 0.5 };
    const failScore = computeGrpoComposite(fail, [fail, pass]);
    const passScore = computeGrpoComposite(pass, [fail, pass]);
    expect(failScore).toBeLessThan(passScore);
  });

  it('normalizes speed across group', () => {
    const fast = { success: true, durationMs: 50, accuracy: 0.8, brevity: 0.8 };
    const slow = { success: true, durationMs: 500, accuracy: 0.8, brevity: 0.8 };
    const group = [fast, slow];
    const fastScore = computeGrpoComposite(fast, group);
    const slowScore = computeGrpoComposite(slow, group);
    expect(fastScore).toBeGreaterThan(slowScore);
  });

  it('handles equal durations in group', () => {
    const r1 = { success: true, durationMs: 100, accuracy: 0.8, brevity: 0.8 };
    const r2 = { success: true, durationMs: 100, accuracy: 0.8, brevity: 0.8 };
    const score = computeGrpoComposite(r1, [r1, r2]);
    expect(score).toBeGreaterThan(0);
  });

  it('handles zero durations gracefully', () => {
    const r = { success: true, durationMs: 0, accuracy: 0.8, brevity: 0.8 };
    const score = computeGrpoComposite(r, [r]);
    expect(score).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// makeGrpoKey() / splitGrpoKey()
// ---------------------------------------------------------------------------
describe('makeGrpoKey() / splitGrpoKey()', () => {
  it('creates a key from context and tool', () => {
    expect(makeGrpoKey('search:file', 'Read')).toBe('search:file::Read');
  });

  it('splits key back into context and tool', () => {
    expect(splitGrpoKey('search:file::Read')).toEqual(['search:file', 'Read']);
  });

  it('handles key without :: separator', () => {
    expect(splitGrpoKey('noseparator')).toEqual(['noseparator', '']);
  });
});

// ---------------------------------------------------------------------------
// countGrpoComparisons()
// ---------------------------------------------------------------------------
describe('countGrpoComparisons()', () => {
  it('returns 0 for empty context', () => {
    const h = createEmptyHistory();
    expect(countGrpoComparisons(h, 'ctx', 'Read')).toBe(0);
  });

  it('counts groups containing the tool', () => {
    const h = createEmptyHistory();
    h.grpoGroups.ctx = [
      { rankings: [{ tool: 'Read' }, { tool: 'Write' }] },
      { rankings: [{ tool: 'Write' }, { tool: 'Grep' }] },
      { rankings: [{ tool: 'Read' }, { tool: 'Grep' }] },
    ];
    expect(countGrpoComparisons(h, 'ctx', 'Read')).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// gatherRelatedTools()
// ---------------------------------------------------------------------------
describe('gatherRelatedTools()', () => {
  it('returns empty map for single-part context', () => {
    const h = createEmptyHistory();
    expect(gatherRelatedTools(h, 'noseparator').size).toBe(0);
  });

  it('gathers tools from related contexts by prefix', () => {
    const h = createEmptyHistory();
    h.contexts = {
      'search:file': [{ tool: 'Read', score: 0.8 }],
      'search:code': [{ tool: 'Grep', score: 0.9 }],
      'build:app': [{ tool: 'Write', score: 0.7 }],
    };
    const related = gatherRelatedTools(h, 'search:new');
    expect(related.size).toBe(2);
    expect(related.get('Read')).toBe(0.8);
    expect(related.get('Grep')).toBe(0.9);
  });

  it('excludes exact matching context', () => {
    const h = createEmptyHistory();
    h.contexts = {
      'search:file': [{ tool: 'Read', score: 0.8 }],
    };
    const related = gatherRelatedTools(h, 'search:file');
    expect(related.size).toBe(0);
  });

  it('keeps highest score for duplicate tools', () => {
    const h = createEmptyHistory();
    h.contexts = {
      'search:a': [{ tool: 'Read', score: 0.6 }],
      'search:b': [{ tool: 'Read', score: 0.9 }],
    };
    const related = gatherRelatedTools(h, 'search:new');
    expect(related.get('Read')).toBe(0.9);
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
