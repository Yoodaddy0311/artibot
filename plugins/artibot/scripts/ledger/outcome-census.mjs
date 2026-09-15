#!/usr/bin/env node
/**
 * Print the Shadow metric owner decision 5 (a) asks for — "of the missions that
 * were DECLARED complete, how many would an `outcome.md` write have been
 * blocked for, and by which gate?" — from a project's central ledger.
 *
 * TWO NUMBERS, NEITHER OF WHICH ANSWERS ALONE. `mission.completed` rows are the
 * DENOMINATOR: a count of blocks on its own cannot separate "few missions were
 * declared" from "most declared missions are blocked". The gate verdict from
 * `lib/runtime/artifact-lifecycle.js#plan` is the NUMERATOR. This script reads
 * the ledger, replays the classification, hands the entries to the fold
 * (`lib/mission/outcome-gate-census.js#foldOutcomeGateCensus`), and prints.
 *
 * READ-ONLY — THE OBSERVE CONTRACT, ENFORCED BY WHAT IS NOT IMPORTED.
 * The ledger's append function (`lib/runtime/ledger.js`, the one writer a hook
 * calls) is deliberately not imported here, so there is no spelling of this
 * file that writes a line; a measuring tool that appends to the stream it
 * measures is its own next data point. The same rule as
 * `scripts/ledger/session-coverage.mjs`, and a test asserts the absence against
 * this file's SOURCE TEXT rather than trusting the claim — which is why that
 * function's name is nowhere in these bytes, not even in prose.
 *
 * THE HONEST BOUND ON THAT CLAIM: this file imports
 * `scripts/hooks/mission-complete-record.js`, and THAT module can append. Only
 * `classifyMissionOutcome`, `loadDeps` and `policyFromConfig` are reached from
 * here, and none of the three appends a ledger line or writes a file — but the claim rests on
 * that function boundary, not on the import graph. Sharing the classifier is
 * deliberate: two spellings of one classification would eventually become two
 * classifications, and then the number this prints and the reason the hook logs
 * would disagree with nobody able to say which was right.
 *
 * THE ARITHMETIC IS NOT HERE. Every count belongs to the fold, which is pure —
 * no clock, no filesystem. This file is the impure shell: it reads the ledger,
 * reads the store and two artifacts per mission, reads the clock ONCE for
 * `measured_at`, and serializes.
 *
 * USAGE
 *   node scripts/ledger/outcome-census.mjs [--cwd <projectRoot>] [--since <iso-or-ms>]
 *   An all-digit `--since` is read as EPOCH MILLISECONDS, never as a year:
 *   `--since 2026` cuts at 1970-01-01T00:00:02.026Z, so spell a year as ISO.
 *
 * `--cwd` defaults to `process.cwd()` for `session-coverage.mjs`'s reason, and
 * carries its trap: Artibot also lives under the user's `.claude` directory, so
 * running the INSTALLED copy from an unrelated directory measures whatever
 * project the shell was in and reports it with the same confidence.
 * `ledger_path` is on stdout for exactly that reason.
 *
 * -- EXIT CODES -------------------------------------------------------------
 *  0  an observation was made and printed — INCLUDING a missing ledger, an
 *     unreadable ledger, an empty ledger, and an unexpected throw. "There is no
 *     ledger" is a finding about the project, not a failure of this script.
 *  2  usage error only: unknown flag, flag without a value, `--since` that does
 *     not parse. ONE line on stderr prefixed `outcome-census:`, NOTHING on
 *     stdout. A typo must not read as success.
 *
 * -- STDOUT -----------------------------------------------------------------
 *  Exactly ONE line of JSON, never pretty-printed, with a FIXED key set:
 *    {"event","measured_at","ledger_path","since","missions","declared",
 *     "blocked","would_write","by_block_code","blocked_ratio","census"}
 *  `error` is the ONE optional key, present only when an unexpected throw was
 *  caught, in which case the fold fields carry their empty values and `census`
 *  is null.
 *
 *  `blocked_ratio` IS `null`, NEVER `0`, WHEN `declared` IS 0. Zero is a
 *  measured rate — "missions were declared and none was blocked" — while null
 *  is the absence of a denominator. The fold owns that distinction; this file
 *  only refuses to flatten it.
 *
 * -- WHAT THIS CANNOT SEE ---------------------------------------------------
 *  - `missions` COUNTS MISSIONS WITH LEDGER ROWS, not missions that existed. A
 *    mission whose work never reached the ledger is absent, not zero.
 *  - THE ONLY INPUT IS LEDGER ROWS (brief §6.4 ②). There is no self-report
 *    channel here: no transcript is read, no model is asked, nothing that
 *    happened outside the ledger can raise or lower any number below. A
 *    mission that was genuinely completed and never recorded reads exactly like
 *    a mission that was never worked on.
 *  - `verification_id` MAY COLLIDE ACROSS SESSIONS (brief §6.4 ④). The live ids
 *    come from the gate's constant verdict hash
 *    (`lib/verification/verify-rate.js`), so two unrelated missions can carry
 *    the same id and the three-carrier join cannot tell them apart. A mission
 *    counted as unblocked on a `VERIFICATION_ID` gate is not proof that one
 *    verification covered it.
 *  - MISSIONS OF STILL-ACTIVE SESSIONS ARE IN `missions` BUT NOT YET DECLARED
 *    (brief §6.4 ⑤). The declaration is written at SessionEnd, so a session
 *    running right now contributes rows to the numerator's denominator
 *    (`missions`) while contributing nothing to `declared`. A low
 *    `declared/missions` ratio during busy hours is that timing, not a failure
 *    of the emitter.
 *  - THE CLASSIFICATION IS REPLAYED, NOT RECALLED. Nothing records why a
 *    mission was blocked, so this recomputes it from today's config, today's
 *    StateStore rows and today's files. A policy change or a landed `plan.md`
 *    moves a mission between codes, which is the intended behaviour and also
 *    means two runs at different times are not the same measurement.
 *  - `--since` CUTS THE LEDGER, NOT THE HISTORY. A mission whose earlier rows
 *    fall outside the window is classified on the rows that remain, so a narrow
 *    window can turn a declared mission into an undeclared one.
 *  - WHAT A `ledger.rejected` LINE REPLACED. Those lines are excluded by the
 *    reader's default and counted in `census.dropped.selection`.
 *
 * @module scripts/ledger/outcome-census
 */

