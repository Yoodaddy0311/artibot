/**
 * Unit tests for lib/autopilot/recovery-transition.js (CA-03).
 *
 * The module under test is the switch the Observe stage was built to enable:
 * `recovery-record.js` writes a recommendation and keeps the fixed
 * `VERIFY -> IMPROVE` transition; this module is what moves the phase instead.
 * Two properties therefore matter more than any individual mapping:
 *
 *  1. **Fail-closed.** The action table is an ALLOWLIST. Any action outside the
 *     five the controller can emit — absent, misspelled, wrong case, non-string
 *     — pauses. A denylist would fail OPEN the day a sixth rung is added.
 *  2. **OFF is byte-identical.** With the config gate off (today's default) the
 *     module must not touch state, must not touch the journal row, and must not
 *     emit telemetry. That is asserted on serialised snapshots plus a tick spy,
 *     not by eyeballing a few fields.
 *
 * Pure by construction: `tick` and `getPluginRoot` are mocked, so no session
 * artifacts are written and no session-store cleanup is needed.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  afterAll, afterEach, beforeEach, describe, expect, it, vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({ tick: vi.fn(), pluginRoot: null }));

vi.mock('../../lib/autopilot/_engine-helpers.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, tick: mocks.tick };
});

vi.mock('../../lib/core/platform.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getPluginRoot: () => (mocks.pluginRoot === null ? actual.getPluginRoot() : mocks.pluginRoot),
  };
});

const {
  TRANSITION_BY_ACTION,
  applyRecoveryTransition,
  loadRecoveryTransitionConfig,
  phaseForRecovery,
} = await import('../../lib/autopilot/recovery-transition.js');

const ON = Object.freeze({ transitionFromVerdict: true });

/** A journal row shaped like `recovery-record.js#recordRecoveryDecision` writes it. */
function makeRow(overrides = {}) {
  return {
    at: '2026-09-17T00:00:00.000Z',
    phase: 'VERIFY',
    status: 'failed',
    verdictRaw: 'fail',
    verdict: 'FAIL',
    verificationStatus: 'FAIL',
    class: 'implementation',
    classReason: 'test',
    action: 'repair',
    target: 'implementation',
    reason: 'test',
    repairAttempts: 0,
    sameClassAttempts: 1,
    retryLimit: 3,
    fixedNext: 'IMPROVE',
    divergent: true,
    recordedBy: 'recovery-record',
    ...overrides,
  };
}

/** A VERIFY-phase state with the row already inside its journal (identity matters). */
function makeState(row, overrides = {}) {
  const state = {
    sessionId: 'test-recovery-transition',
    phase: 'VERIFY',
    lastPhase: null,
    pendingPhase: null,
    pausedReason: null,
    recoveryJournal: [],
    ...overrides,
  };
  if (row) state.recoveryJournal.push(row);
  return state;
}

const tmpDirs = [];
function tmpRootWith(contents) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'recovery-transition-'));
  tmpDirs.push(dir);
  if (contents !== null) writeFileSync(path.join(dir, 'artibot.config.json'), contents, 'utf8');
  return dir;
}

beforeEach(() => {
  mocks.tick.mockClear();
  mocks.pluginRoot = null;
});

afterEach(() => {
  mocks.pluginRoot = null;
});

