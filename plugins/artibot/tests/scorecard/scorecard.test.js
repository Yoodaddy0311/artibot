/**
 * Unit contract for the ledger's Scorecard fold.
 *
 * ── WHAT THIS SUITE CANNOT SEE (repo rules §9) ──────────────────────────────
 *   - ZERO LIVE LEDGER LINES. Every fixture below is written by this file
 *     through `buildEnvelope`, the same assembler the writer uses. Ledger
 *     writers DID land in this batch (pre-bash, subagent-handler, tasks), but
 *     nothing here has ever been compared against a real run. What is verified
 *     is agreement with the ENVELOPE AND RECEIPT CONTRACTS, not agreement with
 *     reality. A green suite says the arithmetic is right about invented data.
 *   - FIXTURE SCALE ≠ LIVE SCALE. The largest fixture here is a dozen lines.
 *     Nothing here says anything about folding a rotated ledger, and the
 *     metrics are all O(n) counts whose cost at size is untested.
 *   - WHETHER THE METRIC SET IS THE RIGHT ONE. The suite pins what each metric
 *     computes and where its denominator comes from. It cannot tell you that
 *     §34's ROUTING block wanted these ten rows rather than some other ten;
 *     the five §34 rows this card deliberately omits are argued in the module
 *     headers and asserted nowhere, because absence of a metric has no
 *     mechanical signature.
 *   - PURITY BEYOND A SOURCE GREP. The purity test strips comments and greps
 *     for effect tokens. It would not catch an effect reached indirectly, e.g.
 *     through a helper imported from another layer. What keeps that honest is
 *     the eslint L2 block, which is a different gate.
 *   - RENDERED WIDTH. `renderScorecardMarkdown` emits Markdown; nothing here
 *     checks that a table is readable in a terminal at any width.
 *
 * @module tests/scorecard/scorecard
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildReplay } from '../../lib/replay/index.js';
import { buildEnvelope } from '../../lib/runtime/event-writer.js';
import {
  AVOIDED_SWITCH_REASONS,
  buildRoutingScorecard,
  buildSessionScorecard,
  classifyAvoidedReason,
  COST_TERMS,
  DECISION_TYPES,
  foldAvoidedSwitches,
  metric,
  METRIC_STATE,
  renderScorecardMarkdown,
  UNMEASURED_TEXT,
} from '../../lib/scorecard/index.js';

const PLUGIN_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const SCORECARD_DIR = path.join(PLUGIN_ROOT, 'lib', 'scorecard');
const SID = 'sess-sc-0001';
const OTHER_SID = 'sess-sc-0002';
const MISSION = 'M-20260902-777';

/** Read as UTF-8 with CRLF normalized — the repo checks out CRLF on this host. */
const read = (p) => readFileSync(p, 'utf-8').replace(/\r\n/g, '\n');

/**
 * Build one well-formed ledger line with fully controlled ordering terms.
 *
 * `ts`, `pid` and `seq` are always explicit: a fixture that leans on the real
 * clock or the real pid cannot make a claim about ordering.
 *
 * @param {object} fields - envelope fields; `event` at minimum.
 * @param {number} seq - ordering term; also drives the timestamp.
 * @returns {object} envelope.
 */
function line(fields, seq) {
  const ts = `2026-09-02T10:00:${String(seq).padStart(2, '0')}.000Z`;
  return buildEnvelope(
    { session_id: SID, source: 'hook', mission_id: MISSION, ts, ...fields },
    { pid: 100, seq },
  );
}

/**
 * A route receipt's `data`, with only the fields these metrics read.
 *
 * `reason` is last and optional so every existing call site keeps its meaning:
 * a receipt written without one is the Phase 0 shape the seed already uses, and
 * `classifyAvoidedReason` has to answer for that shape too.
 */
const receipt = (decision, recommended, selected, terms, reason) => ({
  decision: { type: decision },
  ...(recommended || selected
    ? { models: { ...(recommended ? { recommended: { tier: recommended } } : {}),
      ...(selected ? { selected: { tier: selected } } : {}) } }
    : {}),
  ...(terms ? { terms } : {}),
  ...(reason ? { reason } : {}),
});

