/**
 * Escalation controller — decides whether an outcome justifies moving to a
 * different tier, UP (escalation) or DOWN (downgrade). Both directions live in
 * this one file on purpose: ARTIBOT-5.0-DESIGN.md §3.2 makes downgrade "한
 * 파일 escalation-controller.js (하향은 분기)" citing 01 §13 "Complexity Must
 * Earn Its Existence". A `downgrade-controller.js` is explicitly forbidden.
 *
 * It proposes; it does not switch. The proposal goes to `route-hysteresis.js`
 * (is the move worth its cost) and then to `model-switcher.js` (T-29, which
 * stamps `decision.type`). Nothing here writes a ledger event.
 *
 * Layer: L2 (auxiliary), pure, zero imports. The tier ladder and the allowed
 * set both arrive as inputs, so this module holds no policy of its own. Never
 * throws: any unrecognised input yields `{nextTier: null, kind: null}`, which
 * is "stay where you are".
 *
 * ## Two invariants worth stating out loud
 *   - **`allowedTiers` is a ceiling escalation cannot break.** §4.1: "상향
 *     상한도 allowedTiers — denylist 는 에스컬레이션으로도 못 넘는다." A tier
 *     absent from `allowedTiers` is never proposed, whatever the outcome.
 *   - **Downgrade is off unless `performance` is explicitly `balanced`.** The
 *     brief requires it off for `maximum` and `split` (§4.3, 07:85-98). This
 *     implementation is strictly stronger: it is an ALLOWLIST, so an absent,
 *     misspelt or future `performance` value also leaves downgrade off. The
 *     failure it prevents (silently dropping tier on a mission that asked for
 *     maximum quality) is the expensive one; the failure it causes (missing a
 *     legitimate cost saving) is not.
 *
 * ## What this module does NOT see
 *   - **`empty`/`refusal` at the ladder ceiling is labelled `escalate`, and
 *     the label is a judgement call.** `commands/autopilot.md` ("빈-결과
 *     휴리스틱") says a fable agent returning empty or refusal retries once on
 *     the frontier tier. Frontier resolves to opus, which sits BELOW fable on
 *     the price/capability ladder, so the move looks like a downgrade. It is
 *     labelled `escalate` because §29 lists Capability Failure as an immediate
 *     escalation, and because labelling it `downgrade` would route it through
 *     the downgrade gate and disable the retry under `--fast` (performance =
 *     maximum) — exactly the profile that needs it most. Flagged for review.
 *   - **Nothing here counts anything.** `attempts`, `consecutiveSuccesses` and
 *     `health.refusals` are caller-maintained. If the caller does not count,
 *     every gate that depends on a count silently never fires.
 *   - **The retry-exhausted branch does not pause anything.** `autopilot.md`
 *     says a second empty result means PAUSED; that is the caller's action.
 *     This module only reports `retry-exhausted`.
 *
 * @module lib/routing/escalation-controller
 */

/**
 * Tier ladder, ascending in capability and in price.
 *
 * Mirrors the key order of `lib/core/model-catalog.js#MODELS` (measured
 * 2026-09-02: haiku, sonnet, opus, fable), which is also ascending
 * `priceInPerMTok` (1, 3, 5, 10). Duplicated rather than imported to keep this
 * module a zero-import port; inject `opts.ladder` to override. If the catalog
 * gains a tier, this constant and its test are what must change.
 * @type {readonly string[]}
 */
export const TIER_LADDER = Object.freeze(['haiku', 'sonnet', 'opus', 'fable']);

/**
 * Outcome vocabulary, as a closed allowlist. An outcome outside this set
 * produces no tier change — a new outcome name must be added here deliberately
 * rather than falling through into whichever branch happens to match.
 * @type {readonly string[]}
 */
export const OUTCOMES = Object.freeze([
  'empty',
  'refusal',
  'fail',
  'review_reject',
  'ok',
]);

/**
 * Outcomes that request an upward move (§29 Capability Failure / Critical
 * Verification Failure).
 * @type {readonly string[]}
 */
export const ESCALATING_OUTCOMES = Object.freeze([
  'empty',
  'refusal',
  'fail',
  'review_reject',
]);

/**
 * Outcomes eligible for the ceiling retry described in `commands/autopilot.md`
 * ("빈-결과 휴리스틱"). `fail` and `review_reject` are deliberately absent: the
 * prose covers an empty or refusal-shaped result, not a failed one.
 * @type {readonly string[]}
 */
export const CEILING_RETRY_OUTCOMES = Object.freeze(['empty', 'refusal']);

