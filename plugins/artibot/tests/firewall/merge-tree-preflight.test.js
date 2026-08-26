/**
 * Firewall — merge-tree pre-flight must block conflicting pairs and must
 * refuse to guess on a git that cannot run `--write-tree`.
 *
 * Before `lib/git/merge-preflight.js` the "conflict prediction matrix" of
 * `/git worktree check` existed only as prose (`commands/git.md` § worktree,
 * `skills/git-unified/references/worktree.md` § check); nothing executable
 * backed it. These tests pin the module both consumers now share (ADR-005):
 *
 *   - a real conflicting pair in a temp repo is classified `conflict` with the
 *     file named, and `preflightBranches` reports `blocked`;
 *   - a clean pair is `clean` and the recommended order puts the least
 *     conflicted limb first;
 *   - a bad ref (which git also exits 1 for — measured 2.54) is `error`, not
 *     silently clean;
 *   - a git older than 2.38, an unparseable banner, or a missing git all yield
 *     `supported:false, degrade:'serial'` and NOT ONE merge-tree call is made
 *     (fail-closed — verified by recording every exec);
 *   - `buildBatchCommit` folds limbs into one SHA without touching the
 *     working tree, and stops on the first conflicting fold.
 *
 * ── What this gate cannot see (rules §9) ────────────────────────────────────
 *   - **Semantic conflicts.** Every fixture here is a textual conflict. A pair
 *     that merges clean but breaks at build time is exactly what this module
 *     documents it cannot detect; only CI on the batch SHA sees that.
 *   - **Fixture scale.** Three one-file limbs, not 4-5 real worktrees with
 *     hundreds of files. Runtime and output-size behaviour at scale is
 *     unmeasured (maxBuffer is set to 64MB; that is a guess, not a measurement).
 *   - **The old-git path runs against a FAKE exec.** No git < 2.38 is
 *     installed here, so "degrades on 2.37" proves the version gate, not what
 *     the legacy `merge-tree` would print.
 *   - **Whether either consumer actually calls the module.** `commands/git.md`
 *     and `worktree.md` are prompts; a model may still type the raw git
 *     command. Skill invocation is not exercised by any unit test.
 *
 * Temp repo only — never the user's repository.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEGRADE_SERIAL,
  formatConflictMatrix,
  mergeTreePair,
  parseGitVersion,
  parseMergeTreeOutput,
  preflightBranches,
  probeMergeTreeSupport,
  recommendMergeOrder,
  runGit,
  supportsWriteTree,
} from '../../lib/git/merge-preflight.js';
import { buildBatchCommit } from '../../lib/git/batch-landing.js';

let repo = '';

function git(args, cwd = repo) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  }).trim();
}

function write(rel, content) {
  fsSync.writeFileSync(path.join(repo, rel), content, 'utf-8');
}

beforeAll(() => {
  repo = fsSync.mkdtempSync(path.join(os.tmpdir(), 'artibot-mergepf-'));
  git(['init', '-q', '-b', 'main', '.']);
  git(['config', 'user.email', 'test@example.invalid']);
  git(['config', 'user.name', 'test']);
  git(['config', 'core.autocrlf', 'false']);
  write('f.txt', 'a\nb\nc\n');
  write('g.txt', 'x\n');
  git(['add', '.']);
  git(['commit', '-qm', 'init']);

  // L1 and L2 both rewrite line 1 of f.txt → textual conflict.
  git(['checkout', '-qb', 'L1']);
  write('f.txt', 'a1\nb\nc\n');
  git(['commit', '-qam', 'l1']);
  git(['checkout', '-q', 'main']);
  git(['checkout', '-qb', 'L2']);
  write('f.txt', 'a2\nb\nc\n');
  write('g.txt', 'y\n');
  git(['commit', '-qam', 'l2']);
  // L3 only adds a new file → clean against everything.
  git(['checkout', '-q', 'main']);
  git(['checkout', '-qb', 'L3']);
  write('h.txt', 'z\n');
  git(['add', 'h.txt']);
  git(['commit', '-qm', 'l3']);
  git(['checkout', '-q', 'main']);
});

afterAll(() => {
  try {
    fsSync.rmSync(repo, { recursive: true, force: true });
  } catch { /* best effort */ }
});

