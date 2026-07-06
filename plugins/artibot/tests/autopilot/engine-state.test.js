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
  recordCheckpoint,
  recordPhaseResult,
  recordRiskEvent,
  recordSecretLeak,
} from '../../lib/autopilot/engine-state.js';
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
