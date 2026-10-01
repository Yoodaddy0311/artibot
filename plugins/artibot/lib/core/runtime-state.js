/**
 * Runtime state — where GLOBAL and SESSION hook state lives (O2).
 *
 * WHY THIS MODULE EXISTS. Hooks used to keep `current-effort.json`,
 * `token-usage-session.json`, `user-profile.json`, `first-run-state.json`, … in
 * `<pluginRoot>/runtime/`. In a marketplace install the plugin root is a
 * version-scoped cache directory (`~/.claude/plugins/cache/artibot/artibot/<v>/`)
 * that Claude Code replaces on update, and every session of every project shares
 * whichever one is current. Measured 2026-09-30: cache dirs 4.67.0–4.70.0 each held
 * their own `runtime/` (first-run-state.json 3/4, self-control-welcomed.marker 4/4,
 * user-profile.json 3/4), so each update re-showed the welcome banner and
 * restarted the observe-only counter; and one flat `current-effort.json` was
 * overwritten by whichever session wrote last.
 *
 * WHERE STATE LIVES NOW. Under the artibot STATE dir — `resolveArtibotDir()`, i.e.
 * `~/.claude/artibot` (redirectable with `ARTIBOT_STATE_DIR`, which tests use):
 *
 *   <state>/runtime/<file>                          GLOBAL: one per user, survives updates
 *   <state>/runtime/sessions/<session_id>/<file>    SESSION: one per Claude Code session
 *
 * Under the install.sh layout the plugin root IS `~/.claude/artibot`, so the state
 * dir and the plugin root are the same directory and `runtime/` is where it always
 * was; in a marketplace install they differ, and the state dir is the one that
 * outlives the plugin build. There is NO config switch between the two: the shell
 * statusline cannot read `artibot.config.json`, so a switch would split the readers
 * from the writers again.
 *
 * WHAT IS WHERE (each verified against its writer, see the O2 report):
 *   SESSION  current-effort.json · current-task-budget.json · token-usage-session.json
 *            · current-teammates.json · long-context-active.json
 *   GLOBAL   user-profile.json · first-run-state.json · self-control-welcomed.marker
 *            · macro-suggestions.json · memory-metrics.json
 *
 * READING A SESSION FILE (who may fall back to what). A reader that knows its session —
 * a usable `session_id` — reads THAT session's file and nothing else: no flat file, no
 * legacy one. A flat file belongs to no session in particular (it is what a payload with
 * no `session_id` wrote, or what a pre-O2 hook left), so falling back to it shows one
 * session another session's teammates or token count — reproduced in review on
 * 2026-09-30: a session with no file of its own rendered
 * `👥 ghost-from-other-session | ~987K tokens`. A reader with NO usable session id may
 * take the flat files (the state dir's, then the plugin root's legacy copy) only for the
 * files in {@link SESSIONLESS_FALLBACK_FILES} — `current-effort.json`, whose record
 * carries its own identity gate — and gets nothing for the rest.
 *
 * MIGRATION (copy-if-absent). A GLOBAL file that is absent at its new path is
 * copied, once, from the legacy `<pluginRoot>/runtime/` copy — and, when the
 * plugin root is itself a version directory (`…/4.71.0`), from the newest copy in
 * a SIBLING version directory (newest by file mtime, not by semver: the most recently
 * written data wins), because in a marketplace install the state to
 * carry over was written by the PREVIOUS version, not the running one. The copy
 * is an exclusive create (`file.js#atomicCreateTextSync`), so a concurrent writer
 * is never overwritten and a reader never sees a half-copied file, and the legacy
 * file is left in place (a session still running the old build may be using it).
 * SESSION files are never migrated: they are per-session, short-lived, and the
 * effort record carries a 10-minute expiry.
 *
 * SESSION DIRECTORIES DO NOT GROW WITHOUT BOUND: {@link sweepSessionDirs} removes
 * `sessions/<id>/` directories idle longer than {@link SESSION_DIR_MAX_AGE_MS} and
 * caps the survivors at {@link SESSION_DIR_KEEP}. `scripts/hooks/session-start.js`
 * calls it on every session start. So everything under `sessions/<id>/` is disposable,
 * whatever wrote it: durable state must not be parked there.
 *
 * WHAT THIS MODULE DOES NOT DO:
 *   - It does not decide what a writer writes, or make any writer use it. Every
 *     writer has to call it; a writer that still joins `pluginRoot` + `runtime`
 *     itself is invisible to it. The wired writers are pinned by
 *     `tests/firewall/runtime-state-survives-update.test.js`.
 *   - It does not migrate anything when the state dir already has the file, even
 *     if the legacy copy is newer — copy-if-absent is not a merge.
 *   - It does not know whether a hook payload's `session_id` names the session a
 *     reader is in. For SubagentStart/Stop it is the PARENT session (measured
 *     2026-09-30 in the repo ledger's `hook.fired` rows, see workflow-status.js
 *     `payloadSessionId`); for the statusLine payload it is the documented schema,
 *     not re-measured.
 *
 * @module lib/core/runtime-state
 */

