/**
 * Safe-default reader for the `learning.grpoRouting.effortPolicy` config block
 * and its on-disk learned overlay (P3 — GRPO-tuned adaptive effort/budget).
 *
 * The effort-resolver + task-budget hot paths must NEVER fail when the block,
 * the policy file, or the overlay is missing, partial, malformed, or carries a
 * version we don't recognise. Every code path here degrades to the IDENTITY
 * overlay (`enabled: false`, empty maps), which is a guaranteed zero-behaviour-
 * change no-op. Both the config block and the resolved overlay memoize for 60s.
 *
 * This module is a direct structural mirror of
 * {@link module:lib/cognitive/grpo-routing-config}: frozen defaults with
 * `enabled: false`, 60s memo, never-throws `normalize*`, synchronous
 * `getCached*` peeks, and a `__setCachedConfigForTests` injection seam.
 *
 * Overlay file shape (on disk, `effort-policy-v1.json`):
 * ```
 * {
 *   "version": 1,
 *   "bandShifts": { "implement": 1, "review": -1, ... },   // command -> int [-1,+1]
 *   "budgetMultipliers": { "xhigh": 1.2, "high": 0.8, ... } // band -> [0.5, 1.5]
 * }
 * ```
 *
 * Layer: L4 cognitive. Imports L1 core only (config / file / platform). The
 * trainer (L3) writes the file; this reader (L4) only reads — no import cycle.
 *
 * @module lib/cognitive/effort-policy-config
 */

import path from 'node:path';
import { loadConfig } from '../core/config.js';
import { readJsonFile } from '../core/file.js';
import { getHomeDir } from '../core/platform.js';

/** Effort ladder bands (low..max). Mirrors EFFORT_BANDS in effort-resolver. */
export const EFFORT_BANDS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);

/** On-disk overlay schema version this reader understands. */
const OVERLAY_VERSION = 1;

/** Default block — used when `artibot.config.json` is missing the section. */
export const EFFORT_POLICY_DEFAULTS = Object.freeze({
  enabled: false,
  policyPath: '~/.claude/artibot/policies/effort-policy-v1.json',
  coldStartEpisodes: 150,
  bandShiftClamp: 1,
  budgetMultiplierClamp: Object.freeze({ min: 0.5, max: 1.5 }),
  deltaL1Cap: 1.5,
  snapshotCount: 3,
});

/** Identity overlay — guaranteed zero-behaviour-change no-op. */
export const IDENTITY_OVERLAY = Object.freeze({
  enabled: false,
  bandShifts: Object.freeze({}),
  budgetMultipliers: Object.freeze({}),
});

const CONFIG_TTL_MS = 60_000;

/** @type {{ loadedAt: number, value: object }|null} */
let _configCache = null;
/** @type {{ loadedAt: number, value: object }|null} */
let _overlayCache = null;

// ---------------------------------------------------------------------------
// Cache control / test seams
// ---------------------------------------------------------------------------

/**
 * Reset both in-memory caches. For test isolation.
 * @returns {void}
 */
export function resetEffortPolicyConfigCache() {
  _configCache = null;
  _overlayCache = null;
}

/**
 * Inject a raw config fragment into the config memo for deterministic tests.
 * The value is normalized + frozen; TTL is set to now. NEVER call in production.
 *
 * @param {object|undefined} rawFragment - Raw `effortPolicy` shape.
 * @returns {object} the normalized value now in the cache
 */
export function __setCachedConfigForTests(rawFragment) {
  const value = normalizeConfig(rawFragment);
  _configCache = { loadedAt: Date.now(), value };
  return value;
}

// ---------------------------------------------------------------------------
// Coercion helpers (never throw)
// ---------------------------------------------------------------------------

/**
 * Coerce to a finite number inside [min, max]; fallback on failure.
 * @param {unknown} value @param {number} min @param {number} max @param {number} fallback
 * @returns {number}
 */
