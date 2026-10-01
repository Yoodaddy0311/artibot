/**
 * Bounded reverse read of an append-only NDJSON file — the ledger's tail.
 *
 * TWO SubagentStop paths read the ledger and must not grow with it: the reviewer
 * IDENTITY join (`./stop-identity.js`) and the review DEDUPE keys
 * (`./review-keys.js`). Both need "the newest lines, bounded, never a half line",
 * so the walk lives here once. The alternative that existed before was
 * `lib/runtime/ledger.js#readAllEvents` for the dedupe: a whole-file read and
 * parse, 204-453 ms over a 24.6 MB ledger and 4.1-5.9 s over a 20x copy (471 MiB;
 * the opus review of 0390e273 measured 5.3-6.0 s) — the whole 5,000 ms budget of
 * `hooks/dispatch-table.json`, and past it the handler is killed and its
 * `recordSpawn` is lost (5 of 5 killed runs, measured).
 *
 * WHAT A WALK IS. `scanLedgerTail` opens the file, takes the LAST `maxBytes`
 * (plus one byte of look-behind) and hands `onRun` runs of WHOLE lines, NEWEST
 * run first, until `onRun` answers true. What a chunk boundary splits is carried
 * as BYTES to the next older chunk, so a line is decoded only whole and a
 * multibyte character is never decoded half-read. The line the window edge cuts
 * is dropped, and the look-behind byte is what tells a cut line from a whole one.
 *
 * WHAT THE STATUS SAYS — and why a caller must read it. `exhausted` means every
 * byte of the window was offered: "no row for X in the window" is then a fact
 * about the window (not about the file, which may hold older lines). Every other
 * status means the walk ended for another reason and absence proves NOTHING:
 *   - `stopped`   `onRun` asked to stop;
 *   - `aborted`   a short read (the file shrank under the walk) or a line longer
 *                 than {@link MAX_CARRY_BYTES} with no newline (not a ledger);
 *   - `error`     the file could not be opened or read, or `onRun` threw;
 *   - `missing`   the file does not exist — complete, there is nothing to find.
 *
 * NEVER THROWS, never writes. L2: node built-ins only; the ledger PATH is the
 * caller's (`lib/runtime` is L5 and may not be imported here).
 *
 * @module lib/review/tail-scan
 */

import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

/**
 * Furthest back from the file's end a walk reads. 8 MiB is 1.6x the largest
 * distance measured between a spawn's `route.bound` row and its stop (4.97 MB over
 * 1,216 stops, ledger copy 2026-09-30) and the same bound
 * `lib/review/stop-transcript.js#TRANSCRIPT_TAIL_BYTES` puts on a transcript tail.
 * Share of those stops whose bind row lies inside a window of that size
 * (reviewer-ish / every stop): 128 KB 54% / 43%; 1 MiB 99% / 93%; 4 MiB
 * 100% / 99.7%; 8 MiB 100% / 100%.
 * @type {number}
 */
export const TAIL_SCAN_BYTES = 8 * 1024 * 1024;

/** Bytes per read; a line is ~330 B, so one chunk holds ~800 lines. @type {number} */
export const TAIL_SCAN_CHUNK_BYTES = 256 * 1024;

/**
 * A line longer than this with no newline in it is not a ledger (the writer caps
 * a line at 4 KB); the walk stops rather than concatenate it without bound.
 * @type {number}
 */
const MAX_CARRY_BYTES = 64 * 1024;

const NEWLINE = 0x0a;

/** @param {unknown} value @param {number} fallback @returns {number} a positive integer */
export const positiveInt = (value, fallback) => (
  Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
);

/**
 * Read exactly `buf.length` bytes at `position`, or as many as the file has.
 * @param {number} fd @param {Buffer} buf @param {number} position
 * @returns {number} bytes read
 */
function readFully(fd, buf, position) {
  let total = 0;
  while (total < buf.length) {
    const n = readSync(fd, buf, total, buf.length - total, position + total);
    if (n <= 0) break;
    total += n;
  }
  return total;
}

