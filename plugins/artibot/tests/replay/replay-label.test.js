/**
 * Unit contract for the replay-label fold (`lib/replay/replay-label.js`).
 *
 * The fold grades every routed Action EXACT / PARTIAL / SIMULATED
 * (MODEL-SWITCHING-SCORECARD.md section 46). The unit is one distinct
 * `tool_use_id` carried by a PreToolUse `route.selected` receipt; the evidence
 * is what `joinRouteBinds` and `joinSpawnOutcomes` already derived from the
 * same lines.
 *
 * -- WHAT THIS SUITE CANNOT SEE (repo rules section 9) ----------------------
 *   - ZERO LIVE LINES. Every row below is hand-built in the key layout the
 *     `route-bind` and `spawn-outcome` suites pin. Nothing here says what the
 *     live label distribution IS.
 *   - FIXTURE SCALE. The shared fixture is 13 Actions, built so every counter
 *     has a hand-checkable value. The one live count recorded in
 *     `replay-label.js`'s header was 380 Actions over 8,367 events, and its
 *     shape is nothing like this one's (305 of its 308 SIMULATED rows are a
 *     single reason). Nothing here says anything about the fold at ledger
 *     size, about read cost, or about the live distribution.
 *   - WHETHER A BOUND PAIR IS THE RIGHT PAIR. `route-bind.js` CANNOT SEE #1:
 *     a wrong receipt bound to a spawn is indistinguishable from a right one,
 *     here and there.
 *   - WHETHER EXACT IS UNREACHABLE. That no writer path can put two
 *     independent spawns under one `action_id` is a claim about
 *     `route-observe-pre.js` and `subagent-handler.js`, not something this
 *     suite measures. It pins only that the fold declares the constant and
 *     never emits the label.
 *
 * @module tests/replay/replay-label
 */

import { describe, expect, it } from 'vitest';
import {
  EXACT_UNREACHABLE_REASON,
  labelReplay,
  REPLAY_LABEL_REASONS,
  REPLAY_LABELS,
} from '../../lib/replay/index.js';

const MISSION = 'M-20260921-026';
const SESS_A = 'sess-a';
const SESS_B = 'sess-b';
const OPUS = 'claude-opus-5';
const FABLE = 'claude-fable-5-1';

let seqCounter = 0;

/** The `method` the writer pairs with each confidence tier. */
const METHOD_BY_CONFIDENCE = Object.freeze({
  exact: 'prompt_id+name',
  name: 'name-only',
  fifo: 'prompt_id+fifo',
});

/**
 * A PreToolUse `route.selected` receipt, in the layout `route-observe-pre.js`
 * writes (`routing_epoch_id` = `action_id` = the host's `tool_use_id`, and
 * `data.shadow_of` under the `tool_use:` prefix).
 *
 * @param {object} spec - tool_use_id, session and the shadow prefix override.
 * @returns {object} ledger line.
 */
function selected(spec) {
  const { toolUseId, session = SESS_A, shadowOf = `tool_use:${spec.toolUseId}` } = spec;
  seqCounter += 1;
  return {
    v: 1,
    ts: '2026-09-21T01:00:00.000Z',
    event: 'route.selected',
    session_id: session,
    mission_id: MISSION,
    source: 'hook',
    pid: 4242,
    seq: seqCounter,
    routing_epoch_id: toolUseId,
    action_id: toolUseId,
    worker: 'main',
    data: { shadow_of: shadowOf, action: { type: 'implement' } },
  };
}

/**
 * A `route.bound` row, in the layout `subagent-handler.js#bindRoute` writes.
 *
 * @param {object} spec - agent_id, tool_use_id, confidence and the model columns.
 * @returns {object} ledger line.
 */
