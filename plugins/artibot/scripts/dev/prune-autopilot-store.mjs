#!/usr/bin/env node
/**
 * `prune-autopilot-store` -- remove non-session residue from the autopilot store.
 *
 * The store (`lib/autopilot/session-store.js#getStoreDir`, i.e.
 * `<pluginRoot>/runtime/autopilot`) holds one `<id>.json` per session plus the
 * matching `<id>.events.ndjson` telemetry stream. Three other file kinds
 * accumulate there and are not sessions:
 *
 *   (a) `test-engine-state-*` -- engine-harness scratch state written by tests
 *       into the same directory as real runs.
 *   (b) `*.events.ndjson` with no sibling `*.json` -- a telemetry stream whose
 *       session record was deleted. `deleteSession` removes both, so these are
 *       left by crashes and by manual `.json` deletions.
 *   (c) `*.json.v<n>.bak` -- schema-upgrade backups. `session-store.js`
 *       (`deleteSchemaBackups`) only clears these for a session it is deleting,
 *       so backups of surviving sessions stay forever.
 *
 * Why it matters beyond disk: any metric computed by counting store entries
 * takes all three as sessions, so the denominator is inflated and every rate
 * derived from it reads low. The store measured on a developer machine held
 * 12,664 entries of which 6 were real sessions.
 *
 * Classification is strictly single-bucket, priority (a) then (b) then (c). A
 * `test-engine-state-*.events.ndjson` with no paired json satisfies both (a)
 * and (b); counting it twice would report more targets than the directory
 * contains. Anything not matching all three rules is never a target, including
 * every real session record and its paired stream.
 *
 * Dry-run by default. `--apply` is the only path that unlinks, and it prints
 * the owner-decision notice first so an operator running it out of order sees
 * the precondition before the deletions.
 *
 * @module scripts/dev/prune-autopilot-store
 */

import { existsSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';

import { isMainEntry } from '../hooks/_main-entry.js';
import { getStoreDir } from '../../lib/autopilot/session-store.js';

export const HELP = `usage: node scripts/dev/prune-autopilot-store.mjs [--store <dir>] [--apply] [--json]

  --store <dir>  store directory to scan (default: the autopilot store under
                 the resolved plugin root)
  --apply        actually delete the residue (default: dry run, deletes nothing)
  --json         emit one machine-readable JSON object instead of a table
  --help, -h     show this message

Removes three kinds of non-session residue, each file counted in exactly one
bucket: test-engine-state-* scratch files, orphaned *.events.ndjson streams
whose paired *.json is gone, and *.json.v<n>.bak schema-upgrade backups.
Real session records and their paired event streams are never targets.`;

/** Owner precondition, printed as the first line of an --apply run. */
export const APPLY_NOTICE =
  'O6: run only after the isolation commit has landed (owner decision 2026-09-15)';

const TEST_STATE_PREFIX = 'test-engine-state-';
const EVENTS_SUFFIX = '.events.ndjson';
const SESSION_SUFFIX = '.json';
const BACKUP_RE = /\.json\.v\d+\.bak$/;

/**
 * @typedef {object} Bucket
 * @property {string[]} files entry names, directory-relative
 * @property {number} bytes summed size of those files
 */

/**
 * @typedef {object} Scan
 * @property {Bucket} testEngineState rule (a)
 * @property {Bucket} orphanEvents rule (b)
 * @property {Bucket} schemaBackups rule (c)
 * @property {Bucket} total union of the three, disjoint by construction
 */

/**
 * Classify the residue in a store directory. Pure: reads, never writes.
 *
 * A missing or unreadable directory yields all-zero rather than throwing, so a
 * caller on a machine that never ran autopilot gets the same shape as one that
 * did instead of an error it has to special-case.
 *
 * @param {string} dir store directory
 * @returns {Scan}
 */
export function scanStore(dir) {
  const testEngineState = [];
  const orphanEvents = [];
  const schemaBackups = [];

  const names = safeReaddir(dir);
  // Rule (b) needs to know which session records exist, so the set is built
  // from the same listing before any file is classified.
  const sessionBases = new Set();
  for (const name of names) {
    if (name.endsWith(SESSION_SUFFIX)) {
      sessionBases.add(name.slice(0, -SESSION_SUFFIX.length));
    }
  }

  for (const name of names) {
    if (isTestEngineState(name)) testEngineState.push(name);
    else if (isOrphanEvents(name, sessionBases)) orphanEvents.push(name);
    else if (BACKUP_RE.test(name)) schemaBackups.push(name);
  }

  const a = toBucket(dir, testEngineState);
  const b = toBucket(dir, orphanEvents);
  const c = toBucket(dir, schemaBackups);
  return {
    testEngineState: a,
    orphanEvents: b,
    schemaBackups: c,
    total: {
      files: a.files.length + b.files.length + c.files.length,
      bytes: a.bytes + b.bytes + c.bytes,
    },
  };
}

/**
 * Rule (a): harness scratch state. Restricted to the two suffixes the store
 * itself uses, so a `test-engine-state-*.json.v1.bak` falls through to rule (c)
 * rather than being claimed here by prefix alone.
 *
 * @param {string} name
 * @returns {boolean}
 */
function isTestEngineState(name) {
  if (!name.startsWith(TEST_STATE_PREFIX)) return false;
  return name.endsWith(SESSION_SUFFIX) || name.endsWith(EVENTS_SUFFIX);
}

/**
 * Rule (b): a telemetry stream whose session record is gone.
 *
 * @param {string} name
 * @param {Set<string>} sessionBases ids that still have a `<id>.json`
 * @returns {boolean}
 */
function isOrphanEvents(name, sessionBases) {
  if (!name.endsWith(EVENTS_SUFFIX)) return false;
  return !sessionBases.has(name.slice(0, -EVENTS_SUFFIX.length));
}

/**
 * @param {string} dir
 * @returns {string[]} regular-file entry names, or `[]` when unreadable
 */
function safeReaddir(dir) {
  try {
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * @param {string} dir
 * @param {string[]} files
 * @returns {Bucket}
 */
function toBucket(dir, files) {
  let bytes = 0;
  for (const name of files) {
    try {
      bytes += statSync(path.join(dir, name)).size;
    } catch {
      // A file that vanished between readdir and stat contributes no bytes; it
      // stays listed so the caller sees what the scan saw.
    }
  }
  return { files, bytes };
}

/**
 * @typedef {Scan & {applied: boolean, deleted: number, failed: string[], dir: string}} PruneResult
 */

/**
 * Scan, and delete only when `apply` is true.
 *
 * Deletion is per-file best-effort: one stubborn file lands in `failed` and the
 * rest still go. Returning the scan alongside the outcome lets a caller report
 * what was found and what happened from one call.
 *
 * @param {string} dir store directory
 * @param {{apply?: boolean}} [opts]
 * @returns {PruneResult}
 */
export function pruneStore(dir, opts = {}) {
  const apply = opts.apply === true;
  const scan = scanStore(dir);
  const failed = [];
  let deleted = 0;

  if (apply) {
    const targets = [
      ...scan.testEngineState.files,
      ...scan.orphanEvents.files,
      ...scan.schemaBackups.files,
    ];
    for (const name of targets) {
      try {
        unlinkSync(path.join(dir, name));
        deleted += 1;
      } catch {
        failed.push(name);
      }
    }
  }

  return { ...scan, dir, applied: apply, deleted, failed };
}

/**
 * @typedef {object} Args
 * @property {string|null} store explicit `--store`, or null for the default
 * @property {boolean} apply
 * @property {boolean} json
 * @property {boolean} help
 */

/**
 * @param {string[]} argv arguments after the script name
 * @returns {Args}
 * @throws {Error} on an unknown flag or a missing `--store` value
 */
export function parseArgs(argv) {
  const out = { store: null, apply: false, json: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--apply') out.apply = true;
    else if (a === '--json') out.json = true;
    else if (a === '--store') {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new Error('--store requires a value');
      out.store = v;
      i += 1;
    } else throw new Error(`unknown option: ${a}`);
  }
  return out;
}

/**
 * Human-readable report. Samples are capped at five names per bucket: the point
 * is to recognise the shape of what will be deleted, and a store with ten
 * thousand orphans would otherwise bury the totals.
 *
 * @param {PruneResult} result
 * @returns {string}
 */
export function formatReport(result) {
  const rows = [
    ['test-engine-state', result.testEngineState],
    ['orphan-events', result.orphanEvents],
    ['schema-backups', result.schemaBackups],
  ];
  const lines = [`store: ${result.dir}`, ''];
  for (const [label, bucket] of rows) {
    lines.push(`${label.padEnd(18)} ${String(bucket.files.length).padStart(7)} files  ${String(bucket.bytes).padStart(12)} bytes`);
    for (const name of bucket.files.slice(0, 5)) lines.push(`    ${name}`);
    if (bucket.files.length > 5) lines.push(`    ... and ${bucket.files.length - 5} more`);
  }
  lines.push('');
  lines.push(`${'total'.padEnd(18)} ${String(result.total.files).padStart(7)} files  ${String(result.total.bytes).padStart(12)} bytes`);
  lines.push(
    result.applied
      ? `deleted ${result.deleted}${result.failed.length ? `, failed ${result.failed.length}` : ''}`
      : 'dry run: nothing deleted (pass --apply to delete)',
  );
  return lines.join('\n');
}

/**
 * @param {string[]} argv arguments after the script name
 * @param {{out?: (s: string) => void, err?: (s: string) => void}} [io]
 * @returns {number} process exit code
 */
export function main(argv, io = {}) {
  const out = io.out ?? ((s) => process.stdout.write(s));
  const err = io.err ?? ((s) => process.stderr.write(s));

  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    err(`${e.message}\n${HELP}\n`);
    return 2;
  }
  if (args.help) {
    out(`${HELP}\n`);
    return 0;
  }

  const dir = args.store ?? getStoreDir();
  const result = pruneStore(dir, { apply: args.apply });

  if (args.json) {
    // The notice travels as a field rather than a leading line: `--json`
    // promises ONE parseable object on stdout, and a bare line in front of it
    // breaks every consumer. Text mode carries it as the first line.
    const payload = args.apply ? { notice: APPLY_NOTICE, ...result } : result;
    out(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    if (args.apply) out(`${APPLY_NOTICE}\n`);
    out(`${formatReport(result)}\n`);
  }
  return 0;
}

if (isMainEntry(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
