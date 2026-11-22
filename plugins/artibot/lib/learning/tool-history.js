/**
 * Tool history persistence and scoring helpers.
 * Manages disk I/O, time-decayed scoring, and aggregate computation
 * for tool-learner.js.
 *
 * Zero dependencies beyond node built-ins. ESM only.
 * @module lib/learning/tool-history
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { ARTIBOT_DIR, round } from '../core/index.js';
import { atomicWriteJsonSync, readTextAllowMissing } from '../core/file.js';
import { withFileLock } from '../core/file-lock.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HISTORY_DIR = ARTIBOT_DIR;
const HISTORY_PATH = path.join(HISTORY_DIR, 'tool-history.json');

/** Maximum records kept per context key to prevent unbounded growth */
export const MAX_RECORDS_PER_KEY = 200;

/** Minimum sample size before trusting a recommendation */
export const MIN_SAMPLES = 3;

/** Decay factor for older observations (exponential decay) */
const DECAY_HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** Debounce interval for batched writes (ms) */
export const FLUSH_INTERVAL_MS = 5000;

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

/** @type {import('./tool-learner.js').ToolHistory|null} */
let _history = null;

/** Whether in-memory history has unsaved changes */
let _dirty = false;

/** Pending flush timer reference */
let _flushTimer = null;

/**
 * Records this process appended since its last successful save. A save merges
 * exactly these onto the latest file on disk, so another process's rows that
 * landed in between survive (see {@link saveHistory}).
 * @type {import('./tool-learner.js').UsageRecord[]}
 */
let _pending = [];

/** Cutoff (Unix ms) of a prune run since the last save, re-applied on merge. */
let _pruneCutoff = null;

/** Set by {@link setHistory}: the next save writes the in-memory history whole. */
let _replace = false;

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * Load history from disk. Creates empty history if file doesn't exist.
 *
 * The content is judged by {@link parseHistory}, the same rule the locked
 * re-read ({@link readDiskHistory}) applies. The read rule differs on purpose:
 * this load only seeds the in-memory copy, and a save does not trust that copy
 * for what is on disk — it re-reads the file under the lock, which surfaces
 * every error but ENOENT, and merges this process's pending rows onto what it
 * read. So ANY read error starts empty here. The in-memory copy is written
 * whole only after a reset ({@link setHistory}), or when that re-read finds no
 * file or a file that is not a history ({@link mergeOnto}).
 *
 * @returns {Promise<import('./tool-learner.js').ToolHistory>}
 */
export async function loadHistory() {
  if (_history) return _history;

  let text = null;
  try {
    text = await fs.readFile(HISTORY_PATH, 'utf-8');
  } catch {
    // Missing or unreadable: start empty (see above).
  }
  _history = (text !== null && parseHistory(text)) || createEmptyHistory();
  return _history;
}

/**
 * Parse file content as a history, or null when it is not one: unparseable,
 * not an object, or `version` missing / below 1. `contexts` and `aggregates`
 * that are not objects become `{}` — kept as-is, a number or string made the
 * next recordUsage throw assigning a property to a primitive.
 *
 * @param {string} text
 * @returns {import('./tool-learner.js').ToolHistory|null}
 */
function parseHistory(text) {
  let parsed;
  try { parsed = JSON.parse(text); } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || !parsed.version || parsed.version < 1) return null;
  return {
    ...parsed,
    contexts: parsed.contexts && typeof parsed.contexts === 'object' ? parsed.contexts : {},
    aggregates: parsed.aggregates && typeof parsed.aggregates === 'object' ? parsed.aggregates : {},
  };
}

