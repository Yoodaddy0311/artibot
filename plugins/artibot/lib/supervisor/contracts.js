/**
 * Supervisor contracts — state vocabularies and validators.
 *
 * Mirrors the JSON schemas under
 * `docs/artibot-vnext-autonomous-runtime-design-v1.0/artibot-vnext-design/contracts/`
 * (`event-envelope`, `run-state`, `lane-state`). The shapes are kept here as
 * code + JSDoc rather than as `schemas/supervisor/*.json` because no gate
 * scans `schemas/` (measured 2026-09-02: `rg -n "schemas" tests/firewall
 * scripts/ci` → 0 hits) — a JSON file nobody validates against is a second
 * copy that drifts. If a runtime validator is ever wired in, move the shapes
 * there and import them here; do not keep both.
 *
 * Validators return `{ ok, errors }` and never throw. They are structural
 * (field presence, type, enum membership); they do not judge transitions —
 * that is `state-reducer.js`.
 *
 * ── Operational lane states (`run.json.lanes[limb].state`) ─────────────────
 * The `/split` leader keeps a coarser, human-written state per limb in
 * `<parentRoot>/.artibot/split/run.json`. Those are {@link LANE_OPS_STATES};
 * {@link LANE_OPS_TO_LANE_STATE} maps each onto the design's lane machine so
 * the two vocabularies can be shown side by side without either replacing the
 * other. Observed 2026-09-02 in `Ontology/.artibot/split/run.json`: the file
 * carries `metrics.lanes` / `r4.lanes` / `dispatched.lanes` blocks but NO
 * top-level `lanes[limb].state` yet — `readLaneOpsState` therefore returns
 * `null` ("unknown") for that file, which is the fail-closed answer.
 *
 * ── v1.1 task/worker status (`task-graph.schema.json`) ────────────────────
 * A third vocabulary exists: the eight v1.1 statuses
 * (`schemas/task-graph.schema.json:59-68`). {@link V11_STATUS_TO_LANE_STATE}
 * is the ONE authored table between it and the design lane machine; the ops
 * direction ({@link LANE_OPS_TO_V11_STATUS}) is *derived* by composing the two
 * tables that already exist, never hand-written, so there is a single place to
 * edit. Design §3.1: no fourth file — the mapping lives here.
 *
 * @module lib/supervisor/contracts
 */

import { SOURCES } from './event-types.js';

/** Run states, `contracts/run-state.schema.json` enum order. */
export const RUN_STATES = Object.freeze([
  'CREATED',
  'PLANNED',
  'PROVISIONING',
  'READY',
  'EXECUTING',
  'REVIEWING',
  'INTEGRATING',
  'GATING',
  'STAGING',
  'E2E',
  'PROMOTING',
  'COMPLETED',
  'BLOCKED',
  'PAUSED',
  'FAILED_RECOVERABLE',
  'FAILED_TERMINAL',
  'CANCELLED',
]);

/**
 * The happy path of the run machine (design §05), in order. Side states
 * (`BLOCKED`, `PAUSED`, `FAILED_RECOVERABLE`) are reachable from anywhere and
 * are not on this line. Used by the reducer's telemetry mapping, which may
 * only move *forward* along it.
 */
export const RUN_LINEAR_STATES = Object.freeze([
  'CREATED',
  'PLANNED',
  'PROVISIONING',
  'READY',
  'EXECUTING',
  'REVIEWING',
  'INTEGRATING',
  'GATING',
  'STAGING',
  'E2E',
  'PROMOTING',
  'COMPLETED',
]);

/** Run states no later event may move away from. */
export const RUN_TERMINAL_STATES = Object.freeze(['COMPLETED', 'FAILED_TERMINAL', 'CANCELLED']);

/** Lane states, `contracts/lane-state.schema.json` enum order. */
export const LANE_STATES = Object.freeze([
  'PENDING',
  'READY',
  'CLAIMED',
  'RUNNING',
  'CHECKPOINTING',
  'WAITING_INPUT',
  'REVIEW_REQUIRED',
  'FIXING',
  'DONE',
  'FAILED_RECOVERABLE',
  'FAILED_TERMINAL',
  'ABORTED',
]);

