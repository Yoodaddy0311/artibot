#!/usr/bin/env node
/**
 * Print the Existence Audit — "does this hook / command / skill / `lib/` module
 * ever fire?" — for one plugin root's inventory against a project's central
 * ledger.
 *
 * `lib/replay/existence-audit.js#buildExistenceAudit` owns the answer and is
 * PURE: it never enumerates anything, and its header says so ("THE INVENTORY IS
 * THE CALLER'S WORD"). Until this file it had no production caller at all, so
 * the CLAUDE.md Existence Audit rule could be computed only inside tests. This
 * script is that caller: it lists the four kinds from a plugin root on disk,
 * reads the ledger once, hands both to the fold, and prints the result.
 *
 * READ-ONLY — THE OBSERVE CONTRACT, ENFORCED BY WHAT IS NOT IMPORTED.
 * `lib/runtime/ledger.js#readLedgerCensus` is the only ledger function reached
 * from here; `appendLedgerEvent` is deliberately NOT imported. The plugin root
 * is only listed and read, never written. A measuring tool that appends to the
 * stream it measures is its own next data point.
 *
 * THE ARITHMETIC IS NOT HERE. Every count, reason and denominator comes from
 * `buildExistenceAudit`; this file is the impure shell (filesystem, clock,
 * serialization). The module is imported DIRECTLY, not through
 * `lib/replay/index.js`, whose header keeps it out of the barrel on purpose.
 *
 * USAGE
 *   node scripts/ledger/existence-audit.mjs [--cwd <projectRoot>]
 *        [--plugin-root <dir>] [--since <iso-or-ms>]
 *   `--cwd` is the LEDGER root, `--plugin-root` the INVENTORY root; they are
 *   different trees and neither defaults to the other. An all-digit `--since`
 *   is EPOCH MILLISECONDS, never a year (same rule as `session-coverage.mjs`).
 *
 * -- HOW EACH KIND IS ENUMERATED ------------------------------------------
 *  commands  `commands/*.md`, the file stem LOWERCASED. That is the only
 *            spelling `intent.detected.command` can hold (existence-audit.js
 *            header, "THE COMMANDS CARRIER"). Two stems that collide once
 *            lowercased make the kind `malformed` — the fold refuses duplicate
 *            names, and merging them would hide one file behind another.
 *  skills    `skills/<dir>/` that CONTAINS a `SKILL.md`; the bare directory
 *            name. A directory without one is not a skill and is counted in
 *            `sources.skills.skipped`, not audited.
 *  hooks     the DISTINCT handler `name`s across every
 *            `hooks/dispatch-table.json#slots.*.handlers[*]`, raw spelling,
 *            because `_hook-fired-record.js` records them raw. A name in two
 *            slots is ONE hook (the table's `handlerEntries` vs `count` shows
 *            the difference). FAIL-CLOSED: a table that is unreadable, not
 *            JSON, or has any handler without a non-empty string `name` makes
 *            the whole kind `malformed` — a partial list would print a
 *            complete-looking audit of the wrong set.
 *  modules   every `.js` / `.mjs` / `.cjs` file under `lib/`, as a
 *            plugin-relative forward-slash path (`lib/replay/replay.js`).
 *            ENUMERATED although no event carries it, so each entry says
 *            `unmeasured:no-event-carries-module` instead of the kind simply
 *            vanishing from the output. Symlinks are not followed.
 *
 *  A source that is MISSING leaves its inventory key OUT, so the audit says
 *  `enumerated: false`; a source that EXISTS with zero items passes `[]`, so it
 *  says `enumerated: true` with no entries. Unreadable and malformed sources
 *  are also left out. `sources.<kind>.status` names which of those four
 *  (`enumerated` | `absent` | `unreadable` | `malformed`) it was, so
 *  `enumerated: false` never has to be guessed at.
 *
 * -- WHY `--cwd` MAY DEFAULT TO `process.cwd()`, AND THE TRAP --------------
 *  Same rationale and trap as `session-coverage.mjs`: running the INSTALLED
 *  copy from an unrelated directory measures whatever project the shell was
 *  in. `inputPath` on stdout is the ledger file actually read, and
 *  `pluginRoot` is the inventory actually listed; an audit of the wrong tree
 *  is told apart only by those two paths. `--plugin-root` defaults to THIS
 *  file's own plugin root, so the installed copy audits the installed
 *  inventory, not the repository's.
 *  `--cwd` must be the REPOSITORY ROOT (where `.git` is): the ledger path
 *  resolver does not walk upward, so a subdirectory such as the plugin root
 *  resolves to `<cwd>/.artibot/runtime/ledger.jsonl`, usually absent — an
 *  empty audit that `census.file.present: false` is the only sign of
 *  (measured 2026-09-23 from this worktree's `plugins/artibot`).
 *
 * -- EXIT CODES -----------------------------------------------------------
 *  0  an observation was printed — INCLUDING a missing or unreadable ledger,
 *     a missing inventory source, and an unexpected throw (then `error` is
 *     set and `kinds`/`summary` are null).
 *  2  usage error: unknown flag, flag without a value, unparsable `--since`,
 *     or a `--plugin-root` that is not a directory (an audit of a typo would
 *     print four `enumerated: false` kinds that read like a finding). One
 *     stderr line prefixed `existence-audit:`, NOTHING on stdout.
 *
 * -- STDOUT ---------------------------------------------------------------
 *  ONE line of JSON with a FIXED key set:
 *    {"measuredAt","inputPath","since","pluginRoot","sources",
 *     "hooksOutsideCarrier","unmatched","kinds","summary"}
 *  plus `error` only when a throw was caught. `kinds` and `summary` are the
 *  fold's own output, passed through whole: per-kind `enumerated`,
 *  `denominator`, `carrier`, `carrierNote` and entries with `fired` /
 *  `reason`; `summary.eventsReceived` (survivors handed in) and
 *  `summary.census` (the reader's line census, so loss above the reader is
 *  visible). `inputPath` is `census.file.path`, not a path this file guessed.
 *
 *  `unmatched.<kind>` is every name the kind's carrier COUNTED that no
 *  inventory entry spells, with its count — the other half of a false zero.
 *  An entry's `fired: 0` next to a non-empty `unmatched` means the rows may
 *  name it in a spelling the inventory does not use. It is computed with the
 *  fold's own exported `foldFiredCounts` and `CARRIERS`, not a second count.
 *  `null` when the kind was not enumerated or has no carrier.
 *
 * -- WHAT THIS CANNOT SEE -------------------------------------------------
 *  - SKILL ROWS ARE SPELLED BOTH WAYS, AND NOT ONLY FOR SKILLS. Measured
 *    2026-09-23 on the central ledger: 6 `tool.used` rows with `skill`, 5
 *    namespaced (`artibot:save` 2, `artibot:split` 2, `artibot:team` 1) and 1
 *    bare (`split`). `save` is a COMMAND (`commands/save.md`, no
 *    `skills/save/`), so the Skill tool carries commands too. The bare
 *    directory names enumerated here therefore read `fired: 0, measured:
 *    true` for namespaced calls — a FALSE ZERO — and those calls land in
 *    `unmatched.skills`. No normalisation is attempted: stripping a prefix
 *    would merge `artibot-cowork:x` into `x` and fold command calls into
 *    skill counts, which is a naming decision, not a reader's.
 *  - HOOKS REGISTERED DIRECTLY IN `hooks/hooks.json` ARE NOT IN THE INVENTORY.
 *    No dispatcher runs them, so no `hook.fired` row can name them, and
 *    listing them would print a false `fired: 0`. They are COUNTED instead,
 *    in `hooksOutsideCarrier` (a hooks.json command that does not invoke a
 *    dispatcher named in the table); their firing is not audited at all.
 *  - A DISABLED `hook.fired` SLOT READS AS A FALSE ZERO. The fold decides
 *    `measured` per KIND (any `hook.fired` row at all), not per slot. If
 *    `ledger.hookFired.slots` switched one slot off while others kept
 *    recording, that slot's handlers print `fired: 0, measured: true`. This
 *    file does not read that config, and could not see the value it held
 *    when the rows were written.
 *  - THE INVENTORY IS TODAY'S DISK, THE LEDGER IS HISTORY. The ledger is
 *    shared by every worktree and every plugin version that wrote to it. A
 *    name renamed since is invisible (it is simply not listed); a name added
 *    after the rows were written reads as a silence nobody could have heard.
 *  - NAMESPACED OR NESTED COMMANDS. `commands/<dir>/*.md` is not listed, and
 *    the carrier cannot see namespaced or non-typed invocations anyway.
 *  - EXEMPTIONS ARE NOT DECLARED. Every item is passed as a bare name, so an
 *    entry is `exempt` only when its name literally equals a contract name;
 *    which hook falls under "PreToolUse 보안 훅" is a human mapping.
 *  - CONSUMERS, RELEASE HISTORY, `candidate` — the fold's own limits, unchanged.
 *
 * @module scripts/ledger/existence-audit
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readLedgerCensus } from '../../lib/runtime/ledger.js';
import {
  AUDITED_KINDS, buildExistenceAudit, CARRIERS, foldFiredCounts,
} from '../../lib/replay/existence-audit.js';
import { isMainEntry } from '../hooks/_main-entry.js';

/** This file's own plugin root: scripts/ledger -> plugin root. */
const OWN_PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Flags that take a value. Anything else on the command line is an error. */
const VALUE_FLAGS = ['--cwd', '--plugin-root', '--since'];

