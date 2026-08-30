/**
 * Configuration loader for artibot.config.json.
 * @module lib/core/config
 */

import path from 'node:path';
import { statSync } from 'node:fs';
import { readJsonFile } from './file.js';
import { getHomeDir, getPluginRoot, sameDirPath } from './platform.js';
import { validateConfig } from './config-schema.js';

/**
 * Resolve the base directory for artibot's cross-session user state.
 *
 * `~/.claude/artibot`, deliberately NOT `getPluginRoot()`: this data has to
 * outlive the plugin build that wrote it. In production the plugin root is a
 * version-scoped cache directory (`~/.claude/plugins/cache/artibot/artibot/<v>/`)
 * that Claude Code replaces on upgrade, so anchoring user state there would
 * discard it on every release.
 *
 * `ARTIBOT_STATE_DIR` is the test seam for that choice. It lets a suite redirect
 * user state without moving it in production, and it is read on EVERY call —
 * the `ARTIBOT_DIR` constant below is captured once at import, which is already
 * too late for a test to influence. Any writer that needs to be isolatable must
 * therefore call this function rather than read the constant.
 *
 * @returns {string} Absolute path to the state directory.
 */
export function resolveArtibotDir() {
  const homeDerived = path.join(getHomeDir(), '.claude', 'artibot');
  const override = process.env.ARTIBOT_STATE_DIR;
  if (!override) return homeDerived;

  // The override carries the home it was minted for, and is trusted only while
  // that is still the home in force. Environment variables are inherited by
  // spawned processes, and the hook tests isolate themselves by handing a child
  // `{ ...process.env, HOME: sandbox }` — so without this the override rides
  // along and silently overrules the more specific knob the child was given.
  // Measured 2026-08-30: 4 tests across 2 files broke exactly this way, and 9
  // spawn sites carried the same latent conflict.
  //
  // The pairing is REQUIRED, not optional. An override with no recorded home is
  // an override we cannot place, and "cannot place" must not mean "trust" — the
  // same fail-open shape as a denylist. Census 2026-08-30 found two setters in
  // the repo, both of which record the pair, so nothing relied on the older
  // permissive reading.
  //
  // Compared through `sameDirPath` rather than `===`: `getHomeDir()` returns
  // whatever `USERPROFILE`/`HOME` hold verbatim, so a trailing separator or a
  // drive-letter case difference used to read as a different home and throw the
  // override away — which puts writes back into the real state directory, the
  // exact outcome this seam exists to prevent.
  // Checked against EVERY home variable that is set, not just the winner of
  // `getHomeDir()`'s precedence. That function returns `USERPROFILE` before
  // `HOME`, so a child handed `HOME` alone — the POSIX idiom — moved its home
  // without moving the value being compared, and the override survived a change
  // it was never minted for. Requiring agreement from all of them means any
  // disagreement is a home change, whichever variable carries it.
  const mintedFor = process.env.ARTIBOT_STATE_DIR_HOME;
  if (!mintedFor) return homeDerived;

  const declaredHomes = [process.env.USERPROFILE, process.env.HOME].filter(Boolean);
  const homes = declaredHomes.length > 0 ? declaredHomes : [getHomeDir()];
  if (!homes.every((home) => sameDirPath(mintedFor, home))) return homeDerived;

  return override;
}

/**
 * Base directory for all artibot runtime data.
 * Shared across swarm, learning, and privacy modules.
 *
 * Captured at import, so its value is fixed for the life of the module graph.
 * Existing readers keep that behavior unchanged; new code that writes user state
 * should call `resolveArtibotDir()` so tests can isolate it.
 */
export const ARTIBOT_DIR = resolveArtibotDir();

const DEFAULTS = {
  version: '1.0.0',
  agents: { taskBased: {} },
  team: { enabled: false, maxTeammates: 7 },
  swarm: {
    enabled: false,
    optIn: false,
    serverUrl: 'http://localhost:3000',
    syncInterval: 'session',
    localGlobalRatio: [0.3, 0.7],
    differentialPrivacy: { enabled: true, epsilon: 1.0, delta: 1e-5 },
  },
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
 *
 * @example
 * const config = await loadConfig();
 * console.log(config.team.engine); // 'claude-agent-teams'
 * console.log(config.automation.supportedLanguages); // ['en', 'ko', 'ja']
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

/**
 * Get cached config synchronously (throws if not yet loaded).
 *
 * @example
 * await loadConfig();
 * const config = getConfig();
 * // config.output.defaultStyle === 'artibot-default'
 */
export function getConfig() {
  if (!_cached) throw new Error('Config not loaded. Call loadConfig() first.');
  return _cached;
}

/**
 * Clear cached config and recorded mtime.
 *
 * @example
 * resetConfig();
 * // Next loadConfig() call will re-read from disk
 */
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
