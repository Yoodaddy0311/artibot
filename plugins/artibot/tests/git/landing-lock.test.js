import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  acquireLandingLock,
  buildLandingLockKey,
  getLandingLockPath,
  readLandingLock,
  releaseLandingLock,
} from '../../lib/git/landing-lock.js';

/**
 * lib/git/landing-lock.js — the write window between `openSync(path,'wx')` and
 * `writeSync`.
 *
 * `tryCreateExclusive` creates the file FIRST and writes the record SECOND, so
 * a competitor that arrives in between reads a zero-byte (or half-written)
 * file. `readHolder` returns null for both "no file" and "unparseable file",
 * and the pre-fix staleness rule treated null as `ageMs = Infinity` — always
 * stale — so the competitor unlinked a live lock and took it. Both processes
 * then held the lock, with `isPidAlive: () => true` and a day-long `staleMs`
 * unable to prevent it.
 *
 * Measured 2026-09-04: CI failed twice on this (Windows Node 22, Linux Node
 * 24) in `tests/firewall/landing-serialization.test.js`, 2 of 6 racing
 * children reporting `ok`. Production reach is `lib/git/batch-landing.js:338`,
 * which acquires with default options, so two concurrent `/split integrate`
 * runs on one (repo, branch) could both proceed.
 *
 * The rule these tests pin: an unparseable lock file is a holder mid-write,
 * not an absent holder. It becomes reclaimable only by FILE AGE (mtime), never
 * by the missing record. Temp directories only — never the user's lock dir.
 */

const DAY_MS = 86_400_000;
/** Reclaim off unless a test asks for it: no age path, no dead-pid path. */
const NO_RECLAIM = { staleMs: DAY_MS, isPidAlive: () => true };

let lockDir = '';

beforeAll(() => {
  lockDir = mkdtempSync(path.join(tmpdir(), 'artibot-landing-lock-'));
});

afterAll(() => {
  try {
    rmSync(lockDir, { recursive: true, force: true });
  } catch { /* best effort */ }
});

/** Plant a lock file with exactly `body`, stamped `ageMs` in the past. */
function plant(key, body, ageMs = 0) {
  const lockPath = getLandingLockPath(key, lockDir);
  writeFileSync(lockPath, body, 'utf-8');
  if (ageMs > 0) {
    const when = new Date(Date.now() - ageMs);
    utimesSync(lockPath, when, when);
  }
  return lockPath;
}

describe('a lock file that cannot be parsed is a holder mid-write, not an absent holder', () => {
  it('refuses a fresh EMPTY lock file (the zero-byte window of openSync wx)', () => {
    const key = buildLandingLockKey('owner/empty-fresh', 'master');
    const lockPath = plant(key, '');
    expect(statSync(lockPath).size).toBe(0);
    expect(readLandingLock(key, { lockDir })).toBeNull();

    const r = acquireLandingLock(key, { lockDir, sessionId: 'competitor', ...NO_RECLAIM });

    expect(r.ok).toBe(false);
    expect(r.reclaimed).toBeUndefined();
    // The mid-write holder's file must survive: unlinking it is what let the
    // competitor's own `wx` succeed.
    expect(statSync(lockPath).size).toBe(0);
  });

  it('refuses a fresh HALF-WRITTEN JSON lock file (writeSync interrupted)', () => {
    const key = buildLandingLockKey('owner/partial-fresh', 'master');
    const half = '{\n  "key": "owner-partial-fresh__master",\n  "token": "abc-';
    const lockPath = plant(key, half);
    expect(() => JSON.parse(readFileSync(lockPath, 'utf-8'))).toThrow();
    expect(readLandingLock(key, { lockDir })).toBeNull();

    const r = acquireLandingLock(key, { lockDir, sessionId: 'competitor', ...NO_RECLAIM });

    expect(r.ok).toBe(false);
    expect(r.reclaimed).toBeUndefined();
    expect(readFileSync(lockPath, 'utf-8')).toBe(half);
  });

  it('DOES reclaim an unparseable file older than staleMs — a truly abandoned write', () => {
    const key = buildLandingLockKey('owner/empty-old', 'master');
    plant(key, '', DAY_MS + 60_000);

    const r = acquireLandingLock(key, { lockDir, sessionId: 'competitor', ...NO_RECLAIM });

    expect(r.ok).toBe(true);
    expect(r.reclaimed).toBe(true);
    expect(readLandingLock(key, { lockDir })?.sessionId).toBe('competitor');
    releaseLandingLock(key, { lockDir, token: r.token });
  });

  it('mtime, not the injected clock, decides — a fake `now` must not make a fresh file stale', () => {
    // `opts.now` stamps `acquiredAt`; the OS stamps mtime on the wall clock.
    // Comparing one against the other is a category error: a `now()` of
    // 1_000_000 would read a file written today as decades in the future.
    const key = buildLandingLockKey('owner/fake-clock', 'master');
    plant(key, '');

    const r = acquireLandingLock(key, { lockDir, now: () => 1_000_000, staleMs: 1000, isPidAlive: () => true });

    expect(r.ok).toBe(false);
  });

  it('a file that vanishes between the EEXIST and the read is not a holder — acquisition proceeds', () => {
    // The other genuine source of `readHolder() === null`: the winner released
    // between our failed `wx` and our read. Nothing to protect, so the retry
    // must succeed rather than report a phantom holder.
    const key = buildLandingLockKey('owner/vanished', 'master');
    const first = acquireLandingLock(key, { lockDir, sessionId: 'first' });
    expect(first.ok).toBe(true);
    expect(releaseLandingLock(key, { lockDir, token: first.token })).toBe(true);

    const r = acquireLandingLock(key, { lockDir, sessionId: 'second', ...NO_RECLAIM });

    expect(r.ok).toBe(true);
    expect(r.reclaimed).toBeUndefined();
    releaseLandingLock(key, { lockDir, token: r.token });
  });

  it('a well-formed live holder is still refused, and a well-formed old one still reclaimed', () => {
    // Negative control: the mtime rule must not have displaced the record
    // rule. A parseable record keeps deciding by `acquiredAt` + pid liveness.
    const key = buildLandingLockKey('owner/wellformed', 'master');
    let t = 5_000_000;
    const now = () => t;
    const first = acquireLandingLock(key, { lockDir, now, staleMs: 1000, isPidAlive: () => true });
    expect(first.ok).toBe(true);

    t += 500;
    expect(acquireLandingLock(key, { lockDir, now, staleMs: 1000, isPidAlive: () => true }).ok).toBe(false);

    t += 600;
    const reclaimed = acquireLandingLock(key, { lockDir, now, staleMs: 1000, isPidAlive: () => true });
    expect(reclaimed.ok).toBe(true);
    expect(reclaimed.reclaimed).toBe(true);
    releaseLandingLock(key, { lockDir, token: reclaimed.token });
  });
});
