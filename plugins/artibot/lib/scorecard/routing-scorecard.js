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
 *  1. THIN LIVE SAMPLE, NOT ZERO (corrected 2026-09-15). The `route.selected` writer IS wired
 *     (`scripts/hooks/subagent-handler.js#observeRoute`), but every metric here has been
 *     and live lines now exist (first fold 2026-09-14: 102 `route.selected` rows on
 *     one machine, one repo). That is a SAMPLE, not a baseline — a single-machine
 *     single-run distribution cannot carry a threshold. See session-scorecard.js #1
 *     for why a wired writer and a populated ledger are still two different
 *     statements; the gap is now "populated but unrepresentative", not "empty".
 *  2. USEFUL vs WASTEFUL SWITCHES (§34, §37). §37 defines "useful" as a switch
 *     after which success rises, retries fall, latency falls, effective cost
 *     falls, or review quality rises — every one of those is an AFTER-THE-FACT
 *     comparison needing outcome data that does not exist yet. Switch
 *     Efficiency is their ratio, so it is absent for the same reason. A card
 *     that guessed them would score the router on invented evidence.
 *     Updated 2026-09-21 (backlog CA-18). The canonical definition is §37's
 *     closing line, "Switch Efficiency = Useful Switches / Total Switches", and
 *     `ARTIBOT-5.0-DESIGN.md:505` puts it on the Canary row beside the Switch
 *     Controller's real application (CA-16, todo) — so it is not an Observe row
 *     at all. TWO INDEPENDENT REASONS IT STAYS ABSENT, and either alone suffices:
 *     (a) THE DENOMINATOR IS ZERO. A one-shot live ledger read on 2026-09-21
 *     (18:39 KST, raw lines, not deduped by receipt id) found 402 `route.selected`
 *     rows, `model.switched` 0, and `decision.type` route 321 / pin 81 / switch 0.
 *     Total Switches is 0, so the ratio is unmeasured, not 0%.
 *     (b) THERE IS NO FIELD TO PUT "USEFUL" IN. `route-receipt.schema.json` sets
 *     `additionalProperties: false` at every level and defines no outcome field,
 *     so "useful" cannot be written down even once switches exist.
 *     CA-18 ITSELF STAYS OPEN. What was built in its place is `routing.hold_reasons`
 *     and the residency rows described in #5: the router's recorded HOLD reasons,
 *     which are measurable today, under names that do not contain the word
 *     "efficiency" — they are not a proxy for it and carry no "useful" verdict.
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
 *  5. RESIDENCY AND COOLDOWN (§30). Updated 2026-09-21 (backlog CA-18). WHAT IS
 *     NOW FOLDED: `routing.residency_counter` reports how often
 *     `data.actionsSinceSwitch` is PRESENT AS AN INTEGER and, of those, how often
 *     it is greater than zero — presence and sign only. WHAT IS STILL NOT FOLDED,
 *     and the reason is unchanged: the counter is never compared against the
 *     barrier, and no distribution over its VALUES is emitted, because design
 *     §8.5 G5 records the initial 3 and 2 as "미보정" — a histogram of those values
 *     would describe an uncalibrated constant rather than a behaviour. The
 *     W11-Q2 instruction is honoured in `HOLD_REASON_CODES`: `residency-unknown`
 *     and `minimum-residency` are SEPARATE BUCKETS, so "the counter was missing"
 *     is never read as "measured and short of the barrier".
 *     `routing.residency_counter_coverage` carries the receipts with no usable
 *     counter, following the `routing.tier_comparability` precedent — they are
 *     outside the first row's denominator, so they cannot be its `absent`
 *     (metric.js rejects `absent > denominator`) and would otherwise vanish.
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
 *     from `currentTier`. Updated 2026-09-15 (Wave 11, owner W11-Q1): the hook
 *     `scripts/hooks/route-observe-pre.js` now DOES supply `currentTier` — the
 *     incumbent is read from the transcript tail (last assistant `message.model`
 *     mapped onto a catalog tier), and `currentTier` and `actionsSinceSwitch` go
 *     in together or not at all. So this row can move now, but a model the catalog
 *     does not list still yields no incumbent, which reads as absent rather than
 *     as an error. Until the catalog drift is closed, a zero here is still partly
 *     the WRITER's state rather than the router's restraint.
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
 * agreement, so it is excluded from the denominator — and counted by
 * `routing.tier_comparability` — instead of being scored as a match.
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
 *
 * `hysteresis-band` sits under `low_benefit` by interpretation, not by a
 * sentence in §38: a utility inside the ±band means the gain did not clear the
 * switch cost by the margin the policy demands (`route-hysteresis.js`
 * decision order, step 5), which is "low expected benefit" in §38's words.
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

