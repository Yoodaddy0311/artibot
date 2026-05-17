/**
 * Engine-internal helpers shared between engine.js and goal-loop.js
 * (v4.6.0). Extracted as a module-private utility to keep engine.js
 * under the 800-line quality-gate threshold while still letting the
 * goal-driven iteration loop reuse the same telemetry / persistence /
 * phase-record primitives.
 *
 * Underscored filename signals "internal — not part of the public
 * autopilot surface". Do not re-export from index.js.
 *
 * @module lib/autopilot/_engine-helpers
 */

import { newSessionId, saveSession } from './session-store.js';
import { appendEvent } from './telemetry.js';
import { notifyDanger, notifyPhaseProgress } from './notification.js';

/**
 * Build the initial autopilot session state object. Factored out of
 * engine.js to keep that module under the 800-line quality gate and
 * to colocate state-shape concerns next to the persistence helpers.
 *
 * @param {{ task: string, mode?: string, options?: object, sessionId?: string }} args
 * @returns {object} initial state
 */
export function makeInitialState({ task, mode, options, sessionId }) {
  const id = sessionId || newSessionId();
  return {
    sessionId: id,
    task: task || '',
    mode: mode || 'default',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    options: { maxDuration: '4h', budget: 2_000_000, ...(options || {}) },
    phase: 'INTAKE',
    prdPath: null,
    reportPath: null,
    phases: [],
    checkpoints: [],
    queuedQuestions: [],
    errors: [],
    counters: { buildFailures: 0, testFailures: 0 },
    tokenUsage: 0,
    lastReviewedSHA: null,
    worktreePath: null,
    lockPath: null,
    parentSession: options?.parentSession || null,
    // v4.6.0 Goal-driven mode slots (null/zero for legacy sessions).
    goalContract: null,
    goalIterations: 0,
    lastIterationSHA: null,
    consecutiveSameSHA: 0,
    goalEvaluation: null,
    // v4.6.0 Phase 3 — Goal-level control plane (orthogonal to session pause).
    goalPaused: false,
    goalControl: null,
  };
}

/**
 * Best-effort telemetry tick. Never throws into phase logic — telemetry
 * is advisory and must not break the engine flow.
 * @param {string} sessionId
 * @param {object} event
 */
export function tick(sessionId, event) {
  try {
    if (!sessionId) return;
    appendEvent(sessionId, event);
  } catch {
    /* telemetry must not break engine flow */
  }
}

/**
 * Append a phase record. Mutates state.
 * @param {object} state
 * @param {object} phase
 */
export function recordPhase(state, phase) {
  state.phases = Array.isArray(state.phases) ? state.phases : [];
  state.phases.push({ ts: new Date().toISOString(), ...phase });
}

/**
 * Persist a state mutation safely. Returns the saved state.
 * @param {object} state
 * @returns {object}
 */
export function persist(state) {
  state.updatedAt = new Date().toISOString();
  saveSession(state);
  return state;
}

/**
 * Build a danger notification when pause reason or error severity signals
 * a safety-critical event. Returns null when no danger is detected.
 * @param {object} state
 * @param {string} reason
 * @returns {object|null}
 */
export function maybeDangerNote(state, reason) {
  const errs = Array.isArray(state.errors) ? state.errors : [];
  const dangerErr = errs.find((e) => e?.severity === 'danger');
  if (!dangerErr && !/secret-leak|danger/i.test(reason)) return null;
  return notifyDanger(state.sessionId, {
    riskType: dangerErr?.kind || reason,
    detail: dangerErr?.detail ?? reason,
  });
}

/**
 * Best-effort phase-progress notification. Throttled inside notifyPhaseProgress.
 * @param {object} state
 * @param {string} fromPhase
 * @param {string} toPhase
 * @param {number|null} [durationMs]
 * @returns {object|null}
 */
export function notePhaseProgress(state, fromPhase, toPhase, durationMs = null) {
  try {
    return notifyPhaseProgress(state.sessionId, { fromPhase, toPhase, durationMs });
  } catch {
    return null;
  }
}
