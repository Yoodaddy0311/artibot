/**
 * Self-Rewarding evaluation system.
 * Based on Meta Self-Rewarding LLM patterns for autonomous quality assessment.
 * Evaluates task results, identifies patterns, and generates improvement suggestions.
 * @module lib/learning/self-evaluator
 */

import {
  hasAnySignal,
  loadEvaluations,
  RUBRIC_VERSION,
  saveEvaluations,
  selectByRubric,
} from './evaluation-store.js';
import { getScoreHealth } from './score-health.js';
import {
  DIMENSIONS,
  fileCount,
  scoreCompleteness,
  scoreEfficiency,
  scoreExecutionReliability,
  scoreSatisfaction,
} from './scoring.js';

export { RUBRIC_VERSION, getScoreHealth };

/**
 * Record which scoring signals actually arrived.
 *
 * The point is to separate a broken input pipe from a genuine failure. Both
 * currently score the same, and with the old records nobody can say how many of
 * 318 consecutive D grades were real — this field is what makes that question
 * answerable going forward.
 *
 * @param {object} result - Task result
 * @param {string} signalSource - Provenance label supplied by the caller
 * @returns {Record<string, boolean|string>}
 */
function buildInputsPresent(result, signalSource) {
  return {
    success: result.success !== undefined,
    testsPass: result.testsPass !== undefined,
    duration: result.duration !== undefined,
    filesModified: fileCount(result.filesModified) !== null,
    filesEngaged: fileCount(result.filesEngaged) !== null,
    toolCalls: typeof result.toolCalls === 'number' && Number.isFinite(result.toolCalls),
    // Tracked separately from `toolCalls`: the reliability score needs both, so
    // seeing only the call count arrive would otherwise imply an error rate was
    // computed when it was not.
    toolErrors: typeof result.toolErrors === 'number' && Number.isFinite(result.toolErrors),
    signalSource,
  };
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
 * @param {string[]|number} [result.filesModified] - Files modified (list or count)
 * @param {string[]|number} [result.filesEngaged] - Distinct files the task
 *   interacted with at all, read included. Kept separate from `filesModified`
 *   so neither field has to mean two things; this is the efficiency denominator.
 * @param {number} [result.duration] - Duration in ms
 * @param {number} [result.toolCalls] - Tool invocations spent on the task.
 *   Forms the efficiency ratio with the file count; the scorer stays agnostic
 *   about where either number came from.
 * @param {boolean} [result.testsPass] - Whether tests pass after changes
 * @param {object} [result.metrics] - Additional metrics
 * @param {object} [options]
 * @param {boolean} [options.persist=true] - Whether to save to disk
 * @param {string} [options.signalSource='none'] - Provenance of the scoring
 *   signals, recorded verbatim in `inputsPresent`. The vocabulary belongs to
 *   whoever extracts the signals; this module only stores the label.
 * @param {string|null} [options.model] - Effective model id that produced the
 *   work, as read from the session transcript. Omit rather than guess: a null
 *   model records "unattributed", which is honest, while a declared-but-unverified
 *   id (e.g. from settings.json) would silently poison per-model comparisons.
 * @param {Record<string, number>} [options.modelMix] - Main-thread model -> turn count
 * @param {Record<string, number>} [options.subagentMix] - Subagent model -> turn count.
 *   Kept separate from `model`: once agent tiers diverge from the session tier,
 *   most of a delegated session's work belongs to these models, not the leader.
 * @param {string} [options.modelSource] - Provenance of the attribution
 * @returns {Promise<{
 *   id: string,
 *   taskId: string,
 *   taskType: string,
 *   timestamp: string,
 *   model: string | null,
 *   modelMix: Record<string, number>,
 *   subagentMix: Record<string, number>,
 *   modelSource: string,
 *   rubricVersion: number,
 *   inputsPresent: Record<string, boolean|string>,
 *   dimensions: Record<string, { score: number, weight: number }>,
 *   overall: number,
 *   grade: string,
 *   feedback: string
 * }>}
 */
export async function evaluateResult(task, result, options = {}) {
  const {
    persist = true,
    model = null,
    modelMix = {},
    subagentMix = {},
    modelSource = model ? 'caller' : 'none',
    signalSource = 'none',
  } = options;

  const scored = {
    executionReliability: scoreExecutionReliability(result),
    completeness: scoreCompleteness(task, result),
    efficiency: scoreEfficiency(result),
    satisfaction: scoreSatisfaction(result),
  };

  // Only dimensions with a real signal enter the record. A dimension held at a
  // constant by an absent input is not a low reading, it is no reading, and
  // leaving it in gave two such placeholders 0.45 of the composite weight.
  // Absence is represented by absence; `unmeasuredDimensions` names what is
  // missing so a gap stays legible instead of looking like a schema change.
  const dimensions = {};
  const unmeasuredDimensions = [];
  for (const [name, score] of Object.entries(scored)) {
    if (score === null) unmeasuredDimensions.push(name);
    else dimensions[name] = { score, weight: DIMENSIONS[name].weight };
  }

  // Renormalise across what was measured, so `overall` stays on the 1-5 scale
  // instead of shrinking toward zero as dimensions drop out.
  const measuredWeight = Object.values(dimensions).reduce((sum, d) => sum + d.weight, 0);
  const overall = measuredWeight > 0
    ? Object.values(dimensions).reduce((sum, d) => sum + d.score * d.weight, 0) / measuredWeight
    : null;

  const grade = overall === null ? null : scoreToGrade(overall);
  const feedback = overall === null
    ? 'No scoring signal reached this evaluation; nothing was measured.'
    : generateFeedback(dimensions, overall);

  const evaluation = {
    id: `eval-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    taskId: task.id,
    taskType: task.type,
    timestamp: new Date().toISOString(),
    model,
    modelMix,
    subagentMix,
    modelSource,
    rubricVersion: RUBRIC_VERSION,
    inputsPresent: buildInputsPresent(result, signalSource),
    dimensions,
    unmeasuredDimensions,
    overall: overall === null ? null : Math.round(overall * 100) / 100,
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
    // Rows where nothing was measured carry a null score and no verdict to average.
    if (typeof ev.overall !== 'number') continue;
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
 * Compare evaluation scores grouped by the model that produced them.
 *
 * Rows written before model attribution shipped carry no `model` field; they
 * are reported under `unattributed` instead of being dropped, so the caller can
 * see how much of the history is uncomparable.
 *
 * **This is a correlation, not a controlled comparison.** Different models ran
 * in different periods on different tasks, so a score gap is a prompt to
 * investigate, never on its own evidence that one model is worse. `minSamples`
 * exists to keep thin groups out of the ranked lists for that reason.
 *
 * Only one scoring regime is aggregated at a time — see {@link selectByRubric}.
 * `excludedByRubric` reports what that dropped, because a silent exclusion is
 * as misleading as the silent blend it prevents.
 *
 * @param {object} [options]
 * @param {number} [options.lookback=500] - Number of recent evaluations to analyze
 * @param {number} [options.minSamples=5] - Minimum rows before a model is ranked
 * @param {number} [options.rubricVersion] - Rubric to aggregate (default: newest present)
 * @returns {Promise<{
 *   byModel: Record<string, { count: number, avgScore: number, dimensions: Record<string, number> }>,
 *   ranked: { model: string, count: number, avgScore: number }[],
 *   attributedCount: number,
 *   unattributedCount: number,
 *   totalEvaluations: number,
 *   rubricVersion: number,
 *   excludedByRubric: number,
 *   excludedUnmeasured: number
 * }>}
 */
export async function getModelPerformance(options = {}) {
  const { lookback = 500, minSamples = 5, rubricVersion } = options;
  const window = (await loadEvaluations()).slice(-lookback);
  const { version, selected: inRubric, excludedByRubric } = selectByRubric(window, rubricVersion);
  // Unmeasured rows hold placeholders, not verdicts; averaging them in would
  // pull every model toward the neutral score and hide the differences this
  // function exists to surface.
  const recent = inRubric.filter(hasAnySignal);
  const excludedUnmeasured = inRubric.length - recent.length;

  const groups = {};
  for (const ev of recent) {
    const key = ev.model || 'unattributed';
    if (!groups[key]) groups[key] = { count: 0, scored: 0, totalScore: 0, dims: {} };
    groups[key].count += 1;
    if (typeof ev.overall === 'number') {
      groups[key].scored += 1;
      groups[key].totalScore += ev.overall;
    }
    // Per-dimension tallies count only the rows that carried that dimension.
    // Dividing by the group size instead would drag any optional dimension
    // toward zero in proportion to how often it was unmeasured — an artefact of
    // absence masquerading as a low score.
    for (const [dim, d] of Object.entries(ev.dimensions ?? {})) {
      if (typeof d?.score !== 'number') continue;
      const tally = (groups[key].dims[dim] ??= { sum: 0, n: 0 });
      tally.sum += d.score;
      tally.n += 1;
    }
  }

  const byModel = Object.fromEntries(
    Object.entries(groups).map(([model, g]) => [model, {
      count: g.count,
      avgScore: g.scored > 0 ? Math.round((g.totalScore / g.scored) * 100) / 100 : null,
      dimensions: Object.fromEntries(
        Object.entries(g.dims).map(([d, { sum, n }]) => [
          d, Math.round((sum / n) * 100) / 100,
        ]),
      ),
    }]),
  );

  const ranked = Object.entries(byModel)
    .filter(([model, g]) => model !== 'unattributed'
      && g.count >= minSamples
      && typeof g.avgScore === 'number')
    .map(([model, g]) => ({ model, count: g.count, avgScore: g.avgScore }))
    .sort((a, b) => b.avgScore - a.avgScore);

  const unattributedCount = byModel.unattributed?.count ?? 0;

  return {
    byModel,
    ranked,
    attributedCount: recent.length - unattributedCount,
    unattributedCount,
    totalEvaluations: recent.length,
    rubricVersion: version,
    excludedByRubric,
    excludedUnmeasured,
  };
}

/**
 * Get learning trends over time.
 * Shows how evaluation scores have changed across time windows.
 *
 * Trends are computed within one scoring regime. A rubric change moves the
 * scale, so a slope drawn across that boundary measures the rubric, not the work.
 *
 * @param {object} [options]
 * @param {number} [options.windowSize=10] - Number of evaluations per window
 * @param {number} [options.rubricVersion] - Rubric to analyze (default: newest present)
 * @returns {Promise<{
 *   windows: { index: number, avgScore: number, count: number }[],
 *   trend: string,
 *   latestAvg: number,
 *   earliestAvg: number,
 *   rubricVersion: number,
 *   excludedByRubric: number,
 *   excludedUnmeasured: number
 * }>}
 */
export async function getLearningTrends(options = {}) {
  const { windowSize = 10, rubricVersion } = options;
  const { version, selected: inRubric, excludedByRubric } = selectByRubric(
    await loadEvaluations(),
    rubricVersion,
  );
  // A run of unmeasured rows would otherwise register as a flat, healthy trend.
  // The score check is belt-and-braces: `hasAnySignal` should already have taken
  // those rows out, but a null slipping into the sum would yield NaN averages —
  // a silent wrong number, which is the failure mode this whole change exists
  // to remove.
  const all = inRubric.filter(ev => hasAnySignal(ev) && typeof ev.overall === 'number');
  const excludedUnmeasured = inRubric.length - all.length;

  if (all.length < 2) {
    return {
      windows: [],
      trend: 'insufficient_data',
      latestAvg: all.length === 1 ? all[0].overall : 0,
      earliestAvg: all.length === 1 ? all[0].overall : 0,
      rubricVersion: version,
      excludedByRubric,
      excludedUnmeasured,
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

  return {
    windows, trend, latestAvg, earliestAvg,
    rubricVersion: version, excludedByRubric, excludedUnmeasured,
  };
}

// --- Scoring functions ---


/**
 * Convert overall score to letter grade.
 * @param {number} overall - Overall score 0-5
 * @returns {string}
 */
function scoreToGrade(overall) {
  if (overall >= 4.5) return 'A';
  if (overall >= 3.5) return 'B';
  if (overall >= 2.5) return 'C';
  if (overall >= 1.5) return 'D';
  return 'F';
}

/**
 * Generate human-readable feedback from evaluation dimensions.
 * @param {object} dimensions - Evaluation dimensions with scores
 * @param {number} overall - Overall score
 * @returns {string}
 */
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

/**
 * Identify dimensions with below-threshold performance.
 * @param {object[]} evaluations - Evaluation records
 * @param {number} threshold - Score threshold
 * @returns {object[]}
 */
function findWeakDimensions(evaluations, threshold) {
  const dimSums = {};
  const dimCounts = {};

  for (const ev of evaluations) {
    // Dimensions are optional: a record only carries the ones that had a signal.
    for (const [dim, data] of Object.entries(ev.dimensions ?? {})) {
      if (typeof data?.score !== 'number') continue;
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

/**
 * Identify task types with below-threshold performance.
 * @param {object[]} evaluations - Evaluation records
 * @param {number} threshold - Score threshold
 * @returns {object[]}
 */
function findWeakTaskTypes(evaluations, threshold) {
  const typeSums = {};
  const typeCounts = {};

  for (const ev of evaluations) {
    if (typeof ev.overall !== 'number') continue; // unmeasured: no verdict to average
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

/**
 * Calculate average score for a dimension across evaluations.
 * @param {object[]} evaluations - Evaluation records
 * @param {string} dim - Dimension name
 * @returns {number}
 */
function avgDimScore(evaluations, dim) {
  if (evaluations.length === 0) return 0;
  let sum = 0;
  let count = 0;
  for (const ev of evaluations) {
    const score = ev.dimensions?.[dim]?.score;
    if (typeof score !== 'number') continue;
    sum += score;
    count += 1;
  }
  return count > 0 ? sum / count : 0;
}

/**
 * Determine trend direction from evaluation history.
 * @param {object[]} evaluations - Evaluation records
 * @returns {string}
 */
function computeTrend(evaluations) {
  const scored = evaluations.filter(e => typeof e.overall === 'number');
  if (scored.length < 4) return 'insufficient_data';
  const half = Math.floor(scored.length / 2);
  const firstAvg = scored.slice(0, half).reduce((s, e) => s + e.overall, 0) / half;
  const secondAvg = scored.slice(half).reduce((s, e) => s + e.overall, 0) / (scored.length - half);
  if (secondAvg > firstAvg + 0.3) return 'improving';
  if (secondAvg < firstAvg - 0.3) return 'declining';
  return 'stable';
}

/**
 * Build actionable improvement suggestions from analysis.
 * @param {object[]} weakDimensions - Weak evaluation dimensions
 * @param {object[]} weakTaskTypes - Weak task types
 * @param {string} trend - Overall trend direction
 * @returns {string[]}
 */
function buildSuggestions(weakDimensions, weakTaskTypes, trend) {
  const suggestions = [];

  for (const dim of weakDimensions) {
    const advice = {
      // Keyed on what the dimension measures. `executionReliability` counts
      // failed tool calls, so advising "more test coverage" (the old `accuracy`
      // text) would point at the wrong thing entirely.
      executionReliability: 'Tool calls are failing often. Check paths before acting on them and prefer absolute paths in agent threads.',
      accuracy: 'Increase test coverage and add validation checks before completing tasks.', // rubric v1 rows
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
