import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addEntry,
  CATEGORIES,
  createEmptyVault,
  decay,
  DECAY_MS,
  getEntries,
  getVaultStats,
  loadVault,
  MAX_ENTRIES_PER_CATEGORY,
  resetVault,
  search,
} from '../../lib/learning/vault.js';

// Mock fs to avoid actual disk I/O in tests
vi.mock('node:fs/promises', () => ({
  default: {
    readFile: vi.fn().mockRejectedValue(new Error('ENOENT')),
    writeFile: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
  },
}));

describe('vault', () => {
  beforeEach(() => {
    resetVault();
  });

  // -----------------------------------------------------------------------
  // CATEGORIES
  // -----------------------------------------------------------------------

  describe('CATEGORIES', () => {
    it('has 5 categories', () => {
      expect(CATEGORIES).toHaveLength(5);
    });

    it('includes all required categories', () => {
      expect(CATEGORIES).toContain('identity');
      expect(CATEGORIES).toContain('domain');
      expect(CATEGORIES).toContain('methodology');
      expect(CATEGORIES).toContain('preference');
      expect(CATEGORIES).toContain('constraint');
    });

    it('is frozen', () => {
      expect(Object.isFrozen(CATEGORIES)).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // createEmptyVault()
  // -----------------------------------------------------------------------

  describe('createEmptyVault()', () => {
    it('creates vault with version 1', () => {
      const vault = createEmptyVault();
      expect(vault.version).toBe(1);
    });

    it('creates empty arrays for all categories', () => {
      const vault = createEmptyVault();
      for (const cat of CATEGORIES) {
        expect(vault.categories[cat]).toEqual([]);
      }
    });

    it('sets lastUpdated timestamp', () => {
      const before = Date.now();
      const vault = createEmptyVault();
      expect(vault.lastUpdated).toBeGreaterThanOrEqual(before);
    });
  });

  // -----------------------------------------------------------------------
  // addEntry()
  // -----------------------------------------------------------------------

  describe('addEntry()', () => {
    it('adds entry to specified category', async () => {
      const result = await addEntry('domain', 'JavaScript expertise', 'test');
      expect(result.added).toBe(true);
      expect(result.category).toBe('domain');
      expect(result.id).toMatch(/^v-\d+-/);
    });

    it('rejects invalid category', async () => {
      await expect(addEntry('invalid', 'test', 'test')).rejects.toThrow('Invalid category');
    });

    it('stores content and source correctly', async () => {
      await addEntry('preference', 'Use TypeScript', 'user-request');
      const entries = await getEntries('preference');
      expect(entries).toHaveLength(1);
      expect(entries[0].content).toBe('Use TypeScript');
      expect(entries[0].source).toBe('user-request');
    });

    it('defaults source to unknown', async () => {
      await addEntry('identity', 'I am Artibot');
      const entries = await getEntries('identity');
      expect(entries[0].source).toBe('unknown');
    });

    it('attaches tags when provided', async () => {
      await addEntry('methodology', 'TDD workflow', 'guide', { tags: ['tdd', 'testing'] });
      const entries = await getEntries('methodology');
      expect(entries[0].tags).toEqual(['tdd', 'testing']);
    });

    it('sets createdAt and lastAccessed timestamps', async () => {
      const before = Date.now();
      await addEntry('domain', 'React', 'test');
      const entries = await getEntries('domain');
      expect(entries[0].createdAt).toBeGreaterThanOrEqual(before);
      expect(entries[0].lastAccessed).toBeGreaterThanOrEqual(before);
    });

    it('generates unique IDs', async () => {
      await addEntry('domain', 'entry1', 'test');
      await addEntry('domain', 'entry2', 'test');
      const entries = await getEntries('domain');
      expect(entries[0].id).not.toBe(entries[1].id);
    });
  });

  // -----------------------------------------------------------------------
  // getEntries()
  // -----------------------------------------------------------------------

  describe('getEntries()', () => {
    it('returns empty array for empty category', async () => {
      const entries = await getEntries('identity');
      expect(entries).toEqual([]);
    });

    it('rejects invalid category', async () => {
      await expect(getEntries('invalid')).rejects.toThrow('Invalid category');
    });

    it('returns all entries when no limit', async () => {
      await addEntry('domain', 'entry1', 'test');
      await addEntry('domain', 'entry2', 'test');
      await addEntry('domain', 'entry3', 'test');
      const entries = await getEntries('domain');
      expect(entries).toHaveLength(3);
    });

    it('limits results to most recent entries', async () => {
      await addEntry('domain', 'entry1', 'test');
      await addEntry('domain', 'entry2', 'test');
      await addEntry('domain', 'entry3', 'test');
      const entries = await getEntries('domain', 2);
      expect(entries).toHaveLength(2);
      expect(entries[0].content).toBe('entry2');
      expect(entries[1].content).toBe('entry3');
    });

    it('updates lastAccessed on retrieval', async () => {
      await addEntry('domain', 'test', 'test');
      const before = Date.now();
      await getEntries('domain');
      const vault = await loadVault();
      expect(vault.categories.domain[0].lastAccessed).toBeGreaterThanOrEqual(before);
    });
  });

  // -----------------------------------------------------------------------
  // search()
  // -----------------------------------------------------------------------

  describe('search()', () => {
    it('returns empty array for empty query', async () => {
      expect(await search('')).toEqual([]);
      expect(await search(null)).toEqual([]);
    });

    it('finds entries by content keyword', async () => {
      await addEntry('domain', 'JavaScript expertise', 'test');
      await addEntry('domain', 'Python scripting', 'test');
      const results = await search('JavaScript');
      expect(results).toHaveLength(1);
      expect(results[0].content).toBe('JavaScript expertise');
    });

    it('searches case-insensitively', async () => {
      await addEntry('domain', 'TypeScript configuration', 'test');
      const results = await search('typescript');
      expect(results).toHaveLength(1);
    });

    it('searches across all categories', async () => {
      await addEntry('domain', 'security knowledge', 'test');
      await addEntry('constraint', 'security requirement', 'test');
      const results = await search('security');
      expect(results).toHaveLength(2);
    });

    it('matches source field', async () => {
      await addEntry('preference', 'some pref', 'user-conversation');
      const results = await search('conversation');
      expect(results).toHaveLength(1);
    });

    it('matches tags', async () => {
      await addEntry('methodology', 'workflow', 'test', { tags: ['agile', 'sprint'] });
      const results = await search('agile');
      expect(results).toHaveLength(1);
    });

    it('ranks by match count', async () => {
      await addEntry('domain', 'React frontend framework', 'test', { tags: ['react'] });
      await addEntry('domain', 'Vue frontend', 'test');
      const results = await search('react frontend');
      // 'React frontend framework' matches both keywords + tag
      expect(results[0].content).toBe('React frontend framework');
    });

    it('handles whitespace-only query', async () => {
      expect(await search('   ')).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // decay()
  // -----------------------------------------------------------------------

  describe('decay()', () => {
    it('removes nothing when all entries are fresh', async () => {
      await addEntry('domain', 'fresh entry', 'test');
      const result = await decay();
      expect(result.removed).toBe(0);
      expect(result.remaining).toBe(1);
    });

    it('removes entries older than DECAY_MS', async () => {
      await addEntry('domain', 'old entry', 'test');

      // Manually age the entry
      const vault = await loadVault();
      vault.categories.domain[0].lastAccessed = Date.now() - DECAY_MS - 1000;

      const result = await decay();
      expect(result.removed).toBe(1);
      expect(result.remaining).toBe(0);
    });

    it('preserves recently accessed entries', async () => {
      await addEntry('domain', 'entry1', 'test');
      await addEntry('domain', 'entry2', 'test');

      const vault = await loadVault();
      // Age only the first entry
      vault.categories.domain[0].lastAccessed = Date.now() - DECAY_MS - 1000;

      const result = await decay();
      expect(result.removed).toBe(1);
      expect(result.remaining).toBe(1);
    });

    it('decays across all categories', async () => {
      await addEntry('domain', 'old domain', 'test');
      await addEntry('preference', 'old pref', 'test');
      await addEntry('constraint', 'fresh constraint', 'test');

      const vault = await loadVault();
      vault.categories.domain[0].lastAccessed = Date.now() - DECAY_MS - 1000;
      vault.categories.preference[0].lastAccessed = Date.now() - DECAY_MS - 1000;

      const result = await decay();
      expect(result.removed).toBe(2);
      expect(result.remaining).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // getVaultStats()
  // -----------------------------------------------------------------------

  describe('getVaultStats()', () => {
    it('returns zeros for empty vault', async () => {
      const stats = await getVaultStats();
      expect(stats.totalEntries).toBe(0);
      for (const cat of CATEGORIES) {
        expect(stats.byCategory[cat]).toBe(0);
      }
      expect(stats.oldestEntry).toBeNull();
      expect(stats.newestEntry).toBeNull();
    });

    it('counts entries per category', async () => {
      await addEntry('domain', 'd1', 'test');
      await addEntry('domain', 'd2', 'test');
      await addEntry('preference', 'p1', 'test');

      const stats = await getVaultStats();
      expect(stats.totalEntries).toBe(3);
      expect(stats.byCategory.domain).toBe(2);
      expect(stats.byCategory.preference).toBe(1);
      expect(stats.byCategory.identity).toBe(0);
    });

    it('tracks oldest and newest entries', async () => {
      await addEntry('domain', 'first', 'test');
      await addEntry('domain', 'second', 'test');

      const stats = await getVaultStats();
      expect(stats.oldestEntry).toBeLessThanOrEqual(stats.newestEntry);
    });
  });

  // -----------------------------------------------------------------------
  // resetVault()
  // -----------------------------------------------------------------------

  describe('resetVault()', () => {
    it('clears all vault state', async () => {
      await addEntry('domain', 'test', 'test');
      resetVault();
      const stats = await getVaultStats();
      expect(stats.totalEntries).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // Constants
  // -----------------------------------------------------------------------

  describe('constants', () => {
    it('DECAY_MS is 90 days', () => {
      expect(DECAY_MS).toBe(90 * 24 * 60 * 60 * 1000);
    });

    it('MAX_ENTRIES_PER_CATEGORY is 200', () => {
      expect(MAX_ENTRIES_PER_CATEGORY).toBe(200);
    });
  });

  // -----------------------------------------------------------------------
  // Category isolation
  // -----------------------------------------------------------------------

  describe('category isolation', () => {
    it('entries in one category do not affect others', async () => {
      await addEntry('domain', 'domain knowledge', 'test');
      await addEntry('identity', 'identity info', 'test');

      const domain = await getEntries('domain');
      const identity = await getEntries('identity');
      expect(domain).toHaveLength(1);
      expect(identity).toHaveLength(1);
      expect(domain[0].content).toBe('domain knowledge');
      expect(identity[0].content).toBe('identity info');
    });
  });
});