/**
 * Persist history to disk.
 *
 * One critical section under `lib/core/file-lock.js#withFileLock`: re-read the
 * file, merge, atomic write. The PostToolUse tracker is one process per tool
 * call and the host fires parallel calls at once; the old load-early,
 * write-whole-later shape let the last writer erase everyone else's rows
 * (review measurement N=16: 1/16 kept; reproduced 2026-11-21 at 6-10/16 by
 * tests/hooks/tool-tracker-concurrency.test.js).
 *
 * Merge rule — the file on disk is the base whenever it parses as a history:
 *   - the records THIS process appended since its last save are added to it
 *     (per-key cap and aggregates applied as recordUsage does);
 *   - a prune run since the last save is re-applied to it by cutoff;
 *   - after {@link setHistory} (reset) the in-memory history is written whole,
 *     without reading the file.
 * What the re-read may conclude is an allowlist ({@link readDiskHistory}):
 * ENOENT means "no file" and an unparseable file is not a history — both are
 * replaced by the in-memory history, as before. ANY other read error (EBUSY
 * while another process renames over the file on Windows, EACCES, EMFILE, …)
 * writes nothing: treating it as "no file" wrote the in-memory copy whole and
 * erased every row another process had added since this one loaded (review
 * xcB 2026-11-21, on a copy: 61 rows -> 51, worst 1, with `true` returned).
 *
 * NOT covered: a reset in one process does not stop another process that
 * loaded before it from merging its own pending rows back afterwards; and a
 * prune only re-applies its cutoff, so another process's rows older than the
 * cutoff written after the prune survive until the next prune.
 *
 * @returns {Promise<boolean>} true when written; false when nothing was loaded,
 *   the lock was not taken within its wait (ELOCKTIMEOUT), or the re-read
 *   failed — non-fatal so a hook keeps its slot, with one stderr line. The
 *   pending rows stay queued, but only a later save IN THIS PROCESS can write
 *   them; a hook process that exits after a false loses them. Any other error
 *   (lock create, write) is thrown.
 */
export async function saveHistory() {
  if (!_history) return false;

  let outcome;
  try {
    outcome = withFileLock(HISTORY_PATH, () => {
      const disk = _replace ? { history: null } : readDiskHistory();
      if (disk.error) return { readError: disk.error };
      const next = mergeOnto(disk.history);
      atomicWriteJsonSync(HISTORY_PATH, next);
      return { written: next };
    });
  } catch (err) {
    if (err?.code !== 'ELOCKTIMEOUT') throw err;
    process.stderr.write(`[artibot:tool-history] lock not taken within its wait; ${_pending.length} row(s) not saved\n`);
    return false;
  }
  if (outcome.readError) {
    process.stderr.write(`[artibot:tool-history] re-read under the lock failed (${outcome.readError.code ?? 'error'}); file left as is, ${_pending.length} row(s) not saved\n`);
    return false;
  }
  _history = outcome.written;
  _pending = [];
  _pruneCutoff = null;
  _replace = false;
  return true;
}

/**
 * The latest history on disk.
 *
 * `history` is null when the file is missing (ENOENT) or does not parse as a
 * history ({@link parseHistory}) — the two outcomes {@link saveHistory} may
 * overwrite. Every other read error comes back as `error` instead, never as
 * "missing" (`lib/core/file.js#readTextAllowMissing`).
 *
 * @returns {{ history: import('./tool-learner.js').ToolHistory|null, error?: NodeJS.ErrnoException }}
 */
function readDiskHistory() {
  let text;
  try {
    text = readTextAllowMissing(HISTORY_PATH);
  } catch (err) {
    return { history: null, error: err };
  }
  return { history: text === null ? null : parseHistory(text) };
}

/**
 * Build what {@link saveHistory} writes. `disk` is a fresh parse owned by the
 * caller, so it is extended in place.
 *
 * @param {import('./tool-learner.js').ToolHistory|null} disk
 * @returns {import('./tool-learner.js').ToolHistory}
 */
