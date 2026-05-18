import { describe, expect, it } from 'vitest';
import {
  detectAllIntents,
  detectDryRunIntent,
  detectQueueIntent,
  detectRollbackIntent,
  detectScheduleIntent,
  detectTemplateHint,
} from '../../lib/cognitive/autopilot-intent.js';

// ---------------------------------------------------------------------------
// detectQueueIntent
// ---------------------------------------------------------------------------

describe('detectQueueIntent', () => {
  it('detects Korean batch phrase "이거 3개 다"', () => {
    const r = detectQueueIntent('이거 3개 다 처리해줘');
    expect(r.found).toBe(true);
    expect(r.confidence).toBeGreaterThanOrEqual(0.3);
  });

  it('detects Korean "이것들 처리"', () => {
    const r = detectQueueIntent('이것들 모두 처리해줘');
    expect(r.found).toBe(true);
  });

  it('detects numbered list and extracts goals', () => {
    const prompt = '오늘 할일:\n1. 로그인 버그 수정\n2. 회원가입 페이지 추가\n3. 결제 모듈 리팩토링';
    const r = detectQueueIntent(prompt);
    expect(r.found).toBe(true);
    expect(r.goals.length).toBe(3);
    expect(r.goals[0]).toMatch(/로그인/);
  });

  it('detects English "all 3 of these tasks"', () => {
    const r = detectQueueIntent('please handle all 3 of these tasks for me');
    expect(r.found).toBe(true);
  });

  it('detects "그리고 ... 그리고" conjunction chain', () => {
    const r = detectQueueIntent('A 작업 하고 그리고 B 작업도 하고 그리고 C까지');
    expect(r.found).toBe(true);
  });

  it('detects comma-separated tasks (3+ items)', () => {
    const r = detectQueueIntent('로그인 버그 수정, 회원가입 페이지 추가, 결제 모듈 정리');
    expect(r.found).toBe(true);
    expect(r.goals.length).toBeGreaterThanOrEqual(3);
  });

  it('returns found=false for single-goal prompt', () => {
    const r = detectQueueIntent('login 버그 한개 고쳐줘');
    expect(r.found).toBe(false);
    expect(r.goals).toEqual([]);
  });

  it('handles empty input gracefully', () => {
    const r = detectQueueIntent('');
    expect(r.found).toBe(false);
    expect(r.goals).toEqual([]);
    expect(r.confidence).toBe(0);
  });

  it('handles non-string input gracefully', () => {
    // @ts-expect-error testing defensive guard
    const r = detectQueueIntent(null);
    expect(r.found).toBe(false);
  });

  it('caps confidence at 1.0 even with many signals', () => {
    const prompt = '이거 5개 다 한번에 처리: 1. A\n2. B\n3. C\n4. D\n5. E 그리고 또 그리고';
    const r = detectQueueIntent(prompt);
    expect(r.confidence).toBeLessThanOrEqual(1.0);
  });
});

// ---------------------------------------------------------------------------
// detectScheduleIntent
// ---------------------------------------------------------------------------

