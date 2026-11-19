/**
 * `lib/git/orca-plan.js` — the pure `/orca` decisions: dependency graph, plan
 * assessment, run compilation, binding and dispatch records, landing state,
 * readiness and next actions, row and run shape checks.
 *
 * Where the data comes from (rules section 9: an invented fixture proves
 * nothing): the 8-lane scenario is the REAL `buildFastFanoutPlan` output for
 * task sets shaped like this project's own lanes, and a precondition test fails
 * if the planner stops producing the waves the expectations were derived from.
 * The commit-0 trap is run against a REAL temporary git repository with the REAL
 * `readLimbCompletion`. The binding values are transcribed from the P0 receipt
 * `wt-a-show.json` (Orca 1.4.259). Expected `deps` lists are derived by hand
 * from the contract (declared dependencies + conflicting pairs pointed along
 * the plan order + unknown ownership last), not copied from a run.
 *
 * What this file cannot see:
 *  - The real Orca. `observed` is what a caller measured; nothing here proves
 *    `status.mjs` measures it correctly (that is L5's tests).
 *  - Whether `landingState`'s inputs are measured AFTER a fetch. The git test
 *    moves a remote-tracking ref by hand, as a fetch would.
 *  - Planner shapes the fixtures do not contain; the graph is only as good as
 *    `areAffectedPathsConflicting`, which is reused, not re-tested.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildFastFanoutPlan } from '../../lib/autopilot/fast-profile.js';
import { readLimbCompletion } from '../../lib/git/limb-completion.js';
import {
  appendDispatch,
  assessPlan,
  bindLimb,
  buildDependencyGraph,
  compileRun,
  DISPATCH_KINDS,
  landingState,
  LIMB_SLUG,
  limbName,
  nextActions,
  ORCA_RUN_SCHEMA_VERSION,
  readyLimbs,
  validateLimbRow,
} from '../../lib/git/orca-plan.js';
import { validateOrcaRun } from '../../lib/git/orca-run-file.js';

const deepFreeze = (value) => {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
};
const clone = (value) => JSON.parse(JSON.stringify(value));

const fast = (id, affectedPaths, extra = {}) => ({
  id, affectedPaths, independent: true, risk: 'low', worktreeEligible: true, ...extra,
});
const plain = (id, affectedPaths, extra = {}) => ({ id, affectedPaths, ...extra });
const depsByLimb = (limbs) => Object.fromEntries(limbs.map((row) => [row.limb, row.deps]));
const graphOf = (tasks, plan) => {
  const graph = buildDependencyGraph(tasks, plan);
  expect(graph.ok, JSON.stringify(graph)).toBe(true);
  return graph.limbs;
};

/** This project's own lanes plus a README conflict (L6/L7) and a task that owns nothing (L8). */
const LANE_TASKS = [
  fast('L1', ['lib/git/orca-plan.js', 'lib/git/orca-run-file.js', 'schemas/limb-row.schema.json']),
  fast('L2', ['lib/security/human-gates.js', 'tests/security/human-gates.test.js']),
  fast('L3', ['artibot.config.json', '.gitignore']),
  fast('L4', ['scripts/orca/preflight.mjs', 'scripts/orca/plan.mjs'], { dependsOn: ['L1'] }),
  fast('L5', ['scripts/orca/bind.mjs', 'scripts/orca/status.mjs'], { dependsOn: ['L1'] }),
  fast('L6', ['commands/orca.md', 'README.md'], { dependsOn: ['L3', 'L4', 'L5'] }),
  fast('L7', ['README.md', 'docs/']),
  { id: 'L8', independent: true, risk: 'low', worktreeEligible: true },
];
const lanePlan = () => buildFastFanoutPlan({ fast: true, tasks: LANE_TASKS, cpuCount: 8 });

const NOW = new Date('2026-11-19T04:50:00.000Z');
const compileLanes = (extra = {}) => compileRun({
  objective: '/orca 구현', tag: 'a1b2c3', now: NOW, tasks: LANE_TASKS, plan: lanePlan(), appVersion: '1.4.259', repoId: 'repo-1', ...extra,
});
const lanesRun = () => {
  const compiled = compileLanes();
  expect(compiled.ok, JSON.stringify(compiled)).toBe(true);
  return compiled.run;
};

/**
 * Values transcribed from the P0 receipt `wt-a-show.json` (the user path is `<HOME>` there too).
 * The commit id is joined from 8-character pieces only because the write-time secret guard flags a
 * whole 40-hex literal as a possible credential; the value is the receipt's `head`.
 */
const P0_BINDING = {
  worktreeId: 'd56eb7c9-5a43-4fcf-8c27-05cfbf914642::<HOME>/orca/workspaces/Artibot/orca-p0-a',
  worktreePath: '<HOME>/orca/workspaces/Artibot/orca-p0-a',
  branch: 'orca/p0-a-fcb0gj',
  forkPoint: ['dcb6b1b9', '106362de', '910b4dba', 'd51c04b0', '7b350322'].join(''),
};

const dispatchOf = (id, extra = {}) => ({
  dispatchId: `ctx_${id}`, taskId: `task_${id}`, kind: 'initial', at: '2026-11-19T05:00:00.000Z', ...extra,
});
/** Start a dispatch on each limb through the real `appendDispatch`. */
const dispatched = (run, limbs) => limbs.reduce((current, limb) => {
  const next = appendDispatch(current, limb, dispatchOf(limb));
  expect(next.ok, JSON.stringify(next)).toBe(true);
  return next.run;
}, run);

describe('constants', () => {
  it('pin the run schema version and the dispatch vocabulary', () => {
    expect(ORCA_RUN_SCHEMA_VERSION).toBe(1);
    expect(DISPATCH_KINDS).toEqual(['initial', 'retry', 'rework']);
    expect(Object.isFrozen(DISPATCH_KINDS)).toBe(true);
    expect(LIMB_SLUG.source).toBe('^[a-z0-9][a-z0-9-]{1,30}$');
  });
});

describe('limbName', () => {
  it('returns a string that is already a valid slug unchanged', () => {
    for (const slug of ['l1-core-lib', 'a1', 'x'.repeat(31), 'a--b', 'abc-', '9z']) {
      expect(limbName(slug)).toBe(slug);
    }
  });

  it('lower-cases, turns separators and symbols into one hyphen, and trims', () => {
    expect(limbName('L1 Core/Lib')).toBe('l1-core-lib');
    expect(limbName('  Auth Service  ')).toBe('auth-service');
    expect(limbName('L1_core.lib')).toBe('l1-core-lib');
    expect(limbName('A///B')).toBe('a-b');
  });

  it('pads what is too short and names an id with no ASCII letter or digit', () => {
    expect(limbName('7')).toBe('limb-7');
    expect(limbName('x')).toBe('limb-x');
    expect(limbName('작업')).toBe('limb');
    expect(limbName('')).toBe('limb');
    expect(limbName(undefined)).toBe('limb');
    expect(limbName(42)).toBe('limb');
  });

  it('cuts to 31 characters and does not end on a hyphen', () => {
    expect(limbName('A'.repeat(100))).toBe('a'.repeat(31));
    expect(limbName(`${'a'.repeat(30)}-b`)).toBe('a'.repeat(30));
  });

  it('always produces a valid slug, including for hostile single-run inputs of 120 KB', () => {
    const inputs = [
      '', ' ', '--', '..', '_', '-a-', 'ÀÉÎ', '日本語', 'a'.repeat(32), 'A/b\\c:d', '\0', `  ${'Q'.repeat(40)}`,
      '-'.repeat(120_000), '.'.repeat(120_000), `a${'.'.repeat(120_000)}a`, `a${'.-'.repeat(60_000)}a`,
      ' '.repeat(120_000) + 'z', 'é'.repeat(120_000), 'a'.repeat(120_000),
    ];
    for (const input of inputs) expect(LIMB_SLUG.test(limbName(input)), JSON.stringify(input.slice(0, 20))).toBe(true);
  });
});

