/**
 * Run events — append-only NDJSON event log shared by every kind of "run".
 *
 * Promoted from `lib/autopilot/telemetry.js` (2026-08-26, PRD
 * split-cross-session-multi-worktree Phase 5). The autopilot module kept its
 * public surface (`appendEvent` / `readEvents` / `getEventsPath`) and now
 * delegates here; the only thing that moved is the store-dir-agnostic core so a
 * second run kind can write the *same line shape* into its own directory.
 *
 * Consumers (a promotion with no second consumer is the `lib/orchestration/`
 * mistake this PRD forbids repeating — keep both listed and both real):
 *   - `lib/autopilot/telemetry.js`            autopilot sessions, `runtime/autopilot/`
 *   - `lib/observability/split-telemetry.js`  `/split` runs,      `runtime/split/`
 *
 * Line shape is byte-identical to what autopilot has always written, so
 * `lib/autopilot/replay.js` (`findUnterminatedPhases`, `summarizeEvents`) reads
 * either stream without knowing which produced it:
 *
 *   { ts, sessionId, phase, type, level, message, data? }
 *
 * The id field is spelled `sessionId` for every run kind — a `/split` run id
 * goes there too. Renaming it per kind would fork the reader; the name is the
 * contract, not the semantics.
 *
 * DATA POLICY: 100% local file; no external transmission.
 * Korean-path safe (path.join, UTF-8).
 *
 * Public surface:
 *   - RUN_EVENTS_SUFFIX
 *   - resolveRunEventsPath(storeDir, runId)
 *   - normalizeRunEvent(runId, event)
 *   - appendRunEvent(storeDir, runId, event)
 *   - parseRunEventsText(raw)
 *   - readRunEvents(storeDir, runId, { tail, level })
 *
 * @module lib/observability/run-events
 */

import path from 'node:path';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { ensureDirSync } from '../core/file.js';

export const RUN_EVENTS_SUFFIX = '.events.ndjson';

/**
 * @param {unknown} runId
 * @returns {asserts runId is string}
 */
function assertRunId(runId) {
  if (!runId || typeof runId !== 'string') {
    throw new TypeError('runId must be a non-empty string');
  }
}

/**
 * @param {unknown} storeDir
 * @returns {asserts storeDir is string}
 */
function assertStoreDir(storeDir) {
  if (!storeDir || typeof storeDir !== 'string') {
    throw new TypeError('storeDir must be a non-empty string');
  }
}

/**
 * Resolve the absolute ndjson path for a run inside `storeDir`.
 * @param {string} storeDir
 * @param {string} runId
 * @returns {string}
 */
export function resolveRunEventsPath(storeDir, runId) {
  assertStoreDir(storeDir);
  assertRunId(runId);
  return path.join(storeDir, `${runId}${RUN_EVENTS_SUFFIX}`);
}

/**
 * Build a normalized event line; missing fields are filled with safe defaults.
 * Identical to the former `telemetry.js#normalizeEvent` — field order included,
 * because the on-disk line is what humans diff.
 *
 * @param {string} runId
 * @param {object} event
 * @returns {{ ts: string, sessionId: string, phase: string|null, type: string,
 *   level: 'info'|'warn'|'error', message: string, data?: unknown }}
 */
export function normalizeRunEvent(runId, event) {
  assertRunId(runId);
  const e = event && typeof event === 'object' ? event : {};
  const level = e.level === 'warn' || e.level === 'error' ? e.level : 'info';
  const out = {
    ts: typeof e.ts === 'string' ? e.ts : new Date().toISOString(),
    sessionId: runId,
    phase: typeof e.phase === 'string' ? e.phase : null,
    type: typeof e.type === 'string' ? e.type : 'log',
    level,
    message: typeof e.message === 'string' ? e.message : '',
  };
  if (e.data !== undefined) out.data = e.data;
  return out;
}

/**
 * Append one event as a JSON line. Best-effort atomic at the OS level
 * (single write() call from Node fs.appendFileSync).
 *
 * @param {string} storeDir
 * @param {string} runId
 * @param {object} event - { phase, type, level, message, data?, ts? }
 * @returns {object} the persisted event
 */
export function appendRunEvent(storeDir, runId, event) {
  const filePath = resolveRunEventsPath(storeDir, runId);
  ensureDirSync(path.dirname(filePath));
  const normalized = normalizeRunEvent(runId, event);
  appendFileSync(filePath, `${JSON.stringify(normalized)}\n`, 'utf-8');
  return normalized;
}

/**
 * Parse a single ndjson line; returns null on malformed input.
 * @param {string} line
 * @returns {object|null}
 */
function parseLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/**
 * Parse NDJSON text into events. Blank and malformed lines are skipped, never
 * fatal — a torn last line from a crashed writer must not hide the lines
 * before it.
 *
 * @param {string} raw
 * @returns {object[]}
 */
export function parseRunEventsText(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return [];
  const events = [];
  for (const line of raw.split('\n')) {
    const parsed = parseLine(line);
    if (parsed) events.push(parsed);
  }
  return events;
}

/**
 * Read events for a run. Missing file returns []. Malformed lines are skipped.
 *
 * @param {string} storeDir
 * @param {string} runId
 * @param {{ tail?: number, level?: 'info'|'warn'|'error' }} [opts]
 * @returns {object[]}
 */
export function readRunEvents(storeDir, runId, opts = {}) {
  const filePath = resolveRunEventsPath(storeDir, runId);
  if (!existsSync(filePath)) return [];
  let raw;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }
  let filtered = parseRunEventsText(raw);
  if (opts && typeof opts.level === 'string') {
    filtered = filtered.filter((e) => e.level === opts.level);
  }
  if (opts && Number.isInteger(opts.tail) && opts.tail > 0) {
    return filtered.slice(-opts.tail);
  }
  return filtered;
}
