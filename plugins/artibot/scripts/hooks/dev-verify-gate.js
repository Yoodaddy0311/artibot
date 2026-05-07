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
 * Schema:
 *   - `decision: "block" + reason`  → block stop, model gets reason as feedback
 *   - no output                     → allow stop (read-only turn)
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
  writeStdout,
} from '../utils/index.js';
import { createErrorHandler, logHookError } from '../../lib/core/hook-utils.js';

const HOOK_NAME = 'dev-verify-gate';
const STATE_FILE = 'last-dev-verify-sha.txt';
const MARKER_FILE = 'last-main-agent-edit.timestamp';

const DEV_VERIFY_REASON =
  'Run the DEV verify checklist before finalising. ' +
  '(1) DECOMPOSE: was every numbered item from the original request addressed? ' +
  'List any silently dropped items. ' +
  '(2) EXECUTE: was each modified file re-read after the change to confirm ' +
  'the edit landed at the intended line? ' +
  '(3) VERIFY: produce evidence per item (file:line + what changed). ' +
  "If any item lacks evidence, surface a 'Pending verification' note BEFORE " +
  'the user sees the response. ' +
  'Reference: plugins/artibot/CLAUDE.md (DEV Protocol section).';

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
  return git('git rev-parse --show-toplevel');
}

/** @returns {string|null} */
function getHeadSha(repoRoot) {
  return git('git rev-parse HEAD', repoRoot);
}

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
      if (trimmed) merged.add(trimmed);
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
  writeStdout({ decision: 'block', reason: DEV_VERIFY_REASON });
}

main().catch(createErrorHandler(HOOK_NAME, { exit: false }));
