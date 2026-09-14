/**
 * Session store for autopilot runs.
 * Persists state to runtime/autopilot/{sessionId}.json.
 * Korean-path safe; uses atomic writes to prevent partial-write corruption.
 *
 * Schema reference: PRD docs/PRD/autopilot-mode.md section 13.4
 *
 * @module lib/autopilot/session-store
 */

import path from 'node:path';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { getPluginRoot } from '../core/platform.js';
import { resolveRunEventsPath } from '../observability/run-events.js';
import { migrateV2toV3, SCHEMA_VERSION_V3 } from './migrate-v3.js';

/**
 * Current persisted-state schema version. Bump when the on-disk shape
 * gains a required field or changes semantics. Older state files are
 * upgraded transparently in {@link loadSession} via {@link migrateState}.
 *
 * v1: pre-versioned legacy state (no `schemaVersion` field).
 * v2: guarantees `queuedQuestions`, `checkpoints`, `timeline` arrays.
 * v3: adds `subCheckpoints`, `attemptJournal`, and `pendingPhase` — the
 *     explicit "what runs next" that disambiguates `phase` (see
 *     engine-state.js#nextTarget).
 */
export const CURRENT_SCHEMA_VERSION = SCHEMA_VERSION_V3;

/** Intermediate version stamped before the v2→v3 step, which rejects v<2. */
const SCHEMA_VERSION_V2 = 2;


/**
 * Filesystem error codes that indicate a transient lock on a freshly-written
 * file (antivirus / OneDrive / search-indexer holding a momentary handle on
 * Windows) rather than a hard failure. These are safe to retry.
 * @type {ReadonlySet<string>}
 */
const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

/**
 * Max number of rename attempts before giving up and propagating the error.
 *
 * Raised 5 → 8 (S3, 2026-07): under full-suite cross-project worker saturation
 * the `main` pool's parallel FS churn competes with the autopilot fork, and a
 * transient Windows rename lock (EPERM/EBUSY) intermittently outlived the old
 * 5-attempt / ~310ms budget — surfacing as `renameWithRetry` throwing out of
 * `saveSession` → `persist` → `runPhase2Execute` (engine.execute-worktree
 * case 3 flake). 8 attempts with a capped backoff give a bounded ~810ms budget.
 * @type {number}
 */
const MAX_RENAME_ATTEMPTS = 8;

/**
 * Upper bound (ms) for a single inter-attempt backoff sleep. Caps the
 * exponential growth so a late attempt cannot block the synchronous save path
 * for an unbounded stretch (8 uncapped attempts would sleep 640ms before the
 * last try alone). @type {number}
 */
const MAX_RENAME_BACKOFF_MS = 250;

/**
 * Block the current thread for {@link ms} milliseconds without busy-looping.
 * Uses Atomics.wait on a throwaway SharedArrayBuffer so the synchronous
 * saveSession path can back off between retries without spinning the CPU.
 * @param {number} ms - non-negative milliseconds to sleep
 * @returns {void}
 */
function sleepSync(ms) {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Atomically rename {@link tmp} to {@link filePath} with bounded retry on
 * transient Windows file locks (EPERM/EBUSY/EACCES). Backoff is exponential
 * (~10ms doubling) but capped at {@link MAX_RENAME_BACKOFF_MS} per sleep, across
 * up to {@link MAX_RENAME_ATTEMPTS} attempts. Non-transient errors propagate
 * immediately. After the final failed attempt the original error is re-thrown so
 * the caller's cleanup contract is unchanged.
 * @param {string} tmp - source temp path
 * @param {string} filePath - destination final path
 * @returns {void}
 */
function renameWithRetry(tmp, filePath) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      renameSync(tmp, filePath);
      return;
    } catch (err) {
      const transient = TRANSIENT_RENAME_CODES.has(err.code);
      if (!transient || attempt >= MAX_RENAME_ATTEMPTS) throw err;
      sleepSync(Math.min(10 * 2 ** (attempt - 1), MAX_RENAME_BACKOFF_MS));
    }
  }
}

/**
 * Resolve the autopilot runtime directory inside the plugin root.
 * Path is constructed via path.join so Korean / spaced paths are preserved.
 * @returns {string} absolute directory path
 */
