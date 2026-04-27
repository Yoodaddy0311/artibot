/**
 * Autopilot notification helper.
 * Builds PushNotification instructions for the main Claude to invoke.
 * Night mode and --no-notify suppress active notifications, queueing only.
 *
 * @module lib/autopilot/notification
 */

import { loadSession, saveSession } from './session-store.js';

/**
 * Append a queued notification entry to a session's queuedQuestions list.
 * Best-effort; silently no-ops if the session cannot be loaded.
 * @param {string} sessionId
 * @param {object} entry
 */
function queueOnSession(sessionId, entry) {
  try {
    const state = loadSession(sessionId);
    if (!state) return;
    state.queuedQuestions = Array.isArray(state.queuedQuestions) ? state.queuedQuestions : [];
    state.queuedQuestions.push({ ts: new Date().toISOString(), ...entry });
    saveSession(state);
  } catch {
    /* swallow — queue is best-effort */
  }
}

/**
 * Determine if active notifications should be suppressed.
 * @param {object} state
 * @returns {boolean}
 */
function suppressActive(state) {
  if (!state) return true;
  if (state.mode === 'night') return true;
  if (state.options?.notify === false) return true;
  if (state.options?.noNotify === true) return true;
  return false;
}

/**
 * Build a PushNotification instruction for completion.
 * Returns instruction object: { tool, params, suppressed, queued }.
 * Active call is suppressed in night mode / --no-notify; queue is always updated.
 * @param {string} sessionId
 * @param {string} status - 'COMPLETED' | 'PAUSED' | 'ABORTED' | string
 * @returns {{ tool: 'PushNotification'|null, params?: object, suppressed: boolean, queued: object }}
 */
export function notifyCompletion(sessionId, status) {
  const state = loadSession(sessionId) || { sessionId, mode: 'default', options: {} };
  const title = `Autopilot ${status || 'UPDATE'}`;
  const body = `Session ${sessionId} → ${status || 'UPDATE'}`;
  const queued = { type: 'completion', status, title, body };
  queueOnSession(sessionId, queued);
  if (suppressActive(state)) {
    return { tool: null, suppressed: true, queued };
  }
  return {
    tool: 'PushNotification',
    params: { title, message: body, sessionId },
    suppressed: false,
    queued,
  };
}

/**
 * Build a PushNotification instruction for pause events.
 * @param {string} sessionId
 * @param {string} reason
 * @returns {{ tool: 'PushNotification'|null, params?: object, suppressed: boolean, queued: object }}
 */
export function notifyPause(sessionId, reason) {
  const state = loadSession(sessionId) || { sessionId, mode: 'default', options: {} };
  const title = `Autopilot PAUSED`;
  const body = `Session ${sessionId} paused: ${reason || 'unknown'}`;
  const queued = { type: 'pause', reason, title, body };
  queueOnSession(sessionId, queued);
  if (suppressActive(state)) {
    return { tool: null, suppressed: true, queued };
  }
  return {
    tool: 'PushNotification',
    params: { title, message: body, sessionId },
    suppressed: false,
    queued,
  };
}
