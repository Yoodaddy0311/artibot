/**
 * Swarm configuration and opt-in/out management.
 *
 * Provides helpers for reading swarm settings from artibot.config.json
 * and managing the user's opt-in consent state via a local flag file.
 *
 * @module lib/swarm/swarm-config
 */

import path from 'node:path';
import { ARTIBOT_DIR } from '../core/config.js';
import { ensureDir, readJsonFile, writeJsonFile } from '../core/file.js';

/** Path to the local opt-in consent file */
const CONSENT_PATH = path.join(ARTIBOT_DIR, 'swarm-consent.json');

/** Default swarm configuration values */
export const SWARM_DEFAULTS = {
  enabled: false,
  optIn: false,
  /**
   * Transport backend:
   *   'http' — classic Node server at serverUrl (localhost only per DATA POLICY)
   *   'git'  — user-owned private git repo (recommended for multi-device sync)
   */
  backend: 'http',
  serverUrl: 'http://localhost:3000',
  /** Git swarm repo URL — only used when backend === 'git' */
  gitRepoUrl: null,
  syncInterval: 'session',
  localGlobalRatio: [0.3, 0.7],
  differentialPrivacy: {
    enabled: true,
    epsilon: 1.0,
    delta: 1e-5,
  },
};

/**
 * Check whether swarm participation is active.
 * Both config.swarm.enabled AND local consent must be true.
 *
 * @param {object} config - Full artibot config object
 * @returns {Promise<boolean>}
 */
export async function isSwarmActive(config) {
  const swarmConfig = config?.swarm ?? SWARM_DEFAULTS;
  if (!swarmConfig.enabled) return false;

  const consent = await loadConsent();
  return consent.optedIn === true;
}

/**
 * Get the merged swarm configuration (defaults + user overrides).
 *
 * @param {object} config - Full artibot config object
 * @returns {object} Resolved swarm config
 */
export function getSwarmConfig(config) {
  const userSwarm = config?.swarm ?? {};
  return {
    ...SWARM_DEFAULTS,
    ...userSwarm,
    differentialPrivacy: {
      ...SWARM_DEFAULTS.differentialPrivacy,
      ...(userSwarm.differentialPrivacy ?? {}),
    },
  };
}

/**
 * Record user opt-in consent.
 *
 * @returns {Promise<{ optedIn: boolean, optedInAt: string }>}
 */
export async function optIn() {
  await ensureDir(ARTIBOT_DIR);
  const consent = {
    optedIn: true,
    optedInAt: new Date().toISOString(),
    optedOutAt: null,
  };
  await writeJsonFile(CONSENT_PATH, consent);
  return consent;
}

/**
 * Record user opt-out.
 *
 * @returns {Promise<{ optedIn: boolean, optedOutAt: string }>}
 */
export async function optOut() {
  await ensureDir(ARTIBOT_DIR);
  const consent = {
    optedIn: false,
    optedInAt: null,
    optedOutAt: new Date().toISOString(),
  };
  await writeJsonFile(CONSENT_PATH, consent);
  return consent;
}

/**
 * Load the current consent state from disk.
 *
 * @returns {Promise<{ optedIn: boolean, optedInAt: string|null, optedOutAt: string|null }>}
 */
export async function loadConsent() {
  const data = await readJsonFile(CONSENT_PATH);
  if (!data || typeof data !== 'object') {
    return { optedIn: false, optedInAt: null, optedOutAt: null };
  }
  return {
    optedIn: data.optedIn === true,
    optedInAt: data.optedInAt ?? null,
    optedOutAt: data.optedOutAt ?? null,
  };
}
