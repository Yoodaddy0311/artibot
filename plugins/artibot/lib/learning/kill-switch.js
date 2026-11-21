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
 *   - Read/write failures never throw to callers. A failure row that did not
 *     reach disk is reported, not hidden: `persisted: false` on the result
 *     (and on `result.emergency`), plus one stderr line.
 *   - Every read-modify-write of a state file runs under
 *     `lib/core/file-lock.js#withFileLock` (see {@link lockedUpdate}).
 *     Unlocked, N processes recording at once lost rows — measured 2026-11-21
 *     with 12 real processes: 4-8 of 12 kept (v1), 5-11 of 12 (emergency) —
 *     which could keep a real burst of failures under the trip threshold.
 *
 * @module lib/learning/kill-switch
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { atomicWriteJsonSync, readJsonFile } from '../core/file.js';
import { withFileLock } from '../core/file-lock.js';
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
  return normalizeState(await readJsonFile(filePath));
}

/**
 * Read and parse a state file for {@link lockedUpdate}. Never throws.
 *
 * What a read may conclude is an allowlist: ENOENT (no file yet) and content
 * that does not parse both yield `raw: null` — the caller's defaults, which a
 * write may replace, as before. EVERY other read error (EBUSY while another
 * process renames over the file on Windows, EACCES, EMFILE, …) comes back as
 * `readError`, never as "missing": read as missing, it let the next write put
 * defaults over the real state (review xcB 2026-11-21: a tripped feature was
 * un-tripped and the result said `persisted: true`).
 *
 * @param {string} filePath
 * @returns {{ raw: unknown, readError: NodeJS.ErrnoException|null }}
 */
function readStateFile(filePath) {
  let text;
  try {
    text = readFileSync(filePath, 'utf-8');
  } catch (err) {
    return { raw: null, readError: err?.code === 'ENOENT' ? null : err };
  }
  try { return { raw: JSON.parse(text), readError: null }; } catch { return { raw: null, readError: null }; }
}

/**
 * Synchronous {@link loadState}, for use inside a lock. Never throws.
 * @param {string} filePath
 * @returns {{ state: {features: object}, readError: NodeJS.ErrnoException|null }}
 */
function loadStateSync(filePath) {
  const { raw, readError } = readStateFile(filePath);
  return { state: normalizeState(raw), readError };
}

/**
 * @param {unknown} raw - parsed file content, or null
 * @returns {{features: object}}
 */
function normalizeState(raw) {
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

/** @returns {{failures: Array, tripped: boolean, trippedAt: string|null, cooldownUntil: string|null}} */
function emptyEmergencyState() {
  return { failures: [], tripped: false, trippedAt: null, cooldownUntil: null };
}

/**
 * Read emergency state, defaulting on a missing/corrupt file; any other read
 * error is returned as `readError` (see {@link readStateFile}). Never throws.
 * @param {string} filePath
 * @returns {{ state: {failures: Array, tripped: boolean, trippedAt: string|null, cooldownUntil: string|null}, readError: NodeJS.ErrnoException|null }}
 */
function readEmergencyState(filePath) {
  const { raw, readError } = readStateFile(filePath);
  if (!raw || typeof raw !== 'object') return { state: emptyEmergencyState(), readError };
  return {
    state: {
      failures: Array.isArray(raw.failures) ? raw.failures : [],
      tripped: Boolean(raw.tripped),
      trippedAt: typeof raw.trippedAt === 'string' ? raw.trippedAt : null,
      cooldownUntil: typeof raw.cooldownUntil === 'string' ? raw.cooldownUntil : null,
    },
    readError,
  };
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
    atomicWriteJsonSync(cfgPath, cfg);
    return true;
  } catch (err) {
    process.stderr.write(`[artibot:kill-switch] config write failed: ${err.message}\n`);
    return false;
  }
}

