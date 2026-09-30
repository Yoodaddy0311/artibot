/**
 * Where the Stop / PreToolUse gates keep their loop-guard state — ONE rule.
 *
 * ── What "gate state" is ──────────────────────────────────────────────────
 * Four small files let three hooks remember what they already told the model:
 *
 *   last-main-agent-edit.timestamp   written by `mark-main-agent-edit.js` on a
 *                                    MAIN-agent Edit/Write; its mtime is "the
 *                                    last time this session edited something"
 *   last-dev-verify-sha.txt          `dev-verify-gate.js` — the working-tree
 *                                    fingerprint it last asked about; its mtime
 *                                    is "the last time it asked"
 *   last-review-gate-sha.txt         `stop-review-gate.js` — the fingerprint it
 *                                    last BLOCKED on
 *   last-pre-write-block.txt         `pre-write-guard.js` — the `session|tool|
 *                                    path` it last blocked, so the identical
 *                                    retry is let through
 *
 * They used to live in `<pluginRoot>/runtime/`, which is wrong on two counts,
 * both measured before this module existed:
 *
 *   1. ONE plugin root serves every project. The edit marker was written by an
 *      Edit in ANY project and read by the Stop gate of ANY Artibot checkout, so
 *      project A's edit fired project B's gate (and one session's fire hid
 *      another session's unverified edit).
 *   2. The plugin root is a per-VERSION directory
 *      (`~/.claude/plugins/cache/artibot/artibot/<version>/`). `ls` of the four
 *      installed versions showed four different `runtime/` contents: every
 *      update forgot what the gates had already said.
 *
 * ── The layout ────────────────────────────────────────────────────────────
 *   <store>/gates/sessions/<sha1(session_id)[:16]>/   session-scoped files
 *   <store>/gates/trees/<sha1(tree root)[:16]>/       tree-scoped file
 *
 * `<store>` is `lib/project-state/store-location.js#resolveStoreLocation(...).dir`
 * — the SAME rule the ledger, the StateStore and the spawn ledger use (decision
 * F3): `<git common dir>/artibot/` in a repository, `<projectRoot>/.artibot/
 * runtime/` when git cannot be resolved. Reusing it means the gate state sits
 * beside the ledger, survives plugin updates, and is invisible to `git status`
 * in the git case.
 *
 * WHY THE SCOPE IS SESSION OR TREE, NOT "PROJECT". F3 makes N linked worktrees
 * converge on ONE store directory — right for a ledger, wrong for "did THIS
 * window's leader edit since it was last asked". A file directly under `gates/`
 * would let one `/split` window's edit fire another's gate, which is the
 * cross-project misfire again at smaller scale.
 *
 *   - SESSION-scoped: the edit marker, the dev-verify fingerprint and the
 *     pre-write block. The first two are COMPARED BY MTIME with each other, so
 *     they must share a scope or one session's fire would make another's edit
 *     look already-verified. The third embeds the session id in its own content.
 *   - TREE-scoped: the review-gate fingerprint. It describes a working tree
 *     (`repo root | HEAD | changed files`), not a conversation; scoping it by
 *     session would make every NEW session block once more over an unchanged
 *     state, which is a behaviour change this module does not make.
 *
 * A request with no usable session id lands in the fixed `no-session` slot.
 * A writer and a reader that both lack an id still meet; one that has an id and
 * one that lacks it do not, and "no marker" is the safe direction for every
 * reader below (the gate stays quiet rather than firing on a stranger's state).
 *
 * ── Migration: there is none, on purpose ──────────────────────────────────
 * Readers NEVER look at `<pluginRoot>/runtime/<file>`. The legacy edit marker is
 * a process-global fact that cannot be attributed to a project or a session;
 * importing it would re-create the very misfire this layout removes. The
 * fingerprints are loop guards whose absence costs at most one repeated ask. And
 * an updated plugin root is a NEW directory, so a legacy read could not find the
 * previous version's files in the case that motivated this change anyway.
 * Leftover legacy files are harmless and are not deleted here.
 *
 * ── Pruning ───────────────────────────────────────────────────────────────
 * One directory per session grows without bound, so {@link pruneStaleGateState}
 * removes slot directories idle for {@link GATE_STATE_KEEP_MS}. The process that
 * CREATES a new session directory does it ({@link claimGateDir} says who), the
 * same way `scripts/hooks/_main-entry.js#claimMarker` prunes `hook-seen`.
 *
 * ── WHAT THIS MODULE CANNOT SEE ───────────────────────────────────────────
 * Whether a writer and a reader resolved the SAME project root: both are handed
 * a root by their caller, and a spelling that aliases one directory (8.3 short
 * name, case, a junction) reaches the same files, while two roots that are two
 * directories do not meet. Whether the store is writable: every write is the
 * caller's `atomicWriteSync`, which logs and never throws, so an unwritable
 * store reads back as "no state". Whether a session id survives `--resume`.
 *
 * ── Layer ─────────────────────────────────────────────────────────────────
 * L2 (`lib/project-state`). Imports siblings and `node:` built-ins only. It owns
 * a store directory, which is why `node:fs` appears here (see the L2 block in
 * `eslint.config.js`).
 *
 * @module lib/project-state/gate-markers
 */

