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
 *   1. `git rev-parse --show-toplevel` (memoized via repo-root-cache). This is
 *      authoritative for git projects and already handles nested repos,
 *      submodules and linked worktrees.
 *   2. Marker walk, for projects with no git or no `git` binary on PATH.
 *      Nearest ancestor holding `.git` wins (VCS beats heuristics); otherwise
 *      the OUTERMOST ancestor holding `.artibot` / `package.json`, so nested
 *      markers (this repo has `.artibot` at both the root and `plugins/artibot/`)
 *      collapse onto the same answer from any subdirectory.
 *   3. The starting directory, normalized.
 *
 * HOME GUARD: the marker walk never accepts the user's home directory. `~/.artibot`
 * exists on any machine with Artibot installed and holds cross-project learning
 * data; without this guard every non-git project under the home directory would
 * resolve its root to the home directory and write session conversation into
 * that shared store.
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
 * Ancestors of `start`, nearest-first, excluding the user's home directory.
 * @param {string} start absolute, normalized
 * @returns {string[]}
 */
function candidateDirs(start) {
  const home = path.resolve(os.homedir() || '');
  const dirs = [];
  let dir = start;
  for (;;) {
    if (!sameDir(dir, home)) dirs.push(dir);
    const parent = path.dirname(dir);
    if (parent === dir) break; // filesystem root
    dir = parent;
  }
  return dirs;
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

  // 1. git is authoritative when available.
  const repoRoot = getRepoRoot(start);
  if (repoRoot) return canonical(path.resolve(repoRoot));

  // 2. Marker walk. Nearest `.git` first, then outermost weak marker.
  const dirs = candidateDirs(start);
  const nearestVcs = dirs.find((d) => existsSync(path.join(d, VCS_MARKER)));
  if (nearestVcs) return nearestVcs;

  for (let i = dirs.length - 1; i >= 0; i -= 1) {
    if (WEAK_MARKERS.some((m) => existsSync(path.join(dirs[i], m)))) return dirs[i];
  }

  // 3. No signal — keep today's behavior rather than guessing.
  return start;
}

// Test introspection surface (never relied on outside tests).
export const _internals = Object.freeze({ VCS_MARKER, WEAK_MARKERS, candidateDirs });
