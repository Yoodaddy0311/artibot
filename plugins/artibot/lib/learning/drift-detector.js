/**
 * Alignment Drift Detector.
 * Tracks per-agent alignment scores in a rolling window and detects
 * when an agent's behavior is drifting below acceptable thresholds.
 *
 * Inspired by gradient interception patterns for real-time quality monitoring.
 *
 * Zero dependencies beyond node built-ins. ESM only.
 * @module lib/learning/drift-detector
 */

import { round } from '../core/index.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Rolling window size for alignment score tracking */
const WINDOW_SIZE = 20;

/** Score below this triggers a drift warning */
const DRIFT_THRESHOLD = 0.65;

/** Consecutive flags before critical alert */
const CRITICAL_STREAK = 5;

/** Minimum samples before drift detection is meaningful */
const MIN_SAMPLES = 3;

// ---------------------------------------------------------------------------
// State (module-scoped, session-lifetime)
// ---------------------------------------------------------------------------

/**
 * Per-agent tracking data.
 * @type {Map<string, AgentTrack>}
 *
 * @typedef {Object} AgentTrack
 * @property {ScoreEntry[]} window - Rolling score window
 * @property {number} consecutiveFlags - Consecutive below-threshold events
 * @property {number} totalRecorded - Total scores ever recorded
 */
const agents = new Map();

/**
 * @typedef {Object} ScoreEntry
 * @property {number} score - Alignment score (0.0-1.0)
 * @property {number} timestamp - Unix timestamp
 * @property {object} [metadata] - Optional metadata
 */

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Record an alignment score for an agent.
 *
 * @param {string} agentId - Agent identifier
 * @param {number} score - Alignment score (0.0-1.0)
 * @param {object} [metadata] - Optional metadata to attach
 * @returns {{ recorded: boolean, windowSize: number, currentAvg: number }}
 */
export function recordScore(agentId, score, metadata) {
  const clamped = Math.max(0, Math.min(1, Number(score) || 0));
  const track = getOrCreateTrack(agentId);

  const entry = {
    score: clamped,
    timestamp: Date.now(),
    ...(metadata ? { metadata } : {}),
  };

  // Immutable window update: append + trim to WINDOW_SIZE
  track.window = [...track.window, entry].slice(-WINDOW_SIZE);
  track.totalRecorded += 1;

  // Update consecutive flags
  if (clamped < DRIFT_THRESHOLD) {
    track.consecutiveFlags += 1;
  } else {
    track.consecutiveFlags = 0;
  }

  const avg = computeAverage(track.window);

  return {
    recorded: true,
    windowSize: track.window.length,
    currentAvg: round(avg),
  };
}

/**
 * Check whether an agent is drifting from alignment.
 *
 * @param {string} agentId - Agent identifier
 * @returns {{
 *   drifting: boolean,
 *   score: number,
 *   trend: 'stable'|'declining'|'improving',
 *   severity: 'none'|'warning'|'critical',
 *   consecutiveFlags: number,
 *   samples: number,
 * }}
 */
export function checkDrift(agentId) {
  const track = agents.get(agentId);

  if (!track || track.window.length < MIN_SAMPLES) {
    return {
      drifting: false,
      score: track ? computeAverage(track.window) : 0,
      trend: 'stable',
      severity: 'none',
      consecutiveFlags: 0,
      samples: track ? track.window.length : 0,
    };
  }

  const avg = computeAverage(track.window);
  const trend = detectTrend(track.window);
  const drifting = avg < DRIFT_THRESHOLD;

  let severity = 'none';
  if (drifting && track.consecutiveFlags >= CRITICAL_STREAK) {
    severity = 'critical';
  } else if (drifting) {
    severity = 'warning';
  }

  return {
    drifting,
    score: round(avg),
    trend,
    severity,
    consecutiveFlags: track.consecutiveFlags,
    samples: track.window.length,
  };
}

/**
 * Get recent score history for an agent.
 *
 * @param {string} agentId - Agent identifier
 * @param {number} [limit] - Max entries to return (default: all in window)
 * @returns {ScoreEntry[]}
 */
export function getHistory(agentId, limit) {
  const track = agents.get(agentId);
  if (!track) return [];

  const entries = track.window;
  if (limit && limit > 0) {
    return entries.slice(-limit);
  }
  return [...entries];
}

/**
 * Reset tracking data for a specific agent.
 *
 * @param {string} agentId - Agent identifier
 * @returns {void}
 */
export function resetAgent(agentId) {
  agents.delete(agentId);
}

/**
 * Reset all drift detection state.
 * Intended for testing or session teardown.
 *
 * @returns {void}
 */
export function resetAll() {
  agents.clear();
}

/**
 * Get a summary of all tracked agents.
 *
 * @returns {{ agentId: string, score: number, drifting: boolean, samples: number }[]}
 */
export function getSummary() {
  const result = [];
  for (const [agentId, track] of agents) {
    const avg = computeAverage(track.window);
    result.push({
      agentId,
      score: round(avg),
      drifting: avg < DRIFT_THRESHOLD && track.window.length >= MIN_SAMPLES,
      samples: track.window.length,
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Get or create a tracking record for an agent.
 * @param {string} agentId
 * @returns {AgentTrack}
 */
function getOrCreateTrack(agentId) {
  let track = agents.get(agentId);
  if (!track) {
    track = { window: [], consecutiveFlags: 0, totalRecorded: 0 };
    agents.set(agentId, track);
  }
  return track;
}

/**
 * Compute the average score of a window.
 * @param {ScoreEntry[]} window
 * @returns {number}
 */
function computeAverage(window) {
  if (window.length === 0) return 0;
  const sum = window.reduce((s, e) => s + e.score, 0);
  return sum / window.length;
}

/**
 * Detect the trend direction by comparing first and second half of the window.
 * @param {ScoreEntry[]} window
 * @returns {'stable'|'declining'|'improving'}
 */
function detectTrend(window) {
  if (window.length < 4) return 'stable';

  const mid = Math.floor(window.length / 2);
  const firstHalf = window.slice(0, mid);
  const secondHalf = window.slice(mid);

  const firstAvg = computeAverage(firstHalf);
  const secondAvg = computeAverage(secondHalf);
  const diff = secondAvg - firstAvg;

  if (diff > 0.05) return 'improving';
  if (diff < -0.05) return 'declining';
  return 'stable';
}

// ---------------------------------------------------------------------------
// Exported constants (for testing)
// ---------------------------------------------------------------------------

export { WINDOW_SIZE, DRIFT_THRESHOLD, CRITICAL_STREAK, MIN_SAMPLES };
