/**
 * Split telemetry — the `/split` measurement contract (PRD
 * split-cross-session-multi-worktree, G4 / Phase 5, 2026-08-26).
 *
 * RECORD ONLY. Nothing in this module judges, thresholds, or auto-adjusts.
 * It writes events and, on request, folds them into numbers that are either
 * measured or `null`. The C-stage re-evaluation rule (human-wait share of the
 * run) is a *reader's* decision made over `summarizeWallClock` output; the
 * threshold lives in config and is compared by the report, not here.
 *
 * What is written (all through `lib/observability/run-events.js`, so the line
 * shape is byte-identical to autopilot's `runtime/autopilot/*.events.ndjson`):
 *
 *   type `fast-profile-planned` | `fast-profile-reused`
 *       `data` carries exactly the nine fields `engine.js` emits for `-fast`,
 *       copied name-for-name ({@link FAST_PROFILE_PLANNED_FIELDS}) so the two
 *       streams can be laid side by side. A field the caller did not supply is
 *       written as `null` — never invented, never dropped.
 *   type `phase-start` / `phase-end`
 *       Same pairing contract `replay.js#findUnterminatedPhases` reads: a
 *       `phase-start` with no matching `phase-end` is "still open".
 *   type `wall-clock-start` / `wall-clock-end`
 *       `data.segment` names the window, `data.humanWait` marks the windows
 *       where the operator, not the machine, was the one working (opening a
 *       terminal, answering a prompt). Unpaired → `durationMs: null`. `0` is
 *       reserved for a real zero-length measurement.
 *
 * WHY WALL-CLOCK INCLUDES HUMAN WAITING: `/split` opens N terminal windows
 * that a person has to create. The honest run length is start-to-finish as
 * the operator experiences it, which includes every minute they spent doing
 * that. Splitting the human-wait segments out is what lets a report say how
 * much of the run was the tool versus the person — without pretending the
 * person's time was free.
 *
 * LIVE DATA: as of 2026-08-26 there are ZERO real-operator `/split` runs and
 * ZERO real-operator `-fast` wall-clock measurements. Every number this module
 * can produce today comes from fixtures. The PRD's acceptance criterion for
 * this phase is one live `/split` run with phase pairs, nine fields, and an
 * unpaired-null observed in the ndjson — green tests do not substitute.
 *
 * Public surface:
 *   - FAST_PROFILE_PLANNED_FIELDS
 *   - getSplitStoreDir({ storeDir })
 *   - getSplitEventsPath(runId, { storeDir })
 *   - readSplitEvents(runId, { storeDir, tail, level })
 *   - fastProfileFromPlan(plan, { cpuCount })
 *   - recordFastProfilePlanned(runId, fastProfile, { storeDir, ts })
 *   - recordPhaseStart(runId, phase, { storeDir, message, data, ts })
 *   - recordPhaseEnd(runId, phase, { storeDir, message, data, ts })
 *   - recordWallClockStart(runId, { segment, humanWait, phase, storeDir, ts })
 *   - recordWallClockEnd(runId, { segment, phase, storeDir, ts })
 *   - summarizeWallClock(events)
 *
 * DATA POLICY: 100% local file; no external transmission.
 *
 * @module lib/observability/split-telemetry
 */

import path from 'node:path';
import { getPluginRoot } from '../core/platform.js';
import {
  appendRunEvent,
  readRunEvents,
  resolveRunEventsPath,
} from './run-events.js';

/**
 * The nine `data` keys `lib/autopilot/engine.js` writes on its
 * `fast-profile-planned` tick, in the order it writes them. Copied by name so
 * a `/split` line and a `-fast` line diff field-for-field. The firewall test
 * `tests/firewall/split-telemetry-wallclock.test.js` compares this list against
 * the engine source; edit one and the gate goes red until the other follows.
 */
export const FAST_PROFILE_PLANNED_FIELDS = Object.freeze([
  'requested',
  'reused',
  'cpuCount',
  'requestedParallelism',
  'eligibleParallelism',
  'plannedParallelism',
  'worktrees',
  'serialReasons',
  'fallbackReason',
]);

export const WALL_CLOCK_START = 'wall-clock-start';
export const WALL_CLOCK_END = 'wall-clock-end';
export const PHASE_START = 'phase-start';
export const PHASE_END = 'phase-end';

