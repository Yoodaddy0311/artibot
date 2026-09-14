/**
 * Unit tests for lib/autopilot/engine-state.js — state record/mutation helpers
 * extracted from engine.js (F2 refactor, no behavior change).
 *
 * Validates the extracted module directly: classifyFailure routing, and the
 * record* helpers' mutation/guard contracts. These functions persist via
 * session-store; we operate on throwaway in-memory state and assert on the
 * returned/mutated object (persist is best-effort and tolerant of unknown ids).
 */

import { describe, expect, it } from 'vitest';
import {
  classifyFailure,
  enterPhase,
  nextPhaseAfter,
  nextTarget,
  PHASES,
  recordCheckpoint,
  recordPhaseResult,
  recordRiskEvent,
  recordSecretLeak,
} from '../../lib/autopilot/engine-state.js';
import { openPhaseAttempt } from '../../lib/autopilot/phase-attempt.js';
import { shouldPause } from '../../lib/autopilot/safety.js';

function makeState(overrides = {}) {
  return {
    sessionId: `test-engine-state-${Math.random().toString(36).slice(2)}`,
    phase: 'EXECUTE',
    phases: [],
    ...overrides,
  };
}

describe('classifyFailure', () => {
  it('detects typecheck failures', () => {
    expect(classifyFailure({ stderr: 'error TS2345: type mismatch' })).toBe('typecheck');
    expect(classifyFailure({ stdout: 'tsc found 3 errors' })).toBe('typecheck');
  });

  it('detects test failures', () => {
    expect(classifyFailure({ stderr: 'vitest run failed' })).toBe('test');
  });

  it('detects lint failures', () => {
    expect(classifyFailure({ stderr: 'eslint: 2 problems' })).toBe('lint');
  });

  it('detects build failures', () => {
    expect(classifyFailure({ stderr: 'webpack build failed' })).toBe('build');
  });

  it('falls back to unknown-failure on nonzero exit with no signal', () => {
    expect(classifyFailure({ exitCode: 1, stderr: 'something opaque' })).toBe('unknown-failure');
  });

  it('returns unknown on empty payload', () => {
    expect(classifyFailure()).toBe('unknown');
    expect(classifyFailure({ exitCode: 0 })).toBe('unknown');
  });
});

describe('nextTarget — the single answer to "what runs next"', () => {
  it.each([
    // [label, state, expected]
    ['a terminal COMPLETED session has no target', { phase: 'COMPLETED' }, null],
    ['a terminal ABORTED session has no target', { phase: 'ABORTED' }, null],
    ['an explicit pendingPhase wins over derivation', { phase: 'EVALUATE', pendingPhase: 'EXECUTE' }, 'EXECUTE'],
    ['a rerun names its own phase rather than the successor', { phase: 'CROSS_CHECK', pendingPhase: 'CROSS_CHECK' }, 'CROSS_CHECK'],
    ['pendingPhase outranks the PAUSED/lastPhase pair', { phase: 'PAUSED', lastPhase: 'PLAN', pendingPhase: 'EXECUTE' }, 'EXECUTE'],
    ['PAUSED without pendingPhase falls back to lastPhase (v2 shape)', { phase: 'PAUSED', lastPhase: 'VERIFY' }, 'VERIFY'],
    ['PAUSED with neither restarts at PLAN', { phase: 'PAUSED' }, 'PLAN'],
    ['a completed phase derives its successor', { phase: 'EXECUTE' }, 'CROSS_CHECK'],
    ['the last phase stays on itself', { phase: 'REPORT' }, 'REPORT'],
    ['an unknown phase label routes to PLAN', { phase: 'WAT' }, 'PLAN'],
    ['a pendingPhase that is not a real phase is ignored', { phase: 'EXECUTE', pendingPhase: 'NONSENSE' }, 'CROSS_CHECK'],
    ['a non-string pendingPhase is ignored', { phase: 'EXECUTE', pendingPhase: 3 }, 'CROSS_CHECK'],
    ['a null pendingPhase means "derive"', { phase: 'PLAN', pendingPhase: null }, 'EXECUTE'],
    ['a terminal session ignores a stale pendingPhase', { phase: 'COMPLETED', pendingPhase: 'EXECUTE' }, null],
  ])('%s', (_label, state, expected) => {
    expect(nextTarget(state)).toBe(expected);
  });

  it('is pure — reading the target never mutates the state', () => {
    const state = { phase: 'PAUSED', lastPhase: 'EXECUTE', pendingPhase: 'EXECUTE' };
    const snapshot = JSON.stringify(state);
    nextTarget(state);
    expect(JSON.stringify(state)).toBe(snapshot);
  });

  it('tolerates a missing state', () => {
    expect(nextTarget(null)).toBe('PLAN');
    expect(nextTarget(undefined)).toBe('PLAN');
  });
});

