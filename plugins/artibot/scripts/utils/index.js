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
import { writeFileSync, renameSync, mkdirSync } from 'node:fs';
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

/**
 * Atomically write data to a file by writing to a temp file and renaming.
 * Prevents partial-write corruption of state files on crash or concurrent access.
 * @param {string} filePath - Destination file path
 * @param {string|object} data - String content or object to serialize as JSON
 */
export function atomicWriteSync(filePath, data) {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tmpPath = filePath + '.tmp.' + process.pid;
  writeFileSync(tmpPath, typeof data === 'string' ? data : JSON.stringify(data, null, 2), 'utf-8');
  renameSync(tmpPath, filePath);
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
