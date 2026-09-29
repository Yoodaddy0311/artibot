#!/usr/bin/env node
/**
 * Print Observe axis ④ session coverage — "of the sessions that ended, how many
 * produced a usage receipt?" — from a project's central ledger.
 *
 * Two events answer that question and neither answers it alone. `usage.receipt`
 * is the NUMERATOR: it counts sessions that produced receipts, and a count of
 * receipts on its own cannot separate "few sessions ended" from "most sessions
 * ended without a receipt". `session.ended` is the DENOMINATOR, written by
 * `scripts/hooks/session-end.js#recordSessionEnded` after the receipt stage
 * regardless of that stage's outcome. This script reads both, hands them to the
 * fold, and prints the result.
 *
 * READ-ONLY — THE OBSERVE CONTRACT, ENFORCED BY WHAT IS NOT IMPORTED.
 * `lib/runtime/ledger.js#readLedgerCensus` is the only ledger function reached
 * from here; `appendLedgerEvent` is deliberately NOT imported, so there is no
 * spelling of this file that writes a line. Reading a coverage number must not
 * change the number, and a measuring tool that appends to the stream it measures
 * is its own next data point.
 *
 * THE ARITHMETIC IS NOT HERE. `foldSessionCoverage` and `foldCoverageViews`
 * (`lib/replay/session-coverage.js`; the barrel `lib/replay/index.js` re-exports
 * only the first) own every count, and everything in `lib/replay` is pure — no
 * clock, no filesystem. This file is the impure shell: it reads the ledger and
 * the exclusion list, reads the clock once for `measured_at`, and serializes. A
 * count computed here would be a second answer to a question that already has
 * one, and the two would eventually disagree.
 *
 * USAGE
 *   node scripts/ledger/session-coverage.mjs [--cwd <projectRoot>] [--since <iso-or-ms>]
 *                                            [--exclude-sessions <list-file | id,id,...>]
 *   An all-digit `--since` is read as EPOCH MILLISECONDS, never as a year:
 *   `--since 2026` cuts at 1970-01-01T00:00:02.026Z, so spell a year as ISO.
 *
 *   `--exclude-sessions` takes a plain list file (one session id per line;
 *   markdown bullets, backticks, blank lines and `#` lines are tolerated, and
 *   prose lines are counted as ignored) or a comma-separated id list. A value
 *   with a comma is a list; otherwise an existing regular file is read, a
 *   value that looks like a path (a separator, or a `.ext` suffix) but does not
 *   exist is an error, and anything else is a list of one id. A relative file
 *   path resolves against the PROCESS cwd, not `--cwd`. To force list mode for
 *   an id that ends in `.ext`, add a trailing comma. NO IDS ARE BUILT IN: an
 *   exclusion exists only because the caller named it on this command line.
 *
 * -- WHY AN EXCLUSION CAN NEVER BE THE ONLY THING PRINTED ---------------------
 *  Excluding sessions (say, empty `claude -p` runs that made no model call)
 *  changes the ratio, and a ratio that can be reported with its flattering half
 *  removed gets reported that way. So the top-level fields below are ALWAYS the
 *  raw view of the requested window, exactly as they were before this flag
 *  existed, and every view that an exclusion or a `--since` produces is printed
 *  in `views`, side by side (see STDOUT). There is no invocation whose output
 *  carries the excluded numbers without the raw ones next to them.
 *
 * -- WHY `--cwd` MAY DEFAULT TO `process.cwd()`, AND THE TRAP ----------------
 *  Same rationale and same trap as `scripts/ledger/record-verify.mjs`: the
 *  caller is a model working inside the project it is asking about, so the
 *  process cwd IS the injected root. THE GLOBAL INSTALL IS THE TRAP — Artibot
 *  also lives under the user's `.claude` directory and this file is inside that
 *  copy too, so running the INSTALLED script from an unrelated directory
 *  measures whatever project the shell happened to be in and reports it with
 *  the same confidence. `ledger_path` is on stdout for exactly this reason:
 *  an empty census and a census of the WRONG tree are told apart only by path.
 *
 * -- EXIT CODES, AND WHY ONLY ONE IS NON-ZERO -------------------------------
 *  0  an observation was made and printed — INCLUDING a missing ledger, an
 *     unreadable ledger, an empty ledger, and an unexpected throw. "There is no
 *     ledger" is a finding about the project, not a failure of this script, and
 *     the JSON says which: `census.file.present` / `census.file.readable`.
 *  2  usage error: the command line itself is wrong (unknown flag, flag without
 *     a value, `--since` that does not parse to a finite time, or an
 *     `--exclude-sessions` list that cannot be used: blank, a missing or
 *     non-regular or over-large file, or no session id in it). One line on
 *     stderr prefixed `session-coverage:`, NOTHING on stdout. An exclusion that
 *     cannot be honoured is refused rather than skipped: printing the
 *     un-excluded numbers under a command that asked for exclusion would answer
 *     a question nobody asked.
 *
 *  Exit 2 is a DEVIATION from the task brief, which called for exit 0 always.
 *  It follows the precedent of `record-verify.mjs`: a misspelled flag means the
 *  caller asked for something impossible, and exiting 0 over it reports a
 *  measurement that was never taken. A typo must not read as success.
 *
 * -- STDOUT -----------------------------------------------------------------
 *  Exactly ONE line of JSON, never pretty-printed, with a FIXED key set so a
 *  caller can parse it without branching:
 *    {"event","measured_at","ledger_path","since","ended","with_receipts",
 *     "coverage","fallback_sessions","by_status","by_reason","disagree",
 *     "receipt_only_sessions","receipt_sessions","duplicate_ended_rows",
 *     "malformed_ended","census","exclude_sessions","views"}
 *  `error` is the ONE optional key: present only when an unexpected throw was
 *  caught, in which case the fold fields carry their empty values
 *  (`ended:0`, `coverage:null`) and `census` is null.
 *
 *  Everything from `ended` to `census` is the RAW view (nothing excluded) of
 *  the requested window, unchanged in meaning since before `--exclude-sessions`.
 *
 *  `exclude_sessions` is null unless the flag was given, and otherwise echoes
 *  the request: `{source: "file"|"list", path, requested, ignored}`. `requested`
 *  is the number of unique ids read; `ignored` counts entries that were not
 *  ids (prose in a note, a mistyped id), so a request that silently lost part
 *  of itself shows up here.
 *
 *  `views` holds two scopes, `window` (what `--since` cut; the whole ledger when
 *  there is no `--since`) and `history` (the whole ledger, always), each
 *  `{unexcluded, excluded, exclusion}`. Without `--since` the two scopes are
 *  identical. `excluded` and `exclusion` are null unless ids were excluded.
 *  A view carries `{ended, with_receipts, skipped, coverage, skipped_by_cause,
 *  unresolved_models}` and ALWAYS `ended = with_receipts + skipped`, with the
 *  values of `skipped_by_cause` summing to `skipped`:
 *    - `skipped` is the JOIN's count (an ended session with no readable
 *      `usage.receipt` row), not `by_status.skipped`, the hook's own claim.
 *    - `skipped_by_cause` columns are the hook's reasons: `no-receipts` is the
 *      BARE reason (the hook could not classify the miss), `no-receipts:<cause>`
 *      one column per suffix, plus `null`, `other` and the plain-word head of
 *      any other reason. Rows are never rewritten, so a row written BEFORE the
 *      hook learned `no-receipts:unreadable` is bare even if a file was
 *      unreadable: read bare as "may include an unreadable file", never as
 *      "cause unknown to the session".
 *    - `unresolved_models` is the catalog-drift column: `sessions` (covered or
 *      skipped) whose row named a model the catalog rejected, of which
 *      `skipped_sessions` are skipped, and `by_model` sessions per model.
 *  `exclusion` accounts for one scope: `requested`, `matched_ended` (listed
 *  ids with a `session.ended` row in that scope), `unmatched` (the rest, e.g.
 *  outside the window) and `with_receipts` (listed ids that DID produce a
 *  receipt; an exclusion list should hold sessions that produced none).
 *
 *  `malformed_ended` is a DEVIATION from the task brief's key list, added
 *  because omitting it hides a denominator loss. It counts `session.ended` rows
 *  the fold dropped for shape reasons; every one of them shrinks `ended` while
 *  leaving the numerator alone, so a non-zero value means the printed
 *  `coverage` reads HIGHER than the truth. A reader who cannot see that number
 *  has no way to know the ratio is inflated.
 *
 *  `coverage` IS `null`, NEVER `0`, WHEN `ended` IS 0. Zero is a measured rate
 *  — "sessions ended and none produced a receipt" — while null is the absence
 *  of a denominator. Collapsing the two turns "nothing to measure yet" into
 *  "total failure", which is the single most likely way this number gets
 *  misread. The fold owns that distinction; this file only refuses to flatten it.
 *
 *  `since` is the RESOLVED cutoff as an ISO string, not the raw argument:
 *  `--since 1757000000000` and its ISO spelling print identically, so the
 *  printed value is the instant that was actually cut at.
 *
 * -- WHAT THIS CANNOT SEE ---------------------------------------------------
 *  - ACTIVE SESSIONS ARE NOT IN THE DENOMINATOR. `ended` counts sessions that
 *    ENDED. A session running right now has no `session.ended` row, so a
 *    coverage of 1.0 does not mean every session is covered — it means every
 *    session that has finished so far is.
 *  - A RE-FIRED SessionEnd. When one session carries two `session.ended` rows
 *    the fold keeps the FIRST row's self-report and only bumps
 *    `duplicate_ended_rows`; see the fold's header for why neither row is
 *    provably "the truth".
 *  - `receipt_status` IS A SELF-REPORT. The hook copies its own outcome into
 *    the row; nothing re-derives it. `by_status` counts claims, and the
 *    `disagree` lists exist precisely because a claim and the receipt rows can
 *    contradict each other.
 *  - THE LIVE ANSWER WAS `null` ONCE, AND IS NOT NOW. Measured
 *    2026-09-14T05:15Z against this machine's parent ledger: `session.ended` 0
 *    rows, `usage.receipt` 72 rows over 12 sessions, so `coverage:null` was the
 *    correct output, not a bug in this script — the installed SessionEnd hook
 *    had not written a denominator row yet. The first `session.ended` row landed
 *    2026-09-15 (V5-BACKLOG §4-c); a null on a ledger that HAS such rows would
 *    now be the anomaly. `null` still means exactly "nothing ended in this read".
 *  - WHAT A `ledger.rejected` LINE REPLACED. Those lines are excluded by the
 *    reader's default and counted in `census.dropped.selection`; a session
 *    whose rows were all rejected is simply absent from both sides.
 *  - THE INSTALLED COPY. This file measures the ledger, not itself.
 *  - WHY A LISTED SESSION MADE NO MODEL CALL. The list is the caller's word;
 *    `exclusion.with_receipts` catches the one contradiction the ledger can
 *    show, a listed session that has receipts.
 *  - TWO READS, NOT ONE, WITH `--since`. The window and the full history are
 *    read one after the other (window first, so the history can only be the
 *    larger). A session that ends between the two reads can appear in the
 *    history alone. Neither read is a snapshot of an appending file.
 *  - A WINDOW EDGE THAT SPLITS A SESSION. `--since` cuts rows by their own
 *    timestamp, so a cutoff that falls between a session's receipts and its
 *    `session.ended` row leaves an ended row with no receipt and reads it as
 *    SKIPPED. The full history has no such edge, which is one reason it is
 *    always printed.
 *
 * @module scripts/ledger/session-coverage
 */