/** Lane states no later event may move away from. */
export const LANE_TERMINAL_STATES = Object.freeze(['DONE', 'FAILED_TERMINAL', 'ABORTED']);

/** `reviewVerdict` enum (schema allows `null` as well). */
export const REVIEW_VERDICTS = Object.freeze(['PENDING', 'APPROVED', 'CHANGES_REQUESTED']);

/**
 * Operational lane states the `/split` leader writes into
 * `run.json.lanes[limb].state`. Allowlist — anything else reads as unknown.
 *
 * `failed` is the 9th and was added last: the ops vocabulary had no word for a
 * lane that stopped on a failure, so a v1.1 `failed` task had nowhere to
 * project. Widening an allowlist widens what {@link isLaneOpsState} accepts,
 * so it was only safe because nothing emits the string today — measured
 * 2026-09-02 with a repo-wide `grep -rnE` for a `state` key or assignment set
 * to `failed` (no `--include`, `node_modules` and `.git` excluded): 0 hits.
 * The one writer, `scripts/split/lane-state.mjs`, takes the state from argv
 * and refuses anything off this list, so `failed` can only enter by a human
 * typing it. `tests/supervisor/v11-status-mapping.test.js` re-measures that 0
 * on every run rather than trusting this note.
 */
export const LANE_OPS_STATES = Object.freeze([
  'pending',
  'active',
  'awaiting-dispatch',
  'review',
  'serial-gate',
  'closing',
  'done',
  'suspended',
  'failed',
]);

/**
 * Operational → design lane state. Many-to-one; the design machine is finer
 * about *why* a worker is idle and coarser about the leader's queueing.
 *
 * | ops                 | lane            | why |
 * |---------------------|-----------------|-----|
 * | `pending`           | PENDING         | planned, no window yet |
 * | `awaiting-dispatch` | READY           | window open, brief not yet sent |
 * | `active`            | RUNNING         | worker executing |
 * | `closing`           | RUNNING         | worker running final gates before the `Split-Limb: done` trailer — still the worker's turn |
 * | `review`            | REVIEW_REQUIRED | inspector dispatched / verdict pending |
 * | `serial-gate`       | WAITING_INPUT   | blocked on another lane's landing or a leader-run gate |
 * | `suspended`         | WAITING_INPUT   | operator hold (compact wait, owner pause) — not a failure |
 * | `done`              | DONE            | trailer read by git |
 * | `failed`            | FAILED_RECOVERABLE | lane stopped on a failure. RECOVERABLE, not TERMINAL: the ops word carries no "give up" signal, and choosing the terminal state would let a mere projection close a lane a retry could still finish. Terminal-ness must come from an explicit event, never from this table |
 */
export const LANE_OPS_TO_LANE_STATE = Object.freeze({
  'pending': 'PENDING',
  'awaiting-dispatch': 'READY',
  'active': 'RUNNING',
  'closing': 'RUNNING',
  'review': 'REVIEW_REQUIRED',
  'serial-gate': 'WAITING_INPUT',
  'suspended': 'WAITING_INPUT',
  'done': 'DONE',
  'failed': 'FAILED_RECOVERABLE',
});

/**
 * The eight v1.1 task/worker statuses, in the enum order of
 * `schemas/task-graph.schema.json`. Kept identical to that enum —
 * `v11-status-mapping.test.js` reads the schema file and compares, so the two
 * cannot drift apart silently.
 */
export const V11_STATUSES = Object.freeze([
  'queued',
  'claimed',
  'executing',
  'blocked',
  'reviewing',
  'done',
  'failed',
  'cancelled',
]);

