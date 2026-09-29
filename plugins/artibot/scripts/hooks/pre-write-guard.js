#!/usr/bin/env node
/**
 * Write-Before-Read Guard Hook.
 *
 * PreToolUse hook for Write/Edit: blocks modification of existing files
 * that have not been Read in the current session.
 * PostToolUse hook for Read: records file paths to the session tracking file.
 *
 * Tracking file: /tmp/artibot-read-tracking-{sessionId}.json
 *
 * ── OBSERVE CONTRACT (PRD R-03 "행동 변화 0") ────────────────────────────────
 *  T-39 adds recording only, at the single block point in `handleWriteGuard`.
 *  No new block, no lifted block, no changed `reason` byte; the append runs
 *  AFTER `writeStdout`. The pass, advisory, loop-guard, degraded and
 *  read-tracking paths record NOTHING — Observe is scoped to blocks. Canonical
 *  statement of the contract, the cwd rule, and the never-throw guarantee lives
 *  in the recorder: `lib/runtime/human-asked-record.js`.
 *
 * ── PASS IS PASSTHROUGH, NOT APPROVAL (CA-04, security) ─────────────────────
 *  This hook only ever writes a BLOCK. Every other path (new file, already read,
 *  exempt, external project, advisory, degraded, loop guard, Read tracking) writes
 *  zero bytes and exits 0, so the host's own permission flow decides. It used to
 *  print `{decision:'approve'}` on all of them, and the host reads that as `allow`
 *  and skips the permission prompt (measured on host 2.1.284, in default,
 *  acceptEdits and dontAsk mode). The contract and its ratchet live in
 *  `tests/hooks/pretooluse-passthrough.test.js`.
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { getRepoRoot } from '../../lib/git/repo-root-cache.js';

/** Files that are always allowed without a prior Read. */
const WHITELIST_BASENAMES = new Set(['CLAUDE.md', 'CLAUDE.local.md']);

// ---------------------------------------------------------------------------
// In-memory tracking cache (v4.7.3 perf — perf-auditor A1.1)
// ---------------------------------------------------------------------------
// Previously every Read fired existsSync + readFileSync + atomicWriteSync.
// For >200-Read sessions this dominated PostToolUse latency. We now hold a
// per-session Set in-process and debounce-flush dirty sessions to disk.

/** @type {Map<string, Set<string>>} */
const sessionReadCache = new Map();
/** @type {Set<string>} sessions with pending writes. */
const dirtySessions = new Set();
/** @type {Map<string, string>} sessionId -> tracking file path. */
const sessionPaths = new Map();
/** @type {NodeJS.Timeout|null} */
let debounceTimer = null;
const FLUSH_DEBOUNCE_MS = 200;
let exitHookInstalled = false;

