/**
 * Git worktree isolation manager for autopilot sessions.
 *
 * Creates per-session git worktrees so autopilot can mutate working tree
 * state without disturbing the operator's main checkout. All git invocations
 * use spawnSync with arg-arrays (no shell interpolation) and a 15s timeout.
 *
 * DATA POLICY: no external network, no third-party DB. Only local git CLI.
 *
 * Korean-path safety: the operator's cwd may contain non-ASCII chars
 * (e.g. "바탕 화면"). Git worktree paths on Windows tolerate UTF-8, but
 * when the resolved store dir contains non-ASCII bytes we fall back to
 * an ASCII tmpdir to avoid pathToFileURL / git encoding edge cases.
 *
 * @module lib/autopilot/worktree-manager
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { ensureDirSync } from '../core/file.js';
import { getStoreDir } from './session-store.js';

const GIT_TIMEOUT_MS = 15000;
// eslint-disable-next-line no-control-regex
const NON_ASCII = /[^\x00-\x7F]/;
const AUTOPILOT_BRANCH_PREFIX = 'autopilot/';

/**
 * Build the spawnSync git option bag, threading an optional explicit cwd so
 * callers (and tests) can target an isolated repo instead of inheriting
 * process.cwd(). When cwd is omitted git uses the inherited working directory.
 * @param {string} [cwd]
 * @returns {{encoding: 'utf-8', timeout: number, cwd?: string}}
 */
function gitOpts(cwd) {
  const opts = { encoding: 'utf-8', timeout: GIT_TIMEOUT_MS };
  if (cwd) opts.cwd = cwd;
  return opts;
}

/**
 * Best-effort delete of a local branch, guarded to the `autopilot/` prefix.
 * Never throws; user branches (master/claude/*) are refused outright.
 * @param {string|null|undefined} branch
 * @param {string} [cwd]
 * @returns {boolean} true when a delete was attempted and succeeded
 */
function deleteAutopilotBranch(branch, cwd) {
  if (!branch || typeof branch !== 'string') return false;
  if (!branch.startsWith(AUTOPILOT_BRANCH_PREFIX)) return false;
  try {
    const result = spawnSync('git', ['branch', '-D', branch], gitOpts(cwd));
    return !result.error && result.status === 0;
  } catch {
    return false;
  }
}

/**
 * Resolve the branch a session's worktree is checked out on, by scanning
 * `git worktree list --porcelain`. Returns null for detached worktrees or
 * when the session worktree is not found.
 * @param {string} sessionId
 * @param {string} [cwd]
 * @returns {string|null}
 */
function resolveSessionBranch(sessionId, cwd) {
  try {
    const result = spawnSync('git', ['worktree', 'list', '--porcelain'], gitOpts(cwd));
    if (result.error || result.status !== 0) return null;
    const wtPath = path.normalize(getWorktreePath(sessionId));
    for (const rec of parsePorcelain(result.stdout || '')) {
      if (path.normalize(rec.path) === wtPath) return rec.branch;
    }
  } catch {
    /* best-effort */
  }
  return null;
}

/**
 * Resolve the worktrees root directory.
 * Falls back to an ASCII tmpdir if the plugin store path contains non-ASCII
 * characters (Korean cwd protection).
 * @returns {string} absolute directory path
 */
export function getWorktreesRoot() {
  const candidate = path.join(getStoreDir(), 'worktrees');
  if (NON_ASCII.test(candidate)) {
    return path.join(os.tmpdir(), 'artibot-autopilot-worktrees');
  }
  return candidate;
}

/**
 * Resolve the absolute path for a session's worktree.
 * @param {string} sessionId
 * @returns {string}
 */
export function getWorktreePath(sessionId) {
  if (!sessionId || typeof sessionId !== 'string') {
    throw new TypeError('sessionId must be a non-empty string');
  }
  return path.join(getWorktreesRoot(), sessionId);
}

/**
 * Create a git worktree for the given session.
 * Default behaviour: create a fresh branch `autopilot/{sessionId}` based on HEAD.
 * @param {string} sessionId
 * @param {{branch?: string, detached?: boolean, baseRef?: string, cwd?: string}} [opts]
 *   cwd — optional repo root for the git invocation. Defaults to the inherited
 *   process.cwd(). Injectable so tests run against an isolated temp repo
 *   instead of the operator's real checkout (no process.chdir — vitest parallel
 *   safety).
 * @returns {{ok: boolean, path?: string, branch?: string|null, error?: string}}
 */
