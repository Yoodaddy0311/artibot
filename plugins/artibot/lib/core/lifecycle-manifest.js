/**
 * Lifecycle manifest loader.
 *
 * Loads `plugins/artibot/lifecycle.json` and provides lookup helpers for
 * lifecycle-phase-to-agent routing. Caches the parsed manifest in-memory
 * and invalidates the cache on file mtime change.
 *
 * Phase 2 WS-A.1 — Lifecycle Manifest foundation.
 *
 * @module lib/core/lifecycle-manifest
 */

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { getPluginRoot } from './platform.js';

/** @type {{ data: object, mtimeMs: number, path: string } | null} */
let cache = null;

function manifestPath() {
  return path.join(getPluginRoot(), 'lifecycle.json');
}

/**
 * Load the lifecycle manifest, using an in-memory cache invalidated by mtime.
 *
 * @returns {Promise<object>} Parsed manifest with `version`, `lifecycles`.
 */
export async function loadLifecycles() {
  const file = manifestPath();
  const stats = await stat(file);
  if (cache && cache.path === file && cache.mtimeMs === stats.mtimeMs) {
    return cache.data;
  }
  const raw = await readFile(file, 'utf-8');
  const data = JSON.parse(raw);
  cache = { data, mtimeMs: stats.mtimeMs, path: file };
  return data;
}

/**
 * Retrieve a single lifecycle entry by id.
 *
 * @param {string} id - Lifecycle key (e.g., "build", "verify").
 * @returns {Promise<object|null>} Lifecycle object or null when absent.
 */
export async function getLifecycle(id) {
  const manifest = await loadLifecycles();
  const entry = manifest.lifecycles?.[id];
  return entry ? { ...entry } : null;
}

/**
 * List all lifecycle ids declared in the manifest.
 *
 * @returns {Promise<string[]>} Lifecycle keys in declaration order.
 */
export async function listLifecycles() {
  const manifest = await loadLifecycles();
  return Object.keys(manifest.lifecycles || {});
}

/**
 * Get the candidate agent list for a lifecycle (immutable copy).
 *
 * @param {string} id - Lifecycle key.
 * @returns {Promise<string[]>} Candidate agent names, empty array if unknown.
 */
export async function getCandidatesForLifecycle(id) {
  const manifest = await loadLifecycles();
  const entry = manifest.lifecycles?.[id];
  return Array.isArray(entry?.candidates) ? [...entry.candidates] : [];
}

/**
 * Match free-form text to the best-fitting lifecycle by counting
 * substring hits across each lifecycle's `context_matchers`. Returns
 * the first lifecycle (declaration order) with the highest non-zero score.
 *
 * @param {string} text - Free-form input text.
 * @returns {Promise<{ lifecycle: string, score: number } | null>}
 */
export async function matchContextToLifecycle(text) {
  const lowered = String(text || '').toLowerCase();
  if (!lowered) return null;
  const manifest = await loadLifecycles();
  const entries = Object.entries(manifest.lifecycles || {});
  let best = null;
  for (const [id, entry] of entries) {
    const matchers = Array.isArray(entry?.context_matchers) ? entry.context_matchers : [];
    let score = 0;
    for (const m of matchers) {
      if (m && lowered.includes(String(m).toLowerCase())) score += 1;
    }
    if (score > 0 && (best === null || score > best.score)) {
      best = { lifecycle: id, score };
    }
  }
  return best;
}

/**
 * Reset the in-memory cache. Mainly for tests.
 */
export function _resetLifecycleCache() {
  cache = null;
}
