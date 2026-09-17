/**
 * CA-03 wiring tests — `engine-state.js#recordPhaseResult` handing a journalled
 * VERIFY failure to `recovery-transition.js#applyRecoveryTransition`.
 *
 * The load-bearing case is the OFF one: with `autopilot.recovery.transitionFromVerdict`
 * false (the shipped default) the state and the event stream must be
 * byte-identical to what the Observe stage alone wrote. That is asserted by
 * comparing two serialised runs rather than by spot-checking fields, so a field
 * this file does not know about cannot drift in unnoticed.
 *
 * The ON cases are driven through `recordPhaseResult` with real inputs — the
 * recommendation is computed by `recovery-record.js#recordRecoveryDecision`, not
 * injected — so what is pinned here is the path an engine actually takes.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { nextTarget, recordPhaseResult } from '../../lib/autopilot/engine-state.js';
import { deleteSessionArtifacts } from '../../lib/autopilot/session-store.js';
import { readEvents } from '../../lib/autopilot/telemetry.js';

const sessions = [];

function makeState(overrides = {}) {
  const sessionId = `test-ca03-${Math.random().toString(36).slice(2)}`;
  sessions.push(sessionId);
  return {
    sessionId, phase: 'VERIFY', pendingPhase: null, phases: [], ...overrides,
  };
}

afterEach(() => {
  while (sessions.length) {
    try {
      deleteSessionArtifacts(sessions.pop());
    } catch { /* best-effort */ }
  }
});

/** A VERIFY the driver reported as failed, with a reviewer `fail` token. */
const FAILED_VERIFY = Object.freeze({ phase: 'VERIFY', status: 'failed' });

/** Fields that differ between two otherwise-identical runs (clock + identity). */
const VOLATILE = new Set(['at', 'ts', 'updatedAt', 'sessionId', 'startedAt', 'finishedAt']);

/** Serialise with the volatile fields flattened, so two runs compare literally. */
function stable(value) {
  return JSON.stringify(value, (key, v) => (VOLATILE.has(key) ? '<normalised>' : v));
}

function eventTypes(sessionId) {
  return readEvents(sessionId).map((e) => e.type);
}

function findEvent(sessionId, type) {
  return readEvents(sessionId).find((e) => e.type === type) ?? null;
}

function failingState(overrides = {}) {
  return makeState({
    verifyResult: { ok: false },
    crossCheck: { verdict: 'fail' },
    counters: { buildFailures: 0, testFailures: 0 },
    ...overrides,
  });
}

describe('recordPhaseResult — CA-03 gate OFF (default)', () => {
  it('leaves state and events identical whether the gate is loaded or injected false', () => {
    const s1 = failingState();
    const s2 = failingState();

    recordPhaseResult(s1, { ...FAILED_VERIFY });
    recordPhaseResult(s2, { ...FAILED_VERIFY }, { transitionFromVerdict: false });

    expect(stable(s2)).toBe(stable(s1));
    expect(stable(readEvents(s2.sessionId))).toBe(stable(readEvents(s1.sessionId)));

    for (const state of [s1, s2]) {
      expect(state.recoveryJournal).toHaveLength(1);
      expect(state.recoveryJournal[0].divergent).toBe(true);
      expect(state.recoveryJournal[0].appliedNext).toBeUndefined();
      expect(state.recoveryJournal[0].appliedBy).toBeUndefined();
      expect(state.phase).toBe('VERIFY');
      expect(state.pendingPhase).toBeNull();
      expect(nextTarget(state)).toBe('IMPROVE');
      expect(eventTypes(state.sessionId)).toContain('recovery-decided');
      expect(eventTypes(state.sessionId)).not.toContain('recovery-applied');
    }
  });

  it.each([
    ['a string "true" is not a boolean true', { transitionFromVerdict: 'true' }],
    ['an empty config object', {}],
    ['1 is not a boolean true', { transitionFromVerdict: 1 }],
  ])('treats %s as OFF', (_label, config) => {
    const state = failingState();

    recordPhaseResult(state, { ...FAILED_VERIFY }, config);

    expect(nextTarget(state)).toBe('IMPROVE');
    expect(state.recoveryJournal[0].divergent).toBe(true);
    expect(state.recoveryJournal[0].appliedNext).toBeUndefined();
    expect(eventTypes(state.sessionId)).not.toContain('recovery-applied');
  });
});

