/**
 * Compare Scorecard — what the router RECOMMENDED against what actually SERVED,
 * folded into §34/§35 card rows.
 *
 * WHERE THE NUMBERS COME FROM
 * ---------------------------------------------------------------------------
 * TWO folds, both computed by the CALLER: the OUTPUT of
 * `lib/replay/spawn-outcome.js#joinSpawnOutcomes` (every row but one), and the
 * OUTPUT of `lib/replay/replay-label.js#labelReplay` (the `compare.replay_label`
 * row, and nothing else). This card does no joining, no filtering and no
 * counting of ledger lines — it picks denominators for figures those folds
 * already computed, and that is all it does. Neither fold is called here: the
 * caller runs `readAllEvents → joinSpawnOutcomes → buildCompareScorecard` and
 * hands `labelReplay(events)` in as `replay`, so each fold has exactly one call
 * site per render and the card cannot disagree with the folds it is printing.
 * `replay` is REQUIRED and validated by the same rule as the fold: an omitted
 * or mis-shaped `replay` THROWS. Rendering it `unmeasured` instead would make a
 * caller that forgot the port print the same row as a ledger with no routed
 * Actions — the fail-open shape the next section describes.
 *
 * WHY THE FOLD AND NOT A REPLAY INDEX
 * ---------------------------------------------------------------------------
 * The sibling cards take a `lib/replay` index; this one cannot. The index does
 * not carry the raw `route.bound` rows, and `route-bind.js#bindOf`'s projection
 * drops `recommended_model` — the very column this comparison is about
 * (`spawn-outcome.js`, "WHY THE RAW BIND LINE"). Worse, a flattened path would
 * be FAIL-OPEN: under `includeEvents: false` it would produce the same card as
 * an empty ledger, and "the wiring is wrong" would render identically to "there
 * were no spawns". So the fold is the port, and a fold-shaped object missing a
 * required field THROWS rather than defaulting to zero.
 *
 * SCOPE IS THE WHOLE FOLD, AND `since` IS A LABEL
 * ---------------------------------------------------------------------------
 * `since` is not a filter. Narrowing is the CALLER's, through the `filter` it
 * hands `readAllEvents`; this card records the label so a reader knows which
 * window produced the figures. A second filtering vocabulary here would let the
 * same question be asked two ways and answered differently — the reason
 * `buildRoutingScorecard` takes no session filter either.
 *
 * ── WHAT THIS CARD CANNOT SEE (repo rule §9: write it next to the gate) ──────
 *  1. EVERYTHING `lib/replay/spawn-outcome.js`'s OWN "WHAT THIS MODULE CANNOT
 *     SEE" list names, unchanged and deliberately NOT restated here. Seven
 *     items: whether a divergence is a fault, whether a fifo pair is the right
 *     pair, a multi-model run's intent and a double-written receipt, the outcome
 *     of the spawn, an unpriced pair's cost, retention and windowing, and why a
 *     usage field is absent. A copy of that list would be a second copy that
 *     drifts; read it there. Every limit on the fold is a limit on this card,
 *     because this card is arithmetic over that fold and adds no evidence.
 *  2. WHICH FIGURES OF THE FOLD ARE NOT ROWS. `receipts`,
 *     `main_thread_receipts`, `subagent_receipts`, `duplicate_binds`,
 *     `malformed_binds`, `malformed_receipts`, `model_mismatch`,
 *     `duplicate_receipts`, `multi_model_runs`, `excluded_no_recommendation`,
 *     `agreement_rate`, `agreed_by_model`, `divergence`, `usage_totals` and
 *     `latency` are in the fold and NOT on this card — raw row counts,
 *     row-level integrity counters and detail histograms, where the card is
 *     nine rows. A reader who needs them must read the fold, and their absence
 *     here is not evidence they are zero. The same holds for the label fold:
 *     `by_reason`, `rows`, `multi_model_runs`, `conflicts` and `unlabeled` are in
 *     `labelReplay`'s output and NOT on this card. `agreement_rate` is the one omission
 *     that is not a gap: `compare.agreement` carries the same quotient WITH its
 *     denominator attached, and a bare rate beside it would be the second answer
 *     to one question that `metric()` exists to prevent.
 *  3. A BUCKET'S COST AGAINST THE OTHER BUCKET'S. `cost.same.total` and
 *     `cost.diverged.total` are each comparable only to their OWN `priced`
 *     population (fold CANNOT SEE #5), so they are reported in the note beside
 *     that population and are never divided by anything. A null total prints
 *     `unmeasured`, never 0 — a 0 would read as "the divergences were free",
 *     the exact misreading measured on the live run at 2026-09-21T01:31:59Z.
 *  4. QUALITY. `compare.score` has a denominator fixed at 0 and is therefore
 *     permanently `unmeasured`, because no spawn-keyed score writer exists
 *     (fold CANNOT SEE #4). AGREEMENT IS NOT QUALITY: a card where every spawn
 *     got the model it was routed to says nothing about whether the routing was
 *     right. The row stays on the card as an explicit hole rather than being
 *     omitted, so its absence cannot be mistaken for "not applicable".
 *  5. WHETHER THE TWO FOLDS SAW THE SAME LINES, AND WHAT A LABEL MEANS.
 *     `compare.replay_label` comes from a SECOND fold (`labelReplay`, which
 *     runs its own `joinSpawnOutcomes` inside) and neither result carries a
 *     figure the other can be checked against — its `actions` counts
 *     `route.selected` receipts, a population no other row of this card has. A
 *     caller that folds two different slices gets a card whose rows disagree
 *     with nothing visible. Everything `replay-label.js`'s own "WHAT THIS
 *     MODULE CANNOT SEE" list names is a limit on that row, unchanged and not
 *     restated here; the one a reader of THIS card meets first is its #3
 *     WINDOWING: `--since` does not just narrow the row, it CHANGES labels — a
 *     bind or receipt outside the slice is absent, not late, so its Action
 *     reads SIMULATED. And EXACT is 0 by construction, not by measurement
 *     (`exact_reachable: false`, reason `one-action-one-run`); the row's note
 *     prints that reason from the fold rather than letting an empty bucket
 *     read as "none seen yet".
 *
 * PURITY (design §1-8, L2). No clock, no filesystem, no randomness, no
 * `process`. The only import is `./metric.js`; both folds arrive as arguments
 * and are READ ONLY. `lib/replay` is not imported even though L2 → L2 would
 * allow it: calling `labelReplay` here would give the label fold a second call
 * site per render. Every histogram is key-sorted by `metric()`, so a shuffled
 * ledger serializes to the same bytes.
 *
 * @module lib/scorecard/compare-scorecard
 */