/**
 * The segment a report treats as the whole run. Human-wait share is computed
 * against this window; other segments are informational.
 */
export const RUN_SEGMENT = 'run';

const SPLIT_DIR = 'split';

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
 * @param {unknown} segment
 * @returns {asserts segment is string}
 */
function assertSegment(segment) {
  if (!segment || typeof segment !== 'string') {
    throw new TypeError('segment must be a non-empty string');
  }
}

/**
 * Resolve the directory `/split` run events live in. Defaults to
 * `<pluginRoot>/runtime/split/`; tests pass an explicit `storeDir` under
 * `os.tmpdir()` and never touch the real one.
 *
 * @param {{ storeDir?: string }} [opts]
 * @returns {string}
 */
export function getSplitStoreDir(opts = {}) {
  const override = opts && typeof opts.storeDir === 'string' && opts.storeDir ? opts.storeDir : null;
  return override || path.join(getPluginRoot(), 'runtime', SPLIT_DIR);
}

/**
 * @param {string} runId
 * @param {{ storeDir?: string }} [opts]
 * @returns {string}
 */
export function getSplitEventsPath(runId, opts = {}) {
  return resolveRunEventsPath(getSplitStoreDir(opts), runId);
}

/**
 * @param {string} runId
 * @param {{ storeDir?: string, tail?: number, level?: 'info'|'warn'|'error' }} [opts]
 * @returns {object[]}
 */
export function readSplitEvents(runId, opts = {}) {
  return readRunEvents(getSplitStoreDir(opts), runId, opts);
}

/**
 * @param {string} runId
 * @param {object} event
 * @param {{ storeDir?: string }} [opts]
 * @returns {object}
 */
function record(runId, event, opts = {}) {
  return appendRunEvent(getSplitStoreDir(opts), runId, event);
}

/**
 * Turn a raw `buildFastFanoutPlan` result into the nine-field profile shape
 * `engine.js` writes. Mirrors `fast-execution.js#planFastExecution`'s final
 * `return` (requested / requestedParallelism / serialReasons / reused) so the
 * derived fields mean the same thing in both streams. The plan is not mutated.
 *
 * Fields the plan cannot supply are `null`, not guessed: a `/split` plan is
 * built without the engine's `state`, so `reused` is always `false` here (there
 * is no persisted profile to reuse) and `cpuCount` is whatever the caller
 * measured — this function does not probe the machine.
 *
 * @param {object} plan - output of `lib/autopilot/fast-profile.js#buildFastFanoutPlan`
 * @param {{ cpuCount?: number }} [opts]
 * @returns {object} plan spread + the nine fields
 */
export function fastProfileFromPlan(plan, opts = {}) {
  const p = plan && typeof plan === 'object' ? plan : {};
  const serial = Array.isArray(p.serial) ? p.serial : [];
  const fallbackReason = typeof p.fallbackReason === 'string' ? p.fallbackReason : null;
  const serialReasons = [...new Set([
    ...serial.map((entry) => entry?.reason).filter(Boolean),
    ...(fallbackReason ? [fallbackReason] : []),
  ])];
  const cpuCount = Number.isInteger(opts?.cpuCount) && opts.cpuCount > 0 ? opts.cpuCount : null;
  return {
    ...p,
    serial,
    cpuCount,
    requested: true,
    requestedParallelism: Number.isInteger(p.requestedTaskCount) ? p.requestedTaskCount : null,
    serialReasons,
    fallbackReason,
    reused: false,
  };
}

/**
 * Copy exactly the nine fields out of a profile object. Missing → `null`.
 * Key order follows {@link FAST_PROFILE_PLANNED_FIELDS} so the serialized line
 * reads in the same order as the engine's.
 *
 * @param {object} profile
 * @returns {object}
 */
function copyNineFields(profile) {
  const src = profile && typeof profile === 'object' ? profile : {};
  const data = {};
  for (const key of FAST_PROFILE_PLANNED_FIELDS) {
    data[key] = src[key] === undefined ? null : src[key];
  }
  return data;
}

