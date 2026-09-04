/**
 * Fixtures here BUILD the on-disk shapes git builds — a `.git` directory for a
 * main checkout, a `.git` file plus `worktrees/<name>/commondir` for a linked
 * one — rather than stubbing `fs`. A stubbed reader would prove the branches
 * are wired and nothing about whether the shapes are the ones git writes,
 * which is the only thing this module has to get right.
 *
 * No test in this file runs `git`. The layouts are asserted against a live
 * `git rev-parse --git-common-dir` in the change's report, not in the suite:
 * a CI runner is not guaranteed to have git, and a suite that silently skips
 * is worse than one that never claimed to check.
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveGitCommonDir } from '../../lib/project-state/git-common-dir.js';
import { resolveStoreLocation, STORE_DIR_NAME } from '../../lib/project-state/state-manager.js';

/** Every tmpdir made during a test, removed in afterEach. */
const made = [];

/** @returns {string} A fresh tmpdir, registered for cleanup. */
function tmp() {
  // realpathSync-free on purpose: mkdtemp under os.tmpdir() can hand back a
  // symlinked path (/var -> /private/var on macOS). Resolving it would hide a
  // real bug class, because the caller's projectRoot is not resolved either.
  const dir = mkdtempSync(path.join(os.tmpdir(), 'artibot-gitcommon-'));
  made.push(dir);
  return dir;
}

afterEach(() => {
  while (made.length) rmSync(made.pop(), { recursive: true, force: true });
});

/**
 * Build a main checkout: `<root>/.git/` as a real directory.
 *
 * @param {string} root - Project root to populate.
 * @returns {string} Absolute path of the created `.git` directory.
 */
function makeMainCheckout(root) {
  const gitDir = path.join(root, '.git');
  mkdirSync(gitDir, { recursive: true });
  writeFileSync(path.join(gitDir, 'HEAD'), 'ref: refs/heads/master\n');
  return gitDir;
}

/**
 * Build a linked worktree pointing at an existing main checkout.
 *
 * Mirrors git's own layout: a `.git` FILE holding `gitdir: <abs>` and a
 * per-worktree dir holding `commondir` with a RELATIVE `../..`.
 *
 * @param {object} params - Layout inputs.
 * @param {string} params.mainGitDir - Absolute `<main>/.git`.
 * @param {string} params.worktreeRoot - Root the `.git` file is written into.
 * @param {string} [params.name='wt'] - Worktree name under `worktrees/`.
 * @param {string} [params.pointer] - Literal text after `gitdir: `. Defaults to
 *   the absolute per-worktree dir, which is what git writes.
 * @param {string|null} [params.commondir='../..'] - `commondir` content, or
 *   null to omit the file entirely.
 * @param {string} [params.eol='\n'] - Line ending for the `.git` file.
 * @returns {string} Absolute per-worktree git dir.
 */
function makeLinkedWorktree({
  mainGitDir, worktreeRoot, name = 'wt', pointer, commondir = '../..', eol = '\n',
}) {
  const perWorktree = path.join(mainGitDir, 'worktrees', name);
  mkdirSync(perWorktree, { recursive: true });
  if (commondir !== null) writeFileSync(path.join(perWorktree, 'commondir'), `${commondir}${eol}`);
  mkdirSync(worktreeRoot, { recursive: true });
  const target = pointer ?? perWorktree;
  writeFileSync(path.join(worktreeRoot, '.git'), `gitdir: ${target}${eol}`);
  return perWorktree;
}

describe('main checkout — the `.git` DIRECTORY case', () => {
  it('returns <root>/.git when no commondir file exists', () => {
    const root = tmp();
    const gitDir = makeMainCheckout(root);
    expect(resolveGitCommonDir(root)).toBe(path.resolve(gitDir));
  });

  it('returns an ABSOLUTE path, never one relative to the process CWD', () => {
    const root = tmp();
    makeMainCheckout(root);
    expect(path.isAbsolute(resolveGitCommonDir(root))).toBe(true);
  });

  it('honours a commondir file even in the directory case, resolved against .git', () => {
    // Not a shape git writes for a main checkout, but the rule is stated
    // per-shape and must not quietly become "directories skip the pointer".
    const root = tmp();
    const gitDir = makeMainCheckout(root);
    const shared = path.join(root, 'shared-git');
    mkdirSync(shared, { recursive: true });
    writeFileSync(path.join(gitDir, 'commondir'), '../shared-git\n');
    expect(resolveGitCommonDir(root)).toBe(path.resolve(shared));
  });
});

