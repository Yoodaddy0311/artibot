/**
 * Phase replay simulator for autopilot sessions.
 *
 * Re-runs a previously executed phase against a fresh temp worktree (or a
 * DI-supplied fake worktree in tests) and compares the outcome to what the
 * original session recorded. Uses dry-run mode by default; opt-in real
 * commit via `opts.commit: true`.
 *
 * DATA POLICY: temp worktree creation is delegated to the caller-supplied
 * `worktreeFactory`. This module performs ZERO shell or network operations
 * on its own. Local-git-only by construction.
 *
 * Public surface:
 *   - replayPhase(sessionId, phaseName, opts)
 *
 * @module lib/autopilot/phase-replay
 */

import { loadSession } from './session-store.js';
import { createDryRunGitRunner } from './dry-run.js';

/**
 * Locate the most recent checkpoint for a given phase name.
 * Returns null when not found.
 * @param {Array<object>} checkpoints
 * @param {string} phaseName
 * @returns {object|null}
 */
function findLastPhaseCheckpoint(checkpoints, phaseName) {
  if (!Array.isArray(checkpoints)) return null;
  for (let i = checkpoints.length - 1; i >= 0; i -= 1) {
    const cp = checkpoints[i];
    if (cp && typeof cp === 'object' && cp.phase === phaseName) return cp;
  }
  return null;
}

/**
 * Distill the original outcome — just the bits the replay can compare against.
 * @param {object} checkpoint
 * @returns {{ phase: string, status: string|null, sha: string|null, ts: string|null }}
 */
function summarizeOriginalOutcome(checkpoint) {
  return {
    phase: typeof checkpoint.phase === 'string' ? checkpoint.phase : '',
    status: typeof checkpoint.status === 'string' ? checkpoint.status : null,
    sha: typeof checkpoint.sha === 'string' && checkpoint.sha ? checkpoint.sha : null,
    ts: typeof checkpoint.ts === 'string' ? checkpoint.ts : null,
  };
}

/**
 * Compute a coarse diff between original and replayed outcomes.
 * @param {{ status: string|null, sha: string|null }} original
 * @param {{ status: string|null, sha: string|null }} replay
 * @returns {{ statusMatch: boolean, shaMatch: boolean, divergedFields: string[] }}
 */
function compareOutcomes(original, replay) {
  const statusMatch = original.status === replay.status;
  const shaMatch = original.sha === replay.sha;
  const diverged = [];
  if (!statusMatch) diverged.push('status');
  if (!shaMatch) diverged.push('sha');
  return { statusMatch, shaMatch, divergedFields: diverged };
}

/**
 * Replay a past phase in a (possibly temporary) worktree, comparing the
 * outcome to what was originally recorded.
 *
 * Required `opts`:
 *   - `phaseRunner` ((ctx) => Promise<{status, sha?}>|{status, sha?})
 *     The function that performs the actual phase work. Caller supplies it
 *     to keep this module decoupled from engine.js. Receives a context
 *     with `gitRunner`, `cwd`, `phaseName`, and `dryRun` flag.
 *
 * Optional `opts`:
 *   - `commit: true` — disable dry-run, allow real writes
 *   - `worktreeFactory` — `() => { cwd, cleanup }` for temp worktree DI
 *   - `gitRunner` — override the git runner (default: dry-run runner)
 *   - `state` — pre-loaded session state (skip disk read)
 *
 * @param {string} sessionId
 * @param {string} phaseName
 * @param {{
 *   phaseRunner: (ctx: object) => Promise<object>|object,
 *   commit?: boolean,
 *   worktreeFactory?: () => { cwd: string, cleanup: () => void },
 *   gitRunner?: (args: string[], cwd: string) => string,
 *   state?: object
 * }} opts
 * @returns {Promise<{
 *   ok: boolean,
 *   reason?: string,
 *   originalOutcome?: object,
 *   replayOutcome?: object,
 *   diff?: object,
 *   dryRun: boolean
 * }>}
 */
export async function replayPhase(sessionId, phaseName, opts = {}) {
  const dryRun = opts.commit !== true;
  if (!sessionId || typeof sessionId !== 'string') {
    return { ok: false, reason: 'invalid-session-id', dryRun };
  }
  if (!phaseName || typeof phaseName !== 'string') {
    return { ok: false, reason: 'invalid-phase-name', dryRun };
  }
  if (typeof opts.phaseRunner !== 'function') {
    return { ok: false, reason: 'missing-phase-runner', dryRun };
  }

  let state = opts.state;
  if (!state) {
    try { state = loadSession(sessionId); } catch { state = null; }
  }
  if (!state || typeof state !== 'object') {
    return { ok: false, reason: 'session-not-found', dryRun };
  }

  const originalCheckpoint = findLastPhaseCheckpoint(state.checkpoints, phaseName);
  if (!originalCheckpoint) {
    return { ok: false, reason: 'phase-not-in-checkpoints', dryRun };
  }
  const originalOutcome = summarizeOriginalOutcome(originalCheckpoint);

  const worktree = typeof opts.worktreeFactory === 'function'
    ? opts.worktreeFactory()
    : { cwd: process.cwd(), cleanup() { /* no-op */ } };

  const gitRunner = typeof opts.gitRunner === 'function'
    ? opts.gitRunner
    : createDryRunGitRunner().runner;

  let replayResult;
  try {
    replayResult = await opts.phaseRunner({
      sessionId,
      phaseName,
      cwd: worktree.cwd,
      gitRunner,
      dryRun,
    });
  } catch (err) {
    safeCleanup(worktree);
    const msg = err && err.message ? String(err.message).slice(0, 280) : 'phase-runner-failed';
    return { ok: false, reason: `phase-runner-failed: ${msg}`, originalOutcome, dryRun };
  }
  safeCleanup(worktree);

  const replayOutcome = {
    phase: phaseName,
    status: replayResult && typeof replayResult.status === 'string' ? replayResult.status : null,
    sha: replayResult && typeof replayResult.sha === 'string' && replayResult.sha
      ? replayResult.sha
      : null,
    ts: new Date().toISOString(),
  };
  const diff = compareOutcomes(originalOutcome, replayOutcome);
  return { ok: true, originalOutcome, replayOutcome, diff, dryRun };
}

/**
 * Best-effort cleanup that never throws into the hot path.
 * @param {{ cleanup?: () => void }} worktree
 */
function safeCleanup(worktree) {
  if (!worktree || typeof worktree.cleanup !== 'function') return;
  try { worktree.cleanup(); } catch { /* ignore */ }
}
