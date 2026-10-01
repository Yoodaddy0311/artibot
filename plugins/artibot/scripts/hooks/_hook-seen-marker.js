/**
 * The session-day marker of the direct-run tap: which firing of a directly
 * registered hook earns a `hook.fired` row.
 *
 * ONE ROW PER SESSION-DAY UNIT (architect review, 2026-09-29). A direct hook
 * fires on every tool call, so a row per firing put the ledger writer's module
 * graph on each Bash/Write/Edit and made the ledger grow by thousands of rows a
 * day, against owner decision O8=a1 ("1 dispatch = 1 row"). The row is the FIRST
 * firing per (UTC day, session, slot, hook), decided by a marker file that is
 * looked at BEFORE the writer is loaded ({@link fireOnceDirect}):
 *
 *   <store>/hook-seen/<UTC YYYY-MM-DD>/<sha1(session id)[:16]>.<slot>.<hook>
 *
 * WHY THIS IS ITS OWN FILE (review R1 SHOULD 2, 2026-09-30). All of it used to sit
 * in `_main-entry.js`, the module every hook imports to answer one boolean
 * (`isMainEntry`) and that `_dispatcher-utils.js` calls a zero-dependency leaf.
 * That claim stayed literally true (only `node:` imports), but the file had grown
 * a second job: about 195 lines of file-system code (`mkdirSync`, `openSync`,
 * `rmSync`, a lazily required `node:crypto`) that only a firing which reaches the
 * marker ever runs, parsed by every importer and sitting in the module graph of
 * the read-only CLIs that import `isMainEntry`. The code moved here as it was;
 * the one change is that the session-id rule is now `_main-entry.js#firingSessionId`,
 * so the tap and {@link fireOnceDirect} cannot disagree about which payloads carry one.
 *
 * LOADED ON DEMAND, NEVER STATICALLY. `_main-entry.js#tapDirectFiring` reaches this
 * file with a dynamic `import()`, and only for a firing that passed its cheap gates
 * and carries a session id. A static import in that direction would put this file
 * on the hot path of every importer, and would break every script that copies
 * `_main-entry.js` ALONE into a minimal tree with ERR_MODULE_NOT_FOUND
 * (`tests/scripts/sync-marketplace-meta.test.js` and
 * `tests/hooks/runtime-prompt-decision-wiring.test.js` both do). The import the
 * other way is safe: when this file loads, `_main-entry.js` is already evaluated.
 * The static imports here are `node:` builtins and `./_main-entry.js`, nothing
 * under `lib/` (pinned by `tests/hooks/hook-fired-direct-unit.test.js`); what the
 * flow needs from `lib/` and from the recorder still arrives through the loaders
 * {@link fireOnceDirect} is given.
 *
 * @module scripts/hooks/_hook-seen-marker
 */

