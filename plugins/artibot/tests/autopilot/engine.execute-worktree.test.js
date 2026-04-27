/**
 * Integration tests for autopilot engine + worktree-manager wiring (Wave C).
 * Validates Phase 2 EXECUTE worktree branching, abort cleanup, and the
 * listActiveWorktrees export. Real git calls are tolerated to either succeed
 * or gracefully fall back; both branches are accepted as healthy outcomes.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  abortAutopilot,
  getStatus,
  listActiveWorktrees,
  listWorktrees,
  removeWorktree,
  runPhase1Plan,
  runPhase2Execute,
  startAutopilot,
} from '../../lib/autopilot/index.js';
import { deleteSession, loadSession } from '../../lib/autopilot/session-store.js';

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
    try { removeWorktree(id, { force: true }); } catch { /* ignore */ }
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

  it('case 2: useWorktree=true → either real worktree created OR graceful fallback (no throw)', async () => {
    const r = await startAutopilot({
      task: 'wave-c case2 worktree attempt',
      mode: 'default',
      options: { useWorktree: true },
      sessionId: uniqueId('c2'),
    });
    track(r.sessionId);
    const state = loadSession(r.sessionId);
    runPhase1Plan(state);
    // Phase 2 must not throw regardless of git worktree creation outcome.
    const inst = runPhase2Execute(state);
    expect(inst.type).toBe('team-create');
    // Either path acceptable — instruction shape stays consistent with state.
    if (inst.worktreePath) {
      expect(typeof inst.worktreePath).toBe('string');
      expect(inst.cwdHint).toBe(inst.worktreePath);
      expect(state.worktreePath).toBe(inst.worktreePath);
    } else {
      expect(inst.cwdHint).toBeUndefined();
      expect(state.worktreePath === null || state.worktreePath === undefined).toBe(true);
    }
  });

  it('case 3: abortAutopilot graceful cleans up worktree from active list', async () => {
    const r = await startAutopilot({
      task: 'wave-c case3 abort cleanup',
      mode: 'default',
      options: { useWorktree: true },
      sessionId: uniqueId('c3'),
    });
    track(r.sessionId);
    const state = loadSession(r.sessionId);
    runPhase1Plan(state);
    runPhase2Execute(state);
    const result = await abortAutopilot(r.sessionId, { graceful: true });
    expect(result.status).toBe('ABORTED');
    const remaining = listWorktrees({ autopilotOnly: true });
    const stillThere = remaining.some((w) => w.sessionId === r.sessionId);
    expect(stillThere).toBe(false);
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
