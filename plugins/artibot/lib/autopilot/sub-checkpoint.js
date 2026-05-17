/**
 * Sub-step checkpoint granularity for autopilot phases.
 *
 * Additive layer on top of the existing v2 checkpoint schema — adds an
 * optional `state.subCheckpoints[]` array without touching the legacy
 * `state.checkpoints[]` slot. The schema bump to v3 lives in
 * `lib/autopilot/migrate-v3.js`; this module never imports that migration
 * directly so callers can stage the rollout.
 *
 * DATA POLICY: local file IO only (session-store). No network, no shell.
 *
 * Public surface:
 *   - recordSubCheckpoint(sessionId, phase, subStep, sha, opts?)
 *   - listSubCheckpoints(sessionId, phase?, opts?)
 *
 * @module lib/autopilot/sub-checkpoint
 */

import { loadSession, saveSession } from './session-store.js';

/**
 * SHA validator — same rule as phase-diff / rollback (alnum/_/-, no
 * leading dash). Empty string accepted as "no-sha" marker.
 * @param {unknown} sha
 * @returns {boolean}
 */
function isSafeShaOrEmpty(sha) {
  if (sha === '' || sha === null || sha === undefined) return true;
  return typeof sha === 'string' && /^[A-Za-z0-9_][A-Za-z0-9_-]{0,127}$/.test(sha);
}

/**
 * Validate a phase / subStep label. Must be non-empty string, max 128 chars,
 * no control chars. Empty / non-string rejected.
 * @param {unknown} label
 * @returns {boolean}
 */
function isSafeLabel(label) {
  if (typeof label !== 'string') return false;
  if (label.length === 0 || label.length > 128) return false;
  // Reject control chars (\x00-\x1F, \x7F) and pipe/newline.
  // eslint-disable-next-line no-control-regex
  return !/[\x00-\x1F\x7F]/.test(label);
}

/**
 * Build a normalized sub-checkpoint record.
 * @param {string} phase
 * @param {string} subStep
 * @param {string} sha
 * @returns {{ phase, subStep, sha, ts }}
 */
function buildRecord(phase, subStep, sha) {
  return {
    phase,
    subStep,
    sha: typeof sha === 'string' ? sha : '',
    ts: new Date().toISOString(),
  };
}

/**
 * Append a sub-checkpoint to `state.subCheckpoints[]`. Creates the array
 * if missing. Returns the persisted record. Throws on validation failure.
 *
 * @param {string} sessionId
 * @param {string} phase
 * @param {string} subStep
 * @param {string} sha - may be empty when no commit was made
 * @param {{ state?: object, persist?: boolean }} [opts]
 * @returns {{ phase, subStep, sha, ts }}
 */
export function recordSubCheckpoint(sessionId, phase, subStep, sha, opts = {}) {
  if (!sessionId || typeof sessionId !== 'string') {
    throw new TypeError('sessionId must be a non-empty string');
  }
  if (!isSafeLabel(phase)) throw new TypeError('phase must be a safe non-empty string');
  if (!isSafeLabel(subStep)) throw new TypeError('subStep must be a safe non-empty string');
  if (!isSafeShaOrEmpty(sha)) throw new TypeError('sha must be safe or empty');

  let state = opts.state;
  if (!state) state = loadSession(sessionId);
  if (!state || typeof state !== 'object') {
    state = { sessionId, subCheckpoints: [] };
  }
  const existing = Array.isArray(state.subCheckpoints) ? state.subCheckpoints : [];
  const record = buildRecord(phase, subStep, sha);
  const nextState = {
    ...state,
    sessionId,
    subCheckpoints: [...existing, record],
  };
  if (opts.persist !== false) {
    saveSession(nextState);
  }
  return record;
}

/**
 * Query helper — list sub-checkpoints, optionally filtered by phase.
 *
 * @param {string} sessionId
 * @param {string} [phase] - optional filter
 * @param {{ state?: object }} [opts]
 * @returns {Array<{ phase, subStep, sha, ts }>}
 */
export function listSubCheckpoints(sessionId, phase, opts = {}) {
  if (!sessionId || typeof sessionId !== 'string') return [];
  let state = opts.state;
  if (!state) {
    try { state = loadSession(sessionId); } catch { state = null; }
  }
  if (!state || typeof state !== 'object') return [];
  const list = Array.isArray(state.subCheckpoints) ? state.subCheckpoints : [];
  if (phase === undefined || phase === null || phase === '') return list.slice();
  if (typeof phase !== 'string') return [];
  return list.filter((r) => r && r.phase === phase);
}
