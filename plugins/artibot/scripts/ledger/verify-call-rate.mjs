#!/usr/bin/env node
/**
 * Report the `/verify` CALL rate from the command line: of the sessions that
 * invoked `/verify`, how many left a self-report behind? READ ONLY.
 *
 * `scripts/ledger/verify-rate.mjs` answers a DIFFERENT question — of the
 * sessions the Stop hook fired in, how many did a self-report answer. Its
 * denominator is the hook; this one's denominator is the CALL. A session that
 * ran `/verify` and never reported is invisible to that reader and is exactly
 * what this one counts. Neither file imports the other and this one changes
 * nothing about it.
 *
 * -- TWO DENOMINATORS, NEVER ADDED TOGETHER ---------------------------------
 *  A `/verify` invocation reaches the ledger through one of two unrelated
 *  writers, and they do not overlap:
 *    intent_command  — `scripts/hooks/runtime-prompt.js#recordSlashCommandInvoked`
 *                      writes ONE `intent.detected` row per USER-TYPED slash
 *                      command, carrying `data.command`.
 *    tool_used_skill — `scripts/hooks/tool-used-record.js` writes one
 *                      `tool.used` row per Skill TOOL call, carrying
 *                      `data.skill`.
 *  The split is DELIBERATE, and the sentence saying so lives on the COMMAND
 *  side, not the skill side: `runtime-prompt.js:704-709` says a Skill-tool
 *  invocation is "deliberately NOT recorded here" because `tool.used.skill`
 *  already carries it "and a second row would double-count one activation".
 *  `tool-used-record.js` says nothing about it (`grep -n "double-count"` there
 *  returns nothing, read 2026-09-21).
 *  Summing them would therefore double nothing and divide two populations by
 *  each other's totals, so there is NO combined rate here. Each carrier gets
 *  its own `rows`, its own denominator and its own `status`, and a caller that
 *  wants one number has to say which question it is asking.
 *
 * -- WHAT COUNTS AS A `/verify` CALL ----------------------------------------
 *  The value is trimmed, a leading `/` is removed, and the token after the
 *  LAST `:` must be exactly `verify`. The namespaced spelling is real on the
 *  skill side: measured on this machine's live ledger 2026-09-21 17:56 KST,
 *  the 4 `tool.used` rows carry `artibot:save` twice, `split` once and
 *  `artibot:split` once — both shapes coexist.
 *
 *  ON THE COMMAND SIDE THE COLON BRANCH IS UNREACHABLE, and that is a
 *  correction rather than a guess: `lib/mission/mission-id.js#detectSlashCommand`
 *  (:142-143) matches `/^([a-z][a-z0-9_-]{0,31})(?=\s|$)/i` — note the `i`
 *  flag — against the prompt with its leading `/` removed, and LOWERCASES the
 *  capture before returning it. `:` satisfies neither `\s` nor end-of-input,
 *  so `/artibot:verify` returns null and NO `intent.detected` row is written
 *  at all. The same rule is applied to both carriers anyway: a rule that is
 *  correct and inert costs nothing, and a second writer someday emitting a
 *  namespaced command would otherwise be silently missed.
 *
 *  THE MATCH IS CASE-SENSITIVE AND NAMESPACE-BLIND. Any prefix is accepted —
 *  `anything:verify` counts — because this reader has no roster of legitimate
 *  namespaces to check against, and inventing one would drop a real call the
 *  day a second plugin ships. `Verify` with a capital is MISSED: the `i` flag
 *  and `toLowerCase` above are the COMMAND writer's, so an `intent.detected`
 *  row is already lowercase by the time it lands, but `data.skill` is only
 *  trimmed by `tool-used-record.js` and reaches this reader as the host spelled
 *  it.
 *
 * -- ONE READ, AND WHY NO `event` FILTER ------------------------------------
 *  `readLedgerCensus` takes a SINGLE `event` string, so asking it for three
 *  event names would mean three reads and three censuses describing three
 *  different moments. The ledger is read ONCE with only the caller's
 *  `--session`/`--since` selection, and the events are separated in memory.
 *  The printed census therefore describes that one read, and `survivors` can
 *  be compared against `lines.nonblank` for the whole file.
 *
 * -- IT WRITES NOTHING ------------------------------------------------------
 *  Same contract as its sibling: no writer import, no file opened for writing,
 *  no directory created. `tests/ledger/verify-call-rate.test.js` asserts the
 *  import set as an ALLOWLIST of three specifiers, feeds the same scanner a
 *  fabricated writing source to prove the scanner can go red, and captures the
 *  ledger's bytes, size, mtime and directory listing around a real spawn.
 *
 * -- EXIT CODES -------------------------------------------------------------
 *  0  a rate was printed, OR the ledger could not be read and stdout says so
 *  2  usage error: the command line itself is wrong, and NOTHING was printed
 *  READ `ok` BEFORE TRUSTING AN EXIT 0, for the reason `verify-rate.mjs:43-46`
 *  gives.
 *
 * -- STDOUT -----------------------------------------------------------------
 *  One line of JSON with a FIXED key set:
 *    {"ok","reason","file","call_rate","census"}
 *  A `rate` of `null` means the denominator was ZERO and is never `0` or
 *  `NaN`: "nobody called `/verify`" and "everybody who called it stayed
 *  silent" are opposite findings. `status` says which of the two absences it
 *  was — `unmeasured:no-carrier` (the writer produced nothing at all, so this
 *  is a reading problem) or `unmeasured:no-verify-call` (the writer is alive
 *  and `/verify` was not called).
 *
 * -- WHAT THIS READER CANNOT SEE (rules §9 — stated next to the number) ------
 *  - ORDER. The join is at SESSION level only. A self-report that landed
 *    BEFORE the `/verify` call in the same session counts as an answer here.
 *    `verify-rate.mjs` has a time-ordered firing rate; this one does not.
 *  - WHETHER THE CARRIER WAS ALIVE. "The hook existed in that session" is
 *    inferred from "that session has at least one carrier row", which is an
 *    approximation: a session that called `/verify` as its only command and
 *    whose hook was broken produces no row and is counted in NEITHER
 *    denominator. Both rates therefore describe sessions the carrier was
 *    demonstrably writing in. A Skill row that LOST its `skill` key is the
 *    same blind spot from the other direction: `tool-used-record.js` omits the
 *    key rather than writing null when the name is unknown, and the envelope's
 *    byte cap can drop it too, so such a row is not a carrier row here and its
 *    session can be classified `unmeasured:no-carrier` although the hook did
 *    fire in it.
 *  - A `/verify` REACHED ANY OTHER WAY. Neither a slash command nor a Skill
 *    tool call — a sub-agent, a script, a direct module import — writes either
 *    carrier, and none of it appears here.
 *  - WHETHER A SELF-REPORT IS TRUE. `--status PASS` is a claim; nothing behind
 *    it ran a linter. `lib/verification/verify-rate.js` says the same.
 *  - THE LIVE ANSWER IS `null` ON BOTH CARRIERS TODAY. Measured on this
 *    machine's live ledger 2026-09-21 17:56 KST, 9,591 lines: 11
 *    `intent.detected` rows (split 3, resume 2, team 2, autopilot 1, save 1,
 *    scorecard 1, update 1) and 4 `tool.used` Skill rows, and NOT ONE names
 *    `verify`. So both denominators are 0 and both rates read `null`. That is
 *    an absent measurement, not a rate of zero, and not a trend.
 *  - UPSTREAM LOSS, except through the census printed beside the rate.
 *  - THE INSTALLED COPY. The tests run the file in this worktree.
 *
 * @module scripts/ledger/verify-call-rate
 */

