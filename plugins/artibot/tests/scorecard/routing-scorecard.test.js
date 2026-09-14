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
} from '../../lib/scorecard/index.js';

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
