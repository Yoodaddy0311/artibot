/**
 * File-level exclusive lock for state file read-modify-write sections.
 *
 * The lock is a sentinel file (`<filePath>.lock`) created with O_EXCL
 * (`openSync(…, 'wx')`), so exactly one process can create it; everyone else
 * gets EEXIST and waits. The file holds a JSON record
 * `{ pid, host, token, timestamp }`, where `token` is a per-acquisition UUID.
 *
 * ## Contract: fail-closed
 *
 * - **Contended past LOCK_WAIT_MS** — throws an Error with
 *   `code: 'ELOCKTIMEOUT'`, `lockPath`, `holder` (the parsed record, or null)
 *   and `cause` (the last create error). `fn` is NOT run and the holder's lock
 *   is NOT touched.
 * - **Lock cannot be created for a non-contention reason** (mkdir fails,
 *   read-only filesystem, disk full, …) — the original error is rethrown at
 *   once with its `code` intact. `fn` is NOT run. Exception: EPERM, EACCES and
 *   EBUSY from the create are treated as contention, because that is how
 *   Windows reports a name whose previous lock is still delete-pending. So a
 *   directory that is genuinely unwritable ends as ELOCKTIMEOUT after
 *   LOCK_WAIT_MS with `cause.code` EACCES/EPERM, not as an immediate rethrow.
 * - **Stale lock** — reclaimed, never stolen: a parseable record is stale when
 *   its owner is on this host and its pid is dead, or its timestamp is older
 *   than LOCK_STALE_MS; an unparseable (empty or half-written) file is stale
 *   only when its mtime is older than LOCK_STALE_MS, because a holder that has
 *   created the file but not finished writing it looks exactly like that.
 *   Reclaim runs under a second O_EXCL guard (`<lockPath>.reclaim`), re-reads
 *   the lock, and unlinks it only if it is byte-for-byte the file that was
 *   judged stale (content + mtime), so a lock that changed hands in between is
 *   left alone. After the unlink the reclaimer re-enters the O_EXCL race like
 *   everyone else; it never assumes ownership. The guard itself goes stale on
 *   the same rules as a lock (dead pid on this host, or older than
 *   LOCK_STALE_MS), so a live reclaimer is never pre-empted inside it.
 * - **Release** — unlinks the lock only while the on-disk token is ours, so a
 *   lock another owner put in place (after judging ours stale) survives.
 * - **Re-entry is refused** — a call for a path this process already holds
 *   throws `code: 'ELOCKREENTRANT'` (with `lockPath`) at once, without waiting
 *   or running `fn`; the outer lock is untouched. Passing it through would
 *   hide a logic error: a nested read-modify-write inside the outer one (e.g.
 *   a StateStore commit inside a mutator) writes N+1, then the outer writes
 *   N+1 again from its stale read. Paths are compared as given
 *   (`filePath + '.lock'`), not normalised.
 *
 * ## What this does not cover
 *
 * - **A holder slower than LOCK_STALE_MS.** Its record counts as stale by
 *   timestamp, so another process can reclaim the lock while `fn` still runs.
 *   Keep locked sections short.
 * - **Check-then-unlink windows.** Release and reclaim read the file, then
 *   unlink it; a lock replaced between the two syscalls is removed.
 *   - Reclaim does this under the `.reclaim` guard, which another process can
 *     take over only when the guard's owner is a dead pid on this host or the
 *     guard is older than LOCK_STALE_MS. So the window opens only for a
 *     reclaimer that stalls longer than LOCK_STALE_MS between its re-read and
 *     its unlink, or one on another host. Removing a stale guard is itself a
 *     read-then-unlink with no further guard.
 *   - Release has no guard. The window needs our own record to have been
 *     judged stale first (we held the lock past LOCK_STALE_MS), and is as wide
 *     as the two syscalls.
 * - **A release whose read fails.** Release unlinks only after reading our
 *   token back; if that read fails (EACCES, EBUSY, …) or the unlink fails,
 *   our lock is left on disk. Other processes wait on it until its pid is dead
 *   on this host (it is reclaimed at once after we exit) or its timestamp
 *   passes LOCK_STALE_MS; waiters in the meantime get ELOCKTIMEOUT.
 * - **pid reuse.** A dead owner whose pid was reused on the same host counts
 *   as alive until the timestamp ages past LOCK_STALE_MS.
 * - **Other hosts.** A record from another host (shared/network filesystem)
 *   is judged by timestamp only, which assumes roughly synchronised clocks.
 *   O_EXCL itself is not guaranteed on every network filesystem.
 * - **Fairness.** Waiters poll at a jittered interval; there is no queue, so
 *   a process that releases and immediately re-locks can win again, and
 *   enough sustained contenders can still push one waiter past LOCK_WAIT_MS.
 *
 * ## Signal safety — what it does and does not cover
 *
 * Holding a lock installs one SIGTERM/SIGINT listener pair. The protection is
 * mostly indirect: with no listener the kernel kills the process *immediately*,
 * even while it is waiting for the lock, stranding the `.lock` file. With a
 * listener the signal is queued until the event loop turns, so the synchronous
 * body — including the `finally` that releases the lock — runs to completion
 * first. The handler then releases whatever is still registered (token-checked,
 * like a normal release) and re-raises the signal, so the exit status stays a
 * signal death rather than a normal exit — provided no other SIGTERM/SIGINT
 * listener remains on this process. Another listener catches the re-raise too,
 * which suppresses the default action; if its handler neither exits nor
 * re-raises, the process survives the signal instead. See the same caveat on
 * releaseLocksAndReRaise() below.
 *
 * Not covered:
 * - **Windows** — no POSIX signal delivery. `child.kill('SIGTERM')` maps to
 *   TerminateProcess, which kills unconditionally without running the handler
 *   (measured; see tests/core/file-lock-signal.test.js). This protection is
 *   POSIX-only, and Windows is a primary development platform here, so treat
 *   the stale-lock reclaim — not this — as the Windows story.
 * - **SIGKILL / power loss** — undeliverable to userspace; nothing runs.
 * - **A signal during an unbounded CPU-bound block** — delivery is deferred to
 *   the next event-loop turn, so a body that never returns is never rescued.
 * - **The registration window** — a signal landing between the O_EXCL create
 *   and installSignalHandlers() strands the file, since no listener is
 *   installed and the path is not yet registered.
 * - **Cross-process staleness** — a lock stranded by any of the above is
 *   reclaimed by the stale rules above (dead pid on this host, or older than
 *   LOCK_STALE_MS), not by signals.
 *
 * @module lib/core/file-lock
 */

