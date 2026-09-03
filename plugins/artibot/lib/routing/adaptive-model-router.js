/**
 * Adaptive model router — Phase 0 (Observe).
 *
 * Produces ONE RouteReceipt per routing decision: the `data` object of the
 * ledger event `route.selected` (`schemas/route-receipt.schema.json`). It
 * recommends; it never applies. `models.selected` is always the `resolveModel`
 * policy result, so the receipt records a recommendation BESIDE what actually
 * ran — the divergence rate between the two is the whole Phase 0 metric.
 *
 * Three structural guarantees, each pinned by a test:
 *
 *  1. CEILING. Candidates are `model-policy.js#allowedTiers(agent, {role})`
 *     intersected with the catalog, then optionally NARROWED (never widened)
 *     by `input.allowedTiers`. A tier outside the policy ceiling cannot be
 *     recommended even when it scores best, and a caller cannot widen it.
 *  2. INJECTED EFFORT/BUDGET. `ports.resolveEffort` and `ports.budgetFor` are
 *     ports, per ARTIBOT-5.0-DESIGN.md §1-8 — L2 must not import the L4
 *     effort-resolver or the L5 task-budget. Nothing here computes or looks up
 *     either. With no ports injected the receipt still emits and every
 *     `terms{}.measured` stays false.
 *  3. PURITY. No `node:fs`, no `Date.now`, no `Math.random`. Identity (ids,
 *     timestamp) and the routing epoch arrive from the caller; a value that
 *     was not supplied is `null`, never invented.
 *
 * WHAT THIS MODULE CANNOT SEE:
 *  - The scoring weights are UNCALIBRATED (the `route-scorer.js` tables are
 *    self-declared estimates). A recommendation is an opinion of those tables,
 *    not evidence about which tier is better.
 *  - Zero live receipts exist. Nothing here proves a receipt is ever appended.
 *  - `routing_epoch_id` is whatever the caller passed. G1 (epoch = spawn) is
 *    unresolved in code; T-31 is the intended writer.
 *
 * KNOWN DEVIATION FROM THE SCHEMA (deliberate, single point, tested):
 * `routing_epoch_id` is `null` when no epoch was injected, while the schema
 * types it as a required non-empty string. A receipt in that state is NOT
 * appendable — the null plus the `epoch:unavailable` reason code exists so the
 * gap stays visible instead of being filled by a sentinel that would join to
 * nothing. The same rule governs every other identity field.
 *
 * @module lib/routing/adaptive-model-router
 */

import { allowedTiers as policyAllowedTiers, resolveModel } from '../core/model-policy.js';

import { classifyAction } from './action-classifier.js';
import { COST_TERMS, evaluateSwitch } from './route-hysteresis.js';
import { DEFAULT_CATALOG, DEFAULT_WEIGHTS, scoreRoutes } from './route-scorer.js';

/** Receipt revision this module writes. Matches the schema `const`. */
export const RECEIPT_SCHEMA_VERSION = 1;

/** Every receipt this module writes is a shadow line — it changes nothing. */
export const RECEIPT_SOURCE = 'shadow';

/**
 * The only two `decision.type` values Phase 0 may produce. `switch`,
 * `escalate` and `downgrade` are Canary-gated (PRD §3) and belong to
 * `model-switcher.js#proposeSwitch`, which proposes without applying.
 * @type {readonly string[]}
 */
export const ROUTER_DECISIONS = Object.freeze(['route', 'pin']);

/**
 * Identity the caller MUST supply. None of it can be derived here without a
 * clock or a random source, both of which this module refuses. A missing field
 * is emitted as `null` with an `evidence:missing:<field>` reason code.
 * @type {readonly string[]}
 */
export const REQUIRED_EVIDENCE = Object.freeze([
  'route_receipt_id',
  'mission_id',
  'session_id',
  'execution_profile_version',
  'timestamp',
  'shadow_of',
]);

/** Optional identity, omitted from the receipt when absent (never nulled). */
const OPTIONAL_STRING_EVIDENCE = Object.freeze(['project_id', 'task_id', 'action_id']);

/** Provider used when the catalog spec names none. */
const PROVIDER = 'anthropic';

/** Family used when the catalog spec names none. */
const FAMILY = 'claude';

