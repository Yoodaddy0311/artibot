import { describe, expect, it } from 'vitest';

import {
  buildAdditionalContextOutput,
  buildBlindspotContext,
  buildFingerprint,
  buildTeachBackContext,
  DEFAULT_TEACHBACK_QUESTIONS,
  resolveHookEventName,
  resolvePassEnabled,
  resolveTeachBackQuestions,
} from '../../lib/core/post-work-pass.js';

/**
 * Pure-function contract tests for the shared post-work-pass machinery. The
 * IO-driven gate (runPostWorkPass) is exercised through the hook scripts in
 * tests/hooks/post-work-hooks.test.js; here we lock down the pure helpers.
 */

describe('resolvePassEnabled', () => {
  const opts = { section: 'blindspot', envVar: 'ARTIBOT_DISABLE_BLINDSPOT' };

  it('is false when config omits the section (default off)', () => {
    expect(resolvePassEnabled({}, opts, {})).toBe(false);
    expect(resolvePassEnabled({ postWork: {} }, opts, {})).toBe(false);
  });

  it('is true when the section opts in', () => {
    const config = { postWork: { blindspot: { enabled: true } } };
    expect(resolvePassEnabled(config, opts, {})).toBe(true);
  });

  it('is false when enabled is not strictly true', () => {
    const config = { postWork: { blindspot: { enabled: 'yes' } } };
    expect(resolvePassEnabled(config, opts, {})).toBe(false);
  });

  it('env kill-switch ("1"/"true") wins over an enabled config', () => {
    const config = { postWork: { blindspot: { enabled: true } } };
    expect(resolvePassEnabled(config, opts, { ARTIBOT_DISABLE_BLINDSPOT: '1' })).toBe(false);
    expect(resolvePassEnabled(config, opts, { ARTIBOT_DISABLE_BLINDSPOT: 'true' })).toBe(false);
  });

  it('ignores a non-truthy env value', () => {
    const config = { postWork: { blindspot: { enabled: true } } };
    expect(resolvePassEnabled(config, opts, { ARTIBOT_DISABLE_BLINDSPOT: '0' })).toBe(true);
  });

  it('resolves the teachBack section independently', () => {
    const config = { postWork: { teachBack: { enabled: true } } };
    const tbOpts = { section: 'teachBack', envVar: 'ARTIBOT_DISABLE_TEACHBACK' };
    expect(resolvePassEnabled(config, tbOpts, {})).toBe(true);
    expect(resolvePassEnabled(config, tbOpts, { ARTIBOT_DISABLE_TEACHBACK: '1' })).toBe(false);
  });
});

describe('buildBlindspotContext', () => {
  it('includes the blindspot marker and recommend-only clause', () => {
    const text = buildBlindspotContext();
    expect(text).toContain('사각지대 점검');
    expect(text).toContain('recommend-only');
    expect(text).toContain('earliest blocking hop');
    expect(text).toContain('이상 없음');
  });
});

describe('resolveTeachBackQuestions', () => {
  it('defaults to 3 when unset', () => {
    expect(resolveTeachBackQuestions(undefined)).toBe(DEFAULT_TEACHBACK_QUESTIONS);
    expect(resolveTeachBackQuestions({})).toBe(3);
  });

  it('reads a positive configured value', () => {
    expect(resolveTeachBackQuestions({ postWork: { teachBack: { questions: 5 } } })).toBe(5);
  });

  it('falls back to default on non-positive / non-numeric values', () => {
    expect(resolveTeachBackQuestions({ postWork: { teachBack: { questions: 0 } } })).toBe(3);
    expect(resolveTeachBackQuestions({ postWork: { teachBack: { questions: -2 } } })).toBe(3);
    expect(resolveTeachBackQuestions({ postWork: { teachBack: { questions: 'x' } } })).toBe(3);
  });
});

describe('buildTeachBackContext', () => {
  it('interpolates the question count into the prompt', () => {
    expect(buildTeachBackContext(3)).toContain('퀴즈 3문항');
    expect(buildTeachBackContext(5)).toContain('퀴즈 5문항');
  });

  it('defaults to 3 questions and keeps the no-gate clause', () => {
    const text = buildTeachBackContext();
    expect(text).toContain('퀴즈 3문항');
    expect(text).toContain('만점 게이트 금지');
    expect(text).toContain('12세');
  });
});

describe('buildAdditionalContextOutput', () => {
  it('wraps advisory context under hookSpecificOutput (never decision:block)', () => {
    const out = buildAdditionalContextOutput('hi', 'Stop');
    expect(out).toEqual({ hookSpecificOutput: { hookEventName: 'Stop', additionalContext: 'hi' } });
    expect(out.decision).toBeUndefined();
  });

  it('defaults the event name to Stop', () => {
    expect(buildAdditionalContextOutput('x').hookSpecificOutput.hookEventName).toBe('Stop');
  });
});

describe('resolveHookEventName', () => {
  it('echoes SubagentStop, defaulting everything else to Stop', () => {
    expect(resolveHookEventName({ hook_event_name: 'SubagentStop' })).toBe('SubagentStop');
    expect(resolveHookEventName({ hook_event_name: 'Stop' })).toBe('Stop');
    expect(resolveHookEventName({})).toBe('Stop');
  });
});

describe('buildFingerprint', () => {
  it('is stable regardless of input file order', () => {
    const a = buildFingerprint('/repo', 'sha1', ['b.js', 'a.js']);
    const b = buildFingerprint('/repo', 'sha1', ['a.js', 'b.js']);
    expect(a).toBe(b);
  });

  it('differs across repo roots and shas', () => {
    const base = buildFingerprint('/repo', 'sha1', ['a.js']);
    expect(buildFingerprint('/other', 'sha1', ['a.js'])).not.toBe(base);
    expect(buildFingerprint('/repo', 'sha2', ['a.js'])).not.toBe(base);
  });
});