import {
  closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, rmSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { DIRECT_HOOK_SLOTS, firingSessionId, nearestWorkTreeRoot } from './_main-entry.js';

/** Directory under the store that holds the markers: `<store>/hook-seen/<UTC day>/<marker>`. */
const HOOK_SEEN_DIR = 'hook-seen';

/** A hook name that cannot leave the marker's directory or start a parent segment. */
const MARKER_HOOK_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

/** A `hook-seen` child that is a UTC date; the only names the prune ever touches. */
const UTC_DATE_DIR = /^\d{4}-\d{2}-\d{2}$/;

const DAY_MS = 86_400_000;

/** Date directories older than this many days are removed by the process that opens a new one. */
const KEEP_DAYS = 7;

/**
 * The UTC calendar day of an instant, or null for one a Date cannot hold.
 *
 * @param {unknown} nowMs epoch milliseconds
 * @returns {string|null} `YYYY-MM-DD`
 */
function utcDay(nowMs) {
  if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) return null;
  const date = new Date(nowMs);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

/**
 * First 16 hex characters of the SHA-1 of a session id: the marker's name for
 * it. Hashed so an id is never written to disk under a name it chose, and so a
 * hostile one cannot carry a path separator. `node:crypto` is required here,
 * not imported at the top, so a firing that stops before it has a marker name
 * (no work tree above `cwd`, an unusable hook name) never loads it (about 3 ms
 * cold, measured 2026-09-29).
 *
 * @param {string} sessionId
 * @returns {string}
 */
function sessionDigest(sessionId) {
  const crypto = createRequire(import.meta.url)('node:crypto');
  return crypto.createHash('sha1').update(sessionId).digest('hex').slice(0, 16);
}

/**
 * A non-blank string, or null: the rule {@link directMarkerPath} holds a bare
 * session id to. `_main-entry.js#firingSessionId` applies the same rule to a
 * payload, as the recorder does, so the marker is keyed by the very id the row
 * will carry.
 *
 * @param {unknown} value
 * @returns {string|null}
 */
function nonBlankString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/**
 * The marker for one session-day unit:
 * `<storeDir>/hook-seen/<UTC YYYY-MM-DD>/<sha1(sessionId)[:16]>.<slot>.<hook>`.
 *
 * PURE: no I/O. Null -- never a guessed name -- unless every part is one the
 * marker can hold: an absolute store, a non-blank session id, a slot in
 * {@link DIRECT_HOOK_SLOTS} (the dispatcher slots have no marker because they
 * never record here), a hook name that is a plain file stem, and a valid clock.
 * The caller builds `storeDir` through `lib/project-state/store-location.js`,
 * so no `.git` spelling lives in a hook.
 *
 * @param {{storeDir?: unknown, sessionId?: unknown, slot?: unknown, hook?: unknown,
 *   nowMs?: unknown}} [args]
 * @returns {string|null}
 */
export function directMarkerPath(args) {
  try {
    const { storeDir, sessionId, slot, hook, nowMs } = args ?? {};
    if (typeof storeDir !== 'string' || !path.isAbsolute(storeDir)) return null;
    if (nonBlankString(sessionId) === null) return null;
    if (!DIRECT_HOOK_SLOTS.includes(slot)) return null;
    if (typeof hook !== 'string' || !MARKER_HOOK_NAME.test(hook)) return null;
    const day = utcDay(nowMs);
    if (day === null) return null;
    return path.join(storeDir, HOOK_SEEN_DIR, day, `${sessionDigest(sessionId)}.${slot}.${hook}`);
  } catch {
    return null;
  }
}

/**
 * Remove `hook-seen` date directories older than {@link KEEP_DAYS} days before
 * `today`. Best effort and silent: a failure leaves a stale directory for the
 * next opener, never a hook failure.
 *
 * ONLY a child whose name is a UTC date, whose date is older than the window,
 * and that is a real directory is removed. A date in the future stays (a clock
 * that moved back must not delete the present), and a link is never followed or
 * removed (`lstat`, not `stat`): the target of a link a user placed here is not
 * this function's to delete.
 *
 * @param {string} hookSeenDir the `hook-seen` directory
 * @param {string} today `YYYY-MM-DD`, the day the caller just opened
 * @returns {void}
 */
export function pruneHookSeen(hookSeenDir, today) {
  try {
    const cutoff = Date.parse(`${today}T00:00:00.000Z`) - KEEP_DAYS * DAY_MS;
    if (!Number.isFinite(cutoff)) return;
    for (const name of readdirSync(hookSeenDir)) {
      if (!UTC_DATE_DIR.test(name)) continue;
      try {
        const day = Date.parse(`${name}T00:00:00.000Z`);
        if (!Number.isFinite(day) || day >= cutoff) continue;
        const dir = path.join(hookSeenDir, name);
        const stat = lstatSync(dir);
        if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
        rmSync(dir, { recursive: true, force: true });
      } catch { /* one stale directory that will not go is not worth a failure */ }
    }
  } catch { /* nothing to prune, or nowhere to look */ }
}

/**
 * Claim a unit: create its marker with `wx`, ignoring `EEXIST`. The process that
 * creates a new date directory (a NON-recursive `mkdir`, so exactly one creator
 * sees success) also prunes the old ones. Never throws: an unwritable store
 * costs a later duplicate row, not a failed hook.
 *
 * @param {string} markerPath from {@link directMarkerPath}
 * @returns {void}
 */
function claimMarker(markerPath) {
  try {
    const dayDir = path.dirname(markerPath);
    const seenDir = path.dirname(dayDir);
    mkdirSync(seenDir, { recursive: true });
    let opened = false;
    try {
      mkdirSync(dayDir);
      opened = true;
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
    }
    try {
      closeSync(openSync(markerPath, 'wx'));
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
    }
    if (opened) pruneHookSeen(seenDir, path.basename(dayDir));
  } catch { /* a marker that cannot be written only costs a later duplicate */ }
}

/**
 * Record ONE row for a session-day unit, or find out that it already has one.
 * The decision is made from a marker file BEFORE the ledger writer is loaded:
 *
 *   1. no usable session id                     -> `no-session` (nothing loaded; the tap
 *                                                  asks the same question first, so it
 *                                                  does not even load this module)
 *   2. no git work tree above `cwd`              -> `no-work-tree`
 *   3. no valid marker name                      -> `no-marker`
 *   4. marker exists                             -> `seen` (the writer is NEVER loaded)
 *   5. else load the recorder and append; if the append is not ok -> `append-failed`
 *   6. only then create the marker (`wx`, EEXIST ignored) -> `recorded`
 *
 * NEVER CLAIM FIRST. The marker is created after a successful append, not
 * before: a tail that calls `process.exit(0)` can cut the append off, and a
 * marker created first would then have silenced the whole session-day. The cost
 * of this order is accepted: two firings of one unit that race on their FIRST
 * can both append (a rare duplicate), because neither has a marker to see yet.
 *
 * The loaders are injected so the flow is testable without the modules and so
 * the leaf keeps no static import from `lib/`; `_main-entry.js#tapDirectFiring`
 * passes the real ones. Resolves to a status string; rejects only if a loader does.
 *
 * @param {object} args
 * @param {string} args.hook the hook's name (`_main-entry.js#directHookName`)
 * @param {Record<string, string>} args.fired the `_main-entry.js#snapshotFiring` of the payload
 * @param {number} args.nowMs the clock, injected
 * @param {() => Promise<{resolveGitCommonDir: (dir: string) => (string|null)}>} args.loadCommon
 * @param {() => Promise<{resolveStoreLocation: (p: {projectRoot: string, gitCommonDir: string|null}) => {dir: string}}>} args.loadStore
 * @param {() => Promise<{recordDirectHookFired: (a: object) => ({ok: boolean})}>} args.loadRecorder
 * @returns {Promise<'recorded'|'seen'|'no-session'|'no-work-tree'|'no-marker'|'append-failed'>}
 */
export async function fireOnceDirect({ hook, fired, nowMs, loadCommon, loadStore, loadRecorder }) {
  const sessionId = firingSessionId(fired);
  if (sessionId === null) return 'no-session';
  const [common, store] = await Promise.all([loadCommon(), loadStore()]);
  const projectRoot = nearestWorkTreeRoot(fired.cwd, common.resolveGitCommonDir);
  if (projectRoot === null) return 'no-work-tree';
  const storeDir = store.resolveStoreLocation({
    projectRoot, gitCommonDir: common.resolveGitCommonDir(projectRoot),
  }).dir;
  const marker = directMarkerPath({ storeDir, sessionId, slot: fired.hook_event_name, hook, nowMs });
  if (marker === null) return 'no-marker';
  if (existsSync(marker)) return 'seen';
  const recorder = await loadRecorder();
  if (recorder.recordDirectHookFired({ hook, payload: fired, projectRoot })?.ok !== true) return 'append-failed';
  claimMarker(marker);
  return 'recorded';
}
