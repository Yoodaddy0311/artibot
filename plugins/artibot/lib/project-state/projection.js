/**
 * `state.yaml` projection — the human-readable view of the StateStore.
 *
 * state.yaml is NOT truth. The store is the live truth and `ledger.jsonl` is
 * the history; this file re-renders the store into the shape of
 * `project-state.schema.json` after every committed write
 * (ARTIBOT-5.0-DESIGN.md §1-2, §3.6, §7.2 Addendum §1.1). Delete state.yaml and the next
 * render reproduces it byte for byte. Hand-edit it and the next render throws
 * the edit away — which is why the design says a corrupted projection "must
 * never be repaired by hand in preference to the store".
 *
 * Determinism is a contract, not an accident: `renderProjection` has no clock
 * and no randomness, key order is fixed here rather than inherited from
 * object literals built elsewhere, and mission / worker maps are emitted in
 * sorted key order. That is what lets `/doctor` byte-compare a fresh render
 * against the file on disk (design §3.6).
 *
 * ── workers[] is a projection of the Task Graph, never the reverse ──────────
 * design §7.2 Addendum §7-8 makes the Task Graph canonical and demotes `state.yaml.workers`
 * to a view of it. Each task becomes one worker row; nothing is aggregated,
 * because inventing an aggregation rule ("what status do three tasks with one
 * owner have?") would put a judgement in the projection layer that no design
 * text authorises.
 *
 * The row KEY is the task's `owner` when that owner holds exactly one task in
 * the mission, and the task `id` otherwise. The first branch reproduces the
 * v1.1 §06 example, where a worker name keys its single task; the second is
 * what keeps the mapping injective when one agent holds several tasks. The
 * rule is stated here because it is the only place the two vocabularies meet.
 *
 * ── D14: hand-written fields ───────────────────────────────────────────────
 * `owners.humans` is a field a person edits. Design:319 resolves it by
 * keeping human-authored values in a separate store collection
 * (`project_meta`) and compositing at projection time — so a rebuild cannot
 * erase them. `composeOwners` is that composite: store-derived agents plus
 * meta-held humans.
 *
 * @module lib/project-state/projection
 */

import { emitYaml } from './yaml.js';

/** Mission key order, matching the v1.1 §06 canonical example. */
const MISSION_KEY_ORDER = Object.freeze([
  'title', 'intent', 'plan', 'status', 'owners', 'topology',
  'workers', 'blocked_by', 'review', 'controller',
]);

/**
 * Deep-clone a JSON-shaped value.
 *
 * `structuredClone` rather than a JSON round trip: it preserves `undefined`
 * inside arrays and does not silently drop keys, so a projection bug surfaces
 * as a thrown error instead of a missing field.
 *
 * @template T
 * @param {T} value - Value to clone.
 * @returns {T} A deep copy.
 */
export function clone(value) {
  return structuredClone(value);
}

/**
 * Sort an object's entries by key, returning a new object.
 *
 * @param {Record<string, unknown>} obj - Source object.
 * @returns {Record<string, unknown>} New object with keys in sorted order.
 */
function sortedByKey(obj) {
  const out = {};
  for (const key of Object.keys(obj).sort()) out[key] = obj[key];
  return out;
}

/**
 * Choose projection keys for a mission's tasks.
 *
 * @param {object[]} tasks - Task nodes of one mission.
 * @returns {Map<object, string>} Task -> projection key.
 */
function assignWorkerKeys(tasks) {
  const ownerCounts = new Map();
  for (const task of tasks) {
    if (typeof task.owner === 'string' && task.owner !== '') {
      ownerCounts.set(task.owner, (ownerCounts.get(task.owner) ?? 0) + 1);
    }
  }
  const keys = new Map();
  for (const task of tasks) {
    const owner = typeof task.owner === 'string' && task.owner !== '' ? task.owner : null;
    keys.set(task, owner && ownerCounts.get(owner) === 1 ? owner : task.id);
  }
  return keys;
}

/**
 * Project one task node into a `state.yaml` worker row.
 *
 * Absent fields are omitted rather than emitted as null: the schema leaves
 * worker entries open, and an omitted key reads as "not projected", while an
 * explicit null reads as "measured and empty". `heartbeat_at: null` IS
 * emitted when the task carries it, because design §3.5 records that null as
 * the honest current value — there is no heartbeat emitter yet.
 *
 * @param {object} task - A Task Graph node.
 * @returns {object} A worker row.
 */