const USAGE = 'usage: existence-audit.mjs [--cwd <projectRoot>] [--plugin-root <dir>] '
  + '[--since <iso | epoch-ms (all digits)>]';

/** Plugin-relative source of each kind, echoed in `sources.<kind>.path`. */
const SOURCE_PATHS = Object.freeze({
  commands: 'commands',
  skills: 'skills',
  hooks: 'hooks/dispatch-table.json',
  modules: 'lib',
});

const HOOKS_JSON = 'hooks/hooks.json';
const MODULE_FILE = /\.(?:c|m)?js$/;

/**
 * Report a usage error on ONE line and nothing else.
 *
 * @param {string} message
 * @returns {2} the exit code
 */
function fail(message) {
  process.stderr.write(`existence-audit: ${message} | ${USAGE}\n`);
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
 * All-digit input is epoch ms and is handled BEFORE `Date.parse`.
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
 * @param {string} dir
 * @returns {boolean} true when `dir` exists and is a directory
 */
function isDirectory(dir) {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * List a directory without throwing.
 *
 * @param {string} dir absolute path
 * @returns {{status: 'ok', entries: import('node:fs').Dirent[]}
 *   |{status: 'absent'|'unreadable', error?: string}}
 */
function listDir(dir) {
  if (!existsSync(dir)) return { status: 'absent' };
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    return { status: 'ok', entries: entries.sort((a, b) => (a.name < b.name ? -1 : 1)) };
  } catch (err) {
    return { status: 'unreadable', error: err?.code ?? err?.message ?? String(err) };
  }
}

/**
 * Read and parse a JSON file without throwing.
 *
 * @param {string} file absolute path
 * @returns {{status: 'ok', value: unknown}
 *   |{status: 'absent'|'unreadable'|'malformed', error?: string}}
 */
function readJson(file) {
  if (!existsSync(file)) return { status: 'absent' };
  let raw;
  try {
    raw = readFileSync(file, 'utf-8');
  } catch (err) {
    return { status: 'unreadable', error: err?.code ?? err?.message ?? String(err) };
  }
  try {
    return { status: 'ok', value: JSON.parse(raw) };
  } catch (err) {
    return { status: 'malformed', error: `not JSON: ${err?.message ?? String(err)}` };
  }
}

/**
 * `commands/*.md` stems, lowercased.
 *
 * @param {string} root plugin root
 * @returns {{status: string, items?: string[], skipped?: number, error?: string}}
 */
function enumerateCommands(root) {
  const listed = listDir(path.join(root, SOURCE_PATHS.commands));
  if (listed.status !== 'ok') return listed;
  const items = [];
  let skipped = 0;
  for (const entry of listed.entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) { skipped += 1; continue; }
    const stem = entry.name.slice(0, -'.md'.length).toLowerCase();
    if (items.includes(stem)) {
      return { status: 'malformed', error: `two command files lowercase to ${JSON.stringify(stem)}` };
    }
    items.push(stem);
  }
  return { status: 'enumerated', items, skipped };
}

