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
  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
  const tmpPath = filePath + '.tmp.' + process.pid;
  const payload = typeof data === 'string' ? data : JSON.stringify(data, null, 2);

  // Write tmp with retry (rare, but writeFileSync can also EPERM under contention).
  const backoffs = [0, 50, 100, 200];
  let writeErr = null;
  for (let i = 0; i < backoffs.length; i++) {
    if (i > 0) sleepSync(backoffs[i]);
    try {
      writeFileSync(tmpPath, payload, 'utf-8');
      writeErr = null;
      break;
    } catch (err) {
      writeErr = err;
      if (!RETRYABLE_FS_CODES.has(err.code)) break;
    }
  }
  if (writeErr) {
    safeUnlinkTmp(tmpPath);
    process.stderr.write(`[artibot:atomicWrite] tmp write failed for ${filePath}: ${writeErr.code || ''} ${writeErr.message}\n`);
    return; // graceful: never throw out of a hook write
  }

  // Rename with retry. EPERM on Windows is the dominant failure here.
  let renameErr = null;
  for (let i = 0; i < backoffs.length; i++) {
    if (i > 0) sleepSync(backoffs[i]);
    try {
      renameSync(tmpPath, filePath);
      renameErr = null;
      break;
    } catch (err) {
      renameErr = err;
      if (!RETRYABLE_FS_CODES.has(err.code)) break;
    }
  }
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
