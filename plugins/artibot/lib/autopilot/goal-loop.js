/**
 * Goal-driven iteration loop for autopilot (v4.6.0 Phase 2).
 *
 * Hosts the EVALUATE phase runner that sits between IMPROVE and
 * REPORT. Extracted from engine.js to keep that module under the
 * 800-line quality-gate threshold and to colocate all goal-contract
 * decision logic in a single, testable surface.
 *
 * Decision matrix (priority order):
 *   - no goalContract                            → nextPhase=REPORT (legacy)
 *   - same SHA across 3 consecutive iterations    → PAUSE (no progress)
 *   - met=true                                    → nextPhase=REPORT
 *   - confidence < 0.8                            → PAUSE (manual gate)
 *   - met=false AND iterations < maxIterations    → nextPhase=EXECUTE
 *   - met=false AND iterations >= maxIterations   → PAUSE (cap reached)
 *
 * Safety guards (mirror the v4.5.6 dev-verify-gate infinite-fire trauma):
 *   - HARD_MAX_ITERATIONS enforced at schema time (≤10).
 *   - Same-SHA 3-consecutive guard prevents busy-loops where iteration
 *     produces no commit progress yet evaluation keeps failing.
 *
 * @module lib/autopilot/goal-loop
 */

import { evaluateGoal } from './goal-evaluator.js';
import { DEFAULT_MAX_ITERATIONS } from './goal-schema.js';
import { persist, recordPhase, tick } from './_engine-helpers.js';

/**
 * Build a Phase 4 progress heartbeat slot for telemetry events. Keeps
 * tail-render UI consistent across iterate / pause / met paths.
 *
 * @param {object} state autopilot session state
 * @param {object} contract validated Goal Contract
 * @param {object|null} [evalResult] last evaluator result (optional)
 * @returns {{ iteration: number, maxIterations: number, pct: number, confidence: number|null, met: boolean|null, exitCode: number|null }}
 */
function buildProgress(state, contract, evalResult) {
  const maxIter = contract?.maxIterations || DEFAULT_MAX_ITERATIONS;
  const iter = state.goalIterations || 0;
  return {
    iteration: iter,
    maxIterations: maxIter,
    pct: maxIter > 0 ? Math.round((iter / maxIter) * 100) : 0,
    confidence: evalResult?.confidence ?? null,
    met: evalResult?.met ?? null,
    exitCode: evalResult?.exitCode ?? null,
  };
}

/**
 * Phase EVALUATE runner — evaluate the Goal Contract's stopping
 * condition and decide the next phase.
 *
 * @param {object} state autopilot session state
 * @param {{ runCommand?: (cmd: string) => { exitCode: number, stdout: string, stderr: string } }} evaluatorOpts
 *   DI for the validation command runner (tests inject mocks here).
 * @returns {object} instruction object (phase-result | pause)
 */