// ---------------------------------------------------------------------------
// Coercions — every one returns null rather than a stand-in value
// ---------------------------------------------------------------------------

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
 * @param {*} value - Candidate.
 * @returns {number|null} Finite number, else null.
 */
function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * @param {*} value - Candidate.
 * @returns {number|null} Integer >= 1, else null.
 */
function positiveInt(value) {
  const n = num(value);
  return n !== null && Number.isInteger(n) && n >= 1 ? n : null;
}

/**
 * @param {*} value - Candidate.
 * @returns {number} The value clamped to >= 0, or 0 when unusable.
 */
function nonNegative(value) {
  const n = num(value);
  return n === null || n < 0 ? 0 : n;
}

/**
 * The schema types token counts as integers while the hysteresis terms are
 * real-valued, so the rounding happens here instead of being pushed onto every
 * future writer.
 *
 * @param {*} value - Candidate.
 * @returns {number} Rounded integer >= 0.
 */
function nonNegativeInt(value) {
  return Math.round(nonNegative(value));
}

/**
 * Call an injected port defensively. A port that is absent, is not a function,
 * throws, or returns an unusable value is indistinguishable from "not
 * injected" — all four yield null, so the receipt never claims a value it did
 * not actually receive.
 *
 * @param {*} port - Candidate port.
 * @param {*} arg - Single argument, passed through unchanged.
 * @param {(v: *) => *} coerce - {@link str} or {@link num}.
 * @returns {*} Coerced result, or null.
 */
