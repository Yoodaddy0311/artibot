/**
 * One-time adoption of the autopilot store an older build kept inside the plugin
 * root (owner decision D2, 2026-09-30).
 *
 * Before D2 the store was `<pluginRoot>/runtime/autopilot`; it is now under the
 * user-state dir (see `session-store.js#getStoreDir`). Sessions already sitting
 * at the old places must not be orphaned by the move, so the first use of the new
 * store adopts them. This module is the copy; `session-store.js` decides WHEN
 * (first `getStoreDir()` per process, default store only) and WHERE FROM (every
 * place an older build could have left sessions, in precedence order — see
 * `getLegacyStoreDirs`), and owns every path, so nothing here spells the store
 * location: it is handed `dir` and a list of source directories.
 *
 * WHY COPY, NOT READ-THROUGH. A read fallback (`listSessions`/`loadSession` also
 * consulting the legacy directories) would have to be repeated in every consumer
 * that derives a path from `getStoreDir()` — telemetry, locks, memory, worktrees —
 * because each builds its own path, and an events stream split across two
 * directories is worse than either one. It also leaves the data inside the
 * version directories that `clearCache` deletes, which is the loss being fixed.
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
 * SEVERAL SOURCES, ONE COPY PER ID. The same session id can sit in several source
 * directories — the host copies a previous version's runtime forward, so each
 * version holds a snapshot of the ones before it. The copy adopted is the
 * FRESHEST (latest mtime; a tie goes to the earlier source in precedence order,
 * which is the newer directory): a build still running in an older directory
 * keeps writing there after the snapshot was taken, so the older directory can
 * hold the newer state. Side files come from the same source as the record.
 *
 * COPY-IF-ABSENT, AND ONCE PER ID. The copy is an exclusive create, so a session
 * the store already has is never overwritten. Every id dealt with — copied OR
 * found already present — gets a MARKER FILE beside the store, so a session the
 * user later deletes (or the pruner removes) does not come back from the legacy
 * directories that still hold it. That matters beyond tidiness: a cache carried
 * forward by the host hands the next version a snapshot of ids already migrated.
 *
 * WHY MARKER FILES AND NOT ONE LEDGER FILE. The first version kept a single JSON
 * ledger, read at the start of a pass and rewritten at its end. Two plugin
 * versions adopting at once each wrote the ledger they had built and the last
 * writer won: the reviewer measured 40 ids lost across 15 of 15 concurrent runs
 * and a deleted session reappearing in 3 of 3. A marker is created exclusively,
 * one file per id, so there is no shared file to overwrite and no
 * read-modify-write to interleave. The existence of the marker IS the record, and
 * it is checked at the moment each id is handled rather than once per pass, so a
 * marker another process wrote mid-pass is honoured.
 *
 * NON-DESTRUCTIVE: nothing is written to, moved from, or deleted in a legacy
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
import { atomicCreateTextSync } from '../core/file.js';
import { sameDirPath } from '../core/platform.js';

/**
 * The adoption ledger: a DIRECTORY beside the store holding one marker file per
 * id dealt with (`session.<id>`, `memory.<file>`). Not a `.json` file and not a
 * `.json`-suffixed anything: every reader of the store (`listSessions`, the
 * census, the pruner) keys on that suffix, and its presence beside a store is how
 * the census tells "this store has adopted" from "this store never has".
 * Mirrored by `scripts/ledger/recovery-journal-census.mjs` (it may not import this
 * module); its paired test asserts the two names stay equal.
 */
export const LEGACY_LEDGER_NAME = 'legacy-migration.ledger';

/**
 * @typedef {object} AdoptionReport
 * @property {'override'|'no-legacy'|'nothing-to-adopt'|null} skipped
 *   why nothing was attempted, or null when the sources were examined
 * @property {string[]} legacyDirs the source directories offered to this pass
 * @property {string} storeDir
 * @property {string[]} sessions ids copied by THIS pass
 * @property {string[]} present ids the store already had (recorded, not copied)
 * @property {string[]} memory feature files copied
 * @property {number} errors files that could not be dealt with (retried by the next pass)
 */

