/**
 * Unit tests for lib/autopilot/sub-checkpoint.js
 */
import { afterEach, describe, expect, it } from 'vitest';
import { deleteSessionArtifacts, loadSession, saveSession } from '../../lib/autopilot/session-store.js';
import { listSubCheckpoints, recordSubCheckpoint } from '../../lib/autopilot/sub-checkpoint.js';

const tracked = [];
function track(id) { tracked.push(id); return id; }

afterEach(() => {
  while (tracked.length) {
    const id = tracked.pop();
    try { deleteSessionArtifacts(id); } catch { /* ignore */ }
  }
});

function freshId(label) {
  return track(`ap-test-sub-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
}

describe('recordSubCheckpoint — validation', () => {
  it('throws on empty sessionId', () => {
    expect(() => recordSubCheckpoint('', 'EXECUTE', 'lint', 'aaaa')).toThrow(TypeError);
  });
  it('throws on empty phase', () => {
    expect(() => recordSubCheckpoint('id', '', 'lint', 'aaaa')).toThrow(TypeError);
  });
  it('throws on empty subStep', () => {
    expect(() => recordSubCheckpoint('id', 'EXECUTE', '', 'aaaa')).toThrow(TypeError);
  });
  it('throws on unsafe sha (leading dash)', () => {
    expect(() => recordSubCheckpoint('id', 'EXECUTE', 'lint', '--evil', { persist: false }))
      .toThrow(TypeError);
  });
  it('accepts empty sha as "no-commit" marker', () => {
    const rec = recordSubCheckpoint('id', 'EXECUTE', 'lint', '', {
      state: { sessionId: 'id' }, persist: false,
    });
    expect(rec.sha).toBe('');
  });
});

describe('recordSubCheckpoint — persistence', () => {
  it('appends to state.subCheckpoints[] on first call', () => {
    const id = freshId('append');
    saveSession({ sessionId: id });
    const rec = recordSubCheckpoint(id, 'EXECUTE', 'lint', 'aaaa1');
    expect(rec.phase).toBe('EXECUTE');
    expect(rec.subStep).toBe('lint');
    expect(rec.sha).toBe('aaaa1');
    expect(typeof rec.ts).toBe('string');
    const loaded = loadSession(id);
    expect(loaded.subCheckpoints).toHaveLength(1);
    expect(loaded.subCheckpoints[0].subStep).toBe('lint');
  });

  it('appends multiple records preserving order', () => {
    const id = freshId('multi');
    saveSession({ sessionId: id });
    recordSubCheckpoint(id, 'EXECUTE', 'lint', 'aaaa');
    recordSubCheckpoint(id, 'EXECUTE', 'test', 'bbbb');
    recordSubCheckpoint(id, 'VERIFY', 'coverage', 'cccc');
    const loaded = loadSession(id);
    expect(loaded.subCheckpoints.map((r) => r.subStep)).toEqual(['lint', 'test', 'coverage']);
  });

  it('does not mutate v2 checkpoints[] slot', () => {
    const id = freshId('coexist');
    saveSession({ sessionId: id, checkpoints: [{ phase: 'P', sha: 'x', status: 'passed' }] });
    recordSubCheckpoint(id, 'EXECUTE', 'lint', 'aaaa');
    const loaded = loadSession(id);
    expect(loaded.checkpoints).toHaveLength(1);
    expect(loaded.checkpoints[0].sha).toBe('x');
  });
});

describe('listSubCheckpoints', () => {
  it('returns [] for empty sessionId', () => {
    expect(listSubCheckpoints('')).toEqual([]);
  });

  it('returns all sub-checkpoints when phase omitted', () => {
    const state = {
      sessionId: 'x',
      subCheckpoints: [
        { phase: 'A', subStep: 's1', sha: '', ts: 't' },
        { phase: 'B', subStep: 's2', sha: '', ts: 't' },
      ],
    };
    expect(listSubCheckpoints('x', undefined, { state })).toHaveLength(2);
  });

  it('filters by phase when provided', () => {
    const state = {
      sessionId: 'x',
      subCheckpoints: [
        { phase: 'A', subStep: 's1', sha: '', ts: 't' },
        { phase: 'B', subStep: 's2', sha: '', ts: 't' },
        { phase: 'A', subStep: 's3', sha: '', ts: 't' },
      ],
    };
    const out = listSubCheckpoints('x', 'A', { state });
    expect(out.map((r) => r.subStep)).toEqual(['s1', 's3']);
  });

  it('returns [] for non-string phase', () => {
    const state = { sessionId: 'x', subCheckpoints: [{ phase: 'A', subStep: 's', sha: '', ts: 't' }] };
    expect(listSubCheckpoints('x', 42, { state })).toEqual([]);
  });
});
