/**
 * Tests for the safe, bounded --fast fan-out planner.
 */

import { describe, expect, it } from 'vitest';
import {
  areAffectedPathsConflicting,
  buildFastFanoutPlan,
  FAST_PROFILE_DEFAULTS,
  normalizeFastProfile,
} from '../../lib/autopilot/fast-profile.js';
import { buildFastFanoutPlan as buildFromPublicApi } from '../../lib/autopilot/index.js';

/**
 * True when two task ids land in the same wave — i.e. would run concurrently.
 * @param {{waves: Array<{taskIds: string[]}>}} plan
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function coLocated(plan, a, b) {
  return plan.waves.some((wave) => wave.taskIds.includes(a) && wave.taskIds.includes(b));
}

function task(id, affectedPaths, overrides = {}) {
  return {
    id,
    independent: true,
    affectedPaths,
    risk: 'low',
    worktreeEligible: true,
    ...overrides,
  };
}

describe('normalizeFastProfile', () => {
  it('clamps operator overrides to immutable safety caps', () => {
    const profile = normalizeFastProfile({
      hardMaxAgents: 99,
      agentsPerCpu: 99,
      maxWorktrees: 99,
      maxRisk: 'critical',
    });

    expect(profile.hardMaxAgents).toBe(FAST_PROFILE_DEFAULTS.hardMaxAgents);
    expect(profile.agentsPerCpu).toBe(FAST_PROFILE_DEFAULTS.agentsPerCpu * 2);
    expect(profile.maxWorktrees).toBe(FAST_PROFILE_DEFAULTS.maxWorktrees);
    expect(profile.maxRisk).toBe('medium');
  });
});

describe('autopilot public API', () => {
  it('re-exports the boolean fast plan API from the autopilot barrel', () => {
    expect(buildFromPublicApi).toBe(buildFastFanoutPlan);
  });
});

describe('areAffectedPathsConflicting', () => {
  it('normalizes slash and case, then treats exact paths and ancestors as conflicts', () => {
    expect(areAffectedPathsConflicting(['src/api'], ['src/api/routes.js'])).toBe(true);
    expect(areAffectedPathsConflicting(['SRC\\API\\Client.js'], ['src/api/client.js'])).toBe(true);
    expect(areAffectedPathsConflicting(['./src//ui'], ['src/ui/app.js'])).toBe(true);
    expect(areAffectedPathsConflicting(['src/ui'], ['src/api/routes.js'])).toBe(false);
  });

  it('collapses standard and unsupported glob syntax to a conservative common root', () => {
    expect(areAffectedPathsConflicting(['src/**/*.js'], ['src/api/routes.js'])).toBe(true);
    expect(areAffectedPathsConflicting(['src/a?'], ['src/ab'])).toBe(true);
    expect(areAffectedPathsConflicting(['src/[ab].js'], ['src/a.js'])).toBe(true);
    expect(areAffectedPathsConflicting(['src/{api,ui}/index.js'], ['src/ui/app.js'])).toBe(true);
    expect(areAffectedPathsConflicting(['src/@(api|ui)/index.js'], ['src/api/app.js'])).toBe(true);
    expect(areAffectedPathsConflicting(['src/+(api)/index.js'], ['src/other.js'])).toBe(true);
  });
});

