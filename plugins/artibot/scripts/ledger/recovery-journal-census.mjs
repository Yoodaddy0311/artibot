#!/usr/bin/env node
/**
 * Report the recovery journal's DENOMINATOR from the command line: how many
 * `state.recoveryJournal` rows exist across the autopilot session store, and
 * how they split three ways on `divergent`. READ ONLY.
 *
 * V5-BACKLOG §4-b CA-03 **b** asks for "the journal denominator (row count ·
 * divergent ratio) recorded with its timestamp" as the precondition for
 * lifting the CA-03 flip's NO-GO. This file is that recorder's read side and
 * nothing more: it opens no file for writing, creates no directory, and
 * imports no module that would.
 *
 * -- WHY IT LIVES BESIDE THE LEDGER READERS ---------------------------------
 *  Its INPUT is not the ledger — it is the autopilot session store's directory
 *  of `{sessionId}.json` files. It sits here because
 *  `scripts/ledger/verify-call-rate.mjs` is the precedent it copies verb for
 *  verb (read-only, zero denominator prints `null`, a census beside the
 *  number, a writer-import allowlist asserted by the paired test). Read the
 *  `inputPath` field before assuming which store a run described.
 *
 * -- WHY IT DOES NOT IMPORT THE SESSION STORE MODULE ------------------------
 *  That module is the WRITER: the save, delete and artifact-delete entry
 *  points live in it and pull the mutating `node:fs` verbs into scope.
 *  Importing it for its directory listing would put a writer one identifier
 *  away from this reader and break the allowlist the paired test enforces.
 *  The directory is resolved here instead, from `lib/core/platform.js` —
 *  which imports only `node:os`, `node:process`, `node:fs` (`existsSync`
 *  alone), `node:path` and `node:url`, so unlike the precedent's allowlist NO
 *  entry here reaches a writer even transitively (read 2026-09-22). The parse
 *  of each file is a plain `JSON.parse`, not the store's loader, so NO schema
 *  migration runs and an old-schema file is counted exactly as it sits on
 *  disk.
 *
 *  THIS HEADER DELIBERATELY DOES NOT SPELL THE MUTATING FS VERBS OUT. The
 *  paired test's scanner reads the raw bytes of this file, comments included,
 *  and that is the fail-CLOSED direction — a scanner that first stripped
 *  comments could be fooled by a writer smuggled through a form its stripper
 *  mis-parsed. The cost is that prose here must name those verbs indirectly.
 *
 * -- THE STORE DIRECTORY, AND THE ENV PAIR ----------------------------------
 *  The default is `<pluginRoot>/runtime/autopilot`, and the
 *  `ARTIBOT_AUTOPILOT_STORE_DIR` / `ARTIBOT_AUTOPILOT_STORE_DIR_ROOT` pair is
 *  honoured on the SAME terms the session store's own resolver honours it: the
 *  override counts only while the root it was minted for is still the root in
 *  force, because an unpaired override is one we cannot place and "cannot
 *  place" must not mean "trust". A reader that ignored the pair would report a
 *  confident row count for a directory the writer is not writing to. `--dir`
 *  overrules both and is what the tests use.
 *
 * -- THE THREE-WAY SPLIT IS EXHAUSTIVE --------------------------------------
 *  Every row lands in exactly one bucket, so the three always sum to `rows`:
 *    divergentTrue     `row.divergent === true`
 *    divergentFalse    `row.divergent === false`
 *    divergentMissing  everything else — the key absent, `undefined`, `null`,
 *                      the STRINGS `'true'`/`'false'`, a number, or a row that
 *                      is not an object at all.
 *  Strict identity, never coercion: `'false'` is truthy in JavaScript, so a
 *  coercing reader would file a half-written row under `divergentTrue` and
 *  inflate the very number CA-03 is waiting on. The two producers today are
 *  `lib/autopilot/recovery-record.js:345` (the row literal `divergent: true`)
 *  and `lib/autopilot/recovery-transition.js:239` (`row.divergent = false`,
 *  in-place on the same object, only when the gate is ON), and both emit a
 *  real boolean — so a `divergentMissing` above zero is a finding about the
 *  data, not about this rule. Both were re-read at HEAD 3da220c8 on
 *  2026-09-22; neither is touched by this limb.
 *
 * -- `ratio` IS null WHEN THERE ARE NO ROWS ---------------------------------
 *  `rows === 0` prints `ratio: null`, never `{0,0,0}` and never `NaN`: "no
 *  recovery decision has ever been recorded" and "every recorded decision was
 *  non-divergent" are opposite findings, and a dashboard cannot tell them
 *  apart once a zero denominator has been rendered as a number. `status` says
 *  which absence it was — `unmeasured:no-store` (nothing to read, a reading
 *  problem) or `unmeasured:no-journal` (session files exist and not one of
 *  them has a journal).
 *
 * -- STDOUT IS ONE LINE OF JSON; THE HUMAN LINE GOES TO STDERR --------------
 *  A caller can `JSON.parse` stdout blind. The one-line human summary is
 *  written to stderr precisely so it can never land inside that parse.
 *  Fixed stdout key set:
 *    {"ok","reason","inputPath","measuredAt","rows","divergentTrue",
 *     "divergentFalse","divergentMissing","ratio","status","census"}
 *
 * -- EXIT CODES -------------------------------------------------------------
 *  0  a census was printed, OR the store could not be read and stdout says so
 *  2  usage error: the command line itself is wrong, and stdout stays EMPTY
 *  READ `ok` BEFORE TRUSTING AN EXIT 0.
 *
 * -- WHAT THIS READER CANNOT SEE (rules §9 — stated next to the number) ------
 *  - SESSIONS THAT WERE DELETED. The store's delete entry point and the
 *    `runtime/autopilot` pruner remove files; their rows are gone and this
 *    count cannot know they existed. The census reports files, not history.
 *  - A JOURNAL THAT NEVER REACHED DISK. `recovery-record.js` mutates live
 *    state and the CALLER owns persistence, so a crash between the record and
 *    the save loses the row. This is a count of what was SAVED.
 *  - WHETHER A ROW IS TRUE. `divergent: false` is a claim by
 *    `recovery-transition.js`; nothing behind it re-derived the transition.
 *  - THE MEANING OF THE SPLIT WHILE THE GATE IS OFF. With
 *    `autopilot.recovery.transitionFromVerdict` OFF, `false` is unreachable by
 *    construction, so a 100% `divergentTrue` reading is the configuration
 *    speaking, not a behavioural finding. This reader does NOT read that
 *    config — deliberately, since the flag's value TODAY says nothing about
 *    what it was when each historical row was written.
 *  - THE LIVE ANSWER IS `null` TODAY. Measured on this machine's live store
 *    2026-09-22, 6 session files: 0 of them carry a `recoveryJournal` at all,
 *    so `rows` is 0 and `ratio` is `null` — `unmeasured:no-journal`. That is
 *    an absent measurement, not a ratio of zero.
 *  - THE INSTALLED COPY. The tests run the file in this worktree.
 *
 * @module scripts/ledger/recovery-journal-census
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { getPluginRoot, sameDirPath } from '../../lib/core/platform.js';
import { isMainEntry } from '../hooks/_main-entry.js';

/** Flags that take a value. Anything else on the command line is an error. */
const VALUE_FLAGS = ['--dir', '--session'];

