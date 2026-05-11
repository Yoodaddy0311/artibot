/**
 * Tests for lib/autopilot/goal-control.js (v4.6.0 Phase 3).
 * Covers pauseGoal / resumeGoal / retryGoal / clearGoal / getGoalStatus
 * with real session-store I/O and integration with the EVALUATE phase
 * runner (verifies the goal-paused slot is honored).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearGoal,
  getGoalStatus,
  pauseGoal,
  resumeGoal,
  retryGoal,
} from '../../lib/autopilot/goal-control.js';
import {
  deleteSession,
  newSessionId,
  saveSession,
} from '../../lib/autopilot/session-store.js';
import { runPhaseGoalEvaluate } from '../../lib/autopilot/goal-loop.js';
import * as telemetry from '../../lib/autopilot/telemetry.js';

const tracked = new Set();

function seedSession(overrides = {}) {
  const sessionId = newSessionId() + '-goalctl';
  tracked.add(sessionId);
  const state = {
    sessionId,
    task: 'goal-control test',
    mode: 'default',
    phase: 'IMPROVE',
    phases: [],
    options: {},
    counters: { buildFailures: 0, testFailures: 0 },
    queuedQuestions: [],
    errors: [],
    checkpoints: [],
    tokenUsage: 0,
    lastReviewedSHA: null,
    worktreePath: null,
    lockPath: null,
    parentSession: null,
    goalContract: {
      objective: 'X',
      stoppingCondition: 'Y',
      validationCommand: 'npm run ci',
      forbiddenChanges: [],
      maxIterations: 3,
    },
    goalIterations: 0,
    lastIterationSHA: null,
    consecutiveSameSHA: 0,
    goalEvaluation: null,
    goalPaused: false,
    goalControl: null,
    ...overrides,
  };
  saveSession(state);
  return state;
}

beforeEach(() => {
  vi.spyOn(telemetry, 'appendEvent').mockImplementation(() => {});
});

afterEach(() => {
  for (const id of tracked) {
    try { deleteSession(id); } catch { /* ignore */ }
  }
  tracked.clear();
  vi.restoreAllMocks();
});

describe('pauseGoal', () => {
  it('returns ok=false for missing sessionId', () => {
    expect(pauseGoal('').ok).toBe(false);
    expect(pauseGoal(null).ok).toBe(false);
    expect(pauseGoal(undefined).ok).toBe(false);
  });

  it('returns ok=false for unknown sessionId', () => {
    const r = pauseGoal('ap-19990101-000000-nonexistent');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/session not found/);
  });

  it('returns ok=false when session has no Goal Contract', () => {
    const state = seedSession({ goalContract: null });
    const r = pauseGoal(state.sessionId);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/no Goal Contract/);
  });

  it('sets goalPaused=true and records control action on success', () => {
    const state = seedSession();
    const r = pauseGoal(state.sessionId, { reason: 'user manual review' });
    expect(r.ok).toBe(true);
    expect(r.paused).toBe(true);
    const status = getGoalStatus(state.sessionId);
    expect(status.paused).toBe(true);
    expect(status.lastAction.lastAction).toBe('pause');
    expect(status.lastAction.reason).toBe('user manual review');
  });
});

describe('resumeGoal', () => {
  it('lifts the goalPaused flag', () => {
    const state = seedSession({ goalPaused: true });
    const r = resumeGoal(state.sessionId);
    expect(r.ok).toBe(true);
    expect(r.paused).toBe(false);
    const status = getGoalStatus(state.sessionId);
    expect(status.paused).toBe(false);
    expect(status.lastAction.lastAction).toBe('resume');
  });

  it('returns ok=false when session has no Goal Contract', () => {
    const state = seedSession({ goalContract: null });
    expect(resumeGoal(state.sessionId).ok).toBe(false);
  });
});

describe('retryGoal', () => {
  it('resets goalIterations to 0 by default', () => {
    const state = seedSession({
      goalIterations: 2,
      consecutiveSameSHA: 2,
      lastIterationSHA: 'abc',
      goalPaused: true,
    });
    const r = retryGoal(state.sessionId);
    expect(r.ok).toBe(true);
    expect(r.iterations).toBe(0);
    const status = getGoalStatus(state.sessionId);
    expect(status.iterations).toBe(0);
    expect(status.paused).toBe(false);
    expect(status.lastAction.lastAction).toBe('retry');
  });

  it('preserves goalIterations when resetIterations=false', () => {
    const state = seedSession({ goalIterations: 2 });
    const r = retryGoal(state.sessionId, { resetIterations: false });
    expect(r.iterations).toBe(2);
  });
});

describe('clearGoal', () => {
  it('removes the Goal Contract and resets related slots', () => {
    const state = seedSession({
      goalIterations: 2,
      goalEvaluation: { met: false, exitCode: 1 },
      goalPaused: true,
    });
    const r = clearGoal(state.sessionId);
    expect(r.ok).toBe(true);
    expect(r.cleared).toBe(true);
    const status = getGoalStatus(state.sessionId);
    expect(status.contract).toBeNull();
    expect(status.iterations).toBe(0);
    expect(status.paused).toBe(false);
    expect(status.lastAction.lastAction).toBe('clear');
  });

  it('returns ok=false when session has no Goal Contract', () => {
    const state = seedSession({ goalContract: null });
    expect(clearGoal(state.sessionId).ok).toBe(false);
  });
});

describe('getGoalStatus — read-only', () => {
  it('returns all goal-state fields for a session with a contract', () => {
    const state = seedSession({ goalIterations: 1 });
    const status = getGoalStatus(state.sessionId);
    expect(status.ok).toBe(true);
    expect(status.contract).toBeTruthy();
    expect(status.contract.objective).toBe('X');
    expect(status.iterations).toBe(1);
    expect(status.maxIterations).toBe(3);
    expect(status.paused).toBe(false);
  });

  it('returns ok=false for unknown sessionId', () => {
    const r = getGoalStatus('ap-19990101-000000-missing');
    expect(r.ok).toBe(false);
  });
});

describe('Phase 3 integration — runPhaseGoalEvaluate honors goalPaused', () => {
  it('skips evaluation and returns nextPhase=REPORT when goalPaused is true', () => {
    const state = seedSession({ goalPaused: true });
    const runCommand = vi.fn(() => ({ exitCode: 1, stdout: '', stderr: '' }));
    const r = runPhaseGoalEvaluate(state, { runCommand });
    expect(r.nextPhase).toBe('REPORT');
    expect(r.skipped).toBe(true);
    expect(r.goalPaused).toBe(true);
    // The evaluator (validationCommand) must NOT have been invoked
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('resumes normal evaluation flow after resumeGoal lifts the flag', () => {
    const state = seedSession({ goalPaused: true });
    resumeGoal(state.sessionId);
    // Reload to pick up persisted state (resumeGoal saved to disk)
    state.goalPaused = false;
    const runCommand = vi.fn(() => ({ exitCode: 0, stdout: 'pass', stderr: '' }));
    const r = runPhaseGoalEvaluate(state, { runCommand });
    expect(r.met).toBe(true);
    expect(runCommand).toHaveBeenCalled();
  });
});
