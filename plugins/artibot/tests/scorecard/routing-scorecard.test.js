/**
 * Routing-scorecard stem tests — the live-shaped fixture.
 *
 * `scorecard.test.js` owns the broad card contract. This file exists for one
 * gap that file cannot honestly close: its receipts are hand-shaped, and the
 * repo rule (§9) says a fixture whose shape differs from production proves
 * nothing about production. So the receipt here is a byte-for-byte copy of the
 * `data.reason` / `models` / `decision` shape the live writer emits
 * (`lib/routing/adaptive-model-router.js#routeModel`, measured on the live
 * ledger 2026-09-14 09:10 KST: 8 reason codes opening with `class:agent`,
 * `hysteresis:minimum-residency` present, `decision.type` always `route`,
 * `models.current` null). If the writer changes shape, this is the test that
 * should go red first.
 *
 * @module tests/scorecard/routing-scorecard
 */

import { describe, expect, it } from 'vitest';
import { buildReplay } from '../../lib/replay/index.js';
import { buildEnvelope } from '../../lib/runtime/event-writer.js';
import {
  buildRoutingScorecard,
  classifyAvoidedReason,
  foldAvoidedSwitches,
  foldHoldReasons,
  foldResidencyCounter,
  HOLD_REASON_CODES,
  hysteresisCodes,
  RESIDENCY_UNAVAILABLE,
} from '../../lib/scorecard/index.js';
import { renderScorecardMarkdown } from '../../lib/scorecard/render.js';
import { routeModel } from '../../lib/routing/adaptive-model-router.js';
import { DEFAULT_CATALOG } from '../../lib/routing/route-scorer.js';

/** The live reason vector for a diverged spawn (router recommended opus, policy chose fable). */
const LIVE_DIVERGED_REASON = Object.freeze([
  'class:agent', 'effort:unavailable', 'budget:unavailable', 'route:opus', 'policy:fable',
  'divergence', 'hysteresis:minimum-residency', 'residency:unavailable',
]);

/** The live reason vector for an agreeing spawn — same codes, minus `divergence`. */
const LIVE_AGREED_REASON = Object.freeze([
  'class:agent', 'effort:unavailable', 'budget:unavailable', 'route:opus', 'policy:opus',
  'hysteresis:minimum-residency', 'residency:unavailable',
]);

const identity = (tier) => ({
  provider: 'anthropic', family: 'claude', tier, model_id: `claude-${tier}-5`,
  version: `claude-${tier}-5`, catalog_version: '2026-09-02',
});

/**
 * One live-shaped `route.selected` line.
 *
 * @param {number} seq - ordering term.
 * @param {string} recommended - router tier.
 * @param {string} selected - policy tier.
 * @param {readonly string[]} reason - receipt reason codes.
 * @returns {object} envelope.
 */
function liveLine(seq, recommended, selected, reason) {
  return buildEnvelope({
    session_id: 'sess-live-0001',
    source: 'hook',
    mission_id: 'M-20260914-001',
    event: 'route.selected',
    routing_epoch_id: `toolu_${seq}`,
    ts: `2026-09-14T00:10:${String(seq).padStart(2, '0')}.000Z`,
    data: {
      models: { current: null, recommended: identity(recommended), selected: identity(selected) },
      decision: { type: 'route' },
      reason: [...reason],
      source: 'shadow',
    },
  }, { pid: 4242, seq });
}

const LIVE_LINES = [
  liveLine(1, 'opus', 'fable', LIVE_DIVERGED_REASON),
  liveLine(2, 'opus', 'opus', LIVE_AGREED_REASON),
  liveLine(3, 'fable', 'fable', LIVE_AGREED_REASON),
  liveLine(4, 'opus', 'fable', LIVE_DIVERGED_REASON),
];

