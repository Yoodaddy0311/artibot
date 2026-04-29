/**
 * Base branch resolver for autopilot hooks.
 * Determines the upstream "base" branch (e.g. main / master) for a given
 * autopilot working branch using a multi-step fallback strategy.
 *
 * Resolution order:
 *   1. Explicit `baseBranch` field in the autopilot config (if provided).
 *   2. `refs/remotes/origin/HEAD` symbolic-ref → strips `origin/` prefix.
 *   3. Local `master` then `main` via `git rev-parse --verify`.
 *
 * Returns `null` only when every probe fails (extremely unusual; signals a
 * malformed repository). Callers should treat null as "skip operation".
 *
 * @module lib/git/resolve-base
 */

import { execFileSync } from 'node:child_process';

/**
 * Run `git` with argv-array (shell-free) and return trimmed stdout.
 * Returns null on any failure so callers can chain fallbacks.
 *
 * @param {string[]} args
 * @param {string} cwd
 * @returns {string|null}
 */
function git(args, cwd) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Resolve `origin/HEAD` to its short branch name (e.g. "main").
 *
 * @param {string} cwd
 * @returns {string|null}
 */
function resolveOriginHead(cwd) {
  const ref = git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], cwd);
  if (!ref) return null;
  // Expected form: "origin/main" — strip the leading "origin/".
  const slash = ref.indexOf('/');
  return slash >= 0 ? ref.slice(slash + 1) : ref;
}

/**
 * Verify a branch (or any rev) exists locally.
 *
 * @param {string} ref
 * @param {string} cwd
 * @returns {boolean}
 */
function verifyRef(ref, cwd) {
  return git(['rev-parse', '--verify', '--quiet', ref], cwd) !== null;
}

/**
 * Resolve the base branch using config-first, then origin/HEAD, then fallbacks.
 *
 * @param {string} cwd       - Repo root
 * @param {object} [config]  - Parsed autopilot config (may be null/undefined)
 * @returns {string|null}    - Branch name, or null if no candidate verifies
 */
export function resolveBaseBranch(cwd, config) {
  // 1. Explicit override always wins — trust the operator.
  if (config && typeof config.baseBranch === 'string' && config.baseBranch.trim()) {
    return config.baseBranch.trim();
  }

  // 2. origin/HEAD (the canonical "default branch" pointer).
  const fromOrigin = resolveOriginHead(cwd);
  if (fromOrigin) return fromOrigin;

  // 3. Conventional locals.
  for (const candidate of ['master', 'main']) {
    if (verifyRef(candidate, cwd)) return candidate;
  }

  return null;
}