/** Two cost terms, one measured and one estimated — the §8.2 R2 shape. */
const TERMS = Object.freeze({
  contextRebuild: { value: 1, measured: true },
  handoffLatency: { value: 2, measured: false },
});

/**
 * A small but complete stream: three route receipts across two epochs, two
 * usage receipts, one retry, one asked/resolved pair, one checkpoint, and one
 * line belonging to a DIFFERENT session so scoping has something to exclude.
 *
 * @returns {object[]} ledger lines in emission order.
 */
function seed() {
  return [
    line({ event: 'mission.created', data: { title: 'T', intent_revision: 1 } }, 0),
    line({
      event: 'route.selected',
      source: 'scheduler',
      action_id: 'act-1',
      routing_epoch_id: 'ep-1',
      data: receipt('route', 'opus', 'opus', TERMS),
    }, 1),
    line({
      event: 'route.selected',
      source: 'scheduler',
      action_id: 'act-2',
      routing_epoch_id: 'ep-2',
      data: receipt('pin', 'fable', 'opus', TERMS),
    }, 2),
    line({
      event: 'route.selected',
      source: 'scheduler',
      action_id: 'act-3',
      routing_epoch_id: 'ep-2',
      data: receipt('pin'),
    }, 3),
    line({
      event: 'usage.receipt',
      source: 'worker',
      action_id: 'act-1',
      model: 'claude-opus-5',
      data: { model_identity: { tier: 'opus' } },
    }, 4),
    line({
      event: 'usage.receipt',
      source: 'worker',
      action_id: 'act-2',
      model: 'claude-fable-5-1',
      data: { model_identity: { tier: 'fable' } },
    }, 5),
    line({ event: 'retry.scheduled', action_id: 'act-1', data: { attempt: 2, reason: 'x' } }, 6),
    line({ event: 'human.asked', action_id: 'act-1', data: { question_id: 'q1' } }, 7),
    line({
      event: 'human.resolved',
      source: 'human',
      action_id: 'act-1',
      data: { question_id: 'q1', decision: 'go' },
    }, 8),
    line({
      event: 'mission.checkpointed',
      source: 'supervisor',
      data: { checkpoint_id: 'cp-1', trigger: 'save' },
    }, 9),
    line({ event: 'tool.used', action_id: 'act-1', data: { tool: 'Bash', ok: true, duration_ms: 3 } }, 10),
    // A different session, same mission. Everything scoped must exclude it.
    buildEnvelope(
      {
        session_id: OTHER_SID,
        source: 'hook',
        mission_id: MISSION,
        ts: '2026-09-02T10:00:11.000Z',
        event: 'tool.used',
        action_id: 'act-9',
        data: { tool: 'Read', ok: true, duration_ms: 1 },
      },
      { pid: 100, seq: 11 },
    ),
  ];
}

