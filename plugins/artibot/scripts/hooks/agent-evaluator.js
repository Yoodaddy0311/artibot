#!/usr/bin/env node
/**
 * SubagentStop hook: Agent execution evaluator.
 * Scores agent runs based on observable heuristics and feeds results
 * into the lifelong learning pipeline via collectExperience().
 *
 * Scoring factors (no LLM calls — maintenance cost: $0):
 *   - Tool usage count (productivity signal)
 *   - Error presence (failure signal)
 *   - Task completion markers in output (success signal)
 *   - Output length (effort signal)
 *
 * Hook attachment (hooks.json): SubagentStop
 * Stdin: Claude Code hook data JSON
 * Stdout: JSON { message } — informational only, never blocks
 */

import { parseJSON, readStdin, toFileUrl, writeStdout } from '../utils/index.js';
import path from 'node:path';
import { createErrorHandler, extractAgentId, extractAgentRole, logHookError } from '../../lib/core/hook-utils.js';

// ---------------------------------------------------------------------------
// Plugin root resolution (mirrors tool-tracker.js pattern)
// ---------------------------------------------------------------------------
const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT
  ? path.resolve(process.env.CLAUDE_PLUGIN_ROOT)
  : path.resolve(
      path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/i, '$1')),
      '..',
      '..'
    );

// ---------------------------------------------------------------------------
// Scoring constants
// ---------------------------------------------------------------------------

/** Minimum tool calls to consider an agent "active". */
const MIN_TOOL_CALLS = 2;

/** Keywords in output that signal successful task completion. */
const SUCCESS_MARKERS = [
  'completed', 'done', 'finished', 'success', 'implemented', 'fixed',
  'resolved', 'created', 'updated', 'deployed', 'passed', 'validated',
];

/** Keywords in output that signal errors or failures. */
const ERROR_MARKERS = [
  'error', 'failed', 'failure', 'exception', 'traceback', 'fatal',
  'cannot', "couldn't", 'unable to', 'not found', 'undefined', 'null pointer',
];

/** Keywords indicating partial completion. */
const PARTIAL_MARKERS = [
  'partial', 'incomplete', 'blocked', 'waiting', 'pending', 'skipped',
];

// ---------------------------------------------------------------------------
// Scoring logic
// ---------------------------------------------------------------------------

/**
 * Score an agent run from 0.0 to 1.0.
 *
 * @param {object} hookData - Raw hook payload from Claude Code
 * @returns {{ score: number, breakdown: object, summary: string }}
 */
function evaluateAgent(hookData) {
  const output   = extractOutput(hookData);
  const toolUses = extractToolUseCount(hookData);
  const hasError = hookData?.error || hookData?.is_error || false;

  const lowerOutput = output.toLowerCase();

  // --- Component scores ---

  // a) Completion score
  const successHits = SUCCESS_MARKERS.filter(m => lowerOutput.includes(m)).length;
  const errorHits   = ERROR_MARKERS.filter(m => lowerOutput.includes(m)).length;
  const partialHits = PARTIAL_MARKERS.filter(m => lowerOutput.includes(m)).length;

  let completionScore = 0.5; // neutral default
  if (successHits > 0 && errorHits === 0) completionScore = 0.9;
  else if (successHits > errorHits) completionScore = 0.7;
  else if (errorHits > 0 && successHits === 0) completionScore = 0.2;
  else if (partialHits > 0) completionScore = 0.5;
  if (hasError) completionScore = Math.min(completionScore, 0.2);

  // b) Activity score (tool usage)
  let activityScore = 0.3;
  if (toolUses >= 10) activityScore = 1.0;
  else if (toolUses >= 5) activityScore = 0.8;
  else if (toolUses >= MIN_TOOL_CALLS) activityScore = 0.6;
  else if (toolUses === 1) activityScore = 0.4;

  // c) Output richness score
  const outputLen = output.length;
  let richnessScore = 0.3;
  if (outputLen >= 2000) richnessScore = 1.0;
  else if (outputLen >= 500) richnessScore = 0.7;
  else if (outputLen >= 100) richnessScore = 0.5;

  // --- Weighted composite ---
  const score = Math.round(
    (completionScore * 0.50 + activityScore * 0.30 + richnessScore * 0.20) * 100
  ) / 100;

  const breakdown = {
    completionScore,
    activityScore,
    richnessScore,
    toolUses,
    outputLength: outputLen,
    successMarkers: successHits,
    errorMarkers: errorHits,
    hasError,
  };

  let summary;
  if (score >= 0.8)      summary = 'excellent';
  else if (score >= 0.6) summary = 'good';
  else if (score >= 0.4) summary = 'partial';
  else                   summary = 'poor';

  return { score, breakdown, summary };
}

// ---------------------------------------------------------------------------
// Data extraction helpers
// ---------------------------------------------------------------------------

/**
 * Extract the main text output from hook data.
 * @param {object} hookData
 * @returns {string}
 */
function extractOutput(hookData) {
  if (!hookData) return '';
  const candidates = [
    hookData.output,
    hookData.result,
    hookData.content,
    hookData.message,
    hookData.stdout,
    hookData.text,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.length > 0) return c;
    if (typeof c === 'object' && c !== null) return JSON.stringify(c);
  }
  return '';
}

/**
 * Estimate tool call count from hook data.
 * @param {object} hookData
 * @returns {number}
 */
function extractToolUseCount(hookData) {
  if (!hookData) return 0;
  // Some hook payloads expose metrics
  if (typeof hookData.tool_use_count === 'number') return hookData.tool_use_count;
  if (typeof hookData.tool_calls === 'number') return hookData.tool_calls;
  if (Array.isArray(hookData.tool_uses)) return hookData.tool_uses.length;
  // Fallback: count tool_use blocks in serialized output
  const raw = JSON.stringify(hookData);
  const matches = raw.match(/"tool_use"/g);
  return matches ? matches.length : 0;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const raw = await readStdin();
  const hookData = parseJSON(raw);

  if (!hookData) return;

  const agentId   = extractAgentId(hookData);
  const agentRole = extractAgentRole(hookData);

  const { score, breakdown, summary } = evaluateAgent(hookData);

  // Feed into lifelong learning pipeline
  try {
    const lifelongPath = path.join(PLUGIN_ROOT, 'lib', 'learning', 'lifelong-learner.js');
    const { collectExperience } = await import(toFileUrl(lifelongPath));
    await collectExperience({
      type: 'agent',
      category: agentRole,
      data: {
        agentId,
        score,
        summary,
        ...breakdown,
      },
    });
  } catch (err) {
    logHookError('agent-evaluator', 'learning pipeline unavailable', err);
  }

  writeStdout({
    message: `[agent-evaluator] ${agentId} (${agentRole}) scored ${score} (${summary}) | tools=${breakdown.toolUses} output=${breakdown.outputLength}chars`,
  });
}

main().catch(createErrorHandler('agent-evaluator', { exit: true }));
