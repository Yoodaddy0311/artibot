/**
 * Toolformer + GRPO self-learning tool selection module.
 * Tracks tool usage history, learns success rates per context,
 * recommends optimal tools, and applies Group Relative Policy
 * Optimization for comparative tool ranking within candidate groups.
 *
 * History persistence and scoring internals are in tool-history.js.
 *
 * Storage: ~/.claude/artibot/tool-history.json
 * Zero dependencies - uses node:fs, node:path, node:os only.
 *
 * Write-back buffer: recordUsage() and recordGroupComparison() do NOT
 * write to disk immediately. Changes are batched and flushed after
 * FLUSH_INTERVAL_MS (5 seconds) or on explicit flushToDisk() call.
 *
 * @module lib/learning/tool-learner
 */

import { round } from '../core/index.js';
import {
  clampScore,
  clearCache,
  clearDirtyState,
  computeGrpoComposite,
  computeToolScores,
  countGrpoComparisons,
  createEmptyHistory,
  gatherRelatedTools,
  getBufferState,
  getDirtyState,
  GRPO_LEARNING_RATE,
  loadHistory,
  makeGrpoKey,
  markDirty,
  MAX_GRPO_GROUPS_PER_KEY,
  MIN_SAMPLES,
  rebuildAggregates,
  saveHistory,
  setHistory,
  splitGrpoKey,
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
 * @property {Object<string, GRPOGroup[]>} grpoGroups - GRPO comparison groups per context
 * @property {Object<string, number>} grpoScores - GRPO cumulative scores per "context::tool" key
 * @property {number} lastUpdated - Unix ms
 */

/**
 * @typedef {Object} ToolStats
 * @property {number} totalUses
 * @property {number} totalScore
 * @property {number} avgScore
 * @property {number} lastUsed
 */

/**
 * @typedef {Object} GRPOResult
 * @property {string} tool - Tool or command name
 * @property {boolean} success - Did it succeed? (exit code 0, result found)
 * @property {number} durationMs - Execution time in ms
 * @property {number} accuracy - Output accuracy/usefulness 0.0-1.0
 * @property {number} brevity - Command brevity 0.0-1.0 (shorter = higher)
 * @property {string} [output] - Raw output for reference
 */

/**
 * @typedef {Object} GRPOGroup
 * @property {string} context - Context key
 * @property {GRPORankedEntry[]} rankings - Entries ranked by composite score
 * @property {number} timestamp - When this comparison was recorded
 */

/**
 * @typedef {Object} GRPORankedEntry
 * @property {string} tool - Tool name
 * @property {number} compositeScore - Weighted multi-criteria score 0.0-1.0
 * @property {number} relativeAdvantage - Advantage over group mean (-1 to +1)
 * @property {number} rank - 1-based rank in group
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

  // Prune GRPO groups
  for (const [ctx, groups] of Object.entries(history.grpoGroups)) {
    const before = groups.length;
    history.grpoGroups[ctx] = groups.filter((g) => g.timestamp >= cutoff);
    pruned += before - history.grpoGroups[ctx].length;

    if (history.grpoGroups[ctx].length === 0) {
      delete history.grpoGroups[ctx];
    }
  }

  // Remove orphaned GRPO scores (contexts with no groups or records)
  for (const key of Object.keys(history.grpoScores)) {
    const [ctx] = splitGrpoKey(key);
    if (!history.contexts[ctx] && !history.grpoGroups[ctx]) {
      delete history.grpoScores[key];
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
// GRPO API - Group Relative Policy Optimization
// ---------------------------------------------------------------------------

/**
 * Generate ranked tool candidates for a context using GRPO cumulative scores
 * combined with Toolformer success history. Returns tools ordered by
 * combined GRPO + Toolformer ranking.
 *
 * @param {string} context - Context key
 * @param {number} [count=5] - Number of candidates to return
 * @returns {Promise<GRPOCandidate[]>}
 */
export async function suggestToolCandidates(context, count = 5) {
  const history = await loadHistory();

  // Gather all known tools for this context from both Toolformer and GRPO data
  const toolScores = new Map();

  // 1. Toolformer scores (time-decayed success rate)
  const records = history.contexts[context] || [];
  if (records.length > 0) {
    const tfScored = computeToolScores(records);
    for (const s of tfScored) {
      toolScores.set(s.tool, {
        tool: s.tool,
        toolformerScore: s.weightedScore,
        toolformerSamples: s.samples,
        grpoScore: 0,
        grpoComparisons: 0,
        combinedScore: 0,
      });
    }
  }

  // 2. GRPO cumulative scores
  for (const [key, score] of Object.entries(history.grpoScores)) {
    const [ctx, tool] = splitGrpoKey(key);
    if (ctx !== context) continue;

    let entry = toolScores.get(tool);
    if (!entry) {
      entry = {
        tool,
        toolformerScore: 0,
        toolformerSamples: 0,
        grpoScore: 0,
        grpoComparisons: 0,
        combinedScore: 0,
      };
      toolScores.set(tool, entry);
    }
    entry.grpoScore = score;
    entry.grpoComparisons = countGrpoComparisons(history, context, tool);
  }

  // 3. Also pull from related contexts if we have few candidates
  if (toolScores.size < count) {
    const relatedTools = gatherRelatedTools(history, context);
    for (const [tool, relScore] of relatedTools) {
      if (!toolScores.has(tool)) {
        toolScores.set(tool, {
          tool,
          toolformerScore: relScore * 0.5, // Discount related context scores
          toolformerSamples: 0,
          grpoScore: 0,
          grpoComparisons: 0,
          combinedScore: 0,
        });
      }
    }
  }

  // 4. Compute combined score: blend Toolformer + GRPO
  for (const entry of toolScores.values()) {
    const hasGrpo = entry.grpoComparisons >= 2;
    const hasTf = entry.toolformerSamples >= MIN_SAMPLES;

    if (hasGrpo && hasTf) {
      // Both signals: GRPO 60%, Toolformer 40% (GRPO is more informative for ranking)
      entry.combinedScore = round(entry.grpoScore * 0.6 + entry.toolformerScore * 0.4);
    } else if (hasGrpo) {
      entry.combinedScore = round(entry.grpoScore);
    } else if (hasTf) {
      entry.combinedScore = round(entry.toolformerScore);
    } else {
      // Cold start: use whatever signal we have
      entry.combinedScore = round(
        Math.max(entry.grpoScore, entry.toolformerScore, 0.1)
      );
    }
  }

  // Sort by combined score descending
  const candidates = [...toolScores.values()];
  candidates.sort((a, b) => b.combinedScore - a.combinedScore);

  return candidates.slice(0, count);
}

/**
 * @typedef {Object} GRPOCandidate
 * @property {string} tool - Tool name
 * @property {number} toolformerScore - Toolformer time-decayed score
 * @property {number} toolformerSamples - Number of Toolformer observations
 * @property {number} grpoScore - GRPO cumulative relative score
 * @property {number} grpoComparisons - Number of GRPO group comparisons
 * @property {number} combinedScore - Blended final score
 */

/**
 * Record a group of tool execution results for GRPO relative comparison.
 * Computes composite scores, ranks tools within the group, and updates
 * cumulative GRPO scores using relative advantage.
 *
 * @param {string} context - Context key
 * @param {GRPOResult[]} results - Array of tool execution results to compare
 * @returns {Promise<GRPOGroup>} The recorded comparison group with rankings
 */
export async function recordGroupComparison(context, results) {
  if (!results || results.length < 2) {
    throw new Error('GRPO requires at least 2 tool results to compare');
  }

  const history = await loadHistory();

  // 1. Compute composite score for each tool
  const entries = results.map((r) => {
    const compositeScore = computeGrpoComposite(r, results);
    return { tool: r.tool, compositeScore };
  });

  // 2. Compute group mean
  const groupMean =
    entries.reduce((sum, e) => sum + e.compositeScore, 0) / entries.length;

  // 3. Rank and compute relative advantage
  entries.sort((a, b) => b.compositeScore - a.compositeScore);
  const rankings = entries.map((e, i) => ({
    tool: e.tool,
    compositeScore: round(e.compositeScore),
    relativeAdvantage: round(e.compositeScore - groupMean),
    rank: i + 1,
  }));

  // 4. Store the comparison group
  const group = { context, rankings, timestamp: Date.now() };

  if (!history.grpoGroups[context]) {
    history.grpoGroups[context] = [];
  }
  history.grpoGroups[context].push(group);

  // Cap stored groups
  if (history.grpoGroups[context].length > MAX_GRPO_GROUPS_PER_KEY) {
    history.grpoGroups[context] = history.grpoGroups[context].slice(
      -MAX_GRPO_GROUPS_PER_KEY
    );
  }

  // 5. Update cumulative GRPO scores using relative advantage
  for (const ranked of rankings) {
    const grpoKey = makeGrpoKey(context, ranked.tool);
    const current = history.grpoScores[grpoKey] ?? 0.5; // Start at neutral 0.5
    const updated = current + GRPO_LEARNING_RATE * ranked.relativeAdvantage;
    history.grpoScores[grpoKey] = clampScore(updated);
  }

  markDirty(flushToDisk);
  return group;
}

/**
 * Get GRPO comparison history for a context.
 *
 * @param {string} context - Context key
 * @param {number} [limit=10] - Max groups to return
 * @returns {Promise<GRPOGroup[]>}
 */
export async function getGrpoHistory(context, limit = 10) {
  const history = await loadHistory();
  const groups = history.grpoGroups[context] || [];
  return groups.slice(-limit);
}

/**
 * Get GRPO cumulative scores for all tools in a context.
 *
 * @param {string} context - Context key
 * @returns {Promise<Object<string, number>>} Tool -> GRPO score map
 */
export async function getGrpoScores(context) {
  const history = await loadHistory();
  const result = {};
  const prefix = context + '::';

  for (const [key, score] of Object.entries(history.grpoScores)) {
    if (key.startsWith(prefix)) {
      const tool = key.slice(prefix.length);
      result[tool] = score;
    }
  }

  return result;
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
