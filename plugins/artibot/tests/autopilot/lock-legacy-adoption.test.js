/**
 * Locks across the store move (O2, owner decision D2).
 *
 * The store moved from `<pluginRoot>/runtime/autopilot` to the user-state dir, so
 * a lock an OLDER build is still holding sits where the new build no longer
 * looks. Two wrong answers are available and both are tested against here:
 *
 *   - ignore the legacy locks entirely: a pre-upgrade process that is still
 *     running keeps its feature, and a post-upgrade process starts the same
 *     feature a second time;
 *   - copy every legacy lock forward: the 26 lock files measured in the owner's
 *     checkout on 2026-09-30 would be 26 stale locks carried into a clean store,
 *     and a lock whose pid has since been reused would read as live for 24 hours.
 *
 * The rule implemented and pinned here is the third one: adopt a legacy lock ONLY
 * if `lock.js`'s own staleness rule (`isStale`: dead pid, older than 24h, holder
 * session terminal or leaked past its grace window) says it is live, and never
 * overwrite a holder the new store already has. Nothing is ever written to or
 * deleted from the legacy directory.
 *
 * WHAT THIS FILE CANNOT SEE (rules §9):
 *   - A legacy lock created AFTER this process's first lock call. Adoption is a
 *     one-time transition aid per process, not a continuous parallel reader; an
 *     old-version window started later is invisible until the next process.
 *   - A real second process holding a real lock. The "live" holder here is THIS
 *     process (pid alive by construction), so pid liveness is exercised through
 *     `process.kill(pid, 0)` on a pid that exists and on one that cannot.
 *   - The old process ever learning about the new store's locks: an old build
 *     cannot be changed, so exclusion across the boundary is one-directional.
 */

import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireLock, isLocked, listLocks, readLock } from '../../lib/autopilot/lock.js';
import { getStoreDir } from '../../lib/autopilot/session-store.js';

const ENV_KEYS = [
  'CLAUDE_PLUGIN_ROOT',
  'ARTIBOT_AUTOPILOT_STORE_DIR',
  'ARTIBOT_AUTOPILOT_STORE_DIR_ROOT',
  'ARTIBOT_STATE_DIR',
  'ARTIBOT_STATE_DIR_HOME',
  'USERPROFILE',
  'HOME',
];

/** A pid no process can have — `process.kill(pid, 0)` answers ESRCH. */
const DEAD_PID = 99999999;

/** @type {Record<string, string|undefined>} */
let savedEnv;
let tmp;
let home;
let root;

function newStoreLocks() {
  return path.join(home, '.claude', 'artibot', 'runtime', 'autopilot', 'locks');
}

function legacyDir() {
  return path.join(root, 'runtime', 'autopilot');
}

function legacyLocks() {
  return path.join(legacyDir(), 'locks');
}

/** A session file at the OLD place, so `isStale` can judge the holder's session. */
function writeLegacySession(id, phase) {
  mkdirSync(legacyDir(), { recursive: true });
  writeFileSync(path.join(legacyDir(), `${id}.json`), JSON.stringify({ sessionId: id, phase }), 'utf-8');
}

/** A lock file at the OLD place. */
function writeLegacyLock(name, holder) {
  mkdirSync(legacyLocks(), { recursive: true });
  const file = path.join(legacyLocks(), name);
  writeFileSync(file, JSON.stringify({ pid: process.pid, acquiredAt: Date.now(), ...holder }), 'utf-8');
  return file;
}

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  tmp = mkdtempSync(path.join(os.tmpdir(), 'artibot-lockadopt-'));
  home = path.join(tmp, 'home');
  root = path.join(tmp, 'cache', '4.71.0');
  mkdirSync(home, { recursive: true });
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, 'artibot.config.json'), '{}', 'utf-8');
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  process.env.CLAUDE_PLUGIN_ROOT = root;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  rmSync(tmp, { recursive: true, force: true });
});

