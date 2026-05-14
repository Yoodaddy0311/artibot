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
