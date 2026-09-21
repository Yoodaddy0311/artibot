/**
 * Spawn outcome -- what the router RECOMMENDED against what actually SERVED.
 *
 * TWO LINES, ONE SPAWN, TWO DIFFERENT KEYS
 * ---------------------------------------------------------------------------
 * `scripts/hooks/subagent-handler.js#bindRoute` writes a `route.bound` line at
 * SubagentStart carrying `data.recommended_model`, the MODEL ID the router said
 * this spawn should get. At SessionEnd `lib/economics/receipt-envelope.js`
 * writes a `usage.receipt` line carrying the model that actually served, in
 * `envelope.model` (equal to `data.model_identity.model_id` on 76/76 rows
 * measured 2026-09-21T01:18Z). The two lines do not share a key: the bind is
 * keyed by `data.agent_id`, the receipt by `run_id`, which is `agent-<agentId>`
 * for a subagent run and the bare `session_id` for a main-thread one. This fold
 * strips the prefix and joins on what is left; a receipt with no prefix is a
 * main-thread run and joins NOTHING, so it is in no denominator here, not even
 * the unjoined one.
 *
 * WHY THE RAW BIND LINE, AND MODEL IDS ON BOTH SIDES
 * ---------------------------------------------------------------------------
 * `route-bind.js#bindOf` keeps only the join terms; its `bound[]` rows carry no
 * `recommended_model`, `selected_model` or `agent_type`, which are exactly the
 * columns this comparison is about, so the raw `route.bound` rows are read here
 * rather than another fold's output. `data.selected_model` is a POLICY TIER
 * string ('fable', on 15/306 live rows); `data.recommended_model` is a model id
 * ('claude-opus-5', on 306/306). Comparing a tier to a model id is the defect
 * `lib/learning/ledger/spawn-ledger.js`'s header warns about: it reports
 * divergence on every row that in fact agrees. `selected_model` is carried as
 * an auxiliary column and is never an operand of the comparison.
 *
 * PURITY (design section 1-8, L2). No clock, no filesystem, no randomness. The
 * events array is the injected port: the caller passes `lib/runtime/ledger.js`'s
 * `readAllEvents` output (deduplicated, file order), which this module may not
 * import (L2 to L5 is forbidden). Every array and every record key in the
 * result is sorted, so a shuffled input serializes to the same bytes.
 *
 * -- WHAT THIS MODULE CANNOT SEE (repo rule section 9: write it next to the
 * gate) --------------------------------------------------------------------
 *  1. WHETHER A DIVERGENCE IS A FAULT. An allowlist demotion, `FABLE_DENYLIST`
 *     and a capacity fallback all look identical here. This fold COUNTS; the
 *     judgement needs the policy inputs of that moment, which no line carries.
 *  2. WHETHER A FIFO PAIR IS THE RIGHT PAIR. Tier-3 binds are guesses
 *     (`route-bind.js` CANNOT SEE #1), so a wrong receipt bound to a spawn is
 *     indistinguishable from a right one. They are excluded from `compared`
 *     and reported as `excluded_fifo`; that exclusion is a choice, not a
 *     measurement.
 *  3. A MULTI-MODEL RUN'S INTENT. `receipt-envelope.js` splits a run that
 *     served more than one model into one receipt PER MODEL (live count 0 at
 *     the measurement, so production does not exercise this path). Such a pair
 *     is `diverged` EVEN IF one served model is the recommended one: "served,
 *     plus something else" is a different claim from "served", and collapsing
 *     them would hide every mid-run model switch.
 *  4. THE OUTCOME OF THE SPAWN. There is no spawn-keyed score writer in the
 *     ledger today -- `review.completed` and `review.claim_audit` were 0 rows,
 *     `verify.completed` carries no `run_id`, and `usage.receipt`'s
 *     `outcome.accepted` was null on 94/94 rows. `score` is therefore emitted
 *     as an EXPLICIT null block so a reader sees an unmeasured column rather
 *     than a missing one. Agreement is not quality.
 *  5. AN UNPRICED PAIR'S COST. `cost.total` was a number on only 16/76 live
 *     subagent rows; the rest were null or the string 'unresolved'. Unpriced
 *     pairs are COUNTED in `cost.unpriced` and never summed as 0. Each bucket
 *     carries its OWN `priced` population beside its `total`, and `total` is
 *     null -- never 0 -- when that population is empty, because a sum over zero
 *     rows is unmeasured and a 0 reads as a measured floor. Measured on the
 *     live run at 2026-09-21T01:31:59Z: a flat `diverged_total` printed 0 while
 *     all 5 diverged pairs were unpriced, which reads as "the divergences were
 *     free". `latency` follows the same rule: `total_ms` is null when `count`
 *     is 0. A bucket total is therefore comparable only against its own
 *     `priced`/`count`, never against the other bucket's.
 *  6. RETENTION AND WINDOWING. A spawn whose bind rotated out of the window
 *     looks like an unjoined receipt and vice versa; neither is distinguishable
 *     here from a line that was never written.
 *
 * @module lib/replay/spawn-outcome
 */