describe('linked worktree — the `.git` FILE case', () => {
  it('follows gitdir: then commondir ../.. back to the MAIN .git', () => {
    const main = tmp();
    const mainGitDir = makeMainCheckout(main);
    const worktreeRoot = path.join(tmp(), 'wt');
    makeLinkedWorktree({ mainGitDir, worktreeRoot });

    // The whole point of F3: worktree and main must agree on one location.
    expect(resolveGitCommonDir(worktreeRoot)).toBe(path.resolve(mainGitDir));
    expect(resolveGitCommonDir(worktreeRoot)).toBe(resolveGitCommonDir(main));
  });

  it('resolves a RELATIVE gitdir: pointer against projectRoot, not the CWD', () => {
    // git writes an absolute pointer, but a relocated or hand-written worktree
    // can hold a relative one. Resolving against the CWD would silently bind
    // the store to wherever the process happened to start.
    const root = tmp();
    const mainGitDir = makeMainCheckout(root);
    const worktreeRoot = path.join(root, 'wt');
    makeLinkedWorktree({
      mainGitDir,
      worktreeRoot,
      name: 'rel',
      pointer: path.join('..', '.git', 'worktrees', 'rel'),
    });
    expect(resolveGitCommonDir(worktreeRoot)).toBe(path.resolve(mainGitDir));
  });

  it('returns the per-worktree gitdir itself when it holds no commondir', () => {
    // This is also the submodule shape (<super>/.git/modules/<name>), which
    // the module documents as unsupported rather than claimed-correct.
    const main = tmp();
    const mainGitDir = makeMainCheckout(main);
    const worktreeRoot = path.join(tmp(), 'wt');
    const perWorktree = makeLinkedWorktree({
      mainGitDir, worktreeRoot, name: 'bare', commondir: null,
    });
    expect(resolveGitCommonDir(worktreeRoot)).toBe(path.resolve(perWorktree));
  });

  it('strips the carriage return from a CRLF-written pointer', () => {
    // NEGATIVE CONTROL for the split(/\r?\n/): with a plain trim of the whole
    // file this returns a path ending in \r that exists on no disk, and the
    // assertion below is what fails.
    const main = tmp();
    const mainGitDir = makeMainCheckout(main);
    const worktreeRoot = path.join(tmp(), 'wt');
    makeLinkedWorktree({ mainGitDir, worktreeRoot, name: 'crlf', eol: '\r\n' });

    const resolved = resolveGitCommonDir(worktreeRoot);
    expect(resolved).toBe(path.resolve(mainGitDir));
    expect(resolved).not.toMatch(/[\r\n]/);
  });

  it('ignores trailing lines after the pointer', () => {
    const main = tmp();
    const mainGitDir = makeMainCheckout(main);
    const perWorktree = path.join(mainGitDir, 'worktrees', 'extra');
    mkdirSync(perWorktree, { recursive: true });
    writeFileSync(path.join(perWorktree, 'commondir'), '../..\n');
    const worktreeRoot = path.join(tmp(), 'wt');
    mkdirSync(worktreeRoot, { recursive: true });
    writeFileSync(path.join(worktreeRoot, '.git'), `gitdir: ${perWorktree}\ntrailing junk\n`);

    expect(resolveGitCommonDir(worktreeRoot)).toBe(path.resolve(mainGitDir));
  });
});

