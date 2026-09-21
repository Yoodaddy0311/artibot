/**
 * Replay fidelity labels -- EXACT / PARTIAL / SIMULATED, per routed Action.
 *
 * WHERE THE THREE WORDS COME FROM
 * ---------------------------------------------------------------------------
 * `MODEL-SWITCHING-SCORECARD.md` section 46 defines them and requires a report
 * to PRINT one: Exact = "같은 Action에 여러 model result가 실제 존재", Partial =
 * "일부 candidate만 실제 result 존재", Simulated = "Prediction model 사용",
 * closing with "가짜 '절감 예상'을 실제 값처럼 표현하지 않는다". This module is
 * the PRODUCER of that label. It grades what the ledger can prove, so that a
 * number derived from a prediction can never be printed beside one derived
 * from a receipt without saying which it is.
 *
 * THE UNIT IS ONE ACTION, AND AN ACTION IS ONE `tool_use_id`
 * ---------------------------------------------------------------------------
 * `scripts/hooks/route-observe-pre.js#observePre` writes one `route.selected`
 * receipt per PreToolUse(Agent) and sets both `routing_epoch_id` and
 * `action_id` to the host's `tool_use_id`. That id is therefore the Action key,
 * and the denominator here is `joinRouteBinds().receipts` -- the count of
 * DISTINCT PreToolUse receipts. Each row is graded from what the two existing
 * folds already derived from the same lines: `joinRouteBinds` says whether the
 * Action bound a spawn, `joinSpawnOutcomes` says whether that spawn produced a
 * usage receipt and whether its bind was comparable at all.
 *
 * WHY EXACT IS A STRUCTURAL ZERO (and why there is no branch that emits it)
 * ---------------------------------------------------------------------------
 * One Action is one `tool_use_id`, which binds at most one `agent_id`
 * (`route-bind.js` invariant 1), which is one RUN. No writer path can attach a
 * second, independent model result to the same Action, so section 46's Exact
 * has no way to occur and {@link EXACT_UNREACHABLE_REASON} says so in the
 * result instead of letting a silent 0 read as a measurement. A multi-model run
 * is NOT promoted: `receipt-envelope.js` splits a run that switched model
 * mid-flight into one receipt per model, and that is one execution that served
 * twice, not two outcomes for one Action. Grading it Exact would present a
 * mid-run artefact as a counterfactual -- the "가짜 절감" section 46 forbids.
 * A dead branch for a state no fixture can build is false coverage, so none is
 * written. EXACT OPENS the day a writer contract binds one `action_id` to two
 * or more independent spawns; on that day, delete this constant and add the
 * rule.
 *
 * VOCABULARY WARNING -- TWO SPELLINGS, ONE CONCEPT, NO PRODUCER LINK
 * ---------------------------------------------------------------------------
 * `tests/evals/fixtures/routebench/scenarios.schema.json` has a `replay_mode`
 * enum spelled in LOWER CASE and with a different third word:
 * `exact | partial | simulation`. That field is a SCENARIO AUTHOR'S
 * DECLARATION about a hand-written fixture; this module produces nothing of the
 * sort and never writes it. The mapping, if a caller ever needs one, is
 * EXACT↔exact, PARTIAL↔partial, SIMULATED↔simulation.
 *
 * PURITY (design section 1-8, L2). No clock, no filesystem, no randomness; the
 * events array is the injected port. Sibling folds are the only imports. Every
 * list and every record key in the result is sorted, so a shuffled input
 * serializes to the same bytes.
 *
 * -- WHAT THIS MODULE CANNOT SEE (repo rule section 9: write it next to the
 * gate) ----------------------------------------------------------------------
 *  1. WHETHER A JOINED PAIR IS THE RIGHT PAIR. `route-bind.js` CANNOT SEE #1:
 *     a wrong receipt bound to a spawn is indistinguishable from a right one.
 *     A PARTIAL therefore means "a receipt exists for the spawn this bind
 *     names", not "this receipt is the outcome of this Action".
 *  2. SEMANTIC IDENTITY. Two Actions are the same Action here iff they share a
 *     `tool_use_id`. Two tool calls that asked for the same work are two
 *     Actions, and nothing in the ledger says otherwise.
 *  3. WINDOWING. A bind or a receipt outside the caller's slice is absent, not
 *     late: its Action reads SIMULATED and its bind reads as an orphan. The
 *     label is a property of the INPUT, not of the run.
 *  4. DUPLICATE KEYS. Both upstream folds are first-wins in INPUT order, so a
 *     repeated `tool_use_id` or `agent_id` resolves by position. The repeats
 *     are surfaced as `conflicts` and their Action is graded SIMULATED with
 *     `bind-conflict`, because a broken 1:1 means the evidence cannot be
 *     attributed -- not that it is missing.
 *  5. ITS OWN CONSUMERS. `scripts/bench/routebench.mjs:36-39` describes
 *     `replay_mode` as copied through untouched, but `replay_mode` appears in
 *     NO executable line under `scripts/` or `lib/` (measured 2026-09-21: one
 *     grep hit, and it is that comment). Producing a label does not put it on
 *     a report; that wiring is a separate change.
 *
 * @module lib/replay/replay-label
 */

