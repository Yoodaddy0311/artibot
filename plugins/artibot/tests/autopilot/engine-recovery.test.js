/**
 * Unit tests for crash-recovery helpers in _engine-helpers.js:
 *   - detectInterruptedPhase
 *   - buildRecoveryNote
 *
 * Covers:
 *   - interrupted detection (phase-start without matching phase-end)
 *   - normal termination (each start matched by an end)
 *   - empty event log
 *   - malformed entries (skipped without throwing)
 *   - nested phases (LIFO pairing)
 *   - non-object input safety
 *   - Korean recovery banner formatting
 */
import { describe, expect, it } from 'vitest';
import {
  buildRecoveryNote,
  detectInterruptedPhase,
} from '../../lib/autopilot/_engine-helpers.js';
import { ATTEMPT_RERUN_ALLOWLIST, ATTEMPT_STATUS } from '../../lib/autopilot/phase-attempt.js';

/**
 * Input surface note: these fixtures are NDJSON **events** passed through the
 * documented `{events}` unit-test seam. They used to be `state.timeline`
 * arrays -- a field with no production writer -- so every "interrupted:true"
 * case here described a shape the engine never produced, while the real
 * detector sat permanently at `interrupted:false`. The seam still does not
 * prove the file read works; that is the job of
 * `engine-crash-recovery-smoke.test.js`, which SIGKILLs a real autopilot
 * process. These tests own the pairing logic and the defensive behaviour.
 *
 * Session stub carries only what the detector reads. Because `{events}` is
 * supplied, this id never touches the filesystem.
 */
const SESSION = { sessionId: 'ap-recovery-unit' };

describe('detectInterruptedPhase — interruption detection', () => {
  it('flags interrupted when the log ends on a phase-start with no matching end', () => {
    const events = [
      { type: 'phase-start', phase: 'INTAKE', ts: '2026-05-17T00:00:00Z' },
      { type: 'phase-end', phase: 'INTAKE', ts: '2026-05-17T00:01:00Z' },
      { type: 'phase-start', phase: 'PLAN', ts: '2026-05-17T00:02:00Z' },
    ];
    const result = detectInterruptedPhase(SESSION, { events });
    expect(result.interrupted).toBe(true);
    expect(result.phase).toBe('PLAN');
    expect(result.startedAt).toBe('2026-05-17T00:02:00Z');
  });

  it('reports the most recent open phase when multiple are pending', () => {
    const events = [
      { type: 'phase-start', phase: 'PLAN', ts: '2026-05-17T00:00:00Z' },
      { type: 'phase-start', phase: 'EXECUTE', ts: '2026-05-17T00:01:00Z' },
    ];
    const result = detectInterruptedPhase(SESSION, { events });
    expect(result.interrupted).toBe(true);
    expect(result.phase).toBe('EXECUTE');
  });
});

describe('detectInterruptedPhase — normal termination', () => {
  it('reports interrupted:false when every phase-start has a matching phase-end', () => {
    const events = [
      { type: 'phase-start', phase: 'INTAKE', ts: '2026-05-17T00:00:00Z' },
      { type: 'phase-end', phase: 'INTAKE', ts: '2026-05-17T00:01:00Z' },
      { type: 'phase-start', phase: 'PLAN', ts: '2026-05-17T00:02:00Z' },
      { type: 'phase-end', phase: 'PLAN', ts: '2026-05-17T00:03:00Z' },
    ];
    expect(detectInterruptedPhase(SESSION, { events })).toEqual({ interrupted: false });
  });

  it('handles nested LIFO pairing (inner phase closes before outer)', () => {
    const events = [
      { type: 'phase-start', phase: 'EXECUTE', ts: '2026-05-17T00:00:00Z' },
      { type: 'phase-start', phase: 'TEST', ts: '2026-05-17T00:00:10Z' },
      { type: 'phase-end', phase: 'TEST', ts: '2026-05-17T00:00:20Z' },
      { type: 'phase-end', phase: 'EXECUTE', ts: '2026-05-17T00:00:30Z' },
    ];
    expect(detectInterruptedPhase(SESSION, { events }).interrupted).toBe(false);
  });
});

