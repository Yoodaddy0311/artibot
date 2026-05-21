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
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { getPluginRoot } from '../core/platform.js';

/**
 * Current persisted-state schema version. Bump when the on-disk shape
 * gains a required field or changes semantics. Older state files are
 * upgraded transparently in {@link loadSession} via {@link migrateState}.
 *
 * v1: pre-versioned legacy state (no `schemaVersion` field).
 * v2: guarantees `queuedQuestions`, `checkpoints`, `timeline` arrays.
 */
export const CURRENT_SCHEMA_VERSION = 2;

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
  try {
    writeFileSync(tmp, payload, 'utf-8');
    renameSync(tmp, filePath);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* ignore — tmp may not exist if writeFileSync threw early */ }
    throw err;
  }
  return filePath;
}

/**
 * Load a session by id. Returns null if missing or unreadable.
 *
 * Legacy (v1) state is transparently upgraded via {@link migrateState}.
 * On successful upgrade, the migrated state is immediately re-persisted
 * so the next load is already at {@link CURRENT_SCHEMA_VERSION}.
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
  try {
    saveSession(migrated);
  } catch {
    /* save failure is non-fatal — in-memory migrated state is still returned */
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
 * Idempotent: calling on an already-v2 object returns an equivalent v2 object.
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
  if (!Array.isArray(next.timeline)) next.timeline = [];
  next.schemaVersion = CURRENT_SCHEMA_VERSION;
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