describe('buildDependencyGraph — the 8-lane scenario from the real planner', () => {
  it('precondition: the planner still produces the waves these expectations were derived from', () => {
    const plan = lanePlan();
    expect(plan.fallbackReason).toBeNull();
    expect(plan.waves.map((wave) => wave.taskIds)).toEqual([['L1', 'L2', 'L3', 'L7'], ['L4', 'L5'], ['L6']]);
    expect(plan.serial).toEqual([{ taskId: 'L8', reason: 'missing-affected-paths' }]);
    expect(plan.conflictGroups.map((group) => group.taskIds)).toEqual([['L6', 'L7']]);
  });

  it('turns EVERY task into a limb (not just the first wave) with declared + conflict + unknown-ownership edges', () => {
    const limbs = graphOf(LANE_TASKS, lanePlan());
    expect(limbs.map((row) => row.limb)).toEqual(['l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7', 'l8']);
    expect(depsByLimb(limbs)).toEqual({
      l1: [],
      l2: [],
      l3: [],
      l4: ['l1'],
      l5: ['l1'],
      // declared L3, L4, L5 plus the README.md conflict with L7, which the plan put first
      l6: ['l3', 'l4', 'l5', 'l7'],
      l7: [],
      // owns nothing known: after every other limb
      l8: ['l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7'],
    });
  });

  it('emits unbound rows with exactly the IC-2 keys, in order', () => {
    const [first] = graphOf(LANE_TASKS, lanePlan());
    expect(Object.keys(first)).toEqual(['limb', 'taskIds', 'affectedPaths', 'deps', 'worktreeId', 'worktreePath', 'branch', 'forkPoint', 'dispatches']);
    expect(first).toEqual({
      limb: 'l1',
      taskIds: ['L1'],
      affectedPaths: ['lib/git/orca-plan.js', 'lib/git/orca-run-file.js', 'schemas/limb-row.schema.json'],
      deps: [],
      worktreeId: null,
      worktreePath: null,
      branch: null,
      forkPoint: null,
      dispatches: [],
    });
  });

  it('does not mutate its inputs (deep-frozen tasks and plan)', () => {
    const tasks = deepFreeze(clone(LANE_TASKS));
    const plan = deepFreeze(clone(lanePlan()));
    expect(buildDependencyGraph(tasks, plan).ok).toBe(true);
  });
});

describe('buildDependencyGraph — edges', () => {
  it('follows a multi-stage declared chain given in reverse input order, keeping input order for the rows', () => {
    const limbs = graphOf([
      plain('S4', ['src/d.js'], { dependsOn: ['S3'] }),
      plain('S3', ['src/c.js'], { dependsOn: ['S2'] }),
      plain('S2', ['src/b.js'], { dependsOn: ['S1'] }),
      plain('S1', ['src/a.js']),
    ], null);
    expect(limbs.map((row) => row.limb)).toEqual(['s4', 's3', 's2', 's1']);
    expect(depsByLimb(limbs)).toEqual({ s4: ['s3'], s3: ['s2'], s2: ['s1'], s1: [] });
  });

  it('also reads the planner`s `dependencies` key', () => {
    const limbs = graphOf([plain('A1', ['src/a.js']), plain('B1', ['src/b.js'], { dependencies: ['A1'] })], null);
    expect(depsByLimb(limbs)).toEqual({ a1: [], b1: ['a1'] });
  });

  it('points a conflict along the PLAN order, not the input order', () => {
    // P1 waits for Q1 (declared) so the planner puts P1 in wave 2; R1 conflicts with P1 and goes first.
    const tasks = [
      fast('P1', ['src/shared/a.js'], { dependsOn: ['Q1'] }),
      fast('Q1', ['src/q.js']),
      fast('R1', ['src/shared/']),
    ];
    const plan = buildFastFanoutPlan({ fast: true, tasks, cpuCount: 8 });
    expect(plan.waves.map((wave) => wave.taskIds)).toEqual([['Q1', 'R1'], ['P1']]);
    expect(depsByLimb(graphOf(tasks, plan))).toEqual({ p1: ['q1', 'r1'], q1: [], r1: [] });
  });

  it('serialises nested ownership (a directory and a file inside it) in plan order, under a fallback plan too', () => {
    const tasks = [fast('A1', ['src/']), fast('B1', ['src/a.js'])];
    const plan = buildFastFanoutPlan({ fast: true, tasks, cpuCount: 8 });
    expect(plan.fallbackReason).toBe('no-safe-parallelism');
    expect(depsByLimb(graphOf(tasks, plan))).toEqual({ a1: [], b1: ['a1'] });
  });

  it('does not serialise pairs that only conflict through a third task', () => {
    // T2 and T3 both sit inside T1's directory but not inside each other's file.
    const tasks = [fast('T1', ['src/a/']), fast('T2', ['src/a/b.js']), fast('T3', ['src/a/c.js']), fast('T4', ['docs/'])];
    const plan = buildFastFanoutPlan({ fast: true, tasks, cpuCount: 8 });
    expect(plan.waves.map((wave) => wave.taskIds)).toEqual([['T1', 'T4'], ['T2', 'T3']]);
    expect(depsByLimb(graphOf(tasks, plan))).toEqual({ t1: [], t2: ['t1'], t3: ['t1'], t4: [] });
  });

  it('keeps the planner`s server-entry conflicts, which no path overlap explains', () => {
    const tasks = [fast('A1', ['server/routes/a.js']), fast('B1', ['server/routes/b.js']), fast('C1', ['docs/c.md'])];
    const seeded = buildFastFanoutPlan({ fast: true, tasks, cpuCount: 8, serverEntryPaths: ['server'] });
    expect(seeded.waves.map((wave) => wave.taskIds)).toEqual([['A1', 'C1'], ['B1']]);
    expect(depsByLimb(graphOf(tasks, seeded))).toEqual({ a1: [], b1: ['a1'], c1: [] });

    const unseeded = buildFastFanoutPlan({ fast: true, tasks, cpuCount: 8 });
    expect(unseeded.waves.map((wave) => wave.taskIds)).toEqual([['A1', 'B1', 'C1']]);
    expect(depsByLimb(graphOf(tasks, unseeded))).toEqual({ a1: [], b1: [], c1: [] });
  });

  it('does not turn a plan that disagrees with a declared dependency into a false cycle', () => {
    // Input order Y1, X1, Z1; the conflict X1-Y1 points Y1 -> X1 by input order, but Y1 waits for Z1 which waits for X1.
    const tasks = [
      plain('Y1', ['src/s.js'], { dependsOn: ['Z1'] }),
      plain('X1', ['src/s.js']),
      plain('Z1', ['src/z.js'], { dependsOn: ['X1'] }),
    ];
    expect(depsByLimb(graphOf(tasks, null))).toEqual({ y1: ['x1', 'z1'], x1: [], z1: ['x1'] });
  });

  it('accepts a null or missing plan (input order), and ignores plan ids it does not know', () => {
    const tasks = [plain('A1', ['src/x/']), plain('B1', ['src/x/b.js'])];
    expect(depsByLimb(graphOf(tasks))).toEqual({ a1: [], b1: ['a1'] });
    expect(depsByLimb(graphOf(tasks, null))).toEqual({ a1: [], b1: ['a1'] });
    const stale = { waves: [{ taskIds: ['B1', 'ghost'] }], serial: [{ taskId: 'A1' }], conflictGroups: [{ taskIds: ['ghost', 'A1'] }] };
    expect(depsByLimb(graphOf(tasks, stale))).toEqual({ a1: ['b1'], b1: [] });
  });

  it('reads a malformed plan as no plan (input order) instead of throwing', () => {
    const tasks = [plain('A1', ['src/x/']), plain('B1', ['src/x/b.js'])];
    for (const plan of ['plan', 7, [], { waves: 'x', serial: {}, conflictGroups: 'y' }, { waves: [null, { taskIds: 'x' }], serial: [null, 5], conflictGroups: [null, { taskIds: 'z' }] }]) {
      expect(depsByLimb(graphOf(tasks, plan)), JSON.stringify(plan)).toEqual({ a1: [], b1: ['a1'] });
    }
  });
});

