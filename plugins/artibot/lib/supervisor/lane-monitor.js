/**
 * Lane monitor — health classification for one lane. Pure.
 *
 * Implements the design §03 "Stuck 판정" table with the evidence priority the
 * design fixes (structured events first, git second, session observation
 * third — never message scraping):
 *
 * | evidence                                             | health        |
 * |------------------------------------------------------|---------------|
 * | git says complete (`Split-Limb: done` trailer)       | `done`        |
 * | lane state is DONE                                   | `done`        |
 * | session absent + worktree dirty                      | `recoverable` |
 * | session absent + worktree clean (or no commit)       | `restart`     |
 * | session absent + dirtiness unknown                   | `unknown`     |
 * | liveness age < `suspectHeartbeatSeconds` (8 min)     | `healthy`     |
 * | liveness age < `staleHeartbeatSeconds` (15 min)      | `suspect`     |
 * | liveness age ≥ `staleHeartbeatSeconds`               | `inspect`     |
 * | no liveness signal at all / clock skew / bad input   | `unknown`     |
 *
 * "Liveness" is `lane.lastHeartbeatAt` (structured event) when present, else
 * `gitEvidence.lastCommitAt` (a commit proves the worker was alive at that
 * moment — weaker, since a long implementation step commits nothing, so the
 * result names which signal it used). Missing inputs NEVER yield `healthy`:
 * the acceptance rule is "unknown/ambiguous → fail-closed".
 *
 * Thresholds are inputs (`thresholds`) so the caller reads them from
 * `artibot.config.json#split.supervisor` — this module holds only the
 * defaults the design quotes. Nothing here acts on the verdict.
 *
 * @module lib/supervisor/lane-monitor
 */

import { isLaneOpsState, LANE_OPS_TO_LANE_STATE } from './contracts.js';

/** Design §03 defaults: 8 min suspect, 15 min inspect. */
export const DEFAULT_THRESHOLDS = Object.freeze({
  suspectHeartbeatSeconds: 480,
  staleHeartbeatSeconds: 900,
});

/** Every value `assessLane` can return in `health`, allowlist order. */
export const HEALTH_STATES = Object.freeze([
  'healthy', 'suspect', 'inspect', 'recoverable', 'restart', 'done', 'unknown',
]);

/**
 * @param {unknown} v
 * @returns {number} ms or NaN
 */
function toMs(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  if (typeof v === 'string') {
    const n = Date.parse(v);
    return Number.isFinite(n) ? n : NaN;
  }
  return NaN;
}

/**
 * @param {unknown} t
 * @returns {{ suspectHeartbeatSeconds: number, staleHeartbeatSeconds: number }}
 */
function resolveThresholds(t) {
  const src = t && typeof t === 'object' ? t : {};
  const pick = (key) => {
    const v = src[key];
    return Number.isFinite(v) && v > 0 ? v : DEFAULT_THRESHOLDS[key];
  };
  let suspect = pick('suspectHeartbeatSeconds');
  const stale = pick('staleHeartbeatSeconds');
  if (suspect >= stale) suspect = stale; // a misordered config collapses the suspect band rather than inverting it
  return { suspectHeartbeatSeconds: suspect, staleHeartbeatSeconds: stale };
}

/**
 * @typedef {object} LaneAssessment
 * @property {'healthy'|'suspect'|'inspect'|'recoverable'|'restart'|'done'|'unknown'} health
 * @property {'complete'|'lane-state'|'session'|'heartbeat'|'commit'|'none'} signal - which evidence decided
 * @property {number|null} ageSeconds - age of the liveness signal, when one was used
 * @property {string} reason - one human-readable line
 */

/**
 * Classify one lane. Pure; never throws; every missing input degrades toward
 * `unknown`, never toward `healthy`.
 *
 * @param {object} input
 * @param {{ state?: string, lastHeartbeatAt?: string|null }|null} [input.lane] - reduced lane state (`state-reducer.js`)
 * @param {number} input.nowMs - the caller's clock (epoch ms); pure functions do not read `Date.now()`
 * @param {{ lastCommitAt?: string|null, complete?: boolean, dirty?: boolean|null }} [input.gitEvidence]
 *   `complete` from `lib/git/limb-completion.js`; `lastCommitAt` = `git log -1 --format=%cI`;
 *   `dirty` = working tree has changes (`null` when not measured)
 * @param {{ present?: boolean|null }} [input.session] - is a Claude session attached to the worktree?
 *   `null`/absent = not observed (the common case: `ListAgents` is main-session only)
 * @param {{ suspectHeartbeatSeconds?: number, staleHeartbeatSeconds?: number }} [input.thresholds]
 * @returns {LaneAssessment}
 */