/**
 * One locked read-modify-write of a state file: re-read under the lock, let
 * `mutate` change the fresh copy in place, write it atomically.
 *
 * Never throws for I/O. When the lock cannot be taken (ELOCKTIMEOUT after its
 * 2s wait, or a create error such as an unwritable directory) `mutate` still
 * runs on an unlocked read so the caller gets a real answer, but nothing is
 * written — an unlocked write is the lost update this exists to prevent — and
 * the result says `persisted: false`. The same holds when the re-read under
 * the lock fails for any reason other than a missing or unparseable file:
 * `mutate` runs on the defaults `read` returned and nothing is written, so a
 * transient read error can never put defaults over the real state. An error
 * thrown by `mutate` itself is not an I/O failure and propagates.
 *
 * @template T
 * @param {string} filePath
 * @param {(filePath: string) => { state: object, readError: Error|null }} read - never-throwing loader
 * @param {(state: object) => T} mutate
 * @returns {{ value: T, persisted: boolean }}
 */
function lockedUpdate(filePath, read, mutate) {
  let entered = false;
  try {
    return withFileLock(filePath, () => {
      entered = true;
      const { state, readError } = read(filePath);
      const value = mutate(state);
      if (readError) {
        process.stderr.write(`[artibot:kill-switch] state re-read failed for ${filePath} (${readError.code ?? 'error'}); left as is, not persisted\n`);
        return { value, persisted: false };
      }
      try {
        atomicWriteJsonSync(filePath, state);
        return { value, persisted: true };
      } catch (err) {
        process.stderr.write(`[artibot:kill-switch] state write failed for ${filePath}: ${err?.code ?? ''} ${err?.message ?? err}\n`);
        return { value, persisted: false };
      }
    });
  } catch (err) {
    if (entered) throw err;
    process.stderr.write(`[artibot:kill-switch] state lock not taken for ${filePath} (${err?.code ?? 'error'}); not persisted\n`);
    return { value: mutate(read(filePath).state), persisted: false };
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
 * @returns {Promise<{tripped: boolean, count: number, persisted?: boolean, emergency?: {tripped: boolean, failuresPast1h: number, cooldownUntil: string|null, masterDisabled: boolean, persisted: boolean}}>}
 *   `persisted` is false when the per-feature row did not reach disk (lock not
 *   taken, or the write failed); `tripped`/`count` then describe the unsaved
 *   state. Absent on the early return for an unusable feature name.
 */
export async function recordFailure(entry, config, opts = {}) {
  const feature = typeof entry?.feature === 'string' ? entry.feature : null;
  if (!feature || FORBIDDEN_KEYS.has(feature)) return { tripped: false, count: 0 };
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const { threshold, windowMs } = resolveKsOptions(config);
  const filePath = resolveStatePath(config, opts.pluginRoot);

  // v1 per-feature update, re-read under the lock.
  const { value: v1, persisted } = lockedUpdate(filePath, loadStateSync, (state) => {
    const prev = state.features[feature] || { failures: [], trippedAt: null };
    const cutoff = now - windowMs;
    const recent = prev.failures.filter((f) => Number.isFinite(f?.at) && f.at >= cutoff);
    recent.push({ at: now, error: String(entry.error || '').slice(0, 500) });
    const tripped = recent.length >= threshold;
    state.features[feature] = {
      failures: recent,
      trippedAt: tripped ? (prev.trippedAt || new Date(now).toISOString()) : prev.trippedAt,
    };
    return { tripped: Boolean(state.features[feature].trippedAt), count: recent.length };
  });

  // Emergency global branch (opt-in via config)
  let emergency;
  if (emergencyEnabled(config)) {
    emergency = await recordEmergencyFailure(entry, config, { ...opts, now });
  }

  return {
    tripped: v1.tripped,
    count: v1.count,
    persisted,
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
 * Both state files are written under their locks ({@link lockedUpdate}), so a
 * `recordFailure` in flight cannot write its pre-reset read back over the
 * reset. A global reset writes whole and does not read the files, so a read
 * error never blocks it; a lock not taken or a failed write does.
 *
 * @param {string|object} [featureOrConfig]
 * @param {object} [maybeConfig]
 * @param {{pluginRoot?: string}} [opts]
 * @returns {Promise<{reset: boolean, persisted?: boolean, masterRestored?: boolean}>}
 *   `reset` is false only when there was nothing to reset (unknown or
 *   forbidden feature). `persisted` says whether the reset reached disk — for
 *   the global form, BOTH files. `masterRestored` is attempted only when the
 *   emergency state was actually cleared: re-enabling the master switch over
 *   a still-tripped state on disk would leave the two disagreeing.
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
    // Locked so a failure another process records meanwhile for a DIFFERENT
    // feature is not erased by this write.
    const { persisted } = lockedUpdate(filePath, loadStateSync, (fresh) => {
      fresh.features[feature] = { failures: [], trippedAt: null };
    });
    return { reset: true, persisted };
  }

  // Object or undefined → emergency + global reset
  const config = featureOrConfig;
  const emergencyPath = resolveEmergencyStatePath(config, opts.pluginRoot);
  const emergency = lockedUpdate(
    emergencyPath,
    () => ({ state: emptyEmergencyState(), readError: null }),
    () => undefined,
  );

  // Also clear v1 state
  const v1Path = resolveStatePath(config, opts.pluginRoot);
  const v1 = lockedUpdate(
    v1Path,
    () => ({ state: { features: Object.create(null) }, readError: null }),
    () => undefined,
  );

  const masterRestored = emergency.persisted ? setMasterEnabled(true, opts.pluginRoot) : false;
  return { reset: true, masterRestored, persisted: emergency.persisted && v1.persisted };
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
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();

  // Unlocked first look; the common case (nothing expired) never takes the lock.
  const { state: peek } = readEmergencyState(filePath);
  if (!applyExpiry(peek, now)) return snapshotOf(peek);

  // Something expired: redo it on a fresh read under the lock, so a failure
  // another process appended since the peek is not pruned away by this write.
  const { value } = lockedUpdate(filePath, readEmergencyState, (state) => {
    applyExpiry(state, now);
    return snapshotOf(state);
  });
  return value;
}

/**
 * Apply cooldown expiry and the rolling-hour prune to `state` in place.
 * @param {{failures: Array, tripped: boolean, trippedAt: string|null, cooldownUntil: string|null}} state
 * @param {number} now
 * @returns {boolean} true when anything changed
 */
function applyExpiry(state, now) {
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
  return changed;
}

/**
 * @param {{failures: Array, tripped: boolean, cooldownUntil: string|null}} state
 * @returns {{tripped: boolean, failuresPast1h: number, cooldownUntil: string|null}}
 */
function snapshotOf(state) {
  return {
    tripped: state.tripped,
    failuresPast1h: state.failures.length,
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
 * The append and the threshold check run on a fresh read under the state
 * file's lock ({@link lockedUpdate}), so concurrent failures all count. When
 * the lock is not taken the trip decision is still made (on an unlocked read)
 * — failing toward a disabled master switch is the safe side — but the row is
 * not written and `persisted` is false.
 *
 * @param {{feature: string, error?: string, timestamp?: string}} entry
 * @param {object} [config]
 * @param {{pluginRoot?: string, now?: number}} [opts]
 * @returns {Promise<{tripped: boolean, failuresPast1h: number, cooldownUntil: string|null, masterDisabled: boolean, persisted: boolean}>}
 */
async function recordEmergencyFailure(entry, config, opts = {}) {
  const filePath = resolveEmergencyStatePath(config, opts.pluginRoot);
  const max = emergencyMax(config);
  const cooldownHours = emergencyCooldownHours(config);
  const nowMs = Number.isFinite(opts.now) ? opts.now : Date.now();
  const nowIso = new Date(nowMs).toISOString();

  const { value, persisted } = lockedUpdate(filePath, readEmergencyState, (state) => {
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
    return { ...snapshotOf(state), masterDisabled };
  });

  return { ...value, persisted };
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
