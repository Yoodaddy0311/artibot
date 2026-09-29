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
 * SKIPPED, ITS CAUSES, AND THE CATALOG-DRIFT COLUMN
 * ---------------------------------------------------------------------------
 * `skipped` is `ended - with_receipts`, counted from the JOIN: an ended session
 * with no readable `usage.receipt` row. It is NOT `by_status.skipped` (the
 * hook's self-report of `receipt_status`); a session can claim `skipped` and
 * still have a receipt row, and a session can claim `appended` and have none
 * (`disagree` lists both). `skipped_by_cause` files each skipped session under
 * the hook's own `reason`, bucketed by a fixed rule (`causeOf`), and its values
 * sum to `skipped`. `unresolved_models` aggregates the rows'
 * `data.unresolved_models` for ALL ended sessions, covered or not: a covered
 * session can still have lost part of its spend to a model the catalog does not
 * know, and the ratio cannot see that. Both are counts over the same `collect`
 * pass as the ratio, so they cannot disagree with it.
 *
 * AN EXCLUSION NEVER REPLACES THE RAW VIEW
 * ---------------------------------------------------------------------------
 * {@link foldCoverageViews} returns the raw fold and, when session ids are
 * excluded, the fold over the same rows minus every row of those ids, side by
 * side, plus an account of what the exclusion touched. There is no spelling of
 * that call that returns only the excluded numbers: a reader who is handed one
 * view can quote one view, and quoting only the flattering one is the failure
 * this shape exists to prevent. WHICH ids belong on a list is the caller's
 * decision (only sessions that made no model call qualify); this module reports
 * `exclusion.with_receipts` so a covered session on a list is visible.
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
 *     and its `session.ended` row shows up as a false disagreement (and, when
 *     the cut falls between them, as a false SKIPPED session).
 *  7. WHY A SESSION WAS EXCLUDED. The id list is the caller's word. This module
 *     checks that a listed session ended and whether it has receipts; it cannot
 *     check that it made no model call.
 *  8. THE CAUSE IS THE HOOK'S. `skipped_by_cause` buckets the reason the hook
 *     wrote; it does not re-derive one. A bare `no-receipts` is "the hook could
 *     not classify this", not "cause unknown to the session".
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

/** The hook's bare reason for a session that produced nothing to write. */
const REASON_NO_RECEIPTS = 'no-receipts';

/**
 * `no-receipts:<cause>` exactly as `session-end.js#emptyReceiptsReason` writes
 * it: lowercase words joined by hyphens, bounded. The suffix vocabulary is NOT
 * enumerated here — a cause the hook learns later gets its own column instead
 * of being filed under `other` — but the SHAPE is fixed, so free text can never
 * become a column name.
 */
const NO_RECEIPTS_SUFFIXED = /^no-receipts:[a-z][a-z-]{0,38}$/;

/** The text before the first colon of any other reason, when it is a plain word. */
const REASON_HEAD = /^[a-z][a-z0-9-]{0,39}$/;

/** Cause bucket for a reason no rule recognises (free text, over-long, odd shape). */
const CAUSE_OTHER = 'other';

/**
 * One session id as an exclusion list may spell it: UUIDs, `session-<ms>` and
 * the like. No whitespace, no path separators, no comma. The ledger itself only
 * requires a non-empty string, so an id outside this shape cannot be listed —
 * and is COUNTED as ignored rather than dropped.
 */
const SESSION_ID_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** A markdown list bullet in front of an id. */
const LIST_MARKER = /^[-*+]\s+/;

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
 * The distinct non-empty strings of a value, sorted; `[]` for anything that is
 * not an array. A row's `unresolved_models` is written by the hook, but this
 * fold reads a ledger and does not get to assume the writer was that hook.
 *
 * @param {unknown} value
 * @returns {string[]}
 */
function modelList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(isStr))].sort(cmp);
}

/**
 * The self-reported fields of one `session.ended` row.
 *
 * @param {object} e - screened ledger line
 * @returns {{status: string, reason: string, fallback: boolean, unresolved: string[]}}
 */
