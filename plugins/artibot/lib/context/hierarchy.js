/**
 * 4-level context hierarchy: Plugin -> User -> Project -> Session.
 * Higher levels provide defaults; lower levels override.
 * @module lib/context/hierarchy
 */

import path from 'node:path';
import { readJsonFile } from '../core/file.js';
import { getPluginRoot } from '../core/platform.js';
import { Cache } from '../core/cache.js';

const cache = new Cache(5000);

/**
 * Context hierarchy levels, from broadest to most specific.
 */
export const LEVELS = ['plugin', 'user', 'project', 'session'];

/**
 * Load context from all 4 levels and merge (lower overrides higher).
 * @param {object} [sessionData] - Runtime session data to inject at session level
 * @returns {Promise<object>} Merged context object
 */
export async function loadHierarchy(sessionData = {}) {
  const cacheKey = 'hierarchy:merged';
  const cached = cache.get(cacheKey);
  if (cached && Object.keys(sessionData).length === 0) return cached;

  const pluginCtx = await loadPluginContext();
  const userCtx = await loadUserContext();
  const projectCtx = await loadProjectContext();

  const merged = mergeContexts(pluginCtx, userCtx, projectCtx, sessionData);

  if (Object.keys(sessionData).length === 0) {
    cache.set(cacheKey, merged);
  }

  return merged;
}

/**
 * Plugin-level context from artibot.config.json.
 */
async function loadPluginContext() {
  const configPath = path.join(getPluginRoot(), 'artibot.config.json');
  return (await readJsonFile(configPath)) ?? {};
}

/**
 * User-level context from ~/.claude/artibot-user.json.
 */
async function loadUserContext() {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const userConfigPath = path.join(home, '.claude', 'artibot-user.json');
  return (await readJsonFile(userConfigPath)) ?? {};
}

/**
 * Project-level context from <cwd>/.artibot.json.
 */
async function loadProjectContext() {
  const cwd = process.cwd();
  const projectConfigPath = path.join(cwd, '.artibot.json');
  return (await readJsonFile(projectConfigPath)) ?? {};
}

/**
 * Deep merge multiple context objects. Later arguments override earlier.
 * @param  {...object} sources
 * @returns {object}
 */
export function mergeContexts(...sources) {
  const result = {};
  for (const source of sources) {
    deepAssign(result, source);
  }
  return result;
}

function deepAssign(target, source) {
  for (const key of Object.keys(source)) {
    const val = source[key];
    if (
      val &&
      typeof val === 'object' &&
      !Array.isArray(val) &&
      target[key] &&
      typeof target[key] === 'object' &&
      !Array.isArray(target[key])
    ) {
      deepAssign(target[key], val);
    } else {
      target[key] = val;
    }
  }
}

/** Clear the hierarchy cache. */
export function clearHierarchyCache() {
  cache.clear();
}
