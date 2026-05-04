/**
 * Multi-Step Reasoning Loop Controller.
 *
 * Wraps System 2's solve() with a global iteration loop that:
 *   1. Evaluates results at the step level after each solve() attempt
 *   2. Adapts the task based on what succeeded/failed
 *   3. Re-invokes solve() with accumulated feedback
 *   4. Respects loop-detector boundaries via stepId isolation
 *
 * Key design decisions:
 *   - External to solve() — does not modify the existing retry loop
 *   - Immutable state transitions — each iteration creates new objects
 *   - Feedback accumulation — failed step reasons carry forward
 *   - Bounded iterations — MAX_ITERATIONS prevents runaway loops
 *
 * @module lib/cognitive/multi-step-loop
 */

import { extractFailureReason, solve } from './system2-core.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum global iterations (outer loop around solve's inner 3 retries) */
const MAX_ITERATIONS = 5;

/** Maximum feedback entries to carry forward (prevents context bloat) */
const MAX_FEEDBACK_ENTRIES = 15;

/** Minimum completion rate improvement to justify another iteration */
const MIN_IMPROVEMENT_THRESHOLD = 0.05;

/** Number of stagnant iterations before giving up */
const MAX_STAGNANT_ITERATIONS = 2;

// ---------------------------------------------------------------------------
// Step Evaluator
// ---------------------------------------------------------------------------

/**
 * Evaluate each step's result individually to identify partial successes.
 *
 * @param {object} solveResult - Result from solve()
 * @returns {{
 *   completedSteps: string[],
 *   failedSteps: Array<{ stepId: string, action: string, reason: string }>,
 *   completionRate: number,
 *   stepDetails: Array<{ stepId: string, status: string, action: string }>
 * }}
 */
export function evaluateSteps(solveResult) {
  const completedSteps = [];
  const failedSteps = [];
  const stepDetails = [];

  // Use the last attempt's execution results
  const lastAttempt = solveResult.history[solveResult.history.length - 1];
  if (!lastAttempt?.execution?.results) {
    return { completedSteps, failedSteps, completionRate: 0, stepDetails };
  }

  for (const result of lastAttempt.execution.results) {
    const detail = {
      stepId: result.stepId,
      status: result.status,
      action: result.action,
    };
    stepDetails.push(detail);

    if (result.status === 'success') {
      completedSteps.push(result.stepId);
    } else {
      const reason = extractFailureReason(result);
      failedSteps.push({
        stepId: result.stepId,
        action: result.action,
        reason,
      });
    }
  }

  const total = stepDetails.length;
  const completionRate = total > 0 ? completedSteps.length / total : 0;

  return { completedSteps, failedSteps, completionRate, stepDetails };
}

// ---------------------------------------------------------------------------
// Strategy Adapter
// ---------------------------------------------------------------------------

/**
 * Derive an adjusted task from iteration feedback.
 * Carries forward completed step information and failure reasons
 * so solve() can plan around them.
 *
 * @param {object} originalTask - The original user task
 * @param {object} iterationState - Accumulated iteration state
 * @returns {object} Adjusted task for next iteration
 */
export function adaptTask(originalTask, iterationState) {
  const { completedStepIds, failedStepReasons, feedbackLog, iteration } = iterationState;

  // Trim feedback to prevent context bloat
  const recentFeedback = feedbackLog.slice(-MAX_FEEDBACK_ENTRIES);

  return {
    ...originalTask,
    context: {
      ...originalTask.context,
      multiStepIteration: iteration,
      previouslyCompleted: [...completedStepIds],
      failureReasons: [...failedStepReasons],
      iterationFeedback: recentFeedback,
      adaptationHints: deriveHints(failedStepReasons),
    },
  };
}

/**
 * Derive adaptation hints from failure reasons.
 * These hints guide solve()'s plan() phase to avoid repeating mistakes.
 *
 * @param {Array<{ stepId: string, reason: string }>} failures
 * @returns {string[]}
 */
function deriveHints(failures) {
  const hints = [];

  const reasons = failures.map((f) => f.reason.toLowerCase());

  if (reasons.some((r) => r.includes('dependency') || r.includes('import'))) {
    hints.push('resolve_dependencies_first');
  }
  if (reasons.some((r) => r.includes('permission') || r.includes('blocked'))) {
    hints.push('check_permissions_before_execution');
  }
  if (reasons.some((r) => r.includes('timeout'))) {
    hints.push('split_into_smaller_steps');
  }
  if (reasons.some((r) => r.includes('not found') || r.includes('missing'))) {
    hints.push('verify_prerequisites');
  }
  if (failures.length > 3) {
    hints.push('fundamentally_re_plan');
  }

  return hints;
}

// ---------------------------------------------------------------------------
// Termination Logic
// ---------------------------------------------------------------------------

/**
 * Determine whether to continue iterating.
 *
 * @param {object} params
 * @param {number} params.iteration - Current iteration (1-based)
 * @param {boolean} params.success - Whether solve() succeeded
 * @param {number} params.completionRate - Current step completion rate
 * @param {number} params.previousRate - Previous iteration's completion rate
 * @param {number} params.stagnantCount - Consecutive iterations without improvement
 * @returns {{ shouldContinue: boolean, reason: string }}
 */
