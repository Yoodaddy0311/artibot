/**
 * Where the Artibot runtime store lives — ONE rule, two cases.
 *
 * ── The two cases, side by side (decision F3) ─────────────────────────────
 *   git common dir resolves    -> `<commonDir>/artibot/`
 *       N linked worktrees converge on ONE directory, because every linked
 *       worktree shares the main checkout's common dir. This is the point of
 *       the decision: putting the store under a worktree's own `.artibot/`
 *       is the measured failure the design rejects, where each `/split`
 *       window keeps its own divergent copy.
 *   git common dir unresolved  -> `<projectRoot>/.artibot/runtime/`
 *       Per-tree, one directory per root, and therefore divergent the moment
 *       a second tree exists. Taken only when the injected git port yields
 *       nothing (not a repository, git missing, port threw). The fallback is
 *       REPORTED with a reason rather than taken silently.
 *
 * ── Why this rule is its own module ───────────────────────────────────────
 * The rule is shared: the StateStore (journal + snapshot,
 * `lib/project-state/state-manager.js#createStateStore`) and the runtime
 * ledger (`lib/runtime/event-writer.js#ledgerFilePath`, ADR-011) must answer
 * "where does this project's history live?" identically, or `/doctor` Check 8
 * compares two stores that were never meant to line up. One module, imported
 * by both, makes that identity structural instead of a convention.
 *
 * That is also why there is no `node:fs` import here and no git call: this is
 * pure `path` arithmetic over an ALREADY-RESOLVED common dir, handed in by the
 * caller. Resolving git is `lib/project-state/git-common-dir.js`'s job, and
 * keeping the two apart is what lets an L5 module import this one for free.
 *
 * ── Layer ────────────────────────────────────────────────────────────────
 * L2. Importing `lib/runtime/` from here would be a CYCLE — the ledger writer
 * (L5) imports this module, so the edge only runs downward. Do not add one.
 *
 * @module lib/project-state/store-location
 */

import path from 'node:path';

/** Journal + snapshot live in this directory under the git common dir (F3). */
export const STORE_DIR_NAME = 'artibot';

/** Fallback store root when the git common dir cannot be resolved. */
export const FALLBACK_RELATIVE = path.join('.artibot', 'runtime');

/**
 * Resolve where the store lives.
 *
 * @param {object} params - Resolution inputs.
 * @param {string} params.projectRoot - Absolute project root.
 * @param {string|null} [params.gitCommonDir] - Result of the injected git port.
 * @returns {{dir: string, source: 'git-common-dir'|'project-root-fallback', reason: string|null}}
 *   The store directory, which rule produced it, and why the primary rule failed.
 * @example
 * resolveStoreLocation({ projectRoot: '/repo', gitCommonDir: '.git' }).dir;
 * // '/repo/.git/artibot'  — a RELATIVE common dir is resolved against projectRoot
 */
export function resolveStoreLocation({ projectRoot, gitCommonDir }) {
  if (typeof projectRoot !== 'string' || projectRoot === '') {
    throw new TypeError('createStateStore: projectRoot must be a non-empty absolute path');
  }
  if (typeof gitCommonDir === 'string' && gitCommonDir !== '') {
    // Measured on git 2.54.0.windows.1 (2026-09-02): `git rev-parse
    // --git-common-dir` prints a RELATIVE '.git' in a main checkout and an
    // ABSOLUTE path to the main .git in a linked worktree. path.resolve
    // handles both; treating the output as always-absolute would have
    // produced a store at the process CWD in the common case.
    return {
      dir: path.resolve(projectRoot, gitCommonDir, STORE_DIR_NAME),
      source: 'git-common-dir',
      reason: null,
    };
  }
  return {
    dir: path.join(projectRoot, FALLBACK_RELATIVE),
    source: 'project-root-fallback',
    reason:
      'git common dir unresolved (not a repository, git missing, or the injected port returned nothing) — '
      + 'the store is per-worktree here, so two /split windows would keep divergent copies',
  };
}
