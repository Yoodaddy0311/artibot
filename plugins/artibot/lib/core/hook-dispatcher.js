/**
 * Hook Dispatcher — Phase 2 WS-C.2
 *
 * Generic dispatcher that runs ordered handlers for a given event slot.
 * This is additive infrastructure — it does NOT replace hooks.json. The real
 * hook scripts remain the source of truth until a feature flag activates
 * this dispatcher in a future sub-phase (WS-C.3, pending user approval).
 *
 * Design guarantees:
 * - Never throws — every error is caught and reported in the result object.
 * - Per-handler timeout isolates slow handlers from the rest of the chain.
 * - Handler errors do NOT abort the chain — each handler is sandboxed.
 * - Korean path safe: uses toFileUrl() for all dynamic imports.
 * - Zero new dependencies.
 *
 * @module lib/core/hook-dispatcher
 */

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { getPluginRoot } from './platform.js';
import { toFileUrl } from '../../scripts/utils/index.js';

const DEFAULT_TIMEOUT_MS = 2000;

let _cache = null;

/**
 * Resolve the absolute path to the dispatch table JSON file.
 * @returns {string}
 */
function getDispatchTablePath() {
  return path.join(getPluginRoot(), 'hooks', 'dispatch-table.json');
}

/**
 * Resolve configured per-handler timeout (ms).
 * @returns {number}
 */
function getTimeoutMs() {
  const raw = process.env.ARTIBOT_HOOK_TIMEOUT_MS;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
}

/**
 * Load the dispatch table with mtime-based cache invalidation.
 * Returns an empty shell (version:1, slots:{}) when the file is missing or malformed.
 * @returns {Promise<object>}
 */
export async function loadDispatchTable() {
  const filePath = getDispatchTablePath();
  let mtimeMs = 0;
  try {
    const st = await stat(filePath);
    mtimeMs = st.mtimeMs;
  } catch {
    return { version: 1, slots: {} };
  }
  if (_cache && _cache.path === filePath && _cache.mtimeMs === mtimeMs) {
    return _cache.data;
  }
  try {
    const raw = await readFile(filePath, 'utf-8');
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || !data.slots) {
      return { version: 1, slots: {} };
    }
    _cache = { path: filePath, mtimeMs, data };
    return data;
  } catch (err) {
    process.stderr.write(`[hook-dispatcher] failed to load table: ${err.message}\n`);
    return { version: 1, slots: {} };
  }
}

/**
 * Clear cached dispatch table (test helper).
 */
export function _resetDispatcherCache() {
  _cache = null;
}

/**
 * Race a promise against a timeout. Rejects with a timeout Error on expiry.
 * @param {Promise<unknown>} promise
 * @param {number} ms
 * @returns {Promise<unknown>}
 */
function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`handler timeout after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Resolve a handler specification to an absolute filesystem path.
 * Accepts strings (relative to plugin root) or `{ path: string }` objects.
 * @param {string|object} spec
 * @returns {string|null}
 */
function resolveHandlerPath(spec) {
  const rel = typeof spec === 'string' ? spec : spec && typeof spec.path === 'string' ? spec.path : null;
  if (!rel) return null;
  return path.isAbsolute(rel) ? rel : path.join(getPluginRoot(), rel);
}

/**
 * Run a single handler with timeout + error isolation.
 * @param {string|object} spec
 * @param {object} payload
 * @param {number} timeoutMs
 * @returns {Promise<object>} HandlerResult
 */
async function runHandler(spec, payload, timeoutMs) {
  const handlerName = typeof spec === 'string' ? spec : spec?.path || '<unknown>';
  const start = Date.now();
  const abs = resolveHandlerPath(spec);
  if (!abs) {
    return {
      handler: handlerName,
      success: false,
      error: 'invalid handler spec (missing path)',
      duration_ms: Date.now() - start,
    };
  }
  try {
    const mod = await import(toFileUrl(abs));
    const fn = mod && mod.default;
    if (typeof fn !== 'function') {
      return {
        handler: handlerName,
        success: false,
        error: 'handler module has no default function export',
        duration_ms: Date.now() - start,
      };
    }
    const output = await withTimeout(Promise.resolve().then(() => fn(payload)), timeoutMs);
    return {
      handler: handlerName,
      success: true,
      output,
      duration_ms: Date.now() - start,
    };
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    process.stderr.write(`[hook-dispatcher] handler "${handlerName}" failed: ${message}\n`);
    return {
      handler: handlerName,
      success: false,
      error: message,
      duration_ms: Date.now() - start,
    };
  }
}

/**
 * Dispatch a slot — runs all registered handlers in order with isolation.
 * Always resolves (never throws).
 * @param {string} slot
 * @param {object} payload
 * @returns {Promise<{slot: string, results: object[], duration_ms: number}>}
 */
export async function dispatch(slot, payload) {
  const start = Date.now();
  const results = [];
  try {
    const table = await loadDispatchTable();
    const slotDef = table.slots && table.slots[slot];
    const handlers = slotDef && Array.isArray(slotDef.handlers) ? slotDef.handlers : [];
    const timeoutMs = getTimeoutMs();
    for (const spec of handlers) {
      // eslint-disable-next-line no-await-in-loop -- ordered execution is required
      const result = await runHandler(spec, payload, timeoutMs);
      results.push(result);
    }
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    process.stderr.write(`[hook-dispatcher] dispatch error: ${message}\n`);
  }
  return { slot, results, duration_ms: Date.now() - start };
}
