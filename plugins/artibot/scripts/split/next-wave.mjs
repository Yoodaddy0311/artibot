#!/usr/bin/env node
/**
 * `split next-wave` — READ-ONLY report of what a run still owes and which
 * saved-plan wave to assign next. There is no write option.
 *
 * Why (Codex SP-04, 2026-09-28): `/split plan` saves the whole fast-profile
 * plan (`plan.plan.waves[]` / `plan.plan.serial[]`) but only the first wave
 * becomes limbs, and the run FSM ends at wait → integrate over those limbs. A
 * 3-task / cap-2 plan `[[alpha,beta],[gamma]]` therefore finished "complete"
 * with `gamma` never assigned. This report makes the remainder explicit.
 *
 * Denominator (pinned by tests):
 *
 *   requested = | waves[].taskIds ∪ serial[].taskId ∪ limbs[].taskIds |
 *   completed = | task ids of limbs whose lane state is 'done' |
 *   requested === completed + remaining.length
 *   complete  === measured && remaining.length === 0
 *
 * `limbs[].taskIds` is part of `requested` because rolling appends
 * (`plan-append.mjs`) add limbs without touching the saved plan. LANDED is the
 * `lane-state.mjs` record only: `readLaneOpsState(run.json, limb) === 'done'`;
 * a trailer alone does not count (same rule as `plan-append.mjs`).
 *
 * `remaining[].status`: `in-flight` (some not-landed limb carries it),
 * `unassigned` (in a saved wave, no limb yet), `serial` (in `plan.serial`, no
 * limb — never auto-scheduled; assign it by hand). `remaining[].planWaveIndex`
 * and `nextWave.planWaveIndex` are 0-based indexes into `plan.plan.waves` —
 * NOT the campaign wave number a limb row may carry in its own `wave` key.
 *
 * Old runs: rows without `wave`/`rolling` read fine. A plan without
 * `plan.waves`/`plan.serial` (or whose `requestedTaskCount` disagrees with
 * them) is reported from what exists, with a note, and never as complete.
 *
 * Exit codes: 0 whenever plan.json is readable (it is a report) · 1 on an
 * argument error, when plan.json is missing or malformed, or when run.json is
 * malformed.
 *
 * @module scripts/split/next-wave
 */

import path from 'node:path';
import { planJsonPath, readPlanJson, readRunJson } from '../../lib/git/split-run-file.js';
import { readLaneOpsState } from '../../lib/supervisor/lane-monitor.js';
import { isMainEntry } from '../hooks/_main-entry.js';

export const HELP = `usage: node scripts/split/next-wave.mjs [--parent <root>]

  --parent <root>  parent repo root holding the split state dir (default: cwd)

Prints JSON { runId, requested, completed, remaining[], nextWave, complete, notes[] }.
READ-ONLY: writes nothing. Exit 1 only on an argument error, when plan.json is missing/malformed, or when run.json is malformed.`;

/**
 * @param {string[]} argv
 * @returns {{ parent: string|null, help: boolean }}
 */
