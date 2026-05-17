/**
 * Autopilot live TUI dashboard.
 *
 * Pure ANSI escape sequences — zero runtime deps. Korean-path safe (no I/O on
 * source paths; reads telemetry via session-store + telemetry helpers).
 *
 * Public surface:
 *   - renderFrame(input) — pure string render
 *   - runTuiLoop(sessionId, opts) — async live polling loop
 *   - shouldActivateTui(state, env) — activation policy
 *
 * DATA POLICY: 100% local; writes only to a provided stream (default
 * process.stdout). No external transmission.
 *
 * Note on box-drawing chars: per project policy reports/tables must use ASCII,
 * but live TUI is the documented exception — unicode box-drawing is OK here.
 *
 * @module lib/autopilot/tui
 */

import { loadSession } from './session-store.js';
import { readEvents } from './telemetry.js';
import { getSessionCost, renderCostInline } from './cost-tracker.js';

const ESC = '\x1b[';
const COLORS = Object.freeze({
  reset: `${ESC}0m`,
  bold: `${ESC}1m`,
  red: `${ESC}31m`,
  green: `${ESC}32m`,
  yellow: `${ESC}33m`,
  blue: `${ESC}34m`,
  magenta: `${ESC}35m`,
  cyan: `${ESC}36m`,
  gray: `${ESC}90m`,
});

const PHASE_ORDER = Object.freeze([
  'INTAKE', 'PLAN', 'EXECUTE', 'CROSS_CHECK',
  'VERIFY', 'IMPROVE', 'EVALUATE', 'REPORT',
]);

const BAR_WIDTH = 20;
const MIN_WIDTH = 60;
const MAX_QUEUE_PREVIEW = 3;
const MAX_RECENT_EVENTS = 5;
const NULL_LOAD_STOP_THRESHOLD = 3;

/**
 * Decide whether TUI should be active for a session.
 * Default ON. night mode = OFF. --no-tui or options.tui=false = OFF.
 * env.isTTY=false explicitly disables; undefined leaves default ON.
 *
 * @param {object} state - loadSession result
 * @param {{ isTTY?: boolean }} [env]
 * @returns {boolean}
 */
export function shouldActivateTui(state, env = {}) {
  if (!state) return false;
  if (state.mode === 'night') return false;
  if (state.options?.noTui === true) return false;
  if (state.options?.tui === false) return false;
  if (env && env.isTTY === false) return false;
  return true;
}

/**
 * Compute the canonical phase index (0..7) from a phase label.
 * Returns -1 for PAUSED/COMPLETED/ABORTED or unknown.
 * @param {string} phase
 * @returns {number}
 */
function phaseIndex(phase) {
  const idx = PHASE_ORDER.indexOf(phase);
  return idx;
}

/**
 * Count completed phases by inspecting state.phases[] for status='done'.
 * Falls back to phaseIndex when phases[] is missing.
 * @param {object} state
 * @returns {number}
 */
function countCompletedPhases(state) {
  const phases = Array.isArray(state?.phases) ? state.phases : [];
  let done = 0;
  for (const p of phases) {
    if (p && p.status === 'done') done += 1;
  }
  if (done === 0) {
    const idx = phaseIndex(state?.phase);
    return idx > 0 ? idx : 0;
  }
  return done;
}

/**
 * Build a progress bar string using either unicode or ASCII fallback.
 * @param {number} ratio - 0..1
 * @param {boolean} asciiOnly
 * @returns {string}
 */
function progressBar(ratio, asciiOnly) {
  const r = Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0));
  const filled = Math.round(r * BAR_WIDTH);
  const empty = BAR_WIDTH - filled;
  const fillChar = asciiOnly ? '#' : '\u2588'; // █
  const emptyChar = asciiOnly ? '-' : '\u2591'; // ░
  return `[${fillChar.repeat(filled)}${emptyChar.repeat(empty)}]`;
}

/**
 * Format ms as HH:MM:SS (UTC). Returns '--:--:--' on invalid.
 * @param {number} ms
 * @returns {string}
 */
