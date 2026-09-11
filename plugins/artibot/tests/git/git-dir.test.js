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
 * submodules and `.git` files outside the worktree case.
 *
 * ── Two axes, kept apart on purpose ────────────────────────────────────────
 * Classification and budget are separate claims, and mixing them is what made
 * the old suite flaky. Any test asserting *which* answer git gave injects an
 * ample `timeoutMs`, so a loaded machine cannot turn `not-a-repo` into
 * `timeout` and fail a test that was never about the clock. The budget gets its
 * own two tests: one reads the shipped default back off the spawn options, one
 * drives a 1ms budget into a real ETIMEDOUT.
 *
 * What no test here can settle is whether the default budget is large enough in
 * production. It deliberately is not, for the loaded tail — the design answer is
 * that the hook path never spawns at all, which `via: 'layout'` and the spawn
 * count assert directly. See the default's rationale in the module source.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { getGitDir, gitDirFromLayout, gitPath, resolveGitDir } from '../../lib/git/git-dir.js';

/**
 * A seam over `execSync`, used for three things the real binary cannot show:
 * failing the way a timeout fails without a hung git, counting spawns so the
 * "layout answers first" claim is checked rather than assumed, and reading back
 * the options so the shipped default budget is pinned to a number.
 *
 * Every other test runs the real binary: the flag defaults to off and the
 * factory delegates to the genuine module, so `execFileSync` (used by the
 * fixture builder below) is untouched.
 */
const childProcessMock = vi.hoisted(() => ({
  forceTimeout: false,
  calls: [],
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    execSync: (...args) => {
      childProcessMock.calls.push(args[1] ?? {});
      if (!childProcessMock.forceTimeout) return actual.execSync(...args);
      // Shape measured on Windows 2026-09-11: code ETIMEDOUT, signal SIGTERM,
      // status null. Node kills the child and reports the spawn as failed.
      const err = new Error('spawnSync cmd.exe ETIMEDOUT');
      err.code = 'ETIMEDOUT';
      err.signal = 'SIGTERM';
      err.status = null;
      throw err;
    },
  };
});

/** A budget far above any plausible spawn latency, including a loaded tail. */
const AMPLE_MS = 15_000;

// One reset point, replacing the try/finally that used to wrap every test that
// touched the flag. Deliberately `beforeEach` rather than `afterEach`: it also
// covers state arriving from outside the per-test cycle — module-level setup, a
// test that threw before its cleanup, or a reordered run — so each test starts
// from a known seam no matter what ran before it. `afterEach` would leave the
// first test in the file unguarded.
beforeEach(() => {
  childProcessMock.calls.length = 0;
  childProcessMock.forceTimeout = false;
});

/** @type {string} */ let repo = '';
/** @type {string} */ let worktree = '';
/** @type {string} */ let notARepo = '';
/** @type {string} */ let absent = '';
/** @type {string} */ let subdir = '';
/** @type {string} */ let linked = '';
/** @type {string} */ let linkKind = '';

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

  // A directory inside the repo but below its root. It has no `.git` of its
  // own, so the layout arm cannot answer and git must run — this is the fixture
  // that keeps the spawn path alive in the suite.
  subdir = path.join(repo, 'nested', 'deeper');
  fsSync.mkdirSync(subdir, { recursive: true });

  worktree = path.join(repo, 'linked-wt');
  git(['worktree', 'add', '-q', worktree, '-b', 'wt-branch'], repo);
  // Same purpose as `subdir`, inside the worktree: a cwd the layout cannot
  // answer, so the git arm runs and can be compared against the layout arm.
  // The link test reaches this directory as `<link>/linked-wt/nested`, so it
  // is created here on the real path and addressed through the link there.
  fsSync.mkdirSync(path.join(worktree, 'nested'), { recursive: true });

  // The checkout reached through a link rather than its real path. A junction
  // needs no elevation on Windows; a plain directory symlink usually does, so
  // it is only the second choice. If neither can be created the link tests say
  // so rather than passing vacuously.
  linked = path.join(os.tmpdir(), `git-dir-link-${process.pid}-${Date.now()}`);
  for (const kind of ['junction', 'dir']) {
    try {
      fsSync.symlinkSync(repo, linked, kind);
      linkKind = kind;
      break;
    } catch { /* try the next kind */ }
  }

  notARepo = fsSync.mkdtempSync(path.join(os.tmpdir(), 'git-dir-bare-'));
  // Never created. `execSync` fails to spawn at all with this cwd, which is a
  // different failure from "spawned, and git said no".
  absent = path.join(os.tmpdir(), `git-dir-absent-${process.pid}-${Date.now()}`);
});

