/**
 * One-time adoption of the autopilot store an older build kept inside the plugin
 * root (owner decision D2, 2026-09-30).
 *
 * Before D2 the store was `<pluginRoot>/runtime/autopilot`; it is now under the
 * user-state dir (see `session-store.js#getStoreDir`). Sessions already sitting
 * at the old place must not be orphaned by the move, so the first use of the new
 * store adopts them. This module is the copy; `session-store.js` decides WHEN
 * (first `getStoreDir()` per process, default store only) and owns every path, so
 * nothing here spells the store location — it is handed `dir` and `legacy`.
 *
 * WHY COPY, NOT READ-THROUGH. A read fallback (`listSessions`/`loadSession` also
 * consulting the legacy directory) would have to be repeated in every consumer
 * that derives a path from `getStoreDir()` — telemetry, locks, memory, worktrees —
 * because each builds its own path, and an events stream split across two
 * directories is worse than either one. It also leaves the data inside the
 * version directory that `clearCache` deletes, which is the loss being fixed.
 * Copying moves the data once and every consumer then finds it where it looks.
 *
 * WHAT IS ADOPTED: each `<id>.json` session with its `<id>.events.ndjson` and
 * `<id>.json.v<n>.bak` siblings, and `memory/*.jsonl` (per-feature lessons).
 * WHAT IS NOT: `worktrees/` (a git worktree records absolute paths in the
 * repository's own `.git/worktrees/`; copying the directory would break the link,
 * so a migrated session keeps pointing at the legacy worktree while it exists)
 * and `locks/` (whether a lock still means anything is `lock.js`'s rule —
 * staleness, pid liveness, the holder's session — so `lock.js#adoptLegacyStoreLocks`
 * applies that rule to the live ones and never copies a stale one).
 *
 * COPY-IF-ABSENT, AND ONCE PER ID. The copy is an exclusive create, so a session
 * the store already has is never overwritten. A ledger beside the store records
 * every id it has dealt with — copied OR found already present — so a session
 * the user later deletes (or the pruner removes) does not come back from the
 * legacy directory that still holds it. That matters beyond tidiness: a cache
 * carried forward by the host hands the next version a snapshot of ids already
 * migrated, and the dev checkout's legacy directory never goes away.
 *
 * NON-DESTRUCTIVE: nothing is written to, moved from, or deleted in the legacy
 * directory. A legacy session an older build is still running keeps changing
 * there; the copy is a snapshot of it, not a live mirror. That is the cost of not
 * reaching into a directory this build does not own.
 *
 * @module lib/autopilot/legacy-store-adoption
 */

import path from 'node:path';
import {
  existsSync, readdirSync, readFileSync, statSync, utimesSync,
} from 'node:fs';
import { atomicCreateTextSync, atomicWriteTextSync, readJsonFileSync } from '../core/file.js';
import { sameDirPath } from '../core/platform.js';

/**
 * Ledger of ids already dealt with. No `.json` suffix: every reader of the
 * store (`listSessions`, the census, the pruner) keys on it. Mirrored by
 * `scripts/ledger/recovery-journal-census.mjs` (it may not import this module)
 * and its paired test asserts the two names stay equal.
 */
export const LEGACY_LEDGER_NAME = 'legacy-migration.ledger';

/**
 * @typedef {object} AdoptionReport
 * @property {'override'|'same-dir'|'no-legacy'|'nothing-to-adopt'|null} skipped
 *   why nothing was attempted, or null when the legacy directory was examined
 * @property {string} legacyDir
 * @property {string} storeDir
 * @property {string[]} sessions ids copied by THIS pass
 * @property {string[]} present ids the store already had (recorded, not copied)
 * @property {string[]} memory feature files copied
 * @property {number} errors files that could not be dealt with (retried by the next pass)
 */

/** `<storeDir>\0<legacyDir>` pairs already attempted by this process. */
const attempts = new Map();

/**
 * @param {string} dir
 * @param {string} legacy
 * @returns {string}
 */
function attemptKey(dir, legacy) {
  return `${dir}\u0000${legacy}`;
}

/**
 * A report for a pass that did nothing.
 *
 * @param {string} dir
 * @param {string} legacy
 * @param {AdoptionReport['skipped']} skipped
 * @returns {AdoptionReport}
 */
