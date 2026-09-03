/**
 * Routing Scorecard — the ROUTING block of MODEL-SWITCHING-SCORECARD.md §34,
 * folded from Route Receipts.
 *
 * WHERE THE NUMBERS COME FROM
 * ---------------------------------------------------------------------------
 * One place: the ledger's `route.selected` lines. Design §8.2 §3·§40 settles
 * that "Route Receipt = 원장 route.selected 이벤트의 data. 별도 파일 아님", and
 * `schemas/ledger-events.allowlist.json` names `route-receipt.schema.json` as
 * that event's canonical `data` contract. So every field this module reads is a
 * field that schema defines, and a field the schema does not define is not read.
 *
 * §34 lists nine ROUTING rows. Five of them (Useful Switches, Wasteful
 * Switches, Switch Efficiency, Transition Cost, Transition Time) are NOT built
 * here — see "WHAT THIS CARD CANNOT SEE" below. Emitting them from Phase 0 data
 * would mean presenting estimates as measurements, which is the one thing
 * `cost_term.measured` exists to prevent.
 *
 * SCOPE IS THE WHOLE INDEX, ON PURPOSE
 * ---------------------------------------------------------------------------
 * `buildRoutingScorecard(replay)` takes no session filter, unlike the session
 * card. Routing behaviour is a property of the router across the ledger it was
 * given; the caller narrows by passing a narrower `filter` to `loadReplay`,
 * which forwards it verbatim to `readAllEvents`. Adding a second filtering
 * vocabulary here would let the same question be asked two ways and answered
 * differently.
 *
 * ── WHAT THIS CARD CANNOT SEE (repo rule §9: write it next to the gate) ──────
 *  1. ZERO LIVE ROUTE RECEIPTS. The `route.selected` writer IS wired
 *     (`scripts/hooks/subagent-handler.js#observeRoute`), but every metric here has been
 *     exercised against fixtures only — see session-scorecard.js #1 for why a
 *     wired writer and a populated ledger are still two different statements.
 *  2. USEFUL vs WASTEFUL SWITCHES (§34, §37). §37 defines "useful" as a switch
 *     after which success rises, retries fall, latency falls, effective cost
 *     falls, or review quality rises — every one of those is an AFTER-THE-FACT
 *     comparison needing outcome data that does not exist yet. Switch
 *     Efficiency is their ratio, so it is absent for the same reason. A card
 *     that guessed them would score the router on invented evidence.
 *  3. TRANSITION COST AND TIME (§34). The receipt carries them, but as
 *     `terms{}` entries each flagged `measured`, and the schema is explicit
 *     that "before the usage receipt lands, handoffLatency, reorientationRisk
 *     and expectedRetry are measured:false (§8.2 R2)". Summing estimates into
 *     one currency figure erases those flags. `routing.estimated_terms` reports
 *     the flag mix instead, which is the honest form of the same information.
 *  4. WHETHER A DECISION WAS RIGHT. Nothing here scores the router. It counts
 *     what the router recorded. `routing.recommendation_divergence` says how
 *     often the recommendation and the selection differed, not which was better
 *     — that judgment is RouteBench's, and §8.4 puts RouteBench in Shadow.
 *  5. RESIDENCY AND COOLDOWN (§30). `actionsSinceSwitch` is on the receipt and
 *     is not folded: design §8.5 G5 records the initial values 3 and 2 as
 *     "미보정", so a distribution over them would describe an uncalibrated
 *     constant rather than a behaviour.
 *  6. SHADOW LINES ARE NOT SEPARATED. The receipt allows `source: 'shadow'`
 *     beside production lines. Nothing here splits them, because §8.4 puts the
 *     shadow learner past Observe and no shadow line can exist yet. When one
 *     can, this card will silently mix the two — that is a known future defect,
 *     recorded here rather than discovered later.
 *
 * @module lib/scorecard/routing-scorecard
 */

import { countWhere, freezeCard, histogramMetric, metric, readPath, tallyBy } from './metric.js';

/** Card kind, matching `SESSION_KIND`'s role in the renderer. */
export const ROUTING_KIND = 'routing';