/** The prefix `adaptive-model-router.js#routeModel` puts on every hysteresis code. */
const HYSTERESIS_PREFIX = 'hysteresis:';

/**
 * The hysteresis vocabulary, grouped by what each code says about the decision.
 *
 * An ALLOWLIST, like `DECISION_TYPES` and `AVOIDED_SWITCH_REASONS`, and for the
 * same reason: a negative list ("anything that is not X is a hold") FAILS OPEN —
 * a code added to `route-hysteresis.js` tomorrow would silently join the
 * numerator and inflate the hold rate. Here it lands in `other:<code>` instead,
 * outside the numerator and plainly visible in the histogram.
 *
 * `hold` is the numerator of `routing.hold_reasons`: the router evaluated a
 * transition and kept the incumbent. `allow` (`above-threshold`) is a decision
 * to switch and `no_transition` (`same-tier`) means there was no transition on
 * the table at all — both are counted in the histogram and neither is a hold.
 *
 * `residency-unknown` AND `minimum-residency` ARE SEPARATE ENTRIES, not one
 * "residency" bucket (header #5, owner W11-Q2): the first means the counter was
 * missing and the second means it was measured and short of the barrier. Folding
 * them together would re-create exactly the confusion that code was added to end.
 *
 * NOT LISTED, ON PURPOSE. `evaluateSwitch` also emits `no-candidate`,
 * `catalog-miss` and `override:<name>`. The first two are holds in the module's
 * own terms, but they report that the evaluation could not run — not a policy
 * restraint — and `override:*` is an unbounded family. All three surface as
 * `other:hysteresis:<code>` so they are counted and visible without being
 * claimed as evidence of the router holding back.
 */
export const HOLD_REASON_CODES = Object.freeze({
  hold: Object.freeze([
    'hysteresis:minimum-residency',
    'hysteresis:residency-unknown',
    'hysteresis:below-threshold',
    'hysteresis:hysteresis-band',
  ]),
  allow: Object.freeze(['hysteresis:above-threshold']),
  no_transition: Object.freeze(['hysteresis:same-tier']),
});

const HOLD_CODE_SET = new Set(HOLD_REASON_CODES.hold);
const KNOWN_CODE_SET = new Set([
  ...HOLD_REASON_CODES.hold, ...HOLD_REASON_CODES.allow, ...HOLD_REASON_CODES.no_transition,
]);

/**
 * The distinct `hysteresis:*` codes a receipt carries, in receipt order.
 *
 * DE-DUPLICATED WITHIN THE RECEIPT so a code repeated on one `reason[]` counts
 * once: the histogram's unit is "receipts carrying this code", which is the only
 * reading under which a bucket can be compared with the row's denominator.
 *
 * A `data.reason` that is absent or not an array yields `[]` with no exception —
 * the receipt then falls out of `routing.hold_reasons` entirely and is counted by
 * `routing.hold_reason_coverage`, never scored as "did not hold".
 *
 * @param {object} receipt - a `route.selected` line.
 * @returns {string[]} distinct hysteresis codes, possibly empty.
 */
export function hysteresisCodes(receipt) {
  const reason = readPath(receipt, ['data', 'reason']);
  if (!Array.isArray(reason)) return [];
  const out = [];
  for (const code of reason) {
    if (typeof code !== 'string' || !code.startsWith(HYSTERESIS_PREFIX)) continue;
    if (!out.includes(code)) out.push(code);
  }
  return out;
}

