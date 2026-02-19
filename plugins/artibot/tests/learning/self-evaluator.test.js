import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  evaluateResult,
  getImprovementSuggestions,
  getTeamPerformance,
  getLearningTrends,
} from '../../lib/learning/self-evaluator.js';

// Mock file module
vi.mock('../../lib/core/file.js', () => ({
  readJsonFile: vi.fn(() => Promise.resolve(null)),
  writeJsonFile: vi.fn(() => Promise.resolve()),
}));

const { readJsonFile, writeJsonFile } = await import('../../lib/core/file.js');

describe('self-evaluator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readJsonFile.mockResolvedValue(null);
  });

  describe('evaluateResult()', () => {
    const baseTask = { id: 'task-1', type: 'build', description: 'Build feature' };

    it('evaluates a successful result with high scores', async () => {
      const result = { success: true, testsPass: true, duration: 25000, filesModified: ['a.js'] };
      const ev = await evaluateResult(baseTask, result);

      expect(ev.id).toMatch(/^eval-/);
      expect(ev.taskId).toBe('task-1');
      expect(ev.taskType).toBe('build');
      expect(ev.timestamp).toBeTruthy();
      expect(ev.overall).toBeGreaterThanOrEqual(4);
      expect(ev.grade).toMatch(/^[AB]$/);
      expect(ev.dimensions.accuracy.score).toBe(5);
      expect(ev.dimensions.efficiency.score).toBe(5);
    });

    it('evaluates a failed result with low scores', async () => {
      const result = { success: false, testsPass: false, duration: 600000 };
      const ev = await evaluateResult(baseTask, result);

      expect(ev.overall).toBeLessThan(2);
      expect(ev.grade).toMatch(/^[DF]$/);
      expect(ev.dimensions.accuracy.score).toBeLessThanOrEqual(1);
    });

    it('persists evaluation to disk by default', async () => {
      const result = { success: true };
      await evaluateResult(baseTask, result);

      expect(writeJsonFile).toHaveBeenCalledTimes(1);
      const written = writeJsonFile.mock.calls[0][1];
      expect(Array.isArray(written)).toBe(true);
      expect(written).toHaveLength(1);
      expect(written[0].taskId).toBe('task-1');
    });

    it('skips persistence when persist=false', async () => {
      const result = { success: true };
      await evaluateResult(baseTask, result, { persist: false });
      expect(writeJsonFile).not.toHaveBeenCalled();
    });

    it('appends to existing evaluations', async () => {
      readJsonFile.mockResolvedValue([{ id: 'old', taskId: 'x', overall: 3 }]);
      const result = { success: true };
      await evaluateResult(baseTask, result);

      const written = writeJsonFile.mock.calls[0][1];
      expect(written).toHaveLength(2);
    });

    it('scores efficiency based on duration', async () => {
      const fast = await evaluateResult(baseTask, { success: true, duration: 5000 }, { persist: false });
      const slow = await evaluateResult(baseTask, { success: true, duration: 400000 }, { persist: false });
      expect(fast.dimensions.efficiency.score).toBe(5);
      expect(slow.dimensions.efficiency.score).toBeLessThanOrEqual(2);
    });

    it('defaults efficiency to 3 when no duration', async () => {
      const ev = await evaluateResult(baseTask, { success: true }, { persist: false });
      expect(ev.dimensions.efficiency.score).toBe(3);
    });

    it('handles positive user feedback', async () => {
      const ev = await evaluateResult(baseTask, {
        success: true,
        metrics: { userFeedback: 'positive' },
      }, { persist: false });
      expect(ev.dimensions.satisfaction.score).toBe(5);
    });

    it('handles negative user feedback', async () => {
      const ev = await evaluateResult(baseTask, {
        success: true,
        metrics: { userFeedback: 'negative' },
      }, { persist: false });
      expect(ev.dimensions.satisfaction.score).toBe(1);
    });

    it('handles revision requested signal', async () => {
      const ev = await evaluateResult(baseTask, {
        success: true,
        metrics: { revisionRequested: true },
      }, { persist: false });
      expect(ev.dimensions.satisfaction.score).toBe(3);
    });

    it('handles requirementsCovered metric', async () => {
      const ev = await evaluateResult(baseTask, {
        success: true,
        metrics: { requirementsCovered: 0.9 },
      }, { persist: false });
      expect(ev.dimensions.completeness.score).toBeGreaterThanOrEqual(4);
    });

    it('generates feedback for good results', async () => {
      const ev = await evaluateResult(baseTask, {
        success: true, testsPass: true, duration: 10000,
      }, { persist: false });
      expect(ev.feedback).toContain('Strong performance');
    });

    it('generates feedback for poor results', async () => {
      const ev = await evaluateResult(baseTask, {
        success: false, testsPass: false, duration: 600000,
      }, { persist: false });
      expect(ev.feedback).toContain('Below expectations');
    });

    it('generates feedback noting weakest area', async () => {
      const ev = await evaluateResult(baseTask, {
        success: false, testsPass: false,
      }, { persist: false });
      expect(ev.feedback).toContain('Weakest area');
    });

    it('all dimensions have weight property', async () => {
      const ev = await evaluateResult(baseTask, { success: true }, { persist: false });
      for (const dim of Object.values(ev.dimensions)) {
        expect(dim).toHaveProperty('score');
        expect(dim).toHaveProperty('weight');
        expect(dim.weight).toBeGreaterThan(0);
      }
    });

    it('dimension weights sum to 1.0', async () => {
      const ev = await evaluateResult(baseTask, { success: true }, { persist: false });
      const totalWeight = Object.values(ev.dimensions).reduce((s, d) => s + d.weight, 0);
      expect(totalWeight).toBeCloseTo(1.0, 5);
    });

    it('overall score is between 1 and 5', async () => {
      const good = await evaluateResult(baseTask, { success: true, testsPass: true, duration: 5000 }, { persist: false });
      const bad = await evaluateResult(baseTask, { success: false, testsPass: false, duration: 600000 }, { persist: false });
      expect(good.overall).toBeGreaterThanOrEqual(1);
      expect(good.overall).toBeLessThanOrEqual(5);
      expect(bad.overall).toBeGreaterThanOrEqual(1);
      expect(bad.overall).toBeLessThanOrEqual(5);
    });
  });

  describe('getImprovementSuggestions()', () => {
    it('returns no-data message when empty', async () => {
      readJsonFile.mockResolvedValue(null);
      const result = await getImprovementSuggestions();
      expect(result.overallTrend).toBe('insufficient_data');
      expect(result.suggestions[0]).toContain('No evaluations');
    });

    it('identifies weak dimensions', async () => {
      const evaluations = Array.from({ length: 10 }, (_, i) => ({
        id: `eval-${i}`,
        taskType: 'build',
        overall: 2.5,
        dimensions: {
          accuracy: { score: 2, weight: 0.35 },
          completeness: { score: 2, weight: 0.25 },
          efficiency: { score: 4, weight: 0.20 },
          satisfaction: { score: 2, weight: 0.20 },
        },
      }));
      readJsonFile.mockResolvedValue(evaluations);
      const result = await getImprovementSuggestions({ threshold: 3.0 });
      expect(result.weakDimensions.length).toBeGreaterThan(0);
      expect(result.weakDimensions.some(d => d.dimension === 'accuracy')).toBe(true);
    });

    it('identifies weak task types', async () => {
      const evaluations = Array.from({ length: 10 }, (_, i) => ({
        id: `eval-${i}`,
        taskType: 'deploy',
        overall: 2.0,
        dimensions: {
          accuracy: { score: 2, weight: 0.35 },
          completeness: { score: 2, weight: 0.25 },
          efficiency: { score: 2, weight: 0.20 },
          satisfaction: { score: 2, weight: 0.20 },
        },
      }));
      readJsonFile.mockResolvedValue(evaluations);
      const result = await getImprovementSuggestions();
      expect(result.weakTaskTypes.some(t => t.taskType === 'deploy')).toBe(true);
    });

    it('generates actionable suggestions', async () => {
      const evaluations = Array.from({ length: 10 }, (_, i) => ({
        id: `eval-${i}`,
        taskType: 'build',
        overall: 2.5,
        dimensions: {
          accuracy: { score: 2, weight: 0.35 },
          completeness: { score: 4, weight: 0.25 },
          efficiency: { score: 4, weight: 0.20 },
          satisfaction: { score: 4, weight: 0.20 },
        },
      }));
      readJsonFile.mockResolvedValue(evaluations);
      const result = await getImprovementSuggestions();
      expect(result.suggestions.length).toBeGreaterThan(0);
      expect(result.suggestions.some(s => s.includes('test coverage') || s.includes('validation'))).toBe(true);
    });

    it('reports positive message when all dimensions are good', async () => {
      const evaluations = Array.from({ length: 10 }, (_, i) => ({
        id: `eval-${i}`,
        taskType: 'build',
        overall: 4.5,
        dimensions: {
          accuracy: { score: 5, weight: 0.35 },
          completeness: { score: 4, weight: 0.25 },
          efficiency: { score: 4, weight: 0.20 },
          satisfaction: { score: 5, weight: 0.20 },
        },
      }));
      readJsonFile.mockResolvedValue(evaluations);
      const result = await getImprovementSuggestions();
      expect(result.suggestions.some(s => s.includes('performing well'))).toBe(true);
    });

    it('respects lookback parameter', async () => {
      const evaluations = Array.from({ length: 100 }, (_, i) => ({
        id: `eval-${i}`,
        taskType: 'build',
        overall: i < 80 ? 5.0 : 1.0,
        dimensions: {
          accuracy: { score: i < 80 ? 5 : 1, weight: 0.35 },
          completeness: { score: 4, weight: 0.25 },
          efficiency: { score: 4, weight: 0.20 },
          satisfaction: { score: 4, weight: 0.20 },
        },
      }));
      readJsonFile.mockResolvedValue(evaluations);
      // With lookback=10, only the last 10 (low scores) are analyzed
      const result = await getImprovementSuggestions({ lookback: 10 });
      expect(result.weakDimensions.some(d => d.dimension === 'accuracy')).toBe(true);
    });
  });

  describe('getTeamPerformance()', () => {
    it('returns empty results for no data', async () => {
      readJsonFile.mockResolvedValue(null);
      const result = await getTeamPerformance();
      expect(result.totalEvaluations).toBe(0);
      expect(result.topPerformers).toEqual([]);
    });

    it('groups evaluations by task type', async () => {
      readJsonFile.mockResolvedValue([
        { taskType: 'build', overall: 4.0 },
        { taskType: 'build', overall: 4.5 },
        { taskType: 'fix', overall: 3.0 },
      ]);
      const result = await getTeamPerformance();
      expect(result.byTaskType.build.count).toBe(2);
      expect(result.byTaskType.build.avgScore).toBe(4.25);
      expect(result.byTaskType.fix.count).toBe(1);
    });

    it('identifies top and bottom performers', async () => {
      readJsonFile.mockResolvedValue([
        { taskType: 'build', overall: 5.0 },
        { taskType: 'fix', overall: 2.0 },
        { taskType: 'refactor', overall: 3.0 },
      ]);
      const result = await getTeamPerformance();
      expect(result.topPerformers[0].taskType).toBe('build');
      expect(result.bottomPerformers[0].taskType).toBe('fix');
    });

    it('handles unknown task types', async () => {
      readJsonFile.mockResolvedValue([
        { overall: 3.0 }, // no taskType
      ]);
      const result = await getTeamPerformance();
      expect(result.byTaskType.unknown).toBeDefined();
    });
  });

  describe('getLearningTrends()', () => {
    it('returns insufficient_data for empty evaluations', async () => {
      readJsonFile.mockResolvedValue(null);
      const result = await getLearningTrends();
      expect(result.trend).toBe('insufficient_data');
      expect(result.windows).toEqual([]);
    });

    it('returns single evaluation data', async () => {
      readJsonFile.mockResolvedValue([{ overall: 4.0 }]);
      const result = await getLearningTrends();
      expect(result.trend).toBe('insufficient_data');
      expect(result.latestAvg).toBe(4.0);
    });

    it('computes windows from evaluations', async () => {
      const evaluations = Array.from({ length: 20 }, (_, i) => ({
        overall: 3.0 + (i * 0.1),
      }));
      readJsonFile.mockResolvedValue(evaluations);
      const result = await getLearningTrends({ windowSize: 5 });
      expect(result.windows).toHaveLength(4);
      expect(result.windows[0].count).toBe(5);
    });

    it('detects improving trend', async () => {
      const evaluations = [
        ...Array.from({ length: 5 }, () => ({ overall: 2.0 })),
        ...Array.from({ length: 5 }, () => ({ overall: 4.0 })),
      ];
      readJsonFile.mockResolvedValue(evaluations);
      const result = await getLearningTrends({ windowSize: 5 });
      expect(result.trend).toBe('improving');
    });

    it('detects declining trend', async () => {
      const evaluations = [
        ...Array.from({ length: 5 }, () => ({ overall: 4.0 })),
        ...Array.from({ length: 5 }, () => ({ overall: 2.0 })),
      ];
      readJsonFile.mockResolvedValue(evaluations);
      const result = await getLearningTrends({ windowSize: 5 });
      expect(result.trend).toBe('declining');
    });

    it('detects stable trend', async () => {
      const evaluations = Array.from({ length: 10 }, () => ({ overall: 3.5 }));
      readJsonFile.mockResolvedValue(evaluations);
      const result = await getLearningTrends({ windowSize: 5 });
      expect(result.trend).toBe('stable');
    });
  });
});
