import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLASSIFICATION,
  computeMetrics,
  createSkillEvolver,
  DEFAULT_THRESHOLDS,
  findCommonEdits,
  generateRefactorSuggestion,
} from '../../lib/learning/skill-evolver.js';

vi.mock('../../lib/core/event-bus.js', () => ({
  emit: vi.fn(),
}));

// ---------------------------------------------------------------------------
describe('CLASSIFICATION', () => {
  it('has all four values', () => {
    expect(CLASSIFICATION.PROVEN).toBe('proven');
    expect(CLASSIFICATION.STABLE).toBe('stable');
    expect(CLASSIFICATION.DECLINING).toBe('declining');
    expect(CLASSIFICATION.DEPRECATED).toBe('deprecated');
  });

  it('is frozen', () => {
    expect(Object.isFrozen(CLASSIFICATION)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('DEFAULT_THRESHOLDS', () => {
  it('has expected values', () => {
    expect(DEFAULT_THRESHOLDS.provenSuccessRate).toBe(0.9);
    expect(DEFAULT_THRESHOLDS.provenMinUsage).toBe(10);
    expect(DEFAULT_THRESHOLDS.deprecatedMinUsage).toBe(5);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(DEFAULT_THRESHOLDS)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('computeMetrics()', () => {
  it('returns zeros for empty records', () => {
    const m = computeMetrics([]);
    expect(m.successRate).toBe(0);
    expect(m.usageCount).toBe(0);
    expect(m.avgEditDistance).toBe(0);
    expect(m.trend).toBe(0);
  });

  it('returns zeros for null', () => {
    const m = computeMetrics(null);
    expect(m.usageCount).toBe(0);
  });

  it('computes success rate correctly', () => {
    const records = [
      { success: true, editDistance: 0 },
      { success: true, editDistance: 0 },
      { success: false, editDistance: 10 },
    ];
    const m = computeMetrics(records);
    expect(m.successRate).toBeCloseTo(0.667, 2);
    expect(m.usageCount).toBe(3);
  });

  it('computes average edit distance', () => {
    const records = [
      { success: true, editDistance: 10 },
      { success: true, editDistance: 20 },
    ];
    const m = computeMetrics(records);
    expect(m.avgEditDistance).toBe(15);
  });

  it('computes EWMA trend', () => {
    const allSuccess = Array.from({ length: 5 }, () => ({ success: true, editDistance: 0 }));
    const m = computeMetrics(allSuccess);
    expect(m.trend).toBeGreaterThan(0);
  });

  it('returns frozen object', () => {
    const m = computeMetrics([{ success: true, editDistance: 0 }]);
    expect(Object.isFrozen(m)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('findCommonEdits()', () => {
  it('returns empty for empty diffs', () => {
    expect(findCommonEdits([])).toEqual([]);
  });

  it('returns empty for null', () => {
    expect(findCommonEdits(null)).toEqual([]);
  });

  it('detects lines-added pattern', () => {
    const diffs = [
      { before: 'line1', after: 'line1\nline2' },
      { before: 'a', after: 'a\nb' },
    ];
    const edits = findCommonEdits(diffs);
    expect(edits[0].pattern).toBe('lines-added');
    expect(edits[0].frequency).toBe(2);
  });

  it('detects lines-removed pattern', () => {
    const diffs = [
      { before: 'line1\nline2', after: 'line1' },
      { before: 'a\nb', after: 'a' },
    ];
    const edits = findCommonEdits(diffs);
    expect(edits[0].pattern).toBe('lines-removed');
  });

  it('detects minor-text-change', () => {
    const diffs = [
      { before: 'hello world', after: 'hello earth' },
      { before: 'foo bar', after: 'foo baz' },
    ];
    const edits = findCommonEdits(diffs);
    expect(edits[0].pattern).toBe('minor-text-change');
  });

  it('skips identical pairs', () => {
    const diffs = [{ before: 'same', after: 'same' }];
    expect(findCommonEdits(diffs)).toEqual([]);
  });

  it('sorts by frequency descending', () => {
    const diffs = [
      { before: 'a', after: 'a\nb' },
      { before: 'c', after: 'c\nd' },
      { before: 'x', after: 'y' },
    ];
    const edits = findCommonEdits(diffs);
    expect(edits[0].frequency).toBeGreaterThanOrEqual(edits[edits.length - 1].frequency);
  });
});

// ---------------------------------------------------------------------------
describe('generateRefactorSuggestion()', () => {
  it('suggests rewrite for very low success', () => {
    const s = generateRefactorSuggestion('test-skill', { successRate: 0.2, avgEditDistance: 5, trend: 0 });
    expect(s).toContain('rewriting or removing');
  });

  it('suggests template review for high edit distance', () => {
    const s = generateRefactorSuggestion('test-skill', { successRate: 0.8, avgEditDistance: 60, trend: 0 });
    expect(s).toContain('Review output templates');
  });

  it('suggests investigation for declining trend', () => {
    const s = generateRefactorSuggestion('test-skill', { successRate: 0.8, avgEditDistance: 5, trend: -0.5 });
    expect(s).toContain('trending downward');
  });

  it('returns adequate for healthy skill', () => {
    const s = generateRefactorSuggestion('test-skill', { successRate: 0.9, avgEditDistance: 5, trend: 0.5 });
    expect(s).toContain('performing adequately');
  });
});

// ---------------------------------------------------------------------------
describe('createSkillEvolver', () => {
  let evolver;

  beforeEach(() => {
    vi.clearAllMocks();
    evolver = createSkillEvolver({ now: () => Date.now() });
  });

  // -------------------------------------------------------------------------
  describe('track()', () => {
    it('records an outcome', () => {
      evolver.track('test-skill', { invoked: true, success: true, userEdited: false, editDistance: 0 });
      const records = evolver.getRecords();
      expect(records.get('test-skill')).toHaveLength(1);
    });

    it('appends multiple outcomes', () => {
      evolver.track('s1', { invoked: true, success: true, userEdited: false, editDistance: 0 });
      evolver.track('s1', { invoked: true, success: false, userEdited: true, editDistance: 15 });
      expect(evolver.getRecords().get('s1')).toHaveLength(2);
    });

    it('throws on empty skill name', () => {
      expect(() => evolver.track('', {})).toThrow('non-empty string');
    });

    it('throws on null outcome', () => {
      expect(() => evolver.track('s1', null)).toThrow('Outcome must be an object');
    });

    it('freezes each record entry', () => {
      evolver.track('s1', { invoked: true, success: true, userEdited: false, editDistance: 0 });
      const entry = evolver.getRecords().get('s1')[0];
      expect(Object.isFrozen(entry)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  describe('evaluate()', () => {
    it('returns zeros for unknown skill', () => {
      const m = evolver.evaluate('unknown');
      expect(m.usageCount).toBe(0);
    });

    it('returns correct metrics after tracking', () => {
      evolver.track('s1', { invoked: true, success: true, userEdited: false, editDistance: 0 });
      evolver.track('s1', { invoked: true, success: true, userEdited: false, editDistance: 10 });
      evolver.track('s1', { invoked: true, success: false, userEdited: true, editDistance: 20 });

      const m = evolver.evaluate('s1');
      expect(m.usageCount).toBe(3);
      expect(m.successRate).toBeCloseTo(0.667, 2);
      expect(m.avgEditDistance).toBe(10);
    });
  });

  // -------------------------------------------------------------------------
  describe('classify()', () => {
    it('returns proven for high success + high usage', () => {
      const c = evolver.classify({ successRate: 0.95, usageCount: 15, trend: 0.5 });
      expect(c).toBe('proven');
    });

    it('returns stable for moderate success', () => {
      const c = evolver.classify({ successRate: 0.7, usageCount: 4, trend: 0.1 });
      expect(c).toBe('stable');
    });

    it('returns declining for negative trend', () => {
      const c = evolver.classify({ successRate: 0.6, usageCount: 10, trend: -0.3 });
      expect(c).toBe('declining');
    });

    it('returns declining for low success with enough usage', () => {
      const c = evolver.classify({ successRate: 0.4, usageCount: 5, trend: 0 });
      expect(c).toBe('declining');
    });

    it('returns deprecated for very low success + high usage', () => {
      const c = evolver.classify({ successRate: 0.2, usageCount: 8, trend: -0.5 });
      expect(c).toBe('deprecated');
    });

    it('deprecated takes priority over declining', () => {
      const c = evolver.classify({ successRate: 0.1, usageCount: 10, trend: -0.8 });
      expect(c).toBe('deprecated');
    });
  });

  // -------------------------------------------------------------------------
  // audit #7-1: factory must expose suggest() — evolution-loop calls it by name.
  describe('suggest()', () => {
    it('returns a non-empty string for a tracked skill', () => {
      evolver.track('s1', { invoked: true, success: true, userEdited: false, editDistance: 0 });
      const s = evolver.suggest('s1');
      expect(typeof s).toBe('string');
      expect(s).toContain('s1');
    });

    it('flags heavy editing when avg edit distance is high', () => {
      evolver.track('s1', { invoked: true, success: true, userEdited: true, editDistance: 80 });
      expect(evolver.suggest('s1')).toMatch(/heavy editing/i);
    });

    it('flags very low success for a consistently failing skill', () => {
      evolver.track('s1', { invoked: true, success: false, userEdited: false, editDistance: 0 });
      expect(evolver.suggest('s1')).toMatch(/low success/i);
    });

    it('handles an untracked skill without throwing (zero metrics)', () => {
      const s = evolver.suggest('never-seen');
      expect(typeof s).toBe('string');
      expect(s).toMatch(/low success/i); // successRate 0 <= 0.3
    });

    it('throws on empty skill name', () => {
      expect(() => evolver.suggest('')).toThrow('non-empty string');
    });

    it('matches the pure generateRefactorSuggestion() for the same metrics', () => {
      evolver.track('s1', { invoked: true, success: true, userEdited: true, editDistance: 60 });
      const metrics = evolver.evaluate('s1');
      expect(evolver.suggest('s1')).toBe(generateRefactorSuggestion('s1', metrics));
    });
  });

  // -------------------------------------------------------------------------
  describe('evolve()', () => {
    it('throws on empty skill name', () => {
      expect(() => evolver.evolve('', [])).toThrow('non-empty string');
    });

    it('throws on non-array diffs', () => {
      expect(() => evolver.evolve('s1', 'not-array')).toThrow('Diffs must be an array');
    });

    it('returns empty for no common patterns', () => {
      const rules = evolver.evolve('s1', [{ before: 'a', after: 'b' }]);
      expect(rules).toEqual([]);
    });

    it('returns rules for repeated edit patterns', () => {
      const diffs = [
        { before: 'line1', after: 'line1\nline2' },
        { before: 'a', after: 'a\nb' },
        { before: 'x', after: 'x\ny' },
      ];
      const rules = evolver.evolve('s1', diffs);
      expect(rules.length).toBeGreaterThan(0);
      expect(rules[0].skillName).toBe('s1');
      expect(rules[0].frequency).toBeGreaterThanOrEqual(2);
    });

    it('emits skill:evolved event', async () => {
      const { emit: mockEmit } = await import('../../lib/core/event-bus.js');
      const diffs = [
        { before: 'a', after: 'a\nb' },
        { before: 'c', after: 'c\nd' },
      ];
      evolver.evolve('s1', diffs);
      expect(mockEmit).toHaveBeenCalledWith('skill:evolved', expect.objectContaining({ skillName: 's1' }));
    });

    it('returns frozen rule objects', () => {
      const diffs = [
        { before: 'a', after: 'a\nb' },
        { before: 'c', after: 'c\nd' },
      ];
      const rules = evolver.evolve('s1', diffs);
      if (rules.length > 0) {
        expect(Object.isFrozen(rules[0])).toBe(true);
      }
    });
  });

  // -------------------------------------------------------------------------
  describe('getReport()', () => {
    it('returns empty report with no data', () => {
      const report = evolver.getReport();
      expect(report.totalSkills).toBe(0);
      expect(report.proven).toEqual([]);
      expect(report.stable).toEqual([]);
      expect(report.declining).toEqual([]);
      expect(report.deprecated).toEqual([]);
    });

    it('categorizes skills correctly', () => {
      // Proven: 10+ uses, 90%+ success
      for (let i = 0; i < 12; i++) {
        evolver.track('good-skill', { invoked: true, success: true, userEdited: false, editDistance: 0 });
      }
      // Deprecated: 5+ uses, <=30% success
      for (let i = 0; i < 7; i++) {
        evolver.track('bad-skill', { invoked: true, success: false, userEdited: true, editDistance: 50 });
      }

      const report = evolver.getReport();
      expect(report.totalSkills).toBe(2);
      expect(report.proven).toContain('good-skill');
      expect(report.deprecated).toContain('bad-skill');
    });

    it('includes topByUsage sorted', () => {
      for (let i = 0; i < 5; i++) {
        evolver.track('heavy', { invoked: true, success: true, userEdited: false, editDistance: 0 });
      }
      evolver.track('light', { invoked: true, success: true, userEdited: false, editDistance: 0 });

      const report = evolver.getReport();
      expect(report.topByUsage[0].name).toBe('heavy');
      expect(report.topByUsage[0].count).toBe(5);
    });

    it('returns frozen report', () => {
      expect(Object.isFrozen(evolver.getReport())).toBe(true);
    });

    it('includes generatedAt timestamp', () => {
      const report = evolver.getReport();
      expect(report.generatedAt).toBeDefined();
      expect(typeof report.generatedAt).toBe('string');
    });
  });

  // -------------------------------------------------------------------------
  describe('runBatch()', () => {
    it('throws on non-array input', () => {
      expect(() => evolver.runBatch('not-array')).toThrow('must be an array');
    });

    it('evaluates all provided skills', () => {
      evolver.track('s1', { invoked: true, success: true, userEdited: false, editDistance: 0 });
      evolver.track('s2', { invoked: true, success: false, userEdited: true, editDistance: 30 });

      const results = evolver.runBatch(['s1', 's2', 's3']);
      expect(results.size).toBe(3);
      expect(results.get('s1').classification).toBe('stable');
      expect(results.get('s3').metrics.usageCount).toBe(0);
    });

    it('returns frozen entries', () => {
      evolver.track('s1', { invoked: true, success: true, userEdited: false, editDistance: 0 });
      const results = evolver.runBatch(['s1']);
      expect(Object.isFrozen(results.get('s1'))).toBe(true);
    });

    it('emits skill:deprecated for deprecated skills', async () => {
      const { emit: mockEmit } = await import('../../lib/core/event-bus.js');
      for (let i = 0; i < 6; i++) {
        evolver.track('dead-skill', { invoked: true, success: false, userEdited: true, editDistance: 100 });
      }
      evolver.runBatch(['dead-skill']);
      expect(mockEmit).toHaveBeenCalledWith('skill:deprecated', expect.objectContaining({ skillName: 'dead-skill' }));
    });
  });

  // -------------------------------------------------------------------------
  describe('getRecords()', () => {
    it('returns a copy (not the internal map)', () => {
      evolver.track('s1', { invoked: true, success: true, userEdited: false, editDistance: 0 });
      const r1 = evolver.getRecords();
      const r2 = evolver.getRecords();
      expect(r1).not.toBe(r2);
      expect(r1).toEqual(r2);
    });
  });

  // -------------------------------------------------------------------------
  describe('custom thresholds', () => {
    it('respects custom proven threshold', () => {
      const custom = createSkillEvolver({
        thresholds: { provenSuccessRate: 0.5, provenMinUsage: 2 },
        now: () => Date.now(),
      });
      custom.track('s1', { invoked: true, success: true, userEdited: false, editDistance: 0 });
      custom.track('s1', { invoked: true, success: true, userEdited: false, editDistance: 0 });
      const m = custom.evaluate('s1');
      expect(custom.classify(m)).toBe('proven');
    });
  });
});
