#!/usr/bin/env node
/**
 * Divide "what the topology router RECOMMENDED" by "what the session ACTUALLY
 * spawned", post hoc, from two ledgers that were written by two hooks that
 * cannot see each other. READ ONLY.
 *
 * `lib/topology/topology-router.js#routeTopology` runs in OBSERVE mode: it
 * recommends a topology and routes nothing, and the recommendation is recorded
 * as a `topology-recommended` row in the decisions store. What the session then
 * did is in a different file — the spawn ledger, written by the Subagent
 * hooks. Nothing has ever divided one by the other, and this is that division.
 * Every count here is derived after the fact from rows neither store wrote for
 * this purpose, so read the CANNOT-SEE list at the bottom before reading a
 * number out of the top.
 *
 * -- THE TWO INPUTS, AND THE ONE KEY THAT JOINS THEM ------------------------
 *  1. `<projectRoot>/.artibot/runtime/decisions/*.events.ndjson`, located via
 *     `lib/observability/decision-events.js#getDecisionStoreDir`. Rows of
 *     `type === 'topology-recommended'` (TR below) carry `data.mode`, one of
 *     `lib/topology/topology-router.js#TOPOLOGY_MODES`.
 *  2. `<git-common-dir>/artibot/spawns.ndjson`, read through
 *     `lib/learning/ledger/spawn-ledger.js#readSpawns`.
 *
 *  The join key is `sessionId` — the same host `session_id` in both stores.
 *  NEITHER WRITER IMPORT IS REACHED FROM HERE: `recordTopologyRecommended` and
 *  `appendSpawn` are deliberately absent, so there is no spelling of this file
 *  that appends a line. A measuring tool that writes to the stream it measures
 *  is its own next data point; `tests/ledger/topology-agreement.test.js`
 *  asserts both files' byte lengths across a run rather than trusting this
 *  paragraph.
 *
 * -- HOW A WINDOW IS BUILT --------------------------------------------------
 *  Per session, TR rows are sorted by `ts` and window `i` is
 *  `[TR_i.ts, TR_{i+1}.ts)`. The LAST window of a session has no upper bound,
 *  is flagged `open`, and is counted in `open_windows`: its spawns may still be
 *  coming, so an open window that reads as agreement may simply be early.
 *  The numerator of a window is the count of DISTINCT `agentId` among spawn
 *  rows with `event === 'start'`, the same `sessionId`, and a `ts` inside it.
 *
 * -- THE MATCH RULE, WHICH IS A CHOICE AND NOT A MEASUREMENT ----------------
 *  | mode                          | match                                   |
 *  | solo                          | 0 spawns                                |
 *  | subagent                      | >= 1 spawn, no `team-` agentType        |
 *  | team                          | >= 2 distinct `team-` agentIds          |
 *  | autopilot/autopilot_fast/split| UNMEASURED — the actual lives under the |
 *  |                               | plugin's own runtime dirs, unread in v1 |
 *
 *  `explicit_slash` — any spawn row in the window, `start` OR `stop`, whose
 *  `agentType` starts with `team-` or `split-` — turns a mismatch into
 *  `input_deficit` rather than a router error. STOP ROWS COUNT ON PURPOSE:
 *  the ledger drops starts (44 orphan ids live), so requiring a `start` would
 *  blame the router for a window whose team is visible only through its exits.
 *  The asymmetry is deliberate — a stop-only `team-` row flags the window
 *  without adding to `spawns`. Those prefixes mean the human had already chosen the topology
 *  by typing the command; the router never saw that choice, so counting it
 *  against the router's judgement would measure the wrong thing.
 *
 * -- THE DENOMINATORS ARE A DECISION, SO BOTH ARE PRINTED -------------------
 *  `DEFAULT_SINCE` is the v4.63.0 tag instant, the start of the release window
 *  the O7 "false-state" question is about (leader decision sh04-1). `F04A_T0`
 *  is the F04(a) install instant, the earliest time any TR row could exist.
 *  Both appear in the `t0` block of every report because the agreement number
 *  moves with the cutoff, and a reader who sees only one cannot tell which
 *  question was answered.
 *
 *  THE RATE'S DENOMINATOR IS `measured_windows` = `match` + `mismatch` +
 *  `input_deficit`. `input_deficit` is IN the denominator deliberately:
 *  dropping it would shrink the denominator by an observer's judgement about
 *  whose fault a window was, and every such drop makes the rate read HIGHER
 *  (live 2026-09-21T01:45Z: 12/15 = 0.800 with it, 12/14 = 0.857 without).
 *  Every term is printed per mode and in `totals`, so a reader who wants the
 *  other denominator can recompute it from the rows rather than trusting this
 *  choice.
 *
 * -- EXIT CODES, AND WHY ONLY ONE IS NON-ZERO -------------------------------
 *  0  an observation was printed — INCLUDING a missing store, an empty store
 *     and an unexpected throw. "There is nothing recorded" is a finding about
 *     the project, not a failure of this script.
 *  2  usage error (unknown flag, flag without a value, unparsable `--since`,
 *     `--help`): ONE line on stderr, NOTHING on stdout. Same precedent as
 *     `scripts/ledger/verify-rate.mjs#fail` — exiting 0 over a typo reports a
 *     measurement nobody asked for.
 *
 * -- STDOUT -----------------------------------------------------------------
 *  Default: a human-readable report. `--json`: exactly ONE line with this
 *  FIXED key set —
 *    {"measured_at","project_root","decisions_dir","spawn_ledger_path","since",
 *     "t0","modes","totals","agreement_rate","open_windows","excluded_files",
 *     "excluded_sessions","stop_only_ids","sessions_with_tr",
 *     "sessions_in_spawn_ledger","sessions_joined","reverse_direction",
 *     "non_uuid_sessions"}
 *
 *  `non_uuid_sessions` is INFORMATIONAL AND SUBTRACTS NOTHING. It counts
 *  in-range sessions whose id is not host-shaped — vitest residue such as the
 *  live store's `sess-cmd-*` files. Their windows stay in the table; see
 *  {@link UUID_RE} for why flagging beats dropping.
 *
 *  `excluded_files` COUNTS FILES IN THE STORE, `excluded_sessions` COUNTS
 *  SESSIONS DROPPED IN RANGE — the two disagree on purpose and routinely do.
 *  A `diag-` file whose rows all predate `--since` is one excluded FILE and
 *  zero excluded SESSIONS; collapsing them would hide which of the two a
 *  missing session was lost to.
 *
 *  `agreement_rate` IS `null`, NEVER `0` OR `1`, WHEN NO WINDOW WAS MEASURED.
 *  Zero is a measured rate ("windows were classified and none agreed"); null is
 *  the absence of a denominator. A 0/0 that prints as 1.0 would report perfect
 *  agreement from an empty ledger, which is the single most likely way this
 *  number gets misread.
 *
 * -- WHAT THIS CANNOT SEE ---------------------------------------------------
 *  - SPLIT WINDOWS. A `/split` window writes its decisions into its OWN
 *    worktree root, so those sessions are outside this denominator entirely.
 *  - THE REVERSE DIRECTION ("team recommended, nothing spawned") is
 *    STRUCTURALLY unobservable, not merely absent: `tasks.js`'s
 *    `createTasksMiddleware` attaches a `workflowPlan` only for an agent team,
 *    so `routeTopology` can only say `team` after the caller already chose it.
 *    A count of 0 there is a property of the pipeline, never evidence.
 *  - AUTOPILOT AND SPLIT ACTUALS, which live under the plugin's own runtime
 *    directories and are not read in v1.
 *  - ANYTHING OUTSIDE A WINDOW. A TR row before `--since` is dropped window
 *    and all, and a spawn row after `--since` that precedes its session's
 *    FIRST in-range TR row belongs to no window and is counted by nothing in
 *    the table — it still appears in `sessions_in_spawn_ledger`, which is why
 *    that number can exceed anything the windows explain.
 *  - DROPPED STARTS. The spawn ledger loses some `start` rows (measured
 *    2026-09-04); `stop_only_ids` counts the visible part of that loss, and
 *    every one of them makes a `solo` window read as agreement when it was not.
 *
 * @module scripts/ledger/topology-agreement
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { getDecisionStoreDir } from '../../lib/observability/decision-events.js';
import { readSpawns, spawnLedgerPath } from '../../lib/learning/ledger/spawn-ledger.js';
import { TOPOLOGY_MODES } from '../../lib/topology/topology-router.js';
import { isMainEntry } from '../hooks/_main-entry.js';

/**
 * v4.63.0 tag instant — the start of the release window the O7 "false-state"
 * question is about (leader decision sh04-1). Used when `--since` is omitted.
 */