function numberIn(value, min, max, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/**
 * Coerce to a non-negative integer; fallback on failure.
 * @param {unknown} value @param {number} fallback
 * @returns {number}
 */
function nonNegInt(value, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const n = Math.floor(value);
  return n >= 0 ? n : fallback;
}

/**
 * Normalize a raw `effortPolicy` config fragment into the frozen config shape.
 * Any field that fails validation is replaced by its default, never crashing.
 * @param {object|undefined} raw
 * @returns {object}
 */
function normalizeConfig(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const clamp = r.budgetMultiplierClamp && typeof r.budgetMultiplierClamp === 'object'
    ? r.budgetMultiplierClamp : {};
  return Object.freeze({
    enabled: r.enabled === true,
    policyPath: typeof r.policyPath === 'string' && r.policyPath.length > 0
      ? r.policyPath
      : EFFORT_POLICY_DEFAULTS.policyPath,
    coldStartEpisodes: nonNegInt(r.coldStartEpisodes, EFFORT_POLICY_DEFAULTS.coldStartEpisodes),
    bandShiftClamp: Math.max(0, nonNegInt(r.bandShiftClamp, EFFORT_POLICY_DEFAULTS.bandShiftClamp)),
    budgetMultiplierClamp: Object.freeze({
      min: numberIn(clamp.min, 0.1, 1, EFFORT_POLICY_DEFAULTS.budgetMultiplierClamp.min),
      max: numberIn(clamp.max, 1, 5, EFFORT_POLICY_DEFAULTS.budgetMultiplierClamp.max),
    }),
    deltaL1Cap: numberIn(r.deltaL1Cap, 0, 10, EFFORT_POLICY_DEFAULTS.deltaL1Cap),
    snapshotCount: Math.max(1, nonNegInt(r.snapshotCount, EFFORT_POLICY_DEFAULTS.snapshotCount)),
  });
}

/**
 * Normalize a raw on-disk overlay into the frozen overlay shape. bandShifts are
 * clamped to integer [-1, +1]; budgetMultipliers to [0.5, 1.5] and only for
 * known EFFORT_BANDS. Any malformed input yields the identity overlay.
 * @param {object|undefined} raw
 * @returns {object}
 */
function normalizeOverlay(raw) {
  if (!raw || typeof raw !== 'object' || raw.version !== OVERLAY_VERSION) {
    return IDENTITY_OVERLAY;
  }
  const bandShifts = {};
  const srcShifts = raw.bandShifts && typeof raw.bandShifts === 'object' ? raw.bandShifts : {};
  for (const [cmd, v] of Object.entries(srcShifts)) {
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    const i = Math.round(v);
    bandShifts[cmd] = Math.max(-1, Math.min(1, i));
  }
  const budgetMultipliers = {};
  const srcMult = raw.budgetMultipliers && typeof raw.budgetMultipliers === 'object'
    ? raw.budgetMultipliers : {};
  for (const [band, v] of Object.entries(srcMult)) {
    if (!EFFORT_BANDS.includes(band)) continue;
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    budgetMultipliers[band] = Math.max(0.5, Math.min(1.5, v));
  }
  return Object.freeze({
    enabled: true,
    bandShifts: Object.freeze(bandShifts),
    budgetMultipliers: Object.freeze(budgetMultipliers),
  });
}

/**
 * Expand a leading `~` in a policy path to the user home directory.
 * @param {string} p
 * @returns {string}
 */
function expandHome(p) {
  if (typeof p !== 'string' || p.length === 0) return p;
  if (p === '~') return getHomeDir();
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(getHomeDir(), p.slice(2));
  }
  return p;
}

// ---------------------------------------------------------------------------
// Config reader
// ---------------------------------------------------------------------------

/**
 * Read, memoize, and safe-default the `learning.grpoRouting.effortPolicy` block.
 * Never throws — on any IO/JSON error returns {@link EFFORT_POLICY_DEFAULTS}
 * frozen-normalized. Cached 60s; pass `{ force: true }` to bypass the TTL.
 *
 * @param {{ force?: boolean }} [options]
 * @returns {Promise<object>}
 */
export async function getEffortPolicyConfig(options = {}) {
  const now = Date.now();
  if (!options.force && _configCache && now - _configCache.loadedAt < CONFIG_TTL_MS) {
    return _configCache.value;
  }
  let raw;
  try {
    const config = await loadConfig(Boolean(options.force));
    raw = config?.learning?.grpoRouting?.effortPolicy;
  } catch {
    raw = undefined;
  }
  const value = normalizeConfig(raw);
  _configCache = { loadedAt: now, value };
  return value;
}

/**
 * Synchronous peek at the last resolved config. When the memo is cold or the
 * TTL has expired, returns {@link EFFORT_POLICY_DEFAULTS} — crucially with
 * `enabled: false`, so callers default to identity behaviour when cold.
 * @returns {object}
 */
export function getCachedEffortPolicyConfig() {
  const now = Date.now();
  if (_configCache && now - _configCache.loadedAt < CONFIG_TTL_MS) {
    return _configCache.value;
  }
  return normalizeConfig(undefined);
}

// ---------------------------------------------------------------------------
// Overlay reader
// ---------------------------------------------------------------------------

/**
 * Read, memoize, and safe-default the learned effort/budget overlay.
 *
 * When the config block is `disabled`, the policy file is missing/corrupt, or
 * its `version !== 1`, this returns {@link IDENTITY_OVERLAY} — a guaranteed
 * zero-behaviour-change no-op. Cached 60s; `{ force: true }` bypasses the TTL.
 *
 * @param {{ force?: boolean }} [options]
 * @returns {Promise<object>}
 */
export async function getEffortPolicyOverlay(options = {}) {
  const now = Date.now();
  if (!options.force && _overlayCache && now - _overlayCache.loadedAt < CONFIG_TTL_MS) {
    return _overlayCache.value;
  }

  let value = IDENTITY_OVERLAY;
  try {
    const cfg = await getEffortPolicyConfig({ force: Boolean(options.force) });
    if (cfg.enabled) {
      const file = expandHome(cfg.policyPath);
      const raw = await readJsonFile(file);
      value = normalizeOverlay(raw);
    }
  } catch {
    value = IDENTITY_OVERLAY;
  }

  _overlayCache = { loadedAt: now, value };
  return value;
}

/**
 * Synchronous peek at the last resolved overlay. When the memo is cold or the
 * TTL has expired, returns {@link IDENTITY_OVERLAY}, so the effort-resolver /
 * task-budget hot paths take the zero-cost identity branch when not warmed.
 * @returns {object}
 */
export function getCachedEffortPolicyOverlay() {
  const now = Date.now();
  if (_overlayCache && now - _overlayCache.loadedAt < CONFIG_TTL_MS) {
    return _overlayCache.value;
  }
  return IDENTITY_OVERLAY;
}
