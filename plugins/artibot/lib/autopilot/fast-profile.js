/**
 * Safe, bounded planning policy for autopilot's opt-in --fast mode.
 *
 * The planner never creates worktrees or agents. It consumes task metadata
 * and returns an auditable schedule that the engine may execute. Missing or
 * ambiguous metadata always reduces concurrency instead of guessing.
 *
 * Public surface:
 *   - FAST_PROFILE_DEFAULTS
 *   - normalizeFastProfile(limits)
 *   - areAffectedPathsConflicting(left, right)
 *   - buildFastFanoutPlan(options)
 *
 * @module lib/autopilot/fast-profile
 */

const HARD_MAX_AGENTS = 16;
const HARD_MAX_WORKTREES = 12;
const HARD_MAX_AGENTS_PER_CPU = 4;
const RISK_ORDER = Object.freeze({ low: 0, medium: 1, high: 2, critical: 3 });

/** Immutable defaults. Config may reduce, but never raise, these safety caps. */
export const FAST_PROFILE_DEFAULTS = Object.freeze({
  hardMaxAgents: HARD_MAX_AGENTS,
  agentsPerCpu: 2,
  maxWorktrees: HARD_MAX_WORKTREES,
  maxRisk: 'medium',
});

function boundedInteger(value, fallback, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(maximum, Math.floor(parsed)));
}

function normalizeRisk(value, fallback = 'medium') {
  const risk = typeof value === 'string' ? value.toLowerCase() : fallback;
  return Object.hasOwn(RISK_ORDER, risk) ? risk : fallback;
}

/**
 * Normalize optional config without permitting callers to exceed hard caps.
 * @param {object} [limits]
 * @returns {{ hardMaxAgents: number, agentsPerCpu: number, maxWorktrees: number, maxRisk: string }}
 */
export function normalizeFastProfile(limits = {}) {
  const source = limits && typeof limits === 'object' ? limits : {};
  const maxRisk = normalizeRisk(source.maxRisk, FAST_PROFILE_DEFAULTS.maxRisk);
  return {
    hardMaxAgents: boundedInteger(source.hardMaxAgents, FAST_PROFILE_DEFAULTS.hardMaxAgents, HARD_MAX_AGENTS),
    agentsPerCpu: boundedInteger(source.agentsPerCpu, FAST_PROFILE_DEFAULTS.agentsPerCpu, HARD_MAX_AGENTS_PER_CPU),
    maxWorktrees: boundedInteger(source.maxWorktrees, FAST_PROFILE_DEFAULTS.maxWorktrees, HARD_MAX_WORKTREES),
    maxRisk: RISK_ORDER[maxRisk] > RISK_ORDER.medium ? 'medium' : maxRisk,
  };
}

function isUnsafeRepoPath(value) {
  return value.startsWith('/')
    || value.startsWith('~')
    || /^[a-z]:($|\/)/i.test(value)
    || value.includes(':')
    || value.includes('\0')
    || value.split('/').includes('..');
}

function inspectPath(value) {
  // Absent entries are absent: they shrink no ownership claim, and a task whose
  // affectedPaths are all absent still serializes via `missing-affected-paths`.
  if (value === null || value === undefined) return { path: null, unsafe: false };
  // Anything else unparseable is UNSAFE, not ignorable. Dropping it silently
  // was fail-open in the mixed case: with `['src/a.js', {glob:'src/shared.js'}]`
  // the object vanished, the task kept its (now understated) path set, and two
  // tasks that really do touch `src/shared.js` landed in the same wave. Marking
  // it unsafe routes the task to `assessTask`'s existing `unsafe-affected-path`
  // serialization, which is the conservative answer when ownership is unknown.
  if (typeof value !== 'string' || !value.trim()) return { path: null, unsafe: true };
  const slashed = value.trim().replaceAll('\\', '/');
  if (isUnsafeRepoPath(slashed)) return { path: null, unsafe: true };
  const path = slashed.split('/').filter((segment) => segment && segment !== '.')
    .join('/').toLowerCase();
  return { path: path || null, unsafe: false };
}

function normalizePath(value) {
  return inspectPath(value).path;
}

