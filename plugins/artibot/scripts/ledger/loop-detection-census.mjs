#!/usr/bin/env node
/**
 * Report the loop detector's detections from the command line: how many
 * `loop-state.json` files the state dir holds — one per session under
 * `runtime/sessions/<id>/`, plus the flat sessionless one — and how many detection
 * rows they carry, split by severity and by tool. READ ONLY.
 *
 * `scripts/hooks/tool-tracker.js` is the writer: since 2026-10-23 it flushes the
 * detector history on every call and appends one `detections[]` row per detected
 * loop (`{ts, tool, severity, count, fingerprint_sha12}` — a hash of the detector
 * fingerprint, never the arguments). This file is the read side of that record and
 * nothing more. It is the D-02 stage 1 instrument of
 * `.artibot/guides/v5-design/practicality-improvement-20261023/05_REVISED_DESIGN.md`:
 * the count of warn/block events per session and per tool, and the fingerprints
 * that recur, are the denominator the advisory flip (`cognitive.loopDetector.advisory`)
 * waits on — a false-positive review needs this list before anything reaches the model.
 *
 * -- WHY IT LIVES BESIDE THE LEDGER READERS ---------------------------------
 *  Its INPUT is not the ledger — it is the state dir's session tree. It sits here
 *  because `scripts/ledger/recovery-journal-census.mjs` is the precedent it copies
 *  verb for verb: read-only, zero denominator prints `null`, one line of JSON on
 *  stdout, the human line on stderr, a writer-import allowlist asserted by the paired
 *  test (`tests/ledger/loop-detection-census.test.js`).
 *
 * -- WHY IT DOES NOT IMPORT `lib/core/runtime-state.js` OR `lib/core/config.js` --
 *  The runtime-state module carries the session-directory remover and config.js
 *  imports the file helpers; importing either would put a mutating verb one
 *  identifier away from this reader and break the allowlist. The two layout names
 *  and the state-dir pairing rule are therefore COPIED here, and the paired test
 *  asserts both copies against the originals so a drift stays red.
 *
 * -- THE STATE DIR ----------------------------------------------------------
 *  `~/.claude/artibot`, or `ARTIBOT_STATE_DIR` when it is paired with the home in
 *  force (`ARTIBOT_STATE_DIR_HOME` names the home it was minted for, and every home
 *  variable that is set must still agree) — the same rule as
 *  `lib/core/config.js#resolveArtibotDir`. `--state-dir` overrules it and is what the
 *  tests use.
 *
 * -- WHAT IS COUNTED --------------------------------------------------------
 *  A FILE is read when it exists at `<state>/runtime/sessions/<id>/loop-state.json`
 *  or at `<state>/loop-state.json`. A file that does not parse is a `parseFailures`
 *  count, never a zero. A DETECTION ROW is an object whose `tool` is a string and
 *  whose `severity` is `warn` or `block`; anything else in the array is ignored. The
 *  history itself (the circular buffer of fingerprints) is not counted — it is a
 *  window, not a record.
 *
 * -- ZERO IS NOT NULL -------------------------------------------------------
 *  No state dir, or a state dir with no loop-state file anywhere, is an ABSENT
 *  measurement: `detections`, `byTool` and `topFingerprints` print `null` and
 *  `status` says which absence (`unmeasured:no-state` / `unmeasured:no-files`).
 *  Files read with no detection row anywhere is a MEASURED zero —
 *  `{warn: 0, block: 0, total: 0}`, `status: measured:no-detections` — because
 *  "the detector saw nothing" and "nothing was ever recorded" are opposite findings.
 *
 * -- STDOUT IS ONE LINE OF JSON; THE HUMAN LINE GOES TO STDERR --------------
 *  Fixed stdout key set:
 *    {"ok","reason","inputPaths","measured_at","filesRead","parseFailures",
 *     "sessions","detections","byTool","topFingerprints","status"}
 *
 * -- EXIT CODES -------------------------------------------------------------
 *  0  a census was printed, OR the state dir could not be read and stdout says so
 *  2  usage error: the command line itself is wrong, and stdout stays EMPTY
 *  READ `ok` BEFORE TRUSTING AN EXIT 0.
 *
 * -- WHAT THIS READER CANNOT SEE (rules §9) ---------------------------------
 *  - EXPIRED OR SWEPT SESSIONS. `lib/core/runtime-state.js#sweepSessionDirs` removes
 *    idle session directories (7 days, 256 survivors) on every session start, and
 *    the hook discards a file older than 30 minutes when it restores. This is a
 *    count of what is on disk now, not of every loop that ever fired.
 *  - THE LAST 50 ONLY. The writer caps `detections` per file; a session that looped
 *    more than that shows 50.
 *  - WHETHER A DETECTION WAS A FALSE POSITIVE. A re-run of the same test command,
 *    `tail`, polling — all look like loops to the detector. Sorting that out is the
 *    human review this list exists to feed.
 *  - FILES IN OTHER STATE DIRS. One state dir per run; a second machine or a
 *    redirected session is another run.
 *  - THE INSTALLED COPY. The tests run the file in this worktree.
 *
 * @module scripts/ledger/loop-detection-census
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { getHomeDir, sameDirPath } from '../../lib/core/platform.js';
import { isMainEntry } from '../hooks/_main-entry.js';

/**
 * Copies of `lib/core/runtime-state.js#RUNTIME_DIRNAME` / `#SESSIONS_DIRNAME` (this
 * reader may not import that module); the paired test asserts they stay equal.
 */
