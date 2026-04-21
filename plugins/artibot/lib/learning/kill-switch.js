/**
 * Kill Switch — automatic safety cutoff for self-control features.
 *
 * Two modes coexist for backward compatibility:
 *
 *  1. Per-feature mode (original, v1): records failures per feature key in
 *     `runtime/kill-switch.json`. `threshold` failures inside `windowMs`
 *     mark the feature tripped. `resetKillSwitch(feature, config)` clears
 *     one feature.
 *
 *  2. Emergency global mode (AGO Wave 2): when
 *     `ago.selfControl.emergencyKillSwitch` is present, a second state file
 *     (`runtime/kill-switch-state.json`) tracks a rolling 1h failure count
 *     across ALL features. When it reaches `maxFailuresPerHour`, the
 *     switch trips globally — `masterEnabled` in `artibot.config.json` is
 *     atomically flipped to `false` and a 24h cooldown begins. After
 *     cooldown the failure log self-clears but the user must manually
 *     re-enable `masterEnabled`.
 *
 * Safety invariants:
 *   - `artibot.config.json` is only mutated via atomic tmp-rename.
 *   - No shell, no network, no git.
 *   - No prototype pollution (FORBIDDEN_KEYS filter).
 *   - Read/write failures never throw to callers.
 *
 * @module lib/learning/kill-switch
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { readJsonFile, writeJsonFile } from '../core/file.js';
import { getPluginRoot } from '../core/platform.js';

// ---------------------------------------------------------------------------
// Per-feature (v1) constants
// ---------------------------------------------------------------------------

const STATE_PATH = 'runtime/kill-switch.json';
const DEFAULT_THRESHOLD = 3;
const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

// ---------------------------------------------------------------------------
// Emergency global (Wave 2) constants
// ---------------------------------------------------------------------------

const EMERGENCY_STATE_PATH = 'runtime/kill-switch-state.json';
const EMERGENCY_MAX_FAILURES = 3;
const EMERGENCY_COOLDOWN_HOURS = 24;
const ONE_HOUR_MS = 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the per-feature kill-switch state file path.
 * @param {object} [config]
 * @param {string} [pluginRoot]
 * @returns {string}
 */
function resolveStatePath(config, pluginRoot) {
  const root = pluginRoot || getPluginRoot();
  const relative = config?.ago?.selfControl?.killSwitch?.statePath || STATE_PATH;
  if (path.isAbsolute(relative)) return relative;
  return path.join(root, relative);
}

/**
 * Resolve the emergency-switch state file path.
 * @param {object} [config]
 * @param {string} [pluginRoot]
 * @returns {string}
 */
function resolveEmergencyStatePath(config, pluginRoot) {
  const root = pluginRoot || getPluginRoot();
  const relative = config?.ago?.selfControl?.emergencyKillSwitch?.statePath || EMERGENCY_STATE_PATH;
  if (path.isAbsolute(relative)) return relative;
  return path.join(root, relative);
}

/** @returns {string} */
function resolveConfigJsonPath(pluginRoot) {
  return path.join(pluginRoot || getPluginRoot(), 'artibot.config.json');
}

// ---------------------------------------------------------------------------
// Atomic JSON write (used for config.json and emergency state)
// ---------------------------------------------------------------------------

/**
 * Atomic JSON write. Creates parent dirs, tolerates EEXIST, rename-over.
 * @param {string} filePath
 * @param {object} data
 */
function atomicWriteJson(filePath, data) {
  const dir = path.dirname(filePath);
  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
  renameSync(tmp, filePath);
}

// ---------------------------------------------------------------------------
// Per-feature (v1) option resolution + state I/O
// ---------------------------------------------------------------------------

/**
 * Resolve threshold + window for per-feature v1 semantics.
 * @param {object} [config]
 * @returns {{threshold: number, windowMs: number}}
 */
function resolveKsOptions(config) {
  const ks = config?.ago?.selfControl?.killSwitch || {};
  const threshold = Number.isFinite(ks.threshold) && ks.threshold >= 1
    ? ks.threshold : DEFAULT_THRESHOLD;
  const windowMs = Number.isFinite(ks.windowMs) && ks.windowMs >= 0
    ? ks.windowMs : DEFAULT_WINDOW_MS;
  return { threshold, windowMs };
}

