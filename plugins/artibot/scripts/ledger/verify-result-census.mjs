#!/usr/bin/env node
/**
 * Report, from the command line, what the REPORT verify-evidence gate would say
 * of every stored autopilot session under its two evidence modes — and so what
 * flipping `autopilot.reportVerifyGate.evidenceMode` from `'ack'` to
 * `'explicit-pass'` would cost. READ ONLY. 05 D-04 stage 1
 * (`.artibot/guides/v5-design/practicality-improvement-20261023/05_REVISED_DESIGN.md`).
 *
 * -- WHAT IT COUNTS ----------------------------------------------------------
 *  Over the `{sessionId}.json` files of the autopilot session store, parsed
 *  plainly (no store loader, so no schema migration runs and an old file is
 *  counted exactly as it sits on disk):
 *    files            `.json` files seen (the `.events.ndjson` siblings are not)
 *    parseFailures    files that do not parse, or parse to a non-object
 *    sessions         files that parsed to a session object
 *    reportReached    sessions that REACHED REPORT — a `phases` row named REPORT,
 *                     `phase === 'COMPLETED'`, or `lastPhase === 'REPORT'` — the
 *                     notion `report-verify-gate.js`'s header counts with. This
 *                     is THE DENOMINATOR of everything below: a session still
 *                     ahead of REPORT has not met the gate.
 *    byFold           over reportReached: `recovery-record.js#foldVerify` of
 *                     `state.verifyResult` — PASS / FAIL / UNMEASURED
 *    underAck         over reportReached: `evaluateReportVerifyEvidence(state,
 *                     {evidenceMode:'ack'})` — `ok` count and a zero-filled
 *                     `byCode` over the gate's closed vocabulary
 *    underExplicitPass  the same under `'explicit-pass'`
 *    wouldPauseUnderExplicitPass  sessions that pass under 'ack' and would NOT
 *                     under 'explicit-pass' — the flip's MARGINAL cost, which is
 *                     `underAck.ok - underExplicitPass.ok` by construction (the
 *                     stricter mode never passes what the looser one refuses).
 *  A zero denominator prints `null` for every ratio-like block, never 0: "no
 *  session has reached REPORT" and "every session that did passes" are opposite
 *  findings. `status` says which absence it was — `unmeasured:no-store` or
 *  `unmeasured:no-report-reached` — or `measured`.
 *
 * -- WHERE IT READS, AND WHY IT IMPORTS THE GATE -----------------------------
 *  The store directory, the `ARTIBOT_AUTOPILOT_STORE_DIR` pair and the fallback
 *  to the old locations (read while the new store has adopted nothing) are the
 *  precedent's own exports — `./recovery-journal-census.mjs#resolveStoreDir`,
 *  `#resolveLegacyStoreDirs`, `#LEGACY_LEDGER_NAME` — so there is ONE resolver,
 *  not a second mirror. `--dir` overrules both and is what the tests use.
 *
 *  The verdicts are the gate's own: `lib/autopilot/report-verify-gate.js#
 *  evaluateReportVerifyEvidence` (pure) and `lib/autopilot/recovery-record.js#
 *  foldVerify` (pure). Re-implementing either here would be a second truth
 *  source that drifts. The price is stated plainly: the gate module's own
 *  imports reach the session store's WRITER transitively (through
 *  `_engine-helpers.js`), so the import allowlist the paired test asserts proves
 *  read-only for THIS file only, and the behavioural snapshot there (bytes,
 *  sizes, mtimes, listing captured around a real spawn) is the evidence that a
 *  run writes nothing to the store it measures. This header does not spell the
 *  mutating fs verbs for the same reason the precedent does not.
 *
 * -- STDOUT IS ONE LINE OF JSON; THE HUMAN LINE GOES TO STDERR --------------
 *  Fixed stdout key set, in order:
 *    {"ok","reason","inputPath","files","parseFailures","sessions","reportReached",
 *     "byFold","underAck","underExplicitPass","wouldPauseUnderExplicitPass",
 *     "measured_at","status","census"}
 *  `census` carries provenance (store presence, the `--session` filter, the
 *  directories actually read, the legacy fallback flag) and `perSession`, one
 *  entry per parsed session with the same three verdicts, so the breakdown can
 *  never disagree with the totals.
 *
 * -- EXIT CODES -------------------------------------------------------------
 *  0  a census was printed, OR the store could not be read and stdout says so
 *  2  usage error: the command line itself is wrong, and stdout stays EMPTY
 *  READ `ok` BEFORE TRUSTING AN EXIT 0.
 *
 * -- WHAT THIS READER CANNOT SEE (rules §9) ---------------------------------
 *  - SESSIONS THAT WERE DELETED OR PRUNED. A count of files, not of history.
 *  - WHETHER A PASS IS TRUE. `foldVerify` reads the driver's SELF-REPORT; no
 *    test output is consulted. That is rule 7 ('deterministic'), designed in 05
 *    D-04 and not wired.
 *  - THE LIVE ANSWER. This checkout ships no store; the number is unmeasured
 *    until the script is run on a machine that has one.
 *  - WHAT A DRIVER WILL DO AFTER THE FLIP. `wouldPauseUnderExplicitPass`
 *    describes stored sessions as they are, not drivers that start writing an
 *    explicit PASS once the mode changes.
 *
 * @module scripts/ledger/verify-result-census
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { evaluateReportVerifyEvidence, REPORT_VERIFY_CODES } from '../../lib/autopilot/report-verify-gate.js';
import { foldVerify } from '../../lib/autopilot/recovery-record.js';
import { LEGACY_LEDGER_NAME, resolveLegacyStoreDirs, resolveStoreDir } from './recovery-journal-census.mjs';
import { isMainEntry } from '../hooks/_main-entry.js';

/** Flags that take a value. Anything else on the command line is an error. */
const VALUE_FLAGS = ['--dir', '--session'];

