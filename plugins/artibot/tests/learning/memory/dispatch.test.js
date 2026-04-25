import { describe, expect, it, vi } from 'vitest';
import { createMemoryDispatcher } from '../../../lib/learning/memory/dispatch.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultTypeMap(t) {
  if (t === 'error') return 'errorPatterns';
  if (t === 'command') return 'commandHistory';
  if (t === 'context') return 'projectContexts';
  return 'userPreferences';
}

function makeDispatcher() {
  return createMemoryDispatcher({
    getMemoryDir: () => '/tmp/memory-test',
    typeToStoreKey: defaultTypeMap,
  });
}

function fakeRetriever(results) {
  return {
    search: vi.fn().mockResolvedValue({ results }),
  };
}

// ---------------------------------------------------------------------------
// Lazy singletons
// ---------------------------------------------------------------------------

describe('createMemoryDispatcher / lazy stores', () => {
  it('returns the same semantic store across calls', () => {
    const d = makeDispatcher();
    const a = d.getSemanticStore();
    const b = d.getSemanticStore();
    expect(a).toBe(b);
  });

  it('returns the same episodic store across calls', () => {
    const d = makeDispatcher();
    const a = d.getEpisodicStore();
    const b = d.getEpisodicStore();
    expect(a).toBe(b);
  });

  it('reset() clears semantic / episodic / retriever caches', () => {
    const d = makeDispatcher();
    d.__setSemanticStore({ id: 'fake-sem' });
    d.__setEpisodicStore({ id: 'fake-epi' });
    d.reset();
    // After reset, the next call must build a fresh real store object.
    const a = d.getSemanticStore();
    const b = d.getSemanticStore();
    expect(a).toBe(b);
    expect(a).not.toEqual({ id: 'fake-sem' });
  });

  it('test seams allow injecting working store override', () => {
    const d = makeDispatcher();
    const fake = { id: 'working' };
    d.__setWorkingStore(fake);
    d.__setWorkingStore(null); // reset path
    expect(d.searchMemoryHierarchical).toBeTypeOf('function');
  });

  it('__setRetrieverConfig invalidates the retriever cache', async () => {
    const d = makeDispatcher();
    const r1 = fakeRetriever([]);
    d.__setRetriever(r1);
    d.__setRetrieverConfig({ k: 1 }); // should invalidate r1
    const r2 = fakeRetriever([]);
    d.__setRetriever(r2);
    await d.searchMemoryHierarchical('q');
    expect(r2.search).toHaveBeenCalledOnce();
    expect(r1.search).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// searchMemoryHierarchical
// ---------------------------------------------------------------------------

describe('searchMemoryHierarchical', () => {
  it('returns null when retriever returns no results array', async () => {
    const d = makeDispatcher();
    d.__setRetriever({ search: vi.fn().mockResolvedValue(null) });
    expect(await d.searchMemoryHierarchical('q')).toBeNull();
  });

  it('returns null when retriever throws', async () => {
    const d = makeDispatcher();
    d.__setRetriever({ search: vi.fn().mockRejectedValue(new Error('boom')) });
    expect(await d.searchMemoryHierarchical('q')).toBeNull();
  });

  it('maps layer="working" to workingLayer store key', async () => {
    const d = makeDispatcher();
    d.__setRetriever(fakeRetriever([
      { entry: { type: 'note' }, score: 0.9, layer: 'working' },
    ]));
    const out = await d.searchMemoryHierarchical('q');
    expect(out[0].store).toBe('workingLayer');
    expect(out[0].layer).toBe('working');
  });

  it('maps layer="episodic" to projectContexts', async () => {
    const d = makeDispatcher();
    d.__setRetriever(fakeRetriever([
      { entry: { type: 'note' }, score: 0.5, layer: 'episodic' },
    ]));
    const out = await d.searchMemoryHierarchical('q');
    expect(out[0].store).toBe('projectContexts');
  });

  it('maps semantic-layer entries by entry.type', async () => {
    const d = makeDispatcher();
    d.__setRetriever(fakeRetriever([
      { entry: { type: 'error' }, score: 1, layer: 'semantic' },
      { entry: { type: 'command' }, score: 1, layer: 'semantic' },
      { entry: { type: 'context' }, score: 1, layer: 'semantic' },
      { entry: { type: 'other' }, score: 1, layer: 'semantic' },
      { entry: {}, score: 1, layer: 'semantic' }, // no type
    ]));
    const out = await d.searchMemoryHierarchical('q');
    expect(out.map((e) => e.store)).toEqual([
      'errorPatterns',
      'commandHistory',
      'projectContexts',
      'userPreferences',
      'userPreferences',
    ]);
  });

  it('filters by score threshold', async () => {
    const d = makeDispatcher();
    d.__setRetriever(fakeRetriever([
      { entry: {}, score: 0.1, layer: 'working' },
      { entry: {}, score: 0.7, layer: 'working' },
    ]));
    const out = await d.searchMemoryHierarchical('q', { threshold: 0.5 });
    expect(out.length).toBe(1);
    expect(out[0].score).toBe(0.7);
  });

  it('filters by types array via typeToStoreKey', async () => {
    const d = makeDispatcher();
    d.__setRetriever(fakeRetriever([
      { entry: { type: 'error' }, score: 1, layer: 'semantic' },
      { entry: { type: 'command' }, score: 1, layer: 'semantic' },
    ]));
    const out = await d.searchMemoryHierarchical('q', { types: ['error'] });
    expect(out.length).toBe(1);
    expect(out[0].store).toBe('errorPatterns');
  });

  it('ignores empty types array', async () => {
    const d = makeDispatcher();
    d.__setRetriever(fakeRetriever([
      { entry: { type: 'error' }, score: 1, layer: 'semantic' },
    ]));
    const out = await d.searchMemoryHierarchical('q', { types: [] });
    expect(out.length).toBe(1);
  });

  it('passes default limit=10 to retriever', async () => {
    const d = makeDispatcher();
    const r = fakeRetriever([]);
    d.__setRetriever(r);
    await d.searchMemoryHierarchical('q');
    expect(r.search).toHaveBeenCalledWith('q', { limit: 10 });
  });

  it('passes custom limit to retriever', async () => {
    const d = makeDispatcher();
    const r = fakeRetriever([]);
    d.__setRetriever(r);
    await d.searchMemoryHierarchical('q', { limit: 25 });
    expect(r.search).toHaveBeenCalledWith('q', { limit: 25 });
  });

  it('reuses cached retriever across calls', async () => {
    const d = makeDispatcher();
    const r = fakeRetriever([]);
    d.__setRetriever(r);
    await d.searchMemoryHierarchical('q1');
    await d.searchMemoryHierarchical('q2');
    expect(r.search).toHaveBeenCalledTimes(2);
  });
});