afterAll(() => {
  while (tmpDirs.length) {
    try { rmSync(tmpDirs.pop(), { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

describe('TRANSITION_BY_ACTION — the allowlist itself', () => {
  it('covers exactly the five actions the recovery controller can emit', () => {
    expect(Object.keys(TRANSITION_BY_ACTION).sort())
      .toEqual(['ask_human', 'pause', 'propose_ultraplan', 'repair', 'replan']);
  });

  it('is frozen so a caller cannot widen the allowlist at runtime', () => {
    expect(Object.isFrozen(TRANSITION_BY_ACTION)).toBe(true);
  });
});

describe('phaseForRecovery — known actions', () => {
  it.each([
    ['repair', 'EXECUTE', null],
    ['replan', 'PLAN', null],
    ['propose_ultraplan', 'PAUSED', 'recovery:propose_ultraplan'],
    ['ask_human', 'PAUSED', 'recovery:ask_human'],
    ['pause', 'PAUSED', 'recovery:pause'],
  ])('maps %s to %s', (action, next, pausedReason) => {
    const result = phaseForRecovery(makeRow({ action }));
    expect(result.next).toBe(next);
    expect(result.pausedReason).toBe(pausedReason);
    expect(typeof result.reason).toBe('string');
    expect(result.reason.length).toBeGreaterThan(0);
  });
});

describe('phaseForRecovery — fail-closed on anything outside the allowlist', () => {
  it('pauses for a row with no action key at all', () => {
    const row = makeRow();
    delete row.action;
    expect(phaseForRecovery(row)).toMatchObject({
      next: 'PAUSED', pausedReason: 'recovery:unknown-action',
    });
  });

  it.each([
    ['undefined action', { action: undefined }],
    ['null action', { action: null }],
    ['a phase name, not an action', { action: 'IMPROVE' }],
    ['right word, wrong case', { action: 'REPAIR' }],
    ['a number', { action: 42 }],
    ['an object', { action: {} }],
    ['a prototype key', { action: 'constructor' }],
    ['empty string', { action: '' }],
  ])('pauses for %s', (_label, overrides) => {
    const result = phaseForRecovery(makeRow(overrides));
    expect(result.next).toBe('PAUSED');
    expect(result.pausedReason).toBe('recovery:unknown-action');
  });

  it('pauses for an absent row rather than throwing', () => {
    expect(phaseForRecovery(undefined)).toMatchObject({
      next: 'PAUSED', pausedReason: 'recovery:unknown-action',
    });
    expect(phaseForRecovery(null)).toMatchObject({ next: 'PAUSED' });
  });
});

describe('phaseForRecovery — purity', () => {
  it('does not mutate the row it reads', () => {
    const row = makeRow();
    const before = JSON.stringify(row);
    phaseForRecovery(row);
    expect(JSON.stringify(row)).toBe(before);
  });

  it('returns the same answer for the same input', () => {
    const row = makeRow({ action: 'ask_human' });
    expect(phaseForRecovery(row)).toEqual(phaseForRecovery(row));
  });
});

describe('loadRecoveryTransitionConfig', () => {
  it('reads the shipped config and reports the gate OFF (today default)', () => {
    expect(loadRecoveryTransitionConfig()).toEqual({ transitionFromVerdict: false });
  });

  it('returns false when the config file does not exist', () => {
    mocks.pluginRoot = path.join(os.tmpdir(), 'recovery-transition-nonexistent-dir');
    expect(loadRecoveryTransitionConfig()).toEqual({ transitionFromVerdict: false });
  });

  it('returns false for broken JSON instead of throwing', () => {
    mocks.pluginRoot = tmpRootWith('{ not json');
    expect(loadRecoveryTransitionConfig()).toEqual({ transitionFromVerdict: false });
  });

  it.each([
    ['the string "true"', '"true"'],
    ['the number 1', '1'],
    ['null', 'null'],
    ['an object', '{}'],
  ])('returns false when the flag is %s, not a boolean', (_label, literal) => {
    mocks.pluginRoot = tmpRootWith(
      `{"autopilot":{"recovery":{"transitionFromVerdict":${literal}}}}`,
    );
    expect(loadRecoveryTransitionConfig()).toEqual({ transitionFromVerdict: false });
  });

  it('returns false when the autopilot/recovery branch is missing entirely', () => {
    mocks.pluginRoot = tmpRootWith('{"team":{"enabled":true}}');
    expect(loadRecoveryTransitionConfig()).toEqual({ transitionFromVerdict: false });
  });

  it('returns true only for a real boolean true', () => {
    mocks.pluginRoot = tmpRootWith('{"autopilot":{"recovery":{"transitionFromVerdict":true}}}');
    expect(loadRecoveryTransitionConfig()).toEqual({ transitionFromVerdict: true });
  });
});

describe('applyRecoveryTransition — OFF gate is a no-op', () => {
  it.each([
    ['flag false', { transitionFromVerdict: false }],
    ['empty config', {}],
    ['absent config', undefined],
    ['null config', null],
    ['the string "true"', { transitionFromVerdict: 'true' }],
    ['the number 1', { transitionFromVerdict: 1 }],
  ])('changes nothing with %s', (_label, cfg) => {
    const row = makeRow();
    const state = makeState(row);
    const stateBefore = JSON.stringify(state);
    const rowBefore = JSON.stringify(row);

    const result = applyRecoveryTransition(state, row, cfg);

    expect(result.applied).toBe(false);
    expect(result.next).toBeNull();
    expect(result.from).toBe('IMPROVE');
    expect(result.pausedReason).toBeNull();
    expect(JSON.stringify(state)).toBe(stateBefore);
    expect(JSON.stringify(row)).toBe(rowBefore);
    expect(mocks.tick).not.toHaveBeenCalled();
  });

  it('changes nothing when the row is absent, even with the gate ON', () => {
    const state = makeState(null);
    const stateBefore = JSON.stringify(state);

    const result = applyRecoveryTransition(state, null, ON);

    expect(result).toMatchObject({ applied: false, next: null, from: null, pausedReason: null });
    expect(JSON.stringify(state)).toBe(stateBefore);
    expect(mocks.tick).not.toHaveBeenCalled();
  });
});

describe('applyRecoveryTransition — ON, phase-advancing actions', () => {
  it('routes repair to EXECUTE through pendingPhase, leaving phase untouched', () => {
    const row = makeRow({ action: 'repair' });
    const state = makeState(row);

    const result = applyRecoveryTransition(state, row, ON);

    expect(result).toEqual({
      applied: true, next: 'EXECUTE', from: 'IMPROVE', pausedReason: null,
    });
    expect(state.pendingPhase).toBe('EXECUTE');
    expect(state.phase).toBe('VERIFY');
    expect(state.pausedReason).toBeNull();
    expect(row.divergent).toBe(false);
    expect(row.appliedNext).toBe('EXECUTE');
    expect(row.appliedBy).toBe('recovery-transition');
  });

  it('routes replan to PLAN', () => {
    const row = makeRow({ action: 'replan', fixedNext: 'IMPROVE' });
    const state = makeState(row);

    expect(applyRecoveryTransition(state, row, ON).next).toBe('PLAN');
    expect(state.pendingPhase).toBe('PLAN');
    expect(state.phase).toBe('VERIFY');
  });

  it('emits one recovery-applied event carrying the before/after pair', () => {
    const row = makeRow({ action: 'repair' });
    const state = makeState(row);

    applyRecoveryTransition(state, row, ON);

    expect(mocks.tick).toHaveBeenCalledTimes(1);
    const [sessionId, event] = mocks.tick.mock.calls[0];
    expect(sessionId).toBe('test-recovery-transition');
    expect(event).toMatchObject({
      phase: 'VERIFY',
      type: 'recovery-applied',
      level: 'info',
      data: {
        action: 'repair', from: 'IMPROVE', to: 'EXECUTE', pausedReason: null, divergent: false,
      },
    });
    expect(event.message).toContain('repair');
    expect(event.message).toContain('EXECUTE');
  });

  it('renders n/a in the event when the row has no fixedNext', () => {
    const row = makeRow({ action: 'repair', fixedNext: null });
    const state = makeState(row);

    const result = applyRecoveryTransition(state, row, ON);

    expect(result.from).toBeNull();
    expect(mocks.tick.mock.calls[0][1].message).toContain('n/a');
    expect(mocks.tick.mock.calls[0][1].data.from).toBeNull();
  });
});

describe('applyRecoveryTransition — ON, pausing actions', () => {
  it.each([
    ['propose_ultraplan', 'recovery:propose_ultraplan'],
    ['ask_human', 'recovery:ask_human'],
    ['pause', 'recovery:pause'],
  ])('pauses for %s and parks the resume target at VERIFY', (action, pausedReason) => {
    const row = makeRow({ action });
    const state = makeState(row);

    const result = applyRecoveryTransition(state, row, ON);

    expect(result).toEqual({
      applied: true, next: 'PAUSED', from: 'IMPROVE', pausedReason,
    });
    expect(state.phase).toBe('PAUSED');
    expect(state.lastPhase).toBe('VERIFY');
    expect(state.pendingPhase).toBe('VERIFY');
    expect(state.pausedReason).toBe(pausedReason);
    expect(row.divergent).toBe(false);
    expect(row.appliedNext).toBe('PAUSED');
  });

  it('does not overwrite lastPhase when the state is already PAUSED', () => {
    const row = makeRow({ action: 'ask_human' });
    const state = makeState(row, { phase: 'PAUSED', lastPhase: 'VERIFY' });

    applyRecoveryTransition(state, row, ON);

    expect(state.lastPhase).toBe('VERIFY');
    expect(state.pendingPhase).toBe('VERIFY');
  });

  it('pauses for an unknown action', () => {
    const row = makeRow({ action: 'teleport' });
    const state = makeState(row);

    const result = applyRecoveryTransition(state, row, ON);

    expect(result).toMatchObject({
      applied: true, next: 'PAUSED', pausedReason: 'recovery:unknown-action',
    });
    expect(state.phase).toBe('PAUSED');
    expect(mocks.tick.mock.calls[0][1].data.action).toBe('teleport');
  });
});

describe('applyRecoveryTransition — journal identity', () => {
  it('writes through to the row stored in state.recoveryJournal', () => {
    const row = makeRow({ action: 'repair' });
    const state = makeState(row);
    expect(row).toBe(state.recoveryJournal[0]);

    applyRecoveryTransition(state, state.recoveryJournal[0], ON);

    expect(state.recoveryJournal[0].divergent).toBe(false);
    expect(state.recoveryJournal[0].appliedNext).toBe('EXECUTE');
    expect(state.recoveryJournal).toHaveLength(1);
  });
});

describe('applyRecoveryTransition — never throws into the caller', () => {
  it('degrades when reading the action throws', () => {
    const row = makeRow();
    Object.defineProperty(row, 'action', {
      get() { throw new Error('hostile accessor'); },
      configurable: true,
    });
    const state = makeState(row);
    const phaseBefore = state.phase;

    const result = applyRecoveryTransition(state, row, ON);

    expect(result.applied).toBe(false);
    expect(state.phase).toBe(phaseBefore);
    expect(state.pendingPhase).toBeNull();
    expect(state.pausedReason).toBeNull();
    expect(result.error).toContain('hostile accessor');
  });

  it('degrades when the state is frozen', () => {
    const row = makeRow({ action: 'repair' });
    const state = Object.freeze(makeState(row));

    expect(() => applyRecoveryTransition(state, row, ON)).not.toThrow();
  });
});
