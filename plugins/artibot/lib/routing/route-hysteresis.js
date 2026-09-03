/**
 * Route hysteresis — Switch Economics (MODEL-SWITCHING-SCORECARD.md §28) plus
 * the Minimum Residency / Cooldown gate (§30) and the Routing Epoch override
 * list (§29). Answers one question: *is this switch worth its cost?*
 *
 * `route-scorer.js` (T-27) answers "which tier is best". This module answers
 * "is moving there worth it", and `model-switcher.js` (T-29) turns the answer
 * into a `decision.type`. The split is the whole point: a router that always
 * takes the best tier flaps every action and pays the transition cost each
 * time.
 *
 * Layer: L2 (auxiliary), pure. ZERO imports on purpose — the model catalog
 * arrives as an injected port (`input.catalog`) even though `lib/core` (L1) is
 * importable from here, so the module can be exercised with a stub price table
 * and never reaches for ambient state. Never throws: every bad input degrades
 * to `hold: true` (do not switch), because unknown economics is a reason to
 * stay put, not to move.
 *
 * ## Output contract
 * `cost` uses the seven §28 term names fixed by lane 2 §4.5 and frozen into
 * `schemas/route-receipt.schema.json#/properties/terms`, so a writer can assign
 * `terms = result.cost` with no renaming. The task brief spelled these terms
 * `{serialization, rebuild, cacheLoss, handoff, handoffLatency, reorientation,
 * retry}`; those short names are NOT the landed contract and are not used here.
 *
 * ## What this module does NOT see (read before trusting a green test)
 *   - **Units are mixed, and the utility scalar hides that.** Terms carry their
 *     own units (see {@link COST_TERM_UNITS}); `switchUtility` is USD only.
 *     Two of the seven terms have no agreed conversion into USD and are
 *     therefore EXCLUDED from the sum — see {@link UNPRICED_COST_TERMS}. A
 *     green utility test says nothing about them.
 *   - **The ±0.05 band is uncalibrated.** It is lifted from
 *     `lib/cognitive/effort-resolver.js` (HYSTERESIS = 0.05), where it bands a
 *     0..1 score. Here it bands a USD-valued utility. Same number, different
 *     dimension: it is a placeholder awaiting RouteBench (§30), not a measured
 *     threshold.
 *   - **`minimum_residency` and `cooldown` collapse into one barrier.** Both
 *     §30 knobs are counted in actions, and the only counter this module
 *     receives is `actionsSinceSwitch`. Telling them apart needs a second
 *     counter (actions resident in the current tier vs actions since the last
 *     switch *attempt*) that no caller produces today. See
 *     {@link residencyBarrier}.
 *   - **Benefit is almost entirely pass-through.** Three of the four §28
 *     benefit terms are supplied by the caller and one is a projection; every
 *     one is `measured: false`. A positive `switchUtility` in Phase 0 reflects
 *     what the caller asserted, not anything observed.
 *
 * @module lib/routing/route-hysteresis
 */

/**
 * Flap-suppression half-width around the switch threshold.
 *
 * Value copied from `lib/cognitive/effort-resolver.js` (`HYSTERESIS = 0.05`),
 * which is the pattern §3.2 asks to apply to tiers. UNCALIBRATED for this use:
 * there it bands a 0..1 heuristic score, here it bands a USD utility.
 * @type {number}
 */
export const HYSTERESIS_BAND = 0.05;

/**
 * §30 initial heuristics, verbatim, plus the §28 switch threshold.
 *
 * All four values are UNCALIBRATED. §30 states outright that residency and
 * cooldown "are not fixed rules but calibrated by RouteBench", and may differ
 * per model family. `threshold: 0` is the literal §28 rule ("switch only if
 * SwitchUtility > threshold") with no bias added.
 *
 * Owner decision G5 (2026-09-03) KEPT residency 3 / cooldown 2 at the document
 * values and required only the UNCALIBRATED label the paragraph above already
 * carries — so this block is the decision, unchanged. Its sibling is
 * `escalation-controller.js#DEFAULT_ESCALATION_POLICY` (refusal threshold 2).
 * @type {Readonly<{minimum_residency: number, cooldown: number, threshold: number, band: number}>}
 */