import { freezeCard, metric } from './metric.js';

/** Card kind, matching `ROUTING_KIND`'s role in the renderer. */
export const COMPARE_KIND = 'compare';

/** Decimal places a bucket total is printed with. See `money`. */
const MONEY_DIGITS = 6;

/**
 * The confidence buckets `joinSpawnOutcomes` emits, required BY NAME.
 *
 * A copy of the fold's `byConfidence` initialiser, and the fixtures compare the
 * two so the copy cannot drift unnoticed — the same rule `routing-scorecard.js`
 * applies to `DECISION_TYPES`.
 */
const CONFIDENCE_BUCKETS = Object.freeze(['exact', 'name', 'fifo', 'other']);

/**
 * The label vocabulary `labelReplay` emits in `by_label`, required BY NAME.
 *
 * A copy of `replay-label.js#REPLAY_LABELS`, for the reason `CONFIDENCE_BUCKETS`
 * is a copy (this module imports only `./metric.js`), and the fixtures compare
 * the row's keys to the producer's constant so the copy cannot drift unnoticed.
 */
const REPLAY_LABEL_KEYS = Object.freeze(['EXACT', 'PARTIAL', 'SIMULATED']);

/**
 * A histogram ONLY when the row has a denominator.
 *
 * A zeroed histogram on a row whose denominator is 0 renders as a `## 분포`
 * table of `0` counts, and `0` reads as "measured, and the answer is none" —
 * the misreading `metric.js`'s header exists to prevent. Measured on the empty
 * ledger at 2026-09-21T04:21:54Z: this card printed 9 zero rows where the
 * routing card printed no distribution section at all. `render.js` decides what
 * to draw from `m.counts` being non-empty, and that file is not this batch's to
 * change, so the card withholds the histogram instead.
 *
 * @param {number} denominator - the row's denominator.
 * @param {Record<string, number>} counts - the histogram.
 * @returns {Record<string, number>|null} the histogram, or null when unmeasured.
 */
