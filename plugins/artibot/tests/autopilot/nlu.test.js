/**
 * Unit tests for lib/autopilot/nlu.js
 * Covers classifyAutopilotIntent: night/default/plan suggestions, neg signal cap.
 */
import { describe, expect, it } from 'vitest';
import { classifyAutopilotIntent } from '../../lib/autopilot/nlu.js';

describe('classifyAutopilotIntent', () => {
  it('suggests night when sleep + autonomy phrasing present', () => {
    const r = classifyAutopilotIntent('자고 올게. 밤사이 알아서 다 구현해줘');
    expect(r.suggestion).toBe('night');
    expect(r.score).toBeGreaterThanOrEqual(0.7);
  });

  it('suggests default for 3시간 long-running autonomous task without sleep', () => {
    const r = classifyAutopilotIntent('3시간 동안 알아서 모두 구현하고 결과로 보고해줘');
    expect(r.suggestion).toBe('default');
    expect(r.score).toBeGreaterThanOrEqual(0.7);
  });

  it('suggests plan for explicit PRD-only review handoff', () => {
    const r = classifyAutopilotIntent('PRD만 만들고 검토만 해줘. plan only.');
    expect(r.suggestion).toBe('plan');
  });

  it('returns null suggestion for "지금 바로" interactive request', () => {
    const r = classifyAutopilotIntent('지금 바로 이 줄 고쳐줘');
    expect(r.suggestion).toBeNull();
  });

  it('returns null suggestion for unrelated content like "이메일"', () => {
    const r = classifyAutopilotIntent('이메일 보내는 함수 좀 봐줘');
    expect(r.suggestion).toBeNull();
    expect(r.score).toBeLessThan(0.7);
  });

  it('caps score at 1.0 even with many positive signals', () => {
    const huge = '자고 올게. 밤사이 퇴근하고 내일 아침까지 알아서 모두 구현 통째로 한 번에 다 long-running autonomous overnight';
    const r = classifyAutopilotIntent(huge);
    expect(r.score).toBeLessThanOrEqual(1.0);
  });

  it('negative signal "지금 바로" reduces score even with autonomy phrasing', () => {
    const withNeg = classifyAutopilotIntent('지금 바로 알아서 처리');
    const withoutNeg = classifyAutopilotIntent('알아서 처리');
    expect(withNeg.score).toBeLessThan(withoutNeg.score + 0.0001);
    expect(withNeg.score).toBeLessThanOrEqual(Math.max(0, withoutNeg.score - 0.49));
  });

  it('returns score 0 and null suggestion for empty input', () => {
    const r = classifyAutopilotIntent('');
    expect(r.score).toBe(0);
    expect(r.suggestion).toBeNull();
  });
});