export function runPhaseGoalEvaluate(state, evaluatorOpts = {}) {
  state.phase = 'EVALUATE';
  tick(state.sessionId, {
    phase: 'EVALUATE',
    type: 'phase-start',
    level: 'info',
    message: 'Phase EVALUATE 시작 (goal-driven)',
  });

  // Legacy session (no Goal Contract) → fall straight through to REPORT.
  if (!state.goalContract) {
    recordPhase(state, { name: 'EVALUATE', status: 'skipped', reason: 'no-goal-contract' });
    persist(state);
    tick(state.sessionId, {
      phase: 'EVALUATE',
      type: 'phase-end',
      level: 'info',
      message: 'EVALUATE skipped (legacy session)',
    });
    return {
      type: 'phase-result',
      phase: 'EVALUATE',
      sessionId: state.sessionId,
      nextPhase: 'REPORT',
      skipped: true,
    };
  }

  // v4.6.0 Phase 3 — goal-level pause (orthogonal to session pause).
  // The session continues running but the evaluator is disabled until
  // resumeGoal lifts the flag. EVALUATE becomes a pass-through.
  if (state.goalPaused) {
    recordPhase(state, { name: 'EVALUATE', status: 'skipped', reason: 'goal-paused' });
    persist(state);
    tick(state.sessionId, {
      phase: 'EVALUATE',
      type: 'phase-end',
      level: 'info',
      message: 'EVALUATE skipped (goal paused via /autopilot:goal pause)',
    });
    return {
      type: 'phase-result',
      phase: 'EVALUATE',
      sessionId: state.sessionId,
      nextPhase: 'REPORT',
      skipped: true,
      goalPaused: true,
    };
  }

  const contract = state.goalContract;
  const currentSHA = state.lastReviewedSHA || null;

  // No-progress guard: same SHA across 3 consecutive iterations.
  if (currentSHA && currentSHA === state.lastIterationSHA) {
    state.consecutiveSameSHA = (state.consecutiveSameSHA || 0) + 1;
  } else {
    state.consecutiveSameSHA = 1;
    state.lastIterationSHA = currentSHA;
  }
  if (state.consecutiveSameSHA >= 3) {
    state.phase = 'PAUSED';
    state.pausedReason = 'no progress detected (same SHA across 3 iterations)';
    persist(state);
    tick(state.sessionId, {
      phase: 'EVALUATE',
      type: 'pause',
      level: 'warn',
      message: state.pausedReason,
      data: { sha: currentSHA, consecutive: state.consecutiveSameSHA },
    });
    return {
      type: 'pause',
      sessionId: state.sessionId,
      reason: state.pausedReason,
      instructions: [
        'Goal-driven iteration paused: no progress detected.',
        'Same SHA across 3 consecutive iterations.',
        '사용자 결정 후 /autopilot:resume <sessionId> 로 재개할 수 있습니다.',
      ],
    };
  }

  const evalResult = evaluateGoal({ contract, runCommand: evaluatorOpts.runCommand });
  state.goalEvaluation = evalResult;
  tick(state.sessionId, {
    phase: 'EVALUATE',
    type: 'goal-evaluated',
    level: evalResult.met ? 'info' : 'warn',
    message: `goal evaluation: ${evalResult.reason}`,
    data: { met: evalResult.met, exitCode: evalResult.exitCode, confidence: evalResult.confidence },
    progress: buildProgress(state, contract, evalResult),
  });

  // Met → proceed to REPORT.
  if (evalResult.met) {
    recordPhase(state, { name: 'EVALUATE', status: 'done', met: true });
    persist(state);
    tick(state.sessionId, { phase: 'EVALUATE', type: 'phase-end', level: 'info', message: 'EVALUATE met → REPORT' });
    return {
      type: 'phase-result',
      phase: 'EVALUATE',
      sessionId: state.sessionId,
      nextPhase: 'REPORT',
      met: true,
      evaluation: evalResult,
    };
  }

  // Low confidence (e.g. no validationCommand) → manual gate.
  if (evalResult.confidence < 0.8) {
    state.phase = 'PAUSED';
    state.pausedReason = `manual evaluation required: ${evalResult.reason}`;
    persist(state);
    tick(state.sessionId, {
      phase: 'EVALUATE',
      type: 'pause',
      level: 'warn',
      message: state.pausedReason,
    });
    return {
      type: 'pause',
      sessionId: state.sessionId,
      reason: state.pausedReason,
      evaluation: evalResult,
      instructions: [
        'Goal evaluator could not auto-decide (low confidence).',
        evalResult.reason,
        '사용자가 stopping condition 충족 여부를 확인한 후 resume.',
      ],
    };
  }

  // Not met + confident: check iteration cap.
  state.goalIterations = (state.goalIterations || 0) + 1;
  const maxIter = contract.maxIterations || DEFAULT_MAX_ITERATIONS;

  if (state.goalIterations >= maxIter) {
    state.phase = 'PAUSED';
    state.pausedReason = `max iterations (${maxIter}) reached without meeting stopping condition`;
    persist(state);
    tick(state.sessionId, {
      phase: 'EVALUATE',
      type: 'pause',
      level: 'warn',
      message: state.pausedReason,
      data: { iterations: state.goalIterations, maxIter },
      progress: buildProgress(state, contract, evalResult),
    });
    return {
      type: 'pause',
      sessionId: state.sessionId,
      reason: state.pausedReason,
      evaluation: evalResult,
      iteration: state.goalIterations,
      maxIterations: maxIter,
      instructions: [
        `Goal-driven iteration cap reached (${state.goalIterations}/${maxIter}).`,
        `Last evaluation: ${evalResult.reason}`,
        '사용자 결정 후 /autopilot:resume <sessionId> 로 재개 또는 contract 조정.',
      ],
    };
  }

  // Iterate: reset phase to EXECUTE, emit re-execute instruction.
  state.phase = 'EXECUTE';
  recordPhase(state, { name: 'EVALUATE', status: 'iterate', iteration: state.goalIterations });
  persist(state);
  tick(state.sessionId, {
    phase: 'EVALUATE',
    type: 'phase-end',
    level: 'info',
    message: `EVALUATE not met → re-EXECUTE iteration ${state.goalIterations}/${maxIter}`,
    data: { iteration: state.goalIterations, maxIter, reason: evalResult.reason },
    progress: buildProgress(state, contract, evalResult),
  });
  return {
    type: 'phase-result',
    phase: 'EVALUATE',
    sessionId: state.sessionId,
    nextPhase: 'EXECUTE',
    met: false,
    iteration: state.goalIterations,
    maxIterations: maxIter,
    evaluation: evalResult,
    instructions: [
      `Goal not met (${evalResult.reason}).`,
      `Re-entering Phase 2 EXECUTE — iteration ${state.goalIterations}/${maxIter}.`,
      'Apply corrective changes targeting the stopping condition.',
    ],
  };
}