import { joinRouteBinds } from './route-bind.js';
import { AGENT_RUN_PREFIX, joinSpawnOutcomes, SPAWN_OUTCOME_EVENTS } from './spawn-outcome.js';

/** The label vocabulary of section 46, in report order. */
export const REPLAY_LABELS = Object.freeze(['EXACT', 'PARTIAL', 'SIMULATED']);

/**
 * Why EXACT can never be emitted: one Action is one run.
 *
 * Exported so a consumer prints the cause beside the 0 rather than inferring
 * "we saw none yet" from an empty bucket.
 */
export const EXACT_UNREACHABLE_REASON = 'one-action-one-run';

/** Why `by_label` is three nulls: an empty denominator is unmeasured, not 0. */
export const NO_ACTIONS_REASON = 'no-actions';

/**
 * Every reason string this fold can attach to a row.
 *
 * The first nine are SIMULATED causes in evaluation order; the last two are
 * PARTIAL's. They are exported as a frozen map so a caller switches on a
 * constant rather than on a literal that a rename would silently orphan.
 */
export const REPLAY_LABEL_REASONS = Object.freeze({
  UNBOUND_RECEIPT: 'unbound-receipt',
  BIND_CONFLICT: 'bind-conflict',
  NO_USAGE_RECEIPT: 'no-usage-receipt',
  FIFO_JOIN: 'fifo-join',
  CONFIDENCE_MISSING: 'confidence-missing',
  CONFIDENCE_UNLISTED: 'confidence-unlisted',
  NO_RECOMMENDATION: 'no-recommendation',
  NO_SERVED_MODEL: 'no-served-model',
  ESTIMATE_USAGE: 'estimate-usage',
  SINGLE_RUN_RESULT: 'single-run-result',
  MULTI_MODEL_SINGLE_RUN: 'multi-model-single-run',
});

/**
 * ALLOWLIST of `data.usage.source` values whose numbers were MEASURED.
 *
 * `schemas/attempt-receipt.schema.json` (usage.source) enumerates
 * transcript | otlp | estimate and states the rule this list enforces: "an
 * unlabelled receipt cannot be graded EXACT/PARTIAL/SIMULATED (section 46), and
 * estimate values must never be mixed into a measured aggregate".
 * `lib/economics/usage-receipt.js#buildReceipt` really does write 'estimate'
 * when the transcript fold failed, so the case is live, not hypothetical. An
 * allowlist rather than a deny-list (repo rule section 8): a fourth source
 * added tomorrow is excluded until someone decides it counts.
 */
const MEASURED_USAGE_SOURCES = Object.freeze(['transcript', 'otlp']);

/** The confidence tier `bindRoute` writes for a tier-3 guess. */
const FIFO_CONFIDENCE = 'fifo';

/** Is `value` a non-empty string? @param {unknown} value @returns {boolean} */
function isStr(value) {
  return typeof value === 'string' && value.length > 0;
}

/** Stable string order. @param {string} a @param {string} b @returns {number} */
function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** `value` as a plain object, or an empty one. @param {unknown} value @returns {object} */
function obj(value) {
  return value && typeof value === 'object' ? value : {};
}

/**
 * A counting map as a key-sorted plain object (`spawn-outcome.js#sortedCounts`:
 * `Object.fromEntries` defines own properties, so a reason literally spelled
 * `__proto__` becomes a visible bucket instead of mutating a prototype).
 *
 * @param {Map<string, number>} counts
 * @returns {Record<string, number>}
 */
function sortedCounts(counts) {
  return Object.fromEntries([...counts.entries()].sort((a, b) => cmp(a[0], b[0])));
}

/**
 * The agent ids whose usage numbers are NOT all measurement-grade.
 *
 * `data.usage.source` is not carried on `joinSpawnOutcomes`'s pairs, so the
 * events are swept once here. The run_id reading is `spawn-outcome.js#collect`'s
 * verbatim: envelope `run_id` first, then `data.run_id`, then the `agent-`
 * prefix stripped once. A run with no prefix is a main-thread run and binds
 * nothing, so it is not read.
 *
 * ANY offending row disqualifies the agent -- the allowlist condition is "every
 * receipt of this run was measured", and its negation is "at least one was
 * not", which is order-independent.
 *
 * @param {object[]} list - ledger lines.
 * @returns {Set<string>} agent ids with at least one non-measured usage row.
 */
