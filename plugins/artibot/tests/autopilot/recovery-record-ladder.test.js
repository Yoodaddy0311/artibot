/**
 * Wave 13 — the recovery ladder must be able to reach its ceiling.
 *
 * `recovery-record.js#judge` used to hand `decide()` a literal
 * `replanAttempts: 0` and never passed `ultraplanProposed`, so rungs 2 and 3 of
 * the §35 ladder were unreachable: with the CA-03 gate ON a repeated same-class
 * VERIFY failure re-entered PLAN forever (measured 2026-09-17: six consecutive
 * failed VERIFYs = 1 repair + 5 replan, 0 propose_ultraplan). `ladderFromJournal`
 * derives both values from the journal's APPLIED rows, and the six-tick case
 * below is the regression pin for that measurement.
 *
 * Why applied rows and not `action`: a row records what was RECOMMENDED. Only a
 * row the transition actually applied (`appliedNext === 'PLAN'`) means a replan
 * was spent. With the gate OFF no row carries `appliedNext` at all, so the
 * derived pair is always `0 / false` and the recorded decision is what it was
 * before this change — pinned by the OFF-determinism case at the end.
 *
 * ISOLATION. Unique session id per test, `deleteSessionArtifacts` in afterEach,
 * same contract as `tests/autopilot/recovery-record.test.js`.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { recordPhaseResult } from '../../lib/autopilot/engine-state.js';
import { ladderFromJournal, recordRecoveryDecision } from '../../lib/autopilot/recovery-record.js';
import { deleteSessionArtifacts } from '../../lib/autopilot/session-store.js';
import { readEvents } from '../../lib/autopilot/telemetry.js';

const tracked = [];

function trackSession(label) {
  const id = `ap-test-recovery-ladder-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  tracked.push(id);
  return id;
}

afterEach(() => {
  while (tracked.length) {
    try {
      deleteSessionArtifacts(tracked.pop());
    } catch {
      /* cleanup is best-effort */
    }
  }
});

/** A state whose VERIFY failed with a reviewer `fail` token -> class implementation. */
function failingState(label, overrides = {}) {
  return {
    sessionId: trackSession(label),
    phase: 'VERIFY',
    pendingPhase: null,
    phases: [],
    verifyResult: { ok: false },
    crossCheck: { verdict: 'fail' },
    counters: { buildFailures: 0, testFailures: 0 },
    ...overrides,
  };
}

const FAILED_VERIFY = Object.freeze({ phase: 'VERIFY', status: 'failed' });
const ON = Object.freeze({ transitionFromVerdict: true });
const OFF = Object.freeze({ transitionFromVerdict: false });

/** An applied row, as `recovery-transition.js#applyRecoveryTransition` leaves it. */
function applied(action, appliedNext) {
  return {
    class: 'implementation', action, appliedNext, appliedBy: 'recovery-transition', divergent: false,
  };
}

/** An Observe-stage row: a recommendation that was never applied. */
function observed(action) {
  return { class: 'implementation', action, divergent: true };
}

function eventTypes(sessionId) {
  return readEvents(sessionId).map((e) => e.type);
}

function countEvents(sessionId, type) {
  return eventTypes(sessionId).filter((t) => t === type).length;
}

describe('ladderFromJournal — replanAttempts counts applied PLAN rows only', () => {
  it.each([
    ['no journal rows', [], 0],
    ['one applied PLAN row', [applied('replan', 'PLAN')], 1],
    ['two applied PLAN rows', [applied('repair', 'EXECUTE'), applied('replan', 'PLAN'), applied('replan', 'PLAN')], 2],
  ])('counts the replans spent in $0', (_label, journal, expected) => {
    expect(ladderFromJournal(journal).replanAttempts).toBe(expected);
  });

  it('returns a frozen zero ladder for a non-array journal', () => {
    for (const input of [undefined, null, 'rows', 42, { length: 3 }]) {
      const ladder = ladderFromJournal(input);
      expect(ladder).toEqual({ replanAttempts: 0, ultraplanProposed: false });
      expect(Object.isFrozen(ladder)).toBe(true);
    }
  });

  it('climbs repair -> replan -> propose_ultraplan as applied PLAN rows accumulate', () => {
    const rung = (journal) => recordRecoveryDecision(failingState('climb', { recoveryJournal: journal }), {
      ...FAILED_VERIFY, fixedNext: 'IMPROVE',
    }).action;

    expect(rung([])).toBe('repair');
    expect(rung([applied('repair', 'EXECUTE')])).toBe('replan');
    expect(rung([applied('repair', 'EXECUTE'), applied('replan', 'PLAN')])).toBe('replan');
    expect(rung([applied('repair', 'EXECUTE'), applied('replan', 'PLAN'), applied('replan', 'PLAN')]))
      .toBe('propose_ultraplan');
  });
});

