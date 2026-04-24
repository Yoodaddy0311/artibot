/**
 * Runtime cache ROI middleware.
 *
 * Measures Anthropic prompt caching effectiveness by tracking
 * `cache_read_input_tokens`, `cache_creation_input_tokens`, plain
 * `input_tokens`, `output_tokens`, and `thinking_tokens` (extended thinking).
 *
 * Computes:
 *   - cache hit rate = cache_read / (cache_read + cache_creation + input)
 *   - saved tokens   = cache_read tokens (counted as 90% discount vs base input)
 *   - saved cost USD = savedTokens × (pricePerInput - pricePerCacheRead)
 *
 * Orthogonal to `token-usage.js` which counts raw in/out tokens. This middleware
 * focuses on cache economics and writes to a separate session file so downstream
 * consumers (status line, future `/token-report` command, CI gates) can query
 * either dimension without JOIN logic.
 *
 * DATA POLICY: local-only. Never transmits usage data outside the Artibot
 * plugin directory. Disable via `ARTIBOT_CACHE_ROI=0`.
 *
 * @module lib/runtime/middleware/cache-roi
 */

import path from 'node:path';
import { atomicWriteJson } from '../../core/file.js';
import { getPluginRoot } from '../../core/platform.js';
import { emit } from '../../core/event-bus.js';

// ---------------------------------------------------------------------------
// Pricing table (USD per 1M tokens)
// ---------------------------------------------------------------------------

/**
 * Anthropic model pricing snapshot.
 * Verified: 2026-04 (Anthropic public pricing page).
 * TODO: sync quarterly. If pricing changes, update this table rather than
 * scattering constants. Values are USD per 1,000,000 tokens.
 *
 * Cache read is priced at 10% of base input (90% discount).
 * Cache write (5-minute TTL) is priced at 125% of base input (25% premium).
 *
 * @type {Record<string, { input: number, output: number, cacheRead: number, cacheWrite: number }>}
 */
