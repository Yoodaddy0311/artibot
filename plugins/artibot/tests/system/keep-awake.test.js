/**
 * Tests for lib/system/keep-awake.js
 *
 * Strategy: stub `child_process.spawn`/`spawnSync` and `os.platform()` so
 * we can exercise each branch (win32 / darwin / linux / unsupported)
 * without actually spawning OS helpers. The refcount + handle shape
 * contracts are exercised end-to-end with the stubs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mocks must be registered before importing the module under test.
vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
  spawnSync: vi.fn(),
}));
vi.mock('node:os', () => ({
  platform: vi.fn(() => 'linux'),
}));

import { spawn, spawnSync } from 'node:child_process';
import { platform as osPlatform } from 'node:os';
import {
  _resetForTests,
  acquireKeepAwake,
  isKeepAwakeSupported,
  KeepAwakeError,
} from '../../lib/system/keep-awake.js';

/** Build a minimal fake ChildProcess that obeys the `kill`/`exit` contract. */
function makeFakeChild() {
  const listeners = new Map();
  return {
    killed: false,
    pid: Math.floor(Math.random() * 100000) + 1000,
    once(event, fn) {
      const arr = listeners.get(event) || [];
      arr.push(fn);
      listeners.set(event, arr);
      return this;
    },
    emit(event, ...args) {
      for (const fn of listeners.get(event) || []) fn(...args);
    },
    kill(signal) {
      this.killed = true;
      this.signal = signal;
      // Fire exit after kill to mimic real behavior.
      this.emit('exit', 0, signal);
      return true;
    },
  };
}

beforeEach(() => {
  _resetForTests();
  vi.mocked(spawn).mockReset();
  vi.mocked(spawnSync).mockReset();
  vi.mocked(osPlatform).mockReturnValue('linux');
});

afterEach(() => {
  _resetForTests();
});

describe('KeepAwakeError', () => {
  it('is a typed Error subclass', () => {
    const e = new KeepAwakeError('boom', { code: 'X' });
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('KeepAwakeError');
    expect(e.code).toBe('X');
  });
});

describe('isKeepAwakeSupported', () => {
  it('returns true on linux when systemd-inhibit is present', () => {
    vi.mocked(osPlatform).mockReturnValue('linux');
    vi.mocked(spawnSync).mockReturnValueOnce({ status: 0 });
    expect(isKeepAwakeSupported()).toBe(true);
  });

  it('returns true on darwin when caffeinate is present', () => {
    vi.mocked(osPlatform).mockReturnValue('darwin');
    vi.mocked(spawnSync).mockReturnValueOnce({ status: 0 });
    expect(isKeepAwakeSupported()).toBe(true);
  });

  it('returns false on a platform with no helper', () => {
    vi.mocked(osPlatform).mockReturnValue('linux');
    // both systemd-inhibit and xset missing
    vi.mocked(spawnSync).mockReturnValue({ status: 1 });
    expect(isKeepAwakeSupported()).toBe(false);
  });

  it('returns false on unknown platforms (e.g. sunos)', () => {
    vi.mocked(osPlatform).mockReturnValue('sunos');
    expect(isKeepAwakeSupported()).toBe(false);
  });
});

describe('acquireKeepAwake — linux/systemd-inhibit', () => {
  it('spawns systemd-inhibit with correct args and returns active handle', async () => {
    vi.mocked(osPlatform).mockReturnValue('linux');
    vi.mocked(spawnSync).mockReturnValueOnce({ status: 0 }); // hasBinary('systemd-inhibit')
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValueOnce(child);

    const h = await acquireKeepAwake({ reason: 'unit-test' });
    expect(h.active).toBe(true);
    expect(h.platform).toBe('linux');
    expect(h.since).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(typeof h.release).toBe('function');

    const [bin, args] = vi.mocked(spawn).mock.calls[0];
    expect(bin).toBe('systemd-inhibit');
    expect(args).toContain('--who=artibot');
    expect(args).toContain('--why=unit-test');
    expect(args).toContain('--mode=block');
    expect(args.some((a) => a.startsWith('--what=sleep:idle'))).toBe(true);

    await h.release();
    expect(child.killed).toBe(true);
  });

  it('falls back to xset when systemd-inhibit is missing (linux)', async () => {
    vi.mocked(osPlatform).mockReturnValue('linux');
    // systemd-inhibit missing, xset present
    vi.mocked(spawnSync)
      .mockReturnValueOnce({ status: 1 })  // systemd-inhibit
      .mockReturnValueOnce({ status: 0 }); // xset
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValueOnce(child);

    const h = await acquireKeepAwake({ reason: 'fallback' });
    expect(h.active).toBe(true);
    expect(h.reason).toMatch(/fallback=xset/);
    const [bin] = vi.mocked(spawn).mock.calls[0];
    expect(bin).toBe('xset');
  });

  it('returns inactive no-op handle when no helper available', async () => {
    vi.mocked(osPlatform).mockReturnValue('linux');
    vi.mocked(spawnSync).mockReturnValue({ status: 1 }); // nothing available

    const h = await acquireKeepAwake({ reason: 'no-helper' });
    expect(h.active).toBe(false);
    expect(h.reason).toBe('unsupported');
    expect(vi.mocked(spawn)).not.toHaveBeenCalled();
    // release on no-op handle is safe
    await expect(h.release()).resolves.toBeUndefined();
  });
});

