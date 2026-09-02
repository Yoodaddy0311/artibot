/**
 * Supervisor event vocabulary — the allowlist the reducer accepts.
 *
 * Two families of events reach the supervisor reducer:
 *
 *   1. **Supervisor envelopes** (design §05 "새 이벤트 후보", schema
 *      `contracts/event-envelope.schema.json`). Written by
 *      `lib/supervisor/run-store.js#appendEvent` into
 *      `runtime/split/{runId}.supervisor.ndjson`. Shape:
 *      `{ version:1, eventId, ts, runId, laneId, type, source, actionId, evidenceRef, data }`.
 *
 *   2. **Split telemetry lines** already written by
 *      `lib/observability/split-telemetry.js` (RECORD-ONLY contract, not
 *      modified here) into `runtime/split/{runId}.events.ndjson`. Shape:
 *      `{ ts, sessionId, phase, type, level, message, data? }`. The reducer
 *      consumes them read-only to derive a run state from runs that predate
 *      the supervisor (see `state-reducer.js` "telemetry mapping").
 *
 * Anything outside {@link SUPERVISOR_EVENT_TYPES} ∪ {@link TELEMETRY_EVENT_TYPES}
 * is *unknown*: the reducer records a warning and performs no transition
 * (PR-SV01 acceptance "unknown event fail-safe"). Adding a type here without
 * teaching the reducer what it means makes it "known but inert", which is the
 * same observable behaviour minus the warning — so add both or neither.
 *
 * @module lib/supervisor/event-types
 */

/** Design §05 event vocabulary, verbatim and in design order. */
export const SUPERVISOR_EVENT_TYPES = Object.freeze([
  'run-created',
  'run-state-changed',
  'lane-created',
  'lane-state-changed',
  'lane-heartbeat',
  'lane-progress',
  'worker-attached',
  'worker-detached',
  'context-pressure',
  'checkpoint-written',
  'checkpoint-restored',
  'review-requested',
  'review-result',
  'retry-scheduled',
  'budget-warning',
  'budget-exhausted',
  'human-required',
  'human-resolved',
  'gate-started',
  'gate-result',
]);

/**
 * `source` enum from `contracts/event-envelope.schema.json`. Who emitted the
 * event; the reducer does not weight sources differently today, but the
 * value is validated so a later policy can.
 */
export const SOURCES = Object.freeze([
  'human',
  'supervisor',
  'worker',
  'reviewer',
  'hook',
  'git',
  'gate',
  'scheduler',
]);

/**
 * Event types `lib/observability/split-telemetry.js` writes today. Listed by
 * name (not imported) on purpose: that module exports only the four
 * phase/wall-clock constants and the fast-profile types are string literals
 * inside `recordFastProfilePlanned`. The firewall
 * `tests/firewall/split-telemetry-wallclock.test.js` pins that module; this
 * list is checked against it by `tests/supervisor/event-types.test.js`.
 */
export const TELEMETRY_EVENT_TYPES = Object.freeze([
  'phase-start',
  'phase-end',
  'wall-clock-start',
  'wall-clock-end',
  'fast-profile-planned',
  'fast-profile-reused',
]);

const SUPERVISOR_SET = new Set(SUPERVISOR_EVENT_TYPES);
const TELEMETRY_SET = new Set(TELEMETRY_EVENT_TYPES);

/**
 * Is `type` a supervisor envelope type?
 * @param {unknown} type
 * @returns {boolean}
 */
export function isSupervisorEvent(type) {
  return typeof type === 'string' && SUPERVISOR_SET.has(type);
}

/**
 * Is `type` one of the split-telemetry line types the reducer can consume?
 * @param {unknown} type
 * @returns {boolean}
 */
export function isTelemetryEvent(type) {
  return typeof type === 'string' && TELEMETRY_SET.has(type);
}

/**
 * Is `type` anything the reducer knows how to handle (either family)?
 * @param {unknown} type
 * @returns {boolean}
 */
export function isKnownEvent(type) {
  return isSupervisorEvent(type) || isTelemetryEvent(type);
}
