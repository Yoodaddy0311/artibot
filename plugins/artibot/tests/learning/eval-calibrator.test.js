import { afterEach, describe, expect, it } from 'vitest';
import {
  _buildOverride,
  _dimensionStats,
  createEvalCalibrator,
  DEFAULT_DIMENSIONS,
} from '../../lib/learning/eval-calibrator.js';
import { reset as resetEventBus, getLastEvent } from '../../lib/core/event-bus.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const fixedNow = () => '2026-03-27T00:00:00.000Z';

function makeCalibrator(opts = {}) {
  return createEvalCalibrator({ now: fixedNow, ...opts });
}

afterEach(() => {
  resetEventBus();
});

// ---------------------------------------------------------------------------
// Unit: DEFAULT_DIMENSIONS
// ---------------------------------------------------------------------------

describe('eval-calibrator/DEFAULT_DIMENSIONS', () => {
  it('4개 차원 정의', () => {
    expect(Object.keys(DEFAULT_DIMENSIONS)).toHaveLength(4);
    expect(DEFAULT_DIMENSIONS).toHaveProperty('accuracy');
    expect(DEFAULT_DIMENSIONS).toHaveProperty('completeness');
    expect(DEFAULT_DIMENSIONS).toHaveProperty('efficiency');
    expect(DEFAULT_DIMENSIONS).toHaveProperty('satisfaction');
  });

  it('가중치 합이 1.0', () => {
    const sum = Object.values(DEFAULT_DIMENSIONS).reduce((s, d) => s + d.weight, 0);
    expect(sum).toBeCloseTo(1.0);
  });

  it('frozen 객체', () => {
    expect(Object.isFrozen(DEFAULT_DIMENSIONS)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Unit: buildOverride
// ---------------------------------------------------------------------------

describe('eval-calibrator/_buildOverride', () => {
  it('override 객체 생성', () => {
    const o = _buildOverride('eval-1', 0.8, 0.6, { taskType: 'fix' }, { now: fixedNow });
    expect(o.evalId).toBe('eval-1');
    expect(o.humanScore).toBe(0.8);
    expect(o.aiScore).toBe(0.6);
    expect(o.delta).toBe(0.2);
    expect(o.context.taskType).toBe('fix');
    expect(o.timestamp).toBe('2026-03-27T00:00:00.000Z');
  });

  it('frozen 객체 반환', () => {
    const o = _buildOverride('e1', 0.5, 0.5, null, { now: fixedNow });
    expect(Object.isFrozen(o)).toBe(true);
  });

  it('context가 null이면 null 유지', () => {
    const o = _buildOverride('e1', 0.5, 0.5, null, { now: fixedNow });
    expect(o.context).toBeNull();
  });

  it('delta는 humanScore - aiScore', () => {
    const o = _buildOverride('e1', 0.3, 0.7, null, { now: fixedNow });
    expect(o.delta).toBe(-0.4);
  });
});

// ---------------------------------------------------------------------------
// Unit: dimensionStats
// ---------------------------------------------------------------------------

describe('eval-calibrator/_dimensionStats', () => {
  it('관련 override가 없으면 count=0, meanDelta=0', () => {
    const stats = _dimensionStats([], 'accuracy');
    expect(stats.count).toBe(0);
    expect(stats.meanDelta).toBe(0);
  });

  it('차원별 humanScore/aiScore 평균 delta 계산', () => {
    const overrides = [
      {
        humanScore: 0.8, aiScore: 0.6, delta: 0.2,
        context: { dimensions: { accuracy: { humanScore: 0.9, aiScore: 0.6 } } },
      },
      {
        humanScore: 0.7, aiScore: 0.5, delta: 0.2,
        context: { dimensions: { accuracy: { humanScore: 0.7, aiScore: 0.5 } } },
      },
    ];
    const stats = _dimensionStats(overrides, 'accuracy');
    expect(stats.count).toBe(2);
    expect(stats.meanDelta).toBe(0.25); // ((0.9-0.6) + (0.7-0.5)) / 2
  });

  it('다른 차원의 데이터는 무시', () => {
    const overrides = [
      {
        humanScore: 0.8, aiScore: 0.6, delta: 0.2,
        context: { dimensions: { completeness: { humanScore: 0.9, aiScore: 0.6 } } },
      },
    ];
    const stats = _dimensionStats(overrides, 'accuracy');
    expect(stats.count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Integration: recordHumanOverride
// ---------------------------------------------------------------------------

describe('eval-calibrator/recordHumanOverride', () => {
  it('override 기록 및 반환', () => {
    const cal = makeCalibrator();
    const entry = cal.recordHumanOverride('eval-1', 0.9, 0.7, { taskType: 'build' });
    expect(entry.evalId).toBe('eval-1');
    expect(entry.delta).toBe(0.2);
  });

  it('FIFO: maxExamples 초과 시 오래된 항목 제거', () => {
    const cal = makeCalibrator({ maxExamples: 3 });
    cal.recordHumanOverride('e1', 0.5, 0.5);
    cal.recordHumanOverride('e2', 0.6, 0.6);
    cal.recordHumanOverride('e3', 0.7, 0.7);
    cal.recordHumanOverride('e4', 0.8, 0.8); // e1 제거

    const overrides = cal.getOverrides();
    expect(overrides).toHaveLength(3);
    expect(overrides[0].evalId).toBe('e2');
    expect(overrides[2].evalId).toBe('e4');
  });

  it('evalId 없으면 에러', () => {
    const cal = makeCalibrator();
    expect(() => cal.recordHumanOverride('', 0.5, 0.5)).toThrow('evalId');
  });

  it('점수가 숫자가 아니면 에러', () => {
    const cal = makeCalibrator();
    expect(() => cal.recordHumanOverride('e1', 'high', 0.5)).toThrow('numbers');
  });

  it('event-bus에 override-recorded 이벤트 발행', () => {
    const cal = makeCalibrator();
    cal.recordHumanOverride('eval-1', 0.8, 0.6);
    const event = getLastEvent('feature:eval-calibration');
    expect(event.action).toBe('override-recorded');
    expect(event.evalId).toBe('eval-1');
  });
});

// ---------------------------------------------------------------------------
// Integration: generateFewShotExamples
// ---------------------------------------------------------------------------

describe('eval-calibrator/generateFewShotExamples', () => {
  it('delta가 큰 순서로 정렬', () => {
    const cal = makeCalibrator();
    cal.recordHumanOverride('e1', 0.5, 0.5);   // delta=0
    cal.recordHumanOverride('e2', 0.9, 0.3);   // delta=0.6
    cal.recordHumanOverride('e3', 0.2, 0.8);   // delta=-0.6
    cal.recordHumanOverride('e4', 0.7, 0.6);   // delta=0.1

    const examples = cal.generateFewShotExamples(3);
    expect(examples).toHaveLength(3);
    // e2와 e3의 |delta|가 가장 큼
    expect(Math.abs(examples[0].delta)).toBeGreaterThanOrEqual(Math.abs(examples[1].delta));
    expect(Math.abs(examples[1].delta)).toBeGreaterThanOrEqual(Math.abs(examples[2].delta));
  });

  it('count보다 적으면 있는 만큼 반환', () => {
    const cal = makeCalibrator();
    cal.recordHumanOverride('e1', 0.5, 0.5);
    const examples = cal.generateFewShotExamples(10);
    expect(examples).toHaveLength(1);
  });

  it('비어있으면 빈 배열', () => {
    const cal = makeCalibrator();
    expect(cal.generateFewShotExamples()).toEqual([]);
  });

  it('반환 객체는 frozen', () => {
    const cal = makeCalibrator();
    cal.recordHumanOverride('e1', 0.8, 0.6);
    const examples = cal.generateFewShotExamples();
    expect(Object.isFrozen(examples[0])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Integration: suggestWeightAdjustment
// ---------------------------------------------------------------------------

describe('eval-calibrator/suggestWeightAdjustment', () => {
  it('데이터 부족 시 빈 suggestions', () => {
    const cal = makeCalibrator();
    cal.recordHumanOverride('e1', 0.8, 0.6, {
      dimensions: { accuracy: { humanScore: 0.9, aiScore: 0.6 } },
    });
    // 3개 미만이면 제안 없음
    const result = cal.suggestWeightAdjustment();
    expect(result.suggestions).toHaveLength(0);
  });

  it('일관된 양의 delta면 increase 제안', () => {
    const cal = makeCalibrator();
    for (let i = 0; i < 5; i++) {
      cal.recordHumanOverride(`e${i}`, 0.9, 0.5, {
        dimensions: { accuracy: { humanScore: 0.9, aiScore: 0.5 } },
      });
    }
    const result = cal.suggestWeightAdjustment();
    const accuracySugg = result.suggestions.find((s) => s.dimension === 'accuracy');
    expect(accuracySugg).toBeDefined();
    expect(accuracySugg.direction).toBe('increase');
    expect(accuracySugg.suggestedWeight).toBeGreaterThan(accuracySugg.currentWeight);
  });

  it('일관된 음의 delta면 decrease 제안', () => {
    const cal = makeCalibrator();
    for (let i = 0; i < 5; i++) {
      cal.recordHumanOverride(`e${i}`, 0.3, 0.8, {
        dimensions: { efficiency: { humanScore: 0.3, aiScore: 0.8 } },
      });
    }
    const result = cal.suggestWeightAdjustment();
    const effSugg = result.suggestions.find((s) => s.dimension === 'efficiency');
    expect(effSugg).toBeDefined();
    expect(effSugg.direction).toBe('decrease');
    expect(effSugg.suggestedWeight).toBeLessThan(effSugg.currentWeight);
  });

  it('작은 delta는 무시 (< 0.05)', () => {
    const cal = makeCalibrator();
    for (let i = 0; i < 5; i++) {
      cal.recordHumanOverride(`e${i}`, 0.52, 0.50, {
        dimensions: { accuracy: { humanScore: 0.52, aiScore: 0.50 } },
      });
    }
    const result = cal.suggestWeightAdjustment();
    const accuracySugg = result.suggestions.find((s) => s.dimension === 'accuracy');
    expect(accuracySugg).toBeUndefined();
  });

  it('overrideCount 포함', () => {
    const cal = makeCalibrator();
    cal.recordHumanOverride('e1', 0.5, 0.5);
    const result = cal.suggestWeightAdjustment();
    expect(result.overrideCount).toBe(1);
  });

  it('event-bus에 weight-adjustment-suggested 이벤트 발행', () => {
    const cal = makeCalibrator();
    for (let i = 0; i < 5; i++) {
      cal.recordHumanOverride(`e${i}`, 0.9, 0.4, {
        dimensions: { accuracy: { humanScore: 0.9, aiScore: 0.4 } },
      });
    }
    cal.suggestWeightAdjustment();
    const event = getLastEvent('feature:eval-calibration');
    expect(event.action).toBe('weight-adjustment-suggested');
  });

  it('suggestedWeight는 [0.05, 0.6] 범위 내', () => {
    const cal = makeCalibrator();
    for (let i = 0; i < 10; i++) {
      cal.recordHumanOverride(`e${i}`, 1.0, 0.0, {
        dimensions: { accuracy: { humanScore: 1.0, aiScore: 0.0 } },
      });
    }
    const result = cal.suggestWeightAdjustment();
    for (const s of result.suggestions) {
      expect(s.suggestedWeight).toBeGreaterThanOrEqual(0.05);
      expect(s.suggestedWeight).toBeLessThanOrEqual(0.6);
    }
  });

  it('confidence는 count/10, 최대 1.0', () => {
    const cal = makeCalibrator();
    for (let i = 0; i < 15; i++) {
      cal.recordHumanOverride(`e${i}`, 0.9, 0.4, {
        dimensions: { accuracy: { humanScore: 0.9, aiScore: 0.4 } },
      });
    }
    const result = cal.suggestWeightAdjustment();
    const s = result.suggestions.find((x) => x.dimension === 'accuracy');
    expect(s.confidence).toBe(1); // 15/10 capped to 1
  });
});

// ---------------------------------------------------------------------------
// Integration: getCalibrationStats
// ---------------------------------------------------------------------------

describe('eval-calibrator/getCalibrationStats', () => {
  it('빈 상태의 통계', () => {
    const cal = makeCalibrator();
    const stats = cal.getCalibrationStats();
    expect(stats.totalOverrides).toBe(0);
    expect(stats.avgDelta).toBe(0);
    expect(stats.avgAbsDelta).toBe(0);
    expect(stats.dimensionCount).toBe(4);
  });

  it('override 추가 후 통계 업데이트', () => {
    const cal = makeCalibrator();
    cal.recordHumanOverride('e1', 0.8, 0.6); // delta=0.2
    cal.recordHumanOverride('e2', 0.4, 0.6); // delta=-0.2
    const stats = cal.getCalibrationStats();
    expect(stats.totalOverrides).toBe(2);
    expect(stats.avgDelta).toBe(0); // 0.2 + (-0.2) / 2
    expect(stats.avgAbsDelta).toBe(0.2); // (0.2 + 0.2) / 2
  });

  it('maxExamples 설정 반영', () => {
    const cal = makeCalibrator({ maxExamples: 10 });
    const stats = cal.getCalibrationStats();
    expect(stats.maxExamples).toBe(10);
  });

  it('frozen 객체 반환', () => {
    const cal = makeCalibrator();
    const stats = cal.getCalibrationStats();
    expect(Object.isFrozen(stats)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Integration: reset
// ---------------------------------------------------------------------------

describe('eval-calibrator/reset', () => {
  it('모든 override 초기화', () => {
    const cal = makeCalibrator();
    cal.recordHumanOverride('e1', 0.8, 0.6);
    cal.recordHumanOverride('e2', 0.7, 0.5);
    cal.reset();
    expect(cal.getOverrides()).toHaveLength(0);
    expect(cal.getCalibrationStats().totalOverrides).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Integration: getOverrides
// ---------------------------------------------------------------------------

describe('eval-calibrator/getOverrides', () => {
  it('frozen 복사본 반환', () => {
    const cal = makeCalibrator();
    cal.recordHumanOverride('e1', 0.8, 0.6);
    const overrides = cal.getOverrides();
    expect(overrides).toHaveLength(1);
    expect(Object.isFrozen(overrides[0])).toBe(true);
  });
});
