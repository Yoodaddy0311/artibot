/**
 * GRPO → Cognitive bridge.
 *
 * Exposes GRPO-learned task/team strategy weights as lightweight bias hints
 * for System 1/2 decisions, orchestrator agent selection, and planner
 * strategy picks. All functions are safe no-ops when GRPO history is empty
 * (fresh install or before the daily pipeline has run), so callers can
 * multiply/consume their results without branching.
 *
 * @module lib/cognitive/grpo-bridge
 */

import { getGrpoStats, getRecommendation } from '../learning/grpo-optimizer.js';

/**
 * Neutral bias returned when GRPO has no data or a read fails. Multiplying
 * a confidence by 1.0 preserves the caller's existing behavior.
 */
export const NEUTRAL_BIAS = 1.0;

/** Clamp range to prevent any single GRPO weight from dominating cognition. */
const BIAS_MIN = 0.5;
const BIAS_MAX = 1.5;

/**
 * Clamp a value to [min, max].
 * @param {number} v
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

/**
 * Get a bias multiplier for a strategy label from GRPO-learned weights.
 * Returns {@link NEUTRAL_BIAS} when the strategy is unknown or when the
 * history cannot be read. Callers multiply their existing confidence by
 * the returned value.
 *
 * @param {string} strategy - Strategy label (e.g. `'Bash'`, `'balanced'`, `'fix'`).
 * @returns {Promise<number>} bias in [BIAS_MIN, BIAS_MAX]
 *
 * @example
 * const bias = await getStrategyBias('Bash');
 * const adjustedConfidence = baseConfidence * bias;
 */
export async function getStrategyBias(strategy) {
  if (!strategy || typeof strategy !== 'string') return NEUTRAL_BIAS;
  try {
    const stats = await getGrpoStats({ lookback: 50 });
    const weight = stats?.weights?.[strategy];
    if (typeof weight !== 'number' || !Number.isFinite(weight)) return NEUTRAL_BIAS;
    return clamp(weight, BIAS_MIN, BIAS_MAX);
  } catch {
    return NEUTRAL_BIAS;
  }
}

/**
 * Get the top-ranked strategy from GRPO history with safe fallback.
 * @param {object} [context] - Forwarded to grpo-optimizer.getRecommendation.
 * @returns {Promise<{ recommendation: string|null, weight: number, alternatives: object[] }>}
 *
 * @example
 * const { recommendation } = await getTopStrategy();
 * if (recommendation) useStrategy(recommendation);
 */
export async function getTopStrategy(context = {}) {
  try {
    const rec = await getRecommendation('task', context);
    return {
      recommendation: rec?.recommendation ?? null,
      weight: typeof rec?.weight === 'number' ? rec.weight : NEUTRAL_BIAS,
      alternatives: Array.isArray(rec?.alternatives) ? rec.alternatives : [],
    };
  } catch {
    return { recommendation: null, weight: NEUTRAL_BIAS, alternatives: [] };
  }
}

/**
 * Get the top-ranked team composition for a domain.
 * @param {string} [domain='general']
 * @returns {Promise<{ recommendation: string|null, weight: number, alternatives: object[] }>}
 */
export async function getTopTeam(domain = 'general') {
  try {
    const rec = await getRecommendation('team', { domain });
    return {
      recommendation: rec?.recommendation ?? null,
      weight: typeof rec?.weight === 'number' ? rec.weight : NEUTRAL_BIAS,
      alternatives: Array.isArray(rec?.alternatives) ? rec.alternatives : [],
    };
  } catch {
    return { recommendation: null, weight: NEUTRAL_BIAS, alternatives: [] };
  }
}

/**
 * Summary of how much learned signal is currently available. Consumers can
 * gate optional behavior on `hasData` to avoid acting on sparse history.
 * @returns {Promise<{ hasData: boolean, totalRounds: number, taskRounds: number, teamRounds: number }>}
 */
export async function getLearnedSignalSummary() {
  try {
    const stats = await getGrpoStats({ lookback: 200 });
    return {
      hasData: (stats?.totalRounds ?? 0) > 0,
      totalRounds: stats?.totalRounds ?? 0,
      taskRounds: stats?.taskRounds ?? 0,
      teamRounds: stats?.teamRounds ?? 0,
    };
  } catch {
    return { hasData: false, totalRounds: 0, taskRounds: 0, teamRounds: 0 };
  }
}