function bound(spec) {
  const {
    agentId, toolUseId, session = SESS_A, confidence = 'exact', recommended, selectedModel,
  } = spec;
  seqCounter += 1;
  return {
    v: 1,
    ts: '2026-09-21T01:01:00.000Z',
    event: 'route.bound',
    session_id: session,
    mission_id: MISSION,
    source: 'hook',
    pid: 4242,
    seq: seqCounter,
    routing_epoch_id: agentId,
    run_id: agentId,
    action_id: toolUseId,
    data: {
      tool_use_id: toolUseId,
      agent_id: agentId,
      ...(confidence === null ? {} : { confidence }),
      method: METHOD_BY_CONFIDENCE[confidence] ?? 'name-only',
      matched_on: 'name',
      agent_type: 'code-reviewer',
      ...(selectedModel === undefined ? {} : { selected_model: selectedModel }),
      ...(recommended === undefined ? {} : { recommended_model: recommended }),
      action_class: 'implement',
    },
  };
}

/**
 * A subagent `usage.receipt` row (`run_id` = `agent-<agentId>`).
 *
 * `omitModel` drops BOTH model spellings, which is how a receipt reaches the
 * fold with no served model at all.
 *
 * @param {string} agentId - the spawn this receipt belongs to.
 * @param {object} spec - served model, usage source and the model override.
 * @returns {object} ledger line.
 */
function agentReceipt(agentId, spec = {}) {
  const {
    model = OPUS, source = 'transcript', session = SESS_A, omitModel = false,
  } = spec;
  seqCounter += 1;
  return {
    v: 1,
    ts: `2026-09-21T01:05:${String(seqCounter % 60).padStart(2, '0')}.000Z`,
    event: 'usage.receipt',
    session_id: session,
    mission_id: MISSION,
    source: 'hook',
    pid: 4242,
    seq: seqCounter,
    run_id: `agent-${agentId}`,
    ...(omitModel ? {} : { model }),
    idempotency_key: `usage.receipt:${session}:agent-${agentId}:${model}`,
    data: {
      schema_version: 1,
      run_id: `agent-${agentId}`,
      mission_id: MISSION,
      ...(omitModel ? {} : {
        model_identity: {
          provider: 'anthropic',
          family: 'claude',
          tier: 'high',
          model_id: model,
          version: '1',
          catalog_version: '5',
        },
      }),
      usage: {
        source,
        fresh_input_tokens: 100,
        cached_input_tokens: 200,
        cache_creation_tokens: 300,
        output_tokens: 40,
      },
      timing: { latency_ms: 1000 },
      outcome: { status: 'unknown', accepted: null },
      cost: { total: 0.5, pricing_version: 'pv-1' },
    },
  };
}

/**
 * A `route.bound` row carrying NO `tool_use_id`.
 *
 * The two upstream folds disagree about this line, which is the whole point:
 * `route-bind.js#bindOf` needs BOTH join keys and drops it as malformed, while
 * `spawn-outcome.js#bindOf` needs only `agent_id` and keeps it -- and
 * `#collect` is first-wins in INPUT order, so whichever of the agent's binds
 * arrives first decides that agent's pair.
 *
 * @param {object} spec - the same spec `bound` takes.
 * @returns {object} ledger line.
 */
function boundWithoutToolUse(spec) {
  const line = bound(spec);
  const data = { ...line.data };
  delete data.tool_use_id;
  return { ...line, data };
}

/**
 * One Action's three lines: receipt, bind, and the spawn's usage receipts.
 *
 * @param {object} spec - `toolUseId`, `agentId` and the per-line overrides.
 * @returns {object[]} ledger lines in write order.
 */
function action(spec) {
  const { toolUseId, agentId, session = SESS_A, bind: bindSpec = {}, receipts = [{}] } = spec;
  return [
    selected({ toolUseId, session }),
    ...(agentId === null ? [] : [bound({ agentId, toolUseId, session, ...bindSpec })]),
    ...(agentId === null ? [] : receipts.map((r) => agentReceipt(agentId, { session, ...r }))),
  ];
}

/**
 * Deterministic shuffle (the `spawn-outcome` suite's permutation).
 *
 * @param {object[]} arr - lines in write order.
 * @returns {object[]} the same lines, reordered.
 */
