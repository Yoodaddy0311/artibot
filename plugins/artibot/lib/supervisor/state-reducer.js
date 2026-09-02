/**
 * Supervisor state reducer — events in, derived run state out. Pure.
 *
 * `reduce(events)` folds an ordered event stream into the run-state shape of
 * `contracts/run-state.schema.json`. It has no clock, no filesystem, no
 * randomness: the same array yields a deep-equal result every time
 * (PR-SV01 "same event stream → byte-equivalent derived state"). Timestamps
 * in the output are copied from events, never generated; the optional `now`
 * is used only when the stream is empty.
 *
 * ── Fail-safe rules (PR-SV01 acceptance) ────────────────────────────────────
 *   - **Unknown event type** → `warnings[]` entry, no transition.
 *   - **Terminal never regresses**: once the run is `COMPLETED` /
 *     `FAILED_TERMINAL` / `CANCELLED` (or a lane is `DONE` / `FAILED_TERMINAL`
 *     / `ABORTED`) a later event that would move it elsewhere is a warning,
 *     not a change.
 *   - **Foreign runId** (event `runId` / `sessionId` ≠ the stream's run) →
 *     warning, ignored.
 *   - **Ambiguous** (`to` not a known state, `verdict` not in enum, …) →
 *     warning, no change. Ambiguity is never resolved by guessing.
 *
 * ── Input order ──────────────────────────────────────────────────────────────
 * Events are applied in ARRAY ORDER. The reducer does not sort: sorting by
 * `ts` is `run-store.js#readAllEvents`'s job (stable, so two events with one
 * timestamp keep file order). Feeding an unsorted array is allowed and still
 * deterministic — it just derives a different (and possibly wrong) state.
 *
 * ── Supervisor envelopes (`event-types.js#SUPERVISOR_EVENT_TYPES`) ───────────
 * | type                 | effect |
 * |----------------------|--------|
 * | `run-created`        | `createdAt = ts` (first only), `base = data.base ?? null`, `budget = data.budget` if object. Second occurrence → warning, ignored. |
 * | `run-state-changed`  | `state = data.to` if it is a run state and the current state is not terminal. |
 * | `lane-created`       | creates the lane (`PENDING`, attempt 0) with `data.{ownedPaths,dependsOn,worktree,branch}`. Existing lane → warning, ignored. |
 * | `lane-state-changed` | `lane.state = data.to` if it is a lane state and the lane is not terminal. On the lane's first appearance a valid `data.from` is adopted as its prior state (no warning); afterwards `data.from` ≠ current → warning `from-mismatch` but the event is still applied (the emitter saw the lane; we did not). Entering `RUNNING` from `PENDING`/`READY`/`CLAIMED`/`FAILED_RECOVERABLE` increments `attempt`. |
 * | `lane-heartbeat`     | `lastHeartbeatAt = ts`; `head = data.head` if string. |
 * | `lane-progress`      | same as heartbeat (progress proves liveness). |
 * | `worker-attached`    | `workerId = data.workerId ?? null`; heartbeat. |
 * | `worker-detached`    | `workerId = null`. |
 * | `context-pressure`   | heartbeat only (a hook fired, so the worker is alive). Score is not stored — the schema has no slot. |
 * | `checkpoint-written` | `checkpointSeq = max(current, data.seq)`; heartbeat. |
 * | `checkpoint-restored`| heartbeat only. |
 * | `review-requested`   | `reviewVerdict = 'PENDING'`. |
 * | `review-result`      | `reviewVerdict = data.verdict` if `APPROVED`/`CHANGES_REQUESTED`; otherwise warning. |
 * | `retry-scheduled`    | no state change (the attempt counter moves when the lane actually re-enters `RUNNING`). |
 * | `budget-warning`     | no state change. |
 * | `budget-exhausted`   | no state change — pausing on a hard limit is a policy decision (PR-BD01), not a reducer rule. |
 * | `human-required`     | `exceptionCount += 1`. |
 * | `human-resolved`     | `exceptionCount = max(0, exceptionCount − 1)`. |
 * | `gate-started`       | no state change (`run-state-changed` carries `GATING`). |
 * | `gate-result`        | no state change. |
 *
 * Lane-scoped events (`laneId` set) on a lane that was never `lane-created`
 * create it implicitly as `PENDING` — the design's own example stream
 * (`examples/events.example.ndjson`) does exactly this. A lane-scoped event
 * with `laneId` null/absent is a warning.
 *
 * ── Telemetry lines (`lib/observability/split-telemetry.js`, read-only) ──────
 * A line is recognised as telemetry by shape: it has `sessionId` and no
 * `version`/`source`. Mapping (leader decision 2026-09-02; where the line
 * carries no success signal the state stays at the earlier, safer step):
 *
 * | line                                    | run state |
 * |-----------------------------------------|-----------|
 * | `wall-clock-start` segment `run`        | `createdAt = ts` if unset; state stays `CREATED` |
 * | `phase-start PLAN`                      | `PLANNED` |
 * | `phase-start OPEN`                      | `PROVISIONING` |
 * | `phase-start DISPATCH`                  | `READY` |
 * | `phase-end DISPATCH` + `data.status === 'ready'` | `EXECUTING` (otherwise stays `READY` — a refused dispatch is not execution) |
 * | `wall-clock-start` segment `wait-limbs` | `EXECUTING` (the leader is waiting on windows, so they were dispatched) |
 * | `phase-start INTEGRATE`                 | `INTEGRATING` |
 * | `phase-end INTEGRATE` + landed          | `COMPLETED`, where landed = `data.status === 'landed'` OR `message` starts with `landed` (the `/split integrate` contract writes the landing status as the message — `commands/split.md` "integrate"; message matching is confined to this one rule and is the weakest evidence used anywhere here) |
 * | `phase-end INTEGRATE` not landed        | stays `INTEGRATING`, warning `integrate-not-landed` |
 * | everything else (`fast-profile-*`, `phase-* RESUME`, other segments) | no change |
 *
 * Telemetry may only move the run FORWARD along `RUN_LINEAR_STATES`; a
 * replayed earlier phase (e.g. `phase-start PLAN` after `EXECUTING`, which
 * `run --resume` can produce) is silently ignored — it is normal, not an
 * anomaly. From a side state (`BLOCKED`/`PAUSED`/`FAILED_RECOVERABLE`) any
 * mapped phase applies (the run resumed). Terminal states never regress.
 * Telemetry does not create or touch lanes: those lines carry no lane id.
 *
 * @module lib/supervisor/state-reducer
 */