// ---------------------------------------------------------------------------
// Write-before-read EXEMPTIONS — an allowlist (CA-04 L4)
// ---------------------------------------------------------------------------
// `isWhitelisted` answers one question: may this write skip the prior-Read
// check? It is NOT an approval. Nothing here gets a write past any other gate
// (until CA-04 the exempt path printed a legacy approve, which the host reads as
// allow and which did skip the host's permission prompt; it now prints nothing),
// and it decides nothing for files this hook never looks at (`shouldEnforceGuard`
// stands aside outside the Artibot repo, and for paths outside cwd, the plugin
// root and any `plugins/artibot/` tree, so `~/.claude/settings.json` from a
// project cwd never reaches it).
//
// It used to say yes to any path CONTAINING `.claude/`. That put settings*.json,
// hooks.json, dispatch-table.json and artibot.config.json on a "needs no Read"
// list and matched `not.claude/` besides. Now only four families are exempt;
// anything else is checked like any other file:
//
//   1. CLAUDE.md / CLAUDE.local.md in any directory (unchanged).
//   2. The interior of a split worktree, `.claude/worktrees/<name>/...`. /split
//      relies on this, so it is kept exactly: a limb window edits its own files
//      there with no Read check on each. Only a `.claude` area INSIDE the
//      worktree is judged again, by 3-4: a worktree's own settings are settings.
//   3. Auto-memory notes, `.claude/projects/<slug>/memory/<note>.md`.
//   4. Prose directories, `.claude/{rules,agents,commands,skills}/**`, except
//      that a protected config basename is never exempt there.
//
// The protected basenames mirror `PROTECTED_CONFIG_BASENAMES` in
// lib/security/human-gate-enforce.js so the gate core and this exemption agree on
// what a config file is, plus `.mcp.json` (MCP servers are code that runs; the gate
// core does not list it). tests/hooks/pre-write-guard.test.js pins the safe
// direction: nothing the gate protects is ever exempt here. It walks the gate's
// own list, so a name added there is covered without touching the test. (A name
// listed only here is merely stricter.) They are repeated rather than imported
// because this hook runs on every Write/Edit and Read and stays free of the gate
// core's module graph.
//
// FAIL CLOSED means one thing here: when in doubt there is NO exemption, and the
// file gets the ordinary check (which a Read satisfies and one retry lifts).
//   - Only an ABSOLUTE path can be exempt. The host's Write/Edit take an absolute
//     file_path (all 47 Write/Edit block records in this repo's central ledger,
//     2026-09-10..29, are absolute drive paths). A relative or drive-relative
//     (`C:foo`) path would have to be resolved against a working directory this
//     function cannot vouch for, so it gets none, in any spelling; nor does a
//     Windows spelling on a POSIX host, where it is a relative filename.
//   - Grants match EXACT lower-case names. Denial matches liberally: `.CLAUDE`,
//     `.claude.` and `.claude ` count as `.claude` (NTFS is case-insensitive and
//     Windows drops trailing dots and spaces), so a spelling variant can only
//     lose an exemption, never gain one.
//   - `..` is resolved BEFORE anything is granted. A path that climbs above its
//     own start, holds a control character, a `:` in a name (alternate data
//     stream), a `\\?\` / `\\.\` / UNC prefix, or is longer than any filesystem
//     accepts is not exempt. A cap can only remove an exemption, never add one.
//   - A lexical grant is re-checked against where the write would really land
//     (see `landsInDeniedArea`): junctions, symlinks, 8.3 short names and the
//     on-disk case are resolved by the filesystem itself. A landing in a `.claude`
//     area off the allowlist, or on a protected name outside every worktree (a
//     junction to the project root puts the real .mcp.json, artibot.config.json or
//     hooks.json under a worktree-looking path), revokes the grant.
//
// What this does NOT see: a hard link; a bind or network mount; a target swapped
// between this check and the write; the host's own path normalisation if it
// differs from Node's; a Windows path with a root but no drive (`\x`, `/x`),
// which Node calls absolute and which is resolved against the hook's current
// drive (the host sends drive-qualified paths, 47 of 47 in that ledger; requiring
// a drive would be one line here but flips every POSIX-spelled fixture on
// Windows); `CLAUDE_PLUGIN_ROOT` as a protected location (the gate
// core also protects config basenames under it, which matters for a
// `--plugin-dir` dev install running its hooks.json from a worktree; this
// function does not read the environment, so there that worktree's own
// hooks.json stays exempt HERE, and only here); and the gate itself: WBR is not a
// human gate (a Read satisfies it, one retry lifts it). Enforcement for
// HG-12/HG-13 is CA-04 L2.

/** `.claude` subdirectories holding prose the model edits routinely. */
const CLAUDE_PROSE_DIRS = new Set(['rules', 'agents', 'commands', 'skills']);

/**
 * Config basenames (lower case) that never ride in on a prose directory and that a
 * redirect may not land on (see `landsInDeniedArea`): the gate core's five, plus
 * `.mcp.json`, which defines MCP servers (code that runs) and is not in its list.
 */
