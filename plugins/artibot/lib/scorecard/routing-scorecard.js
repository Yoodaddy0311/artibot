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
 *  7. CACHE AFFINITY AS AN AVOIDED-SWITCH REASON. §38 names three reasons a
 *     switch is worth avoiding, and `lib/routing/route-hysteresis.js` emits a
 *     code for only two of them. `AVOIDED_SWITCH_REASONS.cache_affinity` is
 *     therefore an empty allowlist and its bucket is always 0. THAT ZERO MEANS
 *     "NOT RECORDED", NOT "NEVER HAPPENED" — reading it the second way would
 *     credit the router with a reason it has no way to write down.
 *  8. PINS, IN PHASE 0. `routing.avoided_switch_pinned` has a real denominator
 *     and an expected numerator of zero, because the only receipt writer
 *     (`lib/routing/adaptive-model-router.js#routeModel`) derives `decision.type`
 *     from `currentTier`, and nothing supplies `currentTier` before Shadow. So
 *     the row measures the WRITER's state, not the router's restraint, until
 *     that field is populated. It is emitted anyway so the day it moves is
 *     visible; a row added later would have no baseline to move from.
 *
 * @module lib/scorecard/routing-scorecard
 */

import {
  countWhere, freezeCard, histogramMetric, metric, readPath, sortedCounts, tallyBy,
} from './metric.js';

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
 * The §38 reasons a switch can be avoided, each mapped to the receipt `reason[]`
 * codes that evidence it.
 *
 * Design §38 ("Avoided Switches도 성능이다",
 * `.artibot/guides/v5-design/MODEL-SWITCHING-SCORECARD.md`) names three: cache
 * affinity, low expected benefit, and minimum residency. The codes come from
 * `lib/routing/route-hysteresis.js`, which the router prefixes with
 * `hysteresis:` before writing them onto the receipt
 * (`adaptive-model-router.js#routeModel`).
 *
 * `cache_affinity` IS EMPTY, AND STAYS VISIBLE. No code in the hysteresis
 * vocabulary means "held for cache affinity" today, so there is nothing to list.
 * Dropping the key would make the card claim §38 has two reasons; keeping it
 * empty makes the gap countable — the row will read 0 for it, and "WHAT THIS
 * CARD CANNOT SEE" #7 says that 0 means unrecorded, not absent.
 *
 * An ALLOWLIST, like `DECISION_TYPES`: a hysteresis code outside these lists is
 * reported as `other:<code>` rather than folded into a neighbouring reason.
 */
export const AVOIDED_SWITCH_REASONS = Object.freeze({
  cache_affinity: Object.freeze([]),
  low_benefit: Object.freeze(['hysteresis:below-threshold', 'hysteresis:hysteresis-band']),
  residency: Object.freeze(['hysteresis:minimum-residency']),
});

/** Returned when a receipt carries no usable reason code at all. */
const REASON_NONE = 'other:none';

/**
 * Name the §38 reason a receipt evidences, or report that it evidences none.
 *
 * Scanning is IN RECEIPT ORDER but allowlist membership wins over position: the
 * live `reason[]` always opens with `class:*` and `effort:*` (router lines 480-486
 * as of 2026-09-14), so "first code" would classify every receipt identically
 * and mean nothing. The first code that IS in an allowlist decides.
 *
 * Nothing is ever hidden. An unmapped receipt returns `other:<code>` naming the
 * code that was actually there — preferring the first `hysteresis:` code, since
 * that is the field that would have carried the answer — so a new hysteresis
 * code shows up as its own histogram bucket instead of vanishing into a reason
 * it was never evidence for.
 *
 * @param {unknown} reason - a receipt's `data.reason`, trusted to be nothing.
 * @returns {string} a key of `AVOIDED_SWITCH_REASONS`, or `other:<code>`.
 */
export function classifyAvoidedReason(reason) {
  if (!Array.isArray(reason)) return REASON_NONE;
  let firstCode = null;
  let firstHysteresis = null;
  for (const code of reason) {
    if (typeof code !== 'string' || code.length === 0) continue;
    for (const [name, codes] of Object.entries(AVOIDED_SWITCH_REASONS)) {
      if (codes.includes(code)) return name;
    }
    if (firstCode === null) firstCode = code;
    if (firstHysteresis === null && code.startsWith('hysteresis:')) firstHysteresis = code;
  }
  const unmapped = firstHysteresis ?? firstCode;
  return unmapped === null ? REASON_NONE : `other:${unmapped}`;
}

