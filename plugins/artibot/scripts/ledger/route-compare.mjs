#!/usr/bin/env node
/**
 * Print the spawn-outcome comparison — "for each agent that spawned, which
 * model did the router RECOMMEND, and which model actually served it?" — from
 * a project's central ledger.
 *
 * Two events answer that question and neither answers it alone. `route.bound`
 * is the RECOMMENDATION side: written at SubagentStart, it is the only row that
 * carries an `agent_id` beside the model the router asked for. `usage.receipt`
 * is the SERVED side: built from the transcript after the fact, it is the only
 * row that says which model actually billed. A count of receipts cannot
 * separate "the router was obeyed" from "few agents spawned", and a count of
 * binds cannot separate "the recommendation was honoured" from "nobody
 * checked". This script reads both, hands them to the join, and prints it.
 *
 * READ-ONLY — ENFORCED BY WHAT IS NOT IMPORTED.
 * `lib/runtime/ledger.js#readLedgerCensus` is the only ledger function reached
 * from here; the ledger's append function is deliberately NOT imported, so
 * there is no spelling of this file that adds a line. Reading an agreement rate
 * must not change the rate, and a measuring tool that appends to the stream it
 * measures is its own next data point.
 *
 * THE ARITHMETIC IS NOT HERE. `joinSpawnOutcomes` (`lib/replay/spawn-outcome.js`,
 * re-exported from `lib/replay/index.js`) owns every count, and everything in
 * `lib/replay` is pure — no clock, no filesystem. This file is the impure shell:
 * it reads the file, reads the clock once for `measured_at`, and serializes. A
 * count computed here would be a second answer to a question that already has
 * one, and the two would eventually disagree.
 *
 * USAGE
 *   node scripts/ledger/route-compare.mjs [--cwd <projectRoot>] [--since <iso-or-ms>]
 *   An all-digit `--since` is read as EPOCH MILLISECONDS, never as a year:
 *   `--since 2026` cuts at 1970-01-01T00:00:02.026Z, so spell a year as ISO.
 *
 * -- WHY `--cwd` MAY DEFAULT TO `process.cwd()`, AND THE TRAP ----------------
 *  Same rationale and same trap as `scripts/ledger/session-coverage.mjs`: the
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
 *     stderr prefixed `route-compare:`, NOTHING on stdout.
 *
 *  Exit 2 follows the precedent of `session-coverage.mjs`: a misspelled flag
 *  means the caller asked for something impossible, and exiting 0 over it
 *  reports a measurement that was never taken. A typo must not read as success.
 *
 * -- STDOUT -----------------------------------------------------------------
 *  Exactly ONE line of JSON, never pretty-printed, with a FIXED key set in a
 *  FIXED order so a caller can parse it without branching. `error` is the ONE
 *  optional key: present only when an unexpected throw was caught, in which
 *  case the join's fields carry their empty values and `census` is null.
 *
 *  `agreement_rate` IS `null`, NEVER `0`, WHEN `compared` IS 0. Zero is a
 *  measured rate — "pairs were compared and every one diverged" — while null is
 *  the absence of a denominator. Collapsing the two turns "nothing to compare
 *  yet" into "the router is never obeyed", which is the single most likely way
 *  this number gets misread. The join owns that distinction; this file only
 *  refuses to flatten it.
 *
 *  THE SAME RULE GOVERNS EVERY SUM. `cost.same.total`, `cost.diverged.total`
 *  and `latency.{same,diverged}.total_ms` are `null`, never `0`, when their
 *  population (`priced` / `count`) is 0. A sum over zero rows is unmeasured,
 *  and a 0 reads as a measured floor: the live run at 2026-09-21T01:31:59Z
 *  printed a diverged cost total of 0 while every diverged pair was UNPRICED,
 *  which says "these divergences were free" instead of "nobody priced them".
 *  `cost.compared` counts the PRICED compared pairs, so it is a denominator for
 *  the totals beside it and is NOT the same number as the top-level `compared`;
 *  the difference between the two is `cost.unpriced`.
 *
 *  `since` is the RESOLVED cutoff as an ISO string, not the raw argument, so
 *  `--since 1757000000000` and its ISO spelling print identically.
 *
 *  `pairs` is printed AS-IS, agent ids included. This tool is local and its
 *  reader is the operator of the project being measured; an aggregate with no
 *  way back to the individual spawn cannot be checked against the ledger it
 *  came from.
 *
 * -- WHAT THIS CANNOT SEE ---------------------------------------------------
 *  - A SPAWN WITH NO RECEIPT YET. Receipts are built at session end, so an
 *    agent running right now is an `unjoined_binds` entry, not a divergence.
 *  - WHETHER A FIFO PAIR IS THE RIGHT PAIR. A `fifo` bind matched on ordering
 *    alone. Those pairs are counted in `excluded_fifo` and kept OUT of
 *    `compared`, because a divergence reported off a guessed pairing is
 *    indistinguishable from one that happened.
 *  - WHETHER `recommended_model` IS THE ROUTER'S REAL ANSWER. It is a
 *    self-report copied onto the bind by the hook; nothing re-derives it.
 *  - WHY a divergence happened. `divergence` says which recommendation was not
 *    honoured, never whether a fallback, a hard cap or an outage caused it.
 *  - A QUALITY VERDICT. `score` is fixed at null with the reason
 *    `no-spawn-keyed-score-writer`: no writer keys a quality score by spawn, so
 *    "the cheaper model was served" cannot be read here as "and it was worse".
 *  - WHAT A `ledger.rejected` LINE REPLACED. Those lines are excluded by the
 *    reader's default and counted in `census.dropped.selection`.
 *  - THE INSTALLED COPY. This file measures the ledger, not itself.
 *
 * @module scripts/ledger/route-compare
 */

