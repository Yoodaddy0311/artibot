/**
 * Scoring rubric — the four dimensions and how each is derived from a result.
 *
 * Split out of `self-evaluator.js` (800-line guideline). That module now owns
 * persistence, aggregation and assembly; this one owns "what does a score mean".
 *
 * Every scorer returns `null` rather than a number when its signal is absent.
 * That distinction is the point: a dimension pinned to a constant by a missing
 * input is not a low reading, and treating the two alike is what let 318
 * consecutive sessions record an identical D grade without anyone noticing.
 *
 * Ladder boundaries are calibrated against real transcript populations, with the
 * measured distributions recorded beside each ladder. Recalibrate from data, not
 * from intuition, and update the recorded distribution when you do.
 *
 * Zero runtime deps. ESM only.
 *
 * @module lib/learning/scoring
 */

/**
 * Evaluation dimensions with weights.
 *
 * `executionReliability` was called `accuracy` through rubric v1. The rename is
 * not cosmetic: the score is derived from the rate at which tool calls failed,
 * which is not a reading of whether the output was correct. A key named
 * `accuracy` invited every later reader of the raw store — dashboards, reports,
 * whoever opens the JSON — to believe a claim the number cannot support, and a
 * JSDoc caveat does not travel with the data.
 */
export const DIMENSIONS = {
  executionReliability: {
    weight: 0.35,
    description: 'Rate of failed tool calls during the work',
  },
  completeness: { weight: 0.25, description: 'Coverage of all requested aspects' },
  efficiency: { weight: 0.20, description: 'Resource usage and execution speed' },
  satisfaction: { weight: 0.20, description: 'Implicit user satisfaction signals' },
};

/**
 * Efficiency ladder over "tool calls spent per file engaged" — lower is better.
 * Read it as churn: a session that keeps re-reading and retrying the same few
 * files spends many calls per file, while one that handles a file and moves on
 * spends few.
 *
 * Why not wall-clock: measured session spans run 52–1,849 minutes, so every
 * session lands past the old `<300s` floor and the dimension would collapse to
 * a constant 1 — the same defect as the constant 3 it replaced, wearing a
 * different number. Wall-clock also counts the user being away from the
 * keyboard, which is not the agent's efficiency.
 *
 * Boundaries calibrated against the **full transcript population** — 84 sessions
 * with a usable denominator, via the real extractor, not fixtures. An earlier
 * cut of this ladder was fitted to the 7 largest sessions and put 52% of the
 * real population in a single grade; large sessions are not representative, and
 * a rubric that hands out one grade half the time is barely measuring.
 *
 * Observed quantiles per file engaged:
 *   p10 3.42 · p20 4.26 · p40 6.00 · p50 6.73 · p60 7.75 · p80 11.55 · p90 15.75
 * These rungs put each quintile boundary in a different grade, spreading the
 * population 13/8/26/26/26% instead of piling it at the top.
 *
 * Calibrated for `filesEngaged` specifically. The two denominators the extractor
 * offers are ~2.5x apart at population scale (median 6.73 engaged vs 16.74
 * modified), so **one ladder cannot serve both** — scoring `filesModified` on
 * these rungs drops 58% of sessions to the floor. The fallback in
 * {@link toolCallsPerFile} therefore trades calibration for continuity and is a
 * degraded path, not an equivalent one.
 *
 * Known blind spot: a session that legitimately churns on one hard file scores
 * the same as one that thrashed. This measures dispersion of effort across
 * files, not whether the effort was warranted.
 */
const EFFICIENCY_RATIO_LADDER = [
  { below: 5, score: 5 },
  { below: 7, score: 4 },
  { below: 10, score: 3 },
  { below: 15, score: 2 },
];

/** Score for a ratio past the last ladder rung. */
const EFFICIENCY_FLOOR_SCORE = 1;

/**
 * Reliability ladder over the observed tool-failure rate — lower is better.
 * Rungs sit on the measured quantiles of 92 sessions (p25 1.14% · p50 1.94% ·
 * p75 2.87% · p90 4.00%), which spreads the population 7/4/34/35/21%.
 */
const RELIABILITY_ERROR_LADDER = [
  { below: 0.01, score: 5 },
  { below: 0.02, score: 4 },
  { below: 0.04, score: 3 },
  { below: 0.08, score: 2 },
];

/** Score for an error rate past the last ladder rung. */
const RELIABILITY_FLOOR_SCORE = 1;

/**
 * Count files from a `filesModified` signal, accepting either the list or a
 * pre-counted number.
 * @param {string[]|number|undefined} filesModified - Modified-file signal
 * @returns {number|null} Count, or null when the signal is absent
 */
export function fileCount(filesModified) {
  if (Array.isArray(filesModified)) return filesModified.length;
  if (typeof filesModified === 'number' && Number.isFinite(filesModified)) return filesModified;
  return null;
}

/**
 * Score execution reliability on a scale of 1-5, or null when unmeasured.
 *
 * Prefers the observed tool-failure rate, which is the only correctness-adjacent
 * quantity a transcript actually contains. Measured over 92 sessions it is
 * effectively uncorrelated with the efficiency ratio (Pearson r = 0.017), so it
 * contributes new information rather than restating the churn axis under a
 * second name.
 *
 * Ladder from the observed distribution (p25 1.14% · p50 1.94% · p75 2.87% ·
 * p90 4.00%). Falls back to the boolean verdict for callers that supply one
 * instead of raw counts.
 *
 * **What this is not:** a measure of whether the output was correct. Failed tool
 * calls are a proxy for that at best — a session can execute flawlessly and
 * still produce wrong code. The dimension is named for what it measures rather
 * than for what one might wish it measured.
 *
 * @param {object} result - Task result
 * @returns {number|null} Score, or null when no signal is available
 */
