/**
 * Auto-wire opt-out policy (v4.11.0 Track J).
 *
 * Centralizes the on/off switches for engine auto-wiring features. The engine
 * (or slash command) reads this policy once per session and gates each
 * `wireXxx()` call accordingly. Defaults are "all enabled" — feature flags
 * exist so users on slow disks / restricted CI can disable individual hooks
 * without forking the engine.
 *
 * Resolution chain (later wins):
 *   1. Hard defaults (everything ON)
 *   2. `autopilot.config.json` `autoWire` block (if file exists & readable)
 *   3. `opts.override` (in-memory, per-call wins)
 *
 * DATA POLICY: read-only local disk. No network.
 *
 * Public surface:
 *   - getAutoWirePolicy(opts)
 *   - DEFAULT_AUTOWIRE_POLICY
 *   - AUTOWIRE_KEYS
 *
 * @module lib/autopilot/auto-wire-policy
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** Canonical list of toggleable auto-wire features. */
export const AUTOWIRE_KEYS = Object.freeze([
  'costPredict',
  'smartSkip',
  'autoRollback',
  'autoDrift',
  'autoFlamegraph',
]);

/** Default policy — every auto-wire feature enabled. */
export const DEFAULT_AUTOWIRE_POLICY = Object.freeze({
  costPredict: true,
  smartSkip: true,
  autoRollback: true,
  autoDrift: true,
  autoFlamegraph: true,
});

/**
 * Coerce a value to a strict boolean. Undefined / non-bool returns null so
 * the caller can fall through to the next source in the resolution chain.
 *
 * @param {unknown} v
 * @returns {boolean|null}
 */
function coerceBool(v) {
  if (typeof v === 'boolean') return v;
  return null;
}

/**
 * Read the `autoWire` block out of `autopilot.config.json` if present.
 * Returns an empty object on any failure — config is advisory, never fatal.
 *
 * @param {string} configPath - absolute path to autopilot.config.json
 * @returns {Record<string, unknown>}
 */
function readConfigBlock(configPath) {
  try {
    if (!existsSync(configPath)) return {};
    const raw = readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const block = parsed.autoWire;
    if (!block || typeof block !== 'object') return {};
    return block;
  } catch {
    return {};
  }
}

/**
 * Apply one source of overrides on top of an accumulator. Mutates the
 * accumulator — internal helper only. Only known keys are copied; only
 * boolean values are applied (non-bool entries are dropped silently).
 *
 * @param {Record<string, boolean>} acc
 * @param {Record<string, unknown>} src
 */
function applyOverrides(acc, src) {
  if (!src || typeof src !== 'object') return;
  for (const key of AUTOWIRE_KEYS) {
    const coerced = coerceBool(src[key]);
    if (coerced === null) continue;
    acc[key] = coerced;
  }
}

/**
 * Resolve the effective auto-wire policy for this run.
 *
 * @param {{
 *   configPath?: string,
 *   cwd?: string,
 *   override?: Record<string, boolean>,
 * }} [opts]
 * @returns {Readonly<{
 *   costPredict: boolean,
 *   smartSkip: boolean,
 *   autoRollback: boolean,
 *   autoDrift: boolean,
 *   autoFlamegraph: boolean,
 * }>}
 */
export function getAutoWirePolicy(opts = {}) {
  const acc = { ...DEFAULT_AUTOWIRE_POLICY };
  const cwd = typeof opts.cwd === 'string' && opts.cwd ? opts.cwd : process.cwd();
  const configPath = typeof opts.configPath === 'string' && opts.configPath
    ? opts.configPath
    : path.join(cwd, 'autopilot.config.json');
  applyOverrides(acc, readConfigBlock(configPath));
  applyOverrides(acc, opts.override);
  return Object.freeze(acc);
}