describe('routing-scorecard — 라이브 모양 영수증', () => {
  it('첫 코드가 class:agent 여도 residency 로 사상된다 (첫 코드 사상이 아니다)', () => {
    expect(classifyAvoidedReason([...LIVE_DIVERGED_REASON])).toBe('residency');
    expect(LIVE_DIVERGED_REASON[0]).toBe('class:agent');
  });

  it('추천≠선택 2건이 avoided, decision 이 route 뿐이라 pinned 는 0 이다', () => {
    const fold = foldAvoidedSwitches(buildReplay(LIVE_LINES).routes);
    expect(fold).toEqual({
      avoided: 2,
      pinned: 0,
      byReason: { residency: 2 },
      byDecision: { route: 2 },
      comparable: 4,
      denominator: 4,
    });
  });

  it('카드 행: avoided_switch 는 2/4, avoided_switch_pinned 는 0/2 measured (unmeasured 아님)', () => {
    const card = buildRoutingScorecard(buildReplay(LIVE_LINES));
    const avoided = card.metrics.find((m) => m.key === 'routing.avoided_switch');
    const pinned = card.metrics.find((m) => m.key === 'routing.avoided_switch_pinned');
    expect([avoided.numerator, avoided.denominator, avoided.absent]).toEqual([2, 4, 0]);
    expect(avoided.counts).toEqual({ residency: 2 });
    expect([pinned.numerator, pinned.denominator, pinned.state]).toEqual([0, 2, 'measured']);
    expect(pinned.ratio).toBe(0);
  });

  it('models 없는 라이브 모양 줄이 섞여도 카드가 서고, 그 줄은 tier_comparability 에서 보인다', () => {
    const withoutModels = buildEnvelope({
      session_id: 'sess-live-0001',
      source: 'hook',
      mission_id: 'M-20260914-001',
      event: 'route.selected',
      routing_epoch_id: 'toolu_5',
      ts: '2026-09-14T00:10:05.000Z',
      data: { decision: { type: 'route' }, reason: [...LIVE_AGREED_REASON], source: 'shadow' },
    }, { pid: 4242, seq: 5 });
    const card = buildRoutingScorecard(buildReplay([...LIVE_LINES, withoutModels]));
    const row = (key) => {
      const m = card.metrics.find((x) => x.key === key);
      return [m.numerator, m.denominator, m.absent];
    };
    expect(row('routing.tier_comparability')).toEqual([4, 5, 0]);
    expect(row('routing.recommendation_divergence')).toEqual([2, 4, 0]);
    expect(row('routing.avoided_switch')).toEqual([2, 4, 0]);
  });

  it('두 번 접어도 바이트가 같다', () => {
    const replay = buildReplay(LIVE_LINES);
    expect(JSON.stringify(buildRoutingScorecard(replay)))
      .toBe(JSON.stringify(buildRoutingScorecard(buildReplay([...LIVE_LINES].reverse()))));
  });
});

// ---------------------------------------------------------------------------
/**
 * One `route.selected` line for the hold-reason fixture.
 *
 * Live-shaped on purpose: `class:*` and `effort:*` open every real `reason[]`
 * (`adaptive-model-router.js#routeModel`), and the live writer emits AT MOST
 * ONE `hysteresis:*` code per line because `evaluateSwitch` pushes exactly one.
 * Line `e` below is the multi-code case, which only a caller-supplied
 * `src.hysteresis` can produce — it is in the fixture because the fold must not
 * assume the single-code shape.
 *
 * @param {number} seq - ordering term.
 * @param {unknown} reason - the receipt's `reason[]`, or a non-array.
 * @param {number|null|undefined} actions - `data.actionsSinceSwitch`.
 * @returns {object} envelope.
 */
function holdLine(seq, reason, actions) {
  const data = {
    models: { current: null, recommended: identity('opus'), selected: identity('opus') },
    decision: { type: 'route' },
    reason,
  };
  if (actions !== undefined) data.actionsSinceSwitch = actions;
  return buildEnvelope({
    session_id: 'sess-hold-0001',
    source: 'hook',
    mission_id: 'M-20260921-001',
    event: 'route.selected',
    routing_epoch_id: `toolu_h${seq}`,
    ts: `2026-09-21T00:10:${String(seq).padStart(2, '0')}.000Z`,
    data,
  }, { pid: 4343, seq });
}

