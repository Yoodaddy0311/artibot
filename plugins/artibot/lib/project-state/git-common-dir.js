/**
 * Pure-fs resolution of a repository's git COMMON directory.
 *
 * ── Why this exists next to `lib/git/git-dir.js` ──────────────────────────
 * Two reasons, and neither is a preference:
 *
 *   1. **L2 does not shell out.** `state-manager.js` reaches git through an
 *      INJECTED port precisely so the store stays testable against a tmpdir
 *      and this layer never spawns a process. `lib/git/git-dir.js#getGitDir`
 *      is `execSync`, so re-using it would put a child process behind an L2
 *      import and undo that.
 *   2. **Hook latency.** The store is read on the UserPromptSubmit path.
 *      Spawning `git rev-parse` there costs a process launch on EVERY prompt,
 *      on Windows the most expensive platform for exactly that. Reading one
 *      or two small files costs neither.
 *
 * ── COMMON dir, not git dir — they differ exactly where it matters ────────
 * Inside a linked worktree these are two different paths:
 *
 *   git dir     `<main>/.git/worktrees/<name>`   per-worktree, diverges
 *   common dir  `<main>/.git`                    shared by every worktree
 *
 * `getGitDir` returns the FIRST. The store needs the SECOND (design decision
 * F3): a store under the per-worktree git dir would give each `/split` window
 * its own divergent copy, which is the measured failure the design rejects.
 * So this is not a no-shell clone of `getGitDir`; it answers another question.
 *
 * ── What this deliberately does NOT do ────────────────────────────────────
 *   - **No walk-up.** `<projectRoot>/.git` or nothing. A parent-directory
 *     search would let a nested project silently bind to an ancestor
 *     repository's store. The ledger applies the same rule to the same
 *     `projectRoot`, and the two must not disagree about which repo they mean.
 *   - **No `GIT_DIR` / `GIT_COMMON_DIR` env support.** Honouring them would
 *     make the store location depend on the environment of whichever process
 *     happened to read it, so a hook and a CLI in one repo could resolve to
 *     different stores.
 *   - **No submodule handling.** A submodule's `.git` file points at
 *     `<super>/.git/modules/<name>`, which has no `commondir`; the result is
 *     that directory itself. Correct-by-accident is not claimed here — it is
 *     simply untested and unsupported.
 *   - **No repository validation.** A `.git` directory is taken at its word.
 *     Whether it holds a usable object database is git's question, not this
 *     resolver's.
 *
 * Callers get `null` and decide. `resolveStoreLocation` turns `null` into the
 * reported `project-root-fallback`, never a silent one.
 *
 * @module lib/project-state/git-common-dir
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * Prefix of the pointer line in a linked worktree's `.git` FILE.
 *
 * Matched case-sensitively: git writes it lowercase, and this module's rule
 * set is an allowlist — an unrecognised shape yields `null` rather than a
 * guess at what the author meant.
 */
const GITDIR_PREFIX = 'gitdir:';

/** Name of the file inside a per-worktree git dir that points at the common dir. */
const COMMONDIR_FILE = 'commondir';

/**
 * Read `<gitDir>/commondir` and apply it, or fall back to `gitDir` itself.
 *
 * The content is resolved against `gitDir` because git writes it RELATIVE
 * (`../..` in a standard linked worktree). `path.resolve` also passes an
 * absolute value through unchanged, so both spellings work without a branch.
 *
 * An unreadable `commondir` — absent, a directory, permission-denied — is
 * treated as "there is no common dir indirection here", which is the truth in
 * a main checkout, where git creates no such file.
 *
 * @param {string} gitDir - Absolute git directory to inspect.
 * @returns {string} Absolute common directory.
 */
function applyCommonDirPointer(gitDir) {
  const absolute = path.resolve(gitDir);
  let raw;
  try {
    raw = fs.readFileSync(path.join(absolute, COMMONDIR_FILE), 'utf8');
  } catch {
    return absolute;
  }
  const target = String(raw).trim();
  // Guarded rather than left to path.resolve: an empty segment is ignored by
  // resolve, so the result would be right by luck. Saying so is cheaper than
  // depending on it.
  if (target === '') return absolute;
  return path.resolve(absolute, target);
}

/**
 * Resolve the git common directory for a project root, without running git.
 *
 * Recognised shapes, in order — anything else is `null`:
 *
 * | `<projectRoot>/.git` | Result |
 * |---|---|
 * | directory, no `commondir` | `<projectRoot>/.git` (ordinary checkout) |
 * | directory, with `commondir` | that pointer, resolved against `.git` |
 * | file `gitdir: <p>` , no `commondir` | `<p>` resolved against `projectRoot` |
 * | file `gitdir: <p>` , with `commondir` | pointer resolved against `<p>` |
 * | missing, unreadable, or malformed | `null` |
 *
 * Never throws. Every caller sits on a hook path where a thrown error takes
 * the session event down, and `projectRoot` is routinely a directory that is
 * not a repository at all — that is an expected input, not an error.
 *
 * @param {string} projectRoot - Absolute project root to resolve from.
 * @returns {string|null} Absolute common directory, or `null` when no
 *   recognised repository marker sits directly at `projectRoot`.
 * @example
 * // Linked worktree: .git file -> gitdir: <main>/.git/worktrees/x, commondir '../..'
 * resolveGitCommonDir('/repo/.worktrees/x'); // '/repo/.git'
 * @example
 * resolveGitCommonDir('/not/a/repo'); // null
 */
export function resolveGitCommonDir(projectRoot) {
  if (typeof projectRoot !== 'string' || projectRoot === '') return null;

  const dotGit = path.join(projectRoot, '.git');
  let stats;
  try {
    // statSync, not lstatSync: a symlinked or junctioned `.git` is still a
    // `.git` and must be recognised. The path is NOT realpath-ed afterwards,
    // so the LINK path is what comes back — writes go through it fine, and
    // realpath-ing would make one repository resolve to two store locations
    // depending on whether the caller reached it through a link.
    stats = fs.statSync(dotGit);
  } catch {
    return null;
  }

  if (stats.isDirectory()) return applyCommonDirPointer(dotGit);
  // Neither a directory nor a file — a socket or device named `.git` is not a
  // repository, and reading it could block.
  if (!stats.isFile()) return null;

  let raw;
  try {
    raw = fs.readFileSync(dotGit, 'utf8');
  } catch {
    return null;
  }
  // Only the first line carries the pointer. Splitting on /\r?\n/ rather than
  // trimming the whole file keeps a CRLF-written pointer from dragging the
  // carriage return into the path — on Windows that would produce a path that
  // looks correct in a log and does not exist on disk.
  const [firstLine = ''] = String(raw).split(/\r?\n/);
  const line = firstLine.trim();
  if (!line.startsWith(GITDIR_PREFIX)) return null;

  const target = line.slice(GITDIR_PREFIX.length).trim();
  if (target === '') return null;

  return applyCommonDirPointer(path.resolve(projectRoot, target));
}
