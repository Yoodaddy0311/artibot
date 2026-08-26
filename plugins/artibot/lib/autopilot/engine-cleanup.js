/**
 * Autopilot engine — worktree lifecycle & artifact reaping.
 *
 * Pure extraction from engine.js (no behavior change). Wraps worktree-manager
 * for the engine's create/reap/list needs. One-directional: this module never
 * imports engine.js.
 *
 * @module lib/autopilot/engine-cleanup
 */

import { tick } from './_engine-helpers.js';
import {
  createWorktree,
  listWorktrees,
  pruneOrphans,
  removeWorktree,
} from './worktree-manager.js';

/**
 * Best-effort orphan reaper. Removes the session's own worktree+branch, then
 * sweeps any leftover orphaned `autopilot/*` worktrees and branches. Wired into
 * both finalize (REPORT) and abort paths so sessions never leak branches at
 * their boundaries. Never throws into phase/abort logic.
 * @param {object} state
 * @param {{ force?: boolean }} [opts]
 */
export function reapSessionArtifacts(state, { force = false } = {}) {
  const cwd = state?.options?.worktreeCwd;
  try {
    if (state?.worktreePath) removeWorktree(state.sessionId, { force, cwd });
  } catch {
    /* cleanup non-blocking */
  }
  try {
    pruneOrphans({ cwd });
  } catch {
    /* prune non-blocking */
  }
}

/**
 * Did the operator ask for a session worktree?
 *
 * Single source of truth for that question. Two gates depend on it and they
 * MUST read the same predicate: {@link attemptCreateWorktree} decides whether
 * to *try* creating one, and `engine.js#runPhase2Execute` decides how to *name*
 * a fast-fanout demotion (`integration-worktree-failed` = asked and creation
 * broke, vs `no-integration-worktree` = never asked). If the two disagree, a
 * value lands in the gap where creation is attempted but the failure is then
 * reported as an opt-out — the exact misattribution the split reason codes
 * exist to prevent.
 *
 * They did disagree: this used to be a bare truthy check here and a strict
 * `=== true` at the demotion site, so `useWorktree: 'true' | 1 | 'yes'` spawned
 * a real (failing) `git worktree add` and then blamed the operator for not
 * asking. `Boolean()` — not `=== true` — is deliberate: it preserves the
 * creation gate's existing behavior for every input, and it also covers
 * resumed sessions, whose `options` are read back from disk without passing
 * through the canonical-boolean normalization in `_engine-helpers.js`.
 * @param {object} state
 * @returns {boolean}
 */
export function worktreeRequested(state) {
  return Boolean(state?.options?.useWorktree);
}

/**
 * Phase 2 helper — attempt to create an isolated worktree for the session.
 * Returns the worktree path on success or null on opt-out/failure. Mutates
 * state.worktreePath and emits telemetry ticks. Never throws.
 * @param {object} state
 * @returns {string|null}
 */
export function attemptCreateWorktree(state) {
  if (!worktreeRequested(state)) return null;
  try {
    // worktreeCwd lets callers/tests pin git invocations to an isolated repo
    // (no process.chdir). Undefined → git inherits process.cwd() (default).
    const r = createWorktree(state.sessionId, { cwd: state.options?.worktreeCwd });
    if (r.ok) {
      state.worktreePath = r.path;
      tick(state.sessionId, {
        phase: 'EXECUTE',
        type: 'worktree-created',
        level: 'info',
        message: `worktree=${r.path}`,
        data: { branch: r.branch },
      });
      return r.path;
    }
    tick(state.sessionId, {
      phase: 'EXECUTE',
      type: 'worktree-fallback',
      level: 'warn',
      message: r.error || 'worktree create failed',
    });
    return null;
  } catch (err) {
    tick(state.sessionId, {
      phase: 'EXECUTE',
      type: 'worktree-fallback',
      level: 'warn',
      message: err?.message || 'worktree create threw',
    });
    return null;
  }
}

/**
 * List active autopilot worktrees as a normalized array.
 * @returns {Array<{path: string, branch: string|null, sessionId: string|null}>}
 */
export function listActiveWorktrees() {
  try {
    const trees = listWorktrees({ autopilotOnly: true });
    return trees.map((t) => ({
      path: t.path,
      branch: t.branch,
      sessionId: t.sessionId || null,
    }));
  } catch {
    return [];
  }
}
