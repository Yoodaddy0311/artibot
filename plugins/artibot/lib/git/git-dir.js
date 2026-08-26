/**
 * Git directory resolution.
 *
 * A repository's git directory is NOT always `<root>/.git/`. Inside a linked
 * worktree, `<root>/.git` is a regular FILE containing `gitdir: <path>`, and the
 * real directory lives at `<main>/.git/worktrees/<name>/`. Joining `'.git'` onto
 * a worktree root therefore produces a path that cannot be written to and, on
 * read, silently resolves to nothing.
 *
 * That split is what makes partial adoption dangerous: if one hook writes
 * through this module and another still joins `'.git'` by hand, a worktree
 * session writes its state to the real git dir and reads it back from a path
 * that does not exist. The state does not merely go stale — the two halves
 * disagree about where it lives. Convert call sites together, not one at a time.
 *
 * @module lib/git/git-dir
 */

import path from 'node:path';
import { execSync } from 'node:child_process';

/**
 * Resolve the git directory for a working directory.
 *
 * Returns the per-worktree git dir (`<main>/.git/worktrees/<name>`) inside a
 * linked worktree and `<root>/.git` in an ordinary checkout — in both cases a
 * real directory that can be written to.
 *
 * Never throws: hooks call this on paths that may not be repositories at all,
 * and a hook that throws takes the whole session event down with it. Callers
 * get `null` and decide.
 *
 * `execSync` with a constant command, matching the hook it was promoted from
 * (`git-autopilot-setup.js`) and the rest of the hook layer: there is nothing
 * to interpolate here, and the hooks' tests drive git through a single
 * `execSync` seam.
 *
 * @param {string} cwd - Directory to resolve from.
 * @returns {string|null} Absolute git directory, or null when it cannot be resolved.
 */
export function getGitDir(cwd) {
  if (!cwd || typeof cwd !== 'string') return null;
  try {
    const out = execSync('git rev-parse --absolute-git-dir', {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
      windowsHide: true,
    });
    const resolved = String(out).trim();
    return resolved ? path.resolve(resolved) : null;
  } catch {
    return null;
  }
}

/**
 * Build a path inside the repository's git directory.
 *
 * Use this instead of `path.join(repoRoot, '.git', ...)` — it is the whole
 * point of the module. When the git dir cannot be resolved (not a repository,
 * git missing from PATH) it falls back to the literal `<repoRoot>/.git`, which
 * reproduces the previous behavior exactly: in a non-repository that path does
 * not exist either way, so the caller's `existsSync` check fails as before and
 * the hook skips. The fallback lives here so no hook has to spell `'.git'`.
 *
 * @param {string} repoRoot - Repository or worktree root.
 * @param {...string} segments - Path segments to append to the git directory.
 * @returns {string} Absolute path inside the git directory.
 */
export function gitPath(repoRoot, ...segments) {
  const gitDir = getGitDir(repoRoot) || path.join(repoRoot, '.git');
  return path.join(gitDir, ...segments);
}