afterAll(() => {
  // Unlink the junction FIRST and with unlink, not rm -r: removing it
  // recursively would delete the real checkout through the link.
  try { fsSync.unlinkSync(linked); } catch { /* best effort */ }
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
    // Pins down *why* it resolved, and that it cost no process to do so.
    expect(resolveGitDir(repo)).toMatchObject({ reason: 'ok', via: 'layout' });
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
    // `getGitDir` above cannot tell "not a repository" from "timed out" — both
    // are null, so on a loaded machine that assertion can pass without git ever
    // having answered. It stays on the shipped budget, because that is the
    // contract callers get. The distinction is made here, on an ample budget,
    // so this line fails for a real classification change and not for load.
    expect(resolveGitDir(notARepo, { timeoutMs: AMPLE_MS }).reason).toBe('not-a-repo');
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

describe('resolveGitDir — which arm answered', () => {
  it('answers an ordinary checkout from the layout, without spawning git', () => {
    const result = resolveGitDir(repo);
    expect(result.reason).toBe('ok');
    expect(result.via).toBe('layout');
    expect(result.dir).toBe(getGitDir(repo));
    // The load-bearing claim: the hook path costs no process at all.
    expect(childProcessMock.calls).toHaveLength(0);
  });

  it('answers a linked worktree from the layout too', () => {
    const result = resolveGitDir(worktree);
    expect(result.reason).toBe('ok');
    expect(result.via).toBe('layout');
    expect(result.dir.replace(/\\/g, '/')).toContain('/worktrees/');
    expect(childProcessMock.calls).toHaveLength(0);
  });

  it('falls through to git for a directory below the repository root', () => {
    // No `.git` here, so the layout cannot answer and the spawn path runs. This
    // is the test that fails if someone deletes the git arm as dead code.
    const result = resolveGitDir(subdir, { timeoutMs: AMPLE_MS });
    expect(result.reason).toBe('ok');
    expect(result.via).toBe('git');
    expect(childProcessMock.calls).toHaveLength(1);
  });

  it('spells the git dir identically whichever arm answered', () => {
    // Byte equality between the two arms, measured rather than assumed. The
    // arms disagreed at first: git returns the long Windows path while a plain
    // join returns the 8.3 short name for the same directory. If they ever
    // diverge again, callers key state off two spellings of one directory.
    const viaLayout = resolveGitDir(repo);
    const viaGit = resolveGitDir(subdir, { timeoutMs: AMPLE_MS });
    expect(viaLayout.via).toBe('layout');
    expect(viaGit.via).toBe('git');
    expect(viaLayout.dir).toBe(viaGit.dir);
  });

  it('spells a checkout reached through a link the way git does', () => {
    // Measured 2026-09-11: git resolves a junction to its real target, and
    // realpathSync.native resolves it identically, so the two arms agree even
    // though the caller named the link. Without canonicalizing the layout arm
    // this returns the link path and the arms split.
    if (!linkKind) {
      expect.fail('neither a junction nor a directory symlink could be created; '
        + 'the link-spelling claim is unmeasured on this machine');
    }
    const viaLayout = resolveGitDir(linked);
    const viaGit = resolveGitDir(path.join(linked, 'nested'), { timeoutMs: AMPLE_MS });
    expect(viaLayout.via).toBe('layout');
    expect(viaGit.via).toBe('git');
    expect(viaLayout.dir).toBe(viaGit.dir);
    // And it is the real checkout, not the link.
    expect(viaLayout.dir).toBe(gitDirFromLayout(repo));
  });

  it('spells a worktree reached through a link the way git does', () => {
    if (!linkKind) {
      expect.fail('neither a junction nor a directory symlink could be created; '
        + 'the link-spelling claim is unmeasured on this machine');
    }
    // Both arms must reach the worktree THROUGH the link, or the test proves
    // something weaker than its name: spawning from the real path would only
    // show how git spells a path it was already given in real form.
    const linkedWorktree = path.join(linked, 'linked-wt');
    const viaLayout = resolveGitDir(linkedWorktree);
    const viaGit = resolveGitDir(path.join(linkedWorktree, 'nested'), { timeoutMs: AMPLE_MS });
    expect(viaLayout.via).toBe('layout');
    expect(viaGit.via).toBe('git');
    expect(viaLayout.dir).toBe(viaGit.dir);
    expect(viaLayout.dir.replace(/\\/g, '/')).toContain('/worktrees/');
  });

  it.each(['GIT_DIR', 'GIT_WORK_TREE'])('lets an explicit %s override the layout', (name) => {
    // These deliberately contradict what the directory looks like, and only git
    // knows how to apply them, so the layout must step aside. A `core.worktree`
    // override is NOT covered: seeing it needs a config read, which is the very
    // spawn the layout arm exists to avoid. That limit is stated in the module.
    const saved = process.env[name];
    process.env[name] = name === 'GIT_DIR' ? getGitDir(repo) : repo;
    try {
      const result = resolveGitDir(repo, { timeoutMs: AMPLE_MS });
      expect(result.via).toBe('git');
      expect(childProcessMock.calls).toHaveLength(1);
    } finally {
      if (saved === undefined) delete process.env[name];
      else process.env[name] = saved;
    }
  });
});

describe('resolveGitDir — failure classification', () => {
  // Every case here injects an ample budget. The claim under test is which
  // failure git reported, not how long it was given to report it.
  it('reports not-a-repo for a directory that is not a repository', () => {
    const result = resolveGitDir(notARepo, { timeoutMs: AMPLE_MS });
    expect(result.reason).toBe('not-a-repo');
    expect(result.dir).toBeNull();
    expect(result.via).toBeUndefined();
  });

  it('reports spawn-failed for a cwd that does not exist', () => {
    // Measured on Windows: ENOENT from spawnSync, because the child cannot be
    // started at all. Distinct from git starting and answering "no".
    const result = resolveGitDir(absent, { timeoutMs: AMPLE_MS });
    expect(result.reason).toBe('spawn-failed');
    expect(result.dir).toBeNull();
  });

  it('reports bad-input for non-string input instead of spawning git', () => {
    for (const bad of [null, undefined, '', 0, 42, {}, [], true]) {
      const result = resolveGitDir(bad);
      expect(result.reason, `input=${JSON.stringify(bad) ?? String(bad)}`).toBe('bad-input');
      expect(result.dir).toBeNull();
    }
    expect(childProcessMock.calls).toHaveLength(0);
  });

  it('never throws for any of the failure modes', () => {
    expect(() => resolveGitDir(notARepo, { timeoutMs: AMPLE_MS })).not.toThrow();
    expect(() => resolveGitDir(absent, { timeoutMs: AMPLE_MS })).not.toThrow();
    expect(() => resolveGitDir(subdir, { timeoutMs: 1 })).not.toThrow();
  });
});

describe('resolveGitDir — the spawn budget', () => {
  it('gives git the budget the hook slots allow, and no more', () => {
    // 2000ms is derived, not chosen: the tightest slot budget reaching this
    // module is 5000ms and the dispatcher reserves HEADROOM_MS = 3000
    // (tests/firewall/hook-timeout-budget.test.js). A larger value here would
    // let a slow git consume the whole slot and get the hook killed outright,
    // which drops the verdict instead of degrading it.
    resolveGitDir(subdir);
    expect(childProcessMock.calls).toHaveLength(1);
    expect(childProcessMock.calls[0].timeout).toBe(2000);
  });

  it('reports timeout with a null dir when git exceeds the budget', () => {
    // A 1ms budget against a real spawn, from a cwd the layout cannot answer.
    // This is the failure the module used to collapse into the same `null` as
    // "not a repository".
    const result = resolveGitDir(subdir, { timeoutMs: 1 });
    expect(result.reason).toBe('timeout');
    expect(result.dir).toBeNull();
  });
});

describe('gitDirFromLayout', () => {
  it('reads an ordinary checkout straight off the filesystem', () => {
    expect(gitDirFromLayout(repo)).toBe(getGitDir(repo));
  });

  it('follows the worktree pointer file to the per-worktree git dir', () => {
    // The whole reason this fallback exists: <worktree>/.git is a FILE, so a
    // literal join is unwritable, but the file names the real directory.
    const dir = gitDirFromLayout(worktree);
    expect(dir).toBe(getGitDir(worktree));
    expect(dir.replace(/\\/g, '/')).toContain('/worktrees/');
  });

  it('returns null where there is no git layout to read', () => {
    expect(gitDirFromLayout(notARepo)).toBeNull();
    expect(gitDirFromLayout(absent)).toBeNull();
  });

  it('rejects a .git directory that is not actually a repository', () => {
    // Now that the layout answers before git does, it has to be as strict as
    // git. An empty `.git/` is a directory that exists and is not a repo; git
    // reports 128 for it. Accepting it would widen getGitDir's contract by
    // accident, returning a path where the module used to return null.
    const hollow = fsSync.mkdtempSync(path.join(os.tmpdir(), 'git-dir-hollow-'));
    try {
      fsSync.mkdirSync(path.join(hollow, '.git'));
      expect(gitDirFromLayout(hollow)).toBeNull();
      expect(resolveGitDir(hollow, { timeoutMs: AMPLE_MS }).reason).toBe('not-a-repo');
    } finally {
      fsSync.rmSync(hollow, { recursive: true, force: true });
    }
  });

  it('returns null, without throwing, for non-string input', () => {
    for (const bad of [null, undefined, '', 0, 42, {}, [], true]) {
      expect(() => gitDirFromLayout(bad)).not.toThrow();
      expect(gitDirFromLayout(bad), `input=${JSON.stringify(bad) ?? String(bad)}`).toBeNull();
    }
  });
});

describe('gitPath when git is unavailable entirely', () => {
  // Every hook reaching this module passes a `rev-parse --show-toplevel` root,
  // so these cases model a loaded machine where git would time out. The point
  // is no longer that a fallback recovers — it is that nothing needed to.
  it('resolves a root without git at all, in both repository shapes', () => {
    childProcessMock.forceTimeout = true;
    expect(gitPath(repo, 'autopilot.json'))
      .toBe(path.join(gitDirFromLayout(repo), 'autopilot.json'));
    expect(gitPath(worktree, 'autopilot.json'))
      .toBe(path.join(gitDirFromLayout(worktree), 'autopilot.json'));
    // Not one spawn, so there was nothing for the timeout to break.
    expect(childProcessMock.calls).toHaveLength(0);
  });

  it('never joins onto <worktree>/.git, which is a file', () => {
    // The defect the module exists to prevent, and the one a literal fallback
    // would reintroduce the moment git stopped answering.
    childProcessMock.forceTimeout = true;
    const p = gitPath(worktree, 'autopilot.json');
    expect(p.replace(/\\/g, '/')).toContain('/worktrees/');
    expect(p).not.toBe(path.join(worktree, '.git', 'autopilot.json'));
  });

  it('keeps returning a string for a non-repository, so hooks never throw', () => {
    // Twelve hook call sites join onto this return value and stat it. A null
    // here would throw inside a hook, which takes the session event down.
    childProcessMock.forceTimeout = true;
    expect(typeof gitPath(notARepo, 'autopilot.json')).toBe('string');
    expect(gitPath(notARepo, 'autopilot.json'))
      .toBe(path.join(notARepo, '.git', 'autopilot.json'));
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
