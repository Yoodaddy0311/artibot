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

const mocks = vi.hoisted(() => ({
  tick: vi.fn(),
  pluginRoot: null,
  notifyPause: vi.fn(),
  appendLesson: vi.fn(),
}));

vi.mock('../../lib/autopilot/_engine-helpers.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, tick: mocks.tick };
});

// Both are spread from the original: `_engine-helpers.js` imports `notifyPause`
// and friends from notification.js, so a bare stub would break the helper graph.
vi.mock('../../lib/autopilot/notification.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, notifyPause: mocks.notifyPause };
});

vi.mock('../../lib/autopilot/memory.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, appendLesson: mocks.appendLesson };
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

/** What the real `notification.js#notifyPause` returns on an un-suppressed session. */
function makeNote(overrides = {}) {
  return {
    tool: 'PushNotification',
    params: { title: 'Autopilot PAUSED', message: 'paused', sessionId: 'test-recovery-transition' },
    suppressed: false,
    queued: { type: 'pause', reason: 'recovery:ask_human' },
    ...overrides,
  };
}

beforeEach(() => {
  // mockReset, not mockClear: the throwing implementations installed by the
  // failure tests below would otherwise leak into whatever runs next.
  mocks.tick.mockReset();
  mocks.notifyPause.mockReset();
  mocks.notifyPause.mockReturnValue(makeNote());
  mocks.appendLesson.mockReset();
  mocks.appendLesson.mockReturnValue({ ok: true });
  mocks.pluginRoot = null;
});

/** The `pause` tick among all tick calls (the `recovery-applied` one is separate). */
function pauseTicks() {
  return mocks.tick.mock.calls.filter(([, event]) => event?.type === 'pause');
}

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
    expect(mocks.appendLesson).not.toHaveBeenCalled();
    expect(mocks.notifyPause).not.toHaveBeenCalled();
  });

  it('changes nothing when the row is absent, even with the gate ON', () => {
    const state = makeState(null);
    const stateBefore = JSON.stringify(state);

    const result = applyRecoveryTransition(state, null, ON);

    expect(result).toMatchObject({
      applied: false, next: null, from: null, pausedReason: null, notification: null,
    });
    expect(JSON.stringify(state)).toBe(stateBefore);
    expect(mocks.tick).not.toHaveBeenCalled();
    expect(mocks.appendLesson).not.toHaveBeenCalled();
    expect(mocks.notifyPause).not.toHaveBeenCalled();
  });
});

