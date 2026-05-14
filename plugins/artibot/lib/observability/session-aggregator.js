/**
 * Session aggregator.
 *
 * Captures individual session summaries, folds them into daily rollups, and
 * keeps the original session records for a bounded retention window before
 * archiving (never hard-delete). All writes are atomic (tmp + rename) and
 * crash-safe. Zero external deps — plain JSON on the local filesystem.
 *
 * Output layout (under a caller-chosen storagePath root):
 *   sessions/<sessionId>.json       raw session records
 *   session-rollups.json            rolled-up daily buckets (array)
 *   archive/sessions/<sessionId>.json  pruned originals (never deleted)
 *
 * DATA POLICY: local-only. Never ships anywhere.
 *
 * @module lib/observability/session-aggregator
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import {
  atomicWriteJson,
  ensureDir,
  exists,
  readJsonFile,
} from '../core/file.js';

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Extract the YYYY-MM-DD UTC date label for a given instant.
 *
 * @param {string|number|Date} when
 * @returns {string}
 */
export function dayKey(when) {
  const d = when instanceof Date ? when : new Date(when);
  if (Number.isNaN(d.getTime())) return 'unknown';
  return d.toISOString().slice(0, 10);
}

/**
 * Coerce to a finite non-negative number (0 on any failure).
 *
 * @param {*} v
 * @returns {number}
 */
function safeNum(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

function safeScore0to100(v) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  if (n < 0) return 0;
  if (n > 100) return 100;
  return n;
}

/**
 * Normalize session metrics into the aggregator's canonical schema. Missing
 * fields default to zero so downstream folds never NaN.
 *
 * @param {object} metrics
 * @returns {{
 *   inputTokens: number,
 *   outputTokens: number,
 *   cacheReadTokens: number,
 *   cacheCreationTokens: number,
 *   requestCount: number,
 *   toolCallCount: number,
 *   errorCount: number,
 *   costUsd: number,
 *   durationMs: number,
 * }}
 */
export function normalizeMetrics(metrics = {}) {
  return Object.freeze({
    inputTokens: safeNum(metrics.inputTokens ?? metrics.totalInput),
    outputTokens: safeNum(metrics.outputTokens ?? metrics.totalOutput),
    cacheReadTokens: safeNum(metrics.cacheReadTokens),
    cacheCreationTokens: safeNum(metrics.cacheCreationTokens),
    requestCount: safeNum(metrics.requestCount),
    toolCallCount: safeNum(metrics.toolCallCount),
    errorCount: safeNum(metrics.errorCount),
    costUsd: safeNum(metrics.costUsd),
    durationMs: safeNum(metrics.durationMs),
    claudeMdQuality: safeScore0to100(metrics.claudeMdQuality),
  });
}

/**
 * Build a normalized session record from raw inputs.
 *
 * @param {{
 *   sessionId: string,
 *   startTime: string|number|Date,
 *   endTime: string|number|Date,
 *   metrics?: object,
 *   meta?: object,
 * }} input
 * @returns {object}
 */
export function buildSessionRecord(input) {
  const start = input.startTime ? new Date(input.startTime) : null;
  const end = input.endTime ? new Date(input.endTime) : null;
  const derivedDuration =
    start && end && !Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime())
      ? Math.max(0, end.getTime() - start.getTime())
      : 0;
  const metrics = normalizeMetrics({
    ...(input.metrics || {}),
    durationMs: input.metrics?.durationMs ?? derivedDuration,
  });
  const dayOf = end || start || new Date();

  return Object.freeze({
    sessionId: String(input.sessionId || `session-${Date.now()}`),
    startTime: start ? start.toISOString() : null,
    endTime: end ? end.toISOString() : null,
    day: dayKey(dayOf),
    metrics,
    meta: Object.freeze({ ...(input.meta || {}) }),
  });
}

/**
 * Fold a session record into a daily bucket. Pure: returns a new bucket.
 *
 * @param {object|null} bucket
 * @param {object} record
 * @returns {object}
 */
export function foldIntoBucket(bucket, record) {
  const base = bucket || {
    day: record.day,
    sessionCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    requestCount: 0,
    toolCallCount: 0,
    errorCount: 0,
    costUsd: 0,
    totalDurationMs: 0,
    firstSessionAt: record.startTime || record.endTime || null,
    lastSessionAt: record.endTime || record.startTime || null,
  };
  const m = record.metrics;
  return Object.freeze({
    day: base.day,
    sessionCount: base.sessionCount + 1,
    inputTokens: base.inputTokens + m.inputTokens,
    outputTokens: base.outputTokens + m.outputTokens,
    cacheReadTokens: base.cacheReadTokens + m.cacheReadTokens,
    cacheCreationTokens: base.cacheCreationTokens + m.cacheCreationTokens,
    requestCount: base.requestCount + m.requestCount,
    toolCallCount: base.toolCallCount + m.toolCallCount,
    errorCount: base.errorCount + m.errorCount,
    costUsd: base.costUsd + m.costUsd,
    totalDurationMs: base.totalDurationMs + m.durationMs,
    firstSessionAt:
      !base.firstSessionAt || (record.startTime && record.startTime < base.firstSessionAt)
        ? record.startTime || base.firstSessionAt
        : base.firstSessionAt,
    lastSessionAt:
      !base.lastSessionAt || (record.endTime && record.endTime > base.lastSessionAt)
        ? record.endTime || base.lastSessionAt
        : base.lastSessionAt,
  });
}

/**
 * Merge a new bucket into an existing rollup list. Replaces any bucket for
 * the same day; otherwise appends. Returns a stably-sorted (ascending day)
 * new array.
 *
 * @param {object[]} rollups
 * @param {object} bucket
 * @returns {object[]}
 */
