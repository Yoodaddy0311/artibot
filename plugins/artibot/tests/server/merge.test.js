/**
 * Tests for merge.js — Federated Averaging algorithm.
 *
 * @module tests/server/merge
 */

import { describe, expect, it } from 'vitest';
import { federatedAverage } from '../../server/merge.js';

describe('federatedAverage', () => {
  it('should return empty object for empty input', () => {
    expect(federatedAverage([])).toEqual({});
    expect(federatedAverage(null)).toEqual({});
  });

  it('should return single snapshot weights unchanged', () => {
    const weights = {
      tools: { tool1: { score: 0.8, sampleSize: 10 } },
      errors: {},
      commands: {},
      teams: {},
    };
    const result = federatedAverage([{ weights }]);
    expect(result).toEqual(weights);
  });

  it('should compute weighted average for numeric fields', () => {
    const snap1 = {
      weights: {
        tools: { tool1: { score: 0.8, sampleSize: 10 } },
        errors: {},
        commands: {},
        teams: {},
      },
    };
    const snap2 = {
      weights: {
        tools: { tool1: { score: 0.4, sampleSize: 10 } },
        errors: {},
        commands: {},
        teams: {},
      },
    };

    const result = federatedAverage([snap1, snap2]);
    // Equal sample sizes → simple average: (0.8 + 0.4) / 2 = 0.6
    expect(result.tools.tool1.score).toBeCloseTo(0.6, 3);
    // Sample size should be summed
    expect(result.tools.tool1.sampleSize).toBe(20);
  });

  it('should weight by sample size', () => {
    const snap1 = {
      weights: {
        tools: { tool1: { score: 1.0, sampleSize: 30 } },
        errors: {},
        commands: {},
        teams: {},
      },
    };
    const snap2 = {
      weights: {
        tools: { tool1: { score: 0.0, sampleSize: 10 } },
        errors: {},
        commands: {},
        teams: {},
      },
    };

    const result = federatedAverage([snap1, snap2]);
    // 30/(30+10) * 1.0 + 10/(30+10) * 0.0 = 0.75
    expect(result.tools.tool1.score).toBeCloseTo(0.75, 3);
  });

  it('should handle missing categories gracefully', () => {
    const snap1 = { weights: { tools: { t1: { score: 0.5, sampleSize: 5 } } } };
    const snap2 = { weights: { tools: {} } };

    const result = federatedAverage([snap1, snap2]);
    expect(result.tools.t1.score).toBeCloseTo(0.5, 3);
  });

  it('should take non-numeric values from highest sample entry', () => {
    const snap1 = {
      weights: {
        tools: { t1: { name: 'alpha', sampleSize: 5 } },
        errors: {},
        commands: {},
        teams: {},
      },
    };
    const snap2 = {
      weights: {
        tools: { t1: { name: 'beta', sampleSize: 15 } },
        errors: {},
        commands: {},
        teams: {},
      },
    };

    const result = federatedAverage([snap1, snap2]);
    expect(result.tools.t1.name).toBe('beta');
  });

  it('should merge keys from all snapshots', () => {
    const snap1 = {
      weights: {
        tools: { tool_a: { score: 0.9, sampleSize: 5 } },
        errors: {},
        commands: {},
        teams: {},
      },
    };
    const snap2 = {
      weights: {
        tools: { tool_b: { score: 0.7, sampleSize: 3 } },
        errors: {},
        commands: {},
        teams: {},
      },
    };

    const result = federatedAverage([snap1, snap2]);
    expect(result.tools).toHaveProperty('tool_a');
    expect(result.tools).toHaveProperty('tool_b');
  });

  it('should handle default sampleSize of 1', () => {
    const snap1 = {
      weights: {
        tools: { t: { score: 0.6 } }, // no sampleSize
        errors: {},
        commands: {},
        teams: {},
      },
    };
    const snap2 = {
      weights: {
        tools: { t: { score: 0.4 } },
        errors: {},
        commands: {},
        teams: {},
      },
    };

    const result = federatedAverage([snap1, snap2]);
    expect(result.tools.t.score).toBeCloseTo(0.5, 3);
  });

  it('should round numeric values to 4 decimal places', () => {
    const snap1 = {
      weights: {
        tools: { t: { score: 0.33333, sampleSize: 1 } },
        errors: {},
        commands: {},
        teams: {},
      },
    };
    const snap2 = {
      weights: {
        tools: { t: { score: 0.66667, sampleSize: 1 } },
        errors: {},
        commands: {},
        teams: {},
      },
    };

    const result = federatedAverage([snap1, snap2]);
    const scoreStr = result.tools.t.score.toString();
    const decimals = scoreStr.split('.')[1] || '';
    expect(decimals.length).toBeLessThanOrEqual(4);
  });

  it('should process all four categories', () => {
    const snap = {
      weights: {
        tools: { a: { s: 1, sampleSize: 1 } },
        errors: { b: { s: 1, sampleSize: 1 } },
        commands: { c: { s: 1, sampleSize: 1 } },
        teams: { d: { s: 1, sampleSize: 1 } },
      },
    };

    const result = federatedAverage([snap, snap]);
    expect(result.tools).toHaveProperty('a');
    expect(result.errors).toHaveProperty('b');
    expect(result.commands).toHaveProperty('c');
    expect(result.teams).toHaveProperty('d');
  });
});