/**
 * Write the `-fast`-compatible plan line for a `/split` run. `type`, `level`
 * and `message` follow `engine.js` exactly: `reused` selects the type, and
 * `enabled` selects info vs warn.
 *
 * @param {string} runId
 * @param {object} fastProfile - from {@link fastProfileFromPlan} (or any object carrying the nine fields)
 * @param {{ storeDir?: string, ts?: string, phase?: string }} [opts]
 * @returns {object} the persisted event
 */
export function recordFastProfilePlanned(runId, fastProfile, opts = {}) {
  assertRunId(runId);
  const profile = fastProfile && typeof fastProfile === 'object' ? fastProfile : {};
  const reused = profile.reused === true;
  const enabled = profile.enabled === true;
  return record(runId, {
    ts: opts.ts,
    phase: typeof opts.phase === 'string' ? opts.phase : 'PLAN',
    type: reused ? 'fast-profile-reused' : 'fast-profile-planned',
    level: enabled ? 'info' : 'warn',
    message: reused
      ? 'Fast execution profile reused from the paused session'
      : enabled ? 'Fast parallel execution plan accepted' : 'Fast request fell back to standard execution',
    data: copyNineFields(profile),
  }, opts);
}

/**
 * @param {string} runId
 * @param {string} phase
 * @param {{ storeDir?: string, message?: string, data?: unknown, ts?: string }} [opts]
 * @returns {object}
 */
export function recordPhaseStart(runId, phase, opts = {}) {
  assertRunId(runId);
  assertSegment(phase);
  return record(runId, {
    ts: opts.ts,
    phase,
    type: PHASE_START,
    level: 'info',
    message: typeof opts.message === 'string' ? opts.message : `${phase} start`,
    ...(opts.data !== undefined ? { data: opts.data } : {}),
  }, opts);
}

/**
 * @param {string} runId
 * @param {string} phase
 * @param {{ storeDir?: string, message?: string, data?: unknown, ts?: string }} [opts]
 * @returns {object}
 */
export function recordPhaseEnd(runId, phase, opts = {}) {
  assertRunId(runId);
  assertSegment(phase);
  return record(runId, {
    ts: opts.ts,
    phase,
    type: PHASE_END,
    level: 'info',
    message: typeof opts.message === 'string' ? opts.message : `${phase} end`,
    ...(opts.data !== undefined ? { data: opts.data } : {}),
  }, opts);
}

/**
 * Open a wall-clock window. `humanWait: true` marks a window whose length is
 * the operator's, not the tool's (window creation, prompt answering).
 *
 * @param {string} runId
 * @param {{ segment: string, humanWait?: boolean, phase?: string, storeDir?: string, ts?: string, message?: string }} opts
 * @returns {object}
 */
export function recordWallClockStart(runId, opts = {}) {
  assertRunId(runId);
  assertSegment(opts.segment);
  const humanWait = opts.humanWait === true;
  return record(runId, {
    ts: opts.ts,
    phase: typeof opts.phase === 'string' ? opts.phase : null,
    type: WALL_CLOCK_START,
    level: 'info',
    message: typeof opts.message === 'string' ? opts.message : `wall-clock start: ${opts.segment}`,
    data: { segment: opts.segment, humanWait },
  }, opts);
}

/**
 * Close a wall-clock window. Closing a segment that was never opened is
 * recorded as-is — the summarizer reports it as unpaired rather than this
 * function refusing (a crash between start and end is the case we want to
 * see, not hide).
 *
 * @param {string} runId
 * @param {{ segment: string, phase?: string, storeDir?: string, ts?: string, message?: string }} opts
 * @returns {object}
 */
export function recordWallClockEnd(runId, opts = {}) {
  assertRunId(runId);
  assertSegment(opts.segment);
  return record(runId, {
    ts: opts.ts,
    phase: typeof opts.phase === 'string' ? opts.phase : null,
    type: WALL_CLOCK_END,
    level: 'info',
    message: typeof opts.message === 'string' ? opts.message : `wall-clock end: ${opts.segment}`,
    data: { segment: opts.segment },
  }, opts);
}

/**
 * @param {unknown} ts
 * @returns {number}
 */
function tsToMs(ts) {
  if (typeof ts !== 'string') return NaN;
  const n = Date.parse(ts);
  return Number.isFinite(n) ? n : NaN;
}