describe('a LIVE legacy lock is honoured', () => {
  it('blocks an acquire for the same feature, and is reported with its holder', () => {
    writeLegacySession('ap-old-run', 'EXECUTE');
    writeLegacyLock('feat-live.lock', { sessionId: 'ap-old-run', featureKey: 'feat-live' });

    const status = isLocked('feat-live');
    expect(status.locked).toBe(true);
    expect(status.holder?.sessionId).toBe('ap-old-run');

    const attempt = acquireLock('feat-live', 'ap-new-run');
    expect(attempt.ok).toBe(false);
    expect(attempt.holder?.sessionId).toBe('ap-old-run');
  });

  it('is carried into the new store, byte for byte, so every later reader sees it there', () => {
    writeLegacySession('ap-old-run', 'EXECUTE');
    const src = writeLegacyLock('feat-copied.lock', { sessionId: 'ap-old-run', featureKey: 'feat-copied' });

    isLocked('feat-copied');

    const copied = path.join(newStoreLocks(), 'feat-copied.lock');
    expect(readFileSync(copied, 'utf-8')).toBe(readFileSync(src, 'utf-8'));
    expect(readLock('feat-copied')?.sessionId).toBe('ap-old-run');
  });

  it('carries a repo-scoped lock under the same file name', () => {
    writeLegacySession('ap-scoped', 'EXECUTE');
    writeLegacyLock('example-repo-a__feat-scoped.lock', {
      sessionId: 'ap-scoped', featureKey: 'feat-scoped', repoIdentity: 'example/repo-a',
    });

    const status = isLocked('feat-scoped', { repoIdentity: 'example/repo-a' });

    expect(status.locked).toBe(true);
    expect(status.holder?.sessionId).toBe('ap-scoped');
  });

  it('is honoured when the holder session is missing but the lock is still inside its grace window', () => {
    // The same protection `lock.test.js` pins for the native store: the
    // acquire -> persist race must not read as a leak.
    writeLegacyLock('feat-grace.lock', { sessionId: 'ap-not-persisted-yet', featureKey: 'feat-grace', acquiredAt: Date.now() });

    expect(isLocked('feat-grace').locked).toBe(true);
  });

  it('shows up in listLocks, which preflight uses to find same-repository peers', () => {
    writeLegacySession('ap-peer', 'EXECUTE');
    writeLegacyLock('feat-peer.lock', { sessionId: 'ap-peer', featureKey: 'feat-peer' });

    const mine = listLocks().filter((l) => l.holder.sessionId === 'ap-peer');

    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ lockKey: 'feat-peer', stale: false });
  });
});

describe('a STALE legacy lock is never carried forward', () => {
  it('drops a lock whose pid is dead', () => {
    writeLegacySession('ap-dead', 'EXECUTE');
    writeLegacyLock('feat-dead.lock', { sessionId: 'ap-dead', featureKey: 'feat-dead', pid: DEAD_PID });

    expect(isLocked('feat-dead').locked).toBe(false);
    expect(existsSync(path.join(newStoreLocks(), 'feat-dead.lock'))).toBe(false);
    expect(acquireLock('feat-dead', 'ap-new').ok).toBe(true);
  });

  it('drops a lock older than 24 hours, even with a live pid', () => {
    writeLegacySession('ap-old', 'EXECUTE');
    writeLegacyLock('feat-old.lock', {
      sessionId: 'ap-old', featureKey: 'feat-old', acquiredAt: Date.now() - 25 * 60 * 60 * 1000,
    });

    expect(isLocked('feat-old').locked).toBe(false);
    expect(existsSync(path.join(newStoreLocks(), 'feat-old.lock'))).toBe(false);
  });

  it('drops a lock whose holder session is in a terminal phase, even with a live pid', () => {
    writeLegacySession('ap-finished', 'COMPLETED');
    writeLegacyLock('feat-finished.lock', { sessionId: 'ap-finished', featureKey: 'feat-finished' });

    expect(isLocked('feat-finished').locked).toBe(false);
    expect(existsSync(path.join(newStoreLocks(), 'feat-finished.lock'))).toBe(false);
  });

  it('drops a leaked lock: holder session gone and the grace window over', () => {
    writeLegacyLock('feat-leaked.lock', {
      sessionId: 'ap-never-persisted', featureKey: 'feat-leaked', acquiredAt: Date.now() - 120 * 1000,
    });

    expect(isLocked('feat-leaked').locked).toBe(false);
    expect(existsSync(path.join(newStoreLocks(), 'feat-leaked.lock'))).toBe(false);
  });

  it('skips a corrupt lock file without copying or deleting it', () => {
    mkdirSync(legacyLocks(), { recursive: true });
    const corrupt = path.join(legacyLocks(), 'feat-corrupt.lock');
    writeFileSync(corrupt, '{ not json', 'utf-8');

    expect(isLocked('feat-corrupt').locked).toBe(false);
    expect(existsSync(path.join(newStoreLocks(), 'feat-corrupt.lock'))).toBe(false);
    expect(readFileSync(corrupt, 'utf-8')).toBe('{ not json');
  });

  it('carries nothing of a whole directory of stale locks (the owner checkout had 26)', () => {
    for (let i = 0; i < 12; i += 1) {
      writeLegacySession(`ap-gone-${i}`, 'ABORTED');
      writeLegacyLock(`feat-gone-${i}.lock`, { sessionId: `ap-gone-${i}`, featureKey: `feat-gone-${i}` });
    }

    expect(listLocks()).toEqual([]);
    expect(existsSync(newStoreLocks()) ? readdirSync(newStoreLocks()) : []).toEqual([]);
  });
});

