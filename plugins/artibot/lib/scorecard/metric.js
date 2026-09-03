/**
 * The scorecard's unit: one number that cannot be read without its denominator.
 *
 * WHY A METRIC IS NOT A NUMBER HERE
 * ---------------------------------------------------------------------------
 * Every row this directory renders is a fold over ledger lines, and in Phase 0
 * most folds run over ZERO lines: the ledger writers landed in this batch but
 * an install that predates them writes nothing (see session-scorecard.js #1).
 * A metric type that is just a number turns that into `0`, and `0` reads as
 * "measured, and the answer is none". The repo has been bitten by exactly that
 * shape before, which is why `verify_result` carries `unmeasured` as a
 * first-class value beside pass/fail (`schemas/ledger-events.allowlist.json`,
 * enum_sources.verify_result: "재지 못한 층을 PASS 라 부르지 않는다").
 *
 * So a metric carries `denominator` ALWAYS, and `measured` is derived from it
 * rather than asserted by the caller. `denominator === 0` implies `state:
 * 'unmeasured'` and `ratio: null`. There is no code path that produces `0%`
 * from an empty denominator, because there is no code path that divides by it.
 *
 * TWO SENSES OF THE WORD "MEASURED" — READ THIS BEFORE USING THE FIELD
 * ---------------------------------------------------------------------------
 * They are different and they appear in the same card:
 *
 *   1. `metric.measured` — was THIS METRIC computable? False when nothing was
 *      there to fold over. It says nothing about the quality of the values.
 *   2. `cost_term.measured` — did THAT VALUE come from a measurement, or is it
 *      a constant? Owned by `schemas/route-receipt.schema.json#/definitions/
 *      cost_term`: "measured is mandatory so estimated and measured terms are
 *      never conflated (§46 EXACT/PARTIAL/SIMULATED labelling)".
 *
 * `routing.estimated_terms` folds sense 2 and is itself a metric with sense 1,
 * so a reader can hit both words in one row. That metric's histogram keys are
 * therefore spelled `terms_measured_true` / `terms_measured_false` rather than
 * `measured` / `estimated`, so no key ever collides with the metric's own
 * field name.
 *
 * FAIL-CLOSED CONSTRUCTION
 * ---------------------------------------------------------------------------
 * A malformed spec THROWS. Coercing a bad denominator to 0 would turn a caller
 * wiring bug into a well-formed `unmeasured` row, and then a broken card and an
 * empty ledger would render identically — the fail-open shape again.
 *
 * PURITY (design §1-8, L2)
 * ---------------------------------------------------------------------------
 * No clock, no filesystem, no randomness anywhere in `lib/scorecard/`. Input is
 * a `lib/replay` index, which is itself a pure projection of the ledger. The
 * only sibling import is `countBy` from `lib/replay` (same layer, L2): folding
 * a histogram WITH its denominator is precisely what that function exists for,
 * and a second local copy of it would be a second answer to the same question.
 *
 * @module lib/scorecard/metric
 */

import { countBy } from '../replay/index.js';

/** Metric states. An allowlist — a consumer switching on this must not fall through. */
export const METRIC_STATE = Object.freeze({
  MEASURED: 'measured',
  UNMEASURED: 'unmeasured',
});

/** Rendered in place of any figure whose denominator is zero. Never `0%`. */
export const UNMEASURED_TEXT = 'unmeasured';

/**
 * A shallow copy of `counts` with keys sorted.
 *
 * Property order is observable through `JSON.stringify`, so an encounter-order
 * histogram serializes differently for a reordered input and breaks the
 * determinism this directory promises.
 *
 * @param {Record<string, number>} counts - histogram.
 * @returns {Record<string, number>} same entries, sorted keys.
 */
export function sortedCounts(counts) {
  const out = {};
  for (const k of Object.keys(counts).sort()) out[k] = counts[k];
  return out;
}

/**
 * Assert a non-empty string field, naming the field in the failure.
 *
 * @param {unknown} value - candidate.
 * @param {string} field - field name for the message.
 * @returns {string} the validated string.
 * @throws {TypeError} when absent or empty.
 */