export function upsertBucket(rollups, bucket) {
  const filtered = rollups.filter((b) => b.day !== bucket.day);
  const next = [...filtered, bucket];
  next.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  return next;
}

/**
 * Decide whether a session record should be considered "older than N days"
 * relative to a reference instant. Records with no endTime are treated as
 * `now` (i.e. never pruned prematurely).
 *
 * @param {object} record
 * @param {number} days
 * @param {number} nowMs
 * @returns {boolean}
 */
export function isOlderThan(record, days, nowMs) {
  if (!record?.endTime) return false;
  const t = Date.parse(record.endTime);
  if (!Number.isFinite(t)) return false;
  return nowMs - t > days * MS_PER_DAY;
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function sessionsDir(root) {
  return path.join(root, 'sessions');
}
function archiveDir(root) {
  return path.join(root, 'archive', 'sessions');
}
function rollupsFile(root) {
  return path.join(root, 'session-rollups.json');
}
function sessionFile(root, sessionId) {
  const safe = String(sessionId).replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(sessionsDir(root), `${safe}.json`);
}
function archiveFile(root, sessionId) {
  const safe = String(sessionId).replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(archiveDir(root), `${safe}.json`);
}

// ---------------------------------------------------------------------------
// IO helpers
// ---------------------------------------------------------------------------

async function readSessions(root) {
  const dir = sessionsDir(root);
  if (!(await exists(dir))) return [];
  let entries;
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    const rec = await readJsonFile(path.join(dir, name));
    if (rec && typeof rec === 'object') out.push(rec);
  }
  return out;
}

async function readRollups(root) {
  const data = await readJsonFile(rollupsFile(root));
  return Array.isArray(data) ? data : [];
}

async function moveToArchive(root, record) {
  const src = sessionFile(root, record.sessionId);
  const dst = archiveFile(root, record.sessionId);
  await ensureDir(archiveDir(root));
  // Write target atomically first, then remove source. Rename across dirs
  // may cross devices on some setups; copy+unlink is portable and crash-safe
  // because atomicWriteJson uses tmp + rename.
  await atomicWriteJson(dst, record, 0);
  try {
    await fs.unlink(src);
  } catch {
    // best-effort; already archived is fine
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a session aggregator.
 *
 * @param {{
 *   storagePath: string,
 *   windowDays?: number,
 *   now?: () => number,
 * }} options
 * @returns {{
 *   recordSession: (input: object) => Promise<object>,
 *   rollupDaily: (date?: string|Date) => Promise<object>,
 *   getRollups: (query?: { since?: string|Date, limit?: number }) => Promise<object[]>,
 *   pruneOlder: (days?: number) => Promise<{ archived: number, kept: number }>,
 *   _paths: { root: string, sessions: string, archive: string, rollups: string },
 * }}
 */
export function createSessionAggregator(options) {
  if (!options || typeof options.storagePath !== 'string' || !options.storagePath) {
    throw new TypeError('createSessionAggregator: storagePath is required');
  }
  const root = options.storagePath;
  const windowDays = Number.isFinite(options.windowDays) && options.windowDays > 0
    ? Math.floor(options.windowDays)
    : 30;
  const now = typeof options.now === 'function' ? options.now : Date.now;

  async function recordSession(input) {
    if (!input || !input.sessionId) {
      throw new TypeError('recordSession: sessionId is required');
    }
    const record = buildSessionRecord(input);
    await ensureDir(sessionsDir(root));
    await atomicWriteJson(sessionFile(root, record.sessionId), record);
    return record;
  }

  async function rollupDaily(date) {
    const target = dayKey(date || new Date(now()));
    const sessions = await readSessions(root);
    const matching = sessions.filter((s) => s && s.day === target);

    let bucket = null;
    for (const s of matching) {
      bucket = foldIntoBucket(bucket, s);
    }
    if (!bucket) {
      // Produce an explicit empty marker so the rollup file still reflects
      // that a rollup was attempted for this day. This keeps queries stable.
      bucket = foldIntoBucket(null, buildSessionRecord({
        sessionId: `__empty__${target}`,
        startTime: `${target}T00:00:00.000Z`,
        endTime: `${target}T00:00:00.000Z`,
      }));
      bucket = Object.freeze({ ...bucket, sessionCount: 0, day: target });
    }

    const existing = await readRollups(root);
    const next = upsertBucket(existing, bucket);
    await atomicWriteJson(rollupsFile(root), next);
    return bucket;
  }

  async function getRollups(query = {}) {
    const all = await readRollups(root);
    let out = all;
    if (query.since) {
      const sinceKey = dayKey(query.since);
      out = out.filter((b) => b.day >= sinceKey);
    }
    if (Number.isFinite(query.limit) && query.limit > 0) {
      out = out.slice(-Math.floor(query.limit));
    }
    return out;
  }

  async function pruneOlder(days = windowDays) {
    const sessions = await readSessions(root);
    let archived = 0;
    let kept = 0;
    for (const s of sessions) {
      if (isOlderThan(s, days, now())) {
        await moveToArchive(root, s);
        archived += 1;
      } else {
        kept += 1;
      }
    }
    return { archived, kept };
  }

  return {
    recordSession,
    rollupDaily,
    getRollups,
    pruneOlder,
    _paths: {
      root,
      sessions: sessionsDir(root),
      archive: archiveDir(root),
      rollups: rollupsFile(root),
    },
  };
}

// ---------------------------------------------------------------------------
// Testing exports
// ---------------------------------------------------------------------------

export const _internals = {
  sessionsDir,
  archiveDir,
  rollupsFile,
  sessionFile,
  archiveFile,
  readSessions,
  readRollups,
};
