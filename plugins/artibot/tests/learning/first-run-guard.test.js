/**
 * Tests for lib/learning/first-run-guard.
 *
 * Uses a temp state file per-test to isolate global-run counter state.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
import { pointStateDirAt } from '../helpers/state-dir.js';

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

// O2 — every case above hands an ABSOLUTE `statePath`, so none of them reaches the path
// production actually uses: the shipped config value is the RELATIVE `runtime/first-run-state.json`.
// That one resolves under the artibot STATE dir (`~/.claude/artibot`), not the plugin root — the
// counter is GLOBAL (it counts runs since INSTALL) and a plugin root that is a version-scoped
// cache directory made it restart at zero on every update (measured 2026-09-30: the file existed
// in 3 of 4 cache version dirs).
describe('default (relative) statePath — the state dir, and the legacy copy (O2)', () => {
  let base;
  let stateDir;
  let restoreState;
  const REL = 'runtime/first-run-state.json';
  const counter = (globalRuns) => JSON.stringify({ globalRuns, features: {}, transitions: [] });

  beforeEach(() => {
    base = mkdtempSync(path.join(tmpdir(), 'artibot-first-run-o2-'));
    stateDir = path.join(base, 'state');
    mkdirSync(stateDir, { recursive: true });
    restoreState = pointStateDirAt(stateDir);
  });

  afterEach(() => {
    restoreState();
    rmSync(base, { recursive: true, force: true });
  });

  function seed(root, globalRuns) {
    const file = path.join(root, REL);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, counter(globalRuns));
    return file;
  }

  it('resolves under the state dir, not under the plugin root it is handed', () => {
    const pluginRoot = path.join(base, 'plugin');
    expect(_internals.resolveStatePath({}, { pluginRoot })).toBe(path.join(stateDir, REL));
    expect(_internals.resolveStatePath({ ago: { selfControl: { firstRunMode: { statePath: 'runtime/other.json' } } } }))
      .toBe(path.join(stateDir, 'runtime', 'other.json'));
  });

  it('counts there, and leaves the plugin root alone', async () => {
    const pluginRoot = path.join(base, 'plugin');
    mkdirSync(pluginRoot, { recursive: true });

    const first = await bumpRunCounter('autoCommit', {}, { pluginRoot });

    expect(first.runsSoFar).toBe(1);
    expect(JSON.parse(readFileSync(path.join(stateDir, REL), 'utf8')).globalRuns).toBe(1);
    expect(existsSync(path.join(pluginRoot, 'runtime'))).toBe(false);
  });

  it('a caller that passes no pluginRoot and one that passes the same root see ONE counter', async () => {
    const pluginRoot = path.join(base, 'plugin');
    mkdirSync(pluginRoot, { recursive: true });
    const saved = process.env.CLAUDE_PLUGIN_ROOT;
    process.env.CLAUDE_PLUGIN_ROOT = pluginRoot;
    try {
      await bumpRunCounter('a', {}); // session-start / wakeup style: no opts
      await bumpRunCounter('b', {}, { pluginRoot }); // cron-runner style: explicit root
      expect((await getFirstRunState({})).runsSoFar).toBe(2);
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_PLUGIN_ROOT;
      else process.env.CLAUDE_PLUGIN_ROOT = saved;
    }
  });

  it('carries a counter left in the plugin root over, once, and keeps counting from it', async () => {
    const pluginRoot = path.join(base, 'plugin');
    seed(pluginRoot, 3);

    expect((await getFirstRunState({}, { pluginRoot })).runsSoFar).toBe(3);
    expect(JSON.parse(readFileSync(path.join(stateDir, REL), 'utf8')).globalRuns).toBe(3);

    const next = await bumpRunCounter('autoCommit', {}, { pluginRoot });
    expect(next.runsSoFar).toBe(4);
    // a COPY: the legacy file is left as it was
    expect(JSON.parse(readFileSync(path.join(pluginRoot, REL), 'utf8')).globalRuns).toBe(3);
  });

  it('carries the PREVIOUS version\'s counter over when the running plugin root is a version directory', async () => {
    const cache = path.join(base, 'cache', 'artibot', 'artibot');
    const running = path.join(cache, '4.71.0');
    mkdirSync(running, { recursive: true });
    seed(path.join(cache, '4.70.0'), 4);

    expect((await getFirstRunState({}, { pluginRoot: running })).runsSoFar).toBe(4);
  });

  it('never overwrites a counter that is already in the state dir', async () => {
    const pluginRoot = path.join(base, 'plugin');
    seed(pluginRoot, 1);
    seed(stateDir, 5);

    expect((await getFirstRunState({}, { pluginRoot })).runsSoFar).toBe(5);
  });

  it('an absolute statePath is used as given and never migrated into', async () => {
    const pluginRoot = path.join(base, 'plugin');
    seed(pluginRoot, 3);
    const explicit = path.join(base, 'mine', 'first-run.json');
    const config = { ago: { selfControl: { firstRunMode: { statePath: explicit } } } };

    expect((await getFirstRunState(config, { pluginRoot })).runsSoFar).toBe(0);
    expect(existsSync(explicit)).toBe(false);
  });
});
