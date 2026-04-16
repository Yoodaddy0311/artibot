import { describe, expect, it } from 'vitest';
import {
  runGrpoStage,
  runKnowledgeUpdate,
  runSkillRefinement,
  validateConfig,
} from '../../lib/learning/auto-learning-runner.js';

// ---------------------------------------------------------------------------
// validateConfig
// ---------------------------------------------------------------------------

describe('auto-learning-runner/validateConfig', () => {
  function validConfig(overrides = {}) {
    return {
      enabled: false,
      schedule: '0 3 * * *',
      pipeline: ['self-scan', 'pattern-extract', 'knowledge-update', 'skill-refinement'],
      autoCommit: true,
      autoPush: true,
      maxChangesPerRun: 10,
      dryRun: false,
      ...overrides,
    };
  }

  it('유효한 config → valid=true', () => {
    const result = validateConfig(validConfig());
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('enabled가 boolean 아닌 경우 → 에러', () => {
    const result = validateConfig(validConfig({ enabled: 'yes' }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('enabled'))).toBe(true);
  });

  it('enabled=true → valid', () => {
    const result = validateConfig(validConfig({ enabled: true }));
    expect(result.valid).toBe(true);
  });

  it('maxChangesPerRun가 숫자 아닌 경우 → 에러', () => {
    const result = validateConfig(validConfig({ maxChangesPerRun: 'many' }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('maxChangesPerRun'))).toBe(true);
  });

  it('maxChangesPerRun < 1 → 에러', () => {
    const result = validateConfig(validConfig({ maxChangesPerRun: 0 }));
    expect(result.valid).toBe(false);

    const result2 = validateConfig(validConfig({ maxChangesPerRun: -5 }));
    expect(result2.valid).toBe(false);
  });

  it('maxChangesPerRun=1 → valid', () => {
    const result = validateConfig(validConfig({ maxChangesPerRun: 1 }));
    expect(result.valid).toBe(true);
  });

  it('pipeline이 배열 아닌 경우 → 에러', () => {
    const result = validateConfig(validConfig({ pipeline: 'self-scan' }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('pipeline'))).toBe(true);
  });

  it('pipeline에 유효하지 않은 스테이지 → 에러', () => {
    const result = validateConfig(validConfig({ pipeline: ['self-scan', 'invalid-stage'] }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('invalid-stage'))).toBe(true);
  });

  it('빈 pipeline → valid (스테이지 없어도 됨)', () => {
    const result = validateConfig(validConfig({ pipeline: [] }));
    expect(result.valid).toBe(true);
  });

  it('단일 스테이지 pipeline → valid', () => {
    const result = validateConfig(validConfig({ pipeline: ['self-scan'] }));
    expect(result.valid).toBe(true);
  });

  it('다중 에러 누적', () => {
    const result = validateConfig({
      enabled: 'yes',
      maxChangesPerRun: 'many',
      pipeline: 'invalid',
    });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(3);
  });

  it('반환 구조: valid, errors', () => {
    const result = validateConfig(validConfig());
    expect(result).toHaveProperty('valid');
    expect(result).toHaveProperty('errors');
    expect(Array.isArray(result.errors)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// runKnowledgeUpdate (dryRun)
// ---------------------------------------------------------------------------

describe('auto-learning-runner/runKnowledgeUpdate', () => {
  it('dryRun=true → 즉시 반환 (I/O 없음)', async () => {
    const report = await runKnowledgeUpdate({}, {}, { dryRun: true });
    expect(report.stage).toBe('knowledge-update');
    expect(report.dryRun).toBe(true);
    expect(report.patternsSaved).toBe(0);
    expect(report.promoted).toBe(0);
    expect(report.demoted).toBe(0);
  });

  it('dryRun 리포트에 timestamp 포함', async () => {
    const report = await runKnowledgeUpdate({}, {}, { dryRun: true });
    expect(report.timestamp).toBeDefined();
    expect(report.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('dryRun=true → driftChecked=false', async () => {
    const report = await runKnowledgeUpdate(null, null, { dryRun: true });
    expect(report.driftChecked).toBe(false);
  });

  it('빈 입력도 dryRun 안전', async () => {
    const report = await runKnowledgeUpdate(null, null, { dryRun: true });
    expect(report.stage).toBe('knowledge-update');
    expect(report.dryRun).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// runSkillRefinement (dryRun)
// ---------------------------------------------------------------------------

describe('auto-learning-runner/runSkillRefinement', () => {
  it('dryRun=true → 즉시 반환', async () => {
    const report = await runSkillRefinement({}, { dryRun: true });
    expect(report.stage).toBe('skill-refinement');
    expect(report.dryRun).toBe(true);
    expect(report.skillsAnalyzed).toBe(0);
    expect(report.suggestionsGenerated).toBe(0);
    expect(report.injectionsApplied).toBe(0);
  });

  it('dryRun 리포트에 timestamp 포함', async () => {
    const report = await runSkillRefinement(null, { dryRun: true });
    expect(report.timestamp).toBeDefined();
  });

  it('빈 patternReport dryRun 안전', async () => {
    const report = await runSkillRefinement(null, { dryRun: true });
    expect(report.stage).toBe('skill-refinement');
    expect(report.dryRun).toBe(true);
  });

  it('반환 구조 검증', async () => {
    const report = await runSkillRefinement({}, { dryRun: true });
    expect(report).toHaveProperty('stage');
    expect(report).toHaveProperty('timestamp');
    expect(report).toHaveProperty('skillsAnalyzed');
    expect(report).toHaveProperty('suggestionsGenerated');
    expect(report).toHaveProperty('injectionsApplied');
  });
});

// ---------------------------------------------------------------------------
// runGrpoStage — pipeline stage feeding extracted patterns into GRPO.
// Covers safety contract (skip on insufficient data), success shape, and
// resilience to malformed inputs. GRPO internals are covered in
// grpo-optimizer.test.js; these tests validate the runner's integration.
// ---------------------------------------------------------------------------

function _makePatternExtract(patterns) {
  return { patterns };
}

function _validSelfScan(overrides = {}) {
  return {
    lintErrors: 0,
    testsPassed: true,
    ...overrides,
  };
}

describe('runGrpoStage/skip conditions', () => {
  it('patternExtract가 null이면 skip', async () => {
    const result = await runGrpoStage(null, _validSelfScan());
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('insufficient-patterns');
    expect(result.got).toBe(0);
  });

  it('patterns 배열 없음 → skip', async () => {
    const result = await runGrpoStage({}, _validSelfScan());
    expect(result.skipped).toBe(true);
    expect(result.got).toBe(0);
  });

  it('patterns가 배열이 아님 → skip', async () => {
    const result = await runGrpoStage({ patterns: 'not-array' }, _validSelfScan());
    expect(result.skipped).toBe(true);
    expect(result.got).toBe(0);
  });

  it('patterns 1개 → skip (GRPO는 최소 2개 그룹 필요)', async () => {
    const pe = _makePatternExtract([{ type: 'fix', subject: 'only one' }]);
    const result = await runGrpoStage(pe, _validSelfScan());
    expect(result.skipped).toBe(true);
    expect(result.minimumNeeded).toBe(2);
    expect(result.got).toBe(1);
  });

  it('patterns 0개 → skip', async () => {
    const result = await runGrpoStage(_makePatternExtract([]), _validSelfScan());
    expect(result.skipped).toBe(true);
    expect(result.got).toBe(0);
  });
});

describe('runGrpoStage/success shape', () => {
  it('patterns 2개 + 정상 scan → GRPO round 실행, 결과 반환', async () => {
    const pe = _makePatternExtract([
      { type: 'fix', subject: 'fix(lint): preserve caught error' },
      { type: 'chore', subject: 'chore: session close' },
    ]);
    const result = await runGrpoStage(pe, _validSelfScan());

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
    const pe = _makePatternExtract([
      { type: 'fix', subject: 'a' },
      { type: 'refactor', subject: 'b' },
    ]);
    const result = await runGrpoStage(pe, _validSelfScan({ lintErrors: 3, testsPassed: false }));

    expect(result.candidateCount).toBe(2);
    expect(result.bestStrategy).toBeTruthy();
  });

  it('selfScan이 null이어도 crash 없이 실행', async () => {
    const pe = _makePatternExtract([
      { type: 'fix', subject: 'a' },
      { type: 'feat', subject: 'b' },
    ]);
    const result = await runGrpoStage(pe, null);

    expect(result.candidateCount).toBe(2);
    expect(result.error).toBeUndefined();
  });

  it('pattern에 type이 없거나 문자열 아님 → "default" 전략으로 대체', async () => {
    const pe = _makePatternExtract([
      { subject: 'no type' },
      { type: 123, subject: 'numeric type' },
    ]);
    const result = await runGrpoStage(pe, _validSelfScan());

    expect(result.skipped).toBeUndefined();
    expect(result.candidateCount).toBe(2);
    expect(typeof result.bestStrategy).toBe('string');
  });

  it('pattern에 subject 없음 → commandLength=0으로 처리, crash 없음', async () => {
    const pe = _makePatternExtract([
      { type: 'fix' },
      { type: 'chore' },
    ]);
    const result = await runGrpoStage(pe, _validSelfScan());

    expect(result.error).toBeUndefined();
    expect(result.candidateCount).toBe(2);
  });
});

describe('runGrpoStage/resilience', () => {
  it('patterns 다수 (5개) → 모두 candidate로 변환', async () => {
    const pe = _makePatternExtract([
      { type: 'fix', subject: 'a' },
      { type: 'feat', subject: 'b' },
      { type: 'chore', subject: 'c' },
      { type: 'refactor', subject: 'd' },
      { type: 'docs', subject: 'e' },
    ]);
    const result = await runGrpoStage(pe, _validSelfScan());

    expect(result.candidateCount).toBe(5);
    expect(result.spread).toBeGreaterThanOrEqual(0);
  });

  it('결과의 bestScore는 소수점 3자리로 반올림', async () => {
    const pe = _makePatternExtract([
      { type: 'fix', subject: 'a' },
      { type: 'feat', subject: 'b' },
    ]);
    const result = await runGrpoStage(pe, _validSelfScan());

    if (typeof result.bestScore === 'number') {
      const decimals = (result.bestScore.toString().split('.')[1] ?? '').length;
      expect(decimals).toBeLessThanOrEqual(3);
    }
  });
});