export const DEFAULT_SINCE = '2026-09-17T00:48:41Z';

/** F04(a) install instant — the earliest time a TR row can exist at all. */
export const F04A_T0 = '2026-09-14T05:21:00Z';

/**
 * Every constant this reader's arithmetic depends on, in one frozen block so a
 * reader of the output can find the rule that produced it.
 *
 * `TR_TYPE` is the literal `lib/observability/decision-events.js`
 * `#TOPOLOGY_RECOMMENDED` exports; it is spelled here rather than imported to
 * keep this module's import of that file down to `getDecisionStoreDir` — the
 * one function in it that reads nothing and writes nothing.
 */
export const AGREEMENT_RULES = Object.freeze({
  DEFAULT_SINCE,
  F04A_T0,
  TR_TYPE: 'topology-recommended',
  /** Modes whose actual is readable from the spawn ledger. */
  MEASURABLE_MODES: Object.freeze(['solo', 'subagent', 'team']),
  /** agentType prefix that proves the human typed the command. */
  TEAM_PREFIX: 'team-',
  SPLIT_PREFIX: 'split-',
  /** Decisions files whose rows are not session evidence. */
  EXCLUDED_PREFIXES: Object.freeze({ diag: 'diag-', cron: 'cron-', unattributed: '_unattributed' }),
});