function countsIfMeasured(denominator, counts) {
  return denominator > 0 ? counts : null;
}

/** Non-negative integer? @param {unknown} v @returns {boolean} */
function isCount(v) {
  return Number.isInteger(v) && v >= 0;
}

/** A plain non-array object? @param {unknown} v @returns {boolean} */
function isRecord(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Reject, naming the field that was wrong and the port that was expected.
 *
 * @param {string} why - what was expected, in the caller's vocabulary.
 * @returns {never}
 * @throws {TypeError} always.
 */
function reject(why) {
  throw new TypeError(
    'buildCompareScorecard requires a lib/replay/spawn-outcome.js#joinSpawnOutcomes '
    + `fold — ${why}. Pass joinSpawnOutcomes(readAllEvents(...)), not a replay index: `
    + 'filling a missing field with 0 would make a wiring bug render as an empty ledger.',
  );
}

/**
 * Validate one cost bucket: a population, and a sum that is null when empty.
 *
 * @param {unknown} bucket - `cost.same` or `cost.diverged`.
 * @param {string} name - field name for the failure.
 * @returns {void}
 */
function requireCostBucket(bucket, name) {
  if (!isRecord(bucket)) reject(`\`${name}\` must be an object`);
  if (!isCount(bucket.priced)) reject(`\`${name}.priced\` must be a non-negative integer`);
  if (bucket.total !== null && typeof bucket.total !== 'number') {
    reject(`\`${name}.total\` must be a number or null (never a string, never 0 when empty)`);
  }
}

/**
 * Validate the explicit null score block, AND refuse a populated one.
 *
 * WHY A REAL SCORE IS REJECTED RATHER THAN RENDERED. `scoreMetric`'s denominator
 * is hard-wired to 0 and its note writes `source: null · value: null` as TEXT,
 * because no spawn-keyed score writer exists (fold CANNOT SEE #4). The day one
 * lands, a permissive check here would let the card render a MEASURED score as
 * `unmeasured` with a note asserting it was null — a false statement produced by
 * a card that passed validation. The row cannot be fixed by interpolating the
 * value either: a real score needs a real DENOMINATOR (how many pairs carry
 * one), and `fold.score` is a single block with no population in it, so the fix
 * belongs in the fold and then in this row's design. Failing loudly names that
 * work; rendering quietly hides it. This is the same fail-closed choice
 * `metric.js` makes for a malformed denominator.
 *
 * @param {unknown} score - `fold.score`.
 * @returns {void}
 */
function requireScore(score) {
  if (!isRecord(score)) reject('`score` must be an explicit block, not absent and not null');
  if (score.source !== null && typeof score.source !== 'string') {
    reject('`score.source` must be a string or null');
  }
  if (score.value !== null && typeof score.value !== 'number') {
    reject('`score.value` must be a number or null');
  }
  if (score.source !== null || score.value !== null) {
    reject(
      '`score` carries a real measurement, so a spawn-keyed score writer now exists — '
      + "but `compare.score`'s denominator is hard-wired to 0 and its note states "
      + '`source: null · value: null` as text, so this card would render a measured '
      + 'score as `unmeasured`. Redesign that row with a real denominator (and update '
      + 'its note) rather than relaxing this check',
    );
  }
  if (typeof score.reason !== 'string' || score.reason.length === 0) {
    reject('`score.reason` must be a non-empty string saying why the score is null');
  }
}

/**
 * ALLOWLIST validation of the fold (repo rule §8: state what is permitted).
 *
 * A deny-list of known-bad shapes would be fail-OPEN — a field dropped from the
 * fold tomorrow would pass and this card would print a denominator of
 * `undefined`. So every field a row reads is required here, by name.
 *
 * @param {unknown} fold - candidate fold.
 * @returns {void}
 * @throws {TypeError} naming the first field that is wrong.
 */
function requireFold(fold) {
  if (!isRecord(fold)) reject(`got ${JSON.stringify(fold) ?? typeof fold}`);
  if (!Array.isArray(fold.pairs)) reject('`pairs` must be an array');
  for (const f of ['binds', 'compared', 'excluded_fifo', 'unjoined_binds', 'unjoined_receipts']) {
    if (!isCount(fold[f])) reject(`\`${f}\` must be a non-negative integer`);
  }
  if (!isRecord(fold.by_agreement)) reject('`by_agreement` must be an object');
  for (const f of ['same', 'diverged']) {
    if (!isCount(fold.by_agreement[f])) {
      reject(`\`by_agreement.${f}\` must be a non-negative integer`);
    }
  }
  if (!isRecord(fold.by_confidence)) reject('`by_confidence` must be an object');
  // BY NAME, not just "every value present is a count": a partial
  // `by_confidence` would let this card print an exact-only distribution and
  // call it the distribution over all pairs. The fold emits these four always.
  for (const f of CONFIDENCE_BUCKETS) {
    if (!isCount(fold.by_confidence[f])) {
      reject(`\`by_confidence.${f}\` must be a non-negative integer`);
    }
  }
  if (!isRecord(fold.cost)) reject('`cost` must be an object');
  for (const f of ['compared', 'unpriced']) {
    if (!isCount(fold.cost[f])) reject(`\`cost.${f}\` must be a non-negative integer`);
  }
  requireCostBucket(fold.cost.same, 'cost.same');
  requireCostBucket(fold.cost.diverged, 'cost.diverged');
  requireScore(fold.score);
}

/**
 * Reject a `replay` that is not a label fold, naming the port that was expected.
 *
 * @param {string} why - what was expected.
 * @returns {never}
 * @throws {TypeError} always.
 */
function rejectReplay(why) {
  throw new TypeError(
    'buildCompareScorecard requires `replay`: the output of '
    + `lib/replay/replay-label.js#labelReplay — ${why}. Pass { replay: labelReplay(events) } `
    + 'over the SAME events the fold was built from: rendering a missing label fold as '
    + '`unmeasured` would make a wiring bug look like a ledger with no routed Actions.',
  );
}

/**
 * `by_label`, validated against `actions` and the producer's stated contract.
 *
 * Three contradictions are refused rather than rendered, because each would put
 * a false sentence on the card: zeros on an empty denominator (the producer
 * writes three NULLS there — "0 PARTIAL" is a finding), a histogram that does
 * not sum to its own denominator, and a non-zero EXACT beside a fold that says
 * EXACT cannot occur.
 *
 * @param {object} replay - candidate with `actions` already validated.
 * @returns {void}
 */
function requireByLabel(replay) {
  const { actions, by_label: byLabel } = replay;
  if (!isRecord(byLabel)) rejectReplay('`by_label` must be an object');
  if (actions === 0) {
    for (const k of REPLAY_LABEL_KEYS) {
      if (byLabel[k] !== null) {
        rejectReplay(
          `\`by_label.${k}\` must be null when \`actions\` is 0 `
          + '(an empty denominator is unmeasured, not 0)',
        );
      }
    }
    if (typeof replay.by_label_reason !== 'string' || replay.by_label_reason.length === 0) {
      rejectReplay('`by_label_reason` must name why `by_label` is null when `actions` is 0');
    }
    return;
  }
  let sum = 0;
  for (const k of REPLAY_LABEL_KEYS) {
    if (!isCount(byLabel[k])) rejectReplay(`\`by_label.${k}\` must be a non-negative integer`);
    sum += byLabel[k];
  }
  if (sum !== actions) rejectReplay(`\`by_label\` sums to ${sum}, not to \`actions\` ${actions}`);
  if (replay.by_label_reason !== null) {
    rejectReplay('`by_label_reason` must be null when `actions` is non-zero');
  }
  if (byLabel.EXACT !== 0) {
    rejectReplay('`by_label.EXACT` is non-zero while `exact_reachable` is false');
  }
}

/**
 * ALLOWLIST validation of the label fold — every field the row reads, by name.
 *
 * `exact_reachable: true` is REFUSED, not rendered, for `requireScore`'s
 * reason: this row's note states EXACT is a structural 0 and prints the
 * unreachability reason as text. The day a writer contract lets one Action
 * carry two independent results (replay-label.js "EXACT OPENS"), a permissive
 * check here would print a measured EXACT under a note calling it impossible.
 *
 * @param {unknown} replay - candidate label fold.
 * @returns {void}
 * @throws {TypeError} naming the first field that is wrong.
 */
function requireReplay(replay) {
  if (!isRecord(replay)) rejectReplay(`got ${JSON.stringify(replay) ?? typeof replay}`);
  if (!isCount(replay.actions)) rejectReplay('`actions` must be a non-negative integer');
  if (replay.exact_reachable === true) {
    rejectReplay(
      '`exact_reachable` is true, so EXACT can now occur — but `compare.replay_label`\'s note '
      + 'states EXACT is a structural 0. Redesign that row (and its note) rather than '
      + 'relaxing this check',
    );
  }
  if (replay.exact_reachable !== false) rejectReplay('`exact_reachable` must be the literal false');
  if (typeof replay.exact_unreachable_reason !== 'string'
    || replay.exact_unreachable_reason.length === 0) {
    rejectReplay('`exact_unreachable_reason` must be a non-empty string');
  }
  requireByLabel(replay);
}

/**
 * The `since` LABEL, validated. A filter is the caller's; this is prose.
 *
 * @param {unknown} since - ISO string, null, or absent.
 * @returns {string|null} the label.
 * @throws {TypeError} on anything else.
 */
function requireSinceLabel(since) {
  if (since === undefined || since === null) return null;
  if (typeof since !== 'string') {
    throw new TypeError(
      'buildCompareScorecard: `since` is the LABEL of the filter the caller already '
      + `applied (an ISO string or null), not a filter — got ${typeof since}. This card `
      + 'does not narrow the fold; pass a narrower filter to readAllEvents instead.',
    );
  }
  return since;
}

/**
 * A bucket total as fixed-width text, or the word when the population is empty.
 *
 * FIXED DIGITS ON PURPOSE. The note is compared byte-for-byte across shuffled
 * inputs, and a fixed-precision rendering survives a future change to the order
 * the fold accumulates in — float addition is not associative, so `String(sum)`
 * would tie these bytes to that order. `toFixed` is locale-independent, unlike
 * `toLocaleString`.
 *
 * @param {number|null} total - bucket sum.
 * @returns {string} the figure, or `unmeasured`.
 */
function money(total) {
  return total === null ? 'unmeasured' : total.toFixed(MONEY_DIGITS);
}

/**
 * Join coverage: how much of the bind population has a receipt at all.
 *
 * @param {object} fold - validated fold.
 * @param {number} joined - `fold.pairs.length`.
 * @returns {Readonly<object>} metric.
 */
function pairsMetric(fold, joined) {
  return metric({
    key: 'compare.pairs',
    label: '바인드 대비 영수증 짝지음',
    source: 'route.bound{data.agent_id} ⋈ usage.receipt{run_id − "agent-"} ÷ route.bound',
    denominator: fold.binds,
    numerator: joined,
    note: '분모는 바인드된 스폰(distinct agent_id)이고 분자는 영수증과 짝지어진 스폰이다. '
      + '메인스레드 영수증은 스폰이 아니라 어느 분모에도 없다. 창 밖으로 잘린 줄과 아예 '
      + '쓰이지 않은 줄은 여기서 구분되지 않는다(spawn-outcome.js CANNOT SEE #6).',
  });
}

/**
 * The agreement rate over the COMPARED population.
 *
 * @param {object} fold - validated fold.
 * @returns {Readonly<object>} metric.
 */
function agreementMetric(fold) {
  const { same, diverged } = fold.by_agreement;
  return metric({
    key: 'compare.agreement',
    label: '추천 = 실제 서빙 (모델 ID 일치)',
    source: 'spawn-outcome by_agreement.same ÷ compared',
    denominator: fold.compared,
    numerator: same,
    counts: countsIfMeasured(fold.compared, { same, diverged }),
    note: '분모는 allowlist(exact,name) 확인이고 recommended_model 이 있는 쌍만이다 — 빠진 '
      + '쌍은 일치로 세지 않고 분모에서 뺀다. 빠진 사유는 두 종류이고 이 카드는 한쪽만 '
      + '행으로 싣는다: confidence 로 빠진 쌍은 compare.excluded_fifo 행이 세고, '
      + 'recommended_model 이 없어 빠진 쌍은 이 카드의 행이 아니다 — pairs − compared − '
      + 'excluded_fifo 로만 보인다(fold 의 excluded_no_recommendation). 분모 0 이면 '
      + 'unmeasured 이지 "아무 스폰도 추천 모델을 못 받았다"가 아니다. 일치는 품질이 아니고 '
      + '어느 쪽이 옳았는지는 판정하지 않는다(spawn-outcome.js CANNOT SEE #1).',
  });
}

/**
 * The confidence histogram over ALL pairs, excluded ones included.
 *
 * @param {object} fold - validated fold.
 * @param {number} joined - `fold.pairs.length`.
 * @returns {Readonly<object>} metric.
 */
function confidenceMetric(fold, joined) {
  return metric({
    key: 'compare.confidence',
    label: '바인드 confidence 분포',
    // No `|` in this string on purpose: `render.js#escapeCell` would escape it
    // to `\|`, which is correct but reads as noise in the rendered cell.
    source: 'spawn-outcome by_confidence (exact · name · fifo · other)',
    denominator: joined,
    counts: countsIfMeasured(joined, fold.by_confidence),
    note: '분모는 짝지어진 전 쌍이다 — 비교에서 제외된 쌍도 이 분포에 들어 있다. 즉 '
      + 'compare.agreement 의 분모와 다른 모집단이며, 두 행의 비율을 같은 분모로 읽으면 '
      + '안 된다. 각 쌍은 자기 리터럴 값으로 버킷되므로 allowlist 밖 값은 fifo 나 other 로 '
      + '자기 이름을 갖고 보인다.',
  });
}

/**
 * Priced coverage of the compared population, with each bucket's own sum.
 *
 * @param {object} fold - validated fold.
 * @returns {Readonly<object>} metric.
 */
function costMetric(fold) {
  const cost = fold.cost;
  return metric({
    key: 'compare.cost',
    label: '비교된 쌍 중 가격이 매겨진 쌍',
    source: 'spawn-outcome cost.compared ÷ compared · cost.same.priced · cost.diverged.priced',
    denominator: fold.compared,
    numerator: cost.compared,
    counts: countsIfMeasured(fold.compared, {
      agreed_priced: cost.same.priced,
      diverged_priced: cost.diverged.priced,
      unpriced: cost.unpriced,
    }),
    note: `버킷 합계는 자기 priced 모집단과만 비교할 수 있다 — same=${money(cost.same.total)} `
      + `(priced ${cost.same.priced}), diverged=${money(cost.diverged.total)} `
      + `(priced ${cost.diverged.priced}). 모집단이 비면 합계는 null 이고 여기에 unmeasured `
      + '로 적는다 — 0 으로 쓰면 "그 갈림은 무료였다"로 읽힌다(spawn-outcome.js CANNOT SEE '
      + '#5). 한 쌍은 모든 영수증에 숫자 cost.total 이 있을 때만 priced 다 — 부분 가격은 '
      + '부분 합계가 아니라 미지다.',
  });
}

/**
 * The three residue rows: what the comparison excluded and what never joined.
 *
 * Built together because they are read together, and each has a DIFFERENT
 * denominator on purpose. THEY DO NOT ACCOUNT FOR THE WHOLE RESIDUE: a pair
 * excluded for carrying no `recommended_model` is in NONE of them, and in no row
 * of this card. It is visible only as `pairs − compared − excluded_fifo`, which
 * is `fold.excluded_no_recommendation`. Saying otherwise would make this JSDoc
 * disagree with `compare.excluded_fifo`'s own note, which states the same limit.
 *
 * @param {object} fold - validated fold.
 * @param {number} joined - `fold.pairs.length`.
 * @returns {Readonly<object>[]} three metrics, in render order.
 */
function residueMetrics(fold, joined) {
  return [
    metric({
      key: 'compare.excluded_fifo',
      label: '비교에서 제외된 쌍 (allowlist 밖 confidence)',
      source: 'spawn-outcome excluded_fifo ÷ pairs',
      denominator: joined,
      numerator: fold.excluded_fifo,
      note: '이름은 fifo 지만 allowlist(exact,name) 밖 confidence 전부를 센다 — 내일 '
        + 'bindRoute 에 tier 가 추가되면 조용히 compare.agreement 로 들어가지 않고 여기 '
        + '쌓인다(spawn-outcome.js @returns, excluded_fifo 절). recommended_model 이 없어 '
        + '제외된 쌍은 이 숫자에 없다 — 그쪽은 fold 의 excluded_no_recommendation 이다.',
    }),
    metric({
      key: 'compare.unjoined_binds',
      label: '영수증이 없는 바인드',
      source: 'spawn-outcome unjoined_binds ÷ binds',
      denominator: fold.binds,
      numerator: fold.unjoined_binds,
      note: '바인드는 SubagentStart 에, 영수증은 SessionEnd 에 쓰인다 — 아직 끝나지 않은 '
        + '스폰, 영수증을 못 쓴 스폰, 창 밖으로 잘린 영수증이 여기서 전부 같아 보인다. 이 '
        + '행이 0 이 아닌 것은 그 자체로 결함의 증거가 아니다.',
    }),
    metric({
      key: 'compare.unjoined_receipts',
      label: '바인드가 없는 영수증 에이전트',
      source: 'spawn-outcome unjoined_receipts ÷ (pairs + unjoined_receipts)',
      denominator: joined + fold.unjoined_receipts,
      numerator: fold.unjoined_receipts,
      note: '분모·분자 모두 영수증 ROW 가 아니라 영수증을 낸 distinct 서브에이전트 ID 다 — '
        + '영수증 3장을 쓰고 바인드가 없는 런은 3 이 아니라 1 이다. 분모는 영수증을 낸 '
        + 'distinct 서브에이전트 전체이고(짝지은 쪽 + 못 짝지은 쪽), 메인스레드 영수증은 '
        + '여기 없다. duplicate_binds 는 이 등식을 깨지 않는다 — 중복 바인드 행은 새 '
        + 'agent_id 를 만들지 않는다(spawn-outcome.js#collect). `--since` 로 창을 좁히면 이 '
        + '행은 위로 편향된다 — 바인드는 SubagentStart 에, 영수증은 SessionEnd 에 쓰여 창 '
        + '시작 경계를 걸친 스폰은 바인드만 창 밖에 남아 여기로 떨어진다. 창 밖으로 잘린 '
        + '줄과 아예 쓰이지 않은 줄은 구분되지 않는다(spawn-outcome.js CANNOT SEE #6 '
        + 'RETENTION AND WINDOWING).',
    }),
  ];
}

/**
 * The §46 fidelity label distribution over routed Actions.
 *
 * A pure histogram (no numerator): the three labels are the row, and no one of
 * them is "the" rate. EXACT stays in the histogram as a `0` because the note
 * beside it says why — dropping the key would let a reader assume the fold
 * never considered it.
 *
 * @param {object} replay - validated `labelReplay` output.
 * @returns {Readonly<object>} metric.
 */
function replayLabelMetric(replay) {
  const { actions, by_label: byLabel } = replay;
  const counts = {};
  for (const k of REPLAY_LABEL_KEYS) counts[k] = byLabel[k];
  const empty = actions === 0
    ? ` 이 입력은 actions 0 이라 by_label 이 세 null 이다(by_label_reason: ${replay.by_label_reason}).`
    : '';
  return metric({
    key: 'compare.replay_label',
    label: 'Replay 충실도 라벨 (EXACT · PARTIAL · SIMULATED)',
    source: 'labelReplay by_label ÷ actions (distinct route.selected tool_use_id)',
    denominator: actions,
    counts: countsIfMeasured(actions, counts),
    note: '분모는 labelReplay 의 actions — PreToolUse route.selected 영수증의 distinct '
      + 'tool_use_id 수다(Action 하나 = tool_use_id 하나). compare.pairs 의 바인드·짝 '
      + '모집단과 다르므로 두 행을 같은 분모로 읽으면 안 된다. EXACT 는 측정값이 아니라 '
      + `구조적 0 이다: exact_reachable:false · 사유 ${replay.exact_unreachable_reason} — `
      + 'Action 하나는 런 하나에만 묶여 §46 Exact 가 생길 경로가 없다(replay-label.js 헤더). '
      + 'PARTIAL 은 그 Action 의 스폰에 측정된(transcript·otlp) 영수증과 비교 가능한 바인드 '
      + '(충돌 없는 자기 짝·confidence allowlist 안·추천 모델과 서빙 모델 존재)가 있다는 '
      + '뜻이지 대조군이 있다는 뜻이 아니다(조건 사다리는 replay-label.js#gradeBound). 라벨은 생산자의 대문자 어휘이고 RouteBench 시나리오 replay_mode 의 소문자 '
      + '(exact·partial·simulation)와 다른 필드다. `--since` 로 창을 좁히면 라벨 자체가 '
      + '바뀐다 — 창 밖 바인드·영수증은 늦은 것이 아니라 없는 것이라 SIMULATED 로 읽힌다'
      + '(replay-label.js CANNOT SEE #3). 분모 밖(unlabeled)은 이 행에 없다. actions 0 이면 '
      + `unmeasured 이지 0% 가 아니다.${empty}`,
  });
}

/**
 * The permanently unmeasured quality row.
 *
 * @param {object} fold - validated fold.
 * @returns {Readonly<object>} metric.
 */
function scoreMetric(fold) {
  return metric({
    key: 'compare.score',
    label: '스폰 결과 점수 (측정자 없음)',
    source: 'spawn-outcome score.source · score.value · score.reason',
    denominator: 0,
    note: `source: null · value: null · reason: ${fold.score.reason}. 분모를 0 으로 고정해 `
      + '영구 unmeasured 다 — 원장에 스폰-키 점수 writer 가 없다(spawn-outcome.js CANNOT SEE '
      + '#4). 합의는 품질이 아니다: compare.agreement 가 높아도 라우팅이 옳았다는 뜻이 '
      + '아니다. 행을 빼지 않고 남겨 둔 이유는 부재가 "해당 없음"으로 읽히지 않게 하려는 '
      + '것이다.',
  });
}

/**
 * Build the compare card.
 *
 * @param {object} fold - `joinSpawnOutcomes(events)` output. Read only.
 * @param {object} [opts] - options.
 * @param {string|null} [opts.since] - label of the window the caller filtered to.
 * @param {object} opts.replay - `labelReplay(events)` output over the SAME
 *   events as `fold`. Required; read only.
 * @returns {Readonly<object>} `{kind, scope, metrics, unmeasured, totals}`.
 * @throws {TypeError} when the fold is not a fold, `since` is not a label, or
 *   `replay` is absent or not a label fold.
 */
export function buildCompareScorecard(fold, { since, replay } = {}) {
  requireFold(fold);
  const label = requireSinceLabel(since);
  requireReplay(replay);
  const joined = fold.pairs.length;

  return freezeCard({
    kind: COMPARE_KIND,
    scope: { scope: 'index', since: label },
    metrics: [
      pairsMetric(fold, joined),
      agreementMetric(fold),
      confidenceMetric(fold, joined),
      costMetric(fold),
      ...residueMetrics(fold, joined),
      replayLabelMetric(replay),
      scoreMetric(fold),
    ],
  });
}