import { readLedgerCensus } from '../../lib/runtime/ledger.js';
import { emptyOutcomeGateCensus, foldOutcomeGateCensus } from '../../lib/mission/outcome-gate-census.js';
import {
  classifyMissionOutcome, loadDeps, policyFromConfig, readPluginConfig,
} from '../hooks/mission-complete-record.js';
import { isMainEntry } from '../hooks/_main-entry.js';

/** Echoed on stdout as `event`: the row whose presence is the denominator. */
const CENSUS_EVENT = 'outcome-census';

/** Flags that take a value. Anything else on the command line is an error. */
const VALUE_FLAGS = ['--cwd', '--since'];

const USAGE = 'usage: outcome-census.mjs [--cwd <projectRoot>] [--since <iso | epoch-ms (all digits)>]';

/**
 * Report a usage error on ONE line and nothing else. One line for
 * `session-coverage.mjs#fail`'s reason: this stream is read by a model, and a
 * two-line message invites "the first line is the error, the rest is noise".
 *
 * @param {string} message
 * @returns {2} the exit code, returned so callers read as `return fail(...)`
 */
function fail(message) {
  process.stderr.write(`outcome-census: ${message} | ${USAGE}\n`);
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
    if (i + 1 >= argv.length) return { error: `${flag} requires a value` };
    opts[flag.slice(2)] = argv[i + 1];
    i += 1;
  }
  return { opts };
}

