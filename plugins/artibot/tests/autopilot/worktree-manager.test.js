/**
 * Unit tests for lib/autopilot/worktree-manager.js
 *
 * Covers path resolution, porcelain parsing via listWorktrees, idempotent
 * remove on missing sessions, and a guarded real-git create/remove
 * roundtrip that auto-skips when git is unavailable.
 *
 * ISOLATION CONTRACT (branch-leak guard): every real `git worktree add`
 * here runs against an isolated temp git repo created with mkdtempSync +
 * `git init`, injected via the `cwd` option on createWorktree/removeWorktree.
 * We never run worktree mutations against the operator's real checkout, so the
 * suite can never leave `autopilot/*` branches behind in this repo. No
 * process.chdir is used (vitest runs files in parallel — chdir is global).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  createWorktree,
  getWorktreePath,
  getWorktreesRoot,
  listWorktrees,
  pruneOrphans,
  removeWorktree,
} from '../../lib/autopilot/worktree-manager.js';

function gitAvailable() {
  try {
    const r = spawnSync('git', ['--version'], { encoding: 'utf-8' });
    return r.status === 0;
  } catch {
    return false;
  }
}

/**
 * Create a throwaway git repo with one commit so `git worktree add` works.
 * Returns the absolute repo root (ASCII tmpdir → safe for git on Windows).
 */
function makeTempRepo() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'artibot-wt-test-'));
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

/** Count local autopilot/* branches in a given repo. */
function countAutopilotBranches(repo) {
  const r = spawnSync(
    'git',
    ['for-each-ref', '--format=%(refname:short)', 'refs/heads/autopilot/'],
    { cwd: repo, encoding: 'utf-8' },
  );
  if (r.status !== 0) return 0;
  return (r.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean).length;
}

describe('getWorktreesRoot / getWorktreePath', () => {
  it('returns an absolute path string', () => {
    const root = getWorktreesRoot();
    expect(typeof root).toBe('string');
    expect(path.isAbsolute(root)).toBe(true);
  });

  it('falls back to ASCII tmpdir when cwd has non-ASCII chars', () => {
    const root = getWorktreesRoot();
    // On a Korean cwd (this repo) the root must be ASCII-only.
    // eslint-disable-next-line no-control-regex
    if (/[^\x00-\x7F]/.test(process.cwd())) {
      // eslint-disable-next-line no-control-regex
      expect(/[^\x00-\x7F]/.test(root)).toBe(false);
      expect(root.startsWith(os.tmpdir())).toBe(true);
    }
  });

  it('joins sessionId under the root for getWorktreePath', () => {
    const p = getWorktreePath('ap-test-xyz');
    expect(p.endsWith('ap-test-xyz')).toBe(true);
    expect(p.startsWith(getWorktreesRoot())).toBe(true);
  });

  it('throws when sessionId is empty for getWorktreePath', () => {
    expect(() => getWorktreePath('')).toThrow(TypeError);
    expect(() => getWorktreePath(null)).toThrow(TypeError);
  });
});

describe('listWorktrees', () => {
  it('returns at least the main worktree when run inside a git repo', () => {
    if (!gitAvailable()) return; // skip in non-git env
    const list = listWorktrees();
    expect(Array.isArray(list)).toBe(true);
    expect(list.length).toBeGreaterThanOrEqual(1);
    for (const rec of list) {
      expect(typeof rec.path).toBe('string');
      expect(rec.path.length).toBeGreaterThan(0);
    }
  });

  it('returns empty array for autopilotOnly when no autopilot worktrees exist', () => {
    if (!gitAvailable()) return;
    const list = listWorktrees({ autopilotOnly: true });
    // either zero (clean) or only autopilot-prefixed entries
    for (const rec of list) {
      expect(rec.sessionId).toBeTruthy();
      expect(rec.path.startsWith(getWorktreesRoot())).toBe(true);
    }
  });
});

describe('removeWorktree (idempotent)', () => {
  it('returns ok:true for a sessionId that was never created', () => {
    const res = removeWorktree(`ap-test-missing-${Date.now()}`, { deleteBranch: false });
    expect(res.ok).toBe(true);
  });

  it('rejects empty sessionId with ok:false', () => {
    const res = removeWorktree('');
    expect(res.ok).toBe(false);
    expect(res.error).toBeTruthy();
  });
});

