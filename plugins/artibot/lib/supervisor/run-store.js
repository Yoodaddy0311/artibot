/**
 * Run store — append supervisor events, rebuild derived state (PR-SV02).
 *
 * Files, all under the split store dir (`runtime/split/` by default —
 * `lib/observability/split-telemetry.js#getSplitStoreDir`, honoured so tests
 * can point everything at a temp dir):
 *
 *   `{runId}.events.ndjson`      split telemetry — READ ONLY here. Owned by
 *                                `split-telemetry.js` (record-only contract,
 *                                firewall-guarded). This module never writes it.
 *   `{runId}.supervisor.ndjson`  supervisor envelopes — appended by `appendEvent`.
 *   `{runId}.state.json`         derived state — rewritten atomically by
 *                                `rebuildState`. A cache: delete it and
 *                                `rebuildState` produces a deep-equal file from
 *                                the two ndjson streams (acceptance invariant 4).
 *
 * Idempotency (design §05): an envelope carrying `actionId` is appended at
 * most once per run. A second append with the same `actionId` returns
 * `{ appended: false, duplicate: true }` and writes nothing. `eventId` is a
 * random UUID when the caller does not supply one — identity of an *event*
 * is not derived from content because two genuinely separate heartbeats can
 * be byte-identical.
 *
 * Readers never throw: missing files read as empty, torn lines are skipped.
 * `appendEvent` returns `{ appended:false, errors }` for an invalid envelope
 * rather than throwing, so a supervisor loop cannot be killed by one bad
 * emitter.
 *
 * @module lib/supervisor/run-store
 */

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { atomicWriteJsonSync, ensureDirSync, readJsonFileSync } from '../core/file.js';
import { getSplitStoreDir, readSplitEvents } from '../observability/split-telemetry.js';
import { validateEvent } from './contracts.js';
import { reduce } from './state-reducer.js';

export const SUPERVISOR_EVENTS_SUFFIX = '.supervisor.ndjson';
export const STATE_SUFFIX = '.state.json';

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
 * @param {string} runId
 * @param {{ storeDir?: string }} [opts]
 * @returns {string}
 */
export function getSupervisorEventsPath(runId, opts = {}) {
  assertRunId(runId);
  return path.join(getSplitStoreDir(opts), `${runId}${SUPERVISOR_EVENTS_SUFFIX}`);
}

/**
 * @param {string} runId
 * @param {{ storeDir?: string }} [opts]
 * @returns {string}
 */
export function getStatePath(runId, opts = {}) {
  assertRunId(runId);
  return path.join(getSplitStoreDir(opts), `${runId}${STATE_SUFFIX}`);
}

/**
 * Parse NDJSON text; blank and malformed lines are skipped (a torn last line
 * from a crashed writer must not hide the lines before it).
 *
 * @param {string} raw
 * @returns {object[]}
 */
export function parseNdjson(raw) {
  if (typeof raw !== 'string' || !raw) return [];
  const out = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const v = JSON.parse(t);
      if (v && typeof v === 'object') out.push(v);
    } catch {
      // skip
    }
  }
  return out;
}

/**
 * Read the supervisor envelope stream for a run. Missing file → `[]`.
 *
 * @param {string} runId
 * @param {{ storeDir?: string }} [opts]
 * @returns {object[]}
 */
export function readSupervisorEvents(runId, opts = {}) {
  const file = getSupervisorEventsPath(runId, opts);
  if (!existsSync(file)) return [];
  try {
    return parseNdjson(readFileSync(file, 'utf-8'));
  } catch {
    return [];
  }
}

/**
 * Fill envelope defaults without overwriting what the caller set. Key order
 * follows the schema so the on-disk line reads the same for every emitter.
 *
 * @param {string} runId
 * @param {object} envelope
 * @param {{ now?: string }} [opts]
 * @returns {object}
 */