/**
 * Load per-feature state; always returns valid shape.
 * @param {string} filePath
 * @returns {Promise<{features: object}>}
 */
async function loadState(filePath) {
  const raw = await readJsonFile(filePath);
  const state = { features: Object.create(null) };
  if (!raw || typeof raw !== 'object') return state;
  const features = raw.features;
  if (features && typeof features === 'object' && !Array.isArray(features)) {
    for (const [k, v] of Object.entries(features)) {
      if (FORBIDDEN_KEYS.has(k)) continue;
      if (!v || typeof v !== 'object') continue;
      state.features[k] = {
        failures: Array.isArray(v.failures) ? v.failures.slice(0, 100) : [],
        trippedAt: typeof v.trippedAt === 'string' ? v.trippedAt : null,
      };
    }
  }
  return state;
}

// ---------------------------------------------------------------------------
// Emergency (global) option resolution + state I/O
// ---------------------------------------------------------------------------

/** @param {object} [config] */
function emergencyEnabled(config) {
  return config?.ago?.selfControl?.emergencyKillSwitch?.enabled === true;
}

/** @param {object} [config] */
function emergencyMax(config) {
  const n = config?.ago?.selfControl?.emergencyKillSwitch?.maxFailuresPerHour;
  return Number.isFinite(n) && n > 0 ? n : EMERGENCY_MAX_FAILURES;
}

/** @param {object} [config] */
function emergencyCooldownHours(config) {
  const n = config?.ago?.selfControl?.emergencyKillSwitch?.cooldownHours;
  return Number.isFinite(n) && n > 0 ? n : EMERGENCY_COOLDOWN_HOURS;
}

/**
 * Read emergency state, defaulting on missing/corrupt file. Never throws.
 * @param {string} filePath
 */
function readEmergencyState(filePath) {
  const defaults = { failures: [], tripped: false, trippedAt: null, cooldownUntil: null };
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
    return {
      failures: Array.isArray(parsed.failures) ? parsed.failures : [],
      tripped: Boolean(parsed.tripped),
      trippedAt: typeof parsed.trippedAt === 'string' ? parsed.trippedAt : null,
      cooldownUntil: typeof parsed.cooldownUntil === 'string' ? parsed.cooldownUntil : null,
    };
  } catch {
    return defaults;
  }
}

/**
 * Filter a failures array to entries within the last hour.
 * @param {Array<{timestamp: string}>} failures
 * @param {number} [nowMs]
 */
function failuresPastHour(failures, nowMs = Date.now()) {
  const cutoff = nowMs - ONE_HOUR_MS;
  return failures.filter((f) => {
    const t = Date.parse(f?.timestamp || '');
    return Number.isFinite(t) && t >= cutoff;
  });
}

/**
 * Atomically flip `ago.selfControl.masterEnabled` in artibot.config.json.
 * @param {boolean} enabled
 * @param {string} [pluginRoot]
 * @returns {boolean} success
 */
