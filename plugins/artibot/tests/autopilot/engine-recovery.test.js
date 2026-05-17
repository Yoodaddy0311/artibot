/**
 * Unit tests for crash-recovery helpers in _engine-helpers.js:
 *   - detectInterruptedPhase
 *   - buildRecoveryNote
 *
 * Covers:
 *   - interrupted detection (phase-start without matching phase-end)
 *   - normal termination (each start matched by an end)
 *   - empty timeline
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

describe('detectInterruptedPhase — interruption detection', () => {
  it('flags interrupted when timeline ends on a phase-start with no matching end', () => {
    const state = {
      timeline: [
        { type: 'phase-start', phase: 'INTAKE', ts: '2026-05-17T00:00:00Z' },
        { type: 'phase-end', phase: 'INTAKE', ts: '2026-05-17T00:01:00Z' },
        { type: 'phase-start', phase: 'PLAN', ts: '2026-05-17T00:02:00Z' },
      ],
    };
    const result = detectInterruptedPhase(state);
    expect(result.interrupted).toBe(true);
    expect(result.phase).toBe('PLAN');
    expect(result.startedAt).toBe('2026-05-17T00:02:00Z');
  });

  it('reports the most recent open phase when multiple are pending', () => {
    const state = {
      timeline: [
        { type: 'phase-start', phase: 'PLAN', ts: '2026-05-17T00:00:00Z' },
        { type: 'phase-start', phase: 'EXECUTE', ts: '2026-05-17T00:01:00Z' },
      ],
    };
    const result = detectInterruptedPhase(state);
    expect(result.interrupted).toBe(true);
    expect(result.phase).toBe('EXECUTE');
  });
});

describe('detectInterruptedPhase — normal termination', () => {
  it('reports interrupted:false when every phase-start has a matching phase-end', () => {
    const state = {
      timeline: [
        { type: 'phase-start', phase: 'INTAKE', ts: '2026-05-17T00:00:00Z' },
        { type: 'phase-end', phase: 'INTAKE', ts: '2026-05-17T00:01:00Z' },
        { type: 'phase-start', phase: 'PLAN', ts: '2026-05-17T00:02:00Z' },
        { type: 'phase-end', phase: 'PLAN', ts: '2026-05-17T00:03:00Z' },
      ],
    };
    expect(detectInterruptedPhase(state)).toEqual({ interrupted: false });
  });

  it('handles nested LIFO pairing (inner phase closes before outer)', () => {
    const state = {
      timeline: [
        { type: 'phase-start', phase: 'EXECUTE', ts: '2026-05-17T00:00:00Z' },
        { type: 'phase-start', phase: 'TEST', ts: '2026-05-17T00:00:10Z' },
        { type: 'phase-end', phase: 'TEST', ts: '2026-05-17T00:00:20Z' },
        { type: 'phase-end', phase: 'EXECUTE', ts: '2026-05-17T00:00:30Z' },
      ],
    };
    expect(detectInterruptedPhase(state).interrupted).toBe(false);
  });
});

describe('detectInterruptedPhase — defensive parsing', () => {
  it('returns interrupted:false on empty timeline', () => {
    expect(detectInterruptedPhase({ timeline: [] })).toEqual({ interrupted: false });
  });

  it('returns interrupted:false when timeline field is missing entirely', () => {
    expect(detectInterruptedPhase({ sessionId: 'x' })).toEqual({ interrupted: false });
  });

  it('returns interrupted:false when timeline is not an array', () => {
    expect(detectInterruptedPhase({ timeline: 'not-an-array' })).toEqual({ interrupted: false });
    expect(detectInterruptedPhase({ timeline: null })).toEqual({ interrupted: false });
    expect(detectInterruptedPhase({ timeline: 42 })).toEqual({ interrupted: false });
  });

  it('skips malformed entries (missing type/phase, null, non-objects) without throwing', () => {
    const state = {
      timeline: [
        null,
        'string-entry',
        { /* no type */ phase: 'PLAN' },
        { type: 'phase-start' /* no phase */ },
        { type: 'phase-start', phase: 'EXECUTE', ts: '2026-05-17T00:00:00Z' },
      ],
    };
    const result = detectInterruptedPhase(state);
    expect(result.interrupted).toBe(true);
    expect(result.phase).toBe('EXECUTE');
  });

  it('treats non-object state as not-interrupted (no throw)', () => {
    expect(detectInterruptedPhase(null)).toEqual({ interrupted: false });
    expect(detectInterruptedPhase(undefined)).toEqual({ interrupted: false });
    expect(detectInterruptedPhase('foo')).toEqual({ interrupted: false });
  });

  it('handles missing ts gracefully (startedAt=null)', () => {
    const state = {
      timeline: [
        { type: 'phase-start', phase: 'INTAKE' /* no ts */ },
      ],
    };
    const result = detectInterruptedPhase(state);
    expect(result.interrupted).toBe(true);
    expect(result.startedAt).toBeNull();
  });

  it('ignores orphaned phase-end entries (no preceding start)', () => {
    const state = {
      timeline: [
        { type: 'phase-end', phase: 'PLAN', ts: '2026-05-17T00:00:00Z' },
      ],
    };
    expect(detectInterruptedPhase(state)).toEqual({ interrupted: false });
  });
});

describe('buildRecoveryNote', () => {
  it('returns Korean banner including phase name and timestamp', () => {
    const state = {
      timeline: [
        { type: 'phase-start', phase: 'PLAN', ts: '2026-05-17T00:00:00Z' },
      ],
    };
    const note = buildRecoveryNote(state);
    expect(note).toBeTypeOf('string');
    expect(note).toContain('이전 세션');
    expect(note).toContain('PLAN');
    expect(note).toContain('2026-05-17T00:00:00Z');
    expect(note).toContain('재진입');
  });

  it('returns null when the prior session terminated cleanly', () => {
    const state = {
      timeline: [
        { type: 'phase-start', phase: 'INTAKE', ts: '2026-05-17T00:00:00Z' },
        { type: 'phase-end', phase: 'INTAKE', ts: '2026-05-17T00:01:00Z' },
      ],
    };
    expect(buildRecoveryNote(state)).toBeNull();
  });

  it('returns null on empty/missing timeline', () => {
    expect(buildRecoveryNote({ timeline: [] })).toBeNull();
    expect(buildRecoveryNote({})).toBeNull();
    expect(buildRecoveryNote(null)).toBeNull();
  });

  it('omits the timestamp parenthetical when startedAt is null', () => {
    const state = {
      timeline: [
        { type: 'phase-start', phase: 'EXECUTE' /* no ts */ },
      ],
    };
    const note = buildRecoveryNote(state);
    expect(note).toContain('EXECUTE');
    // No "(...)" since startedAt is null
    expect(note).not.toMatch(/\(/);
  });
});
