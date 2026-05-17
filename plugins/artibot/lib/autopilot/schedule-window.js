/**
 * Schedule-window gating for the autopilot queue (PRD v4.10.0 Track E).
 *
 * Parses a `HH:MM-HH:MM` window string and answers two scheduling questions:
 *   1. Is `now` inside the window? (honours midnight wrap)
 *   2. When does the window next open from `now`?
 *
 * Pure module — no I/O, no clock unless caller passes one. Local-only.
 *
 * Public surface:
 *   - parseWindow(spec)
 *   - isInWindow(now, window)
 *   - nextWindowStart(now, window)
 *
 * @module lib/autopilot/schedule-window
 */

const MINUTES_PER_DAY = 24 * 60;
const WINDOW_RE = /^([0-2]?\d):([0-5]\d)-([0-2]?\d):([0-5]\d)$/;

/**
 * Convert HH and MM strings to a 0..1439 minute integer. Returns null when
 * either component is out of range.
 *
 * @param {string} hh
 * @param {string} mm
 * @returns {number|null}
 */
function toMinutes(hh, mm) {
  const h = Number(hh);
  const m = Number(mm);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  if (h < 0 || h > 23) return null;
  if (m < 0 || m > 59) return null;
  return h * 60 + m;
}

/**
 * Parse a `HH:MM-HH:MM` window spec.
 *
 * Wrap-around is allowed (`22:00-07:00` means 22:00 today through 07:00
 * tomorrow). A spec where start === end is rejected as ambiguous (zero-length
 * or all-day depending on interpretation — caller should pass `00:00-23:59`
 * for "always" instead).
 *
 * @param {string} spec
 * @returns {{start:number, end:number, wraps:boolean, raw:string}}
 */
export function parseWindow(spec) {
  if (typeof spec !== 'string') {
    throw new TypeError('parseWindow: spec must be a string');
  }
  const trimmed = spec.trim();
  const match = WINDOW_RE.exec(trimmed);
  if (!match) {
    throw new RangeError(`parseWindow: invalid spec "${spec}" — expected HH:MM-HH:MM`);
  }
  const start = toMinutes(match[1], match[2]);
  const end = toMinutes(match[3], match[4]);
  if (start === null || end === null) {
    throw new RangeError(`parseWindow: invalid spec "${spec}" — out-of-range HH/MM`);
  }
  if (start === end) {
    throw new RangeError(`parseWindow: zero-length window "${spec}" — start equals end`);
  }
  return { start, end, wraps: start > end, raw: trimmed };
}

/**
 * Pick the minute-of-day from a Date in **local time**. Using local time
 * matches user mental model ("22:00-07:00" means user's wall clock, not UTC).
 *
 * @param {Date|number} now
 * @returns {number} 0..1439
 */
function minuteOfDayLocal(now) {
  const d = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(d.getTime())) {
    throw new TypeError('schedule-window: now must be a valid Date or epoch');
  }
  return d.getHours() * 60 + d.getMinutes();
}

/**
 * Check whether `now` falls inside the window.
 *
 * Semantics: `[start, end)` for non-wrap (inclusive start, exclusive end).
 * For wrap (start > end), inside means `>= start || < end`.
 *
 * @param {Date|number} now
 * @param {{start:number, end:number, wraps:boolean}|string} window
 * @returns {boolean}
 */
export function isInWindow(now, window) {
  const w = typeof window === 'string' ? parseWindow(window) : window;
  if (!w || typeof w.start !== 'number' || typeof w.end !== 'number') {
    throw new TypeError('isInWindow: window must be a parsed window object or spec string');
  }
  const minute = minuteOfDayLocal(now);
  if (w.wraps) {
    return minute >= w.start || minute < w.end;
  }
  return minute >= w.start && minute < w.end;
}

/**
 * Compute the next Date when the window opens, relative to `now`.
 *
 * - If `now` is already inside the window, returns a Date representing the
 *   most-recent start (i.e. the window that is currently open).
 * - Otherwise returns the next `start` (today if still ahead, else tomorrow).
 *
 * The returned Date preserves local time semantics by mutating a clone of
 * `now`'s date components.
 *
 * @param {Date|number} now
 * @param {{start:number, end:number, wraps:boolean}|string} window
 * @returns {Date}
 */
export function nextWindowStart(now, window) {
  const w = typeof window === 'string' ? parseWindow(window) : window;
  if (!w || typeof w.start !== 'number') {
    throw new TypeError('nextWindowStart: window must be a parsed window object or spec string');
  }
  const base = now instanceof Date ? new Date(now.getTime()) : new Date(now);
  if (Number.isNaN(base.getTime())) {
    throw new TypeError('nextWindowStart: now must be a valid Date or epoch');
  }
  const minute = minuteOfDayLocal(base);
  const inside = isInWindow(base, w);

  // dayOffset 0 = today's start, 1 = tomorrow's start, -1 = yesterday's start
  let dayOffset;
  if (inside) {
    // If wrap window and we're in the "tail" (before end, after midnight),
    // the active window actually started yesterday.
    dayOffset = w.wraps && minute < w.end ? -1 : 0;
  } else {
    // Not inside — pick today's start if still in the future, else tomorrow.
    dayOffset = minute < w.start ? 0 : 1;
  }

  const target = new Date(base.getFullYear(), base.getMonth(), base.getDate() + dayOffset,
    Math.floor(w.start / 60), w.start % 60, 0, 0);
  return target;
}
