#!/usr/bin/env node
/**
 * Write-Before-Read Guard Hook.
 *
 * PreToolUse hook for Write/Edit: blocks modification of existing files
 * that have not been Read in the current session.
 * PostToolUse hook for Read: records file paths to the session tracking file.
 *
 * Tracking file: /tmp/artibot-read-tracking-{sessionId}.json
 */

import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Files that are always allowed without a prior Read. */
const WHITELIST_BASENAMES = new Set(['CLAUDE.md', 'CLAUDE.local.md']);

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
 * Uses a two-tier check:
 *   1. Project marker: CWD must contain artibot.config.json (opt-in)
 *   2. File scope: file must be inside the plugin root or CWD
 * External projects without the marker file are always approved.
 * @param {string} filePath
 * @returns {boolean}
 */
function shouldEnforceGuard(filePath) {
  if (!filePath) return false;

  // Tier 1: Project marker check — only enforce in artibot projects
  const cwd = process.cwd();
  const hasMarker = existsSync(path.join(cwd, 'artibot.config.json'))
    || existsSync(path.join(cwd, 'plugins', 'artibot', 'artibot.config.json'));
  if (!hasMarker) {
    process.stderr.write(`[artibot:pre-write-guard] Skipped: no artibot.config.json in CWD (${cwd})
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
import { atomicWriteSync, parseJSON, readStdin, writeStdout } from '../utils/index.js';
import { createErrorHandler, extractFilePath, extractToolName, normalizePath } from '../../lib/core/hook-utils.js';

/**
 * Build the tracking file path for a given session.
 * @param {string} sessionId
 * @returns {string}
 */
function getTrackingPath(sessionId) {
  return path.join(os.tmpdir(), `artibot-read-tracking-${sessionId}.json`);
}

/**
 * Load the set of read file paths from the tracking file.
 * @param {string} trackingPath
 * @returns {string[]}
 */
function loadReadPaths(trackingPath) {
  try {
    if (!existsSync(trackingPath)) return [];
    const data = JSON.parse(readFileSync(trackingPath, 'utf-8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

/**
 * Add a file path to the tracking file.
 * @param {string} trackingPath
 * @param {string} filePath
 */
function recordReadPath(trackingPath, filePath) {
  const existing = loadReadPaths(trackingPath);
  const normalized = normalizePath(filePath);
  if (!existing.includes(normalized)) {
    existing.push(normalized);
    atomicWriteSync(trackingPath, JSON.stringify(existing, null, 2));
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
    recordReadPath(trackingPath, filePath);
    process.stderr.write(`[artibot:pre-write-guard] Tracked read: ${filePath}\n`);
  } catch (err) {
    process.stderr.write(`[artibot:pre-write-guard] Track failed: ${err.message}\n`);
  }
  // Always approve Read operations (tracking is best-effort)
  writeStdout({ decision: 'approve' });
}

/**
 * Handle PreToolUse for Write/Edit: check if the file was read first.
 * @param {object} hookData
 */
function handleWriteGuard(hookData) {
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
  const readPaths = loadReadPaths(trackingPath);

  if (readPaths.includes(normalized)) {
    writeStdout({ decision: 'approve' });
    return;
  }

  // Degraded mode: if tracking file is missing, approve with warning
  if (!existsSync(trackingPath)) {
    process.stderr.write(`[artibot:pre-write-guard] Warning: tracking file missing, approving ${toolName} for "${filePath}" in degraded mode\n`);
    writeStdout({ decision: 'approve' });
    return;
  }

  // Block: existing file not read before write/edit
  const reason = `[WRITE-BEFORE-READ] ${toolName} blocked for "${filePath}". `
    + 'File exists but was not Read in this session. '
    + 'Read the file first to understand its contents before modifying.';
  process.stderr.write(`[artibot:pre-write-guard] ${reason}\n`);
  writeStdout({ decision: 'block', reason });
}

async function main() {
  const raw = await readStdin();
  const hookData = parseJSON(raw);
  if (!hookData) return;

  const hookEvent = hookData?.hook_event_name || '';
  const toolName = extractToolName(hookData);

  // PostToolUse Read tracking mode
  if (toolName === 'Read') {
    handleReadTracking(hookData);
    return;
  }

  // PreToolUse Write/Edit guard mode
  if (toolName === 'Write' || toolName === 'Edit') {
    handleWriteGuard(hookData);
    return;
  }

  // Fallback: approve unknown combinations
  writeStdout({ decision: 'approve' });
}

main().catch(createErrorHandler('pre-write-guard', {
  writeStdout,
  blockReason: 'Write-before-read guard failed. Blocking by default.',
}));
