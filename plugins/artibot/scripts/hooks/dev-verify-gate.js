#!/usr/bin/env node
/**
 * Stop / SubagentStop hook — DEV Verify Gate.
 *
 * Conditionally surfaces the DEV verify checklist (DECOMPOSE → EXECUTE → VERIFY)
 * to the model AFTER turns that modified code. Read-only / diagnostic turns
 * skip this entirely — enforcing EXECUTE/VERIFY on a turn with no edits is
 * overkill and was the source of repeating "pending verification" loops.
 *
 * Replaces the previous `prompt`-type Stop hook entry which fired
 * unconditionally on every Stop.
 *
 * Schema (mode-dependent — see lib/core/dev-verify-output.js):
 *   - enforce (default): `decision: "block" + reason` → block stop, model gets
 *     reason as feedback. Always-supported shape (every Claude Code version).
 *   - advisory: `hookSpecificOutput.additionalContext` → non-blocking soft
 *     feedback (Claude Code ≥ 2.1.163; silently dropped on older versions).
 *   - no output → allow stop (read-only turn)
 *
 * Mode source: ARTIBOT_DEV_VERIFY_MODE env > config.devProtocol.verifyMode >
 * 'enforce'. Default preserves the prior enforcing behavior.
 *
 * Loop guards:
 *   - `stop_hook_active === true` → bail (Claude Code retry after block)
 *   - SHA + file fingerprint cache (`runtime/last-dev-verify-sha.txt`)
 *     prevents repeated verification asks for the same working-tree state.
 *
 * @module scripts/hooks/dev-verify-gate
 */

import path from 'node:path';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  atomicWriteSync,
  getPluginRoot,
  parseJSON,
  readStdin,
  resolveConfigPath,
  writeStdout,
} from '../utils/index.js';
import { createErrorHandler, isArtibotRepo, logHookError } from '../../lib/core/hook-utils.js';
import {
  getHeadSha as getCachedHeadSha,
  getRepoRoot as getCachedRepoRoot,
} from '../../lib/git/repo-root-cache.js';
import { buildDevVerifyOutput, resolveDevVerifyMode } from '../../lib/core/dev-verify-output.js';

const HOOK_NAME = 'dev-verify-gate';
const STATE_FILE = 'last-dev-verify-sha.txt';
const MARKER_FILE = 'last-main-agent-edit.timestamp';

// Single line on purpose: Claude Code ≥ 2.1.172 renders Stop-hook
// additionalContext verbatim in the terminal ("Stop hook feedback:") and
// suppressOutput cannot hide it (upstream anthropics/claude-code#67193).
// The full DECOMPOSE/EXECUTE/VERIFY checklist lives in plugins/artibot/
// CLAUDE.md (DEV Protocol), which the model already has in context.
const DEV_VERIFY_REASON =
  'DEV verify (CLAUDE.md DEV Protocol): report per-item evidence (file:line); ' +
  "flag anything unproven as 'Pending verification'.";

/**
 * Run a git command in the given cwd, returning trimmed stdout.
 * Returns null on failure (silent — git unavailable / not a repo).
 *
 * @param {string} cmd
 * @param {string} [cwd]
 * @returns {string|null}
 */
function git(cmd, cwd) {
  try {
    return execSync(cmd, {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5000,
      windowsHide: true,
    }).trim();
  } catch (err) {
    logHookError(HOOK_NAME, `git failed: ${cmd}`, err);
    return null;
  }
}

/** @returns {string|null} */
function getRepoRoot() {
  return getCachedRepoRoot();
}

/** @returns {string|null} */
function getHeadSha(repoRoot) {
  return getCachedHeadSha(repoRoot);
}

/**
 * Files written by other Stop hooks that race with this gate. Excluded so
 * the gate doesn't spuriously fire on its own dispatcher's side-effects.
 *
 * Background: session-notes.js appends to .artibot/SESSION-NOTES.md during
 * Stop. Because Stop hooks run in parallel (Promise.allSettled in
 * _stop-dispatcher.js), dev-verify-gate often observes the dirty file
 * before git-autopilot-close.js commits it, producing a false-positive
 * DECOMPOSE/EXECUTE/VERIFY ask on read-only turns.
 *
 * @type {Set<string>}
 */
const EXCLUDED_FILES = new Set([
  '.artibot/SESSION-NOTES.md',
]);

/**
 * Collect changed files vs HEAD: working tree + staged.
 * Last-commit (HEAD~1..HEAD) is intentionally excluded — already-committed
 * changes from a prior turn shouldn't re-trigger DEV verify.
 *
 * @param {string} repoRoot
 * @returns {string[]}
 */
function getChangedFiles(repoRoot) {
  const merged = new Set();
  for (const cmd of [
    'git diff --name-only HEAD',
    'git diff --name-only --cached',
  ]) {
    const out = git(cmd, repoRoot);
    if (!out) continue;
    for (const line of out.split('\n')) {
      const trimmed = line.trim();
      if (trimmed && !EXCLUDED_FILES.has(trimmed)) merged.add(trimmed);
    }
  }
  return [...merged];
}

/**
 * Build the cache fingerprint for loop-guard.
 *
 * Includes a short hash of `repoRoot` so different worktrees / repos sharing
 * one plugin install don't collide on the same fingerprint file (worktree A's
 * Stop would otherwise suppress worktree B's DEV verify reminder).
 *
 * @param {string} repoRoot
 * @param {string} sha
 * @param {string[]} files
 * @returns {string}
 */
function buildFingerprint(repoRoot, sha, files) {
  // 32-bit SHA1 truncation: collision impact = one suppressed DEV verify
  // reminder. Not a security boundary — purely a deduplication key.
  const repoHash = createHash('sha1').update(repoRoot).digest('hex').slice(0, 8);
  return `${repoHash}|${sha}|${files.slice().sort().join(',')}`;
}

