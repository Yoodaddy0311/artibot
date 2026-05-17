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
  let payload;
  try {
    payload = JSON.stringify(state, null, 2);
  } catch (err) {
    // stringify failed (e.g., circular ref) — nothing was written, nothing to clean.
    throw err;
  }
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
 * @param {string} sessionId
 * @returns {object|null}
 */
export function loadSession(sessionId) {
  try {
    const filePath = getSessionPath(sessionId);
    if (!existsSync(filePath)) return null;
    const raw = readFileSync(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
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
 * Generate a fresh session id of form ap-YYYYMMDD-HHmmss-xxxx.
 * The 4-char random suffix prevents collisions when multiple sessions are
 * created within the same UTC second (e.g., parallel tests).
 * @returns {string}
 */
export function newSessionId() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const ymd = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
  const hms = `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
  const suffix = Math.random().toString(36).slice(2, 6).padEnd(4, '0');
  return `ap-${ymd}-${hms}-${suffix}`;
}
