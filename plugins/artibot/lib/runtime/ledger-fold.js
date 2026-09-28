/**
 * The run ledger's fold stages that run BEFORE `event-writer.js#foldOversized`
 * — what the writer tries on a line that is over the byte cap AFTER
 * redaction, so that the keys a line is aggregated by survive it.
 *
 * ORDER, CHEAPEST LOSS FIRST. On an oversized line:
 *   1. Drop the `data` keys the allowlist neither requires nor declares, and
 *      name them in a `ledger-fold:dropped=…` marker in the overflow field
 *      (`limits.overflow_field`). Declared keys are the ones a reader groups
 *      by (`review.claim_audit`'s `nature`, `subject_model`,
 *      `subject_agent_id`; `human.asked`'s `gate`); undeclared ones are not.
 *   2. Still over: keep the longest PREFIX of the overflow array that fits
 *      beside one marker, `ledger-fold:<field>-truncated=kept<N>/total<M>`.
 *      Elements are kept or cut whole — half a reference points at nothing —
 *      so one giant element is cut to `kept0`.
 *   3. Still over: {@link shrinkToFit} returns null and the writer applies
 *      `foldOversized` to the ORIGINAL envelope, unchanged from before this
 *      module existed; whatever that cannot fit is rejected.
 *
 * WHY. `foldOversized` alone drops every non-required key to keep the
 * overflow array whole, and rejects the line when the array is the large part.
 * Redaction lengthens strings after the writer-side budgets ran, which is how
 * builder-budgeted claim audits reached it and lost their declared keys or the
 * whole row. The cap-boundary and redaction-growth fixtures in
 * `tests/runtime/event-writer.test.js` pin that neither happens now.
 *
 * EARLIER TRUNCATION MARKERS SURVIVE. An element that already reads
 * `…truncated=kept<N>/total<M>` — a builder that cut the array before the
 * writer saw it — is never cut, and stays ahead of the new marker, so the
 * original total is still on the line. It is recognized by that SHAPE, not by
 * which event or builder wrote it, and it is not counted in the new total.
 *
 * NOT APPLIED to `data_schema` events (their receipt schemas are
 * `additionalProperties:false`), to an envelope whose overflow field holds a
 * non-array, or when the allowlist names no overflow field. Each of those
 * falls through to `foldOversized` exactly as before.
 *
 * This module imports nothing from the writer. Line measurement and the
 * overflow field name are passed in, so the one definition of each stays in
 * `./event-writer.js`.
 *
 * @module lib/runtime/ledger-fold
 */

/** Cap on a fold marker so the marker itself cannot overflow the line. */
export const FOLD_MARKER_MAX = 180;

/** The shape of a truncation marker, whoever wrote it. */
const TRUNCATION_MARKER_RE = /truncated=kept\d+\/total\d+$/;

/**
 * @typedef {object} FoldResult
 * @property {object} env the envelope to append (the input when not folded)
 * @property {boolean} folded whether it was changed
 * @property {string[]} dropped keys removed, in `data` order
 * @property {{field: string, kept: number, total: number}|null} truncated
 *   what stage 2 cut, or null
 */

/**
 * @param {string} body
 * @returns {string}
 */
function marker(body) {
  return `ledger-fold:${body}`.slice(0, FOLD_MARKER_MAX);
}

/**
 * @param {unknown} ref
 * @returns {boolean} whether `ref` is an earlier truncation marker
 */
function isTruncationMarker(ref) {
  return typeof ref === 'string' && ref.length <= FOLD_MARKER_MAX
    && TRUNCATION_MARKER_RE.test(ref);
}

/**
 * @param {object} env
 * @param {object} spec allowlist entry
 * @param {unknown} field overflow field name
 * @returns {boolean} whether these stages may touch the envelope at all
 */
