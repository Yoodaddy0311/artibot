import { beforeEach, describe, expect, it } from 'vitest';
import {
  _resetLifecycleCache,
  getCandidatesForLifecycle,
  getLifecycle,
  listLifecycles,
  loadLifecycles,
  matchContextToLifecycle,
} from '../../lib/core/lifecycle-manifest.js';

describe('lifecycle-manifest', () => {
  beforeEach(() => {
    _resetLifecycleCache();
  });

  describe('loadLifecycles', () => {
    it('returns a manifest containing 8 lifecycles', async () => {
      const manifest = await loadLifecycles();
      expect(manifest).toBeTruthy();
      expect(manifest.version).toBe(1);
      expect(Object.keys(manifest.lifecycles)).toHaveLength(8);
    });

    it('each lifecycle entry exposes label/description/candidates/context_matchers', async () => {
      const manifest = await loadLifecycles();
      for (const [, entry] of Object.entries(manifest.lifecycles)) {
        expect(typeof entry.label).toBe('string');
        expect(typeof entry.description).toBe('string');
        expect(Array.isArray(entry.candidates)).toBe(true);
        expect(Array.isArray(entry.context_matchers)).toBe(true);
      }
    });

    it('returns a cached instance on repeat calls', async () => {
      const first = await loadLifecycles();
      const second = await loadLifecycles();
      expect(second).toBe(first);
    });
  });

  describe('getLifecycle', () => {
    it('returns the build lifecycle with backend-developer as default agent', async () => {
      const entry = await getLifecycle('build');
      expect(entry).not.toBeNull();
      expect(entry.default_agent).toBe('backend-developer');
    });

    it('returns null for an unknown lifecycle id', async () => {
      const entry = await getLifecycle('nonexistent');
      expect(entry).toBeNull();
    });

    it('returns the spec lifecycle with a null default_agent', async () => {
      const entry = await getLifecycle('spec');
      expect(entry).not.toBeNull();
      expect(entry.default_agent).toBeNull();
    });
  });

  describe('listLifecycles', () => {
    it('returns exactly 8 lifecycle ids', async () => {
      const ids = await listLifecycles();
      expect(ids).toHaveLength(8);
      expect(ids).toContain('build');
      expect(ids).toContain('marketing');
    });
  });

  describe('getCandidatesForLifecycle', () => {
    it('includes backend-developer among the build candidates', async () => {
      const candidates = await getCandidatesForLifecycle('build');
      expect(candidates).toContain('backend-developer');
    });

    it('returns an empty array for an unknown lifecycle', async () => {
      const candidates = await getCandidatesForLifecycle('unknown');
      expect(candidates).toEqual([]);
    });

    it('returns an immutable copy (mutations do not leak into cache)', async () => {
      const first = await getCandidatesForLifecycle('build');
      first.push('mutant');
      const second = await getCandidatesForLifecycle('build');
      expect(second).not.toContain('mutant');
    });
  });

  describe('matchContextToLifecycle', () => {
    it('matches English "implement the API endpoint" to build', async () => {
      const result = await matchContextToLifecycle('implement the API endpoint');
      expect(result).not.toBeNull();
      expect(result.lifecycle).toBe('build');
      expect(result.score).toBeGreaterThan(0);
    });

    it('returns null for text with no matchable keywords', async () => {
      const result = await matchContextToLifecycle('xyzzy qqq foo bar baz');
      expect(result).toBeNull();
    });

    it('matches Korean "마케팅 캠페인" to marketing', async () => {
      const result = await matchContextToLifecycle('마케팅 캠페인');
      expect(result).not.toBeNull();
      expect(result.lifecycle).toBe('marketing');
    });
  });
});
