/**
 * Goal-level control plane for autopilot (v4.6.0 Phase 3).
 *
 * Provides session-load → state-mutate → session-save primitives for
 * the four goal-level subcommands:
 *   - pauseGoal:  disable goal evaluator (session keeps running, but
 *                 EVALUATE phase becomes a no-op pass-through)
 *   - resumeGoal: re-enable goal evaluator
 *   - retryGoal:  force re-evaluation (optionally reset iterations to 0)
 *   - clearGoal:  remove the Goal Contract entirely (revert to legacy
 *                 7-phase flow)
 *
 * These are ORTHOGONAL to session-level pause (`maybePause` in
 * engine.js). A session can be running normally while the GOAL is
 * paused; the engine still progresses through phases but EVALUATE
 * skips the evaluator until resumeGoal lifts the flag.
 *
 * @module lib/autopilot/goal-control
 */

import { loadSession, saveSession } from './session-store.js';

/**
 * Internal: load a session and persist a mutation. Returns the result
 * object emitted by the mutator. The mutator must return an object;
 * its `ok` field determines whether a save is performed (so failed
 * lookups don't write garbage to disk).
 *
 * @param {string} sessionId
 * @param {(state: object) => object} mutator
 * @returns {object} result with at least { ok: boolean }
 */
function withSession(sessionId, mutator) {
  if (!sessionId || typeof sessionId !== 'string') {
    return { ok: false, reason: 'sessionId is required' };
  }
  const state = loadSession(sessionId);
  if (!state) {
    return { ok: false, reason: 'session not found' };
  }
  const result = mutator(state);
  if (result?.ok) {
    state.updatedAt = new Date().toISOString();
    saveSession(state);
  }
  return result;
}

/**
 * Record a control-plane action on the session. Mutates state.
 * @param {object} state
 * @param {string} action
 * @param {object} [extra]
 */
function recordControl(state, action, extra = {}) {
  state.goalControl = {
    lastAction: action,
    ts: new Date().toISOString(),
    ...extra,
  };
}

/**
 * Pause goal evaluation. EVALUATE phase becomes a no-op pass-through
 * (nextPhase=REPORT) until resumeGoal is called. Session-level work
 * (Phase 0~5) continues normally.
 *
 * @param {string} sessionId
 * @param {{ reason?: string }} [opts]
 * @returns {{ ok: boolean, paused?: boolean, reason?: string }}
 */
export function pauseGoal(sessionId, opts = {}) {
  return withSession(sessionId, (state) => {
    if (!state.goalContract) {
      return { ok: false, reason: 'session has no Goal Contract' };
    }
    state.goalPaused = true;
    recordControl(state, 'pause', { reason: opts.reason || null });
    return { ok: true, paused: true };
  });
}

/**
 * Resume goal evaluation. Re-enables the evaluator on the next
 * EVALUATE phase. No-op if the goal was not paused.
 *
 * @param {string} sessionId
 * @returns {{ ok: boolean, paused?: boolean, reason?: string }}
 */
export function resumeGoal(sessionId) {
  return withSession(sessionId, (state) => {
    if (!state.goalContract) {
      return { ok: false, reason: 'session has no Goal Contract' };
    }
    state.goalPaused = false;
    recordControl(state, 'resume');
    return { ok: true, paused: false };
  });
}

/**
 * Retry goal evaluation. Optionally resets the iteration counter to 0
 * so the cap restarts from scratch. Useful when the user manually
 * fixes the underlying issue and wants the evaluator to give the
 * session another full set of iterations.
 *
 * @param {string} sessionId
 * @param {{ resetIterations?: boolean }} [opts]
 * @returns {{ ok: boolean, iterations?: number, reason?: string }}
 */
export function retryGoal(sessionId, opts = {}) {
  return withSession(sessionId, (state) => {
    if (!state.goalContract) {
      return { ok: false, reason: 'session has no Goal Contract' };
    }
    const reset = opts.resetIterations !== false; // default true
    if (reset) {
      state.goalIterations = 0;
      state.consecutiveSameSHA = 0;
      state.lastIterationSHA = null;
    }
    state.goalPaused = false;
    recordControl(state, 'retry', { resetIterations: reset });
    return { ok: true, iterations: state.goalIterations };
  });
}

/**
 * Clear the Goal Contract entirely. The session reverts to the legacy
 * 7-phase flow: subsequent EVALUATE invocations short-circuit to
 * nextPhase=REPORT (no Goal Contract → legacy passthrough).
 *
 * @param {string} sessionId
 * @returns {{ ok: boolean, cleared?: boolean, reason?: string }}
 */
export function clearGoal(sessionId) {
  return withSession(sessionId, (state) => {
    if (!state.goalContract) {
      return { ok: false, reason: 'session has no Goal Contract' };
    }
    state.goalContract = null;
    state.goalEvaluation = null;
    state.goalIterations = 0;
    state.lastIterationSHA = null;
    state.consecutiveSameSHA = 0;
    state.goalPaused = false;
    recordControl(state, 'clear');
    return { ok: true, cleared: true };
  });
}

/**
 * Read-only inspection of the goal state. Useful for the
 * `/autopilot:goal status` subcommand.
 *
 * @param {string} sessionId
 * @returns {{ ok: boolean, contract?: object|null, paused?: boolean, iterations?: number, lastAction?: object|null, reason?: string }}
 */
export function getGoalStatus(sessionId) {
  if (!sessionId || typeof sessionId !== 'string') {
    return { ok: false, reason: 'sessionId is required' };
  }
  const state = loadSession(sessionId);
  if (!state) {
    return { ok: false, reason: 'session not found' };
  }
  return {
    ok: true,
    contract: state.goalContract || null,
    paused: state.goalPaused === true,
    iterations: state.goalIterations || 0,
    maxIterations: state.goalContract?.maxIterations ?? null,
    lastEvaluation: state.goalEvaluation || null,
    lastAction: state.goalControl || null,
  };
}
