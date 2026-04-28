/**
 * Live telemetry for autopilot sessions (PRD v4.1 P0-2).
 *
 * Append-only ndjson stream per session:
 *   runtime/autopilot/<sessionId>.events.ndjson
 *
 * DATA POLICY: 100% local file; no external transmission.
 * Korean-path safe (uses path.join, UTF-8 encoding).
 *
 * Public surface:
 *   - appendEvent(sessionId, event)
 *   - readEvents(sessionId, { tail, level })
 *   - tailEventsStream(sessionId, { intervalMs, signal })
 *   - getEventsPath(sessionId)
 *
 * @module lib/autopilot/telemetry
 */

import path from 'node:path';
import {
  appendFileSync,
  existsSync,
  readFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { ensureDirSync } from '../core/file.js';
import { getStoreDir } from './session-store.js';

/**
 * Resolve absolute ndjson path for a session.
 * @param {string} sessionId
 * @returns {string}
 */
export function getEventsPath(sessionId) {
  if (!sessionId || typeof sessionId !== 'string') {
    throw new TypeError('sessionId must be a non-empty string');
  }
  return path.join(getStoreDir(), `${sessionId}.events.ndjson`);
}

/**
 * Build a normalized event line; missing fields are filled with safe defaults.
 * @param {string} sessionId
 * @param {object} event
 * @returns {object}
 */
function normalizeEvent(sessionId, event) {
  const e = event && typeof event === 'object' ? event : {};
  const level = e.level === 'warn' || e.level === 'error' ? e.level : 'info';
  const out = {
    ts: typeof e.ts === 'string' ? e.ts : new Date().toISOString(),
    sessionId,
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
 * @param {string} sessionId
 * @param {object} event - { phase, type, level, message, data? }
 * @returns {object} the persisted event
 */
export function appendEvent(sessionId, event) {
  if (!sessionId || typeof sessionId !== 'string') {
    throw new TypeError('sessionId must be a non-empty string');
  }
  const filePath = getEventsPath(sessionId);
  ensureDirSync(dirname(filePath));
  const normalized = normalizeEvent(sessionId, event);
  const line = `${JSON.stringify(normalized)}\n`;
  appendFileSync(filePath, line, 'utf-8');
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
 * Read events for a session.
 * Missing file returns []. Malformed lines are skipped.
 * @param {string} sessionId
 * @param {{ tail?: number, level?: 'info'|'warn'|'error' }} [opts]
 * @returns {object[]}
 */
export function readEvents(sessionId, opts = {}) {
  const filePath = getEventsPath(sessionId);
  if (!existsSync(filePath)) return [];
  let raw;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }
  const lines = raw.split('\n');
  const events = [];
  for (const line of lines) {
    const parsed = parseLine(line);
    if (parsed) events.push(parsed);
  }
  let filtered = events;
  if (opts && typeof opts.level === 'string') {
    filtered = filtered.filter((e) => e.level === opts.level);
  }
  if (opts && Number.isInteger(opts.tail) && opts.tail > 0) {
    return filtered.slice(-opts.tail);
  }
  return filtered;
}

/**
 * Async iterator that yields newly appended events.
 * Polls every `intervalMs` (default 1000). Stops when `signal` aborts.
 * Skips already-seen lines via line count tracking.
 *
 * @param {string} sessionId
 * @param {{ intervalMs?: number, signal?: AbortSignal, fromStart?: boolean }} [opts]
 * @returns {AsyncIterableIterator<object>}
 */
export async function* tailEventsStream(sessionId, opts = {}) {
  const intervalMs = Number.isFinite(opts.intervalMs) ? Math.max(50, opts.intervalMs) : 1000;
  const signal = opts.signal;
  let cursor = opts.fromStart ? 0 : readEvents(sessionId).length;
  while (!(signal && signal.aborted)) {
    const all = readEvents(sessionId);
    if (all.length > cursor) {
      const fresh = all.slice(cursor);
      cursor = all.length;
      for (const ev of fresh) yield ev;
    }
    await new Promise((resolve) => {
      const t = setTimeout(resolve, intervalMs);
      if (signal) {
        const onAbort = () => { clearTimeout(t); resolve(); };
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }
}
