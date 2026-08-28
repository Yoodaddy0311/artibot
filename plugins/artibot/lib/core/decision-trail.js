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
import { atomicWriteJsonSync, ensureDir } from './file.js';
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

/**
 * Resolve the trail file path.
 *
 * `pluginRoot` lets a caller pin the root it observed at call time. Without it
 * the root comes from `process.env.CLAUDE_PLUGIN_ROOT` (via `getPluginRoot()`)
 * as read *right now*, which is wrong for any write whose caller resolved its
 * intent earlier — see `recordDecision`'s options and `lib/cognitive/router.js`.
 *
 * @param {string} [pluginRoot] - Root to resolve a relative trail path against.
 * @returns {string} Absolute path to the trail file.
 */
function resolveTrailPath(pluginRoot) {
  const cfg = resolveConfig();
  const p = cfg.path;
  if (path.isAbsolute(p)) return p;
  return path.join(pluginRoot || getPluginRoot(), p);
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

// Both take the path as an argument rather than re-resolving it. A read and the
// write that follows it must target the same file: they form a read-modify-write,
// and resolving twice lets the destination move between them, replacing the
// second file's contents with the first file's data.
function readTrailSync(trailPath) {
  try {
    const raw = fsSync.readFileSync(trailPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.entries)) {
      return { entries: [], metadata: { createdAt: new Date().toISOString() } };
    }
    return parsed;
  } catch {
    return { entries: [], metadata: { createdAt: new Date().toISOString() } };
  }
}

function writeTrailSync(trailPath, data) {
  atomicWriteJsonSync(trailPath, data);
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
 * @param {object} [options]
 * @param {string} [options.pluginRoot] - Plugin root captured by the caller at the
 *   moment the decision was made. Pass it whenever the write is deferred (a
 *   fire-and-forget `.then()` chain, a queued task): without it the destination
 *   is re-read from the environment at flush time, which may no longer be the
 *   root the caller meant. See `lib/cognitive/router.js`.
 * @returns {Promise<{id: string, timestamp: string}|null>} null when disabled or on failure
 */
export async function recordDecision(decision, options = {}) {
  const cfg = resolveConfig();
  if (!cfg.enabled) return null;
  if (!decision || typeof decision !== 'object') return null;
  if (typeof decision.subsystem !== 'string' || typeof decision.action !== 'string') {
    return null;
  }

  try {
    // Resolve once, up front. Everything below — mkdir, read, write — uses this
    // one value. Re-resolving after the `await` below would observe whatever the
    // environment says on resumption, and that is how a sandboxed read followed
    // by a real-root write overwrote the real trail with fixture data.
    const trailPath = resolveTrailPath(options.pluginRoot);

    // The only suspension in this function, and it must stay above the read.
    // Everything from `readTrailSync` to `writeTrailSync` is one
    // read-modify-write; an `await` anywhere inside it lets a second call read
    // the same base and write it back, erasing the first call's entry.
    // `route()` (lib/cognitive/router.js:386) fires these unawaited, so
    // overlapping calls are the normal case, not a corner one.
    await ensureDir(path.dirname(trailPath));

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

    const trail = readTrailSync(trailPath);
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

    writeTrailSync(trailPath, trail);

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
 * @param {string} [filter.pluginRoot] - read the trail under this root instead of
 *   the one the environment names right now; mirrors `recordDecision`'s option
 *   so a caller can read back exactly what it wrote.
 * @returns {Promise<object[]>}
 */
export async function queryDecisions(filter = {}) {
  try {
    const trail = readTrailSync(resolveTrailPath(filter.pluginRoot));
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
    // Read-modify-write: one resolution shared by both halves.
    const trailPath = resolveTrailPath();
    const trail = readTrailSync(trailPath);
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
    writeTrailSync(trailPath, trail);
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
    const trail = readTrailSync(resolveTrailPath());
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