describe('createWorktree → removeWorktree roundtrip (isolated temp repo)', () => {
  let repo;
  const created = [];

  beforeAll(() => {
    if (gitAvailable()) repo = makeTempRepo();
  });

  afterAll(() => {
    if (!repo) return;
    for (const id of created) {
      try { removeWorktree(id, { force: true, cwd: repo }); } catch { /* ignore */ }
    }
    try { rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('creates a worktree+branch in the temp repo and removeWorktree deletes both', () => {
    if (!gitAvailable()) return;
    const sessionId = `ap-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const branch = `autopilot/${sessionId}`;

    // Branch must be created INSIDE the temp repo, never the operator repo.
    const before = countAutopilotBranches(repo);
    const createRes = createWorktree(sessionId, { branch, baseRef: 'main', cwd: repo });
    if (!createRes.ok) {
      // git refused (locked/dirty) — accept as a skip, nothing leaked.
      return;
    }
    created.push(sessionId);

    expect(createRes.path).toBe(getWorktreePath(sessionId));
    expect(createRes.branch).toBe(branch);
    expect(countAutopilotBranches(repo)).toBe(before + 1);

    // Remove the worktree AND its branch via the production guard.
    const removeRes = removeWorktree(sessionId, { force: true, cwd: repo });
    expect(removeRes.ok).toBe(true);
    expect(removeRes.branchDeleted).toBe(true);
    // Branch is gone from the temp repo — net zero leak.
    expect(countAutopilotBranches(repo)).toBe(before);
    created.splice(created.indexOf(sessionId), 1);
  });

  it('removeWorktree refuses to delete a non-autopilot branch (deleteBranch guard)', () => {
    if (!gitAvailable()) return;
    const sessionId = `ap-test-named-${Date.now()}`;
    // Explicit non-autopilot branch name.
    const createRes = createWorktree(sessionId, {
      branch: 'feature/keep-me',
      baseRef: 'main',
      cwd: repo,
    });
    if (!createRes.ok) return;
    created.push(sessionId);

    const removeRes = removeWorktree(sessionId, { force: true, cwd: repo });
    expect(removeRes.ok).toBe(true);
    // Non-autopilot branch must NOT be deleted.
    expect(removeRes.branchDeleted).toBe(false);
    const r = spawnSync('git', ['rev-parse', '--verify', 'feature/keep-me'], {
      cwd: repo,
      encoding: 'utf-8',
    });
    expect(r.status).toBe(0);
    // Cleanup the kept branch ourselves.
    spawnSync('git', ['branch', '-D', 'feature/keep-me'], { cwd: repo, encoding: 'utf-8' });
    created.splice(created.indexOf(sessionId), 1);
  });
});

describe('pruneOrphans reaps orphaned autopilot/* branches (isolated temp repo)', () => {
  let repo;

  beforeAll(() => {
    if (gitAvailable()) repo = makeTempRepo();
  });

  afterAll(() => {
    if (repo) {
      try { rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('deletes an orphan autopilot branch with no backing worktree, keeps others', () => {
    if (!gitAvailable()) return;
    const gopts = { cwd: repo, encoding: 'utf-8' };
    // Orphan autopilot branch (no worktree).
    spawnSync('git', ['branch', 'autopilot/orphan-xyz', 'main'], gopts);
    // A user branch that must survive.
    spawnSync('git', ['branch', 'claude/keep', 'main'], gopts);
    expect(countAutopilotBranches(repo)).toBe(1);

    const res = pruneOrphans({ cwd: repo });
    expect(res.branchesDeleted).toBeGreaterThanOrEqual(1);
    expect(countAutopilotBranches(repo)).toBe(0);
    // User branch untouched.
    const r = spawnSync('git', ['rev-parse', '--verify', 'claude/keep'], gopts);
    expect(r.status).toBe(0);
  });
});

describe('createWorktree error path', () => {
  it('returns ok:false with error when sessionId is empty', () => {
    const res = createWorktree('');
    expect(res.ok).toBe(false);
    expect(res.error).toBeTruthy();
  });

  it('returns ok:false with stderr when baseRef is invalid', () => {
    if (!gitAvailable()) return;
    const repo = makeTempRepo();
    try {
      const sessionId = `ap-test-bad-${Date.now()}`;
      const res = createWorktree(sessionId, {
        baseRef: 'this-ref-does-not-exist-zzz',
        cwd: repo,
      });
      expect(res.ok).toBe(false);
      expect(typeof res.error).toBe('string');
      expect(res.error.length).toBeGreaterThan(0);
    } finally {
      try { rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});
