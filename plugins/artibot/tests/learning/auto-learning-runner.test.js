import { describe, expect, it } from 'vitest';
import {
  validateConfig,
  runKnowledgeUpdate,
  runSkillRefinement,
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