function shuffled(arr) {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = (i * 7919) % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * The shared fixture: one Action per label outcome, NO duplicate key anywhere.
 *
 * The duplicate cases live in their own `describe` for the reason the
 * `spawn-outcome` suite documents at its shuffle test: first-wins is defined
 * over INPUT order, so a fixture carrying a duplicate `tool_use_id` or
 * `agent_id` cannot be shuffled and still serialize identically. Keep this
 * builder duplicate-free.
 *
 * @returns {object[]} ledger lines in write order.
 */
function fixture() {
  return [
    // PARTIAL -- the two allowlisted confidences.
    ...action({ toolUseId: 'toolu_p1', agentId: 'ag-p1', bind: { recommended: OPUS } }),
    ...action({
      toolUseId: 'toolu_p2', agentId: 'ag-p2', bind: { confidence: 'name', recommended: FABLE },
      receipts: [{ model: FABLE }],
    }),
    // PARTIAL -- a mid-run model switch: one run, two served models.
    ...action({
      toolUseId: 'toolu_p3', agentId: 'ag-p3', bind: { recommended: OPUS },
      receipts: [{ model: OPUS }, { model: FABLE }],
    }),
    ...action({
      toolUseId: 'toolu_p4', agentId: 'ag-p4', session: SESS_B, bind: { recommended: FABLE },
      receipts: [{ model: FABLE, source: 'otlp' }, { model: OPUS, source: 'otlp' }],
    }),
    // SIMULATED -- a receipt no bind ever named.
    ...action({ toolUseId: 'toolu_s1', agentId: null }),
    // SIMULATED -- bound, but the spawn wrote no usage receipt.
    ...action({ toolUseId: 'toolu_s2', agentId: 'ag-s2', bind: { recommended: OPUS }, receipts: [] }),
    // SIMULATED -- the three confidence exclusions.
    ...action({
      toolUseId: 'toolu_s3', agentId: 'ag-s3', bind: { confidence: 'fifo', recommended: OPUS },
    }),
    ...action({
      toolUseId: 'toolu_s4', agentId: 'ag-s4', bind: { confidence: null, recommended: OPUS },
    }),
    ...action({
      toolUseId: 'toolu_s5', agentId: 'ag-s5', bind: { confidence: 'tier-4', recommended: OPUS },
    }),
    // SIMULATED -- bound and compared-eligible, but the router named no model.
    ...action({ toolUseId: 'toolu_s6', agentId: 'ag-s6' }),
    // SIMULATED -- a receipt carrying no readable served model.
    ...action({
      toolUseId: 'toolu_s7', agentId: 'ag-s7', bind: { recommended: OPUS },
      receipts: [{ omitModel: true }],
    }),
    // SIMULATED -- estimate-grade usage cannot be graded (section 46).
    ...action({
      toolUseId: 'toolu_s8', agentId: 'ag-s8', bind: { recommended: OPUS },
      receipts: [{ source: 'estimate' }],
    }),
    // SIMULATED *and* multi-model: a fifo guess whose run switched model.
    // `multi_model_runs` describes the JOINED population, so this row counts
    // there while being graded SIMULATED here.
    ...action({
      toolUseId: 'toolu_s9', agentId: 'ag-s9', bind: { confidence: 'fifo', recommended: OPUS },
      receipts: [{ model: OPUS }, { model: FABLE }],
    }),
  ];
}

/**
 * The row for one `tool_use_id`.
 *
 * @param {object} out - `labelReplay` result.
 * @param {string} toolUseId - the Action key.
 * @returns {object|undefined} that row.
 */
function row(out, toolUseId) {
  return out.rows.find((r) => r.tool_use_id === toolUseId);
}

describe('labelReplay() grades a bound, receipted Action PARTIAL', () => {
  const f = labelReplay(fixture());

  it('labels an exact-confidence Action PARTIAL with a single-run reason', () => {
    expect(row(f, 'toolu_p1')).toEqual({
      tool_use_id: 'toolu_p1',
      agent_id: 'ag-p1',
      session_id: SESS_A,
      label: 'PARTIAL',
      reason: REPLAY_LABEL_REASONS.SINGLE_RUN_RESULT,
    });
  });

  it('labels a name-confidence Action PARTIAL too (both allowlisted tiers)', () => {
    expect(row(f, 'toolu_p2').label).toBe('PARTIAL');
    expect(row(f, 'toolu_p2').reason).toBe(REPLAY_LABEL_REASONS.SINGLE_RUN_RESULT);
  });

  it('accepts otlp usage beside transcript usage', () => {
    expect(row(f, 'toolu_p4').label).toBe('PARTIAL');
  });
});

describe('a multi-model run stays PARTIAL and never becomes EXACT', () => {
  const f = labelReplay(fixture());

  it('labels a two-model run PARTIAL with the multi-model reason', () => {
    // Section 46's EXACT needs several model results for the same ACTION. A
    // mid-run switch is ONE run that happened to serve twice, so promoting it
    // would present a mid-run artefact as a counterfactual.
    for (const id of ['toolu_p3', 'toolu_p4']) {
      expect(row(f, id).label).toBe('PARTIAL');
      expect(row(f, id).reason).toBe(REPLAY_LABEL_REASONS.MULTI_MODEL_SINGLE_RUN);
    }
  });

  it('counts every multi-model run, SIMULATED ones included', () => {
    // `multi_model_runs` describes the JOINED population, not the graded-
    // PARTIAL one. A counter that skipped SIMULATED rows would under-report
    // mid-run switches exactly where the evidence is weakest.
    expect(f.multi_model_runs).toBe(3);
    expect(row(f, 'toolu_s9').label).toBe('SIMULATED');
    expect(row(f, 'toolu_s9').reason).toBe(REPLAY_LABEL_REASONS.FIFO_JOIN);
    expect(f.rows.filter((r) => r.label === 'PARTIAL')).toHaveLength(4);
  });

  it('still reports EXACT as 0 with three multi-model runs (negative control)', () => {
    expect(f.by_label.EXACT).toBe(0);
    expect(f.rows.some((r) => r.label === 'EXACT')).toBe(false);
  });

  it('declares EXACT structurally unreachable rather than silently absent', () => {
    expect(f.exact_reachable).toBe(false);
    expect(f.exact_unreachable_reason).toBe(EXACT_UNREACHABLE_REASON);
    expect(EXACT_UNREACHABLE_REASON).toBe('one-action-one-run');
  });
});

describe('every SIMULATED reason is reachable and named', () => {
  const f = labelReplay(fixture());

  /**
   * Assert one Action's label and reason.
   *
   * @param {string} toolUseId - the Action key.
   * @param {string} reason - the expected reason.
   * @returns {void}
   */
  const simulated = (toolUseId, reason) => {
    expect(row(f, toolUseId).label).toBe('SIMULATED');
    expect(row(f, toolUseId).reason).toBe(reason);
  };

  it('a receipt no bind named is unbound-receipt', () => {
    simulated('toolu_s1', REPLAY_LABEL_REASONS.UNBOUND_RECEIPT);
    expect(row(f, 'toolu_s1').agent_id).toBeNull();
  });

  it('a bound spawn with no usage receipt is no-usage-receipt', () => {
    simulated('toolu_s2', REPLAY_LABEL_REASONS.NO_USAGE_RECEIPT);
  });

  it('a fifo bind is SIMULATED, NOT promoted to PARTIAL', () => {
    // A tier-3 FIFO bind is a guess (`route-bind.js` CANNOT SEE #1). It has a
    // receipt and a recommendation, so everything except the confidence gate
    // says PARTIAL -- which is exactly why this assertion is explicit.
    const r = row(f, 'toolu_s3');
    expect(r.label).toBe('SIMULATED');
    expect(r.label).not.toBe('PARTIAL');
    expect(r.reason).toBe(REPLAY_LABEL_REASONS.FIFO_JOIN);
    expect(REPLAY_LABEL_REASONS.FIFO_JOIN).toBe('fifo-join');
  });

  it('a bind with no confidence is confidence-missing', () => {
    simulated('toolu_s4', REPLAY_LABEL_REASONS.CONFIDENCE_MISSING);
  });

  it('a confidence outside the allowlist is confidence-unlisted (fail-closed)', () => {
    // A tier added to `bindRoute` tomorrow lands here, not in PARTIAL.
    simulated('toolu_s5', REPLAY_LABEL_REASONS.CONFIDENCE_UNLISTED);
  });

  it('a bind with no recommended_model is no-recommendation', () => {
    simulated('toolu_s6', REPLAY_LABEL_REASONS.NO_RECOMMENDATION);
  });

  it('a receipt with no readable model id is no-served-model', () => {
    simulated('toolu_s7', REPLAY_LABEL_REASONS.NO_SERVED_MODEL);
  });

  it('estimate-grade usage is unmeasured-usage, even when the models agree', () => {
    // The schema's own words (`attempt-receipt.schema.json` usage.source):
    // "an unlabelled receipt cannot be graded EXACT/PARTIAL/SIMULATED".
    simulated('toolu_s8', REPLAY_LABEL_REASONS.UNMEASURED_USAGE);
  });

  it('an ABSENT usage.source is unmeasured-usage too (allowlist, not deny-list)', () => {
    // A deny-list spelled `source === 'estimate'` passes every assertion above
    // and lets an unlabelled receipt through. The schema calls `source`
    // mandatory precisely because an unlabelled receipt cannot be graded.
    const lines = action({
      toolUseId: 'toolu_u1', agentId: 'ag-u1', bind: { recommended: OPUS }, receipts: [],
    });
    const r = agentReceipt('ag-u1');
    delete r.data.usage.source;
    const out = labelReplay([...lines, r]);
    expect(out.rows[0].label).toBe('SIMULATED');
    expect(out.rows[0].reason).toBe(REPLAY_LABEL_REASONS.UNMEASURED_USAGE);
  });

  it('an UNKNOWN usage.source is unmeasured-usage (a fourth source fails closed)', () => {
    // A source added to the writer tomorrow is excluded until someone decides
    // it counts -- it does not silently enter the measured population.
    const lines = action({
      toolUseId: 'toolu_u2', agentId: 'ag-u2', bind: { recommended: OPUS },
      receipts: [{ source: 'billing-api' }],
    });
    const out = labelReplay(lines);
    expect(out.rows[0].label).toBe('SIMULATED');
    expect(out.rows[0].reason).toBe(REPLAY_LABEL_REASONS.UNMEASURED_USAGE);
  });

  it('a non-allowlisted confidence AND a missing recommendation reports the LATTER', () => {
    // Both causes hold at once. The reason ladder is a CONTRACT, not an
    // accident of branch order: `no-recommendation` is evaluated before the
    // by-elimination `confidence-unlisted`, so the row names the cause this
    // module can prove directly rather than the one it infers.
    const out = labelReplay(action({
      toolUseId: 'toolu_u3', agentId: 'ag-u3', bind: { confidence: 'tier-4' },
    }));
    expect(out.rows[0].label).toBe('SIMULATED');
    expect(out.rows[0].reason).toBe(REPLAY_LABEL_REASONS.NO_RECOMMENDATION);
  });

  it('a conflicted bind is bind-conflict', () => {
    // Two binds naming ONE tool_use_id: invariant 1 broke on the writer side.
    const lines = [
      selected({ toolUseId: 'toolu_c1' }),
      bound({ agentId: 'ag-c1', toolUseId: 'toolu_c1', recommended: OPUS }),
      bound({ agentId: 'ag-c2', toolUseId: 'toolu_c1', recommended: OPUS }),
      agentReceipt('ag-c1'),
      agentReceipt('ag-c2'),
    ];
    const out = labelReplay(lines);
    expect(out.actions).toBe(1);
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0].label).toBe('SIMULATED');
    expect(out.rows[0].reason).toBe(REPLAY_LABEL_REASONS.BIND_CONFLICT);
    expect(out.conflicts).toBeGreaterThan(0);
  });

  it('covers eight of the ten SIMULATED reasons in one ledger', () => {
    // Without this, a reason could quietly stop being produced and each
    // individual assertion above would still be satisfiable by some other row.
    const produced = new Set(f.rows.filter((r) => r.label === 'SIMULATED').map((r) => r.reason));
    expect([...produced].sort()).toEqual([
      'confidence-missing', 'confidence-unlisted', 'fifo-join', 'no-recommendation',
      'no-served-model', 'no-usage-receipt', 'unbound-receipt', 'unmeasured-usage',
    ]);
    // The two absentees each need a REPEATED key, which this fixture must not
    // carry (the shuffle test reads it). Both are pinned in their own tests.
    expect(Object.values(REPLAY_LABEL_REASONS)).toContain('bind-conflict');
    expect(Object.values(REPLAY_LABEL_REASONS)).toContain('pair-bind-mismatch');
  });

  it('the reason map is the full vocabulary: ten SIMULATED plus two PARTIAL', () => {
    // The map's ORDER is the evaluation order, and its SIZE is the claim the
    // header makes. A reason added without updating either drifts silently.
    const all = Object.values(REPLAY_LABEL_REASONS);
    expect(all).toHaveLength(12);
    expect(all.slice(-2)).toEqual(['single-run-result', 'multi-model-single-run']);
    expect(new Set(all).size).toBe(all.length);
  });
});