export const DEFAULT_SWITCH_POLICY = Object.freeze({
  minimum_residency: 3,
  cooldown: 2,
  threshold: 0,
  band: HYSTERESIS_BAND,
});

/**
 * The seven §28 SwitchCost terms, in §28 order. Key names are the landed
 * receipt contract (route-receipt.schema.json#/properties/terms).
 * @type {readonly string[]}
 */
export const COST_TERMS = Object.freeze([
  'contextSerialization',
  'contextRebuild',
  'cacheLoss',
  'handoffTokens',
  'handoffLatency',
  'reorientationRisk',
  'expectedRetry',
]);

/**
 * The four §28 SwitchBenefit terms, in §28 order.
 * @type {readonly string[]}
 */
export const BENEFIT_TERMS = Object.freeze([
  'quality',
  'futureCost',
  'latency',
  'failure',
]);

/**
 * Unit each cost term's `value` is expressed in. Mixed by necessity: lane 2
 * §4.5 maps `contextRebuild` and `handoffTokens` onto the receipt's INTEGER
 * token fields, so those two cannot be currency.
 * @type {Readonly<Record<string, 'tokens'|'usd'|'ms'|'ratio'>>}
 */
export const COST_TERM_UNITS = Object.freeze({
  contextSerialization: 'tokens',
  contextRebuild: 'tokens',
  cacheLoss: 'usd',
  handoffTokens: 'tokens',
  handoffLatency: 'ms',
  reorientationRisk: 'ratio',
  expectedRetry: 'usd',
});

/**
 * Cost terms EXCLUDED from `switchUtility`, and why.
 *
 * `handoffLatency` is milliseconds and `reorientationRisk` is a 0..1 weight;
 * converting either into USD needs a value-of-time rate and a risk price that
 * no document decides. Rather than invent a factor, they are reported in
 * `cost` and left out of the sum — the omission is named here so a reader of
 * `switchUtility` can see it instead of inferring completeness. Both are
 * `measured: false` and 0 in Phase 0, so the exclusion changes no number today;
 * it will the moment either becomes measurable.
 * @type {readonly string[]}
 */
export const UNPRICED_COST_TERMS = Object.freeze([
  'handoffLatency',
  'reorientationRisk',
]);

/**
 * `usage.source` values (lane 2 §2.4 / §46 labelling) that make cache-loss a
 * MEASUREMENT rather than an upper-bound estimate. Allowlist, not a denylist:
 * an unrecognised source is an estimate.
 * @type {readonly string[]}
 */
export const MEASURED_USAGE_SOURCES = Object.freeze(['transcript', 'otlp']);

/**
 * `execution_profile.performance` values under which future-cost saving carries
 * any weight at all (§4.1: "balanced 가 아니면 CostSaving 가중치 0"; §4.3:
 * maximum and split set CostEfficiency to 0). Allowlist: an unlisted value
 * weights cost saving at 0.
 *
 * FALLBACK ONLY. `lib/routing/execution-profile.js` (T-26) already publishes
 * the derived answer as `directives.costWeight`; when a caller passes those
 * directives they win (see {@link resolveCostWeight}), so the two modules
 * cannot drift apart. This allowlist covers the caller who hands over a bare
 * profile with no directives.
 * @type {readonly string[]}
 */
export const COST_SAVING_PERFORMANCE = Object.freeze(['balanced']);

/**
 * §29 immediate-escalation triggers that bypass residency, cooldown and the
 * hysteresis band. Closed allowlist — an unlisted override is ignored, so a
 * future trigger fails closed (no switch) instead of silently bypassing §30.
 * @type {readonly string[]}
 */
export const SWITCH_OVERRIDES = Object.freeze([
  'capability_failure',
  'critical_verification_failure',
  'security_risk',
  'architecture_contradiction',
  'user_override',
]);

