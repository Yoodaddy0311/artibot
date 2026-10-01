/**
 * Single-node Task Graph writes — the planning half of `store.updateTask`, and
 * the one judge of what `store.claimTask` may leave on a node (SH-11 pre-flip
 * conditions 1 and 2).
 *
 * ── Why a single-node door ────────────────────────────────────────────────
 * The store's only way to change one node used to be `updateMission(id, m =>
 * m, { graph })`, and `opts.graph` is a WHOLE-GRAPH replacement: one lane write
 * of a bound `/split` run journalled a `mission.upsert` (the row, unchanged) and
 * a `graph.upsert` carrying every other node, to change one. The record kind
 * the journal already has for this — `task.upsert`, a whole node after the
 * mutation, last-write-wins (`journal.js`) — was reachable only through the
 * lease calls, which set their own fields. {@link planTaskUpdate} is the same
 * kind of write for a caller that owns the node's fields: it hands the mutator
 * a clone of the stored node (`ops` and every other field included — the node
 * is the unit, so nothing a caller does not touch is dropped) and journals the
 * node it returns, and only that.
 *
 * ── Why claimTask needs a status argument ─────────────────────────────────
 * `claimTask` wrote `status: 'claimed'` over the node. For a node whose `ops`
 * record says the lane is `active` (status `executing`) that is a disagreement
 * between two fields of one node (`split-state-sources.js#assertOpsStatusAgree`,
 * B1), so the bound `/split` feeder could not take a lease at all — and with no
 * lease, the SH-12 heartbeat emitter (`scripts/split/lane-lease.mjs`) finds
 * nothing to renew for a bound run. {@link claimStatusError} judges the status
 * a caller may ask `claimTask` to leave instead: any word the 8-state
 * vocabulary lets carry an owner. The default stays `claimed`.
 *
 * ── What this module does NOT do ──────────────────────────────────────────
 * It opens no store and takes no lock: the commit (lock, CAS, ledger-first,
 * journal, snapshot) stays in `state-manager.js`, which hands its own `commit`
 * to {@link runTaskUpdate} — so there is no import back and no second copy of
 * the write order. It does not validate the node it is given beyond its id;
 * `validateSnapshot` judges the whole draft inside the commit and a node it
 * refuses comes back as `{ok: false, errors}` with nothing written. It does not
 * move the graph-level `updated_at` (neither do the lease calls) and it cannot
 * remove a node (`task.remove` has no caller here).
 *
 * @module lib/project-state/task-update
 */

import { clone } from './projection.js';
import { OWNED_TASK_STATUSES, validateMissionId } from './validate.js';

/**
 * Judge the status a claim may leave on the node. The 8-state vocabulary
 * permits an owner only for claimed / executing / reviewing
 * (`validate.js#OWNED_TASK_STATUSES`), and a claim names one — so those three
 * are the allowlist, and every other value (an unknown word, `null`, a number)
 * is refused rather than written and discovered later by `validateSnapshot`.
 *
 * @param {unknown} status - The `status` a caller passed to `claimTask`.
 * @returns {string|null} The reason it is refused, or `null` when it is allowed.
 */
export function claimStatusError(status) {
  if (OWNED_TASK_STATUSES.includes(status)) return null;
  return `claimTask: status '${String(status)}' cannot carry an owner — a claim names one, so the status must be one of ${OWNED_TASK_STATUSES.join('|')}`;
}

/**
 * The errors in `updateTask`'s addressing arguments. Checked BEFORE the commit,
 * like `updateMission` checks its mission id: a malformed id never takes the lock.
 *
 * @param {{ missionId: unknown, taskId: unknown }} ids
 * @returns {string[]} Errors; empty when both are usable.
 */
export function updateTaskArgErrors({ missionId, taskId }) {
  const errors = validateMissionId(missionId);
  if (typeof taskId !== 'string' || taskId === '') errors.push('updateTask: taskId must be a non-empty string');
  return errors;
}

/**
 * Plan one node's write from the CURRENT snapshot (the caller is inside the
 * store's lock, so the snapshot is the one the commit will be judged against).
 *
 * The mutator receives a clone of the stored node, or `null` when the mission's
 * graph has no such node (the write then creates it). It returns the node as it
 * should stand afterwards, or `undefined` for "no change" (no records, no
 * version, no ledger row). Anything else — `null`, an array, a scalar, a node
 * with another id — is refused by name.
 *
 * A mission row that has no graph gets an empty one in the same commit, as
 * `updateMission` does: a `task.upsert` for a mission with no graph is ignored
 * by the fold with a warning, which would make the write silently not happen.
 *
 * @param {object} snapshot - Store snapshot (`active_missions`, `task_graphs`).
 * @param {{ missionId: string, taskId: string, mutate: (current: object|null) => (object|undefined) }} params
 * @returns {{ records: object[] } | { errors: string[] }} Store records, or why not.
 */
export function planTaskUpdate(snapshot, { missionId, taskId, mutate }) {
  if (!snapshot?.active_missions?.[missionId]) {
    return { errors: [`updateTask: no mission '${missionId}' in the store — a task write never creates the mission row`] };
  }
  const graph = snapshot.task_graphs?.[missionId] ?? null;
  const current = graph?.tasks?.find((t) => t?.id === taskId) ?? null;
  const next = mutate(current ? clone(current) : null);
  if (next === undefined) return { records: [] };
  if (next === null || typeof next !== 'object' || Array.isArray(next)) {
    const got = next === null ? 'null' : (Array.isArray(next) ? 'an array' : typeof next);
    return { errors: [`updateTask: mutate() for task '${taskId}' must return a task node object, or undefined for no change — got ${got}`] };
  }
  if (next.id !== taskId) {
    return { errors: [`updateTask: mutate() for task '${taskId}' returned a node with id ${JSON.stringify(next.id)}`] };
  }
  const records = [];
  if (!graph) {
    records.push({ kind: 'graph.upsert', mission_id: missionId, graph: { schema_version: 1, mission_id: missionId, tasks: [] } });
  }
  records.push({ kind: 'task.upsert', mission_id: missionId, task: next });
  return { records };
}

/**
 * `store.updateTask` — validate the arguments, then run {@link planTaskUpdate}
 * through the store's own commit.
 *
 * `commit` is INJECTED (state-manager.js passes its private one) so this module
 * never imports the store it serves.
 *
 * @param {Function} commit - `state-manager.js#commit`.
 * @param {object} ctx - The store context `commit` takes.
 * @param {{ missionId: string, taskId: string, mutate: Function, expectedVersion?: number, reason?: string }} params
 * @returns {object} The commit result, or `{ok: false, conflict: false, errors, warnings: []}` for a bad argument.
 * @throws {TypeError} When `mutate` is not a function (a programmer error, like `updateMission`'s).
 */
export function runTaskUpdate(commit, ctx, params) {
  const { missionId, taskId, mutate, expectedVersion, reason } = params ?? {};
  if (typeof mutate !== 'function') throw new TypeError('updateTask: mutate must be a function');
  const errors = updateTaskArgErrors({ missionId, taskId });
  if (errors.length > 0) return { ok: false, conflict: false, errors, warnings: [] };
  return commit(ctx, {
    missionId,
    reason: reason ?? `task.update:${taskId}`,
    expectedVersion,
    plan: (snapshot) => planTaskUpdate(snapshot, { missionId, taskId, mutate }),
  });
}