export function shouldContinue({ iteration, success, completionRate, previousRate, stagnantCount }) {
  if (success) {
    return { shouldContinue: false, reason: 'all_steps_succeeded' };
  }

  if (iteration >= MAX_ITERATIONS) {
    return { shouldContinue: false, reason: `max_iterations_reached (${MAX_ITERATIONS})` };
  }

  if (completionRate >= 1.0) {
    return { shouldContinue: false, reason: 'completion_rate_100_percent' };
  }

  // stagnantCount is already incremented by the caller before passing here
  if (stagnantCount >= MAX_STAGNANT_ITERATIONS && iteration > 1) {
    const improvement = completionRate - previousRate;
    return {
      shouldContinue: false,
      reason: `stagnant_for_${stagnantCount}_iterations (improvement: ${(improvement * 100).toFixed(1)}%)`,
    };
  }

  return { shouldContinue: true, reason: 'improvement_possible' };
}

// ---------------------------------------------------------------------------
// Main Loop Controller
// ---------------------------------------------------------------------------

/**
 * Execute a task with multi-step reasoning: iteratively solve, evaluate,
 * adapt, and re-solve until success or termination.
 *
 * @param {object} task - Task to solve (same shape as System 2's solve() input)
 * @param {object} [options]
 * @param {number} [options.maxIterations=5] - Override max iterations
 * @param {object} [options.solveOptions] - Options passed to solve()
 * @param {Function} [options.onIteration] - Callback: (iterationState) => void
 * @returns {{
 *   taskId: string,
 *   success: boolean,
 *   totalIterations: number,
 *   totalAttempts: number,
 *   completionRate: number,
 *   iterationHistory: Array<{
 *     iteration: number,
 *     solveResult: object,
 *     evaluation: object,
 *     decision: { shouldContinue: boolean, reason: string }
 *   }>,
 *   finalResult: object | null,
 *   duration: number
 * }}
 */
export function solveWithFeedback(task, options = {}) {
  const { maxIterations = MAX_ITERATIONS, solveOptions = {}, onIteration } = options;
  const startTime = Date.now();

  const iterationHistory = [];
  let currentTask = { ...task };
  const completedStepIds = new Set();
  let failedStepReasons = [];
  let feedbackLog = [];
  let previousRate = 0;
  let stagnantCount = 0;
  let totalAttempts = 0;
  let finalResult = null;

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    // 1. Solve with current task
    const solveResult = solve(currentTask, solveOptions);
    totalAttempts += solveResult.attempts;

    // 2. Evaluate steps
    const evaluation = evaluateSteps(solveResult);

    // Accumulate completed steps across iterations
    for (const stepId of evaluation.completedSteps) {
      completedStepIds.add(stepId);
    }

    // Accumulate failure reasons (deduplicate by stepId+reason via Set)
    const failureKeySet = new Set(failedStepReasons.map((f) => `${f.stepId}::${f.reason}`));
    const newFailures = evaluation.failedSteps.filter(
      (f) => !failureKeySet.has(`${f.stepId}::${f.reason}`),
    );
    failedStepReasons = [...failedStepReasons, ...newFailures];

    // Add to feedback log
    feedbackLog = [
      ...feedbackLog,
      {
        iteration,
        completionRate: evaluation.completionRate,
        completedCount: evaluation.completedSteps.length,
        failedCount: evaluation.failedSteps.length,
        timestamp: Date.now(),
      },
    ];

    // 3. Check termination
    const improvement = evaluation.completionRate - previousRate;
    if (improvement < MIN_IMPROVEMENT_THRESHOLD && iteration > 1) {
      stagnantCount += 1;
    } else {
      stagnantCount = 0;
    }

    const decision = shouldContinue({
      iteration,
      success: solveResult.success,
      completionRate: evaluation.completionRate,
      previousRate,
      stagnantCount,
    });

    const iterationEntry = {
      iteration,
      solveResult,
      evaluation,
      decision,
    };
    iterationHistory.push(iterationEntry);

    if (onIteration) {
      try { onIteration(iterationEntry); } catch { /* callback errors must not break the loop */ }
    }

    finalResult = solveResult;

    if (!decision.shouldContinue) {
      break;
    }

    // 4. Adapt task for next iteration
    previousRate = evaluation.completionRate;
    const iterationState = {
      iteration: iteration + 1,
      completedStepIds: [...completedStepIds],
      failedStepReasons,
      feedbackLog,
    };
    currentTask = adaptTask(currentTask, iterationState);
  }

  const lastEval = iterationHistory[iterationHistory.length - 1]?.evaluation;

  return {
    taskId: task.id,
    success: finalResult?.success || false,
    totalIterations: iterationHistory.length,
    totalAttempts,
    completionRate: lastEval?.completionRate || 0,
    iterationHistory,
    finalResult,
    duration: Date.now() - startTime,
  };
}

// extractFailureReason is imported from system2-core.js (shared helper)

// ---------------------------------------------------------------------------
// Exports for testing
// ---------------------------------------------------------------------------

export const _test = {
  MAX_ITERATIONS,
  MAX_FEEDBACK_ENTRIES,
  MIN_IMPROVEMENT_THRESHOLD,
  MAX_STAGNANT_ITERATIONS,
  deriveHints,
};
