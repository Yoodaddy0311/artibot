/**
 * Unit tests for lib/autopilot/engine.js
 * Covers startAutopilot, resumeAutopilot, getStatus, abortAutopilot, PHASES,
 * and the public Phase runner functions.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  abortAutopilot,
  getStatus,
  PHASES,
  resumeAutopilot,
  runPhase0Intake,
  runPhase1Plan,
  runPhase6Report,
  startAutopilot,
} from '../../lib/autopilot/index.js';
import { deleteSessionArtifacts, loadSession } from '../../lib/autopilot/session-store.js';
import { getLockPath, readLock, releaseLock } from '../../lib/autopilot/lock.js';
import { getRepoIdentity } from '../../lib/git/repo-identity.js';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { extractKey } from '../../lib/autopilot/memory.js';

// ARTIFACT ISOLATION CONTRACT (mirrors the branch-leak guard in
// engine.execute-worktree.test.js): every engine entry writes a PRD
// (lib/autopilot/prd-generator.js#generatePRD) and a completion report
// (lib/autopilot/report-generator.js#generateReport) under <projectRoot>/.
// Without an explicit override those default to the real repo root, so each
// test run left stray files in the operator's docs/PRD/ and reports/AUTOPILOT/.
// options.projectRoot redirects both writers into a tmpdir.
let ARTIFACT_ROOT = '';

beforeAll(() => {
  ARTIFACT_ROOT = mkdtempSync(path.join(os.tmpdir(), 'artibot-engine-artifacts-'));
});

afterAll(() => {
  try { rmSync(ARTIFACT_ROOT, { recursive: true, force: true }); } catch { /* best-effort */ }
});

/**
 * startAutopilot with the artifact-isolation override applied.
 * @param {object} args - Same shape as startAutopilot.
 * @returns {Promise<object>}
 */
function start(args) {
  return startAutopilot({
    ...args,
    options: { ...(args.options || {}), projectRoot: ARTIFACT_ROOT },
  });
}

const cleanupIds = new Set();
function track(id) {
  if (id) cleanupIds.add(id);
  return id;
}

afterEach(() => {
  for (const id of cleanupIds) {
    try { deleteSessionArtifacts(id); } catch { /* ignore */ }
  }
  cleanupIds.clear();
});

describe('PHASES constant', () => {
  it('exposes 8 phases in order INTAKE→REPORT (v4.6.0 inserted EVALUATE between IMPROVE and REPORT)', () => {
    expect(Array.isArray(PHASES)).toBe(true);
    expect(PHASES).toEqual([
      'INTAKE', 'PLAN', 'EXECUTE', 'CROSS_CHECK', 'VERIFY', 'IMPROVE', 'EVALUATE', 'REPORT',
    ]);
  });
});

describe('startAutopilot', () => {
  it('throws TypeError when task is missing', async () => {
    await expect(startAutopilot({})).rejects.toThrow(TypeError);
  });

  it('throws TypeError when task is non-string', async () => {
    await expect(startAutopilot({ task: 42 })).rejects.toThrow(TypeError);
  });

  it('returns object with sessionId, prdPath, phase, instruction (P0-1 fix)', async () => {
    const r = await start({ task: 'engine test 표준 진입', mode: 'plan' });
    track(r.sessionId);
    expect(r.sessionId).toMatch(/^ap-\d{8}-\d{6}/);
    expect(typeof r.prdPath).toBe('string');
    expect(r.prdPath.length).toBeGreaterThan(0);
    expect(typeof r.phase).toBe('string');
    expect(r.instruction).toBeTruthy();
    expect(typeof r.instruction).toBe('object');
  });

  it('plan mode stops at INTAKE phase', async () => {
    const r = await start({ task: 'plan-mode 정지 검증', mode: 'plan' });
    track(r.sessionId);
    expect(r.phase).toBe('INTAKE');
  });

  it('default mode also initializes at INTAKE (Phase 0 first)', async () => {
    const r = await start({ task: 'default 모드 초기화', mode: 'default' });
    track(r.sessionId);
    expect(r.phase).toBe('INTAKE');
    expect(r.instruction.type).toBeTruthy();
  });

  it('persists session retrievable via getStatus', async () => {
    const r = await start({ task: '세션 영속화 검증', mode: 'plan' });
    track(r.sessionId);
    const status = await getStatus(r.sessionId);
    expect(status).toBeTruthy();
    expect(status.sessionId).toBe(r.sessionId);
    expect(status.task).toContain('세션 영속화');
    expect(status.mode).toBe('plan');
  });
});

describe('getStatus', () => {
  it('returns null for unknown sessionId', async () => {
    const result = await getStatus('ap-19990101-000000-doesnotexist');
    expect(result).toBeNull();
  });

  it('returns the most recent session when sessionId is omitted', async () => {
    const r = await start({ task: 'most-recent 픽업', mode: 'plan' });
    track(r.sessionId);
    const recent = await getStatus();
    expect(recent).toBeTruthy();
    expect(typeof recent.sessionId).toBe('string');
  });
});

