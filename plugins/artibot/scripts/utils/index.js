/**
 * Common utilities for hook scripts.
 *
 * I/O functions (readStdin, writeStdout, parseJSON) delegate to lib/core/io.js
 * to eliminate duplication. The hook-specific names (e.g., writeStdout vs writeJSON)
 * are preserved for backward compatibility with existing hook scripts.
 *
 * @module scripts/utils
 */

import path from 'node:path';
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

// Canonical getPluginRoot from lib/core/platform.js (single source of truth)
import { getPluginRoot } from '../../lib/core/platform.js';
export { getPluginRoot };

// Delegate I/O to lib/core/io.js (single source of truth)
import { readStdin, writeJSON } from '../../lib/core/io.js';
export { readStdin };

/**
 * Write a JSON object to stdout.
 * Alias for lib/core/io.js writeJSON, kept for backward compatibility with hook scripts.
 * @param {object} data
 */
export function writeStdout(data) {
  writeJSON(data);
}

/**
 * Parse a JSON string safely. Returns null on failure.
 * @param {string} str
 * @returns {object|null}
 */
export function parseJSON(str) {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

/**
 * Resolve a path relative to plugin root using path.join.
 * @param  {...string} segments
 * @returns {string}
 */
export function resolveConfigPath(...segments) {
  return path.join(getPluginRoot(), ...segments);
}

// Retryable error codes on Windows when another process / AV / indexer holds the file
const RETRYABLE_FS_CODES = new Set(['EPERM', 'EBUSY', 'EACCES', 'EEXIST']);

/**
 * Sleep synchronously by busy-waiting (Node has no setTimeoutSync).
 * Used only inside the retry loop, so the wait windows are short (50/100/200ms).
 * @param {number} ms
 */
function sleepSync(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { /* busy wait */ }
}

/**
 * Best-effort tmp file cleanup. Swallows all errors (file may be locked or gone).
 * @param {string} tmpPath
 */
function safeUnlinkTmp(tmpPath) {
  try {
    unlinkSync(tmpPath);
  } catch { /* ignore */ }
}

// Backoff schedule for retryFsOp: immediate, then 50/100/200ms (max 4 attempts).
const FS_RETRY_BACKOFFS = [0, 50, 100, 200];

/**
 * Run a sync fs operation with bounded retry on transient Windows errors
 * (EPERM/EBUSY/EACCES/EEXIST from AV / indexer / concurrent holders).
 * Returns the last error or null on success.
 * @param {() => void} fn - Sync fs op to attempt
 * @returns {Error|null}
 */
function retryFsOp(fn) {
  let lastErr = null;
  for (let i = 0; i < FS_RETRY_BACKOFFS.length; i++) {
    if (i > 0) sleepSync(FS_RETRY_BACKOFFS[i]);
    try {
      fn();
      return null;
    } catch (err) {
      lastErr = err;
      if (!RETRYABLE_FS_CODES.has(err.code)) break;
    }
  }
  return lastErr;
}

/**
 * Atomically write data to a file by writing to a temp file and renaming.
 * Prevents partial-write corruption of state files on crash or concurrent access.
 *
 * Hardened for Windows: rename() can throw EPERM/EBUSY when another hook
 * instance, antivirus, or the file indexer momentarily holds the target file.
 * Retries with exponential backoff (50ms -> 100ms -> 200ms, max 3 attempts).
 * On final failure logs to stderr and best-effort unlinks the tmp file so
 * `~/.claude/artibot-state.json.tmp.<pid>` orphans do not accumulate.
 *
 * @param {string} filePath - Destination file path
 * @param {string|object} data - String content or object to serialize as JSON
 */
export function atomicWriteSync(filePath, data) {
  const dir = dirname(filePath);
  // mkdirSync({ recursive: true }) is idempotent on Node >=10.12 — never throws EEXIST.
  mkdirSync(dir, { recursive: true });
  const tmpPath = filePath + '.tmp.' + process.pid;
  const payload = typeof data === 'string' ? data : JSON.stringify(data, null, 2);

  const writeErr = retryFsOp(() => writeFileSync(tmpPath, payload, 'utf-8'));
  if (writeErr) {
    safeUnlinkTmp(tmpPath);
    process.stderr.write(`[artibot:atomicWrite] tmp write failed for ${filePath}: ${writeErr.code || ''} ${writeErr.message}\n`);
    return; // graceful: never throw out of a hook write
  }

  const renameErr = retryFsOp(() => renameSync(tmpPath, filePath));
  if (renameErr) {
    safeUnlinkTmp(tmpPath);
    process.stderr.write(`[artibot:atomicWrite] rename failed for ${filePath}: ${renameErr.code || ''} ${renameErr.message}\n`);
  }
}

/**
 * Convert a filesystem path to a file:// URL string for dynamic import().
 * Uses manual construction instead of pathToFileURL() because the latter
 * percent-encodes non-ASCII characters (e.g., Korean 바탕 화면 -> %EB%B0%94...),
 * which Node.js import() on Windows cannot resolve back to filesystem paths.
 * @param {string} filePath - Absolute filesystem path
 * @returns {string} file:// URL string
 */
export function toFileUrl(filePath) {
  const forward = filePath.replace(/\\/g, '/');
  // Windows absolute paths need file:///C:/... (empty authority)
  if (/^[A-Z]:/i.test(forward)) {
    return `file:///${forward}`;
  }
  return `file://${forward}`;
}
