import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LEVELS, mergeContexts, loadHierarchy, clearHierarchyCache } from '../../lib/context/hierarchy.js';

// Mock dependencies
vi.mock('../../lib/core/file.js', () => ({
  readJsonFile: vi.fn(() => Promise.resolve(null)),
}));

vi.mock('../../lib/core/platform.js', () => ({
  getPluginRoot: vi.fn(() => '/fake/root'),
}));

describe('hierarchy', () => {
  beforeEach(() => {
    clearHierarchyCache();
    vi.clearAllMocks();
  });

  describe('LEVELS', () => {
    it('defines 4 context levels', () => {
      expect(LEVELS).toEqual(['plugin', 'user', 'project', 'session']);
    });
  });

  describe('mergeContexts()', () => {
    it('merges flat objects', () => {
      const result = mergeContexts({ a: 1 }, { b: 2 });
      expect(result).toEqual({ a: 1, b: 2 });
    });

    it('later sources override earlier', () => {
      const result = mergeContexts({ a: 1 }, { a: 2 });
      expect(result.a).toBe(2);
    });

    it('deep merges nested objects', () => {
      const result = mergeContexts(
        { nested: { a: 1, b: 2 } },
        { nested: { b: 3, c: 4 } },
      );
      expect(result.nested).toEqual({ a: 1, b: 3, c: 4 });
    });

    it('arrays are replaced not merged', () => {
      const result = mergeContexts(
        { arr: [1, 2, 3] },
        { arr: [4, 5] },
      );
      expect(result.arr).toEqual([4, 5]);
    });

    it('handles multiple sources', () => {
      const result = mergeContexts({ a: 1 }, { b: 2 }, { c: 3 }, { a: 10 });
      expect(result).toEqual({ a: 10, b: 2, c: 3 });
    });

    it('handles empty objects', () => {
      const result = mergeContexts({}, { a: 1 }, {});
      expect(result).toEqual({ a: 1 });
    });

    it('handles deep nesting', () => {
      const result = mergeContexts(
        { l1: { l2: { l3: { val: 'old' } } } },
        { l1: { l2: { l3: { val: 'new', extra: true } } } },
      );
      expect(result.l1.l2.l3.val).toBe('new');
      expect(result.l1.l2.l3.extra).toBe(true);
    });

    it('does not mutate first-level source properties', () => {
      const src1 = { a: 1 };
      const src2 = { b: 2 };
      const result = mergeContexts(src1, src2);
      // Top-level properties of sources are not mutated
      expect(src1).toEqual({ a: 1 });
      expect(result).toEqual({ a: 1, b: 2 });
    });
  });

  describe('loadHierarchy()', () => {
    it('returns merged context from all levels', async () => {
      const { readJsonFile } = await import('../../lib/core/file.js');
      readJsonFile.mockResolvedValue({ level: 'plugin' });
      const result = await loadHierarchy();
      expect(result).toHaveProperty('level');
    });

    it('injects session data at session level', async () => {
      const { readJsonFile } = await import('../../lib/core/file.js');
      readJsonFile.mockResolvedValue(null);
      const result = await loadHierarchy({ sessionKey: 'val' });
      expect(result.sessionKey).toBe('val');
    });

    it('caches result when no session data', async () => {
      const { readJsonFile } = await import('../../lib/core/file.js');
      readJsonFile.mockResolvedValue(null);
      const first = await loadHierarchy();
      const second = await loadHierarchy();
      expect(first).toBe(second);
    });

    it('does not cache when session data is provided', async () => {
      const { readJsonFile } = await import('../../lib/core/file.js');
      readJsonFile.mockResolvedValue(null);
      const first = await loadHierarchy({ a: 1 });
      const second = await loadHierarchy({ b: 2 });
      expect(first).not.toBe(second);
    });
  });

  describe('clearHierarchyCache()', () => {
    it('forces reload on next loadHierarchy call', async () => {
      const { readJsonFile } = await import('../../lib/core/file.js');
      readJsonFile.mockResolvedValue({ version: '1' });
      await loadHierarchy();
      clearHierarchyCache();
      readJsonFile.mockResolvedValue({ version: '2' });
      const result = await loadHierarchy();
      expect(result.version).toBe('2');
    });
  });
});