describe('abortAutopilot', () => {
  it('marks session ABORTED and emits reportPath when graceful', async () => {
    const r = await start({ task: 'abort graceful', mode: 'plan' });
    track(r.sessionId);
    const a = await abortAutopilot(r.sessionId, { graceful: true });
    expect(a.sessionId).toBe(r.sessionId);
    expect(a.status).toBe('ABORTED');
    expect(typeof a.reportPath).toBe('string');
    expect(a.reportPath.length).toBeGreaterThan(0);
  });

  it('throws when sessionId missing', async () => {
    await expect(abortAutopilot()).rejects.toThrow();
  });
});

describe('resumeAutopilot', () => {
  it('throws when sessionId missing', async () => {
    await expect(resumeAutopilot()).rejects.toThrow(TypeError);
  });

  it('throws when session not found', async () => {
    await expect(
      resumeAutopilot('ap-19990101-000000-missing'),
    ).rejects.toThrow(/session not found/);
  });

  it('returns noop for COMPLETED sessions', async () => {
    const r = await start({ task: 'completed noop', mode: 'plan' });
    track(r.sessionId);
    await abortAutopilot(r.sessionId, { graceful: true });
    // After abort, session is ABORTED — resume should return noop status.
    const out = await resumeAutopilot(r.sessionId);
    expect(out.status).toBe('noop');
  });

  it('returns paused when featureKey lock is held by a different session (F4)', async () => {
    const task = 'F4 lock contention scenario A';
    const r = await start({ task, mode: 'plan' });
    track(r.sessionId);
    // Simulate a competing live session holding the same featureKey lock by
    // releasing the original holder and writing a fresh lock under a new
    // sessionId from the *current* process (so isStale returns false).
    const featureKey = extractKey(task);
    releaseLock(featureKey, r.sessionId);
    const { acquireLock } = await import('../../lib/autopilot/lock.js');
    const competitorId = 'ap-competitor-19990101-000000';
    const acquired = acquireLock(featureKey, competitorId);
    expect(acquired.ok).toBe(true);
    try {
      const out = await resumeAutopilot(r.sessionId);
      expect(out.status).toBe('paused');
      expect(out.instruction?.reason).toMatch(/lock-held-by-/);
    } finally {
      releaseLock(featureKey, competitorId);
    }
  });

  it('proceeds when featureKey lock is already held by the same session (F4)', async () => {
    const task = 'F4 lock self-recovery scenario B';
    const r = await start({ task, mode: 'plan' });
    track(r.sessionId);
    // The lock is still held by r.sessionId from startAutopilot. Resume should
    // recognize it's our own and proceed without pausing.
    const out = await resumeAutopilot(r.sessionId);
    expect(out.status).not.toBe('paused');
  });
});