describe('a pair built from a DIFFERENT bind is not evidence for this Action', () => {
  // The two upstream folds keep different bind populations, so the pair an
  // agent id resolves to is not always the pair of the bind that named THIS
  // Action. Grading from the wrong bind is fail-OPEN: it reads that bind's
  // confidence and recommendation, so a tier-3 guess can arrive wearing a
  // tier-1 confidence and be graded PARTIAL.
  const sel = selected({ toolUseId: 'toolu_x1' });
  const keyless = boundWithoutToolUse({
    agentId: 'ag-x1', toolUseId: 'toolu_x1', confidence: 'exact', recommended: OPUS,
  });
  const real = bound({
    agentId: 'ag-x1', toolUseId: 'toolu_x1', confidence: 'fifo', recommended: OPUS,
  });
  const used = agentReceipt('ag-x1');

  it('refuses the pair when the keyless bind is seen FIRST', () => {
    const out = labelReplay([sel, keyless, real, used]);
    expect(out.rows[0].label).toBe('SIMULATED');
    expect(out.rows[0].reason).toBe(REPLAY_LABEL_REASONS.PAIR_BIND_MISMATCH);
    // The class is NOT visible as a conflict: route-bind saw one usable bind
    // for this Action, so invariant 1 never broke. It surfaces here and in
    // `unlabeled.malformed_binds`.
    expect(out.conflicts).toBe(0);
    expect(out.unlabeled.malformed_binds).toBe(1);
  });

  it('grades the same LABEL when the real bind is seen FIRST', () => {
    const out = labelReplay([sel, real, keyless, used]);
    expect(out.rows[0].label).toBe('SIMULATED');
    // The REASON legitimately differs: here the pair IS this bind's pair, so
    // the grade comes from the right evidence and the fifo gate is what
    // excludes it. The LABEL is what must not move with input order.
    expect(out.rows[0].reason).toBe(REPLAY_LABEL_REASONS.FIFO_JOIN);
  });

  it('never grades either order PARTIAL (the fail-open this pins)', () => {
    for (const order of [[sel, keyless, real, used], [sel, real, keyless, used]]) {
      expect(labelReplay(order).by_label.PARTIAL).toBe(0);
      expect(labelReplay(order).by_label.SIMULATED).toBe(1);
    }
  });
});

