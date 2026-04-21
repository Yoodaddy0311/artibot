/**
 * Wakeup Scheduler (AGO Self-Control 7 — marker-only).
 *
 * Signals the NEXT session that a wakeup was requested by writing a marker
 * file. Does NOT call any ScheduleWakeup / spawn API directly — that tool
 * is LLM-context-only and must be invoked (if at all) by the operator or
 * the LLM after surfacing the marker in session-start.
 *
 * 4-gate model (all four must hold, else silently rejected):
 *   1. masterEnabled                  — `ago.selfControl.masterEnabled`
 *   2. autoWakeup.enabled             — `ago.selfControl.autoWakeup.enabled`
 *   3. env ARTIBOT_SELF_CONTROL=1     — explicit operator signal
 *   4. time-window                    — currently "always on" once 1-3 pass
 *                                       (field kept for future schedules)
 *
 * Further gates (fail-closed):
 *   - rate limit: maxPerHour (default 2)
 *   - min delay:  delaySeconds >= minDelaySeconds (default 300)
 *   - max depth:  depth <= maxDepth (default 2)
 *
 * Sensitive values in `reason` / `suggestedAction` are redacted before
 * being persisted. Zero runtime deps, ESM, Node >=18.
 *
 * @module lib/learning/wakeup-scheduler
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { redactString as sharedRedactString } from '../core/redaction.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MARKER_REL = path.join('runtime', 'wakeup-requests.json');
const RATE_LIMIT_REL = path.join('runtime', 'wakeup-rate-limit.json');

const DEFAULTS = Object.freeze({
  maxPerHour: 2,
  maxDepth: 2,
  minDelaySeconds: 300,
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Wrapper around the shared generic redactor. Coerces nullish to '' so
 * callers can pass `request.reason ?? ''` etc. without branching.
 *
 * @param {string} s
 * @returns {string}
 */
function redactString(s) {
  return sharedRedactString(String(s ?? ''));
}

/**
 * Resolve autoWakeup config with safe defaults.
 * @param {object|null|undefined} config
 * @returns {{masterEnabled: boolean, enabled: boolean, maxPerHour: number, maxDepth: number, minDelaySeconds: number}}
 */
export function resolveWakeupConfig(config) {
  const sc = config?.ago?.selfControl ?? {};
  const aw = sc.autoWakeup ?? {};
  return {
    masterEnabled: Boolean(sc.masterEnabled),
    enabled: Boolean(aw.enabled),
    maxPerHour: Number.isFinite(aw.maxPerHour) ? aw.maxPerHour : DEFAULTS.maxPerHour,
    maxDepth: Number.isFinite(aw.maxDepth) ? aw.maxDepth : DEFAULTS.maxDepth,
    minDelaySeconds: Number.isFinite(aw.minDelaySeconds) ? aw.minDelaySeconds : DEFAULTS.minDelaySeconds,
  };
}

/**
 * Evaluate the 4 master gates. Returns null when all pass, else a short reason.
 * @param {object} cfg
 * @param {{env?: NodeJS.ProcessEnv, now?: Date}} [ctx]
 * @returns {string|null}
 */
export function evaluateGates(cfg, ctx) {
  if (!cfg?.masterEnabled) return 'gate:master-disabled';
  if (!cfg?.enabled) return 'gate:autoWakeup-disabled';
  const env = ctx?.env ?? process.env;
  if (env.ARTIBOT_SELF_CONTROL !== '1') return 'gate:env-missing';
  // Time-window gate reserved for future use; treated as always-open today.
  return null;
}

/**
 * @param {number} seq
 * @returns {string}
 */
function makeRequestId(seq) {
  const rand = crypto.randomBytes(3).toString('hex');
  return `wake-${Date.now()}-${seq}-${rand}`;
}

/**
 * Count rate-limit entries within the last hour.
 * @param {{entries?: Array<{at: string}>}} state
 * @param {Date} now
 * @returns {number}
 */
function countRecent(state, now) {
  const entries = Array.isArray(state?.entries) ? state.entries : [];
  const cutoff = now.getTime() - 60 * 60 * 1000;
  return entries.filter((e) => {
    const t = Date.parse(e?.at ?? '');
    return Number.isFinite(t) && t >= cutoff;
  }).length;
}

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

