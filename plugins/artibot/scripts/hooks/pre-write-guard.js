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
  if (!filePath) return;

  const trackingPath = getTrackingPath(sessionId);
  recordReadPath(trackingPath, filePath);
  process.stderr.write(`[artibot:pre-write-guard] Tracked read: ${filePath}\n`);
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
  if (hookEvent === 'PostToolUse' && toolName === 'Read') {
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