/**
 * Walk `[lowest, top)` of an open file from its END, `chunkBytes` at a time.
 * Lines after a region's first newline are whole; what precedes it is the tail
 * of a line that began in an older chunk — or, at the window's edge
 * (`lowest > 0`), a line the window cut, which is dropped.
 *
 * @param {number} fd open file descriptor
 * @param {{top: number, lowest: number, chunkBytes: number}} window byte range and chunk size
 * @param {{bytesRead: number}} io counter, updated as chunks are read
 * @param {(run: string) => boolean} onRun receives whole lines, oldest first; true stops the walk
 * @returns {'exhausted'|'stopped'|'aborted'} why the walk ended
 */
function walkBackwards(fd, { top, lowest, chunkBytes }, io, onRun) {
  let end = top;
  let carry = Buffer.alloc(0);
  while (end > lowest) {
    const start = Math.max(lowest, end - chunkBytes);
    const chunk = Buffer.allocUnsafe(end - start);
    if (readFully(fd, chunk, start) !== chunk.length) return 'aborted';
    io.bytesRead += chunk.length;
    const region = carry.length > 0 ? Buffer.concat([chunk, carry]) : chunk;
    const firstNl = region.indexOf(NEWLINE);
    // No newline at all in an interior region means the whole region is one partial line.
    const wholeFrom = start === 0 ? 0 : (firstNl < 0 ? region.length : firstNl + 1);
    carry = start === 0 ? Buffer.alloc(0) : region.subarray(0, firstNl < 0 ? region.length : firstNl);
    if (carry.length > MAX_CARRY_BYTES) return 'aborted';
    if (wholeFrom < region.length && onRun(region.subarray(wholeFrom).toString('utf8'))) return 'stopped';
    end = start;
  }
  return 'exhausted';
}

/**
 * Open `file` and walk its tail, handing whole-line runs (newest run first) to
 * `onRun` until it answers true. See the module header for what each returned
 * `status` does and does not prove. NEVER THROWS.
 *
 * @param {unknown} file absolute path; anything else is an `error`
 * @param {{maxBytes?: number, chunkBytes?: number, endOffset?: number}} [opts]
 *   caps, and `endOffset` — read as if the file ended there (replay and tests)
 * @param {(run: string) => boolean} onRun receives whole lines, oldest first; true stops the walk
 * @returns {{bytesRead: number, status: 'exhausted'|'stopped'|'aborted'|'error'|'missing'}}
 *   `bytesRead` is at most `maxBytes + 1`: the cap plus the one byte of look-behind
 */
export function scanLedgerTail(file, opts, onRun) {
  const io = { bytesRead: 0 };
  let fd = null;
  try {
    if (typeof file !== 'string' || file === '') return { bytesRead: 0, status: 'error' };
    fd = openSync(file, 'r');
    const stat = fstatSync(fd);
    // A directory or a device is not a ledger, and some platforms open one happily.
    if (!stat.isFile()) return { bytesRead: 0, status: 'error' };
    const size = stat.size;
    const top = Number.isFinite(opts?.endOffset) && opts.endOffset >= 0
      ? Math.min(size, Math.floor(opts.endOffset))
      : size;
    const floor = Math.max(0, top - positiveInt(opts?.maxBytes, TAIL_SCAN_BYTES));
    const status = walkBackwards(fd, {
      top,
      // One byte of look-behind: when it is a newline, the line at `floor` is whole.
      lowest: floor > 0 ? floor - 1 : 0,
      chunkBytes: positiveInt(opts?.chunkBytes, TAIL_SCAN_CHUNK_BYTES),
    }, io, onRun);
    return { bytesRead: io.bytesRead, status };
  } catch (err) {
    return { bytesRead: io.bytesRead, status: err?.code === 'ENOENT' ? 'missing' : 'error' };
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* noop */ }
    }
  }
}
