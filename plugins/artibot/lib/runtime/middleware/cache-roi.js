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
import { getPricing, PRICING_VERSION, tierForModelId } from '../../core/model-catalog.js';
import { atomicWriteJson } from '../../core/file.js';
import { getPluginRoot } from '../../core/platform.js';
import { emit } from '../../core/event-bus.js';

// ---------------------------------------------------------------------------
// Pricing (USD per 1M tokens).
//
// There is no local price table here any more. The literal `PRICING_USD_PER_M`
// object that used to live at this spot was DELETED: it was a second,
// independently maintained price table that had drifted onto retired models
// (its opus row was Opus 4.1 at $15/$75 and its haiku row was Haiku 3.5 at
// $0.80/$4). Prices now come from `lib/core/model-catalog.js` and are stamped
// with `PRICING_VERSION` so a stored metric can be replayed against the exact
// table that produced it. A layer-5 module importing layer-1 is allowed.
//
// The 1.3 fable tokenizer coefficient is NOT applied anywhere in this module,
// and that is deliberate: this middleware prices the ACTUAL token counts the
// API reported in its `usage` payload, which already reflect the tokenizer.
// The coefficient is a PREDICTION axis and belongs to `getCostFactor`, which
// estimates tokens that have not been spent yet.
// ---------------------------------------------------------------------------

/**
 * Tier whose prices are used when a NON-claude model string matches no known
 * tier (a role alias like `frontier`, a backend id, `gpt-4`, empty input).
 *
 * Chosen as `sonnet` because the deleted table's `unknown` row was numerically
 * identical to its `sonnet` row, so unknown models keep their prior relative
 * behaviour. The catalog is expected to carry this tier. If it ever did not,
 * the fallback would NOT throw: it would surface as unpriced, i.e. a rising
 * `unpricedRequestCount` — never as a $0 price.
 *
 * An off-catalog `claude-*` id never reaches this fallback: it is unpriced
 * (see {@link resolvePricing}).
 */
export const UNKNOWN_FALLBACK_TIER = 'sonnet';

/**
 * Strip a trailing context variant (`[1m]`) and snapshot date (`-20251001`)
 * and lower-case, so a transcript-shaped string can hit an exact catalog id.
 *
 * @param {string} model - Raw model string.
 * @returns {string} Bare lower-case id candidate.
 */
function bareModelId(model) {
  return model.toLowerCase().replace(/\[[^\]]*\]$/, '').replace(/-\d{8}$/, '');
}

/**
 * Resolve catalog prices for an arbitrary model string, in three steps:
 *
 *   1. EXACT catalog id. After {@link bareModelId} strips `[1m]` / a snapshot
 *      date and lower-cases, a current or legacy catalog id
 *      (`model-catalog.js#tierForModelId`) prices at that id's own row via
 *      `getPricing`. One tier can hold ids with different official prices —
 *      `claude-opus-5` (legacy, Claude Opus 5 row) vs `claude-opus-5-5`
 *      (current, Opus 5.5 tier row) — so the id, not the tier, picks the row.
 *   2. UNPRICED. A bare id matching `/^claude-/` that step 1 did not find
 *      (e.g. `claude-opus-4-8`, `claude-sonnet-4-6`) returns null. It is an
 *      Anthropic model with an official price this catalog does not carry;
 *      the current tier row would be a guess, and for older ids a low one.
 *      Callers keep the request in the counts and out of the dollar sums.
 *   3. Anything else is not a model id — a tier alias (`opus`), a role alias
 *      (`frontier`), a backend id, another vendor's id — and keeps the
 *      SUBSTRING match on the tier name, then {@link UNKNOWN_FALLBACK_TIER}.
 *
 * Where the string comes from: {@link resolveModel}. Its first source,
 * `state.context.backend.selected`, is a BACKEND id, not a model id —
 * `create-artibot-agent.js` sets it to `selectedBackend?.id || 'local'`, after
 * this middleware's phase has run. The only paths by which a model id arrives
 * are `state.config.modelPolicy.default` and `state.response.model`.
 *
 * `lib/economics/usage-receipt.js` is the LEDGER writer and fails closed for
 * every id outside its exact-id index. This roll-up now fails closed for
 * off-catalog claude ids too, and stays best-effort (step 3) only for strings
 * that are not model ids at all.
 *
 * @param {string} model - Model id, tier alias, or anything at all.
 * @returns {object|null} Frozen catalog pricing row (see
 *   model-catalog#getPricing), or null for an unpriced claude id.
 */