describe('detectInterruptedPhase — defensive parsing', () => {
  it('returns interrupted:false on an empty event log', () => {
    expect(detectInterruptedPhase(SESSION, { events: [] })).toEqual({ interrupted: false });
  });

  it('returns interrupted:false for a session with no id to read a log for', () => {
    expect(detectInterruptedPhase({ task: 'no id' })).toEqual({ interrupted: false });
  });

  it('returns interrupted:false when the supplied event list is not an array', () => {
    // Non-array seam input falls through to the real reader, which yields []
    // for an id with no log on disk.
    expect(detectInterruptedPhase(SESSION, { events: 'not-an-array' })).toEqual({ interrupted: false });
    expect(detectInterruptedPhase(SESSION, { events: 42 })).toEqual({ interrupted: false });
  });

  it('skips malformed entries (missing type/phase, null, non-objects) without throwing', () => {
    const events = [
      null,
      'string-entry',
      { /* no type */ phase: 'PLAN' },
      { type: 'phase-start' /* no phase */ },
      { type: 'phase-start', phase: 'EXECUTE', ts: '2026-05-17T00:00:00Z' },
    ];
    const result = detectInterruptedPhase(SESSION, { events });
    expect(result.interrupted).toBe(true);
    expect(result.phase).toBe('EXECUTE');
  });

  it('treats non-object state as not-interrupted (no throw)', () => {
    expect(detectInterruptedPhase(null)).toEqual({ interrupted: false });
    expect(detectInterruptedPhase(undefined)).toEqual({ interrupted: false });
    expect(detectInterruptedPhase('foo')).toEqual({ interrupted: false });
  });

  it('handles missing ts gracefully (startedAt=null)', () => {
    const events = [{ type: 'phase-start', phase: 'INTAKE' /* no ts */ }];
    const result = detectInterruptedPhase(SESSION, { events });
    expect(result.interrupted).toBe(true);
    expect(result.startedAt).toBeNull();
  });

  it('ignores orphaned phase-end entries (no preceding start)', () => {
    const events = [{ type: 'phase-end', phase: 'PLAN', ts: '2026-05-17T00:00:00Z' }];
    expect(detectInterruptedPhase(SESSION, { events })).toEqual({ interrupted: false });
  });
});