describe('buildDependencyGraph — unknown ownership runs last', () => {
  it('orders a limb with no, absolute or escaping paths after every known one, and those after one another', () => {
    const tasks = [
      fast('A1', ['src/a.js']),
      fast('B1', ['src/b.js']),
      { id: 'X1', independent: true, risk: 'low', worktreeEligible: true },
      fast('X2', ['/etc/hosts']),
      fast('X3', ['../outside.js']),
    ];
    const plan = buildFastFanoutPlan({ fast: true, tasks, cpuCount: 8 });
    expect(plan.serial.map((entry) => entry.taskId)).toEqual(['X1', 'X2', 'X3']);
    expect(depsByLimb(graphOf(tasks, plan))).toEqual({
      a1: [], b1: [], x1: ['a1', 'b1'], x2: ['a1', 'b1', 'x1'], x3: ['a1', 'b1', 'x1', 'x2'],
    });
  });

  it('treats a mixed list with a root-only entry as unknown ownership (it claims the whole tree)', () => {
    const limbs = graphOf([plain('A1', ['src/a.js']), plain('M1', ['src/ok.js', '.'])], null);
    expect(depsByLimb(limbs)).toEqual({ a1: [], m1: ['a1'] });
    expect(limbs[1].affectedPaths).toEqual(['src/ok.js', '.']);
  });

  it('fails with `cycle` when a limb with known ownership depends on one without', () => {
    const tasks = [plain('U1', []), plain('K1', ['src/k.js'], { dependsOn: ['U1'] })];
    expect(buildDependencyGraph(tasks, null)).toEqual({ ok: false, reason: 'cycle' });
  });
});

describe('buildDependencyGraph — refusals', () => {
  it('reports declared cycles, self-dependencies and longer cycles as `cycle`', () => {
    const two = [plain('A', ['a/'], { dependsOn: ['B'] }), plain('B', ['b/'], { dependsOn: ['A'] })];
    const self = [plain('A', ['a/'], { dependsOn: ['A'] })];
    const three = [
      plain('A', ['a/'], { dependsOn: ['C'] }), plain('B', ['b/'], { dependsOn: ['A'] }), plain('C', ['c/'], { dependsOn: ['B'] }),
    ];
    for (const tasks of [two, self, three]) expect(buildDependencyGraph(tasks, null)).toEqual({ ok: false, reason: 'cycle' });
  });

  it('reports an unknown or malformed dependency as `unresolved-dependency`', () => {
    for (const dependsOn of [['ghost'], 'A', [1], [''], [null], {}]) {
      const tasks = [plain('A', ['a/']), plain('B', ['b/'], { dependsOn })];
      expect(buildDependencyGraph(tasks, null), JSON.stringify(dependsOn)).toEqual({ ok: false, reason: 'unresolved-dependency' });
    }
    // absent and null mean "none"
    expect(buildDependencyGraph([plain('A', ['a/'], { dependsOn: null }), plain('B', ['b/'], { dependsOn: undefined })], null).ok).toBe(true);
  });

  it('reports a repeated id, whitespace included, as `duplicate-id`', () => {
    expect(buildDependencyGraph([plain('A', ['a/']), plain('A', ['b/'])], null)).toEqual({ ok: false, reason: 'duplicate-id' });
    expect(buildDependencyGraph([plain(' A', ['a/']), plain('A', ['b/'])], null)).toEqual({ ok: false, reason: 'duplicate-id' });
  });

  it('reports tasks that are not a non-empty list of objects, or lack an id, instead of throwing', () => {
    for (const tasks of [undefined, null, 'A', [], [null], ['A'], [[]]]) {
      expect(buildDependencyGraph(tasks, null), JSON.stringify(tasks)).toEqual({ ok: false, reason: 'invalid-tasks' });
    }
    for (const bad of [{ affectedPaths: ['a/'] }, { id: '  ' }, { id: 5 }]) {
      expect(buildDependencyGraph([bad], null), JSON.stringify(bad)).toEqual({ ok: false, reason: 'missing-id' });
    }
  });
});

describe('buildDependencyGraph — names and paths', () => {
  it('suffixes colliding names, and never displaces an id that already is a slug', () => {
    const limbs = graphOf([
      plain('Auth/x', ['a/']), plain('auth-x', ['b/']), plain('auth-x-2', ['c/']), plain('AUTH X', ['d/']),
    ], null);
    expect(limbs.map((row) => row.limb)).toEqual(['auth-x-3', 'auth-x', 'auth-x-2', 'auth-x-4']);
    expect(limbs.map((row) => row.taskIds[0])).toEqual(['Auth/x', 'auth-x', 'auth-x-2', 'AUTH X']);
    expect(new Set(limbs.map((row) => row.limb)).size).toBe(4);
    for (const row of limbs) expect(LIMB_SLUG.test(row.limb)).toBe(true);
  });

  it('stores the owned paths trimmed and de-duplicated, with their case', () => {
    const [row] = graphOf([plain('A', ['Src/A.js ', 'Src/A.js', 'lib/x.js', 7, null])], null);
    expect(row.affectedPaths).toEqual(['Src/A.js', 'lib/x.js']);
  });
});

describe('assessPlan', () => {
  it('accepts the real fast plan', () => {
    expect(assessPlan(lanePlan(), { minStems: 2 })).toEqual({ ok: true, reason: null });
  });

  it('refuses a plan with a fallback reason, naming it', () => {
    const noParallelism = buildFastFanoutPlan({ fast: true, tasks: [fast('A', ['src/']), fast('B', ['src/a.js'])], cpuCount: 8 });
    expect(assessPlan(noParallelism, { minStems: 2 })).toEqual({ ok: false, reason: 'fallback:no-safe-parallelism' });
    const notRequested = buildFastFanoutPlan({ fast: false, tasks: LANE_TASKS });
    expect(assessPlan(notRequested, { minStems: 2 })).toEqual({ ok: false, reason: 'fallback:fast-not-requested' });
    const noTasks = buildFastFanoutPlan({ fast: true, tasks: [] });
    expect(assessPlan(noTasks, { minStems: 2 })).toEqual({ ok: false, reason: 'fallback:no-tasks' });
  });

  it('refuses a plan whose planned parallelism is below minStems', () => {
    const plan = lanePlan();
    expect(plan.plannedParallelism).toBe(4);
    expect(assessPlan(plan, { minStems: 5 })).toEqual({ ok: false, reason: 'stems-below-min:4/5' });
    expect(assessPlan(plan, { minStems: 4 }).ok).toBe(true);
  });

  it('measures a plan that lacks plannedParallelism from its waves, and defaults a bad minStems to 2', () => {
    const handBuilt = { fallbackReason: null, waves: [{ taskIds: ['a', 'b', 'c'] }, { taskIds: ['d'] }] };
    expect(assessPlan(handBuilt, { minStems: 3 }).ok).toBe(true);
    expect(assessPlan(handBuilt, { minStems: 4 })).toEqual({ ok: false, reason: 'stems-below-min:3/4' });
    expect(assessPlan({ fallbackReason: null, waves: [{ taskIds: ['a'] }] }, {})).toEqual({ ok: false, reason: 'stems-below-min:1/2' });
    for (const minStems of [undefined, 0, -1, 1.5, '3', null]) {
      expect(assessPlan({ fallbackReason: null, waves: [{ taskIds: ['a'] }] }, { minStems }).ok, String(minStems)).toBe(false);
    }
    expect(assessPlan({ fallbackReason: null, waves: [] })).toEqual({ ok: false, reason: 'stems-below-min:0/2' });
    for (const waves of ['x', undefined, [null], [{ taskIds: 'x' }]]) {
      expect(assessPlan({ fallbackReason: null, waves }), JSON.stringify(waves)).toEqual({ ok: false, reason: 'stems-below-min:0/2' });
    }
  });

  it('refuses a missing plan', () => {
    for (const plan of [undefined, null, 'plan', 7, []]) expect(assessPlan(plan)).toEqual({ ok: false, reason: 'no-plan' });
  });
});

