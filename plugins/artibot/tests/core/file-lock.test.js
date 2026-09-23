/**
 * In-process contract tests for withFileLock (fail-closed, O_EXCL).
 *
 * `node:fs` is mocked with pass-through spies: every call reaches the real
 * filesystem in a per-test temp dir unless a test injects a fault. So these
 * tests observe real lock files, and fault injection stays one line.
 *
 * Multi-process exclusion lives in file-lock-contention.test.js; signal
 * delivery in file-lock-signal.test.js. The ELOCKTIMEOUT cases below wait the
 * real LOCK_WAIT_MS (2s) each.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('node:fs', async () => {
  const actual = await vi.importActual('node:fs');
  const spied = { ...actual };
  for (const name of [
    'closeSync', 'mkdirSync', 'openSync', 'readFileSync', 'statSync', 'unlinkSync', 'writeSync',
  ]) {
    spied[name] = vi.fn(actual[name]);
  }
  return spied;
});

/** Unmocked fs, for seeding and inspecting files without touching the spies. */
const realFs = await vi.importActual('node:fs');

const SPIES = { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync };

const LOCK_WAIT_MS = 2000;
const HOST = os.hostname();

let withFileLock;
let tmpDir;
let target;
let lockPath;

/** Signals the module installs handlers for. */
const SIGNALS = ['SIGTERM', 'SIGINT'];

/** Listeners present before a test ran, so we can strip only what it added. */
let baselineListeners;

function captureBaselineListeners() {
  baselineListeners = new Map(
    SIGNALS.map((sig) => [sig, new Set(process.listeners(sig))]),
  );
}

/**
 * Remove listeners this test added. `vi.resetModules()` gives each test a
 * fresh module (and thus a fresh "handlers installed" flag) but does NOT
 * detach listeners already attached to the real `process`, so without this
 * they accumulate across the file and trip MaxListenersExceededWarning.
 */
function restoreBaselineListeners() {
  for (const sig of SIGNALS) {
    for (const listener of process.listeners(sig)) {
      if (!baselineListeners.get(sig).has(listener)) {
        process.removeListener(sig, listener);
      }
    }
  }
}

/** Listeners the module added on top of the baseline, for one signal. */
function addedListenerCount(sig) {
  return process.listeners(sig)
    .filter((l) => !baselineListeners.get(sig).has(l)).length;
}

/** @param {string} code */
function fsError(code) {
  return Object.assign(new Error(`${code}: injected`), { code });
}

/** Pid of a process that has already exited. */
function deadPid() {
  return spawnSync(process.execPath, ['-e', '']).pid;
}

/**
 * Write a lock file directly, optionally backdating its mtime.
 *
 * @param {string} content
 * @param {number} [ageMs]
 */
function seedLock(content, ageMs = 0) {
  realFs.writeFileSync(lockPath, content);
  if (ageMs > 0) {
    const when = new Date(Date.now() - ageMs);
    realFs.utimesSync(lockPath, when, when);
  }
}

/** Run `thunk`, returning the error it throws (or failing if it does not). */
function caught(thunk) {
  try {
    thunk();
  } catch (err) {
    return err;
  }
  throw new Error('expected a throw');
}

/** Wall-clock ms taken by `thunk` (its result/throw is re-surfaced). */
function timed(thunk) {
  const t0 = Date.now();
  let error;
  try { thunk(); } catch (err) { error = err; }
  return { ms: Date.now() - t0, error };
}

