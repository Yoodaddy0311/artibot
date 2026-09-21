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
 *
 * @module tests/scorecard/compare-scorecard
 */

import { describe, expect, it } from 'vitest';
import { joinSpawnOutcomes } from '../../lib/replay/index.js';
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

const EVENTS = mainFixture();
const FOLD = joinSpawnOutcomes(EVENTS);

/** Row keys in render order — the card's shape, asserted as an array. */
const ROW_KEYS = [
  'compare.pairs',
  'compare.agreement',
  'compare.confidence',
  'compare.cost',
  'compare.excluded_fifo',
  'compare.unjoined_binds',
  'compare.unjoined_receipts',
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
  const card = buildCompareScorecard(FOLD);

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
    const counts = card.metrics.find((m) => m.key === 'compare.cost').counts;
    expect(Object.keys(counts)).toEqual(['agreed_priced', 'diverged_priced', 'unpriced']);
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
  });

  it('totals 와 unmeasured 가 카드에서 파생된다', () => {
    expect(card.totals).toEqual({ metrics: 8, measured: 7, unmeasured: 1 });
    expect(card.unmeasured).toEqual(['compare.score']);
  });

  it('since 라벨을 scope 에 그대로 싣는다 (카드는 필터링하지 않는다)', () => {
    const scoped = buildCompareScorecard(FOLD, { since: '2026-09-20T00:00:00.000Z' });
    expect(scoped.scope).toEqual({ scope: 'index', since: '2026-09-20T00:00:00.000Z' });
    // The label is a LABEL: the same fold gives the same rows either way.
    expect(scoped.metrics.map((m) => m.numerator)).toEqual(card.metrics.map((m) => m.numerator));
  });
});

