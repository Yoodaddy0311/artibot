#!/usr/bin/env node
/**
 * Feed the dispatched `/split` limb into the Structured Task Graph (OB-12 / OB-15).
 *
 * `schemas/task-graph.schema.json` has named `/split plan.json` limbs as a
 * feeder since it was written, and `state-manager.js` has carried
 * `claimTask` / `releaseTask` / `heartbeatWorker` just as long. Measured
 * 2026-09-21 against the live store, NEITHER half had a caller: 0 `task.upsert`
 * and 0 `lease.set` records in `project-state.jsonl`, 0 `worker/task` events in
 * the ledger, and `file_ownership` present nowhere. This module is the first
 * production caller of both, and it is bound to exactly ONE moment — the
 * dispatch that hands a limb to a window.
 *
 * ── RECORD-ONLY, FAIL-OPEN, in full ──────────────────────────────────────
 * `feedLimb` NEVER throws and never alters what `dispatch` does. Every failure
 * — no session id, no mission row, a store constructor TypeError, a refused
 * ledger port, a CAS conflict — becomes a `skipped:<reason>` string in the
 * dispatch result. Nothing here may change an exit code, a written file or an
 * existing output key. The write side of `/split` (run.json, plan.json,
 * brief/prompt materialisation) does not consult this module's answer.
 *
 * ── Why a mission row is a PRECONDITION, never a side effect ─────────────
 * `state-manager.js#updateMission` creates the row when the mutator returns
 * one, but a store row whose mission has no `mission.created` ledger event is
 * an ORPHAN by `/doctor` Check 8-③'s own definition. The `mission.created`
 * append belongs to the UserPromptSubmit pipeline
 * (`lib/runtime/middleware/tasks.js`), not here, so this module reads the
 * mission and skips when there is none. Measured 2026-09-21: `mission.created`
 * 35 vs store writes 32 on the live ledger — "an event exists, therefore a row
 * exists" is FALSE, which is why the row is re-checked rather than assumed.
 *
 * ── Which mission ────────────────────────────────────────────────────────
 * The one the DISPATCHING session owns, by the `-S<sid8>` tail that
 * `post-compact-rehydrate.js#selectMissionForSession` already resolves
 * fail-closed (two candidates -> neither). That function is imported, not
 * re-derived: a second suffix rule would let the hook and this script disagree
 * about who owns a mission. Observed 2026-09-21: a mission row appears only
 * for sessions that passed UserPromptSubmit, so a `/split` WINDOW generally has
 * none — the leader session running `dispatch` is the one that does.
 *
 * @module scripts/split/task-feed
 */

import { createStateStore } from '../../lib/project-state/state-manager.js';
import { resolveGitCommonDir } from '../../lib/project-state/git-common-dir.js';
import { appendLedgerEvent } from '../../lib/runtime/ledger.js';
import { LIMB_LEASE_TTL_MS, mergeLimbTasks } from '../../lib/topology/split-task-feed.js';
import { TERMINAL_TASK_STATUSES } from '../../lib/project-state/validate.js';
import { selectMissionForSession } from '../hooks/post-compact-rehydrate.js';

/** Ledger/journal `reason` for the graph write this module makes. */
export const FEED_REASON = 'split.task-feed';

/**
 * The session id, from the host env.
 *
 * `CLAUDE_CODE_SESSION_ID` is what the host actually sets; `CLAUDE_SESSION_ID`
 * is read as a fallback because the docs used that spelling and a script that
 * trusted it alone measured an empty string (Wave 16, 2026-09-21). An empty or
 * absent value is reported as absent rather than defaulted — a fabricated id
 * would bind the graph to a session that never ran.
 *
 * @param {Record<string, string|undefined>} [env=process.env] - Environment.
 * @returns {string|null} The session id, or null.
 */
export function sessionIdFromEnv(env = process.env) {
  for (const key of ['CLAUDE_CODE_SESSION_ID', 'CLAUDE_SESSION_ID']) {
    const v = env?.[key];
    if (typeof v === 'string' && v !== '') return v;
  }
  return null;
}

