/**
 * Process-scoped memoizing cache for `git rev-parse` lookups.
 *
 * Stop hooks chain `git rev-parse --show-toplevel` and `git rev-parse HEAD`
 * across multiple files for every Stop event — stop-review-gate +
 * dev-verify-gate alone fire 3 `rev-parse` calls per session-end, each
 * spawning a child process (~30-80ms on Windows). The values do not change
 * during a single hook invocation, so we memoize per (cwd, command) for the
 * lifetime of the Node process.
 *
 * Keyed by absolute cwd so multi-worktree / monorepo setups stay isolated.
 *
 * @module lib/git/repo-root-cache
 */

import path from 'node:path';
import { execSync } from 'node:child_process';

/** @type {Map<string, string|null>} */
const repoRootCache = new Map();

/** @type {Map<string, string|null>} */
const headShaCache = new Map();

/**
 * Normalize cwd to an absolute path; missing cwd → current process cwd.
 * @param {string} [cwd]
 * @returns {string}
 */
function resolveCwd(cwd) {
  return path.resolve(cwd || process.cwd());
}

/**
 * Lazily resolve the repo root for the given cwd. Cached per cwd.
 * Returns null if cwd is not inside a git repo or git is unavailable.
 * @param {string} [cwd]
 * @returns {string|null}
 */
export function getRepoRoot(cwd) {
  const key = resolveCwd(cwd);
  if (repoRootCache.has(key)) return repoRootCache.get(key);
  let value;
  try {
    value = execSync('git rev-parse --show-toplevel', {
      cwd: key,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
      windowsHide: true,
    }).trim() || null;
  } catch {
    value = null;
  }
  repoRootCache.set(key, value);
  return value;
}

/**
 * Lazily resolve HEAD sha for the given cwd. Cached per cwd.
 * Returns null if cwd is not in a git repo or HEAD lookup fails.
 * @param {string} [cwd]
 * @returns {string|null}
 */
export function getHeadSha(cwd) {
  const key = resolveCwd(cwd);
  if (headShaCache.has(key)) return headShaCache.get(key);
  let value;
  try {
    value = execSync('git rev-parse HEAD', {
      cwd: key,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
      windowsHide: true,
    }).trim() || null;
  } catch {
    value = null;
  }
  headShaCache.set(key, value);
  return value;
}

/**
 * Reset memoized state. Test-only — production callers must rely on process
 * lifetime for invalidation.
 */
export function __resetForTest() {
  repoRootCache.clear();
  headShaCache.clear();
}
