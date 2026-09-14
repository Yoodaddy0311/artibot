/**
 * Lane reconcile — "does the recorded state agree with git?". Pure.
 *
 * Design §3.5 (`.artibot/guides/v5-design/ARTIBOT-5.0-DESIGN.md:198`) fixes
 * the resume rule as three steps: *read the state → compare against git →
 * every disagreement becomes `blocked_by:['reconcile:…']`, fail-closed*. This
 * module is only the third step. It does not read files, does not run git, and
 * does not decide anything about resuming — the caller brings the evidence and
 * the caller acts (or, in DR02, does not act: `/resume --contract` reports).
 *
 * ── Why a separate module instead of growing `lane-monitor.js` ────────────
 * `assessLane` answers "is this worker alive?" from a liveness signal. That is
 * a different question from "do two records of the same lane agree?", and it
 * already has a settled evidence priority that the resume path must not
 * relitigate. So this module *calls* {@link assessLane} and only translates
 * its verdict into the `blocked_by` vocabulary; `lane-monitor.js`,
 * `contracts.js` and `state-reducer.js` stay untouched.
 *
 * ── Only one prefix belongs here ───────────────────────────────────────────
 * The design names four `blocked_by` prefixes — `lane:` / `gate:` / `human:` /
 * `reconcile:`. A state-vs-git disagreement is always the fourth, so every
 * string this module can emit is in {@link RECONCILE_REASONS} and every one of
 * them starts with `reconcile:`. The other three have other owners; emitting
 * them from here would make the prefix stop telling the reader who to ask.
 *
 * ── Fail-closed, three ways ────────────────────────────────────────────────
 *  1. An ops state outside `LANE_OPS_STATES` is `reconcile:ops-state-unknown`,
 *     never "probably fine". **This is the live default today**: the leader
 *     writes `dispatched` (Wave 9 `run.json`) and `landed` (Wave 8 archive),
 *     and neither word is in the allowlist, so `readLaneOpsState` returns
 *     `null` for every limb in both files. That drift is a REPORT item — this
 *     module reports it and deliberately does not widen the allowlist to make
 *     it disappear.
 *  2. `complete` evidence that was never measured (`undefined`) counts as "not
 *     complete". Absence of proof is not proof.
 *  3. Reasons accumulate. An unknown ops state that ALSO disagrees with git
 *     yields both strings, in a fixed order (ops → health → mismatch), so the
 *     output is stable enough to diff between runs.
 *
 * @module lib/supervisor/lane-reconcile
 */

import { assessLane, opsStateToLaneState, readLaneOpsState } from './lane-monitor.js';

/**
 * Every string this module can put into `blocked_by`. Frozen, and asserted
 * exhaustive by the test (emitted set === this list, both directions), so a
 * new reason cannot be introduced without being declared here.
 *
 * | reason | meaning |
 * |---|---|
 * | `reconcile:ops-state-unknown` | `run.json` holds a word outside `LANE_OPS_STATES` (live: `dispatched`, `landed`) |
 * | `reconcile:lane-suspect` | liveness signal is stale past the suspect threshold |
 * | `reconcile:lane-inspect` | liveness signal is stale past the inspect threshold |
 * | `reconcile:lane-recoverable` | no session, dirty worktree — uncommitted work |
 * | `reconcile:lane-restart` | no session, clean worktree — nothing to recover |
 * | `reconcile:lane-unknown` | no usable evidence at all |
 * | `reconcile:state-done-git-incomplete` | state says DONE, git does not say complete |
 * | `reconcile:git-complete-state-not-done` | git says complete, state does not say done |
 */
export const RECONCILE_REASONS = Object.freeze([
  'reconcile:ops-state-unknown',
  'reconcile:lane-suspect',
  'reconcile:lane-inspect',
  'reconcile:lane-recoverable',
  'reconcile:lane-restart',
  'reconcile:lane-unknown',
  'reconcile:state-done-git-incomplete',
  'reconcile:git-complete-state-not-done',
]);

/**
 * Health → reason. `healthy` and `done` are agreement, so they map to `null`
 * (no entry); the other five each name themselves. Written out rather than
 * templated from the health word so that adding a health value to
 * `HEALTH_STATES` shows up as an undefined lookup in the test instead of
 * silently minting an undeclared reason string.
 */
const HEALTH_TO_REASON = Object.freeze({
  healthy: null,
  done: null,
  suspect: 'reconcile:lane-suspect',
  inspect: 'reconcile:lane-inspect',
  recoverable: 'reconcile:lane-recoverable',
  restart: 'reconcile:lane-restart',
  unknown: 'reconcile:lane-unknown',
});