/**
 * The shape of a host `session_id`. A sessionId that does not match it was not
 * written by a real session — the live store carries `sess-cmd-*` files left
 * by a vitest run.
 *
 * Their rows are COUNTED, not excluded, and the reason is the difference
 * between a rule and a guess: a synthetic id is not evidence that the row is
 * wrong, only that the session was not a human's, and the ones seen so far
 * fall into `split` -> `unmeasured` on their own. So the reader reports
 * `non_uuid_sessions` and lets a reader discount the denominator deliberately,
 * rather than silently shrinking it here.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The sentence the report prints when no team recommendation exists in range. */
const REVERSE_LINE = 'reverse direction (team recommended -> 0 spawns): structurally unobservable'
  + ' — tasks.js#createTasksMiddleware attaches workflowPlan only for agentTeam,'
  + ' so routeTopology can only say team after the caller already chose team';

/** Flags that take a value. Anything else on the command line is an error. */
const VALUE_FLAGS = ['--cwd', '--since'];

/** Flags that take no value. */
const BOOL_FLAGS = ['--json'];

const USAGE = 'usage: topology-agreement.mjs [--cwd <projectRoot>] '
  + '[--since <iso | epoch-ms (all digits)>] [--json]';

/**
 * Report a usage error on ONE line and nothing else — this stream is read by a
 * model, and a two-line message invites "the rest is noise".
 *
 * @param {string} message
 * @returns {2} the exit code, returned so callers read as `return fail(...)`
 */
function fail(message) {
  process.stderr.write(`topology-agreement: ${message} | ${USAGE}\n`);
  return 2;
}

/**
 * Parse the argument list into a flag map.
 *
 * `--help` and `-h` are usage ERRORS rather than a success path: the exit code
 * that means "I printed no measurement" is 2, and help is that case.
 *
 * @param {string[]} argv arguments after the script path
 * @returns {{opts: Record<string,string|boolean>}|{error: string}}
 */