describe('nextPhaseAfter / PHASES', () => {
  it('walks the canonical order and stops at the end', () => {
    expect(PHASES).toEqual([
      'INTAKE', 'PLAN', 'EXECUTE', 'CROSS_CHECK', 'VERIFY', 'IMPROVE', 'EVALUATE', 'REPORT',
    ]);
    for (let i = 0; i < PHASES.length - 1; i += 1) {
      expect(nextPhaseAfter(PHASES[i])).toBe(PHASES[i + 1]);
    }
    expect(nextPhaseAfter('REPORT')).toBeNull();
    expect(nextPhaseAfter('PAUSED')).toBeNull();
    expect(nextPhaseAfter('COMPLETED')).toBeNull();
    expect(nextPhaseAfter('ABORTED')).toBeNull();
  });
});

describe('enterPhase', () => {
  it('records the entered phase and drops the override that pointed at it', () => {
    const state = makeState({ phase: 'EVALUATE', pendingPhase: 'EXECUTE' });
    expect(enterPhase(state, 'EXECUTE')).toBe(state);
    expect(state.phase).toBe('EXECUTE');
    // Keeping it would redirect the phase AFTER this one as well.
    expect(state.pendingPhase).toBeNull();
    expect(nextTarget(state)).toBe('CROSS_CHECK');
  });

  it('throws when state is missing', () => {
    expect(() => enterPhase(null, 'PLAN')).toThrow(TypeError);
  });
});

describe('recordPhaseResult', () => {
  it('throws when state is missing', () => {
    expect(() => recordPhaseResult(null, { phase: 'PLAN', status: 'done' })).toThrow(TypeError);
  });

  it('appends a labeled phase entry to state.phases', () => {
    const state = makeState();
    const out = recordPhaseResult(state, { phase: 'PLAN', status: 'done' });
    expect(out).toBe(state);
    expect(state.phases.some((p) => p.name === 'PLAN' && p.status === 'done')).toBe(true);
  });

  it('lifts a pause on the phase being reported and advances the target (AP-01)', () => {
    const state = makeState({ phase: 'PAUSED', lastPhase: 'EXECUTE', pendingPhase: 'EXECUTE' });
    recordPhaseResult(state, { phase: 'EXECUTE', status: 'acknowledged-on-resume' });
    expect(state.phase).toBe('EXECUTE');
    expect(state.pendingPhase).toBe('CROSS_CHECK');
    // The whole defect: resume must NOT hand EXECUTE out a second time.
    expect(nextTarget(state)).toBe('CROSS_CHECK');
  });

  it('advances the target when it acknowledges an open attempt', () => {
    const state = makeState({ phase: 'EXECUTE' });
    openPhaseAttempt(state, { phase: 'EXECUTE', runner: 'team-create' });
    recordPhaseResult(state, { phase: 'EXECUTE', status: 'done' });
    expect(state.pendingPhase).toBe('CROSS_CHECK');
    expect(state.activePhaseAttempt).toBeNull();
  });

  it('does not regress phase for a stale report about a different phase', () => {
    const state = makeState({ phase: 'PAUSED', lastPhase: 'VERIFY', pendingPhase: 'VERIFY' });
    recordPhaseResult(state, { phase: 'PLAN', status: 'done' });
    expect(state.phase).toBe('PAUSED');
    expect(state.pendingPhase).toBe('VERIFY');
  });

  it('leaves an explicit pendingPhase alone on a plain in-flow report', () => {
    // goal-loop sets pendingPhase=EXECUTE while phase stays EVALUATE. A driver
    // reporting EVALUATE afterwards must not overwrite that with REPORT.
    const state = makeState({ phase: 'EVALUATE', pendingPhase: 'EXECUTE' });
    recordPhaseResult(state, { phase: 'EVALUATE', status: 'done' });
    expect(state.pendingPhase).toBe('EXECUTE');
  });

  it('tolerates IMPROVE payload with improvements/futurePlans arrays', () => {
    const state = makeState({ featureKey: null });
    expect(() =>
      recordPhaseResult(state, {
        phase: 'IMPROVE',
        status: 'done',
        improvements: ['dedupe x'],
        futurePlans: ['cache y'],
      }),
    ).not.toThrow();
  });
});