function foldable(env, spec, field) {
  const data = env?.data;
  if (typeof spec?.data_schema === 'string') return false;
  if (typeof field !== 'string' || field.length === 0) return false;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  return data[field] === undefined || Array.isArray(data[field]);
}

/**
 * Stage 1: the envelope without its undeclared optional keys.
 *
 * @param {object} env a foldable envelope
 * @param {object} spec allowlist entry
 * @param {string} field overflow field name
 * @returns {{data: object, dropped: string[], tail: string[]}} the kept keys,
 *   what went, and the marker to append after the overflow array
 */
function dropUndeclared(env, spec, field) {
  const required = new Set(Array.isArray(spec?.required) ? spec.required : []);
  const fields = spec?.fields && typeof spec.fields === 'object' ? spec.fields : {};
  const keep = (k) => k === field || required.has(k) || Object.hasOwn(fields, k);
  const dropped = Object.keys(env.data).filter((k) => !keep(k));
  const data = Object.fromEntries(Object.entries(env.data).filter(([k]) => keep(k)));
  const tail = dropped.length > 0 ? [marker(`dropped=${dropped.join(',')}`)] : [];
  return { data, dropped, tail };
}

/**
 * Stage 2: keep the longest prefix of the overflow array that fits.
 *
 * Binary search over N in `[0, M-1]`: the line grows strictly with N (each
 * element costs at least a byte and a comma, and the marker's digits never
 * shrink), so "fits" is monotone. M is not a candidate — every element plus a
 * marker is longer than the line that already did not fit.
 *
 * @param {object} env the original envelope
 * @param {{data: object, dropped: string[], tail: string[]}} stage1
 * @param {string} field overflow field name
 * @param {(env: object) => number} fits whether a candidate is within the cap
 * @returns {FoldResult|null} null when nothing can be cut or the marker alone
 *   does not fit
 */
function truncatePrefix(env, stage1, field, fits) {
  const refs = Array.isArray(env.data[field]) ? env.data[field] : [];
  const pinned = refs.filter(isTruncationMarker);
  const cuttable = refs.filter((r) => !isTruncationMarker(r));
  if (cuttable.length === 0) return null;
  const keeping = (n) => ({
    ...env,
    data: {
      ...stage1.data,
      [field]: [
        ...cuttable.slice(0, n), ...pinned,
        marker(`${field}-truncated=kept${n}/total${cuttable.length}`), ...stage1.tail,
      ],
    },
  });
  if (!fits(keeping(0))) return null;
  let lo = 0;
  let hi = cuttable.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(keeping(mid))) lo = mid;
    else hi = mid - 1;
  }
  return {
    env: keeping(lo),
    folded: true,
    dropped: stage1.dropped,
    truncated: { field, kept: lo, total: cuttable.length },
  };
}

/**
 * Bring an envelope under the cap by stages 1 and 2, or return null so the
 * writer can fall back to `foldOversized`. A line already within the cap is
 * returned untouched.
 *
 * @param {object} env validated, redacted envelope
 * @param {object} spec allowlist entry
 * @param {{maxLineBytes: number, overflowField: unknown,
 *          measure: (env: object) => number}} opts
 * @returns {FoldResult|null}
 */
export function shrinkToFit(env, spec, { maxLineBytes, overflowField, measure }) {
  const fits = (candidate) => measure(candidate) <= maxLineBytes;
  if (fits(env)) return { env, folded: false, dropped: [], truncated: null };
  if (!foldable(env, spec, overflowField)) return null;
  const stage1 = dropUndeclared(env, spec, overflowField);
  if (stage1.dropped.length > 0) {
    const refs = Array.isArray(env.data[overflowField]) ? env.data[overflowField] : [];
    const dropped = { ...env, data: { ...stage1.data, [overflowField]: [...refs, ...stage1.tail] } };
    if (fits(dropped)) {
      return { env: dropped, folded: true, dropped: stage1.dropped, truncated: null };
    }
  }
  return truncatePrefix(env, stage1, overflowField, fits);
}
