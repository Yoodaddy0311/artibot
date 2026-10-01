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
 * that never calls the tap pays nothing for it.
 *
 * ONE ROW PER SESSION-DAY UNIT (architect review, 2026-09-29). A direct hook
 * fires on every tool call, so a row per firing put the ledger writer's module
 * graph on each Bash/Write/Edit and made the ledger grow by thousands of rows a
 * day, against owner decision O8=a1 ("1 dispatch = 1 row"). The row is now the
 * FIRST firing per (UTC day, session, slot, hook), decided by a marker file
 * that is looked at BEFORE the writer is loaded.
 *
 * THE MARKER IS NOT IN THIS FILE (review R1 SHOULD 2, 2026-09-30). Its path, its
 * claim, its prune and the flow that turns a marker into "record or skip"
 * (`fireOnceDirect`) live in the sibling `_hook-seen-marker.js`, which the tap
 * reaches with a dynamic `import()` the way it reaches `lib/`, and only for a
 * firing that carries a session id. Kept here they were about 195 lines of
 * file-system code that every importer parsed and only a firing that reached the
 * marker ever ran, and they had put `mkdirSync` and `rmSync` into the module graph
 * of every read-only CLI that imports `isMainEntry`. What the marker module needs
 * from this file (`DIRECT_HOOK_SLOTS`, `nearestWorkTreeRoot`, `firingSessionId`) is
 * exported here; nothing here imports the marker module statically, and
 * `tests/hooks/hook-fired-direct-unit.test.js` pins both directions.
 *
 * @module scripts/hooks/_main-entry
 */

import { realpathSync } from 'node:fs';
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
 * The session id a {@link snapshotFiring} carries, or null: the first NON-BLANK
 * string of `session_id` and `sessionId`, in that order. The one rule for "does
 * this firing have a session", because two callers must not disagree about it:
 * the tap (a firing without one never even loads the marker module) and
 * `_hook-seen-marker.js#fireOnceDirect` (its first decision, where the id keys
 * the marker). It is also the rule `_hook-fired-record.js` reads the envelope's
 * session by, so the marker is keyed by the very id the row will carry.
 *
 * @param {Record<string, unknown>|null|undefined} fired
 * @returns {string|null}
 */
export function firingSessionId(fired) {
  for (const key of ['session_id', 'sessionId']) {
    const value = fired?.[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return null;
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

/**
 * Record that this directly registered hook was fired, and hand the payload
 * back untouched. Called at the hook's payload-parse site, in place:
 * `const hookData = tapDirectFiring(import.meta.url, parseJSON(raw));`.
 *
 * WHAT IT DOES, IN THE ORDER IT DECIDES. Nothing unless (1) recording is enabled
 * ({@link directRecordingEnabled}); (2) the calling module IS the process entry, so a
 * unit test or a sibling hook that merely imports the script never writes;
 * (3) the payload's `hook_event_name` is in {@link DIRECT_HOOK_SLOTS}, it names a
 * `cwd`, and it carries a session id ({@link firingSessionId}). Everything up to
 * here is a few property reads, so a dispatched child (slot not in the list) and
 * a firing without a session id load nothing. Then
 * `_hook-seen-marker.js#fireOnceDirect` takes over: a git work tree above `cwd`,
 * and the session-day marker, all asked of tiny modules (the marker module
 * itself, `lib/project-state/git-common-dir.js`, `store-location.js`,
 * `node:crypto`) loaded on demand. Only a firing that finds NO marker loads
 * `_hook-fired-record.js` and the ledger writer's graph (~30-65 ms to load,
 * measured 2026-09-29) and appends ONE `hook.fired` row; every later firing of
 * the same (UTC day, session, slot, hook) stops at the marker.
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
    if (firingSessionId(fired) === null) return payload;
    // The clock is read NOW, at the firing, not when the marker module has loaded.
    const nowMs = Date.now();
    import('./_hook-seen-marker.js')
      .then(({ fireOnceDirect }) => fireOnceDirect({
        hook,
        fired,
        nowMs,
        loadCommon: () => import('../../lib/project-state/git-common-dir.js'),
        loadStore: () => import('../../lib/project-state/store-location.js'),
        loadRecorder: () => import('./_hook-fired-record.js'),
      }))
      .catch(() => { /* recording is best effort: the hook must not care */ });
  } catch { /* a tap must never affect the hook it taps */ }
  return payload;
}