async function readJsonSafe(filePath, fallback) {
  try {
    const raw = await readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function writeJson(filePath, payload) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
}

async function appendRateLimit(pluginRoot, now) {
  const p = path.join(pluginRoot, RATE_LIMIT_REL);
  const state = await readJsonSafe(p, { entries: [] });
  const entries = Array.isArray(state.entries) ? state.entries.slice() : [];
  // Prune >24h old to cap file size.
  const cutoff = now.getTime() - 24 * 60 * 60 * 1000;
  const pruned = entries.filter((e) => {
    const t = Date.parse(e?.at ?? '');
    return Number.isFinite(t) && t >= cutoff;
  });
  pruned.push({ at: now.toISOString() });
  await writeJson(p, { entries: pruned });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Request a next-session wakeup based on an auto-spawn-advisor suggestion.
 * Writes a marker file — does NOT call any wakeup API directly.
 *
 * @param {object} request
 * @param {string} request.reason
 * @param {number} request.delaySeconds
 * @param {string} [request.suggestionId]
 * @param {number} [request.depth]
 * @param {string} [request.suggestedAction]
 * @param {string} [request.category]
 * @param {object} options
 * @param {string} options.pluginRoot
 * @param {object} [options.config]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {Date} [options.now]
 * @returns {Promise<{queued: boolean, markerPath: string|null, reason?: string, requestId?: string}>}
 */
export async function requestWakeup(request, options) {
  const pluginRoot = options?.pluginRoot;
  if (!pluginRoot) {
    return { queued: false, markerPath: null, reason: 'missing-pluginRoot' };
  }

  const cfg = resolveWakeupConfig(options?.config);
  const now = options?.now instanceof Date ? options.now : new Date();

  const gateFail = evaluateGates(cfg, { env: options?.env, now });
  if (gateFail) return { queued: false, markerPath: null, reason: gateFail };

  // Validate individual request.
  if (!request || typeof request !== 'object') {
    return { queued: false, markerPath: null, reason: 'invalid-request' };
  }
  const delay = Number.isFinite(request.delaySeconds) ? request.delaySeconds : -1;
  if (delay < cfg.minDelaySeconds) {
    return { queued: false, markerPath: null, reason: 'minDelaySeconds-not-met' };
  }
  const depth = Number.isFinite(request.depth) ? request.depth : 0;
  if (depth > cfg.maxDepth) {
    return { queued: false, markerPath: null, reason: 'maxDepth-exceeded' };
  }

  // Rate limit check.
  const rateLimitPath = path.join(pluginRoot, RATE_LIMIT_REL);
  const rlState = await readJsonSafe(rateLimitPath, { entries: [] });
  if (countRecent(rlState, now) >= cfg.maxPerHour) {
    return { queued: false, markerPath: null, reason: 'maxPerHour-exceeded' };
  }

  // Build marker entry (redaction applied).
  const markerPath = path.join(pluginRoot, MARKER_REL);
  const existing = await readJsonSafe(markerPath, { entries: [] });
  const entries = Array.isArray(existing.entries) ? existing.entries.slice() : [];
  const requestId = makeRequestId(entries.length);

  entries.push({
    id: requestId,
    createdAt: now.toISOString(),
    reason: redactString(request.reason ?? '').slice(0, 500),
    category: typeof request.category === 'string' ? request.category.slice(0, 50) : null,
    suggestionId: typeof request.suggestionId === 'string' ? request.suggestionId.slice(0, 100) : null,
    suggestedAction: redactString(request.suggestedAction ?? '').slice(0, 200),
    delaySeconds: delay,
    depth,
    fulfilled: false,
    requiresApproval: true,
  });

  await writeJson(markerPath, {
    generatedAt: now.toISOString(),
    count: entries.length,
    entries,
  });
  await appendRateLimit(pluginRoot, now);

  return { queued: true, markerPath, requestId };
}

/**
 * Read pending (unfulfilled) wakeup requests.
 * @param {string} pluginRoot
 * @returns {Promise<Array>}
 */
export async function readPendingWakeups(pluginRoot) {
  if (!pluginRoot) return [];
  const markerPath = path.join(pluginRoot, MARKER_REL);
  const data = await readJsonSafe(markerPath, null);
  const list = Array.isArray(data?.entries) ? data.entries : [];
  return list.filter((e) => e && e.fulfilled !== true);
}

/**
 * Mark a wakeup request fulfilled (user/LLM acted on it).
 * @param {string} requestId
 * @param {{pluginRoot: string}} options
 * @returns {Promise<{fulfilled: boolean}>}
 */
export async function fulfillWakeup(requestId, options) {
  const pluginRoot = options?.pluginRoot;
  if (!pluginRoot || !requestId) return { fulfilled: false };
  const markerPath = path.join(pluginRoot, MARKER_REL);
  const data = await readJsonSafe(markerPath, null);
  if (!data || !Array.isArray(data.entries)) return { fulfilled: false };

  let found = false;
  const next = data.entries.map((e) => {
    if (e?.id === requestId && e.fulfilled !== true) {
      found = true;
      return { ...e, fulfilled: true, fulfilledAt: new Date().toISOString() };
    }
    return e;
  });
  if (!found) return { fulfilled: false };

  await writeJson(markerPath, { ...data, entries: next });
  return { fulfilled: true };
}

/**
 * Reset rate-limit counter (called daily by cron or tests).
 * @param {string} pluginRoot
 * @returns {Promise<{reset: boolean}>}
 */
export async function resetRateLimit(pluginRoot) {
  if (!pluginRoot) return { reset: false };
  const p = path.join(pluginRoot, RATE_LIMIT_REL);
  await writeJson(p, { entries: [] });
  return { reset: true };
}

// Test introspection surface (never to be relied on outside tests).
export const _internals = Object.freeze({
  MARKER_REL,
  RATE_LIMIT_REL,
  DEFAULTS,
  redactString,
  countRecent,
});
