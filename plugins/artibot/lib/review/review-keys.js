/**
 * The review idempotency keys already in the ledger — a BOUNDED read, for dedupe.
 *
 * THE PROBLEM THIS REPLACES. `recordReviewFromStop` hands the verdict writer an
 * `existingKeys` port so that a REDELIVERED stop dedupes instead of inflating the
 * §4.1 denominator with a second copy of one verdict. That port was
 * `lib/runtime/ledger.js#readAllEvents`: a whole-file read and parse. Measured
 * 2026-09-30/10-01 over a 24.6 MB / 62k-line ledger copy it cost 204-453 ms, and it
 * scales with the ledger — over a 20x copy (471 MiB) it took 4.1-5.9 s (the opus
 * review of 0390e273: 5.3-6.0 s), the whole 5,000 ms budget
 * `hooks/dispatch-table.json` gives the SubagentStop handler; past it the handler is
 * killed and its own `recordSpawn` is lost (5 of 5 killed runs, measured). It was
 * paid by no stop until the identity fix (SH-05) let named reviewers reach this
 * path; it is paid by every one of them now.
 *
 * WHAT IT READS INSTEAD. The keys of `review.completed` / `review.claim_audit`
 * rows, from the LAST {@link TAIL_SCAN_BYTES} of the ledger (`./tail-scan.js`):
 * a native `indexOf` for the two literal event keys, and a `JSON.parse` only of
 * the lines that hold one. The keys the review path builds are namespaced by event
 * (`review.completed:<session>:<verification_id>`,
 * `review.claim_audit:<session>:<type>:<digest>` — `verdict-writer.js`), so rows of
 * any other event cannot collide and are not needed. The cost is flat in the
 * ledger's size: 18-26 ms at 1x and 17-19 ms at 20x (p50, in-process).
 *
 * THE RECORDED GAP. A redelivery older than the window is NOT deduped and writes a
 * second row. The window is 8 MiB of ledger growth — 1.6x the longest bind-to-stop
 * distance measured (4.97 MB), about 23 hours at the 2026-09-30 average rate of
 * 5.9 KiB/min and a couple of hours in a busy burst. The old read had no such
 * edge; it had the budget failure instead, and a lost spawn record is the worse
 * trade. `tests/hooks/_review-stop-dedupe-tail.test.js` pins both sides.
 *
 * `complete` IS THE CALLER'S SAFETY. It is false when the walk ended for a reason
 * other than reaching the window's edge (a short read, an unreadable file, the row
 * budget): keys may then be MISSING, and the verdict writer's own rule is that a
 * line not written beats a duplicated one, so the hook turns `!complete` into a
 * throwing port (`review=rejected:port-threw:existingKeys`). A ledger that does
 * not exist is complete — there is nothing to duplicate.
 *
 * NEVER THROWS, never writes. L2: node built-ins only; the ledger PATH is the
 * caller's (`lib/runtime` is L5 and may not be imported here).
 *
 * @module lib/review/review-keys
 */

import { positiveInt, scanLedgerTail } from './tail-scan.js';

/** Most review rows one read will parse before it calls itself incomplete. @type {number} */
export const REVIEW_KEYS_MAX_ROWS = 4096;

/** The literal event keys the writer emits (compact JSON). */
const REVIEW_EVENT_MARKERS = Object.freeze(['"event":"review.completed"', '"event":"review.claim_audit"']);
const REVIEW_EVENTS = Object.freeze(['review.completed', 'review.claim_audit']);

/**
 * Collect the `idempotency_key` of every review row of `sessionId` in one decoded
 * run of whole lines. Rows of other events that merely CONTAIN a marker (a
 * `ledger.rejected` row quoting the event it refused) parse and are skipped.
 *
 * @param {string} run whole lines, oldest first
 * @param {string} sessionId the session the keys must belong to
 * @param {Set<string>} keys collected keys (mutated)
 * @param {{rows: number}} budget parse counter (mutated)
 * @param {number} maxRows parse budget
 * @returns {boolean} true when the budget is spent and the walk must stop
 */
function collectKeys(run, sessionId, keys, budget, maxRows) {
  for (const marker of REVIEW_EVENT_MARKERS) {
    let at = run.indexOf(marker);
    while (at >= 0) {
      const start = run.lastIndexOf('\n', at) + 1;
      const nl = run.indexOf('\n', at);
      const end = nl < 0 ? run.length : nl;
      budget.rows += 1;
      if (budget.rows > maxRows) return true;
      try {
        const row = JSON.parse(run.slice(start, end));
        if (REVIEW_EVENTS.includes(row?.event) && row.session_id === sessionId
          && typeof row.idempotency_key === 'string' && row.idempotency_key !== '') {
          keys.add(row.idempotency_key);
        }
      } catch { /* a torn or corrupt line names no key */ }
      at = run.indexOf(marker, end);
    }
  }
  return false;
}

/**
 * The review idempotency keys of one session found in the ledger's tail.
 *
 * @param {unknown} ledgerPath absolute ledger file path
 * @param {unknown} sessionId envelope `session_id` the keys must belong to
 * @param {{maxBytes?: number, chunkBytes?: number, maxRows?: number, endOffset?: number}} [opts]
 *   caps, and `endOffset` — read as if the file ended there (tests)
 * @returns {{keys: string[], bytesRead: number, rows: number, complete: boolean}}
 *   `complete` is false when keys may be missing for any reason but the window's edge
 */
export function readReviewKeysTail(ledgerPath, sessionId, opts = {}) {
  const keys = new Set();
  const budget = { rows: 0 };
  const maxRows = positiveInt(opts.maxRows, REVIEW_KEYS_MAX_ROWS);
  if (typeof sessionId !== 'string' || sessionId === '') {
    return { keys: [], bytesRead: 0, rows: 0, complete: false };
  }
  const scan = scanLedgerTail(ledgerPath, opts, (run) => collectKeys(run, sessionId, keys, budget, maxRows));
  const complete = budget.rows <= maxRows && (scan.status === 'exhausted' || scan.status === 'missing');
  return { keys: [...keys], bytesRead: scan.bytesRead, rows: Math.min(budget.rows, maxRows), complete };
}
