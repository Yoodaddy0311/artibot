/**
 * Wakeup Scheduler (AGO Self-Control 7 — marker-only).
 *
 * Signals the NEXT session that a wakeup was requested by writing a marker
 * file. Does NOT call any ScheduleWakeup / spawn API directly — that tool
 * is LLM-context-only and must be invoked (if at all) by the operator or
 * the LLM after surfacing the marker in session-start.
 *
 * Wave-2 4-gate model (all four must hold, else silently rejected):
 *   1. masterEnabled              — `ago.selfControl.masterEnabled` (default true)
 *   2. autoWakeup.enabled         — `ago.selfControl.autoWakeup.enabled` (default true)
 *   3. kill-switch not tripped    — `lib/learning/kill-switch.js`
 *   4. first-run guard allows     — observe mode *still allows* marker writes
 *                                   because markers are inert/informational.
 *
 * The legacy `ARTIBOT_SELF_CONTROL=1` environment gate has been **removed**
 * in Wave 2: self-control is now default-on and users opt out via config.
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
 *
 * Wave-2 policy: `masterEnabled` and `autoWakeup.enabled` default to **true**
 * (self-control default-ON). Users opt out by setting either flag to `false`.
 *
 * @param {object|null|undefined} config
 * @returns {{masterEnabled: boolean, enabled: boolean, maxPerHour: number, maxDepth: number, minDelaySeconds: number}}
 */
export function resolveWakeupConfig(config) {
  const sc = config?.ago?.selfControl ?? {};
  const aw = sc.autoWakeup ?? {};
  return {
    masterEnabled: sc.masterEnabled !== false,
    enabled: aw.enabled !== false,
    maxPerHour: Number.isFinite(aw.maxPerHour) ? aw.maxPerHour : DEFAULTS.maxPerHour,
    maxDepth: Number.isFinite(aw.maxDepth) ? aw.maxDepth : DEFAULTS.maxDepth,
    minDelaySeconds: Number.isFinite(aw.minDelaySeconds) ? aw.minDelaySeconds : DEFAULTS.minDelaySeconds,
  };
}

/**
 * Evaluate the master config gates. Returns null when all pass, else a short
 * reason. Wave-2: env gate removed; kill-switch / first-run gates are enforced
 * asynchronously in {@link requestWakeup}.
 *
 * @param {object} cfg
 * @param {{now?: Date}} [ctx]
 * @returns {string|null}
 */
// eslint-disable-next-line no-unused-vars -- `ctx` preserved for future time-window gate
export function evaluateGates(cfg, ctx) {
  if (!cfg?.masterEnabled) return 'gate:master-disabled';
  if (!cfg?.enabled) return 'gate:autoWakeup-disabled';
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
// Gate helpers — extracted to keep requestWakeup below the complexity cap.
// ---------------------------------------------------------------------------

/**
 * Run the pre-request side-gates (kill-switch, first-run guard). Returns a
 * short-circuit reason if writes must be blocked, else null. Never throws.
 *
 * @param {string} pluginRoot
 * @param {object} [config]
 * @returns {Promise<string|null>}
 */
async function runPreRequestGates(pluginRoot, config) {
  try {
    const ks = await import('./kill-switch.js');
    if (await ks.isKillSwitchTripped(config, { feature: 'auto-wakeup', pluginRoot })) {
      return 'kill-switch-tripped';
    }
  } catch {
    // best-effort
  }
  try {
    const frg = await import('./first-run-guard.js');
    await frg.bumpRunCounter('auto-wakeup', config);
  } catch {
    // best-effort
  }
  return null;
}

/**
 * Validate a single request payload against the per-request limits.
 * Returns {reason, delay, depth} where `reason` is non-null on rejection.
 *
 * @param {object} request
 * @param {{minDelaySeconds: number, maxDepth: number}} cfg
 * @returns {{reason: string|null, delay: number, depth: number}}
 */
function validateRequest(request, cfg) {
  if (!request || typeof request !== 'object') {
    return { reason: 'invalid-request', delay: -1, depth: 0 };
  }
  const delay = Number.isFinite(request.delaySeconds) ? request.delaySeconds : -1;
  if (delay < cfg.minDelaySeconds) {
    return { reason: 'minDelaySeconds-not-met', delay, depth: 0 };
  }
  const depth = Number.isFinite(request.depth) ? request.depth : 0;
  if (depth > cfg.maxDepth) {
    return { reason: 'maxDepth-exceeded', delay, depth };
  }
  return { reason: null, delay, depth };
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
 * @param {NodeJS.ProcessEnv} [options.env]  reserved; Wave-2 no longer reads ARTIBOT_SELF_CONTROL
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

  const gateFail = evaluateGates(cfg, { now });
  if (gateFail) return { queued: false, markerPath: null, reason: gateFail };

  const preGate = await runPreRequestGates(pluginRoot, options?.config);
  if (preGate) return { queued: false, markerPath: null, reason: preGate };

  const validation = validateRequest(request, cfg);
  if (validation.reason) {
    return { queued: false, markerPath: null, reason: validation.reason };
  }
  const { delay, depth } = validation;

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
