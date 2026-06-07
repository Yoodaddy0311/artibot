/**
 * Tests for the Phase 4 progress heartbeat slot emitted by
 * runPhaseGoalEvaluate (v4.6.0). Verifies each evaluator-related
 * telemetry tick carries a structured `progress` object suitable for
 * /autopilot:tail rendering.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runPhaseGoalEvaluate } from '../../lib/autopilot/goal-loop.js';
import * as sessionStore from '../../lib/autopilot/session-store.js';
import * as telemetry from '../../lib/autopilot/telemetry.js';

const baseContract = Object.freeze({
  objective: 'X',
  stoppingCondition: 'Y',
  validationCommand: 'npm run ci',
  forbiddenChanges: [],
  maxIterations: 3,
});

function makeState(overrides = {}) {
  return {
    sessionId: `ap-progress-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    task: 'progress test',
    mode: 'default',
    phase: 'IMPROVE',
    phases: [],
    lastReviewedSHA: null,
    goalContract: baseContract,
    goalIterations: 0,
    lastIterationSHA: null,
    consecutiveSameSHA: 0,
    goalEvaluation: null,
    goalPaused: false,
    goalControl: null,
    ...overrides,
  };
}

let appendEventSpy;

beforeEach(() => {
  vi.spyOn(sessionStore, 'saveSession').mockImplementation(() => {});
  appendEventSpy = vi.spyOn(telemetry, 'appendEvent').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

function findEvent(predicate) {
  return appendEventSpy.mock.calls
    .map(([, evt]) => evt)
    .find(predicate);
}

describe('progress heartbeat — emission paths', () => {
  it('attaches progress to the goal-evaluated tick (met=true path)', () => {
    const state = makeState();
    runPhaseGoalEvaluate(state, {
      runCommand: () => ({ exitCode: 0, stdout: '', stderr: '' }),
    });
    const evt = findEvent((e) => e.type === 'goal-evaluated');
    expect(evt).toBeTruthy();
    expect(evt.progress).toBeTruthy();
    expect(evt.progress.iteration).toBe(0); // not yet incremented (met=true path)
    expect(evt.progress.maxIterations).toBe(3);
    expect(evt.progress.met).toBe(true);
    expect(evt.progress.exitCode).toBe(0);
    expect(evt.progress.confidence).toBe(1.0);
  });

  it('emits a 100% progress heartbeat on the met phase-end tick', () => {
    const state = makeState();
    runPhaseGoalEvaluate(state, {
      runCommand: () => ({ exitCode: 0, stdout: '', stderr: '' }),
    });
    const evt = findEvent((e) => e.type === 'phase-end' && e.phase === 'EVALUATE');
    expect(evt).toBeTruthy();
    expect(evt.progress).toBeTruthy();
    // Met path does not increment goalIterations, so without the override the
    // pct would stick at the first-iteration 0%. Completion must read 100%.
    expect(evt.progress.pct).toBe(100);
    expect(evt.progress.met).toBe(true);
  });

  it('attaches progress to the iterate phase-end tick (not met, under cap)', () => {
    const state = makeState();
    runPhaseGoalEvaluate(state, {
      runCommand: () => ({ exitCode: 1, stdout: '', stderr: '' }),
    });
    const evt = findEvent((e) => e.type === 'phase-end' && e.phase === 'EVALUATE');
    expect(evt).toBeTruthy();
    expect(evt.progress).toBeTruthy();
    expect(evt.progress.iteration).toBe(1);
    expect(evt.progress.maxIterations).toBe(3);
    expect(evt.progress.pct).toBe(33);
    expect(evt.progress.met).toBe(false);
  });

  it('attaches progress to the max-cap pause tick', () => {
    const state = makeState({ goalIterations: 2 });
    runPhaseGoalEvaluate(state, {
      runCommand: () => ({ exitCode: 1, stdout: '', stderr: '' }),
    });
    // max-cap pause uses two ticks: goal-evaluated + pause. Find the pause.
    const evt = findEvent((e) => e.type === 'pause');
    expect(evt).toBeTruthy();
    expect(evt.progress).toBeTruthy();
    expect(evt.progress.iteration).toBe(3);
    expect(evt.progress.maxIterations).toBe(3);
    expect(evt.progress.pct).toBe(100);
    expect(evt.progress.met).toBe(false);
  });
});

describe('progress heartbeat — field invariants', () => {
  it('progress.pct is a whole-number percentage', () => {
    const state = makeState();
    runPhaseGoalEvaluate(state, {
      runCommand: () => ({ exitCode: 1, stdout: '', stderr: '' }),
    });
    const evt = findEvent((e) => e.type === 'phase-end' && e.phase === 'EVALUATE');
    expect(Number.isInteger(evt.progress.pct)).toBe(true);
    expect(evt.progress.pct).toBeGreaterThanOrEqual(0);
    expect(evt.progress.pct).toBeLessThanOrEqual(100);
  });

  it('progress.iteration matches state.goalIterations at emission time', () => {
    const state = makeState();
    runPhaseGoalEvaluate(state, {
      runCommand: () => ({ exitCode: 1, stdout: '', stderr: '' }),
    });
    const evt = findEvent((e) => e.type === 'phase-end' && e.phase === 'EVALUATE');
    expect(evt.progress.iteration).toBe(state.goalIterations);
  });

  it('progress is absent when the EVALUATE skip path fires (no goalContract)', () => {
    const state = makeState({ goalContract: null });
    runPhaseGoalEvaluate(state);
    const evt = findEvent((e) => e.type === 'phase-end' && e.phase === 'EVALUATE');
    expect(evt).toBeTruthy();
    expect(evt.progress).toBeUndefined();
  });

  it('progress is absent on the goal-paused skip path (Phase 3 orthogonal)', () => {
    const state = makeState({ goalPaused: true });
    runPhaseGoalEvaluate(state);
    const evt = findEvent((e) => e.type === 'phase-end' && e.phase === 'EVALUATE');
    expect(evt).toBeTruthy();
    expect(evt.progress).toBeUndefined();
  });
});
