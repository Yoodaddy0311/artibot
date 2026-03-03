/**
 * Tool history persistence, scoring, and GRPO internal helpers.
 * Manages disk I/O, time-decayed scoring, aggregate computation,
 * and GRPO composite score calculation for tool-learner.js.
 *
 * Zero dependencies beyond node built-ins. ESM only.
 * @module lib/learning/tool-history
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { ARTIBOT_DIR, round } from '../core/index.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HISTORY_DIR = ARTIBOT_DIR;
const HISTORY_PATH = path.join(HISTORY_DIR, 'tool-history.json');

/** Minimum sample size before trusting a recommendation */
export const MIN_SAMPLES = 3;

/** Decay factor for older observations (exponential decay) */
const DECAY_HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** Weight factors for GRPO multi-criteria scoring */
export const GRPO_WEIGHTS = {
  success: 0.35,
  speed: 0.25,
  accuracy: 0.25,
  brevity: 0.15,
};

/** Learning rate for GRPO relative ranking updates */
export const GRPO_LEARNING_RATE = 0.1;

/** Maximum GRPO comparison groups stored per context */
export const MAX_GRPO_GROUPS_PER_KEY = 50;

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

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * Load history from disk. Creates empty history if file doesn't exist.
 * @returns {Promise<import('./tool-learner.js').ToolHistory>}
 */
export async function loadHistory() {
  if (_history) return _history;

  try {
    const raw = await fs.readFile(HISTORY_PATH, 'utf-8');
    _history = JSON.parse(raw);
    if (!_history.version || _history.version < 1) {
      _history = createEmptyHistory();
    }
    // Migrate v1 -> v2: add GRPO fields
    if (_history.version < 2) {
      _history.version = 2;
      _history.grpoGroups = _history.grpoGroups || {};
      _history.grpoScores = _history.grpoScores || {};
    }
  } catch {
    _history = createEmptyHistory();
  }

  return _history;
}

/**
 * Persist history to disk.
 * @returns {Promise<void>}
 */
export async function saveHistory() {
  if (!_history) return;

  _history.lastUpdated = Date.now();
  await fs.mkdir(HISTORY_DIR, { recursive: true });
  const content = JSON.stringify(_history, null, 2) + '\n';
  await fs.writeFile(HISTORY_PATH, content, 'utf-8');
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
    grpoGroups: {},
    grpoScores: {},
    lastUpdated: Date.now(),
  };
}

/**
 * Set the in-memory history reference directly (for reset).
 * @param {import('./tool-learner.js').ToolHistory} history
 */
export function setHistory(history) {
  _history = history;
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
// GRPO Internals
// ---------------------------------------------------------------------------

/**
 * Compute a composite GRPO score for a single tool result,
 * normalizing speed and brevity relative to the group.
 *
 * @param {import('./tool-learner.js').GRPOResult} result - The tool result to score
 * @param {import('./tool-learner.js').GRPOResult[]} group - All results in the comparison group
 * @returns {number} Composite score 0.0-1.0
 */
export function computeGrpoComposite(result, group) {
  // Success: binary
  const successScore = result.success ? 1.0 : 0.0;

  // Speed: normalized inversely (fastest = 1.0, slowest = 0.0)
  const durations = group.map((r) => r.durationMs).filter((d) => d > 0);
  let speedScore = 0.5;
  if (durations.length > 1 && result.durationMs > 0) {
    const maxDur = Math.max(...durations);
    const minDur = Math.min(...durations);
    speedScore =
      maxDur === minDur
        ? 1.0
        : 1.0 - (result.durationMs - minDur) / (maxDur - minDur);
  } else if (result.durationMs > 0 && durations.length === 1) {
    speedScore = 1.0; // Only one with duration data
  }

  // Accuracy: directly from caller's assessment
  const accuracyScore = clampScore(result.accuracy);

  // Brevity: directly from caller's assessment
  const brevityScore = clampScore(result.brevity);

  return (
    GRPO_WEIGHTS.success * successScore +
    GRPO_WEIGHTS.speed * speedScore +
    GRPO_WEIGHTS.accuracy * accuracyScore +
    GRPO_WEIGHTS.brevity * brevityScore
  );
}

/** Build a GRPO storage key */
export function makeGrpoKey(context, tool) {
  return `${context}::${tool}`;
}

/** Split a GRPO storage key back into [context, tool] */
export function splitGrpoKey(key) {
  const idx = key.indexOf('::');
  if (idx === -1) return [key, ''];
  return [key.slice(0, idx), key.slice(idx + 2)];
}

/** Count how many GRPO comparisons a tool participated in for a context */
export function countGrpoComparisons(history, context, tool) {
  const groups = history.grpoGroups[context] || [];
  let count = 0;
  for (const group of groups) {
    if (group.rankings.some((r) => r.tool === tool)) count++;
  }
  return count;
}

/** Gather tool scores from related contexts (same operation prefix) */
export function gatherRelatedTools(history, context) {
  const parts = context.split(':');
  if (parts.length < 2) return new Map();

  const prefix = parts[0] + ':';
  const toolScoreMap = new Map();

  for (const [ctx, records] of Object.entries(history.contexts)) {
    if (ctx.startsWith(prefix) && ctx !== context) {
      for (const rec of records) {
        const existing = toolScoreMap.get(rec.tool);
        if (!existing || rec.score > existing) {
          toolScoreMap.set(rec.tool, rec.score);
        }
      }
    }
  }

  return toolScoreMap;
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
