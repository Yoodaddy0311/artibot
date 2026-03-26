/**
 * Runtime token usage middleware.
 * Tracks per-model, per-agent token consumption with cumulative session stats.
 *
 * @module lib/runtime/middleware/token-usage
 */

// ---------------------------------------------------------------------------
// Store (session-scoped, immutable updates)
// ---------------------------------------------------------------------------

/**
 * @typedef {object} UsageEntry
 * @property {number} inputTokens
 * @property {number} outputTokens
 * @property {string} model
 * @property {string} agent
 * @property {string} operation
 * @property {string} timestamp
 */

/**
 * Create a fresh session store.
 *
 * @returns {{ entries: UsageEntry[], byModel: Record<string, {input: number, output: number, count: number}>, byAgent: Record<string, {input: number, output: number, count: number}>, totals: {input: number, output: number, count: number} }}
 */
function createStore() {
  return {
    entries: [],
    byModel: {},
    byAgent: {},
    totals: { input: 0, output: 0, count: 0 },
  };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Estimate token count from character length.
 * Rough heuristic: ~4 chars per token for English, ~2 for CJK-heavy.
 *
 * @param {string} text
 * @param {number} charsPerToken
 * @returns {number}
 */
function estimateTokens(text, charsPerToken) {
  if (!text || typeof text !== 'string') return 0;
  return Math.ceil(text.length / charsPerToken);
}

/**
 * Build a usage entry from pipeline state.
 *
 * @param {object} state
 * @param {number} inputTokens
 * @param {number} outputTokens
 * @param {{ model: string, agent: string, nowFn: () => number }} opts
 * @returns {UsageEntry}
 */
function buildEntry(state, inputTokens, outputTokens, { model, agent, nowFn }) {
  return Object.freeze({
    inputTokens,
    outputTokens,
    model,
    agent,
    operation: state.context.intent?.best || 'unknown',
    timestamp: new Date(nowFn()).toISOString(),
  });
}

/**
 * Update a bucket (model or agent) immutably.
 *
 * @param {Record<string, {input: number, output: number, count: number}>} buckets
 * @param {string} key
 * @param {number} inputTokens
 * @param {number} outputTokens
 * @returns {Record<string, {input: number, output: number, count: number}>}
 */
function updateBucket(buckets, key, inputTokens, outputTokens) {
  const existing = buckets[key] || { input: 0, output: 0, count: 0 };
  return {
    ...buckets,
    [key]: {
      input: existing.input + inputTokens,
      output: existing.output + outputTokens,
      count: existing.count + 1,
    },
  };
}

/**
 * Update totals immutably.
 *
 * @param {{ input: number, output: number, count: number }} totals
 * @param {number} inputTokens
 * @param {number} outputTokens
 * @returns {{ input: number, output: number, count: number }}
 */
function updateTotals(totals, inputTokens, outputTokens) {
  return {
    input: totals.input + inputTokens,
    output: totals.output + outputTokens,
    count: totals.count + 1,
  };
}

/**
 * Record a usage entry into the store, returning a new store.
 *
 * @param {object} store
 * @param {UsageEntry} entry
 * @param {number} maxEntries
 * @returns {object} New store
 */
function recordUsage(store, entry, maxEntries) {
  const entries = [...store.entries, entry];
  const trimmed = entries.length > maxEntries ? entries.slice(-maxEntries) : entries;

  return {
    entries: trimmed,
    byModel: updateBucket(store.byModel, entry.model, entry.inputTokens, entry.outputTokens),
    byAgent: updateBucket(store.byAgent, entry.agent, entry.inputTokens, entry.outputTokens),
    totals: updateTotals(store.totals, entry.inputTokens, entry.outputTokens),
  };
}

/**
 * Resolve the model name from state context and config.
 *
 * @param {object} state
 * @returns {string}
 */
function resolveModel(state) {
  return (
    state.context.backend?.selected ||
    state.config?.modelPolicy?.default ||
    'unknown'
  );
}

/**
 * Resolve the agent name from state context.
 *
 * @param {object} state
 * @returns {string}
 */
function resolveAgent(state) {
  return (
    state.context.subagents?.contract?.targetAgent ||
    state.context.tasks?.recommendedAgent ||
    'orchestrator'
  );
}

/**
 * Format token count for display.
 *
 * @param {number} tokens
 * @returns {string}
 */
function formatTokenCount(tokens) {
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}K`;
  return String(tokens);
}

// ---------------------------------------------------------------------------
// Query API (pure functions operating on store)
// ---------------------------------------------------------------------------

/**
 * Get cumulative usage from a store.
 *
 * @param {object} store
 * @returns {{ input: number, output: number, total: number, count: number }}
 */
function getUsage(store) {
  return {
    input: store.totals.input,
    output: store.totals.output,
    total: store.totals.input + store.totals.output,
    count: store.totals.count,
  };
}

/**
 * Get usage breakdown by model.
 *
 * @param {object} store
 * @returns {Record<string, {input: number, output: number, total: number, count: number}>}
 */
function getUsageByModel(store) {
  const result = {};
  for (const [model, stats] of Object.entries(store.byModel)) {
    result[model] = { ...stats, total: stats.input + stats.output };
  }
  return result;
}

/**
 * Get usage breakdown by agent.
 *
 * @param {object} store
 * @returns {Record<string, {input: number, output: number, total: number, count: number}>}
 */
function getUsageByAgent(store) {
  const result = {};
  for (const [agent, stats] of Object.entries(store.byAgent)) {
    result[agent] = { ...stats, total: stats.input + stats.output };
  }
  return result;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a token usage tracking middleware.
 *
 * @param {object} [options]
 * @param {boolean} [options.enabled=true] - Enable/disable tracking.
 * @param {number} [options.charsPerToken=4] - Character-to-token ratio for estimation.
 * @param {number} [options.maxEntries=500] - Maximum stored entries before trimming.
 * @param {object} [options.store] - Optional external store (for sharing across instances).
 * @param {() => number} [options.now] - Clock injection for deterministic tests.
 * @returns {(state: object) => Promise<object>}
 */
export function createTokenUsageMiddleware(options = {}) {
  const {
    enabled = true,
    charsPerToken = 4,
    maxEntries = 500,
    now = Date.now,
  } = options;

  let store = options.store || createStore();

  return async function tokenUsageMiddleware(state) {
    if (!enabled) {
      state.context.tokenUsage = { enabled: false };
      return state;
    }

    const inputTokens = estimateTokens(state.userPrompt, charsPerToken);
    const outputTokens = 0; // Output not yet available at middleware time
    const model = resolveModel(state);
    const agent = resolveAgent(state);

    const entry = buildEntry(state, inputTokens, outputTokens, { model, agent, nowFn: now });
    store = recordUsage(store, entry, maxEntries);

    const usage = getUsage(store);

    state.context.tokenUsage = {
      enabled: true,
      current: {
        inputTokens,
        model,
        agent,
      },
      session: {
        totalInput: usage.input,
        totalOutput: usage.output,
        totalTokens: usage.total,
        requestCount: usage.count,
      },
      byModel: getUsageByModel(store),
      byAgent: getUsageByAgent(store),
    };

    state.messageParts.push(`tokens=${formatTokenCount(inputTokens)}`);

    return state;
  };
}

// ---------------------------------------------------------------------------
// Exports for testing
// ---------------------------------------------------------------------------

export {
  createStore as _createStore,
  estimateTokens as _estimateTokens,
  recordUsage as _recordUsage,
  getUsage as _getUsage,
  getUsageByModel as _getUsageByModel,
  getUsageByAgent as _getUsageByAgent,
  formatTokenCount as _formatTokenCount,
};
