import { beforeEach, describe, expect, it } from 'vitest';
import { _resetLifecycleCache, loadLifecycles } from '../../lib/core/lifecycle-manifest.js';
import {
  listRoutableLifecycles,
  routeByContext,
  routeLifecycle,
  skillsForLifecycle,
  suggestLifecycle,
  toolsetForLifecycle,
} from '../../lib/core/lifecycle-router.js';

describe('lifecycle-router', () => {
  beforeEach(() => {
    _resetLifecycleCache();
  });

  describe('routeLifecycle', () => {
    it('routes build to backend-developer with code toolset', async () => {
      const result = await routeLifecycle('build');
      expect(result).not.toBeNull();
      expect(result.lifecycle).toBe('build');
      expect(result.agent).toBe('backend-developer');
      expect(result.toolset).toBe('code');
      expect(Array.isArray(result.skills)).toBe(true);
      expect(Array.isArray(result.candidates)).toBe(true);
    });

    it('honors preferredAgent when it is in candidates', async () => {
      const result = await routeLifecycle('build', { preferredAgent: 'tdd-guide' });
      expect(result.agent).toBe('tdd-guide');
    });

    it('falls back to default_agent when preferredAgent is not in candidates', async () => {
      const result = await routeLifecycle('build', { preferredAgent: 'nonexistent' });
      expect(result.agent).toBe('backend-developer');
    });

    it('returns null agent for spec lifecycle (no default agent)', async () => {
      const result = await routeLifecycle('spec');
      expect(result).not.toBeNull();
      expect(result.agent).toBeNull();
      expect(result.toolset).toBe('meta');
    });

    it('returns null for an unknown lifecycle id', async () => {
      const result = await routeLifecycle('nonexistent-xyz');
      expect(result).toBeNull();
    });

    it('returns null for empty/invalid lifecycle id', async () => {
      expect(await routeLifecycle('')).toBeNull();
      expect(await routeLifecycle(null)).toBeNull();
      expect(await routeLifecycle(undefined)).toBeNull();
    });

    it('maps marketing lifecycle to marketing toolset', async () => {
      const result = await routeLifecycle('marketing');
      expect(result.toolset).toBe('marketing');
      expect(result.agent).toBe('marketing-strategist');
    });

    it('maps design lifecycle to design toolset', async () => {
      const result = await routeLifecycle('design');
      expect(result.toolset).toBe('design');
      expect(result.agent).toBe('architect');
    });

    it('maps ship lifecycle to devops toolset', async () => {
      const result = await routeLifecycle('ship');
      expect(result.toolset).toBe('devops');
      expect(result.agent).toBe('devops-engineer');
    });

    it('maps plan lifecycle to team toolset', async () => {
      const result = await routeLifecycle('plan');
      expect(result.toolset).toBe('team');
      expect(result.agent).toBe('planner');
    });

    it('allows preferredToolset to override lifecycle→toolset mapping', async () => {
      const result = await routeLifecycle('build', { preferredToolset: 'custom' });
      expect(result.toolset).toBe('custom');
    });

    it('candidates list matches lifecycle.json data', async () => {
      const manifest = await loadLifecycles();
      const expected = manifest.lifecycles.build.candidates;
      const result = await routeLifecycle('build');
      expect(result.candidates).toEqual(expected);
    });

    it('returns defensive copies of candidates (mutations do not leak)', async () => {
      const first = await routeLifecycle('build');
      first.candidates.push('mutant');
      const second = await routeLifecycle('build');
      expect(second.candidates).not.toContain('mutant');
    });

    it('resolves all 8 lifecycles without throwing', async () => {
      const ids = await listRoutableLifecycles();
      expect(ids).toHaveLength(8);
      for (const id of ids) {
        const result = await routeLifecycle(id);
        expect(result).not.toBeNull();
        expect(result.lifecycle).toBe(id);
      }
    });
  });

  describe('suggestLifecycle', () => {
    it('suggests build for "implement feature X"', async () => {
      expect(await suggestLifecycle('implement feature X')).toBe('build');
    });

    it('returns null for unclassifiable text', async () => {
      expect(await suggestLifecycle('xyzzy qqq foo bar')).toBeNull();
    });

    it('suggests marketing for Korean "마케팅 캠페인"', async () => {
      expect(await suggestLifecycle('마케팅 캠페인')).toBe('marketing');
    });

    it('returns null for empty string', async () => {
      expect(await suggestLifecycle('')).toBeNull();
    });
  });

  describe('routeByContext', () => {
    it('routes "review this PR" to the review lifecycle', async () => {
      const result = await routeByContext('review this PR');
      expect(result).not.toBeNull();
      expect(result.lifecycle).toBe('review');
      expect(result.agent).toBe('code-reviewer');
      expect(result.toolset).toBe('code');
    });

    it('returns null for gibberish input', async () => {
      const result = await routeByContext('gibberish xyz qqq');
      expect(result).toBeNull();
    });

    it('forwards preferredAgent through to routeLifecycle', async () => {
      const result = await routeByContext('implement API endpoint', {
        preferredAgent: 'typescript-pro',
      });
      expect(result.lifecycle).toBe('build');
      expect(result.agent).toBe('typescript-pro');
    });
  });

  describe('toolsetForLifecycle', () => {
    it('returns the configured toolset for known lifecycles', () => {
      expect(toolsetForLifecycle('build')).toBe('code');
      expect(toolsetForLifecycle('verify')).toBe('code');
      expect(toolsetForLifecycle('review')).toBe('code');
      expect(toolsetForLifecycle('ship')).toBe('devops');
      expect(toolsetForLifecycle('marketing')).toBe('marketing');
      expect(toolsetForLifecycle('design')).toBe('design');
      expect(toolsetForLifecycle('plan')).toBe('team');
      expect(toolsetForLifecycle('spec')).toBe('meta');
    });

    it('returns null for unknown/empty lifecycle ids', () => {
      expect(toolsetForLifecycle('unknown')).toBeNull();
      expect(toolsetForLifecycle('')).toBeNull();
    });
  });

  describe('skillsForLifecycle', () => {
    it('returns an array for every known lifecycle', () => {
      expect(Array.isArray(skillsForLifecycle('build'))).toBe(true);
      expect(Array.isArray(skillsForLifecycle('spec'))).toBe(true);
    });

    it('returns an empty array for unknown lifecycles', () => {
      expect(skillsForLifecycle('nope')).toEqual([]);
    });
  });
});