const USAGE = 'usage: recovery-journal-census.mjs [--dir <store>] [--session <id>]';

/** The field on a journal row this census splits on. */
const SPLIT_FIELD = 'divergent';

/**
 * Report a usage error on ONE line and nothing else — this stream is read by a
 * model, and a two-line message invites "the rest is noise".
 *
 * @param {string} message
 * @returns {2} the exit code, returned so callers read as `return fail(...)`
 */
function fail(message) {
  process.stderr.write(`recovery-journal-census: ${message} | ${USAGE}\n`);
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
    // A flag with no value is a truncated command line, not an empty string.
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
  if (opts.session !== undefined && opts.session.trim() === '') {
    return '--session must not be empty';
  }
  // A session id is a file STEM here; a separator would reach outside the
  // store and report a number for a file the writer never wrote.
  if (opts.session !== undefined && /[\\/]/.test(opts.session)) {
    return `--session must be a bare session id, got: ${opts.session}`;
  }
  return null;
}

/**
 * The autopilot session store directory this run reads.
 *
 * Mirrors the session store's own `getStoreDir` — see the module header for
 * why the env pair is honoured only together, and why this file does not
 * simply import that function.
 *
 * @param {string|undefined} dirOpt the `--dir` value, which overrules everything
 * @returns {string} absolute directory path
 */
