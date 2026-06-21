/**
 * Toolformer self-learning tool selection module.
 * Tracks tool usage history, learns time-decayed success rates per
 * context, and recommends optimal tools for a given task pattern.
 *
 * History persistence and scoring internals are in tool-history.js.
 *
 * Storage: ~/.claude/artibot/tool-history.json
 * Zero dependencies - uses node:fs, node:path, node:os only.
 *
 * Write-back buffer: recordUsage() does NOT write to disk immediately.
 * Changes are batched and flushed after FLUSH_INTERVAL_MS (5 seconds)
 * or on explicit flushToDisk() call.
 *
 * @module lib/learning/tool-learner
 */

import {
  clampScore,
  clearCache,
  clearDirtyState,
  computeToolScores,
  createEmptyHistory,
  getBufferState,
  getDirtyState,
  loadHistory,
  markDirty,
  MIN_SAMPLES,
  rebuildAggregates,
  saveHistory,
  setHistory,
  suggestFromRelated,
  updateAggregate,
} from './tool-history.js';

/** Maximum records kept per context key to prevent unbounded growth */
const MAX_RECORDS_PER_KEY = 200;

/**
 * @typedef {Object} UsageRecord
 * @property {string} tool - Tool name (e.g. "Read", "Grep", "Task")
 * @property {string} context - Context key (e.g. "search:file", "edit:typescript")
 * @property {number} score - Success score 0.0-1.0
 * @property {number} timestamp - Unix ms
 * @property {string} [command] - Originating command (e.g. "/implement", "/analyze")
 * @property {string} [domain] - Domain tag (e.g. "frontend", "backend", "security")
 * @property {string} [callingAgent] - Agent that invoked the tool (v4.7.0). For
 *   sub-agent calls, this is the spawned agent's id; for orchestrator-direct
 *   calls, this is the orchestrator id. Optional for backward compat —
 *   pre-v4.7.0 records do not carry this field.
 * @property {string} [parentAgent] - Calling agent's parent in the spawn chain
 *   (v4.7.0). Enables attribution like "tool X failed when called by agent A
 *   under parent B". Optional; null for top-level orchestrator.
 */

/**
 * @typedef {Object} ToolHistory
 * @property {number} version - Schema version
 * @property {Object<string, UsageRecord[]>} contexts - Keyed by context string
 * @property {Object<string, ToolStats>} aggregates - Pre-computed per-tool aggregates
 * @property {number} lastUpdated - Unix ms
 */

/**
 * @typedef {Object} ToolStats
 * @property {number} totalUses
 * @property {number} totalScore
 * @property {number} avgScore
 * @property {number} lastUsed
 */

// ---------------------------------------------------------------------------
// Flush API
// ---------------------------------------------------------------------------

/**
 * Flush pending changes to disk immediately.
 * No-op if there are no unsaved changes.
 * @returns {Promise<void>}
 */
export async function flushToDisk() {
  const { dirty } = getDirtyState();
  clearDirtyState();
  if (!dirty) return;
  await saveHistory();
}

/**
 * Graceful shutdown: flush any pending writes to disk.
 * Call at plugin teardown to ensure no data is lost.
 * @returns {Promise<void>}
 */
export async function shutdownToolLearner() {
  await flushToDisk();
}

// Register process exit handler to persist pending changes
process.on('beforeExit', () => {
  flushToDisk();
});

// ---------------------------------------------------------------------------
// Core API
// ---------------------------------------------------------------------------

/**
 * Record a tool usage event with success scoring.
 *
 * @param {string} tool - Tool name
 * @param {string} context - Context key describing the task pattern
 * @param {number} score - Success score 0.0 (failure) to 1.0 (success)
 * @param {Object} [meta] - Additional metadata
 * @param {string} [meta.command] - Originating slash command
 * @param {string} [meta.domain] - Domain classification
 * @param {string} [meta.agentId] - Calling agent id (v4.7.0 attribution).
 *   Stored as `callingAgent` on the record. Falsy values are not persisted.
 * @param {string} [meta.agentType] - Calling agent role/type (v4.7.0).
 *   Stored as `parentAgent` for spawn-chain attribution. Falsy values are
 *   not persisted.
 * @returns {Promise<void>}
 * @example
 * await recordUsage('Grep', 'search:typescript', 0.9, { command: '/analyze', domain: 'backend' });
 * // Records that Grep scored 0.9 in a typescript search context
 */