const PRICING_USD_PER_M = Object.freeze({
  // Claude Opus 4.x family
  'opus': { input: 15.0, output: 75.0, cacheRead: 1.5, cacheWrite: 18.75 },
  'opus-4': { input: 15.0, output: 75.0, cacheRead: 1.5, cacheWrite: 18.75 },
  'claude-opus-4': { input: 15.0, output: 75.0, cacheRead: 1.5, cacheWrite: 18.75 },
  // Claude Sonnet 4.x family
  'sonnet': { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
  'sonnet-4': { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-sonnet-4': { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
  // Claude Haiku family
  'haiku': { input: 0.8, output: 4.0, cacheRead: 0.08, cacheWrite: 1.0 },
  'claude-haiku': { input: 0.8, output: 4.0, cacheRead: 0.08, cacheWrite: 1.0 },
  // Fallback
  'unknown': { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
});

/**
 * Resolve pricing for a model string. Matches by prefix so
 * `claude-opus-4-7[1m]` still maps to the `opus` tier.
 *
 * @param {string} model
 * @returns {{ input: number, output: number, cacheRead: number, cacheWrite: number }}
 */
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

/**
 * @typedef {object} CacheUsage
 * @property {number} [cache_read_input_tokens]
 * @property {number} [cache_creation_input_tokens]
 * @property {number} [input_tokens]
 * @property {number} [output_tokens]
 * @property {number} [thinking_tokens]
 */

/**
 * @typedef {object} CacheMetrics
 * @property {number} cacheReadTokens
 * @property {number} cacheCreationTokens
 * @property {number} inputTokens
 * @property {number} outputTokens
 * @property {number} thinkingTokens
 * @property {number} hitRate - Between 0 and 1.
 * @property {number} savedTokens - Tokens served from cache at discount.
 * @property {number} savedCostUsd - Estimated USD saved vs. no-cache baseline.
 * @property {number} spentCostUsd - Actual estimated cost of this call.
 * @property {string} model
 * @property {string} timestamp
 */

/**
 * Coerce a possibly-missing numeric field to a safe integer >= 0.
 *
 * @param {unknown} value
 * @returns {number}
 */
function safeInt(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

/**
 * Compute cache metrics from a raw Anthropic `usage` object.
 * Pure function: no I/O, no mutation.
 *
 * @param {CacheUsage} usage
 * @param {string} model
 * @param {() => number} nowFn
 * @returns {CacheMetrics}
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

  // Saved = (what it would have cost at normal input rate) - (what cache read cost)
  const savedCostUsd = (cacheReadTokens / 1_000_000) * (pricing.input - pricing.cacheRead);

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
// Session aggregation (immutable)
// ---------------------------------------------------------------------------

/**
 * @typedef {object} CacheRoiSession
 * @property {number} totalCacheReadTokens
 * @property {number} totalCacheCreationTokens
 * @property {number} totalInputTokens
 * @property {number} totalOutputTokens
 * @property {number} totalThinkingTokens
 * @property {number} cumulativeSavedUsd
 * @property {number} cumulativeSpentUsd
 * @property {number} hitRate
 * @property {number} requestCount
 * @property {string} updatedAt
 */

/**
 * Create a fresh empty session.
 *
 * @returns {CacheRoiSession}
 */
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

/**
 * Fold a new metric into an existing session, returning a new frozen session.
 *
 * @param {CacheRoiSession} session
 * @param {CacheMetrics} metrics
 * @returns {CacheRoiSession}
 */
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
// Persistence
// ---------------------------------------------------------------------------

/**
 * Resolve the absolute path of the session file.
 *
 * @param {string} [pluginRoot]
 * @returns {string}
 */
export function resolveSessionPath(pluginRoot) {
  const root = pluginRoot || getPluginRoot();
  return path.join(root, 'runtime', 'cache-roi-session.json');
}

/**
 * Persist a session atomically. Never throws — persistence is best-effort
 * because this is an observability sidecar, not a critical path.
 *
 * @param {CacheRoiSession} session
 * @param {string} [pluginRoot]
 * @returns {Promise<boolean>} `true` on success, `false` on failure.
 */
export async function persistSession(session, pluginRoot) {
  try {
    await atomicWriteJson(resolveSessionPath(pluginRoot), session, 0);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Extract the raw usage object from middleware state. Supports several
 * common call shapes so this middleware stays resilient across runtime
 * refactors: `state.response.usage`, `state.context.usage`, or a
 * caller-populated `state.context.cacheRoiInput`.
 *
 * @param {object} state
 * @returns {CacheUsage|null}
 */
function extractUsage(state) {
  return (
    state?.response?.usage ||
    state?.context?.response?.usage ||
    state?.context?.usage ||
    state?.context?.cacheRoiInput ||
    null
  );
}

/**
 * Resolve the effective model name from state context.
 * Mirrors `token-usage.js` resolution so both middlewares agree.
 *
 * @param {object} state
 * @returns {string}
 */
function resolveModel(state) {
  return (
    state?.context?.backend?.selected ||
    state?.config?.modelPolicy?.default ||
    state?.response?.model ||
    'unknown'
  );
}

/**
 * Create the cache-roi tracking middleware.
 *
 * @param {object} [options]
 * @param {boolean} [options.enabled] - Overrides env var if provided.
 * @param {string} [options.pluginRoot] - Test injection.
 * @param {() => number} [options.now] - Clock injection.
 * @param {(session: CacheRoiSession) => Promise<void>} [options.persist] - Test injection.
 * @param {CacheRoiSession} [options.initialSession] - Test injection / SSR.
 * @returns {(state: object, next?: () => Promise<void>) => Promise<object>}
 */
export function createCacheRoiMiddleware(options = {}) {
  const envDisabled = process.env.ARTIBOT_CACHE_ROI === '0';
  const enabled = options.enabled !== undefined ? options.enabled : !envDisabled;
  const now = options.now || Date.now;
  const persist = options.persist
    || ((session) => persistSession(session, options.pluginRoot));

  let session = options.initialSession || createEmptySession();

  return async function cacheRoiMiddleware(state, next) {
    if (typeof next === 'function') {
      await next();
    }

    if (!enabled) {
      if (state && state.context) {
        state.context.cacheRoi = { enabled: false };
      }
      return state;
    }

    const usage = extractUsage(state);
    if (!usage) {
      if (state && state.context) {
        state.context.cacheRoi = {
          enabled: true,
          skipped: 'no-usage',
          session,
        };
      }
      return state;
    }

    const model = resolveModel(state);
    const metrics = computeCacheMetrics(usage, model, now);
    session = foldMetrics(session, metrics);

    await persist(session);

    if (state && state.context) {
      state.context.cacheRoi = {
        enabled: true,
        current: metrics,
        session,
      };
    }

    if (state && Array.isArray(state.messageParts)) {
      const pct = (metrics.hitRate * 100).toFixed(0);
      state.messageParts.push(`cache=${pct}%`);
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