/**
 * Open the StateStore this module writes through.
 *
 * `resolveGitCommonDir` is bound DELIBERATELY: without it `resolveStoreLocation`
 * takes the reported per-worktree fallback and `/split` would grow a second,
 * divergent store next to the one every other writer uses.
 *
 * @param {string} projectRoot - Parent (main checkout) root.
 * @param {string} sessionId - Dispatching session id.
 * @returns {object} A StateStore.
 */
export function openFeedStore(projectRoot, sessionId) {
  return createStateStore({
    projectRoot,
    sessionId,
    source: 'supervisor',
    // The projection is `/split`'s own `state.yaml` surface and is owned by
    // `lib/topology/split-state.js`; re-rendering it from here would put two
    // writers on one file for a bookkeeping write.
    renderProjectionFile: false,
    appendEvent: (envelope) => appendLedgerEvent(projectRoot, envelope),
    resolveGitCommonDir: () => resolveGitCommonDir(projectRoot),
  });
}

/** @param {string} reason @returns {object} The skip result shape. */
function skipped(reason) {
  return { fed: false, skipped: reason, missionId: null, taskId: null, added: [], refreshed: [], claim: null };
}

/**
 * Merge the plan into the snapshot's graph and write it, with ONE CAS retry.
 *
 * The graph is merged from `state` and the CAS is guarded by THAT snapshot's
 * `state_version`, so a commit landing between the read and the write is a
 * conflict. On a conflict the snapshot is re-read and the merge re-run before
 * the retry — the graph is passed whole as `opts.graph`, not computed inside
 * the lock, so retrying with a fresh version alone would rewrite the stale
 * graph over the intervening commit (a concurrent limb's claim, measured).
 *
 * One retry and not a loop, matching `lib/runtime/middleware/tasks.js`: a
 * second conflict means sustained contention, and spinning on a lock would
 * delay the dispatch the leader is waiting on.
 *
 * The mutator is `(cur) => cur` — PRESERVING. `updateMission` writes whatever
 * the mutator returns, so composing a title or an intent here would overwrite
 * the dispatching session's own mission with this script's idea of it.
 *
 * @param {object} store - StateStore.
 * @param {object} state - The snapshot the mission was selected from.
 * @param {string} missionId - Mission id.
 * @param {object|null} plan - Parsed `plan.json`.
 * @param {string} limb - The dispatched limb.
 * @returns {{merged: object, commit: object|null}} The last merge, and its commit
 *   result (null when nothing was written: an unchanged merge, or no `limb` task).
 */
function mergeAndWrite(store, state, missionId, plan, limb) {
  let snapshot = state;
  for (let attempt = 0; ; attempt += 1) {
    const graph = snapshot.task_graphs?.[missionId] ?? null;
    const merged = mergeLimbTasks({ graph, plan, missionId, now: new Date() });
    // A limb absent from the merge is skipped by the caller; seed nothing for it.
    if (merged.unchanged || !merged.graph.tasks.some((t) => t.id === limb)) return { merged, commit: null };
    const commit = store.updateMission(missionId, (cur) => cur, {
      reason: FEED_REASON, graph: merged.graph, expectedVersion: snapshot.state_version,
    });
    if (commit.conflict !== true || attempt >= 1) return { merged, commit };
    snapshot = store.getState();
  }
}

/**
 * Claim the limb's task, or renew the claim this same limb already holds.
 *
 * A lease held by SOMEONE ELSE is reported, never broken — whether or not it
 * has expired, since `getLease` does not judge expiry and reclaiming is CA-09's
 * decision, which the design puts behind a Canary. A lease held by this limb
 * is a re-dispatch of a window that is still working, so the heartbeat is
 * renewed instead.
 *
 * A task that already reached a TERMINAL status is left alone. `releaseTask`
 * clears the lease when a limb finishes, so without this guard a second
 * dispatch of a landed limb would find no lease, claim it, and walk `done`
 * back to `claimed` — measured, and exactly the regression the merge is
 * written to prevent. `failed` is NOT terminal here (`TERMINAL_TASK_STATUSES`):
 * re-dispatching a failed limb IS the retry.
 *
 * @param {object} store - StateStore.
 * @param {string} missionId - Mission id.
 * @param {string} limb - Task id and owner.
 * @param {object|undefined} task - The merged task node for `limb`.
 * @returns {string} One of `claimed` | `reclaimed` | `renewed` | `terminal:<status>` |
 *   `held-by:<owner>` | `refused:<msg>`.
 */