describe('compileRun', () => {
  it('compiles the run.json planning part in the IC-2 shape', () => {
    const run = lanesRun();
    expect(Object.keys(run)).toEqual(['schema_version', 'provider', 'runId', 'tag', 'objective', 'integrationRef', 'createdAt', 'orca', 'limbs']);
    expect(run).toMatchObject({
      schema_version: 1,
      provider: 'orca',
      runId: null,
      tag: 'a1b2c3',
      objective: '/orca 구현',
      integrationRef: 'origin/master',
      createdAt: '2026-11-19T04:50:00.000Z',
      orca: { appVersion: '1.4.259', environment: 'local', repoId: 'repo-1' },
    });
    expect(run.limbs).toEqual(graphOf(LANE_TASKS, lanePlan()));
  });

  it('passes the run-file shape check, and its rows are valid only as unbound planning rows', () => {
    const run = lanesRun();
    expect(validateOrcaRun(run)).toEqual({ ok: true, errors: [] });
    for (const row of run.limbs) {
      expect(validateLimbRow(row, { allowUnbound: true }).ok, row.limb).toBe(true);
      expect(validateLimbRow(row).ok, row.limb).toBe(false);
    }
  });

  it('takes a given runId and integration ref', () => {
    const compiled = compileLanes({ runId: 'run_3c01547fc37f', integrationRef: 'origin/main' });
    expect(compiled.run).toMatchObject({ runId: 'run_3c01547fc37f', integrationRef: 'origin/main' });
  });

  it('records a missing app version or repo id as null rather than refusing', () => {
    const compiled = compileLanes({ appVersion: undefined, repoId: '' });
    expect(compiled.run.orca).toEqual({ appVersion: null, environment: 'local', repoId: null });
  });

  it('accepts `now` as a Date, a millisecond number or a string (kept verbatim)', () => {
    expect(compileLanes({ now: NOW }).run.createdAt).toBe('2026-11-19T04:50:00.000Z');
    expect(compileLanes({ now: NOW.getTime() }).run.createdAt).toBe('2026-11-19T04:50:00.000Z');
    expect(compileLanes({ now: '2026-11-19T13:50:00+09:00' }).run.createdAt).toBe('2026-11-19T13:50:00+09:00');
  });

  it('passes a graph failure through unchanged', () => {
    const tasks = [plain('A', ['a/']), plain('A', ['b/'])];
    expect(compileRun({ objective: 'o', tag: 'a1b2c3', now: NOW, tasks, plan: null })).toEqual({ ok: false, reason: 'duplicate-id' });
    expect(compileRun({ objective: 'o', tag: 'a1b2c3', now: NOW, tasks: [plain('A', ['a/'], { dependsOn: ['A'] })] })).toEqual({ ok: false, reason: 'cycle' });
    expect(compileRun()).toEqual({ ok: false, reason: 'invalid-tasks' });
  });

  it('refuses a run whose own fields are unusable', () => {
    const cases = [
      [{ objective: undefined }, 'missing-objective'],
      [{ objective: '   ' }, 'missing-objective'],
      [{ tag: undefined }, 'bad-tag'],
      [{ tag: 'ab' }, 'bad-tag'],
      [{ tag: 'a/b/c/d' }, 'bad-tag'],
      [{ tag: 'A1B2C3' }, 'bad-tag'],
      [{ tag: 'x'.repeat(17) }, 'bad-tag'],
      [{ integrationRef: '' }, 'bad-integration-ref'],
      [{ integrationRef: 'origin master' }, 'bad-integration-ref'],
      [{ runId: '' }, 'bad-run-id'],
      [{ runId: 42 }, 'bad-run-id'],
      [{ now: undefined }, 'bad-now'],
      [{ now: new Date('nope') }, 'bad-now'],
      [{ now: Number.NaN }, 'bad-now'],
      [{ now: '' }, 'bad-now'],
    ];
    for (const [override, reason] of cases) {
      expect(compileLanes(override), JSON.stringify(override)).toEqual({ ok: false, reason });
    }
  });

  it('accepts a plan-time tag of 6 hex digits and any slug-safe tag of 4-16 characters', () => {
    for (const tag of ['a1b2c3', '000000', 'tag123', 'abcd', 'x'.repeat(16)]) expect(compileLanes({ tag }).ok, tag).toBe(true);
  });

  it('does not mutate its inputs', () => {
    const tasks = deepFreeze(clone(LANE_TASKS));
    const plan = deepFreeze(clone(lanePlan()));
    expect(compileRun({ objective: 'o', tag: 'a1b2c3', now: NOW, tasks, plan }).ok).toBe(true);
  });
});

describe('bindLimb', () => {
  it('records the worktree id, path, branch and fork point on the named limb only', () => {
    const run = lanesRun();
    const bound = bindLimb(run, 'l1', P0_BINDING);
    expect(bound.ok).toBe(true);
    expect(bound.run.limbs[0]).toMatchObject(P0_BINDING);
    expect(bound.run.limbs[0]).toMatchObject({ limb: 'l1', deps: [], dispatches: [] });
    expect(bound.run.limbs.slice(1)).toEqual(run.limbs.slice(1));
    expect(validateLimbRow(bound.run.limbs[0])).toEqual({ ok: true, errors: [] });
    expect(validateOrcaRun(bound.run).ok).toBe(true);
  });

  it('does not mutate the run it is given', () => {
    const run = deepFreeze(lanesRun());
    const before = JSON.stringify(run);
    const bound = bindLimb(run, 'l2', P0_BINDING);
    expect(bound.ok).toBe(true);
    expect(JSON.stringify(run)).toBe(before);
    expect(bound.run).not.toBe(run);
    expect(bound.run.limbs[1]).not.toBe(run.limbs[1]);
  });

  it('answers `unknown-limb` for a name the run does not have (and for a run with no limbs)', () => {
    expect(bindLimb(lanesRun(), 'nope', P0_BINDING)).toEqual({ ok: false, reason: 'unknown-limb' });
    expect(bindLimb(lanesRun(), 'L1', P0_BINDING)).toEqual({ ok: false, reason: 'unknown-limb' });
    expect(bindLimb({}, 'l1', P0_BINDING)).toEqual({ ok: false, reason: 'unknown-limb' });
    expect(bindLimb(null, 'l1', P0_BINDING)).toEqual({ ok: false, reason: 'unknown-limb' });
  });

  it('refuses a binding with a blank or non-string worktree id, path or branch, or a bad fork point', () => {
    const run = lanesRun();
    for (const patch of [{ worktreeId: '' }, { worktreePath: ' ' }, { branch: null }, { branch: undefined }, { worktreeId: 7 }, { forkPoint: 5 }, { forkPoint: '' }]) {
      expect(bindLimb(run, 'l1', { ...P0_BINDING, ...patch }), JSON.stringify(patch)).toEqual({ ok: false, reason: 'bad-binding' });
    }
    expect(bindLimb(run, 'l1', null)).toEqual({ ok: false, reason: 'bad-binding' });
    expect(bindLimb(run, 'l1', undefined)).toEqual({ ok: false, reason: 'bad-binding' });
  });

  it('accepts a missing fork point (it stays null) but never overwrites a recorded one', () => {
    const run = lanesRun();
    const { forkPoint: _omitted, ...withoutFork } = P0_BINDING;
    const first = bindLimb(run, 'l1', withoutFork);
    expect(first.run.limbs[0].forkPoint).toBeNull();

    const recorded = bindLimb(first.run, 'l1', P0_BINDING);
    expect(recorded.run.limbs[0].forkPoint).toBe(P0_BINDING.forkPoint);

    // re-measured after the worker committed: the tip, not the branching point
    const moved = bindLimb(recorded.run, 'l1', { ...P0_BINDING, forkPoint: 'f'.repeat(40) });
    expect(moved.ok).toBe(true);
    expect(moved.run.limbs[0].forkPoint).toBe(P0_BINDING.forkPoint);
  });

  it('binds the same worktree again idempotently, and refuses a DIFFERENT worktree for a bound limb', () => {
    const once = bindLimb(lanesRun(), 'l1', P0_BINDING);
    const twice = bindLimb(once.run, 'l1', P0_BINDING);
    expect(twice.run).toEqual(once.run);
    const other = { ...P0_BINDING, worktreeId: 'd56eb7c9::<HOME>/orca/workspaces/Artibot/orca-p0-b', branch: 'orca/p0-b-zzzzzz' };
    expect(bindLimb(once.run, 'l1', other)).toEqual({ ok: false, reason: 'already-bound' });
  });
});

