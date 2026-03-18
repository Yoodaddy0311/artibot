#!/usr/bin/env node
/**
 * Git Autopilot — PreToolUse hook.
 * Warns (or blocks) when Claude is about to write a file that has
 * uncommitted remote changes, preventing silent overwrites.
 * Decision: warn (block=false) by default; block on explicitly tracked
 * protected paths if config.guardBlocking === true.
 * @module scripts/hooks/git-autopilot-guard
 */

import { existsSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { readStdin, parseJSON, writeStdout } from '../utils/index.js';
import { createErrorHandler, extractToolName, extractFilePath } from '../../lib/core/hook-utils.js';

// -------------------------------------------------------------------------
// Constants
// -------------------------------------------------------------------------

/** Tool names that write files and should be guarded. */
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

/**
 * Get the repo root via git rev-parse.
 * @returns {string|null}
 */
function getRepoRoot() {
  try {
    return execSync('git rev-parse --show-toplevel', {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Load .git/autopilot.json. Returns null if disabled or missing.
 * @param {string} repoRoot
 * @returns {object|null}
 */
function loadConfig(repoRoot) {
  const configPath = path.join(repoRoot, '.git', 'autopilot.json');
  if (!existsSync(configPath)) return null;
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    return config.enabled === false || config.guardEnabled === false ? null : config;
  } catch {
    return null;
  }
}

/**
 * Check whether a file has unmerged remote changes (i.e., differs from
 * the remote tracking branch HEAD).
 * @param {string} filePath - Repo-relative path
 * @param {string} cwd
 * @returns {boolean}
 */
function hasRemoteChanges(filePath, cwd) {
  try {
    // Get the remote tracking ref (e.g. origin/main)
    const trackingRef = execSync('git rev-parse --abbrev-ref --symbolic-full-name @{u}', {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();

    const diff = execSync(`git diff --name-only HEAD ${trackingRef} -- "${filePath}"`, {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return diff.trim().length > 0;
  } catch {
    return false; // No upstream or git error — allow
  }
}

/**
 * Convert an absolute path to a repo-relative path.
 * @param {string} absPath
 * @param {string} repoRoot
 * @returns {string}
 */
function toRelativePath(absPath, repoRoot) {
  if (!absPath || !repoRoot) return absPath ?? '';
  return path.relative(repoRoot, absPath).replace(/\\/g, '/');
}

// -------------------------------------------------------------------------
// Main
// -------------------------------------------------------------------------

async function main() {
  const raw = await readStdin();
  const hookData = parseJSON(raw) ?? {};

  const toolName = extractToolName(hookData);
  if (!WRITE_TOOLS.has(toolName)) return; // Only guard write tools

  const repoRoot = getRepoRoot();
  if (!repoRoot) return;

  const config = loadConfig(repoRoot);
  if (!config) return;

  const absFilePath = extractFilePath(hookData);
  if (!absFilePath) return;

  const relPath = toRelativePath(absFilePath, repoRoot);
  if (!hasRemoteChanges(relPath, repoRoot)) return; // File is in sync

  const blocking = config.guardBlocking === true;
  const message =
    `[artibot:git-autopilot-guard] "${relPath}" has unmerged remote changes. ` +
    (blocking
      ? 'Write blocked — run git pull first.'
      : 'Proceeding, but consider running git pull to avoid divergence.');

  if (blocking) {
    writeStdout({ decision: 'block', reason: message });
    return;
  }

  // Non-blocking: inject warning into the context via stdout message field
  writeStdout({ message });
}

main().catch(
  createErrorHandler('git-autopilot-guard', {
    exit: true,
    writeStdout,
    blockReason: '[artibot:git-autopilot-guard] Guard check failed — allowing as safe fallback',
  })
);
