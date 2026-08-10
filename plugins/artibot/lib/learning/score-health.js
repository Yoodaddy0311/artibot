/**
 * Degeneracy detection for the evaluation store.
 *
 * A scorer whose inputs go missing does not throw — it emits the same row
 * forever, and the store keeps growing while its information content stays at
 * zero. That happened for 318 consecutive rows over roughly two months without
 * anything surfacing. This module makes the collapse observable.
 *
 * Split out of `self-evaluator.js` to keep that file under the 800-line
 * guideline; it is re-exported from there so callers see one entry point.
 *
 * Zero runtime deps. ESM only.
 *
 * @module lib/learning/score-health
 */

import { hasAnySignal, loadEvaluations, RUBRIC_VERSION, selectByRubric } from './evaluation-store.js';
import { DIMENSIONS } from './scoring.js';

/** Rows required before {@link getScoreHealth} will call a store degenerate. */
const DEGENERATE_MIN_SAMPLES = 10;

/**
 * Distinct-signature-to-sample ratio below which a store counts as degenerate
 * even though more than one signature exists. Calibrated against the real
 * failure: 500 rows carried exactly 2 signatures (0.004), which a
 * `distinctSignatures <= 1` rule alone would have passed.
 */
const DEGENERATE_DIVERSITY_RATIO = 0.05;

/**
 * Share of samples one value may hold in a dimension before that dimension
 * counts as constant in all but name.
 *
 * A pure `distinct <= 1` test is formal compliance: measured over 92 real
 * sessions, `accuracy` and `satisfaction` each had two distinct values where the
 * rarer one appeared in **2 sessions (2.2%)**. That passed the old check while
 * carrying essentially no information. Two sessions should not be able to
 * certify a dimension as alive.
 */
const DEGENERATE_DOMINANCE_RATIO = 0.95;

/**
 * Rows a dimension must have reported in the earlier half of the window before
 * its disappearance from the later half counts as a regression rather than
 * noise.
 */
const STOPPED_REPORTING_MIN_PRIOR = 3;

/**
 * Report whether the evaluation store still carries information.
 *
 * Three independent degeneracy tests, because the real defect defeated the
 * obvious one: the full 500-row history held 2 distinct signatures, so a
 * "signatures <= 1" check passed while `efficiency` sat frozen at 3 throughout.
 * The per-dimension test is what catches that shape.
 *
 * Scoped to one rubric — old rows from a previous regime would otherwise supply
 * borrowed variety and mask a fresh collapse.
 *
 * Unlike the aggregate reports, this deliberately **keeps** rows where no signal
 * arrived. Those rows are the symptom: if the extractor breaks, every row
 * becomes the same neutral placeholder and the signature count drops to 1, which
 * is exactly the alarm wanted. Filtering them out would leave zero samples and
 * report silence at the moment the pipe failed. `unmeasured` names how many
 * there were, so a collapse can be read as "stopped measuring" rather than
 * "started failing".
 *
 * What this does not see: whether the scores are *correct*. A store can be
 * healthily varied and still be measuring the wrong thing. Variance is a
 * necessary condition for the store to be informative, not a sufficient one.
 *
 * @param {object} [options]
 * @param {number} [options.lookback=50] - Number of recent evaluations to inspect
 * @param {number} [options.rubricVersion] - Rubric to inspect (default: newest present)
 * @returns {Promise<{
 *   samples: number,
 *   distinctSignatures: number,
 *   distinctByDimension: Record<string, number>,
 *   degenerate: boolean,
 *   reason: string|null,
 *   rubricVersion: number,
 *   excludedByRubric: number,
 *   unmeasured: number
 * }>}
 */
