#!/usr/bin/env node
/**
 * Print the per-model usage and cost table — "which model actually served, how
 * many sessions and spawns, how many tokens, what did that come to" — from a
 * project's central ledger, for a leader to attach to a completion report.
 *
 * Before this script the numbers existed but nobody was shown them: the
 * `usage.receipt` rows (`scripts/hooks/session-end.js`), `/scorecard --compare`
 * (recommended vs served model, cost buckets) and `/model-routing validate
 * --live` (per-agent honoured/unhonoured) each answer a different question and
 * each had to be asked for. `commands/team.md`, `commands/autopilot.md` and
 * `commands/split.md` now tell the leader to run this at the end of a run.
 *
 * READ-ONLY — ENFORCED BY WHAT IS NOT IMPORTED. `lib/runtime/ledger.js#readLedgerCensus`
 * is the only ledger function reached from here; the append function is
 * deliberately NOT imported, so there is no spelling of this file that adds a
 * line, and no `node:fs` write function is imported either. A measuring tool
 * that appends to the stream it measures is its own next data point.
 *
 * THE ARITHMETIC IS NOT HERE. `lib/economics/usage-table.js#foldUsageTable` owns
 * every count and `lib/economics/usage-table-render.js` owns the wording; both
 * are pure. This file is the impure shell: it reads the ledger, reads a
 * transcript when asked, reads the clock once for `measured_at`, and prints.
 *
 * USAGE
 *   node scripts/ledger/usage-cost-table.mjs [--cwd <projectRoot>] [--ledger <file>]
 *        [--since <iso | epoch-ms (all digits)>] [--session <id[,id...]>] [--run <id[,id...]>]
 *        [--live-session <id>] [--projects-dir <dir>] [--json]
 *
 *   Where the ledger is. Default: the project's central ledger, resolved from
 *   `--cwd` (default: the process cwd) by the shared store rule — the git
 *   common dir's `artibot/ledger.jsonl`, so every linked worktree reads the SAME
 *   file. `--ledger <file>` names a ledger file directly (a copy, a backup); it
 *   is read as given and `--cwd` is then not consulted. `ledger_path` is on the
 *   output for exactly this reason: an empty table and a table of the WRONG tree
 *   are told apart only by the path. THE GLOBAL INSTALL IS THE TRAP — Artibot
 *   also lives under the user's `.claude` directory, and running the installed
 *   copy from an unrelated directory reads whatever project the shell was in.
 *
 *   Filters (all optional; without any, the table covers the whole ledger):
 *     --since   keep runs that STARTED at or after this instant (`timing.started_at`,
 *               not the row's write time — see usage-table.js FILTERS). An
 *               all-digit value is EPOCH MILLISECONDS, never a year: `--since 2026`
 *               would otherwise cut at 1970-01-01T00:00:02.026Z, so spell a year as ISO.
 *     --session session ids; a comma list, and the flag may repeat.
 *     --run     run ids (`agent-<id>`, or the bare agent id a `route.bound` row
 *               carries); a comma list, and the flag may repeat.
 *
 *   `--live-session <id>` — READ A SESSION THAT HAS NOT ENDED. Receipts reach
 *   the ledger only when SessionEnd fires, so the session producing a report, and
 *   every spawn inside it, is absent from the ledger (measured 2026-09-30T02:17Z:
 *   the running session had 342 ledger rows of other events and 0 `usage.receipt`
 *   rows). With this flag the session's transcript (`<projects>/<slug>/<id>.jsonl`
 *   plus its `subagents/` directory) is folded straight into receipts by the same
 *   builder SessionEnd uses, and REPLACES that session's ledger rows rather than
 *   adding to them. It records nothing: when the session ends, SessionEnd writes
 *   the ledger row as before. The id is passed explicitly and the script reads NO
 *   environment variable — the caller expands `${CLAUDE_SESSION_ID:-$CLAUDE_CODE_SESSION_ID}`.
 *   A BLANK id (an empty expansion) is not a usage error: the table is printed
 *   without it and says so. `--projects-dir` overrides `~/.claude/projects`.
 *
 *   `--json` prints one line of JSON instead of markdown.
 *
 * -- EXIT CODES, AND WHY ONLY ONE IS NON-ZERO -------------------------------
 *  0  an observation was made and printed — INCLUDING a missing ledger, an
 *     unreadable ledger, an empty ledger, a live session that could not be found,
 *     and an unexpected throw. "There is no ledger" is a finding about the
 *     project, not a failure of this script.
 *  2  usage error: the command line itself is wrong (unknown flag, flag without
 *     a value, a blank `--cwd`/`--ledger`/`--session`/`--run`, `--since` that
 *     does not parse). One line on stderr prefixed `usage-cost-table:`, NOTHING
 *     on stdout. A blank filter is refused rather than skipped: printing the
 *     whole ledger under a command that asked for one session would answer a
 *     question nobody asked. Same precedent as `route-compare.mjs`.
 *
 * -- STDOUT -----------------------------------------------------------------
 *  Markdown (default): the table and the caveat lines, exactly as
 *  `usage-table-render.js` produces them, plus a final newline.
 *  `--json`: ONE line, a FIXED key set in a FIXED order, so a caller can parse
 *  it without branching:
 *    {"event","measured_at","ledger_path","filter","live","receipts","rows",
 *     "total","by_kind","pricing","census"}
 *  `total` is null — never a row of zeros — when nothing was counted. `live` is
 *  null unless `--live-session` was given. `error` is the ONE optional key,
 *  present only when an unexpected throw was caught; the fold's fields then carry
 *  their empty values and `census` is null.
 *
 * -- WHAT THIS CANNOT SEE ---------------------------------------------------
 *  - A SESSION THAT HAS NOT ENDED, other than the one named by `--live-session`.
 *    Open `/split` worker windows are absent until their own SessionEnd.
 *  - WHETHER THE COST IS WHAT ANYONE PAID. It is measured tokens x the catalog's
 *    list price (`usage-table.js` COST); a subscription bills nothing per token.
 *  - A RESUMED SESSION'S PRE-RESUME PART, if the host rewrote its transcript.
 *    The live read trusts the transcript as it is on disk now.
 *  - WHETHER THE HOST'S SESSION ID IS THE TRANSCRIPT STEM. The locator matches
 *    `<projects>/*` + `/<id>.jsonl`; measured on this host, not guaranteed.
 *  - THE INSTALLED COPY. This file measures the ledger, not itself.
 *
 * @module scripts/ledger/usage-cost-table
 */

import { existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildUsageReceipts } from '../../lib/economics/usage-receipt.js';
import { toUsageReceiptEnvelopes, USAGE_RECEIPT_EVENT } from '../../lib/economics/receipt-envelope.js';
import { foldUsageTable, mergeLiveEvents } from '../../lib/economics/usage-table.js';
import { formatUsageTableMarkdown } from '../../lib/economics/usage-table-render.js';
import { readLedgerCensus } from '../../lib/runtime/ledger.js';
import { isMainEntry } from '../hooks/_main-entry.js';

/** Flags that take a value. Anything else on the command line is an error. */
const VALUE_FLAGS = ['--cwd', '--ledger', '--since', '--session', '--run', '--live-session', '--projects-dir'];

/** Flags that take no value. */
const BOOLEAN_FLAGS = ['--json'];

/** Value flags that may repeat and carry comma lists. */
const LIST_FLAGS = ['--session', '--run'];

/**
 * A session id this script will look for on disk. It must start with a letter
 * or digit and contain only `[A-Za-z0-9._-]`: an id is turned into a path
 * segment, so anything with a separator, a space or a leading dot could point
 * outside the projects directory.
 */
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const USAGE = 'usage: usage-cost-table.mjs [--cwd <projectRoot>] [--ledger <file>] [--since <iso | epoch-ms (all digits)>]'
  + ' [--session <id[,id...]>] [--run <id[,id...]>] [--live-session <id>] [--projects-dir <dir>] [--json]';

/**
 * Report a usage error on ONE line and nothing else. One line, always: this
 * stream is read by a model, and a two-line message invites "the first line is
 * the error, the rest is noise".
 *
 * @param {string} message
 * @returns {2} the exit code, returned so callers read as `return fail(...)`
 */
function fail(message) {
  process.stderr.write(`usage-cost-table: ${message} | ${USAGE}\n`);
  return 2;
}

/**
 * Parse the argument list into an option bag.
 *
 * @param {string[]} argv arguments after the script path
 * @returns {{opts: object}|{error: string}}
 */
function parseArgs(argv) {
  const opts = { session: [], run: [], json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (BOOLEAN_FLAGS.includes(flag)) {
      opts[flag.slice(2)] = true;
      continue;
    }
    if (!VALUE_FLAGS.includes(flag)) return { error: `unknown argument: ${flag}` };
    // A flag with no value is an error rather than an empty string: `--since` at
    // the end of the line is a truncated command, not a cutoff of "".
    if (i + 1 >= argv.length) return { error: `${flag} requires a value` };
    const value = argv[i + 1];
    i += 1;
    if (LIST_FLAGS.includes(flag)) opts[flag.slice(2)].push(value);
    else opts[flag.slice(2)] = value;
  }
  return { opts };
}