// ---------------------------------------------------------------------------
describe('보조 픽스처 A — 제외 경로 (주 픽스처에 fifo 쌍이 0 이라 따로 덮는다)', () => {
  const fold = joinSpawnOutcomes(exclusionFixture());
  const card = buildCompareScorecard(fold);
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
  const fold = joinSpawnOutcomes(unpricedDivergenceFixture());
  const card = buildCompareScorecard(fold);
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
describe('결정성 — 입력을 섞어도 바이트가 같다', () => {
  const base = buildCompareScorecard(FOLD);

  it.each([1, 7, 20260921])('시드 %i 로 섞은 입력이 같은 JSON 바이트를 낸다', (seedValue) => {
    const card = buildCompareScorecard(joinSpawnOutcomes(shuffled(EVENTS, seedValue)));
    expect(JSON.stringify(card)).toBe(JSON.stringify(base));
  });

  it('섞은 입력이 같은 마크다운 바이트를 낸다', () => {
    const card = buildCompareScorecard(joinSpawnOutcomes(shuffled(EVENTS, 99)));
    expect(renderScorecardMarkdown(card)).toBe(renderScorecardMarkdown(base));
  });

  it('셔플 자기검증 — 순열이 실제로 순서를 바꾼다', () => {
    // 이 단언이 없으면 위 네 건은 "셔플이 항등함수다" 로도 그린이 된다.
    const permuted = shuffled(EVENTS, 7);
    expect(permuted.length).toBe(EVENTS.length);
    expect(permuted.map((e) => e.seq)).not.toEqual(EVENTS.map((e) => e.seq));
    expect([...permuted].sort((a, b) => a.seq - b.seq).map((e) => e.seq))
      .toEqual([...EVENTS].sort((a, b) => a.seq - b.seq).map((e) => e.seq));
  });
});

// ---------------------------------------------------------------------------
describe('렌더 — compare kind 가 인쇄된다', () => {
  it('heading 과 scope 를 찍는다', () => {
    const out = renderScorecardMarkdown(buildCompareScorecard(FOLD, { since: '2026-09-20' }));
    expect(out).toContain('# ARTIBOT · COMPARE SCORECARD');
    expect(out).toContain('- **scope**: `index`');
    expect(out).toContain('- **since**: `2026-09-20`');
  });

  it('측정된 행은 퍼센트로, score 행은 unmeasured 로 찍힌다', () => {
    const out = renderScorecardMarkdown(buildCompareScorecard(FOLD));
    expect(out).toContain('88.1%'); // 37/42
    expect(out).toContain('unmeasured');
    expect(out).toContain('1 / 8 지표가 분모 0 이다');
  });

  it('histogram 이 분포 절에 나온다', () => {
    const out = renderScorecardMarkdown(buildCompareScorecard(FOLD));
    expect(out).toContain('## 분포');
    expect(out).toContain('agreed_priced');
  });
});

// ---------------------------------------------------------------------------
describe('분모 0 — 빈 원장은 8행 전부 unmeasured 다', () => {
  const card = buildCompareScorecard(joinSpawnOutcomes([]));

  it('행 8개가 모두 unmeasured 이고 ratio 가 null 이다', () => {
    expect(card.metrics.map((m) => m.key)).toEqual(ROW_KEYS);
    for (const m of card.metrics) {
      expect(m.state, `${m.key} 가 measured 다`).toBe('unmeasured');
      expect(m.ratio, `${m.key} 의 ratio 가 null 이 아니다`).toBeNull();
      expect(m.denominator).toBe(0);
    }
  });

  it('unmeasured 색인이 8키 전부다', () => {
    expect(card.unmeasured).toEqual(ROW_KEYS);
    expect(card.totals).toEqual({ metrics: 8, measured: 0, unmeasured: 8 });
  });

  it('렌더 출력에 퍼센트 수치가 없다', () => {
    // 리터럴 '0%' 를 금지할 수는 없다 — 렌더러 자신의 미측정 절이 "0% 가 아니라
    // 미측정이다" 라는 경고 산문을 찍는다(render.js#renderScorecardMarkdown, 미측정
    // 분기). 금지 대상은 렌더된 수치이므로 sibling 스위트와 같은 형태로 본다
    // (tests/scorecard/scorecard.test.js '분모 0 인 행은 ... 퍼센트 수치를 찍지 않는다').
    const out = renderScorecardMarkdown(card);
    expect(out).not.toMatch(/\d+\.\d+%/);
    expect(out).toContain('unmeasured');
    expect(out).toContain('8 / 8 지표가 분모 0 이다');
  });
});

// ---------------------------------------------------------------------------
describe('fail-closed — 배선 오류가 빈 카드로 보이지 않는다', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['배열', []],
    ['문자열', 'fold'],
    ['숫자', 0],
  ])('%s 은 fold 가 아니다', (_name, bad) => {
    expect(() => buildCompareScorecard(bad)).toThrow(TypeError);
  });

  it('replay 인덱스를 넘기면 던진다 (평탄화 경로가 빈 원장처럼 보이지 않게)', () => {
    const replayShaped = { routes: [], switches: [], bound: [], totals: { indexed: 0 } };
    expect(() => buildCompareScorecard(replayShaped)).toThrow(/pairs/);
  });

  it.each([
    'pairs', 'binds', 'compared', 'excluded_fifo', 'unjoined_binds', 'unjoined_receipts',
    'by_agreement', 'by_confidence', 'cost', 'score',
  ])('필수 필드 %s 가 없으면 던진다', (field) => {
    const broken = { ...FOLD };
    delete broken[field];
    expect(() => buildCompareScorecard(broken)).toThrow(TypeError);
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
    ['score 가 null', { score: null }],
    ['score.reason 이 빈 문자열', { score: { source: null, value: null, reason: '' } }],
  ])('%s 이면 던진다', (_name, patch) => {
    expect(() => buildCompareScorecard({ ...FOLD, ...patch })).toThrow(TypeError);
  });

  it.each([
    ['숫자', 1758400000000],
    ['Date 유사 객체', { toISOString: 'nope' }],
    ['배열', ['2026-09-20']],
  ])('since 가 %s 면 던진다', (_name, bad) => {
    expect(() => buildCompareScorecard(FOLD, { since: bad })).toThrow(TypeError);
  });

  it('since 는 문자열·null·생략만 받는다', () => {
    expect(() => buildCompareScorecard(FOLD, { since: null })).not.toThrow();
    expect(() => buildCompareScorecard(FOLD, {})).not.toThrow();
    expect(() => buildCompareScorecard(FOLD)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
describe('불변 — 카드는 얼고 입력은 그대로다', () => {
  it('카드·scope·metrics·행이 전부 frozen 이다', () => {
    const card = buildCompareScorecard(FOLD);
    expect(Object.isFrozen(card)).toBe(true);
    expect(Object.isFrozen(card.scope)).toBe(true);
    expect(Object.isFrozen(card.metrics)).toBe(true);
    expect(Object.isFrozen(card.unmeasured)).toBe(true);
    for (const m of card.metrics) expect(Object.isFrozen(m)).toBe(true);
  });

  it('입력 fold 를 변형하지 않는다', () => {
    const fold = joinSpawnOutcomes(EVENTS);
    const before = JSON.stringify(fold);
    buildCompareScorecard(fold, { since: '2026-09-20T00:00:00.000Z' });
    expect(JSON.stringify(fold)).toBe(before);
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
