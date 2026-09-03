/**
 * The store's append-only journal, and the fold that turns it back into state.
 *
 * The StateStore is JSONL records plus a derived snapshot (decision F1/OD-4).
 * This module owns the JSONL half: the record vocabulary, the fold, and the
 * torn-line-tolerant reader. `state-manager.js` owns the transaction around
 * it and `reconcile.js` owns the drift comparison, and BOTH fold through the
 * one `reduceProjectState` here — so "rebuild from the journal" and "apply a
 * write" cannot drift apart through two implementations of one rule.
 *
 * ── Why a record carries a whole entity, not a patch ───────────────────────
 * `mission.upsert` and `task.upsert` carry the full object as it stands AFTER
 * the mutation, not a diff. Replaying a diff stream requires every future
 * reader to agree with today's writer about merge semantics; replaying whole
 * entities requires only last-write-wins, which has no version-skew failure
 * mode. The cost is line size, bounded by one mission or one task.
 *
 * ── Purity ────────────────────────────────────────────────────────────────
 * `reduceProjectState` has no clock, no filesystem and no randomness: the
 * same array yields a deep-equal snapshot every time. That is what makes the
 * byte comparison in `/doctor` meaningful (design §3.6), and it is the same
 * property `lib/supervisor/state-reducer.js#reduce` holds for run state.
 *
 * @module lib/project-state/journal
 */

import { existsSync, readFileSync } from 'node:fs';
import { clone } from './projection.js';

/** Store record kinds. A closed set: an unknown kind is a warning, never a guess. */
export const STORE_RECORD_KINDS = Object.freeze([
  'mission.upsert', 'mission.remove', 'graph.upsert',
  'task.upsert', 'task.remove', 'lease.set', 'lease.clear', 'meta.upsert',
]);

/** Snapshot schema version. Bumping it is a migration, not a patch. */
export const SNAPSHOT_SCHEMA_VERSION = 1;

/**
 * An empty store snapshot at version 0.
 *
 * Version 0 is deliberately BELOW the `state_version >= 1` floor of
 * `project-state.schema.json`: an empty store has never been written, so it
 * has no projection to render. The first committed write produces version 1.
 *
 * @param {string} project - Project name.
 * @returns {object} A fresh snapshot.
 */
export function emptySnapshot(project) {
  return {
    schema_version: SNAPSHOT_SCHEMA_VERSION,
    project,
    state_version: 0,
    updated_at: null,
    active_missions: {},
    task_graphs: {},
    // Task leases live OUTSIDE the Task Graph because
    // `task-graph.schema.json` sets `additionalProperties: false` and defines
    // no lease field. The design lists "미션·태스크 그래프·lease·controller 락"
    // as four things the store holds, not as one nested thing (design §1-2).
    task_leases: {},
    // D14: fields a person edits by hand, kept apart from the reconstructible
    // cache so a rebuild cannot erase them (design §5 D14).
    project_meta: { missions: {} },
  };
}

/**
 * Apply one record to a snapshot, in place.
 *
 * @param {object} snapshot - Snapshot to mutate.
 * @param {object} record - A store record.
 * @param {string[]} warnings - Accumulator for non-fatal problems.
 * @returns {void}
 */
export function applyRecord(snapshot, record, warnings) {
  const mid = record.mission_id;
  switch (record.kind) {
    case 'mission.upsert':
      snapshot.active_missions[mid] = clone(record.mission);
      break;
    case 'mission.remove':
      delete snapshot.active_missions[mid];
      delete snapshot.task_graphs[mid];
      delete snapshot.task_leases[mid];
      break;
    case 'graph.upsert':
      snapshot.task_graphs[mid] = clone(record.graph);
      break;
    case 'task.upsert':
      upsertTask(snapshot, mid, record.task, warnings);
      break;
    case 'task.remove': {
      const graph = snapshot.task_graphs[mid];
      if (graph) graph.tasks = graph.tasks.filter((t) => t.id !== record.task_id);
      delete snapshot.task_leases[mid]?.[record.task_id];
      break;
    }
    case 'lease.set':
      snapshot.task_leases[mid] ??= {};
      snapshot.task_leases[mid][record.task_id] = clone(record.lease);
      break;
    case 'lease.clear':
      delete snapshot.task_leases[mid]?.[record.task_id];
      break;
    case 'meta.upsert':
      snapshot.project_meta.missions[mid] = clone(record.meta);
      break;
    default:
      warnings.push(`unknown store record kind '${String(record.kind)}' at state_version ${record.state_version}`);
  }
}

/**
 * Insert or replace a task inside a mission's graph.
 *
 * @param {object} snapshot - Snapshot to mutate.
 * @param {string} missionId - Owning mission.
 * @param {object} task - Full task node after the mutation.
 * @param {string[]} warnings - Accumulator.
 * @returns {void}
 */
function upsertTask(snapshot, missionId, task, warnings) {
  const graph = snapshot.task_graphs[missionId];
  if (!graph) {
    warnings.push(`task.upsert for '${task?.id}' has no graph for mission ${missionId} — record ignored`);
    return;
  }
  const next = clone(task);
  const at = graph.tasks.findIndex((t) => t.id === next.id);
  if (at >= 0) graph.tasks[at] = next;
  else graph.tasks.push(next);
}

/**
 * Fold an ordered record stream into a snapshot.
 *
 * Homomorphic with `lib/supervisor/state-reducer.js#reduce` by design
 * (ARTIBOT-5.0-DESIGN.md §3.6): pure, no clock, no filesystem, and the SAME
 * function the store uses to apply its own writes — so "rebuild from the
 * journal" and "the snapshot on disk" cannot drift apart through two
 * implementations of one rule.
 *
 * Records are applied in ARRAY ORDER. This function does not sort.
 *
 * @param {object[]} records - Store records in order.
 * @param {object} [opts] - Fold options.
 * @param {string} [opts.project='artibot'] - Project name for the base snapshot.
 * @returns {{state: object, warnings: string[]}} The folded snapshot and any warnings.
 */
export function reduceProjectState(records, opts = {}) {
  const state = emptySnapshot(opts.project ?? 'artibot');
  const warnings = [];
  if (!Array.isArray(records)) return { state, warnings: ['records must be an array'] };

  for (const record of records) {
    if (record === null || typeof record !== 'object') {
      warnings.push('skipped a non-object journal record');
      continue;
    }
    applyRecord(state, record, warnings);
    if (Number.isInteger(record.state_version)) {
      if (record.state_version < state.state_version) {
        warnings.push(
          `state_version regressed: record ${record.state_version} follows ${state.state_version}`,
        );
      }
      state.state_version = Math.max(state.state_version, record.state_version);
    }
    if (typeof record.ts === 'string') state.updated_at = record.ts;
    if (typeof record.project === 'string') state.project = record.project;
  }
  return { state, warnings };
}

/**
 * Read a JSONL journal, skipping torn lines.
 *
 * A torn tail is the expected shape of a crash during append. It is reported,
 * never repaired in place and never allowed to abort the read: refusing to
 * open a store because its last line is half-written would turn a recoverable
 * crash into an unrecoverable one.
 *
 * @param {string} file - Journal path.
 * @returns {{records: object[], torn: number}} Parsed records and the count of skipped lines.
 */
export function readJournal(file) {
  if (!existsSync(file)) return { records: [], torn: 0 };
  const records = [];
  let torn = 0;
  for (const line of readFileSync(file, 'utf-8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      torn += 1;
    }
  }
  return { records, torn };
}
