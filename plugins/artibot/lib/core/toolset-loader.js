/**
 * Toolset manifest loader.
 *
 * Loads `plugins/artibot/toolsets.json` and provides lookup helpers for
 * command-to-toolset resolution. Caches the parsed manifest in-memory and
 * invalidates the cache on file mtime change.
 *
 * Phase 1 Quick Win — adopted from NousResearch/hermes-agent benchmark.
 *
 * @module lib/core/toolset-loader
 */

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { getPluginRoot } from './platform.js';

/** @type {{ data: object, mtimeMs: number, path: string } | null} */
let cache = null;

function manifestPath() {
  return path.join(getPluginRoot(), 'toolsets.json');
}

/**
 * Load the toolset manifest, using an in-memory cache invalidated by mtime.
 *
 * @returns {Promise<object>} Parsed manifest with `version`, `toolsets`.
 */
export async function loadToolsets() {
  const file = manifestPath();
  const stats = await stat(file);
  if (cache && cache.path === file && cache.mtimeMs === stats.mtimeMs) {
    return cache.data;
  }
  const raw = await readFile(file, 'utf-8');
  const data = JSON.parse(raw);
  cache = { data, mtimeMs: stats.mtimeMs, path: file };
  return data;
}

/**
 * Find the toolset name that owns a given command.
 *
 * @param {string} commandName - Command slug (without .md extension).
 * @returns {Promise<string|null>} Toolset name or null if unassigned.
 */
export async function getToolsetForCommand(commandName) {
  const manifest = await loadToolsets();
  for (const [toolsetName, toolset] of Object.entries(manifest.toolsets || {})) {
    if (Array.isArray(toolset.commands) && toolset.commands.includes(commandName)) {
      return toolsetName;
    }
  }
  return null;
}

/**
 * List all command slugs registered to a given toolset.
 *
 * @param {string} toolsetName - Toolset key (e.g., "code", "marketing").
 * @returns {Promise<string[]>} Command slugs (empty array if toolset missing).
 */
export async function listCommandsInToolset(toolsetName) {
  const manifest = await loadToolsets();
  const toolset = manifest.toolsets?.[toolsetName];
  return Array.isArray(toolset?.commands) ? [...toolset.commands] : [];
}

/**
 * List all toolset names defined in the manifest.
 *
 * @returns {Promise<string[]>}
 */
export async function listToolsets() {
  const manifest = await loadToolsets();
  return Object.keys(manifest.toolsets || {});
}

/**
 * Reset the in-memory cache. Mainly for tests.
 */
export function _resetToolsetCache() {
  cache = null;
}
