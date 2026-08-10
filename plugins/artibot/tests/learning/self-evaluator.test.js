import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  evaluateResult,
  getImprovementSuggestions,
  getLearningTrends,
  getModelPerformance,
  getScoreHealth,
  getTeamPerformance,
  RUBRIC_VERSION,
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
      expect(ev.dimensions.executionReliability.score).toBe(5);
      expect(ev.dimensions.efficiency.score).toBe(5);
    });

    it('evaluates a failed result with low scores', async () => {
      const result = { success: false, testsPass: false, duration: 600000 };
      const ev = await evaluateResult(baseTask, result);

      expect(ev.overall).toBeLessThan(2);
      expect(ev.grade).toMatch(/^[DF]$/);
      expect(ev.dimensions.executionReliability.score).toBeLessThanOrEqual(1);
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

    // --- rubric v1 cases -----------------------------------------------
    // These pin the pre-v2 duration ladder, which survives as the fallback
    // axis for single-task callers that carry a `duration` but no tool-call
    // signal. They are kept verbatim on purpose: if the v2 ratio axis ever
    // starts swallowing duration-only results, these go red.
    it('scores efficiency based on duration', async () => {
      const fast = await evaluateResult(baseTask, { success: true, duration: 5000 }, { persist: false });
      const slow = await evaluateResult(baseTask, { success: true, duration: 400000 }, { persist: false });
      expect(fast.dimensions.efficiency.score).toBe(5);
      expect(slow.dimensions.efficiency.score).toBeLessThanOrEqual(2);
    });

    // rubric v1 gave 3 here ("neutral"). v2 reports the dimension as unmeasured
    // instead: with no duration and no tool counts there is nothing to score,
    // and a neutral number is a verdict nobody earned.
    it('reports efficiency as unmeasured when neither duration nor tool counts arrive', async () => {
      const ev = await evaluateResult(baseTask, { success: true }, { persist: false });
      expect(ev.dimensions.efficiency).toBeUndefined();
      expect(ev.unmeasuredDimensions).toContain('efficiency');
    });
    // --- end rubric v1 cases -------------------------------------------

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

    // B-1: 세션 추출기는 파일수를 **숫자**로 낸다. `.length` 로 읽으면 숫자
    // 입력에서 신호가 조용히 사라진다. completeness 는 v2 에서 파일수를 쓰지
    // 않게 됐지만, fileCount 는 efficiency 분모와 inputsPresent 가 여전히 쓴다.
    it('파일수가 숫자로 와도 배열과 동일하게 인식된다', async () => {
      const asNumber = await evaluateResult(baseTask, {
        success: true, toolCalls: 120, filesModified: 20,
      }, { persist: false });
      const asArray = await evaluateResult(baseTask, {
        success: true, toolCalls: 120,
        filesModified: Array.from({ length: 20 }, (_, i) => `f${i}.js`),
      }, { persist: false });

      expect(asNumber.dimensions.efficiency.score)
        .toBe(asArray.dimensions.efficiency.score);
      expect(asNumber.inputsPresent.filesModified).toBe(true);
      expect(asNumber.inputsPresent.filesModified).toBe(asArray.inputsPresent.filesModified);
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

    it('dimension weights sum to 1.0 when every dimension is measured', async () => {
      const ev = await evaluateResult(baseTask, {
        success: true, toolCalls: 100, toolErrors: 2, filesEngaged: 20,
        metrics: { requirementsCovered: 0.9, userFeedback: 'positive' },
      }, { persist: false });
      expect(Object.keys(ev.dimensions)).toHaveLength(4);
      const totalWeight = Object.values(ev.dimensions).reduce((s, d) => s + d.weight, 0);
      expect(totalWeight).toBeCloseTo(1.0, 5);
    });

    // 일부 차원이 빠져도 overall 은 1-5 척도를 유지해야 한다. 재정규화가 없으면
    // 차원이 빠질수록 점수가 0 쪽으로 쪼그라들어 등급이 통째로 왜곡된다.
    it('측정된 차원만으로도 overall 이 1-5 척도를 유지한다', async () => {
      const ev = await evaluateResult(baseTask, {
        toolCalls: 100, toolErrors: 0, filesEngaged: 50,
      }, { persist: false });
      expect(Object.keys(ev.dimensions).sort()).toEqual(['efficiency', 'executionReliability']);
      expect(ev.overall).toBeGreaterThanOrEqual(1);
      expect(ev.overall).toBeLessThanOrEqual(5);
      expect(ev.overall).toBe(5); // 두 차원 모두 만점이면 가중평균도 5
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

  describe('model attribution', () => {
    const baseTask = { id: 'task-m', type: 'session' };
    const okResult = { success: true, testsPass: true, duration: 25000 };

    it('모델 정보를 주지 않으면 미귀속 상태로 기록된다', async () => {
      const ev = await evaluateResult(baseTask, okResult);
      expect(ev.model).toBeNull();
      expect(ev.modelMix).toEqual({});
      expect(ev.modelSource).toBe('none');
    });

    it('전달된 실효 모델을 레코드에 남긴다', async () => {
      const ev = await evaluateResult(baseTask, okResult, {
        model: 'claude-opus-5',
        modelMix: { 'claude-opus-5': 12 },
        modelSource: 'transcript',
      });
      expect(ev.model).toBe('claude-opus-5');
      expect(ev.modelMix).toEqual({ 'claude-opus-5': 12 });
      expect(ev.modelSource).toBe('transcript');
    });

    it('저장된 레코드에도 모델 필드가 포함된다', async () => {
      await evaluateResult(baseTask, okResult, { model: 'claude-fable-5' });
      const [, saved] = writeJsonFile.mock.calls.at(-1);
      expect(saved.at(-1).model).toBe('claude-fable-5');
      expect(saved.at(-1).modelSource).toBe('caller');
    });
  });

  describe('getModelPerformance()', () => {
    const row = (model, overall, dims = {}) => ({
      model, overall, dimensions: dims,
    });

    it('모델별 평균 점수를 낸다', async () => {
      readJsonFile.mockResolvedValue([
        row('m-a', 4.0), row('m-a', 5.0), row('m-b', 2.0),
      ]);
      const got = await getModelPerformance({ minSamples: 1 });
      expect(got.byModel['m-a'].avgScore).toBe(4.5);
      expect(got.byModel['m-a'].count).toBe(2);
      expect(got.byModel['m-b'].avgScore).toBe(2);
    });

    it('점수순으로 랭크한다', async () => {
      readJsonFile.mockResolvedValue([
        row('lo', 2.0), row('hi', 5.0),
      ]);
      const got = await getModelPerformance({ minSamples: 1 });
      expect(got.ranked.map(r => r.model)).toEqual(['hi', 'lo']);
    });

    it('model 없는 과거 레코드는 버리지 않고 unattributed 로 센다', async () => {
      readJsonFile.mockResolvedValue([
        { overall: 3.0, dimensions: {} },
        { overall: 3.0, dimensions: {} },
        row('m-a', 4.0),
      ]);
      const got = await getModelPerformance({ minSamples: 1 });
      expect(got.unattributedCount).toBe(2);
      expect(got.attributedCount).toBe(1);
      expect(got.totalEvaluations).toBe(3);
    });

    it('unattributed 는 랭킹에 오르지 않는다', async () => {
      readJsonFile.mockResolvedValue([
        { overall: 5.0, dimensions: {} }, row('m-a', 1.0),
      ]);
      const got = await getModelPerformance({ minSamples: 1 });
      expect(got.ranked.map(r => r.model)).toEqual(['m-a']);
    });

    it('표본이 minSamples 미만인 모델은 랭킹에서 뺀다', async () => {
      readJsonFile.mockResolvedValue([
        row('thin', 5.0),
        ...Array.from({ length: 5 }, () => row('thick', 3.0)),
      ]);
      const got = await getModelPerformance({ minSamples: 5 });
      expect(got.ranked.map(r => r.model)).toEqual(['thick']);
      expect(got.byModel.thin.count).toBe(1);
    });

    it('차원별 평균도 모델별로 낸다', async () => {
      readJsonFile.mockResolvedValue([
        row('m-a', 4.0, { accuracy: { score: 5 } }),
        row('m-a', 4.0, { accuracy: { score: 3 } }),
      ]);
      const got = await getModelPerformance({ minSamples: 1 });
      expect(got.byModel['m-a'].dimensions.accuracy).toBe(4);
    });

    it('평가가 없으면 빈 결과', async () => {
      readJsonFile.mockResolvedValue(null);
      const got = await getModelPerformance();
      expect(got.ranked).toEqual([]);
      expect(got.totalEvaluations).toBe(0);
    });
  });

  // =====================================================================
  // rubric v2 — 채점 체제 스탬프
  // =====================================================================

  describe('rubricVersion 스탬프', () => {
    const baseTask = { id: 'task-r', type: 'session' };

    it('신규 레코드에 현재 rubric 버전을 찍는다', async () => {
      const ev = await evaluateResult(baseTask, { success: true }, { persist: false });
      expect(ev.rubricVersion).toBe(RUBRIC_VERSION);
      expect(RUBRIC_VERSION).toBeGreaterThan(1);
    });

    it('저장된 레코드에도 rubric 버전이 남는다', async () => {
      await evaluateResult(baseTask, { success: true });
      const [, saved] = writeJsonFile.mock.calls.at(-1);
      expect(saved.at(-1).rubricVersion).toBe(RUBRIC_VERSION);
    });
  });

  // =====================================================================
  // inputsPresent — 배관 끊긴 행 ↔ 진짜 실패 행 구분
  // =====================================================================

  describe('inputsPresent', () => {
    const baseTask = { id: 'task-i', type: 'session' };

    it('신호가 다 있으면 전부 true 로 기록한다', async () => {
      const ev = await evaluateResult(baseTask, {
        success: true, testsPass: true, duration: 1000,
        filesModified: ['a.js'], filesEngaged: 4, toolCalls: 10, toolErrors: 1,
      }, { persist: false, signalSource: 'transcript' });

      expect(ev.inputsPresent).toEqual({
        success: true,
        testsPass: true,
        duration: true,
        filesModified: true,
        filesEngaged: true,
        toolCalls: true,
        toolErrors: true,
        signalSource: 'transcript',
      });
    });

    it('신호가 하나도 없으면 전부 false + signalSource none', async () => {
      const ev = await evaluateResult(baseTask, {}, { persist: false });
      expect(ev.inputsPresent).toEqual({
        success: false,
        testsPass: false,
        duration: false,
        filesModified: false,
        filesEngaged: false,
        toolCalls: false,
        toolErrors: false,
        signalSource: 'none',
      });
    });

    // toolCalls 만 보고 "오류율이 계산됐다"고 오추론하지 않도록 별도 기록한다.
    it('toolCalls 만 오고 toolErrors 가 없으면 그 사실이 남는다', async () => {
      const ev = await evaluateResult(baseTask, {
        success: true, toolCalls: 100, filesEngaged: 20,
      }, { persist: false, signalSource: 'transcript' });
      expect(ev.inputsPresent.toolCalls).toBe(true);
      expect(ev.inputsPresent.toolErrors).toBe(false);
    });

    // 이것이 이 필드의 존재 이유다. 배관 끊김과 실제 실패는 레코드로도,
    // 이제는 점수로도 구분된다.
    it('신호 부재와 명시적 실패를 구분해 기록한다', async () => {
      const noSignal = await evaluateResult(baseTask, {}, { persist: false });
      const realFail = await evaluateResult(baseTask, { success: false }, { persist: false });

      expect(noSignal.dimensions.executionReliability).toBeUndefined();   // 채점 안 함
      expect(realFail.dimensions.executionReliability.score).toBe(1);      // 실패는 채점함
      expect(noSignal.inputsPresent.success).toBe(false);
      expect(realFail.inputsPresent.success).toBe(true);
    });

    it('testsPass=false 도 신호 도착으로 센다', async () => {
      const ev = await evaluateResult(baseTask, { success: true, testsPass: false }, { persist: false });
      expect(ev.inputsPresent.testsPass).toBe(true);
    });

    it('filesModified 는 빈 배열이어도 신호 도착으로 센다', async () => {
      const ev = await evaluateResult(baseTask, { success: true, filesModified: [] }, { persist: false });
      expect(ev.inputsPresent.filesModified).toBe(true);
    });

    it('저장된 레코드에도 inputsPresent 가 남는다', async () => {
      await evaluateResult(baseTask, { success: true });
      const [, saved] = writeJsonFile.mock.calls.at(-1);
      expect(saved.at(-1).inputsPresent.signalSource).toBe('none');
    });
  });

  // =====================================================================
  // B-2: 미측정을 실패로 채점하지 않는다
  // =====================================================================

  describe('미측정 세션 채점', () => {
    const baseTask = { id: 'task-n', type: 'session' };
    // 실측된 퇴화 시그니처와 글자 그대로 같으면 안 된다.
    // 배관을 고쳐놓고 "못 쟀다"를 "망했다"로 기록하면 같은 자리로 돌아온다.
    it('신호가 하나도 없으면 실측 퇴화 시그니처(1,3,3,2)를 만들지 않는다', async () => {
      const ev = await evaluateResult(baseTask, {}, { persist: false });
      expect(ev.overall).not.toBe(2.1);
      expect(ev.grade).not.toBe('D');
    });

    it('신호가 하나도 없으면 아무 차원도 채점하지 않는다', async () => {
      const ev = await evaluateResult(baseTask, {}, { persist: false });
      expect(ev.dimensions).toEqual({});
      expect(ev.unmeasuredDimensions.sort())
        .toEqual(['completeness', 'efficiency', 'executionReliability', 'satisfaction']);
      expect(ev.overall).toBeNull();
      expect(ev.grade).toBeNull();
      expect(ev.feedback).toContain('nothing was measured');
    });

    it('명시적 실패는 여전히 낮게 채점한다 (미측정 처리가 실패를 삼키지 않는다)', async () => {
      const ev = await evaluateResult(baseTask, { success: false }, { persist: false });
      expect(ev.dimensions.executionReliability.score).toBe(1);
      expect(ev.overall).toBe(1);
      expect(ev.grade).toBe('F');
    });

    it('신호가 일부만 와도 그 차원만 채점된다', async () => {
      const ev = await evaluateResult(baseTask, { success: true }, { persist: false });
      expect(ev.dimensions.executionReliability.score).toBe(4);
      expect(ev.dimensions.efficiency).toBeUndefined();
      expect(ev.unmeasuredDimensions).toContain('efficiency');
    });

    it('미측정 행은 모델 비교 평균을 끌어내리지 않는다', async () => {
      const measured = (model, overall) => ({
        model, overall, dimensions: {}, rubricVersion: 2,
        inputsPresent: { success: true, signalSource: 'transcript' },
      });
      const unmeasured = (model, overall) => ({
        model, overall, dimensions: {}, rubricVersion: 2,
        inputsPresent: {
          success: false, testsPass: false, duration: false,
          filesModified: false, filesEngaged: false, toolCalls: false,
          signalSource: 'none',
        },
      });
      readJsonFile.mockResolvedValue([
        measured('m-a', 5.0), measured('m-a', 5.0),
        unmeasured('m-a', 3.0), unmeasured('m-a', 3.0),
      ]);
      const got = await getModelPerformance({ minSamples: 1 });
      expect(got.byModel['m-a'].avgScore).toBe(5);
      expect(got.byModel['m-a'].count).toBe(2);
      expect(got.excludedUnmeasured).toBe(2);
    });

    // getScoreHealth 는 반대로 미측정 행을 **버리지 않는다** — 그게 경보 신호다.
    it('전 행이 미측정이면 건강도는 침묵이 아니라 degenerate 를 낸다', async () => {
      const unmeasured = () => ({
        overall: 3, rubricVersion: 2,
        dimensions: {
          accuracy: { score: 3 }, completeness: { score: 3 },
          efficiency: { score: 3 }, satisfaction: { score: 3 },
        },
        inputsPresent: {
          success: false, testsPass: false, duration: false,
          filesModified: false, filesEngaged: false, toolCalls: false,
          signalSource: 'none',
        },
      });
      readJsonFile.mockResolvedValue(Array.from({ length: 15 }, unmeasured));
      const got = await getScoreHealth();
      expect(got.samples).toBe(15);
      expect(got.unmeasured).toBe(15);
      expect(got.degenerate).toBe(true);
    });
  });

  // =====================================================================
  // scoreEfficiency 재설계 — 도구호출/산출파일 비율 축
  // =====================================================================

  describe('scoreEfficiency (rubric v2 — toolCalls per file)', () => {
    const baseTask = { id: 'task-e', type: 'session' };

    // `resolveSessionSignals`(WP-A)를 실 transcript 7개에 돌려 얻은 값이다.
    // 픽스처가 아니라 실측이며, 사다리 경계는 이 분포에서 유도했다.
    // 상위 카운트는 main+subagent 합산이다.
    const MEASURED_SESSIONS = [
      { id: '7c0f761d', toolCalls: 146, filesEngaged: 23, ratio: 6.35, expected: 4 },
      { id: '6f24c986', toolCalls: 189, filesEngaged: 29, ratio: 6.52, expected: 4 },
      { id: '43b8b018', toolCalls: 468, filesEngaged: 73, ratio: 6.41, expected: 4 },
      { id: 'd7f7d154', toolCalls: 279, filesEngaged: 36, ratio: 7.75, expected: 3 },
      { id: 'eb558cba', toolCalls: 151, filesEngaged: 19, ratio: 7.95, expected: 3 },
      { id: '6dc179bb', toolCalls: 192, filesEngaged: 17, ratio: 11.29, expected: 2 },
      { id: 'bda9c5e5', toolCalls: 315, filesEngaged: 20, ratio: 15.75, expected: 1 },
    ];

    // 이 7세션은 **큰 세션만 모인 편향 표본**이다. 경계는 전수 84세션 분위수에
    // 맞춰 잡았으므로, 그 분위수가 서로 다른 등급에 떨어지는지를 따로 고정한다.
    // (이전 사다리는 7세션에선 잘 퍼졌지만 전수에선 52%가 한 등급에 몰렸다.)
    const POPULATION_QUANTILES = [
      { p: 'p10', ratio: 3.42 }, { p: 'p20', ratio: 4.26 },
      { p: 'p40', ratio: 6.00 }, { p: 'p60', ratio: 7.75 },
      { p: 'p80', ratio: 11.55 }, { p: 'p90', ratio: 15.75 },
    ];

    const scoreFor = async (result) => {
      const ev = await evaluateResult(baseTask, { success: true, ...result }, { persist: false });
      return ev.dimensions.efficiency.score;
    };

    // ★ AC-2 / R1 방어. "3이 아님"이 아니라 "값이 2종 이상"이어야 통과다.
    it('AC-2: 실측 7세션에서 efficiency 가 상수로 붕괴하지 않는다', async () => {
      const scores = [];
      for (const s of MEASURED_SESSIONS) {
        scores.push(await scoreFor({ toolCalls: s.toolCalls, filesEngaged: s.filesEngaged }));
      }
      const distinct = [...new Set(scores)].sort();
      expect(distinct.length).toBeGreaterThan(1);
      // 상수 3 → 상수 1 치환은 통과가 아니다 (PRD §1.4 C3 의 거짓 수정)
      expect(distinct).not.toEqual([1]);
      expect(distinct).not.toEqual([3]);
      // 한 등급에 표본이 몰리면 경계가 틀린 것이다
      const hist = {};
      for (const s of scores) hist[s] = (hist[s] ?? 0) + 1;
      expect(Math.max(...Object.values(hist))).toBeLessThan(5);
    });

    it.each(MEASURED_SESSIONS)(
      '실측 $id (ratio $ratio) → efficiency $expected',
      async ({ toolCalls, filesEngaged, expected }) => {
        expect(await scoreFor({ toolCalls, filesEngaged })).toBe(expected);
      },
    );

    // 전수 분포 기준 쏠림 방지. 분위수가 한 등급으로 뭉치면 경계가 틀린 것이다.
    it('전수 84세션 분위수가 서로 다른 등급으로 흩어진다', async () => {
      const scores = [];
      for (const { ratio } of POPULATION_QUANTILES) {
        // 비율을 그대로 만들기 위해 분모를 100 으로 고정
        scores.push(await scoreFor({ toolCalls: Math.round(ratio * 100), filesEngaged: 100 }));
      }
      expect(new Set(scores).size).toBeGreaterThanOrEqual(4);
      // p20 과 p80 이 같은 등급이면 중간 구간이 통째로 뭉친 것이다
      expect(scores[1]).not.toBe(scores[4]);
    });

    // 상류 추출기는 filesSeen(전수)과 filesTouched(편집 한정)를 둘 다 낸다.
    // 배선 담당(WP-D)이 어느 쪽을 실어도 사다리가 무너지지 않아야 한다.
    // 아래는 같은 7세션의 편집 한정 분모 실측값이다.
    it('편집 한정 분모(filesTouched)로 실어도 상수로 붕괴하지 않는다', async () => {
      const editOnly = [
        { toolCalls: 189, filesModified: 25 },  // 7.56
        { toolCalls: 146, filesModified: 18 },  // 8.11
        { toolCalls: 151, filesModified: 16 },  // 9.44
        { toolCalls: 279, filesModified: 17 },  // 16.41
        { toolCalls: 315, filesModified: 19 },  // 16.58
        { toolCalls: 468, filesModified: 28 },  // 16.71
        { toolCalls: 192, filesModified: 10 },  // 19.20
      ];
      const scores = [];
      for (const s of editOnly) scores.push(await scoreFor(s));
      const distinct = [...new Set(scores)].sort();
      expect(distinct.length).toBeGreaterThan(1);
      expect(distinct).not.toEqual([1]);
      const hist = {};
      for (const s of scores) hist[s] = (hist[s] ?? 0) + 1;
      expect(Math.max(...Object.values(hist))).toBeLessThan(5);
    });

    // filesEngaged 가 우선하되, WP-D 가 그 필드를 빠뜨려도 비율 축은 살아 있어야
    // 한다. duration 축으로 떨어지면 전 세션이 1점으로 붕괴한다(R1 재발).
    it('filesEngaged 가 없으면 filesModified 로 비율을 낸다', async () => {
      // 6.0 — 중립값(3)도 최저값(1)도 아닌 값이라 비율 경로가 실제로 돌았음을 증명한다
      expect(await scoreFor({ toolCalls: 120, filesModified: 20 })).toBe(4);
    });

    it('filesEngaged 가 있으면 그쪽이 우선한다', async () => {
      // engaged 6.41 → 4, modified 16.71 → 1. 4가 나오면 engaged 를 쓴 것이다.
      expect(await scoreFor({ toolCalls: 468, filesEngaged: 73, filesModified: 28 })).toBe(4);
    });

    it('세션 wall-clock 을 duration 으로 실어도 비율 축이 우선한다', async () => {
      // 실측 span 52~1,849분. v1 사다리에 넣으면 7/7 전부 1점으로 붕괴한다.
      const score = await scoreFor({
        toolCalls: 189,
        filesEngaged: 29,
        duration: 84 * 60 * 1000,
      });
      expect(score).toBe(4);
    });

    it('파일 0건이면 0으로 나누지 않고 미측정으로 둔다', async () => {
      const ev = await evaluateResult(baseTask,
        { success: true, toolCalls: 120, filesEngaged: [] }, { persist: false });
      expect(ev.dimensions.efficiency).toBeUndefined();
      expect(ev.unmeasuredDimensions).toContain('efficiency');
    });

    it('toolCalls 0 이면 비율 축을 쓰지 않는다', async () => {
      const ev = await evaluateResult(baseTask,
        { success: true, toolCalls: 0, filesEngaged: 20 }, { persist: false });
      expect(ev.dimensions.efficiency).toBeUndefined();
    });

    it('파일수를 배열로 줘도 숫자로 줘도 같은 점수', async () => {
      const asArray = await scoreFor({
        toolCalls: 315,
        filesEngaged: Array.from({ length: 20 }, (_, i) => `f${i}.js`),
      });
      expect(asArray).toBe(await scoreFor({ toolCalls: 315, filesEngaged: 20 }));
      expect(asArray).toBe(1);
    });

    it('비율 신호가 없으면 v1 duration 사다리로 물러난다', async () => {
      expect(await scoreFor({ duration: 25000 })).toBe(5);
      expect(await scoreFor({ duration: 400000 })).toBe(1);
    });

    it('아주 높은 비율은 최저점', async () => {
      expect(await scoreFor({ toolCalls: 500, filesModified: 5 })).toBe(1);
    });

    it('아주 낮은 비율은 최고점', async () => {
      expect(await scoreFor({ toolCalls: 10, filesModified: 5 })).toBe(5);
    });
  });

  // =====================================================================
  // getScoreHealth — 퇴화 자가감지
  // =====================================================================

  describe('getScoreHealth()', () => {
    const dims = (a, c, e, s) => ({
      accuracy: { score: a, weight: 0.35 },
      completeness: { score: c, weight: 0.25 },
      efficiency: { score: e, weight: 0.20 },
      satisfaction: { score: s, weight: 0.20 },
    });
    const v2row = (a, c, e, s) => ({ rubricVersion: 2, overall: 3, dimensions: dims(a, c, e, s) });

    it('시그니처가 1종뿐이면 degenerate', async () => {
      readJsonFile.mockResolvedValue(Array.from({ length: 20 }, () => v2row(1, 3, 3, 2)));
      const got = await getScoreHealth();
      expect(got.samples).toBe(20);
      expect(got.distinctSignatures).toBe(1);
      expect(got.degenerate).toBe(true);
      expect(got.reason).toBeTruthy();
    });

    it('시그니처가 다양하면 건강하다', async () => {
      readJsonFile.mockResolvedValue([
        ...Array.from({ length: 5 }, (_, i) => v2row(1 + i % 5, 3, 2, 2)),
        ...Array.from({ length: 5 }, (_, i) => v2row(4, 2 + i % 4, 4, 5)),
        ...Array.from({ length: 5 }, (_, i) => v2row(5, 5, 3 + i % 3, 1 + i % 4)),
      ]);
      const got = await getScoreHealth();
      expect(got.degenerate).toBe(false);
      expect(got.reason).toBeNull();
    });

    // ★ 이 픽스처가 실제 프로덕션 형상이다. 4개 차원이 모두 변하는 픽스처만
    // 검증하면, 실제로 나오는 "3개 상수 + 1개 변동"을 한 번도 시험하지 않는다.
    // 92세션 실측 비율을 그대로 재현한다.
    it('실측 형상(3개 차원 준-상수 + efficiency 변동)을 degenerate 로 잡는다', async () => {
      const rows = [];
      for (let i = 0; i < 92; i += 1) {
        // accuracy/satisfaction 은 90:2, completeness 는 79:11:2 로 쏠려 있었다
        const acc = i < 90 ? 4 : 1;
        const sat = i < 90 ? 4 : 2;
        const comp = i < 79 ? 4.5 : (i < 90 ? 4 : 3);
        const eff = [1, 2, 3, 4, 5][i % 5];
        rows.push(v2row(acc, comp, eff, sat));
      }
      readJsonFile.mockResolvedValue(rows);
      const got = await getScoreHealth({ lookback: 92 });

      // distinct > 1 은 형식적으로 충족된다 — 그것만으로는 못 잡는다
      expect(got.distinctByDimension.accuracy).toBe(2);
      expect(got.distinctByDimension.satisfaction).toBe(2);
      // 그러나 한 값이 98% 를 차지하면 사실상 상수다
      expect(got.degenerate).toBe(true);
      expect(got.reason).toContain('accuracy');
      expect(got.reason).toContain('satisfaction');
    });

    it('소수 표본이 만든 분산으로는 차원이 살아있다고 인정하지 않는다', async () => {
      // 2/92 = 2.2% 가 만드는 분산 — 이걸 통과시키면 게이트가 고무도장이다
      const rows = Array.from({ length: 92 }, (_, i) => v2row(
        i < 90 ? 4 : 1, [3, 4, 4.5][i % 3], [1, 2, 3, 4, 5][i % 5], [2, 4][i % 2],
      ));
      readJsonFile.mockResolvedValue(rows);
      const got = await getScoreHealth({ lookback: 92 });
      expect(got.degenerate).toBe(true);
      expect(got.reason).toMatch(/accuracy \(\d+% one value\)/);
    });

    it('모든 차원이 고르게 퍼져 있으면 통과시킨다', async () => {
      const rows = Array.from({ length: 92 }, (_, i) => v2row(
        [1, 2, 3, 4, 5][i % 5], [3, 4, 4.5][i % 3],
        [1, 2, 3, 4, 5][(i + 2) % 5], [2, 4, 5][i % 3],
      ));
      readJsonFile.mockResolvedValue(rows);
      const got = await getScoreHealth({ lookback: 92 });
      expect(got.degenerate).toBe(false);
    });

    // 실제로 일어난 결함: 500행 전체에서 efficiency 만 상수 3 이었고
    // 다른 차원은 변했다 → distinctSignatures 는 2 라서 <=1 규칙으로는 못 잡는다.
    it('한 차원만 상수여도 잡아낸다 (실제 결함 형상)', async () => {
      readJsonFile.mockResolvedValue([
        ...Array.from({ length: 10 }, () => v2row(4, 4, 3, 4)),
        ...Array.from({ length: 10 }, () => v2row(1, 3, 3, 2)),
      ]);
      const got = await getScoreHealth();
      expect(got.distinctSignatures).toBe(2);
      expect(got.distinctByDimension.efficiency).toBe(1);
      expect(got.distinctByDimension.accuracy).toBe(2);
      expect(got.degenerate).toBe(true);
      expect(got.reason).toContain('efficiency');
    });

    it('표본이 적으면 퇴화로 단정하지 않는다', async () => {
      readJsonFile.mockResolvedValue(Array.from({ length: 3 }, () => v2row(1, 3, 3, 2)));
      const got = await getScoreHealth();
      expect(got.degenerate).toBe(false);
      expect(got.reason).toBe('insufficient_samples');
    });

    it('표본 대비 시그니처 종수가 극히 적으면 degenerate', async () => {
      // 500행 / 2종 — 개별 차원은 변하지만 전체 다양성이 사실상 없다
      readJsonFile.mockResolvedValue([
        ...Array.from({ length: 182 }, () => v2row(4, 4, 3, 4)),
        ...Array.from({ length: 318 }, () => v2row(1, 3, 3, 2)),
      ]);
      const got = await getScoreHealth({ lookback: 500 });
      expect(got.samples).toBe(500);
      expect(got.distinctSignatures).toBe(2);
      expect(got.degenerate).toBe(true);
    });

    it('lookback 을 존중한다', async () => {
      readJsonFile.mockResolvedValue([
        ...Array.from({ length: 30 }, () => v2row(4, 4, 5, 4)),
        ...Array.from({ length: 12 }, () => v2row(1, 3, 3, 2)),
      ]);
      const got = await getScoreHealth({ lookback: 12 });
      expect(got.samples).toBe(12);
      expect(got.distinctSignatures).toBe(1);
      expect(got.degenerate).toBe(true);
    });

    it('구 rubric 행은 현재 체제 건강도에 섞지 않는다', async () => {
      readJsonFile.mockResolvedValue([
        ...Array.from({ length: 20 }, () => ({ overall: 3, dimensions: dims(4, 4, 3, 4) })), // v1
        ...Array.from({ length: 12 }, () => v2row(1, 3, 3, 2)),
      ]);
      const got = await getScoreHealth();
      expect(got.rubricVersion).toBe(2);
      expect(got.samples).toBe(12);
      expect(got.excludedByRubric).toBe(20);
      expect(got.degenerate).toBe(true);
    });

    it('평가가 없으면 조용히 비어 있는 결과', async () => {
      readJsonFile.mockResolvedValue(null);
      const got = await getScoreHealth();
      expect(got.samples).toBe(0);
      expect(got.degenerate).toBe(false);
    });

    // 스키마 호환: v2 레코드는 차원 키가 4개가 아닐 수 있다.
    // **부재를 "상수 1종"으로 세면 안 된다** — 없는 차원은 아예 판정 대상이 아니다.
    it('차원이 아예 없는 경우를 상수로 오판하지 않는다', async () => {
      readJsonFile.mockResolvedValue(Array.from({ length: 20 }, (_, i) => ({
        rubricVersion: 2, overall: 3,
        dimensions: {
          accuracy: { score: [1, 2, 3, 4, 5][i % 5] },
          efficiency: { score: [5, 4, 3, 2, 1][i % 5] },
        },
        unmeasuredDimensions: ['completeness', 'satisfaction'],
      })));
      const got = await getScoreHealth();
      expect(got.distinctByDimension.completeness).toBeUndefined();
      expect(got.distinctByDimension.satisfaction).toBeUndefined();
      expect(got.degenerate).toBe(false);
      expect(got.reason).toBeNull();
    });

    it('표본이 적은 차원은 상수로 단정하지 않는다', async () => {
      readJsonFile.mockResolvedValue([
        ...Array.from({ length: 20 }, (_, i) => ({
          rubricVersion: 2, overall: 3,
          dimensions: {
            accuracy: { score: [1, 2, 3, 4, 5][i % 5] },
            efficiency: { score: [5, 4, 3, 2, 1][i % 5] },
          },
        })),
        // completeness 가 단 2행에만, 같은 값으로 존재한다
        ...Array.from({ length: 2 }, () => ({
          rubricVersion: 2, overall: 3,
          dimensions: {
            accuracy: { score: 3 }, efficiency: { score: 3 },
            completeness: { score: 4.5 },
          },
        })),
      ]);
      const got = await getScoreHealth({ lookback: 22 });
      expect(got.distinctByDimension.completeness).toBe(1);
      expect(got.degenerate).toBe(false); // 2행짜리 차원으로 퇴화 선언 금지
    });

    // ★ 값 기반 규칙은 "차원이 통째로 사라진 것"을 원리적으로 못 본다 —
    // 맵에 항목이 없으니 순회 대상이 아니다. 루브릭 절반이 죽었는데 ok 가 나오던 구멍.
    it('루브릭에 있는데 한 행도 못 낸 차원을 absentDimensions 로 노출한다', async () => {
      readJsonFile.mockResolvedValue(Array.from({ length: 20 }, (_, i) => ({
        rubricVersion: 2, overall: 3,
        dimensions: {
          executionReliability: { score: [1, 2, 3, 4, 5][i % 5] },
          efficiency: { score: [5, 4, 3, 2, 1][i % 5] },
        },
      })));
      const got = await getScoreHealth();
      expect(got.absentDimensions.sort()).toEqual(['completeness', 'satisfaction']);
      expect(got.dimensionCoverage.executionReliability).toBe(20);
      expect(got.dimensionCoverage.completeness).toBeUndefined();
    });

    // 항상 부재인 차원(신호원 자체가 없음)으로 매 세션 경보를 울리면 경보 피로가
    // 생기고, 상시 경보는 아무도 안 본다 — 이번에 고친 실패의 재발이다.
    it('항상 부재인 차원으로는 degenerate 를 울리지 않는다', async () => {
      readJsonFile.mockResolvedValue(Array.from({ length: 20 }, (_, i) => ({
        rubricVersion: 2, overall: 3,
        dimensions: {
          executionReliability: { score: [1, 2, 3, 4, 5][i % 5] },
          efficiency: { score: [5, 4, 3, 2, 1][i % 5] },
        },
      })));
      const got = await getScoreHealth();
      expect(got.absentDimensions).toHaveLength(2);
      expect(got.degenerate).toBe(false);
    });

    // 반대로 "잘 내던 차원이 갑자기 멈춘 것"은 배선이 끊긴 사건이라 경보 대상이다.
    it('보고하던 차원이 도중에 멈추면 degenerate 로 잡는다', async () => {
      readJsonFile.mockResolvedValue([
        ...Array.from({ length: 10 }, (_, i) => ({
          rubricVersion: 2, overall: 3,
          dimensions: {
            executionReliability: { score: [1, 2, 3, 4, 5][i % 5] },
            efficiency: { score: [5, 4, 3, 2, 1][i % 5] },
            completeness: { score: [3, 4, 4.5][i % 3] },
          },
        })),
        ...Array.from({ length: 10 }, (_, i) => ({
          rubricVersion: 2, overall: 3,
          dimensions: {
            executionReliability: { score: [1, 2, 3, 4, 5][i % 5] },
            efficiency: { score: [5, 4, 3, 2, 1][i % 5] },
          },
        })),
      ]);
      const got = await getScoreHealth();
      expect(got.degenerate).toBe(true);
      expect(got.reason).toContain('stopped reporting');
      expect(got.reason).toContain('completeness');
    });

    it('v1(4키)과 v2(부분키) 행이 섞여도 순회가 깨지지 않는다', async () => {
      readJsonFile.mockResolvedValue([
        ...Array.from({ length: 10 }, () => ({
          overall: 3.8,
          dimensions: {
            accuracy: { score: 4 }, completeness: { score: 4 },
            efficiency: { score: 3 }, satisfaction: { score: 4 },
          },
        })),
        ...Array.from({ length: 12 }, (_, i) => ({
          rubricVersion: 2, overall: 3 + (i % 3),
          dimensions: { accuracy: { score: 1 + i % 5 }, efficiency: { score: 5 - i % 5 } },
        })),
      ]);
      const got = await getScoreHealth();
      expect(got.rubricVersion).toBe(2);
      expect(got.excludedByRubric).toBe(10);
      expect(got.samples).toBe(12);
    });
  });

  // =====================================================================
  // 스키마 호환 — 선택적 차원이 집계를 깨지 않는다
  // =====================================================================

  describe('선택적 차원 하위호환', () => {
    it('차원 평균은 그 차원을 가진 행 수로 나눈다', async () => {
      // accuracy 는 4행 전부, completeness 는 2행에만. completeness 평균이
      // 행 수(4)로 나뉘면 절반으로 깎여 "낮은 점수"처럼 보인다.
      readJsonFile.mockResolvedValue([
        { model: 'm', overall: 4, rubricVersion: 2, dimensions: { accuracy: { score: 4 }, completeness: { score: 4 } } },
        { model: 'm', overall: 4, rubricVersion: 2, dimensions: { accuracy: { score: 4 }, completeness: { score: 4 } } },
        { model: 'm', overall: 4, rubricVersion: 2, dimensions: { accuracy: { score: 4 } } },
        { model: 'm', overall: 4, rubricVersion: 2, dimensions: { accuracy: { score: 4 } } },
      ]);
      const got = await getModelPerformance({ minSamples: 1 });
      expect(got.byModel.m.dimensions.accuracy).toBe(4);
      expect(got.byModel.m.dimensions.completeness).toBe(4); // 2 가 아니어야 한다
    });

    it('overall 이 null 인 행이 섞여도 집계가 NaN 이 되지 않는다', async () => {
      readJsonFile.mockResolvedValue([
        { taskType: 'session', model: 'm', overall: 4, rubricVersion: 2, dimensions: { accuracy: { score: 4 } } },
        {
          taskType: 'session', model: 'm', overall: null, rubricVersion: 2, dimensions: {},
          inputsPresent: {
            success: false, testsPass: false, duration: false,
            filesModified: false, filesEngaged: false, toolCalls: false, signalSource: 'none',
          },
        },
      ]);
      const perf = await getModelPerformance({ minSamples: 1 });
      expect(perf.byModel.m.avgScore).toBe(4);
      expect(perf.excludedUnmeasured).toBe(1);

      const team = await getTeamPerformance();
      expect(Number.isNaN(team.byTaskType.session.avgScore)).toBe(false);
      expect(team.byTaskType.session.avgScore).toBe(4);

      const sugg = await getImprovementSuggestions();
      expect(sugg.weakDimensions.every(d => !Number.isNaN(d.avgScore))).toBe(true);
    });
  });

  // =====================================================================
  // rubric 경계 가드 (AC-3)
  // =====================================================================

  describe('rubric 경계 가드', () => {
    const v1 = (model, overall) => ({ model, overall, dimensions: {} });
    const v2 = (model, overall) => ({ model, overall, dimensions: {}, rubricVersion: 2 });

    describe('getModelPerformance()', () => {
      it('v1/v2 가 섞이면 최신 rubric 만 집계하고 제외 수를 보고한다', async () => {
        readJsonFile.mockResolvedValue([
          v1('m-a', 1.0), v1('m-a', 1.0), v1('m-b', 1.0),
          v2('m-a', 5.0), v2('m-a', 5.0),
        ]);
        const got = await getModelPerformance({ minSamples: 1 });
        expect(got.rubricVersion).toBe(2);
        expect(got.excludedByRubric).toBe(3);
        expect(got.totalEvaluations).toBe(2);
        expect(got.byModel['m-a'].avgScore).toBe(5);
        expect(got.byModel['m-b']).toBeUndefined();
      });

      it('v1 행만 있으면 v1 을 집계한다 (업그레이드 직후 빈 리포트 방지)', async () => {
        readJsonFile.mockResolvedValue([v1('m-a', 4.0), v1('m-a', 2.0)]);
        const got = await getModelPerformance({ minSamples: 1 });
        expect(got.rubricVersion).toBe(1);
        expect(got.excludedByRubric).toBe(0);
        expect(got.byModel['m-a'].avgScore).toBe(3);
      });

      it('rubricVersion 을 명시하면 그 체제를 집계한다', async () => {
        readJsonFile.mockResolvedValue([v1('m-a', 2.0), v2('m-a', 5.0)]);
        const got = await getModelPerformance({ minSamples: 1, rubricVersion: 1 });
        expect(got.rubricVersion).toBe(1);
        expect(got.byModel['m-a'].avgScore).toBe(2);
        expect(got.excludedByRubric).toBe(1);
      });
    });

    describe('getLearningTrends()', () => {
      const trendRow = (overall, rubricVersion) => (
        rubricVersion === undefined ? { overall } : { overall, rubricVersion }
      );

      it('구 rubric 행을 추세 평균에 섞지 않는다', async () => {
        readJsonFile.mockResolvedValue([
          ...Array.from({ length: 10 }, () => trendRow(1.0)),          // v1
          ...Array.from({ length: 5 }, () => trendRow(2.0, 2)),
          ...Array.from({ length: 5 }, () => trendRow(4.0, 2)),
        ]);
        const got = await getLearningTrends({ windowSize: 5 });
        expect(got.rubricVersion).toBe(2);
        expect(got.excludedByRubric).toBe(10);
        expect(got.windows).toHaveLength(2);
        expect(got.earliestAvg).toBe(2.0);
        expect(got.latestAvg).toBe(4.0);
        expect(got.trend).toBe('improving');
      });

      it('현재 rubric 행이 2건 미만이면 insufficient_data', async () => {
        readJsonFile.mockResolvedValue([
          ...Array.from({ length: 20 }, () => trendRow(3.0)),          // v1 다수
          trendRow(5.0, 2),                                            // v2 1건
        ]);
        const got = await getLearningTrends();
        expect(got.trend).toBe('insufficient_data');
        expect(got.latestAvg).toBe(5.0);
        expect(got.excludedByRubric).toBe(20);
      });
    });
  });
});
