/**
 * Durable phase attempts — the ACK half of crash recovery (ADR-005 stage 2).
 *
 * Scope split, stated so neither file is mistaken for the other's evidence:
 * this file owns the state machine (open → ACK → clear, reconciliation
 * policy, id uniqueness, schema round-trip). Whether a real crashed process
 * is actually caught is proven only by
 * `engine-crash-recovery-smoke.test.js`, which SIGKILLs a real autopilot
 * between delegation and ACK.
 */
import { describe, expect, it } from 'vitest';
import {
  ackPhaseAttempt,
  ATTEMPT_ARMED_PHASES,
  ATTEMPT_RERUN_ALLOWLIST,
  ATTEMPT_STATUS,
  isAttemptArmed,
  openPhaseAttempt,
  reconcileAttemptOnResume,
} from '../../lib/autopilot/phase-attempt.js';

/** @returns {object} minimal session state */
function stateWith(overrides = {}) {
  return { sessionId: 'ap-attempt-unit', phases: [], checkpoints: [], ...overrides };
}

describe('openPhaseAttempt', () => {
  it('stores a started attempt on the session and returns it', () => {
    const state = stateWith({ checkpoints: [{ sha: 'a'.repeat(40), label: 'pre-execute' }] });
    const attempt = openPhaseAttempt(state, { phase: 'EXECUTE', runner: 'team-create' });

    expect(state.activePhaseAttempt).toBe(attempt);
    expect(attempt).toMatchObject({
      phase: 'EXECUTE',
      runner: 'team-create',
      status: ATTEMPT_STATUS.STARTED,
      checkpointSha: 'a'.repeat(40),
    });
    expect(attempt.attemptId).toEqual(expect.any(String));
    expect(attempt.startedAt).toEqual(expect.any(String));
  });

  it('records a null checkpointSha when the session has none', () => {
    expect(openPhaseAttempt(stateWith(), { phase: 'EXECUTE' }).checkpointSha).toBeNull();
  });

  it('takes the most recent checkpoint carrying a sha', () => {
    const state = stateWith({
      checkpoints: [{ sha: 'old' }, { label: 'no sha here' }],
    });
    expect(openPhaseAttempt(state, { phase: 'EXECUTE' }).checkpointSha).toBe('old');
  });

  it('generates a unique attemptId per attempt, even in the same millisecond', () => {
    // The ACK matches on this id, so a collision would let one phase's
    // acknowledgement clear another phase's outstanding work. A timestamp or
    // counter would not survive this loop.
    const ids = new Set();
    for (let i = 0; i < 500; i += 1) {
      ids.add(openPhaseAttempt(stateWith(), { phase: 'EXECUTE' }).attemptId);
    }
    expect(ids.size).toBe(500);
  });
});

describe('ackPhaseAttempt', () => {
  it('commits the matching attempt and clears the slot', () => {
    const state = stateWith();
    const opened = openPhaseAttempt(state, { phase: 'EXECUTE', runner: 'team-create' });
    const acked = ackPhaseAttempt(state, { phase: 'EXECUTE', status: 'done' });

    expect(acked).toMatchObject({
      attemptId: opened.attemptId,
      status: ATTEMPT_STATUS.COMMITTED,
      resultStatus: 'done',
    });
    expect(acked.committedAt).toEqual(expect.any(String));
    // Clearing is what stops a completed session from pausing forever.
    expect(state.activePhaseAttempt).toBeNull();
  });

  it('refuses to clear an attempt belonging to a different phase', () => {
    const state = stateWith();
    openPhaseAttempt(state, { phase: 'EXECUTE' });

    expect(ackPhaseAttempt(state, { phase: 'PLAN', status: 'done' })).toBeNull();
    // The EXECUTE hand-off is still outstanding — a PLAN acknowledgement must
    // never be able to declare EXECUTE finished.
    expect(state.activePhaseAttempt).toMatchObject({
      phase: 'EXECUTE',
      status: ATTEMPT_STATUS.STARTED,
    });
  });

  it('is a no-op when nothing is open', () => {
    const state = stateWith();
    expect(ackPhaseAttempt(state, { phase: 'EXECUTE', status: 'done' })).toBeNull();
    expect(ackPhaseAttempt(null, { phase: 'EXECUTE' })).toBeNull();
  });
});

