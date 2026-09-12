/**
 * The Checkpoint Store's on-disk adapter — one JSONL file, append-only.
 *
 * ── Where the file lives, and why this module does not decide ─────────────
 * `dir` is INJECTED and never derived. The caller computes it with
 * `lib/project-state/store-location.js#resolveStoreLocation(...).dir`, which is
 * the one rule the project-state store and the runtime ledger already share, so
 * every store answers "where does this project's history live?" identically.
 * A checkpoint adapter that resolved its own location would be a second,
 * independently-drifting answer to that question — and, on a linked worktree,
 * an answer that puts each window's checkpoints in a different place. There is
 * therefore no location constant, no repository lookup and no subprocess in
 * this file. It receives a directory and writes in it.
 *
 * ── One record is one append (design §3.6, ADR-011's concurrency clause) ──
 * `appendFileSync(path, line, { flag: 'a' })`, once per record. Nothing here
 * ever reads the file before writing to it. That is the whole concurrency
 * design, and it is structural rather than a lock: `lib/core/decision-trail.js`
 * takes the read-modify-write shape instead and, measured 2026-08-28 across
 * processes, loses 21 of 60 records. `lib/runtime/event-writer.js` and
 * `lib/learning/ledger/spawn-ledger.js` are the two existing writers of this
 * form; `tests/checkpoint/file-store.test.js` re-runs the 3 x 20 experiment
 * against this one, and states in its header what that measurement does not
 * cover.
 *
 * ── No second artifact on disk (OD-4) ─────────────────────────────────────
 * OD-4 settles the store as "JSONL plus a derived snapshot, not SQLite". Here
 * the derived half costs nothing to keep in sync, because ONE LINE IS ALREADY A
 * WHOLE SNAPSHOT: a checkpoint record carries the complete state as of that
 * moment, not a patch against an earlier one. So this adapter persists no
 * snapshot file, and `checkpoint-store.js#latest` folds the record stream in
 * memory instead. A separate snapshot file would be a second thing that can
 * disagree with the journal, bought for a fold over a list whose length is one
 * mission's checkpoint count. If that fold ever becomes the bottleneck, the
 * answer is a cache keyed on file size, not a new file of record.
 *
 * ── Torn lines ────────────────────────────────────────────────────────────
 * A half-written tail is the expected shape of a crash during append, and
 * `lib/project-state/journal.js#readJournal` sets the precedent: report it,
 * never repair it in place, and never let it abort the read. Refusing to open a
 * store because its last line is incomplete turns a recoverable crash into an
 * unrecoverable one. `census()` is how the count gets out, because a reader
 * that drops lines and says nothing is indistinguishable from one that had
 * nothing to drop.
 *
 * ── Layer ─────────────────────────────────────────────────────────────────
 * L2. `node:fs` is called directly, which is the stated boundary for a module
 * that OWNS a store (eslint.config.js, L2 block comment): injected ports are
 * for upward calls, config and the clock, not for every effect.
 *
 * @module lib/checkpoint/adapters/file-store
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** Default file name under the injected directory. */
export const CHECKPOINT_FILE_NAME = 'checkpoints.jsonl';

/**
 * Parse a JSONL file, skipping every line that cannot be a record.
 *
 * Two kinds are skipped and both are counted as torn: a line that does not
 * parse (the crash tail), and a line that parses into something that is not a
 * record object — `null`, a number, a string, an array. The second kind matters
 * because `JSON.parse('null')` succeeds, and a null pushed into the record list
 * would reach the fold as a record with no fields.
 *
 * @param {string} file - Absolute path to the JSONL file.
 * @returns {{records: object[], torn: number, total: number, nonblank: number, exists: boolean}}
 *   Survivors and the counts that explain them.
 */
function scan(file) {
  if (!existsSync(file)) {
    return { records: [], torn: 0, total: 0, nonblank: 0, exists: false };
  }
  const lines = readFileSync(file, 'utf-8').split('\n');
  const records = [];
  let torn = 0;
  let nonblank = 0;
  for (const line of lines) {
    if (line.trim() === '') continue;
    nonblank += 1;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      torn += 1;
      continue;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      torn += 1;
      continue;
    }
    records.push(parsed);
  }
  return { records, torn, total: lines.length, nonblank, exists: true };
}

/**
 * Create the on-disk checkpoint adapter.
 *
 * @param {object} params - Construction inputs.
 * @param {string} params.dir - Store directory, resolved by the CALLER.
 * @param {string} [params.fileName] - File name under `dir`.
 * @returns {{append: (record: object) => void, readAll: () => object[], census: () => object, filePath: string}}
 *   An adapter matching the port `checkpoint-store.js` expects, plus a census.
 * @throws {TypeError} When `dir` is missing or empty.
 * @example
 * // dir comes from the caller's resolveStoreLocation(...) — see the header.
 * const adapter = createFileStoreAdapter({ dir });
 */
export function createFileStoreAdapter({ dir, fileName = CHECKPOINT_FILE_NAME } = {}) {
  if (typeof dir !== 'string' || dir === '') {
    throw new TypeError(
      'checkpoint file store: dir must be a non-empty path — the location is injected by the caller, never derived here',
    );
  }
  const file = path.join(dir, fileName);

  return {
    filePath: file,

    /**
     * Append one record as one line.
     *
     * `JSON.stringify` escapes any newline inside the record, so one record can
     * never become two lines. The directory is created on write rather than at
     * construction: constructing an adapter should not leave a directory behind
     * for a store nothing ever wrote to.
     *
     * @param {object} record - Envelope built by the store.
     * @returns {void}
     */
    append(record) {
      mkdirSync(dir, { recursive: true });
      appendFileSync(file, `${JSON.stringify(record)}\n`, { flag: 'a' });
    },

    /**
     * Every surviving record, oldest first.
     *
     * A missing file is an empty store, not an error — the first reader
     * normally arrives before the first writer.
     *
     * @returns {object[]} Records in file order.
     */
    readAll() {
      return scan(file).records;
    },

    /**
     * What the last read actually saw, including what it dropped.
     *
     * Reported rather than logged: a log line is not a notification path, and
     * the caller is the only place that can decide whether a torn tail matters.
     * The counted path is included so a census taken over some OTHER file
     * cannot be mistaken for this one's.
     *
     * @returns {{file: {path: string, exists: boolean}, lines: {total: number, nonblank: number},
     *   dropped: {torn: number}, survivors: number}} Read census.
     */
    census() {
      const { records, torn, total, nonblank, exists } = scan(file);
      return {
        file: { path: file, exists },
        lines: { total, nonblank },
        dropped: { torn },
        survivors: records.length,
      };
    },
  };
}
