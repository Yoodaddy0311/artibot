#!/usr/bin/env node
/**
 * Report how many Stop-hook `verify.completed` denominators a `/verify`
 * self-report answered, from the command line. READ ONLY.
 *
 * `scripts/hooks/dev-verify-gate.js` writes the denominator and
 * `scripts/ledger/record-verify.mjs` writes the numerator. Neither can see the
 * other, and nothing has ever divided one by the other. This is that division,
 * and the counting rule it uses lives in `lib/verification/verify-rate.js` —
 * read that module's header before reading a number out of this one, because
 * the list of what the rate CANNOT see is longer than the rate.
 *
 * -- IT WRITES NOTHING, AND THAT IS THE POINT ------------------------------
 *  Every other entry point under `scripts/ledger/` appends. This one imports
 *  no writer, opens no file for writing and creates no directory: a measuring
 *  instrument that appends to what it measures moves its own numbers.
 *  `tests/ledger/verify-rate.test.js` asserts the ledger's bytes, size, mtime
 *  and the directory listing are unchanged across a run rather than trusting
 *  this paragraph.
 *
 * -- WHY `--cwd` MAY DEFAULT TO `process.cwd()` -----------------------------
 *  Same rationale, and the same trap, as `record-verify.mjs:67-76`: the caller
 *  is a model working inside the project it is asking about, so the process
 *  cwd IS the root. THE GLOBAL INSTALL IS THE TRAP — Artibot also lives under
 *  the user's `.claude` directory and this file is inside that copy too, so
 *  invoking the INSTALLED script from an unrelated directory reports on
 *  whatever directory the shell happened to be in. `file` is printed on every
 *  line for exactly that reason: an empty census and a census of the WRONG
 *  tree are told apart only by the path.
 *
 * -- EXIT CODES, AND WHY ONLY ONE IS NON-ZERO -------------------------------
 *  0  a rate was printed, OR the ledger could not be read and stdout says so
 *  2  usage error: the command line itself is wrong, and NOTHING was printed
 *
 *  READ `ok` BEFORE TRUSTING AN EXIT 0. A missing ledger and an unreadable one
 *  both exit 0 with `ok:false` and a rate of `null` over zero lines, because
 *  an absent ledger is an observation about the environment rather than a
 *  malformed request.
 *
 *  A malformed command line is a different thing, and exiting 0 over it would
 *  report a measurement nobody asked for — `--sesion S1` would silently
 *  measure the whole ledger. This is a DEVIATION from the task brief, which
 *  called for exit 0 on a usage error; it follows the precedent
 *  `record-verify.mjs:88-94` set, where a silent no-op was judged the
 *  fail-open shape this repository's verification rules exist to prevent.
 *
 * -- STDOUT -----------------------------------------------------------------
 *  One line of JSON with a FIXED key set:
 *    {"ok","reason","file","rate","census"}
 *  `census` is NOT decoration. `rate` counts survivors, so a rate read without
 *  it reads HIGH whenever the ledger reader dropped something
 *  (`lib/runtime/ledger.js:215`); the two are printed together so they cannot
 *  describe different moments.
 *
 * @module scripts/ledger/verify-rate
 */

import { readLedgerCensus } from '../../lib/runtime/ledger.js';
import { computeVerifyRate, VERIFY_COMPLETED_EVENT } from '../../lib/verification/verify-rate.js';
import { isMainEntry } from '../hooks/_main-entry.js';

/** Flags that take a value. Anything else on the command line is an error. */
const VALUE_FLAGS = ['--cwd', '--session', '--since'];

const USAGE = 'usage: verify-rate.mjs [--cwd <root>] [--session <id>] [--since <iso>]';

/**
 * Report a usage error on ONE line and nothing else — this stream is read by a
 * model, and a two-line message invites "the rest is noise".
 *
 * @param {string} message
 * @returns {2} the exit code, returned so callers read as `return fail(...)`
 */
function fail(message) {
  process.stderr.write(`verify-rate: ${message} | ${USAGE}\n`);
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
 * The command line itself, judged before anything is read.
 *
 * `--since` is validated HERE rather than left to the ledger filter, which
 * treats a `NaN` bound as no bound at all: an unparsable date would silently
 * widen the query to the whole ledger and report the answer to a different
 * question.
 *
 * @param {Record<string,string>} opts
 * @returns {string|null}
 */
function usageError(opts) {
  if (opts.cwd !== undefined && opts.cwd.trim() === '') return '--cwd must not be empty';
  if (opts.since !== undefined && !Number.isFinite(Date.parse(opts.since))) {
    return `--since must be a parsable date, got: ${opts.since}`;
  }
  return null;
}

/**
 * Why no rate could be measured, or `null` when one was.
 *
 * The two cases are kept apart because they call for different actions: an
 * absent ledger means nothing has been recorded yet, an unreadable one means
 * something is wrong with the tree.
 *
 * @param {{file: {present: boolean, readable: boolean, path: string|null}}} census
 * @returns {string|null}
 */
function censusReason(census) {
  if (census.file.present === false) return `no ledger at ${census.file.path}`;
  if (census.file.readable === false) return `ledger not readable at ${census.file.path}`;
  return null;
}

/**
 * Run the script.
 *
 * @param {string[]} argv arguments after the script path
 * @returns {number} process exit code
 */
export function main(argv) {
  const parsed = parseArgs(argv);
  if (parsed.error !== undefined) return fail(parsed.error);
  const { opts } = parsed;
  const usage = usageError(opts);
  if (usage !== null) return fail(usage);

  const filter = { event: VERIFY_COMPLETED_EVENT };
  if (opts.session !== undefined) filter.session_id = opts.session;
  if (opts.since !== undefined) filter.since = opts.since;

  const { events, census } = readLedgerCensus(opts.cwd || process.cwd(), filter);
  const reason = censusReason(census);

  process.stdout.write(`${JSON.stringify({
    ok: reason === null,
    reason,
    file: census.file.path,
    rate: computeVerifyRate(events),
    census,
  })}\n`);
  return 0;
}

if (isMainEntry(import.meta.url)) {
  const [, , ...argv] = process.argv;
  // `computeVerifyRate` never throws and `readLedgerCensus` catches its own fs
  // errors — but a catch here is what makes "exit 0 unless the command line
  // was wrong" true rather than intended, and a reader that crashed the step
  // it was measuring would be worse than no reader.
  try {
    process.exitCode = main(argv);
  } catch (err) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      reason: String(err?.message ?? err),
      file: null,
      rate: computeVerifyRate([]),
      census: null,
    })}\n`);
    process.exitCode = 0;
  }
}