function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--help' || flag === '-h') return { error: 'help requested' };
    if (BOOL_FLAGS.includes(flag)) {
      opts[flag.slice(2)] = true;
      continue;
    }
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
 * Resolve a time argument to epoch milliseconds, or null when it is not a time.
 *
 * All-digit input is read as EPOCH MS before `Date.parse` ever sees it:
 * `Date.parse('2026')` is a year, so a bare `--since 2026` would otherwise cut
 * at a wildly different instant than the caller meant.
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
 * Which exclusion bucket a decisions filename falls into, or null when the
 * file is ordinary session evidence.
 *
 * @param {string} basename
 * @returns {'diag'|'cron'|'unattributed'|null}
 */
function excludedKind(basename) {
  const { EXCLUDED_PREFIXES } = AGREEMENT_RULES;
  for (const [kind, prefix] of Object.entries(EXCLUDED_PREFIXES)) {
    if (basename.startsWith(prefix)) return /** @type {'diag'} */ (kind);
  }
  return null;
}

/**
 * Read every `topology-recommended` row in the decisions store, splitting the
 * excluded files off rather than dropping them silently.
 *
 * A corrupt line is skipped, never thrown: this store is appended by a hook on
 * a live session and a half-written last line is an expected state.
 *
 * @param {string} dir decisions store directory
 * @param {number} sinceMs
 * @returns {{rows: object[], excludedFiles: Record<string, number>,
 *            excludedSessions: Set<string>}}
 */
function readTrRows(dir, sinceMs) {
  const excludedFiles = { diag: 0, cron: 0, unattributed: 0 };
  const excludedSessions = new Set();
  const rows = [];
  let names;
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.events.ndjson'));
  } catch {
    return { rows, excludedFiles, excludedSessions };
  }
  for (const name of names) {
    const kind = excludedKind(name);
    if (kind !== null) excludedFiles[kind] += 1;
    let raw;
    try {
      raw = readFileSync(path.join(dir, name), 'utf8');
    } catch {
      continue;
    }
    for (const line of raw.split('\n')) {
      const row = parseTr(line, sinceMs);
      if (row === null) continue;
      if (kind === null) rows.push(row);
      else excludedSessions.add(row.sessionId);
    }
  }
  return { rows, excludedFiles, excludedSessions };
}

/**
 * One decisions line as a TR row, or null when it is anything else.
 *
 * The filter is on `type`, not on the presence of `data.mode`: the store's
 * other event types also carry a `mode`-shaped payload, and keying on the
 * payload would silently count them.
 *
 * @param {string} line
 * @param {number} sinceMs
 * @returns {{ts: string, tsMs: number, sessionId: string, mode: string}|null}
 */
function parseTr(line, sinceMs) {
  const text = line.trim();
  if (text === '') return null;
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object' || obj.type !== AGREEMENT_RULES.TR_TYPE) return null;
  const tsMs = Date.parse(obj.ts);
  if (!Number.isFinite(tsMs) || tsMs < sinceMs) return null;
  const sessionId = typeof obj.sessionId === 'string' ? obj.sessionId : '';
  const mode = typeof obj?.data?.mode === 'string' ? obj.data.mode : '';
  if (sessionId === '' || mode === '') return null;
  return { ts: obj.ts, tsMs, sessionId, mode };
}

/**
 * Group rows by `sessionId`, each group sorted by time.
 *
 * @param {object[]} rows rows carrying `sessionId` and `tsMs`
 * @returns {Map<string, object[]>}
 */
function bySession(rows) {
  const map = new Map();
  for (const row of rows) {
    const list = map.get(row.sessionId);
    if (list === undefined) map.set(row.sessionId, [row]);
    else list.push(row);
  }
  for (const list of map.values()) list.sort((a, b) => a.tsMs - b.tsMs);
  return map;
}

/**
 * Classify one window against the spawns that fell inside it.
 *
 * @param {string} mode the recommended topology
 * `teamSpawns` counts AGENTS, not agentType strings. A real team routinely
 * spawns two agents of the SAME type — two reviewers over different files —
 * and counting distinct type strings would score that run as one team member
 * and fail the `>= 2` rule on the most ordinary team shape there is.
 *
 * @param {{spawns: number, teamSpawns: number, explicitSlash: boolean}} actual
 * @returns {'match'|'mismatch'|'input_deficit'|'unmeasured'}
 */
