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
 *  The default is `<state dir>/runtime/autopilot`, where the state dir is what
 *  `lib/core/config.js#resolveArtibotDir` returns (`~/.claude/artibot`, or
 *  `ARTIBOT_STATE_DIR` when paired with the home it was minted for). Until
 *  owner decision D2 (2026-09-30) it was `<pluginRoot>/runtime/autopilot`. The
 *  `ARTIBOT_AUTOPILOT_STORE_DIR` / `ARTIBOT_AUTOPILOT_STORE_DIR_ROOT` pair is
 *  honoured on the SAME terms the session store's own resolver honours it: the
 *  override counts only while the root it was minted for is still the root in
 *  force, because an unpaired override is one we cannot place and "cannot
 *  place" must not mean "trust". A reader that ignored the pair would report a
 *  confident row count for a directory the writer is not writing to. `--dir`
 *  overrules both and is what the tests use.
 *
 *  THE OLD LOCATIONS ARE READ, WITHOUT ADOPTING THEM. The session store copies
 *  what older builds left behind — under the plugin root in force, in every
 *  cached version directory and in the marketplace mirror, never a developer
 *  checkout — into the new store the first time any autopilot process touches
 *  it, and this reader may not (it opens nothing for writing). Until that has
 *  happened the new store is empty while real sessions still sit at the old
 *  places, and a census of the empty one would print `unmeasured:no-store` over
 *  a denominator that exists. So, when no `--dir` was given and no override is
 *  in force, and the new store holds no session file AND has no adoption ledger
 *  beside it (the store has never adopted anything), those directories are read
 *  instead — ONE file per session id, the freshest copy, exactly the choice the
 *  adoption makes — and the report says so: `inputPath` is still the store the
 *  run describes, `census.readFrom` lists the directories the numbers actually
 *  came from and `census.legacyFallback` is true. A store that HAS adopted
 *  (ledger present) is never second-guessed — a session the user deleted must
 *  not reappear in a count. The source list is a mirror of the store's
 *  `getLegacyStoreDirs`; the paired test runs both over the same layouts.
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
 * -- SESSION-BY-SESSION AND WHOLE-STORE IN ONE RUN --------------------------
 *  `census.perSession` is `[{sessionId, rows}, …]`, one entry per file that
 *  carried an array journal, in directory order. Its `rows` sum IS the top
 *  level `rows` — one read of the store at two grains, so the breakdown can
 *  never disagree with the total the way two separate runs could. `--session`
 *  still narrows the whole run to one file when only that file is wanted.
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
 *  - THE OLD LOCATIONS ONCE THE NEW STORE IS NON-EMPTY. The fallback above fires
 *    only for a store with no session file and no ledger. A session an older
 *    build is still running keeps changing at the old place after the new store
 *    has adopted a snapshot of it, and that later state is not in this count.
 *  - FILE TIMES IT NEVER SEES. The freshest-copy choice reads each copy's mtime
 *    through `statSync`, the one read verb beyond the three the paired test
 *    originally pinned; a stamp that cannot be read ranks last.
 *  - THE INSTALLED COPY. The tests run the file in this worktree.
 *
 * @module scripts/ledger/recovery-journal-census
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  getHomeDir, getPluginRoot, normalizeDirPath, sameDirPath,
} from '../../lib/core/platform.js';
import { isMainEntry } from '../hooks/_main-entry.js';

/**
 * The adoption ledger's name — a DIRECTORY of per-id marker files, not one file
 * — and a COPY of `session-store.js`'s `LEGACY_LEDGER_NAME` (this reader may not
 * import the writer module). Its presence beside a store means the store has
 * adopted the old locations; `tests/ledger/recovery-journal-census-store.test.js`
 * asserts the two names stay equal.
 */