/**
 * The decision vocabulary, restated from `route-receipt.schema.json#/properties/
 * decision/properties/type/enum`.
 *
 * A COPY, and it is a copy for the same reason `lib/replay` copies the envelope
 * key list: reading the schema file would mean filesystem access in a pure
 * module. The test suite reads the schema and compares, so the copy cannot
 * drift unnoticed. It is an ALLOWLIST — a sixth value appearing in a receipt
 * shows up in the histogram AND fails that comparison, rather than being
 * silently counted as if it had always been legal.
 */
export const DECISION_TYPES = Object.freeze([
  'route', 'pin', 'switch', 'escalate', 'downgrade',
]);

/**
 * The seven §28 SwitchCost term names, restated from
 * `route-receipt.schema.json#/properties/terms/required`. Same copy rule as
 * `DECISION_TYPES`, pinned by the same test.
 */
export const COST_TERMS = Object.freeze([
  'contextSerialization', 'contextRebuild', 'cacheLoss', 'handoffTokens',
  'handoffLatency', 'reorientationRisk', 'expectedRetry',
]);

/**
 * Fold the `measured` flag across every cost term of every receipt.
 *
 * Reads only the seven names in `COST_TERMS`. A key outside that list is
 * ignored rather than counted: the schema sets `additionalProperties: false` on
 * `terms`, so an eighth key is a line that should never have been written, and
 * quietly folding it in would make this card the place where an invalid receipt
 * first looks valid.
 *
 * @param {object[]} receipts - `route.selected` lines.
 * @returns {{counts: Record<string, number>, total: number, estimated: number}}
 *   flag histogram (`terms_measured_true` / `terms_measured_false`), the number
 *   of terms actually seen, and the estimated subset.
 */
export function foldCostTerms(receipts) {
  let measuredTrue = 0;
  let measuredFalse = 0;
  for (const receipt of receipts) {
    const terms = readPath(receipt, ['data', 'terms']);
    if (!terms || typeof terms !== 'object') continue;
    for (const name of COST_TERMS) {
      const flag = readPath(terms, [name, 'measured']);
      if (flag === true) measuredTrue += 1;
      else if (flag === false) measuredFalse += 1;
    }
  }
  const counts = {};
  if (measuredFalse > 0 || measuredTrue > 0) {
    counts.terms_measured_false = measuredFalse;
    counts.terms_measured_true = measuredTrue;
  }
  return { counts, total: measuredTrue + measuredFalse, estimated: measuredFalse };
}

/**
 * True when a receipt's recommended tier and selected tier both exist and differ.
 *
 * Both halves must be present: a receipt missing either one is not evidence of
 * agreement, so it lands in `absent` instead of being scored as a match.
 *
 * @param {object} receipt - a `route.selected` line.
 * @returns {boolean} whether the two tiers are present and unequal.
 */
export function divergedTier(receipt) {
  const recommended = readPath(receipt, ['data', 'models', 'recommended', 'tier']);
  const selected = readPath(receipt, ['data', 'models', 'selected', 'tier']);
  if (typeof recommended !== 'string' || typeof selected !== 'string') return false;
  return recommended !== selected;
}

/**
 * True when both tiers needed by `divergedTier` are present.
 *
 * @param {object} receipt - a `route.selected` line.
 * @returns {boolean} whether the comparison was possible at all.
 */
export function comparableTiers(receipt) {
  return typeof readPath(receipt, ['data', 'models', 'recommended', 'tier']) === 'string'
    && typeof readPath(receipt, ['data', 'models', 'selected', 'tier']) === 'string';
}

/**
 * Build the routing card.
 *
 * @param {object} replay - a `buildReplay` index (T-41). Read only.
 * @returns {object} `{kind, scope, metrics, unmeasured, totals}`.
 * @throws {TypeError} when `replay` is not an index.
 */