/** Record every exec and answer `--version` with a canned banner. */
function fakeGit(banner, status = 0) {
  const calls = [];
  const exec = (args, opts) => {
    calls.push(args);
    if (args[0] === '--version') return { status, stdout: banner, stderr: '' };
    return runGit(args, opts);
  };
  return { exec, calls };
}

describe('version probe (fail-closed)', () => {
  it('parses the git banner and applies the 2.38 floor', () => {
    expect(parseGitVersion('git version 2.54.0.windows.1')).toEqual({ major: 2, minor: 54, patch: 0 });
    expect(parseGitVersion('git version 2.37.2')).toEqual({ major: 2, minor: 37, patch: 2 });
    expect(parseGitVersion('git version 3.0')).toEqual({ major: 3, minor: 0, patch: 0 });
    expect(parseGitVersion('nothing here')).toBeNull();
    expect(supportsWriteTree({ major: 2, minor: 38 })).toBe(true);
    expect(supportsWriteTree({ major: 2, minor: 37 })).toBe(false);
    expect(supportsWriteTree({ major: 3, minor: 0 })).toBe(true);
    expect(supportsWriteTree(null)).toBe(false);
  });

  it('the real local git supports --write-tree (the suite would be vacuous otherwise)', () => {
    const probe = probeMergeTreeSupport({ cwd: repo });
    expect(probe.supported).toBe(true);
    expect(probe.degrade).toBeNull();
    expect(probe.version.major).toBeGreaterThanOrEqual(2);
  });

  it('git 2.37 → unsupported, degrade=serial, and no merge-tree is attempted', () => {
    const { exec, calls } = fakeGit('git version 2.37.2\n');
    const r = preflightBranches(['L1', 'L2', 'L3'], { cwd: repo, exec });
    expect(r.supported).toBe(false);
    expect(r.degrade).toBe(DEGRADE_SERIAL);
    expect(r.blocked).toBe(true);
    expect(r.pairs).toEqual([]);
    expect(r.probe.reason).toMatch(/2\.37\.2 < 2\.38/);
    expect(calls.filter((a) => a[0] === 'merge-tree')).toHaveLength(0);
    // Order falls back to input order — nothing was measured.
    expect(r.mergeOrder).toEqual(['L1', 'L2', 'L3']);
  });

  it('unparseable banner → unsupported (never assumes new git)', () => {
    const { exec, calls } = fakeGit('git version unknown\n');
    const r = preflightBranches(['L1', 'L3'], { cwd: repo, exec });
    expect(r.supported).toBe(false);
    expect(r.degrade).toBe(DEGRADE_SERIAL);
    expect(r.blocked).toBe(true);
    expect(calls.filter((a) => a[0] === 'merge-tree')).toHaveLength(0);
  });

  it('git missing (non-zero --version) → unsupported', () => {
    const { exec } = fakeGit('', 127);
    const probe = probeMergeTreeSupport({ cwd: repo, exec });
    expect(probe.supported).toBe(false);
    expect(probe.degrade).toBe(DEGRADE_SERIAL);
    expect(probe.reason).toMatch(/exited 127/);
  });
});