describe('acquireKeepAwake — darwin/caffeinate', () => {
  it('spawns caffeinate -i by default', async () => {
    vi.mocked(osPlatform).mockReturnValue('darwin');
    vi.mocked(spawnSync).mockReturnValueOnce({ status: 0 });
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValueOnce(child);

    const h = await acquireKeepAwake({ reason: 'mac' });
    expect(h.active).toBe(true);
    const [bin, args] = vi.mocked(spawn).mock.calls[0];
    expect(bin).toBe('caffeinate');
    expect(args).toEqual(['-i']);
  });

  it('adds -d when keepDisplay=true', async () => {
    vi.mocked(osPlatform).mockReturnValue('darwin');
    vi.mocked(spawnSync).mockReturnValueOnce({ status: 0 });
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValueOnce(child);

    const h = await acquireKeepAwake({ reason: 'mac-display', keepDisplay: true });
    expect(h.active).toBe(true);
    const args = vi.mocked(spawn).mock.calls[0][1];
    expect(args).toEqual(['-d', '-i']);
  });
});

describe('acquireKeepAwake — win32/powershell', () => {
  it('spawns powershell with the SetThreadExecutionState script', async () => {
    vi.mocked(osPlatform).mockReturnValue('win32');
    // pwsh missing, powershell present
    vi.mocked(spawnSync)
      .mockReturnValueOnce({ status: 1 })  // pwsh probe
      .mockReturnValueOnce({ status: 0 }); // powershell probe
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValueOnce(child);

    const h = await acquireKeepAwake({ reason: 'win' });
    expect(h.active).toBe(true);
    const [bin, args] = vi.mocked(spawn).mock.calls[0];
    expect(bin).toBe('powershell');
    expect(args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-Command']);
    expect(args[3]).toContain('SetThreadExecutionState');
    expect(args[3]).toContain('0x00000001'); // ES_SYSTEM_REQUIRED
    expect(args[3]).toContain('0x00000040'); // ES_AWAYMODE_REQUIRED
  });

  it('returns no-op handle when neither pwsh nor powershell is available', async () => {
    vi.mocked(osPlatform).mockReturnValue('win32');
    vi.mocked(spawnSync).mockReturnValue({ status: 1 });

    const h = await acquireKeepAwake({ reason: 'win-fail' });
    expect(h.active).toBe(false);
    expect(h.reason).toBe('unsupported');
  });
});

describe('refcount behavior', () => {
  it('acquire x2 returns two handles sharing one child; release x1 keeps child alive', async () => {
    vi.mocked(osPlatform).mockReturnValue('darwin');
    vi.mocked(spawnSync).mockReturnValueOnce({ status: 0 });
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValueOnce(child);

    const h1 = await acquireKeepAwake({ reason: 'r1' });
    const h2 = await acquireKeepAwake({ reason: 'r2' });
    expect(h1.active).toBe(true);
    expect(h2.active).toBe(true);
    // Only one spawn should have occurred — second acquire reused the child.
    expect(vi.mocked(spawn).mock.calls.length).toBe(1);

    await h1.release();
    expect(child.killed).toBe(false);

    await h2.release();
    expect(child.killed).toBe(true);
  });

  it('release is idempotent — calling release twice on the same handle is safe', async () => {
    vi.mocked(osPlatform).mockReturnValue('darwin');
    vi.mocked(spawnSync).mockReturnValueOnce({ status: 0 });
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValueOnce(child);

    const h = await acquireKeepAwake({ reason: 'idem' });
    await h.release();
    await h.release(); // second call → no-op
    expect(child.killed).toBe(true);
  });
});

describe('child exit observer', () => {
  it('unexpected child exit clears the registry — next acquire spawns fresh', async () => {
    vi.mocked(osPlatform).mockReturnValue('darwin');
    vi.mocked(spawnSync).mockReturnValue({ status: 0 });
    const firstChild = makeFakeChild();
    const secondChild = makeFakeChild();
    vi.mocked(spawn)
      .mockReturnValueOnce(firstChild)
      .mockReturnValueOnce(secondChild);

    const h1 = await acquireKeepAwake({ reason: 'first' });
    expect(h1.active).toBe(true);

    // Simulate the child dying unexpectedly (e.g. systemd denied).
    firstChild.emit('exit', 1, null);

    const h2 = await acquireKeepAwake({ reason: 'second' });
    expect(h2.active).toBe(true);
    expect(vi.mocked(spawn).mock.calls.length).toBe(2);
  });
});

describe('handle shape', () => {
  it('handle is frozen and has the documented fields', async () => {
    vi.mocked(osPlatform).mockReturnValue('darwin');
    vi.mocked(spawnSync).mockReturnValueOnce({ status: 0 });
    vi.mocked(spawn).mockReturnValueOnce(makeFakeChild());

    const h = await acquireKeepAwake({ reason: 'shape' });
    expect(Object.isFrozen(h)).toBe(true);
    expect(h).toHaveProperty('active');
    expect(h).toHaveProperty('since');
    expect(h).toHaveProperty('platform');
    expect(h).toHaveProperty('reason');
    expect(typeof h.release).toBe('function');
  });

  it('default reason is used when none provided', async () => {
    vi.mocked(osPlatform).mockReturnValue('darwin');
    vi.mocked(spawnSync).mockReturnValueOnce({ status: 0 });
    vi.mocked(spawn).mockReturnValueOnce(makeFakeChild());

    const h = await acquireKeepAwake({});
    expect(h.reason).toBe('artibot-autopilot');
  });
});