describe('recordPhaseResult — CA-03 gate ON', () => {
  const ON = Object.freeze({ transitionFromVerdict: true });

  it('applies nothing to a clean VERIFY, because no row is recorded', () => {
    const state = makeState({ verifyResult: { status: 'PASS' }, crossCheck: { verdict: 'pass' } });

    recordPhaseResult(state, { phase: 'VERIFY', status: 'done' }, ON);

    expect(state.recoveryJournal).toBeUndefined();
    expect(nextTarget(state)).toBe('IMPROVE');
    expect(eventTypes(state.sessionId)).not.toContain('recovery-applied');
  });

  it('sends a first implementation failure back to EXECUTE (repair)', () => {
    const state = failingState();

    recordPhaseResult(state, { ...FAILED_VERIFY }, ON);

    const row = state.recoveryJournal[0];
    expect(row.class).toBe('implementation');
    expect(row.action).toBe('repair');
    expect(row).toMatchObject({ divergent: false, appliedNext: 'EXECUTE', appliedBy: 'recovery-transition' });
    expect(state.phase).toBe('VERIFY');
    expect(state.pendingPhase).toBe('EXECUTE');
    expect(nextTarget(state)).toBe('EXECUTE');
    expect(findEvent(state.sessionId, 'recovery-applied')).toMatchObject({
      data: { action: 'repair', from: 'IMPROVE', to: 'EXECUTE', pausedReason: null, divergent: false },
    });
  });

  it('sends a spent repair budget to PLAN (replan)', () => {
    const state = failingState({ counters: { buildFailures: 3, testFailures: 0 } });

    recordPhaseResult(state, { ...FAILED_VERIFY }, ON);

    const row = state.recoveryJournal[0];
    expect(row.action).toBe('replan');
    expect(row).toMatchObject({ divergent: false, appliedNext: 'PLAN' });
    expect(state.phase).toBe('VERIFY');
    expect(nextTarget(state)).toBe('PLAN');
    expect(findEvent(state.sessionId, 'recovery-applied').data.to).toBe('PLAN');
  });

  it('sends a repeat of the same class to PLAN even with the budget unspent', () => {
    // One prior implementation row makes this the second sighting, which is the
    // definition of "repeated" for the ladder (recovery-controller.js#REPEATED_AT).
    const state = failingState({ recoveryJournal: [{ class: 'implementation', action: 'repair' }] });

    recordPhaseResult(state, { ...FAILED_VERIFY }, ON);

    const row = state.recoveryJournal[1];
    expect(row.sameClassAttempts).toBe(2);
    expect(row.action).toBe('replan');
    expect(nextTarget(state)).toBe('PLAN');
  });

  it('pauses an UNMEASURED verification and resumes into VERIFY (ask_human)', () => {
    const state = makeState({ verifyResult: { status: 'UNMEASURED' } });

    recordPhaseResult(state, { phase: 'VERIFY', status: 'done' }, ON);

    const row = state.recoveryJournal[0];
    expect(row.class).toBe('unknown');
    expect(row.action).toBe('ask_human');
    expect(row).toMatchObject({ divergent: false, appliedNext: 'PAUSED' });
    expect(state.phase).toBe('PAUSED');
    expect(state.lastPhase).toBe('VERIFY');
    expect(state.pendingPhase).toBe('VERIFY');
    expect(state.pausedReason).toBe('recovery:ask_human');
    expect(nextTarget(state)).toBe('VERIFY');
    expect(findEvent(state.sessionId, 'recovery-applied').data).toMatchObject({
      action: 'ask_human', to: 'PAUSED', pausedReason: 'recovery:ask_human',
    });
  });

  it('pauses a human-value verdict rather than escalating it to pause', () => {
    // `escalateTo: 'pause'` is fixed in VERIFY_ON_FAILURE, but
    // recovery-controller.js#renderHumanRung refuses to convert a value decision
    // into a silent stop, so the action stays ask_human. Both land on PAUSED.
    const state = makeState({ verifyResult: { ok: false }, crossCheck: { verdict: 'REJECT' } });

    recordPhaseResult(state, { ...FAILED_VERIFY }, ON);

    const row = state.recoveryJournal[0];
    expect(row.class).toBe('human-value');
    expect(row.action).toBe('ask_human');
    expect(state.phase).toBe('PAUSED');
    expect(state.pausedReason).toBe('recovery:ask_human');
  });

  it('leaves every non-VERIFY phase alone', () => {
    const state = makeState({ phase: 'EXECUTE', verifyResult: { ok: false } });

    recordPhaseResult(state, { phase: 'EXECUTE', status: 'failed' }, ON);

    expect(state.recoveryJournal).toBeUndefined();
    expect(eventTypes(state.sessionId)).not.toContain('recovery-applied');
  });
});
