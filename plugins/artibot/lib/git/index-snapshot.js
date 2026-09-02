/**
 * Git index snapshot / restore for automated commits.
 *
 * Every automated commit in this plugin follows the same shape: stage, then
 * commit, and swallow a failure. The staging half is not undone by that
 * swallow, so a commit rejected by a pre-commit hook left the index holding
 * everything `git add -A` had swept in. The operator's next `git commit`
 * then published all of it — design docs, scratch files, `.artibot/`, and
 * anything else in the tree. `rules/verification-discipline.md` bans
 * `git add -A` for humans for exactly this reason; the automation was doing
 * it unattended (lane C finding C-1, 2026-08-30).
 *
 * Restoration is by INDEX TREE, not by `git reset`. `git reset` (mixed) also
 * unstages whatever the operator had staged by hand before the automation
 * ran, which turns one silent surprise into another. `git write-tree` records
 * the index as a tree object and `git read-tree` puts that exact index back —
 * including "the operator had `foo.txt` staged and nothing else" — and neither
 * command touches the working tree, so no edit on disk can be lost here.
 *
 * Measured 2026-08-30 (git 2.51.0, scratch repo): from `A manual.txt` +
 * `?? stray.txt`, a `git add -A` moves `stray.txt` to `A `; `read-tree` of the
 * snapshot returns the status output byte-for-byte to its pre-add value and
 * leaves `stray.txt` on disk with its contents intact.
 *
 * Both halves are best-effort by design. A snapshot that cannot be taken
 * (unmerged index during a conflict, not a repository, git missing) yields
 * `null`, and a `null` snapshot makes restore a no-op rather than reading some
 * other tree over the index — failing to clean up is recoverable, clobbering
 * the index is not.
 *
 * @module lib/git/index-snapshot
 */

/**
 * A synchronous git runner bound to a working directory. Must throw (or return
 * a falsy value) when git fails — the standard `execSync`/`execFileSync` shape.
 *
 * @callback SyncGitRunner
 * @param {string[]} args
 * @returns {string} stdout
 */

/**
 * An asynchronous git runner bound to a working directory, in the
 * `{ code, stdout }` shape `scripts/cron/auto-commit-runner.js` already uses.
 *
 * @callback AsyncGitRunner
 * @param {string[]} args
 * @returns {Promise<{ code: number, stdout?: string }>}
 */

/**
 * Record the current index as a tree object.
 *
 * @param {SyncGitRunner} runGit
 * @returns {string|null} tree sha, or null when the index could not be recorded
 */
export function captureIndexTree(runGit) {
  try {
    const out = runGit(['write-tree']);
    const sha = typeof out === 'string' ? out.trim() : '';
    return sha || null;
  } catch {
    return null;
  }
}

/**
 * Put a previously captured index back. Never touches the working tree.
 *
 * @param {SyncGitRunner} runGit
 * @param {string|null} tree tree sha from {@link captureIndexTree}
 * @returns {boolean} true when the index was restored
 */
export function restoreIndexTree(runGit, tree) {
  if (!tree || typeof tree !== 'string') return false;
  try {
    runGit(['read-tree', tree]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Async twin of {@link captureIndexTree}.
 *
 * @param {AsyncGitRunner} runGit
 * @returns {Promise<string|null>}
 */
export async function captureIndexTreeAsync(runGit) {
  try {
    const res = await runGit(['write-tree']);
    if (!res || res.code !== 0) return null;
    const sha = typeof res.stdout === 'string' ? res.stdout.trim() : '';
    return sha || null;
  } catch {
    return null;
  }
}

/**
 * Async twin of {@link restoreIndexTree}.
 *
 * @param {AsyncGitRunner} runGit
 * @param {string|null} tree
 * @returns {Promise<boolean>}
 */
export async function restoreIndexTreeAsync(runGit, tree) {
  if (!tree || typeof tree !== 'string') return false;
  try {
    const res = await runGit(['read-tree', tree]);
    return Boolean(res) && res.code === 0;
  } catch {
    return false;
  }
}
