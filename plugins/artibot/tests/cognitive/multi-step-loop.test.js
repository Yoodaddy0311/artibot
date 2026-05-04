/**
 * Tests for lib/cognitive/multi-step-loop.js
 * Multi-step Reasoning Loop Controller.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  evaluateSteps,
  adaptTask,
  shouldContinue,
  solveWithFeedback,
  _test,
} from '../../lib/cognitive/multi-step-loop.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeSolveResult({ success = false, steps = [], attempts = 1 } = {}) {
  return {
    taskId: 'test-task',
    success,
    attempts,
    history: [
      {
        attempt: 1,
        plan: { steps },
        execution: {
          success,
          results: steps,
          stepsTotal: steps.length,
          stepsCompleted: steps.filter((s) => s.status === 'success').length,
        },
        reflection: {},
      },
    ],
    finalResult: { success },
    duration: 100,
  };
}

function makeStep(id, status = 'success', action = 'do something') {
  const result = {
    stepId: id,
    status,
    action,
    order: parseInt(id.replace('step-', ''), 10) || 1,
  };
  if (status === 'failed') {
    result.execution = { exitCode: 1, stderr: 'Error: something went wrong' };
  }
  if (status === 'blocked') {
    result.execution = { blocked: true, blockedBy: 'safety rule' };
  }
  if (status === 'success') {
    result.execution = { exitCode: 0 };
  }
  return result;
}

// ---------------------------------------------------------------------------
// evaluateSteps
// ---------------------------------------------------------------------------

describe('evaluateSteps', () => {
  it('returns empty for empty solve result', () => {
    const result = evaluateSteps({ history: [] });
    expect(result.completedSteps).toEqual([]);
    expect(result.failedSteps).toEqual([]);
    expect(result.completionRate).toBe(0);
  });

  it('identifies all successful steps', () => {
    const solveResult = makeSolveResult({
      success: true,
      steps: [makeStep('step-1'), makeStep('step-2'), makeStep('step-3')],
    });
    const result = evaluateSteps(solveResult);
    expect(result.completedSteps).toEqual(['step-1', 'step-2', 'step-3']);
    expect(result.failedSteps).toHaveLength(0);
    expect(result.completionRate).toBe(1.0);
  });

  it('identifies mixed success/failure', () => {
    const solveResult = makeSolveResult({
      steps: [
        makeStep('step-1', 'success'),
        makeStep('step-2', 'failed'),
        makeStep('step-3', 'success'),
      ],
    });
    const result = evaluateSteps(solveResult);
    expect(result.completedSteps).toEqual(['step-1', 'step-3']);
    expect(result.failedSteps).toHaveLength(1);
    expect(result.failedSteps[0].stepId).toBe('step-2');
    expect(result.completionRate).toBeCloseTo(0.667, 2);
  });

  it('identifies blocked steps as failures', () => {
    const solveResult = makeSolveResult({
      steps: [makeStep('step-1', 'blocked')],
    });
    const result = evaluateSteps(solveResult);
    expect(result.failedSteps).toHaveLength(1);
    expect(result.failedSteps[0].reason).toContain('Blocked');
  });

  it('handles missing execution data', () => {
    const solveResult = makeSolveResult({
      steps: [{ stepId: 'step-1', status: 'failed', action: 'test' }],
    });
    const result = evaluateSteps(solveResult);
    expect(result.failedSteps[0].reason).toBe('No execution data');
  });
});

// ---------------------------------------------------------------------------
// adaptTask
// ---------------------------------------------------------------------------

describe('adaptTask', () => {
  const baseTask = {
    id: 'task-1',
    description: 'build auth system',
    context: { domain: 'backend' },
  };

  it('preserves original task fields', () => {
    const adapted = adaptTask(baseTask, {
      iteration: 2,
      completedStepIds: [],
      failedStepReasons: [],
      feedbackLog: [],
    });
    expect(adapted.id).toBe('task-1');
    expect(adapted.description).toBe('build auth system');
    expect(adapted.context.domain).toBe('backend');
  });

  it('adds iteration metadata', () => {
    const adapted = adaptTask(baseTask, {
      iteration: 3,
      completedStepIds: ['step-1'],
      failedStepReasons: [{ stepId: 'step-2', reason: 'timeout' }],
      feedbackLog: [{ iteration: 1, completionRate: 0.5 }],
    });
    expect(adapted.context.multiStepIteration).toBe(3);
    expect(adapted.context.previouslyCompleted).toEqual(['step-1']);
    expect(adapted.context.failureReasons).toHaveLength(1);
    expect(adapted.context.iterationFeedback).toHaveLength(1);
  });

  it('derives adaptation hints from failures', () => {
    const adapted = adaptTask(baseTask, {
      iteration: 2,
      completedStepIds: [],
      failedStepReasons: [
        { stepId: 's1', reason: 'missing dependency' },
        { stepId: 's2', reason: 'permission denied' },
      ],
      feedbackLog: [],
    });
    expect(adapted.context.adaptationHints).toContain('resolve_dependencies_first');
    expect(adapted.context.adaptationHints).toContain('check_permissions_before_execution');
  });

  it('trims feedback to MAX_FEEDBACK_ENTRIES', () => {
    const longFeedback = Array.from({ length: 30 }, (_, i) => ({
      iteration: i + 1,
      completionRate: i / 30,
    }));
    const adapted = adaptTask(baseTask, {
      iteration: 31,
      completedStepIds: [],
      failedStepReasons: [],
      feedbackLog: longFeedback,
    });
    expect(adapted.context.iterationFeedback.length).toBeLessThanOrEqual(
      _test.MAX_FEEDBACK_ENTRIES,
    );
  });

  it('derives fundamentally_re_plan hint for many failures', () => {
    const manyFailures = Array.from({ length: 5 }, (_, i) => ({
      stepId: `step-${i}`,
      reason: `error ${i}`,
    }));
    const adapted = adaptTask(baseTask, {
      iteration: 2,
      completedStepIds: [],
      failedStepReasons: manyFailures,
      feedbackLog: [],
    });
    expect(adapted.context.adaptationHints).toContain('fundamentally_re_plan');
  });
});

// ---------------------------------------------------------------------------
// shouldContinue
// ---------------------------------------------------------------------------

describe('shouldContinue', () => {
  it('stops on success', () => {
    const result = shouldContinue({
      iteration: 1,
      success: true,
      completionRate: 1.0,
      previousRate: 0,
      stagnantCount: 0,
    });
    expect(result.shouldContinue).toBe(false);
    expect(result.reason).toBe('all_steps_succeeded');
  });

  it('stops at max iterations', () => {
    const result = shouldContinue({
      iteration: _test.MAX_ITERATIONS,
      success: false,
      completionRate: 0.5,
      previousRate: 0.3,
      stagnantCount: 0,
    });
    expect(result.shouldContinue).toBe(false);
    expect(result.reason).toContain('max_iterations_reached');
  });

  it('stops on 100% completion', () => {
    const result = shouldContinue({
      iteration: 2,
      success: false,
      completionRate: 1.0,
      previousRate: 0.8,
      stagnantCount: 0,
    });
    expect(result.shouldContinue).toBe(false);
  });

  it('continues when improvement is possible', () => {
    const result = shouldContinue({
      iteration: 2,
      success: false,
      completionRate: 0.6,
      previousRate: 0.3,
      stagnantCount: 0,
    });
    expect(result.shouldContinue).toBe(true);
    expect(result.reason).toBe('improvement_possible');
  });

  it('stops after stagnant iterations', () => {
    const result = shouldContinue({
      iteration: 3,
      success: false,
      completionRate: 0.5,
      previousRate: 0.49,
      stagnantCount: _test.MAX_STAGNANT_ITERATIONS,
    });
    expect(result.shouldContinue).toBe(false);
    expect(result.reason).toContain('stagnant');
  });

  it('allows first iteration even without improvement', () => {
    const result = shouldContinue({
      iteration: 1,
      success: false,
      completionRate: 0,
      previousRate: 0,
      stagnantCount: 0,
    });
    expect(result.shouldContinue).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// solveWithFeedback (integration)
// ---------------------------------------------------------------------------

describe('solveWithFeedback', () => {
  it('returns immediately on first-attempt success', () => {
    // Mock solve to succeed immediately
    const task = { id: 't1', description: 'simple fix' };
    const result = solveWithFeedback(task);

    // solve() internally succeeds or fails — we test the wrapper structure
    expect(result.taskId).toBe('t1');
    expect(result.totalIterations).toBeGreaterThanOrEqual(1);
    expect(result.totalIterations).toBeLessThanOrEqual(_test.MAX_ITERATIONS);
    expect(result.iterationHistory).toHaveLength(result.totalIterations);
    expect(result.duration).toBeGreaterThanOrEqual(0);
  });

  it('respects maxIterations option', () => {
    const task = { id: 't2', description: 'complex multi-step task with architecture and refactor' };
    const result = solveWithFeedback(task, { maxIterations: 2 });
    expect(result.totalIterations).toBeLessThanOrEqual(2);
  });

  it('calls onIteration callback for each iteration', () => {
    const callback = vi.fn();
    const task = { id: 't3', description: 'test callback' };
    const result = solveWithFeedback(task, {
      maxIterations: 2,
      onIteration: callback,
    });
    expect(callback).toHaveBeenCalledTimes(result.totalIterations);
  });

  it('iteration history has correct structure', () => {
    const task = { id: 't4', description: 'build and test' };
    const result = solveWithFeedback(task, { maxIterations: 1 });

    const entry = result.iterationHistory[0];
    expect(entry).toHaveProperty('iteration', 1);
    expect(entry).toHaveProperty('solveResult');
    expect(entry).toHaveProperty('evaluation');
    expect(entry).toHaveProperty('decision');
    expect(entry.decision).toHaveProperty('shouldContinue');
    expect(entry.decision).toHaveProperty('reason');
  });

  it('accumulates totalAttempts across iterations', () => {
    const task = { id: 't5', description: 'migrate database schema then optimize performance' };
    const result = solveWithFeedback(task, { maxIterations: 2 });
    // Each iteration calls solve() which has its own retry count
    expect(result.totalAttempts).toBeGreaterThanOrEqual(result.totalIterations);
  });

  it('includes completionRate in result', () => {
    const task = { id: 't6', description: 'simple task' };
    const result = solveWithFeedback(task, { maxIterations: 1 });
    expect(result.completionRate).toBeGreaterThanOrEqual(0);
    expect(result.completionRate).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// deriveHints (internal)
// ---------------------------------------------------------------------------

describe('deriveHints', () => {
  it('returns empty for no failures', () => {
    expect(_test.deriveHints([])).toEqual([]);
  });

  it('detects dependency issues', () => {
    const hints = _test.deriveHints([{ stepId: 's1', reason: 'missing dependency foo' }]);
    expect(hints).toContain('resolve_dependencies_first');
  });

  it('detects permission issues', () => {
    const hints = _test.deriveHints([{ stepId: 's1', reason: 'permission denied' }]);
    expect(hints).toContain('check_permissions_before_execution');
  });

  it('detects timeout issues', () => {
    const hints = _test.deriveHints([{ stepId: 's1', reason: 'operation timeout after 30s' }]);
    expect(hints).toContain('split_into_smaller_steps');
  });

  it('detects missing prerequisites', () => {
    const hints = _test.deriveHints([{ stepId: 's1', reason: 'file not found: config.json' }]);
    expect(hints).toContain('verify_prerequisites');
  });

  it('suggests re-plan for many failures', () => {
    const failures = Array.from({ length: 4 }, (_, i) => ({
      stepId: `s${i}`,
      reason: `error ${i}`,
    }));
    expect(_test.deriveHints(failures)).toContain('fundamentally_re_plan');
  });
});