describe('recordCheckpoint', () => {
  it('throws when state is missing', () => {
    expect(() => recordCheckpoint(undefined, {})).toThrow(TypeError);
  });

  it('pushes a checkpoint capturing sha, label and current phase', () => {
    const state = makeState({ phase: 'EXECUTE' });
    recordCheckpoint(state, { sha: 'abc123', label: 'wip' });
    expect(state.checkpoints).toHaveLength(1);
    expect(state.checkpoints[0]).toMatchObject({ sha: 'abc123', label: 'wip', phase: 'EXECUTE' });
  });

  it('defaults sha/label to null', () => {
    const state = makeState();
    recordCheckpoint(state, {});
    expect(state.checkpoints[0]).toMatchObject({ sha: null, label: null });
  });
});

describe('recordSecretLeak', () => {
  it('throws when state is missing', () => {
    expect(() => recordSecretLeak(null, {})).toThrow(TypeError);
  });

  it('freezes the session to PAUSED and records the leak + lastPhase', () => {
    const state = makeState({ phase: 'VERIFY' });
    recordSecretLeak(state, { kind: 'aws-key', location: 'src/x.js' });
    expect(state.phase).toBe('PAUSED');
    expect(state.lastPhase).toBe('VERIFY');
    expect(state.pausedReason).toBe('secret-leak: aws-key');
    expect(state.errors[0]).toMatchObject({ kind: 'aws-key', location: 'src/x.js' });
    // Resume must come back to the phase the leak interrupted, not to PLAN.
    expect(state.pendingPhase).toBe('VERIFY');
    expect(nextTarget(state)).toBe('VERIFY');
  });

  it('does not overwrite lastPhase when already PAUSED', () => {
    const state = makeState({ phase: 'PAUSED', lastPhase: 'EXECUTE' });
    recordSecretLeak(state, { kind: 'token' });
    expect(state.lastPhase).toBe('EXECUTE');
  });
});

describe('recordRiskEvent (I-04 dead-branch feeder)', () => {
  it('throws when state is missing', () => {
    expect(() => recordRiskEvent(null, {})).toThrow(TypeError);
  });

  it('pushes a severity-tagged risk error and persists', () => {
    const state = makeState({ phase: 'EXECUTE' });
    recordRiskEvent(state, {
      level: 'danger',
      reason: 'Destructive git push --force',
      matchedId: 'git-force-push',
      command: 'git push --force origin main',
    });
    expect(state.errors).toHaveLength(1);
    expect(state.errors[0]).toMatchObject({
      kind: 'risk',
      severity: 'danger',
      matchedId: 'git-force-push',
    });
  });

  it('does NOT mutate phase (pause stays owned by shouldPause)', () => {
    const state = makeState({ phase: 'EXECUTE' });
    recordRiskEvent(state, { level: 'danger', reason: 'x', matchedId: 'y' });
    expect(state.phase).toBe('EXECUTE');
  });

  it('makes shouldPause() return true — the branch was previously unreachable', () => {
    const state = makeState({ phase: 'EXECUTE' });
    expect(shouldPause(state)).toBe(false);
    recordRiskEvent(state, { level: 'danger', reason: 'rm -rf', matchedId: 'rm-rf-broad' });
    expect(shouldPause(state)).toBe(true);
  });

  it('truncates long commands to 200 chars', () => {
    const state = makeState();
    recordRiskEvent(state, { level: 'danger', command: 'x'.repeat(500) });
    expect(state.errors[0].command).toHaveLength(200);
  });

  it('defaults level to danger and null fields', () => {
    const state = makeState();
    recordRiskEvent(state, {});
    expect(state.errors[0]).toMatchObject({ severity: 'danger', reason: null, matchedId: null, command: null });
  });
});
