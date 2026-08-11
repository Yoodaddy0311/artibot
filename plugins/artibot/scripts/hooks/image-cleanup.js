#!/usr/bin/env node
/**
 * Image Cleanup Hook (v2.8.0+).
 *
 * Context: Claude Code CLI, when the user pastes an image into the chat
 * (Ctrl+V or drag-drop), auto-saves the file to the current working directory
 * as `image.png`, `image copy.png`, `image copy 2.png`, etc. and auto-prepends
 * `& 'C:\path\to\image.png'` to the user's next message. There is no native
 * Claude Code setting to disable this behavior yet (upstream issue #26679).
 *
 * This hook fires on SessionStart and silently sweeps any recent, small,
 * git-untracked files matching the exact Claude Code auto-save pattern from
 * the current working directory. It does NOT recurse and it does NOT touch
 * files the user has deliberately committed, renamed, or left for a long time.
 *
 * Safety rails (ALL must hold before a file is deleted):
 *   1. Filename exactly matches `^image(?: copy(?: \d+)?)?\.png$` (non-recursive, cwd only)
 *   2. File size < 10 MB (legitimate design assets are often larger)
 *   3. File mtime within the last 48 hours (old files might be intentional)
 *   4. File is NOT tracked by git (committed files are user-owned)
 *
 * To opt out globally, set env var `ARTIBOT_IMAGE_CLEANUP=off` or add
 * `{"imageCleanup": false}` to `~/.claude/artibot/config.json`.
 *
 * @module scripts/hooks/image-cleanup
 */

import { existsSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { logHookError } from '../../lib/core/hook-utils.js';
import { isMainEntry } from './_main-entry.js';

// -------------------------------------------------------------------------
// Constants
// -------------------------------------------------------------------------

/** Pattern matching Claude Code auto-saved pasted images. */
const CLAUDE_PASTE_PATTERN = /^image(?: copy(?: \d+)?)?\.png$/;

/** Maximum file size in bytes to consider auto-deletable. */
const MAX_AUTO_DELETE_BYTES = 10 * 1024 * 1024;

/** Maximum age in ms — files older than this are left alone. */
const MAX_AGE_MS = 48 * 60 * 60 * 1000;

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

/**
 * Check opt-out signals (env var or user config file).
 * @returns {boolean} true if the hook should skip all work.
 */
function isDisabled() {
  if ((process.env.ARTIBOT_IMAGE_CLEANUP || '').toLowerCase() === 'off') return true;
  const configPath = path.join(os.homedir(), '.claude', 'artibot', 'config.json');
  try {
    if (existsSync(configPath)) {
      const parsed = JSON.parse(readFileSync(configPath, 'utf-8'));
      if (parsed?.imageCleanup === false) return true;
    }
  } catch {
    // Fail-closed on malformed config: if a user wrote a config file at all,
    // they intended to control behavior. Defaulting to enabled silently
    // overrides their intent — the safer side is to disable until config is
    // valid. This hook deletes files, so the bias must lean toward "off".
    process.stderr.write(
      `[artibot:image-cleanup] WARN: malformed config at ${configPath}, disabling hook\n`,
    );
    return true;
  }
  return false;
}

/**
 * Return the set of files tracked by git in cwd (non-recursive, cwd root only).
 * Falls back to an empty set if we're not inside a git repo or git fails.
 * @param {string} cwd
 * @returns {Set<string>}
 */
function trackedFilesAtRoot(cwd) {
  try {
    const out = execSync('git ls-tree HEAD --name-only', {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    const tracked = new Set();
    for (const line of out.split('\n')) {
      const name = line.trim();
      if (name && !name.includes('/')) tracked.add(name);
    }
    return tracked;
  } catch {
    return new Set();
  }
}

/**
 * Decide whether a single candidate file is safe to delete.
 * @param {string} filePath - absolute path
 * @param {number} nowMs
 * @returns {'delete' | 'skip-size' | 'skip-age' | 'skip-missing'}
 */
export function classifyCandidate(filePath, nowMs) {
  let st;
  try {
    st = statSync(filePath);
  } catch {
    return 'skip-missing';
  }
  if (!st.isFile()) return 'skip-missing';
  if (st.size > MAX_AUTO_DELETE_BYTES) return 'skip-size';
  if (nowMs - st.mtimeMs > MAX_AGE_MS) return 'skip-age';
  return 'delete';
}

/**
 * Collect matching entries at the cwd root only (no recursion).
 * @param {string} cwd
 * @returns {string[]} file names (not full paths)
 */
export function listCandidates(cwd) {
  try {
    return readdirSync(cwd).filter((name) => CLAUDE_PASTE_PATTERN.test(name));
  } catch {
    return [];
  }
}

// -------------------------------------------------------------------------
// Main (exported for testability)
// -------------------------------------------------------------------------

/**
 * Sweep auto-saved pasted images from `cwd` (defaults to process.cwd()).
 * Returns a summary object for testing and telemetry.
 * @param {object} [opts]
 * @param {string} [opts.cwd]
 * @param {number} [opts.nowMs]
 * @returns {{ deleted: string[], skipped: Array<{name: string, reason: string}>, disabled: boolean }}
 */
export function main(opts = {}) {
  const summary = { deleted: [], skipped: [], disabled: false };

  if (isDisabled()) {
    summary.disabled = true;
    return summary;
  }

  const cwd = opts.cwd || process.cwd();
  const nowMs = opts.nowMs || Date.now();
  const tracked = trackedFilesAtRoot(cwd);
  const candidates = listCandidates(cwd);

  for (const name of candidates) {
    if (tracked.has(name)) {
      summary.skipped.push({ name, reason: 'tracked-by-git' });
      continue;
    }
    const filePath = path.join(cwd, name);
    const verdict = classifyCandidate(filePath, nowMs);
    if (verdict !== 'delete') {
      summary.skipped.push({ name, reason: verdict });
      continue;
    }
    try {
      unlinkSync(filePath);
      summary.deleted.push(name);
    } catch (err) {
      summary.skipped.push({ name, reason: `delete-failed:${err.code || 'unknown'}` });
    }
  }

  if (summary.deleted.length > 0) {
    process.stderr.write(
      `[artibot:image-cleanup] removed ${summary.deleted.length} pasted image(s): ${summary.deleted.join(', ')}\n`,
    );
  }

  return summary;
}

// -------------------------------------------------------------------------
// CLI entry
// -------------------------------------------------------------------------

// Direct-run guard: importing this module (tests) must not execute the hook —
// note this branch calls process.exit(0), so an unguarded import would kill the
// importing process outright. Production is unaffected: the dispatcher spawns
// this file as argv[1].
//
// Was `argv[1].endsWith('image-cleanup.js')`: a suffix test that any path ending
// in that name satisfied, comparing a possibly-relative argv[1] unresolved.
if (isMainEntry(import.meta.url)) {
  try {
    main();
    process.exit(0);
  } catch (err) {
    logHookError('image-cleanup', err.message || String(err));
    // Never fail the SessionStart chain because of cleanup.
    process.exit(0);
  }
}
