import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

/**
 * `resolveProjectRoot` runs inside hooks — session-ledger fires on EVERY turn —
 * so it must not spawn `git` in the common case. Measured cold cost of that
 * subprocess on the development machine was 181-270ms (median ~217, n=7), all
 * synchronous and therefore not preemptible by a caller's timeout race.
 *
 * The proof here is behavioral rather than timing-based: getRepoRoot is stubbed
 * to THROW. Any resolution that still succeeds provably never consulted git.
 */

vi.mock('../../lib/git/repo-root-cache.js', () => ({
  getRepoRoot: vi.fn(() => {
    throw new Error('getRepoRoot must not be called when a .git marker exists');
  }),
  getHeadSha: vi.fn(() => null),
  __resetForTest: vi.fn(),
}));

describe('resolveProjectRoot fast path (no git subprocess)', () => {
  let tmp;
  let repo;
  let resolveProjectRoot;

  beforeEach(async () => {
    tmp = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'artibot-fastpath-')));
    repo = path.join(tmp, 'repo');
    mkdirSync(repo, { recursive: true });
    execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore', windowsHide: true });
    ({ resolveProjectRoot } = await import('../../lib/git/project-root.js'));
  });
  afterEach(() => {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
  });

  it('resolves a nested directory without consulting git', () => {
    const nested = path.join(repo, 'plugins', 'artibot', 'scripts', 'hooks');
    mkdirSync(nested, { recursive: true });
    expect(resolveProjectRoot(nested)).toBe(repo);
  });

  it('resolves the repo root itself without consulting git', () => {
    expect(resolveProjectRoot(repo)).toBe(repo);
  });

  it('still finds a worktree/submodule root where .git is a FILE', () => {
    // Linked worktrees and submodules write `.git` as a file containing a
    // `gitdir:` pointer. rev-parse reports that directory as the toplevel, so
    // the marker walk must accept a file as readily as a directory.
    const sub = path.join(tmp, 'sub');
    const deep = path.join(sub, 'src', 'lib');
    mkdirSync(deep, { recursive: true });
    writeFileSync(path.join(sub, '.git'), 'gitdir: ../repo/.git/worktrees/sub\n', 'utf-8');
    expect(resolveProjectRoot(deep)).toBe(sub);
  });

  it('falls through to git when there is no .git marker at all', () => {
    // The stub throws, so this proves the git branch is still reachable — the
    // fast path did not swallow the fallback.
    const plain = path.join(tmp, 'plain');
    mkdirSync(plain, { recursive: true });
    expect(() => resolveProjectRoot(plain)).toThrow(/must not be called/);
  });
});
