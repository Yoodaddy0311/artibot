import { describe, expect, it } from 'vitest';
import {
  AUTO_COMMIT_ALLOWLIST,
  AUTO_COMMIT_DENYLIST,
  buildAutoCommitMessage,
  formatGuardrailReason,
  isAutoCommitAllowed,
  matchGlob,
} from '../../lib/learning/auto-learning-committer.js';

// ---------------------------------------------------------------------------
// matchGlob
// ---------------------------------------------------------------------------

describe('auto-learning-committer/matchGlob', () => {
  it('정확한 파일 이름 매칭', () => {
    expect(matchGlob('learning-log.json', 'learning-log.json')).toBe(true);
  });

  it('이름 불일치 → false', () => {
    expect(matchGlob('package.json', 'learning-log.json')).toBe(false);
  });

  it('** 패턴 — 깊은 경로 매칭', () => {
    expect(matchGlob('lib/learning/memory.js', 'lib/learning/**')).toBe(true);
    expect(matchGlob('lib/learning/sub/deep.js', 'lib/learning/**')).toBe(true);
  });

  it('** 패턴 — 직접 자식도 매칭', () => {
    expect(matchGlob('lib/learning/file.js', 'lib/learning/**')).toBe(true);
  });

  it('** 패턴 — 다른 디렉터리 불일치', () => {
    expect(matchGlob('lib/core/file.js', 'lib/learning/**')).toBe(false);
  });

  it('* 패턴 — 단일 세그먼트 매칭', () => {
    expect(matchGlob('skills/tdd/references/doc.md', 'skills/*/references/**')).toBe(true);
  });

  it('* 패턴 — 다중 세그먼트는 매칭 안됨', () => {
    expect(matchGlob('skills/a/b/references/doc.md', 'skills/*/references/**')).toBe(false);
  });

  it('백슬래시 경로 정규화', () => {
    expect(matchGlob('lib\\learning\\file.js', 'lib/learning/**')).toBe(true);
  });

  it('.artibot/** 패턴', () => {
    expect(matchGlob('.artibot/cache/data.json', '.artibot/**')).toBe(true);
  });

  it('patterns/** 패턴', () => {
    expect(matchGlob('patterns/auto-learn-2026-03-25.json', 'patterns/**')).toBe(true);
  });

  it('빈 경로', () => {
    expect(matchGlob('', 'lib/**')).toBe(false);
  });

  it('** 만으로는 빈 패턴 부분에 매칭', () => {
    expect(matchGlob('any/file.js', '**')).toBe(true);
    expect(matchGlob('file.js', '**')).toBe(true);
  });

  it('여러 ** 세그먼트', () => {
    expect(matchGlob('a/b/c/d/e.js', '**/c/**')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isAutoCommitAllowed
// ---------------------------------------------------------------------------

describe('auto-learning-committer/isAutoCommitAllowed', () => {
  it('allowlist에 있는 learning 파일 → allowed', () => {
    const result = isAutoCommitAllowed('lib/learning/memory.js');
    expect(result.allowed).toBe(true);
    expect(result.reason).toContain('allowed');
  });

  it('denylist에 있는 core 파일 → denied', () => {
    const result = isAutoCommitAllowed('lib/core/index.js');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('denied');
  });

  it('denylist가 allowlist보다 우선', () => {
    // skills/*/SKILL.md is denied, even though skills/*/references/** is allowed
    const result = isAutoCommitAllowed('skills/tdd/SKILL.md');
    expect(result.allowed).toBe(false);
  });

  it('allowlist/denylist 어디에도 없는 파일 → not in allowlist', () => {
    const result = isAutoCommitAllowed('random/unknown/file.txt');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('not in allowlist');
  });

  it('artibot.config.json → denied', () => {
    const result = isAutoCommitAllowed('artibot.config.json');
    expect(result.allowed).toBe(false);
  });

  it('package.json → denied', () => {
    const result = isAutoCommitAllowed('package.json');
    expect(result.allowed).toBe(false);
  });

  it('learning-log.json → allowed (정확한 파일명)', () => {
    const result = isAutoCommitAllowed('learning-log.json');
    expect(result.allowed).toBe(true);
  });

  it('patterns/ 하위 → allowed', () => {
    const result = isAutoCommitAllowed('patterns/auto-learn-2026-03-25.json');
    expect(result.allowed).toBe(true);
  });

  it('tests/ 하위 → denied', () => {
    const result = isAutoCommitAllowed('tests/learning/test.js');
    expect(result.allowed).toBe(false);
  });

  it('agents/ → denied', () => {
    const result = isAutoCommitAllowed('agents/orchestrator.md');
    expect(result.allowed).toBe(false);
  });

  it('커스텀 allowlist/denylist 오버라이드', () => {
    const result = isAutoCommitAllowed('custom/file.txt', ['custom/**'], []);
    expect(result.allowed).toBe(true);

    const result2 = isAutoCommitAllowed('custom/file.txt', [], ['custom/**']);
    expect(result2.allowed).toBe(false);
  });

  it('커스텀 denylist가 커스텀 allowlist 우선', () => {
    const result = isAutoCommitAllowed('shared/file.txt', ['shared/**'], ['shared/**']);
    expect(result.allowed).toBe(false);
  });

  it('백슬래시 경로 정규화', () => {
    const result = isAutoCommitAllowed('lib\\learning\\file.js');
    expect(result.allowed).toBe(true);
  });

  it('skills references → allowed', () => {
    const result = isAutoCommitAllowed('skills/coding-standards/references/patterns.json');
    expect(result.allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildAutoCommitMessage
// ---------------------------------------------------------------------------

describe('auto-learning-committer/buildAutoCommitMessage', () => {
  const basePipelineResult = {
    stagesRun: ['self-scan', 'pattern-extract', 'knowledge-update'],
    timestamp: '2026-03-25T03:00:00.000Z',
  };

  const baseProvenance = {
    machineHash: 'abc12345',
    pipelineVersion: '1.15.0',
    projectName: 'Artibot',
  };

  it('[AUTOMATED] 태그 포함', () => {
    const msg = buildAutoCommitMessage(basePipelineResult, 5, 3, baseProvenance);
    expect(msg).toContain('[AUTOMATED]');
  });

  it('chore(auto-learning) prefix', () => {
    const msg = buildAutoCommitMessage(basePipelineResult, 5, 3, baseProvenance);
    expect(msg).toContain('chore(auto-learning)');
  });

  it('스테이지 목록 포함', () => {
    const msg = buildAutoCommitMessage(basePipelineResult, 5, 3, baseProvenance);
    expect(msg).toContain('self-scan, pattern-extract, knowledge-update');
  });

  it('파일 수 포함', () => {
    const msg = buildAutoCommitMessage(basePipelineResult, 5, 3, baseProvenance);
    expect(msg).toContain('5 allowed');
    expect(msg).toContain('3 blocked');
  });

  it('provenance 정보 포함', () => {
    const msg = buildAutoCommitMessage(basePipelineResult, 1, 0, baseProvenance);
    expect(msg).toContain('Artibot@abc12345');
    expect(msg).toContain('v1.15.0');
  });

  it('provenance 없을 때 fallback', () => {
    const msg = buildAutoCommitMessage(basePipelineResult, 1, 0, null);
    expect(msg).toContain('unknown');
    expect(msg).toContain('v1.15.0');
  });

  it('stagesRun 없으면 "all"', () => {
    const msg = buildAutoCommitMessage({}, 1, 0, baseProvenance);
    expect(msg).toContain('Stages: all');
  });

  it('날짜 형식 YYYY-MM-DD', () => {
    const msg = buildAutoCommitMessage(basePipelineResult, 1, 0, baseProvenance);
    expect(msg).toMatch(/\d{4}-\d{2}-\d{2}/);
  });
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('auto-learning-committer/constants', () => {
  it('AUTO_COMMIT_ALLOWLIST는 frozen', () => {
    expect(Object.isFrozen(AUTO_COMMIT_ALLOWLIST)).toBe(true);
  });

  it('AUTO_COMMIT_DENYLIST는 frozen', () => {
    expect(Object.isFrozen(AUTO_COMMIT_DENYLIST)).toBe(true);
  });

  it('ALLOWLIST에 learning 경로 포함', () => {
    expect(AUTO_COMMIT_ALLOWLIST).toContain('lib/learning/**');
    expect(AUTO_COMMIT_ALLOWLIST).toContain('learning-log.json');
    expect(AUTO_COMMIT_ALLOWLIST).toContain('patterns/**');
  });

  it('DENYLIST에 중요 파일 포함', () => {
    expect(AUTO_COMMIT_DENYLIST).toContain('package.json');
    expect(AUTO_COMMIT_DENYLIST).toContain('artibot.config.json');
    expect(AUTO_COMMIT_DENYLIST).toContain('CLAUDE.md');
    expect(AUTO_COMMIT_DENYLIST).toContain('tests/**');
  });

  it('DENYLIST에 소스코드 디렉터리 포함', () => {
    expect(AUTO_COMMIT_DENYLIST).toContain('lib/runtime/**');
    expect(AUTO_COMMIT_DENYLIST).toContain('lib/core/**');
    expect(AUTO_COMMIT_DENYLIST).toContain('agents/**');
    expect(AUTO_COMMIT_DENYLIST).toContain('commands/**');
  });
});

// ---------------------------------------------------------------------------
// formatGuardrailReason — pure helper extracted from runAutoCommit (R3).
// Surfaces blocked file names so users can debug auto-commit skips without
// reading raw hook logs.
// ---------------------------------------------------------------------------

describe('auto-learning-committer/formatGuardrailReason', () => {
  it('blocked가 비어있으면 "no changes to commit"', () => {
    expect(formatGuardrailReason(0, [])).toBe('no changes to commit');
  });

  it('blocked가 null이어도 안전 (배열 처리)', () => {
    expect(formatGuardrailReason(0, null)).toBe('no changes to commit');
  });

  it('blocked가 undefined여도 안전', () => {
    expect(formatGuardrailReason(5, undefined)).toBe('no changes to commit');
  });

  it('blocked 1개 → 파일 이름 노출', () => {
    const r = formatGuardrailReason(1, ['lib/core/secret.js']);
    expect(r).toContain('all 1 changes blocked by guardrail');
    expect(r).toContain('lib/core/secret.js');
    expect(r).not.toContain('+');
  });

  it('blocked 3개 → 모두 노출, "+ more" 없음', () => {
    const r = formatGuardrailReason(3, ['a.js', 'b.js', 'c.js']);
    expect(r).toContain('a.js, b.js, c.js');
    expect(r).not.toContain('more');
  });

  it('blocked 4개 이상 → top 3 + "(+N more)"', () => {
    const r = formatGuardrailReason(5, ['fileA.js', 'fileB.js', 'fileC.js', 'fileD.js', 'fileE.js']);
    expect(r).toContain('fileA.js, fileB.js, fileC.js');
    expect(r).toContain('(+2 more)');
    expect(r).not.toContain('fileD.js');
    expect(r).not.toContain('fileE.js');
  });

  it('total과 blocked 길이가 다를 수 있다 (실제로는 blocked만 차단됨)', () => {
    const r = formatGuardrailReason(10, ['x.js', 'y.js']);
    expect(r).toContain('all 10 changes');
    expect(r).toContain('x.js, y.js');
  });

  it('blocked가 배열 아님 → no changes to commit (안전 fallback)', () => {
    expect(formatGuardrailReason(5, 'not-an-array')).toBe('no changes to commit');
    expect(formatGuardrailReason(5, { foo: 'bar' })).toBe('no changes to commit');
  });
});
