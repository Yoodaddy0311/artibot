/**
 * ASCII phase-profile flamegraph for autopilot session summaries (Track H).
 *
 * Renders a markdown-embeddable bar chart from per-phase durations,
 * tokens, and cost. No ANSI escape codes — drop into REPORT.md as-is.
 *
 * DATA POLICY: pure function, no I/O, no external transmission.
 *
 * Public surface:
 *   - renderFlamegraph(summary, opts)
 *
 * @module lib/autopilot/flamegraph
 */

const DEFAULT_MAX_WIDTH = 50;
const BAR_CHAR = '\u2588';
const EMPTY_BAR = '\u2591';
const MIN_BAR = 1;

/**
 * Coerce a value to a non-negative finite number; treats NaN, negatives,
 * and non-numeric inputs as 0.
 * @param {unknown} n
 * @returns {number}
 */
function safeNum(n) {
  const v = typeof n === 'number' ? n : Number(n);
  if (!Number.isFinite(v) || v < 0) return 0;
  return v;
}

/**
 * Compact token count formatter (e.g. 12.3k, 1.2M).
 * @param {number} n
 * @returns {string}
 */
function fmtTok(n) {
  const v = safeNum(n);
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  return String(Math.round(v));
}

/**
 * Format USD cost as `$0.0000`.
 * @param {number} n
 * @returns {string}
 */
function fmtUsd(n) {
  return `$${safeNum(n).toFixed(4)}`;
}

/**
 * Format duration ms into compact human string (e.g. "2m 14s", "350ms").
 * @param {number} ms
 * @returns {string}
 */
function fmtDuration(ms) {
  const v = safeNum(ms);
  if (v < 1000) return `${Math.round(v)}ms`;
  const totalSec = Math.round(v / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m === 0) return `${s}s`;
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

/**
 * Normalize a single input row to a known shape (no negatives, all fields).
 * @param {object} row
 * @returns {{phase:string, durationMs:number, tokens:number, cost:number}|null}
 */
function normalizeRow(row) {
  if (!row || typeof row !== 'object') return null;
  const phase = typeof row.phase === 'string' && row.phase.length > 0
    ? row.phase : null;
  if (!phase) return null;
  return {
    phase,
    durationMs: safeNum(row.durationMs),
    tokens: safeNum(row.tokens),
    cost: safeNum(row.cost),
  };
}

/**
 * Sort rows by mode: 'duration' (descending) or 'phase' (input order).
 * Returns a NEW array — input is never mutated.
 * @param {Array<object>} rows
 * @param {'phase'|'duration'} mode
 * @returns {Array<object>}
 */
function sortRows(rows, mode) {
  if (mode === 'duration') {
    return [...rows].sort((a, b) => b.durationMs - a.durationMs);
  }
  return [...rows];
}

/**
 * Compute the maximum durationMs across the rows for bar scaling.
 * @param {Array<{durationMs:number}>} rows
 * @returns {number}
 */
function maxDuration(rows) {
  let max = 0;
  for (const r of rows) {
    if (r.durationMs > max) max = r.durationMs;
  }
  return max;
}

/**
 * Build a single bar string of length `width` proportional to (value/max).
 * Always produces at least MIN_BAR filled cells when value > 0.
 * @param {number} value
 * @param {number} max
 * @param {number} width
 * @returns {string}
 */
function buildBar(value, max, width) {
  if (max <= 0 || value <= 0) return EMPTY_BAR.repeat(width);
  const cells = Math.max(MIN_BAR, Math.round((value / max) * width));
  const clamped = Math.min(cells, width);
  return BAR_CHAR.repeat(clamped) + EMPTY_BAR.repeat(Math.max(0, width - clamped));
}

/**
 * Compute the longest phase name length so all rows align in a monospace block.
 * @param {Array<{phase:string}>} rows
 * @returns {number}
 */
function maxPhaseLen(rows) {
  let max = 0;
  for (const r of rows) {
    if (r.phase.length > max) max = r.phase.length;
  }
  return max;
}

/**
 * Format a single row of the flamegraph.
 * @param {{phase:string, durationMs:number, tokens:number, cost:number}} row
 * @param {number} maxDur
 * @param {number} barWidth
 * @param {number} phaseColWidth
 * @returns {string}
 */
function renderRow(row, maxDur, barWidth, phaseColWidth) {
  const pad = row.phase.padEnd(phaseColWidth, ' ');
  const bar = buildBar(row.durationMs, maxDur, barWidth);
  const meta = `${fmtDuration(row.durationMs)} | ${fmtTok(row.tokens)} tok | ${fmtUsd(row.cost)}`;
  return `${pad}  ${bar}  ${meta}`;
}

/**
 * Render an ASCII flamegraph of phase profile data.
 *
 * @param {Array<{phase:string, durationMs:number, tokens:number, cost:number}>} summary
 *   phase-level rows; non-objects and entries without `phase` are dropped.
 * @param {{maxWidth?:number, sort?:'phase'|'duration'}} [opts]
 *   - maxWidth: clamp the bar column to at most this many cells (default 50, min 5, max 200).
 *   - sort: 'phase' (input order, default) or 'duration' (descending).
 * @returns {string} markdown-embeddable ASCII chart (no escape codes).
 */
export function renderFlamegraph(summary, opts = {}) {
  if (!Array.isArray(summary) || summary.length === 0) {
    return '_(flamegraph 데이터 없음 — phase 입력 비어있음)_';
  }
  const rows = summary.map(normalizeRow).filter(Boolean);
  if (rows.length === 0) {
    return '_(flamegraph 데이터 없음 — phase 입력 비어있음)_';
  }
  const mode = opts && opts.sort === 'duration' ? 'duration' : 'phase';
  const sorted = sortRows(rows, mode);
  const requested = Number.isFinite(opts && opts.maxWidth)
    ? Math.floor(opts.maxWidth)
    : DEFAULT_MAX_WIDTH;
  const barWidth = Math.max(5, Math.min(200, requested));
  const maxDur = maxDuration(sorted);
  const phaseColWidth = maxPhaseLen(sorted);
  const lines = sorted.map((r) => renderRow(r, maxDur, barWidth, phaseColWidth));
  return ['```', ...lines, '```'].join('\n');
}
