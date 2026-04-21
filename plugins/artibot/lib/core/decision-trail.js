/**
 * Decision Trail — AGO Track G3 Explainability Layer.
 *
 * Records autonomous decisions made by Artibot subsystems (cognitive router,
 * runtime prompt hook, auto-team, plain-language converter, user-profile
 * promotion, etc.) so that operators can later answer the question
 * "why did the agent do that?".
 *
 * Observational only. This module never blocks, overrides, or vetoes any
 * subsystem decision — all integration points treat it as best-effort.
 *
 * Storage: `runtime/decision-trail.json` at the plugin root, rotating with
 * `retentionDays` (default 30). Sensitive values are redacted when
 * `redactSensitive: true` in `ago.decisionTrail` config.
 *
 * @module lib/core/decision-trail
 */

import path from 'node:path';
import fsSync from 'node:fs';
import { ensureDir } from './file.js';
import { getPluginRoot } from './platform.js';
import {
  redactObject as sharedRedactObject,
  redactString as sharedRedactString,
} from './redaction.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_PATH = 'runtime/decision-trail.json';
const DEFAULT_RETENTION_DAYS = 30;
const MAX_ENTRIES = 5000; // hard cap to keep file size bounded

// ---------------------------------------------------------------------------
// Config loading (lazy, cached)
// ---------------------------------------------------------------------------

/** @type {{enabled: boolean, path: string, retentionDays: number, redactSensitive: boolean} | null} */
let cachedConfig = null;

/**
 * Reset cached config (test helper, not public contract).
 * @returns {void}
 */
export function _resetDecisionTrailCache() {
  cachedConfig = null;
}

function resolveConfig() {
  if (cachedConfig) return cachedConfig;

  const defaults = {
    enabled: true,
    path: DEFAULT_PATH,
    retentionDays: DEFAULT_RETENTION_DAYS,
    redactSensitive: true,
  };

  try {
    const configPath = path.join(getPluginRoot(), 'artibot.config.json');
    const raw = fsSync.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw);
    const trail = parsed?.ago?.decisionTrail ?? {};
    cachedConfig = {
      enabled: trail.enabled !== false,
      path: typeof trail.path === 'string' ? trail.path : defaults.path,
      retentionDays: Number.isFinite(trail.retentionDays)
        ? Math.max(0, Math.floor(trail.retentionDays))
        : defaults.retentionDays,
      redactSensitive: trail.redactSensitive !== false,
    };
  } catch {
    cachedConfig = defaults;
  }
  return cachedConfig;
}

function resolveTrailPath() {
  const cfg = resolveConfig();
  const p = cfg.path;
  if (path.isAbsolute(p)) return p;
  return path.join(getPluginRoot(), p);
}

// ---------------------------------------------------------------------------
// Redaction — delegates to lib/core/redaction.js (single source of truth).
// ---------------------------------------------------------------------------

/**
 * Redact sensitive substrings in a string. Preserves legacy output format
 * (`***REDACTED***`, `{email}`, `$1Users\{user}`, `/{home}/{user}`) via the
 * shared GENERIC pattern set.
 *
 * @param {string} s
 * @returns {string}
 */
function redactString(s) {
  if (typeof s !== 'string') return s;
  return sharedRedactString(s);
}

/**
 * Deep-clone a value, optionally redacting strings. Delegates to
 * sharedRedactObject which already drops prototype-pollution keys and
 * returns a new structure without mutating the input.
 *
 * @param {unknown} value
 * @param {boolean} redact
 * @returns {unknown}
 */
function sanitize(value, redact) {
  if (!redact) {
    // Empty pattern set = structure-clone + unsafe-key stripping, no string mutation.
    return sharedRedactObject(value, { patterns: [] });
  }
  return sharedRedactObject(value);
}

// ---------------------------------------------------------------------------
// Storage (synchronous read + atomic write)
// ---------------------------------------------------------------------------

function readTrailSync() {
  const p = resolveTrailPath();
  try {
    const raw = fsSync.readFileSync(p, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.entries)) {
      return { entries: [], metadata: { createdAt: new Date().toISOString() } };
    }
    return parsed;
  } catch {
    return { entries: [], metadata: { createdAt: new Date().toISOString() } };
  }
}

/**
 * Atomically write JSON to disk (write-temp + rename). Synchronous to keep
 * the recordDecision append path simple and crash-safe even on Windows +
 * OneDrive where concurrent writes can race.
 *
 * @param {string} filePath
 * @param {unknown} data
 * @returns {void}
 */