/**
 * `skills/<dir>/SKILL.md` directory names.
 *
 * @param {string} root plugin root
 * @returns {{status: string, items?: string[], skipped?: number, error?: string}}
 */
function enumerateSkills(root) {
  const dir = path.join(root, SOURCE_PATHS.skills);
  const listed = listDir(dir);
  if (listed.status !== 'ok') return listed;
  const items = [];
  let skipped = 0;
  for (const entry of listed.entries) {
    if (entry.isDirectory() && existsSync(path.join(dir, entry.name, 'SKILL.md'))) {
      items.push(entry.name);
    } else {
      skipped += 1;
    }
  }
  return { status: 'enumerated', items, skipped };
}

/**
 * Validate the dispatch table's shape. All-or-nothing: one bad handler
 * rejects the table.
 *
 * @param {unknown} table parsed JSON
 * @returns {string|null} what is wrong, or null when usable
 */
function dispatchTableDefect(table) {
  const slots = table?.slots;
  if (!slots || typeof slots !== 'object' || Array.isArray(slots)) return 'slots is not an object';
  for (const [slot, def] of Object.entries(slots)) {
    if (!def || typeof def !== 'object') return `slot ${slot} is not an object`;
    const handlers = def.handlers ?? [];
    if (!Array.isArray(handlers)) return `slot ${slot} handlers is not an array`;
    for (const h of handlers) {
      if (typeof h?.name !== 'string' || h.name.length === 0) {
        return `slot ${slot} has a handler without a non-empty string name`;
      }
    }
  }
  return null;
}

