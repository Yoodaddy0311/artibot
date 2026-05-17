/**
 * Autopilot notification helper.
 * Builds PushNotification instructions for the main Claude to invoke.
 * Night mode and --no-notify suppress active notifications, queueing only.
 *
 * Throttle policy (v4.9.0):
 *   - Same (sessionId, type) within {THROTTLE_WINDOW_MS} → suppressed,
 *     queued=true, throttled=true. Payload is still appended to
 *     state.queuedQuestions so audit trail stays complete.
 *   - notifyDanger is throttle-exempt: every safety-critical event fires.
 *   - notifyDanger is also suppression-exempt: night mode and --no-notify
 *     do NOT silence danger alerts. Safety always wins.
 *
 * @module lib/autopilot/notification
 */

import { loadSession, saveSession } from './session-store.js';

/** @type {number} 5-minute throttle window for non-danger notifications. */
export const THROTTLE_WINDOW_MS = 5 * 60 * 1000;

/** @type {number} Cleanup trigger: entries beyond this trip a lazy sweep. */
const THROTTLE_MAP_SOFT_CAP = 1000;
/** @type {number} Sweep threshold: entries older than this age are evicted. */
const THROTTLE_ENTRY_TTL_MS = 60 * 60 * 1000; // 1h

/**
 * Module-level throttle gate. Map<`${sessionId}::${type}`, lastTsMs>.
 * Kept in-memory only — restarts reset throttle, which is acceptable
 * because we never want to silently drop events after a process restart.
 *
 * Memory-bound: lazy cleanup triggers when map.size > THROTTLE_MAP_SOFT_CAP,
 * evicting entries whose ts is older than THROTTLE_ENTRY_TTL_MS. Long-running
 * night sessions with many ended-but-not-cleaned sessions stay bounded.
 * @type {Map<string, number>}
 */
const _throttleMap = new Map();

/**
 * Lazy cleanup — evicts stale entries when map exceeds soft cap.
 * Called from isThrottled hot path, O(n) but only when n > 1000.
 * @returns {number} evicted entry count
 */
function _cleanupThrottleMap() {
  if (_throttleMap.size <= THROTTLE_MAP_SOFT_CAP) return 0;
  const cutoff = Date.now() - THROTTLE_ENTRY_TTL_MS;
  let evicted = 0;
  for (const [key, ts] of _throttleMap.entries()) {
    if (ts < cutoff) {
      _throttleMap.delete(key);
      evicted += 1;
    }
  }
  return evicted;
}

/**
 * Reset throttle state. Test-only helper; not exported via index.js.
 * @returns {void}
 */
export function _resetThrottleForTests() {
  _throttleMap.clear();
}

/**
 * Check + record throttle. Returns true when the call is throttled (caller
 * should suppress). Updates `_throttleMap` only when not throttled, so the
 * next allowed call moves the window forward.
 * @param {string} sessionId
 * @param {string} type
 * @param {number} [windowMs=THROTTLE_WINDOW_MS]
 * @returns {boolean}
 */
function isThrottled(sessionId, type, windowMs = THROTTLE_WINDOW_MS) {
  const key = `${sessionId}::${type}`;
  const now = Date.now();
  const last = _throttleMap.get(key);
  if (typeof last === 'number' && now - last < windowMs) return true;
  _throttleMap.set(key, now);
  _cleanupThrottleMap();
  return false;
}

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
 * @returns {{ tool: 'PushNotification'|null, params?: object, suppressed: boolean, queued: object, throttled?: boolean }}
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
 * @returns {{ tool: 'PushNotification'|null, params?: object, suppressed: boolean, queued: object, throttled?: boolean }}
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

/**
 * Build a PushNotification instruction for safety-critical events
 * (force-push, secret leak, destructive command, etc.).
 *
 * Unlike other notifiers, notifyDanger:
 *   - bypasses throttle (every danger event fires)
 *   - bypasses night-mode / --no-notify suppression (safety always wins)
 *
 * @param {string} sessionId
 * @param {{ riskType: string, detail?: any }} payload
 * @returns {{ tool: 'PushNotification'|null, params?: object, suppressed: boolean, queued: object, throttled?: boolean }}
 */
