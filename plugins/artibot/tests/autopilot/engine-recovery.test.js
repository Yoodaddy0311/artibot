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