import path from 'node:path';
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';

import { resolveArtibotDir } from './config.js';
import { atomicCreateTextSync } from './file.js';
import { getPluginRoot, sameDirPath } from './platform.js';

/** Directory under the state dir that holds runtime state. */
export const RUNTIME_DIRNAME = 'runtime';

/** Directory under `runtime/` that holds one sub-directory per session. */
export const SESSIONS_DIRNAME = 'sessions';

/** A session directory idle this long is removed by {@link sweepSessionDirs}. */
export const SESSION_DIR_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** At most this many session directories survive a sweep (newest first). */
export const SESSION_DIR_KEEP = 256;

/**
 * The session-scoped files a reader with NO usable session id may still take from the
 * flat locations (the state dir's, then the plugin root's legacy copy). Only the effort
 * record qualifies: it names its own session and prompt and expires, so a flat one that
 * belongs to somebody else is refused by `task-budget.js#readEffortRecord`. The others —
 * a teammate roster, a token count, a budget, a long-context marker — carry no identity,
 * so a flat copy is some other session's and there is nothing honest to show.
 * `scripts/hooks/statusline.sh#state_file` spells the same list; a test pins the two.
 */
export const SESSIONLESS_FALLBACK_FILES = Object.freeze(['current-effort.json']);

const SESSION_ID_MAX_LENGTH = 120;

/** The directory name Claude Code's plugin cache gives a version: `4.70.0`. */
const SEMVER_DIRNAME = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

/**
 * @returns {string} `<state dir>/runtime` — read on EVERY call, so the
 *   `ARTIBOT_STATE_DIR` seam works (`config.js#ARTIBOT_DIR` is frozen at import).
 */
export function resolveRuntimeDir() {
  return path.join(resolveArtibotDir(), RUNTIME_DIRNAME);
}

/**
 * Reduce a session id to characters that cannot leave `sessions/`.
 *
 * The rule is the one `lib/observability/decision-events.js#sanitizeRunId` and the
 * F05 effort records already used; `scripts/hooks/statusline.sh` re-implements it
 * with bash parameter expansion (no process is forked per render) and
 * `tests/hooks/statusline-runtime-state.test.js` pins the two equal for ASCII ids
 * (session ids are UUIDs).
 *
 * @param {unknown} raw
 * @returns {string} '' when there is nothing usable — callers then treat the
 *   prompt as session-less.
 */
export function sanitizeSessionId(raw) {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[.-]+/, '')
    .slice(0, SESSION_ID_MAX_LENGTH);
}

/**
 * @param {string} fileName
 * @throws {TypeError} when it is not a bare file name — every caller passes a
 *   constant, so this is a programmer error, not an input error.
 */
function assertBareFileName(fileName) {
  if (
    typeof fileName !== 'string'
    || fileName === ''
    || fileName === '.'
    || fileName === '..'
    || path.basename(fileName) !== fileName
  ) {
    throw new TypeError(`runtime-state: not a bare file name: ${String(fileName)}`);
  }
}

/**
 * @param {unknown} sessionId
 * @returns {string|null} `<state>/runtime/sessions/<id>`, or null when the id is unusable.
 */
export function resolveSessionDir(sessionId) {
  const sid = sanitizeSessionId(sessionId);
  return sid ? path.join(resolveRuntimeDir(), SESSIONS_DIRNAME, sid) : null;
}

/**
 * @param {unknown} sessionId
 * @param {string} fileName - a bare file name
 * @returns {string|null} the session-scoped path, or null when the id is unusable.
 */
export function resolveSessionStatePath(sessionId, fileName) {
  assertBareFileName(fileName);
  const dir = resolveSessionDir(sessionId);
  return dir ? path.join(dir, fileName) : null;
}

/**
 * WRITER side of a session-scoped file: the session's own path when the session is
 * identifiable, otherwise the flat file in the runtime dir (a payload with no
 * `session_id` — old hosts, headless probes — keeps the pre-O2 single-slot behaviour,
 * now at a stable location). Of the flat files only `current-effort.json` is read back
 * by current code ({@link SESSIONLESS_FALLBACK_FILES}); the other four are left for
 * pre-O2 readers, such as an old `statusline.sh` copy.
 *
 * @param {unknown} sessionId
 * @param {string} fileName - a bare file name
 * @returns {string}
 */
