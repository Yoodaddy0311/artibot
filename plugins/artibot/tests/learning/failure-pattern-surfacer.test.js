import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildFailurePatternSurface,
  renderSurfaceBlock,
  replaceSurfaceBlock,
  SURFACE_BEGIN,
  SURFACE_END,
} from '../../lib/learning/failure-pattern-surfacer.js';
import { _resetCache } from '../../lib/learning/failure-categorizer.js';

const SAMPLE = {
  schemaVersion: 1,
  categories: [
    { id: 'low-one', label: 'Low sev', severity: 'low', weight: 1.0, signals: [], fixHints: ['fix-low'] },
    { id: 'crit-one', label: 'Critical sev', severity: 'critical', weight: 0.5, signals: [], fixHints: ['fix-crit'] },
    { id: 'high-a', label: 'High A', severity: 'high', weight: 0.9, signals: [], fixHints: [] },
    { id: 'high-b', label: 'High B', severity: 'high', weight: 0.9, signals: [], fixHints: ['hb'] },
    { id: 'med-one', label: 'Medium sev', severity: 'medium', weight: 0.8, signals: [], fixHints: [] },
  ],
};

function makeFs(content) {
  return {
    stat: async () => ({ mtimeMs: Date.now() + Math.random() }),
    readFile: async () => content,
  };
}

describe('failure-pattern-surfacer', () => {
  beforeEach(() => _resetCache());

  describe('renderSurfaceBlock()', () => {
    it('returns empty string for no categories', () => {
      expect(renderSurfaceBlock([])).toBe('');
      expect(renderSurfaceBlock(null)).toBe('');
    });

    it('ranks severity DESC then weight DESC then id ASC', () => {
      const block = renderSurfaceBlock(SAMPLE.categories, { topN: 5 });
      const critIdx = block.indexOf('crit-one');
      const highAIdx = block.indexOf('high-a');
      const highBIdx = block.indexOf('high-b');
      const medIdx = block.indexOf('med-one');
      const lowIdx = block.indexOf('low-one');
      // critical < high < medium < low (earlier index = higher priority)
      expect(critIdx).toBeLessThan(highAIdx);
      expect(highAIdx).toBeLessThan(highBIdx); // tie on sev+weight → id ASC
      expect(highBIdx).toBeLessThan(medIdx);
      expect(medIdx).toBeLessThan(lowIdx);
    });

    it('honours topN cap', () => {
      const block = renderSurfaceBlock(SAMPLE.categories, { topN: 2 });
      expect(block).toContain('crit-one');
      expect(block).toContain('high-a');
      expect(block).not.toContain('low-one');
      expect(block).toContain('top 2');
    });

    it('wraps output in sentinel markers', () => {
      const block = renderSurfaceBlock(SAMPLE.categories);
      expect(block.startsWith(SURFACE_BEGIN)).toBe(true);
      expect(block.trimEnd().endsWith(SURFACE_END)).toBe(true);
    });

    it('emits the first fix hint as a sub-bullet', () => {
      const block = renderSurfaceBlock(SAMPLE.categories, { topN: 1 });
      expect(block).toContain('↳ fix-crit');
    });

    it('omits the hint sub-bullet when fixHints is empty', () => {
      const block = renderSurfaceBlock(
        [{ id: 'no-hint', label: 'No hint', severity: 'high', signals: [], fixHints: [] }],
      );
      expect(block).toContain('no-hint');
      expect(block).not.toContain('↳');
    });
  });

  describe('replaceSurfaceBlock()', () => {
    it('returns null when no block present', () => {
      expect(replaceSurfaceBlock('# Notes\n\nbody', 'NEW')).toBeNull();
    });

    it('replaces the existing block in place (idempotent)', () => {
      const original = `header\n${SURFACE_BEGIN}\nold\n${SURFACE_END}\nfooter`;
      const updated = replaceSurfaceBlock(original, `${SURFACE_BEGIN}\nnew\n${SURFACE_END}`);
      expect(updated).toContain('new');
      expect(updated).not.toContain('old');
      expect(updated.startsWith('header')).toBe(true);
      expect(updated.endsWith('footer')).toBe(true);
      // Only one block — no stacking.
      expect(updated.split(SURFACE_BEGIN).length - 1).toBe(1);
    });
  });

  describe('buildFailurePatternSurface()', () => {
    it('loads dictionary via categorizer loader and renders block', async () => {
      const surface = await buildFailurePatternSurface({
        cwd: '/repo',
        fs: makeFs(JSON.stringify(SAMPLE)),
      });
      expect(surface).toContain(SURFACE_BEGIN);
      expect(surface).toContain('crit-one');
    });

    it('returns empty string when dictionary is missing', async () => {
      const failingFs = {
        stat: async () => { throw Object.assign(new Error('nope'), { code: 'ENOENT' }); },
        readFile: async () => { throw new Error('nope'); },
      };
      const surface = await buildFailurePatternSurface({ cwd: '/repo', fs: failingFs });
      expect(surface).toBe('');
    });

    it('returns empty string when dictionary JSON is malformed', async () => {
      const surface = await buildFailurePatternSurface({
        cwd: '/repo',
        fs: makeFs('{ not json'),
      });
      expect(surface).toBe('');
    });
  });
});
