/**
 * ADR-003 Stage 1 — Phase 2 EXECUTE pluggable runner.
 * Validates: manual `--runner dynamic` opt-in produces a `dynamic-run`
 * instruction; every other path (flag absent, runner='team', legacy state
 * without the field) stays on the legacy `team-create` instruction so
 * Stage 1 ships with zero default-behavior change.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  abortAutopilot,
  removeWorktree,
  resolveExecuteRunner,
  runPhase1Plan,
  runPhase2Execute,
  startAutopilot,
} from '../../lib/autopilot/index.js';
import { deleteSession, loadSession } from '../../lib/autopilot/session-store.js';

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
beforeAll(() => {
  if (gitAvailable()) tempRepo = makeTempRepo();
});
afterAll(() => {
  if (tempRepo) {
    try { rmSync(tempRepo, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

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
  for (const id of sessionsToClean) {
    try { await abortAutopilot(id, { graceful: true }); } catch { /* ignore */ }
    try { removeWorktree(id, { force: true, cwd: tempRepo }); } catch { /* ignore */ }
    try { deleteSession(id); } catch { /* ignore */ }
  }
  sessionsToClean.clear();
});

async function phase2Instruction(options, label) {
  const r = await startAutopilot({
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
    expect(text).toContain('runner-fallback');
  });

  it('should keep team-create for explicit runner="team"', async () => {
    const inst = await phase2Instruction({ runner: 'team' }, 'team');
    expect(inst.type).toBe('team-create');
  });

  it('should inherit the session worktree into the dynamic-run instruction (ADR-003 §4 cwdHint)', async () => {
    if (!gitAvailable()) return;
    const r = await startAutopilot({
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
    const r = await startAutopilot({
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
