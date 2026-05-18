/**
 * Unit tests for lib/autopilot/schedule-window.js
 *
 * Covers parse / isInWindow / nextWindowStart including midnight wrap.
 * All tests use explicit Date objects (no real clock).
 */
import { describe, expect, it } from 'vitest';
import {
  isInWindow,
  nextWindowStart,
  parseWindow,
} from '../../lib/autopilot/schedule-window.js';

// Build a Date in local time for clarity (window logic is local-time based).
function at(year, month, day, hour, minute) {
  return new Date(year, month - 1, day, hour, minute, 0, 0);
}

describe('parseWindow', () => {
  it('throws TypeError on non-string', () => {
    expect(() => parseWindow(null)).toThrow(TypeError);
    expect(() => parseWindow(42)).toThrow(TypeError);
  });

  it('throws RangeError on malformed string', () => {
    expect(() => parseWindow('22:00')).toThrow(RangeError);
    expect(() => parseWindow('not-a-window')).toThrow(RangeError);
    expect(() => parseWindow('25:00-07:00')).toThrow(RangeError);
    expect(() => parseWindow('22:60-07:00')).toThrow(RangeError);
  });

  it('throws on zero-length window', () => {
    expect(() => parseWindow('09:00-09:00')).toThrow(RangeError);
  });

  it('parses simple same-day window', () => {
    const w = parseWindow('09:00-17:00');
    expect(w.start).toBe(9 * 60);
    expect(w.end).toBe(17 * 60);
    expect(w.wraps).toBe(false);
  });

  it('parses wrap window (22:00-07:00)', () => {
    const w = parseWindow('22:00-07:00');
    expect(w.start).toBe(22 * 60);
    expect(w.end).toBe(7 * 60);
    expect(w.wraps).toBe(true);
  });

  it('accepts single-digit hour', () => {
    const w = parseWindow('9:30-17:45');
    expect(w.start).toBe(9 * 60 + 30);
    expect(w.end).toBe(17 * 60 + 45);
  });
});

describe('isInWindow', () => {
  const day = parseWindow('09:00-17:00');
  const night = parseWindow('22:00-07:00');

  it('returns true at exact start (inclusive)', () => {
    expect(isInWindow(at(2026, 5, 17, 9, 0), day)).toBe(true);
  });

  it('returns false at exact end (exclusive)', () => {
    expect(isInWindow(at(2026, 5, 17, 17, 0), day)).toBe(false);
  });

  it('returns true mid-window', () => {
    expect(isInWindow(at(2026, 5, 17, 12, 30), day)).toBe(true);
  });

  it('returns false outside same-day window', () => {
    expect(isInWindow(at(2026, 5, 17, 8, 59), day)).toBe(false);
    expect(isInWindow(at(2026, 5, 17, 18, 0), day)).toBe(false);
  });

  it('handles midnight wrap: 23:00 is inside night window', () => {
    expect(isInWindow(at(2026, 5, 17, 23, 0), night)).toBe(true);
  });

  it('handles midnight wrap: 03:00 is inside night window', () => {
    expect(isInWindow(at(2026, 5, 17, 3, 0), night)).toBe(true);
  });

  it('handles midnight wrap: 07:00 is OUTSIDE (exclusive end)', () => {
    expect(isInWindow(at(2026, 5, 17, 7, 0), night)).toBe(false);
  });

  it('handles midnight wrap: 12:00 outside night window', () => {
    expect(isInWindow(at(2026, 5, 17, 12, 0), night)).toBe(false);
  });

  it('accepts a spec string directly', () => {
    expect(isInWindow(at(2026, 5, 17, 10, 0), '09:00-17:00')).toBe(true);
  });

  it('throws on invalid window arg', () => {
    expect(() => isInWindow(at(2026, 5, 17, 10, 0), null)).toThrow(TypeError);
  });

  it('throws on invalid now', () => {
    expect(() => isInWindow(new Date('not-a-date'), day)).toThrow(TypeError);
  });
});

describe('nextWindowStart', () => {
  const day = parseWindow('09:00-17:00');
  const night = parseWindow('22:00-07:00');

  it('before window today → returns today 09:00', () => {
    const next = nextWindowStart(at(2026, 5, 17, 6, 0), day);
    expect(next.getHours()).toBe(9);
    expect(next.getMinutes()).toBe(0);
    expect(next.getDate()).toBe(17);
  });

  it('after window today → returns tomorrow 09:00', () => {
    const next = nextWindowStart(at(2026, 5, 17, 18, 0), day);
    expect(next.getHours()).toBe(9);
    expect(next.getDate()).toBe(18);
  });

  it('inside window → returns most-recent start (today)', () => {
    const next = nextWindowStart(at(2026, 5, 17, 12, 0), day);
    expect(next.getDate()).toBe(17);
    expect(next.getHours()).toBe(9);
  });

  it('night window, currently 23:00 → returns today 22:00', () => {
    const next = nextWindowStart(at(2026, 5, 17, 23, 0), night);
    expect(next.getDate()).toBe(17);
    expect(next.getHours()).toBe(22);
  });

  it('night window, currently 03:00 (tail) → returns yesterday 22:00', () => {
    const next = nextWindowStart(at(2026, 5, 17, 3, 0), night);
    expect(next.getDate()).toBe(16);
    expect(next.getHours()).toBe(22);
  });

  it('night window, currently 10:00 (between windows) → returns today 22:00', () => {
    const next = nextWindowStart(at(2026, 5, 17, 10, 0), night);
    expect(next.getDate()).toBe(17);
    expect(next.getHours()).toBe(22);
  });

  it('handles month boundary (tomorrow rolls to next month)', () => {
    // 2026-05-31 18:00 — tomorrow is 2026-06-01
    const next = nextWindowStart(at(2026, 5, 31, 18, 0), day);
    expect(next.getMonth()).toBe(5); // 0-indexed June
    expect(next.getDate()).toBe(1);
  });

  it('accepts a spec string directly', () => {
    const next = nextWindowStart(at(2026, 5, 17, 6, 0), '09:00-17:00');
    expect(next.getHours()).toBe(9);
  });

  it('throws on invalid window arg', () => {
    expect(() => nextWindowStart(at(2026, 5, 17, 10, 0), null)).toThrow(TypeError);
  });
});