export function resolveStoreDir(dirOpt) {
  if (dirOpt !== undefined) return path.resolve(dirOpt);
  const pluginRoot = getPluginRoot();
  const rootDerived = path.join(pluginRoot, 'runtime', 'autopilot');
  const override = process.env.ARTIBOT_AUTOPILOT_STORE_DIR;
  if (!override) return rootDerived;
  const mintedFor = process.env.ARTIBOT_AUTOPILOT_STORE_DIR_ROOT;
  if (!mintedFor) return rootDerived;
  if (!sameDirPath(mintedFor, pluginRoot)) return rootDerived;
  return path.resolve(override);
}

/**
 * Which bucket this row falls in. Total function: every input returns one of
 * the three names, so the buckets sum to the row count by construction.
 *
 * @param {unknown} row one `state.recoveryJournal` entry, any shape
 * @returns {'divergentTrue'|'divergentFalse'|'divergentMissing'}
 */
export function bucketOf(row) {
  if (row === null || typeof row !== 'object') return 'divergentMissing';
  let value;
  // A hostile accessor on a hand-edited file must not take the whole census
  // down; an unreadable field is an absent field.
  try { value = /** @type {{divergent?: unknown}} */ (row)[SPLIT_FIELD]; } catch { return 'divergentMissing'; }
  if (value === true) return 'divergentTrue';
  if (value === false) return 'divergentFalse';
  return 'divergentMissing';
}

/**
 * The `{sessionId}.json` files this run will open, in directory order.
 *
 * `.events.ndjson` siblings are excluded by the `.json` suffix test alone —
 * they do not end in `.json` — which is the same filter `listSessions` uses.
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
 * Fold the store into counts.
 *
 * A file that cannot be read or parsed is counted in `filesUnparsable` and
 * contributes NO rows — it is not silently treated as an empty journal, which
 * would quietly shrink the denominator CA-03 is waiting on.
 *
 * A `recoveryJournal` that is present but not an array is `filesNonArray`:
 * `recovery-record.js#pushJournal` (:164-166) REPLACES a non-array with a
 * fresh `[]` on the next record, so such a file is a journal about to be
 * discarded, not a journal of length one.
 *
 * @param {string} dir
 * @param {string[]} files
 * @returns {{rows: number, divergentTrue: number, divergentFalse: number,
 *   divergentMissing: number, filesRead: number, filesUnparsable: number,
 *   filesWithJournal: number, filesNonArray: number, bytes: number}}
 */
function collect(dir, files) {
  const tally = {
    rows: 0,
    divergentTrue: 0,
    divergentFalse: 0,
    divergentMissing: 0,
    filesRead: 0,
    filesUnparsable: 0,
    filesWithJournal: 0,
    filesNonArray: 0,
    bytes: 0,
  };
  for (const name of files) {
    const file = path.join(dir, name);
    let parsed;
    try {
      const text = readFileSync(file, 'utf-8');
      tally.bytes += Buffer.byteLength(text, 'utf-8');
      parsed = JSON.parse(text);
    } catch {
      tally.filesUnparsable += 1;
      continue;
    }
    tally.filesRead += 1;
    if (parsed === null || typeof parsed !== 'object') continue;
    const journal = parsed.recoveryJournal;
    if (journal === undefined) continue;
    if (!Array.isArray(journal)) {
      tally.filesNonArray += 1;
      continue;
    }
    tally.filesWithJournal += 1;
    for (const row of journal) {
      tally.rows += 1;
      tally[bucketOf(row)] += 1;
    }
  }
  return tally;
}

/**
 * The three fractions, or `null` when the denominator is zero.
 *
 * @param {{rows: number, divergentTrue: number, divergentFalse: number,
 *   divergentMissing: number}} tally
 * @returns {{divergentTrue: number, divergentFalse: number,
 *   divergentMissing: number}|null}
 */
