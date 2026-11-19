/**
 * `/orca` pure decision logic — dependency graph, start/land/close decisions and
 * the limb-row contract. No I/O: nothing here reads a file, runs git or asks
 * Orca. The caller measures the world (`readLimbCompletion`,
 * `git merge-base --is-ancestor`, Orca read verbs) and hands the facts in. The
 * shape check of a whole `run.json` (`validateOrcaRun`) lives with the file I/O
 * in `orca-run-file.js`.
 *
 * Contract: design section 11.3 (IC-1) of the /orca design — the names, the
 * signatures and the result shapes below are what lanes L4/L5 build against.
 * No function throws, whatever it is handed. Those that can fail return
 * `{ ok: true, ... }` or `{ ok: false, reason }` (`assessPlan` and
 * `validateLimbRow` answer `{ ok, reason|errors }`); `limbName` and
 * `landingState` answer a string, `readyLimbs` and `nextActions` a value that
 * is always usable. Inputs are never mutated; every `run` handed back is a new
 * object.
 *
 * Reasons beyond the contract's lists exist only for inputs the contract does
 * not describe (garbage types, a blank id) — see each function.
 *
 * ── Why these four decisions are code and not prose ───────────────────────
 *  1. "Landed" is `done trailer AND commits > 0 AND tip is an ancestor of the
 *     integration ref`. A freshly created limb has zero commits, so its tip IS
 *     the base and `git merge-base --is-ancestor <tip> <integration>` exits 0:
 *     the ancestry test alone calls an empty limb landed ({@link landingState}).
 *  2. A limb may start only when every dependency has LANDED (not merely
 *     finished): a dependent branches from the integration ref after its
 *     predecessor landed ({@link readyLimbs}).
 *  3. Unknown ownership is never guessed: a task whose `affectedPaths` are
 *     missing or unusable runs after every other limb, one at a time
 *     ({@link buildDependencyGraph}).
 *  4. `forkPoint` is write-once: re-measuring `HEAD` after the worker has
 *     committed would move the base to the tip and make `land`'s
 *     `forkPoint..branch` diff skip the limb's own work ({@link bindLimb}).
 *
 * @module lib/git/orca-plan
 */

import { areAffectedPathsConflicting, inspectAffectedPaths, normalizeTaskId } from '../autopilot/fast-profile.js';
import { sanitizeSegment } from './repo-identity.js';

/**
 * Shape version of `run.json`. Defined here (not in `orca-run-file.js`) so the
 * pure compiler can stamp it without importing the I/O module, which imports
 * this one; `orca-run-file.js` re-exports it as the contract names it.
 */
export const ORCA_RUN_SCHEMA_VERSION = 1;

/** Limb slug — same shape as `limb-completion.js`'s private SLUG and `commands/split.md`. */
export const LIMB_SLUG = /^[a-z0-9][a-z0-9-]{1,30}$/;

/** `dispatches[].kind` vocabulary: first start, same-Task retry, follow-up Task. */
export const DISPATCH_KINDS = Object.freeze(['initial', 'retry', 'rework']);

const RUN_TAG = /^[a-z0-9]{4,16}$/;
const LIMB_NAME_MAX = 31;
/**
 * Only this much of a task id is read. `sanitizeSegment` is quadratic in a run of
 * dots inside the string (measured 2026-11-19 on this PC: 16,000 dots 113 ms,
 * 16,000 ".-" pairs 619 ms; a LEADING run of 40,000 dots was 0.2 ms), and a slug
 * is cut to 31 characters anyway.
 */
const TASK_ID_SCAN_MAX = 128;
const DEFAULT_MIN_STEMS = 2;
const DEFAULT_INTEGRATION_REF = 'origin/master';
const ORCA_ENVIRONMENT = 'local';

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isFilled = (value) => typeof value === 'string' && value.trim() !== '';
const failure = (reason) => ({ ok: false, reason });
const unique = (list) => [...new Set(list)];
const replaceAt = (list, index, value) => list.map((entry, at) => (at === index ? value : entry));

// ── limb names ──────────────────────────────────────────────────────────────

/**
 * Slug for one task id. A string that already is a valid slug comes back
 * unchanged; anything else is sanitised (`sanitizeSegment`), lower-cased,
 * reduced to `[a-z0-9-]` and cut to 31 characters. Too short a result gets a
 * `limb-` prefix, an empty one (an id with no ASCII letter or digit) is `limb`.
 * Collisions between different ids are resolved with a numeric suffix by
 * {@link buildDependencyGraph}, which is the only place that sees all ids.
 *
 * @param {string} taskId
 * @returns {string} matches {@link LIMB_SLUG}
 */
