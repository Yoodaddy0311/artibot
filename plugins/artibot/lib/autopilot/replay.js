/**
 * Autopilot session replay — aggregates events.ndjson into phase-level timeline.
 *
 * Used by:
 *   - Phase 6 REPORT generator (auto-inject timeline table)
 *   - `/autopilot:replay <sid>` subcommand (past-session query)
 *
 * DATA POLICY: pure local read of telemetry ndjson; no external calls.
 * Korean-path safe (delegates to telemetry.readEvents).
 *
 * Public surface:
 *   - summarizeSession(sessionId)
 *   - renderTimelineTable(summary)
 *   - findUnterminatedPhases(events)
 *
 * @module lib/autopilot/replay
 */

import { readEvents } from './telemetry.js';

const BOTTLENECK_THRESHOLD = 0.4;

/**
 * Parse ISO timestamp to milliseconds. Returns NaN on invalid.
 * @param {string} ts
 * @returns {number}
 */
function tsToMs(ts) {
  if (typeof ts !== 'string') return NaN;
  const n = Date.parse(ts);
  return Number.isFinite(n) ? n : NaN;
}

/**
 * Format a duration in ms as compact human string (e.g. "2m 14s", "350ms").
 * @param {number} ms
 * @returns {string}
 */
function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '-';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m === 0) return `${s}s`;
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

/**
 * Format ISO timestamp as HH:MM:SS in UTC (locale-agnostic, deterministic for tests).
 * @param {string} ts
 * @returns {string}
 */
function fmtTime(ts) {
  const ms = tsToMs(ts);
  if (!Number.isFinite(ms)) return '-';
  const d = new Date(ms);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

/**
 * Detect whether an event represents a retry signal.
 * @param {object} ev
 * @returns {boolean}
 */
function isRetry(ev) {
  if (!ev || typeof ev !== 'object') return false;
  if (ev.type === 'retry') return true;
  if (ev.level === 'warn' && typeof ev.message === 'string'
    && /retry/i.test(ev.message)) return true;
  return false;
}

/**
 * Pop the most recent open entry with the given phase name. No-op when none
 * is found, so an orphaned `phase-end` is treated as data drift, not an error.
 *
 * @param {Array<{phase: string}>} open
 * @param {string} phase
 * @returns {void}
 */
function popMatchingPhase(open, phase) {
  for (let i = open.length - 1; i >= 0; i -= 1) {
    if (open[i].phase === phase) {
      open.splice(i, 1);
      return;
    }
  }
}

/**
 * Return the phase windows that were opened by a `phase-start` and never
 * closed by a matching `phase-end` — i.e. the phases a crashed process died
 * inside. Order is chronological, so the last element is the innermost /
 * most recent open phase.
 *
 * **Single owner of phase-start/phase-end pairing.** This used to live in
 * `_engine-helpers.js#walkTimelinePending`, reading `state.timeline` — a
 * field with zero production writers, which made the crash detector a
 * permanent `{interrupted:false}` fail-open. The real phase record has always
 * been the NDJSON event log this module already reads, so the pairing walk now
 * lives next to it and `_engine-helpers` consumes it instead of keeping a
 * second copy.
 *
 * Pairing is LIFO by phase name (a `phase-end` closes the most recent open
 * window of the same phase), which preserves the previous detector's nesting
 * behaviour. Production never nests phases — each `runPhaseN` emits its start
 * and end in one call — so LIFO vs. flat only matters for hand-built input.
 *
 * Note this is deliberately NOT {@link groupByPhase}: that one slices events
 * into windows for the report table and emits a row for every window whether
 * or not it closed. Only this function decides "still open".
 *
 * Never throws: non-array input yields `[]`, malformed entries are skipped.
 *
 * @param {object[]} events - Raw events from `telemetry.readEvents`.
 * @returns {Array<{phase: string, startedAt: string|null}>}
 */
export function findUnterminatedPhases(events) {
  if (!Array.isArray(events)) return [];
  const open = [];
  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue;
    const phase = typeof ev.phase === 'string' && ev.phase ? ev.phase : null;
    if (!phase) continue;
    if (ev.type === 'phase-start') {
      open.push({ phase, startedAt: typeof ev.ts === 'string' ? ev.ts : null });
    } else if (ev.type === 'phase-end') {
      popMatchingPhase(open, phase);
    }
  }
  return open;
}

/**
 * Group consecutive events sharing the same phase into windows.
 * `phase-start` opens a new window even if the prior phase was identical.
 * @param {object[]} events
 * @returns {Array<{phase: string, events: object[]}>}
 */
function groupByPhase(events) {
  const groups = [];
  let current = null;
  for (const ev of events) {
    const phase = ev.phase || 'UNKNOWN';
    const isStart = ev.type === 'phase-start';
    if (!current || current.phase !== phase || isStart) {
      current = { phase, events: [], opened: isStart, closed: false };
      groups.push(current);
    }
    current.events.push(ev);
    if (ev.type === 'phase-end') {
      // close the window so subsequent same-phase events start a new group
      current.closed = true;
      current = null;
    }
  }
  return groups;
}

/**
 * Build a phase summary entry from a grouped window.
 * @param {{phase: string, events: object[]}} group
 * @returns {object}
 */