const USAGE = 'usage: verify-result-census.mjs [--dir <store>] [--session <id>]';

/** The two modes this census compares, in the order the report prints them. */
const MODES = Object.freeze({ ack: 'ack', explicitPass: 'explicit-pass' });

/**
 * Report a usage error on ONE line and nothing else.
 *
 * @param {string} message
 * @returns {2} the exit code, returned so callers read as `return fail(...)`
 */
function fail(message) {
  process.stderr.write(`verify-result-census: ${message} | ${USAGE}\n`);
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
 * The command line itself, judged before anything is read.
 *
 * @param {Record<string,string>} opts
 * @returns {string|null}
 */
function usageError(opts) {
  if (opts.dir !== undefined && opts.dir.trim() === '') return '--dir must not be empty';
  if (opts.session !== undefined && opts.session.trim() === '') return '--session must not be empty';
  // A session id is a file STEM here; a separator would reach outside the store.
  if (opts.session !== undefined && /[\\/]/.test(opts.session)) {
    return `--session must be a bare session id, got: ${opts.session}`;
  }
  return null;
}

/**
 * The `{sessionId}.json` files this run will open, in directory order.
 *
 * @param {string} dir
 * @param {string|undefined} session the `--session` narrowing, if any
 * @returns {{present: boolean, readable: boolean, files: string[]}}
 */
function listStoreFiles(dir, session) {
  if (!existsSync(dir)) return { present: false, readable: false, files: [] };
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return { present: true, readable: false, files: [] };
  }
  const json = names.filter((name) => name.endsWith('.json'));
  const files = session === undefined ? json : json.filter((n) => n === `${session}.json`);
  return { present: true, readable: true, files };
}

/**
 * @param {string} file
 * @returns {number} the file's mtime in ms; 0 when it cannot be read, which ranks last
 */
