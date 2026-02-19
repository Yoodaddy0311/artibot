import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Cache, defaultCache } from '../../lib/core/cache.js';

describe('Cache', () => {
  let cache;

  beforeEach(() => {
    cache = new Cache(1000);
  });

  describe('constructor', () => {
    it('creates a cache with default TTL', () => {
      const c = new Cache();
      expect(c.size).toBe(0);
    });

    it('creates a cache with custom TTL', () => {
      const c = new Cache(5000);
      expect(c.size).toBe(0);
    });
  });

  describe('set()', () => {
    it('stores a value', () => {
      cache.set('key', 'value');
      expect(cache.get('key')).toBe('value');
    });

    it('returns this for chaining', () => {
      const result = cache.set('k', 'v');
      expect(result).toBe(cache);
    });

    it('overwrites existing keys', () => {
      cache.set('key', 'old');
      cache.set('key', 'new');
      expect(cache.get('key')).toBe('new');
    });

    it('stores various types', () => {
      cache.set('num', 42);
      cache.set('obj', { a: 1 });
      cache.set('arr', [1, 2, 3]);
      cache.set('null', null);
      expect(cache.get('num')).toBe(42);
      expect(cache.get('obj')).toEqual({ a: 1 });
      expect(cache.get('arr')).toEqual([1, 2, 3]);
      expect(cache.get('null')).toBeNull();
    });
  });

  describe('get()', () => {
    it('returns undefined for missing keys', () => {
      expect(cache.get('nonexistent')).toBeUndefined();
    });

    it('returns undefined for expired entries', () => {
      vi.useFakeTimers();
      cache.set('key', 'value', 100);
      vi.advanceTimersByTime(101);
      expect(cache.get('key')).toBeUndefined();
      vi.useRealTimers();
    });

    it('returns value for non-expired entries', () => {
      vi.useFakeTimers();
      cache.set('key', 'value', 1000);
      vi.advanceTimersByTime(500);
      expect(cache.get('key')).toBe('value');
      vi.useRealTimers();
    });

    it('cleans up expired entries on access', () => {
      vi.useFakeTimers();
      cache.set('key', 'value', 100);
      vi.advanceTimersByTime(101);
      cache.get('key');
      expect(cache.size).toBe(0);
      vi.useRealTimers();
    });
  });

  describe('has()', () => {
    it('returns true for existing non-expired keys', () => {
      cache.set('key', 'value');
      expect(cache.has('key')).toBe(true);
    });

    it('returns false for missing keys', () => {
      expect(cache.has('nonexistent')).toBe(false);
    });

    it('returns false for expired keys', () => {
      vi.useFakeTimers();
      cache.set('key', 'value', 100);
      vi.advanceTimersByTime(101);
      expect(cache.has('key')).toBe(false);
      vi.useRealTimers();
    });

    it('returns false when value is undefined', () => {
      // has() checks via get() !== undefined
      cache.set('key', undefined, 1000);
      // undefined value stored, get returns undefined, so has returns false
      expect(cache.has('key')).toBe(false);
    });
  });

  describe('delete()', () => {
    it('removes an entry', () => {
      cache.set('key', 'value');
      expect(cache.delete('key')).toBe(true);
      expect(cache.get('key')).toBeUndefined();
    });

    it('returns false for nonexistent keys', () => {
      expect(cache.delete('nonexistent')).toBe(false);
    });
  });

  describe('clear()', () => {
    it('removes all entries', () => {
      cache.set('a', 1);
      cache.set('b', 2);
      cache.clear();
      expect(cache.size).toBe(0);
      expect(cache.get('a')).toBeUndefined();
    });
  });

  describe('prune()', () => {
    it('removes expired entries', () => {
      vi.useFakeTimers();
      cache.set('expired', 'x', 100);
      cache.set('valid', 'y', 10000);
      vi.advanceTimersByTime(200);
      cache.prune();
      expect(cache.size).toBe(1);
      expect(cache.get('valid')).toBe('y');
      vi.useRealTimers();
    });

    it('does nothing when all entries are valid', () => {
      cache.set('a', 1);
      cache.set('b', 2);
      cache.prune();
      expect(cache.size).toBe(2);
    });
  });

  describe('size', () => {
    it('reflects the number of stored entries', () => {
      expect(cache.size).toBe(0);
      cache.set('a', 1);
      expect(cache.size).toBe(1);
      cache.set('b', 2);
      expect(cache.size).toBe(2);
      cache.delete('a');
      expect(cache.size).toBe(1);
    });
  });

  describe('custom TTL per entry', () => {
    it('respects per-entry TTL over default TTL', () => {
      vi.useFakeTimers();
      cache.set('short', 'v', 50);
      cache.set('long', 'v', 5000);
      vi.advanceTimersByTime(100);
      expect(cache.get('short')).toBeUndefined();
      expect(cache.get('long')).toBe('v');
      vi.useRealTimers();
    });
  });
});

describe('defaultCache', () => {
  it('is a Cache instance', () => {
    expect(defaultCache).toBeInstanceOf(Cache);
  });
});
