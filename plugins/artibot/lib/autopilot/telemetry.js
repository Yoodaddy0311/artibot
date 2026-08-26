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

import { getStoreDir } from './session-store.js';
import {
  appendRunEvent,
  readRunEvents,
  resolveRunEventsPath,
} from '../observability/run-events.js';

// The store-dir-agnostic core (normalize / append / read) was promoted to
// `lib/observability/run-events.js` on 2026-08-26 so `/split` can write the
// same line shape into `runtime/split/`. This module is the autopilot binding:
// it supplies the store dir and keeps the historical names. Nothing about the
// on-disk line changed — `replay.js` reads both streams unmodified.

/**
 * Resolve absolute ndjson path for a session.
 * @param {string} sessionId
 * @returns {string}
 */
export function getEventsPath(sessionId) {
  if (!sessionId || typeof sessionId !== 'string') {
    throw new TypeError('sessionId must be a non-empty string');
  }
  return resolveRunEventsPath(getStoreDir(), sessionId);
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
  return appendRunEvent(getStoreDir(), sessionId, event);
}

/**
 * Read events for a session.
 * Missing file returns []. Malformed lines are skipped.
 * @param {string} sessionId
 * @param {{ tail?: number, level?: 'info'|'warn'|'error' }} [opts]
 * @returns {object[]}
 */
export function readEvents(sessionId, opts = {}) {
  if (!sessionId || typeof sessionId !== 'string') {
    throw new TypeError('sessionId must be a non-empty string');
  }
  return readRunEvents(getStoreDir(), sessionId, opts);
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