describe('the existing staleness rules still govern an adopted lock', () => {
  it('reclaims it once its pid dies', () => {
    writeLegacySession('ap-will-die', 'EXECUTE');
    writeLegacyLock('feat-will-die.lock', { sessionId: 'ap-will-die', featureKey: 'feat-will-die' });
    expect(isLocked('feat-will-die').locked).toBe(true);

    // The holder exits: the copy in the new store now names a dead pid.
    const copy = path.join(newStoreLocks(), 'feat-will-die.lock');
    const holder = JSON.parse(readFileSync(copy, 'utf-8'));
    writeFileSync(copy, JSON.stringify({ ...holder, pid: DEAD_PID }), 'utf-8');

    expect(isLocked('feat-will-die')).toMatchObject({ locked: false, stale: true });
    expect(acquireLock('feat-will-die', 'ap-successor').ok).toBe(true);
    expect(readLock('feat-will-die')?.sessionId).toBe('ap-successor');
  });
});

describe('what adoption must not do', () => {
  it('never overwrites a holder the new store already has', () => {
    writeLegacySession('ap-old', 'EXECUTE');
    writeLegacyLock('feat-contested.lock', { sessionId: 'ap-old', featureKey: 'feat-contested' });
    // A native holder, written before anything touches the store.
    mkdirSync(newStoreLocks(), { recursive: true });
    const native = path.join(newStoreLocks(), 'feat-contested.lock');
    writeFileSync(native, JSON.stringify({
      pid: process.pid, sessionId: 'ap-native', acquiredAt: Date.now(), featureKey: 'feat-contested',
    }), 'utf-8');

    isLocked('feat-contested');

    expect(JSON.parse(readFileSync(native, 'utf-8')).sessionId).toBe('ap-native');
  });

  it('leaves the legacy directory exactly as it found it', () => {
    writeLegacySession('ap-untouched', 'EXECUTE');
    const live = writeLegacyLock('feat-untouched.lock', { sessionId: 'ap-untouched', featureKey: 'feat-untouched' });
    const stale = writeLegacyLock('feat-stale.lock', { sessionId: 'ap-untouched', featureKey: 'feat-stale', pid: DEAD_PID });
    const before = [live, stale].map((f) => ({ f, bytes: readFileSync(f, 'utf-8'), mtimeMs: statSync(f).mtimeMs }));

    isLocked('feat-untouched');
    acquireLock('feat-stale', 'ap-reclaimer');

    for (const { f, bytes, mtimeMs } of before) {
      expect(readFileSync(f, 'utf-8')).toBe(bytes);
      expect(statSync(f).mtimeMs).toBe(mtimeMs);
    }
  });

  it('is skipped while an honoured ARTIBOT_AUTOPILOT_STORE_DIR redirects the store', () => {
    writeLegacySession('ap-real', 'EXECUTE');
    writeLegacyLock('feat-real.lock', { sessionId: 'ap-real', featureKey: 'feat-real' });
    process.env.ARTIBOT_AUTOPILOT_STORE_DIR = path.join(tmp, 'sandbox-store');
    process.env.ARTIBOT_AUTOPILOT_STORE_DIR_ROOT = root;

    // A sandbox is hermetic: a real holder must not be able to block it.
    expect(isLocked('feat-real').locked).toBe(false);
    expect(acquireLock('feat-real', 'ap-sandboxed').ok).toBe(true);
    expect(existsSync(path.join(getStoreDir(), 'locks', 'feat-real.lock'))).toBe(true);
    expect(JSON.parse(readFileSync(path.join(getStoreDir(), 'locks', 'feat-real.lock'), 'utf-8')).sessionId)
      .toBe('ap-sandboxed');
  });

  it('does nothing, and does not throw, when there is no legacy locks directory', () => {
    expect(() => isLocked('feat-none')).not.toThrow();
    expect(isLocked('feat-none')).toEqual({ locked: false });
    expect(acquireLock('feat-none', 'ap-first').ok).toBe(true);
  });
});
