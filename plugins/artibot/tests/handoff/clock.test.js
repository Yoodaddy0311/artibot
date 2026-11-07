/**
 * Tests for lib/handoff/clock.js#asClock — the one `now` rule shared by
 * handoff-builder (collectHandoffData / deriveGitSyncStatus /
 * renderHandoffMarkdown) and handoff-store (writeHandoff). The store side of
 * the invalid-Date case lives in handoff-store-now.test.js; this file pins the
 * helper itself and the builder side, so one fix is shown to cover both.
 */

import { describe, expect, it } from 'vitest';

import { asClock } from '../../lib/handoff/clock.js';
import { renderHandoffMarkdown } from '../../lib/handoff/handoff-builder.js';

const AT = new Date(2026, 4, 19, 12, 30, 0);

/** @param {() => Date} clock */
function isWallClock(clock) {
  const before = Date.now();
  const got = clock().getTime();
  const after = Date.now();
  return got >= before && got <= after;
}

describe('asClock', () => {
  it('returns a clock function unchanged', () => {
    const fn = () => AT;
    expect(asClock(fn)).toBe(fn);
  });

  it('wraps a finite epoch-ms number', () => {
    expect(asClock(AT.getTime())().getTime()).toBe(AT.getTime());
  });

  it('wraps a valid Date', () => {
    expect(asClock(AT)().getTime()).toBe(AT.getTime());
  });

  it('falls back to the wall clock for undefined and a non-finite number', () => {
    expect(isWallClock(asClock(undefined))).toBe(true);
    expect(isWallClock(asClock(Number.NaN))).toBe(true);
  });

  it('falls back to the wall clock for an invalid Date, like a non-finite number', () => {
    const clock = asClock(new Date('not a date'));
    expect(Number.isFinite(clock().getTime())).toBe(true);
    expect(isWallClock(clock)).toBe(true);
  });
});

describe('asClock — builder consumer', () => {
  it('renderHandoffMarkdown header carries a real timestamp for an invalid Date', () => {
    const md = renderHandoffMarkdown({}, { now: new Date('not a date') });
    const header = md.split('\n').find((l) => l.startsWith('# HANDOFF — '));
    expect(header).toMatch(/^# HANDOFF — \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });
});
