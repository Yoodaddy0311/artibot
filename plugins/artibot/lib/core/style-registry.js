/**
 * Output Style Registry.
 * Manages built-in and custom output styles for Artibot.
 * Supports both markdown-file styles and programmatic styles.
 *
 * Zero runtime dependencies. ESM only.
 * @module lib/core/style-registry
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { getPluginRoot } from './platform.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Directory name for built-in output styles */
const STYLES_DIR = 'output-styles';

/** Required fields in a style config */
const REQUIRED_FIELDS = ['name'];

/** Maximum registered styles to prevent abuse */
const MAX_STYLES = 50;

// ---------------------------------------------------------------------------
// Types (JSDoc only)
// ---------------------------------------------------------------------------

/**
 * @typedef {object} StyleConfig
 * @property {string} name - Unique style identifier
 * @property {string} [description] - Human-readable description
 * @property {((data: unknown) => string)|null} [formatter] - Custom formatter function
 * @property {string} [template] - Raw markdown template content
 * @property {Record<string, unknown>} [options] - Additional style options
 * @property {string} [source] - 'builtin' | 'custom'
 */

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** @type {Map<string, StyleConfig>} */
const registry = new Map();

/** Whether built-in styles have been loaded */
let builtinsLoaded = false;

// ---------------------------------------------------------------------------
// Core Functions
// ---------------------------------------------------------------------------

/**
 * Register a custom output style.
 *
 * @param {string} name - Unique style identifier
 * @param {object} config - Style configuration
 * @param {string} [config.description] - Human-readable description
 * @param {(data: unknown) => string} [config.formatter] - Custom formatter function
 * @param {string} [config.template] - Markdown template content
 * @param {Record<string, unknown>} [config.options] - Additional options
 * @returns {{ name: string, registered: boolean, error?: string }}
 * @example
 * registerStyle('my-custom', {
 *   description: 'Custom compact output',
 *   formatter: (data) => JSON.stringify(data, null, 2),
 *   options: { compact: true },
 * });
 */
export function registerStyle(name, config = {}) {
  if (!name || typeof name !== 'string') {
    return { name: name ?? '', registered: false, error: 'Name is required and must be a string' };
  }

  if (config.formatter && typeof config.formatter !== 'function') {
    return { name, registered: false, error: 'Formatter must be a function' };
  }

  if (registry.size >= MAX_STYLES && !registry.has(name)) {
    return { name, registered: false, error: `Maximum style limit reached (${MAX_STYLES})` };
  }

  const style = {
    name,
    description: config.description ?? '',
    formatter: config.formatter ?? null,
    template: config.template ?? '',
    options: config.options ?? {},
    source: 'custom',
  };

  registry.set(name, style);
  return { name, registered: true };
}

/**
 * Get a registered style by name.
 * Loads built-in styles on first access if not already loaded.
 *
 * @param {string} name - Style identifier
 * @returns {StyleConfig|null} Style config or null if not found
 * @example
 * const style = getStyle('artibot-default');
 * // { name: 'artibot-default', description: '...', template: '...', source: 'builtin' }
 */
export function getStyle(name) {
  ensureBuiltinsLoaded();

  if (!name || typeof name !== 'string') return null;
  return registry.get(name) ?? null;
}

/**
 * List all registered styles with metadata.
 *
 * @returns {Array<{ name: string, description: string, source: string, hasFormatter: boolean }>}
 * @example
 * const styles = listStyles();
 * // [{ name: 'artibot-default', description: '...', source: 'builtin', hasFormatter: false }, ...]
 */
export function listStyles() {
  ensureBuiltinsLoaded();

  return [...registry.values()].map((s) => ({
    name: s.name,
    description: s.description,
    source: s.source,
    hasFormatter: typeof s.formatter === 'function',
  }));
}

/**
 * Remove a custom style by name.
 * Built-in styles cannot be removed.
 *
 * @param {string} name - Style identifier
 * @returns {{ name: string, removed: boolean, error?: string }}
 * @example
 * removeStyle('my-custom');
 * // { name: 'my-custom', removed: true }
 */