describe('ladderFromJournal — an unapplied recommendation is not a spent replan', () => {
  it('counts zero replans for Observe rows that recommended replan', () => {
    const journal = [observed('repair'), observed('replan'), observed('replan'), observed('replan')];

    expect(ladderFromJournal(journal)).toEqual({ replanAttempts: 0, ultraplanProposed: false });
  });

  it('still recommends replan after three unapplied replan rows, exactly as before', () => {
    const state = failingState('observe-rows', {
      recoveryJournal: [observed('repair'), observed('replan'), observed('replan'), observed('replan')],
    });

    const row = recordRecoveryDecision(state, { ...FAILED_VERIFY, fixedNext: 'IMPROVE' });

    expect(row.class).toBe('implementation');
    expect(row.sameClassAttempts).toBe(5);
    expect(row.action).toBe('replan');
    expect(row.replanAttempts).toBe(0);
    expect(row.ultraplanProposed).toBe(false);
  });
});

describe('ladderFromJournal — ultraplanProposed needs an applied PAUSED row', () => {
  /** Two spent replans, so the next judgement sits on the ultraplan rung. */
  const AT_ULTRAPLAN_RUNG = [
    applied('repair', 'EXECUTE'), applied('replan', 'PLAN'), applied('replan', 'PLAN'),
  ];

  it.each([
    ['appliedNext is absent (Observe row)', { class: 'implementation', action: 'propose_ultraplan' }, false],
    ['appliedNext is PLAN, not PAUSED', applied('propose_ultraplan', 'PLAN'), false],
    ['appliedNext is PAUSED', applied('propose_ultraplan', 'PAUSED'), true],
  ])('reads $0 as ultraplanProposed=$2', (_label, row, expected) => {
    expect(ladderFromJournal([...AT_ULTRAPLAN_RUNG, row]).ultraplanProposed).toBe(expected);
  });

  it('re-proposes while no proposal was applied, and asks a person once one was', () => {
    const decideWith = (extraRow) => recordRecoveryDecision(
      failingState('ultra', { recoveryJournal: [...AT_ULTRAPLAN_RUNG, extraRow] }),
      { ...FAILED_VERIFY, fixedNext: 'IMPROVE' },
    );

    const unapplied = decideWith({ class: 'implementation', action: 'propose_ultraplan' });
    expect(unapplied.action).toBe('propose_ultraplan');
    expect(unapplied.target).toBe('mission');
    expect(unapplied.ultraplanProposed).toBe(false);

    // escalateTo 'pause' (VERIFY_ON_FAILURE) renders the human rung as a stop,
    // not a question, for a class that is neither unknown nor human-value.
    const afterProposal = decideWith(applied('propose_ultraplan', 'PAUSED'));
    expect(afterProposal.action).toBe('pause');
    expect(afterProposal.target).toBe('human');
    expect(afterProposal.ultraplanProposed).toBe(true);
  });
});

describe('recordPhaseResult with CA-03 ON — six failed VERIFYs climb to the ceiling', () => {
  it('runs repair -> replan -> replan -> propose_ultraplan -> pause -> pause', () => {
    const state = failingState('six-tick');

    for (let i = 0; i < 6; i += 1) {
      // The driver re-enters VERIFY after each pause/transition; nothing else
      // about the state is reset, so the journal is the only thing that grows.
      state.phase = 'VERIFY';
      state.pendingPhase = null;
      recordPhaseResult(state, { ...FAILED_VERIFY }, ON);
      if (i >= 3) expect(state.phase).toBe('PAUSED');
    }

    expect(state.recoveryJournal).toHaveLength(6);
    expect(state.recoveryJournal.map((r) => r.action)).toEqual([
      'repair', 'replan', 'replan', 'propose_ultraplan', 'pause', 'pause',
    ]);
    expect(state.recoveryJournal.map((r) => r.appliedNext)).toEqual([
      'EXECUTE', 'PLAN', 'PLAN', 'PAUSED', 'PAUSED', 'PAUSED',
    ]);
    expect(state.recoveryJournal.map((r) => r.replanAttempts)).toEqual([0, 0, 1, 2, 2, 2]);
    expect(state.recoveryJournal.map((r) => r.ultraplanProposed))
      .toEqual([false, false, false, false, true, true]);
    expect(state.pausedReason).toBe('recovery:pause');
    expect(countEvents(state.sessionId, 'recovery-decided')).toBe(6);
    expect(countEvents(state.sessionId, 'recovery-applied')).toBe(6);
  });

  it('pauses with recovery:propose_ultraplan on the fourth tick', () => {
    const state = failingState('fourth-tick');

    for (let i = 0; i < 4; i += 1) {
      state.phase = 'VERIFY';
      state.pendingPhase = null;
      recordPhaseResult(state, { ...FAILED_VERIFY }, ON);
    }

    expect(state.phase).toBe('PAUSED');
    expect(state.pausedReason).toBe('recovery:propose_ultraplan');
    expect(state.recoveryJournal[3].action).toBe('propose_ultraplan');
  });
});

