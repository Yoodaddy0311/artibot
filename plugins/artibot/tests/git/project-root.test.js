import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { _internals, resolveProjectRoot } from '../../lib/git/project-root.js';
import { __resetForTest } from '../../lib/git/repo-root-cache.js';

/**
 * Regression cover for the ledger split defect: anchoring a per-project store on
 * the shell's cwd forked the store across directories on any mid-session `cd`.
 * The contract here is stability — every directory inside one project must
 * resolve to the same root.
 */

function git(args, cwd) {
  execFileSync('git', args, { cwd, stdio: 'ignore', windowsHide: true });
}

describe('resolveProjectRoot', () => {
  let tmp;

  beforeEach(() => {
    // realpath.native: on Windows mkdtemp hands back an 8.3 short path
    // (`C:\Users\HEECHA~1\...`). Must match the canonicalization the module
    // itself uses, or equality fails for spelling rather than behavior.
    tmp = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'artibot-projroot-')));
    __resetForTest();
  });
  afterEach(() => {
    __resetForTest();
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
  });

  describe('git projects', () => {
    let repo;
    beforeEach(() => {
      repo = path.join(tmp, 'repo');
      mkdirSync(repo, { recursive: true });
      git(['init'], repo);
    });

    it('resolves the repo root from the repo root itself', () => {
      expect(resolveProjectRoot(repo)).toBe(repo);
    });

    it('resolves a nested subdirectory to the same repo root', () => {
      const nested = path.join(repo, 'plugins', 'artibot', 'scripts', 'hooks');
      mkdirSync(nested, { recursive: true });
      expect(resolveProjectRoot(nested)).toBe(repo);
    });

    it('gives every directory in the project one identical answer', () => {
      const dirs = [repo, path.join(repo, 'a'), path.join(repo, 'a', 'b'), path.join(repo, 'c')];
      dirs.slice(1).forEach((d) => mkdirSync(d, { recursive: true }));
      const answers = new Set(dirs.map((d) => resolveProjectRoot(d)));
      expect([...answers]).toEqual([repo]);
    });

    it('agrees with git rev-parse --show-toplevel', () => {
      // The `.git` walk exists to keep a child process off the per-turn hook
      // path; it is only safe while it returns what git returns. Pin that.
      const nested = path.join(repo, 'a', 'b');
      mkdirSync(nested, { recursive: true });
      const viaGit = realpathSync.native(
        execFileSync('git', ['rev-parse', '--show-toplevel'], {
          cwd: nested, encoding: 'utf-8', windowsHide: true,
        }).trim(),
      );
      expect(resolveProjectRoot(nested)).toBe(viaGit);
    });

    it('is not fooled by a nested .artibot marker (this repo has one)', () => {
      // plugins/artibot/.artibot exists in the real repo; a nearest-marker walk
      // would anchor there instead of the repo root.
      const nested = path.join(repo, 'plugins', 'artibot');
      mkdirSync(path.join(nested, '.artibot'), { recursive: true });
      expect(resolveProjectRoot(path.join(nested, 'scripts'))).toBe(repo);
    });
  });

  describe('non-git projects', () => {
    it('falls back to the outermost package.json ancestor, not the cwd', () => {
      const proj = path.join(tmp, 'proj');
      const deep = path.join(proj, 'packages', 'inner', 'src');
      mkdirSync(deep, { recursive: true });
      writeFileSync(path.join(proj, 'package.json'), '{}', 'utf-8');
      writeFileSync(path.join(proj, 'packages', 'inner', 'package.json'), '{}', 'utf-8');
      // Outermost wins so sibling subdirectories cannot fork the store.
      expect(resolveProjectRoot(deep)).toBe(proj);
      expect(resolveProjectRoot(path.join(proj, 'packages'))).toBe(proj);
    });

    it('finds a .git directory even when the git binary cannot answer', () => {
      const proj = path.join(tmp, 'bare');
      const deep = path.join(proj, 'x', 'y');
      mkdirSync(deep, { recursive: true });
      mkdirSync(path.join(proj, '.git'), { recursive: true });
      expect(resolveProjectRoot(deep)).toBe(proj);
    });

    it('returns the starting directory when no marker exists anywhere', () => {
      const plain = path.join(tmp, 'plain');
      mkdirSync(plain, { recursive: true });
      expect(resolveProjectRoot(plain)).toBe(plain);
    });

    it('excludes the home directory from the marker walk (~/.artibot exists)', () => {
      // ~/.artibot holds cross-project learning data. Without the home guard a
      // marker walk from any markerless directory under $HOME would land there
      // and write session conversation into that shared store.
      const home = path.resolve(os.homedir());
      const dirs = _internals.candidateDirs(path.join(home, 'some', 'project'));
      expect(dirs).not.toContain(home);
      expect(dirs).toContain(path.join(home, 'some', 'project'));
    });
  });

  it('defaults to process.cwd() when called with no argument', () => {
    expect(resolveProjectRoot()).toBe(resolveProjectRoot(process.cwd()));
  });

  it('always returns an absolute path', () => {
    expect(path.isAbsolute(resolveProjectRoot(tmp))).toBe(true);
  });
});