function callPort(port, arg, coerce) {
  if (typeof port !== 'function') return null;
  try {
    return coerce(port(arg));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Receipt pieces
// ---------------------------------------------------------------------------

/**
 * Resolve the catalog port. A caller replaying a stored decision passes a
 * pinned price table; everyone else gets the live catalog.
 *
 * @param {*} candidate - Injected catalog.
 * @returns {object} A port exposing at least `getModel`.
 */
function resolveCatalog(candidate) {
  return candidate && typeof candidate.getModel === 'function' ? candidate : DEFAULT_CATALOG;
}

/**
 * Build one `model_identity`. Returns null when the catalog cannot name the
 * tier — an unknown tier yields no identity rather than a half-filled one.
 *
 * `version` falls back to `model_id` because `lib/core/model-catalog.js`
 * exposes no per-model snapshot string (measured 2026-09-02): the dated id IS
 * the snapshot today. Injecting a catalog whose spec carries `version`
 * overrides that fallback with no code change.
 *
 * @param {string|null} tier - Tier alias.
 * @param {object} catalog - Catalog port.
 * @returns {object|null} Identity, or null.
 */
export function modelIdentity(tier, catalog) {
  const key = str(tier);
  if (key === null) return null;
  const port = resolveCatalog(catalog);
  const spec = port.getModel(key);
  const modelId = spec ? str(spec.id) : null;
  const catalogVersion = str(port.version) ?? str(DEFAULT_CATALOG.version);
  if (modelId === null || catalogVersion === null) return null;
  return {
    provider: str(spec.provider) ?? PROVIDER,
    family: str(spec.family) ?? FAMILY,
    tier: key,
    model_id: modelId,
    version: str(spec.version) ?? modelId,
    catalog_version: catalogVersion,
  };
}

/**
 * Policy ceiling, narrowed (never widened) by a caller-supplied allow-set.
 * Passing `allowedTiers: ['fable']` for a non-allowlisted agent yields an
 * EMPTY set, not fable: the intersection is the only way in.
 *
 * @param {object} src - Router input.
 * @returns {string[]} Permitted tiers, policy order.
 */
export function resolveCandidateTiers(src) {
  const role = str(src.role);
  const ceiling = policyAllowedTiers(src.agentType, role === null ? {} : { role }, src.config);
  const requested = src.allowedTiers;
  if (requested === undefined || requested === null) return [...ceiling];
  const wanted = requested instanceof Set ? [...requested] : requested;
  if (!Array.isArray(wanted)) return [...ceiling];
  return [...ceiling].filter((tier) => wanted.includes(tier));
}

/**
 * Term weights for `scoreRoutes`, derived only from the injected directives
 * (`execution-profile.js#PERFORMANCE_DIRECTIVES`). A zeroed `costWeight` or
 * `contextAffinityWeight` under `maximum`/`split` zeroes the matching scoring
 * term; nothing else is inferred from a profile. An explicit `input.weights`
 * wins outright.
 *
 * @param {object} src - Router input.
 * @returns {Record<string, number>|undefined} Weight override, or undefined.
 */
function resolveWeights(src) {
  if (src.weights && typeof src.weights === 'object') return src.weights;
  const directives = src.directives;
  if (!directives || typeof directives !== 'object') return undefined;
  const zeroCost = num(directives.costWeight) === 0;
  const zeroCtx = num(directives.contextAffinityWeight) === 0;
  if (!zeroCost && !zeroCtx) return undefined;
  const weights = { ...DEFAULT_WEIGHTS };
  if (zeroCost) weights.cost = 0;
  if (zeroCtx) weights.ctxAffinity = 0;
  return weights;
}

/**
 * Resolve the action class.
 *
 * `classifyAction` runs on BOTH paths, even when the caller names the class
 * outright: it is also the only thing that reads the `classifyComplexity`
 * port, and `action.complexity` is schema-required. An explicit class then
 * overrides the classifier's pick and is recorded as `class:explicit`, so
 * naming a class costs the caller the classification but never the factors.
 *
 * @param {object} src - Router input.
 * @returns {{actionClass: string, factors: object, phase: string|null}} Result.
 */
function resolveClassification(src) {
  const base = src.input && typeof src.input === 'object' ? src.input : {};
  const classified = classifyAction(
    { ...base, phase: src.phase ?? base.phase, role: src.role ?? base.role },
    src.classifierOptions ?? {},
  );
  const explicit = str(src.actionClass);
  if (explicit === null) return classified;
  return {
    ...classified,
    actionClass: explicit,
    factors: { ...classified.factors, source: 'explicit' },
  };
}

/**
 * `action` block. `phase` and `complexity` are null when the caller supplied
 * neither a role/phase nor a `classifyComplexity` port — the schema requires
 * both, so a null here is a visible, reported gap rather than a filled-in zero.
 *
 * @param {object} classified - {@link resolveClassification} result.
 * @returns {object} Action block plus the optional passthrough factors.
 */
function buildAction(classified) {
  const factors = classified.factors ?? {};
  const action = {
    type: classified.actionClass,
    phase: str(classified.phase),
    complexity: num(factors.complexity),
  };
  const uncertainty = num(factors.uncertainty);
  const risk = num(factors.risk);
  if (uncertainty !== null) action.uncertainty = uncertainty;
  if (risk !== null) action.risk = risk;
  return action;
}

/**
 * Copy the seven §28 cost terms into plain receipt objects, keyed exactly as
 * `route-hysteresis.js#COST_TERMS` — the schema rejects a typo such as
 * `handoff_bytes` rather than storing it silently.
 *
 * @param {object} cost - `evaluateSwitch(...).cost`.
 * @returns {Record<string, {value: number, measured: boolean}>} Terms.
 */
function buildTerms(cost) {
  const out = {};
  for (const name of COST_TERMS) {
    const term = cost && cost[name];
    out[name] = {
      value: num(term && term.value) ?? 0,
      measured: Boolean(term && term.measured === true),
    };
  }
  return out;
}

/**
 * Project the hysteresis terms onto the §40 `transition` block. Token fields
 * are integers by schema; `handoff_tokens` stays TOKENS because
 * `route-hysteresis.js` already contracts for tokens, never bytes.
 *
 * @param {object} hysteresis - `evaluateSwitch` result.
 * @returns {object} Transition block.
 */
function buildTransition(hysteresis) {
  const cost = hysteresis.cost ?? {};
  return {
    context_rebuild_tokens: nonNegativeInt(cost.contextRebuild && cost.contextRebuild.value),
    cache_loss_estimate: nonNegative(cost.cacheLoss && cost.cacheLoss.value),
    handoff_tokens: nonNegativeInt(cost.handoffTokens && cost.handoffTokens.value),
    predicted_time_ms: nonNegative(cost.handoffLatency && cost.handoffLatency.value),
    predicted_cost: nonNegative(hysteresis.switchCostUsd),
  };
}

/**
 * `predicted` block from the winning row, or four zeros when nothing was
 * scorable. Zero means UNKNOWN here, not "free" and not "certain to fail" —
 * the `route:no-candidate` reason code carries that meaning instead.
 *
 * @param {object|null} top - Winning `scoreRoutes` row.
 * @returns {object} Predicted block.
 */
function buildPredicted(top) {
  const p = top && top.predicted ? top.predicted : null;
  return {
    success: p ? nonNegative(p.success) : 0,
    cost: p ? nonNegative(p.cost) : 0,
    latency: p ? nonNegative(p.latency) : 0,
    retry_probability: p ? nonNegative(p.retry_probability) : 0,
  };
}

/**
 * Run the switch economics for the recommended tier, or accept an evaluation
 * the caller already made — so the receipt and `proposeSwitch` cannot disagree
 * about the same decision. An injected value is accepted only when it carries
 * all seven cost terms.
 *
 * @param {object} src - Router input.
 * @param {string|null} to - Recommended tier.
 * @param {object} catalog - Catalog port.
 * @param {number|null} budgetTokens - From `ports.budgetFor`, or null.
 * @returns {object} `evaluateSwitch`-shaped result.
 */
function resolveHysteresis(src, to, catalog, budgetTokens) {
  const given = src.hysteresis;
  const cost = given && typeof given === 'object' ? given.cost : null;
  if (cost && COST_TERMS.every((name) => cost[name] && typeof cost[name].value === 'number')) {
    return given;
  }
  const signals = src.signals && typeof src.signals === 'object' ? src.signals : {};
  const remaining = num(src.expectedRemainingTokens);
  return evaluateSwitch({
    from: str(src.currentTier),
    to,
    catalog,
    actionsSinceSwitch: src.actionsSinceSwitch,
    contextTokens: signals.contextTokens,
    cacheReadTokens: signals.cacheReadTokens,
    cacheCreation: src.cacheCreation,
    handoffTokens: src.handoffTokens,
    usageSource: src.usageSource,
    policy: src.switchPolicy,
    profile: src.profile,
    directives: src.directives,
    expectedRemainingTokens: remaining === null ? budgetTokens : remaining,
    expectedGain: src.expectedGain,
    override: src.override,
  });
}

/**
 * Copy the caller's identity onto the receipt, nulling what is missing and
 * naming each gap in `reason`.
 *
 * @param {object} evidence - Caller identity block.
 * @param {string[]} reason - Reason accumulator, appended in place.
 * @returns {object} Identity fields for the receipt.
 */
function buildIdentity(evidence, reason) {
  const src = evidence && typeof evidence === 'object' ? evidence : {};
  const out = {};
  for (const field of REQUIRED_EVIDENCE) {
    const value = field === 'execution_profile_version'
      ? positiveInt(src[field])
      : str(src[field]);
    out[field] = value;
    if (value === null) reason.push(`evidence:missing:${field}`);
  }
  for (const field of OPTIONAL_STRING_EVIDENCE) {
    const value = str(src[field]);
    if (value !== null) out[field] = value;
  }
  const revision = positiveInt(src.intent_revision);
  if (revision !== null) out.intent_revision = revision;
  return out;
}

/**
 * Score the allowed candidates and report the winner.
 *
 * @param {object} src - Router input.
 * @param {string} actionClass - Resolved action class.
 * @param {object} catalog - Catalog port.
 * @returns {object|null} Winning row, or null when nothing was scorable.
 */
function pickRoute(src, actionClass, catalog) {
  const ranked = scoreRoutes(
    {
      actionClass,
      allowedTiers: resolveCandidateTiers(src),
      catalog,
      signals: src.signals,
    },
    { weights: resolveWeights(src) },
  );
  return ranked.length > 0 ? ranked[0] : null;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Route one action and return the RouteReceipt for it. Never throws: a
 * malformed input yields a receipt whose gaps are named in `reason`, because a
 * routing observer that can break the run it observes is not an observer.
 *
 * @param {object} [input] - Routing input.
 * @param {string} [input.agentType] - Agent being routed; drives the ceiling.
 * @param {string} [input.role] - `resolveModel` role, e.g. 'build' / 'review'.
 * @param {string} [input.actionClass] - Explicit class; skips classification.
 * @param {object} [input.input] - `classifyAction` input when no class is given.
 * @param {object} [input.classifierOptions] - `classifyAction` options; carries
 *   the `classifyComplexity` port that fills `action.complexity`.
 * @param {Set<string>|string[]} [input.allowedTiers] - NARROWS the policy
 *   ceiling. Never widens it.
 * @param {object} [input.config] - Explicit config for `model-policy.js`.
 * @param {object} [input.catalog] - Catalog port; defaults to the live catalog.
 * @param {object} [input.profile] - Execution profile, passed to the economics.
 * @param {object} [input.directives] - A `PERFORMANCE_DIRECTIVES` entry.
 * @param {object} [input.signals] - `{contextTokens, cacheReadTokens, retriesSoFar, providerHealth}`.
 * @param {string} [input.currentTier] - Incumbent tier; absent on the first decision.
 * @param {number} [input.actionsSinceSwitch] - Residency counter (§30).
 * @param {object} [input.hysteresis] - Pre-computed `evaluateSwitch` result.
 * @param {{resolveEffort?: Function, budgetFor?: Function}} [input.ports] -
 *   Injected effort/budget ports. Nothing is computed when they are absent.
 * @param {string} [input.epoch] - Routing epoch id (G1: the spawn run_id).
 * @param {object} [input.evidence] - {@link REQUIRED_EVIDENCE} plus optional ids.
 * @returns {object} A RouteReceipt (`schemas/route-receipt.schema.json`).
 *
 * @example
 * routeModel({ agentType: 'architect', actionClass: 'architecture', epoch: 'run-1',
 *   evidence: { route_receipt_id: 'r1', mission_id: 'm1', session_id: 's1',
 *     execution_profile_version: 1, timestamp: '2026-09-02T00:00:00.000Z',
 *     shadow_of: 'seq-42' } }).decision.type; // 'route'
 */
export function routeModel(input = {}) {
  const src = input && typeof input === 'object' ? input : {};
  const catalog = resolveCatalog(src.catalog);
  const reason = [];

  const classified = resolveClassification(src);
  reason.push(`class:${str(classified.factors && classified.factors.source) ?? 'unknown'}`);

  const effort = callPort(src.ports && src.ports.resolveEffort, src.effortContext, str);
  reason.push(effort === null ? 'effort:unavailable' : `effort:${effort}`);
  const budgetTokens = callPort(src.ports && src.ports.budgetFor, src.budgetContext, num);
  if (budgetTokens === null) reason.push('budget:unavailable');

  const top = pickRoute(src, classified.actionClass, catalog);
  reason.push(top === null ? 'route:no-candidate' : `route:${top.tier}`);

  const role = str(src.role);
  const selectedTier = resolveModel(src.agentType, role === null ? {} : { role }, src.config);
  const selected = modelIdentity(selectedTier, catalog);
  reason.push(selected === null ? 'policy:unknown-tier' : `policy:${selected.tier}`);
  if (top !== null && selected !== null && top.tier !== selected.tier) reason.push('divergence');

  const hysteresis = resolveHysteresis(src, top === null ? null : top.tier, catalog, budgetTokens);
  for (const code of hysteresis.reason ?? []) reason.push(`hysteresis:${code}`);

  const epoch = str(src.epoch);
  if (epoch === null) reason.push('epoch:unavailable');
  const residency = num(src.actionsSinceSwitch);
  if (residency === null) reason.push('residency:unavailable');

  const currentTier = str(src.currentTier);
  return {
    schema_version: RECEIPT_SCHEMA_VERSION,
    ...buildIdentity(src.evidence, reason),
    routing_epoch_id: epoch,
    action: buildAction(classified),
    models: {
      current: modelIdentity(currentTier, catalog),
      recommended: top === null ? null : modelIdentity(top.tier, catalog),
      selected,
    },
    decision: { type: currentTier !== null && currentTier === selectedTier ? 'pin' : 'route' },
    predicted: buildPredicted(top),
    transition: buildTransition(hysteresis),
    terms: buildTerms(hysteresis.cost),
    actionsSinceSwitch: nonNegativeInt(residency),
    reason,
    source: RECEIPT_SOURCE,
  };
}

export default routeModel;
