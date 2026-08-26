/**
 * ADR-003 Stage 1 — Phase 2 EXECUTE pluggable runner.
 * Validates: manual `--runner dynamic` opt-in produces a `dynamic-run`
 * instruction; every other path (flag absent, runner='team', legacy state
 * without the field) stays on the legacy `team-create` instruction so
 * Stage 1 ships with zero default-behavior change.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  abortAutopilot,
  removeWorktree,
  resolveExecuteRunner,
  resumeAutopilot,
  runPhase1Plan,
  runPhase2Execute,
  startAutopilot,
} from '../../lib/autopilot/index.js';
import { planFastExecution, resolveFastCpuCount } from '../../lib/autopilot/fast-execution.js';
import { recordPhaseResult } from '../../lib/autopilot/engine-state.js';
import { deleteSession, loadSession, saveSession } from '../../lib/autopilot/session-store.js';

function gitAvailable() {
  try {
    return spawnSync('git', ['--version'], { encoding: 'utf-8' }).status === 0;
  } catch {
    return false;
  }
}

// Isolated temp repo so no autopilot/* branch ever lands in the operator's
// checkout (same isolation contract as engine.execute-worktree.test.js).
function makeTempRepo() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'artibot-runner-wt-'));
  const opts = { cwd: dir, encoding: 'utf-8' };
  spawnSync('git', ['init', '-b', 'main'], opts);
  spawnSync('git', ['config', 'user.email', 'test@artibot.local'], opts);
  spawnSync('git', ['config', 'user.name', 'artibot-test'], opts);
  spawnSync('git', ['config', 'commit.gpgsign', 'false'], opts);
  writeFileSync(path.join(dir, 'README.md'), '# temp\n');
  spawnSync('git', ['add', '-A'], opts);
  spawnSync('git', ['commit', '-m', 'init', '--no-gpg-sign'], opts);
  return dir;
}

let tempRepo = null;
// A directory that is deliberately NOT a git repo (and has no git ancestor —
// verified: `git worktree add` under the Node tmpdir exits 128 "not a git
// repository"). Used to force `attemptCreateWorktree` to FAIL while
// `useWorktree` is on, which is the only way to reach the
// `integration-worktree-failed` branch. Needs no gitAvailable() guard: with git
// absent the spawn errors instead, and both paths return null identically.
let nonGitDir = '';
// ARTIFACT ISOLATION CONTRACT (extends the branch-leak guard above to written
// artifacts): startAutopilot writes docs/PRD/ and abortAutopilot writes
// reports/AUTOPILOT/ under <projectRoot>/. Unset, that is the operator's real
// checkout. Always created — unlike tempRepo it must exist even without git.
let artifactRoot = '';
beforeAll(() => {
  if (gitAvailable()) tempRepo = makeTempRepo();
  artifactRoot = mkdtempSync(path.join(os.tmpdir(), 'artibot-runner-artifacts-'));
  nonGitDir = mkdtempSync(path.join(os.tmpdir(), 'artibot-runner-nongit-'));
});
afterAll(() => {
  if (tempRepo) {
    try { rmSync(tempRepo, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  try { rmSync(artifactRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  try { rmSync(nonGitDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

/**
 * startAutopilot with the artifact-isolation override applied.
 * @param {object} args - Same shape as startAutopilot.
 * @returns {Promise<object>}
 */
function start(args) {
  return startAutopilot({
    ...args,
    options: { ...(args.options || {}), projectRoot: artifactRoot },
  });
}

const sessionsToClean = new Set();
function track(id) {
  if (id) sessionsToClean.add(id);
  return id;
}

let counter = 0;
function uniqueId(label) {
  counter += 1;
  return `ap-runner-${label}-${process.pid}-${Date.now()}-${counter}`;
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const id of sessionsToClean) {
    try { await abortAutopilot(id, { graceful: true }); } catch { /* ignore */ }
    try { removeWorktree(id, { force: true, cwd: tempRepo }); } catch { /* ignore */ }
    try { deleteSession(id); } catch { /* ignore */ }
  }
  sessionsToClean.clear();
});

async function phase2Instruction(options, label) {
  const r = await start({
    task: `runner test ${label}`,
    mode: 'default',
    options,
    sessionId: uniqueId(label),
  });
  track(r.sessionId);
  const state = loadSession(r.sessionId);
  runPhase1Plan(state);
  return runPhase2Execute(state);
}

describe('resolveExecuteRunner (pure)', () => {
  it('should return team-create when options.runner is absent', () => {
    expect(resolveExecuteRunner({ options: {} })).toBe('team-create');
  });

  it('should return team-create for explicit runner="team"', () => {
    expect(resolveExecuteRunner({ options: { runner: 'team' } })).toBe('team-create');
  });

  it('should return dynamic-run only for runner="dynamic"', () => {
    expect(resolveExecuteRunner({ options: { runner: 'dynamic' } })).toBe('dynamic-run');
  });

  it('should return team-create for legacy states without options (resume backward compat)', () => {
    expect(resolveExecuteRunner({})).toBe('team-create');
    expect(resolveExecuteRunner(null)).toBe('team-create');
    expect(resolveExecuteRunner({ options: null })).toBe('team-create');
  });

  it('should not select dynamic-run for unknown runner values', () => {
    expect(resolveExecuteRunner({ options: { runner: 'workflow' } })).toBe('team-create');
    expect(resolveExecuteRunner({ options: { runner: '' } })).toBe('team-create');
  });
});

