import { describe, expect, it } from 'vitest';
import {
  buildRuntimeEvalComparison,
  formatRuntimeEvalComparisonMarkdown,
} from '../../lib/runtime/evaluator.js';

describe('runtime evaluator reporting', () => {
  it('builds comparison deltas from previous and current reports', () => {
    const previous = {
      generatedAt: '2026-03-16T00:00:00.000Z',
      total: 4,
      passed: 3,
      failed: 1,
      averageScore: 0.75,
      results: [
        { id: 'simple-system1', name: 'Simple', score: 1, passed: true },
        { id: 'complex-system2', name: 'Complex', score: 0.5, passed: false },
      ],
    };
    const current = {
      generatedAt: '2026-03-17T00:00:00.000Z',
      total: 5,
      passed: 5,
      failed: 0,
      averageScore: 1,
      results: [
        { id: 'simple-system1', name: 'Simple', score: 1, passed: true },
        { id: 'complex-system2', name: 'Complex', score: 1, passed: true },
        { id: 'command-skill-handoff', name: 'Command/skill', score: 1, passed: true },
      ],
    };

    const comparison = buildRuntimeEvalComparison(previous, current);
    expect(comparison.delta.averageScore).toBe(0.25);
    expect(comparison.delta.passed).toBe(2);
    expect(comparison.delta.failed).toBe(-1);
    expect(comparison.scenarios).toHaveLength(3);
    expect(comparison.scenarios[1].deltaScore).toBe(0.5);
    expect(comparison.scenarios[2].previousScore).toBeNull();
  });

  it('formats a readable markdown summary', () => {
    const comparison = {
      generatedAt: '2026-03-17T00:00:00.000Z',
      current: { averageScore: 1, passed: 5, failed: 0 },
      previous: { averageScore: 0.75, passed: 3, failed: 1 },
      delta: { averageScore: 0.25, passed: 2, failed: -1 },
      scenarios: [
        {
          id: 'simple-system1',
          currentScore: 1,
          previousScore: 1,
          deltaScore: 0,
          currentPassed: true,
        },
      ],
    };

    const markdown = formatRuntimeEvalComparisonMarkdown(comparison);
    expect(markdown).toContain('# Runtime Eval Comparison');
    expect(markdown).toContain('## 요약');
    expect(markdown).toContain('| 평균 점수 | 0.75 | 1 | 0.25 |');
    expect(markdown).toContain('| simple-system1 | 1 | 1 | 0 | PASS |');
  });
});
