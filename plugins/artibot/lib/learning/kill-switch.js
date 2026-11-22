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

import { atomicWriteJsonSync, readTextAllowMissing } from '../core/file.js';
import { withFileLock } from '../core/file-lock.js';
import { getPluginRoot } from '../core/platform.js';
import { emergencyBannerLine, featureBannerLine } from './kill-switch-banner.js';

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
 * Read and parse a state file; never throws. EVERY read in this module goes through here (checks and
 * locked re-reads). Allowlist (`core/file.js#readTextAllowMissing`): ENOENT or unparseable content is
 * `raw: null` — defaults a write may replace, "not tripped" to a check. ANY other error (EBUSY while a
 * rename lands on Windows, EACCES, EMFILE, …) is `readError`, never "missing": as missing it let a write
 * put defaults over real state (xcB 2026-11-21: a trip undone, `persisted: true`) and a check answer
 * "not tripped" for a file it never saw (owner decision 2026-11-22 — {@link unreadableMeansTripped}).
 * @param {string} filePath
 * @returns {{ raw: unknown, readError: NodeJS.ErrnoException|null }}
 */
function readStateFile(filePath) {
  let text;
  try {
    text = readTextAllowMissing(filePath);
  } catch (err) {
    return { raw: null, readError: err };
  }
  if (text === null) return { raw: null, readError: null };
  try { return { raw: JSON.parse(text), readError: null }; } catch { return { raw: null, readError: null }; }
}

/**
 * Load per-feature state in its valid shape, plus the read error if the file
 * exists but could not be read (see {@link readStateFile}). Never throws.
 * @param {string} filePath
 * @returns {{ state: {features: object}, readError: NodeJS.ErrnoException|null }}
 */
function loadStateSync(filePath) {
  const { raw, readError } = readStateFile(filePath);
  return { state: normalizeState(raw), readError };
}

/**
 * Fail-closed answer of a CHECK whose state file exists but could not be read: tripped, one stderr
 * line ("not tripped" is the unsafe guess). Writes differ: {@link lockedUpdate} writes nothing.
 * @param {string} filePath
 * @param {NodeJS.ErrnoException} readError
 * @returns {true}
 */
