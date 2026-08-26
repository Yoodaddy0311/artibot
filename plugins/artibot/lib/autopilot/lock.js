/**
 * Cross-process atomic file lock for autopilot features.
 * Uses fs.openSync with 'wx' flag for atomic O_EXCL acquisition.
 * Korean / spaced path safe (uses path.join only).
 *
 * Lock state schema: { pid, sessionId, acquiredAt, featureKey, lockKey,
 *                      repoIdentity?, cwd? }
 *   `featureKey` is the caller's plain key; `lockKey` is the file stem that
 *   was actually written (equal to `featureKey` for unscoped locks).
 *
 * ── Repo-scoped keys (PRD split-cross-session, F3) ─────────────────────────
 * The lock file was keyed by the task slug alone, so two clones of DIFFERENT
 * repositories running the same task collided, while two runs in the SAME
 * repository with different slugs were invisible to each other. Callers may
 * now pass `{ repoIdentity }` (see `lib/git/repo-identity.js`); the file stem
 * becomes the single sanitised string `${repoIdentity}__${featureKey}`.
 *
 * Parallel legacy reader: while a scoped key is in use, the unscoped file
 * `${featureKey}.lock` is STILL READ — a live holder there (a pre-upgrade
 * process) blocks a scoped acquire, and `isLocked` reports it with
 * `scheme:'legacy'`. This is what makes the change reversible: rolling back
 * to unscoped keys re-reads the same files old code always read, and nothing
 * written under the old scheme is ignored meanwhile. The legacy check and the
 * scoped O_EXCL write are two steps, not one; a legacy holder appearing in
 * between is a pre-upgrade process racing an upgraded one — accepted.
 *
 * @module lib/autopilot/lock
 */

import path from 'node:path';
import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { ensureDirSync } from '../core/file.js';
import { composeScopedKey } from '../git/repo-identity.js';
import { getSessionPath, getStoreDir, loadSession } from './session-store.js';

const STALE_MS = 24 * 60 * 60 * 1000; // 24 hours
const POLL_MS = 100;
const DEFAULT_TIMEOUT_MS = 5000;

/** Phases after which a holder can never legitimately keep its lock. */
const TERMINAL_PHASES = new Set(['COMPLETED', 'ABORTED']);
/**
 * Grace period before a lock whose session file is absent is treated as
 * leaked. Protects the acquire→saveSession race: a just-acquired lock whose
 * session has not yet been persisted must not be stolen by a racing process.
 */
const SESSION_GRACE_MS = 60 * 1000;

/**
 * Resolve the file stem a lock is written under.
 * @param {string} featureKey
 * @param {{ repoIdentity?: string }} [opts]
 * @returns {string}
 */
export function getLockKey(featureKey, opts = {}) {
  if (!featureKey || typeof featureKey !== 'string') {
    throw new TypeError('featureKey must be a non-empty string');
  }
  const repoIdentity = opts && typeof opts.repoIdentity === 'string' ? opts.repoIdentity : '';
  return repoIdentity ? composeScopedKey(repoIdentity, featureKey) : featureKey;
}

/**
 * Resolve the absolute lock file path for a feature key. With
 * `opts.repoIdentity` the path is the repo-scoped one; without it, the
 * legacy/unscoped path — byte-identical to what this function always returned.
 * @param {string} featureKey
 * @param {{ repoIdentity?: string }} [opts]
 * @returns {string}
 */
export function getLockPath(featureKey, opts = {}) {
  return path.join(getStoreDir(), 'locks', `${getLockKey(featureKey, opts)}.lock`);
}

/**
 * Best-effort liveness check for a PID. Returns true if the process is alive,
 * false if it is gone (ESRCH). EPERM treats as alive (process exists, no perms).
 * @param {number} pid
 * @returns {boolean}
 */
function isPidAlive(pid) {
  if (typeof pid !== 'number' || !Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err.code === 'EPERM') return true;
    return false;
  }
}

/**
 * Read a lock file by absolute path. Returns null if missing or unparseable.
 * @param {string} lockPath
 * @returns {object|null}
 */