describe('the usage-source sweep reads the same run_id as the upstream fold', () => {
  it('a MAIN-THREAD estimate receipt disqualifies no Action', () => {
    // `run_id` without the `agent-` prefix is a main-thread run
    // (`spawn-outcome.js` AGENT_RUN_PREFIX): it joins no spawn, so its usage
    // grade is not evidence about anybody's Action. Without this, a single
    // estimate-graded main-thread receipt could be read as poisoning the run.
    const main = agentReceipt('ag-main', { source: 'estimate' });
    const lines = [
      ...action({ toolUseId: 'toolu_m1', agentId: 'ag-m1', bind: { recommended: OPUS } }),
      { ...main, run_id: 'sess-a', data: { ...main.data, run_id: 'sess-a' } },
    ];
    const out = labelReplay(lines);
    expect(out.rows[0].label).toBe('PARTIAL');
    expect(out.rows[0].reason).toBe(REPLAY_LABEL_REASONS.SINGLE_RUN_RESULT);
  });

  it('falls back to data.run_id when the envelope carries none', () => {
    // Same precedence as `spawn-outcome.js#collect`: envelope first, then
    // `data.run_id`. A receipt reachable by one reading and not the other
    // would make the label disagree with the pair it was derived from.
    const r = agentReceipt('ag-m2', { source: 'estimate' });
    delete r.run_id;
    const lines = [
      ...action({ toolUseId: 'toolu_m2', agentId: 'ag-m2', bind: { recommended: OPUS }, receipts: [] }),
      r,
    ];
    const out = labelReplay(lines);
    expect(out.rows[0].label).toBe('SIMULATED');
    expect(out.rows[0].reason).toBe(REPLAY_LABEL_REASONS.UNMEASURED_USAGE);
  });

  it('normalises a missing session_id to null rather than dropping the row', () => {
    const lines = action({ toolUseId: 'toolu_m3', agentId: 'ag-m3', bind: { recommended: OPUS } })
      .map((e) => {
        const copy = { ...e };
        delete copy.session_id;
        return copy;
      });
    const out = labelReplay(lines);
    expect(out.actions).toBe(1);
    expect(out.rows[0].session_id).toBeNull();
    expect(out.rows[0].label).toBe('PARTIAL');
  });
});