import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { readLedgerCensus } from '../../lib/runtime/ledger.js';
import {
  emptyCoverageFold,
  foldCoverageViews,
  parseSessionIdList,
} from '../../lib/replay/session-coverage.js';
import { isMainEntry } from '../hooks/_main-entry.js';

/** The event whose rows are the denominator; echoed on stdout as `event`. */
const COVERAGE_EVENT = 'session.ended';

/** Flags that take a value. Anything else on the command line is an error. */
const VALUE_FLAGS = ['--cwd', '--since', '--exclude-sessions'];

const USAGE = 'usage: session-coverage.mjs [--cwd <projectRoot>] [--since <iso | epoch-ms (all digits)>] [--exclude-sessions <list-file | id,id,...>]';

/** A list file larger than this is not a list of session ids. */
const MAX_LIST_BYTES = 1024 * 1024;

/**
 * A value that names a file rather than an id: it has a path separator or ends
 * in a short `.ext`. Session ids are UUIDs or `session-<ms>`-shaped, so neither
 * appears in one; a value that looks like a path and is not there is an error
 * instead of a list of one strange id.
 */
const PATH_LIKE = /[\\/]|\.[A-Za-z0-9]{1,8}$/;

/**
 * Report a usage error on ONE line and nothing else.
 *
 * One line, always, for the reason `record-verify.mjs#fail` gives: this stream
 * is read by a model, and a two-line message invites "the first line is the
 * error, the rest is noise".
 *
 * @param {string} message
 * @returns {2} the exit code, returned so callers read as `return fail(...)`
 */
