/**
 * Tests for lib/learning/memory/retriever.js — 3-layer parallel retriever.
 *
 * Covers:
 *   - Parallel 3-layer scan (working/episodic/semantic stubs)
 *   - Score merge + ordering
 *   - Dedup by episode/signature hash (working never dedups)
 *   - Graceful null-workingStore fallback
 *   - Per-call + per-factory weights override
 *   - Optional metrics recorder invocation
 *   - Empty-query short-circuit
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __test__,
  applyScoring,
  createRetriever,
  dedupResults,
  frequencyBoost,
  recencyBoost,
  resolveWeights,
} from '../../../lib/learning/memory/retriever.js';

// ---------------------------------------------------------------------------
// Stub factory helpers
// ---------------------------------------------------------------------------

function makeWorkingStore(results, { failing = false } = {}) {
  return {
    search: vi.fn(async () => {
      if (failing) throw new Error('working failure');
      return results;
    }),
  };
}

function makeEpisodicStore(results, { failing = false } = {}) {
  return {
    findEpisodes: vi.fn(async () => {
      if (failing) throw new Error('episodic failure');
      return results;
    }),
  };
}

function makeSemanticStore(results, { failing = false } = {}) {
  return {
    find: vi.fn(async () => {
      if (failing) throw new Error('semantic failure');
      return results;
    }),
  };
}

function makeMetrics() {
  return {
    recordQuery: vi.fn(),
    snapshot: vi.fn(() => ({ snapshot: true })),
  };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('retriever — pure helpers', () => {
  describe('resolveWeights', () => {
    it('falls back to design defaults when override is absent', () => {
      const w = resolveWeights();
      expect(w).toEqual({ working: 0.5, episodic: 0.3, semantic: 0.2 });
    });

    it('merges numeric overrides and ignores non-numeric values', () => {
      const w = resolveWeights({ working: 0.7, episodic: 'bad', semantic: -1 });
      expect(w.working).toBe(0.7);
      expect(w.episodic).toBe(0.3); // default
      expect(w.semantic).toBe(0.2); // default (negative rejected)
    });

    it('returns a frozen object', () => {
      const w = resolveWeights({ working: 0.4 });
      expect(Object.isFrozen(w)).toBe(true);
    });
  });

  describe('recencyBoost', () => {
    it('returns 1.0 for working layer', () => {
      expect(recencyBoost('working', {})).toBe(1.0);
    });

    it('returns 0.7 constant for semantic layer', () => {
      expect(recencyBoost('semantic', {})).toBe(0.7);
    });

    it('decays episodic recency exponentially with age', () => {
      const now = 100 * 24 * 60 * 60 * 1000; // day 100
      const fresh = recencyBoost('episodic', { timestamp: now }, now);
      const stale = recencyBoost('episodic', { timestamp: 0 }, now);
      expect(fresh).toBeCloseTo(1.0, 5);
      expect(stale).toBeLessThan(fresh);
      expect(stale).toBeGreaterThan(0);
    });

    it('returns the episodic constant when timestamp is missing', () => {
      expect(recencyBoost('episodic', {}, Date.now())).toBe(0.5);
    });
  });

  describe('frequencyBoost', () => {
    it('working never contributes', () => {
      expect(frequencyBoost('working', { recallCount: 99 })).toBe(0);
    });

    it('episodic uses log(1+recallCount)', () => {
      expect(frequencyBoost('episodic', { recallCount: 0 })).toBe(0);
      expect(frequencyBoost('episodic', { recallCount: 9 })).toBeCloseTo(Math.log(10), 5);
    });

    it('semantic uses log(1+usageCount)', () => {
      expect(frequencyBoost('semantic', { usageCount: 0 })).toBe(0);
      expect(frequencyBoost('semantic', { usageCount: 99 })).toBeCloseTo(Math.log(100), 5);
    });
  });

  describe('applyScoring', () => {
    it('composes layer_weight × similarity × (1+recency) × (1+0.1·freq)', () => {
      const weights = { working: 0.5, episodic: 0.3, semantic: 0.2 };
      const scored = applyScoring(
        [
          { entry: { id: 'w1' }, similarity: 1.0, layer: 'working' },
          { entry: { id: 's1', usageCount: 9 }, similarity: 0.5, layer: 'semantic' },
        ],
        weights,
        Date.now(),
      );
      // working: 0.5 * 1 * (1+1) * (1+0) = 1.0
      expect(scored[0].score).toBeCloseTo(1.0, 5);
      // semantic: 0.2 * 0.5 * (1+0.7) * (1+0.1·log(10)) ≈ 0.2 · 0.5 · 1.7 · 1.2303
      const expected = 0.2 * 0.5 * 1.7 * (1 + 0.1 * Math.log(10));
      expect(scored[1].score).toBeCloseTo(expected, 5);
      expect(scored[1].provenance.layerWeight).toBe(0.2);
    });

    it('skips malformed candidates', () => {
      const scored = applyScoring(
        [null, { similarity: 1.0, layer: 'working' }, { entry: { id: 'x' }, similarity: 1, layer: 'semantic' }],
        { working: 0.5, episodic: 0.3, semantic: 0.2 },
        Date.now(),
      );
      expect(scored).toHaveLength(1);
      expect(scored[0].entry.id).toBe('x');
    });
  });

  describe('dedupResults', () => {
    it('deduplicates episodic by hash and semantic by signatureHash', () => {
      const scored = [
        { entry: { hash: 'e1' }, score: 5, layer: 'episodic', provenance: {} },
        { entry: { hash: 'e1' }, score: 4, layer: 'episodic', provenance: {} },
        { entry: { signatureHash: 's1' }, score: 3, layer: 'semantic', provenance: {} },
        { entry: { signatureHash: 's1' }, score: 2, layer: 'semantic', provenance: {} },
      ];
      const out = dedupResults(scored);
      expect(out).toHaveLength(2);
      expect(out[0].score).toBe(5);
      expect(out[1].score).toBe(3);
    });

    it('never deduplicates working entries even if ids collide', () => {
      const scored = [
        { entry: { id: 'w1' }, score: 5, layer: 'working', provenance: {} },
        { entry: { id: 'w1' }, score: 4, layer: 'working', provenance: {} },
      ];
      const out = dedupResults(scored);
      expect(out).toHaveLength(2);
    });
  });
});

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

describe('createRetriever — search()', () => {
  let workingStore;
  let episodicStore;
  let semanticStore;
  let metrics;

  beforeEach(() => {
    workingStore = makeWorkingStore([
      { entry: { id: 'w-1', content: 'active intent' }, similarity: 0.9 },
    ]);
    episodicStore = makeEpisodicStore([
      { episode: { id: 'e-1', hash: 'eh1', timestamp: Date.now(), recallCount: 2 }, similarity: 0.8 },
      { episode: { id: 'e-2', hash: 'eh2', timestamp: Date.now() - 86400e3, recallCount: 0 }, similarity: 0.4 },
    ]);
    semanticStore = makeSemanticStore([
      { entry: { id: 's-1', signatureHash: 'sh1', usageCount: 3 }, score: 0.7 },
    ]);
    metrics = makeMetrics();
  });

  it('scans all 3 layers in parallel (Promise.all shape)', async () => {
    const retriever = createRetriever({ workingStore, episodicStore, semanticStore, metrics });
    const { results } = await retriever.search('hello');
    expect(workingStore.search).toHaveBeenCalledTimes(1);
    expect(episodicStore.findEpisodes).toHaveBeenCalledTimes(1);
    expect(semanticStore.find).toHaveBeenCalledTimes(1);
    expect(results.length).toBeGreaterThan(0);
  });

  it('returns results sorted by final score descending', async () => {
    const retriever = createRetriever({ workingStore, episodicStore, semanticStore });
    const { results } = await retriever.search('hello');
    for (let i = 1; i < results.length; i += 1) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }
    // Working entry (weight 0.5, recency 1.0) should top the list.
    expect(results[0].layer).toBe('working');
  });

  it('dedups across episodic/semantic but never working', async () => {
    episodicStore = makeEpisodicStore([
      { episode: { id: 'e-1', hash: 'eh-dup' }, similarity: 0.9 },
      { episode: { id: 'e-2', hash: 'eh-dup' }, similarity: 0.6 },
    ]);
    const retriever = createRetriever({ workingStore, episodicStore, semanticStore });
    const { results } = await retriever.search('dup');
    const episodicResults = results.filter((r) => r.layer === 'episodic');
    expect(episodicResults).toHaveLength(1);
  });

  it('handles a null working store gracefully (WC1 not yet present)', async () => {
    const retriever = createRetriever({
      workingStore: null,
      episodicStore,
      semanticStore,
      metrics,
    });
    const { results } = await retriever.search('query');
    expect(results.some((r) => r.layer === 'working')).toBe(false);
    expect(metrics.recordQuery).toHaveBeenCalledWith('working', 0);
  });

  it('falls back to snapshot() when working store has no search()', async () => {
    const snapshotStore = {
      snapshot: vi.fn(() => ({
        entries: [
          { id: 'w-a', content: 'query about artibot memory' },
          { id: 'w-b', content: 'unrelated chatter' },
        ],
      })),
    };
    const retriever = createRetriever({
      workingStore: snapshotStore,
      episodicStore: makeEpisodicStore([]),
      semanticStore: makeSemanticStore([]),
    });
    const { results } = await retriever.search('artibot memory');
    expect(snapshotStore.snapshot).toHaveBeenCalled();
    expect(results.some((r) => r.layer === 'working' && r.entry.id === 'w-a')).toBe(true);
  });

  it('isolates per-layer failures (one scanner throws → others still succeed)', async () => {
    workingStore = makeWorkingStore([], { failing: true });
    const retriever = createRetriever({ workingStore, episodicStore, semanticStore });
    const { results } = await retriever.search('query');
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.layer === 'episodic' || r.layer === 'semantic')).toBe(true);
  });

  it('applies factory-level config weights', async () => {
    const retriever = createRetriever({
      workingStore,
      episodicStore,
      semanticStore,
      config: {
        learning: {
          hierarchicalMemory: {
            weights: { working: 0.1, episodic: 0.1, semantic: 0.9 },
          },
        },
      },
    });
    const { results } = await retriever.search('query');
    expect(results[0].layer).toBe('semantic');
  });

  it('accepts per-call layerWeights override', async () => {
    const retriever = createRetriever({ workingStore, episodicStore, semanticStore });
    const { results } = await retriever.search('query', {
      layerWeights: { semantic: 10.0 },
    });
    expect(results[0].layer).toBe('semantic');
  });

  it('emits metrics.recordQuery once per layer', async () => {
    const retriever = createRetriever({ workingStore, episodicStore, semanticStore, metrics });
    await retriever.search('query');
    const calls = metrics.recordQuery.mock.calls.map((c) => c[0]).sort();
    expect(calls).toEqual(['episodic', 'semantic', 'working']);
    expect(metrics.recordQuery).toHaveBeenCalledWith('working', 1);
    expect(metrics.recordQuery).toHaveBeenCalledWith('episodic', 2);
    expect(metrics.recordQuery).toHaveBeenCalledWith('semantic', 1);
  });

  it('short-circuits on empty/non-string queries', async () => {
    const retriever = createRetriever({ workingStore, episodicStore, semanticStore });
    const out = await retriever.search('');
    expect(out.results).toEqual([]);
    expect(workingStore.search).not.toHaveBeenCalled();
  });

  it('truncates to opts.limit and returns frozen result objects', async () => {
    const retriever = createRetriever({ workingStore, episodicStore, semanticStore });
    const { results } = await retriever.search('query', { limit: 2 });
    expect(results.length).toBeLessThanOrEqual(2);
    for (const r of results) {
      expect(Object.isFrozen(r)).toBe(true);
      expect(r).toHaveProperty('layer');
      expect(r).toHaveProperty('score');
      expect(r).toHaveProperty('provenance');
    }
  });

  it('tolerates a metrics recorder whose recordQuery throws', async () => {
    const throwingMetrics = {
      recordQuery: vi.fn(() => { throw new Error('fail'); }),
      snapshot: vi.fn(() => null),
    };
    const retriever = createRetriever({
      workingStore,
      episodicStore,
      semanticStore,
      metrics: throwingMetrics,
    });
    const { results } = await retriever.search('query');
    expect(results.length).toBeGreaterThan(0);
  });

  it('exposes the __test__ internals for design auditors', () => {
    expect(__test__.LAYERS).toEqual(['working', 'episodic', 'semantic']);
    expect(__test__.DEFAULT_WEIGHTS.working).toBe(0.5);
    expect(Object.isFrozen(__test__)).toBe(true);
  });
});