describe('resolveExecuteRunner — Stage 2 auto-select ladder (config-injected)', () => {
  it('should stay team-create when autoSelect is OFF even with a workflow recommendation', () => {
    const state = { options: { recommendedRunner: 'workflow' } };
    expect(resolveExecuteRunner(state, { autoSelect: false })).toBe('team-create');
  });

  it('should auto-select dynamic-run when autoSelect is ON and recommendation is workflow', () => {
    const state = { options: { recommendedRunner: 'workflow' } };
    expect(resolveExecuteRunner(state, { autoSelect: true })).toBe('dynamic-run');
  });

  it('should stay team-create when autoSelect is ON but no recommendation was injected', () => {
    expect(resolveExecuteRunner({ options: {} }, { autoSelect: true })).toBe('team-create');
    expect(resolveExecuteRunner({ options: { recommendedRunner: 'autopilot' } }, { autoSelect: true })).toBe('team-create');
  });

  it('should let an explicit --runner override beat auto-select in both directions', () => {
    const rec = { recommendedRunner: 'workflow' };
    expect(resolveExecuteRunner({ options: { runner: 'team', ...rec } }, { autoSelect: true })).toBe('team-create');
    expect(resolveExecuteRunner({ options: { runner: 'dynamic' } }, { autoSelect: false })).toBe('dynamic-run');
  });

  it('should pin unknown explicit runner values to team-create even under auto-select (Stage 1 invariant)', () => {
    const rec = { recommendedRunner: 'workflow' };
    expect(resolveExecuteRunner({ options: { runner: 'dynamik', ...rec } }, { autoSelect: true })).toBe('team-create');
    expect(resolveExecuteRunner({ options: { runner: 'workflow', ...rec } }, { autoSelect: true })).toBe('team-create');
    // Empty string counts as "no explicit choice" and falls through the ladder.
    expect(resolveExecuteRunner({ options: { runner: '', ...rec } }, { autoSelect: true })).toBe('dynamic-run');
  });

  it('should default to autoSelect OFF from the live config (kill-switch shipped closed)', () => {
    // No config injected → loadRunnerConfig() reads artibot.config.json,
    // whose shipped default is autoSelect:false.
    const state = { options: { recommendedRunner: 'workflow' } };
    expect(resolveExecuteRunner(state)).toBe('team-create');
  });

  it('should reuse a saved runner selection when the auto-select config changes', () => {
    const state = {
      options: { recommendedRunner: 'workflow' },
      executeRunner: { runner: 'dynamic-run', reason: 'auto-runner-dynamic' },
    };

    expect(resolveExecuteRunner(state, { autoSelect: false })).toBe('dynamic-run');
  });
});

describe('resolveFastCpuCount', () => {
  it('uses options.cpuCount only as an explicit test override', () => {
    expect(resolveFastCpuCount({ cpuCount: 3 })).toBe(3);
    expect(resolveFastCpuCount({})).toBeGreaterThan(0);
  });

  it('prefers availableParallelism and falls back to cpus when it is unusable', () => {
    const available = vi.spyOn(os, 'availableParallelism').mockReturnValue(0);
    const cpus = vi.spyOn(os, 'cpus').mockReturnValue([{}, {}, {}, {}]);

    expect(resolveFastCpuCount()).toBe(4);
    expect(available).toHaveBeenCalledOnce();
    expect(cpus).toHaveBeenCalledOnce();
  });

  it('does not trust a persisted session cpuCount as production capacity', () => {
    vi.spyOn(os, 'availableParallelism').mockReturnValue(2);
    const fastTasks = Array.from({ length: 8 }, (_, index) => ({
      id: `cpu-${index + 1}`,
      independent: true,
      affectedPaths: [`src/cpu-${index + 1}.js`],
      risk: 'low',
      worktreeEligible: true,
    }));

    const fast = planFastExecution({
      options: { fast: true, cpuCount: 999, fastTasks },
    }, 'team-create');

    expect(fast.cpuCount).toBe(2);
    expect(fast.eligibleParallelism).toBe(4);
  });
});