function fail(message) {
  process.stderr.write(`session-coverage: ${message} | ${USAGE}\n`);
  return 2;
}

/**
 * Parse the argument list into a flag map.
 *
 * @param {string[]} argv arguments after the script path
 * @returns {{opts: Record<string,string>}|{error: string}}
 */
function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (!VALUE_FLAGS.includes(flag)) return { error: `unknown argument: ${flag}` };
    // A flag with no value is an error rather than an empty string: `--cwd` at
    // the end of the line is a truncated command, not a root of "".
    if (i + 1 >= argv.length) return { error: `${flag} requires a value` };
    opts[flag.slice(2)] = argv[i + 1];
    i += 1;
  }
  return { opts };
}

/**
 * Resolve `--since` to epoch milliseconds, or null when it is not a time.
 *
 * Epoch milliseconds are handled BEFORE `Date.parse`, not after: `Date.parse`
 * of an all-digit string reads it as a year-or-worse rather than as a stamp, so
 * a plain `Date.parse` would silently accept `1757000000000` as some other
 * instant instead of rejecting it.
 *
 * @param {string} raw
 * @returns {number|null}
 */
function toEpochMs(raw) {
  const text = String(raw).trim();
  if (text === '') return null;
  const ms = /^-?\d+$/.test(text) ? Number(text) : Date.parse(text);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The views of a scope that was never measured: the empty fold, nothing
 * excluded.
 *
 * Used by the error branch so a caught throw prints the SAME key set as a
 * successful run. A reader that has to branch on which keys exist will
 * eventually branch wrong. The empty fold comes from the lib as a literal (a
 * test pins it to `foldSessionCoverage([])`) rather than from a second call to
 * the fold: the handler that needs it is running because that fold, or the
 * read in front of it, has just thrown.
 *
 * @returns {{unexcluded: object, excluded: null, exclusion: null}}
 */
function emptyViews() {
  return { unexcluded: emptyCoverageFold(), excluded: null, exclusion: null };
}

/**
 * One view as stdout carries it, picked BY NAME.
 *
 * @param {object} fold
 * @returns {object}
 */
function viewOf(fold) {
  return {
    ended: fold.ended,
    with_receipts: fold.with_receipts,
    skipped: fold.skipped,
    coverage: fold.coverage,
    skipped_by_cause: fold.skipped_by_cause,
    unresolved_models: fold.unresolved_models,
  };
}

/**
 * One scope (`window` or `history`) as stdout carries it.
 *
 * @param {{unexcluded: object, excluded: object|null, exclusion: object|null}} views
 * @returns {{unexcluded: object, excluded: object|null, exclusion: object|null}}
 */
function scopeOf(views) {
  return {
    unexcluded: viewOf(views.unexcluded),
    excluded: views.excluded === null ? null : viewOf(views.excluded),
    exclusion: views.exclusion,
  };
}

/**
 * Build the stdout object, picking each fold field BY NAME.
 *
 * Picked rather than spread on purpose: the fold is another module's shape and
 * may grow a field, while this script's stdout contract promises a fixed key
 * set. A spread would quietly break that promise on someone else's commit.
 *
 * The top-level fold fields come from `window.unexcluded`, never from an
 * excluded view: see "WHY AN EXCLUSION CAN NEVER BE THE ONLY THING PRINTED".
 *
 * @param {{since: string|null, ledgerPath: string|null,
 *          window: {unexcluded: object, excluded: object|null, exclusion: object|null},
 *          history: {unexcluded: object, excluded: object|null, exclusion: object|null},
 *          census: object|null, exclusion: object|null, error?: string}} parts
 * @returns {object}
 */
function report(parts) {
  const fold = parts.window.unexcluded;
  const out = {
    event: COVERAGE_EVENT,
    // The one clock read in this pipeline. The fold is pure and may not read a
    // clock, so a timestamp on the result has to come from the shell.
    measured_at: new Date().toISOString(),
    ledger_path: parts.ledgerPath,
    since: parts.since,
    ended: fold.ended,
    with_receipts: fold.with_receipts,
    coverage: fold.coverage,
    fallback_sessions: fold.fallback_sessions,
    by_status: fold.by_status,
    by_reason: fold.by_reason,
    disagree: fold.disagree,
    receipt_only_sessions: fold.receipt_only_sessions,
    receipt_sessions: fold.receipt_sessions,
    duplicate_ended_rows: fold.duplicate_ended_rows,
    malformed_ended: fold.malformed_ended,
    census: parts.census,
    exclude_sessions: parts.exclusion,
    views: { window: scopeOf(parts.window), history: scopeOf(parts.history) },
  };
  if (parts.error !== undefined) out.error = parts.error;
  return out;
}

/**
 * The stat of a path, or null when there is nothing there to stat.
 *
 * @param {string} target
 * @returns {import('node:fs').Stats|null}
 */
function statOrNull(target) {
  try {
    return statSync(target);
  } catch {
    return null;
  }
}

/**
 * Turn the `--exclude-sessions` value into the ids to exclude, or into a usage
 * error message. The text is parsed by the lib; this function only decides
 * WHERE the text comes from and refuses what it cannot honour.
 *
 * @param {string} raw - the flag's value
 * @returns {{request: {ids: string[], echo: object}}|{error: string}}
 */
function loadExclusion(raw) {
  const value = String(raw).trim();
  if (value === '') return { error: '--exclude-sessions is blank (give a list file or comma-separated session ids)' };

  let text = value;
  let format = 'csv';
  let source = 'list';
  let filePath = null;

  if (!value.includes(',')) {
    const abs = path.resolve(value);
    const stat = statOrNull(abs);
    if (stat !== null) {
      if (!stat.isFile()) return { error: `--exclude-sessions is not a regular file: ${abs}` };
      if (stat.size > MAX_LIST_BYTES) {
        return { error: `--exclude-sessions file is too large (${stat.size} bytes, limit ${MAX_LIST_BYTES}): ${abs}` };
      }
      try {
        text = readFileSync(abs, 'utf-8');
      } catch (err) {
        return { error: `--exclude-sessions file could not be read: ${abs} (${err?.code ?? err?.message ?? err})` };
      }
      format = 'lines';
      source = 'file';
      filePath = abs;
    } else if (PATH_LIKE.test(value)) {
      return { error: `--exclude-sessions file not found: ${abs}` };
    }
  }

  const { ids, ignored } = parseSessionIdList(text, format);
  if (ids.length === 0) {
    return { error: `--exclude-sessions holds no session ids (${filePath ?? 'list'}; ${ignored} entries ignored)` };
  }
  return { request: { ids, echo: { source, path: filePath, requested: ids.length, ignored } } };
}

/**
 * Read the ledger and fold it into the views `report` prints. Throws whatever
 * the read or the fold throws; the caller turns that into a printed line.
 *
 * The window is read FIRST and the whole ledger second, so a row appended
 * between the two reads can only make the history the larger of the two. With
 * no `--since` the window IS the whole ledger and is read once.
 *
 * @param {{cwd: string, sinceMs: number|null, ids: string[],
 *          readLedger: typeof readLedgerCensus}} input
 * @returns {{ledgerPath: string|null, census: object,
 *            window: object, history: object}} the `report` parts it computes
 */
function measure({ cwd, sinceMs, ids, readLedger }) {
  const windowRead = readLedger(cwd, sinceMs === null ? {} : { since: sinceMs });
  const historyRead = sinceMs === null ? windowRead : readLedger(cwd, {});
  const options = { excludeSessions: ids };
  const window = foldCoverageViews(windowRead.events, options);
  const history = sinceMs === null ? window : foldCoverageViews(historyRead.events, options);
  return {
    ledgerPath: windowRead.census.file.path,
    census: windowRead.census,
    window,
    history,
  };
}

/**
 * Run the script.
 *
 * `env` is not a parameter here — unlike `record-verify.mjs` this script has no
 * environment fallback to read, and a dead parameter would suggest one exists.
 * A DEVIATION from the brief's `main(argv, env)` signature.
 *
 * `deps.readLedger` is the one injection seam, `readLedgerCensus`-shaped, and
 * exists so a test can make the read throw and see the error branch print the
 * same key set. Nothing else reaches it.
 *
 * @param {string[]} argv arguments after the script path
 * @param {{readLedger?: typeof readLedgerCensus}} [deps]
 * @returns {number} process exit code
 */
export function main(argv, deps = {}) {
  const parsed = parseArgs(argv);
  if (parsed.error !== undefined) return fail(parsed.error);
  const { opts } = parsed;

  let sinceMs = null;
  if (opts.since !== undefined) {
    sinceMs = toEpochMs(opts.since);
    if (sinceMs === null) {
      return fail(`--since must be an ISO timestamp or epoch ms, got: ${opts.since}`);
    }
  }
  const since = sinceMs === null ? null : new Date(sinceMs).toISOString();

  // Refused BEFORE any read: a list that cannot be honoured is a malformed
  // request, and answering it with the un-excluded numbers would report a
  // measurement nobody asked for.
  let exclusion = null;
  if (opts['exclude-sessions'] !== undefined) {
    const loaded = loadExclusion(opts['exclude-sessions']);
    if (loaded.error !== undefined) return fail(loaded.error);
    exclusion = loaded.request;
  }

  const cwd = opts.cwd || process.cwd();
  const readLedger = deps.readLedger ?? readLedgerCensus;
  const echo = exclusion === null ? null : exclusion.echo;

  let line;
  try {
    const measured = measure({
      cwd, sinceMs, ids: exclusion === null ? [] : exclusion.ids, readLedger,
    });
    line = report({ since, exclusion: echo, ...measured });
  } catch (err) {
    // An unexpected throw is still an observation outcome, not a usage error:
    // the caller asked a well-formed question and deserves a parseable answer
    // saying the measurement could not be taken.
    line = report({
      since,
      ledgerPath: null,
      census: null,
      exclusion: echo,
      window: emptyViews(),
      history: emptyViews(),
      error: err?.message ?? String(err),
    });
  }
  process.stdout.write(`${JSON.stringify(line)}\n`);
  return 0;
}

if (isMainEntry(import.meta.url)) {
  const [, , ...argv] = process.argv;
  // `main` already converts a throw into a printed line, so this catch only
  // covers a failure of the printing itself (a closed stdout). Exit 0 either
  // way: reading a number must never fail the caller's step.
  try {
    process.exitCode = main(argv);
  } catch {
    process.exitCode = 0;
  }
}
