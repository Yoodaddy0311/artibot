/**
 * Session store for autopilot runs.
 * Persists state to `<state dir>/runtime/autopilot/{sessionId}.json`, where the
 * state dir is `lib/core/config.js#resolveArtibotDir()` (`~/.claude/artibot`) —
 * NOT the plugin root. See {@link getStoreDir} for why, and for the one-time
 * adoption of the store an older build kept inside the plugin root
 * ({@link migrateLegacyStore}).
 * Korean-path safe; uses atomic writes to prevent partial-write corruption.
 *
 * Schema reference: PRD docs/PRD/autopilot-mode.md section 13.4
 *
 * @module lib/autopilot/session-store
 */

import path from 'node:path';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { resolveArtibotDir } from '../core/config.js';
import { renameWithRetry } from '../core/file.js';
import {
  getHomeDir, getPluginRoot, normalizeDirPath, sameDirPath,
} from '../core/platform.js';
import { resolveRunEventsPath } from '../observability/run-events.js';
import {
  adoptLegacy, adoptLegacyOnce, isDirectory, LEGACY_LEDGER_NAME, skippedReport,
} from './legacy-store-adoption.js';
import { migrateV2toV3, SCHEMA_VERSION_V3 } from './migrate-v3.js';

/**
 * Current persisted-state schema version. Bump when the on-disk shape
 * gains a required field or changes semantics. Older state files are
 * upgraded transparently in {@link loadSession} via {@link migrateState}.
 *
 * v1: pre-versioned legacy state (no `schemaVersion` field).
 * v2: guarantees `queuedQuestions`, `checkpoints`, `timeline` arrays.
 * v3: adds `subCheckpoints`, `attemptJournal`, and `pendingPhase` — the
 *     explicit "what runs next" that disambiguates `phase` (see
 *     engine-state.js#nextTarget).
 */
export const CURRENT_SCHEMA_VERSION = SCHEMA_VERSION_V3;

/** Intermediate version stamped before the v2→v3 step, which rejects v<2. */
const SCHEMA_VERSION_V2 = 2;


/**
 * Max number of rename attempts before giving up and propagating the error.
 *
 * Raised 5 → 8 (S3, 2026-07): under full-suite cross-project worker saturation
 * the `main` pool's parallel FS churn competes with the autopilot fork, and a
 * transient Windows rename lock (EPERM/EBUSY) intermittently outlived the old
 * 5-attempt / ~310ms budget — surfacing as `renameWithRetry` throwing out of
 * `saveSession` → `persist` → `runPhase2Execute` (engine.execute-worktree
 * case 3 flake). 8 attempts with a capped backoff give a bounded ~810ms budget.
 * @type {number}
 */
const MAX_RENAME_ATTEMPTS = 8;

/**
 * Upper bound (ms) for a single inter-attempt backoff sleep. Caps the
 * exponential growth so a late attempt cannot block the synchronous save path
 * for an unbounded stretch (8 uncapped attempts would sleep 640ms before the
 * last try alone). @type {number}
 */
const MAX_RENAME_BACKOFF_MS = 250;

/**
 * This module's retry budget, passed to the shared
 * {@link renameWithRetry} in core. The two constants above carry the reason
 * for the values; core owns the loop, the transient-code set, and the sleep.
 * @type {{ attempts: number, maxBackoffMs: number }}
 */
const RENAME_RETRY_OPTS = { attempts: MAX_RENAME_ATTEMPTS, maxBackoffMs: MAX_RENAME_BACKOFF_MS };

