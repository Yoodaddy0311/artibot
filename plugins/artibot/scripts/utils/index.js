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
 * NEVER THROWS — hooks call this on their exit path, where a throw would turn a
 * lost state write into a crashed hook. The outcome is the return value instead
 * (2026-11-21 review M4): before, a failed write returned `undefined` exactly like
 * a successful one, so a caller could not tell "written" from "logged and lost"
 * and `_team-state.js#mergeSessionSnapshot` reported `wrote: true` either way.
 * Every step that can fail — creating the directory, serializing `data`, writing
 * the tmp file, the rename — answers `false` with a stderr line.
 *
 * lib/ must not call this (layer rule, enforced in eslint.config.js): lib code
 * uses `lib/core/file.js#atomicWriteJsonSync`, which throws so its caller decides.
 *
 * @param {string} filePath - Destination file path
 * @param {string|object} data - String content or object to serialize as JSON
 * @returns {boolean} true when the destination now holds `data`; false otherwise
 */
export function atomicWriteSync(filePath, data) {
  const tmpPath = filePath + '.tmp.' + process.pid;
  let payload;
  try {
    // mkdirSync({ recursive: true }) is idempotent for an existing directory, but it
    // throws when a path component is a file (EEXIST/ENOTDIR) or is not creatable.
    mkdirSync(dirname(filePath), { recursive: true });
    payload = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  } catch (err) {
    process.stderr.write(`[artibot:atomicWrite] cannot prepare ${filePath}: ${err?.code || ''} ${err?.message}\n`);
    return false;
  }

  const writeErr = retryFsOp(() => writeFileSync(tmpPath, payload, 'utf-8'));
  if (writeErr) {
    safeUnlinkTmp(tmpPath);
    process.stderr.write(`[artibot:atomicWrite] tmp write failed for ${filePath}: ${writeErr.code || ''} ${writeErr.message}\n`);
    return false;
  }

  const renameErr = retryFsOp(() => renameSync(tmpPath, filePath));
  if (renameErr) {
    safeUnlinkTmp(tmpPath);
    process.stderr.write(`[artibot:atomicWrite] rename failed for ${filePath}: ${renameErr.code || ''} ${renameErr.message}\n`);
    return false;
  }
  return true;
}

/**
 * Convert a filesystem path to a file:// URL string for dynamic import().
 * Uses manual construction instead of pathToFileURL() because the latter
 * percent-encodes non-ASCII characters (e.g., Korean 바탕 화면 -> %EB%B0%94...),
 * which Node.js import() on Windows cannot resolve back to filesystem paths.
 *
 * Three ASCII characters are still encoded, because a URL parser gives them a
 * meaning whatever this helper intends (2026-11-21 review L2): `#` would start a
 * fragment and `?` a query (the rest of the path is dropped), and a literal `%`
 * would be read as an escape (`%41` -> `A`). `%` is encoded FIRST so the escapes
 * produced for `#` and `?` are not encoded a second time. Hangul and spaces stay
 * literal. tests/scripts/utils-to-file-url.test.js imports through a real `#`
 * directory in a child node.
 *
 * @param {string} filePath - Absolute filesystem path
 * @returns {string} file:// URL string
 */
export function toFileUrl(filePath) {
  const forward = filePath
    .replace(/\\/g, '/')
    .replace(/%/g, '%25')
    .replace(/#/g, '%23')
    .replace(/\?/g, '%3F');
  // Windows absolute paths need file:///C:/... (empty authority)
  if (/^[A-Z]:/i.test(forward)) {
    return `file:///${forward}`;
  }
  return `file://${forward}`;
}