describe('everything outside the allowlist is null, never a guess', () => {
  it('returns null for a directory with no .git at all', () => {
    expect(resolveGitCommonDir(tmp())).toBeNull();
  });

  it('does NOT walk up to a parent repository', () => {
    // A nested project must not silently bind to its ancestor's store — the
    // ledger applies the same no-walk-up rule to the same projectRoot.
    const root = tmp();
    makeMainCheckout(root);
    const nested = path.join(root, 'packages', 'child');
    mkdirSync(nested, { recursive: true });
    expect(resolveGitCommonDir(nested)).toBeNull();
  });

  it('returns null for a .git file with garbage content', () => {
    const root = tmp();
    writeFileSync(path.join(root, '.git'), 'this is not a worktree pointer\n');
    expect(resolveGitCommonDir(root)).toBeNull();
  });

  it('returns null for a .git file with an empty gitdir: value', () => {
    const root = tmp();
    writeFileSync(path.join(root, '.git'), 'gitdir:   \n');
    expect(resolveGitCommonDir(root)).toBeNull();
  });

  it('returns null for an empty .git file', () => {
    const root = tmp();
    writeFileSync(path.join(root, '.git'), '');
    expect(resolveGitCommonDir(root)).toBeNull();
  });

  it('returns null for a case-mismatched pointer, matching git', () => {
    const root = tmp();
    writeFileSync(path.join(root, '.git'), 'GITDIR: /somewhere/.git\n');
    expect(resolveGitCommonDir(root)).toBeNull();
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty string', ''],
    ['a number', 42],
    ['an object', {}],
  ])('returns null for %s rather than throwing', (_label, value) => {
    expect(resolveGitCommonDir(value)).toBeNull();
  });

  it('never throws on a path that cannot be stat-ed', () => {
    const root = path.join(tmp(), 'does', 'not', 'exist');
    expect(() => resolveGitCommonDir(root)).not.toThrow();
    expect(resolveGitCommonDir(root)).toBeNull();
  });

  it('accepts a symlinked .git and returns the LINK path, not its target', () => {
    // Two separate behaviours, and the test names both because the first
    // draft of this test asserted the second one wrongly:
    //   - statSync FOLLOWS the link, so a symlinked .git is recognised.
    //   - path.resolve is lexical, so the returned path is <root>/.git.
    // Returning the link path is the wanted outcome: writes go through it
    // fine, and realpath-ing here would make the store location differ
    // between a linked and an unlinked checkout of the same repository.
    const root = tmp();
    const real = path.join(tmp(), 'real-git');
    mkdirSync(real, { recursive: true });
    let linked = true;
    try {
      symlinkSync(real, path.join(root, '.git'), 'junction');
    } catch {
      // Unprivileged Windows without Developer Mode cannot create links. The
      // assertion is skipped rather than weakened; it documents statSync's
      // follow behaviour and is not part of the module's contract.
      linked = false;
    }
    if (linked) expect(resolveGitCommonDir(root)).toBe(path.join(root, '.git'));
  });
});

describe('composed with resolveStoreLocation — the actual call site', () => {
  it('puts one store under the MAIN .git for both the worktree and the main root', () => {
    const main = tmp();
    const mainGitDir = makeMainCheckout(main);
    const worktreeRoot = path.join(tmp(), 'wt');
    makeLinkedWorktree({ mainGitDir, worktreeRoot, name: 'compose' });

    const fromWorktree = resolveStoreLocation({
      projectRoot: worktreeRoot,
      gitCommonDir: resolveGitCommonDir(worktreeRoot),
    });

    expect(fromWorktree.source).toBe('git-common-dir');
    expect(fromWorktree.reason).toBeNull();
    expect(fromWorktree.dir).toBe(path.join(path.resolve(mainGitDir), STORE_DIR_NAME));

    const fromMain = resolveStoreLocation({
      projectRoot: main,
      gitCommonDir: resolveGitCommonDir(main),
    });
    // The divergence this whole design decision exists to prevent.
    expect(fromMain.dir).toBe(fromWorktree.dir);
  });

  it('falls back with a stated reason when the root is not a repository', () => {
    const root = tmp();
    const location = resolveStoreLocation({
      projectRoot: root,
      gitCommonDir: resolveGitCommonDir(root),
    });
    expect(location.source).toBe('project-root-fallback');
    expect(location.reason).toContain('git common dir unresolved');
  });
});
