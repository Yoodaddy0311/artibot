/**
 * Canonical direct-run guard for hook modules.
 *
 * Every hook is spawned as its own Node process with its payload on stdin, and
 * is ALSO imported directly by tests and by sibling hooks reusing an export.
 * Those two facts conflict: a bare top-level `main()` blocks on stdin forever
 * under import and hangs the suite. So each hook gates `main()` on this helper.
 *
 * This lives in its own leaf module — not in `_dispatcher-utils.js` — because
 * ~50 hooks import it on the spawn hot path and must not pay for that module's
 * `node:child_process` and `lib/core/hook-utils.js` graph just to answer one
 * boolean. `_dispatcher-utils.js` re-exports it, so the dispatcher import sites
 * and their tests keep working unchanged.
 *
 * ── THE DIRECT-RUN TAP (OB-24 / R1) ─────────────────────────────────────────
 * The second export family here, {@link tapDirectFiring} and its helpers,
 * exists for one reason: this is the one module every directly registered hook
 * ALREADY imports on its existing `isMainEntry` line, so the tap reaches all 21
 * scripts without adding an import line to any of them (and without moving a
 * single cited line number: 17 prose `file:line` citations in 15 files, measured
 * 2026-09-29). It adds no top-level work and no state, and its only static
 * imports are `node:` builtins: this file stays a dependency-free leaf, which
 * is load-bearing beyond the hot path
 * (`tests/scripts/sync-marketplace-meta.test.js` copies a minimal subset of the
 * plugin into a temp repo, `_main-entry.js` included, and runs a CI script that
 * imports `isMainEntry` from it; a static import of anything under `lib/` here
 * is `ERR_MODULE_NOT_FOUND` there, measured 2026-09-29). Whatever the tap needs
 * from `lib/` it loads on demand, only when a hook actually fires, and a hook
 * that never calls the tap pays nothing for it. `node:crypto` is loaded the same
 * way (once, at the first marker name), because ~50 hooks import this file and
 * only the tap needs a hash.
 *
 * ONE ROW PER SESSION-DAY UNIT (architect review, 2026-09-29). A direct hook
 * fires on every tool call, so a row per firing put the ledger writer's module
 * graph on each Bash/Write/Edit and made the ledger grow by thousands of rows a
 * day, against owner decision O8=a1 ("1 dispatch = 1 row"). The row is now the
 * FIRST firing per (UTC day, session, slot, hook), decided by a marker file
 * that is looked at BEFORE the writer is loaded ({@link fireOnceDirect}).
 *
 * @module scripts/hooks/_main-entry
 */

