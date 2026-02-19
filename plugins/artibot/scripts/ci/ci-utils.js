/**
 * Shared utilities for CI validation scripts.
 * @module scripts/ci/ci-utils
 */

import path from 'node:path';
import { readFileSync } from 'node:fs';

/**
 * Get the plugin root directory.
 * Uses CLAUDE_PLUGIN_ROOT env var, or resolves from this file's location.
 * @returns {string}
 */
export function getPluginRoot() {
  if (process.env.CLAUDE_PLUGIN_ROOT) return path.resolve(process.env.CLAUDE_PLUGIN_ROOT);
  const thisDir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/i, '$1'));
  // This file is at <root>/scripts/ci/ci-utils.js -> go up 2 levels
  return path.resolve(thisDir, '..', '..');
}

/**
 * Extract YAML frontmatter fields from a Markdown file's content.
 * Supports simple key:value pairs (no nested objects).
 * @param {string} content - Raw file content
 * @returns {object|null} Parsed key-value pairs, or null if no frontmatter found
 */
export function extractFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;
  // Simple YAML key:value parser (no nested objects)
  const fields = {};
  for (const line of match[1].split('\n')) {
    const kv = line.match(/^(\w[\w-]*):\s*(.+)$/);
    if (kv) fields[kv[1].trim()] = kv[2].trim();
  }
  return fields;
}
