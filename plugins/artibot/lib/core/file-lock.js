/**
 * File-level advisory lock for state file race condition prevention.
 *
 * Provides a simple retry-loop lock using .lock sentinel files
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
 * even while it is waiting for the lock, stranding the `.lock` file. With a
 * listener the signal is queued until the event loop turns, so the synchronous
 * body — including the `finally` that unlinks the lock — runs to completion
 * first. The
 * handler then unlinks whatever is still registered and re-raises the signal,
 * so the exit status stays a signal death rather than a normal exit — provided
 * no other SIGTERM/SIGINT listener remains on this process. Another listener
 * catches the re-raise too, which suppresses the default action; if its handler
 * neither exits nor re-raises, the process survives the signal instead. See the
 * same caveat on releaseLocksAndReRaise() below.
 *
 * Not covered:
 * - **Windows** — no POSIX signal delivery. `child.kill('SIGTERM')` maps to
 *   TerminateProcess, which kills unconditionally without running the handler
 *   (measured; see tests/core/file-lock-signal.test.js). This protection is
 *   POSIX-only, and Windows is a primary development platform here, so treat
 *   the stale-lock sweep — not this — as the Windows story.
 * - **SIGKILL / power loss** — undeliverable to userspace; nothing runs.
 * - **A signal during an unbounded CPU-bound block** — delivery is deferred to
 *   the next event-loop turn, so a body that never returns is never rescued.
 * - **The registration window** — a signal landing between the writeFileSync
 *   that creates the lock and installSignalHandlers() strands the file, since
 *   no listener is installed and the path is not yet in the active set.
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

/**
 * Backing cell for the retry sleep. Nothing ever writes to it or notifies on
 * it, so `Atomics.wait` on index 0 for value 0 always runs the full timeout
 * and returns `'timed-out'` — i.e. it is a synchronous sleep that yields the
 * CPU. Allocated once; every waiter times out independently, so sharing one
 * cell across nested or re-entrant calls is safe.
 */
const RETRY_SLEEP_CELL = new Int32Array(new SharedArrayBuffer(4));

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
 * The death is only guaranteed while no other SIGTERM/SIGINT listener is
 * registered on this process: removing ours restores the default disposition
 * only if ours were the last. A surviving listener catches the re-raise and
 * suppresses the default action, so a handler that neither exits nor re-raises
 * leaves the process alive. `lib/system/keep-awake.js:154-156` registers such a
 * cleanup; nothing imports it and withFileLock into the same process today
 * (keep-awake reaches only lib/autopilot/, withFileLock only the hook scripts
 * and lib/core/rotation.js), so this is a constraint on future wiring rather
 * than a live defect.
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

    // Synchronous sleep that yields the CPU. Measured on Node 24 / Windows:
    // returns 'timed-out' after ~56ms for a 50ms request, consuming 0.0% of a
    // core, where the busy-wait it replaces burned 96.7% of one core for the
    // same wall time. Contended hooks no longer pin a core while waiting.
    // The OS timer granularity means each retry overshoots slightly, so a
    // 5s window fits ~89 retries rather than ~100; the timeout itself is
    // wall-clock checked above and is unaffected.
    Atomics.wait(RETRY_SLEEP_CELL, 0, 0, LOCK_RETRY_MS);
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
