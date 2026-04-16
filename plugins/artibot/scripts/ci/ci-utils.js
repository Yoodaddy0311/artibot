/**
 * Shared utilities for CI validation scripts.
 * @module scripts/ci/ci-utils
 */

// Canonical getPluginRoot from lib/core/platform.js (single source of truth)
export { getPluginRoot } from '../../lib/core/platform.js';

/**
 * Extract YAML frontmatter fields from a Markdown file's content.
 * Supports simple key:value pairs (no nested objects).
 * @param {string} content - Raw file content
 * @returns {object|null} Parsed key-value pairs, or null if no frontmatter found
 */
export function extractFrontmatter(content) {
  // Normalize CRLF -> LF so the regex below works uniformly on Windows files.
  // Without this, lines like "name: foo\r" fail the `^(\w[\w-]*):\s*(.+)$` match
  // because `.` in JS regex does not match `\r`, causing every field to parse
  // as null except the very last line (which has no trailing `\r` before `---`).
  const normalized = String(content).replace(/\r\n/g, '\n');
  const match = normalized.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  // Simple YAML key:value parser (no nested objects).
  // Block scalars (`key: |`) and list values are stored as raw scalar values
  // (truthy), which is sufficient for CI validators that only check presence.
  const fields = {};
  for (const line of match[1].split('\n')) {
    const kv = line.match(/^(\w[\w-]*):\s*(.+)$/);
    if (kv) fields[kv[1].trim()] = kv[2].trim();
  }
  return fields;
}
