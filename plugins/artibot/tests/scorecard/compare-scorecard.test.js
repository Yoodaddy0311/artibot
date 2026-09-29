/**
 * Unit contract for the compare card (`lib/scorecard/compare-scorecard.js`).
 *
 * The card folds `lib/replay/spawn-outcome.js#joinSpawnOutcomes`'s OUTPUT into
 * the §34/§35 metric rows. The fixtures therefore build RAW `route.bound` and
 * `usage.receipt` ledger lines and run them through the real fold — a
 * hand-written fold object would let the card agree with a shape no writer
 * produces (the batch brief's "writer-true" requirement).
 *
 * THE MAIN FIXTURE'S SHAPE IS COPIED FROM A LIVE MEASUREMENT. ITS NUMBERS ARE
 * NOT LIVE NUMBERS. The proportions (291 binds, 42 joined pairs all at
 * confidence `exact`, 37 agreeing, 5 diverging opus→fable, 249 binds with no
 * receipt, 34 receipt-only agents) follow the sh05 draft §1·§2④⑤ reading of the
 * parent ledger at 2026-09-17. Every LINE below is synthesised in that SHAPE;
 * nothing here was read from a ledger, so no assertion in this file says what
 * live agreement IS.
 *
 * ── WHAT THIS SUITE CANNOT SEE (repo rules §9: write it next to the gate) ────
 *   - LIVE VALUES. See above. Shape-true, value-synthetic.
 *   - THE FOLD'S ARITHMETIC. That `joinSpawnOutcomes` counts correctly is
 *     `tests/replay/spawn-outcome.test.js`'s contract. This suite pins the
 *     DENOMINATOR CHOICES the card makes over a given fold.
 *   - A MULTI-MODEL RUN. Every fixture agent writes exactly one receipt, so
 *     `duplicate_receipts` and `multi_model_runs` are 0 and no row reads them.
 *     A row over those counters would need its own fixture.
 *   - READ COST AT LEDGER SIZE. 371 lines in the main fixture. Live at the
 *     measurement was far larger and nothing here speaks to fold cost.
 *   - WHETHER A DIVERGENCE IS A FAULT, or whether excluding a fifo pair is
 *     generous. The fold counts and this card renders; neither judges.
 *   - A MEASURED LABEL ROW ON THE MAIN FIXTURES. Fixtures A–D and the main one
 *     carry no `route.selected` line, so `labelReplay` over them has 0 Actions
 *     and `compare.replay_label` is `unmeasured` there — true to those inputs,
 *     not a stand-in. The measured row is fixture E's, built through the real
 *     `labelReplay`; which grade a given Action earns is
 *     `tests/replay/replay-label.test.js`'s contract, not this suite's.
 *   - A LIVE `review.claim_audit` ROW. None exists to copy a shape from: W1-8
 *     (8ae56c77) measured 0 `review.*` rows on the central ledger at
 *     2026-09-29T04:24Z, and this suite did not re-measure it. The audit rows of
 *     fixtures F and G go through the PRODUCTION writer
 *     (`verdict-writer.js#buildClaimAuditEvent`), so their `data` keys are
 *     writer-true, but every count and every id is synthetic: nothing here says
 *     what a reviewer really writes or what a live pass rate is. Which audits
 *     join and what the rate is stays `tests/replay/spawn-outcome.test.js` and
 *     `claim-audit-join.test.js`'s contract; this suite pins how the CARD prints
 *     a score block the fold has already made.
 *
 * @module tests/scorecard/compare-scorecard
 */

import { describe, expect, it } from 'vitest';
import {
  CLAIM_AUDIT_JOIN_EVENTS,
  EXACT_UNREACHABLE_REASON,
  joinSpawnOutcomes,
  labelReplay,
  REPLAY_LABELS,
  SCORE_EMPTY_DENOMINATOR_REASON,
  SCORE_NO_JOINED_AUDIT_REASON,
  SCORE_UNAVAILABLE_REASON,
} from '../../lib/replay/index.js';
import { buildClaimAuditEvent } from '../../lib/review/verdict-writer.js';
import { buildCompareScorecard, COMPARE_KIND } from '../../lib/scorecard/compare-scorecard.js';
import { renderScorecardMarkdown } from '../../lib/scorecard/render.js';
import * as barrel from '../../lib/scorecard/index.js';

const MISSION = 'M-20260921-002';
const SESS = 'sess-compare';
const OPUS = 'claude-opus-5';
const FABLE = 'claude-fable-5-1';

/** The writer pairs one `method` with each confidence tier (enum of four). */
const METHOD_BY_CONFIDENCE = Object.freeze({
  exact: 'prompt_id+name',
  name: 'name-only',
  fifo: 'prompt_id+fifo',
});

let seq = 0;

/**
 * A `route.bound` row in the live envelope key order.
 *
 * @param {object} spec - agentId, confidence, recommended, selected.
 * @returns {object} ledger line.
 */