describe('runPhase2Execute — runner branching (ADR-003 Stage 1)', () => {
  it('should emit the legacy team-create instruction when the flag is absent', async () => {
    const inst = await phase2Instruction({}, 'default');
    expect(inst.type).toBe('team-create');
    expect(inst.nextPhase).toBe('CROSS_CHECK');
    expect(inst.teamHint).toEqual({ parallel: true, leadAgent: 'orchestrator' });
    // Stage 1 contract: default instruction carries no runner field (unchanged shape).
    expect(inst.runner).toBeUndefined();
  });

  it('should emit a dynamic-run instruction when runner="dynamic"', async () => {
    const inst = await phase2Instruction({ runner: 'dynamic' }, 'dynamic');
    expect(inst.type).toBe('dynamic-run');
    expect(inst.runner).toBe('dynamic-run');
    expect(inst.nextPhase).toBe('CROSS_CHECK');
    expect(inst.teamHint).toBeUndefined();
    const text = inst.instructions.join('\n');
    expect(text).toContain('Workflow');
    // Blind spot, stated next to the gate: this checks only that the word
    // appears in the instruction text. The actual dynamic-run -> team-create
    // fallback transition is NOT implemented (A3, DEFER), so a green here is
    // evidence the driver was told to fall back — never that it can.
    expect(text).toContain('runner-fallback');
  });

  it('should keep team-create for explicit runner="team"', async () => {
    const inst = await phase2Instruction({ runner: 'team' }, 'team');
    expect(inst.type).toBe('team-create');
  });

  it('should turn an eligible --fast task wave into isolated parallel team instructions', async () => {
    if (!gitAvailable()) return;
    // `useWorktree` is load-bearing, not decoration: fan-out requires a fixed
    // integration base, and without a session worktree the engine demotes to
    // standard (see the no-integration-worktree test below). This test used to
    // omit it and still assert enabled:true — it was asserting the bug.
    const inst = await phase2Instruction({
      fast: true,
      useWorktree: true,
      worktreeCwd: tempRepo,
      cpuCount: 2,
      fastTasks: [
        { id: 'api', independent: true, affectedPaths: ['src/api/**'], risk: 'low', worktreeEligible: true },
        { id: 'ui', independent: true, affectedPaths: ['src/ui/**'], risk: 'low', worktreeEligible: true },
        { id: 'tests', independent: true, affectedPaths: ['tests/**'], risk: 'medium', worktreeEligible: true },
      ],
    }, 'fast-eligible');

    expect(inst.type).toBe('team-create');
    expect(inst.fast).toMatchObject({ enabled: true, profile: 'fast' });
    expect(inst.fast.plannedParallelism).toBeGreaterThan(1);
    expect(inst.fast.worktrees.count).toBeGreaterThan(0);
    expect(inst.fast.serialReasons).toEqual([]);
    expect(inst.teamHint).toMatchObject({ parallel: true, profile: 'fast' });
    expect(inst.teamHint.plannedParallelism).toBe(inst.fast.plannedParallelism);
    expect(inst.instructions.join('\n')).toContain('독립 작업 wave');
    expect(inst.instructions.join('\n')).toContain('파일 소유권');
  });

  it('should demote an eligible --fast wave to standard when there is no integration worktree', async () => {
    // The gap the review found: `--worktree` defaults off, so `--fast` alone
    // left `integration = {cwd:null, baseSha:null}` while fan-out stayed on.
    // A driver reading that null as "the repo root" would branch up to
    // maxWorktrees workers off a MOVING HEAD, since the same instruction also
    // orders a WIP commit every 30 minutes. Identical input to the test above
    // minus `useWorktree` — the only difference is the integration base.
    const inst = await phase2Instruction({
      fast: true,
      cpuCount: 2,
      fastTasks: [
        { id: 'api', independent: true, affectedPaths: ['src/api/**'], risk: 'low', worktreeEligible: true },
        { id: 'ui', independent: true, affectedPaths: ['src/ui/**'], risk: 'low', worktreeEligible: true },
        { id: 'tests', independent: true, affectedPaths: ['tests/**'], risk: 'medium', worktreeEligible: true },
      ],
    }, 'fast-no-integration');

    // Standard instruction, not the fan-out one.
    expect(inst.type).toBe('team-create');
    expect(inst.teamHint).toEqual({ parallel: true, leadAgent: 'orchestrator' });
    // Reason code unchanged: `no-integration-worktree` now means opt-out ONLY —
    // a worktree that was requested and failed reports `integration-worktree-failed`
    // instead (see the next test).
    expect(inst.fast).toMatchObject({
      enabled: false,
      fallbackReason: 'no-integration-worktree',
      worktrees: { required: false, count: 0 },
      waves: [],
    });
    expect(inst.fast.serialReasons).toContain('no-integration-worktree');
    // Nothing may carry a worker plan: no worktreePlan at all, so there is no
    // null baseCwd/baseSha for a driver to reinterpret.
    expect(inst.fast.worktreePlan).toBeUndefined();
    // The tasks were genuinely eligible — demotion is about the missing base,
    // not about the work. Keeping these fields is what lets :status explain it.
    expect(inst.fast).toMatchObject({ requested: true, eligibleParallelism: 3 });
  });

  it('should report a REQUESTED integration worktree that failed as integration-worktree-failed', async () => {
    // Both demotions used to collapse into `no-integration-worktree`, so an
    // operator reading `:status` could not tell "I never asked for a worktree"
    // from "I asked and creation broke". A live session that passed the wrong
    // option key is what EXPOSED that shared label — but it is not what this
    // test covers: that session took the opt-out path, so its own label is
    // `no-integration-worktree` both before and after the split (unchanged, and
    // correct). What this test closes is the other branch the shared label was
    // hiding — worktree requested, creation failed. Same eligible task set as
    // the two tests above; the ONLY difference is that `useWorktree` is on
    // while creation is forced to fail.
    const inst = await phase2Instruction({
      fast: true,
      useWorktree: true,
      // Non-git cwd => `git worktree add` exits 128 => createWorktree ok:false
      // => attemptCreateWorktree returns null with `useWorktree` still true.
      worktreeCwd: nonGitDir,
      cpuCount: 2,
      fastTasks: [
        { id: 'api', independent: true, affectedPaths: ['src/api/**'], risk: 'low', worktreeEligible: true },
        { id: 'ui', independent: true, affectedPaths: ['src/ui/**'], risk: 'low', worktreeEligible: true },
        { id: 'tests', independent: true, affectedPaths: ['tests/**'], risk: 'medium', worktreeEligible: true },
      ],
    }, 'fast-integration-worktree-failed');

    // Creation really did fail: engine.js only sets these when a path exists.
    expect(inst.worktreePath).toBeUndefined();
    expect(inst.cwdHint).toBeUndefined();

    // Same safe demotion as the opt-out case — only the reason differs.
    expect(inst.type).toBe('team-create');
    expect(inst.teamHint).toEqual({ parallel: true, leadAgent: 'orchestrator' });
    expect(inst.fast).toMatchObject({
      enabled: false,
      fallbackReason: 'integration-worktree-failed',
      worktrees: { required: false, count: 0 },
      waves: [],
    });
    expect(inst.fast.serialReasons).toContain('integration-worktree-failed');
    // The whole point of the split: the opt-out code must NOT appear here.
    expect(inst.fast.serialReasons).not.toContain('no-integration-worktree');
    expect(inst.fast.worktreePlan).toBeUndefined();
    expect(inst.fast).toMatchObject({ requested: true, eligibleParallelism: 3 });
  });

  it('should treat a non-boolean truthy useWorktree as a request, not an opt-out', async () => {
    // The creation gate has always been a bare truthy check, so `'true'` (a
    // string — what a resumed session or a hand-edited options blob yields)
    // DOES spawn `git worktree add`. The demotion site used to ask `=== true`,
    // so the same value failed creation and was then labelled
    // `no-integration-worktree` — blaming the operator for not asking when the
    // engine had in fact asked and broken. Both gates now read
    // `worktreeRequested`, so a truthy-but-not-`true` value cannot land in the
    // gap between them. Resume matters here: `resumeAutopilot` reads options
    // straight off disk without the canonical-boolean pass that `startAutopilot`
    // applies to `fast`, so non-boolean values genuinely reach this code.
    const inst = await phase2Instruction({
      fast: true,
      useWorktree: 'true',
      worktreeCwd: nonGitDir,
      cpuCount: 2,
      fastTasks: [
        { id: 'api', independent: true, affectedPaths: ['src/api/**'], risk: 'low', worktreeEligible: true },
        { id: 'ui', independent: true, affectedPaths: ['src/ui/**'], risk: 'low', worktreeEligible: true },
        { id: 'tests', independent: true, affectedPaths: ['tests/**'], risk: 'medium', worktreeEligible: true },
      ],
    }, 'fast-truthy-usewor');

    expect(inst.worktreePath).toBeUndefined();
    expect(inst.fast).toMatchObject({
      enabled: false,
      fallbackReason: 'integration-worktree-failed',
    });
    expect(inst.fast.serialReasons).not.toContain('no-integration-worktree');
  });

  it('should retain the session integration worktree for --fast worker instructions', async () => {
    if (!gitAvailable()) return;
    const inst = await phase2Instruction({
      fast: true,
      useWorktree: true,
      worktreeCwd: tempRepo,
      fastTasks: [
        { id: 'api', independent: true, affectedPaths: ['src/api/**'], risk: 'low', worktreeEligible: true },
        { id: 'ui', independent: true, affectedPaths: ['src/ui/**'], risk: 'low', worktreeEligible: true },
      ],
    }, 'fast-integration-worktree');

    expect(inst.worktreePath).toEqual(expect.any(String));
    expect(inst.fast.worktreePlan.integration).toMatchObject({
      cwd: inst.worktreePath,
      baseSha: expect.stringMatching(/^[0-9a-f]{40}$/),
    });
    expect(inst.fast.worktreePlan.waves[0].workers[0]).toMatchObject({
      baseCwd: inst.worktreePath,
      baseSha: expect.stringMatching(/^[0-9a-f]{40}$/),
    });
    expect(inst.cwdHint).toBe(inst.worktreePath);
  });

  it('should reuse the same integration worktree and base SHA on an EXECUTE resume', async () => {
    if (!gitAvailable()) return;
    const r = await start({
      task: 'runner test fast integration resume',
      mode: 'default',
      options: {
        fast: true,
        useWorktree: true,
        worktreeCwd: tempRepo,
        fastTasks: [
          { id: 'api', independent: true, affectedPaths: ['src/api/**'], risk: 'low', worktreeEligible: true },
          { id: 'ui', independent: true, affectedPaths: ['src/ui/**'], risk: 'low', worktreeEligible: true },
        ],
      },
      sessionId: uniqueId('fast-integration-resume'),
    });
    track(r.sessionId);
    const state = loadSession(r.sessionId);
    runPhase1Plan(state);
    const first = runPhase2Execute(state);
    const resumed = runPhase2Execute(loadSession(r.sessionId));

    expect(resumed.worktreePath).toBe(first.worktreePath);
    expect(resumed.cwdHint).toBe(first.cwdHint);
    expect(resumed.fast.worktreePlan.integration).toEqual(first.fast.worktreePlan.integration);
  });

  it('should fall back to standard when --fast is combined with team:false', async () => {
    // The `--no-team` interlock had zero tests and zero producers (repo-wide
    // census: the only match for either spelling was the consuming line
    // itself). `options.noTeam` is gone; `options.team === false` is the single
    // documented spelling the command driver is contracted to set, and this
    // pins the engine half of that contract (autopilot.md § Fast Fan-out
    // Profile: `team-disabled` telemetry + standard team-create instruction).
    const inst = await phase2Instruction({
      fast: true,
      team: false,
      useWorktree: true,
      worktreeCwd: tempRepo,
      cpuCount: 2,
      fastTasks: [
        { id: 'api', independent: true, affectedPaths: ['src/api/**'], risk: 'low', worktreeEligible: true },
        { id: 'ui', independent: true, affectedPaths: ['src/ui/**'], risk: 'low', worktreeEligible: true },
      ],
    }, 'fast-team-disabled');

    expect(inst.type).toBe('team-create');
    expect(inst.fast).toMatchObject({ enabled: false, fallbackReason: 'team-disabled' });
    expect(inst.fast.serialReasons).toContain('team-disabled');
    expect(inst.fast.worktreePlan).toBeUndefined();
    // Both eligible tasks are serialized under the interlock, not silently kept.
    expect(inst.fast.serial.map((entry) => entry.taskId).sort()).toEqual(['api', 'ui']);
  });

  it('should persist requested, eligible, planned, and worktree fast telemetry in session state', async () => {
    if (!gitAvailable()) return;
    const r = await start({
      task: 'runner test fast telemetry',
      mode: 'default',
      options: {
        fast: true,
        // Required for the plan to stay enabled — this asserts the telemetry of
        // an ACCEPTED plan, which only exists with an integration base.
        useWorktree: true,
        worktreeCwd: tempRepo,
        cpuCount: 2,
        fastTasks: [
          { id: 'one', independent: true, affectedPaths: ['src/one/**'], risk: 'low', worktreeEligible: true },
          { id: 'two', independent: true, affectedPaths: ['src/two/**'], risk: 'low', worktreeEligible: true },
        ],
      },
      sessionId: uniqueId('fast-telemetry'),
    });
    track(r.sessionId);
    const state = loadSession(r.sessionId);
    runPhase1Plan(state);
    runPhase2Execute(state);
    const persisted = loadSession(r.sessionId);

    expect(persisted.fastProfile).toMatchObject({
      requested: true,
      requestedParallelism: 2,
      eligibleParallelism: 2,
      plannedParallelism: 2,
      worktrees: { required: true, count: 2 },
      serialReasons: [],
    });
  });

  it('should retain the standard runner when --fast has unsafe or conflicting work', async () => {
    const inst = await phase2Instruction({
      fast: true,
      fastTasks: [
        { id: 'same-a', independent: true, affectedPaths: ['src/shared.js'], risk: 'low', worktreeEligible: true },
        { id: 'same-b', independent: true, affectedPaths: ['src/shared.js'], risk: 'low', worktreeEligible: true },
      ],
    }, 'fast-conflict');

    expect(inst.type).toBe('team-create');
    expect(inst.fast).toMatchObject({ enabled: false, profile: 'standard' });
    expect(inst.fast.serialReasons.length).toBeGreaterThan(0);
    expect(inst.teamHint).not.toHaveProperty('profile', 'fast');
    expect(inst.instructions.join('\n')).not.toContain('독립 작업 wave별');
  });

  it('should make explicit dynamic runner win over --fast and record the safe fallback', async () => {
    const inst = await phase2Instruction({
      fast: true,
      runner: 'dynamic',
      fastTasks: [
        { id: 'one', independent: true, affectedPaths: ['src/one/**'], risk: 'low', worktreeEligible: true },
        { id: 'two', independent: true, affectedPaths: ['src/two/**'], risk: 'low', worktreeEligible: true },
      ],
    }, 'fast-dynamic');

    expect(inst.type).toBe('dynamic-run');
    expect(inst.fast).toMatchObject({ enabled: false, profile: 'standard' });
    expect(inst.fast.serialReasons).toContain('explicit-runner-dynamic');
  });

  it('should label an auto-selected dynamic runner without claiming it was explicit', () => {
    const state = {
      options: {
        fast: true,
        recommendedRunner: 'workflow',
        fastTasks: [
          { id: 'one', independent: true, affectedPaths: ['src/one/**'], risk: 'low', worktreeEligible: true },
          { id: 'two', independent: true, affectedPaths: ['src/two/**'], risk: 'low', worktreeEligible: true },
        ],
      },
    };

    const runner = resolveExecuteRunner(state, { autoSelect: true });
    const fast = planFastExecution(state, runner);

    expect(runner).toBe('dynamic-run');
    expect(fast).toMatchObject({ enabled: false, profile: 'standard' });
    expect(fast.serialReasons).toContain('auto-runner-dynamic');
    expect(fast.serialReasons).not.toContain('explicit-runner-dynamic');
  });

  it('should reuse the saved runner reason when later options would relabel it', () => {
    const state = {
      executeRunner: { runner: 'dynamic-run', reason: 'auto-runner-dynamic' },
      options: {
        fast: true,
        runner: 'dynamic',
        fastTasks: [
          { id: 'one', independent: true, affectedPaths: ['src/one/**'], risk: 'low', worktreeEligible: true },
          { id: 'two', independent: true, affectedPaths: ['src/two/**'], risk: 'low', worktreeEligible: true },
        ],
      },
    };

    const fast = planFastExecution(state, resolveExecuteRunner(state));

    expect(fast.serialReasons).toContain('auto-runner-dynamic');
    expect(fast.serialReasons).not.toContain('explicit-runner-dynamic');
  });

  it('should reuse the paused EXECUTE fast snapshot when later inputs offer more parallelism', async () => {
    if (!gitAvailable()) return;
    const r = await start({
      task: 'runner test fast resume snapshot',
      mode: 'default',
      options: {
        fast: true,
        // Snapshot reuse is only observable on an accepted plan, which needs
        // the integration base; without it the profile demotes before resume.
        useWorktree: true,
        worktreeCwd: tempRepo,
        cpuCount: 1,
        fastTasks: [
          { id: 'one', independent: true, affectedPaths: ['src/one/**'], risk: 'low', worktreeEligible: true },
          { id: 'two', independent: true, affectedPaths: ['src/two/**'], risk: 'low', worktreeEligible: true },
        ],
      },
      sessionId: uniqueId('fast-resume'),
    });
    track(r.sessionId);
    const state = loadSession(r.sessionId);
    runPhase1Plan(state);
    runPhase2Execute(state);
    // Acknowledge the EXECUTE hand-off before pausing. Without this the
    // session is "work handed out, never reported back" and resume correctly
    // PAUSEs on the outstanding attempt (phase-attempt.js) — which would make
    // this test measure attempt recovery instead of fast-snapshot reuse.
    recordPhaseResult(loadSession(r.sessionId), { phase: 'EXECUTE', status: 'done' });

    const paused = loadSession(r.sessionId);
    paused.phase = 'PAUSED';
    paused.lastPhase = 'EXECUTE';
    paused.options.cpuCount = 64;
    paused.options.fastTasks = Array.from({ length: 16 }, (_, index) => ({
      id: `expanded-${index + 1}`,
      independent: true,
      affectedPaths: [`src/expanded-${index + 1}/**`],
      risk: 'low',
      worktreeEligible: true,
    }));
    saveSession(paused);

    const resumed = await resumeAutopilot(r.sessionId);
    const persisted = loadSession(r.sessionId);

    expect(resumed.phase).toBe('EXECUTE');
    expect(resumed.instruction.fast).toMatchObject({ enabled: true, plannedParallelism: 2 });
    expect(persisted.fastProfile).toMatchObject({ enabled: true, plannedParallelism: 2 });
  });

  it('should PAUSE a resume whose EXECUTE hand-off was never acknowledged', async () => {
    const r = await start({
      task: 'runner test unacked execute',
      mode: 'default',
      options: { cpuCount: 2 },
      sessionId: uniqueId('unacked'),
    });
    track(r.sessionId);
    const state = loadSession(r.sessionId);
    runPhase1Plan(state);
    runPhase2Execute(state);
    // Deliberately NO recordPhaseResult — this is the crash shape: work was
    // handed to a team and the process died before any result came back.

    const handed = loadSession(r.sessionId);
    expect(handed.activePhaseAttempt).toMatchObject({ phase: 'EXECUTE', status: 'started' });

    const resumed = await resumeAutopilot(r.sessionId);
    expect(resumed.status).toBe('paused');
    expect(resumed.phase).toBe('EXECUTE');
    expect(resumed.instruction).toMatchObject({
      type: 'pause',
      reason: 'unacknowledged-attempt',
      attemptId: handed.activePhaseAttempt.attemptId,
    });
    // Korean recovery note, and it must say we are NOT redoing the work.
    expect(resumed.recoveryNote).toContain('EXECUTE');
    expect(resumed.recoveryNote).toContain('자동 재실행하지 않습니다');
    // It must not have silently started EXECUTE again.
    expect(resumed.instruction.type).not.toBe('team-create');
  });

  it('should produce no recovery note when the session completed its phase normally', async () => {
    // Negative control for the test above, and the guard against a permanent
    // recovery loop: acknowledging the hand-off must fully clear the slot, so
    // a healthy session resumes with zero notes no matter how often it pauses.
    const r = await start({
      task: 'runner test acked execute',
      mode: 'default',
      options: { cpuCount: 2 },
      sessionId: uniqueId('acked'),
    });
    track(r.sessionId);
    const state = loadSession(r.sessionId);
    runPhase1Plan(state);
    runPhase2Execute(state);
    recordPhaseResult(loadSession(r.sessionId), { phase: 'EXECUTE', status: 'done' });

    expect(loadSession(r.sessionId).activePhaseAttempt).toBeNull();

    const resumed = await resumeAutopilot(r.sessionId);
    expect(resumed.status).not.toBe('paused');
    expect(resumed.recoveryNote).toBeUndefined();

    // Twice: an ACK that only half-cleared would resurface on the second pass.
    const again = await resumeAutopilot(r.sessionId);
    expect(again.recoveryNote).toBeUndefined();
  });

  it('should resume normally when the operator acknowledges the attempt by argument', async () => {
    const r = await start({
      task: 'runner test operator ack',
      mode: 'default',
      options: { cpuCount: 2 },
      sessionId: uniqueId('op-ack'),
    });
    track(r.sessionId);
    const state = loadSession(r.sessionId);
    runPhase1Plan(state);
    runPhase2Execute(state);
    expect(loadSession(r.sessionId).activePhaseAttempt).toMatchObject({ phase: 'EXECUTE' });

    const resumed = await resumeAutopilot(r.sessionId, { ackOutstandingAttempt: true });

    // Not paused — the operator asserted the handed-out work landed.
    expect(resumed.status).not.toBe('paused');
    expect(resumed.instruction?.reason).not.toBe('unacknowledged-attempt');
    // And the slot is genuinely cleared, so the escape hatch is one-shot
    // rather than a mode: the next resume needs no argument and pauses no more.
    expect(loadSession(r.sessionId).activePhaseAttempt).toBeNull();
    const again = await resumeAutopilot(r.sessionId);
    expect(again.status).not.toBe('paused');
    expect(again.recoveryNote).toBeUndefined();
  });

  it('should still PAUSE when the acknowledgement is absent from the call', async () => {
    // Control for the test above: same session shape, argument omitted.
    const r = await start({
      task: 'runner test no ack arg',
      mode: 'default',
      options: { cpuCount: 2 },
      sessionId: uniqueId('no-ack-arg'),
    });
    track(r.sessionId);
    const state = loadSession(r.sessionId);
    runPhase1Plan(state);
    runPhase2Execute(state);

    const resumed = await resumeAutopilot(r.sessionId);
    expect(resumed.status).toBe('paused');
    expect(resumed.instruction.reason).toBe('unacknowledged-attempt');
  });

  it('should ignore an acknowledgement planted in config or env (call-arg only)', async () => {
    // Negative control on the escape hatch itself. Same reasoning as the
    // consent override: this argument asserts that a human just looked at the
    // tree. A config key or env var would make that assertion once, by nobody,
    // and keep making it forever — permanently disabling the guard.
    const r = await start({
      task: 'runner test planted ack',
      mode: 'default',
      options: { cpuCount: 2, ackOutstandingAttempt: true },
      sessionId: uniqueId('planted-ack'),
    });
    track(r.sessionId);
    const state = loadSession(r.sessionId);
    runPhase1Plan(state);
    runPhase2Execute(state);

    // Planted in session options...
    const planted = loadSession(r.sessionId);
    planted.ackOutstandingAttempt = true;
    planted.config = { autopilot: { ackOutstandingAttempt: true } };
    saveSession(planted);
    // ...and in the environment.
    const priorEnv = process.env.ARTIBOT_ACK_OUTSTANDING_ATTEMPT;
    process.env.ARTIBOT_ACK_OUTSTANDING_ATTEMPT = '1';
    try {
      const resumed = await resumeAutopilot(r.sessionId);
      expect(resumed.status).toBe('paused');
      expect(resumed.instruction.reason).toBe('unacknowledged-attempt');
      expect(loadSession(r.sessionId).activePhaseAttempt).toMatchObject({ status: 'started' });
    } finally {
      if (priorEnv === undefined) delete process.env.ARTIBOT_ACK_OUTSTANDING_ATTEMPT;
      else process.env.ARTIBOT_ACK_OUTSTANDING_ATTEMPT = priorEnv;
    }
  });

  it('should discard a malformed fast snapshot and safely replan from metadata', () => {
    const fast = planFastExecution({
      options: { fast: true, fastTasks: [] },
      fastProfile: {
        requested: true,
        profile: 'fast',
        enabled: true,
        requestedTaskCount: 2,
        eligibleTaskCount: 2,
        requestedParallelism: 2,
        eligibleParallelism: 2,
        plannedParallelism: 2,
        limits: { hardMaxAgents: 16, agentsPerCpu: 2, maxWorktrees: 12 },
        worktrees: { required: true, count: 2 },
        waves: [{ taskIds: ['duplicate', 'duplicate'], worktreeCount: 2 }],
        serial: [],
        serialReasons: [],
      },
    }, 'team-create');

    expect(fast).toMatchObject({
      enabled: false,
      fallbackReason: 'no-tasks',
      reused: false,
    });
  });

  it.each([
    ['non-canonical limits', (profile) => ({
      ...profile,
      limits: { ...profile.limits, maxWorktrees: 99 },
    })],
    ['capacity above CPU cap', (profile) => ({
      ...profile,
      cpuCount: 1,
      limits: { ...profile.limits, agentsPerCpu: 1 },
    })],
    ['serial count mismatch', (profile) => ({
      ...profile,
      serial: [{ taskId: 'ghost', reason: 'not-independent' }],
    })],
    ['duplicate wave and serial task id', (profile) => ({
      ...profile,
      requestedTaskCount: 3,
      requestedParallelism: 3,
      serial: [{ taskId: profile.waves[0].taskIds[0], reason: 'not-independent' }],
      serialReasons: ['not-independent'],
    })],
    ['invalid speed estimate', (profile) => ({ ...profile, estimatedSpeedup: null })],
  ])('should reject a persisted fast snapshot with %s without throwing', (_label, mutate) => {
    const valid = planFastExecution({
      options: {
        fast: true,
        fastTasks: [
          { id: 'one', independent: true, affectedPaths: ['src/one.js'], risk: 'low', worktreeEligible: true },
          { id: 'two', independent: true, affectedPaths: ['src/two.js'], risk: 'low', worktreeEligible: true },
        ],
      },
    }, 'team-create', {}, { cpuCount: 1 });
    const state = {
      options: { fast: true, fastTasks: [] },
      fastProfile: mutate(valid),
    };

    expect(() => planFastExecution(state, 'team-create')).not.toThrow();
    expect(planFastExecution(state, 'team-create')).toMatchObject({
      enabled: false,
      fallbackReason: 'no-tasks',
      reused: false,
    });
  });

  it('should reject a malformed persisted standard fallback instead of reusing it', () => {
    const standard = planFastExecution({
      options: {
        fast: true,
        fastTasks: [
          { id: 'one', independent: true, affectedPaths: ['src/shared.js'], risk: 'low', worktreeEligible: true },
          { id: 'two', independent: true, affectedPaths: ['src/shared.js'], risk: 'low', worktreeEligible: true },
        ],
      },
    }, 'team-create', {}, { cpuCount: 1 });
    const state = {
      options: { fast: true, fastTasks: [] },
      fastProfile: { ...standard, serial: [] },
    };

    expect(planFastExecution(state, 'team-create')).toMatchObject({
      fallbackReason: 'no-tasks',
      reused: false,
    });
  });

  it('should persist the first runner selection and reason for future resumes', async () => {
    const r = await start({
      task: 'runner selection persistence',
      mode: 'default',
      options: {},
      sessionId: uniqueId('runner-selection'),
    });
    track(r.sessionId);
    const state = loadSession(r.sessionId);
    expect(state.executeRunner).toEqual({
      runner: 'team-create',
      reason: 'default-runner-team',
    });
    runPhase1Plan(state);
    runPhase2Execute(state);

    expect(loadSession(r.sessionId).executeRunner).toEqual({
      runner: 'team-create',
      reason: 'default-runner-team',
    });
  });

  it('should not let changed options drift the runner after session start', async () => {
    const r = await start({
      task: 'runner selection immutable after start',
      mode: 'default',
      options: {},
      sessionId: uniqueId('runner-selection-immutable'),
    });
    track(r.sessionId);
    const state = loadSession(r.sessionId);
    state.options.runner = 'dynamic';
    runPhase1Plan(state);

    const inst = runPhase2Execute(state);

    expect(inst.type).toBe('team-create');
    expect(loadSession(r.sessionId).executeRunner).toEqual({
      runner: 'team-create',
      reason: 'default-runner-team',
    });
  });

  it('should inherit the session worktree into the dynamic-run instruction (ADR-003 §4 cwdHint)', async () => {
    if (!gitAvailable()) return;
    const r = await start({
      task: 'runner test dynamic worktree',
      mode: 'default',
      options: { runner: 'dynamic', useWorktree: true, worktreeCwd: tempRepo },
      sessionId: uniqueId('dynwt'),
    });
    track(r.sessionId);
    const state = loadSession(r.sessionId);
    runPhase1Plan(state);
    const inst = runPhase2Execute(state);
    expect(inst.type).toBe('dynamic-run');
    // Worktree creation is best-effort (graceful fallback); when it succeeds
    // the dynamic-run instruction MUST carry the session worktree as cwdHint.
    if (inst.worktreePath) {
      expect(inst.cwdHint).toBe(inst.worktreePath);
      expect(state.worktreePath).toBe(inst.worktreePath);
    } else {
      expect(inst.cwdHint).toBeUndefined();
    }
  });

  it('should stay on team-create when a legacy state lacks the runner field', async () => {
    const r = await start({
      task: 'runner test legacy',
      mode: 'default',
      options: {},
      sessionId: uniqueId('legacy'),
    });
    track(r.sessionId);
    const state = loadSession(r.sessionId);
    delete state.options.runner; // simulate pre-Stage-1 persisted state
    runPhase1Plan(state);
    const inst = runPhase2Execute(state);
    expect(inst.type).toBe('team-create');
  });
});