/**
 * Resolve the autopilot runtime directory.
 * Path is constructed via path.join so Korean / spaced paths are preserved.
 *
 * THE DEFAULT is `resolveArtibotDir()/runtime/autopilot` (`~/.claude/artibot/
 * runtime/autopilot`), NOT `<pluginRoot>/runtime/autopilot` as it was before
 * owner decision D2 (2026-09-30). The plugin root is a version-scoped cache
 * directory: the host replaces it on upgrade and `scripts/update.js#clearCache`
 * prunes the stale ones afterwards, so a store anchored there was lost or
 * orphaned on every update — the same reason `resolveArtibotDir` gives for not
 * anchoring user state there. Measured 2026-09-30 on the owner's machine: three
 * cache versions (4.68.0, 4.69.0, 4.70.0) each held their OWN copy of the same
 * sessions, and one copy had diverged from the others. A single store also means
 * a single lock namespace across versions, so a 4.71 run and a 4.70 run contend
 * on one feature instead of both starting it. Everything built on this function
 * moves with it: events, `locks/`, `memory/` and `worktrees/`.
 * `ARTIBOT_STATE_DIR` (with its `ARTIBOT_STATE_DIR_HOME` pair) relocates the
 * default through `resolveArtibotDir`, on that function's terms.
 *
 * SIDE EFFECT, stated here because a path resolver is not expected to have one:
 * the first call per process for the DEFAULT store adopts what older builds left
 * behind — under the plugin root in force, in every cached version directory and
 * in the marketplace mirror (see {@link getLegacyStoreDirs} and
 * {@link migrateLegacyStore}).
 * This function is the one place every reader and writer of the store passes
 * through — `lock.js`, `memory.js`, `telemetry.js` and `worktree-manager.js`
 * call it directly — so putting the trigger here is what lets a caller that
 * never touches the session API (a lock probe, an event read) still find the
 * data. It never throws, costs one `Set` lookup after the first call, and is
 * skipped entirely while an honored override is in force.
 *
 * `ARTIBOT_AUTOPILOT_STORE_DIR` relocates that directory. It is a path knob,
 * not a test kill-switch: every read and write still happens, just somewhere
 * else, so a suite can exercise the real store code without depositing session
 * files among the real ones. A stray test write shows up in no `git status` —
 * the default store is under the user's home, and before D2 it sat in the
 * git-ignored `/runtime/` — so the cost is not a dirty working copy, it is that
 * every reader of the store population counts fixtures as sessions: {@link
 * listSessions} and, through it, `lib/autopilot/cross-session-learner.js` and
 * `scripts/hooks/bash-risk-guard.js`; `scripts/dev/prune-autopilot-store.mjs`
 * enumerates the same directory directly via this function.
 * It is read on EVERY call, because a value captured at import is already fixed
 * before a test can set it. An honored override also switches the legacy
 * adoption above OFF: a sandbox has to be hermetic, and real sessions turning
 * up inside it would be the contamination the override exists to prevent.
 *
 * `ARTIBOT_AUTOPILOT_STORE_DIR_ROOT` records the plugin root the override was
 * minted for, and the override is honored only while that is still the root in
 * force. Environment variables are inherited by spawned processes, so a test
 * that isolates a child by handing it `{ ...process.env, CLAUDE_PLUGIN_ROOT:
 * sandbox }` would otherwise have this override ride along and overrule the
 * more specific knob the child was actually given — the child would write into
 * the parent's store instead of its own.
 *
 * The pairing is REQUIRED. An override with no recorded root is an override we
 * cannot place, and "cannot place" must not mean "trust"; that is the fail-open
 * shape of a denylist. Mirrors `lib/core/config.js#resolveArtibotDir`, whose
 * `ARTIBOT_STATE_DIR` / `ARTIBOT_STATE_DIR_HOME` pair solves the same problem
 * for user state. Compared through `sameDirPath` rather than `===` so a
 * trailing separator or Windows drive-letter case does not read as a different
 * root and throw the override away — which would put writes back into the real
 * store, the exact outcome this seam exists to prevent.
 *
 * An honored override is returned through `path.resolve`, so both branches
 * yield one absolute path in the platform's own separator. This DIVERGES from
 * `resolveArtibotDir`, which hands its override back verbatim. The reason is
 * measured: consumers build on the returned directory with `path.join` —
 * `telemetry.js#getEventsPath` via `lib/observability/run-events.js:74` — which
 * emits the platform separator regardless of how the directory was spelled. An
 * override written with forward slashes, the Git Bash idiom on Windows, thus
 * produced a child path that was genuinely inside the store yet compared
 * unequal to it as a string (2026-09-21: `telemetry.test.js:40`'s
 * `startsWith(getStoreDir())` red under `C:/…/ap-probe-ctl4`, green under the
 * same directory spelled with backslashes). Normalizing at the single point
 * that mints the value fixes every consumer at once. A relative override
 * resolves against cwd, which is where fs would have placed it anyway.
 *
 * @returns {string} Absolute directory path, in the platform separator, for
 *   both the state-dir default and an honored override.
 */
export function getStoreDir() {
  const resolved = resolveStore();
  if (!resolved.overridden) adoptLegacyOnce(adoptionKey(resolved), resolved.dir, () => legacySources(resolved));
  return resolved.dir;
}