export function notifyDanger(sessionId, { riskType, detail } = {}) {
  const safeRisk = typeof riskType === 'string' && riskType.length > 0 ? riskType : 'unknown-risk';
  const title = `Autopilot DANGER: ${safeRisk}`;
  const detailText = detail === null || detail === undefined
    ? ''
    : typeof detail === 'string'
      ? detail
      : (() => {
          try { return JSON.stringify(detail); } catch { return String(detail); }
        })();
  const body = `Session ${sessionId} danger trigger (${safeRisk})${detailText ? `: ${detailText}` : ''}`;
  const queued = { type: 'danger', riskType: safeRisk, detail: detail ?? null, title, body };
  queueOnSession(sessionId, queued);
  return {
    tool: 'PushNotification',
    params: { title, message: body, sessionId, urgency: 'high' },
    suppressed: false,
    queued,
  };
}

/**
 * Build a PushNotification instruction for phase transitions.
 * Throttled (5min per session+type) and suppressed in night / --no-notify.
 *
 * @param {string} sessionId
 * @param {{ fromPhase?: string|null, toPhase: string, durationMs?: number|null }} payload
 * @returns {{ tool: 'PushNotification'|null, params?: object, suppressed: boolean, queued: object, throttled?: boolean }}
 */
export function notifyPhaseProgress(sessionId, { fromPhase, toPhase, durationMs } = {}) {
  const state = loadSession(sessionId) || { sessionId, mode: 'default', options: {} };
  const safeFrom = fromPhase || 'START';
  const safeTo = toPhase || 'UNKNOWN';
  const durText = Number.isFinite(durationMs) ? ` (${Math.max(0, durationMs)}ms)` : '';
  const title = `Autopilot phase → ${safeTo}`;
  const body = `Session ${sessionId} ${safeFrom} → ${safeTo}${durText}`;
  const queued = {
    type: 'phase-progress',
    fromPhase: safeFrom,
    toPhase: safeTo,
    durationMs: Number.isFinite(durationMs) ? durationMs : null,
    title,
    body,
  };
  queueOnSession(sessionId, queued);
  if (suppressActive(state)) {
    return { tool: null, suppressed: true, queued };
  }
  if (isThrottled(sessionId, 'phase-progress')) {
    return { tool: null, suppressed: true, throttled: true, queued };
  }
  return {
    tool: 'PushNotification',
    params: { title, message: body, sessionId },
    suppressed: false,
    queued,
  };
}

/**
 * Build a PushNotification instruction for goal-loop iteration entries.
 * Fires when met=false and the engine is about to re-enter EXECUTE.
 *
 * @param {string} sessionId
 * @param {{ iteration: number, maxIterations: number, met: boolean, lastValidation?: any }} payload
 * @returns {{ tool: 'PushNotification'|null, params?: object, suppressed: boolean, queued: object, throttled?: boolean }}
 */
export function notifyIteration(sessionId, { iteration, maxIterations, met, lastValidation } = {}) {
  const state = loadSession(sessionId) || { sessionId, mode: 'default', options: {} };
  const iterNum = Number.isFinite(iteration) ? iteration : 0;
  const maxNum = Number.isFinite(maxIterations) ? maxIterations : 0;
  const title = `Autopilot iteration ${iterNum}/${maxNum}`;
  const validationSummary = lastValidation?.reason
    ? `: ${String(lastValidation.reason).slice(0, 140)}`
    : '';
  const body = `Session ${sessionId} iter ${iterNum}/${maxNum} met=${Boolean(met)}${validationSummary}`;
  const queued = {
    type: 'iteration',
    iteration: iterNum,
    maxIterations: maxNum,
    met: Boolean(met),
    lastValidation: lastValidation ?? null,
    title,
    body,
  };
  queueOnSession(sessionId, queued);
  if (suppressActive(state)) {
    return { tool: null, suppressed: true, queued };
  }
  if (isThrottled(sessionId, 'iteration')) {
    return { tool: null, suppressed: true, throttled: true, queued };
  }
  return {
    tool: 'PushNotification',
    params: { title, message: body, sessionId },
    suppressed: false,
    queued,
  };
}