function setMasterEnabled(enabled, pluginRoot) {
  const cfgPath = resolveConfigJsonPath(pluginRoot);
  try {
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    cfg.ago = cfg.ago || {};
    cfg.ago.selfControl = cfg.ago.selfControl || {};
    cfg.ago.selfControl.masterEnabled = Boolean(enabled);
    atomicWriteJson(cfgPath, cfg);
    return true;
  } catch (err) {
    process.stderr.write(`[artibot:kill-switch] config write failed: ${err.message}\n`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Public API — per-feature (backward compatible)
// ---------------------------------------------------------------------------

/**
 * Determine whether the kill-switch is tripped.
 *
 * Two calling conventions are supported:
 *   isKillSwitchTripped(config)                 // any feature tripped OR emergency tripped
 *   isKillSwitchTripped(config, { feature })    // specific feature tripped
 *
 * Pure read in the per-feature branch. The emergency branch may apply
 * cooldown-expiry side-effects via getKillSwitchState().
 *
 * @param {object} [config]
 * @param {{pluginRoot?: string, feature?: string, now?: number}} [opts]
 * @returns {Promise<boolean>}
 */
export async function isKillSwitchTripped(config, opts = {}) {
  const feature = typeof opts.feature === 'string' ? opts.feature : null;
  const filePath = resolveStatePath(config, opts.pluginRoot);
  const state = await loadState(filePath);

  if (feature) {
    if (FORBIDDEN_KEYS.has(feature)) return false;
    return Boolean(state.features[feature]?.trippedAt);
  }

  const anyFeatureTripped = Object.values(state.features).some((f) => f?.trippedAt);
  if (anyFeatureTripped) return true;

  if (emergencyEnabled(config)) {
    const emergency = await getKillSwitchState(config, { pluginRoot: opts.pluginRoot });
    return emergency.tripped;
  }
  return false;
}

/**
 * Record one failure.
 *
 * - Always updates the per-feature log (v1 semantics).
 * - When `emergencyKillSwitch.enabled === true`, also appends to the
 *   emergency rolling-hour log and, at threshold, trips the global
 *   switch (flips masterEnabled=false + starts cooldown).
 *
 * @param {{feature: string, error?: string, timestamp?: string}} entry
 * @param {object} [config]
 * @param {{pluginRoot?: string, now?: number}} [opts]
 * @returns {Promise<{tripped: boolean, count: number, emergency?: {tripped: boolean, failuresPast1h: number, masterDisabled: boolean}}>}
 */
export async function recordFailure(entry, config, opts = {}) {
  const feature = typeof entry?.feature === 'string' ? entry.feature : null;
  if (!feature || FORBIDDEN_KEYS.has(feature)) return { tripped: false, count: 0 };
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const { threshold, windowMs } = resolveKsOptions(config);
  const filePath = resolveStatePath(config, opts.pluginRoot);
  const state = await loadState(filePath);

  // v1 per-feature update
  const prev = state.features[feature] || { failures: [], trippedAt: null };
  const cutoff = now - windowMs;
  const recent = prev.failures.filter((f) => Number.isFinite(f?.at) && f.at >= cutoff);
  recent.push({ at: now, error: String(entry.error || '').slice(0, 500) });
  const tripped = recent.length >= threshold;
  state.features[feature] = {
    failures: recent,
    trippedAt: tripped ? (prev.trippedAt || new Date(now).toISOString()) : prev.trippedAt,
  };
  try { await writeJsonFile(filePath, state); } catch { /* best-effort */ }

  // Emergency global branch (opt-in via config)
  let emergency;
  if (emergencyEnabled(config)) {
    emergency = await recordEmergencyFailure(entry, config, { ...opts, now });
  }

  return {
    tripped: Boolean(state.features[feature].trippedAt),
    count: recent.length,
    ...(emergency ? { emergency } : {}),
  };
}

/**
 * Manually reset the kill-switch.
 *
 * Calling conventions:
 *   resetKillSwitch(feature, config)   // v1: per-feature reset
 *   resetKillSwitch(config)            // Wave 2: emergency reset + master re-enable
 *   resetKillSwitch()                  // full reset of both state files
 *
 * @param {string|object} [featureOrConfig]
 * @param {object} [maybeConfig]
 * @param {{pluginRoot?: string}} [opts]
 * @returns {Promise<{reset: boolean, masterRestored?: boolean}>}
 */
export async function resetKillSwitch(featureOrConfig, maybeConfig, opts = {}) {
  // Detect calling convention
  if (typeof featureOrConfig === 'string') {
    const feature = featureOrConfig;
    const config = maybeConfig;
    if (FORBIDDEN_KEYS.has(feature)) return { reset: false };
    const filePath = resolveStatePath(config, opts.pluginRoot);
    const state = await loadState(filePath);
    if (!state.features[feature]) return { reset: false };
    state.features[feature] = { failures: [], trippedAt: null };
    try { await writeJsonFile(filePath, state); } catch { /* ignore */ }
    return { reset: true };
  }

  // Object or undefined → emergency + global reset
  const config = featureOrConfig;
  const emergencyPath = resolveEmergencyStatePath(config, opts.pluginRoot);
  const fresh = { failures: [], tripped: false, trippedAt: null, cooldownUntil: null };
  try { atomicWriteJson(emergencyPath, fresh); } catch { /* ignore */ }

  // Also clear v1 state
  const v1Path = resolveStatePath(config, opts.pluginRoot);
  try { await writeJsonFile(v1Path, { features: Object.create(null) }); } catch { /* ignore */ }

  const masterRestored = setMasterEnabled(true, opts.pluginRoot);
  return { reset: true, masterRestored };
}

// ---------------------------------------------------------------------------
// Public API — emergency global (Wave 2)
// ---------------------------------------------------------------------------

/**
 * Snapshot the emergency kill-switch state. Applies cooldown expiry
 * side-effect: when cooldownUntil is past, failures clear and tripped
 * flips to false. `masterEnabled` is NOT auto-restored — user must
 * manually re-enable.
 *
 * @param {object} [config]
 * @param {{pluginRoot?: string, now?: number}} [opts]
 * @returns {Promise<{tripped: boolean, failuresPast1h: number, cooldownUntil: string|null}>}
 */
export async function getKillSwitchState(config, opts = {}) {
  if (!emergencyEnabled(config)) {
    return { tripped: false, failuresPast1h: 0, cooldownUntil: null };
  }
  const filePath = resolveEmergencyStatePath(config, opts.pluginRoot);
  const state = readEmergencyState(filePath);
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();

  let changed = false;
  if (state.tripped && state.cooldownUntil && Date.parse(state.cooldownUntil) <= now) {
    state.tripped = false;
    state.trippedAt = null;
    state.cooldownUntil = null;
    state.failures = [];
    changed = true;
  }
  const recent = failuresPastHour(state.failures, now);
  if (recent.length !== state.failures.length) {
    state.failures = recent;
    changed = true;
  }
  if (changed) {
    try { atomicWriteJson(filePath, state); } catch { /* ignore */ }
  }

  return {
    tripped: state.tripped,
    failuresPast1h: recent.length,
    cooldownUntil: state.cooldownUntil,
  };
}

/**
 * Record an emergency failure in the global rolling-hour log.
 * Trips globally at threshold and flips masterEnabled=false.
 *
 * @param {{feature: string, error?: string, timestamp?: string}} entry
 * @param {object} [config]
 * @param {{pluginRoot?: string, now?: number}} [opts]
 * @returns {Promise<{tripped: boolean, failuresPast1h: number, cooldownUntil: string|null, masterDisabled: boolean}>}
 */
async function recordEmergencyFailure(entry, config, opts = {}) {
  const filePath = resolveEmergencyStatePath(config, opts.pluginRoot);
  const max = emergencyMax(config);
  const cooldownHours = emergencyCooldownHours(config);
  const nowMs = Number.isFinite(opts.now) ? opts.now : Date.now();
  const nowIso = new Date(nowMs).toISOString();

  const state = readEmergencyState(filePath);
  state.failures.push({
    feature: String(entry.feature),
    error: entry.error ? String(entry.error).slice(0, 500) : null,
    timestamp: entry.timestamp || nowIso,
  });
  state.failures = failuresPastHour(state.failures, nowMs);

  let masterDisabled = false;
  if (!state.tripped && state.failures.length >= max) {
    state.tripped = true;
    state.trippedAt = nowIso;
    state.cooldownUntil = new Date(nowMs + cooldownHours * ONE_HOUR_MS).toISOString();
    masterDisabled = setMasterEnabled(false, opts.pluginRoot);
    process.stderr.write(
      `[artibot:kill-switch-tripped feature=${entry.feature} failures=${state.failures.length}]\n`,
    );
  }

  try { atomicWriteJson(filePath, state); } catch { /* ignore */ }

  return {
    tripped: state.tripped,
    failuresPast1h: state.failures.length,
    cooldownUntil: state.cooldownUntil,
    masterDisabled,
  };
}

// ---------------------------------------------------------------------------
// Internal exports for tests
// ---------------------------------------------------------------------------

export const _internals = {
  resolveStatePath,
  resolveEmergencyStatePath,
  resolveConfigJsonPath,
  failuresPastHour,
  ONE_HOUR_MS,
};