/**
 * The same directory as {@link getStoreDir}, WITHOUT the legacy adoption. For a
 * caller that must not write as a side effect of asking where the store is — a
 * dry-run tool, a path-only assertion. Everything that reads or writes the store
 * should keep calling {@link getStoreDir}: a caller that uses this one and then
 * opens files has opted out of finding the sessions an older build left behind.
 *
 * @returns {string} Absolute directory path, exactly as `getStoreDir` returns it.
 */
export function resolveStoreDir() {
  return resolveStore().dir;
}

/**
 * The store directory, without the legacy adoption {@link getStoreDir} performs.
 *
 * One observation of the plugin root, not two: the derived path and the value
 * the pairing is compared against must come from the same read, or a
 * `CLAUDE_PLUGIN_ROOT` changed between the two calls would let an override
 * minted for root A be honored while the fallback points at root B. Pure: it
 * touches no file.
 *
 * @returns {{ dir: string, pluginRoot: string, overridden: boolean }}
 */
function resolveStore() {
  const pluginRoot = getPluginRoot();
  const override = process.env.ARTIBOT_AUTOPILOT_STORE_DIR;
  const mintedFor = process.env.ARTIBOT_AUTOPILOT_STORE_DIR_ROOT;
  if (override && mintedFor && sameDirPath(mintedFor, pluginRoot)) {
    return { dir: path.resolve(override), pluginRoot, overridden: true };
  }
  return { dir: path.join(resolveArtibotDir(), 'runtime', 'autopilot'), pluginRoot, overridden: false };
}

// ---------------------------------------------------------------------------
// Legacy store adoption (owner decision D2)
// ---------------------------------------------------------------------------
//
// Before D2 the store was `<pluginRoot>/runtime/autopilot`. The copy that keeps
// those sessions from being orphaned — what it takes, what it leaves, why it is a
// copy, why it runs once per id and why the record of that is one marker file per
// id — is in `legacy-store-adoption.js`. THIS file decides WHEN it runs (the first
// `getStoreDir()` per process, for the default store only) and WHERE FROM, and
// owns every path, so that module never spells the location.

export { LEGACY_LEDGER_NAME };

/**
 * `<root>/runtime/autopilot` — where a build before D2 kept the store, for the
 * plugin root `root`.
 *
 * @param {string} root
 * @returns {string}
 */
function legacyDirOf(root) {
  return path.join(root, 'runtime', 'autopilot');
}

/**
 * What makes two adoptions "the same one" for the once-per-process memo: the
 * store and the plugin root it was asked from.
 *
 * @param {{ dir: string, pluginRoot: string }} resolved
 * @returns {string}
 */
function adoptionKey({ dir, pluginRoot }) {
  return `${dir}\u0000${pluginRoot}`;
}

/**
 * True when the state dir is the one a user gets with nothing overridden,
 * `~/.claude/artibot`. A redirected state dir (`ARTIBOT_STATE_DIR`, paired with
 * its home) is a sandbox — the test suite sets one for every worker — and the
 * user's real installed versions are none of its business.
 *
 * @returns {boolean}
 */
function stateDirIsHomeDefault() {
  return sameDirPath(resolveArtibotDir(), path.join(getHomeDir(), '.claude', 'artibot'));
}

/**
 * True when `child` lies strictly inside `parent`. `path.relative`, never a
 * string prefix; case-insensitive on Windows.
 *
 * @param {string} parent
 * @param {string} child
 * @returns {boolean}
 */
