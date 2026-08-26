/**
 * Firewall — `/split plan` limits must actually reach the fan-out planner.
 *
 * ── The defect class: silent fallback ───────────────────────────────────────
 * `normalizeFastProfile` reads exactly four keys (`hardMaxAgents`,
 * `agentsPerCpu`, `maxWorktrees`, `maxRisk`) and drops everything else. So a
 * caller who writes `limits: { maxWindows: 4 }` gets no error, no warning, and
 * a plan capped at the defaults (16 agents / 12 worktrees). The PRD therefore
 * maps `config.split.maxWindows` onto the EXISTING keys — and this file is the
 * assertion that the mapped value is what binds the schedule, not a
 * coincidence of the fixture. Every cap test carries a negative control with
 * the same tasks and no limits: if the control and the capped run produce the
 * same parallelism, the cap was never read.
 *
 * The fixture is deliberately larger than the cap (10 tasks vs 3–4 windows). A
 * fixture the same size as the cap proves nothing — `min(cap, taskCount)`
 * returns taskCount and the test passes with the cap ignored.
 *
 * ── The seed: `serverEntryPaths` ────────────────────────────────────────────
 * Two windows cannot both start the dev server on one port. Tasks that touch a
 * server entry path are seeded into one conflict group so they never share a
 * wave, even when their file sets do not overlap. The seed is a TOP-LEVEL
 * option of `buildFastFanoutPlan`, not a `limits` key — putting it in `limits`
 * would reproduce the exact fallback this file guards against. Absent/empty
 * leaves the plan byte-for-byte unchanged; unreadable input is fail-closed
 * (one stem), because unknown ownership must shrink concurrency, not widen it.
 *
 * Mutation run, 2026-08-26: replacing `tasksConflict` with the path-only check
 * inside `buildWaves` turns "never co-located" red; removing the seed from
 * `buildConflictGroups` turns the `conflictGroups` assertion red. Both seams
 * are covered separately because a plan that reports a group and then
 * co-locates its members anyway is the inconsistent state we most want to see.
 *
 * WHAT THIS STILL DOES NOT COVER:
 *   - Whether `commands/split.md` actually passes `limits:{maxWorktrees,
 *     hardMaxAgents}` and top-level `serverEntryPaths`. This file drives the
 *     planner directly; the markdown call site is a different gate (and a
 *     model reading prose, so a text-parity test would only show the words).
 *   - Whether `artibot.config.json#split` exists or carries these keys. Config
 *     objects here are injected literals.
 *   - That a merged stem really avoids the port collision. The seed groups by
 *     path; it does not know ports, and it does not know about servers started
 *     from paths not listed in the seed.
 *   - The cpu axis. `cpuCount` is pinned high so only the window cap binds.
 */

import { describe, expect, it } from 'vitest';
import { buildFastFanoutPlan, FAST_PROFILE_DEFAULTS } from '../../lib/autopilot/fast-profile.js';

const CPU_COUNT = 32; // agentsPerCpu(2) × 32 = 64 > every cap under test, so cpu never binds.

function task(id, affectedPaths, overrides = {}) {
  return { id, independent: true, affectedPaths, risk: 'low', worktreeEligible: true, ...overrides };
}

/** N tasks on N disjoint files — no path conflicts, so only caps shape the waves. */
function disjointTasks(count) {
  return Array.from({ length: count }, (_, index) => task(`t${index + 1}`, [`src/t${index + 1}.js`]));
}

/** Mirrors the PRD's mapping: one `maxWindows` value feeds both existing keys. */
function splitLimits(maxWindows) {
  return { maxWorktrees: maxWindows, hardMaxAgents: maxWindows };
}

function coLocated(plan, a, b) {
  return plan.waves.some((wave) => wave.taskIds.includes(a) && wave.taskIds.includes(b));
}

describe('split limits reach the planner (maxWindows → maxWorktrees/hardMaxAgents)', () => {
  const TASK_COUNT = 10;

  it('negative control: with no limits the same 10 tasks fan out to 10', () => {
    const plan = buildFastFanoutPlan({ fast: true, cpuCount: CPU_COUNT, tasks: disjointTasks(TASK_COUNT) });
    expect(plan.profile).toBe('fast');
    expect(plan.plannedParallelism).toBe(TASK_COUNT);
    expect(plan.waves).toHaveLength(1);
    expect(plan.limits.maxWorktrees).toBe(FAST_PROFILE_DEFAULTS.maxWorktrees);
  });

  it.each([4, 3])('maxWindows=%i is the wave ceiling for 10 disjoint tasks', (maxWindows) => {
    const plan = buildFastFanoutPlan({
      fast: true, cpuCount: CPU_COUNT, tasks: disjointTasks(TASK_COUNT), limits: splitLimits(maxWindows),
    });

    expect(plan.profile).toBe('fast');
    // The value was read, not defaulted.
    expect(plan.limits.maxWorktrees).toBe(maxWindows);
    expect(plan.limits.hardMaxAgents).toBe(maxWindows);
    // And it is what binds: the widest wave is exactly the cap, none exceed it,
    // and the wave count is what 10 tasks need under that cap.
    expect(plan.plannedParallelism).toBe(maxWindows);
    expect(plan.worktrees).toEqual({ required: true, count: maxWindows });
    expect(Math.max(...plan.waves.map((wave) => wave.worktreeCount))).toBe(maxWindows);
    expect(plan.waves.every((wave) => wave.worktreeCount <= maxWindows)).toBe(true);
    expect(plan.waves).toHaveLength(Math.ceil(TASK_COUNT / maxWindows));
    // Nothing was dropped to make the cap fit.
    expect(plan.waves.flatMap((wave) => wave.taskIds).sort()).toEqual(
      disjointTasks(TASK_COUNT).map((entry) => entry.id).sort(),
    );
    expect(plan.serial).toEqual([]);
  });

  it('pins the trap: a `maxWindows` key inside `limits` is silently ignored', () => {
    // This is the failure the mapping exists to avoid. If this test ever goes
    // red because the planner learned `maxWindows`, update the mapping AND the
    // PRD together — do not just delete the assertion.
    const plan = buildFastFanoutPlan({
      fast: true, cpuCount: CPU_COUNT, tasks: disjointTasks(TASK_COUNT), limits: { maxWindows: 4 },
    });
    expect(plan.limits).not.toHaveProperty('maxWindows');
    expect(plan.plannedParallelism).toBe(TASK_COUNT);
  });
});