export const LEGACY_LEDGER_NAME = 'legacy-migration.ledger';

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
 * The user-state directory — a mirror of `lib/core/config.js#resolveArtibotDir`.
 *
 * That function lives in a module which imports the file-writing helpers, so the
 * reader cannot import it (the allowlist in the paired test is what forbids it);
 * the duplication is the price. The rule is the same pairing rule as the store's
 * own: `ARTIBOT_STATE_DIR` counts only while EVERY home variable that is set
 * still names the home it was minted for (`ARTIBOT_STATE_DIR_HOME`), and an
 * override with no recorded home is one we cannot place. The paired test runs
 * both resolvers through the same decision table so a drift stays red.
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
  const override = process.env.ARTIBOT_AUTOPILOT_STORE_DIR;
  const mintedFor = process.env.ARTIBOT_AUTOPILOT_STORE_DIR_ROOT;
  if (override && mintedFor && sameDirPath(mintedFor, pluginRoot)) return path.resolve(override);
  return path.join(resolveStateDir(), 'runtime', 'autopilot');
}

/**
 * True when `dir` exists and is a directory. A `readdirSync` of a file throws, so
 * no other fs verb is needed to tell the two apart.
 *
 * @param {string} dir
 * @returns {boolean}
 */
function isDirectory(dir) {
  try {
    readdirSync(dir);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} dir
 * @returns {string[]} names of the subdirectories of `dir`; `[]` when it is absent
 */
function subdirectories(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * True when `child` lies strictly inside `parent` (case-insensitive on Windows).
 *
 * @param {string} parent
 * @param {string} child
 * @returns {boolean}
 */
function isInside(parent, child) {
  const p = normalizeDirPath(parent);
  const c = normalizeDirPath(child);
  if (!p || !c) return false;
  const fold = (x) => (process.platform === 'win32' ? x.toLowerCase() : x);
  const rel = path.relative(fold(p), fold(c));
  if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`)) return false;
  return !path.isAbsolute(rel);
}

/**
 * A developer checkout — `<repo>/plugins/artibot` with `<repo>/.git` (a directory,
 * or a FILE in a linked worktree) — whose old store holds the sessions the test
 * suite and the developer's own runs wrote. The marketplace mirror has the same
 * layout and is not one. Mirrors `session-store.js#isDevCheckoutRoot`.
 *
 * @param {string} root a plugin root
 * @param {string} home
 * @returns {boolean}
 */
function isDevCheckoutRoot(root, home) {
  if (path.basename(root) !== 'artibot') return false;
  const plugins = path.dirname(root);
  if (path.basename(plugins) !== 'plugins') return false;
  if (!existsSync(path.join(path.dirname(plugins), '.git'))) return false;
  return !isInside(path.join(home, '.claude', 'plugins', 'marketplaces'), root);
}

/**
 * Newest version first, numerically (4.10.0 is newer than 4.9.0); names that are
 * not versions after every version, by name. Mirrors the store's own ordering.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function compareVersionsDesc(a, b) {
  const va = /^(\d+)\.(\d+)\.(\d+)/.exec(a);
  const vb = /^(\d+)\.(\d+)\.(\d+)/.exec(b);
  if (va && vb) {
    for (let i = 1; i <= 3; i += 1) {
      const diff = Number(vb[i]) - Number(va[i]);
      if (diff !== 0) return diff;
    }
  } else if (va) {
    return -1;
  } else if (vb) {
    return 1;
  }
  if (a === b) return 0;
  return a < b ? 1 : -1;
}

/**
 * Every directory an older build could have left sessions in, in the order the
 * session store's adoption would read them: the plugin root in force, then — for
 * the default state dir only — every cached version newest first, then the
 * marketplace mirrors; existing directories only, each once, never the store
 * itself and never a developer checkout.
 *
 * `[]` when the default store is not the one in use: `--dir` or an honoured
 * override names a store explicitly, and reading others behind it would describe
 * directories nobody asked about. A MIRROR of `session-store.js#getLegacyStoreDirs`
 * (this reader may not import the writer); the paired test runs both over the
 * same fabricated layouts so a drift stays red.
 *
 * @param {string|undefined} dirOpt the `--dir` value
 * @returns {string[]}
 */
export function resolveLegacyStoreDirs(dirOpt) {
  if (dirOpt !== undefined) return [];
  const pluginRoot = getPluginRoot();
  const override = process.env.ARTIBOT_AUTOPILOT_STORE_DIR;
  const mintedFor = process.env.ARTIBOT_AUTOPILOT_STORE_DIR_ROOT;
  if (override && mintedFor && sameDirPath(mintedFor, pluginRoot)) return [];
  const store = resolveStoreDir(undefined);
  const home = getHomeDir();
  const roots = [pluginRoot];
  if (sameDirPath(resolveStateDir(), path.join(home, '.claude', 'artibot'))) {
    const cacheRoot = path.join(home, '.claude', 'plugins', 'cache', 'artibot', 'artibot');
    const marketplaces = path.join(home, '.claude', 'plugins', 'marketplaces');
    roots.push(
      ...subdirectories(cacheRoot).sort(compareVersionsDesc).map((name) => path.join(cacheRoot, name)),
      ...subdirectories(marketplaces).sort().map((name) => path.join(marketplaces, name, 'plugins', 'artibot')),
    );
  }
  const sources = [];
  for (const root of roots) {
    const source = path.join(root, 'runtime', 'autopilot');
    if (isDevCheckoutRoot(root, home) || sameDirPath(source, store)) continue;
    if (!isDirectory(source) || sources.some((seen) => sameDirPath(seen, source))) continue;
    sources.push(source);
  }
  return sources;
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
 * `perSession` carries one entry per file that HAD an array journal, so its
 * `rows` sum equals `rows` by construction — the per-session breakdown and the
 * total are the same measurement read at two grains, never two measurements.
 * A file with no journal contributes no entry (there is nothing to break down)
 * rather than a zero row, which would read as "this session recovered nothing"
 * when the truth is "this session has no journal".
 *
 * @param {{name: string, file: string}[]} entries the `{sessionId}.json` names
 *   and where each is read from — one directory, or several while the old
 *   locations are being read in place of a store that has adopted nothing
 * @returns {{rows: number, divergentTrue: number, divergentFalse: number,
 *   divergentMissing: number, filesRead: number, filesUnparsable: number,
 *   filesWithJournal: number, filesNonArray: number, bytes: number,
 *   perSession: {sessionId: string, rows: number}[]}}
 */
function collect(entries) {
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
    perSession: /** @type {{sessionId: string, rows: number}[]} */ ([]),
  };
  for (const { name, file } of entries) {
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
    let sessionRows = 0;
    for (const row of journal) {
      tally.rows += 1;
      sessionRows += 1;
      tally[bucketOf(row)] += 1;
    }
    tally.perSession.push({ sessionId: name.slice(0, -'.json'.length), rows: sessionRows });
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
  // A reader of the line alone must not take an old-location count for the
  // current store's.
  const where = report.census.legacyFallback
    ? `${report.census.readFrom.join(', ')} (old location(s), not yet adopted)`
    : report.inputPath;
  if (report.rows === 0) {
    return `recovery journal: 0 rows — ratio null (${report.status})`
      + ` | ${report.census.filesRead} file(s) read at ${where}`
      + ` | measured ${report.measuredAt}\n`;
  }
  const pct = (n) => `${((n / report.rows) * 100).toFixed(1)}%`;
  return `recovery journal: ${report.rows} rows —`
    + ` divergent true ${report.divergentTrue} (${pct(report.divergentTrue)}),`
    + ` false ${report.divergentFalse} (${pct(report.divergentFalse)}),`
    + ` missing ${report.divergentMissing} (${pct(report.divergentMissing)})`
    + ` | ${report.census.filesWithJournal}/${report.census.filesRead} file(s) carry one`
    + ` at ${where} | measured ${report.measuredAt}\n`;
}

/**
 * @param {string} file
 * @returns {number} the file's mtime in ms; 0 when it cannot be read, which ranks
 *   last — the file itself is still counted
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
 * FRESHEST copy (latest mtime; a tie goes to the earlier source, the newer
 * directory) — the same choice the session store's adoption makes, because the
 * same id sits in several version directories and a count must describe the copy
 * that would be adopted, not whichever was listed first. Sorted by id.
 *
 * @param {string[]} sources in precedence order
 * @param {string|undefined} session the `--session` narrowing, if any
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
 * nothing — the old locations.
 *
 * The new store has adopted nothing yet when it holds no session file AT ALL
 * (judged without the `--session` narrowing, which would make a populated store
 * look empty) and has no ledger that would say it once did. If the old locations
 * then hold sessions, they are read rather than print `no-store` over a
 * denominator that exists.
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
  const reason = storeReason(store, primary);
  return {
    ok: reason === null,
    reason,
    inputPath: primary,
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
