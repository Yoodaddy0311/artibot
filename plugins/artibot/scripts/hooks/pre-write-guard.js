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
 *  AFTER `writeStdout`. The approve, advisory, loop-guard, degraded and
 *  read-tracking paths record NOTHING — Observe is scoped to blocks. Canonical
 *  statement of the contract, the cwd rule, and the never-throw guarantee lives
 *  in the recorder: `lib/runtime/human-asked-record.js`.
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
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

/**
 * Check if a file path matches the whitelist (Claude config files).
 * @param {string} filePath
 * @returns {boolean}
 */
function isWhitelisted(filePath) {
  if (!filePath) return false;
  if (WHITELIST_BASENAMES.has(path.basename(filePath))) return true;
  const normalized = filePath.replace(/\\/g, '/');
  return normalized.includes('.claude/');
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
 * External projects without an Artibot marker are always approved silently.
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
 * second attempt through as approve to break the loop.
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
    writeStdout({ decision: 'approve' });
    return;
  }

  try {
    const trackingPath = getTrackingPath(sessionId);
    recordReadPath(sessionId, trackingPath, filePath);
    process.stderr.write(`[artibot:pre-write-guard] Tracked read: ${filePath}\n`);
  } catch (err) {
    process.stderr.write(`[artibot:pre-write-guard] Track failed: ${err.message}\n`);
  }
  // Always approve Read operations (tracking is best-effort)
  writeStdout({ decision: 'approve' });
}

/**
 * Handle PreToolUse for Write/Edit: check if the file was read first.
 *
 * `async` only so the single block point can await the ledger append after its
 * decision is already on stdout. Every approve path still returns without ever
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
    writeStdout({ decision: 'approve' });
    return;
  }

  const normalized = normalizePath(filePath);

  // Allow whitelisted files (Claude config) without Read requirement
  if (isWhitelisted(filePath)) {
    writeStdout({ decision: 'approve' });
    return;
  }

  // Skip guard for external projects (no artibot.config.json in CWD)
  if (!shouldEnforceGuard(filePath)) {
    writeStdout({ decision: 'approve' });
    return;
  }

  // Allow new file creation (file does not exist yet)
  if (!existsSync(filePath)) {
    writeStdout({ decision: 'approve' });
    return;
  }

  // Check if file was read in this session
  const sessionId = hookData?.session_id || 'default';
  const trackingPath = getTrackingPath(sessionId);
  const readSet = getOrLoadSessionSet(sessionId, trackingPath);

  if (readSet.has(normalized)) {
    writeStdout({ decision: 'approve' });
    return;
  }

  // Degraded mode: if tracking file is missing AND cache is empty,
  // we have no signal at all — approve with warning. (When cache has
  // entries but disk is gone, we trust the in-memory state.)
  if (readSet.size === 0 && !existsSync(trackingPath)) {
    process.stderr.write(`[artibot:pre-write-guard] Warning: tracking file missing, approving ${toolName} for "${filePath}" in degraded mode\n`);
    writeStdout({ decision: 'approve' });
    return;
  }

  // Loop guard: when the model retries the same blocked Write/Edit (same
  // sessionId + toolName + filePath), downgrade the second block to approve.
  // This breaks the user-reported "block → retry → block → ... must end
  // session" loop. Fingerprint persists across hook invocations on disk so
  // separate Node child-processes can share the bypass signal. Pattern
  // mirrors dev-verify-gate.js's fingerprint cache (l.151-186).
  const fingerprint = buildBlockFingerprint(sessionId, toolName, normalized);
  if (readLastBlockFingerprint() === fingerprint) {
    process.stderr.write(
      `[pre-write-guard] duplicate block bypassed (loop guard) — file: ${filePath}\n`,
    );
    writeStdout({ decision: 'approve' });
    return;
  }

  // Advisory mode (config devProtocol.writeGuardMode='advisory' or env
  // ARTIBOT_WRITE_GUARD_MODE='advisory'): warn but approve. Friendlier for
  // non-developer/vibe-coding users — surfaces the read-before-write reminder
  // without blocking the edit. Default 'block' preserves strict DEV protocol.
  const mode = resolveWriteGuardMode();
  if (mode === 'advisory') {
    const warning = `[WRITE-BEFORE-READ] ${toolName} for "${filePath}": `
      + 'file exists but was not Read in this session. '
      + 'Reading first is recommended to avoid blind modifications.';
    process.stderr.write(`[artibot:pre-write-guard] (advisory) ${warning}\n`);
    writeStdout({ decision: 'approve' });
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

  // Fallback: approve unknown combinations
  writeStdout({ decision: 'approve' });
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