const OPEN = Object.freeze(['class:agent', 'effort:unavailable']);

// 한 줄 = 한 케이스. 어느 줄이 깨졌는지 바로 읽히도록 순서를 고정한다.
// a 와 k 는 짝이다: 둘 다 actionsSinceSwitch 가 0 이지만 a 는 writer 가 결측이라 표시한
// 0 이고(residency:unavailable) k 는 실측 0 이다. 이 둘이 같은 버킷에 들면 레드가 된다.
const HOLD_LINES = [
  /* a */ holdLine(1, [...OPEN, 'hysteresis:minimum-residency', 'residency:unavailable'], 0),
  /* b */ holdLine(2, [...OPEN, 'hysteresis:above-threshold'], 5),
  /* c */ holdLine(3, [...OPEN, 'hysteresis:same-tier'], 3),
  /* d */ holdLine(4, [...OPEN, 'hysteresis:residency-unknown']),
  /* e */ holdLine(5, [...OPEN, 'hysteresis:above-threshold', 'hysteresis:minimum-residency'], 2),
  /* f */ holdLine(6, [...OPEN, 'hysteresis:override:because_i_said_so']),
  /* g */ holdLine(7, [...OPEN, 'policy:fable']),
  /* h */ holdLine(8, 'not-an-array', null),
  /* i */ holdLine(9, ['hysteresis:below-threshold', 'hysteresis:below-threshold']),
  /* j */ holdLine(10, [...OPEN, 'hysteresis:hysteresis-band'], 7),
  /* k */ holdLine(11, [...OPEN, 'hysteresis:minimum-residency'], 0),
];

const holdReplay = buildReplay(HOLD_LINES);
const holdCard = buildRoutingScorecard(holdReplay);
const rowOf = (card, key) => card.metrics.find((m) => m.key === key);

