/**
 * Routing honor -- did the spawn get the tier the EFFECTIVE routing says it should?
 *
 * INPUTS, ALL INJECTED
 * ---------------------------------------------------------------------------
 * The fold reads `joinSpawnOutcomes(events)` (`./spawn-outcome.js`) -- one pair
 * per spawn whose `route.bound` line joined its `usage.receipt` -- and asks two
 * injected ports per pair:
 *
 *   resolve(judgedAgent)        -> { model, source, reason } | null
 *     the expected tier of the row's `judged_agent` (the host `agent_type`,
 *     or on a named spawn the caller's `subagent_type`; CANNOT SEE #2),
 *     counting the user's overrides. The CLI passes a
 *     closure over `lib/core/model-overrides.js#resolveEffectiveModel`.
 *   tierOfServedModel(modelId)  -> tier | null
 *     the served id's tier. The CLI builds it from the catalog; the canonical
 *     id -> tier reader is `lib/economics/usage-receipt.js#resolveModelIdentity`
 *     (catalog `id` + `legacyIds`, exact match after stripping `[1m]` and a
 *     `-YYYYMMDD` snapshot).
 *
 * plus a `roster`: the qualified agent names (`artibot:x`, `artibot-cowork:x`)
 * whose definitions exist. The roster is an ALLOWLIST checked BEFORE resolve is
 * called, because `resolveEffectiveModel` answers every well-formed name --
 * `artibot:<anything>` falls through to the shipped default tier -- so a closure
 * that forgot to check the roster would turn a teammate name into an `honored`
 * verdict. The fold does not trust the closure to refuse.
 *
 * VERDICTS
 * ---------------------------------------------------------------------------
 *   honored     served tier === expected tier
 *   unhonored   both tiers known and different
 *   unmeasured  anything else, with exactly one reason from
 *               {@link UNMEASURED_REASONS}; the first failing check wins, in
 *               the order that object lists them. Missing data is NEVER
 *               promoted to a verdict.
 *
 * WHY BIND `confidence` IS NOT A GATE HERE (unlike `spawn-outcome.js`, which
 * excludes fifo pairs from `compared`). Confidence grades how the bind matched
 * the ROUTER receipt (`route.selected`) -- it decides whether
 * `recommended_model` belongs to this spawn. This fold reads neither of those.
 * `data.agent_type` is copied from the SubagentStart payload
 * (`scripts/hooks/subagent-handler.js#bindRoute`, `ctx.agentType`) and the
 * served model joins on `agent_id` === `run_id` minus `agent-`, an exact key.
 * Both columns are therefore independent of the fifo guess. Excluding fifo
 * pairs would drop measurable rows for a reason that does not apply; the
 * confidence of every MEASURED row is still reported in
 * `measured_by_confidence` so a reader can recompute without them.
 * THE ONE PLACE IT IS A GATE: the named-spawn fallback (CANNOT SEE #2) reads
 * `subagent_type`, which IS a router-receipt column, so there a fifo bind
 * would put the guess into the verdict. That fallback needs `exact` or `name`
 * AND `matched_on: 'name'`; a row judged through it says
 * `judged_on: 'subagent_type'`.
 *
 * DENOMINATORS -- `binds` is the primary one. A bind is a spawn the router saw,
 * and the question is "of the spawns, how many can we judge". `joined / binds`
 * is the join rate; `joined / subagent_runs` (runs that wrote a subagent
 * receipt: joined + `unjoined_receipts`) is the same join seen from the
 * receipt side. `measured / joined` is the coverage of the verdict, and
 * `honored / measured` is the only honor rate. Every rate is null -- never 0 --
 * when its denominator is 0.
 *
 * PURITY (design section 1-8, L2). No clock, no filesystem, no randomness, no
 * environment. It imports nothing from `./spawn-outcome.js` -- the caller runs
 * the join -- and only the tier vocabulary (`listTiers`) from the pure data
 * module `../core/model-catalog.js` (L2 -> L1). Rows and every count map are
 * sorted, so a shuffled ledger serializes to the same bytes.
 *
 * -- WHAT THIS MODULE CANNOT SEE (repo rule section 9: write it next to the
 * gate) --------------------------------------------------------------------
 *  1. WHY A TIER WAS SERVED. Leaders rarely pass `Agent(model=...)` (design P4:
 *     0/6 PreToolUse rows carried a model key), so today the host serves the
 *     agent's frontmatter `model:` by default. An `honored` row therefore
 *     mostly means "the frontmatter default was served and nobody overrode
 *     it", NOT "the user's setting took effect". Only a row whose
 *     `expected_source` is `override-*` AND whose override differs from the
 *     frontmatter says anything about an override; `by_expected_source` splits
 *     the verdicts for that reason, but this fold does not know the
 *     frontmatter value and cannot make that second cut itself.
 *  2. NAMED SPAWNS. On a named (teammate) spawn the host's `agent_type` is the
 *     TEAMMATE NAME, not the definition (`subagent-handler.js#bindRoute`
 *     comment). The definition is the caller's Agent `subagent_type`, which
 *     the bind copies verbatim off the router receipt as `subagent_type`. When
 *     the host value has no colon and the bind matched on the caller's NAME
 *     (`matched_on: 'name'`, confidence `exact`/`name`, never `fifo`), that
 *     column names the agent, as written (`judged_agent`, `judged_on`). A bind
 *     that matched on `subagent_type` keeps the host value: the identity match
 *     drops the prefix, so there the receipt may be a sibling spawn's. A
 *     teammate name left in place is `unqualified-agent-type`, and so is a
 *     bare name that ends up judged, from either column: the host qualifies
 *     plugin agents (`artibot:doc-updater`), so a bare name is a built-in
 *     (`Explore`), a user-level agent file, or a teammate -- and a user-level
 *     copy may carry a different `model:` than the plugin's. Treating it as
 *     `artibot:` would be a guess. A bind with no `subagent_type` (written
 *     before the column) or no `matched_on` keeps the host value. Measured on the shared
 *     ledger at 2026-09-23T07:40Z: 1 of 190 joined pairs had a qualified
 *     `agent_type`.
 *  3. SPAWNS THAT NEVER BOUND. `bindRoute` writes `route.bound` only when a
 *     router receipt matched; an unbound spawn has no bind and is in no
 *     denominator here. Its receipt, if any, is counted in `subagent_runs`.
 *  4. A SERVED MODEL THE CATALOG DID NOT KNOW. The receipt writer drops usage
 *     whose model id it cannot resolve (`usage-receipt.js`, `unresolvedModels`),
 *     so such a spawn has no receipt and shows up as an unjoined bind, not as
 *     `served-model-unknown`. That reason fires only when the injected mapper
 *     disagrees with the catalog the writer used.
 *  5. THE ROLE. `resolve` is called with the agent name only: a bind carries no
 *     phase role, so a phase override (`phaseRoles.build|review`) is not
 *     evaluated and a spawn that followed one can read as `unhonored`.
 *  6. THE SETTING IN FORCE AT SPAWN TIME. `resolve` answers with the config and
 *     overrides of NOW. A pair written before an override was set (or before a
 *     policy change) is judged against today's value. Window the ledger to
 *     after the last change before reading a rate.
 *  7. MULTI-MODEL RUNS. A run that served more than one model is
 *     `multi-model-run`; which model the routing was about is not decidable.
 *
 * @module lib/replay/routing-honor
 */

