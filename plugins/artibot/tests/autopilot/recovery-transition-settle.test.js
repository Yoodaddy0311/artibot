/**
 * Unit tests for `settleRecoveryTransitions` (lib/autopilot/recovery-transition.js, CA-03 / AP-N4):
 * how a `routed` journal row becomes `applied`, `blocked-before-dispatch` or `superseded`, and
 * which rows and inputs the pass must leave alone.
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
  settleRecoveryTransitions,
} = await import('../../lib/autopilot/recovery-transition.js');

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

afterEach(() => {
  mocks.pluginRoot = null;
});

/**
 * AP-N4 — the settlement pass. `engine-state.js` runs it at every phase entry and
 * every phase result; it is what turns a `routed` row into `applied` (or says why
 * it did not). Evidence of a hand-out is a `state.phases` record with status
 * `queued`: the PLAN / EXECUTE / CROSS_CHECK / VERIFY / IMPROVE runners write
 * exactly that AFTER their dispatch gate passes (INTAKE and REPORT write `done`).
 */
describe('settleRecoveryTransitions — a route becomes applied only after the hand-out', () => {
  /** A row exactly as `applyRecoveryTransition` leaves a route. */
  const routedRow = (overrides = {}) => makeRow({
    action: 'replan',
    applyStatus: APPLY_STATUS.ROUTED,
    routedNext: 'PLAN',
    phasesAtRoute: 2,
    ...overrides,
  });

  /** A state that has recorded two phase records (…, VERIFY result) at the route. */
  const stateAfterRoute = (row, overrides = {}) => makeState(row, {
    phases: [{ name: 'PLAN', status: 'queued' }, { name: 'VERIFY', status: 'failed' }],
    pendingPhase: 'PLAN',
    ...overrides,
  });

  const handOut = (state, name) => state.phases.push({ name, status: 'queued' });
  const ticksOf = (type) => mocks.tick.mock.calls.filter(([, e]) => e?.type === type);

  it('applies the row once the routed phase is handed out', () => {
    const row = routedRow();
    const state = stateAfterRoute(row);
    handOut(state, 'PLAN');

    const settled = settleRecoveryTransitions(state);

    expect(settled).toBe(1);
    expect(row).toMatchObject({
      applyStatus: APPLY_STATUS.APPLIED,
      appliedNext: 'PLAN',
      appliedBy: 'recovery-transition',
      divergent: false,
    });
  });

  it('emits one recovery-applied event when it applies, and none on a second pass', () => {
    const row = routedRow();
    const state = stateAfterRoute(row);
    handOut(state, 'PLAN');

    settleRecoveryTransitions(state);
    const again = settleRecoveryTransitions(state);

    expect(again).toBe(0);
    const applied = ticksOf('recovery-applied');
    expect(applied).toHaveLength(1);
    expect(applied[0][0]).toBe('test-recovery-transition');
    expect(applied[0][1]).toMatchObject({
      phase: 'VERIFY',
      level: 'info',
      data: {
        action: 'replan', from: 'IMPROVE', to: 'PLAN', pausedReason: null, divergent: false,
      },
    });
  });

  it('keeps the row routed while nothing has been handed out', () => {
    const row = routedRow();
    const state = stateAfterRoute(row);

    expect(settleRecoveryTransitions(state)).toBe(0);

    expect(row.applyStatus).toBe(APPLY_STATUS.ROUTED);
    expect(row.divergent).toBe(true);
    expect(row.appliedNext).toBeUndefined();
    expect(mocks.tick).not.toHaveBeenCalled();
  });

  it('ignores a queued record written BEFORE the route (an earlier hand-out is not this one)', () => {
    const row = routedRow({ phasesAtRoute: 2 });
    // index 0 is a queued PLAN, but it predates the route (phasesAtRoute = 2).
    const state = stateAfterRoute(row);

    settleRecoveryTransitions(state);

    expect(row.applyStatus).toBe(APPLY_STATUS.ROUTED);
    expect(row.appliedNext).toBeUndefined();
  });

  it('ignores records that are not hand-outs, such as the driver reporting the phase done', () => {
    const row = routedRow();
    const state = stateAfterRoute(row);
    state.phases.push({ name: 'PLAN', status: 'done' }, { name: 'PLAN', status: 'failed' });

    settleRecoveryTransitions(state);

    expect(row.applyStatus).toBe(APPLY_STATUS.ROUTED);
    expect(row.appliedNext).toBeUndefined();
  });

  it('supersedes the row when a DIFFERENT phase was handed out first, for good', () => {
    const row = routedRow();
    const state = stateAfterRoute(row);
    handOut(state, 'EXECUTE');

    settleRecoveryTransitions(state);
    expect(row.applyStatus).toBe(APPLY_STATUS.SUPERSEDED);

    // A later PLAN hand-out belongs to whatever routed it, not to this row.
    handOut(state, 'PLAN');
    settleRecoveryTransitions(state);

    expect(row.applyStatus).toBe(APPLY_STATUS.SUPERSEDED);
    expect(row.appliedNext).toBeUndefined();
    expect(row.divergent).toBe(true);
    expect(ticksOf('recovery-applied')).toHaveLength(0);
  });

  it('only the FIRST hand-out after the route decides', () => {
    const row = routedRow();
    const state = stateAfterRoute(row);
    handOut(state, 'PLAN');
    handOut(state, 'EXECUTE');

    settleRecoveryTransitions(state);

    expect(row.applyStatus).toBe(APPLY_STATUS.APPLIED);
    expect(row.appliedNext).toBe('PLAN');
  });

  it('applies a repair route when EXECUTE is handed out', () => {
    const row = routedRow({ action: 'repair', routedNext: 'EXECUTE' });
    const state = stateAfterRoute(row, { pendingPhase: 'EXECUTE' });
    handOut(state, 'EXECUTE');

    settleRecoveryTransitions(state);

    expect(row).toMatchObject({ applyStatus: APPLY_STATUS.APPLIED, appliedNext: 'EXECUTE', divergent: false });
  });
});