function isInside(parent, child) {
  const p = normalizeDirPath(parent);
  const c = normalizeDirPath(child);
  if (!p || !c) return false;
  const fold = (x) => (process.platform === 'win32' ? x.toLowerCase() : x);
  const rel = path.relative(fold(p), fold(c));
  if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`)) return false;
  return !path.isAbsolute(rel);
}

/**
 * A developer checkout: the plugin root of a clone of this repository —
 * `<repo>/plugins/artibot` with `<repo>/.git`, a directory, or a FILE in a linked
 * worktree. Its `runtime/autopilot` holds the sessions the test suite and the
 * developer's own runs wrote (measured 2026-09-30 in the owner's checkout: seven
 * sessions, one of them a test-fixture id, and an orphan events stream a firewall
 * test had left), so adopting them would fill a user's real store with fixtures.
 *
 * The marketplace mirror has exactly the same layout — it is a git clone — and is
 * NOT one: it is where real runs were measured (all four of the owner's sessions
 * record a `lockPath` inside it), so anything under the marketplaces directory is
 * exempt.
 *
 * @param {string} root
 * @returns {boolean}
 */
function isDevCheckoutRoot(root) {
  if (path.basename(root) !== 'artibot') return false;
  const plugins = path.dirname(root);
  if (path.basename(plugins) !== 'plugins') return false;
  if (!existsSync(path.join(path.dirname(plugins), '.git'))) return false;
  return !isInside(path.join(getHomeDir(), '.claude', 'plugins', 'marketplaces'), root);
}

/**
 * Newest version first. Numeric, not lexical: 4.10.0 is newer than 4.9.0. Names
 * that are not versions sort after every version, by name.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function compareVersionsDesc(a, b) {
  const va = /^(\d+)\.(\d+)\.(\d+)/.exec(a);
  const vb = /^(\d+)\.(\d+)\.(\d+)/.exec(b);
  if (va && vb) {
    for (let i = 1; i <= 3; i += 1) {
      const diff = Number(vb[i]) - Number(va[i]);
      if (diff !== 0) return diff;
    }
  } else if (va) {
    return -1;
  } else if (vb) {
    return 1;
  }
  if (a === b) return 0;
  return a < b ? 1 : -1;
}

/**
 * @param {string} dir
 * @returns {string[]} names of the subdirectories of `dir`; `[]` when it is absent
 */
function subdirectories(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * The plugin roots the host has cached, newest version first:
 * `~/.claude/plugins/cache/artibot/artibot/<version>`.
 *
 * @param {string} home
 * @returns {string[]}
 */
function installedVersionRoots(home) {
  const cacheRoot = path.join(home, '.claude', 'plugins', 'cache', 'artibot', 'artibot');
  return subdirectories(cacheRoot).sort(compareVersionsDesc).map((name) => path.join(cacheRoot, name));
}

/**
 * The marketplace mirrors that carry the plugin:
 * `~/.claude/plugins/marketplaces/<name>/plugins/artibot`.
 *
 * @param {string} home
 * @returns {string[]}
 */
function marketplaceMirrorRoots(home) {
  const marketplaces = path.join(home, '.claude', 'plugins', 'marketplaces');
  return subdirectories(marketplaces).sort().map((name) => path.join(marketplaces, name, 'plugins', 'artibot'));
}

/**
 * Every directory an older build could have left sessions in, in precedence
 * order: the plugin root in force, then — for the default state dir only — every
 * cached version newest first, then the marketplace mirrors. Only directories
 * that exist, each once, never the store itself and never a developer checkout.
 *
 * Reading the plugin root in force alone was the first version's whole source
 * list, and it missed the case the move exists for: a session that lives only in
 * an OLDER version directory. The host keeps those around until `clearCache`
 * prunes them, and a copy of the runtime directory is what it carries forward —
 * not a guarantee any one version holds every session.
 *
 * @param {{ dir: string, pluginRoot: string, overridden: boolean }} resolved
 * @returns {string[]}
 */
function legacySources({ dir, pluginRoot, overridden }) {
  if (overridden) return [];
  const roots = [pluginRoot];
  if (stateDirIsHomeDefault()) {
    const home = getHomeDir();
    roots.push(...installedVersionRoots(home), ...marketplaceMirrorRoots(home));
  }
  const sources = [];
  for (const root of roots) {
    const source = legacyDirOf(root);
    if (isDevCheckoutRoot(root) || sameDirPath(source, dir)) continue;
    if (!isDirectory(source) || sources.some((seen) => sameDirPath(seen, source))) continue;
    sources.push(source);
  }
  return sources;
}

/**
 * The directories the legacy adoption reads from, in precedence order (see
 * `legacySources`); `[]` while an honored override redirects the store (a sandbox
 * must stay hermetic). Pure: it reads directory listings and writes nothing.
 *
 * @returns {string[]}
 */
export function getLegacyStoreDirs() {
  return legacySources(resolveStore());
}

/**
 * Adopt the legacy stores into the current one now. Normally unnecessary —
 * {@link getStoreDir} does this on its own — and exported for an explicit
 * re-run (`force`) and for tests.
 *
 * `force` re-evaluates sources this process has already looked at, which is how a
 * session that appeared there later gets picked up. It does NOT bypass the
 * markers: an id dealt with once is never copied again.
 *
 * @param {{ force?: boolean }} [opts]
 * @returns {import('./legacy-store-adoption.js').AdoptionReport}
 *   `sessions` are the ids copied by THIS pass, `present` the ids the store
 *   already had (recorded, not copied), `memory` the feature files copied, and
 *   `errors` the files that could not be dealt with (retried by the next pass).
 */
export function migrateLegacyStore({ force = false } = {}) {
  const resolved = resolveStore();
  if (resolved.overridden) return skippedReport(resolved.dir, [], 'override');
  return adoptLegacy(adoptionKey(resolved), resolved.dir, () => legacySources(resolved), { force });
}

/**
 * Resolve the absolute path of a session JSON file.
 * @param {string} sessionId
 * @returns {string}
 */
export function getSessionPath(sessionId) {
  if (!sessionId || typeof sessionId !== 'string') {
    throw new TypeError('sessionId must be a non-empty string');
  }
  return path.join(getStoreDir(), `${sessionId}.json`);
}

/**
 * Atomically persist a session state object.
 * Creates parent dir if missing. Stamps {@link CURRENT_SCHEMA_VERSION} when
 * the caller has not already supplied a `schemaVersion` field.
 *
 * Failure of either JSON.stringify or writeFileSync triggers tmp-file
 * cleanup before re-throwing, so a corrupt half-written file is never
 * left behind on disk (atomic rename is the only path to the final name).
 *
 * The final rename is retried via {@link renameWithRetry} to absorb transient
 * Windows file locks (antivirus / OneDrive). After retries are exhausted the
 * original error still propagates with tmp cleanup, so the contract is unchanged.
 *
 * @param {object} state - Session state matching PRD section 13.4
 * @returns {string} absolute file path written
 */
export function saveSession(state) {
  if (!state || typeof state !== 'object' || !state.sessionId) {
    throw new TypeError('state.sessionId is required');
  }
  if (state.schemaVersion === undefined || state.schemaVersion === null) {
    state.schemaVersion = CURRENT_SCHEMA_VERSION;
  }
  const filePath = getSessionPath(state.sessionId);
  const dir = dirname(filePath);
  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  // JSON.stringify is called outside the tmp-cleanup try/catch on purpose:
  // if serialization throws (circular ref, BigInt, etc.) no tmp file was
  // ever created, so there is nothing to clean up.
  const payload = JSON.stringify(state, null, 2);
  backupBeforeUpgrade(state, filePath);
  try {
    writeFileSync(tmp, payload, 'utf-8');
    renameWithRetry(tmp, filePath, RENAME_RETRY_OPTS);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* ignore — tmp may not exist if writeFileSync threw early */ }
    throw err;
  }
  return filePath;
}

/**
 * Copy the pre-upgrade bytes aside, once, before a newer-schema state
 * overwrites them. The decision is made from the file on disk, not from a
 * marker on the object: `loadSession` deliberately does NOT re-persist
 * (`getStatus()`/`listSessions` load every session, so a persist-on-load would
 * rewrite the whole store on a read), and any in-memory marker is lost the
 * moment a caller clones the state (`{...state}`, JSON round-trip) before
 * saving it. Reading the current file's `schemaVersion` survives both.
 *
 * @param {object} state
 * @param {string} filePath
 * @returns {void}
 */
function backupBeforeUpgrade(state, filePath) {
  const to = state.schemaVersion;
  if (typeof to !== 'number' || !Number.isFinite(to)) return;
  try {
    if (!existsSync(filePath)) return;
    const onDisk = JSON.parse(readFileSync(filePath, 'utf-8'))?.schemaVersion;
    const from = typeof onDisk === 'number' && Number.isFinite(onDisk) ? onDisk : 1;
    if (from >= to) return;
    const backupPath = `${filePath}.v${from}.bak`;
    if (!existsSync(backupPath)) copyFileSync(filePath, backupPath);
  } catch {
    /* best-effort: a missing backup must never block the save itself */
  }
}

/**
 * Load a session by id. Returns null if missing or unreadable.
 *
 * Legacy state is transparently upgraded via {@link migrateState}, **in memory
 * only**. The file on disk is left exactly as it was; the upgrade lands on the
 * first {@link saveSession} of the returned object, which also takes the
 * one-time `.v<old>.bak`. Re-persisting here would mean `getStatus()` — which
 * loads every session in the store — rewrites the whole store on a read.
 *
 * Migration failure is treated as advisory: the original (untouched)
 * parsed state is returned so the caller never sees a hard error from
 * the recovery layer. A `warn`-level telemetry event is best-effort
 * appended; telemetry import is lazy to avoid a load-time cycle.
 *
 * @param {string} sessionId
 * @returns {object|null}
 */
export function loadSession(sessionId) {
  let parsed;
  try {
    const filePath = getSessionPath(sessionId);
    if (!existsSync(filePath)) return null;
    const raw = readFileSync(filePath, 'utf-8');
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return parsed;
  if (!isLegacyState(parsed)) return parsed;
  let migrated;
  try {
    migrated = migrateState(parsed);
  } catch (err) {
    // Migration must never crash the loader — surface advisory warning instead.
    emitMigrationWarn(sessionId, err);
    return parsed;
  }
  return migrated;
}

/**
 * Determine whether a parsed state object predates {@link CURRENT_SCHEMA_VERSION}.
 * Missing, non-numeric, or numerically-lower `schemaVersion` all count as legacy.
 *
 * @param {object} state
 * @returns {boolean}
 */
export function isLegacyState(state) {
  if (!state || typeof state !== 'object') return false;
  const v = state.schemaVersion;
  if (v === undefined || v === null) return true;
  if (typeof v !== 'number' || !Number.isFinite(v)) return true;
  return v < CURRENT_SCHEMA_VERSION;
}

/**
 * Pure migration step. Produces a new state object upgraded to
 * {@link CURRENT_SCHEMA_VERSION}; the input is not mutated.
 *
 * v1 → v2 changes:
 *   - Ensure `queuedQuestions`, `checkpoints`, `timeline` are arrays
 *     (engine.js code paths assume `.push()` works on these slots).
 *   - Stamp `schemaVersion`.
 *
 * v2 → v3 then runs as its own leaf step ({@link migrateV2toV3}) plus
 * {@link reconcileV3}. The chain is ordered because `migrateV2toV3` rejects
 * anything below v2, so v1 input must be stamped v2 first.
 *
 * Idempotent: calling on an already-current object returns an equivalent one.
 *
 * @param {object} state
 * @returns {object} migrated state (new reference)
 */
export function migrateState(state) {
  if (!state || typeof state !== 'object') {
    throw new TypeError('migrateState: state must be an object');
  }
  const next = { ...state };
  if (!Array.isArray(next.queuedQuestions)) next.queuedQuestions = [];
  if (!Array.isArray(next.checkpoints)) next.checkpoints = [];
  // `timeline` is deliberately NOT initialized here any more. It was a ghost:
  // this line was its only writer and it only ever wrote `[]` — nothing in the
  // codebase appended a phase record to it, so the crash detector that read it
  // was permanently fail-open. Phase history lives in the NDJSON event log
  // (`telemetry.appendEvent`), which `replay.js#findUnterminatedPhases` reads.
  // Legacy sessions on disk may still carry a stale `timeline` array; it is
  // simply ignored rather than migrated, since it never held real data.
  next.schemaVersion = SCHEMA_VERSION_V2;
  return reconcileV3(migrateV2toV3(next));
}