function unmeasuredAgents(list) {
  const out = new Set();
  for (const e of list) {
    if (!e || typeof e !== 'object' || e.event !== SPAWN_OUTCOME_EVENTS.receipt) continue;
    const d = obj(e.data);
    const runId = isStr(e.run_id) ? e.run_id : (isStr(d.run_id) ? d.run_id : null);
    if (runId === null || !runId.startsWith(AGENT_RUN_PREFIX)) continue;
    if (!MEASURED_USAGE_SOURCES.includes(obj(d.usage).source)) {
      out.add(runId.slice(AGENT_RUN_PREFIX.length));
    }
  }
  return out;
}

/**
 * The two id sets named by `joinRouteBinds().conflicts`.
 *
 * Three conflict shapes carry ids under four key names (`receipt_duplicate`'s
 * `tool_use_id`, `tool_use_bound_twice`'s `tool_use_id` + `agent_ids`,
 * `agent_bound_twice`'s `agent_id` + `tool_use_ids`), and all of them mark
 * their Action unattributable.
 *
 * @param {object[]} conflicts - `joinRouteBinds().conflicts`.
 * @returns {{tools: Set<string>, agents: Set<string>}}
 */
function conflictKeys(conflicts) {
  const tools = new Set();
  const agents = new Set();
  for (const c of conflicts) {
    if (isStr(c.tool_use_id)) tools.add(c.tool_use_id);
    if (isStr(c.agent_id)) agents.add(c.agent_id);
    for (const id of Array.isArray(c.tool_use_ids) ? c.tool_use_ids : []) tools.add(id);
    for (const id of Array.isArray(c.agent_ids) ? c.agent_ids : []) agents.add(id);
  }
  return { tools, agents };
}

/**
 * Why a pair's `agreement` is null, without restating the confidence allowlist.
 *
 * `joinSpawnOutcomes` nulls `agreement` iff the confidence is outside ITS
 * allowlist OR no `recommended_model` was written. Naming the allowlist again
 * here would be a second copy free to drift, and the gate that matters -- which
 * pairs may be compared -- already lives there. The two live causes are
 * identified by their own evidence and the remainder is, by elimination, a
 * confidence the upstream allowlist does not carry.
 *
 * @param {object} pair - a pair with `agreement === null`.
 * @returns {string} a SIMULATED reason.
 */
function unmatchedReason(pair) {
  if (pair.confidence === FIFO_CONFIDENCE) return REPLAY_LABEL_REASONS.FIFO_JOIN;
  if (!isStr(pair.confidence)) return REPLAY_LABEL_REASONS.CONFIDENCE_MISSING;
  if (!isStr(pair.recommended_model)) return REPLAY_LABEL_REASONS.NO_RECOMMENDATION;
  return REPLAY_LABEL_REASONS.CONFIDENCE_UNLISTED;
}

/**
 * Grade one BOUND Action. ALLOWLIST: PARTIAL needs all five conditions.
 *
 * The label decision reads `pair.agreement`, NOT the confidence tier: the
 * upstream fold owns which tiers may be compared, so a tier added there
 * tomorrow arrives here as `agreement === null` and is graded SIMULATED
 * (fail-closed) without an edit. Confidence and `recommended_model` are read
 * for the REASON only.
 *
 * @param {object} bind - one `joinRouteBinds().bound[]` row.
 * @param {object|undefined} pair - that agent's `joinSpawnOutcomes()` pair.
 * @param {{conflicts: {tools: Set<string>, agents: Set<string>},
 *   unmeasured: Set<string>}} ctx - the two id sets.
 * @returns {{label: string, reason: string}}
 */
function gradeBound(bind, pair, ctx) {
  const simulated = (reason) => ({ label: 'SIMULATED', reason });
  if (ctx.conflicts.tools.has(bind.tool_use_id) || ctx.conflicts.agents.has(bind.agent_id)) {
    return simulated(REPLAY_LABEL_REASONS.BIND_CONFLICT);
  }
  if (pair === undefined) return simulated(REPLAY_LABEL_REASONS.NO_USAGE_RECEIPT);
  if (pair.agreement === null) return simulated(unmatchedReason(pair));
  if (pair.served_models.length === 0) return simulated(REPLAY_LABEL_REASONS.NO_SERVED_MODEL);
  if (ctx.unmeasured.has(bind.agent_id)) return simulated(REPLAY_LABEL_REASONS.ESTIMATE_USAGE);
  return {
    label: 'PARTIAL',
    reason: pair.served_models.length > 1
      ? REPLAY_LABEL_REASONS.MULTI_MODEL_SINGLE_RUN
      : REPLAY_LABEL_REASONS.SINGLE_RUN_RESULT,
  };
}

