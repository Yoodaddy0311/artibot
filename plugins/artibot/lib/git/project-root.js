/**
 * Stable project-root resolution for per-project local artifacts.
 *
 * Hooks fire once per turn with a payload whose `cwd` tracks the *shell's*
 * current directory. Anchoring a per-project store on that value splits the
 * store across directories the moment anything runs `cd` mid-session — the
 * ambient ledger was landing in three separate `.artibot/ledger/` trees in a
 * single session (repo root, `plugins/artibot/`, `plugins/artibot/scripts/hooks/`).
 *
 * Resolution order:
 *   1. Nearest ancestor holding `.git`. This is the same answer
 *      `git rev-parse --show-toplevel` gives for plain repos, linked worktrees
 *      and submodules — all three put a `.git` entry (dir or file) at the root
 *      it would report — but costs a few `existsSync` calls instead of a child
 *      process. That matters: these callers are hooks, and session-ledger runs
 *      on EVERY turn. Measured cold cost of the git subprocess on this machine
 *      was 181-270ms (median ~217, n=7), all of it synchronous and therefore
 *      not preemptible by a caller's timeout race.
 *   2. `git rev-parse --show-toplevel` (memoized via repo-root-cache), for
 *      layouts the marker cannot see — notably a `GIT_DIR`/`GIT_WORK_TREE`
 *      override, where git's answer is authoritative and `.git` may be absent.
 *   3. Weak-marker walk, for projects with no git at all. The OUTERMOST
 *      ancestor holding `.artibot` / `package.json` wins, so nested markers
 *      (this repo has `.artibot` at both the root and `plugins/artibot/`)
 *      collapse onto the same answer from any subdirectory.
 *   4. The starting directory, normalized.
 *
 * HOME GUARD: the WEAK-marker walk never accepts the user's home directory.
 * `~/.artibot` exists on any machine with Artibot installed and holds
 * cross-project learning data; without this guard every non-git project under
 * the home directory would resolve its root to the home directory and write
 * session conversation into that shared store. The guard deliberately does NOT
 * apply to `.git` — a dotfiles repo really is rooted at the home directory, and
 * git would say so too.
 *
 * @module lib/git/project-root
 */

import os from 'node:os';
import path from 'node:path';
import { existsSync, realpathSync } from 'node:fs';
import { getRepoRoot } from './repo-root-cache.js';

/** Markers that identify a project root when git cannot answer. */
const VCS_MARKER = '.git';
const WEAK_MARKERS = Object.freeze(['.artibot', 'package.json']);

/**
 * Canonical spelling of an existing path: resolves Windows 8.3 short names
 * (`C:\Users\HEECHA~1`) and symlinks to one stable form. Non-existent paths come
 * back unchanged.
 *
 * Load-bearing for the home guard — a plain string compare lets
 * `C:\Users\HEECHA~1` slip past a guard written against `C:\Users\HeechangLee`.
 * That is not hypothetical: Node's own tmpdir is spelled with a short name on
 * Windows, so the first cut of this module walked a temp directory straight up
 * into the home directory and wrote a ledger into `~/.artibot/ledger/`.
 *
 * @param {string} p
 * @returns {string}
 */
function canonical(p) {
  try {
    return realpathSync.native(p);
  } catch {
    return p; // not yet created — compare as spelled
  }
}

/**
 * True when two paths denote the same directory, allowing for short names and
 * case-insensitive filesystems.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function sameDir(a, b) {
  const ca = canonical(a);
  const cb = canonical(b);
  return process.platform === 'win32'
    ? ca.toLowerCase() === cb.toLowerCase()
    : ca === cb;
}

/**
 * Every ancestor of `start`, nearest-first, including `start` itself.
 * @param {string} start absolute, normalized
 * @returns {string[]}
 */
function ancestors(start) {
  const dirs = [];
  let dir = start;
  for (;;) {
    dirs.push(dir);
    const parent = path.dirname(dir);
    if (parent === dir) break; // filesystem root
    dir = parent;
  }
  return dirs;
}

/**
 * Ancestors of `start`, nearest-first, excluding the user's home directory.
 * Used for WEAK markers only — see the HOME GUARD note in the module header.
 * @param {string} start absolute, normalized
 * @returns {string[]}
 */
function candidateDirs(start) {
  const home = path.resolve(os.homedir() || '');
  return ancestors(start).filter((dir) => !sameDir(dir, home));
}

/**
 * Resolve the stable project root for `cwd`.
 *
 * Always returns an absolute, normalized path — never null — so callers can use
 * it directly to build a store path without a null branch of their own.
 *
 * @param {string} [cwd] directory to resolve from; defaults to `process.cwd()`
 * @returns {string}
 */
export function resolveProjectRoot(cwd) {
  // Canonicalize up front so two spellings of one directory (short name, symlink,
  // differing case) cannot yield two different roots — the writer and the reader
  // must agree on a single string.
  const start = canonical(path.resolve(cwd || process.cwd()));

  // 1. Nearest `.git` — same answer as rev-parse, without the child process.
  //    Not home-guarded: a dotfiles repo is legitimately rooted at $HOME.
  const nearestVcs = ancestors(start).find((d) => existsSync(path.join(d, VCS_MARKER)));
  if (nearestVcs) return nearestVcs;

  // 2. Ask git for the layouts a marker cannot see (GIT_DIR override, …).
  const repoRoot = getRepoRoot(start);
  if (repoRoot) return canonical(path.resolve(repoRoot));

  // 3. Non-git project: outermost weak marker, home excluded.
  const dirs = candidateDirs(start);
  for (let i = dirs.length - 1; i >= 0; i -= 1) {
    if (WEAK_MARKERS.some((m) => existsSync(path.join(dirs[i], m)))) return dirs[i];
  }

  // 4. No signal — keep today's behavior rather than guessing.
  return start;
}

// Test introspection surface (never relied on outside tests).
export const _internals = Object.freeze({
  VCS_MARKER, WEAK_MARKERS, ancestors, candidateDirs,
});