import {
  isLaneState,
  isLaneTerminal,
  isRunState,
  isRunTerminal,
  REVIEW_VERDICTS,
  RUN_LINEAR_STATES,
} from './contracts.js';
import { isSupervisorEvent, isTelemetryEvent } from './event-types.js';

/**
 * @typedef {object} ReduceWarning
 * @property {string} code - stable machine code (`unknown-event`, `terminal-regress`, …)
 * @property {number} index - position of the offending event in the input array
 * @property {string|null} eventId - envelope `eventId` when present
 * @property {string|null} type - event type when present
 * @property {string} message
 */

/**
 * @typedef {object} LaneState
 * @property {string} laneId
 * @property {string} state
 * @property {number} attempt
 * @property {string[]} ownedPaths
 * @property {string[]} dependsOn
 * @property {string|null} worktree
 * @property {string|null} branch
 * @property {string|null} head
 * @property {string|null} workerId
 * @property {string|null} lastHeartbeatAt
 * @property {number} checkpointSeq
 * @property {string|null} reviewVerdict
 */

/**
 * @typedef {object} RunState
 * @property {1} version
 * @property {string|null} runId
 * @property {string} state
 * @property {string|null} createdAt
 * @property {string|null} updatedAt
 * @property {string|null} base
 * @property {Record<string, LaneState>} lanes
 * @property {number} exceptionCount
 * @property {object} [budget]
 */

const LINEAR_INDEX = new Map(RUN_LINEAR_STATES.map((s, i) => [s, i]));

/** Lane states from which entering `RUNNING` counts as a new attempt. */
const ATTEMPT_START_STATES = new Set(['PENDING', 'READY', 'CLAIMED', 'FAILED_RECOVERABLE']);

/**
 * @param {unknown} v
 * @returns {string|null}
 */
function strOrNull(v) {
  return typeof v === 'string' ? v : null;
}

/**
 * @param {unknown} v
 * @returns {string[]}
 */
function stringArray(v) {
  return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
}

