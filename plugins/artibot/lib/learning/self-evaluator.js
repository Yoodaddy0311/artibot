/**
 * Self-Rewarding evaluation system.
 * Based on Meta Self-Rewarding LLM patterns for autonomous quality assessment.
 * Evaluates task results, identifies patterns, and generates improvement suggestions.
 * @module lib/learning/self-evaluator
 */

import path from 'node:path';
import { readJsonFile, writeJsonFile } from '../core/file.js';
import { getHomeDir } from '../core/platform.js';

const EVALUATIONS_FILENAME = 'evaluations.json';
const MAX_EVALUATIONS = 500;

/**
 * Evaluation dimensions with weights.
 */
const DIMENSIONS = {
  accuracy: { weight: 0.35, description: 'Correctness of output vs requirements' },
  completeness: { weight: 0.25, description: 'Coverage of all requested aspects' },
  efficiency: { weight: 0.20, description: 'Resource usage and execution speed' },
  satisfaction: { weight: 0.20, description: 'Implicit user satisfaction signals' },
};

/**
 * Get the evaluations file path (~/.claude/artibot/evaluations.json).
 * @returns {string}
 */
function getEvaluationsPath() {
  return path.join(getHomeDir(), '.claude', 'artibot', EVALUATIONS_FILENAME);
}

/**
 * Load persisted evaluations from disk.
 * @returns {Promise<object[]>}
 */
async function loadEvaluations() {
  const data = await readJsonFile(getEvaluationsPath());
  return Array.isArray(data) ? data : [];
}

/**
 * Save evaluations to disk, pruning old entries beyond MAX_EVALUATIONS.
 * @param {object[]} evaluations
 */
async function saveEvaluations(evaluations) {
  const pruned = evaluations.length > MAX_EVALUATIONS
    ? evaluations.slice(evaluations.length - MAX_EVALUATIONS)
    : evaluations;
  await writeJsonFile(getEvaluationsPath(), pruned);
}

/**
 * Evaluate a task result across all dimensions.
 * Returns a scored evaluation with per-dimension breakdown.
 *
 * @param {object} task - Task metadata
 * @param {string} task.id - Task identifier
 * @param {string} task.type - Task type (e.g. 'build', 'fix', 'refactor')
 * @param {string} [task.description] - Task description
 * @param {object} result - Task result
 * @param {boolean} result.success - Whether the task succeeded
 * @param {string[]} [result.filesModified] - Files that were modified
 * @param {number} [result.duration] - Duration in ms
 * @param {boolean} [result.testsPass] - Whether tests pass after changes
 * @param {object} [result.metrics] - Additional metrics
 * @param {object} [options]
 * @param {boolean} [options.persist=true] - Whether to save to disk
 * @returns {Promise<{
 *   id: string,
 *   taskId: string,
 *   taskType: string,
 *   timestamp: string,
 *   dimensions: Record<string, { score: number, weight: number }>,
 *   overall: number,
 *   grade: string,
 *   feedback: string
 * }>}
 */
