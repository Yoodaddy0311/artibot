/**
 * Tests for the `--fast` execution planner's opt-in objective attachment
 * (CA-12, Canary stage: one config key turns it on, the same key turns it off).
 *
 * ── What these tests protect ────────────────────────────────────────────────
 *  1. OFF is byte-identical to the pre-CA-12 shape. Not `objective: null` —
 *     the key must be absent, so a deep-equal or a JSON diff against a
 *     recorded plan stays clean.
 *  2. The objective is METADATA. Turning it on may not move a single
 *     scheduling field (waves, parallelism, worktrees, caps).
 *  3. The token is read from `lib/routing/execution-profile.js`, never spelled
 *     here. `wallclock_throughput` is the `/split` token and is UNATTESTED
 *     (owner decision G6: no new consumers), so it must not reach a `--fast`
 *     plan from any input.
 *
 * ── What these tests do NOT see ─────────────────────────────────────────────
 *  - Whether the engine actually forwards the block to a worker. These tests
 *    call the planner directly; `engine.js` wiring is out of scope here.
 *  - Whether a real `artibot.config.json` carries `applyObjective`. No test
 *    here reads the shipped config — limits are always injected.
 *  - Whether a router downstream honours the directives. The block is a
 *    record of intent; nothing in this module enforces it.
 */

import { describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import nodePath from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildFastTeamInstruction,
  demoteFastToStandard,
  planFastExecution,
} from '../../lib/autopilot/fast-execution.js';
import { executionProfile } from '../../lib/routing/execution-profile.js';

const LIB_DIR = nodePath.join(
  nodePath.dirname(fileURLToPath(import.meta.url)), '..', '..', 'lib', 'autopilot',
);
const SPLIT_OBJECTIVE_TOKEN = ['wallclock', 'throughput'].join('_');
const ON = Object.freeze({ applyObjective: true });

/**
 * The plan key set as of base d1957c8f, IN ORDER — an independent literal, not
 * a second call to the code under test. Comparing an on-plan to an off-plan
 * only proves the two agree; it stays green if a new key is added to BOTH.
 *
 * Derived by reading `buildFastFanoutPlan`'s two returns (`fast-profile.js`:
 * the enabled literal and `standardPlan`, which spell the same thirteen keys
 * in the same order) and then `planFastExecution`'s spread-and-override,
 * which appends `cpuCount`, `requested`, `requestedParallelism`,
 * `serialReasons` and `reused` while `serial` and `fallbackReason` keep their
 * original positions. Both plan flavours therefore carry one identical list.
 */
const BASE_PLAN_KEYS = Object.freeze([
  'profile', 'enabled', 'fallbackReason', 'limits', 'requestedTaskCount',
  'eligibleTaskCount', 'eligibleParallelism', 'plannedParallelism',
  'estimatedSpeedup', 'worktrees', 'waves', 'serial', 'conflictGroups',
  'cpuCount', 'requested', 'requestedParallelism', 'serialReasons', 'reused',
]);

const BASE_INSTRUCTION_KEYS = Object.freeze([
  'type', 'phase', 'sessionId', 'nextPhase', 'fast', 'instructions', 'teamHint',
]);

const BASE_TEAM_HINT_KEYS = Object.freeze([
  'parallel', 'leadAgent', 'profile', 'plannedParallelism', 'eligibleParallelism',
  'worktreeCount', 'conflictIsolation', 'waves',
]);

function task(id, affectedPaths, overrides = {}) {
  return { id, independent: true, affectedPaths, risk: 'low', worktreeEligible: true, ...overrides };
}

function fastState(options = {}, tasks = [task('t1', ['src/alpha']), task('t2', ['src/beta'])]) {
  return { sessionId: 'sess-ca12', options: { fast: true, ...options }, fastTasks: tasks };
}

function plan(state, limits = {}) {
  return planFastExecution(state, 'team-create', limits, { cpuCount: 4 });
}

function withoutObjective(value) {
  const copy = { ...value };
  delete copy.objective;
  return copy;
}

/** Re-import the planner with a stubbed profile compiler, then restore. */
async function planWithStubbedProfile(impl, limits = ON) {
  vi.resetModules();
  vi.doMock('../../lib/routing/execution-profile.js', () => ({
    executionProfile: impl, default: impl,
  }));
  try {
    const mod = await import('../../lib/autopilot/fast-execution.js');
    return mod.planFastExecution(fastState(), 'team-create', limits, { cpuCount: 4 });
  } finally {
    vi.doUnmock('../../lib/routing/execution-profile.js');
    vi.resetModules();
  }
}