export function projectWorker(task) {
  const row = { status: task.status };
  if (Array.isArray(task.file_ownership) && task.file_ownership.length > 0) {
    row.owns = [...task.file_ownership];
  }
  if (Object.hasOwn(task, 'heartbeat_at')) row.heartbeat_at = task.heartbeat_at ?? null;
  if (Object.hasOwn(task, 'heartbeat_source')) row.heartbeat_source = task.heartbeat_source ?? null;
  if (Array.isArray(task.blockers) && task.blockers.length > 0) row.blocked_by = [...task.blockers];
  return row;
}

/**
 * Build the `workers` map for one mission.
 *
 * @param {object|undefined} graph - The mission's Task Graph.
 * @returns {object} Worker rows keyed per `assignWorkerKeys`, in sorted key order.
 */
export function projectWorkers(graph) {
  const tasks = Array.isArray(graph?.tasks) ? graph.tasks : [];
  if (tasks.length === 0) return {};
  const keys = assignWorkerKeys(tasks);
  const rows = {};
  for (const task of tasks) rows[keys.get(task)] = projectWorker(task);
  return sortedByKey(rows);
}

/**
 * Composite `owners` from store-derived agents and meta-held humans (D14).
 *
 * @param {object|undefined} storeOwners - Owners as held on the mission.
 * @param {object|undefined} metaOwners - Owners held in `project_meta`.
 * @returns {object|undefined} The composed owners, or undefined when both are empty.
 */
export function composeOwners(storeOwners, metaOwners) {
  const humans = metaOwners?.humans ?? storeOwners?.humans;
  const agents = storeOwners?.agents ?? metaOwners?.agents;
  const out = {};
  if (Array.isArray(humans) && humans.length > 0) out.humans = [...humans];
  if (Array.isArray(agents) && agents.length > 0) out.agents = [...agents];
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Project one mission.
 *
 * @param {object} mission - Mission as stored.
 * @param {object|undefined} graph - The mission's Task Graph.
 * @param {object|undefined} meta - `project_meta.missions[missionId]`.
 * @returns {object} A projected mission with keys in `MISSION_KEY_ORDER`.
 */
export function projectMission(mission, graph, meta) {
  const source = {
    ...clone(mission),
    owners: composeOwners(mission.owners, meta?.owners),
    workers: projectWorkers(graph),
    blocked_by: Array.isArray(mission.blocked_by) ? [...mission.blocked_by] : [],
  };
  const out = {};
  for (const key of MISSION_KEY_ORDER) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  // Any field the store carries that MISSION_KEY_ORDER does not name is still
  // projected, after the named ones and in sorted order. Dropping it would
  // make the projection lossy in a way no reader could detect.
  for (const key of Object.keys(source).sort()) {
    if (!MISSION_KEY_ORDER.includes(key) && source[key] !== undefined) out[key] = source[key];
  }
  return out;
}

/**
 * Build the `state.yaml` projection object from a store snapshot.
 *
 * @param {object} snapshot - A StateStore snapshot.
 * @returns {object} An object shaped by `project-state.schema.json`.
 * @example
 * buildProjection(snapshot).state_version === snapshot.state_version; // true
 */
export function buildProjection(snapshot) {
  const missions = snapshot.active_missions ?? {};
  const graphs = snapshot.task_graphs ?? {};
  const meta = snapshot.project_meta?.missions ?? {};

  const projected = {};
  for (const missionId of Object.keys(missions).sort()) {
    projected[missionId] = projectMission(missions[missionId], graphs[missionId], meta[missionId]);
  }

  const out = { project: snapshot.project, state_version: snapshot.state_version };
  // `updated_at` is copied from the snapshot, never generated here: a clock
  // in the renderer would make two renders of one store differ, and the
  // byte-comparison check in /doctor depends on them not differing.
  if (snapshot.updated_at !== null && snapshot.updated_at !== undefined) {
    out.updated_at = snapshot.updated_at;
  }
  out.active_missions = projected;
  return out;
}

/**
 * Render a store snapshot as `state.yaml` text.
 *
 * @param {object} snapshot - A StateStore snapshot.
 * @returns {string} YAML text, terminated by one newline.
 */
export function renderProjection(snapshot) {
  return emitYaml(buildProjection(snapshot));
}