describe('pairwise classification against a real temp repo', () => {
  it('conflicting pair → conflict with the file named', () => {
    const p = mergeTreePair('L1', 'L2', { cwd: repo });
    expect(p.kind).toBe('conflict');
    expect(p.conflictFiles).toEqual(['f.txt']);
    expect(p.tree).toMatch(/^[0-9a-f]{40,64}$/);
  });

  it('clean pair → clean with a tree OID', () => {
    const p = mergeTreePair('L1', 'L3', { cwd: repo });
    expect(p.kind).toBe('clean');
    expect(p.conflictFiles).toEqual([]);
    expect(p.tree).toMatch(/^[0-9a-f]{40,64}$/);
  });

  it('exit-code trap: a bad ref also exits 1 but is classified error, not conflict', () => {
    const p = mergeTreePair('L1', 'no-such-ref', { cwd: repo });
    expect(p.kind).toBe('error');
    expect(p.tree).toBeNull();
    expect(parseMergeTreeOutput('merge-tree: nope - not something we can merge\n', 1).kind).toBe('error');
    expect(parseMergeTreeOutput('', 0).kind).toBe('error');
  });

  it('preflightBranches blocks on the conflicting pair and orders the clean limb first', () => {
    const r = preflightBranches(['L1', 'L2', 'L3'], { cwd: repo });
    expect(r.supported).toBe(true);
    expect(r.pairs).toHaveLength(3);
    expect(r.blocked).toBe(true);
    expect(r.conflicts.map((c) => [c.ours, c.theirs])).toEqual([['L1', 'L2']]);
    expect(r.mergeOrder[0]).toBe('L3');
    const matrix = formatConflictMatrix(r);
    expect(matrix).toContain('CONFLICT !');
    expect(matrix).toContain('f.txt');
    expect(matrix).toContain('L3');
  });

  it('a set with no conflicts is not blocked', () => {
    const r = preflightBranches(['L1', 'L3', 'main'], { cwd: repo });
    expect(r.blocked).toBe(false);
    expect(r.conflicts).toEqual([]);
    expect(r.pairs.every((p) => p.kind === 'clean')).toBe(true);
  });

  it('an error pair blocks exactly like a conflict', () => {
    const r = preflightBranches(['L1', 'no-such-ref'], { cwd: repo });
    expect(r.blocked).toBe(true);
    expect(r.conflicts[0].kind).toBe('error');
    expect(formatConflictMatrix(r)).toContain('ERROR ?');
  });

  it('recommendMergeOrder is deterministic and conflict-count ascending', () => {
    const pairs = [
      { ours: 'b', theirs: 'a', kind: 'conflict' },
      { ours: 'b', theirs: 'c', kind: 'conflict' },
      { ours: 'a', theirs: 'c', kind: 'clean' },
    ];
    expect(recommendMergeOrder(['b', 'c', 'a'], pairs)).toEqual(['a', 'c', 'b']);
  });
});

describe('buildBatchCommit (object-db only)', () => {
  it('folds two clean limbs into one two-parent chain without touching the working tree', () => {
    const headBefore = git(['rev-parse', 'HEAD']);
    const statusBefore = git(['status', '--porcelain']);
    const b = buildBatchCommit({ base: 'main', limbs: ['L1', 'L3'], cwd: repo, branch: 'ci/split-t' });
    expect(b.status).toBe('built');
    expect(b.sha).toMatch(/^[0-9a-f]{40,64}$/);
    expect(b.steps).toHaveLength(2);
    // Both limbs' changes are in the batch tree.
    expect(git(['show', `${b.sha}:f.txt`])).toBe('a1\nb\nc');
    expect(git(['show', `${b.sha}:h.txt`])).toBe('z');
    // Each fold is a real merge commit (two parents) and the ref exists.
    expect(git(['rev-list', '--parents', '-n', '1', b.sha]).split(' ')).toHaveLength(3);
    expect(git(['rev-parse', 'refs/heads/ci/split-t'])).toBe(b.sha);
    // Working tree and HEAD untouched — safe in a shared checkout.
    expect(git(['rev-parse', 'HEAD'])).toBe(headBefore);
    expect(git(['status', '--porcelain'])).toBe(statusBefore);
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main');
  });

  it('stops on a conflicting fold and creates no ref', () => {
    const b = buildBatchCommit({ base: 'main', limbs: ['L1', 'L2'], cwd: repo, branch: 'ci/split-x' });
    expect(b.status).toBe('conflict');
    expect(b.sha).toBeNull();
    expect(b.conflict.files).toEqual(['f.txt']);
    expect(() => git(['rev-parse', '--verify', 'refs/heads/ci/split-x'])).toThrow();
  });

  it('reports degraded (not conflict, not built) on an old git', () => {
    const { exec } = fakeGit('git version 2.30.0\n');
    const b = buildBatchCommit({ base: 'main', limbs: ['L1', 'L3'], cwd: repo, branch: 'ci/split-old', exec });
    expect(b.status).toBe('degraded');
    expect(b.preflight.degrade).toBe(DEGRADE_SERIAL);
    expect(() => git(['rev-parse', '--verify', 'refs/heads/ci/split-old'])).toThrow();
  });
});