export function getStoreDir() {
  return path.join(getPluginRoot(), 'runtime', 'autopilot');
}

/**
 * Resolve the absolute path of a session JSON file.
 * @param {string} sessionId
 * @returns {string}
 */
export function getSessionPath(sessionId) {
  if (!sessionId || typeof sessionId !== 'string') {
    throw new TypeError('sessionId must be a non-empty string');
  }
  return path.join(getStoreDir(), `${sessionId}.json`);
}

/**
 * Atomically persist a session state object.
 * Creates parent dir if missing. Stamps {@link CURRENT_SCHEMA_VERSION} when
 * the caller has not already supplied a `schemaVersion` field.
 *
 * Failure of either JSON.stringify or writeFileSync triggers tmp-file
 * cleanup before re-throwing, so a corrupt half-written file is never
 * left behind on disk (atomic rename is the only path to the final name).
 *
 * The final rename is retried via {@link renameWithRetry} to absorb transient
 * Windows file locks (antivirus / OneDrive). After retries are exhausted the
 * original error still propagates with tmp cleanup, so the contract is unchanged.
 *
 * @param {object} state - Session state matching PRD section 13.4
 * @returns {string} absolute file path written
 */
export function saveSession(state) {
  if (!state || typeof state !== 'object' || !state.sessionId) {
    throw new TypeError('state.sessionId is required');
  }
  if (state.schemaVersion === undefined || state.schemaVersion === null) {
    state.schemaVersion = CURRENT_SCHEMA_VERSION;
  }
  const filePath = getSessionPath(state.sessionId);
  const dir = dirname(filePath);
  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  // JSON.stringify is called outside the tmp-cleanup try/catch on purpose:
  // if serialization throws (circular ref, BigInt, etc.) no tmp file was
  // ever created, so there is nothing to clean up.
  const payload = JSON.stringify(state, null, 2);
  backupBeforeUpgrade(state, filePath);
  try {
    writeFileSync(tmp, payload, 'utf-8');
    renameWithRetry(tmp, filePath);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* ignore — tmp may not exist if writeFileSync threw early */ }
    throw err;
  }
  return filePath;
}

/**
 * Copy the pre-upgrade bytes aside, once, before a newer-schema state
 * overwrites them. The decision is made from the file on disk, not from a
 * marker on the object: `loadSession` deliberately does NOT re-persist
 * (`getStatus()`/`listSessions` load every session, so a persist-on-load would
 * rewrite the whole store on a read), and any in-memory marker is lost the
 * moment a caller clones the state (`{...state}`, JSON round-trip) before
 * saving it. Reading the current file's `schemaVersion` survives both.
 *
 * @param {object} state
 * @param {string} filePath
 * @returns {void}
 */
function backupBeforeUpgrade(state, filePath) {
  const to = state.schemaVersion;
  if (typeof to !== 'number' || !Number.isFinite(to)) return;
  try {
    if (!existsSync(filePath)) return;
    const onDisk = JSON.parse(readFileSync(filePath, 'utf-8'))?.schemaVersion;
    const from = typeof onDisk === 'number' && Number.isFinite(onDisk) ? onDisk : 1;
    if (from >= to) return;
    const backupPath = `${filePath}.v${from}.bak`;
    if (!existsSync(backupPath)) copyFileSync(filePath, backupPath);
  } catch {
    /* best-effort: a missing backup must never block the save itself */
  }
}

/**
 * Load a session by id. Returns null if missing or unreadable.
 *
 * Legacy state is transparently upgraded via {@link migrateState}, **in memory
 * only**. The file on disk is left exactly as it was; the upgrade lands on the
 * first {@link saveSession} of the returned object, which also takes the
 * one-time `.v<old>.bak`. Re-persisting here would mean `getStatus()` — which
 * loads every session in the store — rewrites the whole store on a read.
 *
 * Migration failure is treated as advisory: the original (untouched)
 * parsed state is returned so the caller never sees a hard error from
 * the recovery layer. A `warn`-level telemetry event is best-effort
 * appended; telemetry import is lazy to avoid a load-time cycle.
 *
 * @param {string} sessionId
 * @returns {object|null}
 */