export function resolveScopedStatePath(sessionId, fileName) {
  return resolveSessionStatePath(sessionId, fileName) ?? path.join(resolveRuntimeDir(), fileName);
}

/**
 * READER side of a session-scoped file.
 *
 *   - A reader with a usable session id gets ONE candidate: that session's own file. No
 *     flat or legacy fallback — a flat file belongs to no session in particular, so
 *     falling back to it would show this session another session's state (see the
 *     module header).
 *   - A reader with no usable session id gets, for the files in
 *     {@link SESSIONLESS_FALLBACK_FILES} only, the flat file in the state dir and then
 *     the flat file under `pluginRoot` (state a hook wrote before O2 — the same file as
 *     the first entry on the install.sh layout, and then listed once). For every other
 *     file the chain is empty.
 *
 * @param {unknown} sessionId
 * @param {string} fileName - a bare file name
 * @param {{ pluginRoot?: string }} [opts]
 * @returns {string[]} candidates, best first; possibly empty
 */
export function resolveSessionReadChain(sessionId, fileName, { pluginRoot } = {}) {
  assertBareFileName(fileName);
  const sessionPath = resolveSessionStatePath(sessionId, fileName);
  if (sessionPath) return [sessionPath];
  if (!SESSIONLESS_FALLBACK_FILES.includes(fileName)) return [];

  const flat = path.join(resolveRuntimeDir(), fileName);
  const chain = [flat];
  if (typeof pluginRoot === 'string' && pluginRoot) {
    const legacy = path.join(pluginRoot, RUNTIME_DIRNAME, fileName);
    if (!sameDirPath(legacy, flat)) chain.push(legacy);
  }
  return chain;
}

/**
 * @param {string} file
 * @returns {number|null} mtime of a regular file, else null.
 */
function regularFileMtimeMs(file) {
  try {
    const st = statSync(file);
    return st.isFile() ? st.mtimeMs : null;
  } catch {
    return null;
  }
}

/**
 * Legacy copies of `relPath`, best first: the plugin root's own, then — when the plugin
 * root is a version directory — the copies in sibling version directories, newest file
 * first. A plugin root whose name is not a version (a dev checkout, `~/.claude/artibot`)
 * scans nothing beside it.
 *
 * @param {string} relPath - e.g. `runtime/first-run-state.json`
 * @param {string} [pluginRoot]
 * @returns {string[]}
 */
function legacyCandidates(relPath, pluginRoot) {
  const root = typeof pluginRoot === 'string' && pluginRoot ? pluginRoot : getPluginRoot();
  const candidates = [path.join(root, relPath)];
  const self = path.basename(root);
  if (!SEMVER_DIRNAME.test(self)) return candidates;

  let names;
  try {
    names = readdirSync(path.dirname(root));
  } catch {
    return candidates;
  }
  const siblings = [];
  for (const name of names) {
    if (name === self || !SEMVER_DIRNAME.test(name)) continue;
    const file = path.join(path.dirname(root), name, relPath);
    const mtimeMs = regularFileMtimeMs(file);
    if (mtimeMs !== null) siblings.push({ file, mtimeMs });
  }
  siblings.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates.concat(siblings.map((s) => s.file));
}

/**
 * @param {string} file
 * @returns {string|null}
 */