import { listTiers } from '../core/model-catalog.js';

/** The three verdicts, in report order. */
export const ROUTING_HONOR_VERDICTS = Object.freeze(['honored', 'unhonored', 'unmeasured']);

/**
 * Why a pair is `unmeasured`. The key order IS the check order: the first
 * failing check names the row, so each row carries exactly one reason.
 */
export const UNMEASURED_REASONS = Object.freeze({
  noAgentType: 'no-agent-type',
  unqualifiedAgentType: 'unqualified-agent-type',
  notInRoster: 'agent-not-in-roster',
  noServedModel: 'no-served-model',
  multiModelRun: 'multi-model-run',
  servedModelUnknown: 'served-model-unknown',
  notResolvable: 'agent-not-resolvable',
  expectedNotATier: 'expected-not-a-tier',
});

/** Plugin prefixes a qualified `agent_type` may carry. */
const QUALIFIED_PREFIXES = Object.freeze(['artibot:', 'artibot-cowork:']);

/**
 * Bind confidences under which the bind's `subagent_type` may name the agent:
 * the receipt was matched on identity, not picked by FIFO. Same two values
 * `spawn-outcome.js` compares on; restated, not imported (purity, header).
 */
const DETERMINISTIC_CONFIDENCE = Object.freeze(['exact', 'name']);