/**
 * Resolve `--since` to epoch milliseconds, or null when it is not a time.
 * Epoch ms are handled BEFORE `Date.parse`, which reads an all-digit string as
 * a year-or-worse rather than rejecting it.
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
 * Group the ledger's rows by mission, in first-seen order.
 *
 * `sessionId` is the LAST session that touched the mission, because that is the
 * session whose StateStore the mission's row most plausibly lives in; the store
 * read is a read either way, so a wrong guess costs a `STATE_ROW_ABSENT`, never
 * a write.
 *
 * @param {object[]} events
 * @returns {Map<string, {history: object[], sessionId: string|null, declared: boolean}>}
 */
function groupByMission(events) {
  const byMission = new Map();
  for (const e of events) {
    const id = typeof e?.mission_id === 'string' && e.mission_id !== '' ? e.mission_id : null;
    if (id === null) continue;
    if (!byMission.has(id)) byMission.set(id, { history: [], sessionId: null, declared: false });
    const entry = byMission.get(id);
    entry.history.push(e);
    if (typeof e.session_id === 'string' && e.session_id !== '') entry.sessionId = e.session_id;
    if (e.event === 'mission.completed') entry.declared = true;
  }
  return byMission;
}

/**
 * Classify every mission in the ledger. One `plan()` replay per DECLARED
 * mission; an undeclared one is counted and not replayed, which is what
 * `classifyMissionOutcome` already does for its `declared: false` branch.
 *
 * @param {object} d `loadDeps()` bindings
 * @param {{projectRoot: string, policy: object, byMission: Map}} ctx
 * @returns {Array<{missionId: string, declared: boolean, blockCode: string|null,
 *   wouldWrite: boolean}>} the fold's input shape, nothing more
 */
function classifyAll(d, ctx) {
  const entries = [];
  for (const [missionId, entry] of ctx.byMission) {
    const result = classifyMissionOutcome(d, {
      projectRoot: ctx.projectRoot,
      sessionId: entry.sessionId ?? missionId,
      missionId,
      history: entry.history,
      declared: entry.declared,
      policy: ctx.policy,
    });
    entries.push({
      missionId,
      declared: result.declared,
      blockCode: result.blockCode,
      wouldWrite: result.wouldWrite,
    });
  }
  return entries;
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
    event: CENSUS_EVENT,
    // The one clock read in this pipeline. The fold is pure and may not read a
    // clock, so a timestamp on the result has to come from the shell.
    measured_at: new Date().toISOString(),
    ledger_path: parts.ledgerPath,
    since: parts.since,
    missions: fold.missions,
    declared: fold.declared,
    blocked: fold.blocked,
    would_write: fold.would_write,
    by_block_code: fold.by_block_code,
    blocked_ratio: fold.blocked_ratio,
    census: parts.census,
  };
  if (parts.error !== undefined) out.error = parts.error;
  return out;
}

/**
 * Read, classify, fold. Separated from {@link main} so the error branch there
 * stays one `catch` over the whole measurement rather than several.
 *
 * @param {string} cwd
 * @param {number|null} sinceMs
 * @returns {Promise<{fold: object, census: object, ledgerPath: string|null}>}
 */
async function measure(cwd, sinceMs) {
  const d = await loadDeps();
  const projectRoot = d.resolveProjectRoot(cwd) ?? cwd;
  const { events, census } = readLedgerCensus(
    projectRoot, sinceMs === null ? {} : { since: sinceMs },
  );
  const policy = policyFromConfig(readPluginConfig(d));
  const entries = classifyAll(d, { projectRoot, policy, byMission: groupByMission(events) });
  return { fold: foldOutcomeGateCensus(entries), census, ledgerPath: census.file.path };
}

/**
 * Run the script.
 *
 * @param {string[]} argv arguments after the script path
 * @returns {Promise<number>} process exit code
 */
export async function main(argv) {
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
    const m = await measure(cwd, sinceMs);
    line = report({ since, ledgerPath: m.ledgerPath, fold: m.fold, census: m.census });
  } catch (err) {
    // An unexpected throw is still an observation outcome, not a usage error:
    // the caller asked a well-formed question and deserves a parseable answer
    // saying the measurement could not be taken.
    line = report({
      since,
      ledgerPath: null,
      fold: emptyOutcomeGateCensus(),
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
  main(argv).then((code) => { process.exitCode = code; }, () => { process.exitCode = 0; });
}