describe('foldHoldReasons — 분자=보류 코드를 가진 영수증, 분모=hysteresis 코드를 가진 영수증', () => {
  it('보류 코드 allowlist 는 4종이고 above-threshold·same-tier 는 분자 밖이다', () => {
    expect(HOLD_REASON_CODES.hold).toEqual([
      'hysteresis:minimum-residency',
      'hysteresis:residency-unknown',
      'hysteresis:below-threshold',
      'hysteresis:hysteresis-band',
    ]);
    expect(HOLD_REASON_CODES.allow).toEqual(['hysteresis:above-threshold']);
    expect(HOLD_REASON_CODES.no_transition).toEqual(['hysteresis:same-tier']);
  });

  it('residency-unknown 과 minimum-residency 는 별도 버킷이다 (W11-Q2)', () => {
    expect(HOLD_REASON_CODES.hold).toContain('hysteresis:residency-unknown');
    expect(HOLD_REASON_CODES.hold).toContain('hysteresis:minimum-residency');
    const fold = foldHoldReasons(holdReplay.routes);
    expect(fold.counts['hysteresis:residency-unknown']).toBe(1);
    expect(fold.counts['hysteresis:minimum-residency']).toBe(3);
  });

  it('hysteresisCodes 는 hysteresis: 코드만, 영수증 안에서 중복 제거해 낸다', () => {
    expect(hysteresisCodes(holdReplay.routes[0])).toEqual(['hysteresis:minimum-residency']);
    expect(hysteresisCodes(holdReplay.routes[8])).toEqual(['hysteresis:below-threshold']);
    expect(hysteresisCodes(holdReplay.routes[6])).toEqual([]);
    expect(hysteresisCodes(holdReplay.routes[7])).toEqual([]);
  });

  it('분모는 코드를 가진 9건, 분자는 보류 코드를 가진 6건이다 (영수증 단위)', () => {
    const fold = foldHoldReasons(holdReplay.routes);
    expect(fold.denominator).toBe(11);
    expect(fold.withCodes).toBe(9);
    expect(fold.held).toBe(6);
  });

  it('no-candidate·catalog-miss 는 other: 로 착지하고 분모 안·분자 밖이다', () => {
    // 평가가 돌지 못한 줄이라 "라우터가 참았다"의 증거가 아니다. 그래서 분자에는 안 들지만
    // 사라지지도 않는다 — 이 둘이 allowlist 로 올라가면 이 핀이 레드가 된다.
    const fold = foldHoldReasons(buildReplay([
      holdLine(40, [...OPEN, 'hysteresis:no-candidate']),
      holdLine(41, [...OPEN, 'hysteresis:catalog-miss']),
    ]).routes);
    expect([fold.withCodes, fold.held]).toEqual([2, 0]);
    expect(fold.counts).toEqual({
      'other:hysteresis:catalog-miss': 1,
      'other:hysteresis:no-candidate': 1,
    });
  });

  it('allowlist 밖 코드는 분자에 들지 않고 other:<code> 로 보인다', () => {
    const fold = foldHoldReasons(holdReplay.routes);
    expect(fold.counts['other:hysteresis:override:because_i_said_so']).toBe(1);
  });

  it('다중 코드 영수증이 있으면 counts 합이 분모를 넘을 수 있다', () => {
    const fold = foldHoldReasons(holdReplay.routes);
    expect(fold.counts).toEqual({
      'hysteresis:above-threshold': 2,
      'hysteresis:below-threshold': 1,
      'hysteresis:hysteresis-band': 1,
      'hysteresis:minimum-residency': 3,
      'hysteresis:residency-unknown': 1,
      'hysteresis:same-tier': 1,
      'other:hysteresis:override:because_i_said_so': 1,
    });
    const sum = Object.values(fold.counts).reduce((a, b) => a + b, 0);
    expect(sum).toBe(10);
    expect(sum).toBeGreaterThan(fold.withCodes);
  });

  it('입력을 변형하지 않는다', () => {
    const before = JSON.stringify(holdReplay.routes);
    foldHoldReasons(holdReplay.routes);
    expect(JSON.stringify(holdReplay.routes)).toBe(before);
  });

  it('라이브 reason 벡터(코드 줄당 1개)도 그대로 보류로 접힌다', () => {
    const fold = foldHoldReasons(buildReplay(LIVE_LINES).routes);
    expect([fold.withCodes, fold.held]).toEqual([4, 4]);
    expect(fold.counts).toEqual({ 'hysteresis:minimum-residency': 4 });
  });
});

