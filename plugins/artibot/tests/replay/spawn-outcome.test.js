/**
 * Unit contract for the spawn-outcome fold (`lib/replay/spawn-outcome.js`).
 *
 * The fold joins the router's RECOMMENDATION (`route.bound`, written at
 * SubagentStart) to the model that ACTUALLY SERVED (`usage.receipt`, written at
 * SessionEnd) per spawned agent, and compares the two MODEL IDS. The join key
 * is the bind's `data.agent_id` against the receipt's `run_id` with the
 * `agent-` prefix stripped; a receipt whose `run_id` carries no prefix is a
 * main-thread run and joins nothing.
 *
 * -- WHAT THIS SUITE CANNOT SEE (repo rules section 9) ----------------------
 *   - ZERO LIVE LINES. Every row below is hand-built in the key layout
 *     measured on the parent ledger at 2026-09-21T01:18Z. Nothing here was
 *     read from a real ledger, so nothing here says what live agreement IS.
 *   - THE WRITERS. That `subagent-handler.js#bindRoute` fires on every spawn,
 *     and that `lib/economics/receipt-envelope.js` emits one receipt per model,
 *     is those suites' business. This suite pins arithmetic over a given array.
 *   - FIXTURE SCALE. 12 binds and 15 receipt rows. Live at the measurement was
 *     306 bind rows and 94 receipts (76 subagent / 18 main-thread). Nothing
 *     here says anything about the fold at ledger size or about read cost.
 *   - WHETHER A FIFO PAIR IS THE RIGHT PAIR. Tier-3 binds are guesses
 *     (`route-bind.js` CANNOT SEE #1). They are excluded from `compared`, and
 *     this suite cannot decide whether excluding them is generous or harsh.
 *   - WHETHER A DIVERGENCE IS A FAULT. Serving a different model may be a
 *     correct downgrade (allowlist, denylist, capacity). The fold counts; it
 *     does not judge, and neither does this suite.
 *   - THE SCORE COLUMN. `score` is asserted to be an EXPLICIT null block. That
 *     the ledger genuinely has no spawn-keyed score writer today is a claim
 *     about the writers, not something this suite measures.
 *
 * @module tests/replay/spawn-outcome
 */

import { describe, expect, it } from 'vitest';
import {
  AGENT_RUN_PREFIX,
  joinSpawnOutcomes,
  SCORE_UNAVAILABLE_REASON,
  SPAWN_OUTCOME_EVENTS,
} from '../../lib/replay/index.js';

const MISSION = 'M-20260921-001';
const SESS_A = 'sess-a';
const SESS_B = 'sess-b';
const OPUS = 'claude-opus-5';
const FABLE = 'claude-fable-5-1';

const SCORE_BLOCK = { source: null, value: null, reason: 'no-spawn-keyed-score-writer' };

let seqCounter = 0;

/**
 * A `route.bound` row in the live envelope key order.
 *
 * `routing_epoch_id` = `run_id` = `agent_id` and `action_id` = `tool_use_id`,
 * as `subagent-handler.js#bindRoute` writes them.
 *
 * @param {object} spec - agent_id, session, confidence and the optional columns.
 * @returns {object} ledger line.
 */
function bound(spec) {
  const {
    agentId, session = SESS_A, confidence = 'exact', agentType,
    recommended, selected, toolUseId = `toolu_${agentId}`,
  } = spec;
  seqCounter += 1;
  return {
    v: 1,
    ts: '2026-09-21T01:00:00.000Z',
    event: 'route.bound',
    session_id: session,
    source: 'hook',
    pid: 4242,
    seq: seqCounter,
    mission_id: MISSION,
    routing_epoch_id: agentId,
    run_id: agentId,
    action_id: toolUseId,
    data: {
      tool_use_id: toolUseId,
      agent_id: agentId,
      confidence,
      method: 'ledger-tail',
      ...(agentType === undefined ? {} : { agent_type: agentType }),
      matched_on: 'tool_use_id',
      ...(selected === undefined ? {} : { selected_model: selected }),
      ...(recommended === undefined ? {} : { recommended_model: recommended }),
      action_class: 'spawn',
    },
  };
}