describe('an empty denominator is UNMEASURED, never 0', () => {
  it('reports three null labels and a reason for an empty ledger', () => {
    const f = labelReplay([]);
    expect(f.actions).toBe(0);
    expect(f.by_label).toEqual({ EXACT: null, PARTIAL: null, SIMULATED: null });
    expect(f.by_label_reason).toBe('no-actions');
    expect(f.rows).toEqual([]);
    expect(f.by_reason).toEqual({});
  });

  it('reads a non-array as an empty ledger', () => {
    for (const bad of [null, undefined, 'events', 42, { events: [] }]) {
      expect(labelReplay(bad).by_label).toEqual({ EXACT: null, PARTIAL: null, SIMULATED: null });
      expect(labelReplay(bad).actions).toBe(0);
    }
  });

  it('counts a pre-4.55 receipt outside the denominator', () => {
    // `data.shadow_of` under the retired `spawn:` prefix can never bind, so it
    // is not an Action this fold can grade -- and saying so is different from
    // grading it SIMULATED.
    const f = labelReplay([selected({ toolUseId: 'toolu_old', shadowOf: 'spawn:ag-old' })]);
    expect(f.actions).toBe(0);
    expect(f.unlabeled.pre_tool_use_only).toBe(1);
    expect(f.by_label_reason).toBe('no-actions');
  });

  it('counts an orphan bind and a malformed bind outside the denominator', () => {
    const f = labelReplay([
      bound({ agentId: 'ag-orphan', toolUseId: 'toolu_gone', recommended: OPUS }),
      { ...bound({ agentId: 'ag-bad', toolUseId: 'toolu_bad' }), data: { agent_id: 'ag-bad' } },
    ]);
    expect(f.actions).toBe(0);
    expect(f.unlabeled.orphan_binds).toBe(1);
    expect(f.unlabeled.malformed_binds).toBe(1);
  });

  it('keeps the same key order with and without a denominator', () => {
    // A shape that changes with the data is the "which keys exist" failure the
    // route-compare CLI suite warns about.
    const empty = labelReplay([]);
    const full = labelReplay(fixture());
    expect(Object.keys(full)).toEqual(Object.keys(empty));
    expect(Object.keys(full.by_label)).toEqual(Object.keys(empty.by_label));
    expect(Object.keys(full.unlabeled)).toEqual(Object.keys(empty.unlabeled));
    expect(Object.keys(empty.by_label)).toEqual([...REPLAY_LABELS]);
  });
});