export const RUNTIME_DIRNAME = 'runtime';
export const SESSIONS_DIRNAME = 'sessions';

/** The file the hook writes, under a session directory or flat in the state dir. */
export const STATE_FILE_NAME = 'loop-state.json';

/** How many recurring fingerprints the report lists. */
const TOP_FINGERPRINTS = 10;

const SEVERITIES = Object.freeze(['warn', 'block']);

/** Flags that take a value. Anything else on the command line is an error. */
const VALUE_FLAGS = ['--state-dir'];

const USAGE = 'usage: loop-detection-census.mjs [--state-dir <dir>]';

/**
 * Report a usage error on ONE line and nothing else.
 *
 * @param {string} message
 * @returns {2} the exit code, returned so callers read as `return fail(...)`
 */
function fail(message) {
  process.stderr.write(`loop-detection-census: ${message} | ${USAGE}\n`);
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
 * @param {Record<string,string>} opts
 * @returns {string|null}
 */
function usageError(opts) {
  if (opts['state-dir'] !== undefined && opts['state-dir'].trim() === '') {
    return '--state-dir must not be empty';
  }
  return null;
}

/**
 * The user-state directory — a mirror of `lib/core/config.js#resolveArtibotDir`
 * (see the module header for why it is copied). The paired test runs both through
 * the same decision table.
 *
 * @returns {string} absolute directory path
 */
export function resolveStateDir() {
  const homeDerived = path.join(getHomeDir(), '.claude', 'artibot');
  const override = process.env.ARTIBOT_STATE_DIR;
  if (!override) return homeDerived;
  const mintedFor = process.env.ARTIBOT_STATE_DIR_HOME;
  if (!mintedFor) return homeDerived;
  const declaredHomes = [process.env.USERPROFILE, process.env.HOME].filter(Boolean);
  const homes = declaredHomes.length > 0 ? declaredHomes : [getHomeDir()];
  if (!homes.every((home) => sameDirPath(mintedFor, home))) return homeDerived;
  return override;
}

/**
 * @param {string} p
 * @returns {boolean} true when `p` exists and is a directory
 */
function isDirectory(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * @param {string} p
 * @returns {boolean} true when `p` exists and is a regular file
 */
function isFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * @param {string} dir
 * @returns {string[]} names of the subdirectories of `dir`, sorted; `[]` when absent
 */
function subdirectories(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * @param {unknown} row
 * @returns {boolean} true for an object the writer could have produced
 */
function isDetectionRow(row) {
  return row !== null
    && typeof row === 'object'
    && !Array.isArray(row)
    && typeof row.tool === 'string'
    && SEVERITIES.includes(row.severity);
}

/**
 * Read one state file into the tally. Mutates `tally` (a local accumulator, not a
 * record anyone else holds).
 *
 * @param {string} file
 * @param {object} tally
 */
function foldFile(file, tally) {
  tally.filesRead += 1;
  let state;
  try {
    state = JSON.parse(readFileSync(file, 'utf-8'));
  } catch {
    tally.parseFailures += 1;
    return;
  }
  const rows = Array.isArray(state?.detections) ? state.detections : [];
  for (const row of rows) {
    if (!isDetectionRow(row)) continue;
    tally.total += 1;
    tally.bySeverity[row.severity] += 1;
    const perTool = tally.byTool[row.tool] ?? { warn: 0, block: 0 };
    perTool[row.severity] += 1;
    tally.byTool[row.tool] = perTool;
    if (typeof row.fingerprint_sha12 === 'string' && row.fingerprint_sha12 !== '') {
      const key = `${row.fingerprint_sha12}\u0000${row.tool}`;
      const entry = tally.fingerprints.get(key) ?? { fingerprint_sha12: row.fingerprint_sha12, tool: row.tool, count: 0 };
      entry.count += 1;
      tally.fingerprints.set(key, entry);
    }
  }
}

/**
 * The recurring fingerprints, most frequent first, ties by fingerprint then tool.
 *
 * @param {Map<string, {fingerprint_sha12: string, tool: string, count: number}>} fingerprints
 * @returns {Array<{fingerprint_sha12: string, tool: string, count: number}>}
 */
function rankFingerprints(fingerprints) {
  return [...fingerprints.values()]
    .sort((a, b) => b.count - a.count
      || a.fingerprint_sha12.localeCompare(b.fingerprint_sha12)
      || a.tool.localeCompare(b.tool))
    .slice(0, TOP_FINGERPRINTS);
}

/**
 * Census one state dir. Pure apart from the reads; never throws.
 *
 * @param {string} stateDir absolute path
 * @param {{ now?: () => Date }} [deps]
 * @returns {object} the stdout document (fixed key set, see the header)
 */
export function censusStateDir(stateDir, deps = {}) {
  const now = typeof deps.now === 'function' ? deps.now : () => new Date();
  const sessionsRoot = path.join(stateDir, RUNTIME_DIRNAME, SESSIONS_DIRNAME);
  const flatFile = path.join(stateDir, STATE_FILE_NAME);
  const base = {
    ok: true,
    reason: null,
    inputPaths: [sessionsRoot, flatFile],
    measured_at: now().toISOString(),
    filesRead: 0,
    parseFailures: 0,
    sessions: 0,
    detections: null,
    byTool: null,
    topFingerprints: null,
    status: 'unmeasured:no-state',
  };

  if (!isDirectory(stateDir)) {
    return { ...base, ok: false, reason: `no state dir at ${stateDir}` };
  }

  const tally = {
    filesRead: 0,
    parseFailures: 0,
    total: 0,
    bySeverity: { warn: 0, block: 0 },
    byTool: {},
    fingerprints: new Map(),
  };
  let sessions = 0;
  for (const sid of subdirectories(sessionsRoot)) {
    const file = path.join(sessionsRoot, sid, STATE_FILE_NAME);
    if (!isFile(file)) continue;
    sessions += 1;
    foldFile(file, tally);
  }
  if (isFile(flatFile)) foldFile(flatFile, tally);

  if (tally.filesRead === 0) {
    return { ...base, status: 'unmeasured:no-files' };
  }

  return {
    ...base,
    filesRead: tally.filesRead,
    parseFailures: tally.parseFailures,
    sessions,
    detections: { warn: tally.bySeverity.warn, block: tally.bySeverity.block, total: tally.total },
    byTool: tally.byTool,
    topFingerprints: rankFingerprints(tally.fingerprints),
    status: tally.total === 0 ? 'measured:no-detections' : 'measured',
  };
}

/**
 * @param {object} report
 * @returns {string} the one-line human summary (stderr)
 */
function humanLine(report) {
  const d = report.detections;
  const counts = d === null ? 'detections=null' : `warn=${d.warn} block=${d.block} total=${d.total}`;
  return `loop-detection-census: files=${report.filesRead} parse_failures=${report.parseFailures} `
    + `sessions=${report.sessions} ${counts} status=${report.status}\n`;
}

/**
 * @param {string[]} argv
 * @returns {number} exit code
 */
export function main(argv = process.argv.slice(2)) {
  const parsed = parseArgs(argv);
  if ('error' in parsed) return fail(parsed.error);
  const invalid = usageError(parsed.opts);
  if (invalid !== null) return fail(invalid);

  const stateDir = parsed.opts['state-dir'] !== undefined
    ? path.resolve(parsed.opts['state-dir'])
    : resolveStateDir();
  const report = censusStateDir(stateDir);
  process.stdout.write(`${JSON.stringify(report)}\n`);
  process.stderr.write(humanLine(report));
  return 0;
}

if (isMainEntry(import.meta.url)) {
  process.exitCode = main();
}