/**
 * @param {string} runId
 * @param {string|null} now
 * @returns {RunState}
 */
function initialState(runId, now) {
  return {
    version: 1,
    runId,
    state: 'CREATED',
    createdAt: now,
    updatedAt: now,
    base: null,
    lanes: {},
    exceptionCount: 0,
  };
}

/**
 * @param {string} laneId
 * @param {object} [data]
 * @returns {LaneState}
 */
function newLane(laneId, data = {}) {
  const d = data && typeof data === 'object' ? data : {};
  return {
    laneId,
    state: 'PENDING',
    attempt: 0,
    ownedPaths: [...new Set(stringArray(d.ownedPaths))],
    dependsOn: stringArray(d.dependsOn),
    worktree: strOrNull(d.worktree),
    branch: strOrNull(d.branch),
    head: strOrNull(d.head),
    workerId: null,
    lastHeartbeatAt: null,
    checkpointSeq: 0,
    reviewVerdict: null,
  };
}

/**
 * Is this object a split-telemetry line rather than a supervisor envelope?
 * @param {object} ev
 * @returns {boolean}
 */
function isTelemetryShape(ev) {
  return typeof ev.sessionId === 'string' && ev.version === undefined && ev.source === undefined;
}

/**
 * Reducer context: mutable state + warning sink for one `reduce` call.
 */
class Ctx {
  /**
   * @param {RunState} state
   */
  constructor(state) {
    this.state = state;
    /** @type {ReduceWarning[]} */
    this.warnings = [];
    this.index = 0;
    /** @type {object} */
    this.ev = {};
    this.runCreated = false;
  }

  /**
   * @param {string} code
   * @param {string} message
   * @returns {void}
   */
  warn(code, message) {
    this.warnings.push({
      code,
      index: this.index,
      eventId: strOrNull(this.ev.eventId),
      type: strOrNull(this.ev.type),
      message,
    });
  }

  /**
   * Lane for the current event, created implicitly when absent. Null (with a
   * warning) when the event carries no laneId. `created` tells the caller the
   * lane had no prior state (so an emitter's `data.from` is the only evidence).
   * @returns {{ lane: LaneState|null, created: boolean }}
   */
  lane() {
    const id = strOrNull(this.ev.laneId);
    if (!id) {
      this.warn('lane-missing', `${this.ev.type} without laneId`);
      return { lane: null, created: false };
    }
    const created = !this.state.lanes[id];
    if (created) this.state.lanes[id] = newLane(id);
    return { lane: this.state.lanes[id], created };
  }

  /**
   * @param {LaneState} lane
   * @returns {void}
   */
  heartbeat(lane) {
    lane.lastHeartbeatAt = strOrNull(this.ev.ts);
    const head = strOrNull(this.ev.data?.head);
    if (head) lane.head = head;
  }

  /**
   * Move the run to `to` unless terminal or unknown.
   * @param {unknown} to
   * @returns {boolean} applied
   */
  setRunState(to) {
    if (!isRunState(to)) {
      this.warn('unknown-run-state', `run-state-changed to ${JSON.stringify(to)} ignored`);
      return false;
    }
    if (isRunTerminal(this.state.state)) {
      if (this.state.state !== to) {
        this.warn('terminal-regress', `run is ${this.state.state}; ${to} ignored`);
      }
      return false;
    }
    this.state.state = /** @type {string} */ (to);
    return true;
  }

  /**
   * Telemetry mapping: forward-only along the linear chain.
   * @param {string} to
   * @returns {boolean} applied
   */
  advanceRun(to) {
    const cur = this.state.state;
    if (isRunTerminal(cur)) return false;
    const curIdx = LINEAR_INDEX.get(cur);
    const toIdx = LINEAR_INDEX.get(to);
    if (curIdx !== undefined && toIdx !== undefined && toIdx <= curIdx) return false;
    this.state.state = to;
    return true;
  }
}

/**
 * Lane-scoped handlers that only need the lane and the data.
 * @type {Record<string, (ctx: Ctx, lane: LaneState, data: object, created: boolean) => void>}
 */
