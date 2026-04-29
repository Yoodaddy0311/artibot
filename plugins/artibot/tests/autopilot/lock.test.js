/**
 * Unit tests for lib/autopilot/lock.js
 * Covers atomic acquire/release, stale recovery, mismatched session,
 * wait+timeout, Korean featureKey, and TypeError inputs.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import {
  acquireLock,
  getLockPath,
  isLocked,
  readLock,
  releaseLock,
} from '../../lib/autopilot/lock.js';

/**
 * Per-test cleanup tracker so concurrent suites don't trample each other.
 */
const created = [];

function track(featureKey) {
  created.push(featureKey);
  return featureKey;
}

afterEach(() => {
  while (created.length) {
    const key = created.pop();
    const lockPath = getLockPath(key);
    try { if (existsSync(lockPath)) unlinkSync(lockPath); } catch { /* ignore */ }
  }
});

describe('acquireLock + isLocked', () => {
  it('returns ok=true and isLocked reports holder accurately', () => {
    const key = track(`unit-acquire-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    const sessionId = 'ap-test-session-1';

    const result = acquireLock(key, sessionId);
    expect(result.ok).toBe(true);
    expect(result.lockPath).toBe(getLockPath(key));
    expect(existsSync(result.lockPath)).toBe(true);

    const status = isLocked(key);
    expect(status.locked).toBe(true);
    expect(status.holder).toBeDefined();
    expect(status.holder.sessionId).toBe(sessionId);
    expect(status.holder.pid).toBe(process.pid);
    expect(status.holder.featureKey).toBe(key);
    expect(typeof status.holder.acquiredAt).toBe('number');
  });
});

describe('acquireLock contention', () => {
  it('second acquire on same featureKey returns ok=false with holder', () => {
    const key = track(`unit-contend-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    const a = acquireLock(key, 'session-A');
    expect(a.ok).toBe(true);

    const b = acquireLock(key, 'session-B');
    expect(b.ok).toBe(false);
    expect(b.holder).toBeDefined();
    expect(b.holder.sessionId).toBe('session-A');
  });
});

describe('releaseLock', () => {
  it('allows re-acquire after release', () => {
    const key = track(`unit-release-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    const a = acquireLock(key, 'session-X');
    expect(a.ok).toBe(true);

    const released = releaseLock(key, 'session-X');
    expect(released).toBe(true);
    expect(existsSync(getLockPath(key))).toBe(false);

    const b = acquireLock(key, 'session-Y');
    expect(b.ok).toBe(true);
  });

  it('returns false when sessionId does not match holder', () => {
    const key = track(`unit-mismatch-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    acquireLock(key, 'owner-session');

    const released = releaseLock(key, 'attacker-session');
    expect(released).toBe(false);
    // Lock still present
    expect(existsSync(getLockPath(key))).toBe(true);
    expect(readLock(key).sessionId).toBe('owner-session');
  });
});

describe('stale lock recovery', () => {
  it('reclaims a lock owned by a dead PID', () => {
    const key = track(`unit-stale-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    const lockPath = getLockPath(key);
    mkdirSync(path.dirname(lockPath), { recursive: true });
    // Forge a lock with an impossible PID
    const fakeHolder = {
      pid: 99999999,
      sessionId: 'ghost-session',
      acquiredAt: Date.now(),
      featureKey: key,
    };
    writeFileSync(lockPath, JSON.stringify(fakeHolder), 'utf-8');

    const result = acquireLock(key, 'live-session');
    expect(result.ok).toBe(true);
    expect(readLock(key).sessionId).toBe('live-session');
    expect(readLock(key).pid).toBe(process.pid);
  });
});

describe('acquireLock wait+timeout', () => {
  it('returns ok=false after timeoutMs when holder remains alive', () => {
    const key = track(`unit-wait-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    const a = acquireLock(key, 'holder-session');
    expect(a.ok).toBe(true);

    const start = Date.now();
    const b = acquireLock(key, 'waiter-session', { wait: true, timeoutMs: 200 });
    const elapsed = Date.now() - start;

    expect(b.ok).toBe(false);
    expect(b.holder).toBeDefined();
    expect(b.holder.sessionId).toBe('holder-session');
    expect(elapsed).toBeGreaterThanOrEqual(180); // allow tiny timer slack
  });
});

describe('Korean featureKey support', () => {
  it('handles Korean characters in featureKey', () => {
    const key = track(`자동조종-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    const result = acquireLock(key, 'session-한글');
    expect(result.ok).toBe(true);
    expect(existsSync(result.lockPath)).toBe(true);
    expect(readLock(key).sessionId).toBe('session-한글');
    expect(releaseLock(key, 'session-한글')).toBe(true);
  });
});

describe('input validation', () => {
  it('throws TypeError when sessionId is missing', () => {
    expect(() => acquireLock('feat-key', undefined)).toThrow(TypeError);
    expect(() => acquireLock('feat-key', '')).toThrow(TypeError);
  });

  it('throws TypeError when featureKey is missing', () => {
    expect(() => acquireLock('', 'session-Z')).toThrow(TypeError);
    expect(() => getLockPath(null)).toThrow(TypeError);
  });
});