describe('settleRecoveryTransitions — blocked before dispatch is its own status (AP-N4)', () => {
  const routedRow = (overrides = {}) => makeRow({
    action: 'replan', applyStatus: APPLY_STATUS.ROUTED, routedNext: 'PLAN', phasesAtRoute: 1, ...overrides,
  });
  /** What `engine.js#maybePause` leaves behind when the dispatch gate refuses PLAN. */
  const pausedAtPlan = (row, overrides = {}) => makeState(row, {
    phase: 'PAUSED',
    lastPhase: 'PLAN',
    pendingPhase: 'PLAN',
    pausedReason: 'budget-exceeded',
    phases: [{ name: 'VERIFY', status: 'failed' }],
    ...overrides,
  });
  const ticksOf = (type) => mocks.tick.mock.calls.filter(([, e]) => e?.type === type);

  it('marks the row blocked-before-dispatch, and still not applied', () => {
    const row = routedRow();
    const state = pausedAtPlan(row);

    expect(settleRecoveryTransitions(state)).toBe(1);

    expect(row.applyStatus).toBe(APPLY_STATUS.BLOCKED);
    expect(row.appliedNext).toBeUndefined();
    expect(row.appliedBy).toBeUndefined();
    expect(row.divergent).toBe(true);
  });

  it('says why in one warn event, and does not repeat it on a second pass', () => {
    const row = routedRow();
    const state = pausedAtPlan(row);

    settleRecoveryTransitions(state);
    expect(settleRecoveryTransitions(state)).toBe(0);

    const blocked = ticksOf('recovery-blocked');
    expect(blocked).toHaveLength(1);
    expect(blocked[0][1]).toMatchObject({
      phase: 'VERIFY',
      level: 'warn',
      data: { action: 'replan', to: 'PLAN', reason: 'budget-exceeded' },
    });
  });

  it('is not blocked when the session is paused at a DIFFERENT phase', () => {
    const row = routedRow();
    const state = pausedAtPlan(row, { lastPhase: 'VERIFY', pendingPhase: 'VERIFY' });

    expect(settleRecoveryTransitions(state)).toBe(0);

    expect(row.applyStatus).toBe(APPLY_STATUS.ROUTED);
  });

  it('is not blocked when the session is not paused at all', () => {
    const row = routedRow();
    const state = pausedAtPlan(row, { phase: 'PLAN', lastPhase: null, pendingPhase: null });

    expect(settleRecoveryTransitions(state)).toBe(0);

    expect(row.applyStatus).toBe(APPLY_STATUS.ROUTED);
  });

  it('becomes applied when the retry is handed out after the pause lifts', () => {
    const row = routedRow();
    const state = pausedAtPlan(row);
    settleRecoveryTransitions(state);
    expect(row.applyStatus).toBe(APPLY_STATUS.BLOCKED);

    state.phase = 'PLAN';
    state.pendingPhase = null;
    state.phases.push({ name: 'PLAN', status: 'queued' });
    settleRecoveryTransitions(state);

    expect(row).toMatchObject({ applyStatus: APPLY_STATUS.APPLIED, appliedNext: 'PLAN', divergent: false });
    expect(ticksOf('recovery-applied')).toHaveLength(1);
  });

  it('prefers the hand-out over the paused reading: a later pause does not un-apply', () => {
    // PLAN went out, THEN something else paused the session at PLAN (a secret
    // leak freezes on the current phase). The hand-out already happened.
    const row = routedRow();
    const state = pausedAtPlan(row);
    state.phases.push({ name: 'PLAN', status: 'queued' });

    settleRecoveryTransitions(state);

    expect(row.applyStatus).toBe(APPLY_STATUS.APPLIED);
    expect(ticksOf('recovery-blocked')).toHaveLength(0);
  });

  it('is superseded, not applied, when another phase goes out after a block', () => {
    const row = routedRow();
    const state = pausedAtPlan(row);
    settleRecoveryTransitions(state);

    state.phase = 'EXECUTE';
    state.phases.push({ name: 'EXECUTE', status: 'queued' });
    settleRecoveryTransitions(state);

    expect(row.applyStatus).toBe(APPLY_STATUS.SUPERSEDED);
    expect(row.appliedNext).toBeUndefined();
  });
});