export function scoreExecutionReliability(result) {
  const rate = toolErrorRate(result);
  if (rate !== null) {
    const rung = RELIABILITY_ERROR_LADDER.find(r => rate < r.below);
    return rung ? rung.score : RELIABILITY_FLOOR_SCORE;
  }
  // No verdict to read means no verdict to give. Scoring an unmeasured session
  // as a failure is how "the transcript was unreadable" got recorded as "the
  // work was bad" — indistinguishable afterwards from a real failure.
  if (result.success === undefined && result.testsPass === undefined) return null;
  let score = result.success ? 4 : 1;
  if (result.testsPass === true) score = Math.min(5, score + 1);
  if (result.testsPass === false) score = Math.max(1, score - 1);
  return score;
}

/**
 * Observed tool-failure rate, or null when the counts are absent.
 * @param {object} result - Task result
 * @returns {number|null}
 */
function toolErrorRate(result) {
  const { toolCalls, toolErrors } = result;
  if (typeof toolCalls !== 'number' || !Number.isFinite(toolCalls) || toolCalls <= 0) return null;
  if (typeof toolErrors !== 'number' || !Number.isFinite(toolErrors) || toolErrors < 0) return null;
  return toolErrors / toolCalls;
}

/**
 * Score result completeness on a scale of 1-5, or null when unmeasured.
 *
 * Requires an explicit requirements-coverage signal. It previously fell back to
 * `3 + success + hasFiles`, which produced 4.5 for 86% of sessions — that is not
 * a measurement of coverage, it is `success` wearing a third name, and it was
 * carrying 0.25 of the composite weight while doing so.
 *
 * @param {object} task - Task metadata
 * @param {object} result - Task result
 * @returns {number|null} Score, or null when no coverage signal exists
 */
export function scoreCompleteness(task, result) {
  const covered = result.metrics?.requirementsCovered;
  if (typeof covered !== 'number' || !Number.isFinite(covered)) return null;
  return Math.min(5, Math.max(1, Math.round((1 + 4 * covered) * 10) / 10));
}

/**
 * Tool calls spent per file produced.
 * @param {object} result - Task result
 * @returns {number|null} Ratio, or null when either side of it is missing
 */
function toolCallsPerFile(result) {
  const calls = result.toolCalls;
  if (typeof calls !== 'number' || !Number.isFinite(calls) || calls <= 0) return null;
  // Prefer files-engaged, but accept files-modified rather than abandoning the
  // ratio. Falling through to the duration axis on a missing field would put
  // every session past the `<300s` floor and rebuild the constant this
  // dimension was rescued from — a wiring omission must not resurrect it.
  //
  // The fallback is deliberately mis-calibrated: files-modified runs ~2.5x
  // higher than files-engaged, so these rungs score it harshly. A pessimistic
  // varying score beats a flattering constant one, but it is a limp, not a
  // second supported mode.
  const files = fileCount(result.filesEngaged) ?? fileCount(result.filesModified);
  // A session that engaged no files has no denominator. That is missing
  // information, not infinite inefficiency, so it must not become a score.
  //
  // What this guard does NOT cover: returning null hands the decision to the
  // duration ladder, so a zero-file session that carries a session-length
  // `duration` is scored 1 by that ladder rather than treated as unmeasured.
  // Unobserved in practice (7/7 measured sessions had files > 0), so it is left
  // alone deliberately — but it is a real path, not an impossible one.
  if (files === null || files <= 0) return null;
  return calls / files;
}

/**
 * Score result efficiency on a scale of 1-5.
 *
 * Prefers the rubric v2 ratio axis (see {@link EFFICIENCY_RATIO_LADDER}) and
 * falls back to the rubric v1 duration ladder for single-task callers that
 * carry a `duration` but no tool-call signal. Absent both, returns the neutral
 * score rather than inventing a verdict.
 *
 * @param {object} result - Task result
 * @returns {number}
 */
export function scoreEfficiency(result) {
  const ratio = toolCallsPerFile(result);
  if (ratio !== null) {
    const rung = EFFICIENCY_RATIO_LADDER.find(r => ratio < r.below);
    return rung ? rung.score : EFFICIENCY_FLOOR_SCORE;
  }
  if (result.duration === undefined) return null;
  // rubric v1: faster is better — <30s = 5, <60s = 4, <120s = 3, <300s = 2, else 1
  if (result.duration < 30000) return 5;
  if (result.duration < 60000) return 4;
  if (result.duration < 120000) return 3;
  if (result.duration < 300000) return 2;
  return 1;
}

/**
 * Score result user satisfaction on a scale of 1-5.
 * @param {object} result - Task result
 * @returns {number}
 */
export function scoreSatisfaction(result) {
  // Requires an actual satisfaction signal. Deriving it from `success` gave 98%
  // of sessions the same 4 — a number that looks like a reading of how the user
  // felt while being nothing of the kind. Nobody in this repo writes these
  // fields yet, so in practice this dimension reports "unmeasured", which is
  // the truth.
  const { userFeedback, revisionRequested } = result.metrics ?? {};
  if (userFeedback === undefined && revisionRequested === undefined) return null;
  let score = result.success === false ? 2 : 4;
  if (userFeedback === 'positive') score = 5;
  if (userFeedback === 'negative') score = 1;
  if (revisionRequested) score = Math.max(1, score - 1);
  return score;
}