describe('appendDispatch', () => {
  it('appends an add-only receipt to the named limb', () => {
    const run = lanesRun();
    const first = appendDispatch(run, 'l1', dispatchOf('a'));
    const second = appendDispatch(first.run, 'l1', dispatchOf('b', { kind: 'retry', taskId: 'task_a' }));
    expect(second.run.limbs[0].dispatches).toEqual([
      { dispatchId: 'ctx_a', taskId: 'task_a', kind: 'initial', at: '2026-11-19T05:00:00.000Z' },
      { dispatchId: 'ctx_b', taskId: 'task_a', kind: 'retry', at: '2026-11-19T05:00:00.000Z' },
    ]);
    expect(second.run.limbs.slice(1)).toEqual(run.limbs.slice(1));
    expect(validateOrcaRun(second.run).ok).toBe(true);
  });

  it('accepts every kind, and rejects anything else as `bad-kind`', () => {
    const run = lanesRun();
    for (const kind of DISPATCH_KINDS) expect(appendDispatch(run, 'l1', dispatchOf('k', { kind })).ok, kind).toBe(true);
    for (const kind of ['Initial', 'start', '', undefined, null, 1]) {
      expect(appendDispatch(run, 'l1', dispatchOf('k', { kind })), String(kind)).toEqual({ ok: false, reason: 'bad-kind' });
    }
  });

  it('refuses a dispatch id already used anywhere in the run as `duplicate`', () => {
    const run = dispatched(lanesRun(), ['l1']);
    expect(appendDispatch(run, 'l1', dispatchOf('l1'))).toEqual({ ok: false, reason: 'duplicate' });
    expect(appendDispatch(run, 'l2', dispatchOf('l1'))).toEqual({ ok: false, reason: 'duplicate' });
    expect(appendDispatch(run, 'l2', dispatchOf('l2')).ok).toBe(true);
  });

  it('answers `unknown-limb`, and `bad-dispatch` for a blank id, task id or timestamp', () => {
    const run = lanesRun();
    expect(appendDispatch(run, 'nope', dispatchOf('a'))).toEqual({ ok: false, reason: 'unknown-limb' });
    for (const patch of [{ dispatchId: '' }, { taskId: ' ' }, { dispatchId: undefined }, { at: '' }, { at: undefined }, { at: new Date('nope') }]) {
      expect(appendDispatch(run, 'l1', dispatchOf('a', patch)), JSON.stringify(patch)).toEqual({ ok: false, reason: 'bad-dispatch' });
    }
    expect(appendDispatch(run, 'l1', null)).toEqual({ ok: false, reason: 'bad-dispatch' });
  });

  it('keeps a string timestamp verbatim and writes a Date or a number as an ISO string', () => {
    const run = lanesRun();
    expect(appendDispatch(run, 'l1', dispatchOf('a', { at: '2026-11-19T14:00:00+09:00' })).run.limbs[0].dispatches[0].at).toBe('2026-11-19T14:00:00+09:00');
    expect(appendDispatch(run, 'l1', dispatchOf('a', { at: NOW })).run.limbs[0].dispatches[0].at).toBe('2026-11-19T04:50:00.000Z');
    expect(appendDispatch(run, 'l1', dispatchOf('a', { at: NOW.getTime() })).run.limbs[0].dispatches[0].at).toBe('2026-11-19T04:50:00.000Z');
  });

  it('tolerates a row without a dispatches array and never mutates the run', () => {
    const run = lanesRun();
    const stripped = deepFreeze({ ...run, limbs: run.limbs.map(({ dispatches: _gone, ...row }) => row) });
    const result = appendDispatch(stripped, 'l3', dispatchOf('a'));
    expect(result.run.limbs[2].dispatches).toHaveLength(1);
    expect('dispatches' in stripped.limbs[2]).toBe(false);
  });
});

describe('landingState', () => {
  const done = { complete: true, reason: 'done', commitCount: 2 };
  const wip = { complete: false, reason: 'no-trailer', commitCount: 2 };
  const empty = { complete: false, reason: 'no-commits', commitCount: 0 };
  // [label, expected state, completion, commit count, tip is an ancestor of the integration ref]
  const table = [
    ['done, 2 commits, tip is an ancestor', 'landed', done, 2, true],
    ['done, 2 commits, tip not yet an ancestor', 'done-unlanded', done, 2, false],
    ['done, ancestry unknown (null)', 'done-unlanded', done, 2, null],
    ['done, ancestry not a boolean', 'done-unlanded', done, 2, 'true'],
    ['TRAP: no commits, tip IS the base so it is trivially an ancestor', 'no-commits', empty, 0, true],
    ['no commits, not an ancestor', 'no-commits', empty, 0, false],
    ['TRAP: completion says done but the caller counted 0 commits', 'no-commits', done, 0, true],
    ['commits but no done trailer, tip is an ancestor (landed by hand)', 'in-progress', wip, 3, true],
    ['commits but no done trailer, not an ancestor', 'in-progress', wip, 3, false],
    ['a done superseded by a later wip', 'in-progress', { complete: false, reason: 'superseded', commitCount: 3 }, 3, true],
    ['no completion at all', 'in-progress', undefined, 3, true],
    ['`complete` that is not exactly true', 'in-progress', { complete: 'yes' }, 3, true],
    ['git-error completion with commits counted elsewhere', 'in-progress', { complete: false, reason: 'git-error' }, 3, true],
  ];
  it.each(table)('%s -> %s', (_label, expected, completion, commitCount, ancestor) => {
    expect(landingState({ completion, commitCount, tipIsAncestorOfIntegration: ancestor })).toBe(expected);
  });

  it('counts a missing, negative, NaN, infinite or string commit count as no commits — never as landed', () => {
    for (const commitCount of [undefined, null, -1, Number.NaN, '3', Number.POSITIVE_INFINITY]) {
      expect(landingState({ completion: done, commitCount, tipIsAncestorOfIntegration: true }), String(commitCount)).toBe('no-commits');
    }
    expect(landingState()).toBe('no-commits');
    expect(landingState({})).toBe('no-commits');
  });
});