function pathBase(value) {
  const wildcardAt = value.search(/[?*[\]{}()!+@|]/);
  if (wildcardAt < 0) return value;
  // A glob inside a filename (for example `src/a?`) can match siblings that
  // do not share its literal prefix. Fall back to its directory, never the
  // partial filename, so uncertain globs serialize safely.
  const directoryAt = value.lastIndexOf('/', wildcardAt);
  return directoryAt < 0 ? '' : value.slice(0, directoryAt);
}

function pathsOverlap(left, right) {
  const leftBase = pathBase(left);
  const rightBase = pathBase(right);
  if (!leftBase || !rightBase) return true;
  return leftBase === rightBase
    || leftBase.startsWith(`${rightBase}/`)
    || rightBase.startsWith(`${leftBase}/`);
}

/**
 * Determine whether two affected-path lists could write the same tree area.
 * Globs are intentionally conservative: their non-glob roots are compared.
 * @param {unknown} left
 * @param {unknown} right
 * @returns {boolean}
 */
export function areAffectedPathsConflicting(left, right) {
  const leftPaths = Array.isArray(left) ? left.map(normalizePath).filter(Boolean) : [];
  const rightPaths = Array.isArray(right) ? right.map(normalizePath).filter(Boolean) : [];
  return leftPaths.some((leftPath) => rightPaths.some((rightPath) => pathsOverlap(leftPath, rightPath)));
}

function taskId(task, index) {
  return typeof task?.id === 'string' && task.id.trim() ? task.id.trim() : `task-${index + 1}`;
}

function taskDependencies(task) {
  const keys = task && typeof task === 'object'
    ? ['dependsOn', 'dependencies'].filter((key) => Object.hasOwn(task, key)) : [];
  const malformed = keys.some((key) => !Array.isArray(task[key])
    || task[key].some((value) => typeof value !== 'string' || !value.trim()));
  const dependencies = malformed ? [] : [...new Set(keys.flatMap((key) => task[key])
    .map((value) => value.trim()))];
  return { dependencies, malformed };
}

function inspectAffectedPaths(values) {
  const inspected = Array.isArray(values) ? values.map(inspectPath) : [];
  return {
    paths: inspected.map((entry) => entry.path).filter(Boolean),
    unsafe: inspected.some((entry) => entry.unsafe),
  };
}

function assessTask(task, index, duplicateIds, profile) {
  const id = taskId(task, index);
  const { paths, unsafe } = inspectAffectedPaths(task?.affectedPaths);
  const dependencyMetadata = taskDependencies(task);
  const risk = typeof task?.risk === 'string' ? task.risk.toLowerCase() : null;
  let reason = null;
  if (!task?.id || typeof task.id !== 'string' || !task.id.trim()) reason = 'missing-id';
  else if (duplicateIds.has(id)) reason = 'duplicate-id';
  else if (dependencyMetadata.malformed) reason = 'unresolved-dependency';
  else if (task.independent !== true) reason = 'not-independent';
  else if (unsafe) reason = 'unsafe-affected-path';
  else if (paths.length === 0) reason = 'missing-affected-paths';
  else if (!Object.hasOwn(RISK_ORDER, risk)) reason = 'risk-unknown';
  else if (RISK_ORDER[risk] > RISK_ORDER[profile.maxRisk]) reason = `risk-${risk}`;
  else if (task.worktreeEligible !== true) reason = 'worktree-ineligible';
  return { id, paths, dependencies: dependencyMetadata.dependencies, eligible: reason === null, reason };
}

function duplicateTaskIds(tasks) {
  const counts = new Map();
  for (const task of tasks) {
    if (typeof task?.id !== 'string' || !task.id.trim()) continue;
    const id = task.id.trim();
    counts.set(id, (counts.get(id) || 0) + 1);
  }
  return new Set([...counts].filter(([, count]) => count > 1).map(([id]) => id));
}

function markDependencyCycles(tasks) {
  const byId = new Map(tasks.filter((task) => task.reason === null).map((task) => [task.id, task]));
  const visited = new Set();
  const active = [];
  const cycleIds = new Set();
  const visit = (task) => {
    if (active.includes(task.id)) {
      active.slice(active.indexOf(task.id)).forEach((id) => cycleIds.add(id));
      return;
    }
    if (visited.has(task.id)) return;
    active.push(task.id);
    task.dependencies.map((id) => byId.get(id)).filter(Boolean).forEach(visit);
    active.pop();
    visited.add(task.id);
  };
  tasks.filter((task) => task.reason === null).forEach(visit);
  return tasks.map((task) => cycleIds.has(task.id)
    ? { ...task, eligible: false, reason: 'dependency-cycle' } : task);
}

