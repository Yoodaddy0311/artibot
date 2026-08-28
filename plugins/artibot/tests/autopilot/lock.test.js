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
import {
  deleteSessionArtifacts,
  saveSession,
} from '../../lib/autopilot/session-store.js';

/**
 * Per-test cleanup tracker so concurrent suites don't trample each other.
 */
const created = [];
const createdSessions = [];

function track(featureKey) {
  created.push(featureKey);
  return featureKey;
}

function trackSession(sessionId) {
  createdSessions.push(sessionId);
  return sessionId;
}

/**
 * Forge a lock file on disk for `featureKey` owned by `holder` fields.
 * Defaults to the current (alive) pid so the legacy dead-pid path is bypassed,
 * isolating the session-liveness branch under test.
 */
function forgeLock(featureKey, { sessionId, acquiredAt = Date.now(), pid = process.pid } = {}) {
  const lockPath = getLockPath(featureKey);
  mkdirSync(path.dirname(lockPath), { recursive: true });
  const holder = { pid, sessionId, acquiredAt, featureKey };
  writeFileSync(lockPath, JSON.stringify(holder), 'utf-8');
  return lockPath;
}

afterEach(() => {
  while (created.length) {
    const key = created.pop();
    const lockPath = getLockPath(key);
    try { if (existsSync(lockPath)) unlinkSync(lockPath); } catch { /* ignore */ }
  }
  while (createdSessions.length) {
    const sid = createdSessions.pop();
    try { deleteSessionArtifacts(sid); } catch { /* ignore */ }
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

describe('stale lock recovery — holder session liveness', () => {
  // 1. Alive PID but the owning session file is gone, and the lock is older
  //    than the grace window → leaked lock → stale → reclaimable.
  it('reclaims a lock whose session file is missing and is past the grace window', () => {
    const key = track(`unit-leak-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    const ghostSession = `ap-ghost-${Math.random().toString(36).slice(2, 8)}`;
    // No saveSession() call → session file never exists.
    forgeLock(key, {
      sessionId: ghostSession,
      pid: process.pid, // alive on purpose: exercises the leak path, not dead-pid path
      acquiredAt: Date.now() - 120 * 1000, // 2 min ago → past 60s grace
    });

    const status = isLocked(key);
    expect(status.stale).toBe(true);
    expect(status.locked).toBe(false);

    const result = acquireLock(key, 'live-session');
    expect(result.ok).toBe(true);
    expect(readLock(key).sessionId).toBe('live-session');
  });

  // 2. Session file missing but lock just acquired (< grace) → NOT yet stale.
  //    Protects the acquire→persist race from premature theft.
  it('does NOT reclaim a missing-session lock still inside the grace window', () => {
    const key = track(`unit-grace-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    const ghostSession = `ap-fresh-${Math.random().toString(36).slice(2, 8)}`;
    forgeLock(key, {
      sessionId: ghostSession,
      pid: process.pid,
      acquiredAt: Date.now(), // just now → inside 60s grace
    });

    const status = isLocked(key);
    expect(status.stale).toBe(false);
    expect(status.locked).toBe(true);

    const result = acquireLock(key, 'racing-session');
    expect(result.ok).toBe(false);
    expect(result.holder.sessionId).toBe(ghostSession);
  });

  // 3. Session exists but is in a terminal phase (COMPLETED) → stale regardless
  //    of age or pid liveness → reclaimable.
  it('reclaims a lock whose session is in a terminal phase (COMPLETED)', () => {
    const key = track(`unit-terminal-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    const sessionId = trackSession(`ap-done-${Math.random().toString(36).slice(2, 8)}`);
    saveSession({ sessionId, phase: 'COMPLETED' });
    forgeLock(key, {
      sessionId,
      pid: process.pid,
      acquiredAt: Date.now(), // fresh: proves terminal short-circuits grace+age
    });

    const status = isLocked(key);
    expect(status.stale).toBe(true);

    const result = acquireLock(key, 'next-session');
    expect(result.ok).toBe(true);
    expect(readLock(key).sessionId).toBe('next-session');
  });

  // 3b. Terminal phase ABORTED is reclaimable too (second TERMINAL_PHASES value).
  it('reclaims a lock whose session is in a terminal phase (ABORTED)', () => {
    const key = track(`unit-aborted-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    const sessionId = trackSession(`ap-abort-${Math.random().toString(36).slice(2, 8)}`);
    saveSession({ sessionId, phase: 'ABORTED' });
    forgeLock(key, {
      sessionId,
      pid: process.pid,
      acquiredAt: Date.now(), // fresh: proves terminal short-circuits grace+age
    });

    expect(isLocked(key).stale).toBe(true);

    const result = acquireLock(key, 'next-session');
    expect(result.ok).toBe(true);
    expect(readLock(key).sessionId).toBe('next-session');
  });

  // 4. Session exists, active phase (EXECUTE), alive pid → healthy → protected.
  it('does NOT reclaim a lock whose session is active (EXECUTE) with an alive pid', () => {
    const key = track(`unit-active-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    const sessionId = trackSession(`ap-active-${Math.random().toString(36).slice(2, 8)}`);
    saveSession({ sessionId, phase: 'EXECUTE' });
    forgeLock(key, {
      sessionId,
      pid: process.pid,
      acquiredAt: Date.now() - 120 * 1000, // old enough to clear grace, still healthy
    });

    const status = isLocked(key);
    expect(status.stale).toBe(false);
    expect(status.locked).toBe(true);

    const result = acquireLock(key, 'intruder-session');
    expect(result.ok).toBe(false);
    expect(result.holder.sessionId).toBe(sessionId);
  });

  // 5a. Regression: dead pid is still stale even with a fresh acquiredAt and an
  //     active session file present (legacy guarantee preserved).
  it('still treats a dead pid as stale even when the session is active', () => {
    const key = track(`unit-deadpid-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    const sessionId = trackSession(`ap-deadpid-${Math.random().toString(36).slice(2, 8)}`);
    saveSession({ sessionId, phase: 'EXECUTE' });
    forgeLock(key, { sessionId, pid: 99999999, acquiredAt: Date.now() });

    expect(isLocked(key).stale).toBe(true);
    expect(acquireLock(key, 'reclaimer').ok).toBe(true);
  });

  // 5b. Regression: age > 24h is still stale (legacy guarantee preserved).
  it('still treats a >24h-old lock as stale', () => {
    const key = track(`unit-old-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    const sessionId = trackSession(`ap-old-${Math.random().toString(36).slice(2, 8)}`);
    saveSession({ sessionId, phase: 'EXECUTE' }); // active session, alive pid
    forgeLock(key, {
      sessionId,
      pid: process.pid,
      acquiredAt: Date.now() - 25 * 60 * 60 * 1000, // 25h ago
    });

    expect(isLocked(key).stale).toBe(true);
    expect(acquireLock(key, 'reclaimer-old').ok).toBe(true);
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
