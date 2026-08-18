import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';

vi.mock('node:fs', async () => {
  const actual = await vi.importActual('node:fs');
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => '{}'),
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

let withFileLock;

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

describe('file-lock', () => {
  beforeEach(async () => {
    captureBaselineListeners();
    vi.resetModules();
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(readFileSync).mockReturnValue('{}');
    vi.mocked(writeFileSync).mockImplementation(() => {});
    vi.mocked(unlinkSync).mockImplementation(() => {});
    vi.mocked(mkdirSync).mockImplementation(() => {});
    ({ withFileLock } = await import('../../lib/core/file-lock.js'));
  });

  afterEach(() => {
    restoreBaselineListeners();
    vi.restoreAllMocks();
  });

  // ─── Lock Acquisition & Release ────────────────────────────────

  it('acquires lock, executes fn, and releases lock', () => {
    const result = withFileLock('/tmp/state.json', () => 42);

    expect(result).toBe(42);
    expect(writeFileSync).toHaveBeenCalledWith(
      '/tmp/state.json.lock',
      expect.stringContaining('"pid"'),
    );
    expect(unlinkSync).toHaveBeenCalledWith('/tmp/state.json.lock');
  });

  it('creates parent directory for lock file', () => {
    withFileLock('/deep/nested/state.json', () => {});

    expect(mkdirSync).toHaveBeenCalledWith('/deep/nested', { recursive: true });
  });

  it('returns the value from fn', () => {
    const result = withFileLock('/tmp/x.json', () => ({ data: 'hello' }));
    expect(result).toEqual({ data: 'hello' });
  });

  // ─── Lock File Content ─────────────────────────────────────────

  it('writes lock with pid and timestamp', () => {
    withFileLock('/tmp/state.json', () => {});

    const lockContent = JSON.parse(vi.mocked(writeFileSync).mock.calls[0][1]);
    expect(lockContent).toHaveProperty('pid', process.pid);
    expect(lockContent).toHaveProperty('timestamp');
    expect(typeof lockContent.timestamp).toBe('number');
  });

  // ─── Stale Lock Cleanup ────────────────────────────────────────

  it('removes stale lock older than timeout and proceeds', () => {
    const staleLock = JSON.stringify({
      pid: 99999,
      timestamp: Date.now() - 10000,
    });
    vi.mocked(existsSync)
      .mockReturnValueOnce(true)   // first check — lock exists
      .mockReturnValue(false);     // after cleanup
    vi.mocked(readFileSync).mockReturnValue(staleLock);

    const result = withFileLock('/tmp/state.json', () => 'ok');

    expect(result).toBe('ok');
    expect(unlinkSync).toHaveBeenCalledWith('/tmp/state.json.lock');
  });

  // ─── Corrupt Lock Cleanup ─────────────────────────────────────

  it('removes corrupt lock file and proceeds', () => {
    vi.mocked(existsSync)
      .mockReturnValueOnce(true)
      .mockReturnValue(false);
    vi.mocked(readFileSync).mockReturnValue('NOT JSON');

    const result = withFileLock('/tmp/state.json', () => 'recovered');

    expect(result).toBe('recovered');
    expect(unlinkSync).toHaveBeenCalledWith('/tmp/state.json.lock');
  });

  it('handles readFileSync throwing on corrupt lock', () => {
    vi.mocked(existsSync)
      .mockReturnValueOnce(true)
      .mockReturnValue(false);
    vi.mocked(readFileSync).mockImplementation(() => {
      throw new Error('EACCES');
    });

    const result = withFileLock('/tmp/state.json', () => 'ok');
    expect(result).toBe('ok');
  });

  // ─── Timeout Behavior ─────────────────────────────────────────

  it('force-removes lock after timeout and proceeds (fail-open)', () => {
    // Lock always exists and is fresh (never stale) — will trigger timeout
    const freshLock = JSON.stringify({
      pid: 99999,
      timestamp: Date.now() + 100000, // far in the future
    });

    let callCount = 0;
    vi.mocked(existsSync).mockImplementation(() => {
      callCount++;
      // After many iterations, stop to avoid infinite loop in test
      return callCount < 200;
    });
    vi.mocked(readFileSync).mockReturnValue(freshLock);

    // Mock Date.now to simulate timeout
    const realDateNow = Date.now;
    let fakeTime = realDateNow.call(Date);
    vi.spyOn(Date, 'now').mockImplementation(() => {
      fakeTime += 100; // advance 100ms each call
      return fakeTime;
    });

    const result = withFileLock('/tmp/state.json', () => 'timeout-ok');
    expect(result).toBe('timeout-ok');

    Date.now = realDateNow;
  });

  // ─── Fail-Open on Lock Creation Failure ────────────────────────

  it('proceeds without lock when writeFileSync fails (fail-open)', () => {
    vi.mocked(writeFileSync).mockImplementation(() => {
      throw new Error('EPERM');
    });

    const result = withFileLock('/tmp/state.json', () => 'no-lock-ok');

    expect(result).toBe('no-lock-ok');
  });

  it('proceeds without lock when mkdirSync fails', () => {
    vi.mocked(mkdirSync).mockImplementation(() => {
      throw new Error('EACCES');
    });
    // writeFileSync will also fail since dir doesn't exist
    vi.mocked(writeFileSync).mockImplementation(() => {
      throw new Error('ENOENT');
    });

    const result = withFileLock('/tmp/state.json', () => 'fallback');
    expect(result).toBe('fallback');
  });

  // ─── Exception Propagation ─────────────────────────────────────

  it('propagates exceptions from fn', () => {
    expect(() => {
      withFileLock('/tmp/state.json', () => {
        throw new Error('fn-error');
      });
    }).toThrow('fn-error');
  });

  it('releases lock even when fn throws', () => {
    try {
      withFileLock('/tmp/state.json', () => {
        throw new Error('boom');
      });
    } catch { /* expected */ }

    // unlinkSync called for cleanup in finally block
    expect(unlinkSync).toHaveBeenCalledWith('/tmp/state.json.lock');
  });

  // ─── Cleanup Error Handling ────────────────────────────────────

  it('swallows error when unlinkSync fails during cleanup', () => {
    vi.mocked(unlinkSync).mockImplementation(() => {
      throw new Error('EPERM');
    });

    // Should not throw despite cleanup failure
    const result = withFileLock('/tmp/state.json', () => 'ok');
    expect(result).toBe('ok');
  });

  it('swallows error when unlinkSync fails during stale lock removal', () => {
    const staleLock = JSON.stringify({
      pid: 99999,
      timestamp: Date.now() - 10000,
    });
    vi.mocked(existsSync)
      .mockReturnValueOnce(true)
      .mockReturnValue(false);
    vi.mocked(readFileSync).mockReturnValue(staleLock);
    // First unlinkSync (stale removal) throws, second (cleanup) succeeds
    vi.mocked(unlinkSync)
      .mockImplementationOnce(() => { throw new Error('EBUSY'); })
      .mockImplementation(() => {});

    const result = withFileLock('/tmp/state.json', () => 'ok');
    expect(result).toBe('ok');
  });

  // ─── Signal Listener Lifecycle (A4) ───────────────────────────
  //
  // The listener pair is installed once per process and deliberately left
  // installed after release — see the rationale on installSignalHandlers().
  // The property under test is therefore "exactly one pair, never growing",
  // not "count returns to zero".

  it('installs exactly one listener per signal on first lock', () => {
    withFileLock('/tmp/state.json', () => {});

    expect(addedListenerCount('SIGTERM')).toBe(1);
    expect(addedListenerCount('SIGINT')).toBe(1);
  });

  it('does not add listeners for repeated sequential locks', () => {
    withFileLock('/tmp/a.json', () => {});
    const after1 = addedListenerCount('SIGTERM');

    withFileLock('/tmp/b.json', () => {});
    withFileLock('/tmp/c.json', () => {});

    expect(after1).toBe(1);
    expect(addedListenerCount('SIGTERM')).toBe(1);
    expect(addedListenerCount('SIGINT')).toBe(1);
  });

  it('does not add listeners for nested locks on different paths', () => {
    withFileLock('/tmp/outer.json', () => {
      withFileLock('/tmp/inner.json', () => {
        expect(addedListenerCount('SIGTERM')).toBe(1);
      });
    });

    expect(addedListenerCount('SIGTERM')).toBe(1);
    expect(addedListenerCount('SIGINT')).toBe(1);
  });

  it('does not add listeners when re-entering the same path', () => {
    withFileLock('/tmp/same.json', () => {
      withFileLock('/tmp/same.json', () => {});
    });

    expect(addedListenerCount('SIGTERM')).toBe(1);
    expect(addedListenerCount('SIGINT')).toBe(1);
  });

  it('does not add listeners when fn throws', () => {
    try {
      withFileLock('/tmp/boom.json', () => { throw new Error('boom'); });
    } catch { /* expected */ }

    expect(addedListenerCount('SIGTERM')).toBe(1);
  });

  it('installs no listeners when the lock could not be created (fail-open)', () => {
    vi.mocked(writeFileSync).mockImplementation(() => {
      throw new Error('EPERM');
    });

    const result = withFileLock('/tmp/state.json', () => 'no-lock-ok');

    expect(result).toBe('no-lock-ok');
    expect(addedListenerCount('SIGTERM')).toBe(0);
    expect(addedListenerCount('SIGINT')).toBe(0);
  });

  // ─── No-Lock Path (lock doesn't exist) ────────────────────────

  it('skips spin-wait loop when no lock exists', () => {
    vi.mocked(existsSync).mockReturnValue(false);

    const result = withFileLock('/tmp/state.json', () => 'fast');

    // Should acquire lock and run fn immediately without spinning
    expect(result).toBe('fast');
    // existsSync called once for the lock check, returned false → no loop
    const lockChecks = vi.mocked(existsSync).mock.calls
      .filter((c) => String(c[0]).endsWith('.lock'));
    expect(lockChecks.length).toBeGreaterThanOrEqual(1);
  });
});
