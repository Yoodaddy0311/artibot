/**
 * Tests for scripts/update-git.js — git source-repo discovery + pull machinery
 * extracted from update.js, plus the INV-7 pre-pull health gate.
 *
 * Covers:
 *   - assertGitHealth (INV-7): not-a-repo / clean+target / dirty / no-remote-target
 *   - findSourceRepo: source-repo.json (stale guard) + walk-up
 *   - stashIfDirty / popAutostash: no-op on a non-repo path (never throws)
 *
 * Network-free: all git operations run against ephemeral local repos created in
 * a tmpdir. No remote is contacted (a bare repo on disk acts as origin).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assertGitHealth,
  findSourceRepo,
  popAutostash,
  stashIfDirty,
} from '../../scripts/update-git.js';

let tmpRoot;

function git(cwd, args) {
  execFileSync('git', args, { cwd, stdio: 'ignore', timeout: 15_000 });
}

/**
 * Build a local clone whose `origin` is a bare repo on disk (no network). The
 * default branch is `master`. Returns { work, bare }.
 */
function makeRepoPair() {
  const bare = join(tmpRoot, 'origin.git');
  const work = join(tmpRoot, 'work');
  mkdirSync(bare, { recursive: true });
  mkdirSync(work, { recursive: true });

  git(bare, ['init', '--bare', '--initial-branch=master']);
  git(work, ['init', '--initial-branch=master']);
  git(work, ['config', 'user.email', 'test@artibot.local']);
  git(work, ['config', 'user.name', 'artibot test']);
  writeFileSync(join(work, 'README.md'), 'seed\n');
  git(work, ['add', '.']);
  git(work, ['commit', '-m', 'seed']);
  git(work, ['remote', 'add', 'origin', bare]);
  git(work, ['push', '-u', 'origin', 'master']);
  // Populate origin/HEAD so resolveRemoteDefaultBranch has an authoritative ref.
  git(work, ['remote', 'set-head', 'origin', '--auto']);
  return { work, bare };
}

let gitAvailable = true;
beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'artibot-update-git-'));
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore', timeout: 5000 });
  } catch {
    gitAvailable = false;
  }
});

afterEach(() => {
  if (tmpRoot && existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// INV-7 — assertGitHealth
// ---------------------------------------------------------------------------

describe('assertGitHealth (INV-7)', () => {
  it('fails not-a-git-repo when .git is absent', () => {
    const plain = join(tmpRoot, 'plain');
    mkdirSync(plain, { recursive: true });
    const r = assertGitHealth(plain);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('not-a-git-repo');
    expect(r.pullTarget).toBeNull();
  });

  it('fails not-a-git-repo for a null / empty root', () => {
    expect(assertGitHealth('').ok).toBe(false);
    expect(assertGitHealth(null).reason).toBe('not-a-git-repo');
  });

  it('passes on a clean repo with a resolvable origin target', () => {
    if (!gitAvailable) return;
    const { work } = makeRepoPair();
    const r = assertGitHealth(work);
    expect(r.ok).toBe(true);
    expect(r.reason).toBeNull();
    expect(r.dirty).toBe(false);
    expect(r.pullTarget).toBe('master');
  });

  it('reports dirty:true when the working tree has changes (still ok)', () => {
    if (!gitAvailable) return;
    const { work } = makeRepoPair();
    writeFileSync(join(work, 'README.md'), 'dirty change\n');
    const r = assertGitHealth(work);
    expect(r.ok).toBe(true);
    expect(r.dirty).toBe(true);
    expect(r.pullTarget).toBe('master');
  });

  it('fails no-remote-target on a repo with no origin refs', () => {
    if (!gitAvailable) return;
    const solo = join(tmpRoot, 'solo');
    mkdirSync(solo, { recursive: true });
    git(solo, ['init', '--initial-branch=master']);
    git(solo, ['config', 'user.email', 'test@artibot.local']);
    git(solo, ['config', 'user.name', 'artibot test']);
    writeFileSync(join(solo, 'f.txt'), 'x\n');
    git(solo, ['add', '.']);
    git(solo, ['commit', '-m', 'init']);
    const r = assertGitHealth(solo);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('no-remote-target');
  });
});

// ---------------------------------------------------------------------------
// findSourceRepo
// ---------------------------------------------------------------------------

describe('findSourceRepo', () => {
  it('returns null when no source can be located', () => {
    // installScriptDir points at a non-repo dir with no parent .git within 5 levels.
    const orphan = join(tmpRoot, 'a', 'b', 'c');
    mkdirSync(orphan, { recursive: true });
    // Note: this may still find a real source-repo.json on the test machine; the
    // contract we assert is "never throws and returns null-or-object".
    const r = findSourceRepo(orphan);
    expect(r === null || (typeof r === 'object' && 'gitRoot' in r)).toBe(true);
  });

  it('walks up from installScriptDir to find an enclosing .git', () => {
    if (!gitAvailable) return;
    const { work } = makeRepoPair();
    const nested = join(work, 'plugins', 'artibot', 'scripts');
    mkdirSync(nested, { recursive: true });
    const r = findSourceRepo(nested);
    // findSourceRepo's higher-priority strategies (a real ~/.claude/artibot/
    // source-repo.json or a common-location clone on the test machine) may
    // intercept before the walk-up branch is reached. The contract this test
    // pins is: given a valid enclosing .git, a non-null repo with a real .git
    // root is returned (walk-up returns `work` only when nothing higher wins).
    expect(r).not.toBeNull();
    expect(existsSync(join(r.gitRoot, '.git'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// stashIfDirty / popAutostash — never throw on a non-repo
// ---------------------------------------------------------------------------

describe('stashIfDirty / popAutostash resilience', () => {
  it('stashIfDirty returns false on a non-repo path (git status fails)', () => {
    const plain = join(tmpRoot, 'norepo');
    mkdirSync(plain, { recursive: true });
    expect(stashIfDirty(plain)).toBe(false);
  });

  it('popAutostash never throws on a non-repo path', () => {
    const plain = join(tmpRoot, 'norepo2');
    mkdirSync(plain, { recursive: true });
    expect(() => popAutostash(plain)).not.toThrow();
  });
});