/**
 * v1.1 status → design lane state. The single authored mapping table; every
 * other direction in this module is derived from it. Total over
 * {@link V11_STATUSES} and injective, which is what makes the inverse below
 * well defined.
 *
 * | v1.1        | lane               | why |
 * |-------------|--------------------|-----|
 * | `queued`    | PENDING            | planned, nobody holds it |
 * | `claimed`   | READY              | taken but not yet running |
 * | `executing` | RUNNING            | worker executing |
 * | `blocked`   | WAITING_INPUT      | *why* it is blocked lives in `blocked_by[]` (`lane:` / `gate:` / `human:` / `reconcile:`), not in the state word |
 * | `reviewing` | REVIEW_REQUIRED    | inspector dispatched / verdict pending |
 * | `done`      | DONE               | — |
 * | `failed`    | FAILED_RECOVERABLE | see the loss note below |
 * | `cancelled` | ABORTED            | — |
 *
 * Losses in both directions, stated rather than hidden:
 * - **lane → v1.1**: four of the twelve lane states have no v1.1 word —
 *   `CLAIMED`, `CHECKPOINTING`, `FIXING`, `FAILED_TERMINAL`. `CHECKPOINTING`
 *   and `FIXING` are moments inside `executing` that v1.1 does not name;
 *   `FAILED_TERMINAL` collapses because v1.1 has a single `failed`; and
 *   `CLAIMED` is unreachable because v1.1 `claimed` means "taken, not yet
 *   running", which is READY here. The inverse leaves all four unmapped, so a
 *   lookup returns `undefined` — unknown, the fail-closed answer, not a guess.
 * - **ops → v1.1**: `closing` and `suspended` are lost, because
 *   {@link LANE_OPS_TO_LANE_STATE} already merges `closing` into RUNNING and
 *   `suspended` into WAITING_INPUT. `closing` survives only as a ledger event;
 *   `suspended` survives only as `blocked_by: ['human:suspend']`. A round trip
 *   through {@link LANE_OPS_TO_V11_STATUS} therefore does not return the ops
 *   word it started from, and that is by design, not a bug.
 */
export const V11_STATUS_TO_LANE_STATE = Object.freeze({
  'queued': 'PENDING',
  'claimed': 'READY',
  'executing': 'RUNNING',
  'blocked': 'WAITING_INPUT',
  'reviewing': 'REVIEW_REQUIRED',
  'done': 'DONE',
  'failed': 'FAILED_RECOVERABLE',
  'cancelled': 'ABORTED',
});

/** lane state → v1.1 status. Derived: the inverse of the table above. */
const LANE_STATE_TO_V11 = Object.freeze(
  Object.fromEntries(Object.entries(V11_STATUS_TO_LANE_STATE).map(([v11, lane]) => [lane, v11])),
);

/**
 * ops state → v1.1 status. **Derived, not authored** — the composition
 * `ops → LANE_OPS_TO_LANE_STATE → inverse(V11_STATUS_TO_LANE_STATE)`. It
 * reproduces the design's ops→v1.1 table exactly (the test asserts all nine
 * rows against the written-out table), so hand-writing it here would only
 * create a second copy to drift. This is the direction the split-state
 * adapter reads `run.json` in.
 */
export const LANE_OPS_TO_V11_STATUS = Object.freeze(
  Object.fromEntries(
    LANE_OPS_STATES.map((ops) => [ops, LANE_STATE_TO_V11[LANE_OPS_TO_LANE_STATE[ops]]]),
  ),
);

const RUN_SET = new Set(RUN_STATES);
const LANE_SET = new Set(LANE_STATES);
const RUN_TERMINAL_SET = new Set(RUN_TERMINAL_STATES);
const LANE_TERMINAL_SET = new Set(LANE_TERMINAL_STATES);
const SOURCE_SET = new Set(SOURCES);
const OPS_SET = new Set(LANE_OPS_STATES);
const V11_SET = new Set(V11_STATUSES);

/** `type` pattern from the envelope schema. */
const TYPE_PATTERN = /^[a-z][a-z0-9-]+$/;