function mtimeOf(file) {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * What the old locations would hand the store, one file per session id: the
 * FRESHEST copy — the same choice the session store's adoption makes and the
 * same rule `recovery-journal-census.mjs` applies. Sorted by id.
 *
 * @param {string[]} sources in precedence order
 * @param {string|undefined} session
 * @returns {{name: string, file: string, dir: string}[]}
 */
function freshestLegacyEntries(sources, session) {
  const chosen = new Map();
  for (const dir of sources) {
    for (const name of listStoreFiles(dir, session).files) {
      const file = path.join(dir, name);
      const mtimeMs = mtimeOf(file);
      const held = chosen.get(name);
      if (!held || mtimeMs > held.mtimeMs) chosen.set(name, { name, file, dir, mtimeMs });
    }
  }
  return [...chosen.values()]
    .sort((a, b) => (a.name < b.name ? -1 : Number(a.name > b.name)))
    .map(({ name, file, dir }) => ({ name, file, dir }));
}

/**
 * Decide what this run reads: the store itself, or — while the store has adopted
 * nothing (no session file at all, no adoption ledger beside it) — the old
 * locations. The same rule as the precedent, applied through its exports.
 *
 * @param {string} primary the store directory
 * @param {{dir?: string, session?: string}} opts
 * @returns {{store: {present: boolean, readable: boolean, files: string[]},
 *   entries: {name: string, file: string}[], readFrom: string[], legacyFallback: boolean}}
 */
function chooseInputs(primary, opts) {
  const store = listStoreFiles(primary, opts.session);
  const adoptedNothing = store.files.length === 0
    && listStoreFiles(primary, undefined).files.length === 0
    && !existsSync(path.join(primary, LEGACY_LEDGER_NAME));
  if (adoptedNothing) {
    const legacy = freshestLegacyEntries(resolveLegacyStoreDirs(opts.dir), opts.session);
    if (legacy.length > 0) {
      return {
        store: { present: true, readable: true, files: legacy.map((e) => e.name) },
        entries: legacy,
        readFrom: [...new Set(legacy.map((e) => e.dir))],
        legacyFallback: true,
      };
    }
  }
  return {
    store,
    entries: store.files.map((name) => ({ name, file: path.join(primary, name) })),
    readFrom: [primary],
    legacyFallback: false,
  };
}

/**
 * Did this session reach REPORT? Any of the three signs the gate header counts
 * with. A session standing AT REPORT whose row has not been recorded yet is not
 * counted: it has not met the gate.
 *
 * @param {Record<string, unknown>} state
 * @returns {boolean}
 */
function reachedReport(state) {
  if (state.phase === 'COMPLETED') return true;
  if (state.lastPhase === 'REPORT') return true;
  const phases = state.phases;
  return Array.isArray(phases) && phases.some((row) => row !== null && typeof row === 'object' && row.name === 'REPORT');
}

/** @returns {Record<string, number>} every gate code, zero-filled */
function zeroCodes() {
  return Object.fromEntries(Object.values(REPORT_VERIFY_CODES).map((code) => [code, 0]));
}

/**
 * Fold the store into counts.
 *
 * @param {{name: string, file: string}[]} entries
 * @returns {{files: number, parseFailures: number, sessions: number, reportReached: number,
 *   byFold: Record<'PASS'|'FAIL'|'UNMEASURED', number>, ack: {ok: number, byCode: Record<string, number>},
 *   explicitPass: {ok: number, byCode: Record<string, number>}, wouldPause: number,
 *   perSession: object[]}}
 */
function collect(entries) {
  const tally = {
    files: entries.length,
    parseFailures: 0,
    sessions: 0,
    reportReached: 0,
    byFold: { PASS: 0, FAIL: 0, UNMEASURED: 0 },
    ack: { ok: 0, byCode: zeroCodes() },
    explicitPass: { ok: 0, byCode: zeroCodes() },
    wouldPause: 0,
    perSession: /** @type {object[]} */ ([]),
  };
  for (const { name, file } of entries) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(file, 'utf-8'));
    } catch {
      tally.parseFailures += 1;
      continue;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      tally.parseFailures += 1;
      continue;
    }
    tally.sessions += 1;
    const reached = reachedReport(parsed);
    const fold = foldVerify(parsed.verifyResult);
    const ack = evaluateReportVerifyEvidence(parsed, { evidenceMode: MODES.ack }).code;
    const explicitPass = evaluateReportVerifyEvidence(parsed, { evidenceMode: MODES.explicitPass }).code;
    tally.perSession.push({
      sessionId: name.slice(0, -'.json'.length), reportReached: reached, fold, ack, explicitPass,
    });
    if (!reached) continue;
    tally.reportReached += 1;
    tally.byFold[fold] += 1;
    tally.ack.byCode[ack] += 1;
    tally.explicitPass.byCode[explicitPass] += 1;
    if (ack === REPORT_VERIFY_CODES.OK) tally.ack.ok += 1;
    if (explicitPass === REPORT_VERIFY_CODES.OK) tally.explicitPass.ok += 1;
    if (ack === REPORT_VERIFY_CODES.OK && explicitPass !== REPORT_VERIFY_CODES.OK) tally.wouldPause += 1;
  }
  return tally;
}

