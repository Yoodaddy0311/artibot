/**
 * Unit tests for how `applyRecoveryTransition` (lib/autopilot/recovery-transition.js, CA-03)
 * announces a PAUSED transition - lesson, `pause` tick, notification - and for the failures of
 * that announcement, which must never undo the pause.
 *
 * Split out of `recovery-transition.test.js` for the 800-line standard (V5-BACKLOG section 3);
 * the cases moved verbatim.
 * The mock block, the row / state builders and the hooks are repeated from that file on purpose
 * rather than shared, so the same isolation holds here: `tick`, the notifier, the lesson writer
 * and `getPluginRoot` are all stubbed and nothing is written outside the test.
 */

import {
  afterEach, beforeEach, describe, expect, it, vi,
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
  APPLY_STATUS,
  applyRecoveryTransition,
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
      divergent: false,
      appliedNext: 'PAUSED',
      appliedBy: 'recovery-transition',
      applyStatus: APPLY_STATUS.APPLIED,
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