function bound(spec) {
  const { agentId, confidence = 'exact', recommended, selected = 'high' } = spec;
  seq += 1;
  return {
    v: 1,
    ts: '2026-09-21T01:00:00.000Z',
    event: 'route.bound',
    session_id: SESS,
    source: 'hook',
    pid: 4242,
    seq,
    mission_id: MISSION,
    routing_epoch_id: agentId,
    run_id: agentId,
    action_id: `toolu_${agentId}`,
    data: {
      tool_use_id: `toolu_${agentId}`,
      agent_id: agentId,
      confidence,
      method: METHOD_BY_CONFIDENCE[confidence] ?? 'name-only',
      agent_type: 'code-reviewer',
      matched_on: 'name',
      selected_model: selected,
      ...(recommended === undefined ? {} : { recommended_model: recommended }),
      action_class: 'implement',
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
 * A `usage.receipt` row. `cost: null` is an UNPRICED row — `cost.total` is a
 * number or null, never a string; 'unresolved' lives in `pricing_version`.
 *
 * @param {object} spec - runId, model, cost.
 * @returns {object} ledger line.
 */
function receipt(spec) {
  const { runId, model = OPUS, cost = 0.5 } = spec;
  seq += 1;
  const priced = typeof cost === 'number';
  return {
    v: 1,
    ts: `2026-09-21T01:05:${String(seq % 60).padStart(2, '0')}.000Z`,
    event: 'usage.receipt',
    session_id: SESS,
    source: 'hook',
    pid: 4242,
    seq,
    mission_id: MISSION,
    run_id: runId,
    model,
    idempotency_key: `usage.receipt:${SESS}:${runId}:${model}`,
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
      usage: { ...USAGE },
      timing: {
        started_at: '2026-09-21T01:04:00.000Z',
        completed_at: '2026-09-21T01:05:00.000Z',
        latency_ms: 1000,
      },
      outcome: { status: 'unknown', accepted: null },
      cost: { total: cost, pricing_version: priced ? 'pv-1' : 'unresolved' },
    },
  };
}

/** A subagent receipt: `run_id` carries the `agent-` prefix. */
function agentReceipt(agentId, spec = {}) {
  return receipt({ runId: `agent-${agentId}`, ...spec });
}

/**
 * A bind+receipt pair appended to `out`.
 *
 * @param {object[]} out - accumulator.
 * @param {object} spec - agentId, confidence, recommended, served, cost.
 * @returns {void}
 */
function pushPair(out, spec) {
  const { agentId, confidence = 'exact', recommended, served = OPUS, cost = 0.5 } = spec;
  out.push(bound({ agentId, confidence, recommended }));
  out.push(agentReceipt(agentId, { model: served, cost }));
}

/**
 * The MAIN fixture, in the live SHAPE with synthetic values (see module header).
 *
 * | figure | value | how it is built |
 * |---|---|---|
 * | binds | 291 | 42 paired + 249 receipt-less |
 * | pairs | 42 | all confidence `exact`, all with `recommended_model` |
 * | same | 37 | served fable 16 + served opus 21 |
 * | diverged | 5 | recommended opus → served fable |
 * | priced | 14 | same 12 (@0.5 → 6.0) + diverged 2 (@0.125 → 0.25) |
 * | unjoined_binds | 249 | binds whose run wrote no receipt |
 * | unjoined_receipts | 34 | receipt-only agent ids; 42 + 34 = 76 distinct |
 * | main-thread receipts | 4 | bare `run_id`, in NO denominator |
 *
 * Costs are dyadic (0.5, 0.125) so each bucket total is an EXACT binary sum and
 * the expected figures are arithmetic, not a float-rounding artefact.
 *
 * @returns {object[]} ledger lines in input order.
 */
function mainFixture() {
  seq = 0;
  const out = [];
  let n = 0;
  const pair = (spec) => {
    n += 1;
    pushPair(out, { agentId: `ag-${String(n).padStart(4, '0')}`, ...spec });
  };
  // same, served fable: 16, of which the first 6 are priced.
  for (let i = 0; i < 16; i += 1) {
    pair({ recommended: FABLE, served: FABLE, cost: i < 6 ? 0.5 : null });
  }
  // same, served opus: 21, of which the first 6 are priced.
  for (let i = 0; i < 21; i += 1) {
    pair({ recommended: OPUS, served: OPUS, cost: i < 6 ? 0.5 : null });
  }
  // diverged opus -> fable: 5, of which the first 2 are priced.
  for (let i = 0; i < 5; i += 1) {
    pair({ recommended: OPUS, served: FABLE, cost: i < 2 ? 0.125 : null });
  }
  // 249 binds whose run never wrote a receipt.
  for (let i = 0; i < 249; i += 1) {
    out.push(bound({ agentId: `ub-${String(i).padStart(4, '0')}`, recommended: OPUS }));
  }
  // 34 receipt-only agents: distinct AGENT IDS with no bind.
  for (let i = 0; i < 34; i += 1) {
    out.push(agentReceipt(`ur-${String(i).padStart(4, '0')}`, { model: OPUS, cost: 0.5 }));
  }
  // 4 main-thread receipts: bare run_id, so they join nothing and sit in no
  // denominator — not even the unjoined one.
  for (let i = 0; i < 4; i += 1) {
    out.push(receipt({ runId: `sess-main-${i}`, model: OPUS, cost: 0.5 }));
  }
  return out;
}

/**
 * AUXILIARY fixture A — the exclusion paths the main fixture has none of.
 *
 * Live at the measurement had 0 fifo pairs, so keeping them out of the main
 * fixture keeps that one shape-true; the exclusion arithmetic still needs
 * covering, and it is covered here instead of by distorting the main shape.
 *
 * 11 pairs: 4 compared (2 same, 2 diverged) · 3 fifo · 2 `other` confidence ·
 * 2 exact with NO `recommended_model`.
 *
 * @returns {object[]} ledger lines.
 */
function exclusionFixture() {
  seq = 0;
  const out = [];
  pushPair(out, { agentId: 'ex-01', recommended: OPUS, served: OPUS });
  pushPair(out, { agentId: 'ex-02', recommended: OPUS, served: OPUS });
  pushPair(out, { agentId: 'ex-03', recommended: OPUS, served: FABLE });
  pushPair(out, { agentId: 'ex-04', recommended: OPUS, served: FABLE });
  for (let i = 0; i < 3; i += 1) {
    pushPair(out, {
      agentId: `fi-0${i}`, confidence: 'fifo', recommended: OPUS, served: OPUS,
    });
  }
  // A confidence tier no writer emits today: it must land in `other` AND in
  // excluded_fifo, because the gate is an allowlist, not a deny-list of 'fifo'.
  for (let i = 0; i < 2; i += 1) {
    pushPair(out, {
      agentId: `ot-0${i}`, confidence: 'tier-4-guess', recommended: OPUS, served: OPUS,
    });
  }
  // No recommended_model: excluded, but NOT as excluded_fifo.
  for (let i = 0; i < 2; i += 1) {
    pushPair(out, { agentId: `nr-0${i}`, served: OPUS });
  }
  return out;
}

/**
 * AUXILIARY fixture B — a diverged bucket that is ENTIRELY unpriced.
 *
 * 5 pairs: 3 same and priced (@0.5), 2 diverged and unpriced. So
 * `cost.diverged.priced` is 0 and `cost.diverged.total` is null — the exact
 * condition `spawn-outcome.js` CANNOT SEE #5 exists for, measured live at
 * 2026-09-21T01:31:59Z as a flat `0` reading "the divergences were free".
 *
 * @returns {object[]} ledger lines.
 */
function unpricedDivergenceFixture() {
  seq = 0;
  const out = [];
  for (let i = 0; i < 3; i += 1) {
    pushPair(out, { agentId: `up-s${i}`, recommended: OPUS, served: OPUS, cost: 0.5 });
  }
  for (let i = 0; i < 2; i += 1) {
    pushPair(out, { agentId: `up-d${i}`, recommended: OPUS, served: FABLE, cost: null });
  }
  return out;
}

/**
 * AUXILIARY fixture D — pairs exist but NONE is comparable.
 *
 * 3 fifo pairs + 2 pairs with no `recommended_model`, so `pairs.length` is 5 and
 * `compared` is 0. This is the state where the two denominators of this card
 * genuinely disagree: the confidence row HAS a denominator (5 joined pairs) while
 * the agreement and cost rows have none. A card that printed a histogram of
 * zeroes for the latter two would be reporting "measured, and the answer is
 * none" over a population it never had.
 *
 * @returns {object[]} ledger lines.
 */
function allExcludedFixture() {
  seq = 0;
  const out = [];
  for (let i = 0; i < 3; i += 1) {
    pushPair(out, {
      agentId: `ax-f${i}`, confidence: 'fifo', recommended: OPUS, served: OPUS, cost: 0.5,
    });
  }
  for (let i = 0; i < 2; i += 1) {
    pushPair(out, { agentId: `ax-n${i}`, served: OPUS, cost: 0.5 });
  }
  return out;
}

/**
 * AUXILIARY fixture C — 42 pairs MIXED across every shape at once.
 *
 * The main fixture is shape-true to one live reading and therefore has 0 fifo
 * pairs, 0 `name` binds and one uniform confidence. This one is deliberately
 * NOT live-shaped: it is the coverage fixture, and it is the only place where
 * `by_confidence.name` is non-zero, where excluded and unjoined populations
 * appear together, and where both agreement buckets carry priced AND unpriced
 * pairs. Its arithmetic is the cross-check on the main fixture's denominators —
 * two independently built folds, the same eight denominator rules.
 *
 * | group | n | confidence | agreement | cost |
 * |---|---|---|---|---|
 * | G1 | 14 | exact | same | 0.5 |
 * | G2 |  4 | exact | same | unpriced |
 * | G3 |  6 | exact | diverged | 0.125 |
 * | G4 |  3 | name | diverged | unpriced |
 * | G5 |  5 | name | same | 0.25 |
 * | G6 |  6 | fifo | excluded (agrees) | 0.5 |
 * | G7 |  4 | exact, no recommended_model | excluded | 0.5 |
 *
 * Plus 5 receipt-less binds, 3 receipt-only agents, 2 main-thread receipts.
 *
 * @returns {object[]} ledger lines.
 */
function mixedFixture() {
  seq = 0;
  const out = [];
  let n = 0;
  const run = (count, spec) => {
    for (let i = 0; i < count; i += 1) {
      n += 1;
      pushPair(out, { agentId: `mx-${String(n).padStart(3, '0')}`, ...spec });
    }
  };
  run(14, { recommended: OPUS, served: OPUS, cost: 0.5 });
  run(4, { recommended: OPUS, served: OPUS, cost: null });
  run(6, { recommended: OPUS, served: FABLE, cost: 0.125 });
  run(3, { confidence: 'name', recommended: OPUS, served: FABLE, cost: null });
  run(5, { confidence: 'name', recommended: FABLE, served: FABLE, cost: 0.25 });
  run(6, { confidence: 'fifo', recommended: OPUS, served: OPUS, cost: 0.5 });
  run(4, { served: OPUS, cost: 0.5 });
  for (let i = 0; i < 5; i += 1) {
    out.push(bound({ agentId: `mu-${i}`, recommended: OPUS }));
  }
  for (let i = 0; i < 3; i += 1) {
    out.push(agentReceipt(`mr-${i}`, { model: OPUS, cost: 0.5 }));
  }
  out.push(receipt({ runId: 'sess-mixed-main', model: OPUS, cost: 0.5 }));
  out.push(receipt({ runId: 'sess-mixed-main-b', model: FABLE, cost: 0.25 }));
  return out;
}

/**
 * A deterministic permutation — no `Math.random`, so a failure reproduces.
 *
 * A 32-bit LCG (glibc constants) over a copy, Fisher–Yates downward.
 *
 * @param {object[]} items - input.
 * @param {number} seedValue - seed.
 * @returns {object[]} permuted copy.
 */
function shuffled(items, seedValue) {
  const out = [...items];
  let state = seedValue;
  for (let i = out.length - 1; i > 0; i -= 1) {
    state = (state * 1103515245 + 12345) % 2147483648;
    const j = state % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * A PreToolUse `route.selected` receipt, in the layout `route-observe-pre.js`
 * writes (`routing_epoch_id` = `action_id` = the host's `tool_use_id`,
 * `data.shadow_of` under the `tool_use:` prefix) — the replay-label suite's
 * `selected` builder, keyed to match this file's `bound` (`toolu_<agentId>`).
 *
 * @param {string} toolUseId - the Action key.
 * @returns {object} ledger line.
 */
function routeSelected(toolUseId) {
  seq += 1;
  return {
    v: 1,
    ts: '2026-09-21T00:59:00.000Z',
    event: 'route.selected',
    session_id: SESS,
    mission_id: MISSION,
    source: 'hook',
    pid: 4242,
    seq,
    routing_epoch_id: toolUseId,
    action_id: toolUseId,
    worker: 'main',
    data: { shadow_of: `tool_use:${toolUseId}`, action: { type: 'implement' } },
  };
}

/**
 * AUXILIARY fixture E — routed Actions, so the label row HAS a denominator.
 *
 * 6 Actions: 3 bound + receipted at confidence `exact` with a recommendation and
 * transcript usage (PARTIAL), 2 bound with no receipt (SIMULATED
 * `no-usage-receipt`), 1 receipt that no bind named (SIMULATED
 * `unbound-receipt`). EXACT is 0 because no input can make it anything else.
 *
 * @returns {object[]} ledger lines.
 */
function labelFixture() {
  seq = 0;
  const out = [];
  for (let i = 0; i < 3; i += 1) {
    out.push(routeSelected(`toolu_lf-p${i}`));
    pushPair(out, { agentId: `lf-p${i}`, recommended: OPUS, served: OPUS });
  }
  for (let i = 0; i < 2; i += 1) {
    out.push(routeSelected(`toolu_lf-s${i}`));
    out.push(bound({ agentId: `lf-s${i}`, recommended: OPUS }));
  }
  out.push(routeSelected('toolu_lf-u0'));
  return out;
}

/**
 * A `review.claim_audit` ledger line built through the PRODUCTION writer.
 *
 * `buildClaimAuditEvent` decides which `data` keys exist (the optional
 * `subject_agent_id` is OMITTED, never null), so the audit fixtures below cannot
 * carry a key shape no writer produces. The envelope keys the writer does not
 * own (`v`, `ts`, `pid`, `seq`) are filled in the way the other builders do.
 *
 * @param {object} spec - `total` and `refuted` counts; `subjectId` is optional.
 * @returns {object} ledger line.
 */
function auditRow(spec) {
  const { subjectId, total, refuted } = spec;
  const built = buildClaimAuditEvent({
    parsed: {
      ok: true,
      subject_agent_type: 'tdd-guide',
      claims_total: total,
      claims_refuted: refuted,
      ...(subjectId === undefined ? {} : { subject_agent_id: subjectId }),
    },
    sessionId: SESS,
  });
  if (!built.ok) throw new Error(`fixture: buildClaimAuditEvent refused: ${built.reason}`);
  seq += 1;
  return { v: 1, ts: '2026-09-21T02:00:00.000Z', pid: 4242, seq, ...built.input };
}

/**
 * A `review.claim_audit` row the parser would have refused, assembled by hand
 * (`claims_total` is not an integer) — the only way such a line reaches the
 * fold, which counts it as `malformed_audits` and in no denominator.
 *
 * @returns {object} ledger line.
 */
function malformedAuditRow() {
  seq += 1;
  return {
    v: 1,
    ts: '2026-09-21T02:00:00.000Z',
    event: 'review.claim_audit',
    session_id: SESS,
    source: 'reviewer',
    pid: 4242,
    seq,
    data: { subject_agent_type: 'tdd-guide', claims_total: 'many', claims_refuted: 0 },
  };
}

/**
 * AUXILIARY fixture F — three bound, receipted spawns and NO audit row.
 *
 * Every audit fixture starts from these lines, so `fold.score` is the null
 * block here and the same card without any audit is the baseline the audit
 * fixtures are compared against: the eight rows that do not read `fold.score`
 * must come out identical whatever the score block is.
 *
 * @returns {object[]} ledger lines.
 */
function auditedSpawns() {
  seq = 0;
  const out = [];
  for (const agentId of ['au-01', 'au-02', 'au-03']) {
    pushPair(out, { agentId, recommended: OPUS, served: OPUS });
  }
  return out;
}

/**
 * AUXILIARY fixture G — fixture F plus reviewer audits of every kind.
 *
 * | rows | what | lands in |
 * |---|---|---|
 * | 3 | au-01 10/2 · au-02 5/0 · au-03 5/3 | joined: (20 − 5) ÷ 20 = 0.75 |
 * | 2 | subject ids no spawn bound, 100/100 each | `unjoined_audits` |
 * | 1 | no `subject_agent_id`, 100/100 | `no_subject_audits` |
 * | 1 | hand-assembled, `claims_total` not an integer | `malformed_audits` |
 *
 * The three rows that must NOT reach the rate carry 100/100 on purpose: a sum
 * that leaked them would move 0.75 to a value nobody would mistake for it.
 *
 * @returns {object[]} ledger lines.
 */
function scoredFixture() {
  const out = auditedSpawns();
  out.push(
    auditRow({ subjectId: 'au-01', total: 10, refuted: 2 }),
    auditRow({ subjectId: 'au-02', total: 5, refuted: 0 }),
    auditRow({ subjectId: 'au-03', total: 5, refuted: 3 }),
    auditRow({ subjectId: 'au-never-1', total: 100, refuted: 100 }),
    auditRow({ subjectId: 'au-never-2', total: 100, refuted: 100 }),
    auditRow({ total: 100, refuted: 100 }),
    malformedAuditRow(),
  );
  return out;
}

/**
 * Fixture F plus exactly ONE audit row, by kind. Each of the five is a state
 * the pre-follow-up card threw on (probed with real calls at 2026-09-29T04:58Z).
 */
const SINGLE_AUDIT_KINDS = Object.freeze({
  joined: () => [...auditedSpawns(), auditRow({ subjectId: 'au-01', total: 10, refuted: 2 })],
  'no-subject': () => [...auditedSpawns(), auditRow({ total: 10, refuted: 2 })],
  unjoined: () => [
    ...auditedSpawns(), auditRow({ subjectId: 'au-never-1', total: 10, refuted: 2 }),
  ],
  malformed: () => [...auditedSpawns(), malformedAuditRow()],
  'zero-claims': () => [...auditedSpawns(), auditRow({ subjectId: 'au-01', total: 0, refuted: 0 })],
});

/**
 * Memoise a builder so that a build which THROWS fails the `it` that asked for
 * it, instead of failing the whole `describe` at collection time (which would
 * hide which case broke).
 *
 * @param {() => *} build - builder.
 * @returns {() => *} memoised getter.
 */
function lazily(build) {
  let done = false;
  let value;
  return () => {
    if (!done) {
      value = build();
      done = true;
    }
    return value;
  };
}

/**
 * The card over `events`, with both folds taken from the SAME lines — the
 * wiring `commands/scorecard.md` performs.
 *
 * @param {object[]} events - ledger lines.
 * @param {object} [opts] - extra options (`since`).
 * @returns {Readonly<object>} card.
 */
function cardOf(events, opts = {}) {
  return buildCompareScorecard(joinSpawnOutcomes(events), { ...opts, replay: labelReplay(events) });
}

/** The `compare.score` row of a card — the ONE row the SH-05 follow-up changes. */
const scoreRowOf = (card) => card.metrics.find((m) => m.key === 'compare.score');

/** The eight rows that do not read `fold.score`: they must not depend on it. */
const otherRowsOf = (card) => card.metrics.filter((m) => m.key !== 'compare.score');

const EVENTS = mainFixture();
const FOLD = joinSpawnOutcomes(EVENTS);
const REPLAY = labelReplay(EVENTS);

/** Row keys in render order — the card's shape, asserted as an array. */
const ROW_KEYS = [
  'compare.pairs',
  'compare.agreement',
  'compare.confidence',
  'compare.cost',
  'compare.excluded_fifo',
  'compare.unjoined_binds',
  'compare.unjoined_receipts',
  'compare.replay_label',
  'compare.score',
];

/** Expected row arithmetic over the main fixture. Every figure is hand-derived. */
const EXPECTED = Object.freeze({
  'compare.pairs': { denominator: 291, numerator: 42, counts: null, state: 'measured' },
  'compare.agreement': {
    denominator: 42, numerator: 37, counts: { diverged: 5, same: 37 }, state: 'measured',
  },
  'compare.confidence': {
    denominator: 42,
    numerator: null,
    counts: { exact: 42, fifo: 0, name: 0, other: 0 },
    state: 'measured',
  },
  'compare.cost': {
    denominator: 42,
    numerator: 14,
    counts: { agreed_priced: 12, diverged_priced: 2, unpriced: 28 },
    state: 'measured',
  },
  'compare.excluded_fifo': { denominator: 42, numerator: 0, counts: null, state: 'measured' },
  'compare.unjoined_binds': { denominator: 291, numerator: 249, counts: null, state: 'measured' },
  'compare.unjoined_receipts': {
    denominator: 76, numerator: 34, counts: null, state: 'measured',
  },
  // No `route.selected` line in the main fixture, so 0 Actions (header).
  'compare.replay_label': { denominator: 0, numerator: null, counts: null, state: 'unmeasured' },
  'compare.score': { denominator: 0, numerator: null, counts: null, state: 'unmeasured' },
});

// ---------------------------------------------------------------------------
describe('픽스처 자기검증 — 이 fold 가 라이브 형태대로 접혔는가', () => {
  it('fold 가 291바인드·42쌍·37일치·5갈림으로 접힌다', () => {
    expect(FOLD.binds).toBe(291);
    expect(FOLD.pairs.length).toBe(42);
    expect(FOLD.compared).toBe(42);
    expect(FOLD.by_agreement).toEqual({ same: 37, diverged: 5 });
    expect(FOLD.by_confidence).toEqual({ exact: 42, name: 0, fifo: 0, other: 0 });
    expect(FOLD.unjoined_binds).toBe(249);
    expect(FOLD.unjoined_receipts).toBe(34);
    expect(FOLD.main_thread_receipts).toBe(4);
    expect(FOLD.excluded_fifo).toBe(0);
    expect(FOLD.excluded_no_recommendation).toBe(0);
    expect(FOLD.cost).toEqual({
      compared: 14,
      unpriced: 28,
      same: { priced: 12, total: 6 },
      diverged: { priced: 2, total: 0.25 },
    });
  });

  it('정합성 등식 3건이 성립한다 (수치들이 서로 모순되지 않는가)', () => {
    // 규율 §5: 관측치를 한 블록으로 보고할 때 서로 모순되지 않는지 명시 점검한다.
    expect(FOLD.pairs.length + FOLD.unjoined_binds).toBe(FOLD.binds); // 42 + 249 = 291
    expect(FOLD.pairs.length + FOLD.unjoined_receipts).toBe(76); //    42 +  34 =  76
    expect(FOLD.by_agreement.same + FOLD.by_agreement.diverged) //     37 +   5 =  42
      .toBe(FOLD.pairs.length);
    expect(FOLD.cost.compared + FOLD.cost.unpriced).toBe(FOLD.compared); // 14 + 28 = 42
  });

  it('76 은 영수증을 낸 distinct 서브에이전트 수다 (행 7 분모 등식의 독립 검증)', () => {
    // `collect` buckets subagent receipts by agent id into `byAgent`; a pair is
    // built for every byAgent key a bind also holds, and unjoined_receipts
    // counts the byAgent keys no bind holds. The two partition byAgent, and
    // duplicate_binds cannot break it — a duplicate bind row adds no map entry.
    const distinct = new Set(
      EVENTS.filter((e) => e.event === 'usage.receipt' && e.run_id.startsWith('agent-'))
        .map((e) => e.run_id.slice('agent-'.length)),
    );
    expect(distinct.size).toBe(76);
    expect(FOLD.pairs.length + FOLD.unjoined_receipts).toBe(distinct.size);
  });

  it('메인스레드 영수증 4건은 어느 분모에도 없다', () => {
    expect(FOLD.receipts).toBe(42 + 34 + 4);
    expect(FOLD.subagent_receipts).toBe(76);
    expect(FOLD.main_thread_receipts).toBe(4);
  });
});

// ---------------------------------------------------------------------------
describe('buildCompareScorecard — 행 값과 행 순서', () => {
  const card = buildCompareScorecard(FOLD, { replay: REPLAY });

  it('kind 와 scope 를 싣는다', () => {
    expect(COMPARE_KIND).toBe('compare');
    expect(card.kind).toBe(COMPARE_KIND);
    expect(card.scope).toEqual({ scope: 'index', since: null });
  });

  it('행 키가 이 순서로 고정된다', () => {
    expect(card.metrics.map((m) => m.key)).toEqual(ROW_KEYS);
  });

  it.each(ROW_KEYS)('%s 의 분모·분자·histogram 이 기대값이다', (key) => {
    const row = card.metrics.find((m) => m.key === key);
    expect({
      denominator: row.denominator,
      numerator: row.numerator,
      counts: row.counts,
      state: row.state,
    }).toEqual(EXPECTED[key]);
  });

  it('histogram 키는 정렬돼 있다 (JSON 바이트가 입력 순서를 타지 않게)', () => {
    // confidence 로 본다 — fold 의 삽입 순서는 exact·name·fifo·other 인데 정렬은
    // exact·fifo·name·other 라 두 순서가 다르다. cost 의 세 키는 삽입 순서가 이미
    // 알파벳순이라 그 행으로는 정렬 여부를 증명할 수 없다(공허한 단언).
    const fold = card.metrics.find((m) => m.key === 'compare.confidence');
    expect(Object.keys(FOLD.by_confidence)).toEqual(['exact', 'name', 'fifo', 'other']);
    expect(Object.keys(fold.counts)).toEqual(['exact', 'fifo', 'name', 'other']);
  });

  it('비율은 분모로 나눈 값이다 (0% 로 메우지 않는다)', () => {
    const agreement = card.metrics.find((m) => m.key === 'compare.agreement');
    expect(agreement.ratio).toBeCloseTo(37 / 42, 12);
    expect(card.metrics.find((m) => m.key === 'compare.score').ratio).toBeNull();
  });

  it('cost 행 note 는 버킷 합계를 자기 priced 와 함께 적는다', () => {
    const note = card.metrics.find((m) => m.key === 'compare.cost').note;
    expect(note).toContain('same=6.000000 (priced 12)');
    expect(note).toContain('diverged=0.250000 (priced 2)');
  });

  it('score 행은 source 에 읽은 필드를, note 에 null 과 사유를 적는다', () => {
    const score = card.metrics.find((m) => m.key === 'compare.score');
    expect(score.source.length).toBeGreaterThan(0);
    expect(score.note).toContain('source: null');
    expect(score.note).toContain('no-spawn-keyed-score-writer');
  });

  it('excluded_fifo · unjoined_receipts note 가 이름·분모의 함정을 적는다', () => {
    const fifo = card.metrics.find((m) => m.key === 'compare.excluded_fifo');
    expect(fifo.note).toContain('allowlist');
    const unjoined = card.metrics.find((m) => m.key === 'compare.unjoined_receipts');
    expect(unjoined.note).toContain('distinct');
    // S6: 바인드가 영수증보다 먼저 쓰이므로 --since 경계를 걸친 스폰은 이 행으로 떨어진다.
    expect(unjoined.note).toContain('--since');
  });

  it('두 note 가 서로 모순되지 않는다 — 제외 사유 2종을 같게 말한다', () => {
    // I2: agreement note 가 "나머지는 excluded_fifo 행이 센다" 라고 말하면 거짓이다.
    // recommended_model 부재로 빠진 쌍은 이 카드의 어느 행에도 없다.
    const agreement = card.metrics.find((m) => m.key === 'compare.agreement');
    expect(agreement.note).toContain('recommended_model');
    expect(agreement.note).toContain('excluded_no_recommendation');
    expect(agreement.note).toContain('이 카드의 행이 아니다');
    // 정반대로 말하던 문구가 남아 있지 않은지 — 두 note 가 같은 사실을 말해야 한다.
    expect(agreement.note).not.toContain('나머지는 일치로 세지 않고 분모에서 뺀다(compare.');
  });

  it('totals 와 unmeasured 가 카드에서 파생된다', () => {
    expect(card.totals).toEqual({ metrics: 9, measured: 7, unmeasured: 2 });
    expect(card.unmeasured).toEqual(['compare.replay_label', 'compare.score']);
  });

  it('since 라벨을 scope 에 그대로 싣는다 (카드는 필터링하지 않는다)', () => {
    const scoped = buildCompareScorecard(FOLD, {
      since: '2026-09-20T00:00:00.000Z', replay: REPLAY,
    });
    expect(scoped.scope).toEqual({ scope: 'index', since: '2026-09-20T00:00:00.000Z' });
    // The label is a LABEL: the same fold gives the same rows either way.
    expect(scoped.metrics.map((m) => m.numerator)).toEqual(card.metrics.map((m) => m.numerator));
  });
});

// ---------------------------------------------------------------------------
describe('보조 픽스처 A — 제외 경로 (주 픽스처에 fifo 쌍이 0 이라 따로 덮는다)', () => {
  const events = exclusionFixture();
  const fold = joinSpawnOutcomes(events);
  const card = buildCompareScorecard(fold, { replay: labelReplay(events) });
  const row = (key) => card.metrics.find((m) => m.key === key);

  it('fold 가 11쌍·비교 4·fifo 제외 5·추천없음 2 로 접힌다', () => {
    expect(fold.pairs.length).toBe(11);
    expect(fold.compared).toBe(4);
    expect(fold.by_agreement).toEqual({ same: 2, diverged: 2 });
    expect(fold.excluded_fifo).toBe(5);
    expect(fold.excluded_no_recommendation).toBe(2);
    expect(fold.by_confidence).toEqual({ exact: 6, name: 0, fifo: 3, other: 2 });
  });

  it('excluded_fifo 는 allowlist 밖 전부를 센다 — fifo 3 + 미지 tier 2', () => {
    // 이름은 fifo 지만 게이트는 allowlist(exact,name)다. 미지 tier 가 조용히
    // compare.agreement 의 분모로 들어가면 fail-open 이다.
    expect(row('compare.excluded_fifo').numerator).toBe(5);
    expect(row('compare.excluded_fifo').denominator).toBe(11);
  });

  it('recommended_model 없는 2쌍은 excluded_fifo 에 없다 (다른 제외 사유)', () => {
    // 11 = 비교 4 + excluded_fifo 5 + 추천없음 2. 카드는 마지막 항을 행으로
    // 싣지 않으므로 이 등식은 여기서만 보인다.
    expect(fold.compared + fold.excluded_fifo + fold.excluded_no_recommendation).toBe(11);
    expect(row('compare.agreement').denominator).toBe(4);
  });

  it('confidence 분모는 전 쌍 11 이다 — 비교 분모 4 와 다른 모집단이다', () => {
    expect(row('compare.confidence').denominator).toBe(11);
    expect(row('compare.confidence').counts).toEqual({ exact: 6, fifo: 3, name: 0, other: 2 });
  });
});

// ---------------------------------------------------------------------------
describe('보조 픽스처 B — diverged 가 전부 unpriced 면 합계는 0 이 아니라 unmeasured', () => {
  const events = unpricedDivergenceFixture();
  const fold = joinSpawnOutcomes(events);
  const card = buildCompareScorecard(fold, { replay: labelReplay(events) });
  const cost = card.metrics.find((m) => m.key === 'compare.cost');

  it('fold 의 diverged 버킷 합계가 null 이다 (0 이 아니다)', () => {
    expect(fold.cost.diverged).toEqual({ priced: 0, total: null });
    expect(fold.cost.same).toEqual({ priced: 3, total: 1.5 });
  });

  it('note 가 null 합계를 unmeasured 로 적고 0 이라 쓰지 않는다', () => {
    expect(cost.note).toContain('diverged=unmeasured (priced 0)');
    expect(cost.note).toContain('same=1.500000 (priced 3)');
    expect(cost.note).not.toContain('diverged=0');
  });

  it('행 자체는 measured 다 — 분모(compared 5)가 있다', () => {
    expect(cost.state).toBe('measured');
    expect(cost.denominator).toBe(5);
    expect(cost.numerator).toBe(3);
    expect(cost.counts).toEqual({ agreed_priced: 3, diverged_priced: 0, unpriced: 2 });
  });
});

// ---------------------------------------------------------------------------
describe('보조 픽스처 C — 42쌍 혼합 (name confidence·제외·미조인이 한 fold 에)', () => {
  const events = mixedFixture();
  const fold = joinSpawnOutcomes(events);
  const card = buildCompareScorecard(fold, { replay: labelReplay(events) });

  /** Expected rows. Independently derived from the G1..G7 table. */
  const WANT = Object.freeze({
    'compare.pairs': { denominator: 47, numerator: 42 },
    'compare.agreement': { denominator: 32, numerator: 23 },
    'compare.confidence': { denominator: 42, numerator: null },
    'compare.cost': { denominator: 32, numerator: 25 },
    'compare.excluded_fifo': { denominator: 42, numerator: 6 },
    'compare.unjoined_binds': { denominator: 47, numerator: 5 },
    'compare.unjoined_receipts': { denominator: 45, numerator: 3 },
    'compare.replay_label': { denominator: 0, numerator: null },
    'compare.score': { denominator: 0, numerator: null },
  });

  it('fold 가 47바인드·42쌍·비교 32·일치 23·갈림 9 로 접힌다', () => {
    expect(fold.binds).toBe(47);
    expect(fold.pairs.length).toBe(42);
    expect(fold.compared).toBe(32);
    expect(fold.by_agreement).toEqual({ same: 23, diverged: 9 });
    expect(fold.excluded_fifo).toBe(6);
    expect(fold.excluded_no_recommendation).toBe(4);
    expect(fold.unjoined_binds).toBe(5);
    expect(fold.unjoined_receipts).toBe(3);
    expect(fold.main_thread_receipts).toBe(2);
  });

  it('name confidence 버킷이 0 이 아니다 (주 픽스처가 못 덮는 지점)', () => {
    expect(fold.by_confidence).toEqual({ exact: 28, name: 8, fifo: 6, other: 0 });
    expect(card.metrics.find((m) => m.key === 'compare.confidence').counts)
      .toEqual({ exact: 28, fifo: 6, name: 8, other: 0 });
  });

  it('양쪽 버킷에 priced 와 unpriced 가 모두 있다', () => {
    expect(fold.cost).toEqual({
      compared: 25,
      unpriced: 7,
      same: { priced: 19, total: 8.25 },
      diverged: { priced: 6, total: 0.75 },
    });
    const note = card.metrics.find((m) => m.key === 'compare.cost').note;
    expect(note).toContain('same=8.250000 (priced 19)');
    expect(note).toContain('diverged=0.750000 (priced 6)');
  });

  it('행 순서가 주 픽스처와 같다', () => {
    expect(card.metrics.map((m) => m.key)).toEqual(ROW_KEYS);
  });

  it.each(ROW_KEYS)('%s 의 분모·분자가 기대값이다', (key) => {
    const row = card.metrics.find((m) => m.key === key);
    expect({ denominator: row.denominator, numerator: row.numerator }).toEqual(WANT[key]);
  });

  it('정합성 등식이 성립한다 (42+5=47 · 42+3=45 · 23+9=32 · 32+6+4=42)', () => {
    expect(fold.pairs.length + fold.unjoined_binds).toBe(fold.binds);
    expect(fold.pairs.length + fold.unjoined_receipts).toBe(45);
    expect(fold.by_agreement.same + fold.by_agreement.diverged).toBe(fold.compared);
    expect(fold.compared + fold.excluded_fifo + fold.excluded_no_recommendation)
      .toBe(fold.pairs.length);
  });

  it('섞어도 바이트가 같다', () => {
    const other = cardOf(shuffled(events, 31));
    expect(JSON.stringify(other)).toBe(JSON.stringify(card));
    expect(renderScorecardMarkdown(other)).toBe(renderScorecardMarkdown(card));
  });
});

// ---------------------------------------------------------------------------
describe('결정성 — 입력을 섞어도 바이트가 같다', () => {
  const base = buildCompareScorecard(FOLD, { replay: REPLAY });

  it.each([1, 7, 20260921])('시드 %i 로 섞은 입력이 같은 JSON 바이트를 낸다', (seedValue) => {
    const card = cardOf(shuffled(EVENTS, seedValue));
    expect(JSON.stringify(card)).toBe(JSON.stringify(base));
  });

  it('섞은 입력이 같은 마크다운 바이트를 낸다', () => {
    const card = cardOf(shuffled(EVENTS, 99));
    expect(renderScorecardMarkdown(card)).toBe(renderScorecardMarkdown(base));
  });

  // S4: 자기검증을 실제로 쓰인 시드 전부에 돌린다. 한 시드만 검증하면 다른
  // 시드가 항등순열이어도 바이트 동일 단언이 공허하게 통과한다.
  it.each([1, 7, 20260921, 99, 31])('셔플 자기검증 — 시드 %i 가 순서를 실제로 바꾼다', (s) => {
    const permuted = shuffled(EVENTS, s);
    expect(permuted.length).toBe(EVENTS.length);
    expect(permuted.map((e) => e.seq)).not.toEqual(EVENTS.map((e) => e.seq));
    expect([...permuted].sort((a, b) => a.seq - b.seq).map((e) => e.seq))
      .toEqual([...EVENTS].sort((a, b) => a.seq - b.seq).map((e) => e.seq));
  });
});

// ---------------------------------------------------------------------------
describe('렌더 — compare kind 가 인쇄된다', () => {
  it('heading 과 scope 를 찍는다', () => {
    const out = renderScorecardMarkdown(buildCompareScorecard(FOLD, {
      since: '2026-09-20', replay: REPLAY,
    }));
    expect(out).toContain('# ARTIBOT · COMPARE SCORECARD');
    expect(out).toContain('- **scope**: `index`');
    expect(out).toContain('- **since**: `2026-09-20`');
  });

  it('측정된 행은 퍼센트로, score·라벨 행은 unmeasured 로 찍힌다', () => {
    const out = renderScorecardMarkdown(buildCompareScorecard(FOLD, { replay: REPLAY }));
    expect(out).toContain('88.1%'); // 37/42
    expect(out).toContain('unmeasured');
    expect(out).toContain('2 / 9 지표가 분모 0 이다');
  });

  it('histogram 이 분포 절에 나온다', () => {
    const out = renderScorecardMarkdown(buildCompareScorecard(FOLD, { replay: REPLAY }));
    expect(out).toContain('## 분포');
    expect(out).toContain('agreed_priced');
  });
});

// ---------------------------------------------------------------------------
describe('분모 0 — 빈 원장은 9행 전부 unmeasured 다', () => {
  const card = cardOf([]);

  it('행 9개가 모두 unmeasured 이고 ratio 가 null 이다', () => {
    expect(card.metrics.map((m) => m.key)).toEqual(ROW_KEYS);
    for (const m of card.metrics) {
      expect(m.state, `${m.key} 가 measured 다`).toBe('unmeasured');
      expect(m.ratio, `${m.key} 의 ratio 가 null 이 아니다`).toBeNull();
      expect(m.denominator).toBe(0);
    }
  });

  it('unmeasured 색인이 9키 전부다', () => {
    expect(card.unmeasured).toEqual(ROW_KEYS);
    expect(card.totals).toEqual({ metrics: 9, measured: 0, unmeasured: 9 });
  });

  it('렌더 출력에 퍼센트 수치가 없다', () => {
    // 리터럴 '0%' 를 금지할 수는 없다 — 렌더러 자신의 미측정 절이 "0% 가 아니라
    // 미측정이다" 라는 경고 산문을 찍는다(render.js#renderScorecardMarkdown, 미측정
    // 분기). 금지 대상은 렌더된 수치이므로 sibling 스위트와 같은 형태로 본다
    // (tests/scorecard/scorecard.test.js '분모 0 인 행은 ... 퍼센트 수치를 찍지 않는다').
    const out = renderScorecardMarkdown(card);
    expect(out).not.toMatch(/\d+\.\d+%/);
    expect(out).toContain('9 / 9 지표가 분모 0 이다');
  });

  it('score 행이 값·비율·상태 세 칸 모두 unmeasured 로 찍힌다', () => {
    // S2: toContain('unmeasured') 만으로는 어느 칸이 그 글자인지 증명되지 않는다.
    // 행 전체를 단언해 값 칸과 비율 칸이 둘 다 그 단어임을 고정한다.
    expect(renderScorecardMarkdown(card)).toContain(
      '| 스폰 결과 점수 (측정자 없음) | unmeasured | 0 | unmeasured | 0 | unmeasured |',
    );
  });

  it('분포 절 자체가 없다 — 분모 0 인 행은 건수 0 히스토그램도 찍지 않는다', () => {
    // I1(검수 판독 → 프로브 실측 2026-09-21T04:21:54Z): 이 카드는 '## 분포' 아래 건수 0 행 9개를
    // 찍었고, 같은 빈 입력의 routing 카드는 분포 절이 아예 없었다. "0 건" 은
    // metric.js 헤더가 금지하는 "측정했고 답은 없음" 오독이다. render.js 의
    // 필터(m.counts && keys.length)는 비소유라, 카드가 counts 를 null 로 낸다.
    const out = renderScorecardMarkdown(card);
    expect(out).not.toContain('## 분포');
    for (const m of card.metrics) expect(m.counts, `${m.key} 가 counts 를 실었다`).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe('보조 픽스처 D — 쌍은 있는데 비교 가능한 쌍이 0 이면 분모가 행마다 다르다', () => {
  const events = allExcludedFixture();
  const fold = joinSpawnOutcomes(events);
  const card = buildCompareScorecard(fold, { replay: labelReplay(events) });
  const row = (key) => card.metrics.find((m) => m.key === key);

  it('fold 가 5쌍·비교 0 으로 접힌다', () => {
    expect(fold.pairs.length).toBe(5);
    expect(fold.compared).toBe(0);
    expect(fold.excluded_fifo).toBe(3);
    expect(fold.excluded_no_recommendation).toBe(2);
  });

  it('agreement·cost 는 분모 0 이라 counts 가 null 이다', () => {
    for (const key of ['compare.agreement', 'compare.cost']) {
      expect(row(key).denominator, key).toBe(0);
      expect(row(key).state, key).toBe('unmeasured');
      expect(row(key).counts, `${key} 가 건수 0 히스토그램을 실었다`).toBeNull();
    }
  });

  it('confidence 는 분모(쌍 5)가 있으므로 counts 를 유지한다', () => {
    expect(row('compare.confidence').denominator).toBe(5);
    expect(row('compare.confidence').state).toBe('measured');
    expect(row('compare.confidence').counts).toEqual({ exact: 2, fifo: 3, name: 0, other: 0 });
  });

  it('분포 절에는 confidence 표만 나온다', () => {
    const out = renderScorecardMarkdown(card);
    expect(out).toContain('## 분포');
    expect(out).toContain('| 바인드 confidence 분포 | fifo | 3 |');
    expect(out).not.toContain('agreed_priced');
    expect(out).not.toContain('| 추천 = 실제 서빙 (모델 ID 일치) | same |');
  });
});

// ---------------------------------------------------------------------------
describe('fail-closed — 배선 오류가 빈 카드로 보이지 않는다', () => {
  // 아래 fold 거부 단언은 전부 유효한 `replay: REPLAY` 를 함께 넘긴다. 빼면
  // replay 부재로도 던지므로, fold 검사가 사라져도 green 인 공허 단언이 된다.
  const ok = { replay: REPLAY };

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['배열', []],
    ['문자열', 'fold'],
    ['숫자', 0],
  ])('%s 은 fold 가 아니다', (_name, bad) => {
    expect(() => buildCompareScorecard(bad, ok)).toThrow(/joinSpawnOutcomes/);
  });

  it('replay 인덱스를 넘기면 던진다 (평탄화 경로가 빈 원장처럼 보이지 않게)', () => {
    const replayShaped = { routes: [], switches: [], bound: [], totals: { indexed: 0 } };
    expect(() => buildCompareScorecard(replayShaped, ok)).toThrow(/pairs/);
  });

  it.each([
    'pairs', 'binds', 'compared', 'excluded_fifo', 'unjoined_binds', 'unjoined_receipts',
    'by_agreement', 'by_confidence', 'cost', 'score',
  ])('필수 필드 %s 가 없으면 던진다', (field) => {
    const broken = { ...FOLD };
    delete broken[field];
    expect(() => buildCompareScorecard(broken, ok)).toThrow(TypeError);
  });

  it.each([
    ['binds 가 음수', { binds: -1 }],
    ['compared 가 소수', { compared: 1.5 }],
    ['by_agreement.same 가 문자열', { by_agreement: { same: '1', diverged: 0 } }],
    ['by_confidence 값이 음수', { by_confidence: { exact: -2 } }],
    ['cost.compared 가 없음', { cost: { unpriced: 0 } }],
    ['cost 버킷 total 이 문자열', {
      cost: {
        compared: 1,
        unpriced: 0,
        same: { priced: 1, total: 'x' },
        diverged: { priced: 0, total: null },
      },
    }],
    // 블록 자체가 없거나 객체가 아닌 것은 "형식이 틀린 블록"이 아니라 배선 오류다 —
    // 어느 필드가 틀렸는지 말할 대상이 없다. 이 던짐은 그대로 남긴다(SH-05 후속은
    // 블록 "안"의 내용만 던지지 않고 표기한다; 아래 '측정 불가' 절).
    ['score 가 null', { score: null }],
    ['score 가 undefined', { score: undefined }],
    ['score 가 배열', { score: [] }],
    ['score 가 문자열', { score: 'x' }],
    // I4-1: by_confidence 의 네 키를 이름으로 요구한다. 부분 fold 가 통과하면
    // 카드가 exact 만 있는 분포를 전 쌍 분포라고 찍는다.
    ['by_confidence 가 빈 객체', { by_confidence: {} }],
    ['by_confidence 에 other 가 없음', { by_confidence: { exact: 1, name: 0, fifo: 0 } }],
    // S3: 아래 6건은 reject 분기에 도달하는 경로가 없어 미검증이었다.
    ['cost.same 이 객체가 아님', {
      cost: { compared: 0, unpriced: 0, same: 'x', diverged: { priced: 0, total: null } },
    }],
    ['cost.same.priced 가 음수', {
      cost: {
        compared: 0, unpriced: 0, same: { priced: -1, total: null }, diverged: { priced: 0, total: null },
      },
    }],
    ['cost.unpriced 가 없음', {
      cost: {
        compared: 0, same: { priced: 0, total: null }, diverged: { priced: 0, total: null },
      },
    }],
    ['by_agreement.diverged 가 문자열', { by_agreement: { same: 0, diverged: 'x' } }],
  ])('%s 이면 던진다', (_name, patch) => {
    expect(() => buildCompareScorecard({ ...FOLD, ...patch }, ok)).toThrow(TypeError);
  });

  it('score 블록이 없으면 던지는 메시지가 그 이유를 적는다', () => {
    // 옛 I4-2 두 케이스(source 가 실제 writer 이름 · value 가 실제 점수)는 여기서 빠졌다.
    // 그 단언은 "점수 축이 아직 정의되지 않았다"의 자리표시자였다("행을 재설계하라, 검사를
    // 풀지 마라"). 축은 8ae56c77 에서 정의됐고 재설계가 SH-05 후속이다 — 새 계약은 아래
    // 'score 행' 그룹들이 잡는다. 블록이 아예 없는 배선 오류만 여기서 던진다.
    expect(() => buildCompareScorecard({ ...FOLD, score: null }, ok))
      .toThrow(/`score` must be an explicit block, not absent and not null/);
  });

  it.each([
    ['숫자', 1758400000000],
    ['Date 유사 객체', { toISOString: 'nope' }],
    ['배열', ['2026-09-20']],
  ])('since 가 %s 면 던진다', (_name, bad) => {
    expect(() => buildCompareScorecard(FOLD, { ...ok, since: bad })).toThrow(/LABEL/);
  });

  it('since 는 문자열·null·생략만 받는다', () => {
    // 옛 단언은 `(FOLD, {})` 와 `(FOLD)` 도 통과로 봤다. replay 가 필수 포트가 된
    // 뒤로 그 둘은 replay 부재로 던진다 — 아래 replay fail-closed 절이 그 계약이다.
    expect(() => buildCompareScorecard(FOLD, { ...ok, since: null })).not.toThrow();
    expect(() => buildCompareScorecard(FOLD, ok)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
describe('불변 — 카드는 얼고 입력은 그대로다', () => {
  it('카드·scope·metrics·행이 전부 frozen 이다', () => {
    const card = buildCompareScorecard(FOLD, { replay: REPLAY });
    expect(Object.isFrozen(card)).toBe(true);
    expect(Object.isFrozen(card.scope)).toBe(true);
    expect(Object.isFrozen(card.metrics)).toBe(true);
    expect(Object.isFrozen(card.unmeasured)).toBe(true);
    for (const m of card.metrics) expect(Object.isFrozen(m)).toBe(true);
  });

  it('입력 fold 와 replay 를 변형하지 않는다', () => {
    const events = labelFixture();
    const fold = joinSpawnOutcomes(events);
    const replay = labelReplay(events);
    const before = JSON.stringify([fold, replay]);
    buildCompareScorecard(fold, { since: '2026-09-20T00:00:00.000Z', replay });
    expect(JSON.stringify([fold, replay])).toBe(before);
  });
});

// ---------------------------------------------------------------------------
describe('보조 픽스처 E — replay 라벨 행 (실제 labelReplay 출력을 접는다)', () => {
  const events = labelFixture();
  const replay = labelReplay(events);
  const card = cardOf(events);
  const row = card.metrics.find((m) => m.key === 'compare.replay_label');

  it('생산자가 6 Action · PARTIAL 3 · SIMULATED 3 · EXACT 0 으로 접는다', () => {
    // 픽스처 자기검증: route.selected 배선이 틀리면 actions 가 0 이 되어 아래 행
    // 단언이 전부 unmeasured 분기를 타게 된다. 생산자 형태가 바뀌면 여기가 먼저 레드다.
    expect(replay.actions).toBe(6);
    expect(replay.by_label).toEqual({ EXACT: 0, PARTIAL: 3, SIMULATED: 3 });
    expect(replay.by_reason).toEqual({
      'no-usage-receipt': 2, 'single-run-result': 3, 'unbound-receipt': 1,
    });
    expect(replay.exact_reachable).toBe(false);
  });

  it('행이 분모 = actions, 분포 = by_label 로 measured 다', () => {
    expect({
      denominator: row.denominator, numerator: row.numerator, ratio: row.ratio,
      counts: row.counts, state: row.state,
    }).toEqual({
      denominator: 6, numerator: null, ratio: null,
      counts: { EXACT: 0, PARTIAL: 3, SIMULATED: 3 }, state: 'measured',
    });
    expect(card.totals).toEqual({ metrics: 9, measured: 8, unmeasured: 1 });
  });

  it('분포 키가 생산자의 REPLAY_LABELS 와 같다 (카드의 사본이 갈리지 않게)', () => {
    expect(Object.keys(row.counts)).toEqual([...REPLAY_LABELS]);
  });

  it('EXACT 0 옆에 exact_reachable:false 와 사유 one-action-one-run 을 적는다', () => {
    expect(row.counts.EXACT).toBe(0);
    expect(EXACT_UNREACHABLE_REASON).toBe('one-action-one-run');
    expect(row.note).toContain(`exact_reachable:false · 사유 ${EXACT_UNREACHABLE_REASON}`);
    expect(row.note).toContain('구조적 0');
    expect(row.note).toContain('CANNOT SEE #3');
    // PARTIAL 은 "영수증이 있다" 만이 아니다 — 비교 가능한 바인드까지가 조건이다(review-sc L2).
    expect(row.note).toContain('측정된(transcript·otlp) 영수증과 비교 가능한 바인드');
  });

  it('렌더에 라벨 행과 분포가 찍힌다', () => {
    const out = renderScorecardMarkdown(card);
    expect(out).toContain(
      '| Replay 충실도 라벨 (EXACT · PARTIAL · SIMULATED) | 6 | 6 | — | 0 | measured |',
    );
    expect(out).toContain('| Replay 충실도 라벨 (EXACT · PARTIAL · SIMULATED) | EXACT | 0 |');
    expect(out).toContain('| Replay 충실도 라벨 (EXACT · PARTIAL · SIMULATED) | SIMULATED | 3 |');
  });

  it('actions 0 이면 행은 unmeasured 이고 counts 가 null 이다 (0% 가 아니다)', () => {
    const empty = cardOf([]).metrics.find((m) => m.key === 'compare.replay_label');
    expect(empty).toMatchObject({ denominator: 0, counts: null, ratio: null, state: 'unmeasured' });
    expect(empty.note).toContain('by_label_reason: no-actions');
  });

  it.each([3, 17, 20260923])('시드 %i 로 섞어도 바이트가 같다', (s) => {
    const permuted = shuffled(events, s);
    expect(permuted.map((e) => e.seq)).not.toEqual(events.map((e) => e.seq));
    expect(JSON.stringify(cardOf(permuted))).toBe(JSON.stringify(card));
  });
});

// ---------------------------------------------------------------------------
describe('fail-closed — replay 포트가 없거나 모양이 틀리면 던진다', () => {
  const REPLAY_E = labelReplay(labelFixture());

  // 세 번째 열은 그 케이스를 거부해야 하는 검사의 메시지 조각이다. 포트 이름
  // (/labelReplay/)만 보면 어느 검사가 던졌는지 못 핀한다 — 예: actions 카운트 검사를
  // 지워도 '음수'·'없음' 두 케이스는 뒤의 합 검사가 던져 green 이었다(review-sc L1).
  it.each([
    ['생략', {}, /got undefined/],
    ['null', { replay: null }, /got null/],
    ['배열', { replay: [] }, /got \[\]/],
    ['fold 를 잘못 넘김', { replay: FOLD }, /`actions` must be a non-negative integer/],
  ])('replay %s 이면 던진다', (_name, opts, why) => {
    expect(() => buildCompareScorecard(FOLD, opts)).toThrow(/labelReplay/);
    expect(() => buildCompareScorecard(FOLD, opts)).toThrow(why);
  });

  it.each([
    ['actions 가 음수', { actions: -1 }, /`actions` must be a non-negative integer/],
    ['actions 가 없음', { actions: undefined }, /`actions` must be a non-negative integer/],
    ['by_label 이 없음', { by_label: undefined }, /`by_label` must be an object/],
    ['by_label 에 SIMULATED 가 없음', { by_label: { EXACT: 0, PARTIAL: 3 } },
      /`by_label\.SIMULATED` must be a non-negative integer/],
    ['by_label 합이 actions 와 다름', { by_label: { EXACT: 0, PARTIAL: 3, SIMULATED: 2 } },
      /sums to 5, not to `actions` 6/],
    ['actions>0 인데 by_label_reason 이 있음', { by_label_reason: 'no-actions' },
      /`by_label_reason` must be null when `actions` is non-zero/],
    ['EXACT 가 0 이 아님', { by_label: { EXACT: 1, PARTIAL: 2, SIMULATED: 3 } },
      /`by_label\.EXACT` is non-zero/],
    ['exact_reachable 이 없음', { exact_reachable: undefined },
      /`exact_reachable` must be the literal false/],
    ['exact_unreachable_reason 이 빈 문자열', { exact_unreachable_reason: '' },
      /`exact_unreachable_reason` must be a non-empty string/],
    ['actions 0 인데 by_label 이 0 세 개', {
      actions: 0, by_label: { EXACT: 0, PARTIAL: 0, SIMULATED: 0 }, by_label_reason: 'no-actions',
    }, /`by_label\.EXACT` must be null when `actions` is 0/],
    ['actions 0 인데 by_label_reason 이 없음', {
      actions: 0, by_label: { EXACT: null, PARTIAL: null, SIMULATED: null }, by_label_reason: null,
    }, /`by_label_reason` must name why/],
  ])('%s 이면 던진다', (_name, patch, why) => {
    const build = () => buildCompareScorecard(FOLD, { replay: { ...REPLAY_E, ...patch } });
    expect(build).toThrow(/labelReplay/);
    expect(build).toThrow(why);
  });

  it('exact_reachable 이 true 면 카드를 찍지 않고 행 재설계를 요구한다', () => {
    // note 가 EXACT 를 구조적 0 이라 문자로 박는다. EXACT 가 열린 뒤에도 통과시키면
    // 측정된 EXACT 를 "불가능" 이라 적은 행이 나온다 — 그래서 거부하고 재설계를 요구한다.
    // (compare.score 도 한때 같은 이유로 거부했다가 SH-05 후속에서 재설계됐다. 이 행은
    // 아직 재설계 전이라 거부가 그대로 남는다.)
    expect(() => buildCompareScorecard(FOLD, { replay: { ...REPLAY_E, exact_reachable: true } }))
      .toThrow(/Redesign that row/);
  });
});

// ---------------------------------------------------------------------------
// SH-05 후속 — `compare.score` 행의 새 계약.
//
// 옛 계약은 `requireScore` 의 단언이었다: score.source 나 score.value 가 null 이 아니면
// 카드를 던진다("행을 재설계하라, 검사를 풀지 마라"). 그건 "점수 축이 아직 정의되지 않았다"의
// 자리표시자였고, 축은 8ae56c77 에서 정의됐다(spawn-outcome.js "THE SCORE AXIS": 값은 리뷰어
// claim_audit 통과율이고, 그 정의가 score.basis 로 값 옆에 찍힌다). 아래 다섯 그룹이 새
// 계약이다 — (1) audit 행이 있어도 카드는 던지지 않는다 (2) 조인된 audit 가 있으면 basis 와
// 분모와 함께 찍는다 (3) 조인된 게 없으면 unmeasured 다 (4) null 블록은 옛 출력과 바이트가
// 같다 (5) 형식이 틀린 블록은 던지지 않고 "측정 불가" 로 표기한다.

/** 조인된 audit 가 있을 때의 행 이름 — 값이 스폰의 결과가 아니라는 말이 이름에 들어 있다. */
const AUDIT_LABEL = '리뷰어 claim_audit 통과율 (스폰 결과 아님)';

/** 블록을 읽을 수 없을 때의 행 이름 — 화면에서 보이는 표지다. */
const UNREADABLE_LABEL = '스폰 점수 (측정 불가)';

describe('score 행 (1) — audit 행이 하나라도 있으면 카드가 던지던 결함', () => {
  // 결함: `requireScore` 는 score.source 나 score.value 가 null 이 아니면 던졌다. 생산자는
  // audit 행을 "종류 불문" 처음 읽는 순간부터 source 를 채운다(조인된 행이든, subject 없는
  // 행이든, 깨진 행이든). 그래서 원장에 review.claim_audit 이 한 줄만 생겨도
  // `/scorecard --compare` 전체가 TypeError 였다 — 2026-09-29T04:58Z 실호출로 5종 전부 재현.
  const spawnsOnly = lazily(() => cardOf(auditedSpawns()));

  it('픽스처 자기검증: 스폰만 있는 원장의 score 는 null 블록이다', () => {
    expect(joinSpawnOutcomes(auditedSpawns()).score).toMatchObject({ source: null, value: null });
  });

  it.each(Object.keys(SINGLE_AUDIT_KINDS))('audit 1건(%s)이 있어도 카드를 찍고 렌더한다', (kind) => {
    const events = SINGLE_AUDIT_KINDS[kind]();
    // 자기검증: 생산자가 audit-bearing 블록을 냈다. 아니면 이 케이스는 옛 경로를 재는 공허 단언이다.
    expect(joinSpawnOutcomes(events).score.source).toBe(CLAIM_AUDIT_JOIN_EVENTS.audit);
    const card = cardOf(events);
    expect(card.metrics.map((m) => m.key)).toEqual(ROW_KEYS);
    expect(() => renderScorecardMarkdown(card)).not.toThrow();
    // score 행이 무엇을 찍든 나머지 8행은 audit 가 없는 카드와 같다.
    expect(otherRowsOf(card)).toEqual(otherRowsOf(spawnsOnly()));
  });
});

// ---------------------------------------------------------------------------
describe('score 행 (2) — 조인된 audit 가 있으면 basis 와 분모 n 을 붙여 찍는다', () => {
  const events = lazily(() => scoredFixture());
  const fold = lazily(() => joinSpawnOutcomes(events()));
  const card = lazily(() => cardOf(events()));
  const row = () => scoreRowOf(card());

  it('픽스처 자기검증: 생산자가 3건 조인 · 통과율 0.75 · 조인 못 한 2 · subject 없는 1 · malformed 1 로 접는다', () => {
    const { score } = fold();
    expect(score).toMatchObject({
      source: CLAIM_AUDIT_JOIN_EVENTS.audit,
      value: 0.75,
      reason: null,
      n: 3,
      audits: 6,
      unjoined_audits: 2,
      no_subject_audits: 1,
      malformed_audits: 1,
    });
    // 생산자가 문서화한 분할: audits = joined + unjoined + no_subject (malformed 는 밖).
    expect(score.audits).toBe(score.n + score.unjoined_audits + score.no_subject_audits);
    expect(typeof score.basis).toBe('string');
  });

  it('행이 measured 이고 분모가 n(조인된 audit 행 수)이다', () => {
    expect(row()).toMatchObject({
      key: 'compare.score',
      denominator: 3,
      numerator: null,
      ratio: null,
      counts: null,
      absent: 0,
      measured: true,
      state: 'measured',
    });
  });

  it('행 이름이 "스폰 결과 점수" 가 아니라 리뷰어 통과율이다', () => {
    expect(row().label).toBe(AUDIT_LABEL);
    expect(row().label).not.toContain('측정자 없음');
    expect(row().source).toContain('review.claim_audit');
    expect(row().source).toContain('route.bound');
  });

  it('note 가 통과율을 고정 자릿수로 적는다', () => {
    expect(row().note).toContain('통과율 0.750000');
  });

  it('note 가 basis 를 글자 그대로 싣는다 (정의 없는 수치를 찍지 않는다)', () => {
    expect(row().note).toContain(fold().score.basis);
  });

  it('note 가 분모 n 의 뜻과 조인 못 한 audit 의 수를 함께 적는다', () => {
    const { note } = row();
    expect(note).toContain('n=3');
    expect(note).toContain('claim 수도 스폰 수도 아니다');
    for (const token of ['joined 3', 'unjoined 2', 'no_subject 1', 'malformed 1']) {
      expect(note, token).toContain(token);
    }
  });

  it('note 에 null 블록의 문장이 남아 있지 않다 (측정된 점수를 null 이라 적지 않는다)', () => {
    for (const stale of ['source: null', 'value: null', '영구 unmeasured', SCORE_UNAVAILABLE_REASON]) {
      expect(row().note, stale).not.toContain(stale);
    }
  });

  it('score 행 밖의 8행은 audit 가 없는 카드와 같다', () => {
    expect(otherRowsOf(card())).toEqual(otherRowsOf(cardOf(auditedSpawns())));
  });

  it('measured 라 unmeasured 색인에서 빠지고 totals 가 카드에서 파생된다', () => {
    expect(card().unmeasured).toEqual(['compare.replay_label']);
    expect(card().totals).toEqual({ metrics: 9, measured: 8, unmeasured: 1 });
  });

  it('렌더: 표 행은 값·비율 칸이 — 이고 통과율은 근거 절에 있다', () => {
    const out = renderScorecardMarkdown(card());
    expect(out).toContain(`| ${AUDIT_LABEL} | — | 3 | — | 0 | measured |`);
    const evidence = out.split('\n').find((l) => l.startsWith(`| ${AUDIT_LABEL} | spawn-outcome`));
    expect(evidence, '근거 절에 score 행이 없다').toContain('통과율 0.750000');
  });

  it.each([3, 17, 20260923])('시드 %i 로 섞어도 카드와 마크다운 바이트가 같다', (seedValue) => {
    const permuted = shuffled(events(), seedValue);
    expect(permuted.map((e) => e.seq)).not.toEqual(events().map((e) => e.seq));
    expect(JSON.stringify(cardOf(permuted))).toBe(JSON.stringify(card()));
    expect(renderScorecardMarkdown(cardOf(permuted))).toBe(renderScorecardMarkdown(card()));
  });

  it('행이 얼고 입력 fold·replay 는 변하지 않는다', () => {
    const inputFold = joinSpawnOutcomes(events());
    const inputReplay = labelReplay(events());
    const before = JSON.stringify([inputFold, inputReplay]);
    const built = buildCompareScorecard(inputFold, { replay: inputReplay });
    expect(JSON.stringify([inputFold, inputReplay])).toBe(before);
    expect(Object.isFrozen(scoreRowOf(built))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('score 행 (3) — audit 를 읽었지만 점수가 없으면 unmeasured 다 (0 이 아니다)', () => {
  // 표의 세 번째 열은 조인 결과(note 가 적어야 하는 분포)다. 종류 이름은 SINGLE_AUDIT_KINDS 의 키.
  it.each([
    ['no-subject', SCORE_NO_JOINED_AUDIT_REASON, ['joined 0', 'unjoined 0', 'no_subject 1', 'malformed 0']],
    ['unjoined', SCORE_NO_JOINED_AUDIT_REASON, ['joined 0', 'unjoined 1', 'no_subject 0', 'malformed 0']],
    ['malformed', SCORE_NO_JOINED_AUDIT_REASON, ['joined 0', 'unjoined 0', 'no_subject 0', 'malformed 1']],
    ['zero-claims', SCORE_EMPTY_DENOMINATOR_REASON, ['joined 1', 'unjoined 0', 'no_subject 0', 'malformed 0']],
  ])('audit 1건(%s): 분모 0 · unmeasured · 사유와 분포를 적는다', (kind, reason, tokens) => {
    const events = SINGLE_AUDIT_KINDS[kind]();
    const fold = joinSpawnOutcomes(events);
    expect(fold.score.reason).toBe(reason); // 자기검증: 이 케이스가 노리는 분기다
    const card = cardOf(events);
    const row = scoreRowOf(card);
    expect(row).toMatchObject({
      label: AUDIT_LABEL,
      denominator: 0,
      numerator: null,
      ratio: null,
      counts: null,
      measured: false,
      state: 'unmeasured',
    });
    expect(card.unmeasured).toContain('compare.score');
    expect(row.note).toContain(`reason: ${reason}`);
    expect(row.note).toContain('통과율 unmeasured');
    expect(row.note).toContain(fold.score.basis);
    for (const token of tokens) expect(row.note, token).toContain(token);
    // 숫자 통과율이 새어 나오지 않는다 — 0 이든 다른 값이든.
    expect(row.note).not.toMatch(/통과율 \d/);
    expect(renderScorecardMarkdown(card)).toContain(
      `| ${AUDIT_LABEL} | unmeasured | 0 | unmeasured | 0 | unmeasured |`,
    );
  });

  it('조인됐지만 claim 이 0 인 audit 는 n 을 적되 분모는 0 이다', () => {
    const row = scoreRowOf(cardOf(SINGLE_AUDIT_KINDS['zero-claims']()));
    expect(row.note).toContain('n=1');
    expect(row.denominator).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('score 행 — 생산자가 낼 수 있는 audit 조합은 전부 읽힌다 (측정 불가가 나오면 카드 버그)', () => {
  // 실제 생산자(joinSpawnOutcomes)가 낸 블록이 "측정 불가" 로 찍히면 카드의 검증이 생산자보다
  // 엄격하다는 뜻이고, 리뷰어의 첫 audit 이 이 행을 잘못 지운다. 조인 0~2 × 조인 못 함 0~1 ×
  // subject 없음 0~1 × 깨진 행 0~1 × (claim 이 있는/없는 조인 audit) = 48개 원장 전부를 본다.
  const combos = [];
  for (const joined of [0, 1, 2]) {
    for (const unjoined of [0, 1]) {
      for (const noSubject of [0, 1]) {
        for (const malformed of [0, 1]) {
          for (const claimless of [false, true]) {
            combos.push({ joined, unjoined, noSubject, malformed, claimless });
          }
        }
      }
    }
  }

  /** 조합대로 원장을 만든다. 조인된 audit 는 au-01(10/2)·au-02(5/1), claimless 면 0/0. */
  function ledgerOf(c) {
    const out = auditedSpawns();
    const joinedRows = [
      { subjectId: 'au-01', total: c.claimless ? 0 : 10, refuted: c.claimless ? 0 : 2 },
      { subjectId: 'au-02', total: c.claimless ? 0 : 5, refuted: c.claimless ? 0 : 1 },
    ];
    for (const spec of joinedRows.slice(0, c.joined)) out.push(auditRow(spec));
    if (c.unjoined) out.push(auditRow({ subjectId: 'au-never-1', total: 7, refuted: 7 }));
    if (c.noSubject) out.push(auditRow({ total: 7, refuted: 7 }));
    if (c.malformed) out.push(malformedAuditRow());
    return out;
  }

  it('조합이 48개이고 서로 다르다 (자기검증)', () => {
    expect(combos).toHaveLength(48);
    expect(new Set(combos.map((c) => JSON.stringify(c))).size).toBe(48);
  });

  it.each(combos.map((c) => [JSON.stringify(c), c]))('%s', (_name, c) => {
    const events = ledgerOf(c);
    const fold = joinSpawnOutcomes(events);
    const card = cardOf(events);
    const row = scoreRowOf(card);
    const rows = c.joined + c.unjoined + c.noSubject + c.malformed;
    expect(row.label).not.toBe(UNREADABLE_LABEL);
    if (rows === 0) {
      // audit 행이 하나도 없으면 null 블록 — 옛 행이다.
      expect(fold.score.source).toBeNull();
      expect(row.label).toBe('스폰 결과 점수 (측정자 없음)');
      return;
    }
    expect(row.label).toBe(AUDIT_LABEL);
    if (c.joined > 0 && !c.claimless) {
      const total = c.joined === 2 ? 15 : 10;
      const refuted = c.joined === 2 ? 3 : 2;
      expect(row).toMatchObject({ denominator: c.joined, measured: true, state: 'measured' });
      expect(row.note).toContain(`통과율 ${((total - refuted) / total).toFixed(6)}`);
      expect(card.unmeasured).not.toContain('compare.score');
    } else {
      expect(row).toMatchObject({ denominator: 0, measured: false, state: 'unmeasured' });
      expect(row.note).toContain('통과율 unmeasured');
      expect(card.unmeasured).toContain('compare.score');
    }
    // 노트가 적은 분포는 생산자의 카운트와 같다.
    expect(row.note).toContain(`joined ${c.joined} + unjoined ${c.unjoined} + no_subject ${c.noSubject}`);
    expect(row.note).toContain(`malformed ${c.malformed}건`);
  });
});

// ---------------------------------------------------------------------------
describe('score 행 (4) — null 블록은 이전 출력과 바이트가 같다', () => {
  // 옛 카드가 만들던 행을 변경 전 코드(8ae56c77)에서 그대로 떠 온 리터럴이다 — 빈 원장, 즉
  // reason `no-spawn-keyed-score-writer`. 이 그룹은 특성화(characterization) 단언이라 변경
  // 전 코드에서도 green 이어야 한다: 새 코드가 옛 출력을 한 바이트도 바꾸지 않았다는 증명이
  // 그 성질이다. 옛 코드에서 출력이 있던 입력은 정확히 이 null 블록뿐이다(나머지는 전부 던졌다).
  const NULL_SCORE_ROW = Object.freeze({
    key: 'compare.score',
    label: '스폰 결과 점수 (측정자 없음)',
    source: 'spawn-outcome score.source · score.value · score.reason',
    denominator: 0,
    numerator: null,
    ratio: null,
    counts: null,
    absent: 0,
    measured: false,
    state: 'unmeasured',
    note: 'source: null · value: null · reason: no-spawn-keyed-score-writer. 분모를 0 으로 고정해 영구 unmeasured 다 — 원장에 스폰-키 점수 writer 가 없다(spawn-outcome.js CANNOT SEE #4). 합의는 품질이 아니다: compare.agreement 가 높아도 라우팅이 옳았다는 뜻이 아니다. 행을 빼지 않고 남겨 둔 이유는 부재가 "해당 없음"으로 읽히지 않게 하려는 것이다.',
  });

  it('리터럴의 사유가 생산자의 row-0 사유와 같다 (골든이 생산자와 갈라지지 않는다)', () => {
    expect(SCORE_UNAVAILABLE_REASON).toBe('no-spawn-keyed-score-writer');
    expect(FOLD.score.reason).toBe(SCORE_UNAVAILABLE_REASON);
    expect(joinSpawnOutcomes([]).score.reason).toBe(SCORE_UNAVAILABLE_REASON);
  });

  it('빈 원장의 score 행이 옛 행과 같다', () => {
    expect(scoreRowOf(cardOf([]))).toEqual(NULL_SCORE_ROW);
  });

  it('스폰은 있고 audit 는 없는 원장(생산자의 row-0 블록)도 같은 행이다', () => {
    expect(scoreRowOf(buildCompareScorecard(FOLD, { replay: REPLAY }))).toEqual(NULL_SCORE_ROW);
  });

  it.each([
    ['옛 세 키 블록', { source: null, value: null, reason: 'no-spawn-keyed-score-writer' }],
    ['여분 키가 붙은 블록', { ...FOLD.score, n: 0, audits: 0, extra: 'x' }],
  ])('%s 도 같은 행이다', (_name, score) => {
    const built = buildCompareScorecard({ ...FOLD, score }, { replay: REPLAY });
    expect(scoreRowOf(built)).toEqual(NULL_SCORE_ROW);
  });

  it('reason 만 바뀌면 note 의 그 자리만 바뀐다', () => {
    const built = buildCompareScorecard(
      { ...FOLD, score: { source: null, value: null, reason: 'r' } },
      { replay: REPLAY },
    );
    expect(scoreRowOf(built)).toEqual({
      ...NULL_SCORE_ROW,
      note: NULL_SCORE_ROW.note.replace('no-spawn-keyed-score-writer', 'r'),
    });
  });

  it('basis 는 null 블록 행에 찍지 않는다 (출력 무변경이 우선이다)', () => {
    const { basis } = FOLD.score;
    expect(typeof basis, '자기검증: 생산자의 null 블록은 basis 를 갖는다').toBe('string');
    const built = buildCompareScorecard(FOLD, { replay: REPLAY });
    expect(JSON.stringify(scoreRowOf(built))).not.toContain(basis);
    expect(renderScorecardMarkdown(built)).not.toContain(basis);
  });

  it('렌더: 표 행과 근거 행이 옛 바이트와 같다', () => {
    const out = renderScorecardMarkdown(cardOf([]));
    expect(out).toContain('| 스폰 결과 점수 (측정자 없음) | unmeasured | 0 | unmeasured | 0 | unmeasured |');
    expect(out).toContain(`| ${NULL_SCORE_ROW.label} | ${NULL_SCORE_ROW.source} | ${NULL_SCORE_ROW.note} |`);
  });
});

// ---------------------------------------------------------------------------
describe('score 행 (5) — 형식이 틀린 블록은 던지지 않고 "측정 불가" 로 표기한다', () => {
  // 생산자가 만든 audit-bearing 블록을 한 필드씩 망가뜨린 사본으로 본다. 블록이 알려진 두
  // 모양(source·value 가 null 인 블록 / review.claim_audit 블록) 어느 쪽도 아니면 카드 전체가
  // 아니라 그 행만 표기를 바꾼다 — 던지면 나머지 8행도 같이 사라지고, 조용히 점수를 실으면
  // 검증되지 않은 수치가 측정값으로 읽힌다.
  const PRODUCED = joinSpawnOutcomes(scoredFixture()).score;
  const dropped = (key) => Object.fromEntries(Object.entries(PRODUCED).filter(([k]) => k !== key));
  const NO_ROWS = {
    n: 0, audits: 0, unjoined_audits: 0, no_subject_audits: 0, malformed_audits: 0,
  };
  const cardWith = (score) => buildCompareScorecard(
    { ...joinSpawnOutcomes(scoredFixture()), score },
    { replay: labelReplay(scoredFixture()) },
  );

  // [이름, score 블록, 표기 note 가 이름으로 짚어야 하는 필드]
  const MALFORMED = [
    ['source 가 숫자', { source: 5, value: null, reason: 'r' }, 'score.source'],
    ['source 가 BigInt', { source: 10n, value: null, reason: 'r' }, 'score.source'],
    ['source 가 알려지지 않은 이벤트 이름', { source: 'review.completed', value: null, reason: 'r' }, 'score.source'],
    ['source 없이 value 만 있음', { source: null, value: 0.82, reason: 'r' }, 'score.value'],
    ['null 블록의 value 가 문자열', { source: null, value: 'x', reason: 'r' }, 'score.value'],
    ['null 블록의 reason 이 빈 문자열', { source: null, value: null, reason: '' }, 'score.reason'],
    ['null 블록에 reason 이 없음', { source: null, value: null }, 'score.reason'],
    ['빈 객체', {}, 'score.source'],
    ['value 가 1 을 넘음', { ...PRODUCED, value: 1.5 }, 'score.value'],
    ['value 가 음수', { ...PRODUCED, value: -0.1 }, 'score.value'],
    ['value 가 NaN', { ...PRODUCED, value: Number.NaN }, 'score.value'],
    ['value 가 Infinity', { ...PRODUCED, value: Number.POSITIVE_INFINITY }, 'score.value'],
    ['value 가 문자열', { ...PRODUCED, value: '0.75' }, 'score.value'],
    ['value 와 reason 이 둘 다 있음', { ...PRODUCED, reason: 'why' }, 'score.reason'],
    ['value 와 reason 이 둘 다 null', { ...PRODUCED, value: null, reason: null }, 'score.reason'],
    ['value 가 있는데 조인된 audit n 이 0', { ...PRODUCED, n: 0, unjoined_audits: 5 }, 'score.n'],
    ['basis 가 없음', dropped('basis'), 'score.basis'],
    ['basis 가 빈 문자열', { ...PRODUCED, basis: '' }, 'score.basis'],
    ['basis 가 여러 줄', { ...PRODUCED, basis: 'a\nb' }, 'score.basis'],
    ['basis 가 숫자', { ...PRODUCED, basis: 7 }, 'score.basis'],
    ['n 이 소수', { ...PRODUCED, n: 1.5 }, 'score.n'],
    ['audits 가 문자열', { ...PRODUCED, audits: '6' }, 'score.audits'],
    ['malformed_audits 가 음수', { ...PRODUCED, malformed_audits: -1 }, 'score.malformed_audits'],
    ['unjoined_audits 가 없음', dropped('unjoined_audits'), 'score.unjoined_audits'],
    ['audits 가 n + unjoined + no_subject 와 다름', { ...PRODUCED, audits: 7 }, 'score.audits'],
    ['audit 행을 하나도 안 읽었는데 source 가 audit', { ...PRODUCED, ...NO_ROWS, value: null, reason: 'r' }, '읽은 audit 행이 0'],
  ];

  it('픽스처 자기검증: 망가뜨리기 전의 생산자 블록은 정상 행으로 찍힌다', () => {
    expect(PRODUCED.source).toBe(CLAIM_AUDIT_JOIN_EVENTS.audit);
    expect(scoreRowOf(cardWith(PRODUCED)).label).toBe(AUDIT_LABEL);
  });

  it.each(MALFORMED)('%s → 던지지 않고 측정 불가 행이 된다', (_name, score, field) => {
    const card = cardWith(score);
    const row = scoreRowOf(card);
    expect(row.label).toBe(UNREADABLE_LABEL);
    expect(row).toMatchObject({
      denominator: 0, numerator: null, ratio: null, counts: null, measured: false, state: 'unmeasured',
    });
    expect(row.note).toContain('측정 불가');
    expect(row.note, `note 가 ${field} 를 짚지 않는다`).toContain(field);
    // 조용히 점수를 싣지 않는다: 수치도, 그 블록이 들고 온 값도 행에 없다.
    expect(row.note).not.toMatch(/\d\.\d{2,}/);
    if (typeof score.value === 'number' && Number.isFinite(score.value)) {
      expect(JSON.stringify(row)).not.toContain(String(score.value));
    }
    expect(card.unmeasured).toContain('compare.score');
    expect(card.metrics.map((m) => m.key)).toEqual(ROW_KEYS);
    expect(otherRowsOf(card)).toEqual(otherRowsOf(cardWith(PRODUCED)));
    expect(renderScorecardMarkdown(card)).toContain(
      `| ${UNREADABLE_LABEL} | unmeasured | 0 | unmeasured | 0 | unmeasured |`,
    );
  });

  it('표기는 한 줄이다 — 값에 개행·파이프가 있어도 표가 갈라지지 않는다', () => {
    const forged = cardWith({ source: 'a\nb | c', value: null, reason: 'r' });
    expect(scoreRowOf(forged).note).not.toMatch(/[\r\n]/);
    const lines = (card) => renderScorecardMarkdown(card).split('\n').length;
    expect(lines(forged)).toBe(lines(cardOf(auditedSpawns())));
  });

  it('측정 불가 행은 null 블록 행과 다른 행이다 (빈 원장으로 읽히지 않는다)', () => {
    const bad = scoreRowOf(cardWith({ source: 5, value: null, reason: 'r' }));
    const empty = scoreRowOf(cardOf(auditedSpawns()));
    expect(bad.label).not.toBe(empty.label);
    expect(bad.note).not.toContain('no-spawn-keyed-score-writer');
    expect(bad.note).not.toContain('영구 unmeasured');
  });

  it('얼려 들어온 블록을 변형하지 않고 카드와 행은 frozen 이다', () => {
    const built = cardWith(Object.freeze({ ...PRODUCED, value: 1.5 }));
    expect(Object.isFrozen(built)).toBe(true);
    expect(Object.isFrozen(scoreRowOf(built))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('배럴 — lib/scorecard/index.js 에서 보인다', () => {
  it('COMPARE_KIND 와 buildCompareScorecard 를 재수출한다', () => {
    expect(barrel.COMPARE_KIND).toBe('compare');
    expect(barrel.buildCompareScorecard).toBe(buildCompareScorecard);
  });

  it('기존 4블록 수출이 살아 있다', () => {
    for (const name of ['ROUTING_KIND', 'SESSION_KIND', 'metric', 'renderScorecardMarkdown']) {
      expect(typeof barrel[name], `${name} 이 배럴에서 사라졌다`).not.toBe('undefined');
    }
  });
});
