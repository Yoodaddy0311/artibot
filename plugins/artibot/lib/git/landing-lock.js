/**
 * Landing lock — one batch landing per (repository, target branch) at a time.
 *
 * Why a separate lock and not `lib/autopilot/lock.js`: that lock's staleness
 * rule is bound to autopilot sessions (`isHolderSessionInactive` reclaims a
 * lock whose session file is missing after 60s). A landing has no autopilot
 * session and legitimately holds its lock for up to the CI wait ceiling
 * (10 min, `batch-landing.js`), so it would be stolen mid-wait. This module
 * keeps the same O_EXCL mechanics and none of the session coupling.
 *
 * ── Key ──────────────────────────────────────────────────────────────────────
 * A single string `${repoIdentity}__${branch}` composed by
 * `lib/git/repo-identity.js#composeScopedKey` — the SAME function the
 * autopilot feature lock uses, so `/`, `:`, `\` are sanitised by one rule in
 * one place (Phase 3 of the same PRD). Single-string on purpose: the PRD notes
 * `lock.js:178` is a composite *payload*, not a composite *key*, so there is
 * no precedent for structured keys, and a flat string is what a filename can
 * hold. `repoIdentity` is supplied by the caller (`getRepoIdentity(cwd)` from
 * the same module, or any stable string); this module never resolves it.
 *
 * ── What the lock guarantees, and what it cannot ─────────────────────────────
 * Mutual exclusion between processes ON THIS HOST that agree on `lockDir`.
 * `openSync(path, 'wx')` is the arbiter; a second holder never gets a
 * descriptor. It does NOT see a second machine, a CI runner, or a human's
 * manual `git push`: the remote can still move between "checked" and "pushed".
 * That remote TOCTOU is closed by `batch-landing.js` re-reading the base SHA
 * immediately before the fast-forward push and by `--force-with-lease` on the
 * integration branch — not by this lock. Treat the lock as a courtesy between
 * local sessions, and the lease as the real guard.
 *
 * ── Staleness ────────────────────────────────────────────────────────────────
 * A holder is stale when its PID is dead (same host) or when the record is
 * older than `staleMs` (default 30 min = 3× the CI wait ceiling). Reclaim is
 * unlink + fresh O_EXCL; if two reclaimers race, exactly one `wx` succeeds.
 *
 * An EMPTY or HALF-WRITTEN lock file is a holder mid-write, not an absent one:
 * `tryCreateExclusive` creates the file and writes the record as two steps, so
 * a competitor can read zero bytes from a lock that is very much alive. Such a
 * file is stale only by FILE AGE (`mtime` vs `Date.now()`) — never because the
 * record failed to parse. Treating an unreadable record as `age = Infinity`
 * unlinked live locks and handed BOTH processes `ok:true`; `isPidAlive` and
 * `staleMs` could not prevent it, because neither is consulted without a
 * record. Measured 2026-09-04: two CI failures (Windows Node 22, Linux Node
 * 24) in `tests/firewall/landing-serialization.test.js`, 2 of 6 racing
 * children winning; production reach is `batch-landing.js:338`, where two
 * concurrent `/split integrate` runs could both land. The mtime axis uses the
 * real clock on purpose — `opts.now` stamps `acquiredAt`, but mtime is stamped
 * by the OS, so comparing an injected clock against it is a category error.
 * Tests move that axis with `utimesSync`. See `tests/git/landing-lock.test.js`.
 *
 * @module lib/git/landing-lock
 */

import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { composeScopedKey, sanitizeSegment } from './repo-identity.js';

/** 3× the 10-minute CI wait ceiling in `batch-landing.js`. */
export const DEFAULT_STALE_MS = 30 * 60 * 1000;

/**
 * `${repoIdentity}__${branch}` via `composeScopedKey` (throws TypeError when
 * either half sanitises to nothing).
 *
 * @param {string} repoIdentity  - Stable repo id (e.g. `owner/name` or `root-<sha16>`)
 * @param {string} branch        - Landing target (e.g. `master`)
 * @returns {string}
 */
export function buildLandingLockKey(repoIdentity, branch) {
  return composeScopedKey(repoIdentity, branch);
}

/**
 * @param {string} key
 * @param {string} lockDir
 * @returns {string}
 */
export function getLandingLockPath(key, lockDir) {
  if (!key || typeof key !== 'string') throw new TypeError('key must be a non-empty string');
  if (!lockDir || typeof lockDir !== 'string') throw new TypeError('lockDir must be a non-empty string');
  const name = sanitizeSegment(key);
  if (!name) throw new TypeError('key must sanitise to a non-empty file name');
  return path.join(lockDir, `${name}.landing.lock`);
}

/**
 * @param {number} pid
 * @returns {boolean}
 */