const LANE_HANDLERS = {
  'lane-heartbeat': (ctx, lane) => ctx.heartbeat(lane),
  'lane-progress': (ctx, lane) => ctx.heartbeat(lane),
  'context-pressure': (ctx, lane) => ctx.heartbeat(lane),
  'checkpoint-restored': (ctx, lane) => ctx.heartbeat(lane),
  'worker-attached': (ctx, lane, data) => {
    lane.workerId = strOrNull(data.workerId);
    ctx.heartbeat(lane);
  },
  'worker-detached': (_ctx, lane) => {
    lane.workerId = null;
  },
  'checkpoint-written': (ctx, lane, data) => {
    if (Number.isInteger(data.seq) && data.seq > lane.checkpointSeq) lane.checkpointSeq = data.seq;
    ctx.heartbeat(lane);
  },
  'review-requested': (_ctx, lane) => {
    lane.reviewVerdict = 'PENDING';
  },
  'review-result': (ctx, lane, data) => {
    const v = data.verdict;
    if (v === 'APPROVED' || v === 'CHANGES_REQUESTED') {
      lane.reviewVerdict = v;
    } else {
      ctx.warn('unknown-verdict', `lane ${lane.laneId}: verdict ${JSON.stringify(v)} not in ${REVIEW_VERDICTS.join('|')}; ignored`);
    }
  },
  'lane-state-changed': (ctx, lane, data, created) => {
    const to = data.to;
    if (!isLaneState(to)) {
      ctx.warn('unknown-lane-state', `lane ${lane.laneId}: to=${JSON.stringify(to)} ignored`);
      return;
    }
    // First sight of this lane: the emitter's `from` is the only evidence of
    // where it was (design example: READY→RUNNING with no lane-created).
    if (created && isLaneState(data.from)) lane.state = data.from;
    if (isLaneTerminal(lane.state)) {
      if (lane.state !== to) {
        ctx.warn('terminal-regress', `lane ${lane.laneId} is ${lane.state}; ${to} ignored`);
      }
      return;
    }
    if (typeof data.from === 'string' && data.from !== lane.state) {
      ctx.warn('from-mismatch', `lane ${lane.laneId}: event says from=${data.from}, reduced state is ${lane.state}; applying ${to}`);
    }
    if (to === 'RUNNING' && ATTEMPT_START_STATES.has(lane.state)) lane.attempt += 1;
    lane.state = /** @type {string} */ (to);
  },
};

/**
 * Run-scoped handlers.
 * @type {Record<string, (ctx: Ctx, data: object) => void>}
 */
const RUN_HANDLERS = {
  'run-created': (ctx, data) => {
    if (ctx.runCreated) {
      ctx.warn('duplicate-run-created', 'run-created seen twice; second ignored');
      return;
    }
    ctx.runCreated = true;
    if (ctx.state.createdAt === null) ctx.state.createdAt = strOrNull(ctx.ev.ts);
    ctx.state.base = strOrNull(data.base);
    if (data.budget && typeof data.budget === 'object') ctx.state.budget = { ...data.budget };
  },
  'run-state-changed': (ctx, data) => {
    ctx.setRunState(data.to);
  },
  'lane-created': (ctx, data) => {
    const id = strOrNull(ctx.ev.laneId);
    if (!id) {
      ctx.warn('lane-missing', 'lane-created without laneId');
      return;
    }
    if (ctx.state.lanes[id]) {
      ctx.warn('duplicate-lane-created', `lane ${id} already exists; lane-created ignored`);
      return;
    }
    ctx.state.lanes[id] = newLane(id, data);
  },
  'human-required': (ctx) => {
    ctx.state.exceptionCount += 1;
  },
  'human-resolved': (ctx) => {
    ctx.state.exceptionCount = Math.max(0, ctx.state.exceptionCount - 1);
  },
};

/** Allowlisted types that carry no state (see module header table). */
const INERT_TYPES = new Set(['retry-scheduled', 'budget-warning', 'budget-exhausted', 'gate-started', 'gate-result']);

/**
 * @param {Ctx} ctx
 * @returns {void}
 */
function applySupervisor(ctx) {
  const { ev } = ctx;
  const data = ev.data && typeof ev.data === 'object' ? ev.data : {};
  if (RUN_HANDLERS[ev.type]) {
    RUN_HANDLERS[ev.type](ctx, data);
  } else if (LANE_HANDLERS[ev.type]) {
    const { lane, created } = ctx.lane();
    if (lane) LANE_HANDLERS[ev.type](ctx, lane, data, created);
  } else if (!INERT_TYPES.has(ev.type)) {
    // Unreachable while every SUPERVISOR_EVENT_TYPES entry has a handler or is
    // inert; kept so a type added to the allowlist without one is loud.
    ctx.warn('unhandled-event', `${ev.type} is allowlisted but has no reducer case`);
  }
}