function buildPhaseEntry(group) {
  const evs = group.events;
  const first = evs[0];
  const last = evs[evs.length - 1];
  const startMs = tsToMs(first?.ts);
  const endMs = tsToMs(last?.ts);
  const durationMs = Number.isFinite(startMs) && Number.isFinite(endMs)
    ? Math.max(0, endMs - startMs)
    : 0;
  let warnings = 0;
  let errors = 0;
  let retries = 0;
  for (const ev of evs) {
    if (ev.level === 'warn') warnings += 1;
    if (ev.level === 'error') errors += 1;
    if (isRetry(ev)) retries += 1;
  }
  // A window opened by `phase-start` and never closed is still running (or the
  // process died in it). Its "duration" is the gap between its own first and
  // last event, which for a hand-off phase like EXECUTE is ~0 — the real work
  // happens after the last event this session recorded. Reporting that 0 as a
  // measured duration is what let a stalled EXECUTE lose the bottleneck
  // ranking to a phase that merely took longer to *log*.
  const unterminated = group.opened === true && group.closed !== true;
  return {
    phase: group.phase,
    startedAt: typeof first?.ts === 'string' ? first.ts : null,
    endedAt: unterminated ? null : (typeof last?.ts === 'string' ? last.ts : null),
    durationMs,
    unterminated,
    events: evs.length,
    warnings,
    errors,
    retries,
    bottleneck: false,
  };
}

/**
 * Compute totalDurationMs across all phases (first ts → last ts).
 * @param {object[]} events
 * @returns {number}
 */
function computeTotalDuration(events) {
  if (!events.length) return 0;
  const firstMs = tsToMs(events[0].ts);
  const lastMs = tsToMs(events[events.length - 1].ts);
  if (!Number.isFinite(firstMs) || !Number.isFinite(lastMs)) return 0;
  return Math.max(0, lastMs - firstMs);
}

/**
 * Summarize a session by aggregating events.ndjson into phase-level timeline.
 * Returns empty result if events file is missing or empty.
 *
 * @param {string} sessionId
 * @returns {{
 *   sessionId: string,
 *   totalDurationMs: number,
 *   phases: Array<{
 *     phase: string, startedAt: string|null, endedAt: string|null, durationMs: number,
 *     events: number, warnings: number, errors: number,
 *     retries: number, bottleneck: boolean
 *   }>,
 *   topBottleneck: string|null
 * }}
 */
export function summarizeSession(sessionId) {
  if (!sessionId || typeof sessionId !== 'string') {
    return { sessionId: '', totalDurationMs: 0, phases: [], topBottleneck: null };
  }
  let events;
  try {
    events = readEvents(sessionId);
  } catch {
    events = null;
  }
  if (!Array.isArray(events) || events.length === 0) {
    return { sessionId, totalDurationMs: 0, phases: [], topBottleneck: null };
  }
  const totalDurationMs = computeTotalDuration(events);
  const groups = groupByPhase(events);
  const phases = groups.map(buildPhaseEntry);

  let topPhase = null;
  let topDuration = 0;
  for (const p of phases) {
    // Unterminated windows carry no measured duration, so they take no part in
    // the bottleneck ranking. Including them let a 0ms stalled phase win or
    // lose the comparison on a number that was never a measurement.
    if (p.unterminated) continue;
    if (totalDurationMs > 0
      && p.durationMs / totalDurationMs >= BOTTLENECK_THRESHOLD) {
      p.bottleneck = true;
    }
    if (p.durationMs > topDuration) {
      topDuration = p.durationMs;
      topPhase = p.phase;
    }
  }
  return {
    sessionId,
    totalDurationMs,
    phases,
    topBottleneck: topPhase,
  };
}

/**
 * Render summary as GFM markdown table string.
 * Returns a brief "no data" stub if the summary has no phases.
 *
 * @param {object} summary - output of summarizeSession
 * @returns {string} markdown
 */
export function renderTimelineTable(summary) {
  const s = summary && typeof summary === 'object' ? summary : {};
  const phases = Array.isArray(s.phases) ? s.phases : [];
  const header = '## Phase Timeline (auto-generated from events.ndjson)';
  if (phases.length === 0) {
    return `${header}\n\n_(timeline 데이터 없음 — events.ndjson 비어있거나 파일 없음)_`;
  }
  const head = '| Phase | 시작 | 소요 | 이벤트 | warn | error | retry | bottleneck |';
  const sep = '|---|---|---|---|---|---|---|---|';
  const rows = phases.map((p) => {
    const flag = p.bottleneck ? '⚠' : '-';
    // `진행중`, not `0ms`: the phase never reported completion, so no duration
    // was measured. Printing 0ms reads as "instant", the opposite of the truth.
    const duration = p.unterminated ? '진행중' : fmtDuration(p.durationMs);
    return `| ${p.phase} | ${fmtTime(p.startedAt)} | ${duration} | `
      + `${p.events} | ${p.warnings} | ${p.errors} | ${p.retries} | ${flag} |`;
  });
  const total = s.totalDurationMs || 0;
  let footer = '';
  if (s.topBottleneck && total > 0) {
    const top = phases.find((p) => p.phase === s.topBottleneck);
    if (top) {
      const pct = Math.round((top.durationMs / total) * 100);
      footer = `\n\nTop bottleneck: **${s.topBottleneck}** (${fmtDuration(top.durationMs)}, ${pct}% of total)`;
    }
  }
  return `${header}\n\n${[head, sep, ...rows].join('\n')}${footer}`;
}