/**
 * Fold the router's recorded hold reasons over ALL route receipts.
 *
 * KPI, stated as numerator over denominator so it cannot be misread:
 *   `routing.hold_reasons` = receipts carrying at least one `HOLD_REASON_CODES.hold`
 *   code ÷ receipts carrying at least one `hysteresis:*` code.
 *
 * NOT A SUBSET OF `foldAvoidedSwitches`. That fold runs over the diverged
 * receipts only; this one runs over every receipt, because a hold is recorded
 * whether or not the recommendation and the selection ended up differing.
 *
 * THE NUMERATOR IS PER RECEIPT, NOT PER CODE: a receipt with two hold codes adds
 * one. `counts` is per code, so SUM(counts) CAN EXCEED `withCodes` — the live
 * writer emits at most one hysteresis code per line (`evaluateSwitch` pushes
 * exactly one), but a caller that supplies its own `src.hysteresis` can carry
 * more, and the pinned test fixes that overflow rather than assuming it away.
 *
 * DEDUPE: this fold does NOT deduplicate receipts. `replay.routes` arrives
 * already deduplicated by `lib/replay/replay.js#orderEvents`, on the envelope key
 * `(session_id, source, pid, seq, ts)` — NOT on `route_receipt_id`, which nothing
 * in `lib/replay` reads. Two receipts sharing a receipt id under different
 * envelope keys would therefore both be counted here.
 *
 * @param {object[]} receipts - `route.selected` lines. Not mutated.
 * @returns {{withCodes: number, held: number, counts: Record<string, number>,
 *   denominator: number}}
 */
export function foldHoldReasons(receipts) {
  const lines = Array.isArray(receipts) ? receipts : [];
  const counts = {};
  let withCodes = 0;
  let held = 0;
  for (const receipt of lines) {
    const codes = hysteresisCodes(receipt);
    if (codes.length === 0) continue;
    withCodes += 1;
    let isHold = false;
    for (const code of codes) {
      const key = KNOWN_CODE_SET.has(code) ? code : `other:${code}`;
      counts[key] = (counts[key] ?? 0) + 1;
      if (HOLD_CODE_SET.has(code)) isHold = true;
    }
    if (isHold) held += 1;
  }
  return { withCodes, held, counts: sortedCounts(counts), denominator: lines.length };
}

/**
 * Fold the §30 residency counter's PRESENCE and SIGN — never its value.
 *
 * KPI: `routing.residency_counter` = receipts whose `data.actionsSinceSwitch` is
 * greater than zero ÷ receipts whose `data.actionsSinceSwitch` IS AN INTEGER.
 *
 * The path is `data.actionsSinceSwitch`, a top-level required property of
 * `route-receipt.schema.json` (`type: integer`, `minimum: 0`) — the module rule
 * at the top of this file holds: nothing is read that the schema does not define.
 *
 * NO COMPARISON WITH THE BARRIER AND NO VALUE HISTOGRAM. The barrier is built
 * from `minimum_residency` 3 and `cooldown` 2, which design §8.5 G5 records as
 * uncalibrated; a row that compared against them, or that binned the values,
 * would report the constant rather than the router (header #5).
 *
 * `null`, absent and non-integer all fall OUT OF THE DENOMINATOR rather than
 * counting as 0 — `0` is a real measurement and the others are the absence of
 * one. `routing.residency_counter_coverage` is where they become visible.
 *
 * @param {object[]} receipts - `route.selected` lines. Not mutated.
 * @returns {{present: number, positive: number, denominator: number}}
 */
export function foldResidencyCounter(receipts) {
  const lines = Array.isArray(receipts) ? receipts : [];
  let present = 0;
  let positive = 0;
  for (const receipt of lines) {
    const value = readPath(receipt, ['data', 'actionsSinceSwitch']);
    if (!Number.isInteger(value)) continue;
    present += 1;
    if (value > 0) positive += 1;
  }
  return { present, positive, denominator: lines.length };
}

/**
 * The two hold-reason rows, built together because they share one fold.
 *
 * Read as a unit: the second row's numerator IS the first row's denominator.
 *
 * @param {object[]} routes - `route.selected` lines.
 * @returns {Readonly<object>[]} the two metrics, in render order.
 */