export function skippedReport(dir, legacy, skipped) {
  return { skipped, legacyDir: legacy, storeDir: dir, sessions: [], present: [], memory: [], errors: 0 };
}

/**
 * Run the adoption at most once per process per (store, legacy) pair. The pair
 * is claimed BEFORE the work starts, so a failure still counts as this
 * process's one attempt instead of being retried on every path computation.
 *
 * @param {string} dir - The store being adopted INTO.
 * @param {string} legacy - The legacy directory being adopted FROM.
 * @returns {void}
 */
export function adoptLegacyOnce(dir, legacy) {
  const key = attemptKey(dir, legacy);
  if (attempts.has(key)) return;
  attempts.set(key, null);
  attempts.set(key, adopt(dir, legacy));
}

/**
 * Adopt now. `force` re-evaluates a legacy directory this process has already
 * looked at, which is how a session that appeared there later gets picked up;
 * it does NOT bypass the ledger — an id dealt with once is never copied again.
 *
 * @param {string} dir
 * @param {string} legacy
 * @param {{ force?: boolean }} [opts]
 * @returns {AdoptionReport}
 */
export function adoptLegacy(dir, legacy, { force = false } = {}) {
  const key = attemptKey(dir, legacy);
  if (!force && attempts.get(key)) return attempts.get(key);
  const report = adopt(dir, legacy);
  attempts.set(key, report);
  return report;
}

/**
 * The adoption itself. Never throws: a store that cannot be adopted is still a
 * usable store, and this runs inside a path resolver.
 *
 * @param {string} dir
 * @param {string} legacy
 * @returns {AdoptionReport}
 */
function adopt(dir, legacy) {
  const report = skippedReport(dir, legacy, null);
  try {
    if (sameDirPath(dir, legacy)) return { ...report, skipped: 'same-dir' };
    if (!existsSync(legacy)) return { ...report, skipped: 'no-legacy' };

    const { sidecars, ids } = indexLegacyDir(legacy);
    const memoryNames = listFiles(path.join(legacy, 'memory'), '.jsonl');
    if (ids.length === 0 && memoryNames.length === 0) return { ...report, skipped: 'nothing-to-adopt' };

    const pass = {
      dir, legacy, report, ledger: readLedger(dir), at: new Date().toISOString(), dirty: false,
    };
    for (const id of ids) adoptSession(pass, id, sidecars.get(id) ?? []);
    for (const name of memoryNames) adoptMemoryFile(pass, name);
    if (pass.dirty) writeLedger(pass);
  } catch {
    report.errors += 1;
  }
  return report;
}

/**
 * @typedef {object} Pass
 * @property {string} dir - The store being adopted INTO.
 * @property {string} legacy - The legacy directory being adopted FROM.
 * @property {AdoptionReport} report - Filled in as the pass goes.
 * @property {{ version: number, entries: Record<string, object> }} ledger
 * @property {string} at - One timestamp for every entry this pass records.
 * @property {boolean} dirty - Whether the ledger gained an entry.
 */

/**
 * Record that `key` has been dealt with, so no later pass offers it again.
 *
 * @param {Pass} pass
 * @param {string} key
 * @param {'copied'|'present'} how
 * @returns {void}
 */
function record(pass, key, how) {
  pass.ledger.entries[key] = { at: pass.at, from: pass.legacy, how };
  pass.dirty = true;
}

/**
 * Adopt one session: its side files, then the record itself.
 *
 * @param {Pass} pass
 * @param {string} id
 * @param {string[]} sidecarNames - The `<id>` events / backup files in the legacy directory.
 * @returns {void}
 */
function adoptSession(pass, id, sidecarNames) {
  const { dir, legacy, report, ledger } = pass;
  if (Object.hasOwn(ledger.entries, id)) return;
  try {
    // A session the store already has owns its side files too; the legacy
    // events of the same id are not merged into it.
    if (existsSync(path.join(dir, `${id}.json`))) {
      report.present.push(id);
      record(pass, id, 'present');
      return;
    }
    // Side files first and the session record LAST: a reader that can see
    // `<id>.json` then also finds the events that belong to it.
    for (const name of sidecarNames) copyTextIfAbsent(path.join(legacy, name), path.join(dir, name));
    const copied = copyTextIfAbsent(path.join(legacy, `${id}.json`), path.join(dir, `${id}.json`));
    (copied ? report.sessions : report.present).push(id);
    record(pass, id, copied ? 'copied' : 'present');
  } catch {
    report.errors += 1; // not ledgered, so the next pass retries it
  }
}