export async function getScoreHealth(options = {}) {
  const { lookback = 50, rubricVersion } = options;
  const window = (await loadEvaluations()).slice(-lookback);
  const { version, selected, excludedByRubric } = selectByRubric(window, rubricVersion);

  const signatures = new Set();
  const countsByDimension = {};

  for (const ev of selected) {
    const entries = Object.entries(ev.dimensions ?? {})
      .sort(([a], [b]) => a.localeCompare(b));
    signatures.add(entries.map(([dim, d]) => `${dim}:${d?.score}`).join(','));
    for (const [dim, d] of entries) {
      const counts = (countsByDimension[dim] ??= new Map());
      counts.set(d?.score, (counts.get(d?.score) ?? 0) + 1);
    }
  }

  const distinctByDimension = Object.fromEntries(
    Object.entries(countsByDimension).map(([dim, counts]) => [dim, counts.size]),
  );

  const dimensionCoverage = Object.fromEntries(
    Object.entries(countsByDimension).map(([dim, counts]) => [
      dim, [...counts.values()].reduce((a, b) => a + b, 0),
    ]),
  );

  // A dimension the rubric defines but no row carries never reaches
  // `countsByDimension`, so the constant-value tests cannot see it. Half the
  // rubric could go dark and every value test would still pass. Only meaningful
  // against the current rubric — older rows answer to a different dimension set.
  const absentDimensions = version === RUBRIC_VERSION
    ? Object.keys(DIMENSIONS).filter(dim => !dimensionCoverage[dim])
    : [];

  const { degenerate, reason } = judgeDegeneracy(
    selected.length,
    signatures.size,
    countsByDimension,
    findStoppedReporting(selected),
  );

  return {
    samples: selected.length,
    distinctSignatures: signatures.size,
    distinctByDimension,
    dimensionCoverage,
    absentDimensions,
    degenerate,
    reason,
    rubricVersion: version,
    excludedByRubric,
    unmeasured: selected.filter(ev => !hasAnySignal(ev)).length,
  };
}

/**
 * Dimensions that reported in the earlier half of the window and then stopped.
 *
 * This is the distinction that keeps the alarm useful. A dimension with no
 * signal source has always been absent — reporting that as degeneracy every
 * session would train everyone to ignore the line, which is how the original
 * defect survived two months. A dimension that *was* producing scores and went
 * quiet is a different event: something broke. Only the second one is an alarm;
 * the first is reported as coverage.
 *
 * @param {object[]} rows - Rows in the inspection window, oldest first
 * @returns {string[]} Dimension names that went quiet
 */
function findStoppedReporting(rows) {
  if (rows.length < DEGENERATE_MIN_SAMPLES) return [];
  const mid = Math.floor(rows.length / 2);
  const presence = (slice) => {
    const seen = {};
    for (const ev of slice) {
      for (const dim of Object.keys(ev.dimensions ?? {})) seen[dim] = (seen[dim] ?? 0) + 1;
    }
    return seen;
  };
  const before = presence(rows.slice(0, mid));
  const after = presence(rows.slice(mid));
  return Object.entries(before)
    .filter(([dim, n]) => n >= STOPPED_REPORTING_MIN_PRIOR && !after[dim])
    .map(([dim]) => dim);
}

/**
 * Decide whether a score distribution has collapsed.
 *
 * `reason` is populated for the not-degenerate verdicts too when the verdict is
 * "cannot tell yet", so a caller can distinguish a healthy store from one that
 * has not been asked enough questions.
 *
 * @param {number} samples - Rows inspected
 * @param {number} distinctSignatures - Distinct dimension-score tuples
 * @param {Record<string, Map<number, number>>} countsByDimension - Value tallies per dimension
 * @param {string[]} stoppedReporting - Dimensions that went quiet mid-window
 * @returns {{ degenerate: boolean, reason: string|null }}
 */
function judgeDegeneracy(samples, distinctSignatures, countsByDimension, stoppedReporting = []) {
  if (samples < DEGENERATE_MIN_SAMPLES) {
    return { degenerate: false, reason: 'insufficient_samples' };
  }
  if (stoppedReporting.length > 0) {
    return {
      degenerate: true,
      reason: `dimension(s) stopped reporting mid-window: ${stoppedReporting.join(', ')}`,
    };
  }
  if (distinctSignatures <= 1) {
    return {
      degenerate: true,
      reason: `all ${samples} rows share a single dimension signature`,
    };
  }
  if (distinctSignatures / samples < DEGENERATE_DIVERSITY_RATIO) {
    return {
      degenerate: true,
      reason: `only ${distinctSignatures} distinct signatures across ${samples} rows`,
    };
  }
  const collapsed = [];
  for (const [dim, counts] of Object.entries(countsByDimension)) {
    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    // Dimensions are optional per record, so a dimension can appear in only a
    // handful of rows. Judging one of those "constant" would be the same
    // small-sample error the dominance test exists to prevent — and a dimension
    // absent from every row never reaches here at all, so absence is never
    // mistaken for constancy.
    if (total < DEGENERATE_MIN_SAMPLES) continue;
    const dominant = Math.max(...counts.values());
    if (counts.size <= 1) collapsed.push(`${dim} (constant)`);
    else if (dominant / total >= DEGENERATE_DOMINANCE_RATIO) {
      collapsed.push(`${dim} (${((dominant / total) * 100).toFixed(0)}% one value)`);
    }
  }
  if (collapsed.length > 0) {
    return {
      degenerate: true,
      reason: `constant dimension(s): ${collapsed.join(', ')}`,
    };
  }
  return { degenerate: false, reason: null };
}