/** Envelope keys the schema allows (`additionalProperties: false`). */
const ENVELOPE_KEYS = new Set([
  'version', 'eventId', 'ts', 'runId', 'laneId', 'type', 'source', 'actionId', 'evidenceRef', 'data',
]);

/**
 * @param {unknown} s
 * @returns {boolean}
 */
export function isRunState(s) {
  return typeof s === 'string' && RUN_SET.has(s);
}

/**
 * @param {unknown} s
 * @returns {boolean}
 */
export function isLaneState(s) {
  return typeof s === 'string' && LANE_SET.has(s);
}

/**
 * @param {unknown} s
 * @returns {boolean}
 */
export function isRunTerminal(s) {
  return typeof s === 'string' && RUN_TERMINAL_SET.has(s);
}

/**
 * @param {unknown} s
 * @returns {boolean}
 */
export function isLaneTerminal(s) {
  return typeof s === 'string' && LANE_TERMINAL_SET.has(s);
}

/**
 * @param {unknown} s
 * @returns {boolean}
 */
export function isLaneOpsState(s) {
  return typeof s === 'string' && OPS_SET.has(s);
}

/**
 * @param {unknown} s
 * @returns {boolean}
 */
export function isV11Status(s) {
  return typeof s === 'string' && V11_SET.has(s);
}

/**
 * @param {unknown} v
 * @returns {boolean}
 */
function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

/**
 * @param {unknown} v
 * @returns {boolean}
 */
function isDateTime(v) {
  return typeof v === 'string' && Number.isFinite(Date.parse(v));
}

/**
 * @param {unknown} v
 * @returns {boolean}
 */
function isStringOrNull(v) {
  return v === null || typeof v === 'string';
}

