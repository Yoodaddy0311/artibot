/**
 * Tests for lib/autopilot/failure-memory.js (v4.11.0 Track K).
 * Covers repo-hash stability, record/dedup/LRU, recall scoring, prune TTL,
 * atomic-write resilience, and Korean-path safety via os.homedir().
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  computeRepoHash,
  DEFAULT_MAX_AGE_MS,
  DEFAULT_MAX_ENTRIES,
  FAILURE_MEMORY_SCHEMA_VERSION,
  getMemoryPath,
  pruneOldMemory,
  recallRelevantFailures,
  recordFailureMemory,
} from '../../lib/autopilot/failure-memory.js';

let storeDir;

beforeEach(() => {
  storeDir = mkdtempSync(path.join(tmpdir(), 'artibot-failmem-'));
});

afterEach(() => {
  try { rmSync(storeDir, { recursive: true, force: true }); } catch { /* noop */ }
});

const HASH_A = 'a'.repeat(40);
const HASH_B = 'b'.repeat(40);

function makeCluster(overrides = {}) {
  return {
    signature: overrides.signature ?? 'log::enoent <PATH>',
    count: overrides.count ?? 3,
    firstSeen: overrides.firstSeen ?? '2026-05-10T00:00:00.000Z',
    lastSeen: overrides.lastSeen ?? '2026-05-11T00:00:00.000Z',
    sampleMessage: overrides.sampleMessage ?? 'ENOENT: missing file foo.js',
    sessions: overrides.sessions ?? ['s-1'],
  };
}

describe('computeRepoHash', () => {
  it('returns a 40-char sha1 hex string', () => {
    const h = computeRepoHash('/some/path', { remoteResolver: () => '' });
    expect(h).toMatch(/^[0-9a-f]{40}$/);
  });

  it('is stable for the same cwd', () => {
    const a = computeRepoHash('/repo', { remoteResolver: () => '' });
    const b = computeRepoHash('/repo', { remoteResolver: () => '' });
    expect(a).toBe(b);
  });

  it('prefers git remote over cwd when present', () => {
    const remote = 'git@github.com:Yoodaddy0311/artibot.git';
    const onMachineA = computeRepoHash('/home/a/repo', { remoteResolver: () => remote });
    const onMachineB = computeRepoHash('/Users/b/repo', { remoteResolver: () => remote });
    expect(onMachineA).toBe(onMachineB);
  });

  it('differs when remote differs', () => {
    const a = computeRepoHash('/x', { remoteResolver: () => 'git@github.com:x/a.git' });
    const b = computeRepoHash('/x', { remoteResolver: () => 'git@github.com:x/b.git' });
    expect(a).not.toBe(b);
  });

  it('falls back to cwd path when no remote', () => {
    const a = computeRepoHash('/path/x', { remoteResolver: () => '' });
    const b = computeRepoHash('/path/y', { remoteResolver: () => '' });
    expect(a).not.toBe(b);
  });

  it('handles Korean cwd paths safely', () => {
    const koreanPath = '/Users/u/바탕 화면/artibot';
    const h = computeRepoHash(koreanPath, { remoteResolver: () => '' });
    expect(h).toMatch(/^[0-9a-f]{40}$/);
  });

  it('returns deterministic hash for empty cwd', () => {
    const a = computeRepoHash('', { remoteResolver: () => '' });
    const b = computeRepoHash('', { remoteResolver: () => '' });
    expect(a).toBe(b);
  });
});

describe('getMemoryPath', () => {
  it('throws on invalid hash', () => {
    expect(() => getMemoryPath('not-a-hash')).toThrow(TypeError);
    expect(() => getMemoryPath('')).toThrow(TypeError);
    expect(() => getMemoryPath(null)).toThrow(TypeError);
  });

  it('honours storeDir override and ends with .json', () => {
    const p = getMemoryPath(HASH_A, { storeDir });
    expect(p.startsWith(storeDir)).toBe(true);
    expect(p.endsWith(`${HASH_A}.json`)).toBe(true);
  });
});