export function loadSession(sessionId) {
  let parsed;
  try {
    const filePath = getSessionPath(sessionId);
    if (!existsSync(filePath)) return null;
    const raw = readFileSync(filePath, 'utf-8');
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return parsed;
  if (!isLegacyState(parsed)) return parsed;
  let migrated;
  try {
    migrated = migrateState(parsed);
  } catch (err) {
    // Migration must never crash the loader — surface advisory warning instead.
    emitMigrationWarn(sessionId, err);
    return parsed;
  }
  return migrated;
}

/**
 * Determine whether a parsed state object predates {@link CURRENT_SCHEMA_VERSION}.
 * Missing, non-numeric, or numerically-lower `schemaVersion` all count as legacy.
 *
 * @param {object} state
 * @returns {boolean}
 */
export function isLegacyState(state) {
  if (!state || typeof state !== 'object') return false;
  const v = state.schemaVersion;
  if (v === undefined || v === null) return true;
  if (typeof v !== 'number' || !Number.isFinite(v)) return true;
  return v < CURRENT_SCHEMA_VERSION;
}

/**
 * Pure migration step. Produces a new state object upgraded to
 * {@link CURRENT_SCHEMA_VERSION}; the input is not mutated.
 *
 * v1 → v2 changes:
 *   - Ensure `queuedQuestions`, `checkpoints`, `timeline` are arrays
 *     (engine.js code paths assume `.push()` works on these slots).
 *   - Stamp `schemaVersion`.
 *
 * v2 → v3 then runs as its own leaf step ({@link migrateV2toV3}) plus
 * {@link reconcileV3}. The chain is ordered because `migrateV2toV3` rejects
 * anything below v2, so v1 input must be stamped v2 first.
 *
 * Idempotent: calling on an already-current object returns an equivalent one.
 *
 * @param {object} state
 * @returns {object} migrated state (new reference)
 */
export function migrateState(state) {
  if (!state || typeof state !== 'object') {
    throw new TypeError('migrateState: state must be an object');
  }
  const next = { ...state };
  if (!Array.isArray(next.queuedQuestions)) next.queuedQuestions = [];
  if (!Array.isArray(next.checkpoints)) next.checkpoints = [];
  // `timeline` is deliberately NOT initialized here any more. It was a ghost:
  // this line was its only writer and it only ever wrote `[]` — nothing in the
  // codebase appended a phase record to it, so the crash detector that read it
  // was permanently fail-open. Phase history lives in the NDJSON event log
  // (`telemetry.appendEvent`), which `replay.js#findUnterminatedPhases` reads.
  // Legacy sessions on disk may still carry a stale `timeline` array; it is
  // simply ignored rather than migrated, since it never held real data.
  next.schemaVersion = SCHEMA_VERSION_V2;
  return reconcileV3(migrateV2toV3(next));
}

/**
 * v3 reconcile — fill the slots `migrateV2toV3` does not own.
 *
 * `pendingPhase` is the delicate one. A v2 session frozen at `PAUSED` recorded
 * only `lastPhase`, and the v2 reader's meaning of that pair was "resume by
 * re-entering lastPhase". Copying it into `pendingPhase` preserves exactly that
 * — it does NOT claim the phase succeeded. If the session also has an open
 * `activePhaseAttempt`, `settleOutstandingAttempt` still pauses the resume
 * before `pendingPhase` is ever read.
 *
 * @param {object} state
 * @returns {object} reconciled state (new reference)
 */
function reconcileV3(state) {
  const next = { ...state };
  if (!Array.isArray(next.attemptJournal)) next.attemptJournal = [];
  if (next.phase === 'PAUSED' && next.pendingPhase === undefined) {
    next.pendingPhase = typeof next.lastPhase === 'string' ? next.lastPhase : null;
  }
  return next;
}

/**
 * Best-effort migration-failure warning. Lazy-imports telemetry so the
 * session-store ↔ telemetry pair does not form a static load cycle.
 *
 * @param {string} sessionId
 * @param {Error} err
 */
function emitMigrationWarn(sessionId, err) {
  // Lazy + fire-and-forget: any failure in the warning path itself is swallowed.
  import('./telemetry.js')
    .then(({ appendEvent }) => {
      try {
        appendEvent(sessionId, {
          type: 'schema-migration-failed',
          level: 'warn',
          message: `schemaVersion migration aborted: ${err?.message ?? 'unknown error'}`,
          data: { error: String(err?.message ?? err) },
        });
      } catch { /* ignore */ }
    })
    .catch(() => { /* ignore */ });
}

/**
 * List all stored session ids (without .json extension).
 * @returns {string[]}
 */
export function listSessions() {
  try {
    const dir = getStoreDir();
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.slice(0, -5));
  } catch {
    return [];
  }
}