/** A deterministic permutation — no randomness, so a failure reproduces. */
function shuffled(events) {
  const out = [...events];
  for (let i = 0; i < out.length; i += 1) {
    const j = (i * 7 + 3) % out.length;
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Find one metric by key, failing loudly rather than returning undefined.
 *
 * @param {object} card - a scorecard.
 * @param {string} key - metric key.
 * @returns {object} the metric.
 */
function pick(card, key) {
  const found = card.metrics.find((m) => m.key === key);
  expect(found, `metric ${key} 없음. 있는 키: ${card.metrics.map((m) => m.key).join(', ')}`)
    .toBeTruthy();
  return found;
}

const replay = buildReplay(seed());
const sessionCard = buildSessionScorecard(replay, { session_id: SID });
const routingCard = buildRoutingScorecard(replay);
const emptyReplay = buildReplay([]);

// ---------------------------------------------------------------------------
describe('metric() — 분모 없는 숫자를 만들지 않는다', () => {
  it('분모 0 이면 unmeasured 이고 ratio 는 null 이다 (0% 아님)', () => {
    const m = metric({ key: 'k', label: 'L', source: 'S', denominator: 0, numerator: 0 });
    expect(m.measured).toBe(false);
    expect(m.state).toBe(METRIC_STATE.UNMEASURED);
    expect(m.ratio).toBeNull();
  });

  it('분모가 있으면 0 도 진짜 0 이다 — 미측정과 구별된다', () => {
    const m = metric({ key: 'k', label: 'L', source: 'S', denominator: 4, numerator: 0 });
    expect(m.measured).toBe(true);
    expect(m.ratio).toBe(0);
  });

  it('분자가 분모를 넘는 경우를 표현할 수 있다 (asked 없는 resolved)', () => {
    // 이 케이스를 막으면 빌더가 더 약한 분모를 고르게 되고, 그러면 이상 신호가
    // 어디에서도 안 보이게 된다. metric.js 헤더의 판단 근거를 여기서 고정한다.
    const m = metric({ key: 'k', label: 'L', source: 'S', denominator: 1, numerator: 3 });
    expect(m.ratio).toBe(3);
  });

  it.each([
    ['key 없음', { label: 'L', source: 'S', denominator: 0 }],
    ['label 없음', { key: 'k', source: 'S', denominator: 0 }],
    ['source 없음', { key: 'k', label: 'L', denominator: 0 }],
    ['denominator 없음', { key: 'k', label: 'L', source: 'S' }],
    ['denominator 음수', { key: 'k', label: 'L', source: 'S', denominator: -1 }],
    ['denominator 소수', { key: 'k', label: 'L', source: 'S', denominator: 1.5 }],
    ['absent > denominator', { key: 'k', label: 'L', source: 'S', denominator: 1, absent: 2 }],
  ])('%s 이면 던진다 (조용히 unmeasured 로 만들지 않는다)', (_name, spec) => {
    expect(() => metric(spec)).toThrow(TypeError);
  });

  it('counts 는 키 정렬돼 직렬화가 결정적이다', () => {
    const a = metric({ key: 'k', label: 'L', source: 'S', denominator: 3, counts: { b: 1, a: 2 } });
    const b = metric({ key: 'k', label: 'L', source: 'S', denominator: 3, counts: { a: 2, b: 1 } });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

// ---------------------------------------------------------------------------
describe('buildSessionScorecard — 세션 범위', () => {
  it('session_id 없이 부르면 던진다 (전 세션을 한 세션인 척 접지 않는다)', () => {
    expect(() => buildSessionScorecard(replay)).toThrow(/session_id/);
    expect(() => buildSessionScorecard(replay, { session_id: '' })).toThrow(/session_id/);
  });

  it('replay 인덱스가 아니면 던진다', () => {
    expect(() => buildSessionScorecard({}, { session_id: SID })).toThrow(/lib\/replay/);
    expect(() => buildSessionScorecard(null, { session_id: SID })).toThrow(/lib\/replay/);
  });

  it('다른 세션 줄은 분모에 들어오지 않는다', () => {
    const events = pick(sessionCard, 'session.events');
    const other = buildSessionScorecard(replay, { session_id: OTHER_SID });
    expect(events.denominator).toBe(11);
    expect(pick(other, 'session.events').denominator).toBe(1);
    expect(events.counts['tool.used']).toBe(1);
  });

  it('Action 귀속 해상도는 action_id 로 묶인 몫이다', () => {
    const m = pick(sessionCard, 'session.actions');
    // act-1..act-3 은 action_id, 나머지(mission.created·checkpointed)는 세션 유도.
    expect(m.counts).toEqual({ action_id: 3, session_id: 1 });
    expect(m.numerator).toBe(3);
    expect(m.denominator).toBe(4);
  });

  it('티어별 Usage Receipt 는 영수증 건수이지 토큰이 아니다', () => {
    const m = pick(sessionCard, 'session.model_tiers');
    expect(m.counts).toEqual({ fable: 1, opus: 1 });
    expect(m.denominator).toBe(2);
    expect(m.absent).toBe(0);
  });

  it('Attempts 와 Retries 가 §34 대로 각각 센다', () => {
    expect(pick(sessionCard, 'session.attempts').numerator).toBe(2);
    expect(pick(sessionCard, 'session.retries').numerator).toBe(1);
  });

  it('Human 도달률은 resolved ÷ asked 다', () => {
    const m = pick(sessionCard, 'session.human_reach');
    expect(m.numerator).toBe(1);
    expect(m.denominator).toBe(1);
    expect(m.ratio).toBe(1);
  });

  it('Checkpoint 분모는 세션의 Mission 수다', () => {
    const m = pick(sessionCard, 'session.checkpoints');
    expect(m.denominator).toBe(1);
    expect(m.numerator).toBe(1);
  });

  it('Observe 기대대로 스위치는 0 이고, 분모가 있으므로 측정된 0 이다', () => {
    const m = pick(sessionCard, 'session.switches');
    expect(m.numerator).toBe(0);
    expect(m.denominator).toBe(3);
    expect(m.measured).toBe(true);
    expect(m.ratio).toBe(0);
  });

  it('빈 원장이면 전 지표가 unmeasured 이고 그것이 정상 출력이다', () => {
    const card = buildSessionScorecard(emptyReplay, { session_id: SID });
    expect(card.unmeasured).toEqual(card.metrics.map((m) => m.key));
    expect(card.totals.measured).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('buildRoutingScorecard — Route Receipt fold', () => {
  it('replay 인덱스가 아니면 던진다', () => {
    expect(() => buildRoutingScorecard({})).toThrow(/lib\/replay/);
  });

  it('Route Decisions 분모는 색인된 줄 전체다', () => {
    const m = pick(routingCard, 'routing.decisions');
    expect(m.numerator).toBe(3);
    expect(m.denominator).toBe(replay.totals.indexed);
  });

  it('decision.type 분포와 pin 비율', () => {
    expect(pick(routingCard, 'routing.decision_types').counts).toEqual({ pin: 2, route: 1 });
    const pinMetric = pick(routingCard, 'routing.pin');
    expect(pinMetric.numerator).toBe(2);
    expect(pinMetric.denominator).toBe(3);
  });

  it('티어별 route 건수 — models 없는 영수증은 absent 로 빠진다', () => {
    const m = pick(routingCard, 'routing.selected_tiers');
    expect(m.counts).toEqual({ opus: 2 });
    expect(m.denominator).toBe(3);
    expect(m.absent).toBe(1);
  });

  it('추천≠선택 분모는 두 티어가 모두 있는 영수증뿐이다', () => {
    const m = pick(routingCard, 'routing.recommendation_divergence');
    expect(m.denominator).toBe(2);
    expect(m.numerator).toBe(1);
    expect(m.absent).toBe(1);
  });

  it('스위치 제안이 0 이면 적용률은 unmeasured 이지 0% 가 아니다', () => {
    const m = pick(routingCard, 'routing.switch_applied');
    expect(m.denominator).toBe(0);
    expect(m.state).toBe(METRIC_STATE.UNMEASURED);
    expect(m.ratio).toBeNull();
  });

  it('measured:false 항 비율은 항 단위로 세고 키가 metric.measured 와 안 겹친다', () => {
    const m = pick(routingCard, 'routing.estimated_terms');
    expect(m.denominator).toBe(4);
    expect(m.numerator).toBe(2);
    expect(m.counts).toEqual({ terms_measured_false: 2, terms_measured_true: 2 });
    expect(Object.keys(m.counts)).not.toContain('measured');
  });

  it('Epoch 수는 route 영수증 기준 distinct 다', () => {
    const m = pick(routingCard, 'routing.epochs');
    expect(m.numerator).toBe(2);
    expect(m.denominator).toBe(3);
  });

  it('terms 의 알려지지 않은 키는 세지 않는다 (스키마가 additionalProperties:false)', () => {
    const rogue = buildReplay([
      line({
        event: 'route.selected',
        source: 'scheduler',
        action_id: 'act-r',
        data: receipt('route', 'opus', 'opus', {
          contextRebuild: { value: 1, measured: true },
          notATerm: { value: 9, measured: false },
        }),
      }, 1),
    ]);
    expect(pick(buildRoutingScorecard(rogue), 'routing.estimated_terms').denominator).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe('foldAvoidedSwitches — 설계 §38 회피된 전환', () => {
  /**
   * One `route.selected` line for the avoided-switch fixture.
   *
   * @param {number} seq - ordering term, also the action suffix.
   * @param {string|undefined} decision - `decision.type`, undefined for a receipt
   *   whose decision never landed.
   * @param {string|undefined} recommended - recommended tier.
   * @param {string|undefined} selected - selected tier.
   * @param {unknown} [reason] - the receipt's `reason[]`.
   * @returns {object} envelope.
   */
  const routeLine = (seq, decision, recommended, selected, reason) => line({
    event: 'route.selected',
    source: 'scheduler',
    action_id: `act-av-${seq}`,
    routing_epoch_id: 'ep-av',
    data: receipt(decision, recommended, selected, undefined, reason),
  }, seq);

  // 한 줄 = 한 케이스. 분류가 바뀌면 어느 줄이 깨졌는지 바로 읽히도록 순서를 고정한다.
  const AVOIDED_LINES = [
    /* a */ routeLine(1, 'route', 'fable', 'opus', ['class:agent', 'divergence', 'hysteresis:minimum-residency']),
    /* b */ routeLine(2, 'route', 'fable', 'opus', ['hysteresis:below-threshold']),
    /* c */ routeLine(3, 'route', 'fable', 'opus', ['hysteresis:hysteresis-band']),
    /* d */ routeLine(4, 'pin', 'fable', 'opus', ['class:agent', 'budget:unavailable']),
    /* e */ routeLine(5, 'route', 'fable', 'opus', ['class:agent', 'hysteresis:above-threshold', 'hysteresis:minimum-residency']),
    /* f */ routeLine(6, 'route', 'fable', 'opus', ['class:agent', 'hysteresis:above-threshold']),
    /* g */ routeLine(7, 'route', 'fable', 'opus'),
    /* h */ routeLine(8, 'route', 'opus', 'opus', ['hysteresis:minimum-residency']),
    /* i */ routeLine(9, 'route', undefined, undefined, ['hysteresis:minimum-residency']),
    /* j */ routeLine(10, undefined, 'fable', 'opus', ['hysteresis:below-threshold']),
  ];

  const avoidedReplay = buildReplay(AVOIDED_LINES);
  const fold = foldAvoidedSwitches(avoidedReplay.routes);
  const avoidedCard = buildRoutingScorecard(avoidedReplay);

  it('분모는 영수증 전체, comparable 은 두 티어가 다 있는 영수증뿐이다', () => {
    // i 는 models 가 없어 comparable 밖이다 — 회피하지 않았다는 증거가 아니라 잴 수 없다는 뜻.
    expect(fold.denominator).toBe(10);
    expect(fold.comparable).toBe(9);
  });

  it('avoided 는 추천≠선택인 영수증이고, 같은 티어(h)는 들어오지 않는다', () => {
    expect(fold.avoided).toBe(8);
  });

  it('pinned 는 avoided 중 decision.type 이 pin 인 몫이다', () => {
    expect(fold.pinned).toBe(1);
  });

  it('사유 히스토그램이 §38 3분류로 사상되고 나머지는 other:<code> 로 보인다', () => {
    expect(fold.byReason).toEqual({
      low_benefit: 3,
      'other:class:agent': 1,
      'other:hysteresis:above-threshold': 1,
      'other:none': 1,
      residency: 2,
    });
    // 히스토그램 합 = avoided. 하나도 조용히 사라지지 않는다.
    expect(Object.values(fold.byReason).reduce((a, b) => a + b, 0)).toBe(fold.avoided);
  });

  it('decision 히스토그램은 avoided 기준이고, 값이 없으면 absent 키다', () => {
    expect(fold.byDecision).toEqual({ absent: 1, pin: 1, route: 6 });
    expect(Object.values(fold.byDecision).reduce((a, b) => a + b, 0)).toBe(fold.avoided);
  });

  it('입력을 변형하지 않는다', () => {
    const before = JSON.stringify(avoidedReplay.routes);
    foldAvoidedSwitches(avoidedReplay.routes);
    expect(JSON.stringify(avoidedReplay.routes)).toBe(before);
  });

  it('카드의 routing.avoided_switch 행이 fold 와 같은 수를 싣는다', () => {
    const m = pick(avoidedCard, 'routing.avoided_switch');
    expect(m.numerator).toBe(8);
    expect(m.denominator).toBe(9);
    expect(m.absent).toBe(1);
    expect(m.counts).toEqual(fold.byReason);
    // 분자는 recommendation_divergence 와 같은 집합이다 — 두 행이 다른 수를 말하면 안 된다.
    expect(m.numerator).toBe(pick(avoidedCard, 'routing.recommendation_divergence').numerator);
  });

  it('카드의 routing.avoided_switch_pinned 분모는 avoided 다', () => {
    const m = pick(avoidedCard, 'routing.avoided_switch_pinned');
    expect(m.numerator).toBe(1);
    expect(m.denominator).toBe(8);
    expect(m.counts).toEqual(fold.byDecision);
  });

  it('순서를 바꿔도, 두 번 불러도 바이트가 같다', () => {
    expect(JSON.stringify(buildRoutingScorecard(avoidedReplay)))
      .toBe(JSON.stringify(avoidedCard));
    expect(JSON.stringify(buildRoutingScorecard(buildReplay(shuffled(AVOIDED_LINES)))))
      .toBe(JSON.stringify(avoidedCard));
  });

  it('seed 카드에서도 두 행이 선다 — 사유가 없는 영수증은 other:none 이다', () => {
    const m = pick(routingCard, 'routing.avoided_switch');
    expect(m.numerator).toBe(1);
    expect(m.denominator).toBe(2);
    expect(m.absent).toBe(1);
    expect(m.counts).toEqual({ 'other:none': 1 });
    const pinned = pick(routingCard, 'routing.avoided_switch_pinned');
    expect(pinned.numerator).toBe(1);
    expect(pinned.denominator).toBe(1);
  });

  it('빈 원장이면 두 행 모두 unmeasured 다 — 0% 가 아니다', () => {
    const card = buildRoutingScorecard(emptyReplay);
    for (const key of ['routing.avoided_switch', 'routing.avoided_switch_pinned']) {
      const m = pick(card, key);
      expect(m.state).toBe(METRIC_STATE.UNMEASURED);
      expect(m.ratio).toBeNull();
      expect(m.counts).toEqual({});
    }
  });

  it('KNOWN DEFECT: comparable 이 비교 불가 영수증보다 적으면 카드가 던진다', () => {
    // 이 행들은 denominator=comparable, absent=routes-comparable 이라 절반 넘게 models 가
    // 없으면 metric() 의 `absent > denominator` 가 걸린다. recommendation_divergence
    // (routing-scorecard.js `key: 'routing.recommendation_divergence'` 행, 2026-09-14 측정)가
    // 먼저 같은 모양으로 던지므로 이 결함은
    // 새로 들어온 것이 아니라 기존 행에서 물려받은 것이다. 여기 적어 두는 이유는, 안 적으면
    // 라이브에서 처음 발견되기 때문이다. 고치는 것은 이 작업의 소유 범위 밖이다.
    const lopsided = buildReplay([
      routeLine(1, 'route', 'fable', 'opus', ['hysteresis:below-threshold']),
      routeLine(2, 'route'),
      routeLine(3, 'route'),
    ]);
    expect(() => buildRoutingScorecard(lopsided)).toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------
describe('classifyAvoidedReason — 사상하지 못한 코드를 숨기지 않는다', () => {
  it.each([
    ['allowlist 의 첫 코드가 이긴다', ['class:agent', 'hysteresis:minimum-residency'], 'residency'],
    ['below-threshold 는 low_benefit', ['hysteresis:below-threshold'], 'low_benefit'],
    ['hysteresis-band 도 low_benefit', ['hysteresis:hysteresis-band'], 'low_benefit'],
    ['미사상 코드는 건너뛰고 뒤의 allowlist 코드를 쓴다',
      ['hysteresis:above-threshold', 'hysteresis:minimum-residency'], 'residency'],
    ['사상 불가면 첫 hysteresis 코드로 other 를 만든다',
      ['class:agent', 'hysteresis:above-threshold'], 'other:hysteresis:above-threshold'],
    ['hysteresis 코드가 없으면 배열 첫 코드로 other 를 만든다',
      ['class:agent', 'budget:unavailable'], 'other:class:agent'],
    ['비문자열 항목은 건너뛴다', [null, 7, 'class:agent'], 'other:class:agent'],
    ['전부 비문자열이면 other:none', [null, 7, {}], 'other:none'],
    ['빈 배열은 other:none', [], 'other:none'],
  ])('%s', (_name, reason, expected) => {
    expect(classifyAvoidedReason(reason)).toBe(expected);
  });

  it.each([['undefined', undefined], ['null', null], ['문자열', 'hysteresis:minimum-residency'], ['객체', {}]])(
    '배열이 아니면(%s) other:none 이다',
    (_name, value) => {
      expect(classifyAvoidedReason(value)).toBe('other:none');
    },
  );
});

// ---------------------------------------------------------------------------
describe('AVOIDED_SWITCH_REASONS 가 라이브 어휘와 드리프트하지 않는다', () => {
  const HYSTERESIS = read(path.join(PLUGIN_ROOT, 'lib', 'routing', 'route-hysteresis.js'));
  const codes = Object.values(AVOIDED_SWITCH_REASONS).flat();

  it('설계 §38 의 3분류가 그대로 키다 (cache_affinity 를 지우지 않는다)', () => {
    expect(Object.keys(AVOIDED_SWITCH_REASONS).sort())
      .toEqual(['cache_affinity', 'low_benefit', 'residency']);
    // 빈 목록은 실수가 아니라 사실이다: 오늘 이 코드를 쓰는 생산자가 없다.
    expect(AVOIDED_SWITCH_REASONS.cache_affinity).toEqual([]);
  });

  it('스캐너 자기검증 — 대조할 코드가 실제로 있다', () => {
    expect(codes.length).toBeGreaterThanOrEqual(3);
    expect(HYSTERESIS.length).toBeGreaterThan(1000);
  });

  it.each(codes)('%s 가 route-hysteresis.js 에 리터럴로 존재한다', (code) => {
    expect(code.startsWith('hysteresis:')).toBe(true);
    expect(HYSTERESIS).toContain(`'${code.slice('hysteresis:'.length)}'`);
  });

  it('스캐너 자기검증 — 없는 코드는 없다고 나온다', () => {
    expect(HYSTERESIS).not.toContain("'cache-affinity'");
    expect(HYSTERESIS).not.toContain("'not-a-hysteresis-code'");
  });

  it('어휘는 얼어 있다 — 소비자가 분류를 넓힐 수 없다', () => {
    expect(Object.isFrozen(AVOIDED_SWITCH_REASONS)).toBe(true);
    expect(Object.isFrozen(AVOIDED_SWITCH_REASONS.residency)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('스키마 사본이 드리프트하지 않는다', () => {
  const schema = JSON.parse(read(path.join(PLUGIN_ROOT, 'schemas', 'route-receipt.schema.json')));

  it('DECISION_TYPES 가 route-receipt 의 decision.type enum 과 같다', () => {
    expect([...DECISION_TYPES]).toEqual(schema.properties.decision.properties.type.enum);
  });

  it('COST_TERMS 가 route-receipt 의 terms.required 와 같다', () => {
    expect([...COST_TERMS]).toEqual(schema.properties.terms.required);
  });
});

// ---------------------------------------------------------------------------
describe('결정성', () => {
  it('입력 순서를 바꿔도 같은 카드가 나온다', () => {
    const other = buildReplay(shuffled(seed()));
    expect(JSON.stringify(buildRoutingScorecard(other)))
      .toBe(JSON.stringify(routingCard));
    expect(JSON.stringify(buildSessionScorecard(other, { session_id: SID })))
      .toBe(JSON.stringify(sessionCard));
  });

  it('같은 카드를 두 번 렌더하면 바이트가 같다', () => {
    expect(renderScorecardMarkdown(sessionCard)).toBe(renderScorecardMarkdown(sessionCard));
    expect(renderScorecardMarkdown(routingCard)).toBe(renderScorecardMarkdown(routingCard));
  });

  it('카드는 얼어 있다 — 소비자가 지표를 덧칠할 수 없다', () => {
    expect(Object.isFrozen(sessionCard)).toBe(true);
    expect(Object.isFrozen(sessionCard.metrics)).toBe(true);
    expect(Object.isFrozen(sessionCard.metrics[0])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('renderScorecardMarkdown', () => {
  it('분모 0 인 행은 unmeasured 로 쓰고 퍼센트 수치를 찍지 않는다', () => {
    const out = renderScorecardMarkdown(buildRoutingScorecard(emptyReplay));
    // 수치 퍼센트만 본다. 산문 안의 "0% 가 아니다" 는 경고 문구이지 렌더된 값이 아니다.
    expect(out).not.toMatch(/\d+\.\d+%/);
    expect(out).toContain(UNMEASURED_TEXT);
  });

  it('측정된 0 은 0.0% 로 찍힌다 — 미측정과 같은 글자가 아니다', () => {
    const out = renderScorecardMarkdown(sessionCard);
    expect(out).toContain('0.0%');
  });

  it('미측정 절이 분모와 함께 개수를 밝힌다', () => {
    const out = renderScorecardMarkdown(buildRoutingScorecard(emptyReplay));
    expect(out).toContain('10 / 10 지표가 분모 0 이다');
  });

  it('알 수 없는 kind 는 렌더하지 않고 던진다', () => {
    expect(() => renderScorecardMarkdown({ kind: 'nope', metrics: [], unmeasured: [] }))
      .toThrow(/unknown card kind/);
    expect(() => renderScorecardMarkdown(null)).toThrow(TypeError);
  });

  it('원장 값의 파이프가 표를 조작하지 못한다', () => {
    // mission_id 는 session.missions 히스토그램의 항목명으로 그대로 렌더된다 —
    // 즉 원장에 쓰인 값이 표의 셀이 된다. 값은 데이터이지 마크업이 아니다.
    const evil = buildReplay([
      line({
        event: 'tool.used',
        mission_id: 'M|INJECTED',
        action_id: 'a-1',
        data: { tool: 'x', ok: true, duration_ms: 1 },
      }, 1),
    ]);
    const out = renderScorecardMarkdown(buildSessionScorecard(evil, { session_id: SID }));
    expect(out).toContain('M\\|INJECTED');
    expect(out).not.toContain('| M|INJECTED |');
  });
});

// ---------------------------------------------------------------------------
describe('순수성 — 소스에 효과가 없다', () => {
  /**
   * Strip comments so a token discussed in prose is not read as a call.
   *
   * LIMITATION, stated where the gate is: this is a regex, not a parser. A `//`
   * inside a string literal would truncate that line. No file in this directory
   * contains one today; if one appears, this stripper is what to fix.
   *
   * @param {string} src - source text.
   * @returns {string} source with comments blanked.
   */
  const stripComments = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

  const files = readdirSync(SCORECARD_DIR).filter((f) => f.endsWith('.js')).sort();

  it('디렉터리에 파일이 실재한다 (스캐너 자기검증 — 0건이면 이 절은 아무것도 증명하지 않는다)', () => {
    expect(files.length).toBeGreaterThanOrEqual(4);
    expect(files).toContain('index.js');
  });

  it.each([
    ['파일시스템', /\bnode:fs\b|\brequire\(['"]fs['"]\)|readFileSync|writeFileSync/],
    ['시계', /\bDate\.now\b|\bnew Date\b|\bhrtime\b/],
    ['난수', /\bMath\.random\b/],
    ['프로세스', /\bprocess\./],
  ])('%s 참조가 0건이다', (_kind, pattern) => {
    for (const file of files) {
      const src = stripComments(read(path.join(SCORECARD_DIR, file)));
      expect(pattern.test(src), `${file} 에 ${_kind} 참조가 있다`).toBe(false);
    }
  });

  it('스캐너 자기검증 — 같은 패턴이 실제 효과 코드에는 걸린다', () => {
    // 이 어서션이 없으면 위 4건은 "패턴이 아무것도 못 잡는다" 로도 그린이 된다.
    expect(/\bprocess\./.test(stripComments('const x = process.cwd();'))).toBe(true);
    expect(/\bnew Date\b/.test(stripComments('const t = new Date();'))).toBe(true);
    expect(/\bprocess\./.test(stripComments('/* process.stdout.isTTY */'))).toBe(false);
  });
});
