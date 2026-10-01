/**
 * The autopilot store must outlive the plugin build that wrote it (O2, owner
 * decision D2 — the store root moves from `<pluginRoot>/runtime/autopilot` to
 * `resolveArtibotDir()/runtime/autopilot`).
 *
 * WHY THIS FILE EXISTS. Before D2 the store sat inside the plugin root, and the
 * plugin root is a version-scoped cache directory: `update.js#clearCache` removes
 * every stale `<cache>/artibot/artibot/<version>/` after an install, and a new
 * version starts with whatever the host copied in. Measured 2026-09-30 on the
 * owner's machine: the 4.68.0 / 4.69.0 / 4.70.0 cache directories each held their
 * OWN copy of the same sessions (mtime-identical, one of them diverged), and
 * `.artibot/guides/v5-design/MEASUREMENT-RUNBOOK.md` records the store shrinking
 * from 46 session ids to 10 after a cache deletion.
 *
 * WHAT IS SIMULATED. "A plugin version change" is two fake plugin roots under one
 * fake HOME — `<cache>/4.70.0` then `<cache>/4.71.0`. Every seam that could
 * rescue the old behaviour (`ARTIBOT_AUTOPILOT_STORE_DIR` and its pair,
 * `ARTIBOT_STATE_DIR` and its pair) is removed in `beforeEach`, because the
 * thing under test is the DEFAULT resolution. The real HOME is never touched:
 * both `USERPROFILE` and `HOME` are repointed, so `resolveArtibotDir()` resolves
 * under the sandbox.
 *
 * The adoption of sessions an OLDER build left behind is pinned separately, in
 * `legacy-store-adoption.test.js`; the locks such a build left behind in
 * `lock-legacy-adoption.test.js`; which project a session belongs to in
 * `session-project.test.js`.
 *
 * WHAT THIS FILE CANNOT SEE (rules §9):
 *   - Whether the host really copies a previous version directory forward. The
 *     identical mtimes in the cache say something does; the mechanism is not in
 *     this repository (install.sh / install.ps1 mirror scripts, hooks, lib,
 *     output-styles and schemas only).
 *   - Fixture size. These sessions are a few hundred bytes; the live ones are
 *     3-7 KB. Nothing here stresses copy cost or directory size.
 */

import {
  existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as store from '../../lib/autopilot/session-store.js';
import { acquireLock, isLocked, readLock } from '../../lib/autopilot/lock.js';
import { appendEvent, readEvents } from '../../lib/autopilot/telemetry.js';
import { appendLesson, getFeaturePath } from '../../lib/autopilot/memory.js';

/** Every variable that could move the store; saved, cleared, restored per test. */
const ENV_KEYS = [
  'CLAUDE_PLUGIN_ROOT',
  'ARTIBOT_AUTOPILOT_STORE_DIR',
  'ARTIBOT_AUTOPILOT_STORE_DIR_ROOT',
  'ARTIBOT_STATE_DIR',
  'ARTIBOT_STATE_DIR_HOME',
  'USERPROFILE',
  'HOME',
];

/** @type {Record<string, string|undefined>} */
let savedEnv;
let tmp;
let home;
let rootA;
let rootB;

/** A plugin root shaped enough for `getPluginRoot` to treat it as real. */
function makePluginRoot(dir) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'artibot.config.json'), '{}', 'utf-8');
  return dir;
}

/** Where the store must be, for the sandbox HOME. */
function expectedStore() {
  return path.join(home, '.claude', 'artibot', 'runtime', 'autopilot');
}

function useRoot(root) {
  process.env.CLAUDE_PLUGIN_ROOT = root;
}

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  tmp = mkdtempSync(path.join(os.tmpdir(), 'artibot-d2-'));
  home = path.join(tmp, 'home');
  mkdirSync(home, { recursive: true });
  rootA = makePluginRoot(path.join(tmp, 'cache', '4.70.0'));
  rootB = makePluginRoot(path.join(tmp, 'cache', '4.71.0'));
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  useRoot(rootA);
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  rmSync(tmp, { recursive: true, force: true });
});