describe('recordFailureMemory', () => {
  it('creates a new file with schema version stamped', () => {
    const r = recordFailureMemory(HASH_A, makeCluster(), { storeDir });
    expect(r.written).toBe(true);
    expect(r.total).toBe(1);
    const file = getMemoryPath(HASH_A, { storeDir });
    expect(existsSync(file)).toBe(true);
    const state = JSON.parse(readFileSync(file, 'utf-8'));
    expect(state.version).toBe(FAILURE_MEMORY_SCHEMA_VERSION);
    expect(state.entries).toHaveLength(1);
  });

  it('dedups by signature and bumps count', () => {
    recordFailureMemory(HASH_A, makeCluster({ count: 3 }), { storeDir });
    const r = recordFailureMemory(HASH_A, makeCluster({ count: 2 }), { storeDir });
    expect(r.total).toBe(1);
    const state = JSON.parse(readFileSync(getMemoryPath(HASH_A, { storeDir }), 'utf-8'));
    expect(state.entries[0].count).toBe(5);
  });

  it('merges sessions across recordings', () => {
    recordFailureMemory(HASH_A, makeCluster({ sessions: ['s-1'] }), { storeDir });
    recordFailureMemory(HASH_A, makeCluster({ sessions: ['s-2', 's-1'] }), { storeDir });
    const state = JSON.parse(readFileSync(getMemoryPath(HASH_A, { storeDir }), 'utf-8'));
    expect(state.entries[0].sessions).toEqual(['s-1', 's-2']);
  });

  it('refreshes updatedAt on every record', () => {
    const now1 = () => new Date('2026-05-01T00:00:00.000Z');
    const now2 = () => new Date('2026-05-15T00:00:00.000Z');
    recordFailureMemory(HASH_A, makeCluster(), { storeDir, now: now1 });
    recordFailureMemory(HASH_A, makeCluster(), { storeDir, now: now2 });
    const state = JSON.parse(readFileSync(getMemoryPath(HASH_A, { storeDir }), 'utf-8'));
    expect(state.entries[0].updatedAt).toBe('2026-05-15T00:00:00.000Z');
  });

  it('preserves firstSeen across merges', () => {
    recordFailureMemory(HASH_A, makeCluster({ firstSeen: '2026-04-01T00:00:00.000Z' }), { storeDir });
    recordFailureMemory(HASH_A, makeCluster({ firstSeen: '2026-05-01T00:00:00.000Z' }), { storeDir });
    const state = JSON.parse(readFileSync(getMemoryPath(HASH_A, { storeDir }), 'utf-8'));
    expect(state.entries[0].firstSeen).toBe('2026-04-01T00:00:00.000Z');
  });

  it('returns written:false on malformed cluster', () => {
    expect(recordFailureMemory(HASH_A, null, { storeDir }).written).toBe(false);
    expect(recordFailureMemory(HASH_A, {}, { storeDir }).written).toBe(false);
    expect(recordFailureMemory(HASH_A, { signature: '' }, { storeDir }).written).toBe(false);
  });

  it('enforces LRU cap evicting oldest updatedAt', () => {
    const maxEntries = 3;
    for (let i = 0; i < 4; i += 1) {
      const now = () => new Date(`2026-05-${10 + i}T00:00:00.000Z`);
      recordFailureMemory(HASH_A, makeCluster({ signature: `sig-${i}` }), { storeDir, now, maxEntries });
    }
    const state = JSON.parse(readFileSync(getMemoryPath(HASH_A, { storeDir }), 'utf-8'));
    expect(state.entries).toHaveLength(maxEntries);
    const sigs = state.entries.map((e) => e.signature).sort();
    expect(sigs).not.toContain('sig-0');
  });

  it('reports evicted count in return value', () => {
    const maxEntries = 2;
    recordFailureMemory(HASH_A, makeCluster({ signature: 'a' }), { storeDir, now: () => new Date('2026-05-01T00:00:00Z'), maxEntries });
    recordFailureMemory(HASH_A, makeCluster({ signature: 'b' }), { storeDir, now: () => new Date('2026-05-02T00:00:00Z'), maxEntries });
    const r = recordFailureMemory(HASH_A, makeCluster({ signature: 'c' }), { storeDir, now: () => new Date('2026-05-03T00:00:00Z'), maxEntries });
    expect(r.evicted).toBe(1);
    expect(r.total).toBe(2);
  });

  it('isolates per-repo files', () => {
    recordFailureMemory(HASH_A, makeCluster({ signature: 'a' }), { storeDir });
    recordFailureMemory(HASH_B, makeCluster({ signature: 'b' }), { storeDir });
    const stateA = JSON.parse(readFileSync(getMemoryPath(HASH_A, { storeDir }), 'utf-8'));
    const stateB = JSON.parse(readFileSync(getMemoryPath(HASH_B, { storeDir }), 'utf-8'));
    expect(stateA.entries[0].signature).toBe('a');
    expect(stateB.entries[0].signature).toBe('b');
  });

  it('uses DEFAULT_MAX_ENTRIES when no override given', () => {
    expect(DEFAULT_MAX_ENTRIES).toBe(100);
  });

  it('recovers from corrupt file by treating it as empty', () => {
    const file = getMemoryPath(HASH_A, { storeDir });
    writeFileSync(file, '{not valid json', 'utf-8');
    const r = recordFailureMemory(HASH_A, makeCluster(), { storeDir });
    expect(r.written).toBe(true);
    expect(r.total).toBe(1);
  });

  it('atomic write leaves no .tmp leftover on success', () => {
    recordFailureMemory(HASH_A, makeCluster(), { storeDir });
    const files = readdirSync(storeDir);
    expect(files.some((f) => f.includes('.tmp.'))).toBe(false);
  });
});