/**
 * Pop the most recent open window with this segment name (LIFO, mirroring
 * `replay.js#popMatchingPhase`). Returns the popped entry or null.
 *
 * @param {Array<{ segment: string }>} open
 * @param {string} segment
 * @returns {object|null}
 */
function popMatchingSegment(open, segment) {
  for (let i = open.length - 1; i >= 0; i -= 1) {
    if (open[i].segment === segment) {
      return open.splice(i, 1)[0];
    }
  }
  return null;
}

/**
 * @typedef {object} WallClockSegment
 * @property {string} segment
 * @property {boolean} humanWait
 * @property {string|null} startedAt
 * @property {string|null} endedAt
 * @property {number|null} durationMs - null unless both ends were recorded with parseable, ordered timestamps
 */

/**
 * @typedef {object} WallClockSummary
 * @property {WallClockSegment[]} segments - every window that had a start, in start order
 * @property {Array<{ segment: string, side: 'start'|'end', ts: string|null }>} unpaired
 *   starts with no end, and ends with no start — the half that was recorded
 * @property {number|null} totalMs - duration of the `run` segment; null when unpaired or absent
 * @property {number|null} humanWaitMs - sum of human-wait windows; null if ANY human-wait window is unpaired
 * @property {number|null} humanWaitPct - humanWaitMs / totalMs × 100 (one decimal); null when either is null or total is 0
 */

/**
 * Fold `wall-clock-start` / `wall-clock-end` events into measured windows.
 * Pure; never throws; non-array input yields an empty summary.
 *
 * Every number here is either a measurement or `null`. In particular:
 *   - a start with no end → `durationMs: null` and an `unpaired` entry
 *   - an end with no start → `unpaired` entry only (nothing to measure)
 *   - end before start (clock skew, hand-edited log) → `durationMs: null`
 *   - `humanWaitPct` is `null` whenever any of its inputs is — a percentage
 *     over a partial sum would be a number that was never measured
 *
 * No threshold is applied. The reader compares `humanWaitPct` against
 * `config.split.humanWaitReevalPct` and says so in the report; this function
 * has no opinion.
 *
 * @param {object[]} events - raw events (any mix; non-wall-clock types are ignored)
 * @returns {WallClockSummary}
 */
export function summarizeWallClock(events) {
  const empty = { segments: [], unpaired: [], totalMs: null, humanWaitMs: null, humanWaitPct: null };
  if (!Array.isArray(events)) return empty;

  const open = [];
  const segments = [];
  const unpaired = [];

  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue;
    const segment = typeof ev.data?.segment === 'string' && ev.data.segment ? ev.data.segment : null;
    if (!segment) continue;
    const ts = typeof ev.ts === 'string' ? ev.ts : null;
    if (ev.type === WALL_CLOCK_START) {
      const entry = {
        segment,
        humanWait: ev.data?.humanWait === true,
        startedAt: ts,
        endedAt: null,
        durationMs: null,
      };
      open.push(entry);
      segments.push(entry);
    } else if (ev.type === WALL_CLOCK_END) {
      const entry = popMatchingSegment(open, segment);
      if (!entry) {
        unpaired.push({ segment, side: 'end', ts });
        continue;
      }
      entry.endedAt = ts;
      const startMs = tsToMs(entry.startedAt);
      const endMs = tsToMs(entry.endedAt);
      entry.durationMs = Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs
        ? endMs - startMs
        : null;
    }
  }
  for (const entry of open) {
    unpaired.push({ segment: entry.segment, side: 'start', ts: entry.startedAt });
  }

  const run = segments.find((s) => s.segment === RUN_SEGMENT);
  const totalMs = run && run.durationMs !== null ? run.durationMs : null;

  const humanSegments = segments.filter((s) => s.humanWait);
  let humanWaitMs = null;
  if (humanSegments.length > 0 && humanSegments.every((s) => s.durationMs !== null)) {
    humanWaitMs = humanSegments.reduce((sum, s) => sum + s.durationMs, 0);
  }

  const humanWaitPct = totalMs !== null && totalMs > 0 && humanWaitMs !== null
    ? Math.round((humanWaitMs / totalMs) * 1000) / 10
    : null;

  return { segments, unpaired, totalMs, humanWaitMs, humanWaitPct };
}
