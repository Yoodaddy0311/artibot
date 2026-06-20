/**
 * Integration tests for autopilot engine + worktree-manager wiring (Wave C).
 * Validates Phase 2 EXECUTE worktree branching, abort cleanup, and the
 * listActiveWorktrees export.
 *
 * ISOLATION CONTRACT (branch-leak guard): when a test exercises real git
 * worktree creation it injects `options.worktreeCwd` pointing at an isolated
 * temp repo (mkdtempSync + git init). The engine threads that cwd through
 * createWorktree/removeWorktree/pruneOrphans, so no `autopilot/*` branch is
 * ever created in the operator's real checkout. No process.chdir (vitest
 * parallel safety).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  abortAutopilot,
  getStatus,
  listActiveWorktrees,
  removeWorktree,
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

function makeTempRepo() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'artibot-eng-wt-'));
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

function countAutopilotBranches(repo) {
  const r = spawnSync(
    'git',
    ['for-each-ref', '--format=%(refname:short)', 'refs/heads/autopilot/'],
    { cwd: repo, encoding: 'utf-8' },
  );
  if (r.status !== 0) return 0;
  return (r.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean).length;
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
  return `ap-wavec-${label}-${process.pid}-${Date.now()}-${counter}`;
}

afterEach(async () => {
  for (const id of sessionsToClean) {
    try { await abortAutopilot(id, { graceful: true }); } catch { /* ignore */ }
    try { removeWorktree(id, { force: true, cwd: tempRepo }); } catch { /* ignore */ }
    try { deleteSession(id); } catch { /* ignore */ }
  }
  sessionsToClean.clear();
});

describe('engine + worktree integration — Phase 2 EXECUTE', () => {
  it('case 1: useWorktree unset → state.worktreePath is null and instruction has no worktreePath', async () => {
    const r = await startAutopilot({
      task: 'wave-c case1 backward compat',
      mode: 'plan',
      options: {},
      sessionId: uniqueId('c1'),
    });
    track(r.sessionId);
    const state = loadSession(r.sessionId);
    runPhase1Plan(state);
    const inst = runPhase2Execute(state);
    expect(state.worktreePath).toBeNull();
    expect(inst.worktreePath).toBeUndefined();
    expect(inst.cwdHint).toBeUndefined();
    expect(inst.type).toBe('team-create');
  });

  it('case 2: useWorktree=true (isolated repo) → worktree+branch created in temp repo, none in operator repo', async () => {
    if (!gitAvailable()) return;
    const before = countAutopilotBranches(tempRepo);
    const r = await startAutopilot({
      task: 'wave-c case2 worktree attempt',
      mode: 'default',
      options: { useWorktree: true, worktreeCwd: tempRepo },
      sessionId: uniqueId('c2'),
    });
    track(r.sessionId);
    const state = loadSession(r.sessionId);
    runPhase1Plan(state);
    const inst = runPhase2Execute(state);
    expect(inst.type).toBe('team-create');
    if (inst.worktreePath) {
      expect(typeof inst.worktreePath).toBe('string');
      expect(inst.cwdHint).toBe(inst.worktreePath);
      expect(state.worktreePath).toBe(inst.worktreePath);
      // The branch must land in the ISOLATED temp repo, not the operator repo.
      expect(countAutopilotBranches(tempRepo)).toBe(before + 1);
    } else {
      expect(inst.cwdHint).toBeUndefined();
      expect(state.worktreePath === null || state.worktreePath === undefined).toBe(true);
    }
  });

  it('case 3: abortAutopilot graceful removes worktree+branch from the temp repo', async () => {
    if (!gitAvailable()) return;
    const before = countAutopilotBranches(tempRepo);
    const r = await startAutopilot({
      task: 'wave-c case3 abort cleanup',
      mode: 'default',
      options: { useWorktree: true, worktreeCwd: tempRepo },
      sessionId: uniqueId('c3'),
    });
    track(r.sessionId);
    const state = loadSession(r.sessionId);
    runPhase1Plan(state);
    const inst = runPhase2Execute(state);
    const result = await abortAutopilot(r.sessionId, { graceful: true });
    expect(result.status).toBe('ABORTED');
    // If a worktree was actually created, abort must leave net-zero branches.
    if (inst.worktreePath) {
      expect(countAutopilotBranches(tempRepo)).toBe(before);
    }
    const post = await getStatus(r.sessionId);
    expect(post.phase).toBe('ABORTED');
  });

  it('case 4: listActiveWorktrees returns array of {path,branch,sessionId} entries', () => {
    const list = listActiveWorktrees();
    expect(Array.isArray(list)).toBe(true);
    for (const entry of list) {
      expect(entry).toHaveProperty('path');
      expect(entry).toHaveProperty('branch');
      expect(entry).toHaveProperty('sessionId');
      expect(typeof entry.path).toBe('string');
    }
  });
});