/**
 * @typedef {object} LaneReconcileResult
 * @property {string|null} limb
 * @property {string|null} opsState - the allowlisted ops word, or `null` when unknown
 * @property {string|null} laneState - the design lane state it projects onto
 * @property {import('./lane-monitor.js').LaneAssessment} assessment - `assessLane`'s verdict, passed through unedited
 * @property {string[]} blocked_by - zero or more {@link RECONCILE_REASONS}, in ops → health → mismatch order
 */

/**
 * @param {unknown} v
 * @returns {object}
 */
function asObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v) ? /** @type {object} */ (v) : {};
}

/**
 * Reconcile one lane. Pure; never throws; every missing input degrades toward
 * a reason, never toward silence.
 *
 * @param {object} [input]
 * @param {string} [input.limb]
 * @param {string|null} [input.opsState] - raw `run.json.lanes[limb].state`; anything off the allowlist reads as unknown
 * @param {{ lastHeartbeatAt?: string|null }|null} [input.lane] - reduced lane state; `lastHeartbeatAt` is null in production (no emitter)
 * @param {{ lastCommitAt?: string|null, complete?: boolean, dirty?: boolean|null }} [input.gitEvidence]
 * @param {{ present?: boolean|null }} [input.session]
 * @param {number} [input.nowMs] - the caller's clock; this module does not read `Date.now()`
 * @param {{ suspectHeartbeatSeconds?: number, staleHeartbeatSeconds?: number }} [input.thresholds]
 * @returns {LaneReconcileResult}
 */
export function reconcileLane({ limb, opsState, lane, gitEvidence, session, nowMs, thresholds } = {}) {
  const git = asObject(gitEvidence);
  const opsKnown = opsStateToLaneState(typeof opsState === 'string' ? opsState : null);
  const laneState = opsKnown;
  const assessment = assessLane({
    lane: { state: laneState, lastHeartbeatAt: asObject(lane).lastHeartbeatAt ?? null },
    nowMs,
    gitEvidence: git,
    session,
    thresholds,
  });

  const blockedBy = [];
  if (laneState === null) blockedBy.push('reconcile:ops-state-unknown');
  const healthReason = HEALTH_TO_REASON[assessment.health];
  if (healthReason) blockedBy.push(healthReason);
  if (laneState === 'DONE' && git.complete !== true) {
    blockedBy.push('reconcile:state-done-git-incomplete');
  } else if (git.complete === true && laneState !== 'DONE') {
    blockedBy.push('reconcile:git-complete-state-not-done');
  }

  return {
    limb: typeof limb === 'string' ? limb : null,
    opsState: opsKnown === null ? null : /** @type {string} */ (opsState),
    laneState,
    assessment,
    blocked_by: blockedBy,
  };
}

/**
 * The limbs to reconcile, in report order: `runJson.limbs` first (the leader's
 * own ordering), then any `lanes` key it omits, then any evidence key neither
 * mentions. A lane that appears in only one of the three is a disagreement in
 * itself, so the union is the fail-closed choice — dropping it would hide it.
 *
 * @param {object} run
 * @param {object} lanes
 * @returns {string[]}
 */
function limbOrder(run, lanes) {
  const out = [];
  const push = (name) => {
    if (typeof name === 'string' && name && !out.includes(name)) out.push(name);
  };
  if (Array.isArray(run.limbs)) run.limbs.forEach(push);
  Object.keys(asObject(run.lanes)).forEach(push);
  Object.keys(lanes).forEach(push);
  return out;
}

/**
 * Reconcile every limb of a `/split` run. Reads the ops state through
 * {@link readLaneOpsState} (so the allowlist is applied in exactly one place)
 * and pairs it with the caller's per-limb evidence.
 *
 * @param {object|null|undefined} runJson - the leader's parsed split `run.json` (same file `readLaneOpsState` documents)
 * @param {Record<string, { lane?: object, gitEvidence?: object, session?: object }>|null} [lanesInput]
 *   per-limb evidence the caller gathered; a limb with no entry reconciles as `unknown`
 * @param {{ nowMs?: number, thresholds?: object }} [options]
 * @returns {LaneReconcileResult[]}
 */
export function reconcileLanes(runJson, lanesInput, options) {
  const run = asObject(runJson);
  const lanes = asObject(lanesInput);
  const { nowMs, thresholds } = asObject(options);
  return limbOrder(run, lanes).map((limb) => {
    const evidence = asObject(lanes[limb]);
    return reconcileLane({
      limb,
      opsState: readLaneOpsState(run, limb),
      lane: evidence.lane,
      gitEvidence: evidence.gitEvidence,
      session: evidence.session,
      nowMs,
      thresholds,
    });
  });
}
