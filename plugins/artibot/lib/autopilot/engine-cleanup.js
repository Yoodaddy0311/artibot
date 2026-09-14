/**
 * Autopilot engine — worktree lifecycle & artifact reaping.
 *
 * Pure extraction from engine.js (no behavior change). Wraps worktree-manager
 * for the engine's create/reap/list needs. One-directional: this module never
 * imports engine.js.
 *
 * @module lib/autopilot/engine-cleanup
 */

import { persist, tick } from './_engine-helpers.js';
import {
  createWorktree,
  listWorktrees,
  pruneOrphans,
  reapWorktree,
} from './worktree-manager.js';

/**
 * Best-effort artifact reaper. Reaps the session's own worktree+branch and
 * sweeps orphaned `autopilot/*` artifacts, but only where the commits are
 * demonstrably reachable from another ref — an unintegrated session result is
 * preserved and reported instead of deleted. Wired into both finalize (REPORT)
 * and abort paths. Never throws into phase/abort logic.
 * @param {object} state
 * @param {{ force?: boolean }} [opts]
 * @returns {{at: string, session: object|null, orphans: object|null}}
 */
export function reapSessionArtifacts(state, { force = false } = {}) {
  const cwd = state?.options?.worktreeCwd;
  // Explicit only. Inferring a target from HEAD would manufacture the very
  // evidence the preservation check exists to demand.
  const integrationTarget = state?.options?.integrationTarget ?? state?.integrationTarget ?? null;

  let session = null;
  try {
    if (state?.worktreePath) {
      session = reapWorktree(state.sessionId, { cwd, force, integrationTarget });
    }
  } catch {
    /* cleanup non-blocking */
  }
  let orphans = null;
  try {
    orphans = pruneOrphans({ cwd, integrationTarget });
  } catch {
    /* prune non-blocking */
  }

  const report = { at: new Date().toISOString(), session, orphans };
  try {
    recordCleanup(state, report, integrationTarget);
  } catch {
    /* persistence non-blocking */
  }
  try {
    emitCleanupTelemetry(state, report);
  } catch {
    /* telemetry non-blocking */
  }
  return report;
}

/**
 * Persist the cleanup outcome onto session state so a preserved result is
 * recoverable after the process exits.
 * @param {object} state
 * @param {object} report
 * @param {string|null} integrationTarget
 */
function recordCleanup(state, report, integrationTarget) {
  if (!state) return;
  state.resultHead = report.session?.resultHead ?? state.resultHead ?? null;
  state.resultRef = report.session?.resultRef ?? state.resultRef ?? null;
  state.integrationTarget = integrationTarget;
  state.cleanupReport = report;
  persist(state);
}

/**
 * A preserved result must never be silent in the completion path — the operator
 * has to learn from telemetry that commits are still parked on a branch.
 * @param {object} state
 * @param {object} report
 */
function emitCleanupTelemetry(state, report) {
  const sessionId = state?.sessionId;
  if (!sessionId) return;
  const s = report.session;
  if (s?.action === 'preserved') {
    tick(sessionId, {
      phase: 'CLEANUP',
      type: 'cleanup-preserved',
      level: 'warn',
      message: `worktree preserved (${s.reason}) head=${s.resultHead} ref=${s.resultRef}`,
      data: { reason: s.reason, resultHead: s.resultHead, resultRef: s.resultRef },
    });
  } else if (s?.action === 'removed') {
    tick(sessionId, {
      phase: 'CLEANUP',
      type: 'cleanup-removed',
      level: 'info',
      message: `worktree removed (${s.reason})`,
      data: { reason: s.reason, evidence: s.evidence },
    });
  }
  if (report.orphans) {
    const removed = report.orphans.removed?.length ?? 0;
    const preserved = report.orphans.preserved?.length ?? 0;
    tick(sessionId, {
      phase: 'CLEANUP',
      type: 'cleanup-orphans',
      level: 'info',
      message: `orphan sweep removed=${removed} preserved=${preserved}`,
      data: { removed, preserved },
    });
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