/** Is `value` a non-empty string? @param {unknown} value @returns {boolean} */
function isStr(value) {
  return typeof value === 'string' && value.length > 0;
}

/** Stable string order. @param {string} a @param {string} b @returns {number} */
function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Count one key. @param {Map<string, number>} counts @param {string} key @returns {void} */
function bump(counts, key) {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

/**
 * A counting map as a key-sorted plain object (own properties only, so a key
 * spelled `__proto__` is a visible bucket, not a prototype write).
 *
 * @param {Map<string, number>} counts
 * @returns {Record<string, number>}
 */
function sortedCounts(counts) {
  return Object.fromEntries([...counts.entries()].sort((a, b) => cmp(a[0], b[0])));
}

/** `num / den`, or null when the denominator is 0. @param {number} num @param {number} den @returns {number|null} */
function rate(num, den) {
  return den === 0 ? null : num / den;
}

/**
 * Call an injected port, turning a throw into null. A port that throws is a
 * port that did not answer, which is `unmeasured`, never a verdict.
 *
 * @param {Function} fn
 * @param {unknown} arg
 * @returns {unknown}
 */
function ask(fn, arg) {
  try {
    return fn(arg);
  } catch {
    return null;
  }
}

/** Does `value` carry one of {@link QUALIFIED_PREFIXES}? @param {unknown} value @returns {boolean} */
function isQualified(value) {
  return isStr(value) && QUALIFIED_PREFIXES.some((p) => value.startsWith(p));
}

/**
 * The name the verdict is about, and which pair column it came from:
 *   1. a qualified host `agent_type` -- the host observed the definition;
 *   2. else, when the bind matched on identity ({@link DETERMINISTIC_CONFIDENCE})
 *      BY THE CALLER'S NAME (`matched_on === 'name'`, the teammate path) and
 *      the host value has no colon (a teammate name, a built-in, a bare name),
 *      the caller's `subagent_type`, as written -- a bare or built-in value
 *      then fails the qualification check like any other;
 *   3. else the host value. A foreign-prefixed host value (`x:y`) is never
 *      replaced: the host said which plugin's agent ran. Nor is a bind that
 *      matched on `subagent_type`: identity matching drops the prefix, so a
 *      user-level `code-reviewer` can take an `artibot:code-reviewer` receipt
 *      from the same prompt, while a direct spawn of the plugin agent reports
 *      the qualified name itself and never reaches this branch.
 * See the module header, CANNOT SEE #2.
 *
 * @param {object} pair - `agent_type`, `subagent_type`, `confidence`, `matched_on` are read.
 * @returns {{name: string|null, on: string|null}}
 */
function judgedAgent(pair) {
  const {
    agent_type: agentType, subagent_type: callerType, confidence, matched_on: matchedOn,
  } = pair;
  if (isQualified(agentType)) return { name: agentType, on: 'agent_type' };
  const hostHasPlugin = isStr(agentType) && agentType.includes(':');
  const byCallerName = matchedOn === 'name' && DETERMINISTIC_CONFIDENCE.includes(confidence);
  if (!hostHasPlugin && isStr(callerType) && byCallerName) {
    return { name: callerType, on: 'subagent_type' };
  }
  return isStr(agentType) ? { name: agentType, on: 'agent_type' } : { name: null, on: null };
}

/**
 * The agent-identity checks on the judged name, in {@link UNMEASURED_REASONS} order.
 *
 * @param {string|null} name - {@link judgedAgent}'s name.
 * @param {Set<string>} roster - qualified names with a definition.
 * @returns {string|null} the failing reason, or null when the agent is judgeable.
 */
function agentReason(name, roster) {
  if (!isStr(name)) return UNMEASURED_REASONS.noAgentType;
  if (!isQualified(name)) return UNMEASURED_REASONS.unqualifiedAgentType;
  if (!roster.has(name)) return UNMEASURED_REASONS.notInRoster;
  return null;
}

/**
 * The served side: exactly one served model with a known tier.
 *
 * @param {unknown} served - the pair's `served_models`.
 * @param {Function} tierOfServedModel - injected mapper.
 * @param {string[]} tiers - the tier vocabulary.
 * @returns {{reason: string|null, model: string|null, tier: string|null}}
 */
function servedSide(served, tierOfServedModel, tiers) {
  const models = Array.isArray(served) ? served.filter(isStr) : [];
  if (models.length === 0) return { reason: UNMEASURED_REASONS.noServedModel, model: null, tier: null };
  if (models.length > 1) return { reason: UNMEASURED_REASONS.multiModelRun, model: null, tier: null };
  const tier = ask(tierOfServedModel, models[0]);
  if (!tiers.includes(tier)) {
    return { reason: UNMEASURED_REASONS.servedModelUnknown, model: models[0], tier: null };
  }
  return { reason: null, model: models[0], tier };
}

/**
 * The expected side: what the resolver says this agent should run on.
 *
 * @param {string} agentType - a roster member.
 * @param {Function} resolve - injected resolver.
 * @param {string[]} tiers - the tier vocabulary.
 * @returns {{reason: string|null, tier: string|null, source: string|null, gate: string|null}}
 */
function expectedSide(agentType, resolve, tiers) {
  const answer = ask(resolve, agentType);
  if (answer === null || typeof answer !== 'object') {
    return { reason: UNMEASURED_REASONS.notResolvable, tier: null, source: null, gate: null };
  }
  const source = isStr(answer.source) ? answer.source : null;
  const gate = isStr(answer.reason) ? answer.reason : null;
  if (!tiers.includes(answer.model)) {
    return { reason: UNMEASURED_REASONS.expectedNotATier, tier: null, source, gate };
  }
  return { reason: null, tier: answer.model, source, gate };
}

/**
 * The verdict row for one joined pair.
 *
 * @param {object} pair - one `joinSpawnOutcomes().pairs[]` element.
 * @param {object} ports - `{ resolve, tierOfServedModel, roster, tiers }`.
 * @returns {object} the row; `reason` is null exactly when `verdict` is not
 *   `unmeasured`.
 */
function judge(pair, ports) {
  const row = {
    agent_id: isStr(pair.agent_id) ? pair.agent_id : '',
    session_id: isStr(pair.session_id) ? pair.session_id : '',
    agent_type: isStr(pair.agent_type) ? pair.agent_type : null,
    subagent_type: isStr(pair.subagent_type) ? pair.subagent_type : null,
    judged_agent: null,
    judged_on: null,
    confidence: isStr(pair.confidence) ? pair.confidence : null,
    served_model: null,
    served_tier: null,
    expected_tier: null,
    expected_source: null,
    expected_gate: null,
    verdict: 'unmeasured',
    reason: null,
  };
  const who = judgedAgent(pair);
  const judged = { ...row, judged_agent: who.name, judged_on: who.on };
  const whoReason = agentReason(who.name, ports.roster);
  if (whoReason !== null) return { ...judged, reason: whoReason };
  const served = servedSide(pair.served_models, ports.tierOfServedModel, ports.tiers);
  const withServed = { ...judged, served_model: served.model, served_tier: served.tier };
  if (served.reason !== null) return { ...withServed, reason: served.reason };
  const expected = expectedSide(who.name, ports.resolve, ports.tiers);
  const full = {
    ...withServed,
    expected_tier: expected.tier,
    expected_source: expected.source,
    expected_gate: expected.gate,
  };
  if (expected.reason !== null) return { ...full, reason: expected.reason };
  return { ...full, verdict: expected.tier === served.tier ? 'honored' : 'unhonored' };
}

/**
 * Validate the ports and normalize the roster. A missing port is a caller bug,
 * so it throws instead of reading as "everything unmeasured".
 *
 * @param {object} ports
 * @returns {{resolve: Function, tierOfServedModel: Function, roster: Set<string>, tiers: string[]}}
 * @throws {TypeError}
 */
function checkPorts(ports) {
  const { resolve, tierOfServedModel, roster } = ports && typeof ports === 'object' ? ports : {};
  if (typeof resolve !== 'function') throw new TypeError('foldRoutingHonor: `resolve` must be a function');
  if (typeof tierOfServedModel !== 'function') {
    throw new TypeError('foldRoutingHonor: `tierOfServedModel` must be a function');
  }
  if (roster === null || typeof roster !== 'object' || typeof roster[Symbol.iterator] !== 'function') {
    throw new TypeError('foldRoutingHonor: `roster` must be an iterable of qualified agent names');
  }
  return { resolve, tierOfServedModel, roster: new Set([...roster].filter(isStr)), tiers: listTiers() };
}

/**
 * Count the rows into the totals block.
 *
 * @param {object[]} rows - sorted verdict rows.
 * @returns {object} verdict counts and the per-verdict breakdowns.
 */
function tally(rows) {
  const verdicts = { honored: 0, unhonored: 0, unmeasured: 0 };
  const byReason = new Map(Object.values(UNMEASURED_REASONS).map((r) => [r, 0]));
  const bySource = { honored: new Map(), unhonored: new Map() };
  const byConfidence = new Map();
  const transitions = new Map();
  for (const row of rows) {
    verdicts[row.verdict] += 1;
    if (row.verdict === 'unmeasured') {
      bump(byReason, row.reason);
      continue;
    }
    bump(bySource[row.verdict], row.expected_source ?? 'unknown');
    bump(byConfidence, row.confidence ?? 'none');
    if (row.verdict === 'unhonored') bump(transitions, `${row.expected_tier}->${row.served_tier}`);
  }
  return {
    verdicts,
    unmeasured_by_reason: sortedCounts(byReason),
    by_expected_source: {
      honored: sortedCounts(bySource.honored),
      unhonored: sortedCounts(bySource.unhonored),
    },
    measured_by_confidence: sortedCounts(byConfidence),
    unhonored_by_transition: sortedCounts(transitions),
  };
}

/**
 * Judge every joined spawn pair against the effective routing.
 *
 * @param {object} fold - the return value of `joinSpawnOutcomes(events)`; read
 *   fields: `binds`, `unjoined_receipts`, `pairs[]` (`agent_id`, `session_id`,
 *   `agent_type`, `subagent_type`, `matched_on`, `confidence`, `served_models`).
 * @param {{resolve: Function, tierOfServedModel: Function, roster: Iterable<string>}} ports
 * @returns {object} `{ denominators, rates, verdicts, unmeasured_by_reason,
 *   by_expected_source, measured_by_confidence, unhonored_by_transition, rows }`.
 *   `denominators.binds` is the primary denominator (see the module header);
 *   every rate is null when its denominator is 0. `unmeasured_by_reason`
 *   lists every reason, zeros included, so the shape never depends on the
 *   data. `by_expected_source` and `measured_by_confidence` are over MEASURED
 *   rows only.
 * @throws {TypeError} when `fold` is not a spawn-outcome fold or a port is missing.
 */
export function foldRoutingHonor(fold, ports) {
  if (!fold || typeof fold !== 'object' || !Array.isArray(fold.pairs)) {
    throw new TypeError('foldRoutingHonor: `fold` must be the result of joinSpawnOutcomes()');
  }
  const checked = checkPorts(ports);
  const rows = fold.pairs
    .map((pair) => judge(pair && typeof pair === 'object' ? pair : {}, checked))
    .sort((a, b) => cmp(a.session_id, b.session_id) || cmp(a.agent_id, b.agent_id));
  const counts = tally(rows);
  const binds = Number.isInteger(fold.binds) ? fold.binds : 0;
  const unjoinedReceipts = Number.isInteger(fold.unjoined_receipts) ? fold.unjoined_receipts : 0;
  const joined = rows.length;
  const measured = counts.verdicts.honored + counts.verdicts.unhonored;
  return {
    denominators: { binds, joined, subagent_runs: joined + unjoinedReceipts, measured },
    rates: {
      join_of_binds: rate(joined, binds),
      join_of_subagent_runs: rate(joined, joined + unjoinedReceipts),
      measured_of_joined: rate(measured, joined),
      honored_of_measured: rate(counts.verdicts.honored, measured),
    },
    ...counts,
    rows,
  };
}
