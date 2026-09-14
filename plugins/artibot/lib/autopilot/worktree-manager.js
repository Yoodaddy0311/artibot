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
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
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
 * Run a git command, normalizing spawn errors into a uniform result so callers
 * can distinguish "git said no" (status 1) from "the lookup itself broke"
 * (status null / non-zero non-1) — the distinction the fail-closed evidence
 * allowlist depends on.
 * @param {string[]} args
 * @param {string} [cwd]
 * @returns {{ok: boolean, status: number|null, stdout: string, stderr: string}}
 */
function git(args, cwd) {
  try {
    const r = spawnSync('git', args, gitOpts(cwd));
    if (r.error) {
      return { ok: false, status: null, stdout: '', stderr: r.error.message || 'spawn error' };
    }
    return {
      ok: r.status === 0,
      status: r.status,
      stdout: r.stdout || '',
      stderr: r.stderr || '',
    };
  } catch (err) {
    return { ok: false, status: null, stdout: '', stderr: err?.message || 'git spawn threw' };
  }
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
 * Canonicalize a path for comparison against `git worktree list` output.
 *
 * `getWorktreesRoot()` can fall back to `os.tmpdir()`, which on Windows is the
 * 8.3 short form (`...\HEECHA~1\...` style), while git porcelain reports the
 * resolved long form. A plain `path.normalize` compare then never matches, and
 * the caller silently loses the branch name.
 * @param {string} p
 * @returns {string}
 */
function canonicalPath(p) {
  let resolved = p;
  try {
    resolved = realpathSync.native(p);
  } catch {
    /* path may not exist yet — fall back to lexical normalization */
  }
  const normalized = path.normalize(resolved);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
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
    const wtPath = canonicalPath(getWorktreePath(sessionId));
    for (const rec of parsePorcelain(result.stdout || '')) {
      if (canonicalPath(rec.path) === wtPath) return rec.branch;
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
      // Full refname, not `:short` — short names become `heads/<x>` when a tag
      // or remote branch shares the name, which would no longer match the
      // branch's own ref in the evidence sweep.
      ['for-each-ref', '--format=%(refname)', `refs/heads/${prefix}`],
      gitOpts(cwd),
    );
    if (result.error || result.status !== 0) return [];
    return (result.stdout || '')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s.startsWith('refs/heads/'))
      .map((s) => s.slice('refs/heads/'.length));
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
 * Result preservation (F01): an orphan branch is deleted only when
 * {@link resolveIntegrationEvidence} finds its tip reachable from another ref.
 * Branches carrying unintegrated commits are reported in `preserved` and left
 * on disk — "no live worktree" is not evidence that the work was integrated.
 * @param {{cwd?: string, reapBranches?: boolean, integrationTarget?: string|null}} [opts]
 *   reapBranches — defaults true; set false for prune-only behavior.
 * @returns {{pruned: number, branchesDeleted: number,
 *   removed: Array<{branch: string, sha: string|null, reason: string}>,
 *   preserved: Array<{branch: string, sha: string|null, reason: string}>}}
 */
export function pruneOrphans(opts = {}) {
  const result = spawnSync('git', ['worktree', 'prune', '--verbose'], gitOpts(opts.cwd));
  if (result.error || result.status !== 0) {
    return { pruned: 0, branchesDeleted: 0, removed: [], preserved: [] };
  }
  const out = (result.stdout || '') + (result.stderr || '');
  const matches = out.match(/Removing worktrees\/|Removing\s+/gi);
  listCache = null;

  const removed = [];
  const preserved = [];
  if (opts.reapBranches !== false) {
    // Branches still attached to a live worktree must be preserved. Resolve the
    // live set from the SAME repo we are pruning (cwd-scoped porcelain) so the
    // guard is accurate under test isolation and multi-repo operation.
    const live = new Set(liveWorktreeBranches(opts.cwd));
    for (const branch of listLocalBranches(AUTOPILOT_BRANCH_PREFIX, opts.cwd)) {
      if (live.has(branch)) continue;
      reapOrphanBranch(branch, opts, removed, preserved);
    }
  }
  return {
    pruned: matches ? matches.length : 0,
    branchesDeleted: removed.length,
    removed,
    preserved,
  };
}

/**
 * Decide one orphan branch's fate and push the outcome onto the report arrays.
 * @param {string} branch
 * @param {{cwd?: string, integrationTarget?: string|null}} opts
 * @param {object[]} removed
 * @param {object[]} preserved
 */
function reapOrphanBranch(branch, opts, removed, preserved) {
  const revParse = git(['rev-parse', branch], opts.cwd);
  const sha = revParse.ok ? revParse.stdout.trim() : null;
  const evidence = resolveIntegrationEvidence(sha, {
    cwd: opts.cwd,
    integrationTarget: opts.integrationTarget,
    selfBranch: branch,
  });
  if (!evidence.integrated) {
    preserved.push({ branch, sha, reason: evidence.reason });
    return;
  }
  if (deleteAutopilotBranch(branch, opts.cwd)) {
    removed.push({ branch, sha, reason: evidence.reason });
  } else {
    preserved.push({ branch, sha, reason: 'branch-delete-failed' });
  }
}

/**
 * Decide whether a commit is safe to discard.
 *
 * Allowlist, never a deny-list: deletion is permitted ONLY when at least one
 * positive piece of evidence says the commit survives elsewhere. A deny-list
 * ("delete unless X") fails open the moment a new way of holding work appears.
 *
 *   (a) `<sha>` is an ancestor of an explicit `integrationTarget`;
 *   (b) some ref under refs/heads or refs/remotes other than the branch we are
 *       about to delete contains `<sha>` — this is what lets a pushed-but-
 *       unmerged branch count, and what keeps a zero-commit session branch
 *       (still sitting on the base tip) deletable.
 *
 * Any failure of the lookups themselves is fail-closed: unknown means keep.
 * @param {string|null} sha
 * @param {{cwd?: string, integrationTarget?: string|null, selfBranch?: string|null}} [opts]
 * @returns {{integrated: boolean, evidence: string[], reason: string}}
 */
export function resolveIntegrationEvidence(sha, opts = {}) {
  const fail = { integrated: false, evidence: [], reason: 'evidence-lookup-failed' };
  if (!sha || typeof sha !== 'string') return fail;
  const { cwd, integrationTarget, selfBranch } = opts;
  const evidence = [];

  const target = typeof integrationTarget === 'string' ? integrationTarget.trim() : '';
  if (target) {
    // exit 0 = ancestor, 1 = not an ancestor (a real answer), anything else
    // (128, spawn failure) = the lookup broke and we must not conclude.
    const anc = git(['merge-base', '--is-ancestor', sha, target], cwd);
    if (anc.status === 0) evidence.push(`integrated-into:${target}`);
    else if (anc.status !== 1) return fail;
  }

  const refs = git(
    ['for-each-ref', '--format=%(refname)', '--contains', sha, 'refs/heads', 'refs/remotes'],
    cwd,
  );
  if (!refs.ok) return fail;
  const selfRef = normalizeSelfRef(selfBranch);
  for (const ref of refs.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
    if (ref === selfRef) continue;
    evidence.push(`reachable-from:${ref}`);
  }

  if (evidence.length === 0) {
    return { integrated: false, evidence, reason: 'no-integration-evidence' };
  }
  return { integrated: true, evidence, reason: 'integrated' };
}

/**
 * Normalize a branch name to a full ref so it can be excluded from the
 * `--contains` sweep (a branch containing its own tip proves nothing).
 * @param {string|null|undefined} selfBranch
 * @returns {string|null}
 */
function normalizeSelfRef(selfBranch) {
  if (!selfBranch || typeof selfBranch !== 'string') return null;
  return selfBranch.startsWith('refs/') ? selfBranch : `refs/heads/${selfBranch}`;
}

/**
 * Does the worktree hold `.artibot/missions` content? Mission files are session
 * results, and they are checked independently of `dirty` because their loss is
 * silent whether or not git tracks them at the moment of the reap.
 * @param {string} wtPath
 * @returns {boolean}
 */
function hasMissions(wtPath) {
  try {
    const dir = path.join(wtPath, '.artibot', 'missions');
    if (!statSync(dir).isDirectory()) return false;
    return readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

/**
 * Describe what a worktree is currently holding: its HEAD commit, the branch it
 * is on, whether the tree has uncommitted changes (untracked files count), and
 * whether mission artifacts are present.
 *
 * `branch` comes from `symbolic-ref` inside the worktree, which is independent
 * of how the path happens to be spelled — unlike matching porcelain output
 * against a locally built path, which breaks on Windows 8.3 short names.
 * `detached` distinguishes "no branch by design" from "the lookup failed",
 * which the caller needs in order to fail closed on the latter.
 * @param {string} wtPath
 * @param {string} [cwd]
 * @returns {{sha: string|null, branch: string|null, detached: boolean,
 *   dirty: boolean, missionsPresent: boolean}}
 */
export function describeWorktreeHead(wtPath, cwd) {
  if (!wtPath || typeof wtPath !== 'string') {
    return { sha: null, branch: null, detached: false, dirty: false, missionsPresent: false };
  }
  const head = git(['-C', wtPath, 'rev-parse', 'HEAD'], cwd);
  const sha = head.ok ? head.stdout.trim() || null : null;
  const ref = git(['-C', wtPath, 'symbolic-ref', '-q', '--short', 'HEAD'], cwd);
  const branch = ref.ok ? ref.stdout.trim() || null : null;
  // `symbolic-ref -q` exits 1 precisely when HEAD is detached; any other
  // non-zero status means the lookup itself broke.
  const detached = !branch && ref.status === 1;
  const status = git(['-C', wtPath, 'status', '--porcelain'], cwd);
  // A status lookup that fails tells us nothing about the tree, so it counts as
  // dirty rather than clean — unknown must never authorize a delete.
  const dirty = status.ok ? status.stdout.trim().length > 0 : true;
  return { sha, branch, detached, dirty, missionsPresent: hasMissions(wtPath) };
}

/**
 * Reap a session's worktree, but only when its commits demonstrably survive
 * elsewhere. Replaces the unconditional remove+branch-delete that could render
 * a committed-but-unmerged session result unreachable.
 *
 * `force` is NOT an override for the preservation rules — it is passed through
 * to `git worktree remove --force` for the case where removal was already
 * authorized. A forced abort therefore no longer discards uncommitted work.
 * @param {string} sessionId
 * @param {{cwd?: string, force?: boolean, integrationTarget?: string|null}} [opts]
 * @returns {{ok: boolean, action: 'removed'|'preserved'|'absent', reason: string,
 *   resultHead: string|null, resultRef: string|null, branch: string|null,
 *   evidence: string[], error?: string}}
 */
export function reapWorktree(sessionId, opts = {}) {
  if (!sessionId || typeof sessionId !== 'string') {
    return { ...emptyReap(), ok: false, reason: 'invalid-session-id' };
  }
  try {
    const { cwd, force = false, integrationTarget = null } = opts;
    const wtPath = getWorktreePath(sessionId);
    // null for a detached worktree — kept null so resultRef stays honest.
    const branch = resolveSessionBranch(sessionId, cwd);
    if (!existsSync(wtPath)) {
      const fallback = branch || `${AUTOPILOT_BRANCH_PREFIX}${sessionId}`;
      return reapMissingWorktree(fallback, { cwd, integrationTarget });
    }
    return reapLiveWorktree(sessionId, wtPath, branch, { cwd, force, integrationTarget });
  } catch (err) {
    return {
      ...emptyReap(),
      ok: false,
      action: 'preserved',
      reason: 'reap-threw',
      error: err?.message || String(err),
    };
  }
}

/**
 * Neutral reap result used as the base of every return shape.
 * @returns {object}
 */
function emptyReap() {
  return {
    ok: true,
    action: 'absent',
    reason: '',
    resultHead: null,
    resultRef: null,
    branch: null,
    evidence: [],
  };
}

/**
 * Worktree directory is gone; only the branch may remain. Delete it when the
 * evidence allowlist permits, otherwise keep it and report why.
 * @param {string} branch
 * @param {{cwd?: string, integrationTarget?: string|null}} opts
 * @returns {object}
 */
function reapMissingWorktree(branch, { cwd, integrationTarget }) {
  const revParse = git(['rev-parse', '--verify', branch], cwd);
  if (!revParse.ok) {
    return { ...emptyReap(), branch, action: 'absent', reason: 'worktree-absent' };
  }
  const sha = revParse.stdout.trim();
  const ev = resolveIntegrationEvidence(sha, { cwd, integrationTarget, selfBranch: branch });
  const base = {
    ...emptyReap(),
    branch,
    resultHead: sha,
    resultRef: `refs/heads/${branch}`,
    evidence: ev.evidence,
  };
  if (!ev.integrated) return { ...base, action: 'preserved', reason: ev.reason };
  if (!deleteAutopilotBranch(branch, cwd)) {
    return { ...base, action: 'preserved', reason: 'branch-delete-failed' };
  }
  return { ...base, action: 'absent', reason: 'worktree-absent', resultRef: null };
}

/**
 * Decide the fate of a worktree that still exists on disk. First match wins:
 * unresolvable head → unresolvable branch → missions → dirty → missing
 * evidence → remove.
 * @param {string} sessionId
 * @param {string} wtPath
 * @param {string|null} porcelainBranch
 * @param {{cwd?: string, force?: boolean, integrationTarget?: string|null}} opts
 * @returns {object}
 */
function reapLiveWorktree(sessionId, wtPath, porcelainBranch, { cwd, force, integrationTarget }) {
  const head = describeWorktreeHead(wtPath, cwd);
  const branch = head.branch ?? porcelainBranch;
  const base = {
    ...emptyReap(),
    branch,
    resultHead: head.sha,
    resultRef: branch ? `refs/heads/${branch}` : null,
  };
  const keep = (reason) => ({ ...base, action: 'preserved', reason });

  if (!head.sha) return keep('head-unresolvable');
  // Without a self branch the evidence sweep would count the very branch we are
  // about to delete as proof of integration. Detached HEADs have no self branch
  // by design and are safe; a failed lookup is not, so it fails closed.
  if (!branch && !head.detached) return keep('branch-unresolvable');
  // Checked before `dirty` so the operator gets the specific reason.
  if (head.missionsPresent) return keep('missions-present');
  if (head.dirty) return keep('dirty-worktree');

  const ev = resolveIntegrationEvidence(head.sha, {
    cwd,
    integrationTarget,
    selfBranch: branch,
  });
  if (!ev.integrated) return { ...keep(ev.reason), evidence: ev.evidence };

  const removal = removeWorktree(sessionId, { cwd, force, deleteBranch: true });
  if (!removal.ok) {
    return {
      ...keep('remove-failed'),
      evidence: ev.evidence,
      error: removal.error || 'worktree removal failed',
    };
  }
  return { ...base, action: 'removed', reason: ev.reason, evidence: ev.evidence };
}