describe('settleRecoveryTransitions — rows it must not touch, and inputs it must survive', () => {
  const ticksOf = (type) => mocks.tick.mock.calls.filter(([, e]) => e?.type === type);

  it('leaves observe rows, legacy applied rows, applied, superseded and unknown statuses alone', () => {
    const rows = [
      makeRow({ action: 'replan' }),
      makeRow({ action: 'replan', appliedNext: 'PLAN', appliedBy: 'recovery-transition', divergent: false }),
      makeRow({ action: 'replan', applyStatus: APPLY_STATUS.APPLIED, appliedNext: 'PLAN', divergent: false }),
      makeRow({ action: 'replan', applyStatus: APPLY_STATUS.SUPERSEDED, routedNext: 'PLAN', phasesAtRoute: 0 }),
      makeRow({ action: 'replan', applyStatus: 'ROUTED', routedNext: 'PLAN', phasesAtRoute: 0 }),
      makeRow({ action: 'replan', applyStatus: 'whatever', routedNext: 'PLAN', phasesAtRoute: 0 }),
    ];
    const state = makeState(null, {
      recoveryJournal: rows,
      phases: [{ name: 'PLAN', status: 'queued' }],
      phase: 'PAUSED',
      lastPhase: 'PLAN',
    });
    const before = JSON.stringify(rows);

    expect(settleRecoveryTransitions(state)).toBe(0);

    expect(JSON.stringify(rows)).toBe(before);
    expect(mocks.tick).not.toHaveBeenCalled();
  });

  it.each([
    ['routedNext missing', { routedNext: undefined }],
    ['routedNext not a string', { routedNext: 3 }],
    ['phasesAtRoute missing', { phasesAtRoute: undefined }],
    ['phasesAtRoute negative', { phasesAtRoute: -1 }],
    ['phasesAtRoute fractional', { phasesAtRoute: 0.5 }],
    ['phasesAtRoute a numeric string', { phasesAtRoute: '0' }],
  ])('leaves a routed row alone when %s', (_label, overrides) => {
    const row = makeRow({
      action: 'replan', applyStatus: APPLY_STATUS.ROUTED, routedNext: 'PLAN', phasesAtRoute: 0, ...overrides,
    });
    const state = makeState(row, { phases: [{ name: 'PLAN', status: 'queued' }] });

    expect(settleRecoveryTransitions(state)).toBe(0);

    expect(row.applyStatus).toBe(APPLY_STATUS.ROUTED);
    expect(row.appliedNext).toBeUndefined();
  });

  it.each([
    ['no state', undefined],
    ['a null state', null],
    ['a state without a journal', {}],
    ['a journal that is not an array', { recoveryJournal: { 0: { applyStatus: 'routed' } } }],
    ['a journal of junk', { recoveryJournal: [null, undefined, 7, 'x', [], () => 1] }],
  ])('returns 0 and throws nothing for %s', (_label, state) => {
    expect(() => settleRecoveryTransitions(state)).not.toThrow();
    expect(settleRecoveryTransitions(state)).toBe(0);
  });

  it('treats a state whose phases is not an array as "nothing handed out"', () => {
    const row = makeRow({
      action: 'replan', applyStatus: APPLY_STATUS.ROUTED, routedNext: 'PLAN', phasesAtRoute: 0,
    });
    const state = makeState(row, { phases: 'oops' });

    expect(() => settleRecoveryTransitions(state)).not.toThrow();
    expect(row.applyStatus).toBe(APPLY_STATUS.ROUTED);
  });

  it('skips junk phase records instead of throwing on them', () => {
    const row = makeRow({
      action: 'replan', applyStatus: APPLY_STATUS.ROUTED, routedNext: 'PLAN', phasesAtRoute: 0,
    });
    const state = makeState(row, { phases: [null, 7, 'PLAN', [], { status: 'queued' }, { name: 'PLAN', status: 'queued' }] });

    settleRecoveryTransitions(state);

    expect(row.applyStatus).toBe(APPLY_STATUS.APPLIED);
  });

  it('one hostile row does not stop the rows after it', () => {
    const hostile = makeRow({
      action: 'replan', applyStatus: APPLY_STATUS.ROUTED, routedNext: 'PLAN', phasesAtRoute: 0,
    });
    Object.defineProperty(hostile, 'phasesAtRoute', { get() { throw new Error('hostile accessor'); } });
    const healthy = makeRow({
      action: 'replan', applyStatus: APPLY_STATUS.ROUTED, routedNext: 'PLAN', phasesAtRoute: 0,
    });
    const state = makeState(hostile, { phases: [{ name: 'PLAN', status: 'queued' }] });
    state.recoveryJournal.push(healthy);

    expect(() => settleRecoveryTransitions(state)).not.toThrow();

    expect(healthy.applyStatus).toBe(APPLY_STATUS.APPLIED);
  });

  it('a frozen routed row cannot be stamped: no claim, no event, no throw', () => {
    const row = Object.freeze(makeRow({
      action: 'replan', applyStatus: APPLY_STATUS.ROUTED, routedNext: 'PLAN', phasesAtRoute: 0,
    }));
    const state = makeState(row, { phases: [{ name: 'PLAN', status: 'queued' }] });

    expect(() => settleRecoveryTransitions(state)).not.toThrow();

    expect(row.applyStatus).toBe(APPLY_STATUS.ROUTED);
    expect(row.appliedNext).toBeUndefined();
    expect(ticksOf('recovery-applied')).toHaveLength(0);
  });

  it('a telemetry failure never undoes the stamp', () => {
    mocks.tick.mockImplementation(() => { throw new Error('telemetry down'); });
    const row = makeRow({
      action: 'replan', applyStatus: APPLY_STATUS.ROUTED, routedNext: 'PLAN', phasesAtRoute: 0,
    });
    const state = makeState(row, { phases: [{ name: 'PLAN', status: 'queued' }] });

    expect(() => settleRecoveryTransitions(state)).not.toThrow();

    expect(row).toMatchObject({ applyStatus: APPLY_STATUS.APPLIED, appliedNext: 'PLAN', divergent: false });
  });

  it('does not mutate the state outside the journal', () => {
    const row = makeRow({
      action: 'replan', applyStatus: APPLY_STATUS.ROUTED, routedNext: 'PLAN', phasesAtRoute: 0,
    });
    const state = makeState(row, {
      phase: 'PAUSED', lastPhase: 'PLAN', pendingPhase: 'PLAN', pausedReason: 'budget-exceeded', phases: [],
    });
    // The journal is where the pass is allowed to write; everything else is not.
    const outsideJournal = (s) => JSON.stringify({ ...s, recoveryJournal: undefined });
    const before = outsideJournal(state);

    settleRecoveryTransitions(state);

    expect(outsideJournal(state)).toBe(before);
  });
});
