/**
 * Compare Scorecard — what the router RECOMMENDED against what actually SERVED,
 * folded into §34/§35 card rows.
 *
 * WHERE THE NUMBERS COME FROM
 * ---------------------------------------------------------------------------
 * ONE place: the OUTPUT of `lib/replay/spawn-outcome.js#joinSpawnOutcomes`. This
 * card does no joining, no filtering and no counting of ledger lines — it picks
 * denominators for figures that fold already computed, and that is all it does.
 * `joinSpawnOutcomes` is NOT called here: the caller runs `readAllEvents →
 * joinSpawnOutcomes → buildCompareScorecard`, so the fold has exactly one call
 * site per render and the card cannot disagree with the fold it is printing.
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
 *  2. WHICH FIGURES OF THE FOLD ARE NOT ROWS. `duplicate_binds`,
 *     `malformed_binds`, `malformed_receipts`, `model_mismatch`,
 *     `duplicate_receipts`, `multi_model_runs`, `excluded_no_recommendation`,
 *     `agreed_by_model`, `divergence`, `usage_totals` and `latency` are in the
 *     fold and NOT on this card — row-level integrity counters and detail
 *     histograms, where the card is eight rows. A reader who needs them must
 *     read the fold, and their absence here is not evidence they are zero.
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
 *
 * PURITY (design §1-8, L2). No clock, no filesystem, no randomness, no
 * `process`. The only import is `./metric.js`; the fold arrives as an argument
 * and is READ ONLY. Every histogram is key-sorted by `metric()`, so a shuffled
 * ledger serializes to the same bytes.
 *
 * @module lib/scorecard/compare-scorecard
 */

import { freezeCard, metric } from './metric.js';

/** Card kind, matching `ROUTING_KIND`'s role in the renderer. */
export const COMPARE_KIND = 'compare';

/** Decimal places a bucket total is printed with. See `money`. */
const MONEY_DIGITS = 6;

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
 * Validate the explicit null score block.
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
  for (const [k, n] of Object.entries(fold.by_confidence)) {
    if (!isCount(n)) reject(`\`by_confidence.${k}\` must be a non-negative integer`);
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
    counts: { same, diverged },
    note: '분모는 allowlist(exact,name) 확인이고 recommended_model 이 있는 쌍만이다 — '
      + '나머지는 일치로 세지 않고 분모에서 뺀다(compare.excluded_fifo 행이 센다). 분모 0 '
      + '이면 unmeasured 이지 "아무 스폰도 추천 모델을 못 받았다"가 아니다. 일치는 품질이 '
      + '아니고 어느 쪽이 옳았는지는 판정하지 않는다(spawn-outcome.js CANNOT SEE #1).',
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
    counts: fold.by_confidence,
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
    counts: {
      agreed_priced: cost.same.priced,
      diverged_priced: cost.diverged.priced,
      unpriced: cost.unpriced,
    },
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
 * Built together because they are read together — a reader who sees a low
 * `compare.agreement` denominator finds the missing population in exactly these
 * three rows, and each one has a DIFFERENT denominator on purpose.
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
        + 'agent_id 를 만들지 않는다(spawn-outcome.js#collect).',
    }),
  ];
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
 * @returns {Readonly<object>} `{kind, scope, metrics, unmeasured, totals}`.
 * @throws {TypeError} when the fold is not a fold, or `since` is not a label.
 */
export function buildCompareScorecard(fold, { since } = {}) {
  requireFold(fold);
  const label = requireSinceLabel(since);
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
      scoreMetric(fold),
    ],
  });
}
