/**
 * File-level advisory lock for state file race condition prevention.
 *
 * Provides a simple spin-lock mechanism using .lock sentinel files
 * to serialize read-modify-write operations on shared state files.
 * Designed for short-lived hook processes where OS-level locking
 * (flock/LockFileEx) is unreliable across platforms.
 *
 * Fail-open: If the lock cannot be acquired, the operation proceeds
 * without locking rather than blocking the user workflow.
 *
 * @module lib/core/file-lock
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Maximum time (ms) to wait for a lock before forcing acquisition. */
const LOCK_TIMEOUT_MS = 5000;

/** Interval (ms) between lock acquisition retries. */
const LOCK_RETRY_MS = 50;

/**
 * Execute a function while holding an advisory file lock.
 *
 * The lock is a JSON sentinel file (`<filePath>.lock`) containing the
 * owning PID and timestamp. Stale locks (older than LOCK_TIMEOUT_MS)
 * are automatically cleaned up.
 *
 * @param {string} filePath - The file being protected
 * @param {() => T} fn - Synchronous function to execute under lock
 * @returns {T} Return value of `fn`
 * @template T
 */
export function withFileLock(filePath, fn) {
  const lockPath = filePath + '.lock';
  const start = Date.now();

  // Spin-wait for existing lock to release
  while (existsSync(lockPath)) {
    try {
      const lockData = JSON.parse(readFileSync(lockPath, 'utf-8'));
      if (Date.now() - lockData.timestamp > LOCK_TIMEOUT_MS) {
        // Stale lock — remove and proceed
        try { unlinkSync(lockPath); } catch { /* ignore */ }
        break;
      }
    } catch {
      // Corrupt lock file — remove and proceed
      try { unlinkSync(lockPath); } catch { /* ignore */ }
      break;
    }

    if (Date.now() - start > LOCK_TIMEOUT_MS) {
      // Timeout — force-remove and proceed (fail-open)
      try { unlinkSync(lockPath); } catch { /* ignore */ }
      break;
    }

    // Busy-wait (hooks are short-lived processes, sleep is not available)
    const waitUntil = Date.now() + LOCK_RETRY_MS;
    while (Date.now() < waitUntil) { /* spin */ }
  }

  // Acquire lock
  try {
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: process.pid, timestamp: Date.now() }),
    );
  } catch {
    // If we cannot create the lock, proceed without it (fail-open)
  }

  try {
    return fn();
  } finally {
    try { unlinkSync(lockPath); } catch { /* ignore */ }
  }
}
