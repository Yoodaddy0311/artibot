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
 * @param {{branch?: string, detached?: boolean, baseRef?: string}} [opts]
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

  const result = spawnSync('git', args, { encoding: 'utf-8', timeout: GIT_TIMEOUT_MS });
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
 * @param {string} sessionId
 * @param {{force?: boolean}} [opts]
 * @returns {{ok: boolean, error?: string}}
 */
export function removeWorktree(sessionId, opts = {}) {
  if (!sessionId || typeof sessionId !== 'string') {
    return { ok: false, error: 'sessionId must be a non-empty string' };
  }
  const wtPath = getWorktreePath(sessionId);
  const args = ['worktree', 'remove'];
  if (opts.force) args.push('--force');
  args.push(wtPath);

  const result = spawnSync('git', args, { encoding: 'utf-8', timeout: GIT_TIMEOUT_MS });
  if (result.error) {
    if (result.error.code === 'ENOENT') return { ok: true };
    return { ok: false, error: `git spawn error: ${result.error.message}` };
  }
  if (result.status !== 0) {
    const stderr = (result.stderr || '').trim();
    if (/not a working tree|is not a working tree|No such file/i.test(stderr) ||
        /could not find/i.test(stderr)) {
      return { ok: true };
    }
    return { ok: false, error: stderr || `git exited with code ${result.status}` };
  }
  listCache = null;
  return { ok: true };
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
      if (norm.startsWith(path.normalize(root) + path.sep)) {
        return { ...r, sessionId: path.basename(norm) };
      }
      return r;
    });
    listCache = { ts: now, records: annotated };
  }
  if (opts.autopilotOnly) return annotated.filter((r) => r.sessionId);
  return annotated;
}

/**
 * Run `git worktree prune` and report a best-effort pruned count.
 * @returns {{pruned: number}}
 */
export function pruneOrphans() {
  const result = spawnSync('git', ['worktree', 'prune', '--verbose'], {
    encoding: 'utf-8',
    timeout: GIT_TIMEOUT_MS,
  });
  if (result.error || result.status !== 0) return { pruned: 0 };
  const out = (result.stdout || '') + (result.stderr || '');
  const matches = out.match(/Removing worktrees\/|Removing\s+/gi);
  listCache = null;
  return { pruned: matches ? matches.length : 0 };
}
