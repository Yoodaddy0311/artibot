/**
 * Tests for lib/autopilot/goal-loop.js — runPhaseGoalEvaluate
 * (v4.6.0 Phase 2). Covers the EVALUATE phase decision matrix:
 * legacy passthrough, met/proceed, iterate, max-cap PAUSE, manual
 * gate PAUSE, no-progress (same SHA) PAUSE.
 *
 * Uses DI-injected runCommand to avoid real subprocess execution.
 * State is constructed inline (no real session-store I/O via tmpdir);
 * persist() writes go to the configured session-store path which is
 * harmless in unit tests.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runPhaseGoalEvaluate } from '../../lib/autopilot/goal-loop.js';
import { resumeAutopilot } from '../../lib/autopilot/engine.js';
import { retryGoal } from '../../lib/autopilot/goal-control.js';
import * as sessionStore from '../../lib/autopilot/session-store.js';
import { deleteSessionArtifacts, loadSession, saveSession } from '../../lib/autopilot/session-store.js';
import * as telemetry from '../../lib/autopilot/telemetry.js';

const baseContract = Object.freeze({
  objective: 'migrate API to v2',
  stoppingCondition: 'all endpoints return 200',
  validationCommand: 'npm run ci',
  forbiddenChanges: [],
  maxIterations: 3,
});

function makeState(overrides = {}) {
  return {
    sessionId: `ap-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    task: 'test',
    mode: 'default',
    phase: 'IMPROVE',
    phases: [],
    lastReviewedSHA: null,
    goalContract: null,
    goalIterations: 0,
    lastIterationSHA: null,
    consecutiveSameSHA: 0,
    goalEvaluation: null,
    ...overrides,
  };
}

// Suppress real session-store / telemetry writes during tests.
beforeEach(() => {
  vi.spyOn(sessionStore, 'saveSession').mockImplementation(() => {});
  vi.spyOn(telemetry, 'appendEvent').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('runPhaseGoalEvaluate — legacy passthrough', () => {
  it('returns nextPhase=REPORT with skipped=true when goalContract is null', () => {
    const state = makeState({ goalContract: null });
    const r = runPhaseGoalEvaluate(state);
    expect(r.type).toBe('phase-result');
    expect(r.nextPhase).toBe('REPORT');
    expect(r.skipped).toBe(true);
    expect(state.phases.some((p) => p.name === 'EVALUATE' && p.status === 'skipped')).toBe(true);
  });
});

describe('runPhaseGoalEvaluate — met → REPORT', () => {
  it('proceeds to REPORT when validationCommand exits 0', () => {
    const state = makeState({ goalContract: baseContract });
    const runCommand = vi.fn(() => ({ exitCode: 0, stdout: 'pass', stderr: '' }));
    const r = runPhaseGoalEvaluate(state, { runCommand });
    expect(r.nextPhase).toBe('REPORT');
    expect(r.met).toBe(true);
    expect(state.goalEvaluation.met).toBe(true);
    expect(state.goalIterations).toBe(0); // no iteration consumed on met
  });
});

describe('runPhaseGoalEvaluate — iterate (not met, under cap)', () => {
  it('emits nextPhase=EXECUTE and increments goalIterations', () => {
    const state = makeState({ goalContract: baseContract });
    const runCommand = vi.fn(() => ({ exitCode: 1, stdout: '', stderr: 'fail' }));
    const r = runPhaseGoalEvaluate(state, { runCommand });
    expect(r.nextPhase).toBe('EXECUTE');
    expect(r.met).toBe(false);
    expect(r.iteration).toBe(1);
    expect(r.maxIterations).toBe(3);
    expect(state.goalIterations).toBe(1);
    // AP-02 contract: `phase` is what just COMPLETED (EVALUATE); the corrective
    // EXECUTE is named in `pendingPhase`. Writing 'EXECUTE' into `phase` here
    // was the defect — resume read it as completed and skipped the iteration.
    expect(state.phase).toBe('EVALUATE');
    expect(state.pendingPhase).toBe('EXECUTE');
  });

  it('iterates again on consecutive failures until iter == max-1', () => {
    const state = makeState({ goalContract: baseContract, goalIterations: 1 });
    const runCommand = vi.fn(() => ({ exitCode: 1, stdout: '', stderr: '' }));
    const r = runPhaseGoalEvaluate(state, { runCommand });
    expect(r.nextPhase).toBe('EXECUTE');
    expect(state.goalIterations).toBe(2);
  });
});

describe('runPhaseGoalEvaluate — max iterations PAUSE', () => {
  it('PAUSEs when goalIterations would reach maxIterations', () => {
    // contract.maxIterations=3, state.goalIterations=2 → next increment hits 3, cap reached
    const state = makeState({ goalContract: baseContract, goalIterations: 2 });
    const runCommand = vi.fn(() => ({ exitCode: 1, stdout: '', stderr: '' }));
    const r = runPhaseGoalEvaluate(state, { runCommand });
    expect(r.type).toBe('pause');
    expect(r.reason).toMatch(/max iterations \(3\) reached/);
    expect(state.phase).toBe('PAUSED');
    // A goal pause used to write PAUSED with no lastPhase, so resume's
    // `lastPhase || 'PLAN'` fallback restarted the whole pipeline at PLAN.
    expect(state.lastPhase).toBe('EVALUATE');
    expect(state.pendingPhase).toBe('EVALUATE');
  });
});

describe('runPhaseGoalEvaluate — manual gate (low confidence)', () => {
  it('PAUSEs when contract has no validationCommand', () => {
    const noCmdContract = { ...baseContract, validationCommand: null };
    const state = makeState({ goalContract: noCmdContract });
    const r = runPhaseGoalEvaluate(state);
    expect(r.type).toBe('pause');
    expect(r.reason).toMatch(/manual evaluation required/);
    expect(state.phase).toBe('PAUSED');
  });
});

describe('runPhaseGoalEvaluate — no-progress guard (same SHA 3x)', () => {
  it('PAUSEs after 3 consecutive iterations on the same SHA (v4.5.6 trauma guard)', () => {
    const state = makeState({
      goalContract: baseContract,
      lastReviewedSHA: 'abc123',
      lastIterationSHA: 'abc123',
      consecutiveSameSHA: 2, // next call increments to 3
    });
    const runCommand = vi.fn(() => ({ exitCode: 1, stdout: '', stderr: '' }));
    const r = runPhaseGoalEvaluate(state, { runCommand });
    expect(r.type).toBe('pause');
    expect(r.reason).toMatch(/no progress detected/);
    expect(state.phase).toBe('PAUSED');
    // runCommand should NOT have been invoked — no-progress guard fires first
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('resets consecutiveSameSHA when a new SHA arrives', () => {
    const state = makeState({
      goalContract: baseContract,
      lastReviewedSHA: 'new456',
      lastIterationSHA: 'old123',
      consecutiveSameSHA: 2,
    });
    const runCommand = vi.fn(() => ({ exitCode: 0, stdout: '', stderr: '' }));
    runPhaseGoalEvaluate(state, { runCommand });
    expect(state.consecutiveSameSHA).toBe(1);
    expect(state.lastIterationSHA).toBe('new456');
  });
});

describe('AP-02 — the corrective EXECUTE survives a persist/resume round trip', () => {
  // These cases use the REAL session store: the defect lived entirely in what
  // resume read back off disk, so a mocked saveSession would have hidden it.
  // `node -e process.exit(3)` is the validation command because resume calls
  // runPhaseGoalEvaluate with no DI hook — a mock here would prove nothing.
  const failingContract = Object.freeze({
    ...baseContract,
    validationCommand: 'node -e "process.exit(3)"',
  });
  const tracked = new Set();
  // ARTIFACT ISOLATION CONTRACT: resume drives real phase runners, and a drift
  // to REPORT would write reports/AUTOPILOT/ under the operator's checkout.
  let artifactRoot = '';

  beforeAll(() => {
    artifactRoot = mkdtempSync(path.join(os.tmpdir(), 'artibot-goal-loop-artifacts-'));
  });

  afterAll(() => {
    try { rmSync(artifactRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  beforeEach(() => {
    // Runs after the outer beforeEach, so this drops its store/telemetry mocks.
    vi.restoreAllMocks();
  });

  afterEach(() => {
    for (const id of tracked) {
      try { deleteSessionArtifacts(id); } catch { /* ignore */ }
    }
    tracked.clear();
  });

  function trackedState(overrides = {}) {
    const state = makeState({
      goalContract: failingContract,
      options: { projectRoot: artifactRoot },
      ...overrides,
    });
    tracked.add(state.sessionId);
    return state;
  }

  it('resumes into EXECUTE — not CROSS_CHECK — after an iterate decision', async () => {
    const state = trackedState();
    const runCommand = vi.fn(() => ({ exitCode: 1, stdout: '', stderr: 'fail' }));
    runPhaseGoalEvaluate(state, { runCommand });
    saveSession(state);

    const onDisk = loadSession(state.sessionId);
    expect(onDisk.phase).toBe('EVALUATE');
    expect(onDisk.pendingPhase).toBe('EXECUTE');

    const resumed = await resumeAutopilot(state.sessionId);

    expect(resumed.phase).toBe('EXECUTE');
    expect(resumed.instruction.type).toBe('team-create');
    expect(resumed.instruction.phase).toBe('EXECUTE');
    // The iteration counter is what the cap is enforced on; losing it across a
    // resume would silently hand the session an extra full set of iterations.
    expect(loadSession(state.sessionId).goalIterations).toBe(1);
  });

  it('re-enters EVALUATE on a capped session and only iterates once retryGoal lifts the cap', async () => {
    const state = trackedState({ goalIterations: 2 });
    const runCommand = vi.fn(() => ({ exitCode: 1, stdout: '', stderr: '' }));
    expect(runPhaseGoalEvaluate(state, { runCommand }).type).toBe('pause');
    saveSession(state);

    // Capped: resume must re-enter the evaluator and pause again, never EXECUTE.
    const blocked = await resumeAutopilot(state.sessionId);
    expect(blocked.status).toBe('paused');
    expect(blocked.instruction.reason).toMatch(/max iterations/);
    expect(loadSession(state.sessionId).pendingPhase).toBe('EVALUATE');

    // retryGoal is the documented exit from the cap (goal-control.js).
    expect(retryGoal(state.sessionId).ok).toBe(true);
    const retried = await resumeAutopilot(state.sessionId);

    expect(retried.instruction.type).toBe('phase-result');
    expect(retried.instruction.nextPhase).toBe('EXECUTE');
    expect(loadSession(state.sessionId).pendingPhase).toBe('EXECUTE');
  });
});

describe('runPhaseGoalEvaluate — state mutation invariants', () => {
  it('always sets state.phase to EVALUATE before deciding (even on legacy skip)', () => {
    const state = makeState({ goalContract: null });
    runPhaseGoalEvaluate(state);
    // After legacy skip, phase stays at EVALUATE (next runner moves to REPORT)
    expect(state.phase).toBe('EVALUATE');
  });

  it('records the evaluation result on state.goalEvaluation', () => {
    const state = makeState({ goalContract: baseContract });
    const runCommand = vi.fn(() => ({ exitCode: 0, stdout: 'ok', stderr: '' }));
    runPhaseGoalEvaluate(state, { runCommand });
    expect(state.goalEvaluation).toMatchObject({
      met: true,
      exitCode: 0,
      confidence: 1.0,
    });
  });
});
