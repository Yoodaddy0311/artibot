/**
 * GRPO-RLVR Reward Capture (Phase A).
 *
 * Pure, deterministic reward extractor for Artibot Episodic records. Implements
 * the contract defined in `plugins/artibot/_design/grpo-rlvr-routing-2026-04-24.md`
 * Section 6.1. Given a finalised {@link EpisodeRecord} this module produces a
 * bounded scalar reward in `[-1.5, +1.2]` plus a component breakdown suitable
 * for auditing and nightly GRPO policy updates.
 *
 * All computation is synchronous and free of IO — the module is safe to call
 * from hot paths (e.g. episodic.appendEpisode). Schema validation is defensive:
 * malformed inputs yield `reward = 0` with a `rewardComponents.invalid` flag
 * rather than throwing, so a corrupt upstream signal never blocks memory writes.
 *
 * Zero external deps. ESM only.
 *
 * ---------------------------------------------------------------------------
 * WIRING NOTE (2026-05-30). The pure extractor `computeReward` /
 * `computeRewardComponents` IS live — it is called synchronously from
 * `lib/learning/memory/episodic.js` to stamp a reward onto each episode. What
 * is DORMANT BY DESIGN is the downstream *reward emitter* in the sibling
 * module {@link module:lib/learning/grpo/reward-metrics} (recordReward →
 * `runtime/reward-metrics.json`), which currently has no production caller.
 * That dormancy is intentional, not a deprecation: GRPO (policy learning) and
 * Dreaming (memory consolidation) are separate, coexisting systems. Preserve
 * the GRPO name, structure, exports and signatures as-is — do not delete or
 * prune. See reward-metrics.js header + docs/WIRING-AUDIT-2026-05-30.md.
 * ---------------------------------------------------------------------------
 *
 * @module lib/learning/grpo/reward-capture
 */

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

/**
 * Hard clipping bounds applied to every reward before return. Mirrors
 * design §3.2 "Reward is clipped to [-1.5, +1.2] before GRPO advantage
 * normalization".
 * @type {Readonly<{min: number, max: number}>}
 */
export const REWARD_CLIP = Object.freeze({ min: -1.5, max: 1.2 });

/**
 * Frozen component weights — tuned against design §3.1 table. Kept as a
 * sibling export so policy-updater and metrics consumers can audit without
 * duplicating the numbers. All entries are dimensionless multipliers applied
 * inside {@link computeRewardComponents}.
 * @type {Readonly<{
 *   toolSuccessPerCall: number, toolSuccessCap: number,
 *   errorPerCount: number, errorCap: number,
 *   testPass: number,
 *   typecheck: number,
 *   correctionPerCount: number, correctionCap: number,
 *   promotedBonus: number,
 *   demotedPenalty: number,
 *   importanceFloor: number, importanceSlope: number
 * }>}
 */
