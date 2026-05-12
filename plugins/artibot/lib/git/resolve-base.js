/**
 * Base branch resolver for autopilot hooks.
 * Determines the upstream "base" branch (e.g. main / master) for a given
 * autopilot working branch using a multi-step fallback strategy.
 *
 * Resolution order (v4.5.12 — stacked-branch aware):
 *   1. Explicit `baseBranch` field in the autopilot config (if provided).
 *   2. Upstream tracking (`@{upstream}`) when it points at a DIFFERENT
 *      branch (not the branch's own origin tracker). This handles
 *      stacked-PR patterns where the working branch tracks a feature
 *      parent rather than the repo default.
 *   3. `refs/remotes/origin/HEAD` symbolic-ref → strips `origin/` prefix.
 *   4. Local `master` then `main` via `git rev-parse --verify`.
 *
 * Returns `null` only when every probe fails (extremely unusual; signals a
 * malformed repository). Callers should treat null as "skip operation".
 *
 * v4.5.12 fix context: a Stop-hook `git reset --soft <mergeBase>` was
 * computing mergeBase against the repo-wide default branch (origin/HEAD)
 * even for feature branches that diverged from a different fork point
 * (e.g. PRs stacked on PR-base branches). The result resolved to an
 * ancient ancestor and squashed dozens of legitimate commits into one.
 * Step 2 above plus the caller-side commit-age sanity gate close the gap.
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
 * Resolve the current branch's upstream tracking ref, but only when it
 * points at a DIFFERENT branch than the working branch itself. This is
 * how stacked-PR setups are detected: a feature branch typically tracks
 * its origin twin (self), but a stacked branch can track the parent.
 *
 * Returns the upstream branch short-name with the leading remote
 * prefix kept (e.g. `origin/artibot/feature/parent`). Callers use it
 * verbatim as a `merge-base` argument.
 *
 * @param {string} cwd
 * @returns {string|null}
 */
function resolveStackedUpstream(cwd) {
  const currentBranch = git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  if (!currentBranch || currentBranch === 'HEAD') return null; // detached
  const upstream = git(
    ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
    cwd,
  );
  if (!upstream) return null;
  // Skip the common case where upstream is the branch's own origin
  // tracker (e.g. branch=foo, upstream=origin/foo). Stacked tracking
  // means upstream's tail is a DIFFERENT branch name.
  const upstreamTail = upstream.replace(/^[^/]+\//, '');
  if (upstreamTail === currentBranch) return null;
  return upstream;
}

/**
 * Resolve the base branch using config-first, then upstream tracking,
 * then origin/HEAD, then conventional locals.
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

  // 2. Upstream tracking when it points at a different branch (stacked PRs).
  const stacked = resolveStackedUpstream(cwd);
  if (stacked) return stacked;

  // 3. origin/HEAD (the canonical "default branch" pointer).
  const fromOrigin = resolveOriginHead(cwd);
  if (fromOrigin) return fromOrigin;

  // 4. Conventional locals.
  for (const candidate of ['master', 'main']) {
    if (verifyRef(candidate, cwd)) return candidate;
  }

  return null;
}

/**
 * Sanity-check a candidate merge-base commit: refuse to use bases older
 * than `maxAgeDays` (default 30) relative to HEAD. Prevents `git reset
 * --soft <ancient-mergeBase>` from collapsing legitimate history when
 * resolveBaseBranch lands on a stale default branch.
 *
 * Returns true when the merge-base is recent enough to use, false when
 * it should be rejected. Errors (missing commits, malformed timestamps)
 * fail closed → false.
 *
 * @param {string} mergeBase commit SHA (or any rev)
 * @param {string} cwd repo root
 * @param {number} [maxAgeDays=30] reject if mergeBase is older than this
 * @returns {boolean}
 */
export function isMergeBaseFresh(mergeBase, cwd, maxAgeDays = 30) {
  if (!mergeBase || typeof mergeBase !== 'string') return false;
  if (!Number.isFinite(maxAgeDays) || maxAgeDays <= 0) return false;

  const mergeBaseTs = git(['log', '-1', '--format=%ct', mergeBase], cwd);
  const headTs = git(['log', '-1', '--format=%ct', 'HEAD'], cwd);
  if (!mergeBaseTs || !headTs) return false;

  const mb = parseInt(mergeBaseTs, 10);
  const head = parseInt(headTs, 10);
  if (!Number.isFinite(mb) || !Number.isFinite(head)) return false;

  const ageDays = (head - mb) / 86400;
  return ageDays <= maxAgeDays;
}
