/**
 * Tests for lib/autopilot/smart-skip.js (v4.10.0 Track G).
 * Covers each complexity level + boundary cases and the recommendation map.
 */

import { describe, expect, it } from 'vitest';
import {
  classifyTaskComplexity,
  COMPLEXITY_LEVELS,
  recommendSkippablePhases,
  SKIPPABLE_PHASES,
} from '../../lib/autopilot/smart-skip.js';

describe('classifyTaskComplexity — empty / invalid', () => {
  it('treats null / non-string as trivial with reason', () => {
    expect(classifyTaskComplexity(null).level).toBe('trivial');
    expect(classifyTaskComplexity(123).level).toBe('trivial');
    expect(classifyTaskComplexity('').level).toBe('trivial');
    expect(classifyTaskComplexity('   ').factors).toContain('empty-goal');
  });
});

describe('classifyTaskComplexity — trivial bucket', () => {
  it('classifies a one-word fix as trivial', () => {
    const r = classifyTaskComplexity('typo');
    expect(r.level).toBe('trivial');
    expect(r.score).toBeLessThan(15);
  });

  it('subtracts trivial keyword to overcome length push', () => {
    const r = classifyTaskComplexity('rename variable foo to bar in one place');
    expect(r.level).toBe('trivial');
  });
});

describe('classifyTaskComplexity — simple bucket', () => {
  it('classifies a single-file tweak without keyword as simple', () => {
    const r = classifyTaskComplexity('Tweak server.js to log on startup');
    expect(r.level).toBe('simple');
  });

  it('classifies a 2-file change without strong keyword as simple', () => {
    const r = classifyTaskComplexity('Wire foo.js into bar.js to share the cache');
    expect(r.level).toBe('simple');
  });
});

describe('classifyTaskComplexity — medium bucket', () => {
  it('classifies feature keyword + one file as medium', () => {
    const r = classifyTaskComplexity('Implement new endpoint in routes.js for user lookup');
    expect(r.level).toBe('medium');
    expect(r.factors.some((f) => f.startsWith('medium-kw'))).toBe(true);
  });

  it('classifies multi-clause medium task', () => {
    const r = classifyTaskComplexity(
      'Add a feature flag and update middleware to gate the new pipeline behind it',
    );
    expect(['medium', 'complex']).toContain(r.level);
  });
});

describe('classifyTaskComplexity — complex bucket', () => {
  it('classifies refactor keyword as complex when length is non-trivial', () => {
    const r = classifyTaskComplexity(
      'Refactor the cognitive router to extract policy evaluation into its own module and migrate callers',
    );
    expect(r.level).toBe('complex');
    expect(r.factors.some((f) => f.startsWith('complex-kw'))).toBe(true);
  });

  it('classifies migration with many files as complex', () => {
    const r = classifyTaskComplexity(
      'Migration: rewrite lib/foo.js, lib/bar.js, lib/baz.js, tests/foo.test.js, and tests/bar.test.js for new API',
    );
    expect(r.level).toBe('complex');
    expect(r.score).toBeGreaterThanOrEqual(65);
  });
});

describe('classifyTaskComplexity — score bounds', () => {
  it('clamps score to [0, 100]', () => {
    const huge = 'refactor migration rewrite '.repeat(100) + 'a.js b.js c.js d.js e.js';
    const r = classifyTaskComplexity(huge);
    expect(r.score).toBeLessThanOrEqual(100);
    expect(r.score).toBeGreaterThanOrEqual(0);
  });

  it('emits structured factors array', () => {
    const r = classifyTaskComplexity('Implement feature in foo.js');
    expect(Array.isArray(r.factors)).toBe(true);
    expect(r.factors.length).toBeGreaterThan(0);
  });
});

describe('recommendSkippablePhases', () => {
  it('skips CROSS_CHECK + IMPROVE for trivial', () => {
    const r = recommendSkippablePhases({ level: 'trivial' });
    expect(r.skip).toEqual(['CROSS_CHECK', 'IMPROVE']);
    expect(r.keep).toEqual([]);
    expect(r.rationale).toMatch(/trivial/);
  });

  it('skips only IMPROVE for simple', () => {
    const r = recommendSkippablePhases({ level: 'simple' });
    expect(r.skip).toEqual(['IMPROVE']);
    expect(r.keep).toEqual(['CROSS_CHECK']);
  });

  it('skips nothing for medium', () => {
    const r = recommendSkippablePhases({ level: 'medium' });
    expect(r.skip).toEqual([]);
    expect(r.keep).toEqual([...SKIPPABLE_PHASES]);
  });

  it('skips nothing for complex', () => {
    const r = recommendSkippablePhases({ level: 'complex' });
    expect(r.skip).toEqual([]);
    expect(r.rationale).toMatch(/complex/);
  });

  it('returns safe default for unknown level', () => {
    const r = recommendSkippablePhases({ level: 'wat' });
    expect(r.skip).toEqual([]);
    expect(r.keep).toEqual([...SKIPPABLE_PHASES]);
  });

  it('returns safe default for missing complexity arg', () => {
    expect(recommendSkippablePhases(null).skip).toEqual([]);
    expect(recommendSkippablePhases(undefined).skip).toEqual([]);
    expect(recommendSkippablePhases({}).skip).toEqual([]);
  });
});

describe('exports', () => {
  it('exposes ordered complexity levels', () => {
    expect(COMPLEXITY_LEVELS).toEqual(['trivial', 'simple', 'medium', 'complex']);
  });

  it('exposes the skippable-phase whitelist', () => {
    expect(SKIPPABLE_PHASES).toEqual(['CROSS_CHECK', 'IMPROVE']);
  });
});
