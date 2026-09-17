/**
 * Unit tests for lib/autopilot/engine-state.js — state record/mutation helpers
 * extracted from engine.js (F2 refactor, no behavior change).
 *
 * Validates the extracted module directly: classifyFailure routing, and the
 * record* helpers' mutation/guard contracts. These functions persist via
 * session-store; we operate on throwaway in-memory state and assert on the
 * returned/mutated object (persist is best-effort and tolerant of unknown ids).
 *
 * STORE ISOLATION (measured 2026-09-17). "Persist is best-effort" is not the
 * same as "persist writes nothing". `recordPhaseResult` / `recordCheckpoint` /
 * `recordRiskEvent` / `recordSecretLeak` all reach `session-store.js`, whose
 * `getStoreDir()` (session-store.js:105) resolves to
 * `<getPluginRoot()>/runtime/autopilot` at CALL time. A single unmodified run
 * of this file left 16 files there (15 `.json` + 1 `.events.ndjson`), and the
 * `afterEach deleteSessionArtifacts` below covers only the VERIFY describe, so
 * the rest accumulated run after run.
 *
 * `getPluginRoot()` (lib/core/platform.js:105-120) re-reads
 * `CLAUDE_PLUGIN_ROOT` on every call and never caches, so pointing the env var
 * at a temp dir in `beforeAll` is enough even though the module graph is
 * already imported by then. The `artibot.config.json` stub is written because
 * `getPluginRoot` treats a config-less directory as a possibly stale root.
 * Sandbox shape follows `tests/hooks/dev-verify-gate-ledger.test.js`.
 *
 * The existing `afterEach` cleanup stays as a second layer; neither replaces
 * the other.
 *
 * WHAT THIS ISOLATION DOES NOT COVER: stores that do not resolve through
 * `getPluginRoot` (the decisions store walks up to the nearest `.git` instead),
 * and anything a child process writes.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
import { deleteSessionArtifacts } from '../../lib/autopilot/session-store.js';

/** Temp plugin root for this file; created in beforeAll, removed in afterAll. */
let sandboxRoot = null;
/** Prior CLAUDE_PLUGIN_ROOT value; `undefined` means it was unset. */
let previousPluginRoot;

beforeAll(() => {
  sandboxRoot = mkdtempSync(path.join(os.tmpdir(), 'artibot-engine-state-'));
  writeFileSync(path.join(sandboxRoot, 'artibot.config.json'), '{}', 'utf8');
  previousPluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  process.env.CLAUDE_PLUGIN_ROOT = sandboxRoot;
});

afterAll(() => {
  if (previousPluginRoot === undefined) delete process.env.CLAUDE_PLUGIN_ROOT;
  else process.env.CLAUDE_PLUGIN_ROOT = previousPluginRoot;
  if (sandboxRoot) rmSync(sandboxRoot, { recursive: true, force: true });
  sandboxRoot = null;
});

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

describe('recordPhaseResult — VERIFY is the SH-06 recording point', () => {
  // These cases persist and emit telemetry, so their artifacts are removed.
  const sessions = [];
  const verifyState = (overrides = {}) => {
    const state = makeState({ phase: 'VERIFY', pendingPhase: null, ...overrides });
    sessions.push(state.sessionId);
    return state;
  };

  afterEach(() => {
    while (sessions.length) {
      try {
        deleteSessionArtifacts(sessions.pop());
      } catch { /* best-effort */ }
    }
  });

  it('journals a failed VERIFY without moving the fixed IMPROVE transition', () => {
    const state = verifyState({ verifyResult: { ok: false }, crossCheck: { verdict: 'fail' } });
    const before = { phase: state.phase, pendingPhase: state.pendingPhase, next: nextTarget(state) };

    recordPhaseResult(state, { phase: 'VERIFY', status: 'failed' });

    expect({ phase: state.phase, pendingPhase: state.pendingPhase, next: nextTarget(state) })
      .toEqual(before);
    expect(nextTarget(state)).toBe('IMPROVE');
    expect(state.recoveryJournal).toHaveLength(1);
    expect(state.recoveryJournal[0]).toMatchObject({
      phase: 'VERIFY', status: 'failed', fixedNext: 'IMPROVE', divergent: true,
    });
  });

  it('writes no journal row for a clean VERIFY', () => {
    const state = verifyState({ verifyResult: { status: 'PASS' }, crossCheck: { verdict: 'pass' } });
    recordPhaseResult(state, { phase: 'VERIFY', status: 'done' });
    expect(state.recoveryJournal).toBeUndefined();
    expect(state.phases.some((p) => p.name === 'VERIFY' && p.status === 'done')).toBe(true);
  });

  it('leaves the journal untouched for every other phase', () => {
    const state = verifyState({ phase: 'EXECUTE', verifyResult: { ok: false } });
    recordPhaseResult(state, { phase: 'EXECUTE', status: 'failed' });
    expect(state.recoveryJournal).toBeUndefined();
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
