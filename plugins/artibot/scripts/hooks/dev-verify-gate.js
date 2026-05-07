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
 * Check if any changed file has been modified since the cache file's mtime.
 * Returns true if at least one file is newer (i.e., real new edits happened
 * since last gate fire). Returns false if all files predate the cache (i.e.,
 * HEAD/working-tree drift but no actual edits — e.g., git autopilot WIP
 * commit shifted HEAD without user edits).
 *
 * @param {string} pluginRoot
 * @param {string} repoRoot
 * @param {string[]} changedFiles
 * @returns {boolean}
 */
function hasNewerEdits(pluginRoot, repoRoot, changedFiles) {
  const cachePath = path.join(pluginRoot, 'runtime', STATE_FILE);
  if (!existsSync(cachePath)) return true; // no prior state — fire on first run
  let cacheMtime;
  try {
    cacheMtime = statSync(cachePath).mtimeMs;
  } catch {
    return true; // unreadable cache — be safe, fire
  }
  for (const file of changedFiles) {
    const abs = path.join(repoRoot, file);
    if (!existsSync(abs)) continue;
    try {
      if (statSync(abs).mtimeMs > cacheMtime) return true;
    } catch {
      // skip unreadable
    }
  }
  return false;
}

async function main() {
  // ===========================================================================
  // EMERGENCY DISABLE (v4.5.6 in-flight): unconditional bail.
  //
  // Root cause: this gate fires whenever the working tree has uncommitted
  // changes, but in /team delegate workflows the changes come from teammates
  // (fix-applier, etc.) — NOT the orchestrator turn that the gate is gating.
  // Result: every orchestrator response while teammates are mid-edit gets
  // blocked with "EXECUTE pending" feedback, paralysing all delegate flows.
  //
  // hooks.json registration was already removed (source + install), but
  // Claude Code caches hooks.json at SessionStart so removal only takes
  // effect on next session. This in-script bail neutralises the gate
  // immediately for the current session as well.
  //
  // Proper fix tracked for v4.5.7: marker-file pattern (PostToolUse(Edit|
  // Write|MultiEdit) writes runtime/last-main-agent-edit.timestamp; gate
  // bails if marker mtime <= cache mtime). That distinguishes orchestrator
  // edits from teammate edits and from working-tree drift.
  // ===========================================================================
  return;

  // eslint-disable-next-line no-unreachable
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

  // Mtime guard: if no changed file is newer than the cache, this turn made
  // no real edits — the working-tree drift is from prior-turn residue or
  // autopilot HEAD movement. Skip to prevent the infinite "fingerprint
  // mismatched but nothing actually changed" block loop that was paralysing
  // user work prior to this fix.
  if (!hasNewerEdits(pluginRoot, repoRoot, changedFiles)) return;

  const headSha = getHeadSha(repoRoot) || 'unknown';
  const fingerprint = buildFingerprint(repoRoot, headSha, changedFiles);
  if (readLastFingerprint(pluginRoot) === fingerprint) return; // already verified

  saveFingerprint(pluginRoot, fingerprint);
  writeStdout({ decision: 'block', reason: DEV_VERIFY_REASON });
}

main().catch(createErrorHandler(HOOK_NAME, { exit: false }));
