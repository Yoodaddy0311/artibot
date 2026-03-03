/**
 * Tests for pattern-analyzer.js — GRPO scoring and pattern extraction.
 *
 * @module tests/learning/pattern-analyzer
 */

import { describe, expect, it } from 'vitest';
import {
  clamp01,
  extractPattern,
  generateConsensusInsight,
  generateInsight,
  groupExperiences,
  grpoRankGroup,
  scoreExperience,
} from '../../lib/learning/pattern-analyzer.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeExp(type, category, data = {}) {
  return { type, category, data, timestamp: Date.now() };
}

// ---------------------------------------------------------------------------
// clamp01()
// ---------------------------------------------------------------------------
describe('clamp01()', () => {
  it('clamps values above 1 to 1', () => {
    expect(clamp01(1.5)).toBe(1);
    expect(clamp01(100)).toBe(1);
  });

  it('clamps values below 0 to 0', () => {
    expect(clamp01(-0.5)).toBe(0);
    expect(clamp01(-100)).toBe(0);
  });

  it('returns values within range unchanged', () => {
    expect(clamp01(0)).toBe(0);
    expect(clamp01(0.5)).toBe(0.5);
    expect(clamp01(1)).toBe(1);
  });

  it('returns 0 for NaN', () => {
    expect(clamp01(NaN)).toBe(0);
  });

  it('returns 0 for non-number types', () => {
    expect(clamp01('hello')).toBe(0);
    expect(clamp01(undefined)).toBe(0);
    expect(clamp01(null)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// groupExperiences()
// ---------------------------------------------------------------------------
describe('groupExperiences()', () => {
  it('groups experiences by type::category key', () => {
    const exps = [
      makeExp('tool', 'Read'),
      makeExp('tool', 'Read'),
      makeExp('tool', 'Write'),
      makeExp('error', 'timeout'),
    ];
    const groups = groupExperiences(exps);
    expect(Object.keys(groups)).toHaveLength(3);
    expect(groups['tool::Read']).toHaveLength(2);
    expect(groups['tool::Write']).toHaveLength(1);
    expect(groups['error::timeout']).toHaveLength(1);
  });

  it('returns empty object for empty input', () => {
    expect(groupExperiences([])).toEqual({});
  });

  it('handles single experience', () => {
    const groups = groupExperiences([makeExp('tool', 'Grep')]);
    expect(groups['tool::Grep']).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// scoreExperience()
// ---------------------------------------------------------------------------
describe('scoreExperience()', () => {
  it('scores tool type with successRate and calls', () => {
    const exp = makeExp('tool', 'Read', { successRate: 0.9, calls: 10, successes: 9 });
    const scores = scoreExperience(exp);
    expect(scores.success).toBeCloseTo(0.9, 1);
    expect(scores.speed).toBeDefined();
    expect(scores.errorRate).toBeDefined();
    expect(scores.resourceEfficiency).toBeDefined();
  });

  it('scores tool type with direct score from tool-tracker', () => {
    const exp = makeExp('tool', 'Read', { score: 0.8 });
    const scores = scoreExperience(exp);
    expect(scores.success).toBeCloseTo(0.8, 1);
  });

  it('scores tool type with avgMs for speed', () => {
    const exp = makeExp('tool', 'Read', { avgMs: 100, successRate: 0.9, calls: 5, successes: 4 });
    const scores = scoreExperience(exp);
    expect(scores.speed).toBeGreaterThan(0.5);
  });

  it('scores error type with zero success', () => {
    const exp = makeExp('error', 'timeout', { recoverable: true });
    const scores = scoreExperience(exp);
    expect(scores.success).toBe(0);
    expect(scores.resourceEfficiency).toBe(0.3);
  });

  it('scores error type non-recoverable with 0 efficiency', () => {
    const exp = makeExp('error', 'crash', { recoverable: false });
    const scores = scoreExperience(exp);
    expect(scores.resourceEfficiency).toBe(0);
  });

  it('scores success type with duration', () => {
    const exp = makeExp('success', 'build', { duration: 5000, testsPass: true, filesModified: 3 });
    const scores = scoreExperience(exp);
    expect(scores.success).toBe(1.0);
    expect(scores.speed).toBeGreaterThan(0);
    expect(scores.errorRate).toBe(1.0);
  });

  it('scores success type with testsPass=false', () => {
    const exp = makeExp('success', 'build', { testsPass: false });
    const scores = scoreExperience(exp);
    expect(scores.errorRate).toBe(0.3);
  });

  it('scores success type with testsPass undefined', () => {
    const exp = makeExp('success', 'build', {});
    const scores = scoreExperience(exp);
    expect(scores.errorRate).toBe(0.5);
  });

  it('scores team type with successRate and duration', () => {
    const exp = makeExp('team', 'deploy', { successRate: 0.8, duration: 30000, size: 3 });
    const scores = scoreExperience(exp);
    expect(scores.success).toBeCloseTo(0.8, 1);
    expect(scores.speed).toBeGreaterThan(0);
  });

  it('scores team type without duration', () => {
    const exp = makeExp('team', 'deploy', { successRate: 0.7, size: 2 });
    const scores = scoreExperience(exp);
    expect(scores.speed).toBe(0.5);
  });

  it('scores unknown type with default values', () => {
    const exp = makeExp('custom', 'unknown', {});
    const scores = scoreExperience(exp);
    expect(scores.success).toBe(0.5);
    expect(scores.speed).toBe(0.5);
    expect(scores.errorRate).toBe(0.5);
    expect(scores.resourceEfficiency).toBe(0.5);
  });

  it('scores unknown type with direct score', () => {
    const exp = makeExp('agent', 'review', { score: 0.9 });
    const scores = scoreExperience(exp);
    expect(scores.success).toBeCloseTo(0.9, 1);
  });

  it('handles empty data gracefully', () => {
    const exp = { type: 'tool', category: 'Read' };
    const scores = scoreExperience(exp);
    expect(scores).toBeDefined();
    expect(scores.success).toBeDefined();
  });

  it('handles tool type with direct score and avgMs', () => {
    const exp = makeExp('tool', 'Read', { score: 0.7, avgMs: 200 });
    const scores = scoreExperience(exp);
    expect(scores.success).toBeCloseTo(0.7, 1);
    expect(scores.speed).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// grpoRankGroup()
// ---------------------------------------------------------------------------
describe('grpoRankGroup()', () => {
  it('ranks experiences by composite score descending', () => {
    const group = [
      makeExp('tool', 'Read', { successRate: 0.5, calls: 10, successes: 5 }),
      makeExp('tool', 'Read', { successRate: 0.9, calls: 10, successes: 9 }),
      makeExp('tool', 'Read', { successRate: 0.3, calls: 10, successes: 3 }),
    ];
    const result = grpoRankGroup(group);
    expect(result.entries).toHaveLength(3);
    expect(result.entries[0].composite).toBeGreaterThanOrEqual(result.entries[1].composite);
    expect(result.entries[1].composite).toBeGreaterThanOrEqual(result.entries[2].composite);
  });

  it('computes group mean correctly', () => {
    const group = [
      makeExp('tool', 'Read', { score: 0.8 }),
      makeExp('tool', 'Read', { score: 0.4 }),
    ];
    const result = grpoRankGroup(group);
    expect(result.groupMean).toBeGreaterThan(0);
    expect(result.groupMean).toBeLessThanOrEqual(1);
  });

  it('sets bestEntry to highest composite', () => {
    const group = [
      makeExp('tool', 'Read', { score: 0.3 }),
      makeExp('tool', 'Read', { score: 0.9 }),
    ];
    const result = grpoRankGroup(group);
    expect(result.bestEntry).toBeDefined();
    expect(result.bestEntry.composite).toBeGreaterThanOrEqual(result.groupMean);
  });

  it('computes relative advantage for each entry', () => {
    const group = [
      makeExp('tool', 'Read', { score: 0.9 }),
      makeExp('tool', 'Read', { score: 0.1 }),
    ];
    const result = grpoRankGroup(group);
    const best = result.entries[0];
    const worst = result.entries[1];
    expect(best.relativeAdvantage).toBeGreaterThan(0);
    expect(worst.relativeAdvantage).toBeLessThan(0);
  });

  it('handles empty group', () => {
    const result = grpoRankGroup([]);
    expect(result.entries).toHaveLength(0);
    expect(result.groupMean).toBe(0);
    expect(result.bestEntry).toBeNull();
  });

  it('handles single entry group', () => {
    const group = [makeExp('tool', 'Read', { score: 0.7 })];
    const result = grpoRankGroup(group);
    expect(result.entries).toHaveLength(1);
    expect(result.bestEntry).toBeDefined();
    expect(result.entries[0].relativeAdvantage).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// extractPattern()
// ---------------------------------------------------------------------------
describe('extractPattern()', () => {
  function makeRanked(entries, groupMean) {
    const sorted = [...entries].sort((a, b) => b.composite - a.composite);
    return {
      entries: sorted,
      groupMean,
      bestEntry: sorted[0] || null,
    };
  }

  it('returns null when bestEntry is null', () => {
    const ranked = { entries: [], groupMean: 0, bestEntry: null };
    expect(extractPattern('tool::Read', ranked)).toBeNull();
  });

  it('returns null when group size < 2', () => {
    const entry = {
      experience: makeExp('tool', 'Read', {}),
      scores: { success: 0.9, speed: 0.8, errorRate: 0.9, resourceEfficiency: 0.7 },
      composite: 0.85,
    };
    const ranked = { entries: [entry], groupMean: 0.85, bestEntry: entry };
    expect(extractPattern('tool::Read', ranked)).toBeNull();
  });

  it('extracts variance pattern when best > mean + 0.02', () => {
    const best = {
      experience: makeExp('tool', 'Read', { strategy: 'fast' }),
      scores: { success: 0.95 },
      composite: 0.9,
      relativeAdvantage: 0.2,
    };
    const worse = {
      experience: makeExp('tool', 'Read', {}),
      scores: { success: 0.5 },
      composite: 0.5,
      relativeAdvantage: -0.2,
    };
    const ranked = makeRanked([best, worse], 0.7);
    const pattern = extractPattern('tool::Read', ranked);
    expect(pattern).not.toBeNull();
    expect(pattern.key).toBe('tool::Read');
    expect(pattern.type).toBe('tool');
    expect(pattern.category).toBe('Read');
    expect(pattern.confidence).toBeGreaterThan(0);
    expect(pattern.confidence).toBeLessThanOrEqual(1);
    expect(pattern.insight).toContain('Read');
    expect(pattern.extractedAt).toBeDefined();
  });

  it('extracts consensus pattern with 3+ entries and low variance', () => {
    const mkEntry = (composite) => ({
      experience: makeExp('tool', 'Grep', {}),
      scores: { success: composite },
      composite,
      relativeAdvantage: 0,
    });
    const entries = [mkEntry(0.71), mkEntry(0.70), mkEntry(0.69)];
    const ranked = makeRanked(entries, 0.70);
    const pattern = extractPattern('tool::Grep', ranked);
    expect(pattern).not.toBeNull();
    expect(pattern.sampleSize).toBe(3);
    expect(pattern.insight).toContain('consistent');
  });

  it('returns null when insufficient signal (2 entries, low variance)', () => {
    const mkEntry = (composite) => ({
      experience: makeExp('tool', 'X', {}),
      scores: { success: composite },
      composite,
      relativeAdvantage: 0,
    });
    const entries = [mkEntry(0.50), mkEntry(0.50)];
    const ranked = makeRanked(entries, 0.50);
    const pattern = extractPattern('tool::X', ranked);
    expect(pattern).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// generateInsight()
// ---------------------------------------------------------------------------
describe('generateInsight()', () => {
  const bestEntry = {
    composite: 0.9,
    scores: { success: 0.95 },
    experience: { data: { recoverable: true, strategy: 'quick', size: 3 } },
  };

  it('generates tool insight with advantage percentage', () => {
    const insight = generateInsight('tool', 'Read', bestEntry, 0.7);
    expect(insight).toContain('Read');
    expect(insight).toContain('above average');
  });

  it('generates error insight with recoverable info', () => {
    const insight = generateInsight('error', 'timeout', bestEntry, 0.5);
    expect(insight).toContain('timeout');
    expect(insight).toContain('Recoverable');
  });

  it('generates success insight with strategy', () => {
    const insight = generateInsight('success', 'build', bestEntry, 0.6);
    expect(insight).toContain('build');
    expect(insight).toContain('Strategy');
  });

  it('generates team insight with optimal size', () => {
    const insight = generateInsight('team', 'deploy', bestEntry, 0.5);
    expect(insight).toContain('deploy');
    expect(insight).toContain('size');
  });

  it('generates default insight for unknown types', () => {
    const insight = generateInsight('custom', 'misc', bestEntry, 0.5);
    expect(insight).toContain('misc');
    expect(insight).toContain('advantage');
  });
});

// ---------------------------------------------------------------------------
// generateConsensusInsight()
// ---------------------------------------------------------------------------
describe('generateConsensusInsight()', () => {
  it('generates tool consensus insight', () => {
    const insight = generateConsensusInsight('tool', 'Read', 5, 0.8);
    expect(insight).toContain('Read');
    expect(insight).toContain('consistent');
    expect(insight).toContain('5');
  });

  it('generates error consensus insight', () => {
    const insight = generateConsensusInsight('error', 'timeout', 3, 0.4);
    expect(insight).toContain('timeout');
    expect(insight).toContain('automated');
  });

  it('generates success consensus insight', () => {
    const insight = generateConsensusInsight('success', 'test', 4, 0.75);
    expect(insight).toContain('test');
    expect(insight).toContain('consistently');
  });

  it('generates team consensus insight', () => {
    const insight = generateConsensusInsight('team', 'review', 6, 0.9);
    expect(insight).toContain('review');
    expect(insight).toContain('consistently');
  });

  it('generates default consensus insight for unknown types', () => {
    const insight = generateConsensusInsight('custom', 'misc', 3, 0.6);
    expect(insight).toContain('misc');
    expect(insight).toContain('stable');
  });
});