/**
 * Coerce to a finite non-negative number, or null when absent/invalid.
 *
 * @param {*} value - Candidate.
 * @returns {number|null} Finite value >= 0, else null.
 */
function nonNegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

/**
 * Build one frozen `{value, measured}` cost/benefit term.
 *
 * @param {number} value - Magnitude in the term's own unit.
 * @param {boolean} measured - True only for values traced to a measurement.
 * @returns {Readonly<{value: number, measured: boolean}>} Frozen term.
 */
function term(value, measured) {
  return Object.freeze({
    value: Number.isFinite(value) ? value : 0,
    measured: measured === true,
  });
}

/**
 * Read `execution_profile.performance`, accepting both shapes in circulation:
 * the plain string used by ARTIBOT-5.0-DESIGN.md §3.2 and the
 * `{priority, budget}` object landed in `schemas/execution-profile.schema.json`
 * (T-18). Returns null when neither is present.
 *
 * @param {object} [profile] - Execution profile.
 * @returns {string|null} Performance value, or null.
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
 * Weight applied to the future-cost-saving benefit term, 0..1.
 *
 * Prefers the injected `directives.costWeight` produced by
 * `execution-profile.js#PERFORMANCE_DIRECTIVES` (balanced 1, maximum 0,
 * split 0) so this module never re-decides a question T-26 already answered.
 * Falls back to {@link COST_SAVING_PERFORMANCE} only when no directives are
 * supplied.
 *
 * @param {object} [input] - Evaluation input.
 * @returns {number} Weight in 0..1.
 */
export function resolveCostWeight(input) {
  const declared = input?.directives?.costWeight;
  if (typeof declared === 'number' && Number.isFinite(declared) && declared >= 0) {
    return Math.min(1, declared);
  }
  const performance = resolvePerformance(input?.profile);
  return performance === null || COST_SAVING_PERFORMANCE.includes(performance) ? 1 : 0;
}

/**
 * Fresh (non-cached) input price per token, in USD, from the injected catalog.
 *
 * @param {object} catalog - Port exposing `getModel(tier)`.
 * @param {string} tier - Tier alias.
 * @returns {number|null} USD per input token, or null when unresolvable.
 */
export function freshInputPrice(catalog, tier) {
  const spec = typeof catalog?.getModel === 'function' ? catalog.getModel(tier) : null;
  const perMTok = nonNegative(spec?.priceInPerMTok);
  return perMTok === null ? null : perMTok / 1e6;
}

/**
 * Output price per token, in USD, from the injected catalog.
 *
 * @param {object} catalog - Port exposing `getModel(tier)`.
 * @param {string} tier - Tier alias.
 * @returns {number|null} USD per output token, or null when unresolvable.
 */
export function outputPrice(catalog, tier) {
  const spec = typeof catalog?.getModel === 'function' ? catalog.getModel(tier) : null;
  const perMTok = nonNegative(spec?.priceOutPerMTok);
  return perMTok === null ? null : perMTok / 1e6;
}

/**
 * Effective residency barrier in actions.
 *
 * §30 lists `minimum_residency.actions` and `cooldown.actions` as two knobs,
 * but both are counted in actions and the only counter a caller supplies is
 * `actionsSinceSwitch` — so they collapse to their maximum. Separating them
 * requires a second counter that does not exist; this is a modelling loss, not
 * a simplification for convenience.
 *
 * @param {{minimum_residency?: number, cooldown?: number}} policy - Switch policy.
 * @returns {number} Actions that must elapse before a switch is considered.
 */
export function residencyBarrier(policy) {
  const residency = nonNegative(policy?.minimum_residency)
    ?? DEFAULT_SWITCH_POLICY.minimum_residency;
  const cooldown = nonNegative(policy?.cooldown) ?? DEFAULT_SWITCH_POLICY.cooldown;
  return Math.max(residency, cooldown);
}