import { readLedgerCensus } from '../../lib/runtime/ledger.js';
import { isSelfReportLine, VERIFY_COMPLETED_EVENT } from '../../lib/verification/verify-rate.js';
import { isMainEntry } from '../hooks/_main-entry.js';

/** Flags that take a value. Anything else on the command line is an error. */
const VALUE_FLAGS = ['--cwd', '--session', '--since'];

const USAGE = 'usage: verify-call-rate.mjs [--cwd <root>] [--session <id>] [--since <iso>]';

/** The command carrier: one row per user-typed slash command. */
const INTENT_EVENT = 'intent.detected';

/** The skill carrier: one row per Skill tool call. */
const TOOL_USED_EVENT = 'tool.used';

/** The bare command name a `/verify` call reduces to. */
const VERIFY_NAME = 'verify';

/**
 * Report a usage error on ONE line and nothing else — this stream is read by a
 * model, and a two-line message invites "the rest is noise".
 *
 * @param {string} message
 * @returns {2} the exit code, returned so callers read as `return fail(...)`
 */
function fail(message) {
  process.stderr.write(`verify-call-rate: ${message} | ${USAGE}\n`);
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
 * @param {{file: {present: boolean, readable: boolean, path: string|null}}} census
 * @returns {string|null}
 */
function censusReason(census) {
  if (census.file.present === false) return `no ledger at ${census.file.path}`;
  if (census.file.readable === false) return `ledger not readable at ${census.file.path}`;
  return null;
}

/**
 * Is this carrier value a `/verify` call?
 *
 * @param {unknown} value `data.command` or `data.skill`
 * @returns {boolean}
 */
function isVerifyCall(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  const bare = trimmed.startsWith('/') ? trimmed.slice(1) : trimmed;
  return bare.slice(bare.lastIndexOf(':') + 1) === VERIFY_NAME;
}

/**
 * The line's session, or `null` when it has none to join on.
 *
 * A non-string is `null` rather than coerced: pooling unjoinable lines under
 * one key would let two unrelated sessions answer each other, which is the
 * failure `lib/verification/verify-rate.js`'s header rules out by name.
 *
 * @param {{session_id?: unknown}} event
 * @returns {string|null}
 */
function sessionOf(event) {
  return typeof event.session_id === 'string' && event.session_id !== ''
    ? event.session_id
    : null;
}

/**
 * The carrier value this row carries, or `undefined` when the row is not a
 * carrier row at all.
 *
 * @param {{event?: unknown, data?: unknown}} event
 * @returns {unknown}
 */
function intentValue(event) {
  if (event.event !== INTENT_EVENT) return undefined;
  const command = /** @type {{command?: unknown}} */ (event.data ?? {})?.command;
  return typeof command === 'string' ? command : undefined;
}

/**
 * @param {{event?: unknown, data?: unknown}} event
 * @returns {unknown}
 */
function skillValue(event) {
  if (event.event !== TOOL_USED_EVENT) return undefined;
  const data = /** @type {{tool?: unknown, skill?: unknown}} */ (event.data ?? {});
  if (data.tool !== 'Skill') return undefined;
  return typeof data.skill === 'string' ? data.skill : undefined;
}

/**
 * Fold one carrier's rows into raw counts and session sets.
 *
 * @param {object[]} events
 * @param {(event: object) => unknown} valueOf
 * @returns {{rows: number, verifyRows: number, sessions: Set<string>,
 *            verifySessions: Set<string>}}
 */
function collectCarrier(events, valueOf) {
  const sessions = new Set();
  const verifySessions = new Set();
  let rows = 0;
  let verifyRows = 0;
  for (const event of events) {
    if (event === null || typeof event !== 'object') continue;
    const value = valueOf(event);
    if (value === undefined) continue;
    rows += 1;
    const verify = isVerifyCall(value);
    if (verify) verifyRows += 1;
    const session = sessionOf(event);
    if (session === null) continue;
    sessions.add(session);
    if (verify) verifySessions.add(session);
  }
  return { rows, verifyRows, sessions, verifySessions };
}

/**
 * The distinct `(session_id, verification_id)` pairs a self-report produced.
 *
 * The grouping key matches `lib/verification/verify-rate.js#groupById` byte for
 * byte — `\0` separator, sessionless spelled as the empty session — so
 * `self_report.pairs` equals that module's `ids.self_report` on the same
 * input. The test asserts the equality rather than trusting this sentence.
 *
 * @param {object[]} events
 * @returns {{pairs: Set<string>, sessionless: Set<string>, sessions: Set<string>}}
 */
function collectSelfReport(events) {
  const pairs = new Set();
  const sessionless = new Set();
  const sessions = new Set();
  for (const event of events) {
    if (event === null || typeof event !== 'object') continue;
    if (event.event !== VERIFY_COMPLETED_EVENT || !isSelfReportLine(event)) continue;
    const id = /** @type {{verification_id?: unknown}} */ (event.data ?? {})?.verification_id;
    if (typeof id !== 'string' || id === '') continue;
    const session = sessionOf(event);
    pairs.add(`${session ?? ''}\0${id}`);
    if (session === null) sessionless.add(`${session ?? ''}\0${id}`);
    else sessions.add(session);
  }
  return { pairs, sessionless, sessions };
}

/**
 * Which absence this carrier is in, or `measured`.
 *
 * `rows === 0` is a READING problem — nothing wrote this carrier, so its
 * silence says nothing about `/verify`. A live carrier with no verify call is
 * a finding about `/verify`. Collapsing the two into one `null` rate would
 * hide which of them it was.
 *
 * `status` IS JUDGED ON `verify_sessions`, NOT ON `verify_rows`, because the
 * denominator is a session count. A ledger whose verify rows are ALL
 * sessionless therefore reads `unmeasured:no-verify-call` while `verify_rows`
 * is above zero — not a contradiction, but read the two fields together
 * before concluding nobody called `/verify`.
 *
 * @param {{rows: number, verifySessions: Set<string>}} raw
 * @returns {'measured'|'unmeasured:no-carrier'|'unmeasured:no-verify-call'}
 */
function statusOf(raw) {
  if (raw.rows === 0) return 'unmeasured:no-carrier';
  if (raw.verifySessions.size === 0) return 'unmeasured:no-verify-call';
  return 'measured';
}

/**
 * One carrier's report, with a FIXED key order.
 *
 * @param {{rows: number, verifyRows: number, sessions: Set<string>,
 *          verifySessions: Set<string>}} raw
 * @param {Set<string>} selfReportSessions
 * @returns {object}
 */
function carrierReport(raw, selfReportSessions) {
  const split = { with_verify_call: 0, without_verify_call: 0, 'unmeasured:no-carrier': 0 };
  for (const session of selfReportSessions) {
    if (raw.verifySessions.has(session)) split.with_verify_call += 1;
    else if (raw.sessions.has(session)) split.without_verify_call += 1;
    else split['unmeasured:no-carrier'] += 1;
  }
  const denominator = raw.verifySessions.size;
  let answered = 0;
  for (const session of raw.verifySessions) {
    if (selfReportSessions.has(session)) answered += 1;
  }
  return {
    rows: raw.rows,
    sessions: raw.sessions.size,
    verify_rows: raw.verifyRows,
    verify_sessions: denominator,
    answered_sessions: answered,
    // Never `NaN` and never `0`: a `0/0` printed as a number reads to a
    // dashboard as a measured absence of reporting.
    rate: denominator === 0 ? null : answered / denominator,
    status: statusOf(raw),
    self_report_sessions: split,
  };
}

/**
 * The whole `call_rate` object, with a FIXED key order.
 *
 * @param {object[]} events one read's survivors, of every event kind
 * @returns {object}
 */
function computeCallRate(events) {
  const list = Array.isArray(events) ? events : [];
  const self = collectSelfReport(list);
  return {
    self_report: {
      pairs: self.pairs.size,
      sessions: self.sessions.size,
      sessionless_pairs: self.sessionless.size,
    },
    carriers: {
      intent_command: carrierReport(collectCarrier(list, intentValue), self.sessions),
      tool_used_skill: carrierReport(collectCarrier(list, skillValue), self.sessions),
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

  // NO `event` filter — see the module header. One read, one census.
  const filter = {};
  if (opts.session !== undefined) filter.session_id = opts.session;
  if (opts.since !== undefined) filter.since = opts.since;

  const { events, census } = readLedgerCensus(opts.cwd || process.cwd(), filter);
  const reason = censusReason(census);

  process.stdout.write(`${JSON.stringify({
    ok: reason === null,
    reason,
    file: census.file.path,
    call_rate: computeCallRate(events),
    census,
  })}\n`);
  return 0;
}

if (isMainEntry(import.meta.url)) {
  const [, , ...argv] = process.argv;
  // `computeCallRate` never throws and `readLedgerCensus` catches its own fs
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
      call_rate: computeCallRate([]),
      census: null,
    })}\n`);
    process.exitCode = 0;
  }
}