/**
 * Fold the avoided switches out of a set of route receipts.
 *
 * "Avoided" is `divergedTier` — the router recommended one tier and another was
 * selected — which is the Observe-era proxy design §5 settles on
 * (`ARTIBOT-5.0-DESIGN.md:479`: "추천≠정책 스폰 = pin 사유 있는 회피"). It is
 * deliberately the SAME SET that `routing.recommendation_divergence` counts;
 * this fold adds the reason distribution over that set rather than a second,
 * differently-drawn population that could disagree with it.
 *
 * `byDecision` buckets a missing `decision.type` as `absent` instead of skipping
 * it, so its counts always sum to `avoided` and a receipt cannot fall out of the
 * histogram unnoticed.
 *
 * @param {object[]} receipts - `route.selected` lines. Not mutated.
 * @returns {{avoided: number, pinned: number, byReason: Record<string, number>,
 *   byDecision: Record<string, number>, comparable: number, denominator: number}}
 */
export function foldAvoidedSwitches(receipts) {
  const lines = Array.isArray(receipts) ? receipts : [];
  const byReason = {};
  const byDecision = {};
  let avoided = 0;
  let pinned = 0;
  for (const receipt of lines) {
    if (!divergedTier(receipt)) continue;
    avoided += 1;
    const reason = classifyAvoidedReason(readPath(receipt, ['data', 'reason']));
    byReason[reason] = (byReason[reason] ?? 0) + 1;
    const type = readPath(receipt, ['data', 'decision', 'type']);
    const bucket = typeof type === 'string' && type.length > 0 ? type : 'absent';
    byDecision[bucket] = (byDecision[bucket] ?? 0) + 1;
    if (bucket === 'pin') pinned += 1;
  }
  return {
    avoided,
    pinned,
    byReason: sortedCounts(byReason),
    byDecision: sortedCounts(byDecision),
    comparable: countWhere(lines, comparableTiers),
    denominator: lines.length,
  };
}

/**
 * The two §38 avoided-switch rows, built together because they share one fold.
 *
 * Split out of `buildRoutingScorecard` so the pair is read as one unit: the
 * second row's denominator IS the first row's numerator, and a reader who
 * changes one without the other silently changes what the ratio means.
 *
 * @param {object[]} routes - `route.selected` lines.
 * @returns {Readonly<object>[]} the two metrics, in render order.
 */
function avoidedSwitchMetrics(routes) {
  const fold = foldAvoidedSwitches(routes);
  return [
    metric({
      key: 'routing.avoided_switch',
      label: 'Avoided Switch (추천≠선택 · 사유 분류)',
      source: 'route.selected · models.recommended.tier ≠ models.selected.tier · '
        + 'data.reason[] hysteresis:* → §38 3분류',
      denominator: fold.comparable,
      numerator: fold.avoided,
      absent: fold.denominator - fold.comparable,
      counts: fold.byReason,
      note: '설계 §38(MODEL-SWITCHING-SCORECARD.md) 사유 3분류 cache_affinity/low_benefit/'
        + "residency. Observe 대리 정의는 ARTIBOT-5.0-DESIGN.md:479 '추천≠정책 스폰'. 사상 "
        + '불가 코드는 other:<code> 로 보인다. 분자는 routing.recommendation_divergence 와 '
        + '같은 집합이고 이 행은 그 집합의 사유 분포를 더한다.',
    }),
    metric({
      key: 'routing.avoided_switch_pinned',
      label: 'Avoided Switch 중 decision=pin',
      source: "route.selected{decision.type='pin'} ∩ 추천≠선택 ÷ 추천≠선택",
      denominator: fold.avoided,
      numerator: fold.pinned,
      counts: fold.byDecision,
      note: 'Phase 0 writer(adaptive-model-router.js#routeModel)는 currentTier 가 null 이라 '
        + 'pin 을 내지 않는다 — 분모가 있어도 분자 0 이 기대값이며 Shadow 에서 currentTier 가 '
        + '실리면 오른다. 분모 0 이면 unmeasured.',
    }),
  ];
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
    ...avoidedSwitchMetrics(routes),
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
