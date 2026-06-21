/**
 * Pattern analysis and GRPO scoring for the lifelong learning pipeline.
 * Contains experience grouping, rule-based scoring, ranking, and
 * pattern extraction logic.
 *
 * Zero dependencies. ESM only.
 * @module lib/learning/pattern-analyzer
 */

import { clamp01, round } from '../core/index.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIN_GROUP_SIZE = 2;

/**
 * GRPO weight factors for experience comparison.
 * Rule-based: no judge AI needed.
 */
const EXPERIENCE_WEIGHTS = {
  success: 0.35,
  speed: 0.25,
  errorRate: 0.25,
  resourceEfficiency: 0.15,
};

// ---------------------------------------------------------------------------
// Experience Grouping
// ---------------------------------------------------------------------------

/**
 * Group experiences by "type::category" composite key.
 * @param {import('./lifelong-learner.js').Experience[]} experiences - Array of experience objects
 * @returns {Object<string, import('./lifelong-learner.js').Experience[]>}
 */
export function groupExperiences(experiences) {
  const groups = {};
  for (const exp of experiences) {
    const key = `${exp.type}::${exp.category}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(exp);
  }
  return groups;
}

// ---------------------------------------------------------------------------
// GRPO Scoring
// ---------------------------------------------------------------------------

/**
 * GRPO rule-based ranking within a group of same-type experiences.
 * Scores each experience against deterministic rules, computes composite,
 * and ranks by relative advantage over group mean.
 *
 * @param {import('./lifelong-learner.js').Experience[]} group
 * @returns {{ entries: object[], groupMean: number, bestEntry: object | null }}
 */
export function grpoRankGroup(group) {
  const entries = group.map((exp) => {
    const scores = scoreExperience(exp);
    const composite = Object.entries(EXPERIENCE_WEIGHTS).reduce(
      (sum, [key, weight]) => sum + (scores[key] ?? 0) * weight,
      0,
    );
    return { experience: exp, scores, composite: round(composite) };
  });

  const groupMean = entries.length > 0
    ? entries.reduce((sum, e) => sum + e.composite, 0) / entries.length
    : 0;

  // Add relative advantage
  for (const entry of entries) {
    entry.relativeAdvantage = round(entry.composite - groupMean);
  }

  entries.sort((a, b) => b.composite - a.composite);

  return {
    entries,
    groupMean: round(groupMean),
    bestEntry: entries[0] ?? null,
  };
}

/**
 * Score a 'tool' type experience.
 * @param {object} data - Experience data payload
 * @param {number|null} directScore - Direct score from tool-tracker bridge (or null)
 * @returns {object}
 */
function _scoreToolExperience(data, directScore) {
  const hasAvgMs = data.avgMs !== null && data.avgMs !== undefined;
  const speedFromMs = hasAvgMs ? clamp01(1.0 / (1 + data.avgMs / 5000)) : null;

  if (directScore !== null) {
    return {
      success: clamp01(directScore),
      speed: speedFromMs ?? clamp01(0.3 + directScore * 0.4),
      errorRate: clamp01(directScore > 0.5 ? 0.8 + directScore * 0.2 : directScore),
      resourceEfficiency: 0.5,
    };
  }

  return {
    success: clamp01(data.successRate ?? 0),
    speed: speedFromMs ?? 0.5,
    errorRate: clamp01(1.0 - (data.calls > 0 ? (data.calls - (data.successes ?? 0)) / data.calls : 0)),
    resourceEfficiency: clamp01(data.calls > 0 ? Math.min(1, 10 / data.calls) : 0.5),
  };
}

/**
 * Score a 'success' type experience.
 * @param {object} data - Experience data payload
 * @returns {object}
 */
function _scoreSuccessExperience(data) {
  const hasDuration = data.duration !== null && data.duration !== undefined;
  const speedScore = hasDuration ? clamp01(1.0 / (1 + data.duration / 60000)) : 0.5;
  const testsPassScore = data.testsPass === true ? 1.0 : data.testsPass === false ? 0.3 : 0.5;

  return {
    success: 1.0,
    speed: speedScore,
    errorRate: testsPassScore,
    resourceEfficiency: clamp01(1.0 / (1 + (data.filesModified ?? 0) / 20)),
  };
}

/**
 * Score a 'team' type experience.
 * @param {object} data - Experience data payload
 * @returns {object}
 */
function _scoreTeamExperience(data) {
  const hasDuration = data.duration !== null && data.duration !== undefined;
  const speedScore = hasDuration ? clamp01(1.0 / (1 + data.duration / 120000)) : 0.5;

  return {
    success: clamp01(data.successRate ?? 0),
    speed: speedScore,
    errorRate: clamp01(data.successRate ?? 0.5),
    resourceEfficiency: clamp01(1.0 / (1 + (data.size ?? 1) / 5)),
  };
}

/**
 * Score a single experience using rule-based evaluators for each dimension.
 * Supports both structured fields (successRate, avgMs, calls) from
 * collectDailyExperiences and flat score field from tool-tracker bridge.
 * @param {import('./lifelong-learner.js').Experience} exp - Experience to score
 * @returns {object} Scores per dimension
 */
export function scoreExperience(exp) {
  const data = exp.data ?? {};

  // If data.score exists (from tool-tracker bridge), use it as primary signal.
  const directScore = typeof data.score === 'number' ? data.score : null;

  switch (exp.type) {
    case 'tool':
      return _scoreToolExperience(data, directScore);

    case 'error':
      return {
        success: 0,
        speed: 0.5,
        errorRate: 0,
        resourceEfficiency: data.recoverable ? 0.3 : 0,
      };

    case 'success':
      return _scoreSuccessExperience(data);

    case 'team':
      return _scoreTeamExperience(data);

    default:
      // For unknown types (e.g. 'agent', 'self-evaluation'), use direct score if available
      if (directScore !== null) {
        return {
          success: clamp01(directScore),
          speed: 0.5,
          errorRate: clamp01(directScore),
          resourceEfficiency: 0.5,
        };
      }
      return { success: 0.5, speed: 0.5, errorRate: 0.5, resourceEfficiency: 0.5 };
  }
}

// ---------------------------------------------------------------------------
// Pattern Extraction
// ---------------------------------------------------------------------------

/**
 * Extract an optimal pattern from ranked group entries.
 * The best-performing entry's characteristics become the pattern.
 *
 * Supports two modes:
 *   1. Variance mode: when scores vary within a group, extracts best-vs-mean pattern
 *   2. Consensus mode: when all scores are similar (low variance), extracts
 *      a "consistent usage" pattern if the group has enough samples.
 *
 * @param {string} groupKey - "type::category"
 * @param {{ entries: object[], groupMean: number, bestEntry: object | null }} ranked
 * @returns {object | null} Extracted pattern or null if insufficient signal
 */
export function extractPattern(groupKey, ranked) {
  const { bestEntry, groupMean, entries } = ranked;
  if (!bestEntry || entries.length < MIN_GROUP_SIZE) return null;

  const [type, category] = groupKey.split('::');

  // Sample-size-based statistical certainty (independent of composite score).
  // n=3 -> 0.42, n=10 -> 0.68, n=30 -> 0.82, n=132 -> 0.91.
  // Pairs with `confidence` so consumers can weight signals by sample size.
  const certainty = round(1 - 1 / Math.sqrt(entries.length));

  // Check if best outperforms the mean (variance mode)
  if (bestEntry.composite > groupMean + 0.02) {
    const topEntries = entries.filter((e) => e.composite > groupMean);
    const confidence = round(
      Math.min(1.0, (topEntries.length / entries.length) * bestEntry.composite),
    );

    return {
      key: groupKey,
      type,
      category,
      confidence,
      certainty,
      bestComposite: bestEntry.composite,
      groupMean,
      sampleSize: entries.length,
      insight: generateInsight(type, category, bestEntry, groupMean),
      bestData: bestEntry.experience.data,
      extractedAt: new Date().toISOString(),
    };
  }

  // Consensus mode: low variance but sufficient samples.
  const MIN_CONSENSUS_SAMPLES = 3;
  if (entries.length >= MIN_CONSENSUS_SAMPLES) {
    const sampleBonus = Math.min(0.3, entries.length * 0.02);
    const confidence = round(
      Math.min(1.0, groupMean + sampleBonus),
    );

    return {
      key: groupKey,
      type,
      category,
      confidence,
      certainty,
      bestComposite: bestEntry.composite,
      groupMean,
      sampleSize: entries.length,
      insight: generateConsensusInsight(type, category, entries.length, groupMean),
      bestData: bestEntry.experience.data,
      extractedAt: new Date().toISOString(),
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Insight Generation
// ---------------------------------------------------------------------------

/**
 * Generate a human-readable insight for consensus patterns (low variance groups).
 * @param {string} type - Pattern type
 * @param {string} category - Pattern category
 * @param {number} sampleSize - Number of samples in the group
 * @param {number} groupMean - Mean composite score
 * @returns {string}
 */
export function generateConsensusInsight(type, category, sampleSize, groupMean) {
  const scorePercent = round(groupMean * 100);

  switch (type) {
    case 'tool':
      return `Tool "${category}" shows consistent performance at ${scorePercent}% across ${sampleSize} uses. Reliable for its context.`;
    case 'error':
      return `Error pattern "${category}" occurs consistently (${sampleSize} occurrences). Consider automated handling.`;
    case 'success':
      return `Task type "${category}" consistently scores ${scorePercent}% across ${sampleSize} completions.`;
    case 'team':
      return `Team pattern "${category}" scores ${scorePercent}% consistently across ${sampleSize} sessions.`;
    default:
      return `Pattern "${category}" shows stable ${scorePercent}% performance across ${sampleSize} observations.`;
  }
}

/**
 * Generate a human-readable insight from pattern extraction data.
 * @param {string} type - Pattern type
 * @param {string} category - Pattern category
 * @param {object} bestEntry - Best performing entry from group
 * @param {number} groupMean - Mean score of the group
 * @returns {string}
 */
export function generateInsight(type, category, bestEntry, groupMean) {
  const advantage = round((bestEntry.composite - groupMean) * 100);

  switch (type) {
    case 'tool':
      return `Tool "${category}" performs ${advantage}% above average. ` +
        `Best success rate: ${round(bestEntry.scores.success * 100)}%.`;
    case 'error':
      return `Error pattern "${category}" detected. ` +
        `Recoverable: ${bestEntry.experience.data?.recoverable ?? 'unknown'}.`;
    case 'success':
      return `Task type "${category}" best approach scores ${advantage}% above group mean. ` +
        `Strategy: ${bestEntry.experience.data?.strategy ?? 'default'}.`;
    case 'team':
      return `Team pattern "${category}" scores ${advantage}% above average. ` +
        `Optimal size: ${bestEntry.experience.data?.size ?? 'unknown'}.`;
    default:
      return `Pattern "${category}" shows ${advantage}% advantage over group mean.`;
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

// clamp01 is a pure [0,1] math util — canonical home is lib/core (sibling of
// round). Re-exported here for backward-compatible imports from this module.
export { clamp01 };