function defaultIsPidAlive(pid) {
  if (typeof pid !== 'number' || !Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

/**
 * @param {string} lockPath
 * @returns {object|null}
 */
function readHolder(lockPath) {
  try {
    if (!existsSync(lockPath)) return null;
    return JSON.parse(readFileSync(lockPath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Age of the lock FILE itself, for the case where its record is unreadable.
 *
 * `Date.now()` and not `opts.now`: `mtime` is stamped by the OS on the wall
 * clock, so an injected test clock compared against it is a category error (a
 * `now()` of 1_000_000 reads a file written today as decades in the future).
 * `staleMs` is a duration, so it stays meaningful on either clock.
 *
 * @param {string} lockPath
 * @returns {number|null} Milliseconds since the last write, or null when the
 *   file is gone — the only other reason a read yields no record, and one that
 *   protects nothing, so the caller retries `wx` at once.
 */
function fileAgeMs(lockPath) {
  try {
    return Date.now() - statSync(lockPath).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * @param {string} lockPath
 * @param {object} record
 * @returns {boolean} true when this call created the file
 */
function tryCreateExclusive(lockPath, record) {
  let fd;
  try {
    fd = openSync(lockPath, 'wx');
  } catch (err) {
    if (err?.code === 'EEXIST') return false;
    throw err;
  }
  try {
    writeSync(fd, JSON.stringify(record, null, 2), 0, 'utf-8');
  } finally {
    closeSync(fd);
  }
  return true;
}

/**
 * Read the current holder without acquiring.
 *
 * @param {string} key
 * @param {{lockDir: string}} opts
 * @returns {object|null}
 */
export function readLandingLock(key, opts) {
  return readHolder(getLandingLockPath(key, opts?.lockDir));
}

/**
 * @typedef {Object} AcquireResult
 * @property {boolean} ok
 * @property {string} lockPath
 * @property {string} [token]    - Present when ok; required to release
 * @property {object} [holder]   - Present when not ok; the current holder record
 * @property {boolean} [reclaimed] - true when a stale holder was evicted
 * @property {string} [reason]   - Present when not ok and `holder` is absent:
 *   the file exists but its record could not be read (a holder mid-write)
 */

/**
 * Try once to take the lock. Never waits — a landing that finds the lock held
 * should report the holder and stop, not queue behind an unknown wait.
 *
 * @param {string} key
 * @param {Object} opts
 * @param {string} opts.lockDir
 * @param {string} [opts.sessionId]
 * @param {number} [opts.staleMs]
 * @param {() => number} [opts.now]
 * @param {(pid:number) => boolean} [opts.isPidAlive]
 * @returns {AcquireResult}
 */
export function acquireLandingLock(key, opts) {
  const lockDir = opts?.lockDir;
  const lockPath = getLandingLockPath(key, lockDir);
  mkdirSync(lockDir, { recursive: true });
  const now = opts?.now ?? Date.now;
  const staleMs = Number.isFinite(opts?.staleMs) ? opts.staleMs : DEFAULT_STALE_MS;
  const isPidAlive = opts?.isPidAlive ?? defaultIsPidAlive;
  const token = randomUUID();
  const record = {
    key,
    token,
    pid: process.pid,
    host: os.hostname(),
    sessionId: opts?.sessionId ?? null,
    acquiredAt: now(),
  };

  if (tryCreateExclusive(lockPath, record)) return { ok: true, lockPath, token };

  const existing = readHolder(lockPath);
  // No record means one of two very different things, and only file age tells
  // them apart: a holder is between `wx` and `writeSync` (protect it), or the
  // file is already gone (nothing to protect). See the module header.
  const ageMs = existing
    ? now() - (existing.acquiredAt ?? 0)
    : (fileAgeMs(lockPath) ?? Infinity);
  const sameHost = existing?.host === record.host;
  const stale = ageMs > staleMs || (existing !== null && sameHost && !isPidAlive(existing.pid));
  if (stale) {
    try { unlinkSync(lockPath); } catch { /* a concurrent reclaimer may have won; O_EXCL below decides */ }
    if (tryCreateExclusive(lockPath, record)) return { ok: true, lockPath, token, reclaimed: true };
  }
  const holder = readHolder(lockPath) ?? existing ?? undefined;
  return holder
    ? { ok: false, lockPath, holder }
    : { ok: false, lockPath, reason: 'lock file exists but its record is unreadable — a holder is mid-write' };
}

/**
 * Release only when the on-disk token matches ours — a stale-reclaimed lock
 * must not be removed by the evicted holder's late `finally`.
 *
 * @param {string} key
 * @param {{lockDir: string, token: string}} opts
 * @returns {boolean}
 */
export function releaseLandingLock(key, opts) {
  const lockPath = getLandingLockPath(key, opts?.lockDir);
  const holder = readHolder(lockPath);
  if (!holder || holder.token !== opts?.token) return false;
  try {
    unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}