export async function recordUsage(tool, context, score, meta = {}) {
  const history = await loadHistory();

  const record = {
    tool,
    context,
    score: clampScore(score),
    timestamp: Date.now(),
    ...(meta.command && { command: meta.command }),
    ...(meta.domain && { domain: meta.domain }),
    // v4.7.0: agent attribution. Skip 'unknown' since extractAgentId returns
    // it as a fallback string — persisting 'unknown' would muddy aggregations.
    ...(meta.agentId && meta.agentId !== 'unknown' && { callingAgent: meta.agentId }),
    ...(meta.agentType && meta.agentType !== 'main' && { parentAgent: meta.agentType }),
  };

  // Append to context bucket
  if (!history.contexts[context]) {
    history.contexts[context] = [];
  }
  history.contexts[context].push(record);

  // Enforce per-key cap: keep most recent records
  if (history.contexts[context].length > MAX_RECORDS_PER_KEY) {
    history.contexts[context] = history.contexts[context].slice(
      -MAX_RECORDS_PER_KEY
    );
  }

  // Update aggregates
  updateAggregate(history, tool, record);

  markDirty(flushToDisk);
}

/**
 * Suggest the best tool(s) for a given context, ranked by
 * time-decayed weighted success score.
 *
 * @param {string} context - Context key to match
 * @param {Object} [options]
 * @param {number} [options.limit=3] - Max suggestions
 * @param {number} [options.minScore=0.4] - Minimum weighted score
 * @returns {Promise<import('./tool-history.js').ToolSuggestion[]>}
 * @example
 * const suggestions = await suggestTool('search:typescript', { limit: 2 });
 * // [{ tool: 'Grep', weightedScore: 0.92, rawAvg: 0.88, samples: 15, confidence: 'medium' }, ...]
 */
export async function suggestTool(context, options = {}) {
  const { limit = 3, minScore = 0.4 } = options;
  const history = await loadHistory();

  const records = history.contexts[context];
  if (!records || records.length === 0) {
    return suggestFromRelated(history, context, limit, minScore);
  }

  const scored = computeToolScores(records);

  return scored
    .filter((s) => s.weightedScore >= minScore && s.samples >= MIN_SAMPLES)
    .slice(0, limit);
}

/**
 * Get aggregate statistics for all tracked tools or a specific tool.
 *
 * @param {string} [toolName] - If provided, return stats for this tool only
 * @returns {Promise<Object<string, ToolStats>|ToolStats|null>}
 */
export async function getToolStats(toolName) {
  const history = await loadHistory();

  if (toolName) {
    return history.aggregates[toolName] ?? null;
  }

  return { ...history.aggregates };
}

/**
 * Get the full context map for inspection or export.
 * @returns {Promise<Object<string, number>>} Map of context -> record count
 */
export async function getContextMap() {
  const history = await loadHistory();
  const result = {};
  for (const [ctx, records] of Object.entries(history.contexts)) {
    result[ctx] = records.length;
  }
  return result;
}

/**
 * Prune old records beyond a retention period.
 * @param {number} [retentionMs] - Retention period in ms (default: 90 days)
 * @returns {Promise<number>} Number of records pruned
 */
export async function pruneOldRecords(retentionMs = 90 * 24 * 60 * 60 * 1000) {
  const history = await loadHistory();
  const cutoff = Date.now() - retentionMs;
  let pruned = 0;

  for (const [ctx, records] of Object.entries(history.contexts)) {
    const before = records.length;
    history.contexts[ctx] = records.filter((r) => r.timestamp >= cutoff);
    pruned += before - history.contexts[ctx].length;

    if (history.contexts[ctx].length === 0) {
      delete history.contexts[ctx];
    }
  }

  // Rebuild aggregates from remaining data
  if (pruned > 0) {
    rebuildAggregates(history);
    markDirty(flushToDisk);
  }

  return pruned;
}

/**
 * Reset all learning data. Use with caution.
 * @returns {Promise<void>}
 */
export async function resetHistory() {
  setHistory(createEmptyHistory());
  await saveHistory();
}

// ---------------------------------------------------------------------------
// Context key builders (helpers for callers)
// ---------------------------------------------------------------------------

/**
 * Build a normalized context key from task attributes.
 *
 * @param {string} operation - What is being done (e.g. "search", "edit", "analyze")
 * @param {string} target - What is being targeted (e.g. "typescript", "config", "tests")
 * @param {string} [scope] - Scope qualifier (e.g. "file", "module", "project")
 * @returns {string} Normalized context key like "search:typescript:file"
 * @example
 * const key = buildContextKey('search', 'TypeScript', 'file');
 * // key: 'search:typescript:file'
 *
 * const key2 = buildContextKey('edit', 'config');
 * // key2: 'edit:config'
 */
export function buildContextKey(operation, target, scope) {
  const parts = [operation, target];
  if (scope) parts.push(scope);
  return parts.map((p) => p.toLowerCase().trim()).join(':');
}

// ---------------------------------------------------------------------------
// Testing Helpers
// ---------------------------------------------------------------------------

/**
 * Clear in-memory cache. Useful for testing.
 * @returns {void}
 */
export function _clearCache() {
  clearCache();
}

/**
 * Expose internal dirty/timer state for testing.
 * @returns {{ dirty: boolean, hasTimer: boolean }}
 */
export function _getBufferState() {
  return getBufferState();
}