describe('buildRecoveryNote', () => {
  it('returns Korean banner including phase name and timestamp', () => {
    const events = [{ type: 'phase-start', phase: 'PLAN', ts: '2026-05-17T00:00:00Z' }];
    const note = buildRecoveryNote(SESSION, { events });
    expect(note).toBeTypeOf('string');
    expect(note).toContain('이전 세션');
    expect(note).toContain('PLAN');
    expect(note).toContain('2026-05-17T00:00:00Z');
    expect(note).toContain('재진입');
  });

  it('returns null when the prior session terminated cleanly', () => {
    const events = [
      { type: 'phase-start', phase: 'INTAKE', ts: '2026-05-17T00:00:00Z' },
      { type: 'phase-end', phase: 'INTAKE', ts: '2026-05-17T00:01:00Z' },
    ];
    expect(buildRecoveryNote(SESSION, { events })).toBeNull();
  });

  it('returns null on an empty or unreadable event log', () => {
    expect(buildRecoveryNote(SESSION, { events: [] })).toBeNull();
    expect(buildRecoveryNote({})).toBeNull();
    expect(buildRecoveryNote(null)).toBeNull();
  });

  it('omits the timestamp parenthetical when startedAt is null', () => {
    const events = [{ type: 'phase-start', phase: 'EXECUTE' /* no ts */ }];
    const note = buildRecoveryNote(SESSION, { events });
    expect(note).toContain('EXECUTE');
    // No "(...)" since startedAt is null
    expect(note).not.toMatch(/\(/);
  });
});

/**
 * ADR-005 2단 regression guard.
 *
 * 1단 gave this banner one sentence — "자동으로 {phase} 재진입합니다" — because
 * back then resume really did re-enter every interrupted phase. 2단 changed
 * that for un-acknowledged attempts: `engine.js#settleOutstandingAttempt`
 * PAUSEs instead, and says so in the opposite words. The banner was not
 * updated, so a driver following `commands/autopilot.md` § Step 2 (which tells
 * it to push this note *before* calling resumeAutopilot) showed the operator
 * "재진입합니다" one line before the engine said "자동 재실행하지 않습니다".
 *
 * These tests pin the banner to the decision `phase-attempt.js#reconcileAttemptOnResume`
 * will actually make. They deliberately assert on the *contradiction* rather
 * than on exact wording, so rephrasing either note keeps them green while
 * re-introducing the conflict turns them red.
 */
describe('buildRecoveryNote — attempt-aware (ADR-005 2단)', () => {
  /** A crashed EXECUTE hand-off: phase-start logged, no phase-end, attempt still open. */
  const executeEvents = [{ type: 'phase-start', phase: 'EXECUTE', ts: '2026-08-23T00:30:16.290Z' }];
  const openAttempt = (phase) => ({
    attemptId: '08a99713-c61f-4fdc-86e6-14733205c68c',
    phase,
    runner: 'team-create',
    status: ATTEMPT_STATUS.STARTED,
    checkpointSha: null,
    startedAt: '2026-08-23T00:30:17.408Z',
  });

  it('warns that the work will NOT be redone when an EXECUTE attempt is outstanding', () => {
    const state = { ...SESSION, activePhaseAttempt: openAttempt('EXECUTE') };
    const note = buildRecoveryNote(state, { events: executeEvents });

    expect(note).toContain('자동 재실행하지 않습니다');
    expect(note).toContain('EXECUTE');
  });

  it('never promises re-entry while also refusing to re-run (the original contradiction)', () => {
    const state = { ...SESSION, activePhaseAttempt: openAttempt('EXECUTE') };
    const note = buildRecoveryNote(state, { events: executeEvents });

    // The exact defect: both claims reaching the operator from one resume.
    expect(note).not.toContain('재진입합니다');
  });

  it('surfaces all three documented exits so the pause is never a dead end', () => {
    const state = { ...SESSION, activePhaseAttempt: openAttempt('EXECUTE') };
    const note = buildRecoveryNote(state, { events: executeEvents });

    expect(note).toContain('recordPhaseResult');
    expect(note).toContain('ackOutstandingAttempt');
    expect(note).toContain('/autopilot:abort');
  });

  it('says an allowlisted phase WILL be redone automatically', () => {
    // CROSS_CHECK/VERIFY are read-and-report passes; redoing them is free, so
    // reconcileAttemptOnResume returns `rerun` and the banner must agree.
    const phase = [...ATTEMPT_RERUN_ALLOWLIST][0];
    const state = { ...SESSION, activePhaseAttempt: openAttempt(phase) };
    const note = buildRecoveryNote(state, { events: [{ type: 'phase-start', phase, ts: '2026-08-23T00:30:16.290Z' }] });

    expect(note).toContain('자동으로 다시 진행합니다');
    expect(note).not.toContain('자동 재실행하지 않습니다');
  });

  it('keeps the plain re-entry banner when no attempt is outstanding', () => {
    // Negative control. Without an open attempt resume really does re-enter,
    // so 1단's wording is correct and must survive.
    const note = buildRecoveryNote(SESSION, { events: executeEvents });

    expect(note).toContain('재진입합니다');
    expect(note).not.toContain('자동 재실행하지 않습니다');
  });

  it('ignores an already-committed attempt (only `started` blocks resume)', () => {
    const state = {
      ...SESSION,
      activePhaseAttempt: { ...openAttempt('EXECUTE'), status: ATTEMPT_STATUS.COMMITTED },
    };
    const note = buildRecoveryNote(state, { events: executeEvents });

    expect(note).toContain('재진입합니다');
  });

  it('still returns null for a cleanly terminated session carrying no attempt', () => {
    const events = [
      { type: 'phase-start', phase: 'EXECUTE', ts: '2026-08-23T00:30:16.290Z' },
      { type: 'phase-end', phase: 'EXECUTE', ts: '2026-08-23T00:31:43.205Z' },
    ];
    expect(buildRecoveryNote({ ...SESSION, activePhaseAttempt: null }, { events })).toBeNull();
  });
});