describe('buildFastFanoutPlan', () => {
  it('falls back to standard serial execution unless fast is explicitly requested', () => {
    const plan = buildFastFanoutPlan({
      tasks: [task('api', ['src/api.js']), task('ui', ['src/ui.js'])],
      cpuCount: 8,
    });

    expect(plan.profile).toBe('standard');
    expect(plan.fallbackReason).toBe('fast-not-requested');
    expect(plan.plannedParallelism).toBe(1);
    expect(plan.estimatedSpeedup).toBe(1);
    expect(plan.serial.map((entry) => entry.taskId)).toEqual(['api', 'ui']);
  });

  it('uses CPU, hard, worktree, and task-count caps for safe fan-out', () => {
    const plan = buildFastFanoutPlan({
      fast: true,
      cpuCount: 2,
      limits: { hardMaxAgents: 16, agentsPerCpu: 2, maxWorktrees: 3 },
      tasks: [
        task('one', ['src/one.js']),
        task('two', ['src/two.js']),
        task('three', ['src/three.js']),
        task('four', ['src/four.js']),
        task('five', ['src/five.js']),
      ],
    });

    expect(plan.profile).toBe('fast');
    expect(plan.eligibleParallelism).toBe(3);
    expect(plan.plannedParallelism).toBe(3);
    expect(plan.worktrees).toEqual({ required: true, count: 3 });
    expect(plan.waves.map((wave) => wave.taskIds)).toEqual([
      ['one', 'two', 'three'],
      ['four', 'five'],
    ]);
    expect(plan.estimatedSpeedup).toBe(2.5);
  });

  it('serializes path-conflict groups while retaining unrelated parallel work', () => {
    const plan = buildFastFanoutPlan({
      fast: true,
      cpuCount: 8,
      tasks: [
        task('api-client', ['src/api/client.js']),
        task('api-routes', ['src/api']),
        task('ui', ['src/ui/app.js']),
      ],
    });

    expect(plan.waves.map((wave) => wave.taskIds)).toEqual([
      ['api-client', 'ui'],
      ['api-routes'],
    ]);
    expect(plan.conflictGroups).toEqual([
      { id: 'conflict-1', taskIds: ['api-client', 'api-routes'] },
    ]);
  });

  it('keeps unproven, risky, and non-isolated work out of fast waves', () => {
    const plan = buildFastFanoutPlan({
      fast: true,
      cpuCount: 8,
      tasks: [
        task('safe-one', ['src/one.js']),
        task('safe-two', ['src/two.js']),
        task('dependent', ['src/three.js'], { independent: false }),
        task('risky', ['src/four.js'], { risk: 'high' }),
        task('shared-tree', ['src/five.js'], { worktreeEligible: false }),
      ],
    });

    expect(plan.waves).toEqual([{ taskIds: ['safe-one', 'safe-two'], worktreeCount: 2 }]);
    expect(plan.serial).toEqual([
      { taskId: 'dependent', reason: 'not-independent' },
      { taskId: 'risky', reason: 'risk-high' },
      { taskId: 'shared-tree', reason: 'worktree-ineligible' },
    ]);
  });

  it('rejects absolute, drive, UNC, home, and traversal paths from fast waves', () => {
    const plan = buildFastFanoutPlan({
      fast: true,
      cpuCount: 8,
      tasks: [
        task('safe-one', ['src/one.js']),
        task('safe-two', ['src/two.js']),
        task('absolute', ['/etc/passwd']),
        task('drive', ['C:\\secrets\\token.txt']),
        task('unc', ['\\\\server\\share\\file.js']),
        task('home', ['~/secret.txt']),
        task('traversal', ['src/../../secret.txt']),
      ],
    });

    expect(plan.profile).toBe('fast');
    expect(plan.serial).toEqual([
      { taskId: 'absolute', reason: 'unsafe-affected-path' },
      { taskId: 'drive', reason: 'unsafe-affected-path' },
      { taskId: 'unc', reason: 'unsafe-affected-path' },
      { taskId: 'home', reason: 'unsafe-affected-path' },
      { taskId: 'traversal', reason: 'unsafe-affected-path' },
    ]);
  });

  it('serializes tasks whose affectedPaths contain unparseable non-string entries', () => {
    // Negative control first, measured rather than assumed: with the SAME
    // shared file spelled as a string the planner does NOT serialize — it
    // splits the pair across waves (`[alpha,gamma,delta]`, `[beta]`, serial
    // empty). So the invariant to hold is "never in one wave together", which
    // is what actually prevents two workers editing src/shared.js at once.
    const stringly = buildFastFanoutPlan({
      fast: true,
      cpuCount: 8,
      tasks: [
        task('alpha', ['src/shared.js']),
        task('beta', ['src/shared.js']),
        task('gamma', ['src/gamma.js']),
        task('delta', ['src/delta.js']),
      ],
    });
    expect(coLocated(stringly, 'alpha', 'beta')).toBe(false);

    // Now the same collision hidden behind shapes the parser cannot read.
    //
    // The arrays are MIXED on purpose: each task keeps one readable, private
    // path and hides the shared file in an unreadable entry. An all-unreadable
    // array would leave `paths` empty and serialize safely via
    // `missing-affected-paths` — it never reaches the failure region. The
    // mixed shape is the one the bug lived in: the unreadable entry vanished,
    // each task kept an understated (and non-overlapping) path set, no
    // conflict was detected, and both landed in the SAME wave — two workers
    // editing src/shared.js concurrently. Verified against the pre-fix code:
    // with `unsafe:false` restored, `coLocated(shaped,'alpha','beta')` is true.
    const shaped = buildFastFanoutPlan({
      fast: true,
      cpuCount: 8,
      tasks: [
        task('alpha', ['src/alpha.js', { glob: 'src/shared.js' }]),
        task('beta', ['src/beta.js', { glob: 'src/shared.js' }]),
        task('gamma', ['src/gamma.js']),
        task('delta', ['src/delta.js']),
      ],
    });

    const reasons = new Map(shaped.serial.map((entry) => [entry.taskId, entry.reason]));
    expect(reasons.get('alpha')).toBe('unsafe-affected-path');
    expect(reasons.get('beta')).toBe('unsafe-affected-path');
    // The invariant, same as the string spelling above.
    expect(coLocated(shaped, 'alpha', 'beta')).toBe(false);
    // Stronger than the string case: unparseable ownership leaves the waves
    // entirely, so neither can share a wave with ANY task.
    for (const wave of shaped.waves) {
      expect(wave.taskIds).not.toContain('alpha');
      expect(wave.taskIds).not.toContain('beta');
    }
    // Well-formed siblings are untouched — this narrows ownership, it does not
    // poison the whole plan.
    expect(shaped.waves.flatMap((wave) => wave.taskIds).sort()).toEqual(['delta', 'gamma']);
  });

  it('treats a blank-string affectedPath as unparseable, not as absent', () => {
    const plan = buildFastFanoutPlan({
      fast: true,
      cpuCount: 8,
      tasks: [
        task('blank', ['   ']),
        task('ok-one', ['src/one.js']),
        task('ok-two', ['src/two.js']),
      ],
    });
    expect(plan.serial).toEqual(expect.arrayContaining([
      { taskId: 'blank', reason: 'unsafe-affected-path' },
    ]));
  });

  it('still reports an all-absent affectedPaths list as missing, not unsafe', () => {
    // null/undefined are absence, not corruption: they shrink no ownership
    // claim, so the pre-existing `missing-affected-paths` reason must survive.
    const plan = buildFastFanoutPlan({
      fast: true,
      cpuCount: 8,
      tasks: [
        task('empty', [null, undefined]),
        task('ok-one', ['src/one.js']),
        task('ok-two', ['src/two.js']),
      ],
    });
    expect(plan.serial).toEqual(expect.arrayContaining([
      { taskId: 'empty', reason: 'missing-affected-paths' },
    ]));
  });

  it('builds topological waves while maximizing independent work in each wave', () => {
    const plan = buildFastFanoutPlan({
      fast: true,
      cpuCount: 8,
      tasks: [
        task('setup', ['src/setup.js']),
        task('docs', ['docs/readme.md']),
        task('api', ['src/api.js'], { dependsOn: ['setup'] }),
        task('ui', ['src/ui.js'], { dependencies: ['setup'] }),
        task('verify', ['tests/all.test.js'], { dependsOn: ['api', 'ui'] }),
      ],
    });

    expect(plan.waves).toEqual([
      { taskIds: ['setup', 'docs'], worktreeCount: 2 },
      { taskIds: ['api', 'ui'], worktreeCount: 2 },
      { taskIds: ['verify'], worktreeCount: 1 },
    ]);
    expect(plan.serial).toEqual([]);
  });

  it('serializes malformed dependency metadata instead of guessing independence', () => {
    const plan = buildFastFanoutPlan({
      fast: true,
      cpuCount: 8,
      tasks: [
        task('setup', ['src/setup.js']),
        task('api', ['src/api.js'], { dependsOn: [42] }),
        task('ui', ['src/ui.js']),
      ],
    });

    expect(plan.waves).toEqual([
      { taskIds: ['setup', 'ui'], worktreeCount: 2 },
    ]);
    expect(plan.serial).toEqual([
      { taskId: 'api', reason: 'unresolved-dependency' },
    ]);
  });

  it('mixes newly-unlocked tasks with pending roots when conflicts allow', () => {
    const plan = buildFastFanoutPlan({
      fast: true,
      cpuCount: 8,
      tasks: [
        task('root-a', ['src/shared']),
        task('root-b', ['src/shared']),
        task('after-a', ['src/after-a.js'], { dependsOn: ['root-a'] }),
      ],
    });

    expect(plan.waves.map((wave) => wave.taskIds)).toEqual([
      ['root-a'],
      ['root-b', 'after-a'],
    ]);
  });

  it('serializes missing IDs, unresolved dependencies, cycles, duplicates, and blocked descendants', () => {
    const plan = buildFastFanoutPlan({
      fast: true,
      cpuCount: 8,
      tasks: [
        task('safe-one', ['src/one.js']),
        task('safe-two', ['src/two.js']),
        task(undefined, ['src/missing.js']),
        task('unresolved', ['src/unresolved.js'], { dependsOn: ['ghost'] }),
        task('cycle-a', ['src/cycle-a.js'], { dependsOn: ['cycle-b'] }),
        task('cycle-b', ['src/cycle-b.js'], { dependsOn: ['cycle-a'] }),
        task('duplicate', ['src/dup-a.js']),
        task('duplicate', ['src/dup-b.js']),
        task('unsafe-parent', ['src/unsafe.js'], { risk: 'high' }),
        task('blocked-child', ['src/blocked.js'], { dependsOn: ['unsafe-parent'] }),
      ],
    });

    expect(plan.waves).toEqual([{ taskIds: ['safe-one', 'safe-two'], worktreeCount: 2 }]);
    expect(plan.serial).toEqual([
      { taskId: 'task-3', reason: 'missing-id' },
      { taskId: 'unresolved', reason: 'unresolved-dependency' },
      { taskId: 'cycle-a', reason: 'dependency-cycle' },
      { taskId: 'cycle-b', reason: 'dependency-cycle' },
      { taskId: 'duplicate', reason: 'duplicate-id' },
      { taskId: 'duplicate', reason: 'duplicate-id' },
      { taskId: 'unsafe-parent', reason: 'risk-high' },
      { taskId: 'blocked-child', reason: 'dependency-not-fast' },
    ]);
  });

  it('falls back when path conflicts leave no safe concurrent pair', () => {
    const plan = buildFastFanoutPlan({
      fast: true,
      tasks: [task('one', ['src/api']), task('two', ['src/api/routes.js'])],
    });

    expect(plan.profile).toBe('standard');
    expect(plan.fallbackReason).toBe('no-safe-parallelism');
    expect(plan.serial).toEqual([
      { taskId: 'one', reason: 'conflict-serialized' },
      { taskId: 'two', reason: 'conflict-serialized' },
    ]);
  });
});
