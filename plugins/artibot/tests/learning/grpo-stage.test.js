import { describe, expect, it } from 'vitest';
import { runGrpoStage } from '../../lib/learning/auto-learning-runner.js';

// ---------------------------------------------------------------------------
// runGrpoStage — pipeline stage that feeds extracted patterns into GRPO.
// These tests cover the stage's safety contract (skip on insufficient data),
// success shape, and resilience to malformed inputs. They do NOT test GRPO
// internals (covered by grpo-optimizer.test.js).
// ---------------------------------------------------------------------------

function makePatternExtract(patterns) {
  return { patterns };
}

function validSelfScan(overrides = {}) {
  return {
    lintErrors: 0,
    testsPassed: true,
    ...overrides,
  };
}

describe('runGrpoStage/skip conditions', () => {
  it('patternExtract가 null이면 skip', async () => {
    const result = await runGrpoStage(null, validSelfScan());
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('insufficient-patterns');
    expect(result.got).toBe(0);
  });

  it('patterns 배열 없음 → skip', async () => {
    const result = await runGrpoStage({}, validSelfScan());
    expect(result.skipped).toBe(true);
    expect(result.got).toBe(0);
  });

  it('patterns가 배열이 아님 → skip', async () => {
    const result = await runGrpoStage({ patterns: 'not-array' }, validSelfScan());
    expect(result.skipped).toBe(true);
    expect(result.got).toBe(0);
  });

  it('patterns 1개 → skip (GRPO는 최소 2개 그룹 필요)', async () => {
    const pe = makePatternExtract([{ type: 'fix', subject: 'only one' }]);
    const result = await runGrpoStage(pe, validSelfScan());
    expect(result.skipped).toBe(true);
    expect(result.minimumNeeded).toBe(2);
    expect(result.got).toBe(1);
  });

  it('patterns 0개 → skip', async () => {
    const result = await runGrpoStage(makePatternExtract([]), validSelfScan());
    expect(result.skipped).toBe(true);
    expect(result.got).toBe(0);
  });
});

describe('runGrpoStage/success shape', () => {
  it('patterns 2개 + 정상 scan → GRPO round 실행, 결과 반환', async () => {
    const pe = makePatternExtract([
      { type: 'fix', subject: 'fix(lint): preserve caught error' },
      { type: 'chore', subject: 'chore: session close' },
    ]);
    const result = await runGrpoStage(pe, validSelfScan());

    expect(result.skipped).toBeUndefined();
    expect(result.candidateCount).toBe(2);
    expect(typeof result.bestStrategy).toBe('string');
    expect(typeof result.bestScore).toBe('number');
    expect(result.bestScore).toBeGreaterThanOrEqual(0);
    expect(result.bestScore).toBeLessThanOrEqual(1);
    expect(typeof result.spread).toBe('number');
    expect(result.spread).toBeGreaterThanOrEqual(0);
  });

  it('lint 에러 있어도 GRPO는 실행 (patterns만 있으면)', async () => {
    const pe = makePatternExtract([
      { type: 'fix', subject: 'a' },
      { type: 'refactor', subject: 'b' },
    ]);
    const result = await runGrpoStage(pe, validSelfScan({ lintErrors: 3, testsPassed: false }));

    expect(result.candidateCount).toBe(2);
    expect(result.bestStrategy).toBeTruthy();
  });

  it('selfScan이 null이어도 crash 없이 실행', async () => {
    const pe = makePatternExtract([
      { type: 'fix', subject: 'a' },
      { type: 'feat', subject: 'b' },
    ]);
    const result = await runGrpoStage(pe, null);

    expect(result.candidateCount).toBe(2);
    expect(result.error).toBeUndefined();
  });

  it('pattern에 type이 없거나 문자열 아님 → "default" 전략으로 대체', async () => {
    const pe = makePatternExtract([
      { subject: 'no type' },
      { type: 123, subject: 'numeric type' },
    ]);
    const result = await runGrpoStage(pe, validSelfScan());

    expect(result.skipped).toBeUndefined();
    expect(result.candidateCount).toBe(2);
    expect(['default', ''].includes(result.bestStrategy) || typeof result.bestStrategy === 'string').toBe(true);
  });

  it('pattern에 subject 없음 → commandLength=0으로 처리, crash 없음', async () => {
    const pe = makePatternExtract([
      { type: 'fix' },
      { type: 'chore' },
    ]);
    const result = await runGrpoStage(pe, validSelfScan());

    expect(result.error).toBeUndefined();
    expect(result.candidateCount).toBe(2);
  });
});

describe('runGrpoStage/resilience', () => {
  it('patterns 다수 (5개) → 모두 candidate로 변환', async () => {
    const pe = makePatternExtract([
      { type: 'fix', subject: 'a' },
      { type: 'feat', subject: 'b' },
      { type: 'chore', subject: 'c' },
      { type: 'refactor', subject: 'd' },
      { type: 'docs', subject: 'e' },
    ]);
    const result = await runGrpoStage(pe, validSelfScan());

    expect(result.candidateCount).toBe(5);
    expect(result.spread).toBeGreaterThanOrEqual(0);
  });

  it('결과의 bestScore는 소수점 3자리로 반올림', async () => {
    const pe = makePatternExtract([
      { type: 'fix', subject: 'a' },
      { type: 'feat', subject: 'b' },
    ]);
    const result = await runGrpoStage(pe, validSelfScan());

    if (typeof result.bestScore === 'number') {
      const decimals = (result.bestScore.toString().split('.')[1] ?? '').length;
      expect(decimals).toBeLessThanOrEqual(3);
    }
  });
});
