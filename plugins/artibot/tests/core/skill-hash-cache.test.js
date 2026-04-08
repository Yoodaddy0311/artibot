import { describe, expect, it } from 'vitest';
import {
  buildSkillHashCache,
  loadSkillHashCache,
  persistSkillHashCache,
  refreshIfStale,
  shouldRebuildCache,
} from '../../lib/core/skill-hash-cache.js';

/**
 * The cache module reads `getPluginRoot()` to locate the skills directory and
 * cache file. We can't easily mock that here without polluting other tests, so
 * these tests exercise the real plugin layout (which has 119 SKILL.md files
 * after Sub-Phase 5). The contracts under test (count > 0, deterministic hash,
 * graceful failure) are layout-stable.
 */

describe('skill-hash-cache', () => {
  describe('buildSkillHashCache', () => {
    it('returns a cache object with version, generatedAt, and skills', async () => {
      const data = await buildSkillHashCache();
      expect(data).toHaveProperty('version', 1);
      expect(data).toHaveProperty('generatedAt');
      expect(data).toHaveProperty('skills');
      expect(typeof data.skills).toBe('object');
    });

    it('includes at least one skill from the live skills directory', async () => {
      const data = await buildSkillHashCache();
      const names = Object.keys(data.skills);
      expect(names.length).toBeGreaterThan(0);
    });

    it('each skill entry has hash, path, and size fields', async () => {
      const data = await buildSkillHashCache();
      const first = Object.values(data.skills)[0];
      expect(first).toHaveProperty('hash');
      expect(first).toHaveProperty('path');
      expect(first).toHaveProperty('size');
      expect(typeof first.hash).toBe('string');
      expect(first.hash).toHaveLength(8);
    });
  });

  describe('persistSkillHashCache + loadSkillHashCache', () => {
    it('persists data and loads it back identically', async () => {
      const built = await buildSkillHashCache();
      expect(persistSkillHashCache(built)).toBe(true);
      const loaded = await loadSkillHashCache();
      expect(loaded).not.toBeNull();
      expect(loaded.version).toBe(built.version);
      expect(Object.keys(loaded.skills).length).toBe(Object.keys(built.skills).length);
    });

    it('persistSkillHashCache returns false on bad input', () => {
      // atomicWriteSync handles JSON.stringify; circular refs throw.
      const circular = {};
      circular.self = circular;
      expect(persistSkillHashCache(circular)).toBe(false);
    });
  });

  describe('shouldRebuildCache', () => {
    it('rebuilds when ARTIBOT_REFRESH_HASHES=1 regardless of mtime', async () => {
      const original = process.env.ARTIBOT_REFRESH_HASHES;
      process.env.ARTIBOT_REFRESH_HASHES = '1';
      try {
        const result = await shouldRebuildCache(Number.MAX_SAFE_INTEGER);
        expect(result).toBe(true);
      } finally {
        if (original === undefined) delete process.env.ARTIBOT_REFRESH_HASHES;
        else process.env.ARTIBOT_REFRESH_HASHES = original;
      }
    });

    it('does not rebuild when cache is fresh', async () => {
      // Ensure a fresh cache exists.
      const data = await buildSkillHashCache();
      persistSkillHashCache(data);
      const result = await shouldRebuildCache(60_000);
      expect(result).toBe(false);
    });
  });

  describe('refreshIfStale', () => {
    it('returns a non-null cache object on success', async () => {
      const data = await refreshIfStale();
      expect(data).not.toBeNull();
      expect(data.skills).toBeDefined();
    });
  });
});