function classify(mode, actual) {
  if (!AGREEMENT_RULES.MEASURABLE_MODES.includes(mode)) return 'unmeasured';
  let matched = false;
  if (mode === 'solo') matched = actual.spawns === 0;
  if (mode === 'subagent') matched = actual.spawns >= 1 && actual.teamSpawns === 0;
  if (mode === 'team') matched = actual.teamSpawns >= 2;
  if (matched) return 'match';
  return actual.explicitSlash ? 'input_deficit' : 'mismatch';
}

/**
 * Summarise the spawn rows that fall inside one window.
 *
 * Distinct `agentId`, not row count: a `start` can be re-delivered, and a
 * session that spawned one agent twice is not two agents.
 *
 * @param {object[]} rows one session's spawn rows, in file order
 * @param {number} from inclusive lower bound (epoch ms)
 * @param {number} to exclusive upper bound, `Infinity` for an open window
 * `stopOnly` is a SET of ids, not a list of rows: the live ledger holds more
 * `stop` rows than `start` rows (363 starts against 435 stops on this
 * machine's parent ledger, measured 2026-09-21T01:44Z and still growing), so
 * one orphan agent can appear twice and counting rows would
 * inflate the loss signal the counter exists to report.
 *
 * @param {Set<string>} startIds every agentId this session ever started
 * @returns {{spawns: number, teamSpawns: number, explicitSlash: boolean,
 *            stopOnly: string[]}}
 */
function foldWindow(rows, from, to, startIds) {
  const ids = new Set();
  const teamIds = new Set();
  const stopOnly = new Set();
  let explicitSlash = false;
  for (const rec of rows) {
    const ms = Date.parse(rec.ts);
    if (!Number.isFinite(ms) || ms < from || ms >= to) continue;
    const type = typeof rec.agentType === 'string' ? rec.agentType : '';
    const id = typeof rec.agentId === 'string' ? rec.agentId : '';
    if (type.startsWith(AGREEMENT_RULES.TEAM_PREFIX)
      || type.startsWith(AGREEMENT_RULES.SPLIT_PREFIX)) explicitSlash = true;
    if (rec.event === 'start') {
      ids.add(id);
      if (type.startsWith(AGREEMENT_RULES.TEAM_PREFIX)) teamIds.add(id);
      continue;
    }
    if (rec.event === 'stop' && !startIds.has(id)) stopOnly.add(id);
  }
  return {
    spawns: ids.size, teamSpawns: teamIds.size, explicitSlash, stopOnly: [...stopOnly],
  };
}

/**
 * An empty per-mode row. Every mode gets one whether or not it was seen, so a
 * caller never has to branch on a missing key and a zero is visible as a zero.
 *
 * @returns {Record<string, number>}
 */
function emptyModeRow() {
  return {
    windows: 0,
    spawns_0: 0,
    spawns_1: 0,
    spawns_2plus: 0,
    match: 0,
    mismatch: 0,
    input_deficit: 0,
    unmeasured: 0,
  };
}

/**
 * Build the per-mode table and the totals from the two stores.
 *
 * @param {object[]} trRows TR rows already filtered by `--since`
 * @param {object[]} spawnRows spawn rows already filtered by `--since`
 * @returns {{modes: Record<string, object>, totals: object, openWindows: number,
 *            stopOnly: number}}
 */
