/**
 * Safe-default reader for the `learning.grpoRouting` config block.
 *
 * The router's hot path must not fail when the block is missing, partial,
 * or malformed. This module memoizes the resolved config for 60s so the
 * router pays a single JSON read per window even on chatty classification
 * traffic.
 *
 * Config shape (design §8.4):
 *   {
 *     "enabled": boolean,
 *     "policyPath": string,
 *     "blendAlpha": number,        // [0.3, 1.0]
 *     "alphaDecayPerWeek": number, // [0, 0.2]
 *     "alphaFloor": number,        // [0.1, 0.9]
 *     "epsilonExplore": number,    // [0, 0.2]
 *     "epsilonFloor": number,      // [0, 0.1]
 *     "coldStartEpisodes": number, // >= 0 integer
 *     "klPenalty": number,         // [0, 1]
 *     "learningRate": number,      // (0, 1]
 *     "snapshotCount": number,     // >= 1 integer
 *     "groupingLevels": string[]
 *   }
 *
 * @module lib/cognitive/grpo-routing-config
 */

import { loadConfig } from '../core/config.js';

/** Default block — used when `artibot.config.json` is missing the section. */
export const GRPO_ROUTING_DEFAULTS = Object.freeze({
  enabled: false,
  policyPath: '~/.claude/artibot/policies/routing-policy-v1.json',
  blendAlpha: 0.7,
  alphaDecayPerWeek: 0.05,
  alphaFloor: 0.3,
  epsilonExplore: 0.05,
  epsilonFloor: 0.01,
  coldStartEpisodes: 200,
  klPenalty: 0.01,
  learningRate: 0.02,
  snapshotCount: 3,
  groupingLevels: Object.freeze(['fine', 'medium', 'coarse']),
});

const CONFIG_TTL_MS = 60_000;

/** @type {{ loadedAt: number, value: object }|null} */
let _configCache = null;

/**
 * Reset the in-memory config cache. For test isolation.
 * @returns {void}
 */
export function resetGrpoRoutingConfigCache() {
  _configCache = null;
}

/**
 * Inject a raw config fragment into the memo for deterministic tests.
 * The value is normalized + frozen; TTL is set to now. NEVER call this in
 * production code paths — it exists purely so integration tests can toggle
 * the `enabled` flag without mutating `artibot.config.json` on disk.
 *
 * @param {object|undefined} rawFragment - Raw `learning.grpoRouting` shape.
 * @returns {object} the normalized value now in the cache
 */
export function __setCachedConfigForTests(rawFragment) {
  const value = normalize(rawFragment);
  _configCache = { loadedAt: Date.now(), value };
  return value;
}

/**
 * Coerce a value to a finite number inside [min, max]; fallback on failure.
 * @param {unknown} value
 * @param {number} min
 * @param {number} max
 * @param {number} fallback
 * @returns {number}
 */
function numberIn(value, min, max, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/**
 * Coerce a value to a non-negative integer; fallback on failure.
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function nonNegInt(value, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const n = Math.floor(value);
  return n >= 0 ? n : fallback;
}

/**
 * Normalize a raw config fragment into the frozen config shape. Any field that
 * fails validation is replaced by its default, never left to crash downstream.
 * @param {object|undefined} raw
 * @returns {object}
 */
function normalize(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const groupingLevels = Array.isArray(r.groupingLevels)
    ? r.groupingLevels.filter((v) => typeof v === 'string' && v.length > 0)
    : [...GRPO_ROUTING_DEFAULTS.groupingLevels];

  return Object.freeze({
    enabled: r.enabled === true,
    policyPath: typeof r.policyPath === 'string' && r.policyPath.length > 0
      ? r.policyPath
      : GRPO_ROUTING_DEFAULTS.policyPath,
    blendAlpha: numberIn(r.blendAlpha, 0.1, 1.0, GRPO_ROUTING_DEFAULTS.blendAlpha),
    alphaDecayPerWeek: numberIn(r.alphaDecayPerWeek, 0, 0.2, GRPO_ROUTING_DEFAULTS.alphaDecayPerWeek),
    alphaFloor: numberIn(r.alphaFloor, 0.1, 0.9, GRPO_ROUTING_DEFAULTS.alphaFloor),
    epsilonExplore: numberIn(r.epsilonExplore, 0, 0.2, GRPO_ROUTING_DEFAULTS.epsilonExplore),
    epsilonFloor: numberIn(r.epsilonFloor, 0, 0.1, GRPO_ROUTING_DEFAULTS.epsilonFloor),
    coldStartEpisodes: nonNegInt(r.coldStartEpisodes, GRPO_ROUTING_DEFAULTS.coldStartEpisodes),
    klPenalty: numberIn(r.klPenalty, 0, 1, GRPO_ROUTING_DEFAULTS.klPenalty),
    learningRate: numberIn(r.learningRate, 0.0001, 1, GRPO_ROUTING_DEFAULTS.learningRate),
    snapshotCount: Math.max(1, nonNegInt(r.snapshotCount, GRPO_ROUTING_DEFAULTS.snapshotCount)),
    groupingLevels: Object.freeze(
      groupingLevels.length > 0 ? groupingLevels : [...GRPO_ROUTING_DEFAULTS.groupingLevels],
    ),
  });
}

/**
 * Read, memoize, and safe-default the `learning.grpoRouting` block.
 *
 * Never throws — on any IO or JSON error, returns {@link GRPO_ROUTING_DEFAULTS}
 * frozen-normalized. Cached for 60s; pass `{ force: true }` to bypass the TTL
 * (primarily for tests).
 *
 * @param {{ force?: boolean }} [options]
 * @returns {Promise<object>}
 *
 * @example
 * const cfg = await getGrpoRoutingConfig();
 * if (cfg.enabled) useBias();
 */
export async function getGrpoRoutingConfig(options = {}) {
  const now = Date.now();
  if (!options.force && _configCache && now - _configCache.loadedAt < CONFIG_TTL_MS) {
    return _configCache.value;
  }

  let raw;
  try {
    const config = await loadConfig(Boolean(options.force));
    raw = config?.learning?.grpoRouting;
  } catch {
    raw = undefined;
  }

  const value = normalize(raw);
  _configCache = { loadedAt: now, value };
  return value;
}

/**
 * Synchronous peek at the last resolved config. When the memo is cold or the
 * TTL has expired, returns {@link GRPO_ROUTING_DEFAULTS} — crucially with
 * `enabled: false`, so the router's hot path is guaranteed to take the
 * zero-cost heuristic branch whenever this module has not yet been warmed.
 *
 * @returns {object}
 */
export function getCachedGrpoRoutingConfig() {
  const now = Date.now();
  if (_configCache && now - _configCache.loadedAt < CONFIG_TTL_MS) {
    return _configCache.value;
  }
  return normalize(undefined);
}
