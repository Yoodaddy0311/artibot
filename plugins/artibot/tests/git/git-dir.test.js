/**
 * lib/git/git-dir — the module's own contract.
 *
 * ── Division of labour (read before adding a case here) ─────────────────────
 * Three files touch this module and they are not interchangeable:
 *
 *   - `tests/firewall/worktree-gitdir-resolution.test.js` asserts the *hook
 *     hazard*: a worktree's top-level `.git` is a file, the pre-fix literal
 *     join is unwritable, and hook state round-trips from both checkouts.
 *   - `tests/firewall/hooks-no-dotgit-literal.test.js` binds the hooks to this
 *     module, so `'.git'` is spelled here and nowhere in `scripts/hooks/`.
 *   - this file asserts what `getGitDir` and `gitPath` promise as *functions*,
 *     independent of who calls them.
 *
 * The resolution cases (ordinary repo, linked worktree, non-repository) appear
 * in the firewall file too. They are restated here deliberately: this is the
 * module's contract, and it must not depend on a file written about the hooks
 * continuing to exist. What is genuinely uncovered elsewhere — and the reason
 * this file earns its place — is the argument surface: a cwd that does not
 * exist, non-string inputs, and `gitPath` with zero or several segments. Every
 * existing `gitPath` call in the suite passes exactly one segment.
 *
 * ── What this file does NOT cover ──────────────────────────────────────────
 * Whether any hook is registered or fires; whether git is a particular version;
 * submodules and `.git` files outside the worktree case; and the 2s `execSync`
 * timeout, which would need a hung git to observe.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { getGitDir, gitPath } from '../../lib/git/git-dir.js';

/** @type {string} */ let repo = '';
/** @type {string} */ let worktree = '';
/** @type {string} */ let notARepo = '';
/** @type {string} */ let absent = '';

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  }).trim();
}

beforeAll(() => {
  // Temp dirs only. Nothing here may touch the user's repository — a stray
  // `worktree add` against it would show up in `git worktree list` forever.
  repo = fsSync.mkdtempSync(path.join(os.tmpdir(), 'git-dir-unit-'));
  git(['init', '-q', '-b', 'main', '.'], repo);
  git(['config', 'user.email', 'test@example.invalid'], repo);
  git(['config', 'user.name', 'test'], repo);
  fsSync.writeFileSync(path.join(repo, 'seed.txt'), 'seed\n', 'utf-8');
  git(['add', 'seed.txt'], repo);
  git(['commit', '-qm', 'init'], repo);

  worktree = path.join(repo, 'linked-wt');
  git(['worktree', 'add', '-q', worktree, '-b', 'wt-branch'], repo);

  notARepo = fsSync.mkdtempSync(path.join(os.tmpdir(), 'git-dir-bare-'));
  // Never created. `execSync` fails to spawn at all with this cwd, which is a
  // different failure from "spawned, and git said no".
  absent = path.join(os.tmpdir(), `git-dir-absent-${process.pid}-${Date.now()}`);
});

afterAll(() => {
  for (const dir of [repo, notARepo]) {
    try { fsSync.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

describe('getGitDir', () => {
  it('resolves an ordinary checkout to its own .git directory', () => {
    const dir = getGitDir(repo);
    expect(dir).not.toBeNull();
    expect(path.basename(dir)).toBe('.git');
    expect(fsSync.statSync(dir).isDirectory()).toBe(true);
  });

  it('resolves a linked worktree to the per-worktree git dir under the main repo', () => {
    const dir = getGitDir(worktree);
    expect(dir).not.toBeNull();
    expect(fsSync.statSync(dir).isDirectory()).toBe(true);
    expect(dir.replace(/\\/g, '/')).toContain('/worktrees/');
    expect(path.basename(dir)).toBe('linked-wt');
    // The defect this module exists to prevent.
    expect(path.resolve(dir)).not.toBe(path.resolve(worktree, '.git'));
  });

  it('returns an absolute path from both repository shapes', () => {
    expect(path.isAbsolute(getGitDir(repo))).toBe(true);
    expect(path.isAbsolute(getGitDir(worktree))).toBe(true);
  });

  it('gives the two checkouts distinct git dirs', () => {
    expect(getGitDir(repo)).not.toBe(getGitDir(worktree));
  });

  it('returns null, without throwing, for a directory that is not a repository', () => {
    expect(() => getGitDir(notARepo)).not.toThrow();
    expect(getGitDir(notARepo)).toBeNull();
  });

  it('returns null, without throwing, for a cwd that does not exist', () => {
    // Distinct from the case above: the child process cannot be spawned at all,
    // so the failure arrives as a spawn error rather than a git exit code.
    expect(fsSync.existsSync(absent)).toBe(false);
    expect(() => getGitDir(absent)).not.toThrow();
    expect(getGitDir(absent)).toBeNull();
  });

  it('rejects non-string input instead of inheriting the process cwd', () => {
    // `null`/`undefined` matter most: without the type guard they reach
    // execSync as "no cwd given", which silently resolves against the process
    // cwd — this test suite's own repository — and returns a real git dir for
    // an argument that named no repository at all.
    for (const bad of [null, undefined, '', 0, 42, {}, [], true]) {
      expect(getGitDir(bad), `input=${JSON.stringify(bad) ?? String(bad)}`).toBeNull();
    }
  });
});

describe('gitPath', () => {
  it('joins segments under the resolved git dir in an ordinary checkout', () => {
    expect(gitPath(repo, 'autopilot.json'))
      .toBe(path.join(getGitDir(repo), 'autopilot.json'));
  });

  it('joins under the per-worktree git dir, never under <worktree>/.git', () => {
    const p = gitPath(worktree, 'autopilot.json');
    expect(p).toBe(path.join(getGitDir(worktree), 'autopilot.json'));
    expect(p.replace(/\\/g, '/')).toContain('/worktrees/');
    expect(p).not.toBe(path.join(worktree, '.git', 'autopilot.json'));
  });

  it('returns the git dir itself when given no segments', () => {
    expect(gitPath(repo)).toBe(getGitDir(repo));
    expect(gitPath(worktree)).toBe(getGitDir(worktree));
  });

  it('nests several segments in order', () => {
    expect(gitPath(repo, 'artibot', 'state', 'phase.json'))
      .toBe(path.join(getGitDir(repo), 'artibot', 'state', 'phase.json'));
  });

  it('falls back to <root>/.git when the git dir cannot be resolved', () => {
    // Reproduces the pre-module behavior exactly: in a non-repository that path
    // does not exist either way, so a caller's existsSync check still fails and
    // the hook still skips. The point is only that no hook spells '.git'.
    expect(gitPath(notARepo, 'autopilot.json'))
      .toBe(path.join(notARepo, '.git', 'autopilot.json'));
    expect(gitPath(absent, 'a', 'b'))
      .toBe(path.join(absent, '.git', 'a', 'b'));
  });

  it('falls back with no segments too', () => {
    expect(gitPath(notARepo)).toBe(path.join(notARepo, '.git'));
  });
});
