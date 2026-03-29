#!/usr/bin/env node
/**
 * Notification hook: Context Token Tracker.
 * Estimates and tracks context window token usage per session.
 * Outputs usage summary to stderr and passes input through to stdout.
 *
 * Runs on every Notification event. Persists per-session state to
 * /tmp/artibot-context-tracker-{sessionId}.json for delta tracking.
 */

import { existsSync, readFileSync } from 'node:fs';
import { parseJSON, readStdin, writeStdout, atomicWriteSync } from '../utils/index.js';
import { createErrorHandler, logHookError } from '../../lib/core/hook-utils.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default max context window size (128K tokens). */
const DEFAULT_MAX_TOKENS = 128_000;

/** Heuristic: average chars per token for mixed English/code content. */
const CHARS_PER_TOKEN = 4;

/** Threshold percentages for warnings. */
const WARN_THRESHOLD = 0.70;
const CRITICAL_THRESHOLD = 0.90;

// ---------------------------------------------------------------------------
// Token Estimation
// ---------------------------------------------------------------------------

/**
 * Estimate token count from a context_window object or raw input length.
 * Prefers explicit values when available; falls back to char-based heuristic.
 * @param {object|null} contextWindow - context_window from hook data
 * @param {string} rawInput - Raw stdin string for fallback estimation
 * @returns {{ current: number, max: number }}
 */
export function estimateTokens(contextWindow, rawInput) {
  const max = contextWindow?.max_tokens ?? DEFAULT_MAX_TOKENS;

  if (contextWindow?.current_tokens !== null && contextWindow?.current_tokens !== undefined) {
    return { current: contextWindow.current_tokens, max };
  }

  // Fallback: estimate from raw input string length
  const current = Math.ceil((rawInput?.length || 0) / CHARS_PER_TOKEN);
  return { current, max };
}

/**
 * Calculate usage percentage (0-100) from current and max tokens.
 * @param {number} current
 * @param {number} max
 * @returns {number}
 */
export function calcUsagePercent(current, max) {
  if (max <= 0) return 0;
  return Math.min((current / max) * 100, 100);
}

/**
 * Calculate delta between current and previous token counts.
 * @param {number} current
 * @param {number|null} previous
 * @returns {number}
 */
export function calcDelta(current, previous) {
  if (previous === null || previous === undefined) return 0;
  return current - previous;
}

// ---------------------------------------------------------------------------
// Session State Persistence
// ---------------------------------------------------------------------------

/**
 * Get the session state file path.
 * Uses OS temp directory for ephemeral per-session data.
 * @param {string} sessionId
 * @returns {string}
 */
export function getSessionFilePath(sessionId) {
  const tmpDir = process.env.TMPDIR || process.env.TEMP || '/tmp';
  return `${tmpDir}/artibot-context-tracker-${sessionId}.json`;
}

/**
 * Load previous session state from disk.
 * @param {string} sessionId
 * @returns {{ previousTokens: number|null, turnCount: number }}
 */
export function loadSessionState(sessionId) {
  if (!sessionId) return { previousTokens: null, turnCount: 0 };

  const filePath = getSessionFilePath(sessionId);
  try {
    if (!existsSync(filePath)) return { previousTokens: null, turnCount: 0 };
    const data = JSON.parse(readFileSync(filePath, 'utf-8'));
    return {
      previousTokens: data.currentTokens ?? null,
      turnCount: data.turnCount ?? 0,
    };
  } catch {
    return { previousTokens: null, turnCount: 0 };
  }
}

/**
 * Save current session state to disk.
 * @param {string} sessionId
 * @param {number} currentTokens
 * @param {number} turnCount
 */
export function saveSessionState(sessionId, currentTokens, turnCount) {
  if (!sessionId) return;

  const filePath = getSessionFilePath(sessionId);
  atomicWriteSync(filePath, {
    sessionId,
    currentTokens,
    turnCount,
    updatedAt: new Date().toISOString(),
  });
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * Format a number with thousand separators.
 * @param {number} n
 * @returns {string}
 */
export function formatNumber(n) {
  return n.toLocaleString('en-US');
}

/**
 * Build the context status message for stderr output.
 * @param {number} current - Current token count
 * @param {number} max - Max token count
 * @param {number} delta - Token delta from previous turn
 * @returns {string}
 */
export function buildStatusMessage(current, max, delta) {
  const percent = calcUsagePercent(current, max);
  const remaining = Math.max(max - current, 0);
  const deltaStr = delta >= 0 ? `+${formatNumber(delta)}` : formatNumber(delta);

  let line = `\u{1F4CA} Context: ~${formatNumber(current)} tokens (${percent.toFixed(1)}% used, ~${formatNumber(remaining)} remaining) | \u0394${deltaStr}`;

  if (percent >= CRITICAL_THRESHOLD * 100) {
    line += `\n\u{1F6A8} Context 90%+ \u2014 compact urgently!`;
  } else if (percent >= WARN_THRESHOLD * 100) {
    line += `\n\u26A0\uFE0F Context 70%+ \u2014 consider /compact`;
  }

  return line;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const raw = await readStdin();
  const hookData = parseJSON(raw);

  // Pass-through: always output the original input
  if (hookData) {
    writeStdout(hookData);
  }

  // Extract session ID and context window info
  const sessionId = hookData?.session_id || 'unknown';
  const contextWindow = hookData?.context_window || null;

  // Estimate tokens
  const { current, max } = estimateTokens(contextWindow, raw);

  // Load previous state and calculate delta
  const { previousTokens, turnCount } = loadSessionState(sessionId);
  const delta = calcDelta(current, previousTokens);

  // Save updated state
  const newTurnCount = turnCount + 1;
  try {
    saveSessionState(sessionId, current, newTurnCount);
  } catch (err) {
    logHookError('context-tracker', 'failed to save session state', err);
  }

  // Output status to stderr
  const status = buildStatusMessage(current, max, delta);
  process.stderr.write(`[artibot:context-tracker] ${status}\n`);
}

main().catch(createErrorHandler('context-tracker'));