import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { resolveGitCommonDir } from './git-common-dir.js';
import { resolveStoreLocation } from './store-location.js';

/** Directory under the store that holds every gate's state. */
export const GATES_DIR_NAME = 'gates';

/** Children of `gates/` that are keyed by session / by working tree. */
export const SESSIONS_DIR_NAME = 'sessions';
export const TREES_DIR_NAME = 'trees';

/** The slot a request without a usable session id falls into. */
export const NO_SESSION_SLOT = 'no-session';

/**
 * The four file names. FROZEN and unchanged from the plugin-root era: the
 * ledger's `deterministic-source` reasons quote `last-main-agent-edit`, and those
 * strings are hashed into `verification_id`.
 */
export const GATE_FILES = Object.freeze({
  mainAgentEdit: 'last-main-agent-edit.timestamp',
  devVerifyFingerprint: 'last-dev-verify-sha.txt',
  reviewGateFingerprint: 'last-review-gate-sha.txt',
  preWriteBlock: 'last-pre-write-block.txt',
});

/**
 * A slot directory idle this long is removed by the next session that starts.
 * Fourteen days: far longer than any live session needs its markers (a marker
 * only matters between an edit and the Stop that follows it) and short enough
 * that a year of sessions does not leave thousands of directories behind.
 */
export const GATE_STATE_KEEP_MS = 14 * 24 * 60 * 60 * 1000;

/** The only child names pruning ever touches: a 16-hex digest or the fixed slot. */
const SLOT_NAME = /^(?:[0-9a-f]{16}|no-session)$/;

/** @param {unknown} v @returns {v is string} */
function isNonBlank(v) {
  return typeof v === 'string' && v.trim() !== '';
}

/**
 * The session id a hook payload carries, or null.
 *
 * `session_id` first, `sessionId` second, non-blank only — the same rule
 * `scripts/hooks/_main-entry.js#fireOnceDirect` applies, so a writer and a
 * reader that read the same payload always read the same id.
 *
 * @param {unknown} hookData
 * @returns {string|null}
 */
export function sessionIdOf(hookData) {
  if (!hookData || typeof hookData !== 'object') return null;
  for (const key of ['session_id', 'sessionId']) {
    const value = /** @type {Record<string, unknown>} */ (hookData)[key];
    if (isNonBlank(value)) return value;
  }
  return null;
}

/**
 * The directory name for a session: first 16 hex characters of the SHA-1 of the
 * id, or {@link NO_SESSION_SLOT}. Hashed so an id is never written to disk under
 * a name it chose and a hostile one cannot carry a path separator or `..`.
 *
 * @param {unknown} sessionId
 * @returns {string}
 */
export function sessionSlot(sessionId) {
  if (!isNonBlank(sessionId)) return NO_SESSION_SLOT;
  return createHash('sha1').update(sessionId).digest('hex').slice(0, 16);
}

/**
 * The directory name for a working tree: first 16 hex characters of the SHA-1 of
 * its resolved root. Case-folded on Windows, where `C:\X` and `c:\x` are one
 * directory.
 *
 * @param {string} projectRoot
 * @returns {string}
 */
export function treeSlot(projectRoot) {
  const resolved = path.resolve(projectRoot);
  const folded = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  return createHash('sha1').update(folded).digest('hex').slice(0, 16);
}

