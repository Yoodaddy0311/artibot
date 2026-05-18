/**
 * Pre-execute failure-memory surfacing helpers (v4.11.0 Track K).
 *
 * Turns `recallRelevantFailures()` output into a user-facing markdown block
 * that the engine can show before the user accepts a goal. Pure functions,
 * no I/O, no side effects.
 *
 * Public surface:
 *   - shouldSurfaceWarning(failures, opts?)
 *   - buildMemoryWarning(failures, opts?)
 *
 * @module lib/autopilot/memory-surface
 */

/** Default minimum cluster count for surfacing a warning. */
export const DEFAULT_SURFACE_THRESHOLD = 3;

/** Hard cap on how many entries are rendered to keep the block scannable. */
export const DEFAULT_RENDER_LIMIT = 3;

/**
 * Decide whether to surface a warning block at all. Returns true when at
 * least one failure entry meets the count threshold. Empty / invalid input
 * always returns false.
 *
 * @param {Array<{count?: number}>} failures
 * @param {{ threshold?: number }} [opts]
 * @returns {boolean}
 */
export function shouldSurfaceWarning(failures, opts = {}) {
  if (!Array.isArray(failures) || failures.length === 0) return false;
  const threshold = positiveInt(opts.threshold, DEFAULT_SURFACE_THRESHOLD);
  for (const f of failures) {
    if (!f || typeof f !== 'object') continue;
    const c = Number.isInteger(f.count) ? f.count : 0;
    if (c >= threshold) return true;
  }
  return false;
}

/**
 * Build a markdown warning block summarising past recurring failures that
 * match the current prompt. Returns an empty string when input is empty.
 *
 * Format (GFM pipe table per project preference):
 *   ### ⚠ Past failures relevant to this goal
 *   | # | count | last seen | sample |
 *   | - | ----- | --------- | ------ |
 *   | 1 | 5     | 2026-05-17 | ENOENT... |
 *
 * (No emoji decoration unless the user opts in — kept to a single header
 * marker; tests check the literal "Past failures" string.)
 *
 * @param {Array<{ signature?: string, count?: number, lastSeen?: string|null, sampleMessage?: string }>} failures
 * @param {{ limit?: number, header?: string }} [opts]
 * @returns {string}
 */
export function buildMemoryWarning(failures, opts = {}) {
  if (!Array.isArray(failures) || failures.length === 0) return '';
  const limit = positiveInt(opts.limit, DEFAULT_RENDER_LIMIT);
  const header = typeof opts.header === 'string' && opts.header
    ? opts.header
    : 'Past failures relevant to this goal';
  const rows = failures
    .filter((f) => f && typeof f === 'object')
    .slice(0, limit)
    .map((f, i) => renderRow(i + 1, f));
  if (rows.length === 0) return '';
  const table = [
    '| # | count | last seen | sample |',
    '| - | ----- | --------- | ------ |',
    ...rows,
  ].join('\n');
  return `### ${header}\n\n${table}\n`;
}

// ─── helpers ───────────────────────────────────────────────────────────

function renderRow(idx, f) {
  const count = Number.isInteger(f.count) ? f.count : 0;
  const last = typeof f.lastSeen === 'string' && f.lastSeen
    ? f.lastSeen.slice(0, 10)
    : '—';
  const sample = truncate(escapePipe(f.sampleMessage || f.signature || ''), 80);
  return `| ${idx} | ${count} | ${last} | ${sample} |`;
}

function escapePipe(s) {
  return String(s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function truncate(s, max) {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

function positiveInt(v, fallback) {
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}