function mergeOnto(disk) {
  if (_replace || !disk) return { ..._history, lastUpdated: Date.now() };

  for (const rec of _pending) {
    const rows = [...(disk.contexts[rec.context] ?? []), rec];
    disk.contexts[rec.context] = rows.length > MAX_RECORDS_PER_KEY
      ? rows.slice(-MAX_RECORDS_PER_KEY)
      : rows;
    updateAggregate(disk, rec.tool, rec);
  }
  if (_pruneCutoff !== null) {
    for (const [ctx, rows] of Object.entries(disk.contexts)) {
      const kept = rows.filter((r) => r.timestamp >= _pruneCutoff);
      if (kept.length === 0) delete disk.contexts[ctx];
      else disk.contexts[ctx] = kept;
    }
    rebuildAggregates(disk);
  }
  disk.lastUpdated = Date.now();
  return disk;
}

/**
 * Queue a record this process appended, for the next {@link saveHistory} merge.
 * @param {import('./tool-learner.js').UsageRecord} record
 */
export function notePendingRecord(record) {
  _pending = [..._pending, record];
}

/**
 * Remember a prune cutoff so the next {@link saveHistory} re-applies it to the
 * file on disk. The latest (largest) cutoff wins.
 * @param {number} cutoff - Unix ms; records older than this are dropped
 */
export function notePrune(cutoff) {
  _pruneCutoff = _pruneCutoff === null ? cutoff : Math.max(_pruneCutoff, cutoff);
}

/**
 * Path of the persisted history (frozen at import, like `ARTIBOT_DIR`).
 * @returns {string}
 */
export function getHistoryPath() {
  return HISTORY_PATH;
}

/**
 * Mark history as dirty and schedule a debounced flush.
 * Does not write to disk immediately; batches writes for efficiency.
 * @param {() => Promise<void>} flushFn - The flush function to call
 */
export function markDirty(flushFn) {
  _dirty = true;
  if (!_flushTimer) {
    _flushTimer = setTimeout(flushFn, FLUSH_INTERVAL_MS);
  }
}

/**
 * Get and reset the dirty/timer state for flushing.
 * @returns {{ dirty: boolean, timer: ReturnType<typeof setTimeout> | null }}
 */
export function getDirtyState() {
  return { dirty: _dirty, timer: _flushTimer };
}

/**
 * Clear the flush timer and dirty flag after a successful flush.
 */
export function clearDirtyState() {
  if (_flushTimer) {
    clearTimeout(_flushTimer);
    _flushTimer = null;
  }
  _dirty = false;
}

/**
 * Create an empty tool history object.
 * @returns {import('./tool-learner.js').ToolHistory}
 */
export function createEmptyHistory() {
  return {
    version: 2,
    contexts: {},
    aggregates: {},
    lastUpdated: Date.now(),
  };
}

/**
 * Set the in-memory history reference directly (for reset).
 * @param {import('./tool-learner.js').ToolHistory} history
 */
export function setHistory(history) {
  _history = history;
  // A wholesale replacement (reset): the next save writes it as-is instead of
  // merging onto the file, and rows queued before it are part of what it replaced.
  _replace = true;
  _pending = [];
  _pruneCutoff = null;
}

// ---------------------------------------------------------------------------
// Aggregate Management
// ---------------------------------------------------------------------------

/**
 * Update the per-tool aggregate stats incrementally.
 * @param {import('./tool-learner.js').ToolHistory} history
 * @param {string} tool
 * @param {import('./tool-learner.js').UsageRecord} record
 */
export function updateAggregate(history, tool, record) {
  let stats = history.aggregates[tool];
  if (!stats) {
    stats = { totalUses: 0, totalScore: 0, avgScore: 0, lastUsed: 0 };
    history.aggregates[tool] = stats;
  }

  stats.totalUses += 1;
  stats.totalScore += record.score;
  stats.avgScore = round(stats.totalScore / stats.totalUses);
  stats.lastUsed = record.timestamp;
}

/**
 * Rebuild all aggregates from raw records.
 * @param {import('./tool-learner.js').ToolHistory} history
 */
export function rebuildAggregates(history) {
  history.aggregates = {};
  for (const records of Object.values(history.contexts)) {
    for (const rec of records) {
      updateAggregate(history, rec.tool, rec);
    }
  }
}