describe('planFastExecution — objective attachment is off by default', () => {
  it('emits exactly the base key list, in order, for an enabled plan', () => {
    const result = plan(fastState());
    expect(result.enabled).toBe(true);
    expect(Object.keys(result)).toEqual([...BASE_PLAN_KEYS]);
  });

  it('emits exactly the base key list, in order, for a standard fallback', () => {
    const fallback = plan(fastState({}, [task('only', ['src/alpha'])]));
    expect(fallback.profile).toBe('standard');
    expect(Object.keys(fallback)).toEqual([...BASE_PLAN_KEYS]);
  });

  it.each([
    ['string true', 'true'],
    ['number one', 1],
    ['truthy object', {}],
    ['false', false],
    ['null', null],
  ])('treats a non-boolean-true flag (%s) as off', (_label, value) => {
    expect(Object.hasOwn(plan(fastState(), { applyObjective: value }), 'objective')).toBe(false);
  });

  it('produces a plan deep-equal to the on-plan once the objective is removed', () => {
    const off = plan(fastState());
    const on = plan(fastState(), ON);
    expect(withoutObjective(on)).toEqual(off);
    expect(JSON.stringify(withoutObjective(on))).toBe(JSON.stringify(off));
  });
});

describe('planFastExecution — the objective block when on', () => {
  it('copies token, reason, directives and source from the profile compiler', () => {
    const compiled = executionProfile({ flags: { fast: true } });
    const { objective } = plan(fastState(), ON);

    expect(objective.token).toBe(compiled.objective);
    expect(objective.token).toBe('time_to_verified_outcome');
    expect(objective.reason).toBe(compiled.objective_reason);
    expect(objective.source).toBe(compiled.source);
    expect(objective.directives).toEqual({ ...compiled.directives });
    expect(objective.applied).toBe(true);
  });

  it('hands over a mutable copy rather than the compiler frozen directives', () => {
    const compiled = executionProfile({ flags: { fast: true } });
    const { objective } = plan(fastState(), ON);
    expect(objective.directives).not.toBe(compiled.directives);
    expect(Object.isFrozen(objective.directives)).toBe(false);
  });

  it('leaves every scheduling field untouched, caps included', () => {
    const limits = { hardMaxAgents: 99, agentsPerCpu: 99, maxWorktrees: 99, applyObjective: true };
    const on = plan(fastState(), limits);
    const off = plan(fastState(), { hardMaxAgents: 99, agentsPerCpu: 99, maxWorktrees: 99 });

    expect(withoutObjective(on)).toEqual(off);
    expect(on.limits.hardMaxAgents).toBe(16);
    expect(on.limits.maxWorktrees).toBe(12);
    expect(on.limits.agentsPerCpu).toBe(4);
    expect(on.plannedParallelism).toBe(off.plannedParallelism);
    expect(on.worktrees).toEqual(off.worktrees);
  });

  it('marks a blocked plan as requested-but-not-applied', () => {
    const blocked = plan(fastState({ team: false }), ON);
    expect(blocked.enabled).toBe(false);
    expect(blocked.fallbackReason).toBe('team-disabled');
    expect(blocked.objective.token).toBe('time_to_verified_outcome');
    expect(blocked.objective.applied).toBe(false);
  });

  it('marks a standard fallback as requested-but-not-applied', () => {
    const single = fastState({}, [task('only', ['src/alpha'])]);
    const fallback = plan(single, ON);
    expect(fallback.profile).toBe('standard');
    expect(fallback.objective.applied).toBe(false);
  });

  it('omits the block when the compiler fails closed with a null objective', async () => {
    const result = await planWithStubbedProfile(() => ({
      objective: null, objective_reason: 'G-1 unresolved', directives: null, source: 'flags',
    }));
    expect(Object.hasOwn(result, 'objective')).toBe(false);
  });

  it('does not throw when the compiler throws', async () => {
    const result = await planWithStubbedProfile(() => { throw new Error('schema invalid'); });
    expect(result.enabled).toBe(true);
    expect(Object.hasOwn(result, 'objective')).toBe(false);
  });
});

describe('planFastExecution — persisted reuse', () => {
  function persistable() {
    const fresh = plan(fastState());
    return { ...fresh, reused: false };
  }

  it('reuses a persisted profile that carries a stale objective, and strips it when off', () => {
    const state = fastState();
    state.fastProfile = { ...persistable(), objective: { token: 'stale', applied: true } };
    const result = plan(state);
    expect(result.reused).toBe(true);
    expect(Object.hasOwn(result, 'objective')).toBe(false);
    // Stripping happens on the returned copy; the stored profile is untouched.
    expect(state.fastProfile.objective).toEqual({ token: 'stale', applied: true });
  });

  it('recomputes the objective on reuse when on, ignoring what was stored', () => {
    const state = fastState();
    state.fastProfile = { ...persistable(), objective: { token: 'stale', applied: false } };
    const result = plan(state, ON);
    expect(result.reused).toBe(true);
    expect(result.objective.token).toBe('time_to_verified_outcome');
    expect(result.objective.applied).toBe(true);
  });

  it('judges reusability the same with and without an objective key', () => {
    const base = persistable();
    const plain = fastState();
    plain.fastProfile = base;
    const decorated = fastState();
    decorated.fastProfile = { ...base, objective: { token: 'stale', applied: true } };

    expect(plan(plain).reused).toBe(true);
    expect(plan(decorated).reused).toBe(true);
    expect(withoutObjective(plan(decorated, ON))).toEqual(withoutObjective(plan(plain, ON)));
  });
});

