/**
 * Cross-process atomic file lock for autopilot features.
 * Uses fs.openSync with 'wx' flag for atomic O_EXCL acquisition.
 * Korean / spaced path safe (uses path.join only).
 *
 * Lock state schema: { pid, sessionId, acquiredAt, featureKey }
 *
 * @module lib/autopilot/lock
 */

import path from 'node:path';
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { ensureDirSync } from '../core/file.js';
import { getStoreDir } from './session-store.js';

const STALE_MS = 24 * 60 * 60 * 1000; // 24 hours
const POLL_MS = 100;
const DEFAULT_TIMEOUT_MS = 5000;

/**
 * Resolve the absolute lock file path for a feature key.
 * @param {string} featureKey
 * @returns {string}
 */
export function getLockPath(featureKey) {
  if (!featureKey || typeof featureKey !== 'string') {
    throw new TypeError('featureKey must be a non-empty string');
  }
  return path.join(getStoreDir(), 'locks', `${featureKey}.lock`);
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
 * Read raw lock JSON. Returns null if missing or unparseable.
 * @param {string} featureKey
 * @returns {object|null}
 */
export function readLock(featureKey) {
  const lockPath = getLockPath(featureKey);
  try {
    if (!existsSync(lockPath)) return null;
    const raw = readFileSync(lockPath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Determine whether a holder record is stale (dead PID or older than 24h).
 * @param {object} holder
 * @returns {boolean}
 */
function isStale(holder) {
  if (!holder || typeof holder !== 'object') return true;
  const ageMs = Date.now() - (holder.acquiredAt ?? 0);
  if (ageMs > STALE_MS) return true;
  if (!isPidAlive(holder.pid)) return true;
  return false;
}

/**
 * Inspect lock state without acquiring.
 * @param {string} featureKey
 * @returns {{ locked: boolean, holder?: object, stale?: boolean }}
 */
export function isLocked(featureKey) {
  const holder = readLock(featureKey);
  if (!holder) return { locked: false };
  const stale = isStale(holder);
  return { locked: !stale, holder, stale };
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
 * Single non-blocking attempt to acquire. Handles stale recovery once.
 * @param {string} featureKey
 * @param {string} sessionId
 * @returns {{ ok: boolean, lockPath: string, holder?: object }}
 */
function attemptAcquire(featureKey, sessionId) {
  const lockPath = getLockPath(featureKey);
  ensureDirSync(path.dirname(lockPath));
  const state = { pid: process.pid, sessionId, acquiredAt: Date.now(), featureKey };

  if (tryWriteLock(lockPath, state)) return { ok: true, lockPath };

  // EEXIST: inspect, possibly reclaim stale
  const existing = readLock(featureKey);
  if (existing && isStale(existing)) {
    try { unlinkSync(lockPath); } catch { /* ignore */ }
    if (tryWriteLock(lockPath, state)) return { ok: true, lockPath };
  }
  const holder = readLock(featureKey) ?? existing ?? undefined;
  return { ok: false, lockPath, holder };
}

/**
 * Acquire a feature lock. Optional polling wait until timeout.
 * @param {string} featureKey
 * @param {string} sessionId
 * @param {{ wait?: boolean, timeoutMs?: number }} [opts]
 * @returns {{ ok: boolean, lockPath: string, holder?: object }}
 */
export function acquireLock(featureKey, sessionId, opts = {}) {
  if (!featureKey || typeof featureKey !== 'string') {
    throw new TypeError('featureKey must be a non-empty string');
  }
  if (!sessionId || typeof sessionId !== 'string') {
    throw new TypeError('sessionId must be a non-empty string');
  }
  const wait = opts.wait === true;
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;

  const first = attemptAcquire(featureKey, sessionId);
  if (first.ok || !wait) return first;

  const deadline = Date.now() + timeoutMs;
  let last = first;
  while (Date.now() < deadline) {
    sleepSync(POLL_MS);
    last = attemptAcquire(featureKey, sessionId);
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
 * @param {string} featureKey
 * @param {string} sessionId
 * @returns {boolean}
 */
export function releaseLock(featureKey, sessionId) {
  if (!featureKey || typeof featureKey !== 'string') {
    throw new TypeError('featureKey must be a non-empty string');
  }
  if (!sessionId || typeof sessionId !== 'string') {
    throw new TypeError('sessionId must be a non-empty string');
  }
  const holder = readLock(featureKey);
  if (!holder) return false;
  if (holder.sessionId !== sessionId || holder.pid !== process.pid) return false;
  try {
    unlinkSync(getLockPath(featureKey));
    return true;
  } catch {
    return false;
  }
}