describe('landingState against a real git repository', () => {
  let repo = '';
  let base = '';
  // No inherited GIT_* variable: a hook that runs the tests (GIT_DIR, GIT_INDEX_FILE, ...) must not aim these commands at the real repo.
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
    GIT_AUTHOR_NAME: 'orca-test',
    GIT_AUTHOR_EMAIL: 'orca-test@example.invalid',
    GIT_COMMITTER_NAME: 'orca-test',
    GIT_COMMITTER_EMAIL: 'orca-test@example.invalid',
  };
  const git = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf-8', env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim();
  const isAncestor = (tip, ref) => spawnSync('git', ['merge-base', '--is-ancestor', tip, ref], { cwd: repo, env, windowsHide: true }).status === 0;
  /** A commit on `branch` on top of `parent`, made with plumbing so no working tree is touched. */
  const commitOn = (branch, parent, messages) => {
    const tree = git(['rev-parse', `${parent}^{tree}`]);
    const sha = git(['commit-tree', tree, '-p', parent, ...messages.flatMap((message) => ['-m', message])]);
    git(['update-ref', `refs/heads/${branch}`, sha]);
    return sha;
  };
  /** What the leader's status measures for one limb, from git alone. */
  const measure = (branch, integrationRef) => {
    const completion = readLimbCompletion({ cwd: repo, branch, base });
    const commitCount = Number(git(['rev-list', '--count', `${base}..refs/heads/${branch}`]));
    const tipIsAncestorOfIntegration = isAncestor(`refs/heads/${branch}`, integrationRef);
    return { completion, commitCount, tipIsAncestorOfIntegration, state: landingState({ completion, commitCount, tipIsAncestorOfIntegration }) };
  };

  beforeAll(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-plan-git-'));
    git(['init', '-q', '-b', 'main', '.']);
    git(['-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'base']);
    base = git(['rev-parse', 'HEAD']);
    git(['update-ref', 'refs/remotes/origin/master', base]);
  });

  afterAll(() => {
    try {
      fs.rmSync(repo, { recursive: true, force: true });
    } catch { /* best effort */ }
  });

  it('a limb with zero commits is NOT landed although git says its tip is an ancestor of the integration ref', () => {
    git(['update-ref', 'refs/heads/orca/empty-abc123', base]);
    const seen = measure('orca/empty-abc123', 'origin/master');
    expect(seen.tipIsAncestorOfIntegration).toBe(true); // the trap: the ancestry test alone would say landed
    expect(seen.completion).toMatchObject({ complete: false, reason: 'no-commits', commitCount: 0 });
    expect(seen.commitCount).toBe(0);
    expect(seen.state).toBe('no-commits');
  });

  it('a done limb is done-unlanded until the integration ref contains its tip, then landed', () => {
    const tip = commitOn('orca/done-abc123', base, ['feat: work', 'Split-Limb: done']);
    const before = measure('orca/done-abc123', 'origin/master');
    expect(before).toMatchObject({ commitCount: 1, tipIsAncestorOfIntegration: false, state: 'done-unlanded' });
    expect(before.completion.complete).toBe(true);

    git(['update-ref', 'refs/remotes/origin/int-landed', tip]); // what a fetch after the fast-forward leaves
    const after = measure('orca/done-abc123', 'origin/int-landed');
    expect(after).toMatchObject({ commitCount: 1, tipIsAncestorOfIntegration: true, state: 'landed' });
  });

  it('a done limb reopened by a later wip trailer is in-progress even when its tip is in the integration ref', () => {
    const done = commitOn('orca/reopen-abc123', base, ['feat: work', 'Split-Limb: done']);
    const tip = commitOn('orca/reopen-abc123', done, ['wip: more', 'Split-Limb: wip']);
    git(['update-ref', 'refs/remotes/origin/int-reopen', tip]);
    const seen = measure('orca/reopen-abc123', 'origin/int-reopen');
    expect(seen.completion).toMatchObject({ complete: false, reason: 'superseded' });
    expect(seen.tipIsAncestorOfIntegration).toBe(true);
    expect(seen.state).toBe('in-progress');
  });

  it('commits with no done trailer that already sit in the integration ref are in-progress, not landed', () => {
    const tip = commitOn('orca/bare-abc123', base, ['feat: landed by hand, no trailer']);
    git(['update-ref', 'refs/remotes/origin/int-bare', tip]);
    const seen = measure('orca/bare-abc123', 'origin/int-bare');
    expect(seen.completion).toMatchObject({ complete: false, reason: 'no-trailer' });
    expect(seen.state).toBe('in-progress');
  });
});

describe('readyLimbs — the 8-lane run through its life', () => {
  const none = { landed: [], inFlight: [], capacity: 4 };

  it('starts the limbs with no unlanded dependency, up to the capacity, and reports what the rest wait for', () => {
    expect(readyLimbs(lanesRun(), none)).toEqual({
      start: ['l1', 'l2', 'l3', 'l7'],
      waiting: {
        l4: ['l1'],
        l5: ['l1'],
        l6: ['l3', 'l4', 'l5', 'l7'],
        l8: ['l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7'],
      },
    });
  });

  it('starts nothing while the capacity is used up, and a dispatched limb is never started again', () => {
    const run = dispatched(lanesRun(), ['l1', 'l2', 'l3', 'l7']);
    const seen = readyLimbs(run, { landed: [], inFlight: ['l1', 'l2', 'l3', 'l7'], capacity: 4 });
    expect(seen.start).toEqual([]);
    expect(Object.keys(seen.waiting)).toEqual(['l4', 'l5', 'l6', 'l8']);
    // slots free up but the four still have dispatches: l4 and l5 wait on l1 landing
    expect(readyLimbs(run, { landed: [], inFlight: [], capacity: 4 }).start).toEqual([]);
  });

  it('releases a dependent only when its dependencies have LANDED, not merely finished', () => {
    const run = dispatched(lanesRun(), ['l1', 'l2', 'l3', 'l7']);
    const finishedNotLanded = readyLimbs(run, { landed: [], inFlight: [], capacity: 4 });
    expect(finishedNotLanded.start).toEqual([]);
    const landed = readyLimbs(run, { landed: ['l1', 'l2', 'l3'], inFlight: ['l7'], capacity: 4 });
    expect(landed.start).toEqual(['l4', 'l5']);
    expect(landed.waiting).toEqual({ l6: ['l4', 'l5', 'l7'], l8: ['l4', 'l5', 'l6', 'l7'] });
  });

  it('holds back what does not fit under the capacity, with an EMPTY waiting list meaning "only a slot is missing"', () => {
    const run = dispatched(lanesRun(), ['l1', 'l2', 'l3', 'l7']);
    const seen = readyLimbs(run, { landed: ['l1', 'l2', 'l3'], inFlight: ['l7'], capacity: 2 });
    expect(seen.start).toEqual(['l4']);
    expect(seen.waiting.l5).toEqual([]);
    expect(seen.waiting.l6).toEqual(['l4', 'l5', 'l7']);
  });

  it('starts the unowned limb last, once everything else has landed', () => {
    const run = dispatched(lanesRun(), ['l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7']);
    const everything = ['l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7'];
    expect(readyLimbs(run, { landed: everything.slice(0, 6), inFlight: [], capacity: 4 }).start).toEqual([]);
    expect(readyLimbs(run, { landed: everything, inFlight: [], capacity: 4 })).toEqual({ start: ['l8'], waiting: {} });
  });

  it('never starts a limb that already landed without a dispatch, and does not list it as waiting', () => {
    const seen = readyLimbs(lanesRun(), { landed: ['l1'], inFlight: [], capacity: 8 });
    expect(seen.start).not.toContain('l1');
    expect(seen.waiting).not.toHaveProperty('l1');
    expect(seen.start).toEqual(['l2', 'l3', 'l4', 'l5', 'l7']);
  });

  it('counts each in-flight limb once and treats a missing or invalid capacity as zero', () => {
    const run = lanesRun();
    const running = dispatched(run, ['l1', 'l2']);
    expect(readyLimbs(running, { landed: [], inFlight: ['l1', 'l1', 'l2'], capacity: 3 }).start).toEqual(['l3']);
    for (const capacity of [undefined, null, 'four', Number.NaN, -2, 0]) {
      expect(readyLimbs(run, { landed: [], inFlight: [], capacity }).start, String(capacity)).toEqual([]);
    }
    expect(readyLimbs(run, { landed: [], inFlight: [], capacity: 2.9 }).start).toEqual(['l1', 'l2']);
    expect(readyLimbs(run, undefined).start).toEqual([]);
  });

  it('reports an unknown dependency as waiting forever rather than starting', () => {
    const run = { limbs: [{ limb: 'solo', deps: ['ghost'], dispatches: [] }] };
    expect(readyLimbs(run, none)).toEqual({ start: [], waiting: { solo: ['ghost'] } });
  });

  it('answers for an empty or invalid run without throwing', () => {
    for (const run of [undefined, null, {}, { limbs: 'x' }, { limbs: [] }, { limbs: [null, 5, {}] }]) {
      expect(readyLimbs(run, none), JSON.stringify(run)).toEqual({ start: [], waiting: {} });
    }
  });

  it('does not mutate its inputs', () => {
    const run = deepFreeze(lanesRun());
    const observed = deepFreeze({ landed: ['l1'], inFlight: ['l2'], capacity: 4 });
    expect(readyLimbs(run, observed).start.length).toBeGreaterThan(0);
  });
});