describe('reconcileAttemptOnResume — allowlist, not deny-list', () => {
  it('pauses on an unacknowledged EXECUTE attempt', () => {
    const state = stateWith();
    openPhaseAttempt(state, { phase: 'EXECUTE' });
    const result = reconcileAttemptOnResume(state);

    expect(result.action).toBe('pause');
    expect(result.note).toContain('EXECUTE');
    expect(result.note).toContain('자동 재실행하지 않습니다');
  });

  it('names every escape route in the pause note', () => {
    // A banner whose advice dead-ends is worse than none: the pause repeats on
    // every resume, so a reader who cannot use the first suggestion must find
    // the other two here rather than by reading source.
    const state = stateWith();
    openPhaseAttempt(state, { phase: 'EXECUTE' });
    const { note } = reconcileAttemptOnResume(state);

    expect(note).toContain('recordPhaseResult');       // 결과를 기록할 수 있을 때
    expect(note).toContain('ackOutstandingAttempt');   // 확인 후 승인 재개
    expect(note).toContain('/autopilot:abort');        // 세션 포기
  });

  it('keeps EXECUTE out of the re-run allowlist', () => {
    // Pinned as its own assertion: an unattended EXECUTE re-run can commit
    // work that already landed, which is the worst outcome this design has.
    expect(ATTEMPT_RERUN_ALLOWLIST.has('EXECUTE')).toBe(false);
    expect(ATTEMPT_ARMED_PHASES.has('EXECUTE')).toBe(true);
    expect(isAttemptArmed('EXECUTE')).toBe(true);
  });

  it('pauses on an unknown phase rather than re-running it', () => {
    // The fail-closed property: a phase nobody has classified yet gets the
    // cautious branch. A deny-list would have auto-re-run it.
    const state = stateWith();
    openPhaseAttempt(state, { phase: 'SOME_FUTURE_PHASE' });
    expect(reconcileAttemptOnResume(state).action).toBe('pause');
  });

  it('re-runs an allowlisted read-only phase', () => {
    const state = stateWith();
    openPhaseAttempt(state, { phase: 'CROSS_CHECK' });
    const result = reconcileAttemptOnResume(state);

    expect(result.action).toBe('rerun');
    expect(result.note).toContain('부작용이 없는 단계');
  });

  it('reports no action for a session with nothing outstanding', () => {
    expect(reconcileAttemptOnResume(stateWith())).toEqual({ action: 'none' });
    expect(reconcileAttemptOnResume(stateWith({ activePhaseAttempt: null })))
      .toEqual({ action: 'none' });
    expect(reconcileAttemptOnResume(null)).toEqual({ action: 'none' });
  });

  it('reports no action for an already-committed attempt', () => {
    const state = stateWith();
    openPhaseAttempt(state, { phase: 'EXECUTE' });
    state.activePhaseAttempt.status = ATTEMPT_STATUS.COMMITTED;
    expect(reconcileAttemptOnResume(state)).toEqual({ action: 'none' });
  });

  it('reports no action for a malformed attempt instead of throwing', () => {
    expect(reconcileAttemptOnResume(stateWith({ activePhaseAttempt: 'nope' })))
      .toEqual({ action: 'none' });
    expect(reconcileAttemptOnResume(stateWith({
      activePhaseAttempt: { status: ATTEMPT_STATUS.STARTED },
    }))).toEqual({ action: 'none' });
  });
});

describe('schema round-trip', () => {
  it('survives JSON serialization unchanged (additive field, no version bump)', () => {
    const state = stateWith({ schemaVersion: 2, checkpoints: [{ sha: 'b'.repeat(40) }] });
    openPhaseAttempt(state, { phase: 'EXECUTE', runner: 'team-create' });

    const reloaded = JSON.parse(JSON.stringify(state));
    expect(reloaded.activePhaseAttempt).toEqual(state.activePhaseAttempt);
    // The whole point of "additive": the version does not move, so an older
    // reader keeps working and simply ignores the field.
    expect(reloaded.schemaVersion).toBe(2);
    // And reconciliation reaches the same verdict after the round-trip.
    expect(reconcileAttemptOnResume(reloaded).action).toBe('pause');
  });
});