function atomicWriteJsonSync(filePath, data) {
  const dir = path.dirname(filePath);
  try {
    fsSync.mkdirSync(dir, { recursive: true });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
  const tmp = `${filePath}.tmp.${process.pid}`;
  fsSync.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  fsSync.renameSync(tmp, filePath);
}

function writeTrailSync(data) {
  const p = resolveTrailPath();
  atomicWriteJsonSync(p, data);
}

// ---------------------------------------------------------------------------
// ID generator
// ---------------------------------------------------------------------------

function generateId() {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `dec-${ts}-${rand}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Record a decision made by any Artibot subsystem.
 * Appends to runtime/decision-trail.json. Silently no-ops when disabled.
 *
 * @param {object} decision
 * @param {string} decision.subsystem   - e.g. 'cognitive-router' | 'runtime-prompt' | 'auto-team' | 'user-profile'
 * @param {string} decision.action      - e.g. 'classified' | 'spawned' | 'effort-classified' | 'skill-level-changed'
 * @param {string} [decision.reason]    - human-readable rationale
 * @param {object} [decision.inputs]    - input signals (redacted if sensitive)
 * @param {object} [decision.outputs]   - decision output (redacted if sensitive)
 * @param {number} [decision.confidence]- 0.0-1.0 if applicable
 * @returns {Promise<{id: string, timestamp: string}|null>} null when disabled or on failure
 */
export async function recordDecision(decision) {
  const cfg = resolveConfig();
  if (!cfg.enabled) return null;
  if (!decision || typeof decision !== 'object') return null;
  if (typeof decision.subsystem !== 'string' || typeof decision.action !== 'string') {
    return null;
  }

  try {
    const timestamp = new Date().toISOString();
    const id = generateId();

    const entry = {
      id,
      timestamp,
      subsystem: decision.subsystem,
      action: decision.action,
      reason: typeof decision.reason === 'string'
        ? (cfg.redactSensitive ? redactString(decision.reason) : decision.reason)
        : undefined,
      inputs: sanitize(decision.inputs ?? null, cfg.redactSensitive),
      outputs: sanitize(decision.outputs ?? null, cfg.redactSensitive),
      confidence: typeof decision.confidence === 'number'
        ? Math.max(0, Math.min(1, decision.confidence))
        : null,
    };

    const trail = readTrailSync();
    trail.entries.push(entry);

    // Hard-cap on entries (drop oldest)
    if (trail.entries.length > MAX_ENTRIES) {
      trail.entries = trail.entries.slice(-MAX_ENTRIES);
    }

    trail.metadata = {
      ...(trail.metadata || {}),
      lastUpdated: timestamp,
      totalAppended: (trail.metadata?.totalAppended || 0) + 1,
    };

    await ensureDir(path.dirname(resolveTrailPath()));
    writeTrailSync(trail);

    return { id, timestamp };
  } catch {
    // Never let trail failures bubble up to the caller
    return null;
  }
}

/**
 * Query recent decisions matching an optional filter.
 *
 * @param {object} [filter]
 * @param {string} [filter.subsystem] - exact subsystem match
 * @param {string} [filter.action]    - exact action match
 * @param {Date|string|number} [filter.since] - return entries at/after this timestamp
 * @param {number} [filter.limit]     - max entries returned (newest first)
 * @returns {Promise<object[]>}
 */
export async function queryDecisions(filter = {}) {
  try {
    const trail = readTrailSync();
    let entries = trail.entries;

    if (filter.subsystem) {
      entries = entries.filter((e) => e.subsystem === filter.subsystem);
    }
    if (filter.action) {
      entries = entries.filter((e) => e.action === filter.action);
    }
    if (filter.since !== undefined) {
      const sinceMs = new Date(filter.since).getTime();
      if (!Number.isNaN(sinceMs)) {
        entries = entries.filter((e) => new Date(e.timestamp).getTime() >= sinceMs);
      }
    }

    // newest first
    entries = entries.slice().reverse();

    if (typeof filter.limit === 'number' && filter.limit > 0) {
      entries = entries.slice(0, filter.limit);
    }
    return entries;
  } catch {
    return [];
  }
}

/**
 * Remove entries older than the configured `retentionDays`.
 * @returns {Promise<{removed: number, remaining: number}>}
 */
export async function pruneDecisionTrail() {
  const cfg = resolveConfig();
  try {
    const trail = readTrailSync();
    const before = trail.entries.length;
    if (cfg.retentionDays <= 0) {
      return { removed: 0, remaining: before };
    }
    const cutoff = Date.now() - cfg.retentionDays * 24 * 60 * 60 * 1000;
    trail.entries = trail.entries.filter(
      (e) => new Date(e.timestamp).getTime() >= cutoff,
    );
    trail.metadata = {
      ...(trail.metadata || {}),
      lastPruned: new Date().toISOString(),
    };
    writeTrailSync(trail);
    return { removed: before - trail.entries.length, remaining: trail.entries.length };
  } catch {
    return { removed: 0, remaining: 0 };
  }
}

/**
 * Aggregate statistics for dashboards / verification.
 * @returns {Promise<{totalDecisions: number, bySubsystem: Record<string, number>, byAction: Record<string, number>, last24h: number}>}
 */
export async function getDecisionStats() {
  try {
    const trail = readTrailSync();
    const bySubsystem = Object.create(null);
    const byAction = Object.create(null);
    const cutoff24h = Date.now() - 24 * 60 * 60 * 1000;
    let last24h = 0;

    for (const e of trail.entries) {
      bySubsystem[e.subsystem] = (bySubsystem[e.subsystem] || 0) + 1;
      byAction[e.action] = (byAction[e.action] || 0) + 1;
      if (new Date(e.timestamp).getTime() >= cutoff24h) last24h++;
    }

    return {
      totalDecisions: trail.entries.length,
      bySubsystem: { ...bySubsystem },
      byAction: { ...byAction },
      last24h,
    };
  } catch {
    return { totalDecisions: 0, bySubsystem: {}, byAction: {}, last24h: 0 };
  }
}

/**
 * Read-only accessor for the redaction helper (exposed for testing
 * external modules that want to pre-redact strings before passing them in).
 * @param {string} s
 * @returns {string}
 */
export function _redactForTest(s) {
  return redactString(s);
}
