/**
 * Switch Controller — Phase 0 (Observe).
 *
 * Turns a RouteReceipt plus the two economics verdicts into ONE proposal, and
 * stops there. §0/§27 name this the Switch Controller sitting between the
 * router and the attempt; in Observe it is the half that never acts.
 *
 * THE OBSERVE INVARIANT, and the reason this module is separate from the one
 * that would apply a switch: `applied` is the literal constant `false`. No
 * input can make it true, no branch sets it, and there is no code path here
 * that changes a model, writes a ledger event, or reaches a host API. The only
 * event a routing decision produces in Phase 0 is `route.selected` (written by
 * the receipt writer, not by this file); `model.switched` is Canary-gated
 * (PRD §3) and is deliberately absent from this source.
 *
 * PROPOSAL VOCABULARY. §40 has five decision values. Two of them (`route`,
 * `pin`) describe what the ROUTER recorded and live in the receipt; the four
 * here describe what the controller would DO. A proposal is never written into
 * `receipt.decision.type` in Phase 0 — that field stays inside `{route, pin}`,
 * and a receipt arriving with anything else is reported as a contract breach
 * rather than trusted.
 *
 * TARGET TIER. The result shape is fixed at three keys, so the tier a
 * `switch`/`escalate`/`downgrade` would move to is carried as a `target:<tier>`
 * reason code rather than as a fourth key. A proposal with no `target:` code
 * names no destination, which is exactly what `hold` means.
 *
 * WHAT THIS MODULE CANNOT SEE:
 *  - Whether a proposal is any good. The gates it reads (hysteresis threshold,
 *    residency, escalation ladder) are uncalibrated heuristics; §30 says the
 *    residency numbers await RouteBench calibration that has not run.
 *  - Whether anything downstream honours a proposal. Zero live proposals exist
 *    and there is no consumer yet — a green test here proves the shape, not
 *    the behaviour of any caller.
 *  - Whether the incumbent tier it was handed is the tier actually running.
 *    `current` is caller-asserted.
 *
 * @module lib/routing/model-switcher
 */

/**
 * Every proposal this module can return, ordered least to most invasive.
 * Closed allowlist: a value outside it is a defect, not a new feature.
 * @type {readonly string[]}
 */
export const PROPOSALS = Object.freeze(['hold', 'switch', 'escalate', 'downgrade']);

/**
 * `decision.type` values a Phase 0 receipt may carry (`route-receipt.schema.json`
 * narrowed by PRD §3). Anything else means a writer got ahead of the gate.
 * @type {readonly string[]}
 */
export const OBSERVE_DECISIONS = Object.freeze(['route', 'pin']);

/** Emitted on every result: this module observed and did not act. */
export const NOT_APPLIED_REASON = 'observe:not-applied';

/**
 * @param {*} value - Candidate.
 * @returns {string|null} Trimmed non-empty string, else null.
 */