function requireText(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(
      `metric(): \`${field}\` must be a non-empty string, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/**
 * Assert a non-negative integer, naming the field in the failure.
 *
 * @param {unknown} value - candidate.
 * @param {string} field - field name for the message.
 * @returns {number} the validated integer.
 * @throws {TypeError} when not a non-negative integer.
 */
function requireCount(value, field) {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(
      `metric(): \`${field}\` must be a non-negative integer, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/**
 * Build one metric row.
 *
 * @param {object} spec - metric definition.
 * @param {string} spec.key - stable identifier, e.g. `routing.pin`.
 * @param {string} spec.label - human label rendered in the table.
 * @param {string} spec.source - what was folded, named so a reader can go and
 *   check it (a ledger event name, or the replay field).
 * @param {number} spec.denominator - lines the fold ran over. Zero means unmeasured.
 * @param {number|null} [spec.numerator] - the counted subset, when the metric
 *   is a rate. `null` for a pure histogram.
 * @param {Record<string, number>|null} [spec.counts] - histogram, key-sorted here.
 * @param {number} [spec.absent] - denominator members that carried no usable
 *   value. Kept separate so a missing field never lands in a real bucket.
 * @param {string} [spec.note] - one line a reader needs to not misread the row.
 * @returns {Readonly<object>} frozen metric.
 * @throws {TypeError} on a malformed spec.
 */
export function metric(spec) {
  if (!spec || typeof spec !== 'object') {
    throw new TypeError(`metric(): spec must be an object, got ${JSON.stringify(spec)}`);
  }
  const key = requireText(spec.key, 'key');
  const label = requireText(spec.label, 'label');
  const source = requireText(spec.source, 'source');
  const denominator = requireCount(spec.denominator, 'denominator');
  const absent = requireCount(spec.absent ?? 0, 'absent');
  if (absent > denominator) {
    throw new TypeError(`metric(${key}): absent ${absent} exceeds denominator ${denominator}`);
  }
  // A numerator ABOVE the denominator is deliberately allowed, and the guard
  // that would reject it was removed on purpose. `session.human_reach` divides
  // human.resolved by human.asked, and a resolved line with no matching asked
  // line is the exact anomaly the allowlist names as detectable ("a human.asked
  // with no matching human.resolved is a detectable signature", and the reverse
  // pairing is what makes it detectable at all). A metric type that cannot
  // represent ratio > 1 forces every builder to pick a weaker denominator, and
  // then the anomaly stops being visible anywhere. `absent > denominator` IS
  // still rejected above, because countBy makes that arithmetically impossible.
  let numerator = null;
  if (spec.numerator !== undefined && spec.numerator !== null) {
    numerator = requireCount(spec.numerator, 'numerator');
  }
  const measured = denominator > 0;
  return Object.freeze({
    key,
    label,
    source,
    denominator,
    numerator,
    ratio: measured && numerator !== null ? numerator / denominator : null,
    counts: spec.counts ? sortedCounts(spec.counts) : null,
    absent,
    measured,
    state: measured ? METRIC_STATE.MEASURED : METRIC_STATE.UNMEASURED,
    note: typeof spec.note === 'string' ? spec.note : '',
  });
}

/**
 * A histogram metric folded through `lib/replay#countBy`, which supplies the
 * denominator and the `absent` count on the same pass.
 *
 * @param {object[]} events - lines to fold over.
 * @param {string|((e: object) => unknown)} pick - field name or selector.
 * @param {object} spec - the rest of the `metric` spec (key, label, source, note).
 * @returns {Readonly<object>} frozen metric.
 */
export function histogramMetric(events, pick, spec) {
  const { counts, absent, total } = countBy(events, pick);
  return metric({ ...spec, counts, absent, denominator: total });
}

/**
 * Read a dotted path off an object without throwing on a missing hop.
 *
 * Receipts nest (`data.decision.type`, `data.models.selected.tier`), and every
 * one of those hops is optional as far as this directory is concerned — no
 * writer is wired in Phase 0, and the fixtures a reader meets first are
 * partial. A missing hop must land in `absent`, not in a bucket named
 * "undefined".
 *
 * @param {object} obj - root.
 * @param {string[]} path - keys to walk.
 * @returns {unknown} the value, or `undefined` when any hop is missing.
 */
export function readPath(obj, path) {
  let cur = obj;
  for (const key of path) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = cur[key];
  }
  return cur;
}

/**
 * Count members satisfying a predicate.
 *
 * @param {object[]} items - candidates.
 * @param {(item: object) => boolean} pred - predicate.
 * @returns {number} matches.
 */
export function countWhere(items, pred) {
  let n = 0;
  for (const item of items) if (pred(item)) n += 1;
  return n;
}

/**
 * Tally a field across records into a key-sorted histogram.
 *
 * Unlike `countBy` this returns no denominator of its own — the caller supplies
 * one that means something (the record count), because a histogram over
 * RECORDS and a histogram over LEDGER LINES have different denominators, and
 * mixing them is how a rate silently changes meaning between two rows of the
 * same table. Non-string and empty values are skipped rather than bucketed, so
 * a missing field never becomes a category named `undefined`.
 *
 * @param {object[]} records - records to fold.
 * @param {(r: object) => unknown} pick - selector.
 * @returns {Record<string, number>} key-sorted counts.
 */
export function tallyBy(records, pick) {
  const counts = {};
  for (const r of records) {
    const raw = pick(r);
    if (typeof raw !== 'string' || raw.length === 0) continue;
    counts[raw] = (counts[raw] ?? 0) + 1;
  }
  return sortedCounts(counts);
}

/**
 * Finish a card: derive the unmeasured index and freeze.
 *
 * `unmeasured` is DERIVED from the metrics rather than maintained beside them.
 * A hand-maintained list is a second copy that drifts the first time someone
 * adds a metric and forgets the list, and the drift always runs the dangerous
 * way — a card that under-reports what it could not measure.
 *
 * @param {{kind: string, scope: object, metrics: object[]}} card - card parts.
 * @returns {Readonly<object>} frozen card with `unmeasured` and `totals`.
 */
export function freezeCard(card) {
  const unmeasured = card.metrics.filter((m) => !m.measured).map((m) => m.key);
  return Object.freeze({
    kind: card.kind,
    scope: Object.freeze({ ...card.scope }),
    metrics: Object.freeze([...card.metrics]),
    unmeasured: Object.freeze(unmeasured),
    totals: Object.freeze({
      metrics: card.metrics.length,
      measured: card.metrics.length - unmeasured.length,
      unmeasured: unmeasured.length,
    }),
  });
}
