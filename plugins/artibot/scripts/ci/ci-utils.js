/**
 * Shared utilities for CI validation scripts.
 * @module scripts/ci/ci-utils
 */

import path from 'node:path';
import { readFileSync } from 'node:fs';

// Canonical getPluginRoot from lib/core/platform.js (single source of truth)
export { getPluginRoot } from '../../lib/core/platform.js';

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
