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
 * A release follows the lane word even over a finished task: a task already
 * `done` (or `cancelled`) with no lease is rewritten to the failed status by
 * a lane `failed`. That is intended — the lane word is the operator's
 * declaration, and failed means retry, as in task-feed's
 * `TERMINAL_TASK_STATUSES` stance.
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
 * ── A BOUND run (SH-11) ─────────────────────────────────────────────────
 * The mission comes from the run's binding (`task-feed.mjs#resolveRunMission`),
 * never from the session, and a binding that cannot be honoured is a
 * `skipped:<reason>` — not a fall back to the session. The lane write of a
 * bound run is already ONE store commit that carries the heartbeat stamp and
 * the release of `status`/`owner` on the NODE (`lib/topology/split-state.js`),
 * but it never touches the lease RECORD: the bound feed takes that at dispatch,
 * BESIDE the node (`task-feed.mjs#leaseBesideNode` — `claimTask` with the
 * node's own status, not `claimed` forced over its ops word), and this sync
 * renews and releases it like any other lease: `renewed` while working,
 * `released:<state>` at `done`/`failed` — each a second store commit, the lane
 * write being the first — and `unchanged` (no write) on a repeat. A limb the
 * feed left no lease for — its `lease` key said `skipped:status-<status>` or
 * `refused:<msg>`, or the feed skipped — costs nothing here: `unchanged` at a
 * finishing state, `skipped:no-lease` while working. A lease taken BEFORE the
 * run was bound is renewed and released on the same terms.
 *
 * With the canary key off (`split.missionBinding.enabled`, shipped `false`;
 * `task-feed.mjs#missionBindingEnabled`) a run that carries a record is
 * synced by the LEGACY rule — the session's own mission, ordinary lease
 * semantics — and every result after the mission is resolved adds
 * `binding: { status: 'disabled' }`.
 *
 * @module scripts/split/lane-lease
 */

import { missionBindingEnabled, openFeedStore, resolveRunMission, sessionIdFromEnv } from './task-feed.mjs';

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

/**
 * @param {string} outcome
 * @param {string|null} [missionId]
 * @param {{ binding?: object }} [note] - `{binding: {status:'disabled'}}` when the canary switch is not honouring the run's record
 * @returns {{outcome: string, missionId: string|null, binding?: object}}
 */
function result(outcome, missionId = null, note = {}) {
  return { outcome, missionId, ...note };
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
 * @param {{ openStore?: Function, config?: object|null }} [ports] - Test seam. `config`: the parsed artibot.config.json the canary key is read from (`null` = no config = off; absent = read the shipped file).
 * @returns {{outcome: string, missionId: string|null, binding?: {status: 'disabled'}}} `outcome` is one of `renewed` |
 *   `released:<status>` | `unchanged` | `held-by:<owner>` | `refused:<msg>` | `skipped:<reason>`.
 *   `binding` is present only when the run carries a record the switch is not honouring.
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
    const resolved = resolveRunMission({ parentRoot, state: snapshot, sessionId: sid, honorBinding: () => missionBindingEnabled(ports) });
    if (resolved.mode === 'rejected') return result(`skipped:${resolved.reason}`, resolved.missionId);
    const { missionId } = resolved;
    // A run whose record the canary switch is not honouring is synced by the
    // legacy rule, and every result from here on says so.
    const note = resolved.mode === 'legacy' && resolved.binding ? { binding: resolved.binding } : {};
    // Re-checked, not trusted — see task-feed: creating the row here is the orphan.
    if (!missionId || !snapshot.active_missions?.[missionId]) return result('skipped:no-mission', null, note);
    const task = snapshot.task_graphs?.[missionId]?.tasks?.find((t) => t?.id === limb);
    if (!task) return result('skipped:no-task', missionId, note);

    // Pre-checked for a readable outcome; the store re-checks the owner inside
    // its lock, so a lease taken between this read and the write is still refused.
    const held = snapshot.task_leases?.[missionId]?.[limb] ?? null;
    if (held && held.owner !== limb) return result(`held-by:${held.owner}`, missionId, note);

    if (action === 'heartbeat') {
      if (!held) return result('skipped:no-lease', missionId, note);
      const beat = store.heartbeatWorker({ missionId, taskId: limb, owner: limb, reason: LANE_LEASE_REASON });
      return result(commitOutcome(beat, 'renewed'), missionId, note);
    }
    // `releaseTask` commits even when nothing would change, so a re-asserted
    // `done` would add a `state.updated` per run. Nothing held and the status
    // already there is the state the release would produce.
    if (!held && task.status === state) return result('unchanged', missionId, note);
    const released = store.releaseTask({ missionId, taskId: limb, owner: limb, status: state, reason: LANE_LEASE_REASON });
    return result(commitOutcome(released, `released:${state}`), missionId, note);
  } catch (err) {
    // Including the store constructor's TypeErrors. A lane write must not
    // fail because bookkeeping did.
    return result(`skipped:store-threw:${err?.message ?? 'unknown'}`);
  }
}
