/**
 * Unit tests for session-store schema versioning + v1 -> v2 migration.
 * Covers:
 *   - schemaVersion auto-stamping on save
 *   - isLegacyState true/false branches (missing/wrong type/older)
 *   - migrateState idempotence
 *   - missing-array slots backfilled (queuedQuestions/checkpoints)
 *   - loadSession migration on the read path
 *   - migrateState non-object rejection
 *   - immutability (input not mutated)
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  CURRENT_SCHEMA_VERSION,
  deleteSessionArtifacts,
  getSessionPath,
  isLegacyState,
  loadSession,
  migrateState,
  saveSession,
} from '../../lib/autopilot/session-store.js';
import { nextPhaseAfter } from '../../lib/autopilot/engine-state.js';
import { reconcileAttemptOnResume } from '../../lib/autopilot/phase-attempt.js';

const tracked = [];

function track(id) {
  tracked.push(id);
  return id;
}

afterEach(() => {
  while (tracked.length) {
    const id = tracked.pop();
    try { deleteSessionArtifacts(id); } catch { /* ignore */ }
  }
});

describe('CURRENT_SCHEMA_VERSION', () => {
  it('exports a positive integer schema version', () => {
    expect(typeof CURRENT_SCHEMA_VERSION).toBe('number');
    expect(Number.isInteger(CURRENT_SCHEMA_VERSION)).toBe(true);
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(2);
  });
});

describe('isLegacyState', () => {
  it('returns true when schemaVersion is missing', () => {
    expect(isLegacyState({ sessionId: 'x' })).toBe(true);
  });

  it('returns true when schemaVersion is null', () => {
    expect(isLegacyState({ sessionId: 'x', schemaVersion: null })).toBe(true);
  });

  it('returns true when schemaVersion is a non-number (e.g., string "1")', () => {
    expect(isLegacyState({ sessionId: 'x', schemaVersion: '1' })).toBe(true);
  });

  it('returns true when schemaVersion is numerically lower than current', () => {
    expect(isLegacyState({ sessionId: 'x', schemaVersion: 1 })).toBe(true);
  });

  it('returns false when schemaVersion equals current', () => {
    expect(isLegacyState({ sessionId: 'x', schemaVersion: CURRENT_SCHEMA_VERSION })).toBe(false);
  });

  it('returns false when schemaVersion exceeds current (forward-compat read)', () => {
    expect(isLegacyState({ sessionId: 'x', schemaVersion: CURRENT_SCHEMA_VERSION + 5 })).toBe(false);
  });

  it('returns false for non-object input', () => {
    expect(isLegacyState(null)).toBe(false);
    expect(isLegacyState(undefined)).toBe(false);
    expect(isLegacyState('foo')).toBe(false);
  });

  it('treats Infinity/NaN schemaVersion as legacy (not finite)', () => {
    expect(isLegacyState({ sessionId: 'x', schemaVersion: Infinity })).toBe(true);
    expect(isLegacyState({ sessionId: 'x', schemaVersion: NaN })).toBe(true);
  });
});