/**
 * Tier the ceiling retry targets. `commands/autopilot.md` names "frontier";
 * `lib/core/model-catalog.js#ROLE_ALIASES` maps frontier -> opus (measured
 * 2026-09-02). Written as the resolved tier because this module takes no
 * catalog port; override via `opts.policy.ceilingRetryTier`.
 * @type {string}
 */
export const CEILING_RETRY_TIER = 'opus';

/**
 * `execution_profile.performance` values under which downgrade is ENABLED.
 * Allowlist of one (§4.3: only balanced carries the
 * `cost_per_accepted_outcome` objective that a downgrade serves).
 *
 * FALLBACK ONLY. `lib/routing/execution-profile.js` (T-26) publishes the
 * derived answer as `directives.downgradeEnabled`; when a caller passes those
 * directives they win, so the two modules cannot drift apart. This allowlist
 * covers the caller who hands over a bare profile. Note the deliberate
 * asymmetry: T-26 defaults an ABSENT performance to balanced, while this
 * fallback treats absent as "not balanced" and leaves downgrade off. The
 * defaults differ because the wrong answers cost differently — T-26's shapes
 * an estimate, this one changes which model runs.
 * @type {readonly string[]}
 */
export const DOWNGRADE_ENABLED_PERFORMANCE = Object.freeze(['balanced']);

/**
 * Action classes whose arrival justifies considering a downgrade (§4.1:
 * "actionClass 가 status / classify / edit-routine 으로 바뀜"). Values are from
 * the closed action-class allowlist in
 * `schemas/route-receipt.schema.json#/properties/action/properties/type`.
 * @type {readonly string[]}
 */
export const DOWNGRADE_ACTION_CLASSES = Object.freeze([
  'status',
  'classify',
  'edit-routine',
]);

/**
 * UNCALIBRATED policy defaults.
 *
 * `ceilingRetries: 1` is the only value with a written source
 * (`commands/autopilot.md`: "frontier 티어로 1회 재시도"). The other two are
 * placeholders: §4.1 says downgrade needs "연속 성공 N" without naming N, and
 * no document sets a refusal-exclusion count at all.
 *
 * Owner decision G5 (2026-09-03) KEPT these numbers as they stand and required
 * only that their status be stated where they are written: they are document /
 * placeholder values awaiting RouteBench, NOT measured thresholds. The same
 * ruling covers `route-hysteresis.js#DEFAULT_SWITCH_POLICY` (residency 3 /
 * cooldown 2), which carries its own UNCALIBRATED note. Changing any of these
 * numbers needs calibration evidence, not a judgement call.
 * @type {Readonly<{ceilingRetries: number, ceilingRetryTier: string, downgradeAfterSuccesses: number, refusalExclusionThreshold: number}>}
 */
export const DEFAULT_ESCALATION_POLICY = Object.freeze({
  ceilingRetries: 1,
  ceilingRetryTier: CEILING_RETRY_TIER,
  // UNCALIBRATED (G5) — §4.1 names no N.
  downgradeAfterSuccesses: 2,
  // UNCALIBRATED (G5) — no document sets this count.
  refusalExclusionThreshold: 2,
});

/**
 * Coerce to a finite non-negative integer-ish number, or null.
 *
 * @param {*} value - Candidate.
 * @returns {number|null} Finite value >= 0, else null.
 */