/**
 * Zero out all seven cost terms. `handoffLatency`, `reorientationRisk` and
 * `expectedRetry` stay `measured: false` even at zero (§8.2 R2: they remain
 * unmeasured until the usage receipt lands, and a `measured: true` zero would
 * read as "we checked, it costs nothing").
 *
 * @param {boolean} measuredComputable - measured flag for the four priced terms.
 * @returns {Readonly<Record<string, {value: number, measured: boolean}>>} Terms.
 */
function zeroCost(measuredComputable) {
  return Object.freeze({
    contextSerialization: term(0, measuredComputable),
    contextRebuild: term(0, measuredComputable),
    cacheLoss: term(0, measuredComputable),
    handoffTokens: term(0, measuredComputable),
    handoffLatency: term(0, false),
    reorientationRisk: term(0, false),
    expectedRetry: term(0, false),
  });
}

/**
 * Build the four §28 SwitchBenefit terms.
 *
 * Three are pure pass-through of caller-asserted USD gains (`expectedGain`),
 * because nothing in Phase 0 measures quality, latency or failure-rate deltas.
 * `futureCost` is projected from `expectedRemainingTokens` and the price delta
 * between tiers, scaled by {@link resolveCostWeight} (zero under maximum and
 * split). Every term is `measured: false` — an estimate derived from estimates
 * is not a measurement.
 *
 * @param {object} input - Evaluation input (see {@link evaluateSwitch}).
 * @param {number} priceFrom - Fresh input price of the incumbent tier.
 * @param {number} priceTo - Fresh input price of the candidate tier.
 * @returns {Readonly<Record<string, {value: number, measured: boolean}>>} Terms.
 */
function buildBenefit(input, priceFrom, priceTo) {
  const gain = input?.expectedGain ?? {};
  const weight = resolveCostWeight(input);
  const remaining = nonNegative(input?.expectedRemainingTokens) ?? 0;
  const futureCost = weight * remaining * (priceFrom - priceTo);
  return Object.freeze({
    quality: term(nonNegative(gain.quality) ?? 0, false),
    futureCost: term(futureCost, false),
    latency: term(nonNegative(gain.latency) ?? 0, false),
    failure: term(nonNegative(gain.failure) ?? 0, false),
  });
}

/**
 * Build the seven §28 SwitchCost terms from the transition inputs.
 *
 * Decomposition (each token is charged once, on the side that pays it):
 *   - `contextSerialization` — the handoff payload as OUTPUT of the outgoing
 *     tier. Same token count as `handoffTokens`, priced on the `from` side.
 *   - `handoffTokens` — the same payload as INPUT to the incoming tier.
 *   - `contextRebuild` — context NOT carried by the handoff
 *     (`contextTokens - handoffTokens`, floored at 0): what the incoming model
 *     must re-derive. Priced as fresh input on the `to` side.
 *   - `cacheLoss` — prompt-cache value forfeited, in USD. MEASURED only when
 *     `usageSource` is a receipt source AND a cache-read count is present;
 *     otherwise the §3.2 upper bound `contextTokens × freshInputPrice(to)`,
 *     flagged `measured: false`.
 *   - the remaining three — 0 / `measured: false` (§8.2 R2).
 *
 * @param {object} input - Evaluation input (see {@link evaluateSwitch}).
 * @param {number} priceTo - Fresh input price of the candidate tier, USD/token.
 * @returns {Readonly<Record<string, {value: number, measured: boolean}>>} Terms.
 */
function buildCost(input, priceTo) {
  const contextTokens = nonNegative(input?.contextTokens);
  const handoffTokens = nonNegative(input?.handoffTokens);
  const cacheRead = nonNegative(input?.cacheReadTokens);
  const creation = input?.cacheCreation ?? {};
  const created = (nonNegative(creation['1h']) ?? 0) + (nonNegative(creation['5m']) ?? 0);

  const handoff = handoffTokens ?? 0;
  const rebuild = contextTokens === null ? 0 : Math.max(0, contextTokens - handoff);

  // Cached footprint, widest first: an actual cache-read count beats the
  // creation totals, which beat the whole context as a last-resort bound.
  const cachedFootprint = cacheRead ?? (created > 0 ? created : contextTokens ?? 0);
  const cacheMeasured = MEASURED_USAGE_SOURCES.includes(input?.usageSource)
    && cacheRead !== null;

  return Object.freeze({
    contextSerialization: term(handoff, handoffTokens !== null),
    contextRebuild: term(rebuild, contextTokens !== null && handoffTokens !== null),
    cacheLoss: term(cachedFootprint * priceTo, cacheMeasured),
    handoffTokens: term(handoff, handoffTokens !== null),
    handoffLatency: term(0, false),
    reorientationRisk: term(0, false),
    expectedRetry: term(0, false),
  });
}