/**
 * Distinct dispatch-table handler names, plus the dispatcher script basenames
 * that `hooksOutsideCarrier` needs.
 *
 * @param {string} root plugin root
 * @returns {{status: string, items?: string[], handlerEntries?: number,
 *   dispatchers?: string[], error?: string}}
 */
function enumerateHooks(root) {
  const read = readJson(path.join(root, SOURCE_PATHS.hooks));
  if (read.status !== 'ok') return read;
  const defect = dispatchTableDefect(read.value);
  if (defect !== null) return { status: 'malformed', error: defect };
  const names = [];
  const dispatchers = [];
  for (const def of Object.values(read.value.slots)) {
    for (const h of def.handlers ?? []) names.push(h.name);
    if (typeof def.dispatcher === 'string') dispatchers.push(path.posix.basename(def.dispatcher));
  }
  return { status: 'enumerated', items: [...new Set(names)], handlerEntries: names.length, dispatchers };
}

/**
 * Every module file under `lib/`, as a plugin-relative posix path.
 * Fail-closed: an unreadable subdirectory makes the whole kind unreadable.
 *
 * @param {string} root plugin root
 * @returns {{status: string, items?: string[], error?: string}}
 */
function enumerateModules(root) {
  const items = [];
  const pending = [SOURCE_PATHS.modules];
  while (pending.length > 0) {
    const rel = pending.shift();
    const listed = listDir(path.join(root, rel));
    if (listed.status !== 'ok') {
      if (rel === SOURCE_PATHS.modules) return listed;
      return { status: 'unreadable', error: `${rel}: ${listed.error ?? listed.status}` };
    }
    for (const entry of listed.entries) {
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) pending.push(child);
      else if (entry.isFile() && MODULE_FILE.test(entry.name)) items.push(child);
    }
  }
  return { status: 'enumerated', items };
}

/**
 * hooks.json commands that do NOT invoke a dispatcher in the table — the hooks
 * `hook.fired` structurally cannot name.
 *
 * @param {string} root plugin root
 * @param {string[]|undefined} dispatchers dispatcher basenames, when the table was usable
 * @returns {{path: string, status: string, count: number|null, entries: string[]|null,
 *   error?: string}}
 */
function hooksOutsideCarrier(root, dispatchers) {
  const notCounted = (status, error) => ({
    path: HOOKS_JSON, status, count: null, entries: null, ...(error ? { error } : {}),
  });
  if (dispatchers === undefined) return notCounted('unmeasured:dispatch-table-not-enumerated');
  const read = readJson(path.join(root, HOOKS_JSON));
  if (read.status !== 'ok') return notCounted(read.status, read.error);
  const events = read.value?.hooks;
  if (!events || typeof events !== 'object' || Array.isArray(events)) {
    return notCounted('malformed', 'hooks is not an object');
  }
  const entries = [];
  for (const [event, groups] of Object.entries(events)) {
    for (const group of Array.isArray(groups) ? groups : []) {
      for (const hook of Array.isArray(group?.hooks) ? group.hooks : []) {
        const command = typeof hook?.command === 'string' ? hook.command.trim() : '';
        // The script basename plus its arguments, e.g. `workflow-status.js notification`.
        const tail = command.match(/[^\s/\\]+\.(?:c|m)?js\b.*$/)?.[0] ?? command;
        if (dispatchers.includes(tail.split(/\s/)[0])) continue;
        entries.push(`${event} ${tail}`);
      }
    }
  }
  return { path: HOOKS_JSON, status: 'enumerated', count: entries.length, entries };
}