describe('the counters partition the denominator', () => {
  const f = labelReplay(fixture());

  it('by_label sums to actions and to rows.length', () => {
    expect(f.actions).toBe(13);
    expect(f.rows).toHaveLength(f.actions);
    expect(f.by_label.EXACT + f.by_label.PARTIAL + f.by_label.SIMULATED).toBe(f.actions);
    expect(f.by_label_reason).toBeNull();
  });

  it('by_reason sums to actions and is key-sorted', () => {
    const total = Object.values(f.by_reason).reduce((a, b) => a + b, 0);
    expect(total).toBe(f.actions);
    expect(Object.keys(f.by_reason)).toEqual([...Object.keys(f.by_reason)].sort());
  });

  it('rows are sorted by session then tool_use_id', () => {
    const keys = f.rows.map((r) => `${r.session_id}\u0000${r.tool_use_id}`);
    expect(keys).toEqual([...keys].sort());
  });

  it('every row carries a label from the frozen vocabulary', () => {
    expect(Object.isFrozen(REPLAY_LABELS)).toBe(true);
    expect([...REPLAY_LABELS]).toEqual(['EXACT', 'PARTIAL', 'SIMULATED']);
    for (const r of f.rows) expect(REPLAY_LABELS).toContain(r.label);
  });
});