/**
 * v3 reconcile — fill the slots `migrateV2toV3` does not own.
 *
 * `pendingPhase` is the delicate one. A v2 session frozen at `PAUSED` recorded
 * only `lastPhase`, and the v2 reader's meaning of that pair was "resume by
 * re-entering lastPhase". Copying it into `pendingPhase` preserves exactly that
 * — it does NOT claim the phase succeeded. If the session also has an open
 * `activePhaseAttempt`, `settleOutstandingAttempt` still pauses the resume
 * before `pendingPhase` is ever read.
 *
 * @param {object} state
 * @returns {object} reconciled state (new reference)
 */
function reconcileV3(state) {
  const next = { ...state };
  if (!Array.isArray(next.attemptJournal)) next.attemptJournal = [];
  if (next.phase === 'PAUSED' && next.pendingPhase === undefined) {
    next.pendingPhase = typeof next.lastPhase === 'string' ? next.lastPhase : null;
  }
  return next;
}

/**
 * Best-effort migration-failure warning. Lazy-imports telemetry so the
 * session-store ↔ telemetry pair does not form a static load cycle.
 *
 * @param {string} sessionId
 * @param {Error} err
 */
function emitMigrationWarn(sessionId, err) {
  // Lazy + fire-and-forget: any failure in the warning path itself is swallowed.
  import('./telemetry.js')
    .then(({ appendEvent }) => {
      try {
        appendEvent(sessionId, {
          type: 'schema-migration-failed',
          level: 'warn',
          message: `schemaVersion migration aborted: ${err?.message ?? 'unknown error'}`,
          data: { error: String(err?.message ?? err) },
        });
      } catch { /* ignore */ }
    })
    .catch(() => { /* ignore */ });
}