export function buildRoutingScorecard(replay) {
  if (!replay || typeof replay !== 'object' || !Array.isArray(replay.routes)) {
    throw new TypeError(
      'buildRoutingScorecard requires a lib/replay index — pass the result of '
      + 'buildReplay(events) or loadReplay(root, {readEvents}).',
    );
  }
  const routes = replay.routes;
  const switches = replay.switches ?? [];
  const indexed = readPath(replay, ['totals', 'indexed']);
  const lines = Number.isInteger(indexed) ? indexed : 0;
  const decisionOf = (e) => readPath(e, ['data', 'decision', 'type']);
  const pins = countWhere(routes, (e) => decisionOf(e) === 'pin');
  const proposedSwitches = countWhere(routes, (e) => decisionOf(e) === 'switch');
  const terms = foldCostTerms(routes);
  const comparable = countWhere(routes, comparableTiers);

  const metrics = [
    metric({
      key: 'routing.decisions',
      label: 'Route Decisions',
      source: 'route.selected ÷ 색인된 원장 줄',
      denominator: lines,
      numerator: routes.length,
      note: '§34 ROUTING "Route Decisions". 분모는 색인에 들어온 줄 전체다.',
    }),
    histogramMetric(routes, decisionOf, {
      key: 'routing.decision_types',
      label: 'decision.type 분포',
      source: 'route.selected · data.decision.type',
      note: '허용 5종은 route-receipt 스키마 소유. 여섯 번째 값이 나오면 여기 histogram 에 '
        + '보이면서 스키마 대조 테스트가 레드가 된다 — 조용히 통과하지 않는다.',
    }),
    metric({
      key: 'routing.pin',
      label: 'Avoided Switch (pin 비율)',
      source: "route.selected{decision.type='pin'} ÷ route.selected",
      denominator: routes.length,
      numerator: pins,
      note: '§34 "Avoided Switches". 전환을 제안하지 않고 현행 모델을 유지한 결정의 몫.',
    }),
    histogramMetric(routes, (e) => readPath(e, ['data', 'models', 'selected', 'tier']), {
      key: 'routing.selected_tiers',
      label: '티어별 Route 건수',
      source: 'route.selected · data.models.selected.tier',
      note: 'selected 는 실제로 실행된 모델이다. Observe 에서는 항상 resolveModel 정책 결과이지 '
        + '라우터 추천이 아니다(route-receipt 스키마 models 절).',
    }),
    metric({
      key: 'routing.recommendation_divergence',
      label: '추천 ≠ 선택 (Observe 지표)',
      source: 'route.selected · data.models.recommended.tier vs .selected.tier',
      denominator: comparable,
      numerator: countWhere(routes, divergedTier),
      absent: routes.length - comparable,
      note: '분모는 두 티어가 모두 있는 영수증만이다 — 한쪽이 없으면 일치로 세지 않고 미분류로 '
        + '뺀다. 어느 쪽이 옳았는지는 판정하지 않는다(헤더 #4).',
    }),
    metric({
      key: 'routing.switch_applied',
      label: '스위치 제안 대비 적용',
      source: "model.switched ÷ route.selected{decision.type='switch'}",
      denominator: proposedSwitches,
      numerator: switches.length,
      note: 'Observe 기대값은 분자·분모 모두 0 이며 그때 이 행은 unmeasured 다 — 0% 가 아니다. '
        + '설계 §8.4 는 Switch Controller 실적용을 Canary 에 둔다.',
    }),
    metric({
      key: 'routing.estimated_terms',
      label: 'measured:false 항 비율',
      source: 'route.selected · data.terms[*].measured (§28 7항)',
      denominator: terms.total,
      numerator: terms.estimated,
      counts: terms.counts,
      note: '여기서의 measured 는 항 값이 실측인지이고, 이 행 자체의 measured 는 분모가 있었는지다 '
        + '— 다른 뜻이다(metric.js 헤더). 비율이 높다 = 카드가 추정 위에 서 있다.',
    }),
    metric({
      key: 'routing.epochs',
      label: 'Routing Epoch 수',
      source: 'route.selected · routing_epoch_id',
      denominator: routes.length,
      numerator: Object.keys(tallyBy(routes, (e) => e.routing_epoch_id)).length,
      note: 'G1 로 epoch 의 실효 단위는 스폰이다. 비율 1 에 가까울수록 영수증 하나에 epoch 하나 '
        + '— 스폰마다 한 번만 라우팅했다는 뜻이다.',
    }),
  ];

  return freezeCard({
    kind: ROUTING_KIND,
    scope: { scope: 'index' },
    metrics,
  });
}
