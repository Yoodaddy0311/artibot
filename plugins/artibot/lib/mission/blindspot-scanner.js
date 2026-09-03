/**
 * Blindspot scanner — produces the 3-class `findings` split of design 03/09.
 *
 *   mission_blockers      the mission cannot complete until this is resolved
 *   bounded_blindspots    close, small, clearly-improving, all 6 conditions met
 *   future_opportunities  recorded, must not silently become a large refactor
 *
 * THIS MODULE NEVER FIXES ANYTHING. It classifies and reports.
 *
 * Design 09 says a bounded blindspot "may be fixed autonomously" when all six
 * conditions hold. `commands/blindspot.md` says the opposite in the shipped
 * product ("recommend-only"). That conflict is open decision **A1** and Phase 0
 * is explicitly out of scope for it, so every report this module returns
 * carries `autoFix: {allowed: false, blockedBy: 'A1'}`. Computing the six
 * conditions is still worth doing — it is what makes the decision measurable —
 * but the classification is a recommendation and nothing here authorizes an
 * edit.
 *
 * PURITY (design §1-8, L2): no clock, no filesystem, no randomness, no I/O.
 *
 * WHAT THIS SCANNER CANNOT SEE
 * ----------------------------
 *  - It does not scan anything. It receives candidate findings the caller has
 *    already gathered, so an issue nobody collected is invisible.
 *  - The six conditions are caller assertions, not measurements. `small: true`
 *    is believed; nothing here counts lines or runs a test.
 *  - Unset conditions are treated as NOT met (fail-closed): silence never
 *    promotes a finding into `bounded_blindspots`.
 *
 * @module lib/mission/blindspot-scanner
 */

import { FINDING_CLASSES } from './contract.js';

/**
 * The six gate conditions of design 09. All must hold for a candidate to be a
 * bounded blindspot. Kept as an ordered allowlist so a future condition is
 * added HERE (and fails closed for existing callers) rather than by extending a
 * denial list, which would fail open.
 */
export const BOUNDED_CONDITIONS = Object.freeze([
  'causal',
  'small',
  'reversible',
  'intentClear',
  'noNewProductDecision',
  'verifiable',
]);

/** Re-exported so consumers need one import for the class vocabulary. */
export { FINDING_CLASSES };

function evaluateConditions(candidate) {
  const met = [];
  const unmet = [];
  for (const key of BOUNDED_CONDITIONS) {
    // Fail-closed: only an explicit `true` counts. undefined/null/'yes' do not.
    if (candidate?.[key] === true) met.push(key);
    else unmet.push(key);
  }
  return { met, unmet, allMet: unmet.length === 0 };
}

/**
 * Classify one candidate finding.
 *
 * @param {object} candidate
 * @param {string} candidate.subject - What the finding is about.
 * @param {boolean} [candidate.blocksMission] - Mission cannot complete without it.
 * @param {boolean} [candidate.causal]
 * @param {boolean} [candidate.small]
 * @param {boolean} [candidate.reversible]
 * @param {boolean} [candidate.intentClear]
 * @param {boolean} [candidate.noNewProductDecision]
 * @param {boolean} [candidate.verifiable]
 * @returns {{class: string, subject: string, reason: string,
 *   conditions: {met: string[], unmet: string[], allMet: boolean}}}
 */
export function classifyBlindspot(candidate) {
  const subject = typeof candidate?.subject === 'string' ? candidate.subject : '';
  const conditions = evaluateConditions(candidate);

  // A blocker outranks the six conditions: if the mission cannot complete
  // without it, its size and reversibility do not change what it is.
  if (candidate?.blocksMission === true) {
    return {
      class: 'mission_blockers',
      subject,
      conditions,
      reason: 'blocks mission completion',
    };
  }

  if (conditions.allMet) {
    return {
      class: 'bounded_blindspots',
      subject,
      conditions,
      reason: 'all 6 conditions asserted (design 09)',
    };
  }

  return {
    class: 'future_opportunities',
    subject,
    conditions,
    reason: `unmet condition(s): ${conditions.unmet.join(', ')}`,
  };
}

/**
 * Scan a candidate list into the 3-class `findings` object.
 *
 * @param {object} input
 * @param {object[]} [input.candidates]
 * @param {object} [input.contract] - Present contract; reporting only, unchanged.
 * @returns {{
 *   findings: {mission_blockers: string[], bounded_blindspots: string[], future_opportunities: string[]},
 *   classified: object[],
 *   autoFix: {allowed: false, blockedBy: 'A1', reason: string}
 * }}
 */
export function scanBlindspots(input = {}) {
  const candidates = Array.isArray(input.candidates) ? input.candidates : [];
  const classified = candidates.map((c) => classifyBlindspot(c));

  const findings = {
    mission_blockers: [],
    bounded_blindspots: [],
    future_opportunities: [],
  };
  for (const item of classified) findings[item.class].push(item.subject);

  return {
    findings,
    classified,
    autoFix: {
      allowed: false,
      blockedBy: 'A1',
      reason: 'design 09 permits auto-fix of bounded blindspots; commands/blindspot.md'
        + ' forbids it. Decision A1 is open and Phase 0 excludes it, so this scanner'
        + ' reports only.',
    },
  };
}