/**
 * Convert the priced cost terms to USD and sum them.
 * {@link UNPRICED_COST_TERMS} are skipped by name, not by accident.
 *
 * @param {Record<string, {value: number}>} cost - Cost terms.
 * @param {number} priceFromOut - Output price of the incumbent tier, USD/token.
 * @param {number} priceToIn - Fresh input price of the candidate tier, USD/token.
 * @returns {number} Total switch cost in USD.
 */
function costToUsd(cost, priceFromOut, priceToIn) {
  return cost.contextSerialization.value * priceFromOut
    + cost.contextRebuild.value * priceToIn
    + cost.cacheLoss.value
    + cost.handoffTokens.value * priceToIn
    + cost.expectedRetry.value;
}

/**
 * Sum the benefit terms. All four are already USD.
 *
 * @param {Record<string, {value: number}>} benefit - Benefit terms.
 * @returns {number} Total switch benefit in USD.
 */
function benefitToUsd(benefit) {
  return BENEFIT_TERMS.reduce((sum, key) => sum + benefit[key].value, 0);
}

/**
 * Assemble the frozen result object.
 *
 * @param {object} parts - Result fields.
 * @returns {Readonly<object>} Frozen evaluation result.
 */
function result(parts) {
  return Object.freeze({
    hold: parts.hold,
    switchUtility: parts.switchUtility,
    switchBenefitUsd: parts.switchBenefitUsd,
    switchCostUsd: parts.switchCostUsd,
    benefit: parts.benefit,
    cost: parts.cost,
    threshold: parts.threshold,
    residency: parts.residency,
    reason: Object.freeze(parts.reason),
  });
}

/**
 * Evaluate whether moving from one tier to another is worth its cost.
 *
 * Decision order (first match wins, and every one of them holds):
 *   1. no candidate tier                      -> `no-candidate`
 *   2. candidate equals incumbent             -> `same-tier`
 *   3. catalog cannot price either tier       -> `catalog-miss`
 *   4. §30 residency barrier not yet met      -> `minimum-residency`
 *   5. utility inside the ±band of threshold  -> `hysteresis-band`
 *   6. utility <= threshold                   -> `below-threshold`
 * Otherwise `hold: false`. A recognised `override` (§29) skips 4-6 but never
 * 1-3: an immediate escalation still cannot switch to a tier that does not
 * exist or cannot be priced.
 *
 * @param {object} [input] - Evaluation input.
 * @param {string|null} [input.from] - Incumbent tier alias, or null on the first decision.
 * @param {string} [input.to] - Candidate tier alias from the router.
 * @param {number} [input.cacheReadTokens] - Cache-read tokens from the usage receipt.
 * @param {{'1h'?: number, '5m'?: number}} [input.cacheCreation] - Cache-creation tokens by TTL.
 * @param {number} [input.contextTokens] - Live context size in tokens.
 * @param {number} [input.handoffTokens] - Handoff payload in TOKENS (never bytes).
 * @param {string} [input.usageSource] - `transcript|otlp|estimate` provenance of the cache numbers.
 * @param {object} [input.catalog] - Injected catalog port exposing `getModel(tier)`.
 * @param {number} [input.actionsSinceSwitch] - Actions elapsed since the last switch (§30).
 * @param {object} [input.policy] - Overrides for {@link DEFAULT_SWITCH_POLICY}.
 * @param {object} [input.profile] - Execution profile; `performance` gates cost-saving weight.
 * @param {{costWeight?: number}} [input.directives] - `execution-profile.js` directives; `costWeight` overrides the profile allowlist.
 * @param {number} [input.expectedRemainingTokens] - Tokens the mission is expected still to spend.
 * @param {{quality?: number, latency?: number, failure?: number}} [input.expectedGain] - Caller-asserted USD gains.
 * @param {string} [input.override] - A {@link SWITCH_OVERRIDES} value for §29 immediate escalation.
 * @returns {Readonly<object>} `{hold, switchUtility, benefit, cost, ...}`; never throws.
 *
 * @example
 * evaluateSwitch({ from: 'opus', to: 'opus', catalog }).hold; // true ('same-tier')
 */