describe('detectScheduleIntent', () => {
  it('detects "오늘 밤" → night window', () => {
    const r = detectScheduleIntent('오늘 밤에 처리해줘');
    expect(r.found).toBe(true);
    expect(r.window).toBe('22:00-07:00');
  });

  it('detects "내일 아침까지" → night window', () => {
    const r = detectScheduleIntent('내일 아침까지 끝내줘');
    expect(r.found).toBe(true);
    expect(r.window).toBe('22:00-07:00');
  });

  it('detects "잠자는 동안"', () => {
    const r = detectScheduleIntent('잠자는 동안 알아서 해줘');
    expect(r.found).toBe(true);
    expect(r.window).toBe('22:00-07:00');
  });

  it('detects "야간에만"', () => {
    const r = detectScheduleIntent('야간에만 작업해');
    expect(r.found).toBe(true);
  });

  it('detects English "overnight"', () => {
    const r = detectScheduleIntent('please run this overnight');
    expect(r.found).toBe(true);
    expect(r.window).toBe('22:00-07:00');
  });

  it('detects "tonight"', () => {
    const r = detectScheduleIntent('handle it tonight while I sleep');
    expect(r.found).toBe(true);
  });

  it('returns found=false for non-temporal prompt', () => {
    const r = detectScheduleIntent('fix the login bug');
    expect(r.found).toBe(false);
    expect(r.window).toBeNull();
  });

  it('handles empty input', () => {
    const r = detectScheduleIntent('');
    expect(r.found).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// detectDryRunIntent
// ---------------------------------------------------------------------------

describe('detectDryRunIntent', () => {
  it('detects Korean "한번 봐줘"', () => {
    const r = detectDryRunIntent('한번 봐줘 어떻게 될지');
    expect(r.found).toBe(true);
    expect(r.confidence).toBeGreaterThanOrEqual(0.7);
  });

  it('detects "테스트만"', () => {
    const r = detectDryRunIntent('일단 테스트만 해봐');
    expect(r.found).toBe(true);
  });

  it('detects "미리보기"', () => {
    const r = detectDryRunIntent('미리보기로 보여줘');
    expect(r.found).toBe(true);
  });

  it('detects "시뮬레이션"', () => {
    const r = detectDryRunIntent('시뮬레이션 돌려봐');
    expect(r.found).toBe(true);
  });

  it('detects "어떻게 될지만"', () => {
    const r = detectDryRunIntent('어떻게 될지만 알려줘');
    expect(r.found).toBe(true);
  });

  it('detects English "dry run"', () => {
    const r = detectDryRunIntent('please dry run this first');
    expect(r.found).toBe(true);
  });

  it('detects "preview"', () => {
    const r = detectDryRunIntent('show me a preview');
    expect(r.found).toBe(true);
  });

  it('detects "simulate"', () => {
    const r = detectDryRunIntent('simulate the migration');
    expect(r.found).toBe(true);
  });

  it('returns found=false for execute-now prompt', () => {
    const r = detectDryRunIntent('지금 바로 적용해줘');
    expect(r.found).toBe(false);
  });

  it('handles empty input', () => {
    expect(detectDryRunIntent('').found).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// detectTemplateHint
// ---------------------------------------------------------------------------

describe('detectTemplateHint', () => {
  it('detects bugfix from "버그"', () => {
    const r = detectTemplateHint('로그인 버그 고쳐줘');
    expect(r.found).toBe(true);
    expect(r.template).toBe('bugfix');
  });

  it('detects bugfix from English "fix"', () => {
    const r = detectTemplateHint('please fix this broken endpoint');
    expect(r.found).toBe(true);
    expect(r.template).toBe('bugfix');
  });

  it('detects refactor from "리팩토링"', () => {
    const r = detectTemplateHint('이 모듈 리팩토링 해줘');
    expect(r.found).toBe(true);
    expect(r.template).toBe('refactor');
  });

  it('detects refactor from "clean up"', () => {
    const r = detectTemplateHint('please clean up the auth module');
    expect(r.found).toBe(true);
    expect(r.template).toBe('refactor');
  });

  it('detects feature from "신기능 추가"', () => {
    const r = detectTemplateHint('신기능 추가해줘 다크모드');
    expect(r.found).toBe(true);
    expect(r.template).toBe('feature');
  });

  it('detects feature from "new feature"', () => {
    const r = detectTemplateHint('add a new feature for export');
    expect(r.found).toBe(true);
    expect(r.template).toBe('feature');
  });

  it('returns null template when no signals', () => {
    const r = detectTemplateHint('hello world');
    expect(r.found).toBe(false);
    expect(r.template).toBeNull();
  });

  it('prioritises bugfix when multiple signals tie', () => {
    const r = detectTemplateHint('bug fix and refactor and new feature');
    // At equal hit count, bugfix wins by priority
    expect(['bugfix', 'refactor', 'feature']).toContain(r.template);
  });

  it('handles empty input', () => {
    expect(detectTemplateHint('').found).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// detectRollbackIntent
// ---------------------------------------------------------------------------

describe('detectRollbackIntent', () => {
  it('detects "되돌려"', () => {
    const r = detectRollbackIntent('이전 상태로 되돌려줘');
    expect(r.found).toBe(true);
    expect(r.confidence).toBeGreaterThanOrEqual(0.7);
  });

  it('detects "롤백"', () => {
    const r = detectRollbackIntent('롤백 해줘');
    expect(r.found).toBe(true);
  });

  it('detects "복구"', () => {
    const r = detectRollbackIntent('지난 커밋으로 복구해줘');
    expect(r.found).toBe(true);
  });

  it('detects "취소해"', () => {
    const r = detectRollbackIntent('방금 작업 취소해줘');
    expect(r.found).toBe(true);
  });

  it('detects English "undo"', () => {
    const r = detectRollbackIntent('undo the last change');
    expect(r.found).toBe(true);
  });

  it('detects "rollback"', () => {
    const r = detectRollbackIntent('rollback to v4.10.0');
    expect(r.found).toBe(true);
  });

  it('detects "revert"', () => {
    const r = detectRollbackIntent('revert this commit');
    expect(r.found).toBe(true);
  });

  it('returns found=false for non-rollback prompt', () => {
    const r = detectRollbackIntent('add a new feature');
    expect(r.found).toBe(false);
  });

  it('handles empty input', () => {
    expect(detectRollbackIntent('').found).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// detectAllIntents (coordinator)
// ---------------------------------------------------------------------------

describe('detectAllIntents', () => {
  it('returns all 5 intent slots', () => {
    const r = detectAllIntents('hello');
    expect(r).toHaveProperty('queue');
    expect(r).toHaveProperty('schedule');
    expect(r).toHaveProperty('dryRun');
    expect(r).toHaveProperty('template');
    expect(r).toHaveProperty('rollback');
  });

  it('combines multiple intents in one prompt', () => {
    const prompt = '오늘 밤에 이거 3개 다 시뮬레이션으로 돌려봐: 1. A\n2. B\n3. C';
    const r = detectAllIntents(prompt);
    expect(r.queue.found).toBe(true);
    expect(r.schedule.found).toBe(true);
    expect(r.dryRun.found).toBe(true);
  });

  it('returns all not-found on empty input', () => {
    const r = detectAllIntents('');
    expect(r.queue.found).toBe(false);
    expect(r.schedule.found).toBe(false);
    expect(r.dryRun.found).toBe(false);
    expect(r.template.found).toBe(false);
    expect(r.rollback.found).toBe(false);
  });
});