export function normalizeEnvelope(runId, envelope, opts = {}) {
  const e = envelope && typeof envelope === 'object' ? envelope : {};
  const out = {
    version: e.version === undefined ? 1 : e.version,
    eventId: typeof e.eventId === 'string' && e.eventId ? e.eventId : randomUUID(),
    ts: typeof e.ts === 'string' ? e.ts : (typeof opts.now === 'string' ? opts.now : new Date().toISOString()),
    runId: e.runId === undefined ? runId : e.runId,
    laneId: e.laneId === undefined ? null : e.laneId,
    type: e.type,
    source: e.source === undefined ? 'supervisor' : e.source,
    actionId: e.actionId === undefined ? null : e.actionId,
    evidenceRef: e.evidenceRef === undefined ? null : e.evidenceRef,
  };
  if (e.data !== undefined) out.data = e.data;
  for (const key of Object.keys(e)) {
    if (!(key in out)) out[key] = e[key]; // surfaces unknown keys to validateEvent
  }
  return out;
}

/**
 * Append one supervisor envelope to `{runId}.supervisor.ndjson`.
 *
 * @param {string} runId
 * @param {object} envelope - partial envelope; `type` required, the rest defaulted
 * @param {{ storeDir?: string, now?: string }} [opts]
 * @returns {{ appended: boolean, duplicate?: boolean, event?: object, existing?: object, errors?: string[] }}
 */
export function appendEvent(runId, envelope, opts = {}) {
  assertRunId(runId);
  const event = normalizeEnvelope(runId, envelope, opts);
  const check = validateEvent(event);
  if (!check.ok) return { appended: false, errors: check.errors };
  if (event.runId !== runId) {
    return { appended: false, errors: [`envelope runId ${JSON.stringify(event.runId)} != ${runId}`] };
  }
  if (typeof event.actionId === 'string' && event.actionId) {
    const existing = readSupervisorEvents(runId, opts).find((e) => e.actionId === event.actionId);
    if (existing) return { appended: false, duplicate: true, existing };
  }
  const file = getSupervisorEventsPath(runId, opts);
  ensureDirSync(path.dirname(file));
  appendFileSync(file, `${JSON.stringify(event)}\n`, 'utf-8');
  return { appended: true, event };
}

/**
 * @param {unknown} ts
 * @returns {number}
 */
function tsKey(ts) {
  const n = typeof ts === 'string' ? Date.parse(ts) : NaN;
  return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY; // unparseable sorts last, file order kept
}

/**
 * Merge the telemetry stream and the supervisor stream for a run, sorted by
 * `ts` (stable: equal or unparseable timestamps keep their read order,
 * telemetry first). Neither file is modified; event objects are returned as
 * parsed.
 *
 * @param {string} runId
 * @param {{ storeDir?: string }} [opts]
 * @returns {object[]}
 */
export function readAllEvents(runId, opts = {}) {
  assertRunId(runId);
  const merged = [...readSplitEvents(runId, opts), ...readSupervisorEvents(runId, opts)];
  return merged
    .map((ev, i) => ({ ev, i, k: tsKey(ev?.ts) }))
    .sort((a, b) => (a.k - b.k) || (a.i - b.i))
    .map((x) => x.ev);
}

/**
 * Read the cached derived state. `null` when absent or unreadable.
 *
 * @param {string} runId
 * @param {{ storeDir?: string }} [opts]
 * @returns {object|null}
 */
export function readState(runId, opts = {}) {
  return readJsonFileSync(getStatePath(runId, opts), null);
}

/**
 * Replay both streams through the reducer and atomically rewrite
 * `{runId}.state.json` (tmp + rename via `lib/core/file.js#atomicWriteJsonSync`).
 * The file holds ONLY the state (schema shape); warnings are returned, not
 * persisted, so the cache stays byte-comparable across rebuilds.
 *
 * This is the one write a read-only observer (`scripts/split/watch.mjs`)
 * performs. It is a cache of the two append-only streams and can be deleted
 * at any time.
 *
 * @param {string} runId
 * @param {{ storeDir?: string, now?: string }} [opts]
 * @returns {{ state: object, warnings: object[], events: number, path: string }}
 */
export function rebuildState(runId, opts = {}) {
  assertRunId(runId);
  const events = readAllEvents(runId, opts);
  const { state, warnings } = reduce(events, { runId, now: opts.now });
  const file = getStatePath(runId, opts);
  atomicWriteJsonSync(file, state);
  return { state, warnings, events: events.length, path: file };
}
