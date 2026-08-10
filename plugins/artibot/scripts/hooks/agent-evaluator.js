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
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createErrorHandler, extractAgentId, extractAgentRole, logHookError } from '../../lib/core/hook-utils.js';

// ---------------------------------------------------------------------------
// Plugin root resolution (mirrors tool-tracker.js pattern)
// ---------------------------------------------------------------------------
const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT
  ? path.resolve(process.env.CLAUDE_PLUGIN_ROOT)
  : path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
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

/**
 * Lines that contain any of these phrases are excluded from errorHits.
 * v4.7.2 (issue-scanner W4 P1-2): plain `includes()` flagged
 * "no errors", "0 issues found", "error free" as failures, inflating the
 * error rate for clean runs.
 */
const ERROR_NEGATION_PHRASES = [
  'no error', 'no errors', 'no errors found', 'no issues', '0 issues',
  '0 issues found', 'not failed', 'cannot reproduce', 'error free',
  'error-free',
];

// ---------------------------------------------------------------------------
// Scoring logic
// ---------------------------------------------------------------------------

/**
 * Escape regex special characters in a literal marker.
 * @param {string} s
 * @returns {string}
 */
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Count markers matched as whole tokens (word-boundary).
 * v4.7.2 (P1-2): replaces `lowerOutput.includes(m)` substring match which
 * fired on `terraformatter` for `traceback`, `application` for `cannot`, etc.
 *
 * @param {string} output - Raw output string (case preserved for line filter)
 * @param {string[]} markers - Lowercase marker phrases
 * @param {{ excludeNegations?: boolean }} [opts]
 * @returns {number} Number of distinct markers matched in `output`
 */
function countMarkers(output, markers, opts = {}) {
  if (!output) return 0;
  const lines = opts.excludeNegations
    ? output.split(/\r?\n/).filter((line) => {
      const lower = line.toLowerCase();
      return !ERROR_NEGATION_PHRASES.some((p) => lower.includes(p));
    })
    : null;
  const haystack = (lines === null ? output : lines.join('\n')).toLowerCase();
  return markers.reduce((count, m) => {
    // Word-boundary on both ends prevents `error` matching `errorless` /
    // `terraformatter`, `cannot` matching `cannotation`, etc. Single-word
    // markers also match their `(s|es)` plural form so `error` still hits on
    // `2 errors found` — preserves the legitimate signal the original
    // substring-match captured.
    const escaped = escapeRegex(m);
    const isSingleWord = !/\s/.test(m);
    const tail = isSingleWord ? '(?:s|es)?' : '';
    const re = new RegExp(`(?:^|[^a-z0-9_])${escaped}${tail}(?:[^a-z0-9_]|$)`, 'i');
    return count + (re.test(haystack) ? 1 : 0);
  }, 0);
}

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

  // --- Component scores ---

  // a) Completion score (P1-2: word-boundary + error-negation filter)
  const successHits = countMarkers(output, SUCCESS_MARKERS);
  const errorHits   = countMarkers(output, ERROR_MARKERS, { excludeNegations: true });
  const partialHits = countMarkers(output, PARTIAL_MARKERS);

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
// Config gate
// ---------------------------------------------------------------------------

/**
 * Read learning.collectAgentExperience from artibot.config.json.
 * Default: true (preserve existing behavior). Returns false explicitly only
 * when the key is set to `false` — any parse error or missing key keeps the
 * pipeline enabled so opt-out is explicit, not accidental.
 *
 * @returns {boolean}
 */
function isAgentExperienceCollectionEnabled() {
  try {
    const configPath = path.join(PLUGIN_ROOT, 'artibot.config.json');
    if (!existsSync(configPath)) return true;
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    return config?.learning?.collectAgentExperience !== false;
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function main() {
  const raw = await readStdin();
  const hookData = parseJSON(raw);

  if (!hookData) return;

  const agentId   = extractAgentId(hookData);
  const agentRole = extractAgentRole(hookData);

  const { score, breakdown, summary } = evaluateAgent(hookData);

  // Extract the explicit agent_type field (v2.1.69+) for finer classification
  const agentType = hookData?.agent_type || agentRole;

  // Feed into lifelong learning pipeline (gated to skip ~200-500ms cold-start
  // dynamic import on every SubagentStop — accumulates in /team parallel).
  // Default true preserves prior behavior; set learning.collectAgentExperience=false
  // in artibot.config.json to opt out.
  if (isAgentExperienceCollectionEnabled()) {
    try {
      const lifelongPath = path.join(PLUGIN_ROOT, 'lib', 'learning', 'lifelong-learner.js');
      const { collectExperience } = await import(toFileUrl(lifelongPath));
      await collectExperience({
        type: 'agent',
        category: agentRole,
        data: {
          agentId,
          agentType,
          score,
          summary,
          ...breakdown,
        },
      });
    } catch (err) {
      logHookError('agent-evaluator', 'learning pipeline unavailable', err);
    }
  }

  writeStdout({
    message: `[agent-evaluator] ${agentId} (${agentRole}/${agentType}) scored ${score} (${summary}) | tools=${breakdown.toolUses} output=${breakdown.outputLength}chars`,
  });
}

// Direct-run guard: importing this module (tests) must not execute the hook.
// main() blocks on stdin, so an import both hangs the importer and fires the
// hook's side effects. Production is unaffected — the dispatcher (or Claude
// Code) spawns this file as argv[1], so the guard passes there.
const isDirectRun = process.argv[1]
  && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isDirectRun) {
  main().catch(createErrorHandler('agent-evaluator', { exit: true }));
}