/**
 * Which absence this store is in, or `measured`.
 *
 * @param {{present: boolean, readable: boolean}} store
 * @param {{sessions: number, reportReached: number}} tally
 * @returns {'measured'|'unmeasured:no-store'|'unmeasured:no-report-reached'}
 */
function statusOf(store, tally) {
  if (!store.present || !store.readable || tally.sessions === 0) return 'unmeasured:no-store';
  if (tally.reportReached === 0) return 'unmeasured:no-report-reached';
  return 'measured';
}

/**
 * Why no census could be taken, or `null` when one was.
 *
 * @param {{present: boolean, readable: boolean}} store
 * @param {{sessions: number}} tally
 * @param {string} dir
 * @returns {string|null}
 */
function storeReason(store, tally, dir) {
  if (!store.present) return `no session store at ${dir}`;
  if (!store.readable) return `session store not readable at ${dir}`;
  if (tally.sessions === 0) return `no session store at ${dir} (no session file parsed)`;
  return null;
}

/**
 * The one-line human summary. Goes to stderr so stdout stays parseable.
 *
 * @param {object} report the stdout object
 * @returns {string}
 */
function humanLine(report) {
  const where = report.census.legacyFallback
    ? `${report.census.readFrom.join(', ')} (old location(s), not yet adopted)`
    : report.inputPath;
  const head = `verify result: ${report.reportReached} of ${report.sessions} session(s) reached REPORT`;
  if (report.reportReached === 0) {
    return `${head} — null (${report.status}) | ${report.files} file(s) at ${where} | measured ${report.measured_at}\n`;
  }
  return `${head} — fold PASS ${report.byFold.PASS} / FAIL ${report.byFold.FAIL} / UNMEASURED ${report.byFold.UNMEASURED}`
    + ` | ok under ack ${report.underAck.ok}, under explicit-pass ${report.underExplicitPass.ok}`
    + ` | would pause under explicit-pass ${report.wouldPauseUnderExplicitPass}`
    + ` | ${report.files} file(s) at ${where} | measured ${report.measured_at}\n`;
}

/**
 * Take the census. Pure apart from the fs reads and the clock.
 *
 * @param {{dir?: string, session?: string, now?: string}} [opts]
 * @returns {object} the stdout report, with a FIXED key order
 */
export function census(opts = {}) {
  const primary = resolveStoreDir(opts.dir);
  const measuredAt = opts.now ?? new Date().toISOString();
  const {
    store, entries, readFrom, legacyFallback,
  } = chooseInputs(primary, opts);
  const tally = collect(entries);
  const reason = storeReason(store, tally, primary);
  const measured = tally.reportReached > 0;
  return {
    ok: reason === null,
    reason,
    inputPath: primary,
    files: tally.files,
    parseFailures: tally.parseFailures,
    sessions: tally.sessions,
    reportReached: tally.reportReached,
    byFold: measured ? tally.byFold : null,
    underAck: measured ? tally.ack : null,
    underExplicitPass: measured ? tally.explicitPass : null,
    wouldPauseUnderExplicitPass: measured ? tally.wouldPause : null,
    measured_at: measuredAt,
    status: statusOf(store, tally),
    census: {
      storePresent: store.present,
      storeReadable: store.readable,
      sessionFilter: opts.session ?? null,
      perSession: tally.perSession,
      legacyFallback,
      readFrom,
    },
  };
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

  const report = census({ dir: opts.dir, session: opts.session });
  process.stdout.write(`${JSON.stringify(report)}\n`);
  process.stderr.write(humanLine(report));
  return 0;
}

if (isMainEntry(import.meta.url)) {
  const [, , ...argv] = process.argv;
  try {
    process.exitCode = main(argv);
  } catch (err) {
    // A reader that crashed on the store it was measuring would be worse than no
    // number: say so on stdout in the same envelope, exit 0, and let `ok` speak.
    const reason = `census failed: ${err?.message ?? String(err)}`;
    process.stdout.write(`${JSON.stringify({
      ok: false, reason, inputPath: null, files: 0, parseFailures: 0, sessions: 0, reportReached: 0,
      byFold: null, underAck: null, underExplicitPass: null, wouldPauseUnderExplicitPass: null,
      measured_at: new Date().toISOString(), status: 'unmeasured:no-store', census: null,
    })}\n`);
    process.stderr.write(`verify-result-census: ${reason}\n`);
    process.exitCode = 0;
  }
}