function markInvalidDependencies(tasks, knownIds) {
  const reasonById = new Map(tasks.map((task) => [task.id, task.reason]));
  return tasks.map((task) => {
    if (task.reason !== null) return task;
    if (task.dependencies.some((id) => !knownIds.has(id))) {
      return { ...task, eligible: false, reason: 'unresolved-dependency' };
    }
    if (task.dependencies.some((id) => reasonById.get(id) !== null)) {
      return { ...task, eligible: false, reason: 'dependency-not-fast' };
    }
    return task;
  });
}

function settleBlockedDependencies(tasks, knownIds) {
  let current = tasks;
  while (true) {
    const next = markInvalidDependencies(current, knownIds);
    if (next.every((task, index) => task.reason === current[index].reason)) return next;
    current = next;
  }
}

function assessTasks(tasks, profile) {
  const list = Array.isArray(tasks) ? tasks : [];
  const duplicateIds = duplicateTaskIds(list);
  const knownIds = new Set(list.flatMap((task) => typeof task?.id === 'string' && task.id.trim()
    ? [task.id.trim()] : []));
  const assessed = list.map((task, index) => assessTask(task, index, duplicateIds, profile));
  const resolved = settleBlockedDependencies(assessed, knownIds);
  return settleBlockedDependencies(markDependencyCycles(resolved), knownIds);
}

/**
 * Server entry paths are an opt-in conflict seed for `/split`: every task that
 * touches one of them would start the same dev server, and two windows cannot
 * share a port. They are read from a top-level option, NOT from `limits`, on
 * purpose — `normalizeFastProfile` reads exactly four keys and drops the rest,
 * so a seed smuggled through `limits` would fall back silently to "no seed".
 *
 * Absent (`undefined`/`null`) or empty means no seed and leaves every plan
 * unchanged. Anything the planner cannot read — a non-array, or an entry
 * `inspectPath` flags unsafe — is fail-closed: the seed marks EVERY eligible
 * task, which collapses the plan to one stem. Unknown ownership must reduce
 * concurrency, never widen it (module header).
 */
function inspectServerEntryPaths(values) {
  if (values === null || values === undefined) return { paths: [], unsafe: false };
  if (!Array.isArray(values)) return { paths: [], unsafe: true };
  return inspectAffectedPaths(values);
}

function touchesServerEntry(paths, seed) {
  return seed.unsafe
    || paths.some((path) => seed.paths.some((entry) => pathsOverlap(path, entry)));
}

/**
 * One predicate for both the audit (`conflictGroups`) and the schedule
 * (`buildWaves`). Keeping them on the same rule is what prevents a plan that
 * reports two tasks as one group and then co-locates them in a wave anyway.
 */
function tasksConflict(left, right) {
  return areAffectedPathsConflicting(left.paths, right.paths)
    || (left.serverEntry === true && right.serverEntry === true);
}

function buildConflictGroups(tasks) {
  const parents = tasks.map((_, index) => index);
  const root = (index) => {
    let current = index;
    while (parents[current] !== current) current = parents[current];
    return current;
  };
  const join = (left, right) => { parents[root(left)] = root(right); };
  for (let left = 0; left < tasks.length; left += 1) {
    for (let right = left + 1; right < tasks.length; right += 1) {
      if (tasksConflict(tasks[left], tasks[right])) join(left, right);
    }
  }
  const groups = new Map();
  tasks.forEach((task, index) => {
    const key = root(index);
    groups.set(key, [...(groups.get(key) || []), task.id]);
  });
  return [...groups.values()].filter((ids) => ids.length > 1)
    .map((taskIds, index) => ({ id: `conflict-${index + 1}`, taskIds }));
}