/** The usage block every fixture receipt starts from. */
const USAGE = Object.freeze({
  source: 'transcript',
  fresh_input_tokens: 100,
  cached_input_tokens: 200,
  cache_creation_tokens: 300,
  output_tokens: 40,
  thinking_tokens: 5,
  requests: 1,
});

/**
 * A `usage.receipt` row in the live envelope key order.
 *
 * `envelope.model === data.model_identity.model_id` held on 76/76 live
 * subagent rows, so the fixture keeps them equal unless a case says otherwise.
 *
 * @param {object} spec - run_id, served model, cost, usage and latency overrides.
 * @returns {object} ledger line.
 */
function receipt(spec) {
  const {
    runId, session = SESS_A, model = OPUS, cost = 0.5,
    latencyMs = 1000, usage = {},
  } = spec;
  seqCounter += 1;
  return {
    v: 1,
    ts: '2026-09-21T01:05:00.000Z',
    event: 'usage.receipt',
    session_id: session,
    source: 'hook',
    pid: 4242,
    seq: seqCounter,
    mission_id: MISSION,
    run_id: runId,
    model,
    idempotency_key: `usage.receipt:${runId}:${model}`,
    data: {
      schema_version: 1,
      run_id: runId,
      mission_id: MISSION,
      model_identity: {
        provider: 'anthropic',
        family: 'claude',
        tier: 'high',
        model_id: model,
        version: '1',
        catalog_version: '5',
      },
      usage: { ...USAGE, ...usage },
      timing: {
        started_at: '2026-09-21T01:04:00.000Z',
        completed_at: '2026-09-21T01:05:00.000Z',
        latency_ms: latencyMs,
      },
      outcome: { status: 'unknown', accepted: null },
      cost: { total: cost, pricing_version: 'pv-1' },
    },
  };
}

/** A subagent receipt: `run_id` is `agent-<agentId>`. */
function agentReceipt(agentId, spec = {}) {
  return receipt({ runId: `agent-${agentId}`, ...spec });
}

/**
 * The full fixture: 12 binds (one repeated, one malformed) and 15 receipt rows.
 *
 * Built so every counter in the contract has a non-zero, hand-checkable value.
 *
 * @returns {object[]} ledger lines in input order.
 */