/**
 * Validate a supervisor event envelope against
 * `contracts/event-envelope.schema.json`.
 *
 * Required: `version === 1`, `eventId`, `ts` (parseable date-time), `runId`,
 * `type` (`^[a-z][a-z0-9-]+$`), `source` ∈ {@link SOURCES}. Optional
 * `laneId` / `actionId` / `evidenceRef` must be string or null; `data` is
 * free-form. Unknown keys are errors (schema `additionalProperties: false`).
 *
 * Does NOT check that `type` is a known supervisor type: the envelope schema
 * accepts any pattern-conforming type, and the reducer is where unknown types
 * become warnings.
 *
 * @param {unknown} envelope
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateEvent(envelope) {
  const errors = [];
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    return { ok: false, errors: ['envelope must be an object'] };
  }
  const e = /** @type {Record<string, unknown>} */ (envelope);
  if (e.version !== 1) errors.push('version must be 1');
  if (!isNonEmptyString(e.eventId)) errors.push('eventId must be a non-empty string');
  if (!isDateTime(e.ts)) errors.push('ts must be a date-time string');
  if (!isNonEmptyString(e.runId)) errors.push('runId must be a non-empty string');
  if (!isNonEmptyString(e.type) || !TYPE_PATTERN.test(/** @type {string} */ (e.type))) {
    errors.push('type must match ^[a-z][a-z0-9-]+$');
  }
  if (!isNonEmptyString(e.source) || !SOURCE_SET.has(/** @type {string} */ (e.source))) {
    errors.push(`source must be one of ${SOURCES.join('|')}`);
  }
  for (const key of ['laneId', 'actionId', 'evidenceRef']) {
    if (key in e && !isStringOrNull(e[key])) errors.push(`${key} must be a string or null`);
  }
  for (const key of Object.keys(e)) {
    if (!ENVELOPE_KEYS.has(key)) errors.push(`unknown key: ${key}`);
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Validate one lane entry against `contracts/lane-state.schema.json`.
 * Required: `laneId`, `state` ∈ {@link LANE_STATES}, `attempt` (int ≥ 0),
 * `ownedPaths` (unique string array).
 *
 * @param {unknown} lane
 * @param {string} [label='lane'] - prefix for error messages
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateLaneState(lane, label = 'lane') {
  const errors = [];
  if (!lane || typeof lane !== 'object' || Array.isArray(lane)) {
    return { ok: false, errors: [`${label}: must be an object`] };
  }
  const l = /** @type {Record<string, unknown>} */ (lane);
  if (!isNonEmptyString(l.laneId)) errors.push(`${label}: laneId must be a non-empty string`);
  if (!isLaneState(l.state)) errors.push(`${label}: state must be one of ${LANE_STATES.join('|')}`);
  if (!Number.isInteger(l.attempt) || /** @type {number} */ (l.attempt) < 0) {
    errors.push(`${label}: attempt must be an integer >= 0`);
  }
  if (!Array.isArray(l.ownedPaths) || !l.ownedPaths.every((p) => typeof p === 'string')) {
    errors.push(`${label}: ownedPaths must be a string array`);
  } else if (new Set(l.ownedPaths).size !== l.ownedPaths.length) {
    errors.push(`${label}: ownedPaths must be unique`);
  }
  if ('dependsOn' in l && (!Array.isArray(l.dependsOn) || !l.dependsOn.every((p) => typeof p === 'string'))) {
    errors.push(`${label}: dependsOn must be a string array`);
  }
  for (const key of ['worktree', 'branch', 'head', 'workerId']) {
    if (key in l && !isStringOrNull(l[key])) errors.push(`${label}: ${key} must be a string or null`);
  }
  if ('lastHeartbeatAt' in l && l.lastHeartbeatAt !== null && !isDateTime(l.lastHeartbeatAt)) {
    errors.push(`${label}: lastHeartbeatAt must be a date-time string or null`);
  }
  if ('checkpointSeq' in l && (!Number.isInteger(l.checkpointSeq) || /** @type {number} */ (l.checkpointSeq) < 0)) {
    errors.push(`${label}: checkpointSeq must be an integer >= 0`);
  }
  if ('reviewVerdict' in l && l.reviewVerdict !== null && !REVIEW_VERDICTS.includes(/** @type {string} */ (l.reviewVerdict))) {
    errors.push(`${label}: reviewVerdict must be null or one of ${REVIEW_VERDICTS.join('|')}`);
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Validate a derived run state against `contracts/run-state.schema.json`.
 * Required: `version === 1`, `runId`, `state` ∈ {@link RUN_STATES},
 * `createdAt`, `updatedAt`, `lanes` (object of valid lane states).
 * `budget` is not validated beyond "object or absent" (PR-BD01 owns it).
 *
 * @param {unknown} state
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateRunState(state) {
  const errors = [];
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    return { ok: false, errors: ['run state must be an object'] };
  }
  const s = /** @type {Record<string, unknown>} */ (state);
  if (s.version !== 1) errors.push('version must be 1');
  if (!isNonEmptyString(s.runId)) errors.push('runId must be a non-empty string');
  if (!isRunState(s.state)) errors.push(`state must be one of ${RUN_STATES.join('|')}`);
  if (!isDateTime(s.createdAt)) errors.push('createdAt must be a date-time string');
  if (!isDateTime(s.updatedAt)) errors.push('updatedAt must be a date-time string');
  if ('base' in s && !isStringOrNull(s.base)) errors.push('base must be a string or null');
  if (!s.lanes || typeof s.lanes !== 'object' || Array.isArray(s.lanes)) {
    errors.push('lanes must be an object');
  } else {
    for (const [id, lane] of Object.entries(s.lanes)) {
      const r = validateLaneState(lane, `lanes.${id}`);
      errors.push(...r.errors);
    }
  }
  if ('exceptionCount' in s && (!Number.isInteger(s.exceptionCount) || /** @type {number} */ (s.exceptionCount) < 0)) {
    errors.push('exceptionCount must be an integer >= 0');
  }
  if ('budget' in s && (s.budget === null || typeof s.budget !== 'object')) {
    errors.push('budget must be an object when present');
  }
  return { ok: errors.length === 0, errors };
}