describe('demoteFastToStandard', () => {
  it('flips applied to false without mutating the input', () => {
    const accepted = plan(fastState(), ON);
    const demoted = demoteFastToStandard(accepted, 'no-integration-worktree');

    expect(demoted.objective.applied).toBe(false);
    expect(demoted.objective.token).toBe(accepted.objective.token);
    expect(demoted.objective).not.toBe(accepted.objective);
    expect(accepted.objective.applied).toBe(true);
  });

  it('is byte-identical to the pre-CA-12 result when no block is present', () => {
    const accepted = plan(fastState());
    const demoted = demoteFastToStandard(accepted, 'no-integration-worktree');
    expect(Object.hasOwn(demoted, 'objective')).toBe(false);
    expect(demoted).toEqual({
      ...accepted,
      enabled: false,
      fallbackReason: 'no-integration-worktree',
      worktrees: { required: false, count: 0 },
      waves: [],
      serialReasons: [...new Set([...accepted.serialReasons, 'no-integration-worktree'])],
    });
  });
});

describe('buildFastTeamInstruction', () => {
  it('emits exactly the base key lists, in order, when no objective is present', () => {
    const state = fastState();
    const off = buildFastTeamInstruction(state, plan(state));

    expect(Object.keys(off)).toEqual([...BASE_INSTRUCTION_KEYS]);
    expect(Object.keys(off.teamHint)).toEqual([...BASE_TEAM_HINT_KEYS]);
    expect(Object.keys(off.fast)).toEqual([...BASE_PLAN_KEYS, 'worktreePlan']);
    expect(off.instructions).toHaveLength(6);
    expect(off.teamHint.objective).toBeUndefined();
  });

  it('appends exactly one line and one teamHint key when the plan carries one', () => {
    const state = fastState();
    const off = buildFastTeamInstruction(state, plan(state));
    const on = buildFastTeamInstruction(state, plan(state, ON));

    expect(on.instructions).toHaveLength(off.instructions.length + 1);
    expect(on.instructions.slice(0, off.instructions.length)).toEqual(off.instructions);
    expect(on.teamHint.objective).toBe('time_to_verified_outcome');
    expect(withoutObjective(on.teamHint)).toEqual(off.teamHint);
  });

  it('assembles the line from directive values and keeps the budget guard explicit', () => {
    const state = fastState();
    const on = buildFastTeamInstruction(state, plan(state, ON));
    const { directives } = plan(state, ON).objective;
    const line = on.instructions.at(-1);

    expect(line).toContain('time_to_verified_outcome');
    expect(line).toContain(String(directives.costWeight));
    expect(line).toContain(directives.effortFloor);
    expect(line).toMatch(/예산/);
    expect(line).not.toMatch(/무제한입니다|unlimited/);
  });
});

/**
 * The one scan used by BOTH the real check and its own self-verification, so
 * a scanner that silently stopped matching would fail its own fixture first.
 */
function scanForSplitToken(source) {
  return source.includes(SPLIT_OBJECTIVE_TOKEN);
}

describe('G6 — the /split objective token never reaches a --fast plan', () => {
  const sources = readdirSync(LIB_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
    .map((entry) => entry.name);

  it.each([
    ['default', {}],
    ['on', ON],
    ['blocked', ON],
  ])('never emits the split token (%s)', (label, limits) => {
    const state = label === 'blocked' ? fastState({ team: false }) : fastState();
    const result = plan(state, limits);
    expect(result.objective?.token).not.toBe(SPLIT_OBJECTIVE_TOKEN);
    expect(JSON.stringify(result)).not.toContain(SPLIT_OBJECTIVE_TOKEN);
  });

  it('scans every lib/autopilot source file, not a hand-picked pair', () => {
    expect(sources).toContain('fast-execution.js');
    expect(sources).toContain('fast-profile.js');
    expect(sources.length).toBeGreaterThan(2);
  });

  it.each(sources)('%s does not contain the split token literal', (file) => {
    expect(scanForSplitToken(readFileSync(nodePath.join(LIB_DIR, file), 'utf8'))).toBe(false);
  });

  it('the same scanner separates a planted source from a clean one', () => {
    const planted = `const objective = '${SPLIT_OBJECTIVE_TOKEN}';`;
    const clean = readFileSync(nodePath.join(LIB_DIR, 'fast-execution.js'), 'utf8');
    expect(scanForSplitToken(planted)).toBe(true);
    expect(scanForSplitToken(clean)).toBe(false);
  });
});