function fixture() {
  return [
    // -- same, opus, priced, with an auxiliary TIER string in selected_model --
    bound({ agentId: 'ag-001', recommended: OPUS, selected: 'opus', agentType: 'code-reviewer' }),
    agentReceipt('ag-001', { model: OPUS, cost: 0.5 }),
    // -- same, opus, priced --
    bound({ agentId: 'ag-002', recommended: OPUS }),
    agentReceipt('ag-002', { model: OPUS, cost: 0.25 }),
    // -- same, fable, priced --
    bound({ agentId: 'ag-003', recommended: FABLE, agentType: 'architect' }),
    agentReceipt('ag-003', { model: FABLE, cost: 0.125 }),
    // -- diverged opus -> fable, priced --
    bound({ agentId: 'ag-004', recommended: OPUS }),
    agentReceipt('ag-004', { model: FABLE, cost: 1.5 }),
    // -- diverged opus -> fable, priced, confidence 'name' --
    bound({ agentId: 'ag-005', recommended: OPUS, confidence: 'name' }),
    agentReceipt('ag-005', { model: FABLE, cost: 2.25 }),
    // -- fifo: a guess join, excluded from `compared` even though it agrees --
    bound({ agentId: 'ag-006', recommended: OPUS, confidence: 'fifo' }),
    agentReceipt('ag-006', { model: OPUS, cost: 0.0625 }),
    // -- no recommended_model: nothing to compare against --
    bound({ agentId: 'ag-007', confidence: 'name' }),
    agentReceipt('ag-007', { model: OPUS, cost: 0.03125 }),
    // -- same, opus, UNPRICED (cost.total null) and unmeasured latency --
    bound({ agentId: 'ag-008', recommended: OPUS, confidence: 'name' }),
    agentReceipt('ag-008', { model: OPUS, cost: null, latencyMs: null }),
    // -- diverged fable -> opus, UNPRICED (cost.total 'unresolved'), sess-b --
    bound({ agentId: 'ag-009', session: SESS_B, recommended: FABLE }),
    agentReceipt('ag-009', {
      session: SESS_B, model: OPUS, cost: 'unresolved', usage: { thinking_tokens: null },
    }),
    // -- multi-model run: two receipts, one per served model, sess-b --
    bound({ agentId: 'ag-010', session: SESS_B, recommended: OPUS, confidence: 'weird' }),
    agentReceipt('ag-010', { session: SESS_B, model: OPUS, cost: 0.75 }),
    agentReceipt('ag-010', { session: SESS_B, model: FABLE, cost: 1, latencyMs: 2000 }),
    // -- two binds that never produced a receipt --
    bound({ agentId: 'ag-011', recommended: OPUS }),
    bound({ agentId: 'ag-012', recommended: FABLE }),
    // -- a subagent receipt with no bind --
    agentReceipt('ag-099', { model: OPUS, cost: 0.5 }),
    // -- two MAIN-THREAD receipts: run_id is the session id, no agent- prefix --
    receipt({ runId: SESS_A, model: OPUS, cost: 0.5 }),
    receipt({ runId: SESS_B, session: SESS_B, model: FABLE, cost: 0.5 }),
    // -- malformed receipt: run_id is not a non-empty string --
    receipt({ runId: '', model: OPUS, cost: 0.5 }),
    // -- malformed bind: no string data.agent_id --
    { ...bound({ agentId: 'ag-bad', recommended: OPUS }), data: { tool_use_id: 'toolu_bad', confidence: 'exact' } },
  ];
}

/** The fixture plus a repeat bind for `ag-001` (later row must lose). */
function fixtureWithDuplicate() {
  return [
    ...fixture(),
    bound({ agentId: 'ag-001', recommended: FABLE, confidence: 'fifo', toolUseId: 'toolu_late' }),
  ];
}