export const REWARD_WEIGHTS = Object.freeze({
  toolSuccessPerCall: 0.1,
  toolSuccessCap: 0.4,
  errorPerCount: 0.3,
  errorCap: 0.9,
  testPass: 0.5,
  typecheck: 0.2,
  correctionPerCount: 0.4,
  correctionCap: 0.8,
  promotedBonus: 0.2,
  demotedPenalty: 0.3,
  importanceFloor: 0.5,
  importanceSlope: 0.5,
  // 7th dimension — claude-md-auditor surface. Bounded to ±0.05 so it
  // never dominates verifiable signals; fed by the audit cache that the
  // nightly session rollup picks up. See SKILL.md claude-md-auditor.
  claudeMdQualityMax: 0.05,
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} EpisodeRewardInput
 * @property {Array<{exitCode?: number|null}>} [toolCalls]
 * @property {number} [errors]
 * @property {number} [testPassRatio] - in [0,1]; absent means "no tests in task"
 * @property {boolean} [typecheckClean]
 * @property {number} [userCorrections]
 * @property {number} [importanceScore] - in [0,1]; default 0.5
 * @property {boolean} [promoted]
 * @property {boolean} [demoted]
 * @property {boolean} [timedOut]
 * @property {number|null} [claudeMdQuality] - 0..100 audit score; null = no audit ran this window
 */

/**
 * @typedef {Object} RewardComponents
 * @property {number} toolSuccess - positive contribution from successful tool calls
 * @property {number} errors - negative contribution from error count
 * @property {number} tests - contribution from testPassRatio
 * @property {number} typecheck - contribution from typecheckClean
 * @property {number} corrections - negative contribution from userCorrections
 * @property {number} promoted - bonus for semantic promotion
 * @property {number} demoted - penalty for semantic demotion
 * @property {number} claudeMdQuality - contribution from CLAUDE.md audit score (≤ ±0.05)
 * @property {number} importanceModulator - scale factor applied before clipping
 * @property {number} preClip - reward before REWARD_CLIP applied
 * @property {boolean} timedOut - true when episode was forcibly zeroed
 * @property {boolean} invalid - true when validation rejected the record
 */

/**
 * @typedef {Object} RewardResult
 * @property {number} reward - final clipped reward in [-1.5, +1.2]
 * @property {RewardComponents} rewardComponents
 */

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function clamp01(n, fallback) {
  if (!Number.isFinite(n)) return fallback;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function nonNegativeInt(n) {
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

/**
 * Best-effort schema guard. Returns `{ ok: true, episode }` with coerced
 * fields on success, `{ ok: false, reason }` on malformed input.
 *
 * @param {unknown} episode
 * @returns {{ok: true, episode: Required<EpisodeRewardInput>} | {ok: false, reason: string}}
 */
export function validateEpisodeForReward(episode) {
  if (episode === null || episode === undefined || typeof episode !== 'object') {
    return { ok: false, reason: 'not-an-object' };
  }
  const toolCalls = Array.isArray(episode.toolCalls) ? episode.toolCalls : [];
  const errors = nonNegativeInt(episode.errors);
  const userCorrections = nonNegativeInt(episode.userCorrections);
  const importanceScore = clamp01(episode.importanceScore, 0.5);

  let testPassRatio;
  if (episode.testPassRatio !== undefined && episode.testPassRatio !== null) {
    if (!Number.isFinite(episode.testPassRatio)) {
      return { ok: false, reason: 'testPassRatio-NaN' };
    }
    testPassRatio = clamp01(episode.testPassRatio, 0);
  }

  let claudeMdQuality = null;
  if (episode.claudeMdQuality !== undefined && episode.claudeMdQuality !== null) {
    const n = Number(episode.claudeMdQuality);
    if (Number.isFinite(n)) {
      claudeMdQuality = Math.max(0, Math.min(100, n));
    }
  }

  return {
    ok: true,
    episode: {
      toolCalls,
      errors,
      testPassRatio,
      typecheckClean: Boolean(episode.typecheckClean),
      userCorrections,
      importanceScore,
      promoted: Boolean(episode.promoted),
      demoted: Boolean(episode.demoted),
      timedOut: Boolean(episode.timedOut),
      claudeMdQuality,
    },
  };
}

// ---------------------------------------------------------------------------
// Internal component extractors (each < 50 lines)
// ---------------------------------------------------------------------------

function extractToolSuccess(toolCalls) {
  const successful = toolCalls.reduce((n, t) => {
    if (t && t.exitCode === 0) return n + 1;
    return n;
  }, 0);
  const raw = successful * REWARD_WEIGHTS.toolSuccessPerCall;
  return Math.min(REWARD_WEIGHTS.toolSuccessCap, raw);
}

function extractErrorPenalty(errors) {
  const raw = errors * REWARD_WEIGHTS.errorPerCount;
  return -Math.min(REWARD_WEIGHTS.errorCap, raw);
}

function extractTestReward(testPassRatio) {
  if (typeof testPassRatio !== 'number') return 0;
  return REWARD_WEIGHTS.testPass * testPassRatio;
}

function extractTypecheck(typecheckClean) {
  return typecheckClean ? REWARD_WEIGHTS.typecheck : 0;
}

function extractCorrectionPenalty(userCorrections) {
  const raw = userCorrections * REWARD_WEIGHTS.correctionPerCount;
  return -Math.min(REWARD_WEIGHTS.correctionCap, raw);
}

function extractPromotion(promoted, demoted) {
  let delta = 0;
  if (promoted) delta += REWARD_WEIGHTS.promotedBonus;
  if (demoted) delta -= REWARD_WEIGHTS.demotedPenalty;
  return delta;
}

function importanceModulator(importanceScore) {
  return REWARD_WEIGHTS.importanceFloor + importanceScore * REWARD_WEIGHTS.importanceSlope;
}

function extractClaudeMdReward(score) {
  if (score === null || score === undefined || !Number.isFinite(score)) return 0;
  // Linear about the 50-point neutral: [0, 100] -> [-max, +max].
  const max = REWARD_WEIGHTS.claudeMdQualityMax;
  const norm = (score - 50) / 50;
  if (norm > 1) return max;
  if (norm < -1) return -max;
  return max * norm;
}

function clipReward(value) {
  if (!Number.isFinite(value)) return 0;
  if (value < REWARD_CLIP.min) return REWARD_CLIP.min;
  if (value > REWARD_CLIP.max) return REWARD_CLIP.max;
  return value;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Produce the reward + component breakdown for an episode.
 *
 * @param {EpisodeRewardInput|unknown} episode
 * @returns {RewardResult}
 */
export function computeRewardComponents(episode) {
  const guard = validateEpisodeForReward(episode);
  if (!guard.ok) {
    return {
      reward: 0,
      rewardComponents: {
        toolSuccess: 0,
        errors: 0,
        tests: 0,
        typecheck: 0,
        corrections: 0,
        promoted: 0,
        demoted: 0,
        claudeMdQuality: 0,
        importanceModulator: 1,
        preClip: 0,
        timedOut: false,
        invalid: true,
      },
    };
  }
  const e = guard.episode;

  if (e.timedOut) {
    return {
      reward: 0,
      rewardComponents: {
        toolSuccess: 0,
        errors: 0,
        tests: 0,
        typecheck: 0,
        corrections: 0,
        promoted: 0,
        demoted: 0,
        claudeMdQuality: 0,
        importanceModulator: importanceModulator(e.importanceScore),
        preClip: 0,
        timedOut: true,
        invalid: false,
      },
    };
  }

  const toolSuccess = extractToolSuccess(e.toolCalls);
  const errorPenalty = extractErrorPenalty(e.errors);
  const tests = extractTestReward(e.testPassRatio);
  const typecheck = extractTypecheck(e.typecheckClean);
  const corrections = extractCorrectionPenalty(e.userCorrections);
  const promo = extractPromotion(e.promoted, e.demoted);
  const claudeMd = extractClaudeMdReward(e.claudeMdQuality);
  const modulator = importanceModulator(e.importanceScore);

  const base = toolSuccess + errorPenalty + tests + typecheck + corrections;
  // Modulator scales the verifiable-outcome portion. Promotion/demotion
  // bonuses and the CLAUDE.md audit signal are long-term, orthogonal —
  // layered on top, not modulated.
  const preClip = base * modulator + promo + claudeMd;

  return {
    reward: clipReward(preClip),
    rewardComponents: {
      toolSuccess,
      errors: errorPenalty,
      tests,
      typecheck,
      corrections,
      promoted: e.promoted ? REWARD_WEIGHTS.promotedBonus : 0,
      demoted: e.demoted ? -REWARD_WEIGHTS.demotedPenalty : 0,
      claudeMdQuality: claudeMd,
      importanceModulator: modulator,
      preClip,
      timedOut: false,
      invalid: false,
    },
  };
}

/**
 * Main export — returns just the reward + components. Thin wrapper around
 * {@link computeRewardComponents} to match design §6.1 signature.
 *
 * @param {EpisodeRewardInput|unknown} episode
 * @returns {RewardResult}
 */
export function computeReward(episode) {
  return computeRewardComponents(episode);
}