import { randomUUID } from 'node:crypto';
import {
  closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { dirname } from 'node:path';
import { sleepSync } from './file.js';

/** Maximum time (ms) to wait for a contended lock before ELOCKTIMEOUT. */
const LOCK_WAIT_MS = 2000;

/** Age (ms) past which a lock record or an unparseable lock file is stale. */
const LOCK_STALE_MS = 10000;

/**
 * Retry interval bounds (ms); each wait picks a uniform value in between.
 *
 * Jittered and short rather than a fixed 50ms: with a fixed interval the
 * worst wait grows roughly as waiters x interval. Measured 2026-09-23 on a
 * loaded Windows machine, 32 one-shot contenders: max wait 1,917ms with a
 * fixed 50ms vs 1,017ms with 10-25ms jitter, 0 lost updates either way.
 * sleepSync is Atomics.wait, so the shorter sleep yields the CPU instead of
 * spinning.
 */
const LOCK_RETRY_MIN_MS = 10;
const LOCK_RETRY_MAX_MS = 25;

/**
 * Create errors that mean "someone else has (or is removing) the file".
 * EPERM/EACCES/EBUSY cover Windows, where creating a name whose previous file
 * is still delete-pending or open fails with those instead of EEXIST.
 */
const CONTENDED_CODES = new Set(['EEXIST', 'EPERM', 'EACCES', 'EBUSY']);

/** Signals intercepted so held locks are released before the process dies. */
const RELEASE_SIGNALS = ['SIGTERM', 'SIGINT'];

const HOST = hostname();

/** Lock paths this process currently holds, mapped to our token for each. */
const heldLocks = new Map();

/**
 * Installed signal handlers, keyed by signal. Empty until the first lock is
 * acquired; exactly one entry per signal thereafter.
 */
const signalHandlers = new Map();

/**
 * Same rule as lib/git/landing-lock.js#defaultIsPidAlive: EPERM means the
 * process exists but belongs to someone else, so it counts as alive.
 *
 * @param {unknown} pid
 * @returns {boolean}
 */
function isPidAlive(pid) {
  if (typeof pid !== 'number' || !Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

/**
 * Create `path` exclusively and write `record` into it. The fd is closed
 * before returning, so the file can be unlinked and recreated on Windows.
 *
 * @param {string} path
 * @param {object} record
 * @returns {Error|null} null on success, the create error when contended.
 * @throws The create error when it is not a contention code; the write or
 *   close error (after removing the half-created file) when those fail.
 */
function createExclusive(path, record) {
  let fd;
  try {
    fd = openSync(path, 'wx');
  } catch (err) {
    if (CONTENDED_CODES.has(err?.code)) return err;
    throw err;
  }
  try {
    writeSync(fd, JSON.stringify(record));
    closeSync(fd);
  } catch (err) {
    try { closeSync(fd); } catch { /* already closed or failing */ }
    try { unlinkSync(path); } catch { /* best-effort */ }
    throw err;
  }
  return null;
}

/**
 * Snapshot a lock (or guard) file.
 *
 * @param {string} path
 * @returns {{ vanished: true } | { vanished: false, raw: string|null, mtimeMs: number|null, record: object|null }}
 *   `raw`/`mtimeMs` are null when the file exists but could not be read.
 */
function inspect(path) {
  let mtimeMs;
  let raw;
  try {
    mtimeMs = statSync(path).mtimeMs;
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    if (err?.code === 'ENOENT') return { vanished: true };
    return { vanished: false, raw: null, mtimeMs: null, record: null };
  }
  let record = null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && typeof parsed.timestamp === 'number') {
      record = parsed;
    }
  } catch { /* unparseable: judged by mtime */ }
  return { vanished: false, raw, mtimeMs, record };
}

/**
 * @param {{ raw: string|null, mtimeMs: number|null, record: object|null }} seen
 * @param {number} staleMs - Age threshold for the timestamp / mtime.
 * @returns {boolean}
 */
function isStale(seen, staleMs) {
  const now = Date.now();
  if (seen.record) {
    const { host, pid, timestamp } = seen.record;
    return (host === HOST && !isPidAlive(pid)) || now - timestamp > staleMs;
  }
  // Unreadable: nothing to judge by, so never stale.
  if (seen.mtimeMs === null) return false;
  return now - seen.mtimeMs > staleMs;
}

/**
 * True while `path` still is exactly the file we snapshotted.
 *
 * @param {string} path
 * @param {{ raw: string|null, mtimeMs: number|null }} seen
 * @returns {boolean}
 */
function unchangedSince(path, seen) {
  return sameFile(inspect(path), seen);
}

/**
 * @param {ReturnType<typeof inspect>} now
 * @param {{ raw: string|null, mtimeMs: number|null }} seen
 * @returns {boolean} True when `now` is a readable snapshot identical to `seen`.
 */
function sameFile(now, seen) {
  return !now.vanished && now.raw !== null
    && now.raw === seen.raw && now.mtimeMs === seen.mtimeMs;
}

/**
 * Unlink `path` only if it carries `token`.
 *
 * @param {string} path
 * @param {string} token
 * @returns {void}
 */
function unlinkIfOwned(path, token) {
  const seen = inspect(path);
  if (seen.vanished || seen.record?.token !== token) return;
  try { unlinkSync(path); } catch { /* best-effort */ }
}

/**
 * Take the reclaim guard. A stale guard is removed (if unchanged) but not
 * taken in the same turn, so two waiters that both judged it stale do not
 * both go on to create one.
 *
 * The guard goes stale on the same rules and threshold as a lock
 * (LOCK_STALE_MS, or a dead pid on this host) — not sooner. A shorter
 * threshold let a live reclaimer that stalled between its re-read and its
 * unlink lose the guard to a second reclaimer, which then removed the stale
 * lock and created its own; the first reclaimer's unlink then removed that
 * fresh lock, and a third process could co-hold it. The cost is that a
 * reclaimer that crashed on another host (or whose pid was reused) blocks
 * reclaim of that one lock for LOCK_STALE_MS.
 *
 * @param {string} guardPath
 * @returns {string|null} Our guard token, or null when the guard is busy.
 */
function takeReclaimGuard(guardPath) {
  const token = randomUUID();
  const record = { pid: process.pid, host: HOST, token, timestamp: Date.now() };
  if (createExclusive(guardPath, record) === null) return token;
  const seen = inspect(guardPath);
  if (!seen.vanished && isStale(seen, LOCK_STALE_MS) && unchangedSince(guardPath, seen)) {
    try { unlinkSync(guardPath); } catch { /* next turn */ }
  }
  return null;
}

/**
 * Remove a lock judged stale, if it is still the same file.
 *
 * @param {string} lockPath
 * @param {{ raw: string|null, mtimeMs: number|null }} seen - What was judged stale.
 * @returns {boolean} True only when the lock is gone (we removed it, or it
 *   vanished), so an immediate retry can succeed. False — busy guard, a lock
 *   that changed, or an unlink that failed — sends the caller to its jittered
 *   sleep, so a stale lock that cannot be removed is polled, not spun on.
 */
function reclaimStale(lockPath, seen) {
  const guardPath = `${lockPath}.reclaim`;
  const guardToken = takeReclaimGuard(guardPath);
  if (guardToken === null) return false;
  try {
    const now = inspect(lockPath);
    if (now.vanished) return true;
    if (!sameFile(now, seen)) return false;
    try {
      unlinkSync(lockPath);
      return true;
    } catch (err) {
      return err?.code === 'ENOENT';
    }
  } finally {
    unlinkIfOwned(guardPath, guardToken);
  }
}

/**
 * @param {string} lockPath
 * @param {object|null} holder
 * @param {Error|null} cause
 * @returns {Error}
 */
function timeoutError(lockPath, holder, cause) {
  return Object.assign(
    new Error(`withFileLock: ${lockPath} not acquired within ${LOCK_WAIT_MS}ms`, { cause }),
    { code: 'ELOCKTIMEOUT', lockPath, holder },
  );
}

/** @returns {number} A retry delay in [LOCK_RETRY_MIN_MS, LOCK_RETRY_MAX_MS]. */
function retryDelayMs() {
  return LOCK_RETRY_MIN_MS + Math.random() * (LOCK_RETRY_MAX_MS - LOCK_RETRY_MIN_MS);
}

/**
 * Acquire `lockPath` exclusively or throw.
 *
 * @param {string} lockPath
 * @returns {string} Our token.
 */
function acquire(lockPath) {
  mkdirSync(dirname(lockPath), { recursive: true });
  const token = randomUUID();
  const start = Date.now();
  let holder = null;
  for (;;) {
    const record = { pid: process.pid, host: HOST, token, timestamp: Date.now() };
    const contended = createExclusive(lockPath, record);
    if (contended === null) return token;

    const seen = inspect(lockPath);
    let retryNow = false;
    if (seen.vanished) {
      // Released between our create and our look. EEXIST means the name is
      // free now; a Windows delete-pending error needs a moment to clear.
      retryNow = contended.code === 'EEXIST';
    } else {
      holder = seen.record;
      if (isStale(seen, LOCK_STALE_MS)) retryNow = reclaimStale(lockPath, seen);
    }

    const waited = Date.now() - start;
    if (waited >= LOCK_WAIT_MS) throw timeoutError(lockPath, holder, contended);
    // One jittered sleep for every non-immediate retry — a live holder, a busy
    // reclaim guard and a Windows delete-pending name alike. The OS timer
    // overshoots each sleep slightly; the budget is wall-clock checked above.
    if (!retryNow) sleepSync(Math.min(retryDelayMs(), LOCK_WAIT_MS - waited));
  }
}

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
 * Signal handler: release every held lock whose on-disk token is still ours,
 * then re-raise the signal so the process still dies of what killed it.
 * Re-raising (rather than `process.exit`) preserves the signal exit status
 * that dispatchers and shells use for accounting.
 *
 * The death is only guaranteed while no other SIGTERM/SIGINT listener is
 * registered on this process: removing ours restores the default disposition
 * only if ours were the last. A surviving listener catches the re-raise and
 * suppresses the default action, so a handler that neither exits nor re-raises
 * leaves the process alive. `lib/system/keep-awake.js:154-156` registers such a
 * cleanup. keep-awake is imported only by lib/autopilot/ (engine.js via
 * _engine-helpers.js) and lib/system/index.js. withFileLock is reached from
 * the hook scripts, lib/core/rotation.js, and lib/project-state/state-manager.js
 * (the StateStore commit), which is itself imported by
 * lib/runtime/middleware/tasks.js, lib/handoff/state-version-port.js and
 * several scripts. The direct imports of lib/autopilot/engine.js and
 * _engine-helpers.js include none of those (checked 2026-09-23); the full
 * transitive import graph was not traced. Treat this as a constraint on
 * future wiring rather than a known live defect.
 *
 * @param {string} signal - The signal being handled.
 * @returns {void}
 */
function releaseLocksAndReRaise(signal) {
  for (const [lockPath, token] of heldLocks) {
    unlinkIfOwned(lockPath, token);
  }
  heldLocks.clear();
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
 * Execute a function while holding an exclusive file lock.
 *
 * Fail-closed: throws (ELOCKTIMEOUT, or the original create error) without
 * running `fn` when the lock cannot be taken. See the module header.
 *
 * @param {string} filePath - The file being protected
 * @param {() => T} fn - Synchronous function to execute under lock
 * @returns {T} Return value of `fn`
 * @throws {Error} `code: 'ELOCKTIMEOUT'` when not acquired within
 *   LOCK_WAIT_MS — including a create that keeps failing with EPERM, EACCES
 *   or EBUSY (treated as contention; the last one is `cause`);
 *   `code: 'ELOCKREENTRANT'` when this process already holds the path; the
 *   mkdir or create error with its own code (e.g. EACCES from mkdir, EROFS,
 *   ENOSPC) otherwise, at once.
 * @template T
 */
export function withFileLock(filePath, fn) {
  const lockPath = filePath + '.lock';
  if (heldLocks.has(lockPath)) {
    throw Object.assign(
      new Error(`withFileLock: ${lockPath} is already held by this process (re-entry refused)`),
      { code: 'ELOCKREENTRANT', lockPath },
    );
  }

  const token = acquire(lockPath);
  heldLocks.set(lockPath, token);
  installSignalHandlers();
  try {
    return fn();
  } finally {
    heldLocks.delete(lockPath);
    unlinkIfOwned(lockPath, token);
  }
}