const CLAUDE_CONFIG_BASENAMES = new Set([
  'settings.json', 'settings.local.json', 'hooks.json', 'dispatch-table.json', 'artibot.config.json',
  '.mcp.json',
]);

/** Longest path considered (Linux PATH_MAX). Longer is simply not exempt. */
const MAX_EXEMPT_PATH_CHARS = 4096;

/** Most missing trailing components searched past when resolving a not-yet-created path. */
const MAX_MISSING_COMPONENTS = 64;

const EXEMPT = 'exempt';
const DENIED = 'denied';
const PLAIN = 'plain';

/** Windows drops trailing dots and spaces from a name (`.claude.` names `.claude`). */
function trimDotsAndSpaces(name) {
  let end = name.length;
  while (end > 0 && (name[end - 1] === '.' || name[end - 1] === ' ')) end -= 1;
  return name.slice(0, end);
}

/** A name for comparison only: as Windows and a case-insensitive disk would read it. */
function comparable(name) {
  return trimDotsAndSpaces(name).toLowerCase();
}

/** True for `.claude` in any spelling the filesystem could read as `.claude`. */
function looksLikeClaudeDir(name) {
  return comparable(name) === '.claude';
}

/**
 * Split a path into name segments with `.` and `..` resolved, or `null` when no
 * exemption can be derived from it (see the header: control characters, `:` in a
 * name, device / extended / UNC prefixes, a climb above the start, over-long).
 * A leading drive designator (`C:`) is dropped; only the names matter here.
 *
 * @param {string} filePath
 * @returns {string[]|null}
 */