/**
 * One row per DISTINCT `tool_use_id`, in `session_id` then `tool_use_id` order.
 *
 * The de-duplication is what makes `rows.length === actions` structural rather
 * than fixture-dependent: `bound[]` may list one `tool_use_id` twice when
 * invariant 1 broke, while the denominator counts distinct receipts. First wins
 * in the upstream fold's sorted order, and the Action is SIMULATED either way.
 * `bound[]` and `unbound_receipts[]` are disjoint on `tool_use_id` by
 * construction, and together they cover every receipt.
 *
 * @param {object} join - `joinRouteBinds()` result.
 * @param {Map<string, object>} pairs - `joinSpawnOutcomes()` pairs by agent id.
 * @param {object} ctx - the id sets `gradeBound` reads.
 * @returns {object[]} rows.
 */
function buildRows(join, pairs, ctx) {
  const rows = new Map();
  for (const b of join.bound) {
    if (rows.has(b.tool_use_id)) continue;
    rows.set(b.tool_use_id, {
      tool_use_id: b.tool_use_id,
      agent_id: b.agent_id,
      session_id: isStr(b.session_id) ? b.session_id : null,
      ...gradeBound(b, pairs.get(b.agent_id), ctx),
    });
  }
  for (const r of join.unbound_receipts) {
    if (rows.has(r.tool_use_id)) continue;
    rows.set(r.tool_use_id, {
      tool_use_id: r.tool_use_id,
      agent_id: null,
      session_id: isStr(r.session_id) ? r.session_id : null,
      label: 'SIMULATED',
      reason: REPLAY_LABEL_REASONS.UNBOUND_RECEIPT,
    });
  }
  return [...rows.values()].sort(
    (a, b) => cmp(a.session_id ?? '', b.session_id ?? '') || cmp(a.tool_use_id, b.tool_use_id),
  );
}

/**
 * Grade every routed Action in a ledger slice.
 *
 * @param {object[]} events - ledger lines in file order; a non-array reads as
 *   an empty ledger.
 * @returns {object} the label fold. `by_label` is three NULLS -- never three
 *   zeros -- when `actions` is 0, with `by_label_reason` naming why: a
 *   distribution over an empty denominator is unmeasured, and "0 PARTIAL" is a
 *   finding. The KEY SET never changes with the data. `by_label` sums to
 *   `actions` and to `rows.length`, and so does `by_reason`. `EXACT` is always
 *   0 and `exact_reachable` is always false ({@link EXACT_UNREACHABLE_REASON}).
 *   `multi_model_runs` counts rows whose run served more than one model
 *   INCLUDING SIMULATED ones -- it describes the joined population, not the
 *   graded-PARTIAL one. `unlabeled` counts what is OUTSIDE the denominator:
 *   retired `spawn:`-shadowed receipts, binds whose receipt is not in this
 *   slice, and binds missing a join key.
 */
export function labelReplay(events) {
  const list = Array.isArray(events) ? events : [];
  const join = joinRouteBinds(list);
  const outcomes = joinSpawnOutcomes(list);
  const pairs = new Map(outcomes.pairs.map((p) => [p.agent_id, p]));
  const ctx = { conflicts: conflictKeys(join.conflicts), unmeasured: unmeasuredAgents(list) };

  const rows = buildRows(join, pairs, ctx);
  const byLabel = { EXACT: 0, PARTIAL: 0, SIMULATED: 0 };
  const byReason = new Map();
  let multiModelRuns = 0;
  for (const r of rows) {
    byLabel[r.label] += 1;
    byReason.set(r.reason, (byReason.get(r.reason) ?? 0) + 1);
    const pair = r.agent_id === null ? undefined : pairs.get(r.agent_id);
    if (pair !== undefined && pair.served_models.length > 1) multiModelRuns += 1;
  }

  const actions = join.receipts;
  return {
    actions,
    by_label: actions === 0 ? { EXACT: null, PARTIAL: null, SIMULATED: null } : byLabel,
    by_label_reason: actions === 0 ? NO_ACTIONS_REASON : null,
    by_reason: sortedCounts(byReason),
    exact_reachable: false,
    exact_unreachable_reason: EXACT_UNREACHABLE_REASON,
    multi_model_runs: multiModelRuns,
    conflicts: join.conflicts.length,
    rows,
    unlabeled: {
      pre_tool_use_only: join.ignored.pre_tool_use_only,
      orphan_binds: join.orphan_binds.length,
      malformed_binds: join.ignored.malformed_binds,
    },
  };
}