describe('foldResidencyCounter — 분자=값>0, 분모=실측 카운터를 가진 영수증', () => {
  it('실측 5건이 분모, 0 보다 큰 4건이 분자다', () => {
    const fold = foldResidencyCounter(holdReplay.routes);
    expect(fold.denominator).toBe(11);
    expect(fold.present).toBe(5);
    expect(fold.positive).toBe(4);
  });

  it('residency:unavailable 이 있으면 값이 0 이어도 분모 밖이다 (실측 0 과 구별)', () => {
    // a 와 k 는 둘 다 actionsSinceSwitch=0 이고, 갈리는 근거는 reason 뿐이다.
    const fold = foldResidencyCounter(holdReplay.routes);
    expect(fold.unavailable).toBe(1);
    const onlyMeasuredZero = foldResidencyCounter(buildReplay([
      holdLine(50, [...OPEN, 'hysteresis:minimum-residency'], 0),
    ]).routes);
    expect([onlyMeasuredZero.present, onlyMeasuredZero.positive]).toEqual([1, 0]);
    const onlyUnavailableZero = foldResidencyCounter(buildReplay([
      holdLine(51, [...OPEN, 'residency:unavailable'], 0),
    ]).routes);
    expect([onlyUnavailableZero.present, onlyUnavailableZero.unavailable]).toEqual([0, 1]);
  });

  it('세 버킷은 배타적이고 합이 분모와 같다 — 조용히 사라지는 영수증이 없다', () => {
    const fold = foldResidencyCounter(holdReplay.routes);
    expect(fold.present + fold.unavailable + fold.malformed).toBe(fold.denominator);
    expect(fold.malformed).toBe(5);
  });

  it('null·부재는 malformed 로 분모에서 빠진다', () => {
    const fold = foldResidencyCounter(buildReplay([
      holdLine(20, [...OPEN], null),
      holdLine(21, [...OPEN]),
      holdLine(22, [...OPEN], 0),
    ]).routes);
    expect([fold.present, fold.positive, fold.malformed]).toEqual([1, 0, 2]);
  });

  it('비정수(소수·문자열·NaN)는 분모에서 빠지고, 음수는 정수라 들어온다', () => {
    // 음수는 라이브에 도달하지 않는다 — writer 의 nonNegative 가 0 으로 클램프하므로
    // 영수증에 -1 이 실릴 수 없다. 그래도 fold 의 현재 동작을 핀해 둔다.
    const fold = foldResidencyCounter(buildReplay([
      holdLine(30, [...OPEN], 1.5),
      holdLine(31, [...OPEN], '3'),
      holdLine(32, [...OPEN], Number.NaN),
      holdLine(33, [...OPEN], -1),
      holdLine(34, [...OPEN], 4),
    ]).routes);
    expect([fold.present, fold.positive, fold.malformed]).toEqual([2, 1, 3]);
  });

  it('reason 이 배열이 아니면 unavailable 표시 없음으로 본다', () => {
    const fold = foldResidencyCounter(buildReplay([
      holdLine(35, 'not-an-array', 6),
    ]).routes);
    expect([fold.present, fold.positive, fold.unavailable]).toEqual([1, 1, 0]);
  });

  it('입력을 변형하지 않는다', () => {
    const before = JSON.stringify(holdReplay.routes);
    foldResidencyCounter(holdReplay.routes);
    expect(JSON.stringify(holdReplay.routes)).toBe(before);
  });
});

describe('writer↔reader 계약 — routeModel 출력을 그대로 접는다', () => {
  /**
   * Wrap a real `routeModel` receipt as the ledger `data` this fold reads.
   *
   * @param {object} over - `routeModel` input overrides.
   * @param {number} seq - ordering term.
   * @returns {object} envelope.
   */
  const fromWriter = (over, seq) => buildEnvelope({
    session_id: 'sess-writer-0001',
    source: 'hook',
    mission_id: 'M-20260921-002',
    event: 'route.selected',
    routing_epoch_id: `toolu_w${seq}`,
    ts: `2026-09-21T00:20:${String(seq).padStart(2, '0')}.000Z`,
    data: routeModel({
      agentType: 'architect',
      role: 'build',
      catalog: DEFAULT_CATALOG,
      currentTier: 'opus',
      epoch: 'run-1',
      ...over,
    }),
  }, { pid: 4444, seq });

  it('카운터를 안 주면 writer 가 0 + residency:unavailable 을 쓰고, fold 는 결측으로 센다', () => {
    const line = fromWriter({ actionsSinceSwitch: undefined }, 1);
    // writer 쪽 사실을 먼저 고정한다 — 이 전제가 틀렸던 것이 이 행의 첫 결함이었다.
    expect(line.data.actionsSinceSwitch).toBe(0);
    expect(line.data.reason).toContain('residency:unavailable');
    const fold = foldResidencyCounter(buildReplay([line]).routes);
    expect([fold.present, fold.unavailable]).toEqual([0, 1]);
  });

  it('카운터를 주면 표시가 없고 fold 가 실측으로 센다', () => {
    const line = fromWriter({ actionsSinceSwitch: 9 }, 2);
    expect(line.data.actionsSinceSwitch).toBe(9);
    expect(line.data.reason).not.toContain('residency:unavailable');
    const fold = foldResidencyCounter(buildReplay([line]).routes);
    expect([fold.present, fold.positive, fold.unavailable]).toEqual([1, 1, 0]);
  });

  it('실측 0 은 분모에 들어온다 — writer 가 쓰는 결측 0 과 다른 줄이다', () => {
    const line = fromWriter({ actionsSinceSwitch: 0 }, 3);
    expect(line.data.reason).not.toContain('residency:unavailable');
    const fold = foldResidencyCounter(buildReplay([line]).routes);
    expect([fold.present, fold.positive]).toEqual([1, 0]);
  });

  it('reader 의 상수가 writer 가 쓰는 코드와 같은 문자열이다', () => {
    expect(fromWriter({ actionsSinceSwitch: undefined }, 4).data.reason)
      .toContain(RESIDENCY_UNAVAILABLE);
  });
});