/** Reports of the passes this process has run, by the caller's key. */
const attempts = new Map();

/**
 * A report for a pass that did nothing.
 *
 * @param {string} dir
 * @param {string[]} legacyDirs
 * @param {AdoptionReport['skipped']} skipped
 * @returns {AdoptionReport}
 */
export function skippedReport(dir, legacyDirs, skipped) {
  return { skipped, legacyDirs, storeDir: dir, sessions: [], present: [], memory: [], errors: 0 };
}

/**
 * Run the adoption at most once per process per `key`. The key is claimed BEFORE
 * the work starts, so a failure still counts as this process's one attempt
 * instead of being retried on every path computation, and `getSources` — which
 * reads directories — runs only when the pass actually does.
 *
 * @param {string} key - What makes two calls "the same adoption" (store + plugin root).
 * @param {string} dir - The store being adopted INTO.
 * @param {() => string[]} getSources - The directories to adopt FROM, in precedence order.
 * @returns {void}
 */
export function adoptLegacyOnce(key, dir, getSources) {
  if (attempts.has(key)) return;
  attempts.set(key, null);
  attempts.set(key, adopt(dir, safeSources(getSources)));
}

/**
 * Adopt now. `force` re-evaluates sources this process has already looked at,
 * which is how a session that appeared there later gets picked up; it does NOT
 * bypass the markers — an id dealt with once is never copied again.
 *
 * @param {string} key
 * @param {string} dir
 * @param {() => string[]} getSources
 * @param {{ force?: boolean }} [opts]
 * @returns {AdoptionReport}
 */
export function adoptLegacy(key, dir, getSources, { force = false } = {}) {
  if (!force && attempts.get(key)) return attempts.get(key);
  const report = adopt(dir, safeSources(getSources));
  attempts.set(key, report);
  return report;
}

/**
 * @param {() => string[]} getSources
 * @returns {string[]} `[]` when enumerating the sources throws
 */
function safeSources(getSources) {
  try {
    return getSources();
  } catch {
    return [];
  }
}

/**
 * The adoption itself. Never throws: a store that cannot be adopted is still a
 * usable store, and this runs inside a path resolver.
 *
 * @param {string} dir
 * @param {string[]} sources
 * @returns {AdoptionReport}
 */
function adopt(dir, sources) {
  const report = skippedReport(dir, sources, null);
  try {
    const live = sources.filter((source) => !sameDirPath(source, dir) && isDirectory(source));
    if (live.length === 0) return { ...report, skipped: 'no-legacy' };

    const { sessions, memory } = gather(live);
    if (sessions.size === 0 && memory.size === 0) return { ...report, skipped: 'nothing-to-adopt' };

    const pass = { dir, report, at: new Date().toISOString() };
    for (const [id, candidate] of sessions) adoptSession(pass, id, candidate);
    for (const [name, candidate] of memory) adoptMemoryFile(pass, name, candidate);
  } catch {
    report.errors += 1;
  }
  return report;
}

/**
 * @param {string} dir
 * @returns {boolean} true when `dir` exists and is a directory
 */