/**
 * Resolve `--since` to epoch milliseconds, or null when it is not a time.
 *
 * Epoch milliseconds are handled BEFORE `Date.parse`, not after: `Date.parse` of
 * an all-digit string reads it as a year-or-worse rather than as a stamp, so a
 * plain `Date.parse` would silently accept `1757000000000` as some other instant.
 *
 * @param {string} raw
 * @returns {number|null}
 */
function toEpochMs(raw) {
  const text = String(raw).trim();
  if (text === '') return null;
  const ms = /^-?\d+$/.test(text) ? Number(text) : Date.parse(text);
  return Number.isFinite(ms) && !Number.isNaN(new Date(ms).getTime()) ? ms : null;
}

/** A comma list flattened, trimmed, without empty entries. */
const idList = (values) => values.flatMap((v) => v.split(',')).map((s) => s.trim()).filter((s) => s !== '');

/**
 * Validate everything that can be validated before any read, and turn the
 * option bag into the request the run needs.
 *
 * @param {object} opts
 * @returns {{request: object}|{error: string}}
 */
function validate(opts) {
  for (const name of ['cwd', 'ledger', 'projects-dir']) {
    if (opts[name] !== undefined && opts[name].trim() === '') return { error: `--${name} is blank` };
  }
  const request = { json: opts.json, live: opts['live-session'], sessionIds: null, runIds: null, sinceMs: null };
  for (const [flag, key] of [['session', 'sessionIds'], ['run', 'runIds']]) {
    if (opts[flag].length === 0) continue;
    const ids = idList(opts[flag]);
    if (ids.length === 0) return { error: `--${flag} is blank (give one or more ids, comma separated)` };
    request[key] = ids;
  }
  if (opts.since !== undefined) {
    request.sinceMs = toEpochMs(opts.since);
    if (request.sinceMs === null) {
      return { error: `--since must be an ISO timestamp or epoch ms, got: ${opts.since}` };
    }
  }
  request.ledger = opts.ledger === undefined ? null : path.resolve(opts.ledger);
  request.cwd = path.resolve(opts.cwd ?? process.cwd());
  request.projectsDir = path.resolve(opts['projects-dir'] ?? path.join(os.homedir(), '.claude', 'projects'));
  return { request };
}

/**
 * Read the ledger's `usage.receipt` lines.
 *
 * An explicit `--ledger` is read as `dirname` + `basename`: the reader joins an
 * explicit path onto the root it is given, so handing it the file's own
 * directory and name lands on exactly that file for any absolute path.
 *
 * @param {object} request
 * @returns {{events: object[], census: object}}
 */
function readLedger(request) {
  if (request.ledger === null) return readLedgerCensus(request.cwd, { event: USAGE_RECEIPT_EVENT });
  return readLedgerCensus(path.dirname(request.ledger), {
    event: USAGE_RECEIPT_EVENT,
    ledgerPath: path.basename(request.ledger),
  });
}

/**
 * The transcript of a session: the first `<projects>/<dir>/<id>.jsonl` that
 * exists, directories in sorted order so the answer does not depend on listing
 * order. Null when there is none or the projects directory cannot be listed.
 *
 * @param {string} projectsDir
 * @param {string} sessionId - already checked against {@link SESSION_ID_RE}.
 * @returns {string|null}
 */