describe('buildRoutingScorecard — 보류 사유·잔류 카운터 행', () => {
  it('routing.hold_reasons 는 6/9 이고 counts 를 싣는다', () => {
    const m = rowOf(holdCard, 'routing.hold_reasons');
    expect([m.numerator, m.denominator, m.absent, m.state]).toEqual([6, 9, 0, 'measured']);
    expect(m.counts['hysteresis:minimum-residency']).toBe(3);
  });

  it('routing.hold_reason_coverage 는 9/11 — 코드 없는 영수증이 여기서 보인다', () => {
    const m = rowOf(holdCard, 'routing.hold_reason_coverage');
    expect([m.numerator, m.denominator, m.absent]).toEqual([9, 11, 0]);
    expect(m.ratio).toBeCloseTo(9 / 11, 10);
  });

  it('routing.residency_counter 는 4/5, coverage 행은 5/11 이고 결측 사유를 나눠 싣는다', () => {
    const counter = rowOf(holdCard, 'routing.residency_counter');
    expect([counter.numerator, counter.denominator]).toEqual([4, 5]);
    expect(counter.counts).toBeNull();
    const coverage = rowOf(holdCard, 'routing.residency_counter_coverage');
    expect([coverage.numerator, coverage.denominator]).toEqual([5, 11]);
    expect(coverage.counts).toEqual({
      counter_not_integer: 5,
      measured: 5,
      'residency:unavailable': 1,
    });
    const sum = Object.values(coverage.counts).reduce((a, b) => a + b, 0);
    expect(sum).toBe(coverage.denominator);
  });

  it('새 행은 avoided_switch_pinned 뒤, switch_applied 앞에 온다', () => {
    const keys = holdCard.metrics.map((m) => m.key);
    expect(keys.indexOf('routing.hold_reasons'))
      .toBe(keys.indexOf('routing.avoided_switch_pinned') + 1);
    expect(keys.indexOf('routing.residency_counter_coverage') + 1)
      .toBe(keys.indexOf('routing.switch_applied'));
  });

  it('빈 원장이면 새 네 행 모두 unmeasured 다 — 0% 가 아니다', () => {
    const card = buildRoutingScorecard(buildReplay([]));
    for (const key of [
      'routing.hold_reasons', 'routing.hold_reason_coverage',
      'routing.residency_counter', 'routing.residency_counter_coverage',
    ]) {
      const m = rowOf(card, key);
      expect(m.state).toBe('unmeasured');
      expect(m.ratio).toBeNull();
    }
    expect(rowOf(card, 'routing.hold_reasons').counts).toEqual({});
  });

  it('두 번 접어도 바이트가 같다 (보류 행 포함)', () => {
    expect(JSON.stringify(buildRoutingScorecard(buildReplay([...HOLD_LINES].reverse()))))
      .toBe(JSON.stringify(holdCard));
  });

  it('새 행 네 개의 라벨이 실제로 렌더된다 (분포 절 포함)', () => {
    const md = renderScorecardMarkdown(holdCard);
    expect(md).toContain('ARTIBOT · ROUTING SCORECARD');
    for (const key of [
      'routing.hold_reasons', 'routing.hold_reason_coverage',
      'routing.residency_counter', 'routing.residency_counter_coverage',
    ]) {
      expect(md, key).toContain(rowOf(holdCard, key).label);
    }
    // 분포 절에 코드별 버킷과 결측 사유가 실제로 실린다.
    expect(md).toContain('hysteresis:minimum-residency');
    expect(md).toContain('counter_not_integer');
  });
});