describe('file-lock', () => {
  beforeEach(async () => {
    captureBaselineListeners();
    for (const [name, spy] of Object.entries(SPIES)) {
      vi.mocked(spy).mockReset();
      vi.mocked(spy).mockImplementation(realFs[name]);
    }
    tmpDir = realFs.mkdtempSync(path.join(os.tmpdir(), 'artibot-lockunit-'));
    target = path.join(tmpDir, 'state.json');
    lockPath = `${target}.lock`;
    vi.resetModules();
    ({ withFileLock } = await import('../../lib/core/file-lock.js'));
  });

  afterEach(() => {
    restoreBaselineListeners();
    vi.restoreAllMocks();
    realFs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  // ─── Acquisition & Release ─────────────────────────────────────

  it('holds a lock record while fn runs and removes it afterwards', () => {
    let seen;
    const result = withFileLock(target, () => {
      seen = JSON.parse(realFs.readFileSync(lockPath, 'utf-8'));
      return 42;
    });

    expect(result).toBe(42);
    expect(seen).toMatchObject({ pid: process.pid, host: HOST });
    expect(typeof seen.token).toBe('string');
    expect(seen.token.length).toBeGreaterThan(0);
    expect(typeof seen.timestamp).toBe('number');
    expect(realFs.existsSync(lockPath)).toBe(false);
  });

  it('uses a fresh token for every acquisition', () => {
    const tokens = [1, 2].map(() => withFileLock(target, () => (
      JSON.parse(realFs.readFileSync(lockPath, 'utf-8')).token
    )));

    expect(tokens[0]).not.toBe(tokens[1]);
  });

  it('creates the parent directory for the lock file', () => {
    const nested = path.join(tmpDir, 'deep', 'nested', 'state.json');

    withFileLock(nested, () => {
      expect(realFs.existsSync(`${nested}.lock`)).toBe(true);
    });

    expect(mkdirSync).toHaveBeenCalledWith(path.dirname(nested), { recursive: true });
  });

  it('takes an uncontended lock with a single exclusive create', () => {
    withFileLock(target, () => {});

    const creates = vi.mocked(openSync).mock.calls.filter(([p]) => p === lockPath);
    expect(creates).toEqual([[lockPath, 'wx']]);
  });

  it('returns the value from fn', () => {
    expect(withFileLock(target, () => ({ data: 'hello' }))).toEqual({ data: 'hello' });
  });

  // ─── Stale Lock Reclaim ────────────────────────────────────────

  it('reclaims a same-host lock whose owner pid is dead', () => {
    seedLock(JSON.stringify({ pid: deadPid(), host: HOST, token: 'dead', timestamp: Date.now() }));

    const { ms, error } = timed(() => withFileLock(target, () => 'ok'));

    expect(error).toBeUndefined();
    expect(ms).toBeLessThan(1000);
    expect(realFs.existsSync(lockPath)).toBe(false);
    expect(realFs.existsSync(`${lockPath}.reclaim`)).toBe(false);
  });

  it('reclaims a lock record older than LOCK_STALE_MS even from another host', () => {
    seedLock(JSON.stringify({
      pid: process.pid, host: 'elsewhere', token: 'old', timestamp: Date.now() - 11_000,
    }));

    expect(withFileLock(target, () => 'ok')).toBe('ok');
    expect(realFs.existsSync(lockPath)).toBe(false);
  });

  it('reclaims an unparseable lock file only once its mtime is past LOCK_STALE_MS', () => {
    seedLock('{"pid":12', 11_000);

    expect(withFileLock(target, () => 'ok')).toBe('ok');
    expect(realFs.existsSync(lockPath)).toBe(false);
  });

  it('retries after a stale-lock unlink fails and still reclaims', () => {
    seedLock(JSON.stringify({ pid: deadPid(), host: HOST, token: 'dead', timestamp: Date.now() }));
    vi.mocked(unlinkSync).mockImplementationOnce(() => { throw fsError('EBUSY'); });

    expect(withFileLock(target, () => 'ok')).toBe('ok');
    expect(realFs.existsSync(lockPath)).toBe(false);
  });

  it('does not steal a live reclaim guard younger than LOCK_STALE_MS', () => {
    const staleLock = JSON.stringify({ pid: deadPid(), host: HOST, token: 'dead', timestamp: Date.now() });
    seedLock(staleLock);
    // A live reclaimer (this process's pid) that has held the guard for 3s —
    // longer than any sane read+unlink, still well inside LOCK_STALE_MS.
    const guard = JSON.stringify({
      pid: process.pid, host: HOST, token: 'guard', timestamp: Date.now() - 3000,
    });
    realFs.writeFileSync(`${lockPath}.reclaim`, guard);
    const fn = vi.fn();

    const error = caught(() => withFileLock(target, fn));

    expect(error.code).toBe('ELOCKTIMEOUT');
    expect(fn).not.toHaveBeenCalled();
    expect(realFs.readFileSync(`${lockPath}.reclaim`, 'utf-8')).toBe(guard);
    expect(realFs.readFileSync(lockPath, 'utf-8')).toBe(staleLock);
  }, 10_000);

  it('clears a reclaim guard older than LOCK_STALE_MS and reclaims', () => {
    seedLock(JSON.stringify({ pid: deadPid(), host: HOST, token: 'dead', timestamp: Date.now() }));
    realFs.writeFileSync(`${lockPath}.reclaim`, JSON.stringify({
      pid: process.pid, host: 'elsewhere', token: 'guard', timestamp: Date.now() - 11_000,
    }));

    const { ms, error } = timed(() => withFileLock(target, () => 'ok'));

    expect(error).toBeUndefined();
    expect(ms).toBeLessThan(900);
    expect(realFs.existsSync(`${lockPath}.reclaim`)).toBe(false);
    expect(realFs.existsSync(lockPath)).toBe(false);
  });

  it('polls, rather than spins on, a stale lock it cannot remove', () => {
    seedLock(JSON.stringify({ pid: deadPid(), host: HOST, token: 'dead', timestamp: Date.now() }));
    vi.mocked(unlinkSync).mockImplementation((p) => {
      if (String(p) === lockPath) throw fsError('EPERM');
      return realFs.unlinkSync(p);
    });

    const error = caught(() => withFileLock(target, () => 'never'));

    expect(error.code).toBe('ELOCKTIMEOUT');
    // Every failed reclaim is followed by a sleep of at least 10ms, so 2000ms
    // admits at most ~200 create attempts. A retry-at-once loop makes
    // thousands in the same time.
    const creates = vi.mocked(openSync).mock.calls.filter(([p]) => p === lockPath);
    expect(creates.length).toBeGreaterThan(5);
    expect(creates.length).toBeLessThanOrEqual(LOCK_WAIT_MS / 10 + 5);
  }, 10_000);

  it('clears a reclaim guard left by a dead reclaimer without waiting for its age', () => {
    seedLock(JSON.stringify({ pid: deadPid(), host: HOST, token: 'dead', timestamp: Date.now() }));
    realFs.writeFileSync(`${lockPath}.reclaim`, JSON.stringify({
      pid: deadPid(), host: HOST, token: 'guard', timestamp: Date.now(),
    }));

    const { ms, error } = timed(() => withFileLock(target, () => 'ok'));

    expect(error).toBeUndefined();
    expect(ms).toBeLessThan(900);
  });

  it('retries a transient EPERM create (Windows delete-pending) and acquires', () => {
    vi.mocked(openSync).mockImplementationOnce(() => { throw fsError('EPERM'); });

    expect(withFileLock(target, () => 'ok')).toBe('ok');
    const creates = vi.mocked(openSync).mock.calls.filter(([p]) => p === lockPath);
    expect(creates.length).toBe(2);
  });

  // ─── Fail-Closed: Contended Past LOCK_WAIT_MS ──────────────────

  it('throws ELOCKTIMEOUT without running fn and leaves a live holder\'s lock intact', () => {
    const holder = { pid: process.pid, host: HOST, token: 'live-holder', timestamp: Date.now() };
    const content = JSON.stringify(holder);
    seedLock(content);
    const fn = vi.fn();

    const { ms, error } = timed(() => withFileLock(target, fn));

    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe('ELOCKTIMEOUT');
    expect(error.lockPath).toBe(lockPath);
    expect(error.holder).toEqual(holder);
    expect(error.message).toContain(`${LOCK_WAIT_MS}ms`);
    expect(error.cause?.code).toBe('EEXIST');
    expect(ms).toBeGreaterThanOrEqual(LOCK_WAIT_MS);
    expect(ms).toBeLessThan(LOCK_WAIT_MS + 1500);
    expect(fn).not.toHaveBeenCalled();
    expect(realFs.readFileSync(lockPath, 'utf-8')).toBe(content);
    expect(addedListenerCount('SIGTERM')).toBe(0);
  }, 10_000);

  it('does not steal a fresh unparseable lock (holder mid-write): ELOCKTIMEOUT, holder null', () => {
    seedLock('{"pid":12');
    const fn = vi.fn();

    const error = caught(() => withFileLock(target, fn));

    expect(error.code).toBe('ELOCKTIMEOUT');
    expect(error.holder).toBeNull();
    expect(fn).not.toHaveBeenCalled();
    expect(realFs.readFileSync(lockPath, 'utf-8')).toBe('{"pid":12');
  }, 10_000);

  it('does not steal a lock it cannot read, however old it looks', () => {
    seedLock('', 60_000);
    vi.mocked(readFileSync).mockImplementation((p, ...rest) => {
      if (String(p) === lockPath) throw fsError('EACCES');
      return realFs.readFileSync(p, ...rest);
    });
    const fn = vi.fn();

    const error = caught(() => withFileLock(target, fn));

    expect(error.code).toBe('ELOCKTIMEOUT');
    expect(fn).not.toHaveBeenCalled();
    expect(realFs.existsSync(lockPath)).toBe(true);
  }, 10_000);

  it('does not unlink a lock that changed between the stale judgment and the reclaim', () => {
    const live = JSON.stringify({ pid: process.pid, host: HOST, token: 'new-owner', timestamp: Date.now() });
    seedLock(live);
    // The first read of the lock sees an old record; every later read sees
    // what is really on disk — as if the lock changed hands in between.
    const stale = JSON.stringify({ pid: 1, host: 'elsewhere', token: 'old', timestamp: Date.now() - 60_000 });
    let firstLockRead = true;
    vi.mocked(readFileSync).mockImplementation((p, ...rest) => {
      if (String(p) === lockPath && firstLockRead) {
        firstLockRead = false;
        return stale;
      }
      return realFs.readFileSync(p, ...rest);
    });

    const error = caught(() => withFileLock(target, () => 'never'));

    expect(error.code).toBe('ELOCKTIMEOUT');
    expect(vi.mocked(unlinkSync).mock.calls.filter(([p]) => p === lockPath)).toEqual([]);
    expect(realFs.readFileSync(lockPath, 'utf-8')).toBe(live);
  }, 10_000);

  // ─── Fail-Closed: Lock Cannot Be Created ───────────────────────

  it('rethrows a mkdir failure with its code and does not run fn', () => {
    vi.mocked(mkdirSync).mockImplementationOnce(() => { throw fsError('EACCES'); });
    const fn = vi.fn();

    const error = caught(() => withFileLock(target, fn));

    expect(error.code).toBe('EACCES');
    expect(fn).not.toHaveBeenCalled();
  });

  it('rethrows a non-contention create failure with its code and does not run fn', () => {
    vi.mocked(openSync).mockImplementationOnce(() => { throw fsError('EROFS'); });
    const fn = vi.fn();

    const error = caught(() => withFileLock(target, fn));

    expect(error.code).toBe('EROFS');
    expect(fn).not.toHaveBeenCalled();
    expect(addedListenerCount('SIGTERM')).toBe(0);
    expect(addedListenerCount('SIGINT')).toBe(0);
  });

  it('removes a half-created lock when writing the record fails', () => {
    vi.mocked(writeSync).mockImplementationOnce(() => { throw fsError('ENOSPC'); });
    const fn = vi.fn();

    const error = caught(() => withFileLock(target, fn));

    expect(error.code).toBe('ENOSPC');
    expect(fn).not.toHaveBeenCalled();
    expect(realFs.existsSync(lockPath)).toBe(false);
  });

  // ─── Exceptions & Release ──────────────────────────────────────

  it('propagates exceptions from fn', () => {
    expect(() => withFileLock(target, () => { throw new Error('fn-error'); })).toThrow('fn-error');
  });

  it('releases the lock even when fn throws', () => {
    try {
      withFileLock(target, () => { throw new Error('boom'); });
    } catch { /* expected */ }

    expect(realFs.existsSync(lockPath)).toBe(false);
  });

  it('leaves a lock that another owner put in place while fn ran', () => {
    const foreign = JSON.stringify({ pid: 424242, host: HOST, token: 'someone-else', timestamp: Date.now() });

    withFileLock(target, () => {
      realFs.unlinkSync(lockPath);
      realFs.writeFileSync(lockPath, foreign, { flag: 'wx' });
    });

    expect(realFs.readFileSync(lockPath, 'utf-8')).toBe(foreign);
  });

  it('swallows an unlink failure during release, leaving our own lock behind', () => {
    vi.mocked(unlinkSync).mockImplementationOnce(() => { throw fsError('EPERM'); });

    expect(withFileLock(target, () => 'ok')).toBe('ok');
    // Left for the stale rules to reclaim (dead pid once we exit).
    const left = JSON.parse(realFs.readFileSync(lockPath, 'utf-8'));
    expect(left).toMatchObject({ pid: process.pid, host: HOST });
  });

  it('leaves our own lock behind when release cannot read it back', () => {
    let token;
    const result = withFileLock(target, () => {
      token = JSON.parse(realFs.readFileSync(lockPath, 'utf-8')).token;
      vi.mocked(readFileSync).mockImplementation((p, ...rest) => {
        if (String(p) === lockPath) throw fsError('EBUSY');
        return realFs.readFileSync(p, ...rest);
      });
      return 'ok';
    });

    expect(result).toBe('ok');
    expect(JSON.parse(realFs.readFileSync(lockPath, 'utf-8')).token).toBe(token);
  });

  // ─── Re-entry ──────────────────────────────────────────────────

  it('refuses a same-path re-entry at once with ELOCKREENTRANT; the outer call completes and releases', () => {
    const innerFn = vi.fn();
    let innerError;
    let outerToken;
    let tokenAfterInner;

    const { ms, error } = timed(() => withFileLock(target, () => {
      outerToken = JSON.parse(realFs.readFileSync(lockPath, 'utf-8')).token;
      innerError = caught(() => withFileLock(target, innerFn));
      tokenAfterInner = JSON.parse(realFs.readFileSync(lockPath, 'utf-8')).token;
      return 'outer-done';
    }));

    expect(error).toBeUndefined();
    expect(innerError.code).toBe('ELOCKREENTRANT');
    expect(innerError.lockPath).toBe(lockPath);
    expect(innerFn).not.toHaveBeenCalled();
    // No wait: refused, not contended.
    expect(ms).toBeLessThan(500);
    // The outer lock was untouched by the refused inner call…
    expect(tokenAfterInner).toBe(outerToken);
    // …and released normally by the outer call.
    expect(realFs.existsSync(lockPath)).toBe(false);
  });

  it('lets the outer call see ELOCKREENTRANT propagate and still releases the lock', () => {
    const error = caught(() => withFileLock(target, () => {
      withFileLock(target, () => {});
    }));

    expect(error.code).toBe('ELOCKREENTRANT');
    expect(realFs.existsSync(lockPath)).toBe(false);
  });

  // ─── Signal Listener Lifecycle (A4) ───────────────────────────
  //
  // The listener pair is installed once per process and deliberately left
  // installed after release — see the rationale on installSignalHandlers().
  // The property under test is therefore "exactly one pair, never growing",
  // not "count returns to zero".

  it('installs exactly one listener per signal on first lock', () => {
    withFileLock(target, () => {});

    expect(addedListenerCount('SIGTERM')).toBe(1);
    expect(addedListenerCount('SIGINT')).toBe(1);
  });

  it('does not add listeners for repeated sequential locks', () => {
    withFileLock(path.join(tmpDir, 'a.json'), () => {});
    const after1 = addedListenerCount('SIGTERM');

    withFileLock(path.join(tmpDir, 'b.json'), () => {});
    withFileLock(path.join(tmpDir, 'c.json'), () => {});

    expect(after1).toBe(1);
    expect(addedListenerCount('SIGTERM')).toBe(1);
    expect(addedListenerCount('SIGINT')).toBe(1);
  });

  it('does not add listeners for nested locks on different paths', () => {
    withFileLock(path.join(tmpDir, 'outer.json'), () => {
      withFileLock(path.join(tmpDir, 'inner.json'), () => {
        expect(addedListenerCount('SIGTERM')).toBe(1);
      });
    });

    expect(addedListenerCount('SIGTERM')).toBe(1);
    expect(addedListenerCount('SIGINT')).toBe(1);
  });

  it('does not add listeners when a same-path re-entry is refused', () => {
    withFileLock(target, () => {
      try {
        withFileLock(target, () => {});
      } catch { /* ELOCKREENTRANT, pinned above */ }
    });

    expect(addedListenerCount('SIGTERM')).toBe(1);
    expect(addedListenerCount('SIGINT')).toBe(1);
  });

  it('does not add listeners when fn throws', () => {
    try {
      withFileLock(target, () => { throw new Error('boom'); });
    } catch { /* expected */ }

    expect(addedListenerCount('SIGTERM')).toBe(1);
  });
});