/**
 * Delete a session file. Returns true on success, false if missing.
 * @param {string} sessionId
 * @returns {boolean}
 */
export function deleteSession(sessionId) {
  try {
    const filePath = getSessionPath(sessionId);
    if (!existsSync(filePath)) return false;
    unlinkSync(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Delete a session file AND its telemetry stream.
 *
 * Separate from {@link deleteSession} on purpose. `deleteSession` removes only
 * the session JSON, so a caller that creates sessions in a loop — every test
 * `afterAll` in `tests/autopilot/` — leaves the `.events.ndjson` behind forever.
 * Measured 2026-08-28: `runtime/autopilot/` held 10,484 ndjson against 2,446
 * json, a ratio that is exactly that leak. Widening `deleteSession` itself was
 * rejected: it is an exported, barrel-re-exported API (`index.js:138`) and the
 * event log is the post-mortem record for a crashed run, so throwing it away by
 * default would remove evidence someone may still want. Opting in says "this
 * session was disposable" — which only the caller knows.
 *
 * The events path is resolved through `lib/observability/run-events.js` rather
 * than `telemetry.js`: telemetry imports `getStoreDir` from this module
 * (`telemetry.js:19`), so importing it back would close a cycle. `run-events`
 * is a leaf (node builtins + `core/file.js` only).
 *
 * Locks are NOT removed. They are keyed by featureKey, not sessionId
 * (`lock.js:80`), so a session id alone cannot name one; `releaseLock` owns
 * that path.
 *
 * Pre-upgrade `.v<n>.bak` copies are swept too: they are written by the same
 * disposable sessions, and leaving them behind would recreate the exact ndjson
 * leak measured above in a second file family.
 *
 * @param {string} sessionId
 * @returns {{ session: boolean, events: boolean, backups: number }} What was actually removed.
 */
export function deleteSessionArtifacts(sessionId) {
  const session = deleteSession(sessionId);
  let events = false;
  try {
    const eventsPath = resolveRunEventsPath(getStoreDir(), sessionId);
    if (existsSync(eventsPath)) {
      unlinkSync(eventsPath);
      events = true;
    }
  } catch {
    // Best-effort, mirroring deleteSession: cleanup must never fail a caller.
  }
  return { session, events, backups: deleteSchemaBackups(sessionId) };
}

/**
 * Remove every `<sessionId>.json.v<n>.bak` left by a schema upgrade.
 * @param {string} sessionId
 * @returns {number} how many backup files were removed
 */
function deleteSchemaBackups(sessionId) {
  let removed = 0;
  try {
    const dir = getStoreDir();
    if (!existsSync(dir)) return 0;
    const prefix = `${sessionId}.json.v`;
    for (const name of readdirSync(dir)) {
      if (!name.startsWith(prefix) || !name.endsWith('.bak')) continue;
      try {
        unlinkSync(path.join(dir, name));
        removed += 1;
      } catch { /* ignore a single stubborn file */ }
    }
  } catch {
    /* best-effort */
  }
  return removed;
}

/**
 * Generate a fresh session id of form ap-YYYYMMDD-HHmmss-xxxxxx.
 * The 6-char random suffix prevents collisions when multiple sessions are
 * created within the same UTC second (e.g., parallel tests). 36^6 ≈ 2.18B
 * keyspace makes a 200-sample collision ~0.0009%/run (vs ~1.18%/run at 4 char).
 * @returns {string}
 */
export function newSessionId() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const ymd = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
  const hms = `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
  const suffix = Math.random().toString(36).slice(2, 8).padEnd(6, '0');
  return `ap-${ymd}-${hms}-${suffix}`;
}