function count(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

/**
 * Frozen decision helper.
 *
 * @param {string|null} nextTier - Proposed tier, or null to stay.
 * @param {string} reason - Single reason code.
 * @param {'escalate'|'downgrade'|null} kind - Direction, or null when staying.
 * @returns {Readonly<{nextTier: string|null, reason: string, kind: string|null}>} Decision.
 */
function decide(nextTier, reason, kind) {
  return Object.freeze({ nextTier, reason, kind });
}

/**
 * Read `execution_profile.performance`, accepting both the plain-string shape
 * (ARTIBOT-5.0-DESIGN.md §3.2) and the `{priority, budget}` object landed in
 * `schemas/execution-profile.schema.json` (T-18).
 *
 * @param {object} [profile] - Execution profile.
 * @returns {string|null} Performance value, or null when absent.
 */
export function resolvePerformance(profile) {
  const perf = profile?.performance;
  if (typeof perf === 'string') return perf.trim() || null;
  if (perf && typeof perf === 'object' && typeof perf.priority === 'string') {
    return perf.priority.trim() || null;
  }
  return null;
}

/**
 * Is downgrade permitted?
 *
 * Prefers the injected `directives.downgradeEnabled` from
 * `execution-profile.js#PERFORMANCE_DIRECTIVES`, so this module never
 * re-decides a question T-26 already answered. Falls back to
 * {@link DOWNGRADE_ENABLED_PERFORMANCE} when no directives are supplied.
 *
 * @param {object} [profile] - Execution profile.
 * @param {{downgradeEnabled?: boolean}} [directives] - execution-profile directives.
 * @returns {boolean} True only when a directive or the allowlist says so.
 * @example
 * downgradeEnabled({ performance: 'balanced' }); // true
 * downgradeEnabled({ performance: 'maximum' }); // false
 * downgradeEnabled({}); // false (absent is not balanced)
 * downgradeEnabled({}, { downgradeEnabled: true }); // true (directive wins)
 */
export function downgradeEnabled(profile, directives) {
  if (typeof directives?.downgradeEnabled === 'boolean') {
    return directives.downgradeEnabled;
  }
  const performance = resolvePerformance(profile);
  return performance !== null && DOWNGRADE_ENABLED_PERFORMANCE.includes(performance);
}

/**
 * Tiers a refusal count has temporarily taken out of service.
 *
 * Provider health, per the task brief: repeated refusals on a tier take it out
 * of the candidate set. `health.refusals` is a caller-maintained map of tier ->
 * refusal count; the window it covers is the caller's business.
 *
 * @param {{refusals?: Record<string, number>}} [health] - Health snapshot.
 * @param {number} threshold - Refusals at which a tier is excluded.
 * @returns {string[]} Excluded tier aliases (may be empty).
 */
export function excludedTiers(health, threshold) {
  const refusals = health?.refusals;
  if (!refusals || typeof refusals !== 'object') return [];
  const limit = count(threshold) ?? DEFAULT_ESCALATION_POLICY.refusalExclusionThreshold;
  return Object.keys(refusals).filter((tier) => (count(refusals[tier]) ?? 0) >= limit);
}

/**
 * Candidate tiers: the allowed set, intersected with the ladder, ordered by
 * ladder position, with health-excluded tiers removed.
 *
 * If exclusions would empty the set, they are ignored and the caller is told
 * so — stranding the router with no candidate at all is worse than routing to
 * a tier that has been refusing.
 *
 * @param {Iterable<string>|undefined} allowedTiers - Allowed set (Set or array).
 * @param {readonly string[]} ladder - Ascending tier ladder.
 * @param {string[]} excluded - Health-excluded tiers.
 * @returns {{tiers: string[], exclusionsIgnored: boolean}} Ordered candidates.
 */
export function candidateTiers(allowedTiers, ladder, excluded) {
  const allowed = allowedTiers === undefined || allowedTiers === null
    ? []
    : Array.from(allowedTiers);
  const onLadder = ladder.filter((tier) => allowed.includes(tier));
  const filtered = onLadder.filter((tier) => !excluded.includes(tier));
  return filtered.length > 0
    ? { tiers: filtered, exclusionsIgnored: false }
    : { tiers: onLadder, exclusionsIgnored: onLadder.length > 0 && excluded.length > 0 };
}

/**
 * Decide the next tier for an outcome.
 *
 * Branches, in order:
 *   - unknown outcome or unknown current tier -> stay
 *   - `ok` -> the downgrade branch (gated by profile, action class and a
 *     consecutive-success count)
 *   - any {@link ESCALATING_OUTCOMES} value -> the next allowed rung above the
 *     current tier; at the ceiling, the `autopilot.md` one-shot frontier retry
 *     for `empty`/`refusal` only
 *
 * @param {object} [input] - Outcome context.
 * @param {string} [input.outcome] - One of {@link OUTCOMES}.
 * @param {string} [input.tier] - Tier that produced the outcome.
 * @param {number} [input.attempts] - Ceiling retries already spent on this action.
 * @param {object} [input.profile] - Execution profile; gates downgrade.
 * @param {{downgradeEnabled?: boolean}} [input.directives] - `execution-profile.js` directives; overrides the profile allowlist.
 * @param {Iterable<string>} [input.allowedTiers] - Ceiling set from `model-policy.js#allowedTiers`.
 * @param {string} [input.actionClass] - Current action class; gates downgrade.
 * @param {number} [input.consecutiveSuccesses] - Successes in a row; gates downgrade.
 * @param {{refusals?: Record<string, number>}} [input.health] - Provider health snapshot.
 * @param {object} [input.policy] - Overrides for {@link DEFAULT_ESCALATION_POLICY}.
 * @param {readonly string[]} [input.ladder] - Tier ladder override.
 * @returns {Readonly<{nextTier: string|null, reason: string, kind: 'escalate'|'downgrade'|null}>} Proposal.
 *
 * @example
 * resolveEscalation({ outcome: 'fail', tier: 'sonnet', allowedTiers: ['sonnet', 'opus'] });
 * // { nextTier: 'opus', reason: 'escalate:fail', kind: 'escalate' }
 */
export function resolveEscalation(input = {}) {
  const policy = { ...DEFAULT_ESCALATION_POLICY, ...(input?.policy ?? {}) };
  const ladder = Array.isArray(input?.ladder) && input.ladder.length > 0
    ? input.ladder
    : TIER_LADDER;
  const outcome = input?.outcome;
  const tier = input?.tier;

  if (!OUTCOMES.includes(outcome)) return decide(null, 'unknown-outcome', null);
  if (typeof tier !== 'string' || !ladder.includes(tier)) {
    return decide(null, 'unknown-tier', null);
  }

  const excluded = excludedTiers(input?.health, policy.refusalExclusionThreshold);
  const { tiers, exclusionsIgnored } = candidateTiers(input?.allowedTiers, ladder, excluded);
  if (tiers.length === 0) return decide(null, 'no-allowed-tier', null);

  const currentIndex = ladder.indexOf(tier);

  if (outcome === 'ok') {
    return resolveDowngrade(input, policy, ladder, tiers, currentIndex);
  }

  // Upward: the lowest allowed rung strictly above the current tier.
  const up = tiers.find((candidate) => ladder.indexOf(candidate) > currentIndex);
  if (up !== undefined) {
    const suffix = exclusionsIgnored ? ',health-exclusion-ignored' : '';
    return decide(up, `escalate:${outcome}${suffix}`, 'escalate');
  }

  return resolveCeilingRetry(outcome, tier, input, policy, tiers);
}

/**
 * The ladder ceiling has been reached. `commands/autopilot.md` grants exactly
 * one retry on the frontier tier for an empty or refusal-shaped result.
 *
 * @param {string} outcome - Escalating outcome.
 * @param {string} tier - Current (ceiling) tier.
 * @param {object} input - Original input.
 * @param {object} policy - Resolved policy.
 * @param {string[]} tiers - Ordered candidate tiers.
 * @returns {Readonly<object>} Proposal.
 */
function resolveCeilingRetry(outcome, tier, input, policy, tiers) {
  if (!CEILING_RETRY_OUTCOMES.includes(outcome)) return decide(null, 'ceiling', null);

  const attempts = count(input?.attempts) ?? 0;
  const limit = count(policy.ceilingRetries) ?? DEFAULT_ESCALATION_POLICY.ceilingRetries;
  if (attempts >= limit) return decide(null, 'retry-exhausted', null);

  const target = policy.ceilingRetryTier;
  if (target === tier) return decide(null, 'ceiling', null);
  if (!tiers.includes(target)) return decide(null, 'retry-tier-not-allowed', null);

  // Labelled `escalate`, not `downgrade` — see the module header.
  return decide(target, 'ceiling-retry:frontier', 'escalate');
}

/**
 * Downward branch. Every gate must pass; each failure reports which one.
 *
 * @param {object} input - Original input.
 * @param {object} policy - Resolved policy.
 * @param {readonly string[]} ladder - Tier ladder.
 * @param {string[]} tiers - Ordered candidate tiers.
 * @param {number} currentIndex - Ladder index of the current tier.
 * @returns {Readonly<object>} Proposal.
 */
function resolveDowngrade(input, policy, ladder, tiers, currentIndex) {
  if (!downgradeEnabled(input?.profile, input?.directives)) {
    return decide(null, 'downgrade-disabled:performance', null);
  }
  if (!DOWNGRADE_ACTION_CLASSES.includes(input?.actionClass)) {
    return decide(null, 'downgrade-hold:action-class', null);
  }
  const successes = count(input?.consecutiveSuccesses) ?? 0;
  const needed = count(policy.downgradeAfterSuccesses)
    ?? DEFAULT_ESCALATION_POLICY.downgradeAfterSuccesses;
  if (successes < needed) return decide(null, 'downgrade-hold:successes', null);

  // Highest allowed rung strictly below the current tier: step down one rung
  // that is actually available, not all the way to the floor.
  const below = tiers.filter((candidate) => ladder.indexOf(candidate) < currentIndex);
  if (below.length === 0) return decide(null, 'downgrade-hold:floor', null);

  return decide(below[below.length - 1], `downgrade:${input.actionClass}`, 'downgrade');
}
