/**
 * Common utilities for hook scripts.
 * @module scripts/utils
 */

import path from 'node:path';

/**
 * Read all of stdin as a string.
 * @returns {Promise<string>}
 */
export function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(chunks.join('')));
    process.stdin.resume();
  });
}

/**
 * Write a JSON object to stdout.
 * @param {object} data
 */
export function writeStdout(data) {
  process.stdout.write(JSON.stringify(data));
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
 * Get the plugin root directory.
 * Uses CLAUDE_PLUGIN_ROOT env var, or resolves from this file's location.
 * @returns {string}
 */
export function getPluginRoot() {
  if (process.env.CLAUDE_PLUGIN_ROOT) {
    return path.resolve(process.env.CLAUDE_PLUGIN_ROOT);
  }
  // This file is at <root>/scripts/utils/index.js -> go up 2 levels
  const thisDir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/i, '$1'));
  return path.resolve(thisDir, '..', '..');
}

/**
 * Resolve a path relative to plugin root using path.join.
 * @param  {...string} segments
 * @returns {string}
 */
export function resolveConfigPath(...segments) {
  return path.join(getPluginRoot(), ...segments);
}