function readLockFile(lockPath) {
  try {
    if (!existsSync(lockPath)) return null;
    const raw = readFileSync(lockPath, 'utf-8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Read raw lock JSON for the (scoped or unscoped) key. Returns null if
 * missing or unparseable. Does NOT fall through to the legacy file — use
 * {@link isLocked} for the parallel-reader view.
 * @param {string} featureKey
 * @param {{ repoIdentity?: string }} [opts]
 * @returns {object|null}
 */
export function readLock(featureKey, opts = {}) {
  return readLockFile(getLockPath(featureKey, opts));
}

/**
 * Read the unscoped (pre-repo-identity) lock file for a feature key. This is
 * the parallel legacy reader: identical to `readLock(featureKey)` without opts,
 * named separately so call sites say what they mean.
 * @param {string} featureKey
 * @returns {object|null}
 */
export function readLegacyLock(featureKey) {
  return readLockFile(getLockPath(featureKey));
}

/**
 * Determine whether the holder's owning session is inactive, independent of
 * pid liveness. Two cases close the PID-reuse / lock-leak gaps:
 *   1. The session reached a terminal phase (COMPLETED/ABORTED) → stale now.
 *   2. The session file is gone AND the lock predates the grace window →
 *      leaked lock (e.g. deleteSession ran, or a crash before persist) → stale.
 *
 * Returns false (not inactive) when the holder lacks a usable sessionId so the
 * legacy age/pid checks remain the sole authority for such records.
 *
 * @param {object} holder
 * @returns {boolean}
 */
function isHolderSessionInactive(holder) {
  if (!holder || typeof holder.sessionId !== 'string' || !holder.sessionId) return false;
  // Terminal sessions are stale regardless of age or pid liveness.
  // loadSession returns null for a missing OR corrupt file; the existsSync
  // re-check below distinguishes them, so a present-but-corrupt session file
  // is treated as live (protected), never over-reclaimed.
  const session = loadSession(holder.sessionId);
  if (session && TERMINAL_PHASES.has(session.phase)) return true;
  // Missing session file = leaked lock, but only after the grace window so the
  // acquire→persist race cannot be mis-detected as a leak.
  const ageMs = Date.now() - (holder.acquiredAt ?? 0);
  if (ageMs > SESSION_GRACE_MS) {
    try {
      // existsSync false => file truly gone (not just unparseable) => leaked.
      if (!existsSync(getSessionPath(holder.sessionId))) return true;
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Determine whether a holder record is stale: dead PID, older than 24h, or
 * its owning session is inactive (terminal phase, or leaked lock past grace).
 * The session check closes the PID-reuse hole (a recycled pid reads as alive)
 * and the lock-leak hole (session file deleted but lock file lingered).
 * @param {object} holder
 * @returns {boolean}
 */
function isStale(holder) {
  if (!holder || typeof holder !== 'object') return true;
  const ageMs = Date.now() - (holder.acquiredAt ?? 0);
  if (ageMs > STALE_MS) return true;
  if (!isPidAlive(holder.pid)) return true;
  if (isHolderSessionInactive(holder)) return true;
  return false;
}

/**
 * Inspect lock state without acquiring.
 *
 * With `opts.repoIdentity` the scoped file is consulted first; when it is
 * absent the unscoped legacy file is read too (parallel reader), and the
 * result says which one answered via `scheme`.
 *
 * @param {string} featureKey
 * @param {{ repoIdentity?: string }} [opts]
 * @returns {{ locked: boolean, holder?: object, stale?: boolean, scheme?: 'scoped'|'legacy' }}
 */
export function isLocked(featureKey, opts = {}) {
  const scoped = Boolean(opts && opts.repoIdentity);
  const holder = readLock(featureKey, opts);
  if (holder) {
    const stale = isStale(holder);
    return { locked: !stale, holder, stale, scheme: scoped ? 'scoped' : 'legacy' };
  }
  if (scoped) {
    const legacy = readLegacyLock(featureKey);
    if (legacy) {
      const stale = isStale(legacy);
      return { locked: !stale, holder: legacy, stale, scheme: 'legacy' };
    }
  }
  return { locked: false };
}

/**
 * Atomically write lock file using O_EXCL. Returns true on success, false on
 * EEXIST. All other errors propagate.
 * @param {string} lockPath
 * @param {object} state
 * @returns {boolean}
 */
function tryWriteLock(lockPath, state) {
  let fd;
  try {
    fd = openSync(lockPath, 'wx');
  } catch (err) {
    if (err.code === 'EEXIST') return false;
    throw err;
  }
  try {
    writeSync(fd, JSON.stringify(state, null, 2), 0, 'utf-8');
  } finally {
    closeSync(fd);
  }
  return true;
}

/**
 * Build the holder record written into the lock file.
 * @param {string} featureKey
 * @param {string} sessionId
 * @param {{ repoIdentity?: string, cwd?: string }} scope
 * @returns {object}
 */
function buildHolderState(featureKey, sessionId, scope) {
  const state = {
    pid: process.pid,
    sessionId,
    acquiredAt: Date.now(),
    featureKey,
    lockKey: getLockKey(featureKey, scope),
  };
  if (scope.repoIdentity) state.repoIdentity = scope.repoIdentity;
  if (typeof scope.cwd === 'string' && scope.cwd) state.cwd = scope.cwd;
  return state;
}

/**
 * Single non-blocking attempt to acquire. Handles stale recovery once.
 * @param {string} featureKey
 * @param {string} sessionId
 * @param {{ repoIdentity?: string, cwd?: string }} scope
 * @returns {{ ok: boolean, lockPath: string, holder?: object, scheme?: 'scoped'|'legacy' }}
 */
function attemptAcquire(featureKey, sessionId, scope) {
  const lockPath = getLockPath(featureKey, scope);
  ensureDirSync(path.dirname(lockPath));
  const state = buildHolderState(featureKey, sessionId, scope);

  // Parallel legacy reader: a live pre-upgrade holder on the unscoped file
  // owns the feature until it finishes. Stale legacy files are left alone —
  // they are not ours to reclaim and cannot block anyone.
  if (scope.repoIdentity) {
    const legacy = readLegacyLock(featureKey);
    if (legacy && !isStale(legacy)) return { ok: false, lockPath, holder: legacy, scheme: 'legacy' };
  }

  if (tryWriteLock(lockPath, state)) return { ok: true, lockPath };

  // EEXIST: inspect, possibly reclaim stale
  const existing = readLock(featureKey, scope);
  if (existing && isStale(existing)) {
    // ignore: a concurrent reclaimer may have unlinked first (ENOENT harmless);
    // the O_EXCL tryWriteLock below is the real arbiter of who wins the lock.
    try { unlinkSync(lockPath); } catch { /* ignore */ }
    if (tryWriteLock(lockPath, state)) return { ok: true, lockPath };
  }
  const holder = readLock(featureKey, scope) ?? existing ?? undefined;
  return { ok: false, lockPath, holder };
}

/**
 * Acquire a feature lock. Optional polling wait until timeout.
 * @param {string} featureKey
 * @param {string} sessionId
 * @param {{ wait?: boolean, timeoutMs?: number, repoIdentity?: string, cwd?: string }} [opts]
 *   repoIdentity — scope the key to a repository (`lib/git/repo-identity.js`).
 *   cwd — recorded in the holder so preflight can tell same-tree from
 *   other-worktree peers; informational, never used for the key.
 * @returns {{ ok: boolean, lockPath: string, holder?: object, scheme?: 'scoped'|'legacy' }}
 */
export function acquireLock(featureKey, sessionId, opts = {}) {
  if (!featureKey || typeof featureKey !== 'string') {
    throw new TypeError('featureKey must be a non-empty string');
  }
  if (!sessionId || typeof sessionId !== 'string') {
    throw new TypeError('sessionId must be a non-empty string');
  }
  const safeOpts = opts && typeof opts === 'object' ? opts : {};
  const wait = safeOpts.wait === true;
  const timeoutMs = Number.isFinite(safeOpts.timeoutMs) ? safeOpts.timeoutMs : DEFAULT_TIMEOUT_MS;
  const scope = {
    repoIdentity: typeof safeOpts.repoIdentity === 'string' ? safeOpts.repoIdentity : '',
    cwd: safeOpts.cwd,
  };

  const first = attemptAcquire(featureKey, sessionId, scope);
  if (first.ok || !wait) return first;

  const deadline = Date.now() + timeoutMs;
  let last = first;
  while (Date.now() < deadline) {
    sleepSync(POLL_MS);
    last = attemptAcquire(featureKey, sessionId, scope);
    if (last.ok) return last;
  }
  return last;
}

/**
 * Synchronous sleep without busy-wait. Uses Atomics.wait on an unshared
 * Int32Array view — yields the thread to the OS scheduler instead of
 * spinning the CPU. Falls back to a single small busy-wait slice when
 * SharedArrayBuffer is unavailable in the runtime.
 * @param {number} ms
 */
function sleepSync(ms) {
  const target = Math.max(0, ms | 0);
  if (target === 0) return;
  try {
    const sab = new SharedArrayBuffer(4);
    const ia = new Int32Array(sab);
    Atomics.wait(ia, 0, 0, target);
  } catch {
    const start = Date.now();
    while (Date.now() - start < target) { /* fallback only */ }
  }
}

/**
 * Release a lock only if held by the given session. Returns true if removed.
 * Releases exactly the file the same `opts` would have acquired — a scoped
 * release never touches the legacy file and vice versa.
 * @param {string} featureKey
 * @param {string} sessionId
 * @param {{ repoIdentity?: string }} [opts]
 * @returns {boolean}
 */
export function releaseLock(featureKey, sessionId, opts = {}) {
  if (!featureKey || typeof featureKey !== 'string') {
    throw new TypeError('featureKey must be a non-empty string');
  }
  if (!sessionId || typeof sessionId !== 'string') {
    throw new TypeError('sessionId must be a non-empty string');
  }
  const holder = readLock(featureKey, opts);
  if (!holder) return false;
  if (holder.sessionId !== sessionId || holder.pid !== process.pid) return false;
  try {
    unlinkSync(getLockPath(featureKey, opts));
    return true;
  } catch {
    return false;
  }
}

/**
 * Enumerate every lock file in the store with its staleness, scoped and
 * legacy alike. Read-only; corrupt files are skipped, never deleted. Used by
 * preflight's `repoConcurrency` check to find same-repository peers.
 * @returns {Array<{ lockKey: string, lockPath: string, holder: object, stale: boolean }>}
 */
export function listLocks() {
  const locksDir = path.join(getStoreDir(), 'locks');
  if (!existsSync(locksDir)) return [];
  let entries;
  try {
    entries = readdirSync(locksDir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of entries) {
    if (!name.endsWith('.lock')) continue;
    const lockPath = path.join(locksDir, name);
    const holder = readLockFile(lockPath);
    if (!holder) continue;
    out.push({ lockKey: name.slice(0, -5), lockPath, holder, stale: isStale(holder) });
  }
  return out;
}

/**
 * Release every lock currently held by the given session. Intended for
 * session-shutdown / crash-recovery flows where the engine wants to drop
 * all of its outstanding feature claims at once.
 *
 * Locks held by a different session (or with unreadable/corrupt files)
 * are left alone and reported in `skipped`. PID is intentionally NOT
 * checked here — a recovering process inheriting a crashed session's
 * sessionId should still be able to clear its own locks. Stale detection
 * is handled separately by {@link acquireLock}.
 *
 * @param {string} sessionId
 * @returns {{ released: string[], skipped: string[] }}
 */
export function releaseAllForSession(sessionId) {
  if (!sessionId || typeof sessionId !== 'string') {
    throw new TypeError('sessionId must be a non-empty string');
  }
  const released = [];
  const skipped = [];
  const locksDir = path.join(getStoreDir(), 'locks');
  if (!existsSync(locksDir)) return { released, skipped };

  let entries;
  try {
    entries = readdirSync(locksDir);
  } catch {
    return { released, skipped };
  }

  for (const name of entries) {
    if (!name.endsWith('.lock')) continue;
    const featureKey = name.slice(0, -5);
    const lockPath = path.join(locksDir, name);
    let holder;
    try {
      const raw = readFileSync(lockPath, 'utf-8');
      holder = JSON.parse(raw);
    } catch {
      // Corrupt or unreadable lock — skip rather than delete blindly.
      skipped.push(featureKey);
      continue;
    }
    if (!holder || holder.sessionId !== sessionId) {
      skipped.push(featureKey);
      continue;
    }
    try {
      unlinkSync(lockPath);
      released.push(featureKey);
    } catch {
      skipped.push(featureKey);
    }
  }
  return { released, skipped };
}
