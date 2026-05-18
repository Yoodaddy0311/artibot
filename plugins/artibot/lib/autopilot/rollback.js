/**
 * Phase-level rollback for autopilot sessions.
 *
 * Finds the last green (status='passed') checkpoint and rolls the worktree
 * back to its SHA via `git reset --hard`. ONLY operates inside an actual
 * git worktree (`git rev-parse --show-toplevel` must succeed); refuses to
 * touch anything else.
 *
 * DATA POLICY: local git only. Never invokes fetch / push / remote operations.
 * Korean-path safe (no shell, execFile via DI gitRunner).
 *
 * Public surface:
 *   - rollbackToLastGreen(sessionId, opts)
 *   - listRollbackTargets(sessionId, opts)
 *
 * @module lib/autopilot/rollback
 */

import { execFileSync } from 'node:child_process';
import { loadSession } from './session-store.js';

/**
 * SHA validator. Same shape as phase-diff.js: alnum/_/-, no leading dash,
 * max 128 chars. Guards against option-injection through gitRunner args.
 * @param {unknown} sha
 * @returns {boolean}
 */
export function isSafeSha(sha) {
  return typeof sha === 'string' && /^[A-Za-z0-9_][A-Za-z0-9_-]{0,127}$/.test(sha);
}

/**
 * Default local git runner — execFileSync, never shell, captured stderr.
 * @param {string[]} args
 * @param {string} cwd
 * @returns {string} stdout
 */
function defaultGitRunner(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * Verify cwd is inside a git worktree. Returns the worktree root or null.
 * @param {(args: string[], cwd: string) => string} gitRunner
 * @param {string} cwd
 * @returns {string|null}
 */
function getWorktreeRoot(gitRunner, cwd) {
  try {
    const out = gitRunner(['rev-parse', '--show-toplevel'], cwd);
    const root = typeof out === 'string' ? out.trim() : '';
    return root || null;
  } catch {
    return null;
  }
}

/**
 * Normalize checkpoint list, filter to safe green entries (status='passed').
 * Each entry preserves index for tie-break / latest selection.
 * @param {Array<object>} checkpoints
 * @returns {Array<{index: number, phase: string, sha: string, status: string, ts?: string}>}
 */
function collectGreenCheckpoints(checkpoints) {
  if (!Array.isArray(checkpoints)) return [];
  const out = [];
  for (let i = 0; i < checkpoints.length; i += 1) {
    const cp = checkpoints[i];
    if (!cp || typeof cp !== 'object') continue;
    if (cp.status !== 'passed') continue;
    if (!isSafeSha(cp.sha)) continue;
    const phase = typeof cp.phase === 'string' && cp.phase ? cp.phase : 'unknown';
    out.push({
      index: i,
      phase,
      sha: cp.sha,
      status: cp.status,
      ts: typeof cp.ts === 'string' ? cp.ts : undefined,
    });
  }
  return out;
}

/**
 * Enumerate rollback targets (every green checkpoint, latest-first).
 * @param {string} sessionId
 * @param {{ state?: object }} [opts]
 * @returns {Array<{index: number, phase: string, sha: string, status: string, ts?: string}>}
 */
export function listRollbackTargets(sessionId, opts = {}) {
  if (!sessionId || typeof sessionId !== 'string') return [];
  let state = opts.state;
  if (!state) {
    try { state = loadSession(sessionId); } catch { state = null; }
  }
  if (!state || typeof state !== 'object') return [];
  const greens = collectGreenCheckpoints(state.checkpoints);
  return greens.slice().reverse();
}

/**
 * Roll the worktree back to the latest green checkpoint via `git reset --hard`.
 *
 * Hard guards:
 *   - cwd MUST be inside a git worktree (rev-parse --show-toplevel)
 *   - target SHA MUST pass isSafeSha
 *   - session MUST have at least one passed checkpoint
 *
 * @param {string} sessionId
 * @param {{
 *   gitRunner?: (args: string[], cwd: string) => string,
 *   cwd?: string,
 *   state?: object,
 *   dryRun?: boolean
 * }} [opts]
 * @returns {{
 *   ok: boolean,
 *   reason?: string,
 *   target?: { phase: string, sha: string, ts?: string },
 *   worktreeRoot?: string,
 *   dryRun?: boolean
 * }}
 */
export function rollbackToLastGreen(sessionId, opts = {}) {
  if (!sessionId || typeof sessionId !== 'string') {
    return { ok: false, reason: 'invalid-session-id' };
  }
  const gitRunner = typeof opts.gitRunner === 'function' ? opts.gitRunner : defaultGitRunner;
  const cwd = typeof opts.cwd === 'string' && opts.cwd ? opts.cwd : process.cwd();
  const worktreeRoot = getWorktreeRoot(gitRunner, cwd);
  if (!worktreeRoot) {
    return { ok: false, reason: 'not-in-worktree' };
  }
  const targets = listRollbackTargets(sessionId, { state: opts.state });
  if (targets.length === 0) {
    return { ok: false, reason: 'no-green-checkpoint', worktreeRoot };
  }
  const target = targets[0]; // latest-first
  if (!isSafeSha(target.sha)) {
    return { ok: false, reason: 'unsafe-sha', worktreeRoot };
  }
  if (opts.dryRun === true) {
    return {
      ok: true,
      target: { phase: target.phase, sha: target.sha, ts: target.ts },
      worktreeRoot,
      dryRun: true,
    };
  }
  try {
    gitRunner(['reset', '--hard', target.sha], worktreeRoot);
  } catch (err) {
    const msg = err && err.message ? String(err.message).slice(0, 280) : 'git-reset-failed';
    return { ok: false, reason: `git-reset-failed: ${msg}`, worktreeRoot };
  }
  return {
    ok: true,
    target: { phase: target.phase, sha: target.sha, ts: target.ts },
    worktreeRoot,
  };
}