import {
  closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, realpathSync, rmSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Detect whether the current module was invoked as the main entry point.
 * Cross-platform — handles Windows drive-letter URLs.
 *
 * Decodes with `fileURLToPath`, never `new URL(...).pathname`. A URL pathname is
 * percent-ENCODED while `process.argv[1]` is a raw filesystem path, so the two
 * stop matching the moment the install path holds anything URL-unsafe — and the
 * hook then silently does nothing when spawned. Measured 2026-08-10 by
 * comparing both forms from the same module under each path shape:
 *
 *   plain           current=true   fixed=true
 *   "with space"    current=FALSE  fixed=true   (%20)
 *   "바탕 화면"      current=FALSE  fixed=true   (%EB%B0%94…)
 *   "tilde~name"    current=FALSE  fixed=true   (%7E — hits Windows 8.3 short
 *                                                names such as HEECHA~1)
 *   "hash#tag"      current=FALSE  fixed=true   (# opens a URL fragment, which
 *                                                truncates the pathname)
 *   "paren(1)"      current=true   fixed=true   (parens are not encoded)
 *
 * The default install path (`C:\Users\<name>\…`) is ASCII and space-free, so the
 * bug was latent there — but every hook routes through this helper, so a user
 * whose profile name contains a space or non-ASCII character would lose all of
 * them at once. `scripts\utils\index.js` documents the same trap from the
 * opposite direction (path -> URL).
 *
 * Second spelling gap, same failure mode, found 2026-08-14: Node resolves the
 * MAIN module to its realpath before handing it to `import.meta.url`, while
 * `process.argv[1]` stays exactly as the command spelled it. Reach a hook
 * through a symlink or a Windows junction and the two disagree, so the guard
 * returns false and the hook exits 0 having done nothing — the same silent
 * shape as the encoding bug above, from the opposite cause. Measured with a
 * junction (link -> me) over one probe file:
 *
 *   node <dir>\me\probe.js     fired=true
 *   node <dir>\link\probe.js   fired=FALSE  (argv[1] keeps `link`,
 *                                             import.meta.url says `me`)
 *
 * So the string compare is a fast path and a miss falls through to a realpath
 * compare of both sides. Identity remains the contract: a DIFFERENT file has a
 * different realpath and still returns false. That direction is the one to
 * protect — a false negative loses a hook, but a false positive would fire
 * main() on a plain import, which is what this guard exists to prevent.
 *
 * @param {string} importMetaUrl `import.meta.url` of the caller
 * @returns {boolean}
 */
export function isMainEntry(importMetaUrl) {
  try {
    if (!process.argv[1]) return false;
    const self = path.resolve(fileURLToPath(importMetaUrl));
    const argv1 = path.resolve(process.argv[1]);
    if (argv1 === self) return true; // no fs call on the common path
    return realpath(argv1) === realpath(self);
  } catch {
    return false;
  }
}

/**
 * Canonical spelling of a path, or the path as given when it cannot be resolved
 * (does not exist yet, permission denied). `realpathSync.native` also collapses
 * Windows 8.3 short names; it is not guaranteed on every platform, hence the
 * fallback to the JS implementation.
 *
 * `node:fs` does not reintroduce the graph cost the module header guards
 * against: the loader has already instantiated it in every Node process, unlike
 * `node:child_process` and `lib/core/hook-utils.js`.
 *
 * @param {string} p
 * @returns {string}
 */
function realpath(p) {
  try {
    return (realpathSync.native || realpathSync)(p);
  } catch {
    return p;
  }
}

// ---------------------------------------------------------------------------
// Direct-run tap (OB-24 / R1) -- see the module header
// ---------------------------------------------------------------------------

/**
 * The ten host events registered DIRECTLY in `hooks/hooks.json`, i.e. with no
 * dispatcher in front of them. Measured 2026-09-29 from `hooks.json` and
 * `dispatch-table.json`: 24 registrations, 21 distinct scripts, exactly these
 * events. Every other command in `hooks.json` goes through one of the six
 * dispatchers, which write their own `hook.fired` row.
 *
 * AN ALLOWLIST, AND THAT IS THE DOUBLE-COUNT GUARD. Five scripts are both
 * direct hooks and dispatcher handlers (pre-write-guard, tool-tracker,
 * memory-tracker, subagent-handler, workflow-status). A dispatcher spawns the
 * same script with the same stdin, so the process cannot tell who launched it.
 * The payload can: a dispatched child carries its dispatcher's slot in
 * `hook_event_name` (PostToolUse, SubagentStop, SessionStart, ...), which is not
 * in this list, so it records nothing and the dispatcher's own row stays the
 * only one. An event the host adds later is not in the list either, so it
 * records nothing until someone lists it: fail-closed in the generating
 * direction. `tests/hooks/hook-fired-direct.test.js` derives the expected set
 * from the two registration files and fails on any drift.
 *
 * @type {ReadonlyArray<string>}
 */
export const DIRECT_HOOK_SLOTS = Object.freeze([
  'PreToolUse',
  'PreCompact',
  'PostCompact',
  'SubagentStart',
  'TeammateIdle',
  'TaskCompleted',
  'PermissionRequest',
  'PostToolUseFailure',
  'Notification',
  'InstructionsLoaded',
]);

/**
 * The nearest ancestor of `cwd` (itself included) that is a git work-tree root,
 * or null. "Is a work-tree root" is asked of `resolveCommonDir`, which callers
 * pass in as `lib/project-state/git-common-dir.js#resolveGitCommonDir`: the
 * pure-fs resolver the ledger writer uses to place its file, so a directory
 * qualifies exactly when a ledger path can be derived from it. That is step 1 of
 * `lib/git/project-root.js#resolveProjectRoot` WITHOUT its step 2: that resolver
 * falls back to `git rev-parse` -- a child process, measured at 181-270 ms in
 * that module's header and 240-360 ms per dispatcher in `_hook-fired-record.js`
 * -- for a directory with no work tree above it. A PreToolUse hook has a 5 s
 * budget and runs on every tool call; it must not start a process to decide
 * whether to write one line, so a directory outside any repository is simply
 * not recorded. The start directory is canonicalised first (short names,
 * symlinks), like the resolver, so both name one repository by one string.
 *
 * Asking the resolver, rather than joining the marker name by hand, is also what
 * `tests/firewall/hooks-no-dotgit-literal.test.js` requires of every hook. It is
 * INJECTED, not imported, because this file may not import from `lib/` (see the
 * module header).
 *
 * Never throws, never spawns.
 *
 * @param {unknown} cwd
 * @param {(dir: string) => (string|null)} resolveCommonDir
 * @returns {string|null}
 */
export function nearestWorkTreeRoot(cwd, resolveCommonDir) {
  try {
    if (typeof cwd !== 'string' || cwd.trim() === '' || typeof resolveCommonDir !== 'function') return null;
    let dir = realpath(path.resolve(cwd));
    for (;;) {
      if (resolveCommonDir(dir) !== null) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  } catch {
    return null;
  }
}

/**
 * The name a hook script is recorded under: its file name without a `.js`,
 * `.mjs` or `.cjs` extension. One rule, shared by the tap ({@link
 * directHookName}) and by `scripts/ledger/existence-audit.mjs`, which lists the
 * same scripts from `hooks/hooks.json` and must spell them the way the rows do.
 *
 * @param {string} fileName a script path or base name
 * @returns {string}
 */
export function hookStem(fileName) {
  return path.basename(String(fileName)).replace(/\.[cm]?js$/, '');
}

/**
 * The name a directly registered hook is recorded under: its file name without
 * the extension. That is the spelling `hooks/dispatch-table.json` gives the same
 * scripts (`pre-write-guard`, `session-ledger` for `session-ledger.mjs`), so a
 * script on both paths is ONE name to the Existence Audit.
 *
 * @param {string} importMetaUrl `import.meta.url` of the hook script
 * @returns {string}
 * @throws {TypeError} when the argument is not a file URL
 */
export function directHookName(importMetaUrl) {
  return hookStem(fileURLToPath(importMetaUrl));
}

/**
 * The payload keys `_hook-fired-record.js#recordDirectHookFired` reads, and
 * nothing else. `tests/hooks/hook-fired-direct.test.js` pins that an envelope
 * built from the snapshot equals one built from the full payload, so a key the
 * recorder starts reading without being listed here turns that test red.
 *
 * @type {ReadonlyArray<string>}
 */
export const FIRING_PAYLOAD_KEYS = Object.freeze([
  'hook_event_name',
  'session_id',
  'sessionId',
  'cwd',
  'tool_use_id',
  'prompt_id',
  'mission_id',
  'missionId',
]);

/**
 * A copy of just the {@link FIRING_PAYLOAD_KEYS} a payload holds as strings.
 *
 * WHY A COPY. The tap does not await the recorder, so the recorder runs after
 * the hook has gone on to use, and sometimes mutate, the very object it parsed
 * (`workflow-status` adds `tasks` to it; `context-tracker` echoes it to stdout).
 * Handing over a snapshot means a later mutation cannot change what is recorded,
 * and a 64 KB prompt is not kept alive until the writer has loaded.
 *
 * @param {object} payload
 * @returns {Record<string, string>}
 */
export function snapshotFiring(payload) {
  const out = {};
  for (const key of FIRING_PAYLOAD_KEYS) {
    const value = payload[key];
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

/**
 * Is direct recording switched on for a process with this environment? Three
 * literals of `ARTIBOT_HOOK_FIRED_DIRECT` decide it:
 *
 *   `off`   never. The operator's escape hatch, and the control arm of the
 *           byte-identity tests.
 *   `on`    always, even inside the vitest runner. What the R1 suite sets.
 *   other   (unset, empty, a typo): ON, except inside the vitest runner.
 *
 * So a typo cannot silence the audit in production: default ON is the point.
 *
 * WHY THE TEST RUNNER IS OFF BY DEFAULT. Measured 2026-09-29 on the whole suite:
 * 35 existing tests in 8 files spawn these very hooks and assert the EXACT
 * contents of the ledger they leave (`route-observe-pre.test.js` "writes exactly
 * one route.selected receipt", `host-payload-contract.test.js` "touches no
 * ledger at all", `post-compact-rehydrate.test.js` "no store directory is
 * created", ...). A `hook.fired` row beside theirs turns every one of them red
 * for a reason that has nothing to do with what they test. vitest sets `VITEST`
 * in its workers and a spawned child inherits it, so this one condition covers
 * them all without editing any; a suite that WANTS the row (this change's) says
 * `on`. It also means a suite run in a real worktree cannot append rows to the
 * developer's live central ledger. The better long-term seam is a default
 * `off` in `tests/setup/state-dir.js`, which then makes this `VITEST` clause
 * redundant and removable; that file is not this change's to edit.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {boolean}
 */
export function directRecordingEnabled(env = process.env) {
  const mode = env.ARTIBOT_HOOK_FIRED_DIRECT;
  if (mode === 'off') return false;
  if (mode === 'on') return true;
  return !env.VITEST;
}

// ---------------------------------------------------------------------------
// Session-day marker: one row per (UTC day, session, slot, hook)
// ---------------------------------------------------------------------------

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
 * not imported at the top: ~50 hooks import this file and only a firing that
 * reaches the marker needs a hash (about 3 ms cold, measured 2026-09-29).
 *
 * @param {string} sessionId
 * @returns {string}
 */
function sessionDigest(sessionId) {
  const crypto = createRequire(import.meta.url)('node:crypto');
  return crypto.createHash('sha1').update(sessionId).digest('hex').slice(0, 16);
}

/**
 * A non-blank string, or null. The recorder reads the session id through the
 * same rule, so the marker is keyed by the very id the row will carry.
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
 *   1. no usable session id                     -> `no-session` (nothing loaded)
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
 * the leaf keeps no static import from `lib/`; {@link tapDirectFiring} passes
 * the real ones. Resolves to a status string; rejects only if a loader does.
 *
 * @param {object} args
 * @param {string} args.hook the hook's name ({@link directHookName})
 * @param {Record<string, string>} args.fired the {@link snapshotFiring} of the payload
 * @param {number} args.nowMs the clock, injected
 * @param {() => Promise<{resolveGitCommonDir: (dir: string) => (string|null)}>} args.loadCommon
 * @param {() => Promise<{resolveStoreLocation: (p: {projectRoot: string, gitCommonDir: string|null}) => {dir: string}}>} args.loadStore
 * @param {() => Promise<{recordDirectHookFired: (a: object) => ({ok: boolean})}>} args.loadRecorder
 * @returns {Promise<'recorded'|'seen'|'no-session'|'no-work-tree'|'no-marker'|'append-failed'>}
 */
export async function fireOnceDirect({ hook, fired, nowMs, loadCommon, loadStore, loadRecorder }) {
  const sessionId = nonBlankString(fired?.session_id) ?? nonBlankString(fired?.sessionId);
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

/**
 * Record that this directly registered hook was fired, and hand the payload
 * back untouched. Called at the hook's payload-parse site, in place:
 * `const hookData = tapDirectFiring(import.meta.url, parseJSON(raw));`.
 *
 * WHAT IT DOES, IN THE ORDER IT DECIDES. Nothing unless (1) recording is enabled
 * ({@link directRecordingEnabled}); (2) the calling module IS the process entry, so a
 * unit test or a sibling hook that merely imports the script never writes;
 * (3) the payload's `hook_event_name` is in {@link DIRECT_HOOK_SLOTS} and it
 * names a `cwd`. Everything up to here is a few property reads, so a dispatched
 * child (slot not in the list) loads nothing. Then {@link fireOnceDirect} takes
 * over: a session id, a git work tree above `cwd`, and the session-day marker,
 * all asked of tiny modules (`lib/project-state/git-common-dir.js`,
 * `store-location.js`, `node:crypto`) loaded on demand. Only a firing that finds
 * NO marker loads `_hook-fired-record.js` and the ledger writer's graph (~30-65
 * ms to load, measured 2026-09-29) and appends ONE `hook.fired` row; every later
 * firing of the same (UTC day, session, slot, hook) stops at the marker.
 *
 * NOT AWAITED, ON PURPOSE. The tap returns before anything has loaded. The
 * hook's own synchronous work (guard chain, `writeStdout`) therefore runs
 * BEFORE any recorder code does, which is the ordering the PreToolUse hooks'
 * observe contract asks for ("the append happens AFTER writeStdout"); the
 * pending imports keep the process alive until the row is written, and a hook
 * that finishes first simply exits a little later. A tail that calls
 * `process.exit(0)` immediately (the `exit: true` error handlers) can cut a row
 * that has not landed yet: an under-count on the crash path, never a wrong row,
 * and the next firing retries because the marker is only claimed after the append.
 *
 * FAIL-SILENT. It never throws, never writes stdout or stderr, and never
 * changes the exit code: the whole chain ends in a `catch` that discards, and
 * the recorder catches its own faults.
 *
 * @template T
 * @param {string} importMetaUrl `import.meta.url` of the calling hook script
 * @param {T} payload the parsed host payload, returned as given
 * @returns {T}
 */
export function tapDirectFiring(importMetaUrl, payload) {
  try {
    if (!directRecordingEnabled(process.env)) return payload;
    if (!isMainEntry(importMetaUrl)) return payload;
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return payload;
    if (!DIRECT_HOOK_SLOTS.includes(payload.hook_event_name)) return payload;
    const hook = directHookName(importMetaUrl);
    const fired = snapshotFiring(payload);
    if (typeof fired.cwd !== 'string' || fired.cwd.trim() === '') return payload;
    fireOnceDirect({
      hook,
      fired,
      nowMs: Date.now(),
      loadCommon: () => import('../../lib/project-state/git-common-dir.js'),
      loadStore: () => import('../../lib/project-state/store-location.js'),
      loadRecorder: () => import('./_hook-fired-record.js'),
    }).catch(() => { /* recording is best effort: the hook must not care */ });
  } catch { /* a tap must never affect the hook it taps */ }
  return payload;
}
