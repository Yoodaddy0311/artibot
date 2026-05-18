/**
 * Unit tests for session-store schema versioning + v1 -> v2 migration.
 * Covers:
 *   - schemaVersion auto-stamping on save
 *   - isLegacyState true/false branches (missing/wrong type/older)
 *   - migrateState idempotence
 *   - missing-array slots backfilled (queuedQuestions/checkpoints/timeline)
 *   - loadSession migration on the read path
 *   - migrateState non-object rejection
 *   - immutability (input not mutated)
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  CURRENT_SCHEMA_VERSION,
  deleteSession,
  getSessionPath,
  isLegacyState,
  loadSession,
  migrateState,
  saveSession,
} from '../../lib/autopilot/session-store.js';

const tracked = [];

function track(id) {
  tracked.push(id);
  return id;
}

afterEach(() => {
  while (tracked.length) {
    const id = tracked.pop();
    try { deleteSession(id); } catch { /* ignore */ }
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

  it('backfills queuedQuestions / checkpoints / timeline as empty arrays when missing', () => {
    const v1 = { sessionId: 'ap-mig-2' };
    const v2 = migrateState(v1);
    expect(v2.queuedQuestions).toEqual([]);
    expect(v2.checkpoints).toEqual([]);
    expect(v2.timeline).toEqual([]);
  });

  it('preserves existing array contents when already populated', () => {
    const v1 = {
      sessionId: 'ap-mig-3',
      queuedQuestions: [{ id: 'q1' }],
      checkpoints: [{ id: 'c1' }],
      timeline: [{ type: 'phase-start', phase: 'INTAKE', ts: '2026-05-17T00:00:00Z' }],
    };
    const v2 = migrateState(v1);
    expect(v2.queuedQuestions).toEqual([{ id: 'q1' }]);
    expect(v2.checkpoints).toEqual([{ id: 'c1' }]);
    expect(v2.timeline).toHaveLength(1);
  });

  it('is idempotent — migrating an already-v2 state returns equivalent v2 state', () => {
    const v2 = migrateState({ sessionId: 'ap-mig-4' });
    const v2Again = migrateState(v2);
    expect(v2Again.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(v2Again.queuedQuestions).toEqual([]);
    expect(v2Again.checkpoints).toEqual([]);
    expect(v2Again.timeline).toEqual([]);
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
    expect(v2.timeline).toEqual([]);
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

  it('migrates a v1 file on read and re-persists it as v2', () => {
    const sessionId = track(`ap-load-mig-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    writeRawState(sessionId, { sessionId, task: 'legacy on disk' });

    const loaded = loadSession(sessionId);
    expect(loaded.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(Array.isArray(loaded.queuedQuestions)).toBe(true);
    expect(Array.isArray(loaded.checkpoints)).toBe(true);
    expect(Array.isArray(loaded.timeline)).toBe(true);

    // Second load should hit the fast path (already v2)
    const loadedAgain = loadSession(sessionId);
    expect(loadedAgain.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('returns already-v2 state untouched (no migration overhead)', () => {
    const sessionId = track(`ap-load-v2-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    const original = {
      sessionId,
      task: 'modern',
      schemaVersion: CURRENT_SCHEMA_VERSION,
      queuedQuestions: [{ id: 'q' }],
      checkpoints: [],
      timeline: [],
    };
    saveSession(original);
    const loaded = loadSession(sessionId);
    expect(loaded.queuedQuestions).toEqual([{ id: 'q' }]);
  });

  it('returns null when session file is missing', () => {
    expect(loadSession('ap-nonexistent-mig-xyz')).toBeNull();
  });
});
