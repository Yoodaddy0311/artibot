/**
 * Configuration loader for artibot.config.json.
 * @module lib/core/config
 */

import path from 'node:path';
import { statSync } from 'node:fs';
import { readJsonFile } from './file.js';
import { getHomeDir, getPluginRoot } from './platform.js';
import { validateConfig } from './config-schema.js';

/**
 * Base directory for all artibot runtime data.
 * Shared across swarm, learning, and privacy modules.
 */
export const ARTIBOT_DIR = path.join(getHomeDir(), '.claude', 'artibot');

const DEFAULTS = {
  version: '1.0.0',
  agents: { taskBased: {} },
  team: { enabled: false, maxTeammates: 7 },
  automation: {
    intentDetection: true,
    ambiguityThreshold: 50,
    supportedLanguages: ['en', 'ko', 'ja'],
  },
  context: {
    importCacheTTL: 30000,
  },
  output: {
    maxContextLength: 500,
    defaultStyle: 'artibot-default',
  },
};

let _cached = null;
let _cachedMtime = null;

/**
 * Load artibot.config.json with defaults.
 * Uses mtime-based cache invalidation: returns cached config if the file has
 * not changed on disk since the last load. Pass force=true to bypass mtime
 * check and always reload from disk.
 */
export async function loadConfig(force = false) {
  const configPath = path.join(getPluginRoot(), 'artibot.config.json');

  if (_cached && !force) {
    let currentMtime = null;
    try {
      currentMtime = statSync(configPath).mtimeMs;
    } catch {
      // File missing or unreadable — fall through to reload
    }
    if (currentMtime !== null && currentMtime === _cachedMtime) {
      return _cached;
    }
  }
  const loaded = await readJsonFile(configPath);
  _cached = deepMerge(DEFAULTS, loaded ?? {});

  // Record mtime after successful load so next call can skip the file read
  try {
    _cachedMtime = statSync(configPath).mtimeMs;
  } catch {
    _cachedMtime = null;
  }

  // Validate merged config and log warnings for invalid fields
  const { valid, errors } = validateConfig(_cached);
  if (!valid) {
    for (const err of errors) {
      process.stderr.write(`[artibot] config warning: ${err}\n`);
    }
  }

  return _cached;
}

/** Get cached config synchronously (throws if not yet loaded). */
export function getConfig() {
  if (!_cached) throw new Error('Config not loaded. Call loadConfig() first.');
  return _cached;
}

/** Clear cached config and recorded mtime. */
export function resetConfig() {
  _cached = null;
  _cachedMtime = null;
}

/** Keys that must never be merged to prevent prototype pollution. */
const UNSAFE_MERGE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (UNSAFE_MERGE_KEYS.has(key)) continue;
    if (
      source[key] &&
      typeof source[key] === 'object' &&
      !Array.isArray(source[key]) &&
      target[key] &&
      typeof target[key] === 'object' &&
      !Array.isArray(target[key])
    ) {
      result[key] = deepMerge(target[key], source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}