function fmtElapsed(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '--:--:--';
  const totalSec = Math.floor(ms / 1000);
  const hh = String(Math.floor(totalSec / 3600)).padStart(2, '0');
  const mm = String(Math.floor((totalSec % 3600) / 60)).padStart(2, '0');
  const ss = String(totalSec % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

/**
 * Format ISO ts to HH:MM:SS for event log.
 * @param {string} ts
 * @returns {string}
 */
function fmtTs(ts) {
  if (typeof ts !== 'string') return '--:--:--';
  const t = Date.parse(ts);
  if (!Number.isFinite(t)) return '--:--:--';
  const d = new Date(t);
  return `${String(d.getUTCHours()).padStart(2, '0')}:`
    + `${String(d.getUTCMinutes()).padStart(2, '0')}:`
    + `${String(d.getUTCSeconds()).padStart(2, '0')}`;
}

/**
 * Format byte/token count as compact human string (1.2M / 950k / 42).
 * @param {number} n
 * @returns {string}
 */
function fmtCount(n) {
  if (!Number.isFinite(n) || n < 0) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

/**
 * Pick a color for a phase status.
 * @param {string} phase
 * @returns {string} ANSI color escape
 */
function colorForPhase(phase) {
  if (phase === 'COMPLETED') return COLORS.green;
  if (phase === 'PAUSED') return COLORS.red;
  if (phase === 'ABORTED') return COLORS.red;
  return COLORS.yellow;
}

/**
 * Pick a color for an event level.
 * @param {string} level
 * @returns {string}
 */
function colorForLevel(level) {
  if (level === 'error') return COLORS.red;
  if (level === 'warn') return COLORS.yellow;
  return COLORS.blue;
}

/**
 * Truncate a string to a max display width (best-effort, code points).
 * Adds a single-char ellipsis when truncated.
 * @param {string} s
 * @param {number} max
 * @returns {string}
 */
function truncate(s, max) {
  const str = typeof s === 'string' ? s : '';
  if (max <= 0) return '';
  if (str.length <= max) return str;
  if (max === 1) return str.slice(0, 1);
  return `${str.slice(0, max - 1)}\u2026`;
}

/**
 * Build the horizontal rule line with a centered label.
 * @param {string} label
 * @param {number} innerWidth - width between corners
 * @returns {string}
 */
function ruleLine(label, innerWidth) {
  const prefix = '\u251C\u2500 '; // ├─
  const suffix = ' ';
  const labelStr = label || '';
  const used = prefix.length + labelStr.length + suffix.length;
  const fillCount = Math.max(0, innerWidth - used);
  const fill = '\u2500'.repeat(fillCount); // ─
  return `${prefix}${labelStr}${suffix}${fill}\u2524`; // ┤
}

/**
 * Build a padded inner row "│ content │" (no color codes inside padding calc).
 * Color escapes do not consume terminal columns so we strip them for padding.
 * @param {string} content - may contain ANSI escapes
 * @param {number} innerWidth - width between corners
 * @returns {string}
 */
function row(content, innerWidth) {
  // Compute visible length by stripping ESC sequences.
  // eslint-disable-next-line no-control-regex
  const visible = String(content).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  const inner = innerWidth - 2; // 2 spaces of padding
  let body;
  if (visible.length > inner) {
    // truncate visible portion (best-effort: keep raw, slice by visible length)
    body = truncate(content, inner);
  } else {
    body = `${content}${' '.repeat(inner - visible.length)}`;
  }
  return `\u2502 ${body} \u2502`; // │ … │
}

/**
 * Compose the top border with centered title.
 * @param {string} title
 * @param {number} innerWidth
 * @returns {string}
 */
function topBorder(title, innerWidth) {
  const prefix = '\u250C\u2500 '; // ┌─
  const suffix = ' ';
  const used = prefix.length + title.length + suffix.length;
  const fillCount = Math.max(0, innerWidth - used);
  const fill = '\u2500'.repeat(fillCount);
  return `${prefix}${title}${suffix}${fill}\u2510`; // ┐
}

/**
 * Bottom border line.
 * @param {number} innerWidth
 * @returns {string}
 */
function bottomBorder(innerWidth) {
  return `\u2514${'\u2500'.repeat(innerWidth)}\u2518`; // └─…─┘
}

/**
 * Build the header row block (mode/phase/iter/elapsed).
 * @param {object} state
 * @param {number} innerWidth
 * @returns {string}
 */
function headerRow(state, innerWidth) {
  const mode = state?.mode || 'default';
  const phase = state?.phase || 'UNKNOWN';
  const phaseColor = colorForPhase(phase);
  const idx = phaseIndex(phase);
  const phaseLabel = idx >= 0 ? `${idx} ${phase}` : phase;
  const iter = Number.isFinite(state?.goalIterations) && state.goalIterations > 0
    ? String(state.goalIterations)
    : '-';
  const createdMs = state?.createdAt ? Date.parse(state.createdAt) : NaN;
  const elapsed = Number.isFinite(createdMs) ? Date.now() - createdMs : NaN;
  const content = `Mode: ${mode} \u2502 Phase: ${phaseColor}${phaseLabel}${COLORS.reset}`
    + ` \u2502 Iter: ${iter} \u2502 \u23F1 ${fmtElapsed(elapsed)}`;
  return row(content, innerWidth);
}

/**
 * Progress bar rows (phases + optional tokens).
 * @param {object} state
 * @param {{ used: number, budget: number }|undefined} tokenUsage
 * @param {number} innerWidth
 * @param {boolean} asciiOnly
 * @returns {string[]}
 */
function progressRows(state, tokenUsage, innerWidth, asciiOnly) {
  const rows = [];
  const done = countCompletedPhases(state);
  const total = PHASE_ORDER.length;
  const phasesLine = `Progress: ${progressBar(done / total, asciiOnly)} ${done}/${total} phases`;
  rows.push(row(phasesLine, innerWidth));
  if (tokenUsage && Number.isFinite(tokenUsage.used) && Number.isFinite(tokenUsage.budget)
    && tokenUsage.budget > 0) {
    const ratio = tokenUsage.used / tokenUsage.budget;
    const tokenLine = `Tokens:   ${progressBar(ratio, asciiOnly)} `
      + `${fmtCount(tokenUsage.used)} / ${fmtCount(tokenUsage.budget)}`;
    rows.push(row(tokenLine, innerWidth));
  }
  return rows;
}

/**
 * Build recent event rows.
 * @param {object[]} events
 * @param {number} innerWidth
 * @returns {string[]}
 */
function eventRows(events, innerWidth) {
  const list = Array.isArray(events) ? events.slice(-MAX_RECENT_EVENTS) : [];
  if (list.length === 0) {
    return [row(`${COLORS.gray}(no events yet)${COLORS.reset}`, innerWidth)];
  }
  return list.map((ev) => {
    const ts = fmtTs(ev?.ts);
    const phase = (ev?.phase || '-').padEnd(11, ' ').slice(0, 11);
    const level = (ev?.level || 'info').padEnd(5, ' ').slice(0, 5);
    const color = colorForLevel(ev?.level);
    const msg = typeof ev?.message === 'string' ? ev.message : '';
    const lineContent = `${ts} ${phase} ${color}${level}${COLORS.reset} ${msg}`;
    return row(lineContent, innerWidth);
  });
}

/**
 * Build queued-questions rows. Returns [] if none.
 * @param {object} state
 * @param {number} innerWidth
 * @returns {string[]}
 */
function queueRows(state, innerWidth) {
  const queued = Array.isArray(state?.queuedQuestions) ? state.queuedQuestions : [];
  if (queued.length === 0) return [];
  const rows = [ruleLine(`Queued Questions (${queued.length})`, innerWidth)];
  const preview = queued.slice(-MAX_QUEUE_PREVIEW);
  preview.forEach((q, i) => {
    const title = typeof q?.title === 'string' && q.title.length > 0
      ? q.title
      : typeof q?.body === 'string' ? q.body : '(unknown)';
    rows.push(row(`${i + 1}. ${title}`, innerWidth));
  });
  return rows;
}

/**
 * Render a single dashboard frame as ANSI-decorated string.
 * Pure function — no I/O, deterministic per (state, events) tuple at a given
 * Date.now() (which affects only the elapsed display).
 *
 * @param {{
 *   state: object,
 *   events?: object[],
 *   summary?: object,
 *   width?: number,
 *   tokenUsage?: { used: number, budget: number },
 *   costSummary?: object,
 *   asciiOnly?: boolean,
 * }} input
 * @returns {string} multi-line frame
 */
export function renderFrame(input = {}) {
  const state = input.state || {};
  const events = Array.isArray(input.events) ? input.events : [];
  const widthRaw = Number.isFinite(input.width) ? input.width : 80;
  const width = Math.max(40, Math.min(200, widthRaw));
  const compact = width < MIN_WIDTH;
  const asciiOnly = Boolean(input.asciiOnly);
  const innerWidth = width - 2; // exclude corner chars on the borders
  const title = `Autopilot Live \u2500 ${state?.sessionId || '-'}`;

  const lines = [];
  lines.push(topBorder(title, innerWidth));
  lines.push(headerRow(state, innerWidth));
  lines.push(ruleLine('', innerWidth));
  for (const r of progressRows(state, input.tokenUsage, innerWidth, asciiOnly)) {
    lines.push(r);
  }
  lines.push(ruleLine(`Recent Events (last ${MAX_RECENT_EVENTS})`, innerWidth));
  for (const r of eventRows(events, innerWidth)) {
    lines.push(r);
  }
  if (!compact) {
    for (const r of queueRows(state, innerWidth)) {
      lines.push(r);
    }
  }
  // Cost footer (one row when usage events exist; omitted otherwise).
  let costLine;
  try {
    costLine = renderCostInline(input.costSummary);
  } catch {
    costLine = '';
  }
  if (costLine) {
    lines.push(ruleLine('Cost', innerWidth));
    lines.push(row(costLine, innerWidth));
  }
  lines.push(bottomBorder(innerWidth));
  return lines.join('\n');
}

/**
 * Internal: detect terminal capability for current stream.
 * @param {NodeJS.WriteStream} stream
 * @returns {{ width: number, asciiOnly: boolean, isTTY: boolean }}
 */
function terminalCaps(stream) {
  const isTTY = Boolean(stream && stream.isTTY);
  const width = (stream && Number.isFinite(stream.columns) && stream.columns > 0)
    ? stream.columns
    : 80;
  const asciiOnly = process.platform === 'win32' && !process.env.WT_SESSION;
  return { width, asciiOnly, isTTY };
}

/**
 * Async live loop — clears terminal and renders frame every intervalMs.
 * Stops when signal aborts, when state.phase ∈ {COMPLETED,PAUSED,ABORTED},
 * or when loadSession returns null 3 times in a row.
 *
 * Best-effort: silently returns on TTY-less environments (tests/CI).
 *
 * @param {string} sessionId
 * @param {{ intervalMs?: number, signal?: AbortSignal, stream?: NodeJS.WriteStream,
 *           tokenUsage?: { used: number, budget: number } }} [opts]
 * @returns {Promise<void>}
 */
export async function runTuiLoop(sessionId, opts = {}) {
  if (!sessionId || typeof sessionId !== 'string') return;
  const stream = opts.stream || process.stdout;
  const caps = terminalCaps(stream);
  if (!caps.isTTY) return;
  const intervalMs = Number.isFinite(opts.intervalMs) ? Math.max(50, opts.intervalMs) : 1000;
  const signal = opts.signal;

  // Cursor hide.
  try { stream.write(`${ESC}?25l`); } catch { /* ignore */ }

  let nullLoadStreak = 0;
  let lastFrame = '';
  try {
    // Loop runs at least once so a quick-exit (COMPLETED) still paints.
    for (;;) {
      if (signal && signal.aborted) break;
      const state = loadSession(sessionId);
      if (!state) {
        nullLoadStreak += 1;
        if (nullLoadStreak >= NULL_LOAD_STOP_THRESHOLD) break;
      } else {
        nullLoadStreak = 0;
      }
      const events = readEvents(sessionId, { tail: MAX_RECENT_EVENTS });
      const frame = renderFrame({
        state: state || { sessionId, phase: 'UNKNOWN', mode: 'default' },
        events,
        width: caps.width,
        asciiOnly: caps.asciiOnly,
        tokenUsage: opts.tokenUsage,
      });
      // Clear + home, then write frame.
      try { stream.write(`${ESC}2J${ESC}H${frame}\n`); } catch { /* ignore */ }
      lastFrame = frame;
      const terminalPhases = new Set(['COMPLETED', 'PAUSED', 'ABORTED']);
      if (state && terminalPhases.has(state.phase)) break;
      // Sleep with abort support.
      await new Promise((resolve) => {
        const t = setTimeout(resolve, intervalMs);
        if (signal) {
          const onAbort = () => { clearTimeout(t); resolve(); };
          signal.addEventListener('abort', onAbort, { once: true });
        }
      });
    }
  } finally {
    // Restore cursor; keep final frame on screen.
    try { stream.write(`${ESC}?25h\n`); } catch { /* ignore */ }
  }
  // Touch lastFrame so the linter knows it's intentionally captured (final-frame
  // contract for callers that peek at the rendered output via mock streams).
  void lastFrame;
}
