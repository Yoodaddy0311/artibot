/**
 * Bounded tail read over an append-only NDJSON stream.
 *
 * TWO ENTRY POINTS, ONE WINDOW:
 *   readNdjsonTail  — takes a FILE PATH. Any NDJSON stream: the host
 *                     transcript (`transcript_path`) as much as a ledger.
 *   readLedgerTail  — takes a PROJECT ROOT and resolves the ledger's location
 *                     through `ledger.js#ledgerFilePath` before delegating.
 * The second is a thin wrapper on the first, so a caller that knows its path
 * and a caller that knows only its project read byte-for-byte the same window.
 *
 * WHY THIS IS ITS OWN MODULE — the ledger grows without bound while every hook
 * that reads it runs on a spawn path and must not grow with it. That makes
 * "read only the last N bytes, and do not trust the first line you land on" a
 * rule two or more hooks need to obey IDENTICALLY. It was implemented once
 * inside `scripts/hooks/subagent-handler.js` for its receipt scan; a second copy
 * in a second hook would be a second answer to one question, and the day the
 * two copies disagree about where a window starts is the day one hook sees a
 * receipt the other does not. So the rule lives here and the hooks call it.
 *
 * WHAT THE WINDOW COSTS YOU — a window is a window: a line older than
 * `tailBytes` back is NOT returned, and a caller cannot tell "no such line"
 * from "fell out of the window". That is the intended trade (a bounded read),
 * not a loss to be recovered here. Callers that care must say so themselves —
 * `subagent-handler.js` records `skipped:unbound` rather than implying the
 * receipt never existed.
 *
 * WHY THE FIRST LINE IS DROPPED — a byte-offset read almost always lands
 * mid-line. Parsing that fragment either throws (caught, but then the tail is
 * lost to the catch) or, worse, succeeds on a truncated object and hands the
 * caller a line that was never written. Dropping it costs at most one line per
 * read and is the only way to be sure of the rest.
 *
 * NEVER THROWS — a missing, unreadable, or corrupt ledger yields `[]`. A read
 * hook that dies takes its spawn's bookkeeping with it, and no bookkeeping is
 * worth a failed spawn. Corrupt individual lines are skipped, not fatal: one
 * bad line must not erase the window around it.
 *
 * THIS MODULE DOES NOT WRITE. It has no append path and no state; the write
 * surface is `./ledger.js` / `./event-writer.js`.
 *
 * @module lib/runtime/ledger-tail
 */

import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import { ledgerFilePath } from './ledger.js';

/**
 * Default size of the tail window, in bytes.
 *
 * 128 KB is the design's stated bound for the receipt scan: 32 candidate lines
 * at the 4 KB per-line cap (`event-writer.js` enforces that cap, so the two
 * numbers are not independent guesses). Callers with a different budget pass
 * `tailBytes`; callers with no opinion inherit this one so that two hooks
 * reading "the tail" by default read the SAME tail.
 *
 * @type {number}
 */
export const DEFAULT_TAIL_BYTES = 131072;

/**
 * The last `tailBytes` of ANY newline-delimited JSON file, parsed, in append
 * order.
 *
 * Takes a FILE PATH, not a project: the ledger is only one NDJSON stream a
 * hook may have to tail — the host transcript (`transcript_path`) is another,
 * and it is not derivable from a project root. Splitting the path resolution
 * off ({@link readLedgerTail} does that one job) is what lets both callers
 * share the window arithmetic instead of copying it.
 *
 * A non-finite or non-positive `tailBytes` falls back to
 * {@link DEFAULT_TAIL_BYTES} rather than reading the whole file: an unbounded
 * read is the one outcome this module exists to prevent, so a nonsense budget
 * must not silently buy one. It is a silent substitution, not an error, because
 * the function's contract is that it never throws.
 *
 * @param {unknown} filePath absolute path to an NDJSON file; non-string yields `[]`
 * @param {{tailBytes?: number}} [opts]
 * @returns {object[]} Parsed lines in append order; `[]` when unreadable
 */
export function readNdjsonTail(filePath, { tailBytes = DEFAULT_TAIL_BYTES } = {}) {
  let fd = null;
  try {
    if (typeof filePath !== 'string' || filePath.length === 0) return [];
    const windowBytes = Number.isFinite(tailBytes) && tailBytes > 0
      ? tailBytes
      : DEFAULT_TAIL_BYTES;
    if (!existsSync(filePath)) return [];
    const size = statSync(filePath).size;
    const start = size > windowBytes ? size - windowBytes : 0;
    const length = size - start;
    if (length <= 0) return [];
    const buf = Buffer.alloc(length);
    fd = openSync(filePath, 'r');
    // DECODE THE BYTES THAT ARRIVED, NOT THE BYTES ASKED FOR. `readSync` may
    // return fewer than `length`, and the buffer's remainder is then still
    // zeroes. Decoding the whole buffer appends NUL characters to whatever the
    // last bytes were, and a NUL is NOT whitespace to `String.prototype.trim`,
    // so they glue onto the final record, break its JSON.parse, and drop a
    // record that had in fact been read in full. Measured red before this line
    // existed: a read stopping one byte short of a record's newline lost that
    // record (tests/runtime/ledger-tail.test.js, "does not lose the last
    // COMPLETE record"). Slicing to the returned count is the whole fix.
    //
    // AND THE TRAILING FRAGMENT IS NOT POPPED, deliberately. A short read can
    // stop mid-record, so the last element may be a fragment — but popping it
    // unconditionally would destroy the very record this slice just saved: a
    // read ending exactly at a record's last byte (newline not yet read) leaves
    // that COMPLETE record as the last element, and it is indistinguishable
    // from a fragment by position alone. JSON.parse is the discriminator
    // instead, and it is a sound one: a proper prefix of a valid JSON object
    // cannot itself parse as an object, because the closing brace is the last
    // character. Measured 2026-09-15 over 165 proper prefixes of 5 realistic
    // ledger lines — 3 parsed as objects, and all 3 were prefixes of a line
    // with TRAILING WHITESPACE, i.e. the whole record, correctly kept. Zero
    // prefixes that cut into record content survived.
    const bytesRead = readSync(fd, buf, 0, length, start);
    const raw = buf.subarray(0, bytesRead).toString('utf8').split('\n');
    if (start > 0) raw.shift();
    const out = [];
    for (const line of raw) {
      if (line.trim() === '') continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed === 'object') out.push(parsed);
      } catch { /* a corrupt line is skipped, not fatal */ }
    }
    return out;
  } catch {
    return [];
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* noop */ }
    }
  }
}

/**
 * The tail of a PROJECT'S ledger — {@link readNdjsonTail} over the one file
 * `ledger.js#ledgerFilePath` names for that project.
 *
 * Resolution is deliberately not the caller's job: the ledger's location is a
 * rule (git common dir, else the in-project fallback — ADR-011), and a caller
 * that spelled the path itself would be a second answer to where the ledger
 * lives. The resolution is inside the try because resolving reads config and
 * probes the filesystem, and this function's contract is that it never throws.
 *
 * @param {unknown} projectRoot absolute project root; non-string yields `[]`
 * @param {{tailBytes?: number}} [opts]
 * @returns {object[]} Parsed lines in append order; `[]` when unreadable
 */
export function readLedgerTail(projectRoot, opts = {}) {
  try {
    if (typeof projectRoot !== 'string' || projectRoot.length === 0) return [];
    return readNdjsonTail(ledgerFilePath(projectRoot), opts);
  } catch {
    return [];
  }
}
