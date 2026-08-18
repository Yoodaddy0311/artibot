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
 * ## Signal safety — what it does and does not cover
 *
 * Holding a lock installs one SIGTERM/SIGINT listener pair. The protection is
 * mostly indirect: with no listener the kernel kills the process *immediately*,
 * even mid-spin-wait, stranding the `.lock` file. With a listener the signal is
 * queued until the event loop turns, so the synchronous body — including the
 * `finally` that unlinks the lock — always runs to completion first. The
 * handler then unlinks whatever is still registered and re-raises the signal so
 * the exit status stays a signal death rather than a normal exit.
 *
 * Not covered:
 * - **SIGKILL / power loss** — undeliverable to userspace; nothing runs.
 * - **A signal during an unbounded CPU-bound block** — delivery is deferred to
 *   the next event-loop turn, so a body that never returns is never rescued.
 * - **Cross-process staleness** — a lock stranded by any of the above is
 *   reclaimed by the stale-lock sweep below (LOCK_TIMEOUT_MS), not by signals.
 *
 * @module lib/core/file-lock
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Maximum time (ms) to wait for a lock before forcing acquisition. */
const LOCK_TIMEOUT_MS = 5000;

/** Interval (ms) between lock acquisition retries. */
const LOCK_RETRY_MS = 50;

/** Signals intercepted so held locks are released before the process dies. */
const RELEASE_SIGNALS = ['SIGTERM', 'SIGINT'];

/**
 * Lock paths this process currently holds. A Set (not a counter) so that
 * re-entering the same path cannot double-count it.
 */
const activeLockPaths = new Set();

/**
 * Installed signal handlers, keyed by signal. Empty until the first lock is
 * acquired; exactly one entry per signal thereafter.
 */
const signalHandlers = new Map();

/**
 * Remove our signal listeners, restoring the default disposition.
 * Idempotent.
 *
 * @returns {void}
 */
function removeSignalHandlers() {
  for (const [signal, handler] of signalHandlers) {
    process.removeListener(signal, handler);
  }
  signalHandlers.clear();
}

/**
 * Signal handler: drop every held lock, then re-raise the signal so the
 * process still dies of what killed it. Re-raising (rather than
 * `process.exit`) preserves the signal exit status that dispatchers and
 * shells use for accounting.
 *
 * @param {string} signal - The signal being handled.
 * @returns {void}
 */
function releaseLocksAndReRaise(signal) {
  for (const lockPath of activeLockPaths) {
    try { unlinkSync(lockPath); } catch { /* best-effort */ }
  }
  activeLockPaths.clear();
  // Remove first, otherwise the re-raise re-enters this handler forever.
  removeSignalHandlers();
  process.kill(process.pid, signal);
}

/**
 * Install exactly one listener per signal, once per process.
 *
 * Deliberately never uninstalled on lock release: a signal that arrived during
 * the lock window is delivered on the *next* event-loop turn, so removing the
 * listener at release time would leave that queued signal with no listener and
 * the process would swallow it entirely and keep running. One bounded pair per
 * process is the cost of not losing signals.
 *
 * @returns {void}
 */
function installSignalHandlers() {
  if (signalHandlers.size > 0) return;
  for (const signal of RELEASE_SIGNALS) {
    const handler = () => releaseLocksAndReRaise(signal);
    signalHandlers.set(signal, handler);
    process.on(signal, handler);
  }
}

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
    // Registered only on a real acquisition — the fail-open path below leaves
    // no lock file, so there is nothing for the signal handler to clean up.
    activeLockPaths.add(lockPath);
    installSignalHandlers();
  } catch {
    // If we cannot create the lock, proceed without it (fail-open)
  }

  try {
    return fn();
  } finally {
    try { unlinkSync(lockPath); } catch { /* ignore */ }
    activeLockPaths.delete(lockPath);
  }
}
