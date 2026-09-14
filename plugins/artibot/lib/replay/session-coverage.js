/**
 * Session coverage — Observe axis ④, read as a JOIN rather than a self-report.
 *
 * THE DENOMINATOR IS A ROW, NOT AN ABSENCE
 * ---------------------------------------------------------------------------
 * `usage.receipt` counts sessions that PRODUCED receipts. On its own that
 * number cannot separate "few sessions ended" from "most sessions ended without
 * a receipt", because a session that produced nothing writes nothing. So
 * `scripts/hooks/session-end.js#recordSessionEnded` writes one `session.ended`
 * row per ended session AFTER the receipt stage and REGARDLESS of its outcome,
 * and this fold divides by that. A session with no `session.ended` row is not
 * a zero here — it is outside the measurement.
 *
 * THE JOIN IS CANONICAL, THE STATUS IS A WITNESS
 * ---------------------------------------------------------------------------
 * The `session.ended` row carries `data.receipt_status` ('appended' | 'failed'
 * | 'skipped', from `session-end.js#appendReceiptEnvelopes`) — what the hook
 * believed it had just done. `with_receipts` does not use it. It counts
 * sessions for which a `usage.receipt` row is actually READABLE in the input,
 * because 존재 ≠ 성공 ≠ 결과: an append that returned ok and a row that can be
 * read back are two different claims. Where the two disagree, both directions
 * are listed in `disagree` rather than reconciled — a reconciliation here would
 * decide which of the two measurements to believe, and that is not this
 * module's call.
 *
 * PURITY (design §1-8, L2). No clock, no filesystem, no randomness. The events
 * array is the injected port: the caller passes `lib/runtime/ledger.js`'s
 * `readAllEvents` output (deduplicated, file order), which this module may not
 * import (L2 → L5 is forbidden). Every list and every key in the result is
 * sorted, so a shuffled input of distinct sessions serializes to the same bytes.
 *
 * ── WHAT THIS MODULE CANNOT SEE (repo rule §9: write it next to the gate) ────
 *  1. ACTIVE SESSIONS. A session still running has no `session.ended` row yet
 *     and is NOT in the denominator. `coverage` is over ENDED sessions only, so
 *     it says nothing about how a live session is doing, and a read taken
 *     mid-session is not a smaller sample of the same population.
 *  2. A RE-FIRED SessionEnd. `ended --resume` can fire SessionEnd twice for one
 *     session. The FIRST row in input order wins for status, reason and
 *     fallback; later rows only bump `duplicate_ended_rows`. Which of the two
 *     rows is "the truth" about that session is not decidable from the rows.
 *  3. WHETHER `receipt_status` IS RIGHT. It is the hook's SELF-REPORT, so
 *     `by_status` and `by_reason` are auxiliary — a breakdown of what the writer
 *     thought, not of what is in the ledger. The join is the measurement.
 *  4. RECEIPTS THAT LANDED UNDER ANOTHER ID. Receipts written under a mission
 *     but with a different or missing `session_id` do not join, and this module
 *     cannot tell that case apart from receipts that were never written. It
 *     does not look at `mission_id` at all.
 *  5. WHETHER A RECEIPT IS PRICED. A `usage.receipt` row counts whether or not
 *     it carries a cost. "Covered" here means a row exists, not that the row
 *     resolved a model or produced a number.
 *  6. RETENTION. A session whose rows rotated out of the window the caller read
 *     is invisible on both sides; a window that cut between a session's receipts
 *     and its `session.ended` row shows up as a false disagreement.
 *
 * @module lib/replay/session-coverage
 */

/** The two ledger events this fold reads. */
export const SESSION_COVERAGE_EVENTS = Object.freeze({
  ended: 'session.ended',
  receipt: 'usage.receipt',
});

/**
 * `receipt_status` value the hook writes when at least one envelope appended
 * (`session-end.js#appendReceiptEnvelopes`). The only status the join expects
 * to find a row behind.
 */
const STATUS_APPENDED = 'appended';

/** Bucket key for a missing or non-string status/reason. */
const NULL_KEY = 'null';

/**
 * Is `value` a non-empty string?
 * @param {unknown} value
 * @returns {boolean}
 */