/**
 * Adopt one per-feature lesson file.
 *
 * @param {Pass} pass
 * @param {string} name - File name under `memory/`.
 * @returns {void}
 */
function adoptMemoryFile(pass, name) {
  const { dir, legacy, report, ledger } = pass;
  const key = `memory/${name}`;
  if (Object.hasOwn(ledger.entries, key)) return;
  try {
    const copied = copyTextIfAbsent(path.join(legacy, 'memory', name), path.join(dir, 'memory', name));
    if (copied) report.memory.push(name);
    record(pass, key, copied ? 'copied' : 'present');
  } catch {
    report.errors += 1;
  }
}

/**
 * Persist the ledger. A failure is counted, not thrown: the copies already
 * stand, and the next pass re-derives "present" from them.
 *
 * @param {Pass} pass
 * @returns {void}
 */
function writeLedger({ dir, ledger, report }) {
  try {
    atomicWriteTextSync(path.join(dir, LEGACY_LEDGER_NAME), `${JSON.stringify(ledger, null, 2)}\n`);
  } catch {
    report.errors += 1;
  }
}

/**
 * One pass over a legacy directory: the session ids, and each id's side files.
 * Regular files only — a directory that happens to be named `x.json` is not a
 * session.
 *
 * @param {string} legacy
 * @returns {{ ids: string[], sidecars: Map<string, string[]> }}
 */
function indexLegacyDir(legacy) {
  const ids = [];
  const sidecars = new Map();
  const addSidecar = (id, name) => {
    if (!sidecars.has(id)) sidecars.set(id, []);
    sidecars.get(id).push(name);
  };
  for (const entry of readdirSync(legacy, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const { name } = entry;
    if (name.endsWith('.events.ndjson')) {
      addSidecar(name.slice(0, -'.events.ndjson'.length), name);
    } else if (/\.json\.v\d+\.bak$/.test(name)) {
      addSidecar(name.slice(0, name.indexOf('.json.v')), name);
    } else if (name.endsWith('.json')) {
      ids.push(name.slice(0, -'.json'.length));
    }
  }
  return { ids, sidecars };
}

/**
 * Names of the regular files in `dir` ending in `suffix`; `[]` when the
 * directory is absent or unreadable.
 *
 * @param {string} dir
 * @param {string} suffix
 * @returns {string[]}
 */
function listFiles(dir, suffix) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/**
 * Copy a text file to `dst` only if nothing is there, keeping the source's
 * timestamps. `bash-risk-guard#findActiveSession` picks the most recently
 * MODIFIED active session, so a copy stamped "now" would rank a months-old
 * legacy session above the one that is really live.
 *
 * The create is exclusive (`core/file.js#atomicCreateTextSync`, a hard link of a
 * fully written tmp file): an `existsSync` check followed by a rename leaves a
 * window in which two processes both pass the check, and that module measured
 * the window being hit in 190 of 200 two-process trials. A reader therefore
 * never sees a half-copied session either.
 *
 * @param {string} src
 * @param {string} dst
 * @returns {boolean} true when this call created `dst`; false when it existed
 */
function copyTextIfAbsent(src, dst) {
  const text = readFileSync(src, 'utf-8');
  const { atimeMs, mtimeMs } = statSync(src);
  if (!atomicCreateTextSync(dst, text).created) return false;
  try {
    // Fractional SECONDS, from the float `*Ms` fields: a `Date` argument would
    // truncate to whole milliseconds, and NTFS stamps are finer than that.
    utimesSync(dst, atimeMs / 1000, mtimeMs / 1000);
  } catch {
    /* an ordering hint only — the copy itself stands */
  }
  return true;
}

/**
 * @param {string} dir
 * @returns {{ version: number, entries: Record<string, object> }} never throws;
 *   an absent or corrupt ledger reads as empty, which can only re-offer an id
 *   for copying (still copy-if-absent), never overwrite one.
 */
function readLedger(dir) {
  const parsed = readJsonFileSync(path.join(dir, LEGACY_LEDGER_NAME), null);
  const entries = Object.create(null);
  if (parsed && typeof parsed === 'object' && parsed.entries && typeof parsed.entries === 'object') {
    Object.assign(entries, parsed.entries);
  }
  return { version: 1, entries };
}