/**
 * @param {Ctx} ctx
 * @returns {void}
 */
function applyTelemetry(ctx) {
  const { ev, state } = ctx;
  const phase = strOrNull(ev.phase);
  const segment = strOrNull(ev.data?.segment);
  switch (ev.type) {
    case 'wall-clock-start':
      if (segment === 'run' && state.createdAt === null) state.createdAt = strOrNull(ev.ts);
      if (segment === 'wait-limbs') ctx.advanceRun('EXECUTING');
      return;
    case 'phase-start':
      if (phase === 'PLAN') ctx.advanceRun('PLANNED');
      else if (phase === 'OPEN') ctx.advanceRun('PROVISIONING');
      else if (phase === 'DISPATCH') ctx.advanceRun('READY');
      else if (phase === 'INTEGRATE') ctx.advanceRun('INTEGRATING');
      return;
    case 'phase-end': {
      if (phase === 'DISPATCH' && ev.data?.status === 'ready') {
        ctx.advanceRun('EXECUTING');
      } else if (phase === 'INTEGRATE') {
        const landed = ev.data?.status === 'landed'
          || (typeof ev.message === 'string' && /^landed\b/.test(ev.message));
        if (landed) ctx.advanceRun('COMPLETED');
        else ctx.warn('integrate-not-landed', `INTEGRATE ended without a landed signal: ${JSON.stringify(ev.message ?? null)}`);
      }
      return;
    }
    default:
      // wall-clock-end, fast-profile-*: carry no state information.
  }
}

/**
 * Fold an event stream into a run state. Pure and deterministic.
 *
 * @param {ReadonlyArray<object>} events - supervisor envelopes and/or split-telemetry lines, in apply order
 * @param {{ now?: string, runId?: string }} [opts]
 *   `runId` pins the run (events for another run are warnings); default is
 *   the first event's `runId`/`sessionId`. `now` seeds `createdAt`/`updatedAt`
 *   ONLY for an empty stream (otherwise timestamps come from events).
 * @returns {{ state: RunState, warnings: ReduceWarning[] }}
 */
export function reduce(events, opts = {}) {
  const list = Array.isArray(events) ? events : [];
  const now = typeof opts?.now === 'string' ? opts.now : null;
  let runId = typeof opts?.runId === 'string' && opts.runId ? opts.runId : null;
  if (!runId) {
    const first = list.find((e) => e && typeof e === 'object' && (typeof e.runId === 'string' || typeof e.sessionId === 'string'));
    runId = first ? strOrNull(first.runId) ?? strOrNull(first.sessionId) : null;
  }
  const ctx = new Ctx(initialState(runId, now));

  list.forEach((ev, index) => {
    ctx.index = index;
    ctx.ev = ev && typeof ev === 'object' ? ev : {};
    if (!ev || typeof ev !== 'object') {
      ctx.warn('malformed-event', 'event is not an object');
      return;
    }
    const evRun = strOrNull(ev.runId) ?? strOrNull(ev.sessionId);
    if (runId && evRun && evRun !== runId) {
      ctx.warn('foreign-run', `event for ${evRun} in stream for ${runId}; ignored`);
      return;
    }
    if (isTelemetryShape(ev)) {
      if (!isTelemetryEvent(ev.type)) {
        ctx.warn('unknown-event', `telemetry type ${JSON.stringify(ev.type)} ignored`);
        return;
      }
      applyTelemetry(ctx);
    } else if (isSupervisorEvent(ev.type)) {
      applySupervisor(ctx);
    } else {
      ctx.warn('unknown-event', `type ${JSON.stringify(ev.type ?? null)} ignored`);
      return;
    }
    const ts = strOrNull(ev.ts);
    if (ts) ctx.state.updatedAt = ts;
  });

  if (ctx.state.updatedAt === null) ctx.state.updatedAt = ctx.state.createdAt;
  return { state: ctx.state, warnings: ctx.warnings };
}