export function createWorktree(sessionId, opts = {}) {
  if (!sessionId || typeof sessionId !== 'string') {
    return { ok: false, error: 'sessionId must be a non-empty string' };
  }
  const detached = Boolean(opts.detached);
  const branch = detached ? null : (opts.branch || `autopilot/${sessionId}`);
  const baseRef = opts.baseRef || 'HEAD';
  const wtPath = getWorktreePath(sessionId);

  try {
    ensureDirSync(getWorktreesRoot());
  } catch (err) {
    return { ok: false, error: `ensureDir failed: ${err.message}` };
  }

  const args = detached
    ? ['worktree', 'add', '--detach', wtPath, baseRef]
    : ['worktree', 'add', '-b', branch, wtPath, baseRef];

  const result = spawnSync('git', args, gitOpts(opts.cwd));
  if (result.error) {
    return { ok: false, error: `git spawn error: ${result.error.message}` };
  }
  if (result.status !== 0) {
    const stderr = (result.stderr || '').trim();
    return { ok: false, error: stderr || `git exited with code ${result.status}` };
  }
  listCache = null;
  return { ok: true, path: wtPath, branch };
}

/**
 * Remove a session's worktree. Idempotent — returns ok:true if already gone.
 *
 * Branch-leak guard: after the worktree is removed we also `git branch -D`
 * the session's `autopilot/{sessionId}` branch so it does not accumulate
 * (root cause of the 393-branch leak). Only `autopilot/`-prefixed branches
 * are ever deleted; detached worktrees (branch=null) are skipped. The branch
 * is resolved from porcelain *before* removal, then deleted *after*, and the
 * delete is best-effort (never affects the returned ok status).
 * @param {string} sessionId
 * @param {{force?: boolean, cwd?: string, deleteBranch?: boolean}} [opts]
 *   cwd — optional repo root for git (test isolation; no process.chdir).
 *   deleteBranch — defaults true; set false to keep the branch.
 * @returns {{ok: boolean, error?: string, branchDeleted?: boolean}}
 */
export function removeWorktree(sessionId, opts = {}) {
  if (!sessionId || typeof sessionId !== 'string') {
    return { ok: false, error: 'sessionId must be a non-empty string' };
  }
  const wtPath = getWorktreePath(sessionId);
  const deleteBranch = opts.deleteBranch !== false;
  // Resolve the branch BEFORE removal — `git worktree list` no longer reports
  // the worktree once it is gone, so we would otherwise lose the branch name.
  const branch = deleteBranch ? resolveSessionBranch(sessionId, opts.cwd) : null;
  const args = ['worktree', 'remove'];
  if (opts.force) args.push('--force');
  args.push(wtPath);

  const result = spawnSync('git', args, gitOpts(opts.cwd));
  if (result.error) {
    if (result.error.code === 'ENOENT') return { ok: true };
    return { ok: false, error: `git spawn error: ${result.error.message}` };
  }
  if (result.status !== 0) {
    const stderr = (result.stderr || '').trim();
    if (/not a working tree|is not a working tree|No such file/i.test(stderr) ||
        /could not find/i.test(stderr)) {
      // Worktree already gone — still attempt branch cleanup as a fallback,
      // using the convention name when porcelain gave us nothing.
      const fallbackBranch = branch || `${AUTOPILOT_BRANCH_PREFIX}${sessionId}`;
      const branchDeleted = deleteBranch
        ? deleteAutopilotBranch(fallbackBranch, opts.cwd)
        : false;
      return { ok: true, branchDeleted };
    }
    return { ok: false, error: stderr || `git exited with code ${result.status}` };
  }
  listCache = null;
  const branchDeleted = deleteBranch
    ? deleteAutopilotBranch(branch || `${AUTOPILOT_BRANCH_PREFIX}${sessionId}`, opts.cwd)
    : false;
  return { ok: true, branchDeleted };
}

/**
 * Parse `git worktree list --porcelain` output into structured records.
 * @param {string} raw
 * @returns {Array<{path: string, branch: string|null, sha: string|null}>}
 */
function parsePorcelain(raw) {
  if (!raw) return [];
  const blocks = raw.split(/\r?\n\r?\n/).map((b) => b.trim()).filter(Boolean);
  return blocks.map((block) => {
    const rec = { path: '', branch: null, sha: null };
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('worktree ')) rec.path = line.slice(9).trim();
      else if (line.startsWith('HEAD ')) rec.sha = line.slice(5).trim();
      else if (line.startsWith('branch ')) {
        const ref = line.slice(7).trim();
        rec.branch = ref.startsWith('refs/heads/') ? ref.slice(11) : ref;
      } else if (line === 'detached') {
        rec.branch = null;
      }
    }
    return rec;
  }).filter((r) => r.path);
}