describe('serverEntryPaths seeds the conflict grouping', () => {
  const ENTRIES = ['src/server.js', 'apps/api'];
  const tasks = () => [
    task('boot', ['src/server.js']),        // exact entry
    task('routes', ['apps/api/routes.js']), // descendant of a directory entry
    task('ui', ['src/ui/app.js']),
    task('docs', ['docs/readme.md']),
  ];

  it('negative control: without the seed the four tasks share one wave', () => {
    const plan = buildFastFanoutPlan({ fast: true, cpuCount: CPU_COUNT, tasks: tasks() });
    expect(plan.conflictGroups).toEqual([]);
    expect(coLocated(plan, 'boot', 'routes')).toBe(true);
  });

  it('merges every task touching an entry into one group and never co-locates them', () => {
    const plan = buildFastFanoutPlan({
      fast: true, cpuCount: CPU_COUNT, tasks: tasks(), serverEntryPaths: ENTRIES,
    });

    expect(plan.profile).toBe('fast');
    expect(plan.conflictGroups).toEqual([{ id: 'conflict-1', taskIds: ['boot', 'routes'] }]);
    expect(coLocated(plan, 'boot', 'routes')).toBe(false);
    // Unrelated work keeps its parallelism and nothing is dropped.
    expect(plan.plannedParallelism).toBeGreaterThanOrEqual(2);
    expect(plan.waves.flatMap((wave) => wave.taskIds).sort()).toEqual(['boot', 'docs', 'routes', 'ui']);
    expect(plan.serial).toEqual([]);
  });

  it('a directory-level claim that contains an entry counts as touching it', () => {
    const plan = buildFastFanoutPlan({
      fast: true, cpuCount: CPU_COUNT, serverEntryPaths: ['src/server.js'],
      tasks: [task('whole-src', ['src']), task('routes', ['apps/api/routes.js']), task('docs', ['docs/a.md'])],
    });
    // `src` owns `src/server.js`; `routes` does not touch the only entry.
    expect(plan.conflictGroups).toEqual([]);
    expect(coLocated(plan, 'whole-src', 'routes')).toBe(true);

    const seeded = buildFastFanoutPlan({
      fast: true, cpuCount: CPU_COUNT, serverEntryPaths: ['src/server.js', 'apps/api'],
      tasks: [task('whole-src', ['src']), task('routes', ['apps/api/routes.js']), task('docs', ['docs/a.md'])],
    });
    expect(seeded.conflictGroups).toEqual([{ id: 'conflict-1', taskIds: ['whole-src', 'routes'] }]);
    expect(coLocated(seeded, 'whole-src', 'routes')).toBe(false);
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['empty array', []],
  ])('an absent seed (%s) leaves the plan unchanged', (_label, serverEntryPaths) => {
    const baseline = buildFastFanoutPlan({ fast: true, cpuCount: CPU_COUNT, tasks: tasks() });
    const plan = buildFastFanoutPlan({ fast: true, cpuCount: CPU_COUNT, tasks: tasks(), serverEntryPaths });
    expect(plan).toEqual(baseline);
  });

  it.each([
    ['a bare string', 'src/server.js'],
    ['an absolute path', ['/srv/app/server.js']],
    ['a drive path', ['C:\\app\\server.js']],
    ['a traversal', ['src/../server.js']],
    ['a non-string entry beside a good one', ['src/server.js', { glob: 'apps/api' }]],
  ])('an unreadable seed (%s) is fail-closed: one stem, no fan-out', (_label, serverEntryPaths) => {
    const plan = buildFastFanoutPlan({ fast: true, cpuCount: CPU_COUNT, tasks: tasks(), serverEntryPaths });
    expect(plan.profile).toBe('standard');
    expect(plan.fallbackReason).toBe('no-safe-parallelism');
    expect(plan.conflictGroups).toEqual([{ id: 'conflict-1', taskIds: ['boot', 'routes', 'ui', 'docs'] }]);
    expect(plan.serial.map((entry) => entry.reason)).toEqual(Array(4).fill('conflict-serialized'));
  });

  it('seed and window cap compose: the cap still bounds the waves the seed leaves', () => {
    const plan = buildFastFanoutPlan({
      fast: true, cpuCount: CPU_COUNT, limits: splitLimits(3),
      serverEntryPaths: ['src/server.js'],
      tasks: [
        task('boot-a', ['src/server.js']),
        task('boot-b', ['src/server.js', 'src/boot-b.js']),
        ...disjointTasks(6),
      ],
    });
    expect(plan.profile).toBe('fast');
    expect(coLocated(plan, 'boot-a', 'boot-b')).toBe(false);
    expect(plan.waves.every((wave) => wave.worktreeCount <= 3)).toBe(true);
    expect(plan.plannedParallelism).toBe(3);
    expect(plan.waves.flatMap((wave) => wave.taskIds)).toHaveLength(8);
  });
});