describe('Phase runner functions return instruction objects', () => {
  it('runPhase0Intake returns object with type field', async () => {
    const r = await start({ task: 'phase0 inst 검증', mode: 'plan' });
    track(r.sessionId);
    const state = await getStatus(r.sessionId);
    const inst = runPhase0Intake(state);
    expect(inst).toBeTruthy();
    expect(typeof inst.type).toBe('string');
  });

  it('runPhase1Plan returns object with type field', async () => {
    const r = await start({ task: 'phase1 inst 검증', mode: 'default' });
    track(r.sessionId);
    const state = await getStatus(r.sessionId);
    const inst = runPhase1Plan(state);
    expect(inst).toBeTruthy();
    expect(typeof inst.type).toBe('string');
  });

  it('runPhase6Report returns object with type=phase-result and reportPath', async () => {
    const r = await start({ task: 'phase6 report 산출', mode: 'default' });
    track(r.sessionId);
    const state = await getStatus(r.sessionId);
    const inst = runPhase6Report(state);
    expect(inst).toBeTruthy();
    expect(inst.type).toBe('phase-result');
    expect(typeof inst.reportPath).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// D-2 lock-collision regression (Phase 2c P0 fix)
// ---------------------------------------------------------------------------
describe('startAutopilot — feature lock collision (D-2)', () => {
  // Use a deterministic but uncommon task so the featureKey is stable across
  // the two calls within this single describe block.
  const collisionTask = `lock-collision-regression-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const collisionKey = extractKey(collisionTask);

  afterEach(() => {
    // Best-effort: remove the lock file even if the test failed mid-way.
    try {
      const lockPath = getLockPath(collisionKey);
      if (existsSync(lockPath)) unlinkSync(lockPath);
    } catch {
      /* cleanup best-effort */
    }
  });

  it('first startAutopilot acquires the lock; second on the same task pauses with lock-held-by reason', async () => {
    const a = await start({ task: collisionTask, mode: 'plan' });
    track(a.sessionId);
    expect(a.paused).not.toBe(true);
    expect(a.phase).toBe('INTAKE');

    const b = await start({ task: collisionTask, mode: 'plan' });
    track(b.sessionId);
    expect(b.paused).toBe(true);
    expect(b.phase).toBe('PAUSED');
    expect(b.reason).toMatch(/^lock-held-by-/);
    // The instruction returned must be a pause directive (not a phase result).
    expect(b.instruction).toBeTruthy();
    expect(b.instruction.type).toBe('pause');

    // Release explicitly so subsequent suites are not affected.
    releaseLock(collisionKey, a.sessionId);
  });

  it('after release, a third startAutopilot for the same featureKey acquires successfully', async () => {
    const a = await start({ task: collisionTask, mode: 'plan' });
    track(a.sessionId);
    expect(a.paused).not.toBe(true);

    // Release manually to mirror what completion / abort would do.
    expect(releaseLock(collisionKey, a.sessionId)).toBe(true);

    const c = await start({ task: collisionTask, mode: 'plan' });
    track(c.sessionId);
    expect(c.paused).not.toBe(true);
    expect(c.phase).toBe('INTAKE');

    // Cleanup the lock for the third session.
    releaseLock(collisionKey, c.sessionId);
  });
});

// Every test above runs with projectRoot = a plain tmpdir (no git), so the
// engine resolves NO repo identity and keys the lock the legacy way — which is
// exactly why those tests keep passing unchanged. This block is the one place
// the scoped path is exercised end to end: a temp git repo with a remote.
describe('startAutopilot — repo-scoped feature lock wiring', () => {
  let repoRoot = '';

  function git(args) {
    execFileSync('git', args, { cwd: repoRoot, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  }

  beforeAll(() => {
    repoRoot = mkdtempSync(path.join(os.tmpdir(), 'artibot-engine-lockscope-'));
    git(['init', '-q', '-b', 'main', '.']);
    git(['config', 'user.email', 'test@example.invalid']);
    git(['config', 'user.name', 'test']);
    git(['remote', 'add', 'origin', 'https://github.com/Example/Lock-Scope.git']);
    writeFileSync(path.join(repoRoot, 'seed.txt'), 'seed\n', 'utf-8');
    git(['add', 'seed.txt']);
    git(['commit', '-qm', 'init']);
  });

  afterAll(() => {
    try { rmSync(repoRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('acquires under ${repoIdentity}__${featureKey}, pins the scope on state, and abort releases that same file', async () => {
    const task = 'lock scope wiring assertion';
    const featureKey = extractKey(task);
    const repoIdentity = getRepoIdentity(repoRoot);
    expect(repoIdentity).toBe('example/lock-scope');

    const r = await startAutopilot({ task, mode: 'plan', options: { projectRoot: repoRoot } });
    track(r.sessionId);
    expect(r.paused).not.toBe(true);

    const scopedPath = getLockPath(featureKey, { repoIdentity });
    expect(r.sessionId && existsSync(scopedPath)).toBe(true);
    expect(existsSync(getLockPath(featureKey))).toBe(false); // no legacy file written
    expect(readLock(featureKey, { repoIdentity })).toMatchObject({
      sessionId: r.sessionId, featureKey, repoIdentity, cwd: repoRoot,
    });
    expect(loadSession(r.sessionId).lockScope).toEqual({ repoIdentity, cwd: repoRoot });

    // An unscoped release cannot find it; the engine's own abort path does.
    expect(releaseLock(featureKey, r.sessionId)).toBe(false);
    await abortAutopilot(r.sessionId, { graceful: false });
    expect(existsSync(scopedPath)).toBe(false);
  });

  it('a second start in the same repo on the same task pauses; a tmpdir start on the same task does not', async () => {
    const task = 'lock scope collision assertion';
    const featureKey = extractKey(task);
    const repoIdentity = getRepoIdentity(repoRoot);

    const a = await startAutopilot({ task, mode: 'plan', options: { projectRoot: repoRoot } });
    track(a.sessionId);
    const b = await startAutopilot({ task, mode: 'plan', options: { projectRoot: repoRoot } });
    track(b.sessionId);
    // No git under ARTIFACT_ROOT → legacy key → a different file → no collision.
    const c = await start({ task, mode: 'plan' });
    track(c.sessionId);
    try {
      expect(a.paused).not.toBe(true);
      expect(b.paused).toBe(true);
      expect(b.reason).toBe(`lock-held-by-${a.sessionId}`);
      expect(c.paused).not.toBe(true);
    } finally {
      releaseLock(featureKey, a.sessionId, { repoIdentity });
      releaseLock(featureKey, c.sessionId);
    }
  });
});
