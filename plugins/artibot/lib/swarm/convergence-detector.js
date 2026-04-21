/**
 * Swarm Convergence Detector (AGO Track G8).
 *
 * Detects patterns that have converged across multiple Artibot instances and
 * applies a confidence boost as a learning signal. This module NEVER mutates
 * skills or auto-promotes them — it only emits a boosted-confidence metadata
 * stream that downstream consumers (learning layer) may optionally consider.
 *
 * DATA POLICY (non-negotiable):
 * - Consumes ONLY outputs from `lib/swarm/collective-hub.js` (no external API)
 * - `instanceHash` values must already be DP-applied by `swarm-client` upstream;
 *   this module additionally rejects obviously non-hash values
 * - Never re-transmits any pattern content outward (read-only fan-in)
 * - Refuses prototype-polluting keys: `__proto__`, `constructor`, `prototype`
 *
 * @module lib/swarm/convergence-detector
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MIN_INSTANCES = 3;
const DEFAULT_CONFIDENCE_BOOST = 0.15;
const DEFAULT_CONFIDENCE_THRESHOLD = 0.7;
const CONFIDENCE_CEILING = 1.0;
const RUNTIME_SUBPATH = 'runtime/converged-patterns.json';
const INSTANCE_HASH_RE = /^[a-f0-9]{32,128}$/i;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// ---------------------------------------------------------------------------
// Typedefs
// ---------------------------------------------------------------------------

/**
 * @typedef {object} Contribution
 * @property {string} instanceHash - DP-applied SHA-256 hash identifying a swarm instance
 * @property {object} pattern - Anonymized pattern object
 * @property {number} confidence - Local confidence (0.0 - 1.0)
 */

/**
 * @typedef {object} ConvergedPattern
 * @property {object} pattern - Anonymized pattern (read-only; content never re-sent)
 * @property {number} originalConfidence - Mean original confidence across contributions
 * @property {number} boostedConfidence - originalConfidence + boost (capped at 1.0)
 * @property {number} instanceCount - Unique instances that agreed
 * @property {string} convergedAt - ISO timestamp when convergence was detected
 */

// ---------------------------------------------------------------------------
// Safety helpers
// ---------------------------------------------------------------------------

/**
 * Reject objects carrying prototype-polluting keys.
 *
 * @param {unknown} obj
 * @returns {boolean} true if safe
 */
function isSafeObject(obj) {
  if (!obj || typeof obj !== 'object') return false;
  for (const key of Object.keys(obj)) {
    if (FORBIDDEN_KEYS.has(key)) return false;
  }
  return true;
}

/**
 * Validate that a contribution looks like swarm-client output.
 *
 * @param {unknown} c
 * @returns {c is Contribution}
 */
function isValidContribution(c) {
  if (!c || typeof c !== 'object') return false;
  const { instanceHash, pattern, confidence } = /** @type {Contribution} */ (c);
  if (typeof instanceHash !== 'string' || !INSTANCE_HASH_RE.test(instanceHash)) return false;
  if (!isSafeObject(pattern)) return false;
  if (typeof confidence !== 'number' || Number.isNaN(confidence)) return false;
  if (confidence < 0 || confidence > 1) return false;
  return true;
}

/**
 * Stable pattern key: prefer `pattern.id`, fall back to a shallow signature.
 *
 * @param {object} pattern
 * @returns {string}
 */
function patternKey(pattern) {
  if (pattern && typeof pattern.id === 'string' && pattern.id.length > 0) {
    return pattern.id;
  }
  const type = typeof pattern?.type === 'string' ? pattern.type : 'unknown';
  const sig = typeof pattern?.signature === 'string' ? pattern.signature : '';
  return `${type}:${sig}`;
}

/**
 * Cap a value to [0, CONFIDENCE_CEILING].
 *
 * @param {number} n
 * @returns {number}
 */