export function parseArgs(argv) {
  const out = { parent: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--parent') {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new Error('--parent requires a value');
      out.parent = v;
      i += 1;
    } else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

const cleanIds = (list) => (Array.isArray(list) ? list : [])
  .filter((id) => typeof id === 'string' && id.trim()).map((id) => id.trim());

/**
 * Saved-plan task ids. `measured` is false when either list is missing.
 *
 * @param {object} plan
 * @returns {{ waves: string[][], serial: string[], measured: boolean, notes: string[] }}
 */
function readSavedPlan(plan) {
  const saved = plan?.plan && typeof plan.plan === 'object' ? plan.plan : null;
  const notes = [];
  const hasWaves = Array.isArray(saved?.waves);
  const hasSerial = Array.isArray(saved?.serial);
  if (!hasWaves || !hasSerial) {
    notes.push(`plan.json has no saved ${!hasWaves ? 'plan.waves' : 'plan.serial'} — later waves are unmeasured; counted from limbs only, never reported complete`);
  }
  const waves = hasWaves ? saved.waves.map((w) => cleanIds(w?.taskIds)) : [];
  const serial = hasSerial ? cleanIds(saved.serial.map((s) => (typeof s === 'string' ? s : s?.taskId))) : [];
  let measured = hasWaves && hasSerial;
  const planned = new Set([...waves.flat(), ...serial]).size;
  if (measured && Number.isInteger(saved.requestedTaskCount) && saved.requestedTaskCount !== planned) {
    notes.push(`plan.requestedTaskCount is ${saved.requestedTaskCount} but waves+serial hold ${planned} ids — the planner dropped tasks; unmeasured, never reported complete`);
    measured = false;
  }
  return { waves, serial, measured, notes };
}

/**
 * Limb rows with their task ids and landed flag.
 *
 * @param {object} plan
 * @param {object|null} run
 * @returns {{ rows: Array<{ limb: string, taskIds: string[], landed: boolean }>, notes: string[] }}
 */
function readLimbRows(plan, run) {
  const notes = [];
  const rows = (Array.isArray(plan?.limbs) ? plan.limbs : [])
    .filter((l) => l && typeof l.limb === 'string' && l.limb)
    .map((l) => {
      let taskIds = cleanIds(l.taskIds);
      if (taskIds.length === 0) {
        notes.push(`limb ${l.limb} has no taskIds — counted as task id ${l.limb}`);
        taskIds = [l.limb];
      }
      return { limb: l.limb, taskIds, landed: readLaneOpsState(run, l.limb) === 'done' };
    });
  return { rows, notes };
}

/**
 * Remaining tasks, walked from each source separately (not derived from the
 * requested set) so the denominator pin can catch a source dropped on one side.
 *
 * @param {{ waves: string[][], serial: string[] }} saved
 * @param {Array<{ limb: string, taskIds: string[], landed: boolean }>} rows
 * @param {Set<string>} done
 * @returns {Array<{ taskId: string, status: 'in-flight'|'unassigned'|'serial', planWaveIndex: number|null, limb: string|null }>} - `planWaveIndex` is the 0-based `plan.plan.waves` index (not the row's campaign `wave`)
 */
function collectRemaining(saved, rows, done) {
  const owner = new Map();
  for (const r of rows) for (const id of r.taskIds) if (!r.landed && !owner.has(id)) owner.set(id, r.limb);
  const waveOf = new Map();
  saved.waves.forEach((ids, index) => ids.forEach((id) => { if (!waveOf.has(id)) waveOf.set(id, index); }));
  const serialSet = new Set(saved.serial);
  const seen = new Set();
  const out = [];
  const visit = (id) => {
    if (done.has(id) || seen.has(id)) return;
    seen.add(id);
    const limb = owner.get(id) ?? null;
    const status = limb ? 'in-flight' : (serialSet.has(id) && !waveOf.has(id) ? 'serial' : 'unassigned');
    out.push({ taskId: id, status, planWaveIndex: waveOf.get(id) ?? null, limb });
  };
  saved.waves.forEach((ids) => ids.forEach(visit));
  saved.serial.forEach(visit);
  rows.forEach((r) => r.taskIds.forEach(visit));
  return out;
}

/**
 * Lowest saved-plan wave that still has unassigned tasks, or `null`.
 *
 * @param {ReturnType<typeof collectRemaining>} remaining
 * @returns {{ planWaveIndex: number, taskIds: string[] }|null} - `planWaveIndex` is 0-based into `plan.plan.waves`
 */
function pickNextWave(remaining) {
  const candidates = remaining.filter((r) => r.status === 'unassigned' && r.planWaveIndex !== null);
  if (candidates.length === 0) return null;
  const planWaveIndex = Math.min(...candidates.map((r) => r.planWaveIndex));
  return { planWaveIndex, taskIds: candidates.filter((r) => r.planWaveIndex === planWaveIndex).map((r) => r.taskId) };
}

/**
 * Warning when an earlier saved wave still has unfinished tasks. The saved
 * plan keeps wave membership but not `dependsOn`, so this report cannot tell
 * whether the next wave was pushed back for capacity (safe to start now) or
 * for a dependency on those unfinished tasks (must wait). `null` = no warning.
 *
 * @param {ReturnType<typeof collectRemaining>} remaining
 * @param {{ planWaveIndex: number }|null} nextWave
 * @returns {string|null}
 */
function earlierWaveNote(remaining, nextWave) {
  if (!nextWave) return null;
  const open = remaining.filter((r) => r.planWaveIndex !== null && r.planWaveIndex < nextWave.planWaveIndex);
  if (open.length === 0) return null;
  return `earlier plan wave(s) still have ${open.length} unfinished task(s) (${open.map((r) => r.taskId).join(', ')}); the saved plan has no dependency data, so whether wave ${nextWave.planWaveIndex} was deferred for capacity or for a dependency cannot be told — check before assigning it`;
}

/**
 * Pure core: the next-wave report for a parsed plan and run.
 *
 * @param {object} plan - parsed plan.json
 * @param {object|null} run - parsed run.json (`null` = absent → nothing landed)
 * @returns {{ runId: string|null, requested: number, completed: number, remaining: ReturnType<typeof collectRemaining>, nextWave: { planWaveIndex: number, taskIds: string[] }|null, complete: boolean, notes: string[] }}
 */
export function computeNextWave(plan, run) {
  const saved = readSavedPlan(plan);
  const limbs = readLimbRows(plan, run);
  const notes = [...saved.notes, ...limbs.notes];
  const requestedIds = new Set([...saved.waves.flat(), ...saved.serial, ...limbs.rows.flatMap((r) => r.taskIds)]);
  const done = new Set(limbs.rows.filter((r) => r.landed).flatMap((r) => r.taskIds));
  const remaining = collectRemaining(saved, limbs.rows, done);
  const requested = requestedIds.size;
  const completed = done.size;
  let measured = saved.measured;
  if (requested !== completed + remaining.length) {
    notes.push(`denominator mismatch: requested ${requested} != completed ${completed} + remaining ${remaining.length}`);
    measured = false;
  }
  if (remaining.some((r) => r.status === 'serial')) {
    notes.push('serial tasks are never auto-scheduled — assign each one by hand (plan-append.mjs)');
  }
  const nextWave = pickNextWave(remaining);
  const earlier = earlierWaveNote(remaining, nextWave);
  if (earlier) notes.push(earlier);
  return {
    runId: typeof plan?.runId === 'string' ? plan.runId : null,
    requested,
    completed,
    remaining,
    nextWave,
    complete: measured && remaining.length === 0,
    notes,
  };
}

/**
 * CLI entry. Returns exit code.
 *
 * @param {string[]} argv
 * @param {{ cwd?: string, stdout?: (s: string) => void, stderr?: (s: string) => void }} [opts]
 * @returns {number}
 */
export function main(argv, opts = {}) {
  const out = opts.stdout ?? ((s) => process.stdout.write(s));
  const err = opts.stderr ?? ((s) => process.stderr.write(s));
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    err(`next-wave: ${e.message}\n${HELP}\n`);
    return 1;
  }
  if (args.help) {
    out(`${HELP}\n`);
    return 0;
  }
  const parentRoot = path.resolve(args.parent ?? opts.cwd ?? process.cwd());
  const plan = readOrReason(() => readPlanJson(parentRoot), 'plan.json malformed');
  if (plan.reason || plan.value === null) {
    err(`next-wave: ${plan.reason ?? `plan.json missing: ${planJsonPath(parentRoot)}`}\n`);
    return 1;
  }
  const run = readOrReason(() => readRunJson(parentRoot), 'run.json malformed (landed state unknown)');
  if (run.reason) {
    err(`next-wave: ${run.reason}\n`);
    return 1;
  }
  out(`${JSON.stringify(computeNextWave(plan.value, run.value), null, 2)}\n`);
  return 0;
}

/**
 * @param {() => object|null} read
 * @param {string} label
 * @returns {{ value: object|null, reason: string|null }}
 */
function readOrReason(read, label) {
  try {
    return { value: read(), reason: null };
  } catch (e) {
    return { value: null, reason: `${label}: ${e.message}` };
  }
}

if (isMainEntry(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
