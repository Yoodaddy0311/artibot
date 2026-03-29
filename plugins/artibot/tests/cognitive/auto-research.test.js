import { describe, expect, it, vi } from 'vitest';
import {
  createAutoResearch,
  deduplicateItems,
  extractKeywords,
  scoreQuality,
  scoreRelevance,
  selectSources,
} from '../../lib/cognitive/auto-research.js';

// ---------------------------------------------------------------------------
// extractKeywords
// ---------------------------------------------------------------------------
describe('extractKeywords', () => {
  it('extracts meaningful tokens', () => {
    const kw = extractKeywords('how to implement OAuth2 in Express');
    expect(kw).toContain('implement');
    expect(kw).toContain('oauth2');
    expect(kw).toContain('express');
  });

  it('removes stop words', () => {
    const kw = extractKeywords('the quick brown fox is on the table');
    expect(kw).not.toContain('the');
    expect(kw).not.toContain('is');
    expect(kw).not.toContain('on');
  });

  it('removes duplicates', () => {
    const kw = extractKeywords('test test test unique');
    expect(kw.filter((k) => k === 'test')).toHaveLength(1);
  });

  it('limits to 10 keywords', () => {
    const long = Array.from({ length: 20 }, (_, i) => `word${i}`).join(' ');
    expect(extractKeywords(long).length).toBeLessThanOrEqual(10);
  });

  it('handles Korean text', () => {
    const kw = extractKeywords('함수를 클래스에서 모듈로 변환');
    expect(kw).toContain('함수를');
    expect(kw).toContain('클래스에서');
  });

  it('returns empty for null/empty', () => {
    expect(extractKeywords(null)).toEqual([]);
    expect(extractKeywords('')).toEqual([]);
    expect(extractKeywords(undefined)).toEqual([]);
  });

  it('filters tokens shorter than 2 chars', () => {
    const kw = extractKeywords('I a am ok go no');
    expect(kw).not.toContain('i');
    expect(kw).not.toContain('a');
    expect(kw).toContain('ok');
    expect(kw).toContain('go');
    expect(kw).toContain('no');
  });
});