export function isDirectory(dir) {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * @param {string} file
 * @returns {number} the file's mtime in ms, or 0 when it cannot be read
 */
function mtimeOf(file) {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * @typedef {object} Candidate
 * @property {string} legacy - The source directory this copy would come from.
 * @property {number} mtimeMs - That copy's record (or file) mtime.
 * @property {string[]} [sidecars] - Its side files, for a session.
 */

/**
 * Everything the sources offer, one candidate per session id and per memory
 * file: the FRESHEST copy, and on a tie the one from the earlier source.
 *
 * @param {string[]} sources in precedence order
 * @returns {{ sessions: Map<string, Candidate>, memory: Map<string, Candidate> }}
 */
function gather(sources) {
  const sessions = new Map();
  const memory = new Map();
  const offer = (into, key, candidate) => {
    const held = into.get(key);
    if (!held || candidate.mtimeMs > held.mtimeMs) into.set(key, candidate);
  };
  for (const legacy of sources) {
    const { ids, sidecars } = indexLegacyDir(legacy);
    for (const id of ids) {
      offer(sessions, id, {
        legacy, mtimeMs: mtimeOf(path.join(legacy, `${id}.json`)), sidecars: sidecars.get(id) ?? [],
      });
    }
    for (const name of listFiles(path.join(legacy, 'memory'), '.jsonl')) {
      offer(memory, name, { legacy, mtimeMs: mtimeOf(path.join(legacy, 'memory', name)) });
    }
  }
  return { sessions, memory };
}

/**
 * @typedef {object} Pass
 * @property {string} dir - The store being adopted INTO.
 * @property {AdoptionReport} report - Filled in as the pass goes.
 * @property {string} at - One timestamp for every marker this pass writes.
 */

/**
 * The marker for one id: a file inside the ledger directory.
 *
 * @param {string} dir
 * @param {'session'|'memory'} kind
 * @param {string} name
 * @returns {string}
 */
function markerFile(dir, kind, name) {
  return path.join(dir, LEGACY_LEDGER_NAME, `${kind}.${name}`);
}

/**
 * Record that `name` has been dealt with, so no later pass offers it again. An
 * exclusive create: if another process recorded it first, that is the same fact
 * and nothing is overwritten. A failure is counted, not thrown — the copy
 * already stands, and the next pass re-derives "present" from it.
 *
 * @param {Pass} pass
 * @param {'session'|'memory'} kind
 * @param {string} name
 * @param {'copied'|'present'} how
 * @param {string} from
 * @returns {void}
 */
function record(pass, kind, name, how, from) {
  try {
    atomicCreateTextSync(markerFile(pass.dir, kind, name), `${JSON.stringify({ at: pass.at, from, how })}\n`);
  } catch {
    pass.report.errors += 1;
  }
}

/**
 * Adopt one session: its side files, then the record itself.
 *
 * @param {Pass} pass
 * @param {string} id
 * @param {Candidate} candidate
 * @returns {void}
 */
function adoptSession(pass, id, candidate) {
  const { dir, report } = pass;
  const { legacy, sidecars } = candidate;
  // Checked NOW, not once per pass: a marker another process wrote while this
  // one was busy with earlier ids must still be honoured.
  if (existsSync(markerFile(dir, 'session', id))) return;
  try {
    // A session the store already has owns its side files too; the legacy
    // events of the same id are not merged into it.
    if (existsSync(path.join(dir, `${id}.json`))) {
      report.present.push(id);
      record(pass, 'session', id, 'present', legacy);
      return;
    }
    // Side files first and the session record LAST: a reader that can see
    // `<id>.json` then also finds the events that belong to it.
    for (const name of sidecars) copyTextIfAbsent(path.join(legacy, name), path.join(dir, name));
    const copied = copyTextIfAbsent(path.join(legacy, `${id}.json`), path.join(dir, `${id}.json`));
    (copied ? report.sessions : report.present).push(id);
    record(pass, 'session', id, copied ? 'copied' : 'present', legacy);
  } catch {
    report.errors += 1; // not recorded, so the next pass retries it
  }
}

/**
 * Adopt one per-feature lesson file.
 *
 * @param {Pass} pass
 * @param {string} name - File name under `memory/`.
 * @param {Candidate} candidate
 * @returns {void}
 */
function adoptMemoryFile(pass, name, candidate) {
  const { dir, report } = pass;
  if (existsSync(markerFile(dir, 'memory', name))) return;
  try {
    const copied = copyTextIfAbsent(
      path.join(candidate.legacy, 'memory', name),
      path.join(dir, 'memory', name),
    );
    if (copied) report.memory.push(name);
    record(pass, 'memory', name, copied ? 'copied' : 'present', candidate.legacy);
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
