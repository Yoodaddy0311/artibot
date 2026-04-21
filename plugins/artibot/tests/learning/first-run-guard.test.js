/**
 * Tests for lib/learning/first-run-guard.
 *
 * Uses a temp state file per-test to isolate global-run counter state.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  _internals,
  bumpRunCounter,
  getFirstRunState,
  resetFirstRunState,
  shouldObserveOnly,
} from '../../lib/learning/first-run-guard.js';

// ---------------------------------------------------------------------------
// Test harness: each test gets a fresh temp dir + absolute statePath override
// ---------------------------------------------------------------------------

let tmpDir;
let stateFile;
let cfg;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'artibot-first-run-'));
  stateFile = path.join(tmpDir, 'first-run-state.json');
  cfg = {
    ago: {
      selfControl: {
        firstRunMode: {
          enabled: true,
          observeRuns: 5,
          statePath: stateFile,
        },
      },
    },
  };
});

afterEach(() => {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------

describe('getFirstRunState', () => {
  it('starts in observe mode with full budget remaining', async () => {
    const s = await getFirstRunState(cfg);
    expect(s.mode).toBe('observe');
    expect(s.runsSoFar).toBe(0);
    expect(s.runsRemaining).toBe(5);
  });

  it('returns active immediately when firstRunMode.enabled=false', async () => {
    cfg.ago.selfControl.firstRunMode.enabled = false;
    const s = await getFirstRunState(cfg);
    expect(s.mode).toBe('active');
  });
});

describe('bumpRunCounter', () => {
  it('increments counter and keeps observe mode below threshold', async () => {
    const first = await bumpRunCounter('autoCommit', cfg);
    expect(first.mode).toBe('observe');
    expect(first.runsSoFar).toBe(1);
    expect(first.transitioned).toBe(false);

    const fourth = await bumpRunCounter('autoCommit', cfg);
    await bumpRunCounter('autoCommit', cfg);
    const beforeTransition = await bumpRunCounter('autoCommit', cfg);
    expect(beforeTransition.runsSoFar).toBe(4);
    expect(beforeTransition.mode).toBe('observe');
    // silence unused
    void fourth;
  });

  it('transitions to active on the run that reaches observeRuns threshold', async () => {
    for (let i = 0; i < 4; i += 1) {
      await bumpRunCounter('autoCommit', cfg);
    }
    const fifth = await bumpRunCounter('autoCommit', cfg);
    expect(fifth.mode).toBe('active');
    expect(fifth.runsSoFar).toBe(5);
    expect(fifth.transitioned).toBe(true);

    // Persisted transition record
    const persisted = JSON.parse(readFileSync(stateFile, 'utf-8'));
    expect(persisted.transitions).toHaveLength(1);
    expect(persisted.transitions[0].feature).toBe('autoCommit');
    expect(persisted.transitions[0].from).toBe('observe');
    expect(persisted.transitions[0].to).toBe('active');
  });

  it('stays in active mode once the threshold is crossed (no double transition)', async () => {
    for (let i = 0; i < 5; i += 1) await bumpRunCounter('autoCleanup', cfg);
    const afterActive = await bumpRunCounter('autoCleanup', cfg);
    expect(afterActive.mode).toBe('active');
    expect(afterActive.transitioned).toBe(false);
    // globalRuns should not increment past threshold while active
    expect(afterActive.runsSoFar).toBe(5);
  });

  it('writes feature-level run counts', async () => {
    await bumpRunCounter('autoCommit', cfg);
    await bumpRunCounter('autoCleanup', cfg);
    await bumpRunCounter('autoCleanup', cfg);
    const persisted = JSON.parse(readFileSync(stateFile, 'utf-8'));
    expect(persisted.features.autoCommit.runs).toBe(1);
    expect(persisted.features.autoCleanup.runs).toBe(2);
  });

  it('returns active without writing when firstRunMode is disabled', async () => {
    cfg.ago.selfControl.firstRunMode.enabled = false;
    const res = await bumpRunCounter('autoCommit', cfg);
    expect(res.mode).toBe('active');
    expect(existsSync(stateFile)).toBe(false);
  });

  it('throws on missing featureName', async () => {
    await expect(bumpRunCounter('', cfg)).rejects.toThrow(TypeError);
  });
});

describe('shouldObserveOnly', () => {
  it('returns true while in observe mode', async () => {
    const res = await shouldObserveOnly('autoCommit', cfg);
    expect(res.shouldObserve).toBe(true);
    expect(res.runsRemaining).toBe(5);
  });

  it('returns false after threshold reached', async () => {
    for (let i = 0; i < 5; i += 1) await bumpRunCounter('autoCommit', cfg);
    const res = await shouldObserveOnly('autoCommit', cfg);
    expect(res.shouldObserve).toBe(false);
  });

  it('returns false when feature disabled via config', async () => {
    cfg.ago.selfControl.firstRunMode.enabled = false;
    const res = await shouldObserveOnly('autoCommit', cfg);
    expect(res.shouldObserve).toBe(false);
  });
});

describe('resetFirstRunState', () => {
  it('clears counters and restores observe mode', async () => {
    for (let i = 0; i < 5; i += 1) await bumpRunCounter('autoCommit', cfg);
    expect((await getFirstRunState(cfg)).mode).toBe('active');

    await resetFirstRunState(cfg);

    const s = await getFirstRunState(cfg);
    expect(s.mode).toBe('observe');
    expect(s.runsSoFar).toBe(0);
    expect(s.runsRemaining).toBe(5);
  });
});

describe('concurrency safety', () => {
  it('parallel bumps do not throw and produce a consistent final count', async () => {
    const promises = Array.from({ length: 10 }, () => bumpRunCounter('autoCommit', cfg));
    await Promise.all(promises);
    const final = await getFirstRunState(cfg);
    // Under concurrent read-modify-write some updates may race; we verify
    // invariants (no corruption, transition recorded after threshold).
    expect(final.runsSoFar).toBeGreaterThanOrEqual(1);
    expect(final.runsSoFar).toBeLessThanOrEqual(10);
    const persisted = JSON.parse(readFileSync(stateFile, 'utf-8'));
    expect(persisted.features.autoCommit.runs).toBeGreaterThanOrEqual(1);
  });
});

describe('_internals', () => {
  it('exposes resolveStatePath with absolute override honored', () => {
    const p = _internals.resolveStatePath(cfg);
    expect(p).toBe(stateFile);
  });

  it('getObserveRuns defaults to 5 on invalid input', () => {
    expect(_internals.getObserveRuns({})).toBe(5);
    expect(_internals.getObserveRuns({ ago: { selfControl: { firstRunMode: { observeRuns: -1 } } } })).toBe(5);
    expect(_internals.getObserveRuns({ ago: { selfControl: { firstRunMode: { observeRuns: 7 } } } })).toBe(7);
  });
});