import { readLedgerCensus } from '../../lib/runtime/ledger.js';
import { joinSpawnOutcomes, SPAWN_OUTCOME_EVENTS } from '../../lib/replay/index.js';
import { isMainEntry } from '../hooks/_main-entry.js';

/** Flags that take a value. Anything else on the command line is an error. */
const VALUE_FLAGS = ['--cwd', '--since'];

const USAGE = 'usage: route-compare.mjs [--cwd <projectRoot>] [--since <iso | epoch-ms (all digits)>]';

/**
 * Report a usage error on ONE line and nothing else.
 *
 * One line, always, for the reason `session-coverage.mjs#fail` gives: this
 * stream is read by a model, and a two-line message invites "the first line is
 * the error, the rest is noise".
 *
 * @param {string} message
 * @returns {2} the exit code, returned so callers read as `return fail(...)`
 */
function fail(message) {
  process.stderr.write(`route-compare: ${message} | ${USAGE}\n`);
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
 * One usage block with every field at zero.
 *
 * Spelled here rather than imported so the error branch stays reachable even
 * if the join module is the thing that failed to load. The field list mirrors
 * `lib/replay/spawn-outcome.js#USAGE_FIELDS`; a field added there and not here
 * shows up as a missing key on the error line only, which is why the key set
 * is pinned by a test rather than by this comment.
 *
 * @returns {Record<string, number>}
 */
function emptyUsage() {
  return {
    fresh_input_tokens: 0,
    cached_input_tokens: 0,
    cache_creation_tokens: 0,
    output_tokens: 0,
    thinking_tokens: 0,
    requests: 0,
  };
}

/**
 * The join's fields at their empty values.
 *
 * Used by the error branch so a caught throw prints the SAME key set as a
 * successful run. A reader that has to branch on which keys exist will
 * eventually branch wrong.
 *
 * SPELLED OUT RATHER THAN DERIVED, AND THEREFORE ABLE TO DRIFT. Copying the
 * join's own empty result would make drift impossible, but it would also make
 * the error branch depend on the module whose failure to load is one of the
 * things that reaches this branch. So the duplication is deliberate and the
 * drift is caught from outside instead: `tests/ledger/route-compare-cli.test.js`
 * walks this object against `joinSpawnOutcomes([])` recursively and requires
 * the same keys in the same order at every level. That test is why this
 * paragraph can promise the shapes match; the export below exists only to let
 * it look.
 *
 * @returns {object}
 */
export function emptyJoin() {
  return {
    binds: 0,
    duplicate_binds: 0,
    malformed_binds: 0,
    receipts: 0,
    main_thread_receipts: 0,
    subagent_receipts: 0,
    malformed_receipts: 0,
    model_mismatch: 0,
    duplicate_receipts: 0,
    pairs: [],
    compared: 0,
    excluded_fifo: 0,
    excluded_no_recommendation: 0,
    by_agreement: { same: 0, diverged: 0 },
    // null, not 0: there is no denominator, which is a different statement from
    // a denominator whose agreements were all zero.
    agreement_rate: null,
    by_confidence: {
      exact: 0, name: 0, fifo: 0, other: 0,
    },
    agreed_by_model: {},
    divergence: {},
    multi_model_runs: 0,
    // `total` is null, NEVER 0, when `priced` is 0. A sum over zero rows is
    // unmeasured, and a 0 reads as a measured floor — "these divergences were
    // free" rather than "nothing was priced". Measured on the live run at
    // 2026-09-21T01:31:59Z, an earlier shape printed exactly that.
    cost: {
      compared: 0,
      unpriced: 0,
      same: { priced: 0, total: null },
      diverged: { priced: 0, total: null },
    },
    // Token totals are kept PER FIELD because cached input, fresh input and
    // output are priced differently; one collapsed "tokens" number cannot be
    // turned back into a bill. Mirrors `spawn-outcome.js#USAGE_FIELDS`.
    usage_totals: { same: emptyUsage(), diverged: emptyUsage(), non_numeric: 0 },
    // Same rule as `cost`: `total_ms` is null, never 0, when `count` is 0. A
    // latency total of 0 over no pairs reads as an instantaneous run.
    latency: {
      same: { count: 0, total_ms: null },
      diverged: { count: 0, total_ms: null },
    },
    unjoined_binds: 0,
    unjoined_receipts: 0,
    // Verbatim, including the reason: a null score with no reason reads as a
    // measurement that failed, rather than as one no writer produces.
    score: { source: null, value: null, reason: 'no-spawn-keyed-score-writer' },
  };
}

/**
 * Build the stdout object, picking each join field BY NAME.
 *
 * Picked rather than spread on purpose: the join is another module's shape and
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
    // Echoed so a reader knows which two event names produced these counts
    // without opening the join; a renamed event would otherwise read as zero.
    events: { bind: SPAWN_OUTCOME_EVENTS.bind, receipt: SPAWN_OUTCOME_EVENTS.receipt },
    // The one clock read in this pipeline. The join is pure and may not read a
    // clock, so a timestamp on the result has to come from the shell.
    measured_at: new Date().toISOString(),
    ledger_path: parts.ledgerPath,
    since: parts.since,
    binds: fold.binds,
    duplicate_binds: fold.duplicate_binds,
    malformed_binds: fold.malformed_binds,
    receipts: fold.receipts,
    main_thread_receipts: fold.main_thread_receipts,
    subagent_receipts: fold.subagent_receipts,
    malformed_receipts: fold.malformed_receipts,
    model_mismatch: fold.model_mismatch,
    duplicate_receipts: fold.duplicate_receipts,
    pairs: fold.pairs,
    compared: fold.compared,
    excluded_fifo: fold.excluded_fifo,
    excluded_no_recommendation: fold.excluded_no_recommendation,
    by_agreement: fold.by_agreement,
    agreement_rate: fold.agreement_rate,
    by_confidence: fold.by_confidence,
    agreed_by_model: fold.agreed_by_model,
    divergence: fold.divergence,
    multi_model_runs: fold.multi_model_runs,
    cost: fold.cost,
    usage_totals: fold.usage_totals,
    latency: fold.latency,
    unjoined_binds: fold.unjoined_binds,
    unjoined_receipts: fold.unjoined_receipts,
    score: fold.score,
    census: parts.census,
  };
  if (parts.error !== undefined) out.error = parts.error;
  return out;
}

/**
 * Run the script.
 *
 * `env` is not a parameter: this script has no environment fallback to read,
 * and a dead parameter would suggest one exists.
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
    line = report({
      since, ledgerPath: census.file.path, fold: joinSpawnOutcomes(events), census,
    });
  } catch (err) {
    // An unexpected throw is still an observation outcome, not a usage error:
    // the caller asked a well-formed question and deserves a parseable answer
    // saying the measurement could not be taken. An UNREADABLE ledger does not
    // land here — the reader swallows it and reports it in the census — so a
    // present `error` means something escaped the reader itself.
    line = report({
      since,
      ledgerPath: null,
      fold: emptyJoin(),
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
