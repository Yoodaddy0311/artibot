/**
 * Configuration loader for artibot.config.json.
 * @module lib/core/config
 */

import path from 'node:path';
import os from 'node:os';
import { readJsonFile } from './file.js';
import { getPluginRoot } from './platform.js';

/**
 * Base directory for all artibot runtime data.
 * Shared across swarm, learning, and privacy modules.
 */
export const ARTIBOT_DIR = path.join(os.homedir(), '.claude', 'artibot');

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
    hierarchyCacheTTL: 5000,
  },
  output: {
    maxContextLength: 500,
    defaultStyle: 'artibot-default',
  },
};

let _cached = null;

/**
 * Load artibot.config.json with defaults.
 * Caches on first load; pass force=true to reload.
 */
export async function loadConfig(force = false) {
  if (_cached && !force) return _cached;

  const configPath = path.join(getPluginRoot(), 'artibot.config.json');
  const loaded = await readJsonFile(configPath);
  _cached = deepMerge(DEFAULTS, loaded ?? {});
  return _cached;
}

/** Get cached config synchronously (throws if not yet loaded). */
export function getConfig() {
  if (!_cached) throw new Error('Config not loaded. Call loadConfig() first.');
  return _cached;
}

/** Clear cached config. */
export function resetConfig() {
  _cached = null;
}

function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
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