export function limbName(taskId) {
  const raw = typeof taskId === 'string' ? taskId.trim().slice(0, TASK_ID_SCAN_MAX) : '';
  if (LIMB_SLUG.test(raw)) return raw;
  const slug = sanitizeSegment(raw)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, LIMB_NAME_MAX)
    .replace(/-+$/, '');
  if (slug.length >= 2) return slug;
  return slug ? `limb-${slug}` : 'limb';
}

function uniqueName(base, taken) {
  if (!taken.has(base)) return base;
  for (let attempt = 2; ; attempt += 1) {
    const suffix = `-${attempt}`;
    const candidate = `${base.slice(0, LIMB_NAME_MAX - suffix.length).replace(/-+$/, '')}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * One name per id, in order. Ids that already are slugs keep their own name
 * (they are unique, so they cannot collide); the rest are sanitised and, on a
 * collision, suffixed `-2`, `-3`, ... — a literal id such as `a-2` is never
 * displaced by an earlier suffix because slug ids are placed first.
 */
function assignLimbNames(ids) {
  const taken = new Set(ids.filter((id) => LIMB_SLUG.test(id)));
  return ids.map((id) => {
    if (LIMB_SLUG.test(id)) return id;
    const name = uniqueName(limbName(id), taken);
    taken.add(name);
    return name;
  });
}

// ── dependency graph ────────────────────────────────────────────────────────

/** Declared prerequisites of a task (`dependsOn` and `dependencies`, like the fast planner), or `null` when malformed. */
function declaredDependencies(task) {
  const lists = ['dependsOn', 'dependencies']
    .map((key) => task[key])
    .filter((value) => value !== undefined && value !== null);
  if (lists.some((list) => !Array.isArray(list) || !list.every(isFilled))) return null;
  return unique(lists.flat().map((value) => value.trim()));
}

/**
 * An entry is a concrete path when the planner's own inspection keeps it:
 * `inspectAffectedPaths` silently drops absent and root-only entries (`null`,
 * `.`), and `areAffectedPathsConflicting` drops them too, so one such entry in
 * a mixed list would claim the whole tree while the overlap check saw only the
 * rest. Checked per entry, like `plan-append.mjs#pathClaimError`.
 */
function isConcretePath(value) {
  const inspected = inspectAffectedPaths([value]);
  return !inspected.unsafe && inspected.paths.length === 1;
}

function ownership(task) {
  const listed = Array.isArray(task.affectedPaths) ? task.affectedPaths : [];
  return {
    stored: unique(listed.filter(isFilled).map((value) => value.trim())),
    complete: listed.length > 0 && listed.every(isConcretePath),
  };
}

function normalizeTasks(tasks) {
  if (!Array.isArray(tasks) || tasks.length === 0 || !tasks.every(isRecord)) return failure('invalid-tasks');
  const ids = tasks.map((task) => normalizeTaskId(task.id));
  if (ids.includes(null)) return failure('missing-id');
  const known = new Set(ids);
  if (known.size !== ids.length) return failure('duplicate-id');
  const items = [];
  for (const [index, task] of tasks.entries()) {
    const deps = declaredDependencies(task);
    if (deps === null || !deps.every((dep) => known.has(dep))) return failure('unresolved-dependency');
    items.push({ id: ids[index], deps, ...ownership(task) });
  }
  return { ok: true, items };
}

/**
 * Schedule position of every task: plan waves first, then the plan's serial
 * list, then anything the plan never named (input order). A `null` plan is
 * simply input order.
 */
function planOrder(ids, plan) {
  const known = new Set(ids);
  const sequence = new Set();
  const take = (id) => {
    const normalized = normalizeTaskId(id);
    if (normalized !== null && known.has(normalized)) sequence.add(normalized);
  };
  if (isRecord(plan)) {
    (Array.isArray(plan.waves) ? plan.waves : []).forEach((wave) => {
      (Array.isArray(wave?.taskIds) ? wave.taskIds : []).forEach(take);
    });
    (Array.isArray(plan.serial) ? plan.serial : []).forEach((entry) => take(entry?.taskId));
  }
  ids.forEach(take);
  return new Map([...sequence].map((id, index) => [id, index]));
}

/**
 * Kahn's algorithm over `dependencies: Map<id, Set<id>>`. Among the ready ids
 * the lowest `priority` goes first, so the result is the topological order
 * closest to the plan. `null` when a cycle (a self-dependency included) leaves
 * ids that never become ready.
 */
function topologicalOrder(dependencies, priority) {
  const remaining = new Map([...dependencies].map(([id, deps]) => [id, new Set(deps)]));
  const order = [];
  while (remaining.size > 0) {
    const ready = [...remaining].filter(([, deps]) => deps.size === 0).map(([id]) => id);
    if (ready.length === 0) return null;
    const next = ready.reduce((best, id) => ((priority.get(id) ?? 0) < (priority.get(best) ?? 0) ? id : best));
    order.push(next);
    remaining.delete(next);
    remaining.forEach((deps) => deps.delete(next));
  }
  return order;
}

function forEachPair(list, visit) {
  list.forEach((first, index) => {
    list.slice(index + 1).forEach((second) => visit(first, second));
  });
}

/**
 * Pairs the plan separated only because of the server-entry seed. The seed is a
 * planner option the plan result does not carry, but the plan's conflict groups
 * do: a group is a connected component of "paths overlap OR both touch the
 * server entry". When a group spans more than one component of path overlap
 * alone, the seed merged them, and every member pair is treated as conflicting.
 * A group that path overlap already explains adds nothing, so transitive-only
 * pairs (A-B, B-C) are not serialised against each other.
 */
function serverEntryPairs(complete, plan, directPairs) {
  const groups = isRecord(plan) && Array.isArray(plan.conflictGroups) ? plan.conflictGroups : [];
  const parent = new Map(complete.map((item) => [item.id, item.id]));
  const find = (id) => {
    let cursor = id;
    while (parent.get(cursor) !== cursor) cursor = parent.get(cursor);
    return cursor;
  };
  directPairs.forEach(([first, second]) => parent.set(find(first), find(second)));
  const pairs = [];
  for (const group of groups) {
    const members = unique((Array.isArray(group?.taskIds) ? group.taskIds : []).map(normalizeTaskId)).filter((id) => parent.has(id));
    if (new Set(members.map(find)).size > 1) forEachPair(members, (first, second) => pairs.push([first, second]));
  }
  return pairs;
}

/**
 * Position of every task in the topological order of the DECLARED dependencies
 * that stays closest to the plan, or `null` when the declared dependencies are
 * cyclic. For a plan that already respects them (anything `buildFastFanoutPlan`
 * made) this is exactly the plan order.
 */
function rankTasks(items, plan) {
  const declared = new Map(items.map((item) => [item.id, new Set(item.deps)]));
  const order = topologicalOrder(declared, planOrder(items.map((item) => item.id), plan));
  return order === null ? null : new Map(order.map((id, index) => [id, index]));
}

/**
 * `dependencies` map: declared prerequisites, plus every conflicting pair
 * pointed from the earlier to the later task (rank order), plus "unknown
 * ownership runs after everything": complete limbs precede incomplete ones, and
 * incomplete limbs are chained in rank order. Returns `null` when the declared
 * dependencies alone are cyclic.
 */
function buildEdges(items, plan) {
  const rank = rankTasks(items, plan);
  if (rank === null) return null;

  const complete = items.filter((item) => item.complete);
  const incomplete = items.filter((item) => !item.complete);
  const overlapping = [];
  forEachPair(complete, (first, second) => {
    if (areAffectedPathsConflicting(first.stored, second.stored)) overlapping.push([first.id, second.id]);
  });
  const unknownOwnership = [];
  forEachPair(incomplete, (first, second) => unknownOwnership.push([first.id, second.id]));
  const pairs = [...overlapping, ...unknownOwnership, ...serverEntryPairs(complete, plan, overlapping)];

  const edges = new Map(items.map((item) => [item.id, new Set(item.deps)]));
  pairs.forEach(([first, second]) => {
    const [early, late] = rank.get(first) <= rank.get(second) ? [first, second] : [second, first];
    edges.get(late).add(early);
  });
  incomplete.forEach((late) => complete.forEach((early) => edges.get(late.id).add(early.id)));
  return edges;
}

function limbRow(item, name, deps) {
  return {
    limb: name,
    taskIds: [item.id],
    affectedPaths: [...item.stored],
    deps,
    worktreeId: null,
    worktreePath: null,
    branch: null,
    forkPoint: null,
    dispatches: [],
  };
}

/**
 * Limb rows (one per task, input order) with their `deps`.
 *
 * - a limb per task, not per first wave: every planned task becomes a limb;
 * - edges = declared `dependsOn`/`dependencies` UNION every pair whose owned
 *   paths conflict (`areAffectedPathsConflicting`), the pair pointed from the
 *   earlier to the later task in plan order (waves, then serial, then the rest).
 *   The plan order is read as the topological order closest to the plan, so a
 *   fallback or hand-built plan that disagrees with a declared dependency does
 *   not turn that disagreement into a false cycle;
 * - a task whose `affectedPaths` are missing or unusable (empty, absolute, `..`,
 *   a mixed list with a root-only entry) is ordered after every task with known
 *   ownership, and the unknown-ownership tasks after one another;
 * - conflicts the planner found only through its server-entry seed are kept
 *   (see {@link serverEntryPairs}).
 *
 * `plan` is the `buildFastFanoutPlan` result; only `waves[].taskIds`,
 * `serial[].taskId` and `conflictGroups[].taskIds` are read, and `null` is fine.
 * Rejecting a plan (fallback, too few stems) is {@link assessPlan}'s job.
 *
 * @param {Array<{ id: string, dependsOn?: string[], affectedPaths?: string[] }>} tasks
 * @param {object|null} [plan]
 * @returns {{ ok: true, limbs: object[] } | { ok: false, reason: string }}
 *   reason: `cycle` | `unresolved-dependency` | `duplicate-id`, and for input the
 *   contract does not describe `invalid-tasks` (not a non-empty list of objects)
 *   and `missing-id`. A complete task that depends on an incomplete one is a
 *   `cycle` — "after everything" and "before that task" cannot both hold.
 */
export function buildDependencyGraph(tasks, plan) {
  const normalized = normalizeTasks(tasks);
  if (!normalized.ok) return normalized;
  const { items } = normalized;
  const edges = buildEdges(items, plan);
  if (edges === null || topologicalOrder(edges, new Map()) === null) return failure('cycle');
  const names = assignLimbNames(items.map((item) => item.id));
  const nameOf = new Map(items.map((item, index) => [item.id, names[index]]));
  const position = new Map(items.map((item, index) => [item.id, index]));
  const limbs = items.map((item, index) => {
    const deps = [...edges.get(item.id)].sort((first, second) => position.get(first) - position.get(second));
    return limbRow(item, names[index], deps.map((id) => nameOf.get(id)));
  });
  return { ok: true, limbs };
}

// ── plan assessment and run compilation ─────────────────────────────────────

function widestWave(plan) {
  const waves = Array.isArray(plan.waves) ? plan.waves : [];
  return waves.reduce((widest, wave) => Math.max(widest, Array.isArray(wave?.taskIds) ? wave.taskIds.length : 0), 0);
}

/**
 * Accept or refuse a `buildFastFanoutPlan` result, the way `/split plan` does:
 * a plan with a `fallbackReason` is refused, and so is one whose planned
 * parallelism is below `minStems` (the plan-validity floor; one window is
 * `/team`'s job). A plan lacking `plannedParallelism` is measured from its
 * waves; a missing or invalid `minStems` is the config default, 2.
 *
 * @param {object} plan
 * @param {{ minStems?: number }} [options]
 * @returns {{ ok: boolean, reason: string|null }} reason is `null` when ok,
 *   else `no-plan` | `fallback:<fallbackReason>` | `stems-below-min:<planned>/<min>`
 */
export function assessPlan(plan, options) {
  if (!isRecord(plan)) return { ok: false, reason: 'no-plan' };
  if (plan.fallbackReason !== null && plan.fallbackReason !== undefined) {
    return { ok: false, reason: `fallback:${String(plan.fallbackReason)}` };
  }
  const minStems = isRecord(options) ? options.minStems : undefined;
  const floor = Number.isInteger(minStems) && minStems >= 1 ? minStems : DEFAULT_MIN_STEMS;
  const planned = Number.isFinite(plan.plannedParallelism) ? plan.plannedParallelism : widestWave(plan);
  if (planned < floor) return { ok: false, reason: `stems-below-min:${planned}/${floor}` };
  return { ok: true, reason: null };
}

/** A date, a millisecond number or a non-blank string, as the string to store. A string is kept verbatim. */
function toTimestamp(value) {
  if (isFilled(value)) return value;
  const date = value instanceof Date || typeof value === 'number' ? new Date(value) : null;
  return date !== null && Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

const orNull = (value) => (isFilled(value) ? value : null);

function invalidRunMeta({ objective, tag, integrationRef, runId, createdAt }) {
  if (!isFilled(objective)) return 'missing-objective';
  if (typeof tag !== 'string' || !RUN_TAG.test(tag)) return 'bad-tag';
  if (!isFilled(integrationRef) || /\s/.test(integrationRef)) return 'bad-integration-ref';
  if (runId !== null && !isFilled(runId)) return 'bad-run-id';
  if (createdAt === null) return 'bad-now';
  return null;
}

/**
 * Compile the planning part of `run.json` (design section 11.4): one unbound
 * limb row per task, `runId` still `null` unless given. Pure — `now` is passed
 * in. The tag is the 6-hex plan-time tag; any `[a-z0-9]{4,16}` is accepted
 * because it only ever ends up in a branch name.
 *
 * Graph failures are passed through unchanged (`cycle`, `unresolved-dependency`,
 * `duplicate-id`, ...); the run-level checks fail with `missing-objective`,
 * `bad-tag`, `bad-integration-ref`, `bad-run-id` or `bad-now`.
 *
 * @param {object} input
 * @param {string|null} [input.runId=null]
 * @param {string} input.objective
 * @param {string} [input.integrationRef='origin/master']
 * @param {string} [input.appVersion]
 * @param {string} [input.repoId]
 * @param {object[]} input.tasks - fast-profile task shape
 * @param {object|null} [input.plan] - `buildFastFanoutPlan` result
 * @param {string} input.tag
 * @param {Date|number|string} input.now
 * @returns {{ ok: true, run: object } | { ok: false, reason: string }}
 */
export function compileRun(input) {
  const {
    runId = null, objective, integrationRef = DEFAULT_INTEGRATION_REF, appVersion, repoId, tasks, plan, tag, now,
  } = isRecord(input) ? input : {};
  const graph = buildDependencyGraph(tasks, plan);
  if (!graph.ok) return graph;
  const createdAt = toTimestamp(now);
  const invalid = invalidRunMeta({ objective, tag, integrationRef, runId, createdAt });
  if (invalid !== null) return failure(invalid);
  return {
    ok: true,
    run: {
      schema_version: ORCA_RUN_SCHEMA_VERSION,
      provider: 'orca',
      runId,
      tag,
      objective,
      integrationRef,
      createdAt,
      orca: { appVersion: orNull(appVersion), environment: ORCA_ENVIRONMENT, repoId: orNull(repoId) },
      limbs: graph.limbs,
    },
  };
}

// ── binding and dispatch records ────────────────────────────────────────────

function limbRows(run) {
  return isRecord(run) && Array.isArray(run.limbs) ? run.limbs.filter((row) => isRecord(row) && isFilled(row.limb)) : [];
}

function limbIndex(run, limb) {
  return isRecord(run) && Array.isArray(run.limbs) ? run.limbs.findIndex((row) => isRecord(row) && row.limb === limb) : -1;
}

function readBinding(binding) {
  if (!isRecord(binding)) return null;
  const { worktreeId, worktreePath, branch, forkPoint } = binding;
  if (![worktreeId, worktreePath, branch].every(isFilled)) return null;
  if (forkPoint !== undefined && forkPoint !== null && !isFilled(forkPoint)) return null;
  return { worktreeId, worktreePath, branch, forkPoint: forkPoint ?? null };
}

/**
 * Record what Orca created for a limb: the worktree id (the limb's stable key),
 * its path, the branch and the fork point.
 *
 * `forkPoint` is write-once: when the row already carries one, it is kept and
 * the passed value is ignored (see the module header, point 4). Binding the
 * same worktree again is therefore idempotent.
 *
 * @param {object} run
 * @param {string} limb
 * @param {{ worktreeId: string, worktreePath: string, branch: string, forkPoint?: string|null }} binding
 * @returns {{ ok: true, run: object } | { ok: false, reason: string }}
 *   reason: `unknown-limb`; `bad-binding` (a field is not a non-blank string);
 *   `already-bound` (the limb is bound to a DIFFERENT worktree — rebinding would
 *   orphan the first one)
 */
export function bindLimb(run, limb, binding) {
  const index = limbIndex(run, limb);
  if (index < 0) return failure('unknown-limb');
  const values = readBinding(binding);
  if (values === null) return failure('bad-binding');
  const row = run.limbs[index];
  if (isFilled(row.worktreeId) && row.worktreeId !== values.worktreeId) return failure('already-bound');
  const forkPoint = isFilled(row.forkPoint) ? row.forkPoint : values.forkPoint;
  const bound = { ...row, worktreeId: values.worktreeId, worktreePath: values.worktreePath, branch: values.branch, forkPoint };
  return { ok: true, run: { ...run, limbs: replaceAt(run.limbs, index, bound) } };
}

function readDispatch(dispatch) {
  if (!isRecord(dispatch)) return failure('bad-dispatch');
  if (!DISPATCH_KINDS.includes(dispatch.kind)) return failure('bad-kind');
  const at = toTimestamp(dispatch.at);
  if (!isFilled(dispatch.dispatchId) || !isFilled(dispatch.taskId) || at === null) return failure('bad-dispatch');
  return { ok: true, entry: { dispatchId: dispatch.dispatchId, taskId: dispatch.taskId, kind: dispatch.kind, at } };
}

function knowsDispatch(run, dispatchId) {
  return limbRows(run).some((row) => Array.isArray(row.dispatches) && row.dispatches.some((entry) => entry?.dispatchId === dispatchId));
}

/**
 * Append one dispatch receipt (`{ dispatchId, taskId, kind, at }`) to a limb's
 * add-only `dispatches`. `taskId` is the ORCA Task id (the plan's task id is in
 * `taskIds`). A dispatch id belongs to exactly one limb: the same id twice,
 * anywhere in the run, is a `duplicate`.
 *
 * @param {object} run
 * @param {string} limb
 * @param {{ dispatchId: string, taskId: string, kind: 'initial'|'retry'|'rework', at: string|Date|number }} dispatch
 * @returns {{ ok: true, run: object } | { ok: false, reason: string }}
 *   reason: `unknown-limb` | `duplicate` | `bad-kind`, and `bad-dispatch` for a
 *   blank id or timestamp (not a contract case)
 */
export function appendDispatch(run, limb, dispatch) {
  const index = limbIndex(run, limb);
  if (index < 0) return failure('unknown-limb');
  const read = readDispatch(dispatch);
  if (!read.ok) return read;
  if (knowsDispatch(run, read.entry.dispatchId)) return failure('duplicate');
  const row = run.limbs[index];
  const dispatches = [...(Array.isArray(row.dispatches) ? row.dispatches : []), read.entry];
  return { ok: true, run: { ...run, limbs: replaceAt(run.limbs, index, { ...row, dispatches }) } };
}

// ── landing, readiness, next actions ────────────────────────────────────────

/**
 * Where a limb stands, from facts the caller measured.
 *
 *  - `no-commits`    no commit of its own yet — this wins over everything: the
 *                    tip is the base, so "is an ancestor of the integration ref"
 *                    is trivially true and must not read as landed;
 *  - `in-progress`   commits, but no `Split-Limb: done` (or a later `wip`);
 *  - `done-unlanded` done and not yet in the integration ref (the landing queue);
 *  - `landed`        done AND commits > 0 AND the tip is an ancestor of the
 *                    integration ref (measured after a fetch).
 *
 * Anything that is not exactly `complete === true`, a positive finite
 * `commitCount` or `tipIsAncestorOfIntegration === true` counts as "no".
 *
 * @param {{ completion?: { complete?: boolean }, commitCount?: number, tipIsAncestorOfIntegration?: boolean }} facts
 *   `completion` is a `readLimbCompletion` result
 * @returns {'landed'|'done-unlanded'|'in-progress'|'no-commits'}
 */
export function landingState(facts) {
  const { completion, commitCount, tipIsAncestorOfIntegration } = isRecord(facts) ? facts : {};
  if (!Number.isFinite(commitCount) || commitCount <= 0) return 'no-commits';
  if (completion?.complete !== true) return 'in-progress';
  return tipIsAncestorOfIntegration === true ? 'landed' : 'done-unlanded';
}

const namesOf = (value) => (Array.isArray(value) ? value.filter(isFilled) : []);

function normalizeObserved(observed) {
  const source = isRecord(observed) ? observed : {};
  return {
    landed: new Set(namesOf(source.landed)),
    inFlight: new Set(namesOf(source.inFlight)),
    capacity: Number.isFinite(source.capacity) ? Math.max(0, Math.floor(source.capacity)) : 0,
    doneUnlanded: unique(namesOf(source.doneUnlanded)),
    withWorktree: Array.isArray(source.withWorktree) ? new Set(namesOf(source.withWorktree)) : null,
  };
}

const depsOf = (row) => namesOf(row.deps);
const hasDispatch = (row) => Array.isArray(row.dispatches) && row.dispatches.length > 0;

/**
 * Which limbs may start now. A limb is a candidate when it has no dispatch yet,
 * has not landed, and every dependency has landed; candidates start in run order
 * while `inFlight + started <= capacity`. Everything else without a dispatch is
 * `waiting`, mapped to the dependencies that have not landed — an EMPTY list
 * means it is only waiting for a free slot.
 *
 * @param {object} run
 * @param {{ landed?: string[], inFlight?: string[], capacity?: number }} observed
 *   a missing or invalid `capacity` is 0 (nothing starts)
 * @returns {{ start: string[], waiting: Record<string, string[]> }}
 */
export function readyLimbs(run, observed) {
  const seen = normalizeObserved(observed);
  const slots = Math.max(0, seen.capacity - seen.inFlight.size);
  const start = [];
  const waiting = {};
  for (const row of limbRows(run)) {
    if (hasDispatch(row) || seen.landed.has(row.limb)) continue;
    const unlanded = depsOf(row).filter((dep) => !seen.landed.has(dep));
    if (unlanded.length === 0 && start.length < slots) start.push(row.limb);
    else waiting[row.limb] = unlanded;
  }
  return { start, waiting };
}

/** Limbs that would be startable once `queue` has landed (and are not startable now). */
function unblockedBy(rows, seen, queue) {
  const arriving = new Set([...seen.landed, ...queue]);
  return rows.filter((row) => {
    const deps = depsOf(row);
    return !hasDispatch(row) && !seen.landed.has(row.limb)
      && deps.some((dep) => queue.includes(dep)) && deps.every((dep) => arriving.has(dep));
  }).map((row) => row.limb);
}

/** `integrate` rule of the design: a landing queue AND (nothing in flight OR landing frees a waiting limb). */
function landReason(rows, seen, queue) {
  if (queue.length === 0) return null;
  if (seen.inFlight.size === 0) return `착지 대기 ${queue.length}개 — 진행 중 줄기 없음`;
  const freed = unblockedBy(rows, seen, queue);
  return freed.length > 0 ? `착지 대기 ${queue.length}개 — 착지하면 ${freed.join(', ')} 시작 가능` : null;
}

function closeActions(rows, seen) {
  if (seen.withWorktree === null) return [];
  return rows
    .filter((row) => seen.landed.has(row.limb) && seen.withWorktree.has(row.limb))
    .map((row) => ({ kind: 'close', limb: row.limb, reason: '착지 완료 — worktree 정리 대기' }));
}

/** Limbs that were dispatched but are neither running, nor in the landing queue, nor landed: the leader must decide. */
function stalledLimbs(rows, seen, queue) {
  return rows
    .filter((row) => hasDispatch(row) && !seen.landed.has(row.limb) && !seen.inFlight.has(row.limb) && !queue.includes(row.limb))
    .map((row) => row.limb);
}

function idleReason(rows, seen, queue, waiting) {
  if (rows.length === 0) return '줄기 없음';
  if (rows.every((row) => seen.landed.has(row.limb))) {
    return seen.withWorktree === null ? '전 줄기 착지 — 정리 여부는 미확인(withWorktree 미제공)' : '런 완료 — 전 줄기 착지·정리 끝';
  }
  const stalled = stalledLimbs(rows, seen, queue);
  const blocked = Object.values(waiting).filter((deps) => deps.length > 0).length;
  const slotLimited = Object.keys(waiting).length - blocked;
  return [
    ...(seen.inFlight.size > 0 ? [`진행 중 ${seen.inFlight.size}개 — 워커 보고(기상) 대기`] : []),
    ...(stalled.length > 0 ? [`멈춘 줄기 ${stalled.length}개(${stalled.join(', ')}) — dispatch 는 있으나 진행 중도 착지 대기도 아니다: 재시도·반송·오너 판단`] : []),
    ...(blocked > 0 ? [`선행 미착지로 대기 ${blocked}개`] : []),
    ...(slotLimited > 0 ? [`동시 상한(${seen.capacity})으로 대기 ${slotLimited}개`] : []),
  ].join(' · ');
}

/**
 * What the leader should do next, in order: `land` (the landing queue as one
 * batch), `start` (limbs from {@link readyLimbs}), `close` (one per landed limb
 * whose worktree is still there). Nothing to do is one `idle` entry saying why:
 * what is running, which limbs are stalled (dispatched, but neither running nor
 * queued nor landed — a failed or lost worker, or a `worker_done` without the
 * done trailer), and how many wait on a dependency that has not landed.
 *
 * `observed` is {@link readyLimbs}'s `{ landed, inFlight, capacity }` plus two
 * optional lists the contract's three do not cover:
 *  - `doneUnlanded`  limbs whose {@link landingState} is `done-unlanded` (the
 *                    landing queue); without it there is no `land` action;
 *  - `withWorktree`  limbs whose worktree still exists; without it there is no
 *                    `close` action (not guessed — "unknown" is not "all open").
 *
 * `land` is proposed only when the queue is non-empty AND either nothing is in
 * flight or landing it frees a waiting limb (design section 4.4, integrate);
 * an owner instruction to integrate sooner is the leader's call.
 *
 * @param {object} run
 * @param {{ landed?: string[], inFlight?: string[], capacity?: number, doneUnlanded?: string[], withWorktree?: string[] }} observed
 * @returns {Array<{ kind: 'start'|'land'|'close'|'idle', limbs?: string[], limb?: string, reason: string }>}
 */
export function nextActions(run, observed) {
  const seen = normalizeObserved(observed);
  const rows = limbRows(run);
  const known = new Set(rows.map((row) => row.limb));
  const queue = seen.doneUnlanded.filter((name) => known.has(name) && !seen.landed.has(name));
  const ready = readyLimbs(run, observed);
  const actions = [];
  const landing = landReason(rows, seen, queue);
  if (landing !== null) actions.push({ kind: 'land', limbs: queue, reason: landing });
  if (ready.start.length > 0) {
    actions.push({
      kind: 'start',
      limbs: ready.start,
      reason: `시작 가능 ${ready.start.length}개 — 선행 줄기 착지 완료, 진행 중 ${seen.inFlight.size}/${seen.capacity}`,
    });
  }
  actions.push(...closeActions(rows, seen));
  if (actions.length > 0) return actions;
  return [{ kind: 'idle', reason: idleReason(rows, seen, queue, ready.waiting) }];
}

// ── shape checks ────────────────────────────────────────────────────────────

const present = (row, key) => row[key] !== undefined;

function checkBinding(row, allowUnbound) {
  return ['branch', 'worktreePath'].flatMap((key) => {
    if (!present(row, key)) return [`${key}: required`];
    if (row[key] === null && allowUnbound) return [];
    if (isFilled(row[key])) return [];
    return [allowUnbound ? `${key}: must be a non-empty string or null` : `${key}: must be a non-empty string (a limb not bound to a worktree yet has none)`];
  });
}

function checkLists(row) {
  const errors = [];
  if (!present(row, 'affectedPaths')) errors.push('affectedPaths: required');
  else if (!Array.isArray(row.affectedPaths) || !row.affectedPaths.every(isFilled)) errors.push('affectedPaths: must be an array of non-empty strings');
  if (present(row, 'taskIds') && (!Array.isArray(row.taskIds) || !row.taskIds.every(isFilled))) errors.push('taskIds: must be an array of non-empty strings');
  if (present(row, 'deps') && (!Array.isArray(row.deps) || !row.deps.every((dep) => typeof dep === 'string' && LIMB_SLUG.test(dep)))) {
    errors.push('deps: must be an array of limb names');
  }
  return errors;
}

function checkOptionalStrings(row) {
  return ['forkPoint', 'worktreeId']
    .filter((key) => present(row, key) && row[key] !== null && !isFilled(row[key]))
    .map((key) => `${key}: must be a non-empty string or null`);
}

function checkDispatches(row) {
  if (!present(row, 'dispatches')) return [];
  if (!Array.isArray(row.dispatches)) return ['dispatches: must be an array'];
  return row.dispatches.flatMap((entry, index) => {
    const ok = isRecord(entry) && isFilled(entry.dispatchId) && isFilled(entry.taskId) && isFilled(entry.at) && DISPATCH_KINDS.includes(entry.kind);
    return ok ? [] : [`dispatches[${index}]: needs dispatchId, taskId, at (non-empty strings) and kind (${DISPATCH_KINDS.join('|')})`];
  });
}

/**
 * The limb-row contract: the fields `land` and the completion reader consume,
 * identical for a `/split` `plan.json` row and an `/orca` `run.json` row (the
 * JSON Schema twin is `schemas/limb-row.schema.json`; a firewall test keeps the
 * two in agreement).
 *
 * Required keys: `limb` (a slug), `branch`, `worktreePath` (non-empty strings)
 * and `affectedPaths` (an array of non-empty strings — empty is a valid claim
 * of nothing, which `land` then refuses). Optional: `forkPoint` and `worktreeId`
 * (non-empty string or `null`), `taskIds`, `deps` (limb names), `dispatches`
 * (`{ dispatchId, taskId, kind, at }`). Other keys (`/split`'s `wave`,
 * `rolling`, `worktreeName`, ...) are allowed and not checked.
 *
 * `allowUnbound` is the planning-state variant: `branch` and `worktreePath` may
 * be `null` (a row `compileRun` produced and `bindLimb` has not filled yet). It
 * is for the run-file reader; a row that must be landed is checked WITHOUT it.
 *
 * @param {unknown} row
 * @param {{ allowUnbound?: boolean }} [options]
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateLimbRow(row, options) {
  if (!isRecord(row)) return { ok: false, errors: ['row must be an object'] };
  const allowUnbound = isRecord(options) && options.allowUnbound === true;
  const errors = [
    ...(typeof row.limb === 'string' && LIMB_SLUG.test(row.limb) ? [] : [`limb: must match ${LIMB_SLUG.source}`]),
    ...checkBinding(row, allowUnbound),
    ...checkLists(row),
    ...checkOptionalStrings(row),
    ...checkDispatches(row),
  ];
  return { ok: errors.length === 0, errors };
}