export function assessLane({ lane, nowMs, gitEvidence, session, thresholds } = {}) {
  const git = gitEvidence && typeof gitEvidence === 'object' ? gitEvidence : {};
  const sess = session && typeof session === 'object' ? session : {};
  const th = resolveThresholds(thresholds);
  const laneState = lane && typeof lane === 'object' && typeof lane.state === 'string' ? lane.state : null;

  if (git.complete === true) {
    return { health: 'done', signal: 'complete', ageSeconds: null, reason: 'Split-Limb: done trailer read from git' };
  }
  if (laneState === 'DONE') {
    return { health: 'done', signal: 'lane-state', ageSeconds: null, reason: 'lane state is DONE' };
  }

  if (sess.present === false) {
    if (git.dirty === true) {
      return { health: 'recoverable', signal: 'session', ageSeconds: null, reason: 'session absent, worktree dirty — uncommitted work to recover' };
    }
    if (git.dirty === false) {
      const why = typeof git.lastCommitAt === 'string' ? 'worktree clean' : 'no commit';
      return { health: 'restart', signal: 'session', ageSeconds: null, reason: `session absent, ${why} — nothing to recover, lane must restart` };
    }
    return { health: 'unknown', signal: 'session', ageSeconds: null, reason: 'session absent, worktree dirtiness not measured' };
  }

  const now = toMs(nowMs);
  if (!Number.isFinite(now)) {
    return { health: 'unknown', signal: 'none', ageSeconds: null, reason: 'nowMs missing or not a number' };
  }

  let signal = 'none';
  let at = NaN;
  const hb = toMs(lane && typeof lane === 'object' ? lane.lastHeartbeatAt : null);
  if (Number.isFinite(hb)) {
    signal = 'heartbeat';
    at = hb;
  } else {
    const commit = toMs(git.lastCommitAt);
    if (Number.isFinite(commit)) {
      signal = 'commit';
      at = commit;
    }
  }
  if (signal === 'none') {
    return { health: 'unknown', signal, ageSeconds: null, reason: 'no heartbeat and no commit timestamp' };
  }
  const ageSeconds = Math.floor((now - at) / 1000);
  if (ageSeconds < 0) {
    return { health: 'unknown', signal, ageSeconds, reason: `${signal} is ${-ageSeconds}s in the future (clock skew)` };
  }
  if (ageSeconds < th.suspectHeartbeatSeconds) {
    return { health: 'healthy', signal, ageSeconds, reason: `${signal} ${ageSeconds}s ago (< ${th.suspectHeartbeatSeconds}s)` };
  }
  if (ageSeconds < th.staleHeartbeatSeconds) {
    return { health: 'suspect', signal, ageSeconds, reason: `${signal} ${ageSeconds}s ago (${th.suspectHeartbeatSeconds}–${th.staleHeartbeatSeconds}s)` };
  }
  return { health: 'inspect', signal, ageSeconds, reason: `${signal} ${ageSeconds}s ago (>= ${th.staleHeartbeatSeconds}s)` };
}

/**
 * Read the leader's operational state for a limb from `run.json`.
 * Accepts `lanes[limb]` as either a string or `{ state }`. Anything outside
 * `LANE_OPS_STATES` — including a missing `lanes` block — is `null`
 * ("unknown"), which callers must treat as *not known to be idle*
 * (`scripts/split/fanout-probe.mjs` alerts on it).
 *
 * @param {object|null|undefined} runJson - parsed `<parentRoot>/.artibot/split/run.json`
 * @param {string} limb
 * @returns {string|null}
 */
export function readLaneOpsState(runJson, limb) {
  if (!runJson || typeof runJson !== 'object' || typeof limb !== 'string' || !limb) return null;
  const lanes = runJson.lanes;
  if (!lanes || typeof lanes !== 'object') return null;
  const entry = lanes[limb];
  const raw = typeof entry === 'string' ? entry : (entry && typeof entry === 'object' ? entry.state : null);
  return isLaneOpsState(raw) ? raw : null;
}

/**
 * Map an operational state to the design lane state (`contracts.js`
 * `LANE_OPS_TO_LANE_STATE`). Unknown → `null`.
 *
 * @param {string|null} opsState
 * @returns {string|null}
 */
export function opsStateToLaneState(opsState) {
  return isLaneOpsState(opsState) ? LANE_OPS_TO_LANE_STATE[opsState] : null;
}