function foldAgreement(trRows, spawnRows) {
  const modes = Object.fromEntries(TOPOLOGY_MODES.map((m) => [m, emptyModeRow()]));
  const totals = {
    windows: 0, measured_windows: 0, match: 0, mismatch: 0, input_deficit: 0, unmeasured: 0,
  };
  const spawnsBySession = bySession(spawnRows.map((r) => ({ ...r, tsMs: Date.parse(r.ts) })));
  const stopOnlyIds = new Set();
  let openWindows = 0;

  for (const [sessionId, trs] of bySession(trRows)) {
    const sessionSpawns = spawnsBySession.get(sessionId) ?? [];
    const startIds = new Set(
      sessionSpawns.filter((r) => r.event === 'start').map((r) => r.agentId),
    );
    trs.forEach((tr, i) => {
      const open = i === trs.length - 1;
      const to = open ? Infinity : trs[i + 1].tsMs;
      const actual = foldWindow(sessionSpawns, tr.tsMs, to, startIds);
      for (const id of actual.stopOnly) stopOnlyIds.add(id);
      if (open) openWindows += 1;
      tally(modes[tr.mode], totals, classify(tr.mode, actual), actual.spawns);
    });
  }
  return {
    modes, totals, openWindows, stopOnly: stopOnlyIds.size,
  };
}

/**
 * Add one classified window to its mode row and to the totals.
 *
 * An unknown mode — a router that grew a seventh topology without this table
 * being updated — is counted in the totals and dropped from the per-mode view
 * rather than crashing, and the totals then disagree with the table, which is
 * the visible symptom that says "update this file".
 *
 * @param {Record<string, number>|undefined} row
 * @param {Record<string, number>} totals
 * @param {'match'|'mismatch'|'input_deficit'|'unmeasured'} verdict
 * @param {number} spawns
 * @returns {void}
 */
function tally(row, totals, verdict, spawns) {
  totals.windows += 1;
  totals[verdict] += 1;
  if (verdict !== 'unmeasured') totals.measured_windows += 1;
  if (row === undefined) return;
  row.windows += 1;
  row[verdict] += 1;
  if (spawns === 0) row.spawns_0 += 1;
  else if (spawns === 1) row.spawns_1 += 1;
  else row.spawns_2plus += 1;
}

/**
 * Assemble the report object — the same shape the human renderer and `--json`
 * both read, so the two can never describe different moments.
 *
 * @param {{cwd: string, since: string, sinceMs: number}} ctx
 * @returns {object}
 */
function buildReport(ctx) {
  const decisionsDir = getDecisionStoreDir({ projectRoot: ctx.cwd });
  const spawnPath = spawnLedgerPath(ctx.cwd);
  const { rows, excludedFiles, excludedSessions } = readTrRows(decisionsDir, ctx.sinceMs);
  const spawnRows = readSpawns(ctx.cwd, { since: ctx.sinceMs });
  const fold = foldAgreement(rows, spawnRows);
  const trSessions = new Set(rows.map((r) => r.sessionId));
  const spawnSessions = new Set(spawnRows.map((r) => r.sessionId));
  const joined = [...trSessions].filter((id) => spawnSessions.has(id));
  const denominator = fold.totals.measured_windows;
  return {
    // The one clock read in this pipeline.
    measured_at: new Date().toISOString(),
    project_root: ctx.cwd,
    decisions_dir: decisionsDir,
    spawn_ledger_path: existsSync(spawnPath) ? spawnPath : `${spawnPath} (absent)`,
    since: ctx.since,
    t0: {
      default_since: new Date(DEFAULT_SINCE).toISOString(),
      f04a: new Date(F04A_T0).toISOString(),
    },
    modes: fold.modes,
    totals: fold.totals,
    // null, never 0 and never 1, when nothing was measured — see the header.
    agreement_rate: denominator === 0 ? null : fold.totals.match / denominator,
    open_windows: fold.openWindows,
    excluded_files: excludedFiles,
    excluded_sessions: excludedSessions.size,
    stop_only_ids: fold.stopOnly,
    sessions_with_tr: trSessions.size,
    sessions_in_spawn_ledger: spawnSessions.size,
    sessions_joined: joined.length,
    reverse_direction: fold.modes.team.windows === 0 ? 'structurally-unobservable' : 'measured',
    non_uuid_sessions: [...trSessions].filter((id) => !UUID_RE.test(id)).length,
  };
}

/** Column widths of the human table, in the order the header names them. */
const COLS = [15, 7, 8, 3, 5, 5, 8, 13, 10];

/**
 * One table row, padded to the column widths.
 *
 * @param {Array<string|number>} cells
 * @returns {string}
 */
