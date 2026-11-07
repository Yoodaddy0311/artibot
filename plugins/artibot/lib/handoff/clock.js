/**
 * Clock normalization shared by the `/save` pipeline.
 *
 * `/save` hands one caller-supplied `now` to both
 * `handoff-builder.js#collectHandoffData` and `handoff-store.js#writeHandoff`
 * (commands/save.md Phase B and C). Both modules treat `now` internally as a
 * clock (`now()` → Date), but callers naturally reach for a Date or for
 * `Date.now()` (a number). One rule for both modules so the same value is
 * accepted by every step: function | finite number | valid Date; anything
 * else (undefined included) means the wall clock.
 *
 * Zero imports on purpose — the store is the lower-level I/O module and must
 * not depend on the builder to get this.
 *
 * @module lib/handoff/clock
 */

/**
 * Normalize a caller-supplied `now` into a clock function returning a Date.
 *
 * - function → returned as-is
 * - finite number (epoch ms) → `() => new Date(n)`
 * - valid Date → `() => that Date`
 * - anything else (undefined, NaN, an invalid Date such as
 *   `new Date('x')`) → wall clock `() => new Date()`
 *
 * An invalid Date takes the wall-clock exit like a non-finite number does:
 * passed through, it made writeHandoff write `NaN-NaN-NaN-NaNNaN.md` and the
 * builder render `# HANDOFF — NaN-NaN-NaN NaN:NaN` (inspector, 2026-11-08).
 *
 * @param {unknown} now
 * @returns {() => Date}
 */
export function asClock(now) {
  if (typeof now === 'function') return now;
  if (typeof now === 'number' && Number.isFinite(now)) return () => new Date(now);
  if (now instanceof Date && Number.isFinite(now.getTime())) return () => now;
  return () => new Date();
}