export function removeStyle(name) {
  if (!name || typeof name !== 'string') {
    return { name: name ?? '', removed: false, error: 'Name is required' };
  }

  const style = registry.get(name);
  if (!style) {
    return { name, removed: false, error: 'Style not found' };
  }

  if (style.source === 'builtin') {
    return { name, removed: false, error: 'Cannot remove built-in styles' };
  }

  registry.delete(name);
  return { name, removed: true };
}

/**
 * Format data using a named style's formatter function.
 * Falls back to JSON.stringify if no formatter is available.
 *
 * @param {string} name - Style identifier
 * @param {unknown} data - Data to format
 * @returns {{ output: string, styleName: string, formatted: boolean }}
 * @example
 * const result = formatWithStyle('my-custom', { key: 'value' });
 * // { output: '...', styleName: 'my-custom', formatted: true }
 */
export function formatWithStyle(name, data) {
  const style = getStyle(name);

  if (!style) {
    return {
      output: typeof data === 'string' ? data : JSON.stringify(data, null, 2),
      styleName: name,
      formatted: false,
    };
  }

  if (typeof style.formatter === 'function') {
    const output = style.formatter(data);
    return { output, styleName: name, formatted: true };
  }

  // No formatter: return template or stringified data
  return {
    output: style.template || (typeof data === 'string' ? data : JSON.stringify(data, null, 2)),
    styleName: name,
    formatted: false,
  };
}

/**
 * Check if a style exists in the registry.
 *
 * @param {string} name - Style identifier
 * @returns {boolean}
 * @example
 * hasStyle('artibot-default'); // true
 */
export function hasStyle(name) {
  ensureBuiltinsLoaded();
  return registry.has(name);
}

/**
 * Reset the registry to empty state.
 * Intended for testing or reinitialization.
 *
 * @returns {void}
 */
export function resetRegistry() {
  registry.clear();
  builtinsLoaded = false;
}

// ---------------------------------------------------------------------------
// Internal: Built-in Style Loader
// ---------------------------------------------------------------------------

/**
 * Load built-in styles from the output-styles directory.
 * Only runs once; subsequent calls are no-ops.
 */
function ensureBuiltinsLoaded() {
  if (builtinsLoaded) return;
  builtinsLoaded = true;

  try {
    const stylesDir = path.join(getPluginRoot(), STYLES_DIR);
    if (!existsSync(stylesDir)) return;

    const files = readdirSync(stylesDir).filter((f) => f.endsWith('.md'));

    for (const file of files) {
      try {
        const filePath = path.join(stylesDir, file);
        const content = readFileSync(filePath, 'utf-8');
        const { frontmatter, body } = parseFrontmatter(content);

        const name = frontmatter.name || file.replace(/\.md$/, '');

        registry.set(name, {
          name,
          description: frontmatter.description ?? '',
          formatter: null,
          template: body.trim(),
          options: { ...frontmatter },
          source: 'builtin',
        });
      } catch {
        // Skip files that fail to parse
      }
    }
  } catch {
    // styles directory may not exist in test environments
  }
}

/**
 * Parse YAML-like frontmatter from a markdown string.
 * Supports simple key: value pairs (no nested structures).
 *
 * @param {string} content - Markdown content with optional --- frontmatter ---
 * @returns {{ frontmatter: Record<string, string>, body: string }}
 */
export function parseFrontmatter(content) {
  const frontmatter = {};

  if (!content || typeof content !== 'string') {
    return { frontmatter, body: '' };
  }

  const trimmed = content.trimStart();
  if (!trimmed.startsWith('---')) {
    return { frontmatter, body: content };
  }

  const endIdx = trimmed.indexOf('---', 3);
  if (endIdx === -1) {
    return { frontmatter, body: content };
  }

  const fmBlock = trimmed.slice(3, endIdx).trim();
  const body = trimmed.slice(endIdx + 3);

  for (const line of fmBlock.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;

    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    if (key) {
      frontmatter[key] = value;
    }
  }

  return { frontmatter, body };
}

// ---------------------------------------------------------------------------
// Exported constants
// ---------------------------------------------------------------------------

export { MAX_STYLES, STYLES_DIR, REQUIRED_FIELDS };