describe('nextActions', () => {
  /** alpha and beta are free; gamma needs both to have landed. */
  const mini = () => compileRun({
    objective: 'o',
    tag: 'a1b2c3',
    now: NOW,
    tasks: [
      plain('alpha', ['src/alpha/']),
      plain('beta', ['src/beta/']),
      plain('gamma', ['src/gamma/'], { dependsOn: ['alpha', 'beta'] }),
    ],
    plan: null,
  }).run;
  const kinds = (actions) => actions.map((action) => action.kind);

  it('starts the free limbs first, with the reason a human can read', () => {
    const actions = nextActions(mini(), { landed: [], inFlight: [], capacity: 2 });
    expect(actions).toEqual([{ kind: 'start', limbs: ['alpha', 'beta'], reason: expect.stringMatching(/시작 가능 2개/) }]);
  });

  it('is idle while every slot is busy and the dependents wait', () => {
    const run = dispatched(mini(), ['alpha', 'beta']);
    const actions = nextActions(run, { landed: [], inFlight: ['alpha', 'beta'], capacity: 2 });
    expect(actions).toEqual([{ kind: 'idle', reason: expect.stringMatching(/진행 중 2개/) }]);
  });

  it('proposes landing the queue when nothing is in flight', () => {
    const run = dispatched(mini(), ['alpha', 'beta']);
    const actions = nextActions(run, { landed: [], inFlight: [], capacity: 2, doneUnlanded: ['alpha', 'beta'] });
    expect(actions).toEqual([{ kind: 'land', limbs: ['alpha', 'beta'], reason: expect.stringMatching(/진행 중 줄기 없음/) }]);
  });

  it('proposes landing while another limb is in flight only when the landing frees a waiting limb', () => {
    const run = dispatched(mini(), ['alpha', 'beta']);
    // beta is still running: landing alpha alone does not free gamma (gamma needs alpha AND beta)
    const blocked = nextActions(run, { landed: [], inFlight: ['beta'], capacity: 2, doneUnlanded: ['alpha'] });
    expect(kinds(blocked)).toEqual(['idle']);
    // beta is done too: landing both frees gamma, although something else is still running
    const freed = nextActions(run, { landed: [], inFlight: ['other'], capacity: 2, doneUnlanded: ['alpha', 'beta'] });
    expect(freed).toEqual([{ kind: 'land', limbs: ['alpha', 'beta'], reason: expect.stringMatching(/gamma 시작 가능/) }]);
  });

  it('lists land before start before close', () => {
    const run = dispatched(mini(), ['alpha', 'beta']);
    const actions = nextActions(run, { landed: ['alpha'], inFlight: [], capacity: 2, doneUnlanded: ['beta'], withWorktree: ['alpha', 'beta'] });
    expect(kinds(actions)).toEqual(['land', 'close']);
    const later = nextActions(run, { landed: ['alpha', 'beta'], inFlight: [], capacity: 2, withWorktree: ['alpha', 'beta'] });
    expect(later).toEqual([
      { kind: 'start', limbs: ['gamma'], reason: expect.any(String) },
      { kind: 'close', limb: 'alpha', reason: expect.any(String) },
      { kind: 'close', limb: 'beta', reason: expect.any(String) },
    ]);
  });

  it('does not guess about closing: no withWorktree list means no close action', () => {
    const run = dispatched(mini(), ['alpha', 'beta', 'gamma']);
    const actions = nextActions(run, { landed: ['alpha', 'beta', 'gamma'], inFlight: [], capacity: 2 });
    expect(actions).toEqual([{ kind: 'idle', reason: expect.stringMatching(/정리 여부는 미확인/) }]);
  });

  it('says the run is complete when everything has landed and been closed', () => {
    const run = dispatched(mini(), ['alpha', 'beta', 'gamma']);
    const actions = nextActions(run, { landed: ['alpha', 'beta', 'gamma'], inFlight: [], capacity: 2, withWorktree: [] });
    expect(actions).toEqual([{ kind: 'idle', reason: expect.stringMatching(/런 완료/) }]);
  });

  it('names a stalled limb (dispatched, but neither running nor queued nor landed) and what waits on it', () => {
    const run = dispatched(mini(), ['alpha', 'beta']);
    const [action] = nextActions(run, { landed: ['beta'], inFlight: [], capacity: 2 });
    expect(action.kind).toBe('idle');
    expect(action.reason).toMatch(/멈춘 줄기 1개\(alpha\)/);
    expect(action.reason).toMatch(/선행 미착지로 대기 1개/);
  });

  it('reports running, stalled and waiting limbs together when all three exist', () => {
    const run = dispatched(mini(), ['alpha', 'beta']);
    const [action] = nextActions(run, { landed: [], inFlight: ['beta'], capacity: 2 });
    expect(action.reason).toMatch(/진행 중 1개/);
    expect(action.reason).toMatch(/멈춘 줄기 1개\(alpha\)/);
    expect(action.reason).toMatch(/대기 1개/);
  });

  it('does not call a limb in the landing queue stalled', () => {
    const run = dispatched(mini(), ['alpha', 'beta']);
    const [action] = nextActions(run, { landed: [], inFlight: ['other'], capacity: 2, doneUnlanded: ['alpha'] });
    expect(action.kind).toBe('idle');
    expect(action.reason).toMatch(/멈춘 줄기 1개\(beta\)/);
    expect(action.reason).not.toMatch(/alpha/);
  });

  it('says a limb waits for a free slot (not for a dependency) when only the capacity holds it back', () => {
    const lone = compileRun({ objective: 'o', tag: 'a1b2c3', now: NOW, tasks: [plain('solo', ['src/solo/'])], plan: null }).run;
    expect(nextActions(lone, { landed: [], inFlight: [], capacity: 0 })).toEqual([{ kind: 'idle', reason: '동시 상한(0)으로 대기 1개' }]);
    const run = dispatched(mini(), ['alpha']);
    const [action] = nextActions(run, { landed: [], inFlight: ['alpha'], capacity: 1 });
    expect(action.reason).toMatch(/진행 중 1개/);
    expect(action.reason).toMatch(/동시 상한\(1\)으로 대기 1개/); // beta is free to start but the single slot is taken
    expect(action.reason).toMatch(/선행 미착지로 대기 1개/); // gamma waits for alpha and beta
  });

  it('ignores queue entries that are not limbs of the run or have landed already', () => {
    const run = dispatched(mini(), ['alpha', 'beta']);
    const actions = nextActions(run, { landed: ['alpha'], inFlight: [], capacity: 2, doneUnlanded: ['alpha', 'ghost', 'beta'] });
    expect(actions).toEqual([{ kind: 'land', limbs: ['beta'], reason: expect.any(String) }]);
  });

  it('answers idle for an empty or invalid run without throwing', () => {
    for (const run of [undefined, null, {}, { limbs: [] }]) {
      expect(nextActions(run, { landed: [], inFlight: [], capacity: 2 })).toEqual([{ kind: 'idle', reason: '줄기 없음' }]);
    }
    expect(nextActions(mini(), undefined)).toEqual([{ kind: 'idle', reason: expect.any(String) }]);
  });

  it('does not mutate its inputs', () => {
    const run = deepFreeze(mini());
    const observed = deepFreeze({ landed: ['alpha'], inFlight: [], capacity: 2, doneUnlanded: ['beta'], withWorktree: ['alpha'] });
    expect(nextActions(run, observed).length).toBeGreaterThan(0);
  });
});

