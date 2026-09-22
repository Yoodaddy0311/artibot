/**
 * `/split` plan limbs -> Structured Task Graph nodes (OB-12 / OB-15).
 *
 * `schemas/task-graph.schema.json` names its feeders in its own description:
 * "Feeders are /split plan.json limbs (affectedPaths -> file_ownership) and
 * /team TaskCreate". Measured 2026-09-21 on the live store, the first half of
 * that sentence had no code behind it: every `task_graphs[*].tasks` was `[]`
 * and `file_ownership` appeared zero times. This module is the missing
 * mapping, and nothing else — it is PURE, it opens no store and reads no file.
 * The port binding lives in `scripts/split/task-feed.mjs`.
 *
 * ── Why a merge and not a build ──────────────────────────────────────────
 * `state-manager.js#updateMission` takes `opts.graph` as a WHOLE-GRAPH
 * replacement (`{kind:'graph.upsert', graph}`), so a feeder that simply
 * rebuilds from `plan.json` would reset every task a worker had already
 * claimed or finished back to `queued` on the next `/split dispatch`. Merging
 * is therefore this module's obligation, not the store's: an existing node is
 * carried through UNTOUCHED except for `file_ownership`, which is the one
 * field the plan owns.
 *
 * Tasks the graph holds that the plan does not name (a `/team TaskCreate`
 * node, say) are preserved in place. The two feeders write into one graph and
 * neither may evict the other's rows.
 *
 * ── Layer ────────────────────────────────────────────────────────────────
 * L4, like the rest of `lib/topology/`: `eslint.config.js` registers the
 * directory in the L4 Cognitive block, so the ceiling this file may import
 * from is L2 (its own edges reach no higher). `ownsFromPlan` is IMPORTED rather
 * than re-implemented: `scripts/split/land.mjs` already judges limb ownership
 * from that same projection, and a second reading of `affectedPaths` here
 * would let the two drift.
 *
 * @module lib/topology/split-task-feed
 */

import { ownsFromPlan, stringList } from './split-state-sources.js';

/**
 * Lease TTL for a limb task, in milliseconds.
 *
 * DELIBERATELY long (24h). The lease vocabulary judges expiry from
 * `expires_at` against the clock (`state-manager.js#claimTask`), and no
 * heartbeat emitter exists yet — design §3.5 records that absence and
 * `heartbeatWorker` derives the instant rather than receiving one. With a
 * short TTL every live `/split` window would read as expired to the resume
 * reader within the hour, and a future reclaimer would take a limb away from
 * a session that is still working it. A day outlives a `/split` wave, so the
 * value degrades toward "held" rather than toward "stolen". Shorten this only
 * together with a real emitter (SH-12).
 */
export const LIMB_LEASE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Status a freshly fed limb node carries.
 *
 * `queued` and not `claimed`: the 8-state vocabulary requires an owner for
 * `claimed` (`validate.js` OWNED_TASK_STATUSES), and seeding is a separate
 * act from claiming. The claim is `claimTask`'s job and it sets the status
 * itself.
 */
export const SEED_TASK_STATUS = 'queued';

/**
 * Build the node a limb seeds into the graph.
 *
 * @param {string} limb - Limb id; becomes the task id.
 * @param {string} missionId - Owning mission.
 * @param {ReadonlyArray<string>} fileOwnership - Plan `affectedPaths`, already filtered.
 * @param {string} nowIso - ISO instant stamped as `created_at`.
 * @returns {object} A task node valid against `task-graph.schema.json`.
 */
function seedTask(limb, missionId, fileOwnership, nowIso) {
  return {
    id: limb,
    mission_id: missionId,
    title: `/split limb ${limb}`,
    status: SEED_TASK_STATUS,
    // Explicitly null, not absent: `queued` permits no owner and the null says
    // "nobody holds this", which is what the resume reader needs to see.
    owner: null,
    file_ownership: [...fileOwnership],
    created_at: nowIso,
  };
}

/**
 * Whether two ownership lists differ, order included.
 *
 * Order is significant on purpose: the list is a projection of `plan.json`,
 * and reporting a reorder as a change keeps the stored value byte-faithful to
 * the plan a reader would compare it against.
 *
 * @param {unknown} current - Stored value.
 * @param {ReadonlyArray<string>} next - Plan-derived value.
 * @returns {boolean} True when the stored value must be rewritten.
 */
function ownershipDiffers(current, next) {
  if (!Array.isArray(current)) return next.length > 0 || current !== undefined;
  return current.length !== next.length || current.some((v, i) => v !== next[i]);
}

/**
 * Merge `plan.json` limbs into an existing Task Graph.
 *
 * Pure and total: any shape of `graph` or `plan` yields a result. The returned
 * graph is a NEW object; the input is never mutated.
 *
 * @param {object} params - Merge inputs.
 * @param {object|null} [params.graph] - Current graph (`store.getTaskGraph(missionId)`), or null.
 * @param {object|null} params.plan - Parsed `plan.json`.
 * @param {string} params.missionId - Mission the graph belongs to.
 * @param {Date} [params.now] - Clock; stamps `created_at` / `updated_at`.
 * @returns {{graph: object, added: string[], refreshed: string[], unchanged: boolean}}
 *   `added` are limbs newly seeded, `refreshed` are limbs whose `file_ownership`
 *   was rewritten. `unchanged: true` means the caller SHOULD NOT write — a
 *   no-op `graph.upsert` still costs a `state.updated` ledger row per dispatch.
 * @example
 * const { graph, unchanged } = mergeLimbTasks({ graph: null, plan, missionId: 'M-20260921-S1234abcd' });
 * if (!unchanged) store.updateMission(missionId, (cur) => cur, { graph });
 */
export function mergeLimbTasks({ graph, plan, missionId, now = new Date() }) {
  const nowIso = now.toISOString();
  const owns = ownsFromPlan(plan);
  const existing = Array.isArray(graph?.tasks) ? graph.tasks : [];

  /** @type {string[]} */ const added = [];
  /** @type {string[]} */ const refreshed = [];
  const seen = new Set();

  const tasks = existing.map((task) => {
    const id = typeof task?.id === 'string' ? task.id : null;
    if (id === null || !Object.hasOwn(owns, id) || seen.has(id)) return task;
    seen.add(id);
    const next = stringList(owns[id]);
    if (!ownershipDiffers(task.file_ownership, next)) return task;
    refreshed.push(id);
    // `file_ownership` ONLY. status, owner, heartbeat_at and everything else
    // stay exactly as the worker left them — a re-dispatch must not walk a
    // running or finished limb backwards.
    return { ...task, file_ownership: next, updated_at: nowIso };
  });

  for (const [limb, paths] of Object.entries(owns)) {
    if (seen.has(limb)) continue;
    seen.add(limb);
    tasks.push(seedTask(limb, missionId, stringList(paths), nowIso));
    added.push(limb);
  }

  const unchanged = added.length === 0 && refreshed.length === 0;
  return {
    graph: {
      schema_version: Number.isInteger(graph?.schema_version) && graph.schema_version >= 1
        ? graph.schema_version
        : 1,
      mission_id: missionId,
      updated_at: unchanged && typeof graph?.updated_at === 'string' ? graph.updated_at : nowIso,
      tasks,
    },
    added,
    refreshed,
    unchanged,
  };
}
