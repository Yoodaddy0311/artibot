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
 * Phase 2 helper — attempt to create an isolated worktree for the session.
 * Returns the worktree path on success or null on opt-out/failure. Mutates
 * state.worktreePath and emits telemetry ticks. Never throws.
 * @param {object} state
 * @returns {string|null}
 */
export function attemptCreateWorktree(state) {
  if (!state.options?.useWorktree) return null;
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