/** The two ledger events this fold reads. */
export const SPAWN_OUTCOME_EVENTS = Object.freeze({
  bind: 'route.bound',
  receipt: 'usage.receipt',
});

/**
 * `run_id` prefix `lib/economics/receipt-envelope.js` puts on a SUBAGENT run.
 * A `run_id` without it is a main-thread run (18/94 live) and joins nothing.
 */
export const AGENT_RUN_PREFIX = 'agent-';

/** Why `score` is null: there is no spawn-keyed score writer in the ledger. */
export const SCORE_UNAVAILABLE_REASON = 'no-spawn-keyed-score-writer';

/** Confidence values `bindRoute` writes; anything else buckets as `other`. */
const KNOWN_CONFIDENCE = Object.freeze(['exact', 'name', 'fifo']);

/** The guess tier, excluded from `compared`. */
const CONFIDENCE_FIFO = 'fifo';

/** The `usage` fields summed per agreement bucket. */
const USAGE_FIELDS = Object.freeze([
  'fresh_input_tokens',
  'cached_input_tokens',
  'cache_creation_tokens',
  'output_tokens',
  'thinking_tokens',
  'requests',
]);

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

/** Count one key. @param {Map<string, number>} counts @param {string} key @returns {void} */
function bump(counts, key) {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

/**
 * A counting map as a key-sorted plain object.
 *
 * `Object.fromEntries` defines own properties, so a model literally spelled
 * `__proto__` becomes a visible bucket instead of mutating a prototype.
 *
 * @param {Map<string, number>} counts
 * @returns {Record<string, number>}
 */
function sortedCounts(counts) {
  return Object.fromEntries([...counts.entries()].sort((a, b) => cmp(a[0], b[0])));
}

/** A zeroed usage accumulator. @returns {Record<string, number>} */
function emptyUsage() {
  return Object.fromEntries(USAGE_FIELDS.map((f) => [f, 0]));
}

/**
 * The comparison columns of one `route.bound` row.
 *
 * @param {object} e - screened ledger line.
 * @returns {object|null} bind record, or null when `data.agent_id` is unusable.
 */
function bindOf(e) {
  const d = obj(e.data);
  if (!isStr(d.agent_id)) return null;
  return {
    agent_id: d.agent_id,
    session_id: isStr(e.session_id) ? e.session_id : '',
    tool_use_id: isStr(d.tool_use_id) ? d.tool_use_id : null,
    confidence: isStr(d.confidence) ? d.confidence : null,
    agent_type: isStr(d.agent_type) ? d.agent_type : null,
    recommended_model: isStr(d.recommended_model) ? d.recommended_model : null,
    selected_model: isStr(d.selected_model) ? d.selected_model : null,
  };
}

/**
 * The served model, cost and metering of one `usage.receipt` row.
 *
 * The served id is read from the envelope first and from `model_identity`
 * second; the two agreed on 76/76 live subagent rows, so the fallback is a
 * belt on a brace rather than a reconciliation.
 *
 * @param {object} e - screened ledger line.
 * @returns {{model: string|null, cost: unknown, usage: object, latency_ms: unknown}}
 */
function receiptOf(e) {
  const d = obj(e.data);
  const identity = obj(d.model_identity);
  return {
    model: isStr(e.model) ? e.model : (isStr(identity.model_id) ? identity.model_id : null),
    cost: obj(d.cost).total,
    usage: obj(d.usage),
    latency_ms: obj(d.timing).latency_ms,
  };
}

/**
 * One pass over the input: the binds, the receipts, and the row counters.
 *
 * FIRST BIND WINS, in INPUT order. The caller passes file order; sorting by
 * `ts` would make the answer depend on a clock this module may not read, and on
 * timestamps written by whichever process fired last.
 *
 * @param {object[]} list - ledger lines.
 * @returns {object} binds, receipts by agent id and the row counters.
 */
function collect(list) {
  const binds = new Map();
  const byAgent = new Map();
  const counts = {
    duplicateBinds: 0, malformedBinds: 0, receipts: 0,
    mainThreadReceipts: 0, subagentReceipts: 0, malformedReceipts: 0,
  };

  for (const e of list) {
    if (!e || typeof e !== 'object') continue;

    if (e.event === SPAWN_OUTCOME_EVENTS.bind) {
      const b = bindOf(e);
      if (b === null) {
        counts.malformedBinds += 1;
      } else if (binds.has(b.agent_id)) {
        counts.duplicateBinds += 1;
      } else {
        binds.set(b.agent_id, b);
      }
      continue;
    }

    if (e.event !== SPAWN_OUTCOME_EVENTS.receipt) continue;
    counts.receipts += 1;
    const d = obj(e.data);
    const runId = isStr(e.run_id) ? e.run_id : (isStr(d.run_id) ? d.run_id : null);
    if (runId === null) {
      counts.malformedReceipts += 1;
      continue;
    }
    if (!runId.startsWith(AGENT_RUN_PREFIX)) {
      counts.mainThreadReceipts += 1;
      continue;
    }
    counts.subagentReceipts += 1;
    const agentId = runId.slice(AGENT_RUN_PREFIX.length);
    const bucket = byAgent.get(agentId);
    if (bucket === undefined) byAgent.set(agentId, [receiptOf(e)]);
    else bucket.push(receiptOf(e));
  }

  return { binds, byAgent, counts };
}

/**
 * Build one pair from a bind and its receipts.
 *
 * A pair is priced only when EVERY receipt of the run carries a numeric
 * `cost.total`; a partially priced multi-model run is UNKNOWN, not a partial
 * sum, because the missing leg has no upper bound.
 *
 * @param {object} bind - bind record.
 * @param {object[]} receipts - that agent's receipt records.
 * @returns {object} pair record plus the internal receipt list.
 */
function pairOf(bind, receipts) {
  const served = [...new Set(receipts.map((r) => r.model).filter(isStr))].sort(cmp);
  const priced = receipts.length > 0 && receipts.every((r) => typeof r.cost === 'number');
  const compared = bind.confidence !== CONFIDENCE_FIFO && isStr(bind.recommended_model);
  const agreement = compared
    ? (served.length === 1 && served[0] === bind.recommended_model ? 'same' : 'diverged')
    : null;
  return {
    agent_id: bind.agent_id,
    session_id: bind.session_id,
    tool_use_id: bind.tool_use_id,
    confidence: bind.confidence,
    agent_type: bind.agent_type,
    recommended_model: bind.recommended_model,
    selected_model: bind.selected_model,
    served_models: served,
    receipts: receipts.length,
    agreement,
    priced,
    cost_total: priced ? receipts.reduce((sum, r) => sum + r.cost, 0) : null,
  };
}

/**
 * Add one pair's receipts into the usage, latency and cost accumulators.
 *
 * @param {object} acc - mutable accumulator bag.
 * @param {object} pair - a COMPARED pair.
 * @param {object[]} receipts - that pair's receipt records.
 * @returns {void}
 */
function accumulate(acc, pair, receipts) {
  const bucket = pair.agreement;
  for (const r of receipts) {
    for (const field of USAGE_FIELDS) {
      const v = r.usage[field];
      if (typeof v === 'number' && Number.isFinite(v)) acc.usage[bucket][field] += v;
      else acc.nonNumeric += 1;
    }
  }
  if (receipts.every((r) => typeof r.latency_ms === 'number' && Number.isFinite(r.latency_ms))) {
    acc.latency[bucket].count += 1;
    acc.latency[bucket].total_ms += receipts.reduce((sum, r) => sum + r.latency_ms, 0);
  }
  if (!pair.priced) {
    acc.costUnpriced += 1;
    return;
  }
  acc.cost[bucket].priced += 1;
  acc.cost[bucket].total += pair.cost_total;
}

/**
 * A sum bucket with its total nulled when the population is empty.
 *
 * A sum over zero rows is UNMEASURED, and printing 0 makes it read as a
 * measured floor -- the misreading CANNOT SEE #5 exists to prevent. Measured on
 * the live run at 2026-09-21T01:31:59Z: `diverged_total` printed 0 while all 5
 * diverged pairs were unpriced, i.e. "these divergences were free".
 *
 * @param {object} bucket - accumulator with a population field and a sum field.
 * @param {string} popKey - name of the population field.
 * @param {string} sumKey - name of the sum field.
 * @returns {object} the bucket with `sumKey` null when `popKey` is 0.
 */
function nullIfEmpty(bucket, popKey, sumKey) {
  return {
    [popKey]: bucket[popKey],
    [sumKey]: bucket[popKey] === 0 ? null : bucket[sumKey],
  };
}

/**
 * Join `route.bound` recommendations to `usage.receipt` served models.
 *
 * @param {object[]} events - ledger lines in file order; a non-array reads as
 *   an empty ledger.
 * @returns {object} the spawn-outcome fold. `agreement_rate` is `null` -- never
 *   0 -- when nothing was comparable: an empty denominator is UNMEASURED, and a
 *   0 would read as "no spawn got the model it was routed to", which is a
 *   finding. `score` is an EXPLICIT null block for the same reason (CANNOT SEE
 *   #4). `main_thread_receipts` is in no denominator: those runs are not
 *   spawns, so they are neither joined nor unjoined. `cost.same.total`,
 *   `cost.diverged.total` and both `latency.*.total_ms` are null -- never 0 --
 *   when their own population is 0 (CANNOT SEE #5). `cost.compared` is
 *   `same.priced + diverged.priced`, and `cost.compared + cost.unpriced`
 *   equals `compared`.
 */
export function joinSpawnOutcomes(events) {
  const { binds, byAgent, counts } = collect(Array.isArray(events) ? events : []);

  const pairs = [];
  const receiptsOf = new Map();
  let unjoinedBinds = 0;
  for (const bind of binds.values()) {
    const receipts = byAgent.get(bind.agent_id);
    if (receipts === undefined) {
      unjoinedBinds += 1;
      continue;
    }
    const pair = pairOf(bind, receipts);
    pairs.push(pair);
    receiptsOf.set(pair.agent_id, receipts);
  }
  pairs.sort((a, b) => cmp(a.session_id, b.session_id) || cmp(a.agent_id, b.agent_id));

  // Over PAIRS, not over binds: an unjoined bind's confidence says nothing
  // about how a comparison was made, so it is not in this breakdown.
  const byConfidence = { exact: 0, name: 0, fifo: 0, other: 0 };
  const agreedByModel = new Map();
  const divergence = new Map();
  const acc = {
    usage: { same: emptyUsage(), diverged: emptyUsage() },
    latency: { same: { count: 0, total_ms: 0 }, diverged: { count: 0, total_ms: 0 } },
    cost: { same: { priced: 0, total: 0 }, diverged: { priced: 0, total: 0 } },
    nonNumeric: 0, costUnpriced: 0,
  };
  let same = 0; let diverged = 0; let multiModelRuns = 0;
  let excludedFifo = 0; let excludedNoRecommendation = 0;

  for (const pair of pairs) {
    const key = KNOWN_CONFIDENCE.includes(pair.confidence) ? pair.confidence : 'other';
    byConfidence[key] += 1;
    if (pair.served_models.length > 1) multiModelRuns += 1;

    if (pair.agreement === null) {
      if (pair.confidence === CONFIDENCE_FIFO) excludedFifo += 1;
      else excludedNoRecommendation += 1;
      continue;
    }
    if (pair.agreement === 'same') {
      same += 1;
      bump(agreedByModel, pair.served_models[0]);
    } else {
      diverged += 1;
      for (const model of pair.served_models) {
        if (model !== pair.recommended_model) {
          bump(divergence, `${pair.recommended_model}->${model}`);
        }
      }
    }
    accumulate(acc, pair, receiptsOf.get(pair.agent_id));
  }

  const compared = same + diverged;
  return {
    binds: binds.size,
    duplicate_binds: counts.duplicateBinds,
    malformed_binds: counts.malformedBinds,
    receipts: counts.receipts,
    main_thread_receipts: counts.mainThreadReceipts,
    subagent_receipts: counts.subagentReceipts,
    malformed_receipts: counts.malformedReceipts,
    pairs,
    compared,
    excluded_fifo: excludedFifo,
    excluded_no_recommendation: excludedNoRecommendation,
    by_agreement: { same, diverged },
    agreement_rate: compared === 0 ? null : same / compared,
    by_confidence: byConfidence,
    agreed_by_model: sortedCounts(agreedByModel),
    divergence: sortedCounts(divergence),
    multi_model_runs: multiModelRuns,
    cost: {
      compared: acc.cost.same.priced + acc.cost.diverged.priced,
      unpriced: acc.costUnpriced,
      same: nullIfEmpty(acc.cost.same, 'priced', 'total'),
      diverged: nullIfEmpty(acc.cost.diverged, 'priced', 'total'),
    },
    usage_totals: {
      same: acc.usage.same,
      diverged: acc.usage.diverged,
      non_numeric: acc.nonNumeric,
    },
    latency: {
      same: nullIfEmpty(acc.latency.same, 'count', 'total_ms'),
      diverged: nullIfEmpty(acc.latency.diverged, 'count', 'total_ms'),
    },
    unjoined_binds: unjoinedBinds,
    unjoined_receipts: [...byAgent.keys()].filter((id) => !binds.has(id)).length,
    score: { source: null, value: null, reason: SCORE_UNAVAILABLE_REASON },
  };
}
