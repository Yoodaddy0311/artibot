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
 * THE ARITHMETIC IS NOT HERE. `foldSessionCoverage` (`lib/replay/session-coverage.js`,
 * re-exported from `lib/replay/index.js`) owns every count, and everything in
 * `lib/replay` is pure — no clock, no filesystem. This file is the impure shell:
 * it reads the file, reads the clock once for `measured_at`, and serializes. A
 * count computed here would be a second answer to a question that already has
 * one, and the two would eventually disagree.
 *
 * USAGE
 *   node scripts/ledger/session-coverage.mjs [--cwd <projectRoot>] [--since <iso-or-ms>]
 *   An all-digit `--since` is read as EPOCH MILLISECONDS, never as a year:
 *   `--since 2026` cuts at 1970-01-01T00:00:02.026Z, so spell a year as ISO.
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
 *     a value, `--since` that does not parse to a finite time). One line on
 *     stderr prefixed `session-coverage:`, NOTHING on stdout.
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
 *     "malformed_ended","census"}
 *  `error` is the ONE optional key: present only when an unexpected throw was
 *  caught, in which case the fold fields carry their empty values
 *  (`ended:0`, `coverage:null`) and `census` is null.
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
 *  - THE LIVE ANSWER TODAY IS `null`. Measured 2026-09-14T05:15Z against this
 *    machine's parent ledger: `session.ended` 0 rows, `usage.receipt` 72 rows
 *    over 12 sessions. So every ended session is invisible and `coverage:null`
 *    is the correct output, not a bug in this script — the installed SessionEnd
 *    hook has not written a denominator row yet. A non-null number here means
 *    the hook started firing; that is the signal to watch for.
 *  - WHAT A `ledger.rejected` LINE REPLACED. Those lines are excluded by the
 *    reader's default and counted in `census.dropped.selection`; a session
 *    whose rows were all rejected is simply absent from both sides.
 *  - THE INSTALLED COPY. This file measures the ledger, not itself.
 *
 * @module scripts/ledger/session-coverage
 */

import { readLedgerCensus } from '../../lib/runtime/ledger.js';
import { foldSessionCoverage } from '../../lib/replay/index.js';
import { isMainEntry } from '../hooks/_main-entry.js';

/** The event whose rows are the denominator; echoed on stdout as `event`. */
const COVERAGE_EVENT = 'session.ended';

/** Flags that take a value. Anything else on the command line is an error. */
const VALUE_FLAGS = ['--cwd', '--since'];

const USAGE = 'usage: session-coverage.mjs [--cwd <projectRoot>] [--since <iso | epoch-ms (all digits)>]';

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
 * The fold's fields at their empty values.
 *
 * Used by the error branch so a caught throw prints the SAME key set as a
 * successful run. A reader that has to branch on which keys exist will
 * eventually branch wrong.
 *
 * @returns {object}
 */
function emptyFold() {
  return {
    ended: 0,
    with_receipts: 0,
    coverage: null,
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
 * Build the stdout object, picking each fold field BY NAME.
 *
 * Picked rather than spread on purpose: the fold is another module's shape and
 * may grow a field, while this script's stdout contract promises a fixed key
 * set. A spread would quietly break that promise on someone else's commit.
 *
 * @param {{since: string|null, ledgerPath: string|null, fold: object,
 *          census: object|null, error?: string}} parts
 * @returns {object}
 */
function report(parts) {
  const { fold } = parts;
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
  };
  if (parts.error !== undefined) out.error = parts.error;
  return out;
}

/**
 * Run the script.
 *
 * `env` is not a parameter here — unlike `record-verify.mjs` this script has no
 * environment fallback to read, and a dead parameter would suggest one exists.
 * A DEVIATION from the brief's `main(argv, env)` signature.
 *
 * @param {string[]} argv arguments after the script path
 * @returns {number} process exit code
 */
export function main(argv) {
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
  const cwd = opts.cwd || process.cwd();

  let line;
  try {
    const { events, census } = readLedgerCensus(cwd, sinceMs === null ? {} : { since: sinceMs });
    line = report({ since, ledgerPath: census.file.path, fold: foldSessionCoverage(events), census });
  } catch (err) {
    // An unexpected throw is still an observation outcome, not a usage error:
    // the caller asked a well-formed question and deserves a parseable answer
    // saying the measurement could not be taken.
    line = report({
      since,
      ledgerPath: null,
      fold: emptyFold(),
      census: null,
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