// ---------------------------------------------------------------------------
// Scoring Internals
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} ToolSuggestion
 * @property {string} tool - Tool name
 * @property {number} weightedScore - Time-decayed weighted score (0-1)
 * @property {number} rawAvg - Raw average score
 * @property {number} samples - Number of observations
 * @property {string} confidence - "low" | "medium" | "high"
 */

/**
 * Compute time-decayed weighted scores for tools in a record set.
 * @param {import('./tool-learner.js').UsageRecord[]} records
 * @returns {ToolSuggestion[]}
 */
export function computeToolScores(records) {
  const now = Date.now();
  /** @type {Map<string, { totalWeight: number, weightedSum: number, rawSum: number, count: number }>} */
  const toolMap = new Map();

  for (const rec of records) {
    const age = now - rec.timestamp;
    const weight = Math.pow(0.5, age / DECAY_HALF_LIFE_MS);

    let entry = toolMap.get(rec.tool);
    if (!entry) {
      entry = { totalWeight: 0, weightedSum: 0, rawSum: 0, count: 0 };
      toolMap.set(rec.tool, entry);
    }

    entry.totalWeight += weight;
    entry.weightedSum += rec.score * weight;
    entry.rawSum += rec.score;
    entry.count += 1;
  }

  /** @type {ToolSuggestion[]} */
  const suggestions = [];

  for (const [tool, entry] of toolMap) {
    const weightedScore =
      entry.totalWeight > 0 ? entry.weightedSum / entry.totalWeight : 0;
    const rawAvg = entry.count > 0 ? entry.rawSum / entry.count : 0;

    suggestions.push({
      tool,
      weightedScore: round(weightedScore),
      rawAvg: round(rawAvg),
      samples: entry.count,
      confidence: getConfidence(entry.count),
    });
  }

  suggestions.sort((a, b) => b.weightedScore - a.weightedScore);
  return suggestions;
}

/**
 * Fallback: when exact context has no data, find related contexts by
 * prefix matching and aggregate their scores.
 * @param {import('./tool-learner.js').ToolHistory} history
 * @param {string} context
 * @param {number} limit
 * @param {number} minScore
 * @returns {ToolSuggestion[]}
 */
export function suggestFromRelated(history, context, limit, minScore) {
  const parts = context.split(':');
  if (parts.length < 2) return [];

  const prefix = parts[0] + ':';
  const relatedRecords = [];

  for (const [ctx, records] of Object.entries(history.contexts)) {
    if (ctx.startsWith(prefix) && ctx !== context) {
      relatedRecords.push(...records);
    }
  }

  if (relatedRecords.length === 0) return [];

  const scored = computeToolScores(relatedRecords);
  return scored
    .filter((s) => s.weightedScore >= minScore && s.samples >= MIN_SAMPLES)
    .map((s) => ({ ...s, confidence: 'low' }))
    .slice(0, limit);
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Clamp a numeric score between 0 and 1.
 * @param {number} n - Score to clamp
 * @returns {number}
 */
export function clampScore(n) {
  return Math.max(0, Math.min(1, Number(n) || 0));
}

/**
 * Determine confidence level from sample count.
 * @param {number} count - Number of samples
 * @returns {"low"|"medium"|"high"}
 */
export function getConfidence(count) {
  if (count >= 20) return 'high';
  if (count >= MIN_SAMPLES) return 'medium';
  return 'low';
}

/**
 * Clear in-memory cache. Useful for testing.
 * @returns {void}
 */
export function clearCache() {
  _history = null;
  _dirty = false;
  _pending = [];
  _pruneCutoff = null;
  _replace = false;
  if (_flushTimer) {
    clearTimeout(_flushTimer);
    _flushTimer = null;
  }
}

/**
 * Expose internal dirty/timer state for testing.
 * @returns {{ dirty: boolean, hasTimer: boolean }}
 */
export function getBufferState() {
  return { dirty: _dirty, hasTimer: _flushTimer !== null };
}