/** Deterministic shuffle (same construction as `tests/replay/session-coverage.test.js`). */
function shuffled(arr) {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = (i * 7919) % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

describe('the barrel exports the fold', () => {
  it('exports all four names from lib/replay/index.js', () => {
    expect(typeof joinSpawnOutcomes).toBe('function');
    expect(SPAWN_OUTCOME_EVENTS).toEqual({ bind: 'route.bound', receipt: 'usage.receipt' });
    expect(AGENT_RUN_PREFIX).toBe('agent-');
    expect(SCORE_UNAVAILABLE_REASON).toBe('no-spawn-keyed-score-writer');
  });
});

describe('joinSpawnOutcomes() on nothing', () => {
  it('reports agreement_rate null, NOT zero, for an empty denominator', () => {
    // 0 compared pairs means UNMEASURED. A 0 here would read as "no spawn ever
    // got the model it was routed to", which is a finding; "nothing was
    // comparable" is the absence of one.
    const f = joinSpawnOutcomes([]);
    expect(f.agreement_rate).toBeNull();
    expect(f.agreement_rate).not.toBe(0);
    expect(f.binds).toBe(0);
    expect(f.duplicate_binds).toBe(0);
    expect(f.malformed_binds).toBe(0);
    expect(f.receipts).toBe(0);
    expect(f.main_thread_receipts).toBe(0);
    expect(f.subagent_receipts).toBe(0);
    expect(f.malformed_receipts).toBe(0);
    expect(f.pairs).toEqual([]);
    expect(f.compared).toBe(0);
    expect(f.excluded_fifo).toBe(0);
    expect(f.excluded_no_recommendation).toBe(0);
    expect(f.by_agreement).toEqual({ same: 0, diverged: 0 });
    expect(f.by_confidence).toEqual({
      exact: 0, name: 0, fifo: 0, other: 0,
    });
    expect(f.agreed_by_model).toEqual({});
    expect(f.divergence).toEqual({});
    expect(f.multi_model_runs).toBe(0);
    expect(f.cost).toEqual({
      compared: 0,
      unpriced: 0,
      same: { priced: 0, total: null },
      diverged: { priced: 0, total: null },
    });
    expect(f.unjoined_binds).toBe(0);
    expect(f.unjoined_receipts).toBe(0);
  });

  it('nulls every empty sum rather than printing a measured-looking 0', () => {
    // A sum over zero rows is UNMEASURED. On the empty fold BOTH cost totals
    // and BOTH latency totals have a zero population, so all four must be null
    // and none of them 0 -- the assertion is written both ways because
    // `toEqual` alone would accept a 0 if the expectation drifted.
    const f = joinSpawnOutcomes([]);
    expect(f.cost.same.total).toBeNull();
    expect(f.cost.same.total).not.toBe(0);
    expect(f.cost.diverged.total).toBeNull();
    expect(f.cost.diverged.total).not.toBe(0);
    expect(f.latency).toEqual({
      same: { count: 0, total_ms: null },
      diverged: { count: 0, total_ms: null },
    });
    expect(f.latency.same.total_ms).not.toBe(0);
    expect(f.latency.diverged.total_ms).not.toBe(0);
  });

  it('emits the explicit score block even on an empty ledger', () => {
    // The column is UNMEASURED, not missing. A live reader must be able to see
    // the difference without reading this module.
    expect(joinSpawnOutcomes([]).score).toEqual(SCORE_BLOCK);
    expect(joinSpawnOutcomes([]).score.source).toBeNull();
    expect(joinSpawnOutcomes([]).score.value).toBeNull();
    expect(joinSpawnOutcomes([]).score.reason).toBe(SCORE_UNAVAILABLE_REASON);
  });

  it('treats a non-array input as an empty ledger', () => {
    const empty = JSON.stringify(joinSpawnOutcomes([]));
    expect(JSON.stringify(joinSpawnOutcomes(undefined))).toBe(empty);
    expect(JSON.stringify(joinSpawnOutcomes(null))).toBe(empty);
    expect(JSON.stringify(joinSpawnOutcomes('x'))).toBe(empty);
    expect(JSON.stringify(joinSpawnOutcomes(42))).toBe(empty);
  });
});

describe('joinSpawnOutcomes() row accounting over the fixture', () => {
  const f = joinSpawnOutcomes(fixtureWithDuplicate());

  it('counts 12 binds, 1 duplicate and 1 malformed bind', () => {
    expect(f.binds).toBe(12);
    expect(f.duplicate_binds).toBe(1);
    expect(f.malformed_binds).toBe(1);
  });

  it('splits receipts into subagent, main-thread and malformed', () => {
    expect(f.receipts).toBe(15);
    expect(f.subagent_receipts).toBe(12);
    expect(f.main_thread_receipts).toBe(2);
    expect(f.malformed_receipts).toBe(1);
    expect(f.subagent_receipts + f.main_thread_receipts + f.malformed_receipts)
      .toBe(f.receipts);
  });

  it('FIRST BIND WINS in input order: the late repeat does not overwrite', () => {
    const first = f.pairs.find((p) => p.agent_id === 'ag-001');
    expect(first.recommended_model).toBe(OPUS);
    expect(first.confidence).toBe('exact');
    expect(first.tool_use_id).toBe('toolu_ag-001');
    expect(first.agreement).toBe('same');
  });

  it('MAIN-THREAD receipts are outside every denominator', () => {
    // run_id is the bare session_id (18/94 live). They join nothing, and they
    // are NOT unjoined subagent runs either -- counting them as unjoined would
    // invent 18 phantom spawns.
    expect(f.main_thread_receipts).toBe(2);
    expect(f.unjoined_receipts).toBe(1);
    expect(f.pairs.some((p) => p.agent_id === SESS_A || p.agent_id === SESS_B)).toBe(false);
  });
});

describe('joinSpawnOutcomes() pairs and comparison', () => {
  const f = joinSpawnOutcomes(fixtureWithDuplicate());

  it('builds one pair per bound agent that has a subagent receipt', () => {
    expect(f.pairs).toHaveLength(10);
    expect(f.unjoined_binds).toBe(2);
    expect(f.unjoined_receipts).toBe(1);
  });

  it('sorts pairs by session_id, then agent_id', () => {
    expect(f.pairs.map((p) => `${p.session_id}/${p.agent_id}`)).toEqual([
      'sess-a/ag-001', 'sess-a/ag-002', 'sess-a/ag-003', 'sess-a/ag-004',
      'sess-a/ag-005', 'sess-a/ag-006', 'sess-a/ag-007', 'sess-a/ag-008',
      'sess-b/ag-009', 'sess-b/ag-010',
    ]);
  });

  it('compares 8 pairs and excludes fifo and no-recommendation separately', () => {
    expect(f.compared).toBe(8);
    expect(f.excluded_fifo).toBe(1);
    expect(f.excluded_no_recommendation).toBe(1);
  });

  it('splits compared pairs 4 same / 4 diverged at rate 0.5', () => {
    expect(f.by_agreement).toEqual({ same: 4, diverged: 4 });
    expect(f.agreement_rate).toBe(0.5);
  });

  it('buckets confidence over ALL PAIRS, unknown values under "other"', () => {
    expect(f.by_confidence).toEqual({
      exact: 5, name: 3, fifo: 1, other: 1,
    });
    expect(Object.values(f.by_confidence).reduce((a, b) => a + b, 0)).toBe(f.pairs.length);
  });

  it('by_confidence counts PAIRS, not binds: an unjoined bind is not in it', () => {
    // The two readings are distinguishable and the population was not stated in
    // the contract's prose, so it is pinned here. `ag-011` and `ag-012` are
    // bound with confidence 'exact' and never produced a receipt; counting them
    // would make the breakdown a census of the ROUTER's confidence rather than
    // of the comparisons that were actually made.
    expect(f.unjoined_binds).toBe(2);
    expect(f.binds).toBe(f.pairs.length + f.unjoined_binds);
    expect(Object.values(f.by_confidence).reduce((a, b) => a + b, 0))
      .toBe(f.binds - f.unjoined_binds);
    expect(f.by_confidence.exact).toBe(5);
    expect(f.by_confidence.exact).not.toBe(7);
  });

  it('counts agreement per served model and divergence per recommended->served', () => {
    expect(f.agreed_by_model).toEqual({ [FABLE]: 1, [OPUS]: 3 });
    expect(f.divergence).toEqual({
      [`${FABLE}->${OPUS}`]: 1,
      [`${OPUS}->${FABLE}`]: 3,
    });
  });

  it('a MULTI-MODEL run that includes the recommended model is still diverged', () => {
    // `receipt-envelope.js` splits a run that served more than one model into
    // one receipt PER MODEL. "The recommendation was served, plus something
    // else" is not the same claim as "the recommendation was served".
    const multi = f.pairs.find((p) => p.agent_id === 'ag-010');
    expect(multi.receipts).toBe(2);
    expect(multi.served_models).toEqual([FABLE, OPUS]);
    expect(multi.recommended_model).toBe(OPUS);
    expect(multi.agreement).toBe('diverged');
    expect(f.multi_model_runs).toBe(1);
  });

  it('carries selected_model as an auxiliary column and never compares it', () => {
    // `selected_model` is a policy TIER ('fable'), not a model id. Comparing a
    // tier to a model id is the bug `lib/learning/ledger/spawn-ledger.js`
    // warns about: it reports divergence on every row that agrees.
    const p = f.pairs.find((x) => x.agent_id === 'ag-001');
    expect(p.selected_model).toBe('opus');
    expect(p.recommended_model).toBe(OPUS);
    expect(p.served_models).toEqual([OPUS]);
    expect(p.agreement).toBe('same');
    expect(p.agent_type).toBe('code-reviewer');
  });

  it('gives an excluded pair agreement null, not a verdict', () => {
    const fifo = f.pairs.find((p) => p.agent_id === 'ag-006');
    expect(fifo.confidence).toBe('fifo');
    expect(fifo.agreement).toBeNull();
    const noRec = f.pairs.find((p) => p.agent_id === 'ag-007');
    expect(noRec.recommended_model).toBeNull();
    expect(noRec.agreement).toBeNull();
    expect(noRec.agent_type).toBeNull();
  });
});

describe('joinSpawnOutcomes() cost, usage and latency', () => {
  const f = joinSpawnOutcomes(fixtureWithDuplicate());

  it('sums only PRICED pairs and counts the rest instead of summing them as 0', () => {
    // A null or 'unresolved' cost is UNKNOWN. Adding it as 0 would make the
    // total read as a measured floor when it is nothing of the kind.
    expect(f.cost.compared).toBe(6);
    expect(f.cost.unpriced).toBe(2);
    expect(f.cost.same).toEqual({ priced: 3, total: 0.5 + 0.25 + 0.125 });
    expect(f.cost.diverged).toEqual({ priced: 3, total: 1.5 + 2.25 + (0.75 + 1) });
  });

  it('carries each bucket its OWN priced population beside its total', () => {
    // A total is only readable against the population it was summed over. The
    // two buckets have different denominators (3 priced of 4 same, 3 of 4
    // diverged here), so a reader given one shared `compared` cannot divide
    // either total correctly.
    expect(f.cost.same.priced + f.cost.diverged.priced).toBe(f.cost.compared);
    expect(f.cost.same.priced).toBeLessThan(f.by_agreement.same);
    expect(f.cost.diverged.priced).toBeLessThan(f.by_agreement.diverged);
  });

  it('marks the two unpriced pairs and leaves their cost_total null', () => {
    const unpriced = f.pairs.filter((p) => p.priced === false).map((p) => p.agent_id);
    expect(unpriced).toEqual(['ag-008', 'ag-009']);
    for (const id of unpriced) {
      expect(f.pairs.find((p) => p.agent_id === id).cost_total).toBeNull();
    }
    expect(f.pairs.find((p) => p.agent_id === 'ag-010').priced).toBe(true);
    expect(f.pairs.find((p) => p.agent_id === 'ag-010').cost_total).toBe(1.75);
  });

  it('REGRESSION: diverged pairs that are ALL unpriced report null, not 0', () => {
    // Measured on the live run 2026-09-21T01:31:59Z: a flat `diverged_total`
    // printed 0 while cost.compared was 16 and every one of the 5 diverged
    // pairs was unpriced. A reader sees "16 pairs priced, divergence cost 0"
    // and concludes the divergences were free. The bucket population is what
    // separates "summed to zero" from "nothing to sum".
    const rows = [
      bound({ agentId: 'ag-p1', recommended: OPUS }),
      agentReceipt('ag-p1', { model: OPUS, cost: 0.5 }),
      bound({ agentId: 'ag-u1', recommended: OPUS }),
      agentReceipt('ag-u1', { model: FABLE, cost: null }),
      bound({ agentId: 'ag-u2', recommended: OPUS }),
      agentReceipt('ag-u2', { model: FABLE, cost: 'unresolved' }),
    ];
    const g = joinSpawnOutcomes(rows);
    expect(g.compared).toBe(3);
    expect(g.by_agreement).toEqual({ same: 1, diverged: 2 });
    expect(g.cost.compared).toBe(1);
    expect(g.cost.unpriced).toBe(2);
    expect(g.cost.same).toEqual({ priced: 1, total: 0.5 });
    expect(g.cost.diverged.priced).toBe(0);
    expect(g.cost.diverged.total).toBeNull();
    expect(g.cost.diverged.total).not.toBe(0);
  });

  it('REGRESSION: a latency bucket with no qualifying pair reports null, not 0', () => {
    // Same class as the cost case. Every diverged pair here has a null
    // latency_ms, so the bucket has nothing to sum; a 0 would read as "these
    // divergences were instantaneous".
    const g = joinSpawnOutcomes([
      bound({ agentId: 'ag-p1', recommended: OPUS }),
      agentReceipt('ag-p1', { model: OPUS, latencyMs: 1000 }),
      bound({ agentId: 'ag-n1', recommended: OPUS }),
      agentReceipt('ag-n1', { model: FABLE, latencyMs: null }),
    ]);
    expect(g.by_agreement).toEqual({ same: 1, diverged: 1 });
    expect(g.latency.same).toEqual({ count: 1, total_ms: 1000 });
    expect(g.latency.diverged.count).toBe(0);
    expect(g.latency.diverged.total_ms).toBeNull();
    expect(g.latency.diverged.total_ms).not.toBe(0);
  });

  it('sums usage over the receipts of compared pairs and flags non-numeric fields', () => {
    expect(f.usage_totals.same).toEqual({
      fresh_input_tokens: 400,
      cached_input_tokens: 800,
      cache_creation_tokens: 1200,
      output_tokens: 160,
      thinking_tokens: 20,
      requests: 4,
    });
    expect(f.usage_totals.diverged).toEqual({
      fresh_input_tokens: 500,
      cached_input_tokens: 1000,
      cache_creation_tokens: 1500,
      output_tokens: 200,
      thinking_tokens: 20,
      requests: 5,
    });
    expect(f.usage_totals.non_numeric).toBe(1);
  });

  it('counts latency only for pairs whose EVERY receipt reports a number', () => {
    // No mean is emitted: the caller divides, and a caller that sees count 0
    // cannot accidentally divide by it.
    expect(f.latency.same).toEqual({ count: 3, total_ms: 3000 });
    expect(f.latency.diverged).toEqual({ count: 4, total_ms: 6000 });
  });
});

describe('joinSpawnOutcomes() invariants hold on the fixture', () => {
  const f = joinSpawnOutcomes(fixtureWithDuplicate());

  it('pairs + unjoined_binds === binds', () => {
    expect(f.pairs.length + f.unjoined_binds).toBe(f.binds);
  });

  it('pairs + unjoined_receipts === distinct subagent agent ids', () => {
    expect(f.pairs.length + f.unjoined_receipts).toBe(11);
  });

  it('compared + excluded_fifo + excluded_no_recommendation === pairs', () => {
    expect(f.compared + f.excluded_fifo + f.excluded_no_recommendation)
      .toBe(f.pairs.length);
  });

  it('by_agreement partitions compared', () => {
    expect(f.by_agreement.same + f.by_agreement.diverged).toBe(f.compared);
    expect(f.agreement_rate).toBe(f.by_agreement.same / f.compared);
  });

  it('cost.compared + cost.unpriced === compared', () => {
    expect(f.cost.compared + f.cost.unpriced).toBe(f.compared);
  });

  it('agreed_by_model totals same, divergence totals at least diverged', () => {
    const agreed = Object.values(f.agreed_by_model).reduce((a, b) => a + b, 0);
    expect(agreed).toBe(f.by_agreement.same);
    const diverged = Object.values(f.divergence).reduce((a, b) => a + b, 0);
    expect(diverged).toBeGreaterThanOrEqual(f.by_agreement.diverged);
  });
});

describe('joinSpawnOutcomes() is order-independent', () => {
  it('serializes a shuffled input identically', () => {
    // First-bind-wins is defined over INPUT order, so the shuffled fixture is
    // the one WITHOUT the duplicate bind -- the same caveat the session-coverage
    // precedent documents.
    const rows = fixture();
    expect(JSON.stringify(joinSpawnOutcomes(shuffled(rows))))
      .toBe(JSON.stringify(joinSpawnOutcomes(rows)));
  });

  it('sorts every record key and every served_models list', () => {
    const f = joinSpawnOutcomes(shuffled(fixture()));
    expect(Object.keys(f.agreed_by_model)).toEqual([...Object.keys(f.agreed_by_model)].sort());
    expect(Object.keys(f.divergence)).toEqual([...Object.keys(f.divergence)].sort());
    for (const p of f.pairs) {
      expect(p.served_models).toEqual([...p.served_models].sort());
    }
  });

  it('a repeat bind keeps the FIRST row in input order, not the earliest ts', () => {
    const first = bound({ agentId: 'ag-x', recommended: OPUS, confidence: 'exact' });
    const second = bound({ agentId: 'ag-x', recommended: FABLE, confidence: 'fifo' });
    const rcpt = agentReceipt('ag-x', { model: OPUS });
    expect(joinSpawnOutcomes([first, second, rcpt]).pairs[0].recommended_model).toBe(OPUS);
    expect(joinSpawnOutcomes([second, first, rcpt]).pairs[0].recommended_model).toBe(FABLE);
  });
});

describe('joinSpawnOutcomes() negative control: the prefix strip is load-bearing', () => {
  it('a receipt whose run_id EQUALS a bind agent_id but lacks agent- does NOT join', () => {
    // If the fold ever matched `run_id` directly, a main-thread run whose
    // session id happened to equal an agent id would be attributed to that
    // spawn. This mutation makes the difference visible.
    const rows = [
      bound({ agentId: 'ag-001', recommended: OPUS }),
      receipt({ runId: 'ag-001', model: FABLE }),
    ];
    const f = joinSpawnOutcomes(rows);
    expect(f.binds).toBe(1);
    expect(f.pairs).toEqual([]);
    expect(f.unjoined_binds).toBe(1);
    expect(f.main_thread_receipts).toBe(1);
    expect(f.subagent_receipts).toBe(0);
    expect(f.unjoined_receipts).toBe(0);
    expect(f.agreement_rate).toBeNull();
  });

  it('the SAME rows with the prefix restored DO join', () => {
    // The positive half of the control: without it, "does not join" and "the
    // fold joins nothing at all" look identical.
    const f = joinSpawnOutcomes([
      bound({ agentId: 'ag-001', recommended: OPUS }),
      agentReceipt('ag-001', { model: FABLE }),
    ]);
    expect(f.pairs).toHaveLength(1);
    expect(f.subagent_receipts).toBe(1);
    expect(f.main_thread_receipts).toBe(0);
    expect(f.by_agreement).toEqual({ same: 0, diverged: 1 });
  });

  it('reads the served model id from the envelope, falling back to model_identity', () => {
    const row = agentReceipt('ag-001', { model: FABLE });
    delete row.model;
    const f = joinSpawnOutcomes([bound({ agentId: 'ag-001', recommended: FABLE }), row]);
    expect(f.pairs[0].served_models).toEqual([FABLE]);
    expect(f.by_agreement).toEqual({ same: 1, diverged: 0 });
  });
});

describe('joinSpawnOutcomes() skips malformed lines without throwing', () => {
  it('ignores non-objects, other events and rows with no usable id', () => {
    const f = joinSpawnOutcomes([
      null,
      undefined,
      'nope',
      {},
      { event: 'tool.used', session_id: SESS_A },
      { event: 'route.bound', session_id: SESS_A, data: { agent_id: 42 } },
      { event: 'route.bound', session_id: SESS_A },
      { event: 'usage.receipt', session_id: SESS_A, run_id: 7 },
      bound({ agentId: 'ag-001', recommended: OPUS }),
      agentReceipt('ag-001', { model: OPUS }),
    ]);
    expect(f.binds).toBe(1);
    expect(f.malformed_binds).toBe(2);
    expect(f.malformed_receipts).toBe(1);
    expect(f.pairs).toHaveLength(1);
    expect(f.agreement_rate).toBe(1);
    expect(f.score).toEqual(SCORE_BLOCK);
  });

  it('a ledger of only malformed lines is unmeasured, not zero agreement', () => {
    const f = joinSpawnOutcomes([null, {}, { event: 'route.bound' }]);
    expect(f.binds).toBe(0);
    expect(f.agreement_rate).toBeNull();
    expect(f.malformed_binds).toBe(1);
  });
});