/**
 * `<store>/gates` for a project root — the store is whatever
 * {@link resolveStoreLocation} says, never a path spelled here.
 *
 * @param {string} projectRoot absolute project root (a work-tree root)
 * @param {(root: string) => (string|null)} [resolveCommonDir] injection seam for
 *   tests; production uses the pure-fs `resolveGitCommonDir` (no git process)
 * @returns {string}
 * @throws {TypeError} when `projectRoot` is empty or not a string (the store
 *   rule's own contract)
 */
export function gatesDir(projectRoot, resolveCommonDir = resolveGitCommonDir) {
  const { dir } = resolveStoreLocation({
    projectRoot,
    gitCommonDir: resolveCommonDir(projectRoot),
  });
  return path.join(dir, GATES_DIR_NAME);
}

/**
 * Directory holding one session's gate files.
 *
 * @param {string} projectRoot
 * @param {unknown} sessionId a string, or anything else for the `no-session` slot
 * @param {(root: string) => (string|null)} [resolveCommonDir]
 * @returns {string}
 */
export function sessionGateDir(projectRoot, sessionId, resolveCommonDir) {
  return path.join(
    gatesDir(projectRoot, resolveCommonDir),
    SESSIONS_DIR_NAME,
    sessionSlot(sessionId),
  );
}

/**
 * Directory holding one working tree's gate files.
 *
 * @param {string} projectRoot
 * @param {(root: string) => (string|null)} [resolveCommonDir]
 * @returns {string}
 */
export function treeGateDir(projectRoot, resolveCommonDir) {
  return path.join(
    gatesDir(projectRoot, resolveCommonDir),
    TREES_DIR_NAME,
    treeSlot(projectRoot),
  );
}

/**
 * Create a slot directory and say whether THIS call created it.
 *
 * The parent is made recursively, the leaf with a non-recursive `mkdir`, so when
 * two processes race exactly one sees success — that one is the creator and owes
 * the prune. Never throws: an unmakeable directory returns false, and the
 * caller's own write then fails and logs (`atomicWriteSync` never throws).
 *
 * @param {string} dir
 * @returns {boolean} true only for the process that created `dir`
 */
export function claimGateDir(dir) {
  try {
    mkdirSync(path.dirname(dir), { recursive: true });
    mkdirSync(dir);
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove slot directories idle longer than `keepMs`, under `sessions/` and
 * `trees/`.
 *
 * ONLY a child whose name is a slot digest (or `no-session`), that is a REAL
 * directory (`lstat`, so a link is never followed or removed), and whose mtime
 * is older than the window is removed. A directory dated in the future stays — a
 * clock that moved back must not delete the present — and so does every name in
 * `keep`. Best effort and silent: a stale directory that will not go is left for
 * the next creator, never raised as a hook failure.
 *
 * @param {string} gatesDirPath the `gates/` directory ({@link gatesDir})
 * @param {{ nowMs?: number, keepMs?: number, keep?: string[] }} [opts]
 *   `keep` names slots to leave alone (the caller's own)
 * @returns {number} how many directories were removed
 */
export function pruneStaleGateState(gatesDirPath, opts = {}) {
  const { nowMs = Date.now(), keepMs = GATE_STATE_KEEP_MS } = opts;
  if (!isNonBlank(gatesDirPath) || !Number.isFinite(nowMs) || !Number.isFinite(keepMs)) return 0;
  const keep = new Set(Array.isArray(opts.keep) ? opts.keep : []);
  let removed = 0;
  for (const parentName of [SESSIONS_DIR_NAME, TREES_DIR_NAME]) {
    const parentDir = path.join(gatesDirPath, parentName);
    let names;
    try {
      names = readdirSync(parentDir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!SLOT_NAME.test(name) || keep.has(name)) continue;
      try {
        const dir = path.join(parentDir, name);
        const stat = lstatSync(dir);
        if (!stat.isDirectory()) continue;
        if (!(stat.mtimeMs < nowMs - keepMs)) continue;
        rmSync(dir, { recursive: true, force: true });
        removed += 1;
      } catch { /* one stale directory that will not go is not worth a failure */ }
    }
  }
  return removed;
}