function holdReasonMetrics(routes) {
  const fold = foldHoldReasons(routes);
  return [
    metric({
      key: 'routing.hold_reasons',
      label: '보류 사유 (hysteresis 코드 보유 영수증 중 보류)',
      source: 'route.selected · data.reason[] hysteresis:* 중 보류 코드 보유 영수증 '
        + '÷ hysteresis:* 코드를 가진 영수증',
      denominator: fold.withCodes,
      numerator: fold.held,
      counts: fold.counts,
      note: '보류 코드 allowlist 4종(minimum-residency · residency-unknown · below-threshold '
        + '· hysteresis-band). same-tier(전환이 테이블에 없었음)와 above-threshold(전환 허용)는 '
        + 'counts 에 보이되 분자 밖이다. allowlist 밖 코드는 other:<code> — 분자에 넣지 않는다. '
        + '분자는 영수증 단위(보류 코드가 하나라도 있으면 1)라 counts 합은 분모를 넘을 수 있다. '
        + '이 행은 Switch Efficiency 가 아니다(헤더 #2) — useful 판정을 담지 않는다.',
    }),
    metric({
      key: 'routing.hold_reason_coverage',
      label: 'hysteresis 코드가 실린 영수증',
      source: 'route.selected · data.reason[] 에 hysteresis:* 가 있는 영수증 ÷ route.selected',
      denominator: routes.length,
      numerator: fold.withCodes,
      note: 'routing.tier_comparability 와 같은 역할이다 — 코드가 없는 영수증(옛 writer·reason 이 '
        + '배열이 아닌 줄)은 위 행의 분모에서 빠지고 여기서 보인다. 100% 가 아니면 위 행의 '
        + '분모가 전체보다 작다는 뜻이다.',
    }),
  ];
}

/**
 * The two §30 residency rows, built together because they share one fold.
 *
 * @param {object[]} routes - `route.selected` lines.
 * @returns {Readonly<object>[]} the two metrics, in render order.
 */
function residencyMetrics(routes) {
  const fold = foldResidencyCounter(routes);
  return [
    metric({
      key: 'routing.residency_counter',
      label: '잔류 카운터 > 0 (값 분포 아님)',
      source: 'route.selected · data.actionsSinceSwitch > 0 ÷ 정수인 영수증',
      denominator: fold.present,
      numerator: fold.positive,
      note: '임계(§8.5 G5 의 3·2)와 비교하지 않고 값 분포도 싣지 않는다 — 그 상수가 "미보정"이라 '
        + '분포가 라우터가 아니라 상수를 보고하게 된다(헤더 #5). null·부재·비정수는 분모에서 '
        + '빠진다 — 0 은 실측이고 나머지는 결측이라 다른 진술이다.',
    }),
    metric({
      key: 'routing.residency_counter_coverage',
      label: '잔류 카운터가 정수로 실린 영수증',
      source: 'route.selected · data.actionsSinceSwitch 가 정수인 영수증 ÷ route.selected',
      denominator: routes.length,
      numerator: fold.present,
      note: '카운터가 없는 영수증은 위 행의 분모 밖이라 absent 로 실을 수 없고(metric.js 는 '
        + 'absent > denominator 를 던진다) 여기서 보인다. routing.tier_comparability 선례.',
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
        + '라우터 추천이 아니다(route-receipt 스키마 models 절).'
        + ' GA-02 canary 게이트는 reason 만 싣고 이 값을 바꾸지 않는다(작동기 CA-02 미착수).',
    }),
    metric({
      key: 'routing.tier_comparability',
      label: '추천·선택 티어 비교 가능 영수증',
      source: 'route.selected · data.models.recommended.tier ∧ .selected.tier 둘 다 있는 영수증 '
        + '÷ route.selected',
      denominator: routes.length,
      numerator: comparable,
      note: 'recommended·selected 티어가 둘 다 있는 영수증의 몫. 이 행이 100% 가 아니면 아래 두 '
        + '비율(routing.recommendation_divergence · routing.avoided_switch)의 분모가 전체보다 '
        + '작다 — 비교 불가 영수증은 그 두 행의 absent 가 아니라 여기서 보인다(absent 는 분모 '
        + '안의 결측만 센다, metric.js).',
    }),
    metric({
      key: 'routing.recommendation_divergence',
      label: '추천 ≠ 선택 (Observe 지표)',
      source: 'route.selected · data.models.recommended.tier vs .selected.tier',
      denominator: comparable,
      numerator: countWhere(routes, divergedTier),
      note: '분모는 두 티어가 모두 있는 영수증만이다 — 한쪽이 없으면 일치로 세지 않고 분모에서 '
        + '뺀다. 빠진 영수증 수는 routing.tier_comparability 행이 센다. 어느 쪽이 옳았는지는 '
        + '판정하지 않는다(헤더 #4).',
    }),
    ...avoidedSwitchMetrics(routes),
    ...holdReasonMetrics(routes),
    ...residencyMetrics(routes),
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