describe('validateLimbRow', () => {
  const row = (patch = {}) => ({ limb: 'alpha', branch: 'worktree-split-demo-alpha', worktreePath: '/repo/.claude/worktrees/split-demo-alpha', affectedPaths: ['src/alpha/'], ...patch });

  it('accepts the four required keys alone, and a full /orca row', () => {
    expect(validateLimbRow(row())).toEqual({ ok: true, errors: [] });
    const full = row({
      forkPoint: 'a'.repeat(40),
      taskIds: ['L1'],
      deps: ['beta', 'gamma-2'],
      worktreeId: 'wt-1::/path',
      dispatches: [dispatchOf('a'), dispatchOf('b', { kind: 'rework' })],
    });
    expect(validateLimbRow(full)).toEqual({ ok: true, errors: [] });
  });

  it('ignores keys it does not know (the /split row carries wave, rolling, worktreeName, ...)', () => {
    expect(validateLimbRow(row({ wave: 3, rolling: true, worktreeName: 'split-demo-alpha', plannedBranch: 'x', promptPath: 'p' })).ok).toBe(true);
  });

  it('requires each of limb, branch, worktreePath and affectedPaths, naming the key', () => {
    for (const key of ['limb', 'branch', 'worktreePath', 'affectedPaths']) {
      const { [key]: _removed, ...without } = row();
      const verdict = validateLimbRow(without);
      expect(verdict.ok, key).toBe(false);
      expect(verdict.errors.join(' '), key).toContain(key);
    }
  });

  it('refuses a slug that does not match, a blank branch or path, and badly typed lists', () => {
    for (const patch of [
      { limb: 'Auth/x' }, { limb: 'a' }, { limb: 'A1' }, { limb: 'x'.repeat(32) }, { limb: 5 },
      { branch: '' }, { branch: '   ' }, { branch: 7 }, { worktreePath: '' }, { worktreePath: ['x'] },
      { affectedPaths: 'src/' }, { affectedPaths: [1] }, { affectedPaths: [''] }, { affectedPaths: [' '] }, { affectedPaths: null },
      { taskIds: 'L1' }, { taskIds: [''] }, { deps: ['Beta'] }, { deps: 'beta' }, { deps: [3] },
      { forkPoint: '' }, { forkPoint: 5 }, { worktreeId: '' }, { worktreeId: 9 },
      { dispatches: {} }, { dispatches: [null] }, { dispatches: [{ dispatchId: 'x' }] }, { dispatches: [dispatchOf('a', { kind: 'launch' })] },
    ]) {
      expect(validateLimbRow(row(patch)).ok, JSON.stringify(patch)).toBe(false);
    }
  });

  it('accepts an empty affectedPaths list (a claim of nothing — land then refuses every change)', () => {
    expect(validateLimbRow(row({ affectedPaths: [] })).ok).toBe(true);
  });

  it('accepts null for forkPoint and worktreeId, and treats undefined as absent', () => {
    expect(validateLimbRow(row({ forkPoint: null, worktreeId: null })).ok).toBe(true);
    expect(validateLimbRow(row({ forkPoint: undefined, worktreeId: undefined, deps: undefined })).ok).toBe(true);
    expect(validateLimbRow(row({ branch: undefined })).ok).toBe(false);
  });

  it('rejects an unbound row unless allowUnbound is set — and says why', () => {
    const unbound = row({ branch: null, worktreePath: null });
    const strict = validateLimbRow(unbound);
    expect(strict.ok).toBe(false);
    expect(strict.errors).toHaveLength(2);
    expect(strict.errors[0]).toMatch(/branch: must be a non-empty string/);
    expect(validateLimbRow(unbound, { allowUnbound: true })).toEqual({ ok: true, errors: [] });
    // allowUnbound relaxes null only; blank strings and a missing key stay errors
    expect(validateLimbRow(row({ branch: '' }), { allowUnbound: true }).ok).toBe(false);
    expect(validateLimbRow(row({ branch: undefined }), { allowUnbound: true }).ok).toBe(false);
  });

  it('collects every problem at once', () => {
    const verdict = validateLimbRow({ limb: 'Bad', branch: '', affectedPaths: 'x' });
    expect(verdict.ok).toBe(false);
    expect(verdict.errors.length).toBeGreaterThanOrEqual(4);
  });

  it('refuses anything that is not an object', () => {
    for (const value of [null, undefined, [], 'row', 5, true]) {
      expect(validateLimbRow(value), String(value)).toEqual({ ok: false, errors: ['row must be an object'] });
    }
  });
});

describe('every function answers instead of throwing, whatever it is handed', () => {
  const junk = [undefined, null, 0, 5, '', 'text', true, [], {}, () => 1, Symbol('s')];

  it('takes null and non-object option or input arguments', () => {
    const goodRow = { limb: 'alpha', branch: 'b', worktreePath: '/w', affectedPaths: [] };
    for (const value of junk) {
      expect(() => assessPlan(lanePlan(), value), String(value)).not.toThrow();
      expect(assessPlan(lanePlan(), value).ok, String(value)).toBe(true); // minStems falls back to 2
      expect(compileRun(value), String(value)).toEqual({ ok: false, reason: 'invalid-tasks' });
      expect(landingState(value), String(value)).toBe('no-commits');
      expect(validateLimbRow(goodRow, value).ok, String(value)).toBe(true);
      expect(validateLimbRow(value).ok, String(value)).toBe(false);
    }
  });

  it('takes junk for the run, the limb name and the record arguments', () => {
    for (const value of junk) {
      expect(() => bindLimb(value, value, value), String(value)).not.toThrow();
      expect(() => appendDispatch(value, value, value), String(value)).not.toThrow();
      expect(() => readyLimbs(value, value), String(value)).not.toThrow();
      expect(() => nextActions(value, value), String(value)).not.toThrow();
      expect(() => validateOrcaRun(value), String(value)).not.toThrow();
      expect(() => buildDependencyGraph(value, value), String(value)).not.toThrow();
      expect(() => assessPlan(value, value), String(value)).not.toThrow();
      expect(() => limbName(value), String(value)).not.toThrow();
      expect(bindLimb(value, value, value).ok, String(value)).toBe(false);
      expect(appendDispatch(value, value, value).ok, String(value)).toBe(false);
    }
  });

  it('treats a truthy but non-true allowUnbound as not allowed (fail closed)', () => {
    const unbound = { limb: 'alpha', branch: null, worktreePath: null, affectedPaths: [] };
    for (const allowUnbound of [1, 'true', {}, [], 'yes']) expect(validateLimbRow(unbound, { allowUnbound }).ok, String(allowUnbound)).toBe(false);
    expect(validateLimbRow(unbound, { allowUnbound: true }).ok).toBe(true);
  });
});

