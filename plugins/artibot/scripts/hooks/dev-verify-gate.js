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
import { existsSync, readFileSync } from 'node:fs';
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
 * @param {string} sha
 * @param {string[]} files
 * @returns {string}
 */
function buildFingerprint(sha, files) {
  return `${sha}|${files.slice().sort().join(',')}`;
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

async function main() {
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

  const headSha = getHeadSha(repoRoot) || 'unknown';
  const pluginRoot = getPluginRoot();
  const fingerprint = buildFingerprint(headSha, changedFiles);
  if (readLastFingerprint(pluginRoot) === fingerprint) return; // already verified

  saveFingerprint(pluginRoot, fingerprint);
  writeStdout({ decision: 'block', reason: DEV_VERIFY_REASON });
}

main().catch(createErrorHandler(HOOK_NAME, { exit: false }));