function selfReportOf(e) {
  const d = e.data && typeof e.data === 'object' ? e.data : {};
  return {
    status: isStr(d.receipt_status) ? d.receipt_status : NULL_KEY,
    reason: isStr(d.reason) ? d.reason : NULL_KEY,
    fallback: d.session_fallback === true,
    unresolved: modelList(d.unresolved_models),
  };
}

/**
 * The `skipped_by_cause` column a session's reason belongs to. Every reason
 * lands in exactly one column, so the columns partition the skipped sessions.
 *
 *  - a missing / non-string / empty reason     → `null` (same key as `by_reason`)
 *  - `no-receipts`                              → `no-receipts` (the BARE reason)
 *  - `no-receipts:<lowercase-hyphenated>`       → itself, one column per cause
 *  - `no-receipts:` + anything else             → `other`. NOT the bare column:
 *    a reason that claims a cause but breaks the shape is not evidence of the
 *    bare case, and the head rule below would otherwise file it there.
 *  - any other reason with a plain-word head    → that head (`parse-failed:<msg>`
 *    is `parse-failed`, so a free-text message never becomes a key)
 *  - everything else                            → `other`
 *
 * @param {string} reason - a `selfReportOf` reason, already a non-empty string
 * @returns {string}
 */
function causeOf(reason) {
  if (reason === NULL_KEY) return NULL_KEY;
  if (reason === REASON_NO_RECEIPTS || NO_RECEIPTS_SUFFIXED.test(reason)) return reason;
  if (reason.startsWith(`${REASON_NO_RECEIPTS}:`)) return CAUSE_OTHER;
  const head = reason.split(':', 1)[0];
  return REASON_HEAD.test(head) ? head : CAUSE_OTHER;
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
 * Count every ended session against the receipts, once.
 *
 * `with_receipts` and `skipped` are two counters on the two arms of one test,
 * NOT `ended - with_receipts`: the identity the report promises
 * (`ended = with_receipts + skipped`) is then a property of the code, and a
 * test can fail it. The cause column and the drift column are filled in the
 * same walk, so they cannot describe a different set of sessions than the ratio.
 *
 * @param {Map<string, {status: string, reason: string, fallback: boolean,
 *   unresolved: string[]}>} ended - `collect`'s ended sessions
 * @param {Set<string>} receiptSessions - sessions with a readable receipt row
 * @returns {{byStatus: Map<string, number>, byReason: Map<string, number>,
 *   byCause: Map<string, number>, byModel: Map<string, number>,
 *   appendedNoReceipt: string[], receiptNotAppended: string[],
 *   withReceipts: number, skipped: number, fallbackSessions: number,
 *   driftSessions: number, driftSkipped: number}}
 */
function tallySessions(ended, receiptSessions) {
  const t = {
    byStatus: new Map(),
    byReason: new Map(),
    byCause: new Map(),
    byModel: new Map(),
    appendedNoReceipt: [],
    receiptNotAppended: [],
    withReceipts: 0,
    skipped: 0,
    fallbackSessions: 0,
    driftSessions: 0,
    driftSkipped: 0,
  };

  for (const [sid, report] of ended) {
    bump(t.byStatus, report.status);
    bump(t.byReason, report.reason);
    if (report.fallback) t.fallbackSessions += 1;
    const joined = receiptSessions.has(sid);
    if (joined) {
      t.withReceipts += 1;
    } else {
      t.skipped += 1;
      bump(t.byCause, causeOf(report.reason));
    }
    if (report.unresolved.length > 0) {
      t.driftSessions += 1;
      if (!joined) t.driftSkipped += 1;
      for (const model of report.unresolved) bump(t.byModel, model);
    }
    if (report.status === STATUS_APPENDED && !joined) t.appendedNoReceipt.push(sid);
    if (joined && report.status !== STATUS_APPENDED) t.receiptNotAppended.push(sid);
  }
  return t;
}

/**
 * Fold ledger lines into Observe's session-coverage numbers.
 *
 * @param {object[]} events - ledger lines in file order; a non-array reads as
 *   an empty ledger.
 * @returns {{
 *   ended: number, with_receipts: number, coverage: number|null,
 *   skipped: number, skipped_by_cause: Record<string, number>,
 *   unresolved_models: {sessions: number, skipped_sessions: number,
 *     by_model: Record<string, number>},
 *   fallback_sessions: number,
 *   by_status: Record<string, number>, by_reason: Record<string, number>,
 *   disagree: {status_appended_no_receipt: string[],
 *     receipt_but_status_not_appended: string[], count: number},
 *   receipt_only_sessions: string[], receipt_sessions: number,
 *   duplicate_ended_rows: number, malformed_ended: number
 * }} `ended === with_receipts + skipped`, and the values of
 *   `skipped_by_cause` sum to `skipped`. `unresolved_models` counts sessions
 *   (covered or skipped) whose row named a model the catalog rejected, and the
 *   sessions naming each model. `coverage` is `null` — never 0 — when no
 *   session ended: an empty denominator is UNMEASURED, and a 0 would read as a
 *   finding.
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
  const t = tallySessions(ended, receiptSessions);
  const receiptOnly = [...receiptSessions].filter((sid) => !ended.has(sid)).sort(cmp);

  return {
    ended: ended.size,
    with_receipts: t.withReceipts,
    coverage: ended.size === 0 ? null : t.withReceipts / ended.size,
    skipped: t.skipped,
    skipped_by_cause: sortedCounts(t.byCause),
    unresolved_models: {
      sessions: t.driftSessions,
      skipped_sessions: t.driftSkipped,
      by_model: sortedCounts(t.byModel),
    },
    fallback_sessions: t.fallbackSessions,
    by_status: sortedCounts(t.byStatus),
    by_reason: sortedCounts(t.byReason),
    disagree: {
      status_appended_no_receipt: t.appendedNoReceipt.sort(cmp),
      receipt_but_status_not_appended: t.receiptNotAppended.sort(cmp),
      count: t.appendedNoReceipt.length + t.receiptNotAppended.length,
    },
    receipt_only_sessions: receiptOnly,
    receipt_sessions: receiptSessions.size,
    duplicate_ended_rows: duplicateEndedRows,
    malformed_ended: malformedEnded,
  };
}

/**
 * {@link foldSessionCoverage} at its empty values, as a literal.
 *
 * For a caller that must print the SAME key set after its own failure: calling
 * the fold again from inside that failure's handler could throw a second time,
 * and a literal cannot. A test pins `emptyCoverageFold()` to
 * `foldSessionCoverage([])`, so the two cannot drift apart unnoticed.
 *
 * @returns {ReturnType<typeof foldSessionCoverage>} a fresh object every call
 */
export function emptyCoverageFold() {
  return {
    ended: 0,
    with_receipts: 0,
    coverage: null,
    skipped: 0,
    skipped_by_cause: {},
    unresolved_models: { sessions: 0, skipped_sessions: 0, by_model: {} },
    fallback_sessions: 0,
    by_status: {},
    by_reason: {},
    disagree: {
      status_appended_no_receipt: [],
      receipt_but_status_not_appended: [],
      count: 0,
    },
    receipt_only_sessions: [],
    receipt_sessions: 0,
    duplicate_ended_rows: 0,
    malformed_ended: 0,
  };
}

/**
 * Unwrap one pair of matching backticks or quotes around an id.
 * @param {string} text
 * @returns {string}
 */
function unwrapId(text) {
  const match = /^(["'`])(.*)\1$/.exec(text);
  return match ? match[2].trim() : text;
}

/**
 * Read session ids out of the text of an exclusion list.
 *
 * `lines` (the default) is a plain list file, one id per line, and tolerates
 * what a hand-written note carries: markdown bullets, backticks or quotes
 * around an id, blank lines, `#` headings and comments. `csv` splits on commas
 * instead, for an id list typed on a command line.
 *
 * An entry that is not blank, not a comment and not a session id (see
 * `SESSION_ID_TOKEN`) is COUNTED in `ignored` rather than dropped: a list line
 * with a stray character would otherwise vanish, and the exclusion it was meant
 * to make would silently not happen. Prose in a note lands here too, which is
 * why the count is reported and not treated as an error.
 *
 * @param {unknown} text - a non-string reads as an empty list
 * @param {'lines'|'csv'} [format]
 * @returns {{ids: string[], ignored: number}} `ids` unique and sorted
 */
export function parseSessionIdList(text, format = 'lines') {
  if (typeof text !== 'string') return { ids: [], ignored: 0 };
  const entries = format === 'csv' ? text.split(',') : text.split(/\r?\n/);
  const ids = new Set();
  let ignored = 0;
  for (const raw of entries) {
    const entry = raw.trim();
    if (entry === '' || entry.startsWith('#')) continue;
    const id = unwrapId(entry.replace(LIST_MARKER, '').trim());
    if (SESSION_ID_TOKEN.test(id)) ids.add(id);
    else ignored += 1;
  }
  return { ids: [...ids].sort(cmp), ignored };
}

/**
 * The non-empty strings of an iterable, as a set. A bare string is NOT read as
 * a list of characters: it reads as nothing, because a caller that meant one id
 * should have parsed it (`parseSessionIdList`) and this fails closed.
 *
 * @param {unknown} value
 * @returns {Set<string>}
 */
function idSet(value) {
  const out = new Set();
  if (value === null || value === undefined || typeof value === 'string') return out;
  if (typeof value[Symbol.iterator] !== 'function') return out;
  for (const id of value) if (isStr(id)) out.add(id);
  return out;
}

/**
 * The raw fold and, when session ids are excluded, the fold over the same rows
 * without them — TOGETHER, never one instead of the other.
 *
 * An exclusion removes every row (of any event) whose `session_id` is listed,
 * so the ratio, the cause columns and the informational counts all describe the
 * same reduced ledger. `unexcluded` is always `foldSessionCoverage(events)`
 * unchanged; the exclusion cannot reach it.
 *
 * @param {object[]} events - ledger lines in file order; a non-array reads as empty
 * @param {{excludeSessions?: Iterable<string>}} [options] - ids to exclude; an
 *   empty, absent or non-iterable value means NO exclusion
 * @returns {{
 *   unexcluded: ReturnType<typeof foldSessionCoverage>,
 *   excluded: ReturnType<typeof foldSessionCoverage>|null,
 *   exclusion: {requested: number, matched_ended: number, unmatched: string[],
 *     with_receipts: string[]}|null
 * }} `exclusion` is null exactly when `excluded` is. `requested` counts unique
 *   ids; `matched_ended` is how many of them have a `session.ended` row in
 *   THESE events (equal to `unexcluded.ended - excluded.ended`); `unmatched`
 *   lists the rest; `with_receipts` lists matched ids that DO have a readable
 *   receipt — an exclusion list should hold sessions that produced none.
 */
export function foldCoverageViews(events, options = {}) {
  const list = Array.isArray(events) ? events : [];
  const unexcluded = foldSessionCoverage(list);
  const ids = idSet(options?.excludeSessions);
  if (ids.size === 0) return { unexcluded, excluded: null, exclusion: null };

  const kept = list.filter((e) => !(e && typeof e === 'object' && ids.has(e.session_id)));
  const { ended, receiptSessions } = collect(list);
  const matched = [...ids].filter((sid) => ended.has(sid));

  return {
    unexcluded,
    excluded: foldSessionCoverage(kept),
    exclusion: {
      requested: ids.size,
      matched_ended: matched.length,
      unmatched: [...ids].filter((sid) => !ended.has(sid)).sort(cmp),
      with_receipts: matched.filter((sid) => receiptSessions.has(sid)).sort(cmp),
    },
  };
}