export async function evaluateResult(task, result, options = {}) {
  const { persist = true } = options;

  const dimensions = {
    accuracy: {
      score: scoreAccuracy(result),
      weight: DIMENSIONS.accuracy.weight,
    },
    completeness: {
      score: scoreCompleteness(task, result),
      weight: DIMENSIONS.completeness.weight,
    },
    efficiency: {
      score: scoreEfficiency(result),
      weight: DIMENSIONS.efficiency.weight,
    },
    satisfaction: {
      score: scoreSatisfaction(result),
      weight: DIMENSIONS.satisfaction.weight,
    },
  };

  const overall = Object.values(dimensions).reduce(
    (sum, d) => sum + d.score * d.weight,
    0,
  );

  const grade = scoreToGrade(overall);
  const feedback = generateFeedback(dimensions, overall);

  const evaluation = {
    id: `eval-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    taskId: task.id,
    taskType: task.type,
    timestamp: new Date().toISOString(),
    dimensions,
    overall: Math.round(overall * 100) / 100,
    grade,
    feedback,
  };

  if (persist) {
    const existing = await loadEvaluations();
    await saveEvaluations([...existing, evaluation]);
  }

  return evaluation;
}

/**
 * Get improvement suggestions based on evaluation history.
 * Analyzes low-scoring patterns and generates actionable recommendations.
 *
 * @param {object} [options]
 * @param {number} [options.lookback=50] - Number of recent evaluations to analyze
 * @param {number} [options.threshold=3.0] - Score threshold below which to flag issues
 * @returns {Promise<{
 *   weakDimensions: { dimension: string, avgScore: number, trend: string }[],
 *   weakTaskTypes: { taskType: string, avgScore: number, count: number }[],
 *   suggestions: string[],
 *   overallTrend: string
 * }>}
 */
export async function getImprovementSuggestions(options = {}) {
  const { lookback = 50, threshold = 3.0 } = options;
  const all = await loadEvaluations();
  const recent = all.slice(-lookback);

  if (recent.length === 0) {
    return {
      weakDimensions: [],
      weakTaskTypes: [],
      suggestions: ['No evaluations recorded yet. Complete tasks to build evaluation history.'],
      overallTrend: 'insufficient_data',
    };
  }

  const weakDimensions = findWeakDimensions(recent, threshold);
  const weakTaskTypes = findWeakTaskTypes(recent, threshold);
  const overallTrend = computeTrend(recent);
  const suggestions = buildSuggestions(weakDimensions, weakTaskTypes, overallTrend);

  return { weakDimensions, weakTaskTypes, suggestions, overallTrend };
}

/**
 * Get team performance analysis.
 * Evaluates which team compositions and patterns produced the best results.
 *
 * @param {object} [options]
 * @param {number} [options.lookback=100] - Number of recent evaluations to analyze
 * @returns {Promise<{
 *   byTaskType: Record<string, { count: number, avgScore: number }>,
 *   topPerformers: { taskType: string, avgScore: number }[],
 *   bottomPerformers: { taskType: string, avgScore: number }[],
 *   totalEvaluations: number
 * }>}
 */
export async function getTeamPerformance(options = {}) {
  const { lookback = 100 } = options;
  const all = await loadEvaluations();
  const recent = all.slice(-lookback);

  const byTaskType = {};
  for (const ev of recent) {
    const type = ev.taskType || 'unknown';
    if (!byTaskType[type]) {
      byTaskType[type] = { count: 0, totalScore: 0 };
    }
    byTaskType[type].count += 1;
    byTaskType[type].totalScore += ev.overall;
  }

  const entries = Object.entries(byTaskType).map(([taskType, data]) => ({
    taskType,
    count: data.count,
    avgScore: Math.round((data.totalScore / data.count) * 100) / 100,
  }));

  const sorted = [...entries].sort((a, b) => b.avgScore - a.avgScore);

  return {
    byTaskType: Object.fromEntries(
      entries.map(e => [e.taskType, { count: e.count, avgScore: e.avgScore }]),
    ),
    topPerformers: sorted.slice(0, 3),
    bottomPerformers: sorted.slice(-3).reverse(),
    totalEvaluations: recent.length,
  };
}

/**
 * Get learning trends over time.
 * Shows how evaluation scores have changed across time windows.
 *
 * @param {object} [options]
 * @param {number} [options.windowSize=10] - Number of evaluations per window
 * @returns {Promise<{
 *   windows: { index: number, avgScore: number, count: number }[],
 *   trend: string,
 *   latestAvg: number,
 *   earliestAvg: number
 * }>}
 */
export async function getLearningTrends(options = {}) {
  const { windowSize = 10 } = options;
  const all = await loadEvaluations();

  if (all.length < 2) {
    return {
      windows: [],
      trend: 'insufficient_data',
      latestAvg: all.length === 1 ? all[0].overall : 0,
      earliestAvg: all.length === 1 ? all[0].overall : 0,
    };
  }

  const windows = [];
  for (let i = 0; i < all.length; i += windowSize) {
    const slice = all.slice(i, i + windowSize);
    const avg = slice.reduce((sum, e) => sum + e.overall, 0) / slice.length;
    windows.push({
      index: windows.length,
      avgScore: Math.round(avg * 100) / 100,
      count: slice.length,
    });
  }

  const earliestAvg = windows[0].avgScore;
  const latestAvg = windows[windows.length - 1].avgScore;
  const trend = latestAvg > earliestAvg + 0.3
    ? 'improving'
    : latestAvg < earliestAvg - 0.3
      ? 'declining'
      : 'stable';

  return { windows, trend, latestAvg, earliestAvg };
}

// --- Scoring functions ---

function scoreAccuracy(result) {
  let score = result.success ? 4 : 1;
  if (result.testsPass === true) score = Math.min(5, score + 1);
  if (result.testsPass === false) score = Math.max(1, score - 1);
  return score;
}

function scoreCompleteness(task, result) {
  let score = 3; // base: average
  if (result.success) score += 1;
  if (result.filesModified && result.filesModified.length > 0) score += 0.5;
  if (task.description && result.metrics?.requirementsCovered) {
    score = Math.min(5, 1 + 4 * result.metrics.requirementsCovered);
  }
  return Math.min(5, Math.max(1, Math.round(score * 10) / 10));
}

function scoreEfficiency(result) {
  if (result.duration === undefined) return 3;
  // Faster is better: <30s = 5, <60s = 4, <120s = 3, <300s = 2, else 1
  if (result.duration < 30000) return 5;
  if (result.duration < 60000) return 4;
  if (result.duration < 120000) return 3;
  if (result.duration < 300000) return 2;
  return 1;
}

function scoreSatisfaction(result) {
  let score = result.success ? 4 : 2;
  if (result.metrics?.userFeedback === 'positive') score = 5;
  if (result.metrics?.userFeedback === 'negative') score = 1;
  if (result.metrics?.revisionRequested) score = Math.max(1, score - 1);
  return score;
}

function scoreToGrade(overall) {
  if (overall >= 4.5) return 'A';
  if (overall >= 3.5) return 'B';
  if (overall >= 2.5) return 'C';
  if (overall >= 1.5) return 'D';
  return 'F';
}

function generateFeedback(dimensions, overall) {
  const parts = [];

  if (overall >= 4.0) {
    parts.push('Strong performance overall.');
  } else if (overall >= 3.0) {
    parts.push('Adequate performance with room for improvement.');
  } else {
    parts.push('Below expectations. Review approach and strategy.');
  }

  const weakest = Object.entries(dimensions)
    .sort(([, a], [, b]) => a.score - b.score)[0];

  if (weakest && weakest[1].score < 3) {
    parts.push(`Weakest area: ${weakest[0]} (${weakest[1].score}/5).`);
  }

  return parts.join(' ');
}

// --- Analysis helpers ---

function findWeakDimensions(evaluations, threshold) {
  const dimSums = {};
  const dimCounts = {};

  for (const ev of evaluations) {
    for (const [dim, data] of Object.entries(ev.dimensions)) {
      dimSums[dim] = (dimSums[dim] || 0) + data.score;
      dimCounts[dim] = (dimCounts[dim] || 0) + 1;
    }
  }

  const results = [];
  for (const dim of Object.keys(dimSums)) {
    const avg = dimSums[dim] / dimCounts[dim];
    if (avg < threshold) {
      const half = Math.floor(evaluations.length / 2);
      const firstHalf = evaluations.slice(0, half);
      const secondHalf = evaluations.slice(half);
      const firstAvg = avgDimScore(firstHalf, dim);
      const secondAvg = avgDimScore(secondHalf, dim);
      const trend = secondAvg > firstAvg + 0.2
        ? 'improving'
        : secondAvg < firstAvg - 0.2
          ? 'declining'
          : 'stable';
      results.push({
        dimension: dim,
        avgScore: Math.round(avg * 100) / 100,
        trend,
      });
    }
  }

  return results.sort((a, b) => a.avgScore - b.avgScore);
}

function findWeakTaskTypes(evaluations, threshold) {
  const typeSums = {};
  const typeCounts = {};

  for (const ev of evaluations) {
    const type = ev.taskType || 'unknown';
    typeSums[type] = (typeSums[type] || 0) + ev.overall;
    typeCounts[type] = (typeCounts[type] || 0) + 1;
  }

  const results = [];
  for (const type of Object.keys(typeSums)) {
    const avg = typeSums[type] / typeCounts[type];
    if (avg < threshold) {
      results.push({
        taskType: type,
        avgScore: Math.round(avg * 100) / 100,
        count: typeCounts[type],
      });
    }
  }

  return results.sort((a, b) => a.avgScore - b.avgScore);
}

function avgDimScore(evaluations, dim) {
  if (evaluations.length === 0) return 0;
  let sum = 0;
  let count = 0;
  for (const ev of evaluations) {
    if (ev.dimensions[dim]) {
      sum += ev.dimensions[dim].score;
      count += 1;
    }
  }
  return count > 0 ? sum / count : 0;
}

function computeTrend(evaluations) {
  if (evaluations.length < 4) return 'insufficient_data';
  const half = Math.floor(evaluations.length / 2);
  const firstAvg = evaluations.slice(0, half).reduce((s, e) => s + e.overall, 0) / half;
  const secondAvg = evaluations.slice(half).reduce((s, e) => s + e.overall, 0) / (evaluations.length - half);
  if (secondAvg > firstAvg + 0.3) return 'improving';
  if (secondAvg < firstAvg - 0.3) return 'declining';
  return 'stable';
}

function buildSuggestions(weakDimensions, weakTaskTypes, trend) {
  const suggestions = [];

  for (const dim of weakDimensions) {
    const advice = {
      accuracy: 'Increase test coverage and add validation checks before completing tasks.',
      completeness: 'Review task requirements more carefully and create checklists before starting.',
      efficiency: 'Consider breaking large tasks into smaller sub-tasks for faster execution.',
      satisfaction: 'Seek explicit user feedback and align output format with expectations.',
    };
    suggestions.push(advice[dim.dimension] || `Improve ${dim.dimension} scores.`);
  }

  for (const type of weakTaskTypes) {
    suggestions.push(`Task type "${type.taskType}" has low scores (${type.avgScore}/5). Consider using specialized agents or different strategies.`);
  }

  if (trend === 'declining') {
    suggestions.push('Overall trend is declining. Review recent changes to approach and strategy.');
  }

  if (suggestions.length === 0) {
    suggestions.push('All dimensions performing well. Continue current approach.');
  }

  return suggestions;
}