function readLegacyText(file) {
  try {
    return readFileSync(file, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Copy a legacy file to `destPath` if — and only if — `destPath` does not exist yet.
 * Never throws; a migration that cannot happen leaves the caller with an empty state,
 * which is exactly what it would have had.
 *
 * @param {string} destPath - the new location (absolute)
 * @param {string} relPath - the same file relative to a plugin root, e.g.
 *   `runtime/first-run-state.json`
 * @param {{ pluginRoot?: string, extraSources?: string[] }} [opts]
 *   `extraSources`: absolute fallbacks tried after the plugin-root candidates.
 * @returns {{ migrated: boolean, reason: string, from?: string }}
 */
export function migrateLegacyFile(destPath, relPath, { pluginRoot, extraSources } = {}) {
  try {
    if (existsSync(destPath)) return { migrated: false, reason: 'present' };
    const sources = legacyCandidates(relPath, pluginRoot)
      .concat(Array.isArray(extraSources) ? extraSources : []);
    for (const source of sources) {
      if (sameDirPath(source, destPath)) continue;
      const content = readLegacyText(source);
      if (content === null) continue;
      const created = atomicCreateTextSync(destPath, content);
      return created.created
        ? { migrated: true, reason: 'copied', from: source }
        : { migrated: false, reason: 'raced' };
    }
    return { migrated: false, reason: 'no-legacy' };
  } catch {
    return { migrated: false, reason: 'error' };
  }
}

/**
 * The location of a GLOBAL state file named the way the config names them — relative
 * (`runtime/first-run-state.json`) or absolute. Relative resolves under the STATE dir,
 * never the plugin root; absolute is the operator's explicit choice and is returned as is.
 *
 * Pure: it does not migrate. Use {@link resolveGlobalStateFile} on a path that is read.
 *
 * @param {string} relOrAbs
 * @returns {string}
 */
export function resolveGlobalStatePath(relOrAbs) {
  return path.isAbsolute(relOrAbs) ? relOrAbs : path.join(resolveArtibotDir(), relOrAbs);
}

/**
 * {@link resolveGlobalStatePath} plus the copy-if-absent migration for a relative path.
 * An absolute path is never migrated.
 *
 * @param {string} relOrAbs
 * @param {{ pluginRoot?: string, extraSources?: string[] }} [opts]
 * @returns {string}
 */
export function resolveGlobalStateFile(relOrAbs, opts = {}) {
  const file = resolveGlobalStatePath(relOrAbs);
  if (!path.isAbsolute(relOrAbs)) migrateLegacyFile(file, relOrAbs, opts);
  return file;
}

/**
 * Newest mtime among a directory and its entries, so a session that is still writing one
 * small file keeps its whole directory. (A rewrite in place does not touch the directory's
 * own mtime, which is why the entries are read.)
 *
 * @param {string} dir
 * @returns {number|null} null when `dir` is not a readable directory.
 */
function newestMtimeMs(dir) {
  let st;
  try {
    st = statSync(dir);
  } catch {
    return null;
  }
  if (!st.isDirectory()) return null;
  let newest = st.mtimeMs;
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return newest;
  }
  for (const name of entries) {
    try {
      newest = Math.max(newest, statSync(path.join(dir, name)).mtimeMs);
    } catch {
      // raced away between readdir and stat
    }
  }
  return newest;
}

/**
 * @param {string} dir
 * @returns {boolean} true when the directory is gone.
 */
function removeDir(dir) {
  try {
    rmSync(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove idle session directories and cap the rest.
 *
 *   1. a directory whose newest entry is older than `maxAgeMs` goes;
 *   2. of the survivors only the newest `keep` stay.
 *
 * A directory named in `protect` (the caller's own session) is never removed and does
 * not use up a `keep` slot. Only directories whose name is already a sanitized session id
 * are considered, so a plain file or a directory somebody else put under `sessions/` is
 * left alone. Never throws.
 *
 * @param {{ now?: number, maxAgeMs?: number, keep?: number, protect?: string[] }} [opts]
 * @returns {{ scanned: number, removed: number, kept: number }}
 */
export function sweepSessionDirs(opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const maxAgeMs = Number.isFinite(opts.maxAgeMs) && opts.maxAgeMs >= 0
    ? opts.maxAgeMs
    : SESSION_DIR_MAX_AGE_MS;
  const keep = Number.isInteger(opts.keep) && opts.keep >= 0 ? opts.keep : SESSION_DIR_KEEP;
  const protectedIds = new Set(
    (Array.isArray(opts.protect) ? opts.protect : []).map(sanitizeSessionId).filter(Boolean),
  );

  const root = path.join(resolveRuntimeDir(), SESSIONS_DIRNAME);
  let names;
  try {
    names = readdirSync(root);
  } catch {
    return { scanned: 0, removed: 0, kept: 0 };
  }

  let scanned = 0;
  let removed = 0;
  let kept = 0;
  const live = [];
  for (const name of names) {
    if (sanitizeSessionId(name) !== name) continue;
    const dir = path.join(root, name);
    const mtimeMs = newestMtimeMs(dir);
    if (mtimeMs === null) continue;
    scanned += 1;
    if (protectedIds.has(name)) {
      kept += 1;
    } else if (now - mtimeMs > maxAgeMs) {
      if (removeDir(dir)) removed += 1;
      else kept += 1;
    } else {
      live.push({ dir, mtimeMs });
    }
  }

  live.sort((a, b) => b.mtimeMs - a.mtimeMs);
  live.forEach((entry, index) => {
    if (index < keep || !removeDir(entry.dir)) kept += 1;
    else removed += 1;
  });
  return { scanned, removed, kept };
}
