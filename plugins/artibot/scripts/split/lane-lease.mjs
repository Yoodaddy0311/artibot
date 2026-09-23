/**
 * Carry a `/split` lane transition into the limb's StateStore lease.
 *
 * `task-feed.mjs#feedLimb` claims the limb's task at dispatch with a 24h TTL
 * (`lib/topology/split-task-feed.js#LIMB_LEASE_TTL_MS`). Measured 2026-09-23,
 * that lease had one renewal path (a re-dispatch) and NO release path:
 * `releaseTask` had 0 callers outside `lib/project-state/` and the tests. A
 * landed limb therefore sat `claimed` for the whole TTL, and the feeder's
 * `terminal:done` guard could not be reached in production. The leader's
 * `lane-state <limb> <state>` is the moment the lane's fate is declared, so
 * this module maps that word onto the lease — {@link LANE_LEASE_ACTIONS}.
 *
 * ── RECORD-ONLY, FAIL-OPEN — the same contract as task-feed ─────────────
 * `syncLaneLease` NEVER throws. No session id, no mission row, no task, a
 * lease held by someone else, a store constructor TypeError, a refused ledger
 * port — each becomes an `outcome` string, and `lane-state` prints it under
 * one `lease` key without changing its exit code or its existing output.
 * A mission row is a precondition, never a side effect (task-feed's header
 * gives the orphan argument); a lease held by another owner is reported and
 * never broken.
 *
 * ── No new ledger vocabulary (D-B1) ─────────────────────────────────────
 * Every write goes through `heartbeatWorker` / `releaseTask`, whose only
 * ledger event is the store's own `state.updated`, attributed by
 * {@link LANE_LEASE_REASON}. `task.released` stays `writeWorkerState`'s event
 * to owe; this module does not append it.
 *
 * ── Why the CLI and not `setLaneState` ──────────────────────────────────
 * `scripts/split/dispatch.mjs` calls `setLaneState` directly and then feeds
 * the limb, which already renews a held lease. Syncing inside `setLaneState`
 * would renew it twice per dispatch, so only `lane-state.mjs#main` calls this.
 *
 * @module scripts/split/lane-lease
 */

import { selectMissionForSession } from '../hooks/post-compact-rehydrate.js';
import { openFeedStore, sessionIdFromEnv } from './task-feed.mjs';

/** Ledger/journal `reason` for the store writes this module makes. */
export const LANE_LEASE_REASON = 'split.lane-lease';

/**
 * What each ops state (`lib/supervisor/contracts.js#LANE_OPS_STATES`) does to
 * the lease. An allowlist: a state missing here — a new ops word included —
 * does nothing, and `tests/scripts/lane-lease.test.js` fails until it is
 * classified.
 *
 * - `heartbeat` — the lane is being worked; renew the lease this limb holds.
 * - `release`   — the lane finished; drop the lease and set the task status
 *   to the same word (`done` and the failed word are both task statuses).
 *   The split is `split-state.js#ledgerEventNameFor`'s own: those two are the
 *   transitions that owe `task.released`.
 * - `none`      — not yet dispatched, or parked: nothing to say to the lease.
 */
export const LANE_LEASE_ACTIONS = Object.freeze({
  pending: 'none',
  active: 'heartbeat',
  'awaiting-dispatch': 'none',
  review: 'heartbeat',
  'serial-gate': 'heartbeat',
  closing: 'heartbeat',
  done: 'release',
  suspended: 'none',
  failed: 'release',
});

/** @param {string} outcome @param {string|null} [missionId] @returns {{outcome: string, missionId: string|null}} */
function result(outcome, missionId = null) {
  return { outcome, missionId };
}

/** @param {object} commit - A store commit result. @param {string} ok - Outcome on success. @returns {string} */
function commitOutcome(commit, ok) {
  return commit.ok ? ok : `refused:${commit.errors?.[0] ?? 'unknown'}`;
}

/**
 * Apply one lane transition to the limb's lease. Total — returns for every input.
 *
 * @param {object} [input] - Sync inputs.
 * @param {string} input.parentRoot - Parent (main checkout) root.
 * @param {string} input.limb - Limb; also the task id and the lease owner, as in task-feed.
 * @param {string} input.state - The ops state just written.
 * @param {string|null} [input.sessionId] - Override; defaults to the host env.
 * @param {{ openStore?: Function }} [ports] - Test seam.
 * @returns {{outcome: string, missionId: string|null}} `outcome` is one of `renewed` |
 *   `released:<status>` | `unchanged` | `held-by:<owner>` | `refused:<msg>` | `skipped:<reason>`.
 * @example
 * syncLaneLease({ parentRoot, limb: 'auth', state: 'done' }); // { outcome: 'released:done', missionId: 'M-…' }
 */
export function syncLaneLease(input, ports = {}) {
  try {
    const { parentRoot, limb, state, sessionId } = input ?? {};
    const action = Object.hasOwn(LANE_LEASE_ACTIONS, state) ? LANE_LEASE_ACTIONS[state] : 'none';
    if (action === 'none') return result('skipped:no-transition');
    if (typeof parentRoot !== 'string' || parentRoot === '') return result('skipped:no-project-root');
    if (typeof limb !== 'string' || limb === '') return result('skipped:no-limb');
    const sid = sessionId ?? sessionIdFromEnv();
    if (typeof sid !== 'string' || sid === '') return result('skipped:no-session-id');

    const store = (ports.openStore ?? openFeedStore)(parentRoot, sid);
    const snapshot = store.getState();
    const { missionId } = selectMissionForSession(snapshot, sid);
    // Re-checked, not trusted — see task-feed: creating the row here is the orphan.
    if (!missionId || !snapshot.active_missions?.[missionId]) return result('skipped:no-mission');
    const task = snapshot.task_graphs?.[missionId]?.tasks?.find((t) => t?.id === limb);
    if (!task) return result('skipped:no-task', missionId);

    // Pre-checked for a readable outcome; the store re-checks the owner inside
    // its lock, so a lease taken between this read and the write is still refused.
    const held = snapshot.task_leases?.[missionId]?.[limb] ?? null;
    if (held && held.owner !== limb) return result(`held-by:${held.owner}`, missionId);

    if (action === 'heartbeat') {
      if (!held) return result('skipped:no-lease', missionId);
      const beat = store.heartbeatWorker({ missionId, taskId: limb, owner: limb, reason: LANE_LEASE_REASON });
      return result(commitOutcome(beat, 'renewed'), missionId);
    }
    // `releaseTask` commits even when nothing would change, so a re-asserted
    // `done` would add a `state.updated` per run. Nothing held and the status
    // already there is the state the release would produce.
    if (!held && task.status === state) return result('unchanged', missionId);
    const released = store.releaseTask({ missionId, taskId: limb, owner: limb, status: state, reason: LANE_LEASE_REASON });
    return result(commitOutcome(released, `released:${state}`), missionId);
  } catch (err) {
    // Including the store constructor's TypeErrors. A lane write must not
    // fail because bookkeeping did.
    return result(`skipped:store-threw:${err?.message ?? 'unknown'}`);
  }
}