function tableRow(cells) {
  return cells.map((c, i) => String(c).padEnd(COLS[i])).join('| ');
}

/**
 * Render the default, human-readable report.
 *
 * @param {object} rep the object `buildReport` returned
 * @returns {string}
 */
function renderHuman(rep) {
  const lines = [
    `measured_at        ${rep.measured_at}`,
    `project_root       ${rep.project_root}`,
    `decisions_dir      ${rep.decisions_dir}`,
    `spawn_ledger_path  ${rep.spawn_ledger_path}`,
    `since              ${rep.since}`,
    `t0  v4.63.0 tag    ${rep.t0.default_since}   (default --since)`,
    `t0  F04(a) install ${rep.t0.f04a}   (earliest possible TR row)`,
    '',
    tableRow(['TR mode', 'windows', 'spawns=0', '=1', '>=2', 'match', 'mismatch', 'input_deficit', 'unmeasured']),
  ];
  for (const mode of TOPOLOGY_MODES) {
    const r = rep.modes[mode];
    lines.push(tableRow([
      mode, r.windows, r.spawns_0, r.spawns_1, r.spawns_2plus,
      r.match, r.mismatch, r.input_deficit, r.unmeasured,
    ]));
  }
  lines.push(
    '',
    `agreement_rate            ${rep.agreement_rate === null ? 'null (no measured window)' : rep.agreement_rate.toFixed(4)}`,
    `measured_windows          ${rep.totals.measured_windows} of ${rep.totals.windows}`,
    `open_windows              ${rep.open_windows}`,
    `excluded_files            diag=${rep.excluded_files.diag} cron=${rep.excluded_files.cron} unattributed=${rep.excluded_files.unattributed}`,
    `excluded_sessions         ${rep.excluded_sessions}`,
    `stop_only_ids             ${rep.stop_only_ids}`,
    `sessions_with_tr          ${rep.sessions_with_tr}`,
    `sessions_in_spawn_ledger  ${rep.sessions_in_spawn_ledger}`,
    `sessions_joined           ${rep.sessions_joined}`,
    `non_uuid_sessions         ${rep.non_uuid_sessions}   (synthetic / test-fixture residue`
      + ' — still counted; prefixed classes are in excluded_files)',
    '',
  );
  if (rep.reverse_direction === 'structurally-unobservable') lines.push(REVERSE_LINE, '');
  lines.push(...caveats());
  return `${lines.join('\n')}\n`;
}

/**
 * The three things this report cannot see, printed with every run so the
 * number is never read without them.
 *
 * @returns {string[]}
 */
function caveats() {
  return [
    'what this cannot see:',
    '  - split-window sessions write their decisions into their own worktree root,'
      + ' so they are outside this denominator entirely',
    '  - the reverse direction (team recommended, nothing spawned) is structurally 0:'
      + ' a team recommendation can only follow a team the caller already chose',
    '  - autopilot and split ACTUALS live under the plugin runtime dirs and are unmeasured in v1',
  ];
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
  if (typeof opts.cwd === 'string' && opts.cwd.trim() === '') return fail('--cwd must not be empty');

  const raw = opts.since === undefined ? DEFAULT_SINCE : String(opts.since);
  const sinceMs = toEpochMs(raw);
  if (sinceMs === null) return fail(`--since must be an ISO timestamp or epoch ms, got: ${opts.since}`);

  const cwd = typeof opts.cwd === 'string' ? opts.cwd : process.cwd();
  const rep = buildReport({ cwd, since: new Date(sinceMs).toISOString(), sinceMs });
  process.stdout.write(opts.json === true ? `${JSON.stringify(rep)}\n` : renderHuman(rep));
  return 0;
}

if (isMainEntry(import.meta.url)) {
  const [, , ...argv] = process.argv;
  // Reading a number must never fail the caller's step: an unexpected throw
  // still exits 0, with the reason on stderr where it cannot be mistaken for a
  // measurement.
  try {
    process.exitCode = main(argv);
  } catch (err) {
    process.stderr.write(`topology-agreement: ${String(err?.message ?? err)}\n`);
    process.exitCode = 0;
  }
}
