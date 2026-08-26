/**
 * Firewall — git directory resolution must survive linked worktrees.
 *
 * In a linked worktree the top-level `.git` is a FILE holding `gitdir: <path>`,
 * not a directory. `path.join(worktreeRoot, '.git', 'autopilot.json')` therefore
 * names a path under a regular file: writes fail with ENOTDIR and reads find
 * nothing. Every autopilot hook stored its state that way, so a session started
 * inside a worktree silently lost its config and phase state.
 *
 * These tests pin the resolver the hooks now share (`lib/git/git-dir.js`) to the
 * behavior that fixes it: state written through `gitPath` round-trips from BOTH
 * the main checkout and a linked worktree, and the two get separate git dirs.
 *
 * Scope, stated plainly: this exercises the shared resolver, not each hook's
 * private read path — the hooks export only `main()`, which cannot be driven
 * without a full hook event. `hooks-no-dotgit-literal.test.js` is what binds the
 * hooks to this resolver; neither test proves a hook is registered or fires.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getGitDir, gitPath } from '../../lib/git/git-dir.js';

let repo = '';
let worktree = '';

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  }).trim();
}

beforeAll(() => {
  // Temp dir only — never the user's repository.
  repo = fsSync.mkdtempSync(path.join(os.tmpdir(), 'artibot-gitdir-'));
  git(['init', '-q', '-b', 'main', '.'], repo);
  git(['config', 'user.email', 'test@example.invalid'], repo);
  git(['config', 'user.name', 'test'], repo);
  fsSync.writeFileSync(path.join(repo, 'seed.txt'), 'seed\n', 'utf-8');
  git(['add', 'seed.txt'], repo);
  git(['commit', '-qm', 'init'], repo);

  worktree = path.join(repo, 'linked-wt');
  git(['worktree', 'add', '-q', worktree, '-b', 'wt-branch'], repo);
});

afterAll(() => {
  try {
    fsSync.rmSync(repo, { recursive: true, force: true });
  } catch { /* best effort */ }
});

describe('git directory resolution across worktrees', () => {
  it('confirms the hazard: a worktree top-level .git is a file, not a directory', () => {
    const topLevel = path.join(worktree, '.git');
    expect(fsSync.existsSync(topLevel)).toBe(true);
    expect(fsSync.statSync(topLevel).isDirectory()).toBe(false);
    expect(fsSync.readFileSync(topLevel, 'utf-8')).toMatch(/^gitdir: /);
  });

  it('resolves the main checkout to its own .git directory', () => {
    const dir = getGitDir(repo);
    expect(dir).not.toBeNull();
    expect(fsSync.statSync(dir).isDirectory()).toBe(true);
    expect(path.basename(dir)).toBe('.git');
  });

  it('resolves a linked worktree to its per-worktree git dir, not <root>/.git', () => {
    const dir = getGitDir(worktree);
    expect(dir).not.toBeNull();
    expect(fsSync.statSync(dir).isDirectory()).toBe(true);
    // The whole point: NOT the literal join that the hooks used to do.
    expect(path.resolve(dir)).not.toBe(path.resolve(worktree, '.git'));
    expect(dir.replace(/\\/g, '/')).toContain('/worktrees/');
  });

  it('gives the main checkout and the worktree separate git dirs', () => {
    expect(getGitDir(repo)).not.toBe(getGitDir(worktree));
  });

  it('round-trips hook state written through gitPath from the main checkout', () => {
    const file = gitPath(repo, 'autopilot.json');
    fsSync.writeFileSync(file, JSON.stringify({ enabled: true, from: 'main' }), 'utf-8');
    expect(JSON.parse(fsSync.readFileSync(file, 'utf-8'))).toEqual({ enabled: true, from: 'main' });
  });

  it('round-trips hook state written through gitPath from inside a worktree', () => {
    const file = gitPath(worktree, 'autopilot.json');
    fsSync.writeFileSync(file, JSON.stringify({ enabled: true, from: 'worktree' }), 'utf-8');
    expect(JSON.parse(fsSync.readFileSync(file, 'utf-8'))).toEqual({
      enabled: true, from: 'worktree',
    });
  });

  it('keeps the two states separate rather than one clobbering the other', () => {
    expect(JSON.parse(fsSync.readFileSync(gitPath(repo, 'autopilot.json'), 'utf-8')).from)
      .toBe('main');
    expect(JSON.parse(fsSync.readFileSync(gitPath(worktree, 'autopilot.json'), 'utf-8')).from)
      .toBe('worktree');
  });

  it('shows the pre-fix literal join is unusable inside a worktree', () => {
    // This is the write every hook used to perform. It cannot succeed: the
    // parent is a file. Kept as an executable statement of why the fix exists.
    const legacy = path.join(worktree, '.git', 'autopilot.json');
    expect(() => fsSync.writeFileSync(legacy, '{}', 'utf-8')).toThrow();
    expect(fsSync.existsSync(legacy)).toBe(false);
  });

  it('returns null rather than throwing outside a repository', () => {
    const notARepo = fsSync.mkdtempSync(path.join(os.tmpdir(), 'artibot-nogit-'));
    try {
      expect(getGitDir(notARepo)).toBeNull();
      expect(getGitDir('')).toBeNull();
      expect(getGitDir(undefined)).toBeNull();
      // gitPath still yields the legacy path so callers behave as before.
      expect(gitPath(notARepo, 'autopilot.json'))
        .toBe(path.join(notARepo, '.git', 'autopilot.json'));
    } finally {
      fsSync.rmSync(notARepo, { recursive: true, force: true });
    }
  });
});