describe('labelReplay() is order-independent and non-mutating', () => {
  it('serializes a shuffled input identically', () => {
    // Duplicate-free fixture only: first-wins is defined over INPUT order, so
    // a duplicated key would legitimately move under a shuffle -- the same
    // caveat `tests/replay/spawn-outcome.test.js` records at its shuffle test.
    const rows = fixture();
    expect(JSON.stringify(labelReplay(shuffled(rows))))
      .toBe(JSON.stringify(labelReplay(rows)));
  });

  it('does not mutate the caller\'s events', () => {
    const rows = fixture().map((e) => Object.freeze(e));
    Object.freeze(rows);
    expect(() => labelReplay(rows)).not.toThrow();
    expect(labelReplay(rows).actions).toBe(13);
  });
});

describe('duplicate keys are counted, not graded away', () => {
  it('keeps one row per tool_use_id when a receipt is written twice', () => {
    const lines = [
      selected({ toolUseId: 'toolu_d1' }),
      selected({ toolUseId: 'toolu_d1' }),
      bound({ agentId: 'ag-d1', toolUseId: 'toolu_d1', recommended: OPUS }),
      agentReceipt('ag-d1'),
    ];
    const out = labelReplay(lines);
    expect(out.actions).toBe(1);
    expect(out.rows).toHaveLength(1);
    expect(out.conflicts).toBe(1);
    expect(out.rows[0].reason).toBe(REPLAY_LABEL_REASONS.BIND_CONFLICT);
  });

  it('keeps one row when one agent is bound to two Actions', () => {
    const lines = [
      selected({ toolUseId: 'toolu_d2' }),
      selected({ toolUseId: 'toolu_d3' }),
      bound({ agentId: 'ag-d2', toolUseId: 'toolu_d2', recommended: OPUS }),
      bound({ agentId: 'ag-d2', toolUseId: 'toolu_d3', recommended: OPUS }),
      agentReceipt('ag-d2'),
    ];
    const out = labelReplay(lines);
    expect(out.actions).toBe(2);
    expect(out.rows).toHaveLength(2);
    expect(out.conflicts).toBe(1);
    expect(out.rows.every((r) => r.reason === REPLAY_LABEL_REASONS.BIND_CONFLICT)).toBe(true);
    expect(out.by_label.SIMULATED).toBe(2);
  });
});

describe('the replay barrel', () => {
  it('exports the fold, the label vocabulary and the unreachability constant', () => {
    expect(typeof labelReplay).toBe('function');
    expect([...REPLAY_LABELS]).toEqual(['EXACT', 'PARTIAL', 'SIMULATED']);
    expect(EXACT_UNREACHABLE_REASON).toBe('one-action-one-run');
    expect(Object.isFrozen(REPLAY_LABEL_REASONS)).toBe(true);
  });
});