// ---------------------------------------------------------------------------
// selectSources
// ---------------------------------------------------------------------------
describe('selectSources', () => {
  it('selects codebase for code keywords', () => {
    const sources = selectSources(['function', 'export'], '');
    expect(sources.has('codebase')).toBe(true);
  });

  it('selects web for docs/library keywords', () => {
    const sources = selectSources(['documentation', 'npm'], '');
    expect(sources.has('web')).toBe(true);
  });

  it('selects memory for recall keywords', () => {
    const sources = selectSources(['previous', 'remember'], '');
    expect(sources.has('memory')).toBe(true);
  });

  it('selects web for "how to" pattern', () => {
    const sources = selectSources(['implement'], 'how to implement auth');
    expect(sources.has('web')).toBe(true);
  });

  it('selects codebase for file path pattern', () => {
    const sources = selectSources([], 'check /src/app.js for errors');
    expect(sources.has('codebase')).toBe(true);
  });

  it('falls back to codebase+memory when nothing matches', () => {
    const sources = selectSources(['xyzzy'], 'xyzzy');
    expect(sources.has('codebase')).toBe(true);
    expect(sources.has('memory')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// deduplicateItems
// ---------------------------------------------------------------------------
describe('deduplicateItems', () => {
  it('removes duplicate content by fingerprint', () => {
    const items = [
      { source: 'web', content: 'OAuth2 is a protocol for authorization' },
      { source: 'memory', content: 'OAuth2 is a protocol for authorization' },
      { source: 'codebase', content: 'Different content here' },
    ];
    expect(deduplicateItems(items)).toHaveLength(2);
  });

  it('keeps items with different content', () => {
    const items = [
      { source: 'web', content: 'Alpha content' },
      { source: 'web', content: 'Beta content' },
    ];
    expect(deduplicateItems(items)).toHaveLength(2);
  });

  it('handles empty array', () => {
    expect(deduplicateItems([])).toEqual([]);
  });

  it('skips items with empty content', () => {
    const items = [
      { source: 'web', content: '' },
      { source: 'web', content: '' },
      { source: 'web', content: 'real' },
    ];
    expect(deduplicateItems(items)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// scoreRelevance
// ---------------------------------------------------------------------------
describe('scoreRelevance', () => {
  it('returns 1.0 when all keywords match', () => {
    expect(scoreRelevance('oauth express auth', ['oauth', 'express', 'auth'])).toBe(1);
  });

  it('returns 0 when no keywords match', () => {
    expect(scoreRelevance('unrelated text', ['oauth', 'express'])).toBe(0);
  });

  it('returns partial score for partial match', () => {
    const score = scoreRelevance('oauth is great', ['oauth', 'express']);
    expect(score).toBe(0.5);
  });

  it('returns 0 for empty inputs', () => {
    expect(scoreRelevance('', ['kw'])).toBe(0);
    expect(scoreRelevance('text', [])).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// scoreQuality
// ---------------------------------------------------------------------------
describe('scoreQuality', () => {
  it('returns high score for diverse, voluminous, unique results', () => {
    const q = scoreQuality({ total: 15, deduplicated: 0, sources: ['web', 'codebase', 'memory'] });
    expect(q).toBeGreaterThanOrEqual(0.7);
  });

  it('returns low score for single source, few results', () => {
    const q = scoreQuality({ total: 1, deduplicated: 0, sources: ['web'] });
    expect(q).toBeLessThan(0.5);
  });

  it('penalizes high duplication', () => {
    const high = scoreQuality({ total: 10, deduplicated: 0, sources: ['web'] });
    const low = scoreQuality({ total: 10, deduplicated: 8, sources: ['web'] });
    expect(high).toBeGreaterThan(low);
  });

  it('returns 0 for empty stats', () => {
    expect(scoreQuality({ total: 0, deduplicated: 0, sources: [] })).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// createAutoResearch — shouldResearch
// ---------------------------------------------------------------------------
describe('createAutoResearch', () => {
  describe('shouldResearch', () => {
    const ar = createAutoResearch();

    it('returns true when confidence < 0.3', () => {
      expect(ar.shouldResearch({ confidence: 0.1 })).toBe(true);
      expect(ar.shouldResearch({ confidence: 0.29 })).toBe(true);
    });

    it('returns false when confidence >= 0.3', () => {
      expect(ar.shouldResearch({ confidence: 0.3 })).toBe(false);
      expect(ar.shouldResearch({ confidence: 0.8 })).toBe(false);
    });

    it('returns false for null routing result', () => {
      expect(ar.shouldResearch(null)).toBe(false);
    });

    it('respects custom threshold', () => {
      const custom = createAutoResearch({ confidenceThreshold: 0.5 });
      expect(custom.shouldResearch({ confidence: 0.4 })).toBe(true);
      expect(custom.shouldResearch({ confidence: 0.6 })).toBe(false);
    });

    it('uses score field as fallback', () => {
      expect(ar.shouldResearch({ score: 0.1 })).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // scope
  // ---------------------------------------------------------------------------
  describe('scope', () => {
    const ar = createAutoResearch();

    it('returns frozen object with keywords, sources, query', () => {
      const s = ar.scope('how to use express middleware');
      expect(s.keywords).toBeInstanceOf(Array);
      expect(s.sources).toBeInstanceOf(Set);
      expect(s.query).toBe('how to use express middleware');
      expect(Object.isFrozen(s)).toBe(true);
    });

    it('handles empty query', () => {
      const s = ar.scope('');
      expect(s.keywords).toEqual([]);
      expect(s.sources.size).toBeGreaterThan(0);
    });
  });

  // ---------------------------------------------------------------------------
  // gather
  // ---------------------------------------------------------------------------
  describe('gather', () => {
    it('calls all injected functions in parallel', async () => {
      const searchFn = vi.fn().mockResolvedValue([{ content: 'web result' }]);
      const grepFn = vi.fn().mockResolvedValue([{ content: 'code result' }]);
      const memoryRecallFn = vi.fn().mockResolvedValue([{ content: 'memory result' }]);
      const ar = createAutoResearch({ searchFn, grepFn, memoryRecallFn });

      const scopeResult = { keywords: ['test'], sources: new Set(['web', 'codebase', 'memory']), query: 'test' };
      const result = await ar.gather(scopeResult);

      expect(searchFn).toHaveBeenCalledTimes(1);
      expect(grepFn).toHaveBeenCalledTimes(1);
      expect(memoryRecallFn).toHaveBeenCalledTimes(1);
      expect(result.web).toHaveLength(1);
      expect(result.codebase).toHaveLength(1);
      expect(result.memory).toHaveLength(1);
      expect(result.errors).toHaveLength(0);
    });

    it('captures errors without failing other sources', async () => {
      const searchFn = vi.fn().mockRejectedValue(new Error('network error'));
      const grepFn = vi.fn().mockResolvedValue([{ content: 'code ok' }]);
      const ar = createAutoResearch({ searchFn, grepFn });

      const scopeResult = { keywords: ['test'], sources: new Set(['web', 'codebase']), query: 'test' };
      const result = await ar.gather(scopeResult);

      expect(result.web).toHaveLength(0);
      expect(result.codebase).toHaveLength(1);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].source).toBe('web');
    });

    it('skips sources without injected functions', async () => {
      const ar = createAutoResearch();
      const scopeResult = { keywords: ['test'], sources: new Set(['web', 'codebase', 'memory']), query: 'test' };
      const result = await ar.gather(scopeResult);

      expect(result.web).toHaveLength(0);
      expect(result.codebase).toHaveLength(0);
      expect(result.memory).toHaveLength(0);
    });

    it('limits results per source to maxResults', async () => {
      const items = Array.from({ length: 20 }, (_, i) => ({ content: `item ${i}` }));
      const grepFn = vi.fn().mockResolvedValue(items);
      const ar = createAutoResearch({ grepFn, maxResults: 5 });

      const scopeResult = { keywords: ['test'], sources: new Set(['codebase']), query: 'test' };
      const result = await ar.gather(scopeResult);

      expect(result.codebase).toHaveLength(5);
    });

    it('records elapsed time', async () => {
      const grepFn = vi.fn().mockResolvedValue([]);
      const ar = createAutoResearch({ grepFn });
      const scopeResult = { keywords: [], sources: new Set(['codebase']), query: '' };
      const result = await ar.gather(scopeResult);
      expect(typeof result.elapsed).toBe('number');
      expect(result.elapsed).toBeGreaterThanOrEqual(0);
    });
  });

  // ---------------------------------------------------------------------------
  // synthesize
  // ---------------------------------------------------------------------------
  describe('synthesize', () => {
    const ar = createAutoResearch();

    it('deduplicates and scores items', () => {
      const gatherResult = {
        web: [{ source: 'web', content: 'oauth guide for express' }],
        codebase: [{ source: 'codebase', content: 'oauth guide for express' }],
        memory: [{ source: 'memory', content: 'different content about auth' }],
      };
      const result = ar.synthesize(gatherResult, ['oauth', 'express']);

      expect(result.items.length).toBe(2);
      expect(result.stats.deduplicated).toBe(1);
      expect(result.quality).toBeGreaterThan(0);
      expect(Object.isFrozen(result)).toBe(true);
    });

    it('sorts by relevance descending', () => {
      const gatherResult = {
        web: [{ source: 'web', content: 'low relevance text' }],
        codebase: [{ source: 'codebase', content: 'oauth express middleware guide' }],
        memory: [],
      };
      const result = ar.synthesize(gatherResult, ['oauth', 'express']);
      expect(result.items[0].relevance).toBeGreaterThanOrEqual(result.items[1].relevance);
    });

    it('handles empty gather result', () => {
      const result = ar.synthesize({ web: [], codebase: [], memory: [] }, []);
      expect(result.items).toHaveLength(0);
      expect(result.quality).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // persist
  // ---------------------------------------------------------------------------
  describe('persist', () => {
    const ar = createAutoResearch();

    it('stores to session memory', () => {
      const mem = new Map();
      const synthesis = { items: [{ source: 'web', content: 'test', relevance: 0.9 }], quality: 0.7, stats: {} };
      const result = ar.persist(synthesis, mem);

      expect(result.stored).toBe(true);
      expect(result.key).toMatch(/^research:\d+$/);
      expect(mem.size).toBe(1);
    });

    it('returns stored:false without session memory', () => {
      const synthesis = { items: [], quality: 0, stats: {} };
      expect(ar.persist(synthesis, null).stored).toBe(false);
      expect(ar.persist(synthesis, {}).stored).toBe(false);
    });

    it('limits stored topItems to 5', () => {
      const mem = new Map();
      const items = Array.from({ length: 10 }, (_, i) => ({ source: 'web', content: `item ${i}`, relevance: 0.5 }));
      const synthesis = { items, quality: 0.5, stats: {} };
      ar.persist(synthesis, mem);

      const stored = [...mem.values()][0];
      expect(stored.topItems).toHaveLength(5);
    });
  });

  // ---------------------------------------------------------------------------
  // run (full pipeline)
  // ---------------------------------------------------------------------------
  describe('run', () => {
    it('skips when confidence is high', async () => {
      const ar = createAutoResearch();
      const result = await ar.run('query', { confidence: 0.8 });
      expect(result.skipped).toBe(true);
      expect(result.scope).toBeUndefined();
    });

    it('runs full pipeline when confidence is low', async () => {
      const searchFn = vi.fn().mockResolvedValue([{ content: 'web oauth docs' }]);
      const grepFn = vi.fn().mockResolvedValue([{ content: 'function oauth() {}' }]);
      const memoryRecallFn = vi.fn().mockResolvedValue([{ content: 'used oauth before' }]);
      const mem = new Map();
      const ar = createAutoResearch({ searchFn, grepFn, memoryRecallFn });

      const result = await ar.run(
        'how to implement oauth in express',
        { confidence: 0.1 },
        mem,
      );

      expect(result.skipped).toBe(false);
      expect(result.scope.keywords.length).toBeGreaterThan(0);
      expect(result.gather.elapsed).toBeGreaterThanOrEqual(0);
      expect(result.synthesis.items.length).toBeGreaterThan(0);
      expect(result.synthesis.quality).toBeGreaterThan(0);
      expect(result.persist.stored).toBe(true);
      expect(mem.size).toBe(1);
    });

    it('works without session memory', async () => {
      const grepFn = vi.fn().mockResolvedValue([{ content: 'result' }]);
      const ar = createAutoResearch({ grepFn });

      const result = await ar.run('function export test', { confidence: 0.1 });
      expect(result.skipped).toBe(false);
      expect(result.persist.stored).toBe(false);
    });

    it('returns frozen result', async () => {
      const ar = createAutoResearch();
      const result = await ar.run('test', { confidence: 0.1 });
      expect(Object.isFrozen(result)).toBe(true);
    });
  });
});