describe('the store does not move with the plugin version', () => {
  it('resolves to <state dir>/runtime/autopilot under either plugin root', () => {
    useRoot(rootA);
    const underA = store.getStoreDir();
    useRoot(rootB);
    const underB = store.getStoreDir();
    expect(underA).toBe(expectedStore());
    expect(underB).toBe(underA);
  });

  it('keeps a session saved under one version visible under the next', () => {
    useRoot(rootA);
    store.saveSession({ sessionId: 'ap-survivor', task: 'survives an update', phase: 'EXECUTE' });

    useRoot(rootB);
    expect(store.listSessions()).toContain('ap-survivor');
    expect(store.loadSession('ap-survivor')?.task).toBe('survives an update');
  });

  it('keeps the session when the old version directory is deleted (clearCache)', () => {
    useRoot(rootA);
    store.saveSession({ sessionId: 'ap-after-prune', task: 'outlives its cache dir' });
    rmSync(rootA, { recursive: true, force: true });

    useRoot(rootB);
    expect(store.loadSession('ap-after-prune')?.task).toBe('outlives its cache dir');
  });

  it('moves the WHOLE store: events, locks and memory follow the same directory', () => {
    useRoot(rootA);
    appendEvent('ap-whole', { type: 'probe', message: 'from 4.70' });
    const held = acquireLock('whole-feature', 'ap-whole');
    expect(held.ok).toBe(true);
    appendLesson('whole-feature', { lesson: 'kept across versions', sessionId: 'ap-whole' });

    useRoot(rootB);
    expect(readEvents('ap-whole').map((e) => e.type)).toEqual(['probe']);
    // The lock is one namespace across versions, so a 4.71 process and a 4.70
    // process collide on the same feature instead of running it twice.
    expect(readLock('whole-feature')?.sessionId).toBe('ap-whole');
    expect(isLocked('whole-feature').locked).toBe(true);
    expect(acquireLock('whole-feature', 'ap-other').ok).toBe(false);
    expect(existsSync(getFeaturePath('whole-feature'))).toBe(true);
    expect(getFeaturePath('whole-feature').startsWith(expectedStore())).toBe(true);
  });

  it('follows ARTIBOT_STATE_DIR when it is paired with the home it was minted for', () => {
    const stateDir = path.join(tmp, 'elsewhere');
    process.env.ARTIBOT_STATE_DIR = stateDir;
    process.env.ARTIBOT_STATE_DIR_HOME = home;
    expect(store.getStoreDir()).toBe(path.join(stateDir, 'runtime', 'autopilot'));
  });

  it('discards an unpaired ARTIBOT_STATE_DIR (fail-closed, same rule as resolveArtibotDir)', () => {
    process.env.ARTIBOT_STATE_DIR = path.join(tmp, 'elsewhere');
    expect(store.getStoreDir()).toBe(expectedStore());
  });
});

describe('ARTIBOT_AUTOPILOT_STORE_DIR keeps its pairing', () => {
  it('honours the override only for the plugin root it was minted for', () => {
    const sandbox = path.join(tmp, 'sandbox-store');
    process.env.ARTIBOT_AUTOPILOT_STORE_DIR = sandbox;
    process.env.ARTIBOT_AUTOPILOT_STORE_DIR_ROOT = rootA;

    useRoot(rootA);
    expect(store.getStoreDir()).toBe(path.resolve(sandbox));
    // A child handed another plugin root drops the parent's override and lands in
    // the shared store, not in the parent's sandbox.
    useRoot(rootB);
    expect(store.getStoreDir()).toBe(expectedStore());
  });

  it('discards an override with no recorded root', () => {
    process.env.ARTIBOT_AUTOPILOT_STORE_DIR = path.join(tmp, 'sandbox-store');
    expect(store.getStoreDir()).toBe(expectedStore());
  });
});