describe('applyRecoveryTransition — ON, phase-advancing actions', () => {
  it('routes repair to EXECUTE through pendingPhase, leaving phase untouched', () => {
    const row = makeRow({ action: 'repair' });
    const state = makeState(row);

    const result = applyRecoveryTransition(state, row, ON);

    expect(result).toEqual({
      applied: true, next: 'EXECUTE', from: 'IMPROVE', pausedReason: null, notification: null,
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

    // `notification` is whatever the (stubbed) notifier returned, passed through.
    expect(result).toEqual({
      applied: true, next: 'PAUSED', from: 'IMPROVE', pausedReason, notification: makeNote(),
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

  /**
   * A frozen row on a PAUSING action: the session moves (state is written
   * first), then stamping the row throws — ESM is strict, so assigning to a
   * frozen property is a TypeError — and the whole call degrades. The half-way
   * result is deliberate and fail-closed: the session stays PAUSED and the
   * journal row keeps its honest `divergent: true`, which is safer than a row
   * claiming `divergent: false` for a transition that did not complete.
   */
  it('degrades to applied:false on a frozen row, leaving the session paused', () => {
    const row = Object.freeze(makeRow({ action: 'ask_human' }));
    const state = makeState(row, { featureKey: 'feat' });

    let result;
    expect(() => { result = applyRecoveryTransition(state, row, ON); }).not.toThrow();

    expect(result.applied).toBe(false);
    expect(result.next).toBeNull();
    expect(result.pausedReason).toBeNull();
    expect(result.notification).toBeNull();
    expect(result.error).toContain('divergent');
    // The transition committed before the row stamp threw, so the session is
    // paused and the row is untouched.
    expect(state.phase).toBe('PAUSED');
    expect(state.lastPhase).toBe('VERIFY');
    expect(state.pausedReason).toBe('recovery:ask_human');
    expect(row.divergent).toBe(true);
    expect(row.appliedNext).toBeUndefined();
    // Nothing announced: both the recovery-applied and the pause tick come
    // after the row stamp, and the notifier after those.
    expect(mocks.tick).not.toHaveBeenCalled();
    expect(mocks.notifyPause).not.toHaveBeenCalled();
    // The lesson does survive an unapplied transition — it is written inside the
    // state move, and state really is PAUSED, so the archive matches reality.
    expect(mocks.appendLesson).toHaveBeenCalledTimes(1);
  });
});

/**
 * B1 — a PAUSED transition has to announce itself the same way
 * `engine.js#maybePause` does. Before this block the module moved four state
 * fields and emitted one `recovery-applied` tick, so a session could be paused
 * by a recovery verdict with nothing in the lesson archive, no `pause` event and
 * no notification: the operator learned about it only by reading state.
 */
describe('applyRecoveryTransition — PAUSED announces itself (lesson + pause tick + notify)', () => {
  const PAUSING = [
    ['propose_ultraplan', 'recovery:propose_ultraplan'],
    ['ask_human', 'recovery:ask_human'],
    ['pause', 'recovery:pause'],
    ['teleport', 'recovery:unknown-action'],
  ];

  it.each(PAUSING)('emits exactly one pause tick for %s', (action, pausedReason) => {
    const row = makeRow({ action });
    const state = makeState(row, { featureKey: 'feat' });

    applyRecoveryTransition(state, row, ON);

    const ticks = pauseTicks();
    expect(ticks).toHaveLength(1);
    expect(ticks[0][0]).toBe('test-recovery-transition');
    expect(ticks[0][1]).toEqual({
      phase: 'VERIFY',
      type: 'pause',
      level: 'warn',
      message: `Autopilot paused: ${pausedReason}`,
      data: { reason: pausedReason },
    });
  });

  it('labels the pause tick PAUSED when there is no lastPhase to name', () => {
    const row = makeRow({ action: 'pause' });
    const state = makeState(row, { phase: null, lastPhase: null, featureKey: 'feat' });

    applyRecoveryTransition(state, row, ON);

    expect(pauseTicks()[0][1].phase).toBe('PAUSED');
  });

  it.each(PAUSING)('appends exactly one lesson for %s', (action, pausedReason) => {
    const row = makeRow({ action });
    const state = makeState(row, { featureKey: 'feat-key' });

    applyRecoveryTransition(state, row, ON);

    expect(mocks.appendLesson).toHaveBeenCalledTimes(1);
    expect(mocks.appendLesson).toHaveBeenCalledWith('feat-key', {
      sessionId: 'test-recovery-transition',
      lesson: `Pause at VERIFY: ${pausedReason}`,
      errorPattern: pausedReason,
      sourcePhase: 'VERIFY',
    });
  });

  it('writes unknown into the lesson body when there is no lastPhase', () => {
    const row = makeRow({ action: 'pause' });
    const state = makeState(row, { phase: null, lastPhase: null, featureKey: 'feat' });

    applyRecoveryTransition(state, row, ON);

    expect(mocks.appendLesson.mock.calls[0][1]).toMatchObject({
      lesson: 'Pause at unknown: recovery:pause', sourcePhase: null,
    });
  });

  it('skips the lesson silently when the session has no featureKey', () => {
    const row = makeRow({ action: 'ask_human' });
    const state = makeState(row);

    const result = applyRecoveryTransition(state, row, ON);

    expect(mocks.appendLesson).not.toHaveBeenCalled();
    expect(result.applied).toBe(true);
    expect(state.phase).toBe('PAUSED');
  });

  it.each(PAUSING)('notifies exactly once for %s, with (sessionId, pausedReason)', (action, pausedReason) => {
    const row = makeRow({ action });
    const state = makeState(row, { featureKey: 'feat' });

    applyRecoveryTransition(state, row, ON);

    expect(mocks.notifyPause).toHaveBeenCalledTimes(1);
    expect(mocks.notifyPause).toHaveBeenCalledWith('test-recovery-transition', pausedReason);
  });

  it.each([
    ['repair', 'EXECUTE'],
    ['replan', 'PLAN'],
  ])('does none of the three for %s (advances to %s)', (action) => {
    const row = makeRow({ action });
    const state = makeState(row, { featureKey: 'feat' });

    const result = applyRecoveryTransition(state, row, ON);

    expect(pauseTicks()).toHaveLength(0);
    expect(mocks.appendLesson).not.toHaveBeenCalled();
    expect(mocks.notifyPause).not.toHaveBeenCalled();
    expect(result.notification).toBeNull();
  });

  it('runs state -> lesson -> recovery-applied -> pause -> notify, in that order', () => {
    const row = makeRow({ action: 'ask_human' });
    const state = makeState(row, { featureKey: 'feat' });
    let phaseWhenLessonRan = null;
    mocks.appendLesson.mockImplementation(() => {
      phaseWhenLessonRan = state.phase; // state transition must already be done
      return { ok: true };
    });

    applyRecoveryTransition(state, row, ON);

    expect(phaseWhenLessonRan).toBe('PAUSED');
    const lessonOrder = mocks.appendLesson.mock.invocationCallOrder[0];
    const appliedOrder = mocks.tick.mock.calls
      .map((call, i) => [call[1]?.type, mocks.tick.mock.invocationCallOrder[i]])
      .find(([type]) => type === 'recovery-applied')[1];
    const pauseOrder = mocks.tick.mock.calls
      .map((call, i) => [call[1]?.type, mocks.tick.mock.invocationCallOrder[i]])
      .find(([type]) => type === 'pause')[1];
    const notifyOrder = mocks.notifyPause.mock.invocationCallOrder[0];

    expect(lessonOrder).toBeLessThan(appliedOrder);
    expect(appliedOrder).toBeLessThan(pauseOrder);
    expect(pauseOrder).toBeLessThan(notifyOrder);
  });
});

describe('applyRecoveryTransition — the notification field on the return value', () => {
  it('returns the notifyPause result verbatim rather than re-deciding suppression', () => {
    const note = makeNote({ tool: null, suppressed: true, queued: { type: 'pause' } });
    mocks.notifyPause.mockReturnValue(note);
    const row = makeRow({ action: 'pause' });
    const state = makeState(row);

    const result = applyRecoveryTransition(state, row, ON);

    expect(result.notification).toBe(note);
    expect(result.notification.suppressed).toBe(true);
  });

  it.each([
    ['the gate is OFF', { transitionFromVerdict: false }],
    ['the config is absent', undefined],
  ])('is null when %s', (_label, cfg) => {
    const row = makeRow({ action: 'pause' });
    const state = makeState(row);

    expect(applyRecoveryTransition(state, row, cfg).notification).toBeNull();
  });

  it('is null when there is no row at all', () => {
    expect(applyRecoveryTransition(makeState(null), null, ON).notification).toBeNull();
  });

  it('is null on the degraded (hostile row) path', () => {
    const row = makeRow();
    Object.defineProperty(row, 'action', {
      get() { throw new Error('hostile accessor'); }, configurable: true,
    });

    const result = applyRecoveryTransition(makeState(row), row, ON);

    expect(result.applied).toBe(false);
    expect(result.notification).toBeNull();
  });
});

/**
 * A failed announcement is not a failed transition. The session IS paused —
 * reverting that because a notification helper threw would leave the engine
 * running on a verdict it already acted on.
 */
describe('applyRecoveryTransition — announcement failures never undo the pause', () => {
  function expectStillPaused(result, state, row) {
    expect(result.applied).toBe(true);
    expect(result.next).toBe('PAUSED');
    expect(result.pausedReason).toBe('recovery:pause');
    expect(state.phase).toBe('PAUSED');
    expect(state.lastPhase).toBe('VERIFY');
    expect(state.pendingPhase).toBe('VERIFY');
    expect(state.pausedReason).toBe('recovery:pause');
    expect(row).toMatchObject({
      divergent: false, appliedNext: 'PAUSED', appliedBy: 'recovery-transition',
    });
  }

  it('stays applied when appendLesson throws', () => {
    mocks.appendLesson.mockImplementation(() => { throw new Error('disk full'); });
    const row = makeRow({ action: 'pause' });
    const state = makeState(row, { featureKey: 'feat' });

    const result = applyRecoveryTransition(state, row, ON);

    expectStillPaused(result, state, row);
    expect(pauseTicks()).toHaveLength(1);
    expect(mocks.notifyPause).toHaveBeenCalledTimes(1);
  });

  it('stays applied when notifyPause throws, and reports notification null', () => {
    mocks.notifyPause.mockImplementation(() => { throw new Error('notify exploded'); });
    const row = makeRow({ action: 'pause' });
    const state = makeState(row, { featureKey: 'feat' });

    const result = applyRecoveryTransition(state, row, ON);

    expectStillPaused(result, state, row);
    expect(result.notification).toBeNull();
    expect(result.error).toBeUndefined();
  });

  it('stays applied when the pause tick throws', () => {
    mocks.tick.mockImplementation((_sid, event) => {
      if (event?.type === 'pause') throw new Error('telemetry down');
    });
    const row = makeRow({ action: 'pause' });
    const state = makeState(row, { featureKey: 'feat' });

    const result = applyRecoveryTransition(state, row, ON);

    expectStillPaused(result, state, row);
    expect(mocks.notifyPause).toHaveBeenCalledTimes(1);
  });
});