describe('migrateState', () => {
  it('upgrades a pre-versioned (v1) state to current schema version', () => {
    const v1 = { sessionId: 'ap-mig-1', task: 'legacy', phase: 'INTAKE' };
    const v2 = migrateState(v1);
    expect(v2.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('backfills queuedQuestions / checkpoints as empty arrays when missing', () => {
    const v1 = { sessionId: 'ap-mig-2' };
    const v2 = migrateState(v1);
    expect(v2.queuedQuestions).toEqual([]);
    expect(v2.checkpoints).toEqual([]);
    // `timeline` is intentionally absent: it had no production writer, so
    // migration no longer manufactures it. See session-store.js#migrateState.
    expect(v2.timeline).toBeUndefined();
  });

  it('preserves existing array contents when already populated', () => {
    const v1 = {
      sessionId: 'ap-mig-3',
      queuedQuestions: [{ id: 'q1' }],
      checkpoints: [{ id: 'c1' }],
    };
    const v2 = migrateState(v1);
    expect(v2.queuedQuestions).toEqual([{ id: 'q1' }]);
    expect(v2.checkpoints).toEqual([{ id: 'c1' }]);
  });

  it('is idempotent — migrating an already-v2 state returns equivalent v2 state', () => {
    const v2 = migrateState({ sessionId: 'ap-mig-4' });
    const v2Again = migrateState(v2);
    expect(v2Again.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(v2Again.queuedQuestions).toEqual([]);
    expect(v2Again.checkpoints).toEqual([]);
  });

  it('does not mutate the input object', () => {
    const v1 = { sessionId: 'ap-mig-5' };
    const snapshot = JSON.stringify(v1);
    migrateState(v1);
    expect(JSON.stringify(v1)).toBe(snapshot);
    expect(v1.schemaVersion).toBeUndefined();
    expect(v1.queuedQuestions).toBeUndefined();
  });

  it('replaces non-array slots (e.g., null) with empty array', () => {
    const v1 = { sessionId: 'ap-mig-6', queuedQuestions: null, checkpoints: 'not-an-array', timeline: 42 };
    const v2 = migrateState(v1);
    expect(v2.queuedQuestions).toEqual([]);
    expect(v2.checkpoints).toEqual([]);
    // A stale `timeline` on a legacy session is carried through untouched
    // rather than coerced — it is ignored data now, not a slot to maintain.
    expect(v2.timeline).toBe(42);
  });

  it('throws TypeError when input is not an object', () => {
    expect(() => migrateState(null)).toThrow(TypeError);
    expect(() => migrateState(undefined)).toThrow(TypeError);
    expect(() => migrateState('foo')).toThrow(TypeError);
  });
});

describe('saveSession schemaVersion auto-stamping', () => {
  it('auto-stamps CURRENT_SCHEMA_VERSION when caller omits the field', () => {
    const sessionId = track(`ap-stamp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    const state = { sessionId, task: 'no version provided' };
    saveSession(state);
    const loaded = loadSession(sessionId);
    expect(loaded.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('preserves caller-provided schemaVersion (no overwrite)', () => {
    const sessionId = track(`ap-keep-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    const state = { sessionId, task: 'forward-compat', schemaVersion: CURRENT_SCHEMA_VERSION + 99 };
    saveSession(state);
    const loaded = loadSession(sessionId);
    // loaded version above current => not legacy => not migrated
    expect(loaded.schemaVersion).toBe(CURRENT_SCHEMA_VERSION + 99);
  });
});

describe('loadSession migration path', () => {
  function writeRawState(sessionId, state) {
    const filePath = getSessionPath(sessionId);
    const dir = dirname(filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(filePath, JSON.stringify(state, null, 2), 'utf-8');
  }

  it('migrates a legacy file in memory and leaves the bytes on disk alone', () => {
    // No persist-on-load: `getStatus()` and `listSessions` load EVERY session
    // in the store, so re-persisting here would rewrite every legacy file in it
    // on a single status call.
    const sessionId = track(`ap-load-mig-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    writeRawState(sessionId, { sessionId, task: 'legacy on disk' });
    const rawBefore = readFileSync(getSessionPath(sessionId), 'utf-8');

    const loaded = loadSession(sessionId);
    expect(loaded.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(Array.isArray(loaded.queuedQuestions)).toBe(true);
    expect(Array.isArray(loaded.checkpoints)).toBe(true);

    expect(readFileSync(getSessionPath(sessionId), 'utf-8')).toBe(rawBefore);
    expect(existsSync(`${getSessionPath(sessionId)}.v1.bak`)).toBe(false);

    // Every load re-derives the same answer, so the contract is stable.
    expect(loadSession(sessionId).schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('returns already-v2 state untouched (no migration overhead)', () => {
    const sessionId = track(`ap-load-v2-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    const original = {
      sessionId,
      task: 'modern',
      schemaVersion: CURRENT_SCHEMA_VERSION,
      queuedQuestions: [{ id: 'q' }],
      checkpoints: [],
    };
    saveSession(original);
    const loaded = loadSession(sessionId);
    expect(loaded.queuedQuestions).toEqual([{ id: 'q' }]);
  });

  it('returns null when session file is missing', () => {
    expect(loadSession('ap-nonexistent-mig-xyz')).toBeNull();
  });
});

describe('v2 → v3 upgrade on the first save', () => {
  function writeV2(sessionId, extra = {}) {
    const filePath = getSessionPath(sessionId);
    if (!existsSync(dirname(filePath))) mkdirSync(dirname(filePath), { recursive: true });
    const state = { sessionId, schemaVersion: 2, task: 'v2 on disk', phases: [], ...extra };
    writeFileSync(filePath, JSON.stringify(state, null, 2), 'utf-8');
    return filePath;
  }

  it('writes the .bak from the original bytes exactly once, on the first save', () => {
    const sessionId = track(`ap-v3-bak-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    const filePath = writeV2(sessionId);
    const originalBytes = readFileSync(filePath, 'utf-8');
    const backupPath = `${filePath}.v2.bak`;

    const migrated = loadSession(sessionId);
    expect(migrated.schemaVersion).toBe(3);
    expect(existsSync(backupPath)).toBe(false);

    saveSession(migrated);
    expect(readFileSync(backupPath, 'utf-8')).toBe(originalBytes);
    expect(JSON.parse(readFileSync(filePath, 'utf-8')).schemaVersion).toBe(3);

    // Second save must not re-snapshot: the marker is one-shot, so a long run
    // cannot bury the original under a chain of identical backups.
    migrated.task = 'changed after upgrade';
    saveSession(migrated);
    expect(readFileSync(backupPath, 'utf-8')).toBe(originalBytes);
    expect(existsSync(`${filePath}.v3.bak`)).toBe(false);
  });

  it('backfills subCheckpoints and attemptJournal without touching carried fields', () => {
    const sessionId = track(`ap-v3-fields-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    writeV2(sessionId, { goalIterations: 2, lastReviewedSHA: 'abc1234', fastProfile: { enabled: true } });

    const migrated = loadSession(sessionId);
    expect(migrated.subCheckpoints).toEqual([]);
    expect(migrated.attemptJournal).toEqual([]);
    expect(migrated.goalIterations).toBe(2);
    expect(migrated.lastReviewedSHA).toBe('abc1234');
    expect(migrated.fastProfile).toEqual({ enabled: true });
  });

  it('reconciles a v2 PAUSED session by copying lastPhase into pendingPhase', () => {
    const sessionId = track(`ap-v3-paused-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    writeV2(sessionId, { phase: 'PAUSED', lastPhase: 'VERIFY' });

    const migrated = loadSession(sessionId);
    // Preserves the v2 reader's meaning ("re-enter lastPhase"). It does NOT
    // claim VERIFY succeeded — nothing here advances past it.
    expect(migrated.pendingPhase).toBe('VERIFY');
    expect(migrated.phase).toBe('PAUSED');
  });

  it('reconciles a v2 PAUSED session with no lastPhase to a null pendingPhase', () => {
    const sessionId = track(`ap-v3-paused-nolast-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    writeV2(sessionId, { phase: 'PAUSED' });
    expect(loadSession(sessionId).pendingPhase).toBeNull();
  });

  it('leaves a non-PAUSED v2 session without a pendingPhase override', () => {
    const sessionId = track(`ap-v3-running-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    writeV2(sessionId, { phase: 'EXECUTE' });
    expect(loadSession(sessionId).pendingPhase).toBeUndefined();
  });

  it('still pauses a migrated session whose EXECUTE attempt was never acknowledged', () => {
    // The reconcile must not launder an outstanding hand-off into "resume here".
    const sessionId = track(`ap-v3-attempt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    writeV2(sessionId, {
      phase: 'PAUSED',
      lastPhase: 'EXECUTE',
      activePhaseAttempt: {
        attemptId: 'att-1', phase: 'EXECUTE', status: 'started', checkpointSha: null, startedAt: '2026-09-01T00:00:00.000Z',
      },
    });

    const migrated = loadSession(sessionId);
    expect(migrated.pendingPhase).toBe('EXECUTE');
    expect(reconcileAttemptOnResume(migrated).action).toBe('pause');
  });

  it('deletes the .bak alongside the session', () => {
    const sessionId = `ap-v3-cleanup-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const filePath = writeV2(sessionId);
    saveSession(loadSession(sessionId));
    expect(existsSync(`${filePath}.v2.bak`)).toBe(true);

    expect(deleteSessionArtifacts(sessionId)).toMatchObject({ session: true, backups: 1 });
    expect(existsSync(`${filePath}.v2.bak`)).toBe(false);
  });
});

describe('v3 → v2 downgrade — where a legacy reader agrees and where it does not', () => {
  /** The exact derivation v2 resume used, applied to a v3 state. */
  function legacyTarget(state) {
    return state.phase === 'PAUSED' ? (state.lastPhase || 'PLAN') : nextPhaseAfter(state.phase);
  }

  it('agrees with v3 on a post-ACK EXECUTE session', () => {
    const postAck = { phase: 'EXECUTE', pendingPhase: 'CROSS_CHECK', activePhaseAttempt: null };
    expect(legacyTarget(postAck)).toBe('CROSS_CHECK');
    expect(legacyTarget(postAck)).toBe(postAck.pendingPhase);
  });

  it('diverges on a mid-iteration goal session — the documented downgrade limit', () => {
    // v3 says EXECUTE (the corrective iteration). A v2 reader sees phase
    // EVALUATE and derives its successor, REPORT — it would END the session
    // instead of iterating. Hence: 진행 중 goal 세션은 다운그레이드 후 재개 금지.
    const iterating = { phase: 'EVALUATE', pendingPhase: 'EXECUTE', goalIterations: 1 };
    expect(legacyTarget(iterating)).toBe('REPORT');
    expect(legacyTarget(iterating)).not.toBe(iterating.pendingPhase);
    // It fails forward, never into a duplicate EXECUTE — the outcome the
    // attempt machinery exists to prevent.
    expect(legacyTarget(iterating)).not.toBe('EXECUTE');
  });

  it('restores the exact v2 file from the .bak bytes', () => {
    const sessionId = track(`ap-v3-restore-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    const filePath = getSessionPath(sessionId);
    if (!existsSync(dirname(filePath))) mkdirSync(dirname(filePath), { recursive: true });
    const v2Bytes = JSON.stringify({ sessionId, schemaVersion: 2, phase: 'PAUSED', lastPhase: 'EXECUTE' }, null, 2);
    writeFileSync(filePath, v2Bytes, 'utf-8');

    saveSession(loadSession(sessionId));
    expect(JSON.parse(readFileSync(filePath, 'utf-8')).schemaVersion).toBe(3);

    writeFileSync(filePath, readFileSync(`${filePath}.v2.bak`, 'utf-8'), 'utf-8');
    expect(readFileSync(filePath, 'utf-8')).toBe(v2Bytes);
  });
});
