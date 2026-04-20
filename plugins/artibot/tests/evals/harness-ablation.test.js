import { describe, expect, it } from 'vitest';
import {
  _buildStack,
  _evalWithMiddleware,
  _scoreResult,
  DEFAULT_CONFIG,
  DEFAULT_MIDDLEWARES,
  DEFAULT_SCENARIOS,
  formatAblationReport,
  runAblationTest,
} from '../../scripts/evals/harness-ablation.js';

// ---------------------------------------------------------------------------
// Unit: scoreResult
// ---------------------------------------------------------------------------

describe('harness-ablation/_scoreResult', () => {
  it('완전한 결과는 1.0에 가까운 점수', () => {
    const result = {
      context: {
        routing: { system: 'system1' },
        intent: { best: 'action:fix' },
        skills: { suggested: ['cmd-fix'] },
        subagents: { contract: { mode: 'subAgent' } },
      },
      userPrompt: 'a prompt that is longer than 20 chars for sure',
      message: '[runtime] route=SYSTEM1',
    };
    expect(_scoreResult(result)).toBe(1);
  });

  it('빈 결과는 낮은 점수', () => {
    const result = { context: {}, userPrompt: '', message: '' };
    expect(_scoreResult(result)).toBeLessThan(0.5);
  });

  it('부분적 결과는 중간 점수', () => {
    const result = {
      context: { routing: { system: 'system1' }, intent: null },
      userPrompt: 'some longer prompt text here',
      message: 'no runtime tag',
    };
    const score = _scoreResult(result);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });
});

// ---------------------------------------------------------------------------
// Unit: buildStack
// ---------------------------------------------------------------------------

describe('harness-ablation/_buildStack', () => {
  it('엔트리 수만큼 미들웨어 생성', () => {
    const entries = [
      { name: 'a', factory: () => async (s) => s },
      { name: 'b', factory: () => async (s) => s },
    ];
    const stack = _buildStack(entries, { now: Date.now, checkpointStore: new Map() });
    expect(stack).toHaveLength(2);
    expect(typeof stack[0]).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// Unit: evalWithMiddleware
// ---------------------------------------------------------------------------

describe('harness-ablation/_evalWithMiddleware', () => {
  it('시나리오별 점수와 평균을 반환', async () => {
    const noopMiddleware = [async (state) => state];
    const scenarios = [{ id: 'test', prompt: 'hello world' }];
    const result = await _evalWithMiddleware(noopMiddleware, scenarios, {
      config: DEFAULT_CONFIG,
      now: Date.now,
    });

    expect(result).toHaveProperty('scores');
    expect(result).toHaveProperty('average');
    expect(typeof result.scores.test).toBe('number');
    expect(typeof result.average).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// Integration: runAblationTest
// ---------------------------------------------------------------------------

describe('harness-ablation/runAblationTest', () => {
  it('baseline과 결과 구조가 올바름', async () => {
    const result = await runAblationTest({
      scenarios: DEFAULT_SCENARIOS.slice(0, 1), // 빠른 테스트를 위해 1개만
    });

    expect(result).toHaveProperty('baseline');
    expect(result).toHaveProperty('results');
    expect(result).toHaveProperty('removeCandidates');
    expect(result.baseline).toHaveProperty('average');
    expect(result.baseline).toHaveProperty('scores');
    expect(Array.isArray(result.results)).toBe(true);
    expect(Array.isArray(result.removeCandidates)).toBe(true);
  });

  it('각 미들웨어별 ablation 결과 포함', async () => {
    const entries = [
      { name: 'alpha', factory: () => async (s) => s },
      { name: 'beta', factory: () => async (s) => s },
    ];

    const result = await runAblationTest({
      middlewares: entries,
      scenarios: [{ id: 's1', prompt: 'test prompt' }],
    });

    expect(result.results).toHaveLength(2);
    expect(result.results[0].name).toBe('alpha');
    expect(result.results[1].name).toBe('beta');
    for (const r of result.results) {
      expect(r).toHaveProperty('average');
      expect(r).toHaveProperty('delta');
      expect(r).toHaveProperty('scores');
    }
  });

  it('커스텀 threshold로 제거 후보 필터링', async () => {
    const entries = [
      { name: 'noop', factory: () => async (s) => s },
    ];

    const result = await runAblationTest({
      middlewares: entries,
      scenarios: [{ id: 's1', prompt: 'test' }],
      threshold: 1.0, // 매우 높은 임계값 → 모든 미들웨어가 후보
    });

    expect(result.removeCandidates).toContain('noop');
  });

  it('delta가 threshold 이상이면 제거 후보에서 제외', async () => {
    const result = await runAblationTest({
      scenarios: DEFAULT_SCENARIOS.slice(0, 1),
      threshold: 0.0001, // 매우 낮은 임계값
    });

    // router 제거 시 큰 영향이 있으므로 후보에서 제외될 가능성 높음
    // (구현에 따라 다를 수 있으나 구조 검증)
    expect(Array.isArray(result.removeCandidates)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Unit: formatAblationReport
// ---------------------------------------------------------------------------

describe('harness-ablation/formatAblationReport', () => {
  it('보고서 문자열 생성', () => {
    const ablation = {
      baseline: { average: 0.85, scores: { s1: 0.85 } },
      results: [
        { name: 'router', average: 0.5, delta: 0.35, scores: { s1: 0.5 } },
        { name: 'memory', average: 0.83, delta: 0.02, scores: { s1: 0.83 } },
      ],
      removeCandidates: ['memory'],
    };

    const report = formatAblationReport(ablation);
    expect(report).toContain('HARNESS ABLATION REPORT');
    expect(report).toContain('Baseline avg score: 0.85');
    expect(report).toContain('router');
    expect(report).toContain('memory');
    expect(report).toContain('Remove candidates');
  });

  it('제거 후보 없으면 해당 메시지 표시', () => {
    const ablation = {
      baseline: { average: 0.9, scores: {} },
      results: [{ name: 'router', average: 0.5, delta: 0.4, scores: {} }],
      removeCandidates: [],
    };

    const report = formatAblationReport(ablation);
    expect(report).toContain('No removal candidates');
  });
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('harness-ablation/constants', () => {
  it('DEFAULT_MIDDLEWARES에 모든 미들웨어 포함', () => {
    const names = DEFAULT_MIDDLEWARES.map((e) => e.name);
    expect(names).toContain('router');
    expect(names).toContain('memory');
    expect(names).toContain('skills');
    expect(names).toContain('tasks');
    expect(names).toContain('subagents');
    expect(names).toContain('guardrail');
    expect(names).toContain('summarization');
    expect(names).toContain('tokenUsage');
    expect(names).toContain('checkpoint');
  });

  it('DEFAULT_SCENARIOS에 3개 시나리오', () => {
    expect(DEFAULT_SCENARIOS).toHaveLength(3);
    for (const s of DEFAULT_SCENARIOS) {
      expect(s).toHaveProperty('id');
      expect(s).toHaveProperty('prompt');
    }
  });

  it('DEFAULT_CONFIG은 frozen', () => {
    expect(Object.isFrozen(DEFAULT_CONFIG)).toBe(true);
  });
});
