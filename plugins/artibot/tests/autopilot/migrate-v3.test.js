/**
 * Unit tests for lib/autopilot/migrate-v3.js
 */
import { describe, expect, it } from 'vitest';
import {
  migrateV2toV3,
  needsV3Migration,
  SCHEMA_VERSION_V3,
  SUPPORTED_FROM_VERSION,
} from '../../lib/autopilot/migrate-v3.js';

describe('SCHEMA_VERSION_V3', () => {
  it('is exactly 3', () => {
    expect(SCHEMA_VERSION_V3).toBe(3);
  });
  it('SUPPORTED_FROM_VERSION is 2', () => {
    expect(SUPPORTED_FROM_VERSION).toBe(2);
  });
});

describe('needsV3Migration', () => {
  it('returns true for v2 state', () => {
    expect(needsV3Migration({ schemaVersion: 2 })).toBe(true);
  });
  it('returns false for v3 state', () => {
    expect(needsV3Migration({ schemaVersion: 3 })).toBe(false);
  });
  it('returns false for forward-compat v4', () => {
    expect(needsV3Migration({ schemaVersion: 4 })).toBe(false);
  });
  it('returns false for pre-v2 (handled by earlier migration)', () => {
    expect(needsV3Migration({ schemaVersion: 1 })).toBe(false);
  });
  it('returns false for non-object input', () => {
    expect(needsV3Migration(null)).toBe(false);
    expect(needsV3Migration('foo')).toBe(false);
  });
  it('returns false when schemaVersion missing', () => {
    expect(needsV3Migration({ sessionId: 'x' })).toBe(false);
  });
});

describe('migrateV2toV3', () => {
  it('upgrades v2 state to v3 with subCheckpoints[]', () => {
    const v2 = { sessionId: 'x', schemaVersion: 2, checkpoints: [] };
    const v3 = migrateV2toV3(v2);
    expect(v3.schemaVersion).toBe(3);
    expect(v3.subCheckpoints).toEqual([]);
  });

  it('does not mutate input', () => {
    const v2 = { sessionId: 'x', schemaVersion: 2 };
    const snapshot = JSON.stringify(v2);
    migrateV2toV3(v2);
    expect(JSON.stringify(v2)).toBe(snapshot);
  });

  it('preserves existing subCheckpoints content', () => {
    const v2 = {
      sessionId: 'x',
      schemaVersion: 2,
      subCheckpoints: [{ phase: 'A', subStep: 's', sha: '', ts: 't' }],
    };
    const v3 = migrateV2toV3(v2);
    expect(v3.subCheckpoints).toHaveLength(1);
  });

  it('is idempotent on already-v3 state', () => {
    const v3a = migrateV2toV3({ sessionId: 'x', schemaVersion: 2 });
    const v3b = migrateV2toV3(v3a);
    expect(v3b.schemaVersion).toBe(3);
    expect(v3b.subCheckpoints).toEqual([]);
  });

  it('does NOT stamp machineId (cross-machine module handles it)', () => {
    const v3 = migrateV2toV3({ sessionId: 'x', schemaVersion: 2 });
    expect(v3.machineId).toBeUndefined();
  });

  it('throws TypeError on non-object input', () => {
    expect(() => migrateV2toV3(null)).toThrow(TypeError);
    expect(() => migrateV2toV3('foo')).toThrow(TypeError);
  });

  it('throws RangeError on pre-v2 input', () => {
    expect(() => migrateV2toV3({ sessionId: 'x', schemaVersion: 1 })).toThrow(RangeError);
  });
});
