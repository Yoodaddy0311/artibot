import { describe, expect, it } from 'vitest';
import {
  AUTOPILOT_FEATURES,
  DEFAULT_TRIGGER_THRESHOLD,
  dominantIntent,
  extendClassification,
  shouldAutoTrigger,
} from '../../lib/cognitive/intent-router-extension.js';
import { detectAllIntents } from '../../lib/cognitive/autopilot-intent.js';

describe('extendClassification', () => {
  it('appends autopilotIntents to a base classification', () => {
    const base = { score: 0.5, system: 2, confidence: 0.8 };
    const ext = extendClassification(base, '오늘 밤에 처리해줘');
    expect(ext.score).toBe(0.5);
    expect(ext.system).toBe(2);
    expect(ext.autopilotIntents).toBeDefined();
    expect(ext.autopilotIntents.schedule.found).toBe(true);
  });

  it('does not mutate the base classification (immutable pattern)', () => {
    const base = { score: 0.3 };
    const ext = extendClassification(base, 'test');
    expect(base).not.toHaveProperty('autopilotIntents');
    expect(ext).not.toBe(base);
  });

  it('handles null/undefined base classification gracefully', () => {
    const ext = extendClassification(null, 'fix the bug');
    expect(ext.autopilotIntents.template.template).toBe('bugfix');
  });

  it('handles non-string prompt gracefully', () => {
    // @ts-expect-error testing defensive guard
    const ext = extendClassification({ score: 0.1 }, 42);
    expect(ext.autopilotIntents).toBeDefined();
    expect(ext.autopilotIntents.queue.found).toBe(false);
  });

  it('exposes all 5 intent slots', () => {
    const ext = extendClassification({}, 'hello');
    for (const name of AUTOPILOT_FEATURES) {
      expect(ext.autopilotIntents).toHaveProperty(name);
    }
  });
});

describe('shouldAutoTrigger', () => {
  it('returns empty array when no intent meets threshold', () => {
    const intents = detectAllIntents('hello world');
    expect(shouldAutoTrigger(intents)).toEqual([]);
  });

  it('returns triggered feature names sorted by confidence desc', () => {
    const intents = detectAllIntents('오늘 밤에 시뮬레이션 돌려봐 미리보기로');
    const triggered = shouldAutoTrigger(intents);
    expect(triggered.length).toBeGreaterThan(0);
    expect(triggered).toContain('schedule');
    expect(triggered).toContain('dryRun');
  });

  it('respects custom threshold', () => {
    const intents = detectAllIntents('오늘 밤에 처리');
    const strict = shouldAutoTrigger(intents, { threshold: 0.95 });
    const loose = shouldAutoTrigger(intents, { threshold: 0.3 });
    expect(loose.length).toBeGreaterThanOrEqual(strict.length);
  });

  it('respects "only" allow-list filter', () => {
    const intents = detectAllIntents('오늘 밤에 시뮬레이션 돌려봐');
    const onlySchedule = shouldAutoTrigger(intents, { only: ['schedule'] });
    expect(onlySchedule).toEqual(['schedule']);
    expect(onlySchedule).not.toContain('dryRun');
  });

  it('uses DEFAULT_TRIGGER_THRESHOLD when none provided', () => {
    expect(DEFAULT_TRIGGER_THRESHOLD).toBe(0.7);
    const intents = detectAllIntents('오늘 밤에 시뮬레이션');
    const a = shouldAutoTrigger(intents);
    const b = shouldAutoTrigger(intents, { threshold: DEFAULT_TRIGGER_THRESHOLD });
    expect(a).toEqual(b);
  });

  it('clamps invalid threshold values into [0,1]', () => {
    const intents = detectAllIntents('rollback please');
    expect(() => shouldAutoTrigger(intents, { threshold: -1 })).not.toThrow();
    expect(() => shouldAutoTrigger(intents, { threshold: 99 })).not.toThrow();
  });

  it('returns [] for null intents input', () => {
    expect(shouldAutoTrigger(null)).toEqual([]);
    expect(shouldAutoTrigger(undefined)).toEqual([]);
  });

  it('skips intent slots with non-numeric confidence', () => {
    const malformed = {
      queue: { found: true, confidence: 'high', goals: [] },
      schedule: { found: false, window: null, confidence: 0 },
      dryRun: { found: false, confidence: 0 },
      template: { found: false, template: null, confidence: 0 },
      rollback: { found: false, confidence: 0 },
    };
    expect(shouldAutoTrigger(malformed)).toEqual([]);
  });

  it('skips intents with found=false even if confidence is high', () => {
    const intents = {
      queue: { found: false, confidence: 0.99, goals: [] },
      schedule: { found: false, window: null, confidence: 0 },
      dryRun: { found: false, confidence: 0 },
      template: { found: false, template: null, confidence: 0 },
      rollback: { found: false, confidence: 0 },
    };
    expect(shouldAutoTrigger(intents)).toEqual([]);
  });
});

describe('dominantIntent', () => {
  it('returns null when nothing triggers', () => {
    expect(dominantIntent(detectAllIntents('hello'))).toBeNull();
  });

  it('returns the single triggered feature', () => {
    const intents = detectAllIntents('오늘 밤에 처리해줘');
    expect(dominantIntent(intents)).toBe('schedule');
  });

  it('returns the highest-confidence feature when multiple trigger', () => {
    const intents = detectAllIntents('오늘 밤 밤사이 잠자는 동안 시뮬레이션 돌려봐');
    const top = dominantIntent(intents);
    expect(['schedule', 'dryRun']).toContain(top);
  });

  it('honours custom threshold', () => {
    const intents = detectAllIntents('rollback');
    expect(dominantIntent(intents, { threshold: 0.99 })).toBeNull();
  });
});

describe('AUTOPILOT_FEATURES constant', () => {
  it('exposes exactly 5 feature names', () => {
    expect(AUTOPILOT_FEATURES).toHaveLength(5);
    expect(AUTOPILOT_FEATURES).toEqual(['queue', 'schedule', 'dryRun', 'template', 'rollback']);
  });

  it('is frozen / immutable', () => {
    expect(Object.isFrozen(AUTOPILOT_FEATURES)).toBe(true);
  });
});
