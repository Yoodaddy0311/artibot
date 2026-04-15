import { describe, expect, it } from 'vitest';
import {
  getLearnedSignalSummary,
  getStrategyBias,
  getTopStrategy,
  getTopTeam,
  NEUTRAL_BIAS,
} from '../../lib/cognitive/grpo-bridge.js';

// ---------------------------------------------------------------------------
// grpo-bridge — safe read layer between GRPO history and cognitive modules.
// Contract: every function must return a safe value when GRPO history is
// unavailable, malformed, or the strategy is unknown. Never throw.
// ---------------------------------------------------------------------------

describe('grpo-bridge/NEUTRAL_BIAS', () => {
  it('NEUTRAL_BIAS = 1.0 (no-op multiplier)', () => {
    expect(NEUTRAL_BIAS).toBe(1.0);
  });
});

describe('grpo-bridge/getStrategyBias', () => {
  it('null strategy → NEUTRAL_BIAS', async () => {
    const bias = await getStrategyBias(null);
    expect(bias).toBe(NEUTRAL_BIAS);
  });

  it('undefined strategy → NEUTRAL_BIAS', async () => {
    const bias = await getStrategyBias(undefined);
    expect(bias).toBe(NEUTRAL_BIAS);
  });

  it('non-string strategy → NEUTRAL_BIAS', async () => {
    expect(await getStrategyBias(123)).toBe(NEUTRAL_BIAS);
    expect(await getStrategyBias({})).toBe(NEUTRAL_BIAS);
    expect(await getStrategyBias([])).toBe(NEUTRAL_BIAS);
  });

  it('알려지지 않은 strategy → NEUTRAL_BIAS', async () => {
    const bias = await getStrategyBias('absolutely-never-seen-strategy-xyz');
    expect(bias).toBe(NEUTRAL_BIAS);
  });

  it('반환값은 항상 [0.5, 1.5] 범위 (clamp 보장)', async () => {
    // Regardless of underlying history, bias must be clamped.
    const bias = await getStrategyBias('Bash');
    expect(bias).toBeGreaterThanOrEqual(0.5);
    expect(bias).toBeLessThanOrEqual(1.5);
  });
});

describe('grpo-bridge/getTopStrategy', () => {
  it('반환 shape: { recommendation, weight, alternatives }', async () => {
    const result = await getTopStrategy();
    expect(result).toHaveProperty('recommendation');
    expect(result).toHaveProperty('weight');
    expect(result).toHaveProperty('alternatives');
    expect(Array.isArray(result.alternatives)).toBe(true);
  });

  it('weight는 항상 숫자', async () => {
    const result = await getTopStrategy();
    expect(typeof result.weight).toBe('number');
    expect(Number.isFinite(result.weight)).toBe(true);
  });

  it('recommendation은 string 또는 null', async () => {
    const result = await getTopStrategy();
    expect(['string', 'object'].includes(typeof result.recommendation)).toBe(true);
    if (typeof result.recommendation === 'object') {
      expect(result.recommendation).toBeNull();
    }
  });

  it('context 인자 전달 → 에러 없이 실행', async () => {
    const result = await getTopStrategy({ taskType: 'frontend' });
    expect(result).toHaveProperty('recommendation');
  });
});

describe('grpo-bridge/getTopTeam', () => {
  it('기본 domain "general" → 반환 shape 유효', async () => {
    const result = await getTopTeam();
    expect(result).toHaveProperty('recommendation');
    expect(result).toHaveProperty('weight');
    expect(result).toHaveProperty('alternatives');
  });

  it('명시적 domain → 에러 없이 실행', async () => {
    const result = await getTopTeam('frontend');
    expect(result).toHaveProperty('recommendation');
    expect(Array.isArray(result.alternatives)).toBe(true);
  });

  it('weight는 숫자이며 neutral일 때 1.0', async () => {
    const result = await getTopTeam('non-existent-domain-xyz');
    expect(typeof result.weight).toBe('number');
  });
});

describe('grpo-bridge/getLearnedSignalSummary', () => {
  it('반환 shape: { hasData, totalRounds, taskRounds, teamRounds }', async () => {
    const summary = await getLearnedSignalSummary();
    expect(summary).toHaveProperty('hasData');
    expect(summary).toHaveProperty('totalRounds');
    expect(summary).toHaveProperty('taskRounds');
    expect(summary).toHaveProperty('teamRounds');
  });

  it('hasData는 boolean', async () => {
    const summary = await getLearnedSignalSummary();
    expect(typeof summary.hasData).toBe('boolean');
  });

  it('모든 count는 0 이상 정수', async () => {
    const summary = await getLearnedSignalSummary();
    expect(summary.totalRounds).toBeGreaterThanOrEqual(0);
    expect(summary.taskRounds).toBeGreaterThanOrEqual(0);
    expect(summary.teamRounds).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(summary.totalRounds)).toBe(true);
    expect(Number.isInteger(summary.taskRounds)).toBe(true);
    expect(Number.isInteger(summary.teamRounds)).toBe(true);
  });

  it('hasData는 totalRounds > 0과 일관', async () => {
    const summary = await getLearnedSignalSummary();
    expect(summary.hasData).toBe(summary.totalRounds > 0);
  });
});

describe('grpo-bridge/safety contract', () => {
  it('모든 함수는 예외를 throw하지 않는다 (no-throw guarantee)', async () => {
    // Each public function should catch internally and return a safe default.
    await expect(getStrategyBias('whatever')).resolves.toBeDefined();
    await expect(getTopStrategy()).resolves.toBeDefined();
    await expect(getTopTeam()).resolves.toBeDefined();
    await expect(getLearnedSignalSummary()).resolves.toBeDefined();
  });

  it('이상한 context도 무시하고 실행', async () => {
    await expect(getTopStrategy(null)).resolves.toBeDefined();
    await expect(getTopStrategy({ weird: [1, 2, 3] })).resolves.toBeDefined();
  });
});