/**
 * Enumerate all four kinds. Only `enumerated` sources become inventory keys.
 *
 * @param {string} root plugin root
 * @returns {{inventory: object, sources: object, outside: object}}
 */
function enumerate(root) {
  const results = {
    commands: enumerateCommands(root),
    skills: enumerateSkills(root),
    hooks: enumerateHooks(root),
    modules: enumerateModules(root),
  };
  const inventory = {};
  const sources = {};
  for (const [kind, r] of Object.entries(results)) {
    if (r.status === 'enumerated') inventory[kind] = r.items;
    const source = { path: SOURCE_PATHS[kind], status: r.status, count: r.items ? r.items.length : null };
    if (r.skipped !== undefined) source.skipped = r.skipped;
    if (r.handlerEntries !== undefined) source.handlerEntries = r.handlerEntries;
    if (r.error !== undefined) source.error = r.error;
    sources[kind] = source;
  }
  return { inventory, sources, outside: hooksOutsideCarrier(root, results.hooks.dispatchers) };
}

/**
 * Carrier names counted by the fold that no inventory entry spells.
 *
 * @param {object[]} events ledger survivors
 * @param {object} inventory the inventory handed to the audit
 * @returns {Record<string, Record<string, number>|null>} per kind
 */
function unmatchedNames(events, inventory) {
  const out = {};
  for (const kind of AUDITED_KINDS) {
    const fold = foldFiredCounts(events, CARRIERS[kind] ?? null);
    if (fold === null || !Object.hasOwn(inventory, kind)) { out[kind] = null; continue; }
    const listed = new Set(inventory[kind]);
    out[kind] = Object.fromEntries(Object.entries(fold.counts).filter(([name]) => !listed.has(name)));
  }
  return out;
}

/**
 * Build the stdout object with its fixed key set.
 *
 * @param {object} parts
 * @returns {object}
 */
function report(parts) {
  const out = {
    // The one clock read in this pipeline; the fold is pure.
    measuredAt: new Date().toISOString(),
    inputPath: parts.inputPath,
    since: parts.since,
    pluginRoot: parts.pluginRoot,
    sources: parts.sources,
    hooksOutsideCarrier: parts.outside,
    unmatched: parts.unmatched,
    kinds: parts.kinds,
    summary: parts.summary,
  };
  if (parts.error !== undefined) out.error = parts.error;
  return out;
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

  let sinceMs = null;
  if (opts.since !== undefined) {
    sinceMs = toEpochMs(opts.since);
    if (sinceMs === null) return fail(`--since must be an ISO timestamp or epoch ms, got: ${opts.since}`);
  }
  const pluginRoot = path.resolve(opts['plugin-root'] ?? OWN_PLUGIN_ROOT);
  if (!isDirectory(pluginRoot)) return fail(`--plugin-root is not a directory: ${opts['plugin-root']}`);
  const since = sinceMs === null ? null : new Date(sinceMs).toISOString();
  const cwd = opts.cwd || process.cwd();

  let line;
  try {
    const { inventory, sources, outside } = enumerate(pluginRoot);
    const { events, census } = readLedgerCensus(cwd, sinceMs === null ? {} : { since: sinceMs });
    const { kinds, summary } = buildExistenceAudit(events, { inventory, census });
    const unmatched = unmatchedNames(events, inventory);
    line = report({
      inputPath: census.file.path, since, pluginRoot, sources, outside, unmatched, kinds, summary,
    });
  } catch (err) {
    line = report({
      inputPath: null,
      since,
      pluginRoot,
      sources: null,
      outside: null,
      unmatched: null,
      kinds: null,
      summary: null,
      error: err?.message ?? String(err),
    });
  }
  process.stdout.write(`${JSON.stringify(line)}\n`);
  return 0;
}

if (isMainEntry(import.meta.url)) {
  const [, , ...argv] = process.argv;
  // `main` already converts a throw into a printed line; this only covers a
  // failure of the printing itself. Reading a number must never fail a step.
  try {
    process.exitCode = main(argv);
  } catch {
    process.exitCode = 0;
  }
}