function ratioOf(tally) {
  if (tally.rows === 0) return null;
  return {
    divergentTrue: tally.divergentTrue / tally.rows,
    divergentFalse: tally.divergentFalse / tally.rows,
    divergentMissing: tally.divergentMissing / tally.rows,
  };
}

/**
 * Which absence this store is in, or `measured`.
 *
 * `no-store` is a READING problem — there is nothing on disk to describe, so
 * the silence says nothing about recovery decisions. `no-journal` is a finding
 * ABOUT recovery decisions: the store is alive and holds none.
 *
 * @param {{present: boolean, readable: boolean}} store
 * @param {{filesRead: number, rows: number}} tally
 * @returns {'measured'|'unmeasured:no-store'|'unmeasured:no-journal'}
 */
function statusOf(store, tally) {
  if (!store.present || !store.readable || tally.filesRead === 0) return 'unmeasured:no-store';
  if (tally.rows === 0) return 'unmeasured:no-journal';
  return 'measured';
}

/**
 * Why no census could be taken, or `null` when one was.
 *
 * @param {{present: boolean, readable: boolean}} store
 * @param {string} dir
 * @returns {string|null}
 */
function storeReason(store, dir) {
  if (!store.present) return `no session store at ${dir}`;
  if (!store.readable) return `session store not readable at ${dir}`;
  return null;
}

/**
 * The one-line human summary. Goes to stderr so stdout stays parseable.
 *
 * @param {object} report the stdout object
 * @returns {string}
 */
function humanLine(report) {
  if (report.rows === 0) {
    return `recovery journal: 0 rows — ratio null (${report.status})`
      + ` | ${report.census.filesRead} file(s) read at ${report.inputPath}`
      + ` | measured ${report.measuredAt}\n`;
  }
  const pct = (n) => `${((n / report.rows) * 100).toFixed(1)}%`;
  return `recovery journal: ${report.rows} rows —`
    + ` divergent true ${report.divergentTrue} (${pct(report.divergentTrue)}),`
    + ` false ${report.divergentFalse} (${pct(report.divergentFalse)}),`
    + ` missing ${report.divergentMissing} (${pct(report.divergentMissing)})`
    + ` | ${report.census.filesWithJournal}/${report.census.filesRead} file(s) carry one`
    + ` at ${report.inputPath} | measured ${report.measuredAt}\n`;
}

/**
 * Take the census. Pure apart from the two fs reads and the clock.
 *
 * @param {{dir?: string, session?: string, now?: string}} [opts]
 * @returns {object} the stdout report, with a FIXED key order
 */
export function census(opts = {}) {
  const dir = resolveStoreDir(opts.dir);
  const measuredAt = opts.now ?? new Date().toISOString();
  const store = listStoreFiles(dir, opts.session);
  const tally = collect(dir, store.files);
  const reason = storeReason(store, dir);
  return {
    ok: reason === null,
    reason,
    inputPath: dir,
    measuredAt,
    rows: tally.rows,
    divergentTrue: tally.divergentTrue,
    divergentFalse: tally.divergentFalse,
    divergentMissing: tally.divergentMissing,
    ratio: ratioOf(tally),
    status: statusOf(store, tally),
    census: {
      storePresent: store.present,
      storeReadable: store.readable,
      filesSeen: store.files.length,
      filesRead: tally.filesRead,
      filesUnparsable: tally.filesUnparsable,
      filesWithJournal: tally.filesWithJournal,
      filesNonArray: tally.filesNonArray,
      bytesRead: tally.bytes,
      sessionFilter: opts.session ?? null,
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
  // `census` catches its own fs errors — but a catch here is what makes "exit
  // 0 unless the command line was wrong" true rather than intended, and a
  // reader that crashed on the store it was measuring would be worse than no
  try {
    process.exitCode = main(argv);
  } catch (err) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      reason: String(err?.message ?? err),
      inputPath: null,
      measuredAt: new Date().toISOString(),
      rows: 0,
      divergentTrue: 0,
      divergentFalse: 0,
      divergentMissing: 0,
      ratio: null,
      status: 'unmeasured:no-store',
      census: null,
    })}\n`);
    process.exitCode = 0;
  }
}