function resolvePricing(model) {
  if (!model || typeof model !== 'string') return getPricing(UNKNOWN_FALLBACK_TIER);
  const bare = bareModelId(model);
  if (tierForModelId(bare) !== null) return getPricing(bare);
  if (/^claude-/.test(bare)) return null;
  const lower = model.toLowerCase();
  if (lower.includes('fable')) return getPricing('fable');
  if (lower.includes('opus')) return getPricing('opus');
  if (lower.includes('sonnet')) return getPricing('sonnet');
  if (lower.includes('haiku')) return getPricing('haiku');
  return getPricing(UNKNOWN_FALLBACK_TIER);
}

/**
 * Back-compat view of catalog prices in this module's historical shape.
 *
 * Exported as `_PRICING` for tests and any reader that still expects
 * `{input, output, cacheRead, cacheWrite}` keyed by tier plus `unknown`.
 * `cacheWrite` is the 5-minute write rate; the old key name is kept for this
 * compatibility alias only — new code should read the catalog row directly,
 * which distinguishes `cacheWrite5m` from `cacheWrite1h`.
 *
 * @param {string} tier
 */
function toCompatRow(tier) {
  const p = getPricing(tier);
  return Object.freeze({
    input: p.input,
    output: p.output,
    cacheRead: p.cacheRead,
    cacheWrite: p.cacheWrite5m,
  });
}

const PRICING_COMPAT = Object.freeze({
  fable: toCompatRow('fable'),
  opus: toCompatRow('opus'),
  sonnet: toCompatRow('sonnet'),
  haiku: toCompatRow('haiku'),
  unknown: toCompatRow(UNKNOWN_FALLBACK_TIER),
});

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

  // Unpriced model: token counts and hitRate stand, every dollar field and
  // the version stamp are null — a stamp would claim a table priced it.
  const savedCostUsd = pricing
    ? (cacheReadTokens / 1_000_000) * (pricing.input - pricing.cacheRead)
    : null;
  // `cache_creation_input_tokens` is priced at the 5-MINUTE write rate. The
  // Anthropic usage payload does not distinguish 1-hour writes from 5-minute
  // ones through this single counter, and the 1-hour rate is higher (catalog
  // `cacheWrite1h` = 2x input vs `cacheWrite5m` = 1.25x input, so 1.6x the
  // 5-minute rate). `spentCostUsd` is therefore a LOWER BOUND whenever a
  // 1-hour TTL is in play, not an exact charge.
  const spentCostUsd = pricing
    ? (cacheReadTokens / 1_000_000) * pricing.cacheRead +
      (cacheCreationTokens / 1_000_000) * pricing.cacheWrite5m +
      (inputTokens / 1_000_000) * pricing.input +
      (outputTokens / 1_000_000) * pricing.output
    : null;

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
    pricingTier: pricing ? pricing.tier : null,
    pricingVersion: pricing ? PRICING_VERSION : null,
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
    unpricedRequestCount: 0,
    updatedAt: new Date(0).toISOString(),
  });
}

/**
 * Fold one metric into the session. An unpriced metric (null dollars) counts
 * in `requestCount`, the token totals and `unpricedRequestCount`, and adds
 * nothing to the dollar sums — `0 + null` would silently add it as $0.
 */
export function foldMetrics(session, metrics) {
  const priced = metrics.spentCostUsd !== null;
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
    cumulativeSavedUsd: session.cumulativeSavedUsd + (priced ? metrics.savedCostUsd : 0),
    cumulativeSpentUsd: session.cumulativeSpentUsd + (priced ? metrics.spentCostUsd : 0),
    hitRate: denom > 0 ? totalCacheReadTokens / denom : 0,
    requestCount: session.requestCount + 1,
    unpricedRequestCount: (session.unpricedRequestCount ?? 0) + (priced ? 0 : 1),
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

    const saved = metrics.savedCostUsd === null
      ? 'unpriced'
      : `$${metrics.savedCostUsd.toFixed(4)}`;
    emit('feature:cache-roi', {
      detail: `hit=${(metrics.hitRate * 100).toFixed(0)}% saved=${saved}`,
    });

    return state;
  };
}

// ---------------------------------------------------------------------------
// Exports for testing
// ---------------------------------------------------------------------------

export {
  PRICING_COMPAT as _PRICING,
  resolvePricing as _resolvePricing,
  safeInt as _safeInt,
  extractUsage as _extractUsage,
  resolveModel as _resolveModel,
};