/**
 * List all stored session ids (without .json extension).
 * @returns {string[]}
 */
export function listSessions() {
  try {
    const dir = getStoreDir();
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.slice(0, -5));
  } catch {
    return [];
  }
}

/**
 * Delete a session file. Returns true on success, false if missing.
 * @param {string} sessionId
 * @returns {boolean}
 */
export function deleteSession(sessionId) {
  try {
    const filePath = getSessionPath(sessionId);
    if (!existsSync(filePath)) return false;
    unlinkSync(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Delete a session file AND its telemetry stream.
 *
 * Separate from {@link deleteSession} on purpose. `deleteSession` removes only
 * the session JSON, so a caller that creates sessions in a loop — every test
 * `afterAll` in `tests/autopilot/` — leaves the `.events.ndjson` behind forever.
 * Measured 2026-08-28: `runtime/autopilot/` held 10,484 ndjson against 2,446
 * json, a ratio that is exactly that leak. Widening `deleteSession` itself was
 * rejected: it is an exported, barrel-re-exported API (`index.js:138`) and the
 * event log is the post-mortem record for a crashed run, so throwing it away by
 * default would remove evidence someone may still want. Opting in says "this
 * session was disposable" — which only the caller knows.
 *
 * The events path is resolved through `lib/observability/run-events.js` rather
 * than `telemetry.js`: telemetry imports `getStoreDir` from this module
 * (`telemetry.js:19`), so importing it back would close a cycle. `run-events`
 * is a leaf (node builtins + `core/file.js` only).
 *
 * Locks are NOT removed. They are keyed by featureKey, not sessionId
 * (`lock.js:80`), so a session id alone cannot name one; `releaseLock` owns
 * that path.
 *
 * Pre-upgrade `.v<n>.bak` copies are swept too: they are written by the same
 * disposable sessions, and leaving them behind would recreate the exact ndjson
 * leak measured above in a second file family.
 *
 * @param {string} sessionId
 * @returns {{ session: boolean, events: boolean, backups: number }} What was actually removed.
 */
export function deleteSessionArtifacts(sessionId) {
  const session = deleteSession(sessionId);
  let events = false;
  try {
    const eventsPath = resolveRunEventsPath(getStoreDir(), sessionId);
    if (existsSync(eventsPath)) {
      unlinkSync(eventsPath);
      events = true;
    }
  } catch {
    // Best-effort, mirroring deleteSession: cleanup must never fail a caller.
  }
  return { session, events, backups: deleteSchemaBackups(sessionId) };
}

/**
 * Remove every `<sessionId>.json.v<n>.bak` left by a schema upgrade.
 * @param {string} sessionId
 * @returns {number} how many backup files were removed
 */
function deleteSchemaBackups(sessionId) {
  let removed = 0;
  try {
    const dir = getStoreDir();
    if (!existsSync(dir)) return 0;
    const prefix = `${sessionId}.json.v`;
    for (const name of readdirSync(dir)) {
      if (!name.startsWith(prefix) || !name.endsWith('.bak')) continue;
      try {
        unlinkSync(path.join(dir, name));
        removed += 1;
      } catch { /* ignore a single stubborn file */ }
    }
  } catch {
    /* best-effort */
  }
  return removed;
}

/**
 * Generate a fresh session id of form ap-YYYYMMDD-HHmmss-xxxxxx.
 * The 6-char random suffix prevents collisions when multiple sessions are
 * created within the same UTC second (e.g., parallel tests). 36^6 ≈ 2.18B
 * keyspace makes a 200-sample collision ~0.0009%/run (vs ~1.18%/run at 4 char).
 * @returns {string}
 */
export function newSessionId() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const ymd = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
  const hms = `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
  const suffix = Math.random().toString(36).slice(2, 8).padEnd(6, '0');
  return `ap-${ymd}-${hms}-${suffix}`;
}