function findTranscript(projectsDir, sessionId) {
  let dirs;
  try {
    dirs = readdirSync(projectsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return null;
  }
  for (const dir of dirs) {
    const candidate = path.join(projectsDir, dir, `${sessionId}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** The `live` block for a request that never reached a transcript. */
function liveInfo(sessionId, status, extra = {}) {
  return {
    requested: true,
    status,
    session_id: sessionId,
    transcript_path: null,
    files: 0,
    receipts: 0,
    replaced_ledger_receipts: 0,
    unresolved_models: [],
    searched: null,
    ...extra,
  };
}

/**
 * Fold the current session's transcript into receipt envelopes.
 *
 * @param {object} request
 * @returns {Promise<{info: object|null, events: object[]}>} `info` is null when
 *   `--live-session` was not given.
 */
async function collectLive(request) {
  if (request.live === undefined) return { info: null, events: [] };
  const sessionId = request.live.trim();
  if (sessionId === '') return { info: liveInfo('', 'blank-session-id'), events: [] };
  if (!SESSION_ID_RE.test(sessionId)) return { info: liveInfo(sessionId, 'invalid-session-id'), events: [] };

  const transcriptPath = findTranscript(request.projectsDir, sessionId);
  if (transcriptPath === null) {
    return { info: liveInfo(sessionId, 'not-found', { searched: request.projectsDir }), events: [] };
  }
  let built;
  try {
    // The mission id is a stamp the builder requires and this table never reads.
    built = await buildUsageReceipts({ transcriptPath, missionId: sessionId });
  } catch {
    return { info: liveInfo(sessionId, 'read-failed', { transcript_path: transcriptPath }), events: [] };
  }
  const receipts = Array.isArray(built?.receipts) ? built.receipts : [];
  const unreadable = built?.meta?.unreadableFiles ?? 0;
  let status = 'ok';
  if (receipts.length === 0) status = unreadable > 0 ? 'read-failed' : 'empty';
  return {
    info: liveInfo(sessionId, status, {
      transcript_path: transcriptPath,
      files: built?.meta?.files ?? 0,
      receipts: receipts.length,
      unresolved_models: Object.keys(built?.meta?.unresolvedModels ?? {}).sort(),
    }),
    events: toUsageReceiptEnvelopes(receipts, { sessionId }),
  };
}

/** `ok` | `missing` | `unreadable`, from the reader's census. */
function ledgerState(census) {
  if (!census.file.present) return 'missing';
  return census.file.readable ? 'ok' : 'unreadable';
}

/**
 * The stdout object, picking each fold field BY NAME. Picked rather than
 * spread on purpose: the fold is another module's shape and may grow a field,
 * while this script's stdout contract promises a fixed key set.
 *
 * @param {object} parts
 * @returns {object}
 */
function report(parts) {
  const { table } = parts;
  const out = {
    event: table.event,
    // The one clock read in this pipeline. The fold and the renderer are pure and
    // may not read a clock, so a timestamp on the result comes from the shell.
    measured_at: parts.measuredAt,
    ledger_path: parts.ledgerPath,
    filter: table.filter,
    live: parts.live,
    receipts: table.receipts,
    rows: table.rows,
    total: table.total,
    by_kind: table.by_kind,
    pricing: table.pricing,
    census: parts.census,
  };
  if (parts.error !== undefined) out.error = parts.error;
  return out;
}

/**
 * Measure: read, fold, and return what the two output modes need.
 *
 * @param {object} request
 * @param {string} measuredAt
 * @returns {Promise<{printed: object, markdown: string}>}
 */
async function measure(request, measuredAt) {
  const { events, census } = readLedger(request);
  const live = await collectLive(request);
  const merged = mergeLiveEvents(events, live.events);
  if (live.info !== null) live.info.replaced_ledger_receipts = merged.replaced;

  const table = foldUsageTable(merged.events, {
    sessionIds: request.sessionIds,
    runIds: request.runIds,
    since: request.sinceMs,
  });
  const ledgerPath = census.file.path;
  return {
    printed: report({ table, measuredAt, ledgerPath, live: live.info, census }),
    markdown: formatUsageTableMarkdown(table, {
      measuredAt, ledgerPath, ledgerState: ledgerState(census), live: live.info,
    }),
  };
}

/**
 * Run the script.
 *
 * `deps.now` is the one injection seam (a `Date`-returning function); nothing
 * else reaches the clock.
 *
 * @param {string[]} argv arguments after the script path
 * @param {{now?: () => Date}} [deps]
 * @returns {Promise<number>} process exit code
 */
export async function main(argv, deps = {}) {
  const parsed = parseArgs(argv);
  if (parsed.error !== undefined) return fail(parsed.error);
  const checked = validate(parsed.opts);
  if (checked.error !== undefined) return fail(checked.error);
  const { request } = checked;

  const measuredAt = (deps.now ?? (() => new Date()))().toISOString();
  let result;
  try {
    result = await measure(request, measuredAt);
  } catch (err) {
    // An unexpected throw is still an observation outcome, not a usage error:
    // the caller asked a well-formed question and deserves a parseable answer
    // saying the measurement could not be taken.
    const message = err?.message ?? String(err);
    result = {
      printed: report({
        table: foldUsageTable([]), measuredAt, ledgerPath: null, live: null, census: null, error: message,
      }),
      markdown: `**모델별 사용량·비용** — 표를 만들지 못했다: ${message}`,
    };
  }
  process.stdout.write(request.json ? `${JSON.stringify(result.printed)}\n` : `${result.markdown}\n`);
  return 0;
}

if (isMainEntry(import.meta.url)) {
  const [, , ...argv] = process.argv;
  // `main` already converts a throw into a printed line, so the rejection handler
  // only covers a failure of the printing itself (a closed stdout). Exit 0 either
  // way: reading a number must never fail the caller's step.
  main(argv).then(
    (code) => { process.exitCode = code; },
    () => { process.exitCode = 0; },
  );
}