/**
 * @param {string} pluginRoot
 * @returns {string}
 */
function readLastFingerprint(pluginRoot) {
  try {
    const filePath = path.join(pluginRoot, 'runtime', STATE_FILE);
    if (!existsSync(filePath)) return '';
    return readFileSync(filePath, 'utf-8').trim();
  } catch {
    return '';
  }
}

/**
 * @param {string} pluginRoot
 * @param {string} fingerprint
 */
function saveFingerprint(pluginRoot, fingerprint) {
  try {
    const filePath = path.join(pluginRoot, 'runtime', STATE_FILE);
    atomicWriteSync(filePath, fingerprint + '\n');
  } catch (err) {
    logHookError(HOOK_NAME, 'failed to persist fingerprint', err);
  }
}

/**
 * Has the main orchestrator agent made an edit since the last gate fire?
 *
 * Compares `runtime/last-main-agent-edit.timestamp` (written by the
 * mark-main-agent-edit PostToolUse hook on Edit/Write/MultiEdit, only when
 * NOT inside a subagent context) against `runtime/last-dev-verify-sha.txt`
 * (written by this gate after a successful fire).
 *
 * Decision matrix:
 *   - marker missing       → no main-agent edits have ever fired   → bail (false)
 *   - cache missing        → first run, no baseline                → fire (true)
 *   - marker mtime > cache → new main-agent edits since last fire → fire (true)
 *   - marker mtime ≤ cache → no NEW edits (or only teammate edits) → bail (false)
 *
 * The "marker missing → bail" branch is critical: a fresh checkout with
 * dirty working-tree (e.g. an in-progress branch resumed from another
 * machine) must NOT spuriously fire the verify ask, because the orchestrator
 * has not actually edited anything in this session yet.
 *
 * @param {string} pluginRoot
 * @returns {boolean} true → fire gate, false → bail
 */
function hasNewerMainAgentEdit(pluginRoot) {
  const markerPath = path.join(pluginRoot, 'runtime', MARKER_FILE);
  const cachePath = path.join(pluginRoot, 'runtime', STATE_FILE);

  if (!existsSync(markerPath)) return false;
  if (!existsSync(cachePath)) return true;

  try {
    const markerMtime = statSync(markerPath).mtimeMs;
    const cacheMtime = statSync(cachePath).mtimeMs;
    return markerMtime > cacheMtime;
  } catch {
    return true; // stat failure — be safe, fire
  }
}

/**
 * Resolve the DEV-verify enforcement mode from config + env. Best-effort: a
 * missing/unreadable config falls back to the env override or the 'enforce'
 * default — config IO must never break the Stop slot.
 *
 * @returns {'enforce'|'advisory'}
 */
function loadVerifyMode() {
  let config = {};
  try {
    const configPath = resolveConfigPath('artibot.config.json');
    config = JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch {
    // No config / unreadable — resolveDevVerifyMode applies env + default.
  }
  return resolveDevVerifyMode(config);
}

/**
 * Pick the hookSpecificOutput event name from the inbound payload. Stop and
 * SubagentStop share this gate; advisory output must echo the right event.
 *
 * @param {object} hookData
 * @returns {'Stop'|'SubagentStop'}
 */
function resolveHookEventName(hookData) {
  return hookData?.hook_event_name === 'SubagentStop' ? 'SubagentStop' : 'Stop';
}

async function main() {
  // v4.5.8: emergency disable removed. The marker-file pattern below now
  // distinguishes main-agent edits (gate fires) from teammate edits and
  // working-tree drift (gate bails). See `mark-main-agent-edit.js` for the
  // PostToolUse hook that writes the marker.

  const raw = await readStdin();
  const hookData = parseJSON(raw) ?? {};

  // Loop guard: Claude Code sets stop_hook_active=true when re-running Stop
  // hooks after a previous block. Bail to prevent infinite block→retry loops.
  if (hookData.stop_hook_active === true) return;

  const repoRoot = getRepoRoot();
  if (!repoRoot) return;

  // Scope guard: DEV verify is an Artibot-internal policy. Bail silently in
  // any other project the user happens to be working in (the plugin installs
  // globally, so the Stop hook would otherwise fire everywhere).
  if (!isArtibotRepo(repoRoot)) return;

  const changedFiles = getChangedFiles(repoRoot);
  // Read-only / diagnostic turn — no DEV verify needed.
  if (changedFiles.length === 0) return;

  const pluginRoot = getPluginRoot();

  // Marker check: did the main orchestrator agent edit anything since the
  // last verify fire? If not (only teammates edited, or only working-tree
  // drift like autopilot WIP commits), bail. This is the v4.5.8 fix for
  // the v4.5.6 paralysis bug where every orchestrator Stop while teammates
  // were mid-edit got blocked with a spurious "Pending verification" ask.
  if (!hasNewerMainAgentEdit(pluginRoot)) return;

  const headSha = getHeadSha(repoRoot) || 'unknown';
  const fingerprint = buildFingerprint(repoRoot, headSha, changedFiles);
  if (readLastFingerprint(pluginRoot) === fingerprint) return; // already verified

  saveFingerprint(pluginRoot, fingerprint);

  // Mode-aware output: 'enforce' (default) blocks the stop; 'advisory' surfaces
  // the same checklist as non-blocking 2.1.163 additionalContext feedback.
  const mode = loadVerifyMode();
  const hookEventName = resolveHookEventName(hookData);
  writeStdout(buildDevVerifyOutput(DEV_VERIFY_REASON, { mode, hookEventName }));
}

main().catch(createErrorHandler(HOOK_NAME, { exit: false }));