function claimLimb(store, missionId, limb, task) {
  if (TERMINAL_TASK_STATUSES.includes(task?.status)) return `terminal:${task.status}`;
  const held = store.getLease(missionId, limb);
  if (held && held.owner !== limb) return `held-by:${held.owner}`;
  if (held) {
    const beat = store.heartbeatWorker({ missionId, taskId: limb, owner: limb, reason: FEED_REASON });
    return beat.ok ? 'renewed' : `refused:${beat.errors?.[0] ?? 'heartbeat-failed'}`;
  }
  const claim = store.claimTask({ missionId, taskId: limb, owner: limb, ttlMs: LIMB_LEASE_TTL_MS, reason: FEED_REASON });
  if (!claim.ok) return `refused:${claim.errors?.[0] ?? 'claim-failed'}`;
  return claim.reclaimed ? 'reclaimed' : 'claimed';
}

/**
 * Seed and claim one dispatched limb. Total — returns a result for every input.
 *
 * @param {object} params - Feed inputs.
 * @param {string} params.parentRoot - Parent (main checkout) root.
 * @param {object|null} params.plan - Parsed `plan.json`, as `dispatch` already read it.
 * @param {string} params.limb - The limb being dispatched.
 * @param {boolean} [params.dryRun=false] - True writes NOTHING and opens no store.
 * @param {string|null} [params.sessionId] - Override; defaults to the host env.
 * @param {{ openStore?: Function }} [ports] - Test seam.
 * @returns {{fed: boolean, skipped: string|null, missionId: string|null, taskId: string|null,
 *   added: string[], refreshed: string[], claim: string|null, stateVersion?: number, location?: string}}
 * @example
 * feedLimb({ parentRoot, plan, limb: 'auth' }); // { fed: true, claim: 'claimed', ... }
 */
export function feedLimb({ parentRoot, plan, limb, dryRun = false, sessionId }, ports = {}) {
  try {
    if (dryRun) return skipped('dry-run');
    if (typeof parentRoot !== 'string' || parentRoot === '') return skipped('no-project-root');
    if (typeof limb !== 'string' || limb === '') return skipped('no-limb');
    const sid = sessionId ?? sessionIdFromEnv();
    if (typeof sid !== 'string' || sid === '') return skipped('no-session-id');

    const store = (ports.openStore ?? openFeedStore)(parentRoot, sid);
    const state = store.getState();
    const { missionId } = selectMissionForSession(state, sid);
    // Re-checked against the snapshot rather than trusted: the selector's
    // contract is "a mission this session owns", and creating one here is the
    // orphan this module must not make.
    if (!missionId || !state.active_missions?.[missionId]) return skipped('no-mission');

    const { merged, commit } = mergeAndWrite(store, state, missionId, plan, limb);
    const task = merged.graph.tasks.find((t) => t.id === limb);
    if (!task) return skipped('limb-not-in-plan');

    let stateVersion = state.state_version;
    if (commit) {
      if (!commit.ok) return { ...skipped(`graph-write-refused:${commit.errors?.[0] ?? 'unknown'}`), missionId };
      stateVersion = commit.state_version ?? stateVersion;
    }

    const claim = claimLimb(store, missionId, limb, task);
    return {
      fed: true,
      skipped: null,
      missionId,
      taskId: limb,
      added: merged.added,
      refreshed: merged.refreshed,
      claim,
      stateVersion: store.getState().state_version ?? stateVersion,
      location: store.location?.source ?? null,
    };
  } catch (err) {
    // Including the store constructor's TypeErrors. A dispatch must not fail
    // because bookkeeping did.
    return skipped(`store-threw:${err?.message ?? 'unknown'}`);
  }
}