const LIST_CACHE_TTL_MS = 5000;
let listCache = null;

/**
 * Invalidate the in-process listWorktrees cache. Called automatically by
 * createWorktree / removeWorktree / pruneOrphans; also exported for tests.
 */
export function invalidateListCache() {
  listCache = null;
}

/**
 * List all git worktrees known to the current repo. Annotated records are
 * cached for LIST_CACHE_TTL_MS to avoid repeated git CLI forks; mutation
 * helpers in this module invalidate the cache automatically.
 * @param {{autopilotOnly?: boolean}} [opts]
 * @returns {Array<{path: string, branch: string|null, sha: string|null, sessionId?: string}>}
 */
export function listWorktrees(opts = {}) {
  const now = Date.now();
  let annotated;
  if (listCache && now - listCache.ts < LIST_CACHE_TTL_MS) {
    annotated = listCache.records;
  } else {
    const result = spawnSync('git', ['worktree', 'list', '--porcelain'], {
      encoding: 'utf-8',
      timeout: GIT_TIMEOUT_MS,
    });
    if (result.error || result.status !== 0) return [];
    const records = parsePorcelain(result.stdout || '');
    const root = getWorktreesRoot();
    annotated = records.map((r) => {
      const norm = path.normalize(r.path);
      // Always return the normalized path so callers can do
      // `rec.path.startsWith(getWorktreesRoot())` reliably across platforms
      // (git porcelain emits forward slashes on Windows, but our root uses
      // OS-native separators).
      if (norm.startsWith(path.normalize(root) + path.sep)) {
        return { ...r, path: norm, sessionId: path.basename(norm) };
      }
      return { ...r, path: norm };
    });
    listCache = { ts: now, records: annotated };
  }
  if (opts.autopilotOnly) return annotated.filter((r) => r.sessionId);
  return annotated;
}

/**
 * List local branches that match a prefix (best-effort, empty on failure).
 * @param {string} prefix
 * @param {string} [cwd]
 * @returns {string[]}
 */
function listLocalBranches(prefix, cwd) {
  try {
    const result = spawnSync(
      'git',
      ['for-each-ref', '--format=%(refname:short)', `refs/heads/${prefix}`],
      gitOpts(cwd),
    );
    if (result.error || result.status !== 0) return [];
    return (result.stdout || '')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Resolve the set of branch names currently checked out across all worktrees
 * of the given repo (cwd-scoped). Best-effort; empty on failure.
 * @param {string} [cwd]
 * @returns {string[]}
 */
function liveWorktreeBranches(cwd) {
  try {
    const result = spawnSync('git', ['worktree', 'list', '--porcelain'], gitOpts(cwd));
    if (result.error || result.status !== 0) return [];
    return parsePorcelain(result.stdout || '')
      .map((r) => r.branch)
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Run `git worktree prune` then reap orphaned `autopilot/*` branches — local
 * branches under that prefix whose backing worktree no longer exists. This is
 * the production reaper wired into engine abort/finalize paths to stop the
 * branch-leak accumulation at session boundaries.
 *
 * Safety: only `autopilot/`-prefixed branches are ever inspected or deleted;
 * any branch still checked out in a live worktree is left untouched. User
 * branches (master/claude/*) are never matched.
 * @param {{cwd?: string, reapBranches?: boolean}} [opts]
 *   reapBranches — defaults true; set false for prune-only behavior.
 * @returns {{pruned: number, branchesDeleted: number}}
 */
export function pruneOrphans(opts = {}) {
  const result = spawnSync('git', ['worktree', 'prune', '--verbose'], gitOpts(opts.cwd));
  if (result.error || result.status !== 0) return { pruned: 0, branchesDeleted: 0 };
  const out = (result.stdout || '') + (result.stderr || '');
  const matches = out.match(/Removing worktrees\/|Removing\s+/gi);
  listCache = null;

  let branchesDeleted = 0;
  if (opts.reapBranches !== false) {
    // Branches still attached to a live worktree must be preserved. Resolve the
    // live set from the SAME repo we are pruning (cwd-scoped porcelain) so the
    // guard is accurate under test isolation and multi-repo operation.
    const live = new Set(liveWorktreeBranches(opts.cwd));
    for (const branch of listLocalBranches(AUTOPILOT_BRANCH_PREFIX, opts.cwd)) {
      if (live.has(branch)) continue;
      if (deleteAutopilotBranch(branch, opts.cwd)) branchesDeleted += 1;
    }
  }
  return { pruned: matches ? matches.length : 0, branchesDeleted };
}