describe('ladderFromJournal — malformed rows are ignored, never thrown on', () => {
  it('counts nothing from rows that are not recovery rows', () => {
    const journal = [
      null, undefined, 'PLAN', 42, [],
      { appliedNext: 42 }, { appliedNext: null }, { appliedNext: ['PLAN'] },
      { appliedNext: 'plan' }, { appliedNext: 'PLANNED' },
      { action: 'propose_ultraplan', appliedNext: 42 },
      { action: 42, appliedNext: 'PAUSED' },
    ];

    expect(() => ladderFromJournal(journal)).not.toThrow();
    expect(ladderFromJournal(journal)).toEqual({ replanAttempts: 0, ultraplanProposed: false });
  });

  it('still counts the good rows in a journal that also holds junk', () => {
    const journal = [null, applied('replan', 'PLAN'), 'junk', applied('replan', 'PLAN'), { appliedNext: 7 }];

    expect(ladderFromJournal(journal)).toEqual({ replanAttempts: 2, ultraplanProposed: false });
  });
});

describe('row snapshot — the ladder the row was judged against is on the row', () => {
  it('records the values as of the decision, excluding the row being written', () => {
    const state = failingState('snapshot', {
      recoveryJournal: [applied('repair', 'EXECUTE'), applied('replan', 'PLAN')],
    });

    const row = recordRecoveryDecision(state, { ...FAILED_VERIFY, fixedNext: 'IMPROVE' });

    expect(row).toMatchObject({ replanAttempts: 1, ultraplanProposed: false, action: 'replan' });
    // The row itself becomes the second applied PLAN row only once the
    // transition stamps it, so the snapshot stays at 1.
    expect(row.appliedNext).toBeUndefined();
  });

  it('writes 0/false on an Observe row, where no transition ever applies', () => {
    const state = failingState('snapshot-off');

    recordPhaseResult(state, { ...FAILED_VERIFY }, OFF);

    expect(state.recoveryJournal[0]).toMatchObject({ replanAttempts: 0, ultraplanProposed: false });
    expect(state.recoveryJournal[0].appliedNext).toBeUndefined();
  });
});

describe('CA-03 OFF — the derived ladder changes no Observe decision', () => {
  it('still records repair then five replans, and judges the seventh the same way', () => {
    const state = failingState('off-determinism');

    for (let i = 0; i < 6; i += 1) {
      state.phase = 'VERIFY';
      state.pendingPhase = null;
      recordPhaseResult(state, { ...FAILED_VERIFY }, OFF);
    }

    expect(state.recoveryJournal.map((r) => r.action)).toEqual([
      'repair', 'replan', 'replan', 'replan', 'replan', 'replan',
    ]);
    expect(state.recoveryJournal.every((r) => r.appliedNext === undefined)).toBe(true);
    expect(state.recoveryJournal.every((r) => r.divergent === true)).toBe(true);
    expect(countEvents(state.sessionId, 'recovery-applied')).toBe(0);

    state.phase = 'VERIFY';
    state.pendingPhase = null;
    recordPhaseResult(state, { ...FAILED_VERIFY }, OFF);

    const seventh = state.recoveryJournal[6];
    expect(seventh).toMatchObject({
      action: 'replan', target: 'plan', replanAttempts: 0, ultraplanProposed: false,
    });
    expect(seventh.sameClassAttempts).toBe(7);
  });
});
