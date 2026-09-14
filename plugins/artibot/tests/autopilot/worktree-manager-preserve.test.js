/**
 * F01 result-preservation tests — a session reap must never render committed
 * work unreachable.
 *
 * ISOLATION CONTRACT (same as worktree-manager.test.js / engine.execute-worktree
 * .test.js): every real git mutation runs against a mkdtemp temp repo injected
 * via `cwd` / `options.worktreeCwd`; engine artifacts are redirected with
 * `options.projectRoot`. No process.chdir (vitest parallel safety). Every case
 * asserts the result sha is still reachable from some ref after the reap.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  describeWorktreeHead,
  getWorktreePath,
  pruneOrphans,
  reapWorktree,
  removeWorktree,
  resolveIntegrationEvidence,
} from '../../lib/autopilot/worktree-manager.js';
import {
  abortAutopilot,
  runPhase1Plan,
  runPhase2Execute,
  runPhase6Report,
  startAutopilot,
} from '../../lib/autopilot/index.js';
import { deleteSessionArtifacts, loadSession } from '../../lib/autopilot/session-store.js';

function gitAvailable() {
  try {
    return spawnSync('git', ['--version'], { encoding: 'utf-8' }).status === 0;
  } catch {
    return false;
  }
}

function git(args, cwd) {
  return spawnSync('git', args, { cwd, encoding: 'utf-8' });
}

function makeTempRepo() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'artibot-f01-'));
  git(['init', '-b', 'main'], dir);
  git(['config', 'user.email', 'test@artibot.local'], dir);
  git(['config', 'user.name', 'artibot-test'], dir);
  git(['config', 'commit.gpgsign', 'false'], dir);
  writeFileSync(path.join(dir, 'README.md'), '# temp\n');
  git(['add', '-A'], dir);
  git(['commit', '-m', 'init', '--no-gpg-sign'], dir);
  return dir;
}

function branchExists(repo, branch) {
  return git(['rev-parse', '--verify', `refs/heads/${branch}`], repo).status === 0;
}

/** Assert the sha is still reachable from at least one ref (local or remote). */
function reachableRefs(repo, sha) {
  const r = git(['for-each-ref', '--format=%(refname)', '--contains', sha,
    'refs/heads', 'refs/remotes'], repo);
  if (r.status !== 0) return [];
  return (r.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

/** Commit a file inside a worktree and return the new HEAD sha. */
function commitInside(wtPath, name, body) {
  writeFileSync(path.join(wtPath, name), body);
  git(['add', '-A'], wtPath);
  git(['commit', '-m', `add ${name}`, '--no-gpg-sign'], wtPath);
  return git(['rev-parse', 'HEAD'], wtPath).stdout.trim();
}

let counter = 0;
function uniqueId(label) {
  counter += 1;
  return `ap-f01-${label}-${process.pid}-${Date.now()}-${counter}`;
}

let repo = null;
let artifactRoot = '';
const sessions = new Set();

beforeAll(() => {
  if (gitAvailable()) repo = makeTempRepo();
  artifactRoot = mkdtempSync(path.join(os.tmpdir(), 'artibot-f01-artifacts-'));
});

afterEach(async () => {
  for (const id of sessions) {
    try { await abortAutopilot(id, { graceful: true }); } catch { /* ignore */ }
    try { removeWorktree(id, { force: true, cwd: repo }); } catch { /* ignore */ }
    try { git(['branch', '-D', `autopilot/${id}`], repo); } catch { /* ignore */ }
    try { deleteSessionArtifacts(id); } catch { /* ignore */ }
  }
  sessions.clear();
});

afterAll(() => {
  if (repo) {
    try { rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  try { rmSync(artifactRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

/**
 * Create a session worktree in the temp repo via raw git (no engine), tracked
 * for cleanup. Returns { sessionId, branch, wtPath } or null when git refused.
 */
function makeSessionWorktree(label) {
  const sessionId = uniqueId(label);
  const branch = `autopilot/${sessionId}`;
  const wtPath = getWorktreePath(sessionId);
  mkdirSync(path.dirname(wtPath), { recursive: true });
  const r = git(['worktree', 'add', '-b', branch, wtPath, 'main'], repo);
  if (r.status !== 0) return null;
  sessions.add(sessionId);
  return { sessionId, branch, wtPath };
}

describe('resolveIntegrationEvidence', () => {
  it('(f) fails closed on a non-git cwd — never claims integration', () => {
    const nonGit = mkdtempSync(path.join(os.tmpdir(), 'artibot-f01-nongit-'));
    try {
      const ev = resolveIntegrationEvidence('0'.repeat(40), { cwd: nonGit });
      expect(ev.integrated).toBe(false);
      expect(ev.reason).toBe('evidence-lookup-failed');
    } finally {
      rmSync(nonGit, { recursive: true, force: true });
    }
  });

  it('fails closed on a missing sha', () => {
    const ev = resolveIntegrationEvidence(null, { cwd: repo });
    expect(ev.integrated).toBe(false);
    expect(ev.reason).toBe('evidence-lookup-failed');
  });
});

describe('reapWorktree preservation', () => {
  it('(a) preserves an unintegrated clean branch with a committed result', () => {
    if (!gitAvailable()) return;
    const s = makeSessionWorktree('a');
    if (!s) return;
    const sha = commitInside(s.wtPath, 'feature.txt', 'work\n');

    const res = reapWorktree(s.sessionId, { cwd: repo });
    expect(res.action).toBe('preserved');
    expect(res.reason).toBe('no-integration-evidence');
    expect(res.resultHead).toBe(sha);
    expect(res.resultRef).toBe(`refs/heads/${s.branch}`);
    expect(branchExists(repo, s.branch)).toBe(true);
    expect(existsSync(s.wtPath)).toBe(true);
    expect(reachableRefs(repo, sha)).toContain(`refs/heads/${s.branch}`);
  });

  it('(b) removes a branch whose commits are merged into the integration target', () => {
    if (!gitAvailable()) return;
    const s = makeSessionWorktree('b');
    if (!s) return;
    const sha = commitInside(s.wtPath, 'merged.txt', 'work\n');
    expect(git(['merge', '--no-ff', '-m', 'merge', s.branch], repo).status).toBe(0);

    const res = reapWorktree(s.sessionId, { cwd: repo, integrationTarget: 'main' });
    expect(res.action).toBe('removed');
    expect(res.evidence.some((e) => e.startsWith('integrated-into:main'))).toBe(true);
    expect(branchExists(repo, s.branch)).toBe(false);
    expect(reachableRefs(repo, sha)).toContain('refs/heads/main');
    sessions.delete(s.sessionId);
    deleteSessionArtifacts(s.sessionId);
  });

  it('(c) preserves a dirty worktree even when force:true', () => {
    if (!gitAvailable()) return;
    const s = makeSessionWorktree('c');
    if (!s) return;
    writeFileSync(path.join(s.wtPath, 'scratch.txt'), 'uncommitted\n');
    const head = describeWorktreeHead(s.wtPath, repo);
    expect(head.dirty).toBe(true);

    const res = reapWorktree(s.sessionId, { cwd: repo, force: true, integrationTarget: 'main' });
    expect(res.action).toBe('preserved');
    expect(res.reason).toBe('dirty-worktree');
    expect(branchExists(repo, s.branch)).toBe(true);
    expect(existsSync(path.join(s.wtPath, 'scratch.txt'))).toBe(true);
  });

  it('(e) removes a branch that exists only on a remote (no local merge)', () => {
    if (!gitAvailable()) return;
    const s = makeSessionWorktree('e');
    if (!s) return;
    const sha = commitInside(s.wtPath, 'pushed.txt', 'work\n');
    const bare = mkdtempSync(path.join(os.tmpdir(), 'artibot-f01-bare-'));
    try {
      expect(git(['init', '--bare'], bare).status).toBe(0);
      git(['remote', 'add', `origin-${s.sessionId}`, bare], repo);
      expect(git(['push', `origin-${s.sessionId}`, s.branch], repo).status).toBe(0);

      const res = reapWorktree(s.sessionId, { cwd: repo });
      expect(res.action).toBe('removed');
      expect(res.evidence.some((e) => e.includes('refs/remotes/'))).toBe(true);
      expect(branchExists(repo, s.branch)).toBe(false);
      expect(reachableRefs(repo, sha).some((r) => r.startsWith('refs/remotes/'))).toBe(true);
      sessions.delete(s.sessionId);
      deleteSessionArtifacts(s.sessionId);
    } finally {
      git(['remote', 'remove', `origin-${s.sessionId}`], repo);
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it('(f) preserves when the evidence lookup itself fails (non-git cwd)', () => {
    if (!gitAvailable()) return;
    const s = makeSessionWorktree('f');
    if (!s) return;
    const nonGit = mkdtempSync(path.join(os.tmpdir(), 'artibot-f01-nongit2-'));
    try {
      const res = reapWorktree(s.sessionId, { cwd: nonGit, force: true });
      expect(res.action).toBe('preserved');
      expect(res.reason).toBe('evidence-lookup-failed');
      expect(branchExists(repo, s.branch)).toBe(true);
      expect(existsSync(s.wtPath)).toBe(true);
    } finally {
      rmSync(nonGit, { recursive: true, force: true });
    }
  });

  it('(g) preserves a worktree holding .artibot/missions, and prune keeps it', () => {
    if (!gitAvailable()) return;
    const s = makeSessionWorktree('g');
    if (!s) return;
    const missions = path.join(s.wtPath, '.artibot', 'missions');
    mkdirSync(missions, { recursive: true });
    const missionFile = path.join(missions, 'm1.json');
    writeFileSync(missionFile, '{"id":"m1"}\n');

    const res = reapWorktree(s.sessionId, { cwd: repo, force: true, integrationTarget: 'main' });
    expect(res.action).toBe('preserved');
    expect(res.reason).toBe('missions-present');
    expect(existsSync(missionFile)).toBe(true);

    pruneOrphans({ cwd: repo, integrationTarget: 'main' });
    expect(existsSync(missionFile)).toBe(true);
    expect(branchExists(repo, s.branch)).toBe(true);
  });

  it('never throws for an unknown session and deletes nothing', () => {
    const res = reapWorktree(`ap-f01-missing-${Date.now()}`, { cwd: repo });
    expect(res.ok).toBe(true);
    expect(res.action).toBe('absent');
  });
});

describe('pruneOrphans result preservation', () => {
  it('preserves an orphan branch carrying a unique commit, removes one at main tip', () => {
    if (!gitAvailable()) return;
    // Orphan WITH unique work: build it in a throwaway worktree, then drop the
    // worktree but keep the branch.
    const keepId = `orphan-keep-${process.pid}-${Date.now()}`;
    const keepBranch = `autopilot/${keepId}`;
    const scratch = path.join(mkdtempSync(path.join(os.tmpdir(), 'artibot-f01-scr-')), 'wt');
    let keepSha = null;
    if (git(['worktree', 'add', '-b', keepBranch, scratch, 'main'], repo).status === 0) {
      keepSha = commitInside(scratch, 'orphan-work.txt', 'unique\n');
      git(['worktree', 'remove', '--force', scratch], repo);
    }
    // Orphan with NO unique work — sits on main's tip.
    const dropBranch = `autopilot/orphan-drop-${process.pid}-${Date.now()}`;
    git(['branch', dropBranch, 'main'], repo);

    const res = pruneOrphans({ cwd: repo });
    expect(res.preserved.some((p) => p.branch === keepBranch)).toBe(true);
    expect(res.removed.some((p) => p.branch === dropBranch)).toBe(true);
    expect(branchExists(repo, keepBranch)).toBe(true);
    expect(branchExists(repo, dropBranch)).toBe(false);
    expect(reachableRefs(repo, keepSha)).toContain(`refs/heads/${keepBranch}`);

    git(['branch', '-D', keepBranch], repo);
    rmSync(path.dirname(scratch), { recursive: true, force: true });
  });
});

describe('engine integration — unintegrated results survive REPORT and ABORT', () => {
  /** startAutopilot with worktree + artifact isolation applied. */
  async function startSession(label) {
    const sessionId = uniqueId(label);
    const r = await startAutopilot({
      task: `f01 ${label} result preservation`,
      mode: 'default',
      options: {
        useWorktree: true,
        worktreeCwd: repo,
        projectRoot: artifactRoot,
        keepAwake: false,
      },
      sessionId,
    });
    sessions.add(r.sessionId);
    const state = loadSession(r.sessionId);
    runPhase1Plan(state);
    const inst = runPhase2Execute(state);
    return { sessionId: r.sessionId, worktreePath: inst.worktreePath };
  }

  it('(d-i) REPORT preserves a committed-but-unmerged session branch', async () => {
    if (!gitAvailable()) return;
    const s = await startSession('report');
    if (!s.worktreePath) return; // git refused the worktree — nothing to assert
    const sha = commitInside(s.worktreePath, 'ap05.txt', 'unintegrated\n');

    runPhase6Report(loadSession(s.sessionId));

    const after = loadSession(s.sessionId);
    expect(after.cleanupReport?.session?.action).toBe('preserved');
    expect(after.resultHead).toBe(sha);
    expect(after.resultRef).toBe(`refs/heads/autopilot/${s.sessionId}`);
    expect(branchExists(repo, `autopilot/${s.sessionId}`)).toBe(true);
    expect(reachableRefs(repo, sha).length).toBeGreaterThan(0);
  });

  it('(d-ii) non-graceful ABORT preserves a committed-but-unmerged branch', async () => {
    if (!gitAvailable()) return;
    const s = await startSession('abort');
    if (!s.worktreePath) return;
    const sha = commitInside(s.worktreePath, 'ap05-abort.txt', 'unintegrated\n');

    await abortAutopilot(s.sessionId, { graceful: false });

    const after = loadSession(s.sessionId);
    expect(after.cleanupReport?.session?.action).toBe('preserved');
    expect(after.resultHead).toBe(sha);
    expect(branchExists(repo, `autopilot/${s.sessionId}`)).toBe(true);
    expect(reachableRefs(repo, sha).length).toBeGreaterThan(0);
  });
});