function unreadableMeansTripped(filePath, readError) {
  process.stderr.write(`[artibot:kill-switch] state unreadable at ${filePath} (${readError?.code ?? 'error'}); treated as tripped (fail-closed)\n`);
  return true;
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
 * `masterDisabled` (whether the trip's master-switch write landed, see
 * {@link recordEmergencyFailure}) is carried only when the file holds a boolean.
 * @param {string} filePath
 * @returns {{ state: {failures: Array, tripped: boolean, trippedAt: string|null, cooldownUntil: string|null, masterDisabled?: boolean}, readError: NodeJS.ErrnoException|null }}
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
      ...(typeof raw.masterDisabled === 'boolean' ? { masterDisabled: raw.masterDisabled } : {}),
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
 * Read artibot.config.json, set `ago.selfControl.masterEnabled`, write it
 * atomically. Throws on any read, parse or write error.
 * @param {string} cfgPath
 * @param {boolean} enabled
 */
function writeMasterEnabled(cfgPath, enabled) {
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
  cfg.ago = cfg.ago || {};
  cfg.ago.selfControl = cfg.ago.selfControl || {};
  cfg.ago.selfControl.masterEnabled = Boolean(enabled);
  atomicWriteJsonSync(cfgPath, cfg);
}

/**
 * Flip `ago.selfControl.masterEnabled` in artibot.config.json: re-read and atomic write under the config
 * file's lock, like every state write here ({@link lockedUpdate}). Never throws. Lock not taken:
 * re-enabling writes nothing (false); disabling (the trip) still writes, unlocked — the safe side, and
 * the production gate passes `feature`, so this switch is the emergency trip's only effect. The lock
 * orders only writers that take it; `macro-learner.js` and `scripts/swarm-init.js` take none.
 *
 * @param {boolean} enabled
 * @param {string} [pluginRoot]
 * @returns {boolean} true when the value was written
 */
function setMasterEnabled(enabled, pluginRoot) {
  const cfgPath = resolveConfigJsonPath(pluginRoot);
  let entered = false;
  try {
    withFileLock(cfgPath, () => {
      entered = true;
      writeMasterEnabled(cfgPath, enabled);
    });
    return true;
  } catch (err) {
    if (entered) return configWriteFailed(err);
    const action = enabled ? 'left as is' : 'disabling unlocked (the safe side)';
    process.stderr.write(`[artibot:kill-switch] config lock not taken for ${cfgPath} (${err?.code ?? 'error'}); masterEnabled ${action}\n`);
    if (enabled) return false;
    try {
      writeMasterEnabled(cfgPath, false);
      return true;
    } catch (writeErr) {
      return configWriteFailed(writeErr);
    }
  }
}

/**
 * @param {unknown} err
 * @returns {false}
 */
function configWriteFailed(err) {
  process.stderr.write(`[artibot:kill-switch] config write failed: ${err?.message ?? err}\n`);
  return false;
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
 * Fail-closed: a state file that exists but cannot be read (any error but
 * ENOENT — {@link readStateFile}) answers true, in both calling conventions;
 * a missing or unparseable file is still "nothing tripped".
 *
 * @param {object} [config]
 * @param {{pluginRoot?: string, feature?: string, now?: number}} [opts]
 * @returns {Promise<boolean>}
 */
export async function isKillSwitchTripped(config, opts = {}) {
  const feature = typeof opts.feature === 'string' ? opts.feature : null;
  const filePath = resolveStatePath(config, opts.pluginRoot);
  const { state, readError } = loadStateSync(filePath);
  if (readError) return unreadableMeansTripped(filePath, readError);

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
 *   emergency state was actually cleared, and inside the same lock
 *   ({@link resetEmergencyAndMaster}): re-enabling the master switch over a
 *   still-tripped state on disk would leave the two disagreeing.
 */
export async function resetKillSwitch(featureOrConfig, maybeConfig, opts = {}) {
  // Detect calling convention
  if (typeof featureOrConfig === 'string') {
    return resetFeature(featureOrConfig, resolveStatePath(maybeConfig, opts.pluginRoot));
  }

  // Object or undefined → emergency + global reset
  const config = featureOrConfig;
  const emergency = resetEmergencyAndMaster(resolveEmergencyStatePath(config, opts.pluginRoot), opts.pluginRoot);

  // Also clear v1 state
  const v1Path = resolveStatePath(config, opts.pluginRoot);
  const v1 = lockedUpdate(
    v1Path,
    () => ({ state: { features: Object.create(null) }, readError: null }),
    () => undefined,
  );

  return { reset: true, masterRestored: emergency.masterRestored, persisted: emergency.persisted && v1.persisted };
}

/**
 * The per-feature form of {@link resetKillSwitch}. "Nothing to reset" (`reset: false`) only after a read
 * SHOWED the feature absent — the pre-check, or the locked re-read when the pre-check could not read
 * (else an empty entry was created and `reset: true` answered — lane D 2026-11-22). Re-read failed too:
 * nothing is known, `reset: true, persisted: false`, as before.
 * @param {string} feature
 * @param {string} filePath - the per-feature state file
 * @returns {{reset: boolean, persisted?: boolean}}
 */
function resetFeature(feature, filePath) {
  if (FORBIDDEN_KEYS.has(feature)) return { reset: false };
  const { state, readError } = loadStateSync(filePath);
  if (!readError && !state.features[feature]) return { reset: false };
  let lockedReadFailed = false;
  const read = (p) => {
    const r = loadStateSync(p);
    lockedReadFailed = Boolean(r.readError);
    return r;
  };
  // Locked so a failure another process records meanwhile for a DIFFERENT
  // feature is not erased by this write.
  const { value: existed, persisted } = lockedUpdate(filePath, read, (fresh) => {
    if (!fresh.features[feature]) return false;
    fresh.features[feature] = { failures: [], trippedAt: null };
    return true;
  });
  if (!existed && !lockedReadFailed) return { reset: false };
  return { reset: true, persisted };
}

/**
 * Clear the emergency state and re-enable the master switch as ONE critical section under the emergency
 * lock; a trip ({@link recordEmergencyFailure}) flips the master inside that same lock, so the pairs
 * serialize (reset-then-trip: tripped + off; trip-then-reset: clear + on). Restoring after the lock was
 * released let a trip land in between and be undone (reproduced 3/3, kill-switch-reset-race.test.js).
 * Lock order emergency → config, as the trip's: no deadlock. Restores only when the clear reached disk.
 * @param {string} filePath - the emergency state file
 * @param {string} [pluginRoot]
 * @returns {{ persisted: boolean, masterRestored: boolean }}
 */
function resetEmergencyAndMaster(filePath, pluginRoot) {
  try {
    return withFileLock(filePath, () => {
      try {
        atomicWriteJsonSync(filePath, emptyEmergencyState());
      } catch (err) {
        process.stderr.write(`[artibot:kill-switch] state write failed for ${filePath}: ${err?.code ?? ''} ${err?.message ?? err}\n`);
        return { persisted: false, masterRestored: false };
      }
      return { persisted: true, masterRestored: setMasterEnabled(true, pluginRoot) };
    });
  } catch (err) {
    process.stderr.write(`[artibot:kill-switch] state lock not taken for ${filePath} (${err?.code ?? 'error'}); not persisted\n`);
    return { persisted: false, masterRestored: false };
  }
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
 * Fail-closed: when the state file exists but cannot be read — on the peek or
 * on the re-read under the lock — the answer is `tripped: true` with
 * `failuresPast1h: null` (unknown, not zero), `statePath` (the file that could
 * not be read, for a caller to name) and one stderr line
 * ({@link unreadableMeansTripped}); the file is left as is. A trip whose
 * master-switch write has not landed carries `masterRetryPending: true`
 * ({@link recordEmergencyFailure} retries it on the next failure).
 *
 * @param {object} [config]
 * @param {{pluginRoot?: string, now?: number}} [opts]
 * @returns {Promise<{tripped: boolean, failuresPast1h: number|null, cooldownUntil: string|null, statePath?: string, masterRetryPending?: true}>}
 */
export async function getKillSwitchState(config, opts = {}) {
  if (!emergencyEnabled(config)) {
    return { tripped: false, failuresPast1h: 0, cooldownUntil: null };
  }
  const filePath = resolveEmergencyStatePath(config, opts.pluginRoot);
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const unreadable = (readError) => ({
    tripped: unreadableMeansTripped(filePath, readError), failuresPast1h: null, cooldownUntil: null, statePath: filePath,
  });

  // Unlocked first look; the common case (nothing expired) never takes the lock.
  const { state: peek, readError } = readEmergencyState(filePath);
  if (readError) return unreadable(readError);
  if (!applyExpiry(peek, now)) return stateSnapshot(peek);

  // Something expired: redo it on a fresh read under the lock, so a failure
  // another process appended since the peek is not pruned away by this write.
  let lockedReadError = null;
  const read = (p) => {
    const r = readEmergencyState(p);
    lockedReadError = r.readError;
    return r;
  };
  const { value } = lockedUpdate(filePath, read, (state) => {
    applyExpiry(state, now);
    return stateSnapshot(state);
  });
  return lockedReadError ? unreadable(lockedReadError) : value;
}

/**
 * {@link snapshotOf} for {@link getKillSwitchState}: plus `masterRetryPending: true`
 * while a trip's master-switch write has not landed (the key is absent otherwise).
 * @param {{failures: Array, tripped: boolean, cooldownUntil: string|null, masterDisabled?: boolean}} state
 * @returns {{tripped: boolean, failuresPast1h: number, cooldownUntil: string|null, masterRetryPending?: true}}
 */
function stateSnapshot(state) {
  return state.tripped && state.masterDisabled === false
    ? { ...snapshotOf(state), masterRetryPending: true }
    : snapshotOf(state);
}

/**
 * The emergency-switch banner line for a {@link getKillSwitchState} result (text and rules:
 * `kill-switch-banner.js#emergencyBannerLine`); this resolves the files it names.
 * @param {{tripped: boolean, failuresPast1h: number|null, statePath?: string, masterRetryPending?: true}} state
 * @param {object} [config] - the loaded artibot config, the one the gate reads
 * @param {{pluginRoot?: string}} [opts]
 * @returns {string|null}
 */
export function describeKillSwitchStatus(state, config, opts = {}) {
  return emergencyBannerLine(state, config, bannerPaths(config, opts.pluginRoot));
}

/**
 * Every SessionStart kill-switch banner line: the emergency switch, then the features that
 * tripped on their own — or the fail-closed line when their state cannot be read
 * (`kill-switch-banner.js`). Never throws for I/O.
 * @param {object} [config]
 * @param {{pluginRoot?: string}} [opts]
 * @returns {Promise<string[]>}
 */
export async function killSwitchBannerLines(config, opts = {}) {
  const paths = bannerPaths(config, opts.pluginRoot);
  const { state, readError } = loadStateSync(paths.featureStatePath);
  const names = readError ? [] : Object.keys(state.features).filter((k) => state.features[k].trippedAt);
  return [
    emergencyBannerLine(await getKillSwitchState(config, { pluginRoot: opts.pluginRoot }), config, paths),
    featureBannerLine({ names, readError, statePath: paths.featureStatePath }),
  ].filter(Boolean);
}

/** @returns {{configPath: string, featureStatePath: string}} the files the banner's recovery advice names */
function bannerPaths(config, pluginRoot) {
  return { configPath: resolveConfigJsonPath(pluginRoot), featureStatePath: resolveStatePath(config, pluginRoot) };
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
    delete state.masterDisabled; // belongs to the trip that just expired
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
 * The append and the threshold check run on a fresh read under the state
 * file's lock ({@link lockedUpdate}), so concurrent failures all count. When
 * the lock is not taken the trip decision is still made (on an unlocked read)
 * — failing toward a disabled master switch is the safe side — but the row is
 * not written and `persisted` is false.
 *
 * The master switch is the trip's only effect in production (the gate passes
 * `feature`, so it never reads the emergency state), so a trip whose write did
 * not land must not be forgotten: the state records `masterDisabled`, and while
 * it is `false` on a tripped state every later failure retries the write
 * (fail-closed; lane D 2026-11-22: one EBUSY on the config read inside its lock
 * left the trip without effect for its whole cooldown). Once the write has
 * landed nothing re-flips it, and a state without the field (written before it
 * existed) is not retried — unknown is not "failed".
 *
 * @param {{feature: string, error?: string, timestamp?: string}} entry
 * @param {object} [config]
 * @param {{pluginRoot?: string, now?: number}} [opts]
 * @returns {Promise<{tripped: boolean, failuresPast1h: number, cooldownUntil: string|null, masterDisabled: boolean, persisted: boolean}>}
 *   `masterDisabled`: this call disabled the master switch (at the trip, or on a retry).
 */
async function recordEmergencyFailure(entry, config, opts = {}) {
  const filePath = resolveEmergencyStatePath(config, opts.pluginRoot);
  const max = emergencyMax(config);
  const cooldownHours = emergencyCooldownHours(config);
  const nowMs = Number.isFinite(opts.now) ? opts.now : Date.now();
  const nowIso = new Date(nowMs).toISOString();

  const { value, persisted } = lockedUpdate(filePath, readEmergencyState, (state) => {
    settleBeforeFailure(state, nowMs, opts.pluginRoot);
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
      state.masterDisabled = masterDisabled;
      process.stderr.write(
        `[artibot:kill-switch-tripped feature=${entry.feature} failures=${state.failures.length}]\n`,
      );
    } else if (state.tripped && state.masterDisabled === false) {
      masterDisabled = setMasterEnabled(false, opts.pluginRoot);
      state.masterDisabled = masterDisabled;
    }
    return { ...snapshotOf(state), masterDisabled };
  });

  return { ...value, persisted };
}

/**
 * Before a failure is counted: expire a trip whose cooldown has passed (else the
 * retry below would switch the master off with no trip behind it — lane B probe A),
 * then RE-ARM a live trip whose master write had landed but the user turned the
 * master switch back on (the pause banner says how): the state starts over and this
 * failure is its first. Without it the switch was inert for the rest of the cooldown
 * (probe D). "Back on" is read from the config FILE the gate loads, not the caller's
 * object, which can be stale; a file that cannot be read does not re-arm.
 * @param {object} state - emergency state, changed in place
 * @param {number} nowMs
 * @param {string} [pluginRoot]
 */
function settleBeforeFailure(state, nowMs, pluginRoot) {
  applyExpiry(state, nowMs);
  if (!state.tripped || state.masterDisabled !== true || !masterBackOn(pluginRoot)) return;
  Object.assign(state, emptyEmergencyState());
  delete state.masterDisabled;
  process.stderr.write('[artibot:kill-switch] master switch turned back on during a trip; emergency switch re-armed\n');
}

/** @returns {boolean} true only when artibot.config.json was read and its master switch is not off (the gate's rule) */
function masterBackOn(pluginRoot) {
  try {
    const cfg = JSON.parse(readTextAllowMissing(resolveConfigJsonPath(pluginRoot)) ?? 'null');
    return cfg !== null && typeof cfg === 'object' && cfg.ago?.selfControl?.masterEnabled !== false;
  } catch {
    return false;
  }
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