describe('recallRelevantFailures', () => {
  beforeEach(() => {
    recordFailureMemory(HASH_A, makeCluster({
      signature: 'log::enoent missing module',
      sampleMessage: 'ENOENT: missing module foo',
      count: 5,
    }), { storeDir });
    recordFailureMemory(HASH_A, makeCluster({
      signature: 'log::typeerror undefined',
      sampleMessage: 'TypeError: cannot read property of undefined',
      count: 3,
    }), { storeDir });
    recordFailureMemory(HASH_A, makeCluster({
      signature: 'log::lint failure',
      sampleMessage: 'eslint reported 5 errors',
      count: 2,
    }), { storeDir });
  });

  it('returns [] for empty prompt', () => {
    expect(recallRelevantFailures(HASH_A, '', { storeDir })).toEqual([]);
    expect(recallRelevantFailures(HASH_A, '   ', { storeDir })).toEqual([]);
  });

  it('returns [] when no file exists', () => {
    expect(recallRelevantFailures(HASH_B, 'enoent', { storeDir })).toEqual([]);
  });

  it('returns entries matching prompt keywords', () => {
    const r = recallRelevantFailures(HASH_A, 'fix the enoent missing module bug', { storeDir });
    expect(r.length).toBeGreaterThan(0);
    expect(r[0].signature).toContain('enoent');
  });

  it('returns [] when no token overlap', () => {
    const r = recallRelevantFailures(HASH_A, 'xyz qrs vwu', { storeDir });
    expect(r).toEqual([]);
  });

  it('sorts by overlap then count', () => {
    const r = recallRelevantFailures(HASH_A, 'enoent typeerror lint', { storeDir });
    expect(r.length).toBeGreaterThan(1);
    for (let i = 1; i < r.length; i += 1) {
      const prev = r[i - 1];
      const cur = r[i];
      expect(prev.overlap >= cur.overlap).toBe(true);
    }
  });

  it('honours limit option', () => {
    const r = recallRelevantFailures(HASH_A, 'enoent typeerror lint', { storeDir, limit: 1 });
    expect(r).toHaveLength(1);
  });

  it('defaults to top 3', () => {
    const r = recallRelevantFailures(HASH_A, 'enoent typeerror lint', { storeDir });
    expect(r.length).toBeLessThanOrEqual(3);
  });

  it('includes overlap field on each returned entry', () => {
    const r = recallRelevantFailures(HASH_A, 'enoent module', { storeDir });
    expect(r[0]).toHaveProperty('overlap');
    expect(r[0].overlap).toBeGreaterThan(0);
  });
});

describe('pruneOldMemory', () => {
  it('returns 0/0 when file missing', () => {
    expect(pruneOldMemory(HASH_A, 1000, { storeDir })).toEqual({ pruned: 0, remaining: 0 });
  });

  it('removes entries older than maxAge', () => {
    const oldNow = () => new Date('2026-01-01T00:00:00.000Z');
    const newNow = () => new Date('2026-05-15T00:00:00.000Z');
    recordFailureMemory(HASH_A, makeCluster({ signature: 'old' }), { storeDir, now: oldNow });
    recordFailureMemory(HASH_A, makeCluster({ signature: 'new' }), { storeDir, now: newNow });
    const fakeNow = () => new Date('2026-05-16T00:00:00.000Z');
    const r = pruneOldMemory(HASH_A, 30 * 24 * 60 * 60 * 1000, { storeDir, now: fakeNow });
    expect(r.pruned).toBe(1);
    expect(r.remaining).toBe(1);
  });

  it('keeps everything when nothing is past cutoff', () => {
    recordFailureMemory(HASH_A, makeCluster(), { storeDir });
    const r = pruneOldMemory(HASH_A, DEFAULT_MAX_AGE_MS, { storeDir });
    expect(r.pruned).toBe(0);
  });

  it('uses default 90-day TTL', () => {
    expect(DEFAULT_MAX_AGE_MS).toBe(90 * 24 * 60 * 60 * 1000);
  });

  it('does not rewrite file when no entries pruned', () => {
    recordFailureMemory(HASH_A, makeCluster(), { storeDir });
    const file = getMemoryPath(HASH_A, { storeDir });
    const before = statSync(file).mtimeMs;
    const r = pruneOldMemory(HASH_A, DEFAULT_MAX_AGE_MS, { storeDir });
    expect(r.pruned).toBe(0);
    const after = statSync(file).mtimeMs;
    expect(after).toBe(before);
  });
});