function toSegments(filePath) {
  if (filePath.length > MAX_EXEMPT_PATH_CHARS) return null;
  for (let i = 0; i < filePath.length; i += 1) {
    const code = filePath.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return null;
  }
  const slashed = filePath.replace(/\\/g, '/');
  if (slashed.startsWith('//')) return null;
  const segments = [];
  for (const raw of slashed.replace(/^[A-Za-z]:/, '').split('/')) {
    if (raw === '' || raw === '.') continue;
    if (raw === '..') {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    // `:` names a stream or a drive-relative form; a name made only of dots and
    // spaces is `.`, `..` or nothing once Windows has trimmed it.
    if (raw.includes(':') || trimDotsAndSpaces(raw) === '') return null;
    segments.push(raw);
  }
  return segments;
}

/** @returns {number} index of the first segment at or after `from` that reads as `.claude`, or -1 */
function indexOfClaudeDir(segments, from) {
  for (let i = from; i < segments.length; i += 1) {
    if (looksLikeClaudeDir(segments[i])) return i;
  }
  return -1;
}

/**
 * Verdict for the segment that follows an exact `.claude` (`kindAt` indexes it).
 * @returns {'exempt'|'denied'}
 */
function claudeAreaVerdict(segments, kindAt) {
  const kind = segments[kindAt];
  const last = segments.length - 1;
  // A second .claude further down is not a shape any allowlist entry describes.
  if (indexOfClaudeDir(segments, kindAt + 1) !== -1) return DENIED;
  if (CLAUDE_PROSE_DIRS.has(kind)) {
    return last > kindAt && !CLAUDE_CONFIG_BASENAMES.has(comparable(segments[last])) ? EXEMPT : DENIED;
  }
  const isMemoryNote = kind === 'projects' && last === kindAt + 3
    && segments[kindAt + 2] === 'memory' && segments[last].endsWith('.md');
  return isMemoryNote ? EXEMPT : DENIED;
}

/**
 * Judge a path by its `.claude` structure alone. Stepping through a worktree
 * marker (`.claude/worktrees/<name>/` with something inside) makes the rest a
 * worktree interior: exempt unless a `.claude` area inside it says otherwise.
 * @returns {'exempt'|'denied'|'plain'} `plain`: no `.claude` anywhere, nothing to grant
 */
function claudeVerdict(segments) {
  let from = 0;
  let insideWorktree = false;
  for (;;) {
    const at = indexOfClaudeDir(segments, from);
    if (at === -1) return insideWorktree ? EXEMPT : PLAIN;
    // An aliased spelling (`.CLAUDE`, `.claude.`) never earns an exemption.
    if (segments[at] !== '.claude') return DENIED;
    const stepsIntoWorktree = segments[at + 1] === 'worktrees' && at + 3 < segments.length
      && !looksLikeClaudeDir(segments[at + 2]);
    if (!stepsIntoWorktree) return claudeAreaVerdict(segments, at + 1);
    insideWorktree = true;
    from = at + 3;
  }
}

/** Rule 1 (context file anywhere), else the `.claude` structure. */
function verdictFor(filePath, segments) {
  if (WHITELIST_BASENAMES.has(path.basename(filePath))) return EXEMPT;
  return claudeVerdict(segments);
}

/**
 * True when `name` exists as an entry that `realpath` could not follow (a link
 * whose target is gone) or cannot be told apart from one.
 */
function entryExistsOrUnknown(name) {
  try {
    lstatSync(name);
    return true;
  } catch (err) {
    return err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR';
  }
}

/**
 * Where a write to `filePath` would really land, as the filesystem resolves it:
 * junctions and symlinks followed, 8.3 short names expanded, on-disk case. A path
 * that does not exist yet is resolved through its nearest existing ancestor.
 * Only ever called with an absolute path: `isWhitelisted` refuses every other
 * spelling first, so nothing here is resolved against the hook's working directory.
 *
 * @param {string} filePath - absolute
 * @returns {string|null} the landing path; `null` when it cannot be established
 *   (unexpected error, dangling link, too many missing components)
 */
function resolveLandingPath(filePath) {
  const missing = [];
  let head = filePath;
  while (missing.length <= MAX_MISSING_COMPONENTS) {
    try {
      const real = realpathSync.native(head);
      return missing.length === 0 ? real : path.join(real, ...missing.reverse());
    } catch (err) {
      const notThere = err?.code === 'ENOENT' || err?.code === 'ENOTDIR';
      if (!notThere || entryExistsOrUnknown(head)) return null;
    }
    const parent = path.dirname(head);
    if (parent === head) return null;
    missing.push(path.basename(head));
    head = parent;
  }
  return null;
}

/**
 * True when the write would land somewhere the allowlist does not exempt, or
 * where it lands cannot be established. Two landings revoke a lexical grant:
 *   - inside a `.claude` area off the allowlist (DENIED); and
 *   - on a protected config name in a place that is neither a worktree nor an
 *     allowed area (PLAIN). A junction to the project root is how a path that
 *     looks like worktree source reaches the real .mcp.json, artibot.config.json
 *     or hooks.json. A worktree's OWN copy of those names lands inside the
 *     worktree (EXEMPT), is source, and keeps its exemption.
 * Any other landing keeps the grant: a junction that leaves the worktree without
 * entering `.claude` (worktree-setup.mjs links node_modules that way) is what the
 * old rule exempted too. (Consequence, fail-closed: a worktree directory whose
 * REAL location is outside `.claude/worktrees/` loses the exemption for the
 * protected names, and only those.)
 */
function landsInDeniedArea(filePath) {
  const landing = resolveLandingPath(filePath);
  if (landing === null) return true;
  const segments = toSegments(landing);
  if (segments === null || segments.length === 0) return true;
  const verdict = verdictFor(landing, segments);
  if (verdict === DENIED) return true;
  return verdict === PLAIN && CLAUDE_CONFIG_BASENAMES.has(comparable(segments[segments.length - 1]));
}

/**
 * May this write skip the write-before-read check? An allowlist, see the header.
 * Never throws: any surprise means "not exempt".
 *
 * @param {*} filePath
 * @returns {boolean}
 */
export function isWhitelisted(filePath) {
  try {
    if (typeof filePath !== 'string' || filePath === '') return false;
    // Only an absolute path can be exempt. A relative or drive-relative one (`C:foo`)
    // would be resolved against a working directory this function cannot vouch for.
    if (!path.isAbsolute(filePath)) return false;
    const segments = toSegments(filePath);
    if (segments === null || verdictFor(filePath, segments) !== EXEMPT) return false;
    return !landsInDeniedArea(filePath);
  } catch (err) {
    process.stderr.write(`[artibot:pre-write-guard] exemption check failed, treating as not exempt: ${err?.message}\n`);
    return false;
  }
}

/**
 * Determine if the write-before-read guard should be enforced.
 *
 * Tier 1 (Artibot-repo gate): the cwd's git repo-root — NOT the cwd itself —
 * must contain `plugins/artibot/CLAUDE.md` or `artibot.config.json`. The
 * earlier cwd-only check produced false positives in monorepo subdirectories
 * (a sibling `artibot.config.json` in a parent dir would match unrelated
 * subprojects); resolving via `getRepoRoot()` constrains detection to the
 * actual repo we're inside.
 *
 * Tier 2 (file-scope gate): the file being written must live inside the
 * plugin root OR inside the cwd (case-insensitive on Windows), to avoid
 * tracking writes that escape the project boundary.
 *
 * External projects without an Artibot marker always pass through silently.
 *
 * @param {string} filePath
 * @returns {boolean}
 */
function shouldEnforceGuard(filePath) {
  if (!filePath) return false;

  const cwd = process.cwd();

  // Tier 1: Artibot marker check anchored on the actual repo root, not cwd —
  // prevents false positives where a parent directory in a monorepo carries
  // an unrelated artibot.config.json. Falls back to cwd when not in a git
  // repo (preserves the legacy bare-directory checkout behaviour).
  const repoRoot = getRepoRoot(cwd) || cwd;
  const hasMarker = existsSync(path.join(repoRoot, 'plugins', 'artibot', 'CLAUDE.md'))
    || existsSync(path.join(repoRoot, 'artibot.config.json'));
  if (!hasMarker) {
    process.stderr.write(`[artibot:pre-write-guard] Skipped: not an Artibot repo (repoRoot=${repoRoot})
`);
    return false;
  }

  // Tier 2: File must be inside plugin root OR inside CWD (case-insensitive on Windows)
  const norm = filePath.replace(/\\/g, '/').toLowerCase();
  const pluginRoot = (process.env.CLAUDE_PLUGIN_ROOT || '').replace(/\\/g, '/').toLowerCase();
  const cwdNorm = cwd.replace(/\\/g, '/').toLowerCase();

  if (pluginRoot && norm.startsWith(pluginRoot)) return true;
  if (cwdNorm && norm.startsWith(cwdNorm)) return true;
  return norm.includes('plugins/artibot/');
}
import { atomicWriteSync, getPluginRoot, parseJSON, readStdin, resolveConfigPath, writeStdout } from '../utils/index.js';
import { createErrorHandler, extractFilePath, extractToolName, normalizePath } from '../../lib/core/hook-utils.js';
import { recordHumanAsked } from '../../lib/runtime/human-asked-record.js';
import { isMainEntry } from './_main-entry.js';

const BLOCK_FINGERPRINT_FILE = 'last-pre-write-block.txt';

/**
 * The fail-closed reason string, unchanged from before this file recorded
 * anything. Named so the tail and the recorder cannot drift apart; the VALUE is
 * frozen by the invariance gate.
 */
const HOOK_ERROR_REASON = 'Write-before-read guard failed. Blocking by default.';

/**
 * The parsed payload of the turn in flight, kept so the fail-closed tail can
 * describe what it blocked. `null` until stdin is read and parsed — which is
 * also the realistic shape of a hook error, since the failure this tail exists
 * for happens while reading stdin.
 * @type {object|null}
 */
let lastHookData = null;

/**
 * Resolve the write-before-read enforcement mode.
 *
 * Precedence: ARTIBOT_WRITE_GUARD_MODE env > config.devProtocol.writeGuardMode
 * > 'block' (default). Default is 'block' to preserve the prior DEV-protocol
 * enforcing behavior (regression-safe); set to 'advisory' for a non-blocking
 * warning — friendlier for non-developer/vibe-coding users at the cost of the
 * strict read-before-write guarantee.
 *
 * Best-effort: a missing/unreadable config never breaks the guard; we fall
 * back to env then the 'block' default.
 *
 * @returns {'block'|'advisory'}
 */
function resolveWriteGuardMode() {
  const envMode = (process.env.ARTIBOT_WRITE_GUARD_MODE || '').trim().toLowerCase();
  if (envMode === 'advisory' || envMode === 'block') return envMode;

  try {
    const configPath = resolveConfigPath('artibot.config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    const cfgMode = String(config?.devProtocol?.writeGuardMode || '').trim().toLowerCase();
    if (cfgMode === 'advisory' || cfgMode === 'block') return cfgMode;
  } catch {
    // No config / unreadable — fall through to default.
  }
  return 'block';
}

/**
 * Build a fingerprint that uniquely identifies a (sessionId, toolName,
 * filePath) attempt. Two consecutive attempts with the same fingerprint
 * indicate the model is retrying the same blocked operation — feed the
 * second attempt through as a pass to break the loop.
 *
 * Pattern mirrors dev-verify-gate.js:151-156 (sha1-truncated fingerprint
 * cached on disk between hook invocations).
 *
 * @param {string} sessionId
 * @param {string} toolName
 * @param {string} normalizedPath
 * @returns {string}
 */
function buildBlockFingerprint(sessionId, toolName, normalizedPath) {
  return createHash('sha1')
    .update(`${sessionId}|${toolName}|${normalizedPath}`)
    .digest('hex')
    .slice(0, 16);
}

/**
 * Read the last block fingerprint from disk. Returns empty string when the
 * fingerprint file does not exist or is unreadable.
 * @returns {string}
 */
function readLastBlockFingerprint() {
  try {
    const filePath = path.join(getPluginRoot(), 'runtime', BLOCK_FINGERPRINT_FILE);
    if (!existsSync(filePath)) return '';
    return readFileSync(filePath, 'utf-8').trim();
  } catch {
    return '';
  }
}

/**
 * Persist the latest block fingerprint to disk so the next attempt can
 * detect a duplicate and bypass the block.
 * @param {string} fingerprint
 */
function saveBlockFingerprint(fingerprint) {
  try {
    const dir = path.join(getPluginRoot(), 'runtime');
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    atomicWriteSync(path.join(dir, BLOCK_FINGERPRINT_FILE), fingerprint + '\n');
  } catch {
    // best-effort — fingerprint persistence is a UX nicety, not load-bearing
  }
}

/**
 * Build the tracking file path for a given session.
 * @param {string} sessionId
 * @returns {string}
 */
function getTrackingPath(sessionId) {
  return path.join(os.tmpdir(), `artibot-read-tracking-${sessionId}.json`);
}

/**
 * Lazily seed the in-memory cache for a session from disk.
 * @param {string} sessionId
 * @param {string} trackingPath
 * @returns {Set<string>}
 */
function getOrLoadSessionSet(sessionId, trackingPath) {
  let set = sessionReadCache.get(sessionId);
  if (set) return set;
  set = new Set();
  try {
    if (existsSync(trackingPath)) {
      const data = JSON.parse(readFileSync(trackingPath, 'utf-8'));
      if (Array.isArray(data)) {
        for (const p of data) set.add(p);
      }
    }
  } catch {
    // corrupt or unreadable — treat as empty
  }
  sessionReadCache.set(sessionId, set);
  sessionPaths.set(sessionId, trackingPath);
  return set;
}

/**
 * Synchronously flush every dirty session to disk.
 * Called from the debounce timer and from process-exit.
 */
function flushDirtySessions() {
  for (const sessionId of dirtySessions) {
    const set = sessionReadCache.get(sessionId);
    const trackingPath = sessionPaths.get(sessionId);
    if (!set || !trackingPath) continue;
    try {
      atomicWriteSync(trackingPath, JSON.stringify([...set], null, 2));
    } catch (err) {
      process.stderr.write(`[artibot:pre-write-guard] flush failed: ${err.message}\n`);
    }
  }
  dirtySessions.clear();
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
}

function ensureExitFlush() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on('exit', flushDirtySessions);
}

/**
 * Add a file path to the in-memory cache + schedule a debounced flush.
 * @param {string} sessionId
 * @param {string} trackingPath
 * @param {string} filePath
 * @returns {boolean} true if newly recorded, false if duplicate
 */
function recordReadPath(sessionId, trackingPath, filePath) {
  const set = getOrLoadSessionSet(sessionId, trackingPath);
  const normalized = normalizePath(filePath);
  if (set.has(normalized)) return false;
  set.add(normalized);
  dirtySessions.add(sessionId);
  ensureExitFlush();
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(flushDirtySessions, FLUSH_DEBOUNCE_MS);
  return true;
}

// Test-only — reset all memoize state between vitest cases.
export function __resetForTest() {
  sessionReadCache.clear();
  dirtySessions.clear();
  sessionPaths.clear();
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
}

/**
 * Handle PostToolUse for Read: record the file path.
 * @param {object} hookData
 */
function handleReadTracking(hookData) {
  const sessionId = hookData?.session_id || 'default';
  const filePath = extractFilePath(hookData);
  if (!filePath) {
    return;
  }

  try {
    const trackingPath = getTrackingPath(sessionId);
    recordReadPath(sessionId, trackingPath, filePath);
    process.stderr.write(`[artibot:pre-write-guard] Tracked read: ${filePath}\n`);
  } catch (err) {
    process.stderr.write(`[artibot:pre-write-guard] Track failed: ${err.message}\n`);
  }
  // Read operations are never decided here (tracking is best-effort): PASSTHROUGH.
}

/**
 * Handle PreToolUse for Write/Edit: check if the file was read first.
 *
 * `async` only so the single block point can await the ledger append after its
 * decision is already on stdout. Every pass path still returns without ever
 * suspending, so the decision itself is produced on the same synchronous path
 * as before.
 *
 * @param {object} hookData
 * @returns {Promise<void>}
 */
async function handleWriteGuard(hookData) {
  const toolName = extractToolName(hookData);
  const filePath = extractFilePath(hookData);

  if (!filePath) {
    return;
  }

  const normalized = normalizePath(filePath);

  // Allow whitelisted files (Claude config) without Read requirement
  if (isWhitelisted(filePath)) {
    return;
  }

  // Skip guard for external projects (no artibot.config.json in CWD)
  if (!shouldEnforceGuard(filePath)) {
    return;
  }

  // Allow new file creation (file does not exist yet)
  if (!existsSync(filePath)) {
    return;
  }

  // Check if file was read in this session
  const sessionId = hookData?.session_id || 'default';
  const trackingPath = getTrackingPath(sessionId);
  const readSet = getOrLoadSessionSet(sessionId, trackingPath);

  if (readSet.has(normalized)) {
    return;
  }

  // Degraded mode: if tracking file is missing AND cache is empty,
  // we have no signal at all — pass through with a warning. (When cache has
  // entries but disk is gone, we trust the in-memory state.)
  if (readSet.size === 0 && !existsSync(trackingPath)) {
    process.stderr.write(`[artibot:pre-write-guard] Warning: tracking file missing, approving ${toolName} for "${filePath}" in degraded mode\n`);
    return;
  }

  // Loop guard: when the model retries the same blocked Write/Edit (same
  // sessionId + toolName + filePath), downgrade the second block to a pass.
  // This breaks the user-reported "block → retry → block → ... must end
  // session" loop. Fingerprint persists across hook invocations on disk so
  // separate Node child-processes can share the bypass signal. Pattern
  // mirrors dev-verify-gate.js's fingerprint cache (l.151-186).
  const fingerprint = buildBlockFingerprint(sessionId, toolName, normalized);
  if (readLastBlockFingerprint() === fingerprint) {
    process.stderr.write(
      `[pre-write-guard] duplicate block bypassed (loop guard) — file: ${filePath}\n`,
    );
    return;
  }

  // Advisory mode (config devProtocol.writeGuardMode='advisory' or env
  // ARTIBOT_WRITE_GUARD_MODE='advisory'): warn but pass through. Friendlier for
  // non-developer/vibe-coding users — surfaces the read-before-write reminder
  // without blocking the edit. Default 'block' preserves strict DEV protocol.
  const mode = resolveWriteGuardMode();
  if (mode === 'advisory') {
    const warning = `[WRITE-BEFORE-READ] ${toolName} for "${filePath}": `
      + 'file exists but was not Read in this session. '
      + 'Reading first is recommended to avoid blind modifications.';
    process.stderr.write(`[artibot:pre-write-guard] (advisory) ${warning}\n`);
    return;
  }

  // Block: existing file not read before write/edit.
  //
  // This string is the only corrective channel available for this failure. A
  // PreToolUse block means the tool never executed, so Claude Code emits no
  // PostToolUse or PostToolUseFailure event and no advisor hook can append the
  // missing step (measured 2026-08-10: deliberate Grep/Edit tool_use_error
  // failures produced zero events on either). Stating the retry here is what
  // turns "you did it wrong" into a recoverable instruction.
  const reason = `[WRITE-BEFORE-READ] ${toolName} blocked for "${filePath}". `
    + 'File exists but was not Read in this session. '
    + `Read the file first to understand its contents before modifying, then retry the same ${toolName}.`;
  process.stderr.write(`[artibot:pre-write-guard] ${reason}\n`);
  saveBlockFingerprint(fingerprint);
  writeStdout({ decision: 'block', reason });
  await recordHumanAsked({ hookData, tool: toolName, reason });
}

export async function main() {
  const raw = await readStdin();
  const hookData = parseJSON(raw);
  lastHookData = hookData;
  if (!hookData) return;

  const toolName = extractToolName(hookData);

  // PostToolUse Read tracking mode
  if (toolName === 'Read') {
    handleReadTracking(hookData);
    return;
  }

  // PreToolUse Write/Edit guard mode
  if (toolName === 'Write' || toolName === 'Edit') {
    await handleWriteGuard(hookData);
    return;
  }

  // Fallback: an unknown combination passes through (no decision).
}

/**
 * The fail-closed tail: block on any error the hook could not handle, then
 * record that block like any other. Exported so a test can enter the real
 * production path instead of a copy of it.
 *
 * The tool name is recovered from the payload rather than assumed, but is
 * clamped to the recorder's contract (`'Write' | 'Edit'` here). This hook also
 * serves Read for PostToolUse tracking, and a parse failure leaves no payload
 * at all — neither may reach the recorder as an out-of-contract `tool`. When
 * nothing is recoverable the recorder skips the append anyway (no `cwd`), so
 * `'Write'` is a shape default, not a claim about what was blocked.
 *
 * @param {Error} err
 * @returns {Promise<void>}
 */
export async function handleHookError(err) {
  createErrorHandler('pre-write-guard', {
    writeStdout,
    blockReason: HOOK_ERROR_REASON,
  })(err);
  const errored = extractToolName(lastHookData);
  await recordHumanAsked({
    hookData: lastHookData,
    tool: errored === 'Edit' ? 'Edit' : 'Write',
    reason: HOOK_ERROR_REASON,
  });
}

// Direct-run guard: importing this module (tests) must not execute the hook.
// main() blocks on stdin, so an import both hangs the importer and fires the
// hook's side effects. Production is unaffected — the dispatcher (or Claude
// Code) spawns this file as argv[1], so the guard passes there.
if (isMainEntry(import.meta.url)) {
  main().catch(handleHookError);
}
