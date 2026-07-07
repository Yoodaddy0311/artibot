/**
 * Unit tests for saveSession's bounded rename retry (Windows transient-lock
 * absorption: EPERM/EBUSY/EACCES from antivirus / OneDrive holding a fresh
 * .tmp handle). Covers:
 *   - retry succeeds after N transient failures (call-count asserted)
 *   - the enlarged budget (S3: MAX_RENAME_ATTEMPTS 5 → 8) makes attempts 6-8
 *     reachable — a 7th-attempt success would have thrown under the old max=5
 *   - retries exhausted => original error propagates + tmp cleanup attempted
 *   - non-transient error (ENOENT) => no retry, immediate propagation
 *
 * node:fs is mocked so renameSync behaviour is fully controlled. Atomics.wait
 * backoff runs for real but is bounded (per-sleep capped at 250ms) so the suite
 * stays fast.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => true),
  mkdirSync: vi.fn(),
  readdirSync: vi.fn(() => []),
  readFileSync: vi.fn(() => '{}'),
  renameSync: vi.fn(),
  unlinkSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { saveSession } from '../../lib/autopilot/session-store.js';

/** Build a Node-style fs error carrying a `code`. */
function fsError(code) {
  const err = new Error(`${code}: operation not permitted, rename`);
  err.code = code;
  return err;
}

const baseState = () => ({ sessionId: 'ap-retry-test', task: 'x' });

beforeEach(() => {
  vi.clearAllMocks();
  mkdirSync.mockImplementation(() => {});
  writeFileSync.mockImplementation(() => {});
  unlinkSync.mockImplementation(() => {});
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('saveSession rename retry', () => {
  it('retries on EPERM and succeeds on the 3rd attempt', () => {
    renameSync
      .mockImplementationOnce(() => { throw fsError('EPERM'); })
      .mockImplementationOnce(() => { throw fsError('EPERM'); })
      .mockImplementationOnce(() => {});

    const result = saveSession(baseState());

    expect(renameSync).toHaveBeenCalledTimes(3);
    expect(result).toContain('ap-retry-test.json');
    expect(unlinkSync).not.toHaveBeenCalled();
  });

  it('retries on EBUSY then succeeds (transient-code coverage)', () => {
    renameSync
      .mockImplementationOnce(() => { throw fsError('EBUSY'); })
      .mockImplementationOnce(() => {});

    saveSession(baseState());

    expect(renameSync).toHaveBeenCalledTimes(2);
    expect(unlinkSync).not.toHaveBeenCalled();
  });

  it('retries on EPERM and succeeds on the 7th attempt (enlarged budget — would throw at old max=5)', () => {
    for (let i = 0; i < 6; i += 1) {
      renameSync.mockImplementationOnce(() => { throw fsError('EPERM'); });
    }
    renameSync.mockImplementationOnce(() => {});

    const result = saveSession(baseState());

    expect(renameSync).toHaveBeenCalledTimes(7);
    expect(result).toContain('ap-retry-test.json');
    expect(unlinkSync).not.toHaveBeenCalled();
  });

  it('propagates the original error and cleans up tmp after 8 EPERM attempts', () => {
    renameSync.mockImplementation(() => { throw fsError('EPERM'); });

    expect(() => saveSession(baseState())).toThrow(/EPERM/);
    expect(renameSync).toHaveBeenCalledTimes(8);
    expect(unlinkSync).toHaveBeenCalledTimes(1);
  });

  it('does not retry on a non-transient error (ENOENT) and propagates immediately', () => {
    renameSync.mockImplementation(() => { throw fsError('ENOENT'); });

    expect(() => saveSession(baseState())).toThrow(/ENOENT/);
    expect(renameSync).toHaveBeenCalledTimes(1);
    expect(unlinkSync).toHaveBeenCalledTimes(1);
  });
});