export function evaluateSwitch(input = {}) {
  const policy = { ...DEFAULT_SWITCH_POLICY, ...(input?.policy ?? {}) };
  const threshold = nonNegative(policy.threshold) ?? DEFAULT_SWITCH_POLICY.threshold;
  const band = nonNegative(policy.band) ?? DEFAULT_SWITCH_POLICY.band;
  const barrier = residencyBarrier(policy);
  const actions = nonNegative(input?.actionsSinceSwitch);
  const residency = Object.freeze({
    actionsSinceSwitch: actions,
    minimumResidency: nonNegative(policy.minimum_residency)
      ?? DEFAULT_SWITCH_POLICY.minimum_residency,
    cooldown: nonNegative(policy.cooldown) ?? DEFAULT_SWITCH_POLICY.cooldown,
    barrier,
    satisfied: actions !== null && actions >= barrier,
  });

  const from = typeof input?.from === 'string' ? input.from : null;
  const to = typeof input?.to === 'string' ? input.to : null;

  const blocked = (blockReason, measuredComputable = false) => result({
    hold: true,
    switchUtility: 0,
    switchBenefitUsd: 0,
    switchCostUsd: 0,
    benefit: Object.freeze({
      quality: term(0, false),
      futureCost: term(0, false),
      latency: term(0, false),
      failure: term(0, false),
    }),
    cost: zeroCost(measuredComputable),
    threshold,
    residency,
    reason: [blockReason],
  });

  if (!to) return blocked('no-candidate');
  // Staying put costs nothing: the four computable terms are an exact zero.
  if (from !== null && from === to) return blocked('same-tier', true);

  const catalog = input?.catalog;
  const priceToIn = freshInputPrice(catalog, to);
  // A null incumbent is the session's first decision: there is no outgoing
  // model to serialize from, so its side of the transition prices at zero.
  const priceFromOut = from === null ? 0 : outputPrice(catalog, from);
  const priceFromIn = from === null ? 0 : freshInputPrice(catalog, from);
  if (priceToIn === null || priceFromOut === null || priceFromIn === null) {
    return blocked('catalog-miss');
  }

  const cost = buildCost(input, priceToIn);
  const benefit = buildBenefit(input, priceFromIn, priceToIn);
  const switchCostUsd = costToUsd(cost, priceFromOut, priceToIn);
  const switchBenefitUsd = benefitToUsd(benefit);
  const switchUtility = switchBenefitUsd - switchCostUsd;

  const override = SWITCH_OVERRIDES.includes(input?.override) ? input.override : null;
  const reason = [];
  let hold;

  if (override !== null) {
    hold = false;
    reason.push(`override:${override}`);
  } else if (!residency.satisfied) {
    hold = true;
    reason.push('minimum-residency');
  } else if (Math.abs(switchUtility - threshold) <= band) {
    // effort-resolver's flap suppression, applied to tiers: inside the band the
    // incumbent keeps the seat regardless of which side of the line it is on.
    hold = true;
    reason.push('hysteresis-band');
  } else if (switchUtility <= threshold) {
    hold = true;
    reason.push('below-threshold');
  } else {
    hold = false;
    reason.push('above-threshold');
  }

  return result({
    hold,
    switchUtility,
    switchBenefitUsd,
    switchCostUsd,
    benefit,
    cost,
    threshold,
    residency,
    reason,
  });
}
