/**
 * GRPO-RLVR routing helpers — kept in a sibling module so `router.js` stays
 * under the 800-line quality gate. Implements the blending and exploration
 * steps described in `_design/grpo-rlvr-routing-2026-04-24.md` §5.2 + §5.3.
 *
 * All exports are pure, synchronous, and side-effect free except for the
 * single `Math.random()` call inside {@link applyExploration}, which is
 * explicitly disabled under NODE_ENV=test to keep routing deterministic.
 *
 * @module lib/cognitive/grpo-routing
 */

/**
 * Heuristic-vs-GRPO blending constants (see design §5.3).
 * Callers may override these per call via the `alpha` parameter, but these
 * defaults match the v3.4 initial rollout choice of "heuristic dominates".
 */
export const DEFAULT_BLEND_ALPHA = 0.7;
/** Lower clamp for alpha — never let heuristic weight fall below this. */
export const ALPHA_FLOOR = 0.3;
/** Upper clamp for alpha — never let heuristic weight exceed this. */
export const ALPHA_CEIL = 1.0;

/** Default epsilon for epsilon-greedy probe (see design §5.2). */
export const DEFAULT_EPSILON = 0.05;
/** Long-term floor after epsilon decay. */
export const EPSILON_FLOOR = 0.01;

/**
 * Score threshold that splits System 1 from System 2 on a blended score.
 * Kept independent of the router's adaptive threshold so blending remains
 * predictable when the heuristic threshold drifts.
 */
export const BLEND_DECISION_THRESHOLD = 0.5;

/**
 * Clamp a number to the range [min, max]. Returns `min` for non-finite input.
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clamp(value, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/**
 * Linearly blend the heuristic complexity score with the GRPO-predicted
 * probability of routing to System 2.
 *
 * Formula (per design §5.3):
 *   final = alpha * heuristic + (1 - alpha) * p_s2
 *
 * When the policy has zero confidence (cold start / no data), the bias is
 * ignored and the heuristic score passes through unchanged — this is the
 * "trust heuristic until GRPO proves itself" safety property.
 *
 * @param {object} input
 * @param {number} input.heuristicScore - Score from `classifyComplexity` in [0,1].
 * @param {{ p_s2: number, confidence: number }} input.bias - From `getRoutingBias`.
 * @param {number} [input.alpha] - Heuristic weight; clamped to [ALPHA_FLOOR, ALPHA_CEIL].
 * @returns {{ finalScore: number, blended: boolean, alphaApplied: number }}
 *
 * @example
 * const { finalScore } = applyGrpoBlending({
 *   heuristicScore: 0.45,
 *   bias: { p_s2: 0.78, confidence: 0.56 },
 *   alpha: 0.7,
 * });
 * const system = finalScore > 0.5 ? 2 : 1;
 */
export function applyGrpoBlending({ heuristicScore, bias, alpha = DEFAULT_BLEND_ALPHA } = {}) {
  const h = clamp(heuristicScore, 0, 1);

  // Neutral bias / fallback path: skip blending entirely.
  if (
    !bias
    || typeof bias !== 'object'
    || typeof bias.p_s2 !== 'number'
    || !Number.isFinite(bias.p_s2)
    || typeof bias.confidence !== 'number'
    || bias.confidence <= 0
  ) {
    return { finalScore: h, blended: false, alphaApplied: 1.0 };
  }

  const alphaClamped = clamp(alpha, ALPHA_FLOOR, ALPHA_CEIL);
  const pS2 = clamp(bias.p_s2, 0, 1);
  const mixed = alphaClamped * h + (1 - alphaClamped) * pS2;
  return {
    finalScore: clamp(mixed, 0, 1),
    blended: true,
    alphaApplied: alphaClamped,
  };
}

/**
 * Return `true` when tests require deterministic routing. Test runners set
 * `NODE_ENV=test` (vitest default); Artibot's CI also sets `VITEST=true`.
 * Either signal flips exploration off.
 * @returns {boolean}
 */
export function isDeterministicEnv() {
  if (typeof process === 'undefined' || !process || !process.env) return false;
  return process.env.NODE_ENV === 'test' || process.env.VITEST === 'true';
}

/**
 * Apply an epsilon-greedy exploration probe on top of a settled routing decision.
 * With probability `epsilon`, flip the system (1 -> 2 or 2 -> 1) and flag the
 * event so the reward-capture pipeline can discount the outcome (design §5.2).
 *
 * In test environments epsilon is forced to 0 for determinism.
 *
 * @param {{ system: 1|2 }} decision - The decision from heuristic/blend step.
 * @param {number} [epsilon] - Exploration probability in [0, 1].
 * @param {() => number} [rand] - Injectable RNG for tests; defaults to `Math.random`.
 * @returns {{ system: 1|2, explored: boolean, epsilonApplied: number }}
 *
 * @example
 * const probed = applyExploration({ system: 1 }, 0.05);
 * if (probed.explored) markEpisodeAsProbe();
 */
export function applyExploration(decision, epsilon = DEFAULT_EPSILON, rand = Math.random) {
  const base = decision && (decision.system === 1 || decision.system === 2)
    ? decision.system
    : 1;

  // Test runs: force zero exploration regardless of caller-supplied epsilon.
  if (isDeterministicEnv()) {
    return { system: base, explored: false, epsilonApplied: 0 };
  }

  const eps = clamp(epsilon, 0, 1);
  if (eps <= 0) {
    return { system: base, explored: false, epsilonApplied: 0 };
  }

  const draw = typeof rand === 'function' ? rand() : Math.random();
  const rolled = typeof draw === 'number' && Number.isFinite(draw) ? draw : 1;
  if (rolled < eps) {
    return {
      system: base === 1 ? 2 : 1,
      explored: true,
      epsilonApplied: eps,
    };
  }
  return { system: base, explored: false, epsilonApplied: eps };
}

/**
 * End-to-end blend + exploration pipeline. Returns the final System 1/2
 * decision plus a metadata object (or `null` when the bias has no confidence,
 * indicating the heuristic passed through unchanged). Callers embed the meta
 * in their classification response for explainability.
 *
 * @param {object} input
 * @param {1|2} input.heuristicSystem - System chosen by heuristic alone.
 * @param {number} input.heuristicScore - Heuristic complexity in [0,1].
 * @param {{ p_s2: number, confidence: number }} input.bias - From getCachedRoutingBias.
 * @param {number} [input.alpha] - Blend alpha (heuristic weight).
 * @param {number} [input.epsilon] - Exploration probability.
 * @returns {{ system: 1|2, meta: object|null }}
 */
export function routeWithPolicy({ heuristicSystem, heuristicScore, bias, alpha, epsilon } = {}) {
  const blend = applyGrpoBlending({ heuristicScore, bias, alpha });
  if (!blend.blended) return { system: heuristicSystem, meta: null };
  const decided = blend.finalScore >= BLEND_DECISION_THRESHOLD ? 2 : 1;
  const probed = applyExploration({ system: decided }, epsilon);
  return {
    system: probed.system,
    meta: {
      p_s2: bias.p_s2,
      confidence: bias.confidence,
      blendedScore: blend.finalScore,
      alpha: blend.alphaApplied,
      explored: probed.explored,
    },
  };
}