function buildWaves(tasks, capacity) {
  const waves = [];
  const completed = new Set();
  let pending = [...tasks];
  while (pending.length > 0) {
    const ready = pending.filter((task) => task.dependencies.every((id) => completed.has(id)));
    const wave = ready.reduce((selected, task) => selected.length < capacity
      && selected.every((placed) => !tasksConflict(task, placed))
      ? [...selected, task] : selected, []);
    if (wave.length === 0) break;
    const waveIds = new Set(wave.map((task) => task.id));
    waves.push(wave);
    waveIds.forEach((id) => completed.add(id));
    pending = pending.filter((task) => !waveIds.has(task.id));
  }
  return waves;
}

function parallelCapacity(profile, cpuCount, taskCount) {
  const cpu = boundedInteger(cpuCount, 1, Number.MAX_SAFE_INTEGER);
  return Math.min(profile.hardMaxAgents, profile.agentsPerCpu * cpu, profile.maxWorktrees, taskCount);
}

function speedup(taskCount, waves, serialCount) {
  const sequentialSlots = waves.length + serialCount;
  if (taskCount === 0 || sequentialSlots === 0) return 1;
  return Math.round((taskCount / sequentialSlots) * 100) / 100;
}

function standardPlan(assessments, profile, fallbackReason, conflictIds = new Set(), conflictGroups = []) {
  const serial = assessments.map((task) => ({
    taskId: task.id,
    reason: task.reason || (conflictIds.has(task.id) ? 'conflict-serialized' : fallbackReason),
  }));
  return {
    profile: 'standard', enabled: false, fallbackReason, limits: profile,
    requestedTaskCount: assessments.length,
    eligibleTaskCount: assessments.filter((task) => task.eligible).length,
    eligibleParallelism: assessments.length > 0 ? 1 : 0,
    plannedParallelism: assessments.length > 0 ? 1 : 0,
    estimatedSpeedup: 1, worktrees: { required: false, count: 0 },
    waves: [], serial, conflictGroups,
  };
}

/**
 * Create a bounded parallel-work plan from explicit planner task metadata.
 * `estimatedSpeedup` is an equal-duration scheduling estimate, not a promise.
 * `serverEntryPaths` (optional, top-level) seeds the conflict grouping: tasks
 * that touch any of those paths are kept in one stem. See
 * `inspectServerEntryPaths` for why it is not a `limits` key.
 * @param {{ fast?: boolean, tasks?: object[], cpuCount?: number, limits?: object,
 *   serverEntryPaths?: string[] }} [options]
 * @returns {object}
 */
export function buildFastFanoutPlan(options = {}) {
  const source = options && typeof options === 'object' ? options : {};
  const profile = normalizeFastProfile(source.limits);
  const assessments = assessTasks(source.tasks, profile);
  if (source.fast !== true) return standardPlan(assessments, profile, 'fast-not-requested');
  if (assessments.length === 0) return standardPlan(assessments, profile, 'no-tasks');

  const seed = inspectServerEntryPaths(source.serverEntryPaths);
  const eligible = assessments.filter((task) => task.eligible)
    .map((task) => ({ ...task, serverEntry: touchesServerEntry(task.paths, seed) }));
  if (eligible.length < 2) return standardPlan(assessments, profile, 'fewer-than-two-eligible-tasks');

  const groups = buildConflictGroups(eligible);
  const waves = buildWaves(eligible, parallelCapacity(profile, source.cpuCount, eligible.length));
  const plannedParallelism = Math.max(...waves.map((wave) => wave.length));
  if (plannedParallelism < 2) {
    const conflictIds = new Set(groups.flatMap((group) => group.taskIds));
    return standardPlan(assessments, profile, 'no-safe-parallelism', conflictIds, groups);
  }

  const serial = assessments.filter((task) => !task.eligible)
    .map((task) => ({ taskId: task.id, reason: task.reason }));
  return {
    profile: 'fast', enabled: true, fallbackReason: null, limits: profile,
    requestedTaskCount: assessments.length, eligibleTaskCount: eligible.length,
    eligibleParallelism: parallelCapacity(profile, source.cpuCount, eligible.length),
    plannedParallelism, estimatedSpeedup: speedup(assessments.length, waves, serial.length),
    worktrees: { required: true, count: plannedParallelism },
    waves: waves.map((wave) => ({ taskIds: wave.map((task) => task.id), worktreeCount: wave.length })),
    serial, conflictGroups: groups,
  };
}