function capConfidence(n) {
  if (Number.isNaN(n)) return 0;
  if (n > CONFIDENCE_CEILING) return CONFIDENCE_CEILING;
  if (n < 0) return 0;
  return n;
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Group valid contributions by stable pattern key, tracking unique instances.
 *
 * @param {Contribution[]} contributions
 * @returns {Map<string, { pattern: object, instances: Set<string>, confidences: number[] }>}
 */
function groupByPattern(contributions) {
  const map = new Map();
  for (const c of contributions) {
    if (!isValidContribution(c)) continue;
    const key = patternKey(c.pattern);
    let entry = map.get(key);
    if (!entry) {
      entry = { pattern: c.pattern, instances: new Set(), confidences: [] };
      map.set(key, entry);
    }
    entry.instances.add(c.instanceHash);
    entry.confidences.push(c.confidence);
  }
  return map;
}

/**
 * Detect patterns that converged across multiple swarm instances.
 * Does NOT mutate skills — returns boosted patterns for downstream consumers.
 *
 * @param {Contribution[]} contributions
 * @param {{minInstances?: number, confidenceBoost?: number, confidenceThreshold?: number}} [options]
 * @returns {Promise<ConvergedPattern[]>}
 */
export async function detectConvergence(contributions, options = {}) {
  if (!Array.isArray(contributions) || contributions.length === 0) return [];

  const minInstances = options.minInstances ?? DEFAULT_MIN_INSTANCES;
  const boost = options.confidenceBoost ?? DEFAULT_CONFIDENCE_BOOST;
  const threshold = options.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;

  const grouped = groupByPattern(contributions);
  const convergedAt = new Date().toISOString();
  const result = [];

  for (const { pattern, instances, confidences } of grouped.values()) {
    if (instances.size < minInstances) continue;
    const mean = confidences.reduce((a, b) => a + b, 0) / confidences.length;
    if (mean < threshold) continue;
    result.push({
      pattern,
      originalConfidence: Math.round(mean * 1000) / 1000,
      boostedConfidence: capConfidence(Math.round((mean + boost) * 1000) / 1000),
      instanceCount: instances.size,
      convergedAt,
    });
  }

  return result;
}

/**
 * Apply convergence boost to a local pattern based on global agreement.
 * Pure/deterministic; no I/O.
 *
 * @param {{id?: string, confidence?: number}} localPattern
 * @param {Array<{pattern: {id?: string}, instanceCount?: number}>} globalSiblings
 * @param {number} [confidenceBoost]
 * @returns {number} new confidence capped at 1.0
 */
export function applyBoost(localPattern, globalSiblings, confidenceBoost = DEFAULT_CONFIDENCE_BOOST) {
  if (!isSafeObject(localPattern)) return 0;
  const base = typeof localPattern.confidence === 'number' ? localPattern.confidence : 0;
  if (!Array.isArray(globalSiblings) || globalSiblings.length === 0) return capConfidence(base);

  const key = patternKey(localPattern);
  const match = globalSiblings.find((s) => isSafeObject(s) && patternKey(s.pattern || {}) === key);
  if (!match) return capConfidence(base);

  return capConfidence(Math.round((base + confidenceBoost) * 1000) / 1000);
}

// ---------------------------------------------------------------------------
// Persistence (read-only re-emission)
// ---------------------------------------------------------------------------

/**
 * Resolve the converged-patterns file path under a plugin root.
 *
 * @param {string} pluginRoot
 * @returns {string}
 */
function resolveStorePath(pluginRoot) {
  return path.join(pluginRoot, RUNTIME_SUBPATH);
}

/**
 * Persist converged patterns to disk (for downstream learning consumers).
 * Writes are local-only; no network.
 *
 * @param {string} pluginRoot
 * @param {ConvergedPattern[]} converged
 * @returns {Promise<string>} absolute path written
 */
export async function persistConvergedPatterns(pluginRoot, converged) {
  const target = resolveStorePath(pluginRoot);
  await mkdir(path.dirname(target), { recursive: true });
  const payload = {
    version: 1,
    generatedAt: new Date().toISOString(),
    patterns: Array.isArray(converged) ? converged : [],
  };
  await writeFile(target, JSON.stringify(payload, null, 2), 'utf8');
  return target;
}

/**
 * Query current convergence state from disk (for downstream learning consumers).
 *
 * @param {string} pluginRoot
 * @returns {Promise<ConvergedPattern[]>}
 */
export async function getConvergedPatterns(pluginRoot) {
  const target = resolveStorePath(pluginRoot);
  try {
    const raw = await readFile(target, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.patterns)) return [];
    return parsed.patterns.filter((p) => isSafeObject(p));
  } catch (err) {
    if (err && /** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return [];
    return [];
  }
}

// ---------------------------------------------------------------------------
// Exports for testing
// ---------------------------------------------------------------------------

export {
  DEFAULT_MIN_INSTANCES as _DEFAULT_MIN_INSTANCES,
  DEFAULT_CONFIDENCE_BOOST as _DEFAULT_CONFIDENCE_BOOST,
  DEFAULT_CONFIDENCE_THRESHOLD as _DEFAULT_CONFIDENCE_THRESHOLD,
  CONFIDENCE_CEILING as _CONFIDENCE_CEILING,
  RUNTIME_SUBPATH as _RUNTIME_SUBPATH,
  FORBIDDEN_KEYS as _FORBIDDEN_KEYS,
  patternKey as _patternKey,
  isValidContribution as _isValidContribution,
  isSafeObject as _isSafeObject,
};
