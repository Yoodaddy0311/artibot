/**
 * Runtime cache ROI middleware.
 *
 * Measures Anthropic prompt caching effectiveness. Parses each API response's
 * `usage` payload (cache_read_input_tokens, cache_creation_input_tokens,
 * input_tokens, output_tokens, thinking_tokens), computes hit rate and USD
 * savings, and folds a session roll-up atomically into
 * `runtime/cache-roi-session.json`.
 *
 * Orthogonal to `token-usage.js` (raw in/out counts). Both middlewares run in
 * sequence and write to separate session files so downstream consumers never
 * need to JOIN across schemas.
 *
 * DATA POLICY: local-only. Disable via `ARTIBOT_CACHE_ROI=0`.
 *
 * @module lib/runtime/middleware/cache-roi
 */

import path from 'node:path';
import { atomicWriteJson } from '../../core/file.js';
import { getPluginRoot } from '../../core/platform.js';
import { emit } from '../../core/event-bus.js';

// ---------------------------------------------------------------------------
// Pricing (USD per 1M tokens). Verified 2026-04. Sync quarterly.
// Cache read = 10% of input; cache write = 125% of input.
// ---------------------------------------------------------------------------

const PRICING_USD_PER_M = Object.freeze({
  opus: { input: 15.0, output: 75.0, cacheRead: 1.5, cacheWrite: 18.75 },
  sonnet: { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
  haiku: { input: 0.8, output: 4.0, cacheRead: 0.08, cacheWrite: 1.0 },
  unknown: { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
});

/** @param {string} model @returns {{input:number,output:number,cacheRead:number,cacheWrite:number}} */
function resolvePricing(model) {
  if (!model || typeof model !== 'string') return PRICING_USD_PER_M.unknown;
  const lower = model.toLowerCase();
  if (lower.includes('opus')) return PRICING_USD_PER_M.opus;
  if (lower.includes('sonnet')) return PRICING_USD_PER_M.sonnet;
  if (lower.includes('haiku')) return PRICING_USD_PER_M.haiku;
  return PRICING_USD_PER_M.unknown;
}

// ---------------------------------------------------------------------------
// Pure metric computation
// ---------------------------------------------------------------------------

/** Coerce to safe non-negative integer. */
function safeInt(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

/**
 * Compute cache metrics from a raw Anthropic usage object. Pure function.
 *
 * @param {object} usage
 * @param {string} model
 * @param {() => number} [nowFn]
 */
export function computeCacheMetrics(usage, model, nowFn = Date.now) {
  const cacheReadTokens = safeInt(usage?.cache_read_input_tokens);
  const cacheCreationTokens = safeInt(usage?.cache_creation_input_tokens);
  const inputTokens = safeInt(usage?.input_tokens);
  const outputTokens = safeInt(usage?.output_tokens);
  const thinkingTokens = safeInt(usage?.thinking_tokens);

  const totalInputSide = cacheReadTokens + cacheCreationTokens + inputTokens;
  const hitRate = totalInputSide > 0 ? cacheReadTokens / totalInputSide : 0;
  const pricing = resolvePricing(model);

  const savedCostUsd =
    (cacheReadTokens / 1_000_000) * (pricing.input - pricing.cacheRead);
  const spentCostUsd =
    (cacheReadTokens / 1_000_000) * pricing.cacheRead +
    (cacheCreationTokens / 1_000_000) * pricing.cacheWrite +
    (inputTokens / 1_000_000) * pricing.input +
    (outputTokens / 1_000_000) * pricing.output;

  return Object.freeze({
    cacheReadTokens,
    cacheCreationTokens,
    inputTokens,
    outputTokens,
    thinkingTokens,
    hitRate,
    savedTokens: cacheReadTokens,
    savedCostUsd,
    spentCostUsd,
    model: model || 'unknown',
    timestamp: new Date(nowFn()).toISOString(),
  });
}

// ---------------------------------------------------------------------------
// Session aggregation (immutable fold)
// ---------------------------------------------------------------------------

export function createEmptySession() {
  return Object.freeze({
    totalCacheReadTokens: 0,
    totalCacheCreationTokens: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalThinkingTokens: 0,
    cumulativeSavedUsd: 0,
    cumulativeSpentUsd: 0,
    hitRate: 0,
    requestCount: 0,
    updatedAt: new Date(0).toISOString(),
  });
}

export function foldMetrics(session, metrics) {
  const totalCacheReadTokens = session.totalCacheReadTokens + metrics.cacheReadTokens;
  const totalCacheCreationTokens = session.totalCacheCreationTokens + metrics.cacheCreationTokens;
  const totalInputTokens = session.totalInputTokens + metrics.inputTokens;
  const totalOutputTokens = session.totalOutputTokens + metrics.outputTokens;
  const totalThinkingTokens = session.totalThinkingTokens + metrics.thinkingTokens;
  const denom = totalCacheReadTokens + totalCacheCreationTokens + totalInputTokens;

  return Object.freeze({
    totalCacheReadTokens,
    totalCacheCreationTokens,
    totalInputTokens,
    totalOutputTokens,
    totalThinkingTokens,
    cumulativeSavedUsd: session.cumulativeSavedUsd + metrics.savedCostUsd,
    cumulativeSpentUsd: session.cumulativeSpentUsd + metrics.spentCostUsd,
    hitRate: denom > 0 ? totalCacheReadTokens / denom : 0,
    requestCount: session.requestCount + 1,
    updatedAt: metrics.timestamp,
  });
}

// ---------------------------------------------------------------------------
// Persistence (best-effort; never throws)
// ---------------------------------------------------------------------------

export function resolveSessionPath(pluginRoot) {
  const root = pluginRoot || getPluginRoot();
  return path.join(root, 'runtime', 'cache-roi-session.json');
}

export async function persistSession(session, pluginRoot) {
  try {
    await atomicWriteJson(resolveSessionPath(pluginRoot), session, 0);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// State extraction helpers
// ---------------------------------------------------------------------------

/** Supports several call shapes so this stays resilient across runtime refactors. */
function extractUsage(state) {
  return (
    state?.response?.usage ||
    state?.context?.response?.usage ||
    state?.context?.usage ||
    state?.context?.cacheRoiInput ||
    null
  );
}

function resolveModel(state) {
  return (
    state?.context?.backend?.selected ||
    state?.config?.modelPolicy?.default ||
    state?.response?.model ||
    'unknown'
  );
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create the cache-roi tracking middleware.
 *
 * @param {object} [options]
 * @param {boolean} [options.enabled]
 * @param {string} [options.pluginRoot]
 * @param {() => number} [options.now]
 * @param {(session: object) => Promise<void>} [options.persist]
 * @param {object} [options.initialSession]
 */
export function createCacheRoiMiddleware(options = {}) {
  const envDisabled = process.env.ARTIBOT_CACHE_ROI === '0';
  const enabled = options.enabled !== undefined ? options.enabled : !envDisabled;
  const now = options.now || Date.now;
  const persist = options.persist
    || ((session) => persistSession(session, options.pluginRoot));

  let session = options.initialSession || createEmptySession();

  return async function cacheRoiMiddleware(state, next) {
    if (typeof next === 'function') await next();

    if (!enabled) {
      if (state?.context) state.context.cacheRoi = { enabled: false };
      return state;
    }

    const usage = extractUsage(state);
    if (!usage) {
      if (state?.context) {
        state.context.cacheRoi = { enabled: true, skipped: 'no-usage', session };
      }
      return state;
    }

    const model = resolveModel(state);
    const metrics = computeCacheMetrics(usage, model, now);
    session = foldMetrics(session, metrics);

    await persist(session);

    if (state?.context) {
      state.context.cacheRoi = { enabled: true, current: metrics, session };
    }
    if (state && Array.isArray(state.messageParts)) {
      state.messageParts.push(`cache=${(metrics.hitRate * 100).toFixed(0)}%`);
    }

    emit('feature:cache-roi', {
      detail: `hit=${(metrics.hitRate * 100).toFixed(0)}% saved=$${metrics.savedCostUsd.toFixed(4)}`,
    });

    return state;
  };
}

// ---------------------------------------------------------------------------
// Exports for testing
// ---------------------------------------------------------------------------

export {
  PRICING_USD_PER_M as _PRICING,
  resolvePricing as _resolvePricing,
  safeInt as _safeInt,
  extractUsage as _extractUsage,
  resolveModel as _resolveModel,
};
