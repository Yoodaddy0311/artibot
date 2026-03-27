/**
 * Evaluator Calibration module.
 * Accumulates human feedback as few-shot examples and suggests
 * GRPO weight adjustments to reduce AI/human scoring divergence.
 *
 * Source: Anthropic Harness Design blog — progressive calibration pattern.
 *
 * @module lib/learning/eval-calibrator
 */

import { emit } from '../core/event-bus.js';

// ---------------------------------------------------------------------------
// Default dimension set (mirrors self-evaluator.js DIMENSIONS)
// ---------------------------------------------------------------------------

const DEFAULT_DIMENSIONS = Object.freeze({
  accuracy: { weight: 0.35 },
  completeness: { weight: 0.25 },
  efficiency: { weight: 0.20 },
  satisfaction: { weight: 0.20 },
});

// ---------------------------------------------------------------------------
// Helpers (pure)
// ---------------------------------------------------------------------------

/**
 * Build an override entry from human feedback.
 *
 * @param {string} evalId
 * @param {number} humanScore
 * @param {number} aiScore
 * @param {object} [context]
 * @param {object} [options]
 * @returns {object}
 */
function buildOverride(evalId, humanScore, aiScore, context, options = {}) {
  const now = options.now || (() => new Date().toISOString());
  return Object.freeze({
    evalId: String(evalId),
    humanScore: Number(humanScore),
    aiScore: Number(aiScore),
    delta: Math.round((Number(humanScore) - Number(aiScore)) * 100) / 100,
    context: context ? Object.freeze({ ...context }) : null,
    timestamp: now(),
  });
}

/**
 * Compute mean delta for a given dimension across overrides that have
 * per-dimension breakdowns in their context.
 *
 * @param {object[]} overrides
 * @param {string} dimension
 * @returns {{ count: number, meanDelta: number }}
 */
function dimensionStats(overrides, dimension) {
  const relevant = overrides.filter(
    (o) => o.context?.dimensions?.[dimension] !== null && o.context?.dimensions?.[dimension] !== undefined,
  );

  if (relevant.length === 0) {
    return { count: 0, meanDelta: 0 };
  }

  const sum = relevant.reduce((acc, o) => {
    const humanDim = o.context.dimensions[dimension].humanScore ?? o.humanScore;
    const aiDim = o.context.dimensions[dimension].aiScore ?? o.aiScore;
    return acc + (humanDim - aiDim);
  }, 0);

  return {
    count: relevant.length,
    meanDelta: Math.round((sum / relevant.length) * 100) / 100,
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an eval calibrator instance.
 *
 * @param {object} [config]
 * @param {number} [config.maxExamples=50] - Maximum stored overrides (FIFO)
 * @param {Record<string, { weight: number }>} [config.dimensions] - Dimension definitions
 * @param {() => string} [config.now] - Clock injection
 * @returns {object}
 */
export function createEvalCalibrator(config = {}) {
  const maxExamples = config.maxExamples ?? 50;
  const dimensions = config.dimensions || DEFAULT_DIMENSIONS;
  const nowFn = config.now || (() => new Date().toISOString());

  /** @type {object[]} */
  let overrides = [];

  return {
    /**
     * Record a human override of an AI evaluation score.
     *
     * @param {string} evalId
     * @param {number} humanScore - Human-assigned score [0, 1]
     * @param {number} aiScore - AI-assigned score [0, 1]
     * @param {object} [context] - Additional context (task type, dimensions, etc.)
     * @returns {object} The recorded override
     */
    recordHumanOverride(evalId, humanScore, aiScore, context) {
      if (!evalId) {
        throw new Error('evalId is required');
      }
      if (typeof humanScore !== 'number' || typeof aiScore !== 'number') {
        throw new Error('humanScore and aiScore must be numbers');
      }

      const entry = buildOverride(evalId, humanScore, aiScore, context, { now: nowFn });

      // FIFO: drop oldest when at capacity
      const next = overrides.length >= maxExamples
        ? [...overrides.slice(1), entry]
        : [...overrides, entry];
      overrides = next;

      emit('feature:eval-calibration', {
        action: 'override-recorded',
        evalId,
        delta: entry.delta,
      });

      return entry;
    },

    /**
     * Generate few-shot examples for self-evaluator calibration.
     * Returns overrides with largest absolute delta first.
     *
     * @param {number} [count=5]
     * @returns {object[]}
     */
    generateFewShotExamples(count = 5) {
      const sorted = [...overrides].sort(
        (a, b) => Math.abs(b.delta) - Math.abs(a.delta),
      );
      return sorted.slice(0, count).map((o) => Object.freeze({ ...o }));
    },

    /**
     * Suggest weight adjustments for evaluation dimensions based on
     * systematic human feedback divergence.
     *
     * @returns {{ suggestions: Array<{ dimension: string, currentWeight: number, suggestedWeight: number, direction: string, confidence: number }>, overrideCount: number }}
     */
    suggestWeightAdjustment() {
      const suggestions = [];

      for (const [name, dim] of Object.entries(dimensions)) {
        const stats = dimensionStats(overrides, name);

        if (stats.count < 3) continue;

        const absDelta = Math.abs(stats.meanDelta);
        if (absDelta < 0.05) continue;

        const direction = stats.meanDelta > 0 ? 'increase' : 'decrease';
        const adjustment = Math.min(absDelta * 0.5, 0.1);
        const suggestedWeight = direction === 'increase'
          ? Math.min(dim.weight + adjustment, 0.6)
          : Math.max(dim.weight - adjustment, 0.05);

        suggestions.push(Object.freeze({
          dimension: name,
          currentWeight: dim.weight,
          suggestedWeight: Math.round(suggestedWeight * 100) / 100,
          direction,
          meanDelta: stats.meanDelta,
          confidence: Math.min(stats.count / 10, 1),
        }));
      }

      const result = Object.freeze({
        suggestions: Object.freeze(suggestions),
        overrideCount: overrides.length,
      });

      if (suggestions.length > 0) {
        emit('feature:eval-calibration', {
          action: 'weight-adjustment-suggested',
          count: suggestions.length,
        });
      }

      return result;
    },

    /**
     * Get calibration statistics.
     *
     * @returns {{ totalOverrides: number, maxExamples: number, avgDelta: number, avgAbsDelta: number, dimensionCount: number }}
     */
    getCalibrationStats() {
      const totalOverrides = overrides.length;
      const avgDelta = totalOverrides > 0
        ? Math.round((overrides.reduce((s, o) => s + o.delta, 0) / totalOverrides) * 100) / 100
        : 0;
      const avgAbsDelta = totalOverrides > 0
        ? Math.round((overrides.reduce((s, o) => s + Math.abs(o.delta), 0) / totalOverrides) * 100) / 100
        : 0;

      return Object.freeze({
        totalOverrides,
        maxExamples,
        avgDelta,
        avgAbsDelta,
        dimensionCount: Object.keys(dimensions).length,
      });
    },

    /**
     * Get all stored overrides (read-only copy).
     * @returns {object[]}
     */
    getOverrides() {
      return overrides.map((o) => Object.freeze({ ...o }));
    },

    /**
     * Reset all stored overrides.
     */
    reset() {
      overrides = [];
    },
  };
}

// ---------------------------------------------------------------------------
// Exports for testing
// ---------------------------------------------------------------------------

export {
  DEFAULT_DIMENSIONS,
  buildOverride as _buildOverride,
  dimensionStats as _dimensionStats,
};
