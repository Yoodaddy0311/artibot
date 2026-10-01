/**
 * First-Run Safe Mode — AGO Self-Control Wave 2 Module 1.
 *
 * After installation the first N self-control runs are forced into
 * "observe-only" mode: runners log what they WOULD have done but must
 * not actually mutate user state. When the global run counter reaches
 * `observeRuns`, transition to active mode is recorded automatically.
 *
 * Safety invariants:
 *   - Pure filesystem I/O scoped to `runtime/first-run-state.json`.
 *   - Never writes to git, config, or network.
 *   - Concurrency safe: atomic rename per write, read-modify-write merge
 *     tolerates lost updates by keeping the higher counter.
 *
 * WHERE THE COUNTER LIVES (O2). It is GLOBAL — one per user, the point being that
 * it counts runs since INSTALL — so it sits under the artibot state dir
 * (`<state dir>/runtime/first-run-state.json`, `~/.claude/artibot`), not under the
 * plugin root. In a marketplace install the plugin root is a version-scoped cache
 * directory, and a counter kept there restarted at zero on every update (measured
 * 2026-09-30: `first-run-state.json` in 3 of 4 cache version dirs). A relative
 * `statePath` from config resolves under the state dir; an absolute one is used as
 * given. A counter the previous version left is carried over once
 * (`lib/core/runtime-state.js`, copy-if-absent), from `opts.pluginRoot` when a
 * caller passes one and from the running plugin root otherwise.
 *
 * @module lib/learning/first-run-guard
 */

import { existsSync, readFileSync } from 'node:fs';

import { atomicWriteJsonSync } from '../core/file.js';
import { resolveGlobalStateFile } from '../core/runtime-state.js';

const DEFAULT_OBSERVE_RUNS = 5;
const DEFAULT_STATE_PATH = 'runtime/first-run-state.json';

/**
 * Resolve the absolute path to the first-run state file, migrating a legacy
 * plugin-root copy into place the first time it is asked for.
 * @param {object} [config]
 * @param {{pluginRoot?: string}} [opts] - `pluginRoot` names only where a LEGACY copy
 *   may be; it does not decide where the state lives.
 * @returns {string}
 */
function resolveStatePath(config, opts = {}) {
  const rel = config?.ago?.selfControl?.firstRunMode?.statePath || DEFAULT_STATE_PATH;
  return resolveGlobalStateFile(rel, { pluginRoot: opts.pluginRoot });
}

/**
 * Read the state file or return a fresh default. Never throws.
 * @param {string} filePath
 * @returns {{globalRuns: number, features: object, transitions: Array}}
 */
function readState(filePath) {
  if (!existsSync(filePath)) {
    return { globalRuns: 0, features: {}, transitions: [] };
  }
  try {
    const raw = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    return {
      globalRuns: Number.isFinite(parsed.globalRuns) ? parsed.globalRuns : 0,
      features: parsed.features && typeof parsed.features === 'object' ? parsed.features : {},
      transitions: Array.isArray(parsed.transitions) ? parsed.transitions : [],
    };
  } catch {
    return { globalRuns: 0, features: {}, transitions: [] };
  }
}

/**
 * Determine whether first-run mode is disabled globally.
 * @param {object} [config]
 * @returns {boolean}
 */
function isDisabled(config) {
  const cfg = config?.ago?.selfControl?.firstRunMode;
  return cfg?.enabled === false;
}

/**
 * Read observe threshold from config, defaulting to 5.
 * @param {object} [config]
 * @returns {number}
 */
function getObserveRuns(config) {
  const n = config?.ago?.selfControl?.firstRunMode?.observeRuns;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_OBSERVE_RUNS;
}

/**
 * Get the current first-run mode and remaining observe budget.
 * Returns active immediately when opt-out is set.
 *
 * @param {object} [config]
 * @param {{pluginRoot?: string}} [opts]
 * @returns {Promise<{mode: 'observe'|'active', runsRemaining: number, runsSoFar: number}>}
 */
export async function getFirstRunState(config, opts = {}) {
  if (isDisabled(config)) {
    return { mode: 'active', runsRemaining: 0, runsSoFar: 0 };
  }
  const threshold = getObserveRuns(config);
  const state = readState(resolveStatePath(config, opts));
  const runsSoFar = state.globalRuns;
  const runsRemaining = Math.max(0, threshold - runsSoFar);
  return {
    mode: runsSoFar >= threshold ? 'active' : 'observe',
    runsRemaining,
    runsSoFar,
  };
}

/**
 * Increment counters for a feature. Safe to call every run.
 * In active mode this is a no-op and returns current state.
 *
 * @param {string} featureName
 * @param {object} [config]
 * @param {{pluginRoot?: string}} [opts]
 * @returns {Promise<{mode: 'observe'|'active', runsRemaining: number, runsSoFar: number, transitioned: boolean}>}
 */
export async function bumpRunCounter(featureName, config, opts = {}) {
  if (!featureName || typeof featureName !== 'string') {
    throw new TypeError('bumpRunCounter: featureName must be a non-empty string');
  }
  if (isDisabled(config)) {
    return { mode: 'active', runsRemaining: 0, runsSoFar: 0, transitioned: false };
  }
  const threshold = getObserveRuns(config);
  const filePath = resolveStatePath(config, opts);
  const state = readState(filePath);

  // Already active — do not bump globalRuns further but record feature run.
  const wasObserve = state.globalRuns < threshold;
  const feature = state.features[featureName] || { runs: 0, lastObserved: null };
  feature.runs += 1;
  feature.lastObserved = new Date().toISOString();
  state.features[featureName] = feature;

  if (wasObserve) {
    state.globalRuns += 1;
  }

  let transitioned = false;
  if (wasObserve && state.globalRuns >= threshold) {
    state.transitions.push({
      feature: featureName,
      at: new Date().toISOString(),
      from: 'observe',
      to: 'active',
    });
    transitioned = true;
  }

  atomicWriteJsonSync(filePath, state);

  const mode = state.globalRuns >= threshold ? 'active' : 'observe';
  return {
    mode,
    runsRemaining: Math.max(0, threshold - state.globalRuns),
    runsSoFar: state.globalRuns,
    transitioned,
  };
}

/**
 * Runner convenience: should the feature downgrade to observe-only on this run?
 *
 * @param {string} featureName
 * @param {object} [config]
 * @param {{pluginRoot?: string}} [opts]
 * @returns {Promise<{shouldObserve: boolean, reason: string, runsRemaining: number}>}
 */
export async function shouldObserveOnly(featureName, config, opts = {}) {
  const state = await getFirstRunState(config, opts);
  if (state.mode === 'active') {
    return {
      shouldObserve: false,
      reason: 'first-run threshold met or mode disabled',
      runsRemaining: 0,
    };
  }
  return {
    shouldObserve: true,
    reason: `first-run observe mode (${state.runsSoFar}/${state.runsSoFar + state.runsRemaining})`,
    runsRemaining: state.runsRemaining,
  };
}

/**
 * Reset the first-run state file entirely. Used by tests or
 * by a user who reinstalls and wants a fresh observation window.
 *
 * @param {object} [config]
 * @param {{pluginRoot?: string}} [opts]
 * @returns {Promise<{reset: true, path: string}>}
 */
export async function resetFirstRunState(config, opts = {}) {
  const filePath = resolveStatePath(config, opts);
  const fresh = { globalRuns: 0, features: {}, transitions: [] };
  atomicWriteJsonSync(filePath, fresh);
  return { reset: true, path: filePath };
}

/** @internal test helper */
export const _internals = { resolveStatePath, readState, getObserveRuns };