function isStr(value) {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Stable string order for sort callbacks.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Count one key.
 * @param {Map<string, number>} counts
 * @param {string} key
 * @returns {void}
 */
function bump(counts, key) {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

/**
 * A counting map as a key-sorted plain object.
 *
 * `Object.fromEntries` defines own properties, so a status literally spelled
 * `__proto__` becomes a visible bucket instead of silently mutating a prototype.
 *
 * @param {Map<string, number>} counts
 * @returns {Record<string, number>}
 */
function sortedCounts(counts) {
  return Object.fromEntries([...counts.entries()].sort((a, b) => cmp(a[0], b[0])));
}

/**
 * The three self-reported fields of one `session.ended` row.
 *
 * @param {object} e - screened ledger line
 * @returns {{status: string, reason: string, fallback: boolean}}
 */
function selfReportOf(e) {
  const d = e.data && typeof e.data === 'object' ? e.data : {};
  return {
    status: isStr(d.receipt_status) ? d.receipt_status : NULL_KEY,
    reason: isStr(d.reason) ? d.reason : NULL_KEY,
    fallback: d.session_fallback === true,
  };
}

/**
 * One pass over the input: the ended sessions and the sessions with receipts.
 *
 * FIRST ROW WINS, in INPUT order. The caller passes file order; sorting by `ts`
 * would make the answer depend on a clock this module may not read, and on
 * timestamps written by whichever process fired last.
 *
 * @param {object[]} list - ledger lines
 * @returns {{ended: Map<string, object>, receiptSessions: Set<string>,
 *   malformedEnded: number, duplicateEndedRows: number}}
 */
function collect(list) {
  const ended = new Map();
  const receiptSessions = new Set();
  let malformedEnded = 0;
  let duplicateEndedRows = 0;

  for (const e of list) {
    if (!e || typeof e !== 'object') continue;
    if (e.event === SESSION_COVERAGE_EVENTS.ended) {
      if (!isStr(e.session_id)) {
        malformedEnded += 1;
        continue;
      }
      if (ended.has(e.session_id)) {
        duplicateEndedRows += 1;
        continue;
      }
      ended.set(e.session_id, selfReportOf(e));
      continue;
    }
    if (e.event === SESSION_COVERAGE_EVENTS.receipt && isStr(e.session_id)) {
      receiptSessions.add(e.session_id);
    }
  }
  return { ended, receiptSessions, malformedEnded, duplicateEndedRows };
}

/**
 * Fold ledger lines into Observe's session-coverage numbers.
 *
 * @param {object[]} events - ledger lines in file order; a non-array reads as
 *   an empty ledger.
 * @returns {{
 *   ended: number, with_receipts: number, coverage: number|null,
 *   fallback_sessions: number,
 *   by_status: Record<string, number>, by_reason: Record<string, number>,
 *   disagree: {status_appended_no_receipt: string[],
 *     receipt_but_status_not_appended: string[], count: number},
 *   receipt_only_sessions: string[], receipt_sessions: number,
 *   duplicate_ended_rows: number, malformed_ended: number
 * }} `coverage` is `null` — never 0 — when no session ended: an empty
 *   denominator is UNMEASURED, and a 0 would read as a finding.
 *   `receipt_only_sessions` are sessions with receipts and no `session.ended`
 *   row (receipts predate the event, so early ledgers carry many); they are
 *   outside the denominator, which is why `receipt_sessions` can exceed
 *   `with_receipts`. `malformed_ended` counts `session.ended` rows dropped for
 *   a missing `session_id` — they belong to no session and cannot be counted,
 *   but a non-zero here means the denominator is short by that much.
 */
export function foldSessionCoverage(events) {
  const { ended, receiptSessions, malformedEnded, duplicateEndedRows } = collect(
    Array.isArray(events) ? events : [],
  );

  const byStatus = new Map();
  const byReason = new Map();
  const appendedNoReceipt = [];
  const receiptNotAppended = [];
  let withReceipts = 0;
  let fallbackSessions = 0;

  for (const [sid, report] of ended) {
    bump(byStatus, report.status);
    bump(byReason, report.reason);
    if (report.fallback) fallbackSessions += 1;
    const joined = receiptSessions.has(sid);
    if (joined) withReceipts += 1;
    if (report.status === STATUS_APPENDED && !joined) appendedNoReceipt.push(sid);
    if (joined && report.status !== STATUS_APPENDED) receiptNotAppended.push(sid);
  }

  const receiptOnly = [...receiptSessions].filter((sid) => !ended.has(sid)).sort(cmp);

  return {
    ended: ended.size,
    with_receipts: withReceipts,
    coverage: ended.size === 0 ? null : withReceipts / ended.size,
    fallback_sessions: fallbackSessions,
    by_status: sortedCounts(byStatus),
    by_reason: sortedCounts(byReason),
    disagree: {
      status_appended_no_receipt: appendedNoReceipt.sort(cmp),
      receipt_but_status_not_appended: receiptNotAppended.sort(cmp),
      count: appendedNoReceipt.length + receiptNotAppended.length,
    },
    receipt_only_sessions: receiptOnly,
    receipt_sessions: receiptSessions.size,
    duplicate_ended_rows: duplicateEndedRows,
    malformed_ended: malformedEnded,
  };
}