function str(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * The incumbent tier: the caller's assertion first, then the receipt's own
 * `models.current`. Null means there is no incumbent — the session's first
 * decision — and nothing can be "switched away from".
 *
 * @param {*} current - Caller-asserted tier.
 * @param {*} receipt - RouteReceipt, or null.
 * @returns {string|null} Tier alias, or null.
 */
function incumbentTier(current, receipt) {
  const asserted = str(current);
  if (asserted !== null) return asserted;
  const models = receipt && typeof receipt === 'object' ? receipt.models : null;
  const from = models && models.current;
  return from ? str(from.tier) : null;
}

/**
 * The tier the router recommended, read from the receipt.
 *
 * @param {*} receipt - RouteReceipt, or null.
 * @returns {string|null} Tier alias, or null.
 */
function recommendedTier(receipt) {
  const models = receipt && typeof receipt === 'object' ? receipt.models : null;
  const to = models && models.recommended;
  return to ? str(to.tier) : null;
}

/**
 * Check the receipt against the Observe invariant and report, never repair.
 *
 * @param {*} receipt - RouteReceipt, or null.
 * @param {string[]} reason - Accumulator, appended in place.
 * @returns {void}
 */
function auditReceipt(receipt, reason) {
  if (!receipt || typeof receipt !== 'object') {
    reason.push('receipt:absent');
    return;
  }
  const type = receipt.decision && str(receipt.decision.type);
  if (type === null) {
    reason.push('receipt:decision-absent');
  } else if (!OBSERVE_DECISIONS.includes(type)) {
    reason.push(`receipt:decision-unexpected:${type}`);
  }
}

/**
 * Copy a verdict's reason codes under a namespace so a reader can tell which
 * module said what.
 *
 * @param {*} verdict - `evaluateSwitch` or `resolveEscalation` result.
 * @param {string} prefix - Namespace, e.g. 'hysteresis'.
 * @param {string[]} reason - Accumulator, appended in place.
 * @returns {void}
 */
function copyReasons(verdict, prefix, reason) {
  const codes = verdict && verdict.reason;
  if (typeof codes === 'string') {
    reason.push(`${prefix}:${codes}`);
    return;
  }
  if (!Array.isArray(codes)) return;
  for (const code of codes) {
    const text = str(code);
    if (text !== null) reason.push(`${prefix}:${text}`);
  }
}

/**
 * Assemble the frozen, three-key result. `applied` is written here, once, as a
 * literal — there is no parameter for it.
 *
 * @param {string} proposal - A {@link PROPOSALS} value.
 * @param {string[]} reason - Ordered reason codes.
 * @returns {Readonly<{proposal: string, applied: false, reason: readonly string[]}>} Result.
 */
function result(proposal, reason) {
  return Object.freeze({
    proposal,
    applied: false,
    reason: Object.freeze([...reason, NOT_APPLIED_REASON]),
  });
}

/**
 * Propose what to do with the incumbent model, and do none of it.
 *
 * Branch order, first match wins:
 *   1. `escalation.kind === 'escalate'` with a tier that actually moves ->
 *      `escalate`. §29 immediate escalation outranks the economics: a
 *      capability or verification failure does not wait out a residency
 *      barrier.
 *   2. `escalation.kind === 'downgrade'` with a tier that actually moves ->
 *      `downgrade`, but ONLY when the economics also released the seat.
 *      A downgrade is an optimisation, so residency, the hysteresis band and
 *      the threshold all still apply; when they hold, so does this.
 *   3. `hysteresis.hold === false` and the router recommended a different
 *      tier -> `switch`.
 *   4. otherwise -> `hold`.
 *
 * @param {object} [input] - Controller input.
 * @param {string} [input.current] - Incumbent tier; falls back to
 *   `receipt.models.current.tier`, then to "no incumbent".
 * @param {object} [input.receipt] - The RouteReceipt for this action
 *   (`adaptive-model-router.js#routeModel`).
 * @param {object} [input.hysteresis] - `route-hysteresis.js#evaluateSwitch` result.
 * @param {object} [input.escalation] - `escalation-controller.js#resolveEscalation` result.
 * @returns {Readonly<{proposal: string, applied: false, reason: readonly string[]}>}
 *   `applied` is always false. Never throws.
 *
 * @example
 * proposeSwitch({ current: 'sonnet',
 *   escalation: { nextTier: 'opus', reason: 'escalate:fail', kind: 'escalate' } });
 * // { proposal: 'escalate', applied: false, reason: [...] }
 */
export function proposeSwitch(input = {}) {
  const src = input && typeof input === 'object' ? input : {};
  const reason = [];
  auditReceipt(src.receipt, reason);

  const current = incumbentTier(src.current, src.receipt);
  const escalation = src.escalation && typeof src.escalation === 'object' ? src.escalation : null;
  const hysteresis = src.hysteresis && typeof src.hysteresis === 'object' ? src.hysteresis : null;
  copyReasons(escalation, 'escalation', reason);
  copyReasons(hysteresis, 'hysteresis', reason);

  const nextTier = escalation ? str(escalation.nextTier) : null;
  const kind = escalation ? str(escalation.kind) : null;
  const moves = nextTier !== null && nextTier !== current;

  if (kind === 'escalate' && moves) {
    reason.push(`target:${nextTier}`);
    return result('escalate', reason);
  }

  if (kind === 'downgrade' && moves) {
    if (hysteresis === null || hysteresis.hold !== false) {
      reason.push('hold:downgrade-blocked-by-economics');
      return result('hold', reason);
    }
    reason.push(`target:${nextTier}`);
    return result('downgrade', reason);
  }

  const recommended = recommendedTier(src.receipt);
  if (hysteresis !== null && hysteresis.hold === false
    && recommended !== null && recommended !== current) {
    reason.push(`target:${recommended}`);
    return result('switch', reason);
  }

  if (hysteresis === null) reason.push('hold:no-economics');
  return result('hold', reason);
}

export default proposeSwitch;
