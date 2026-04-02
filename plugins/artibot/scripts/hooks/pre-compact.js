#!/usr/bin/env node
/**
 * PreCompact hook.
 * Generates a structured compaction summary preserving key metadata
 * before context window compression. Saves state snapshot and emits
 * a summary that helps the model resume without asking "where were we?"
 * @module scripts/hooks/pre-compact
 */

import { parseJSON, readStdin, writeStdout } from '../utils/index.js';
import path from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createErrorHandler, getClaudeDir, getStatePath, logHookError } from '../../lib/core/hook-utils.js';

const HOOK_NAME = 'pre-compact';
const log = (msg) => process.stderr.write(`[artibot:${HOOK_NAME}] ${msg}\n`);

const PENDING_KEYWORDS = /\b(todo|next|pending|remaining|blocked|in.?progress)\b/i;
const FILE_PATH_PATTERN = /(?:^|[\s"'`(])([a-zA-Z0-9_./-]+\/[a-zA-Z0-9_.-]+\.[a-zA-Z]{1,10})(?:[\s"'`):,]|$)/g;
const MAX_RECENT_REQUESTS = 3;
const MAX_KEY_FILES = 8;
const TRUNCATE_LEN = 160;

// -------------------------------------------------------------------------
// Metadata Extractors
// -------------------------------------------------------------------------

/**
 * Count messages by role.
 * @param {object[]} messages
 * @returns {{ user: number, assistant: number, tool: number }}
 */
function extractScope(messages) {
  const scope = { user: 0, assistant: 0, tool: 0 };
  for (const msg of messages) {
    const role = msg.role || msg.type || 'unknown';
    if (role === 'user') scope.user++;
    else if (role === 'assistant') scope.assistant++;
    else if (role === 'tool' || role === 'tool_result') scope.tool++;
  }
  return scope;
}

/**
 * Extract unique tool names from messages.
 * @param {object[]} messages
 * @returns {string[]}
 */
function extractToolsMentioned(messages) {
  const tools = new Set();
  for (const msg of messages) {
    const name = msg.tool_name || msg.name || '';
    if (name) tools.add(name);
  }
  return [...tools].sort();
}

/**
 * Get the most recent user requests, truncated.
 * @param {object[]} messages
 * @returns {string[]}
 */
function extractRecentRequests(messages) {
  const userMsgs = messages
    .filter((m) => (m.role || m.type) === 'user' && m.content)
    .map((m) => typeof m.content === 'string' ? m.content : JSON.stringify(m.content));

  return userMsgs
    .slice(-MAX_RECENT_REQUESTS)
    .map((text) => text.length > TRUNCATE_LEN ? text.slice(0, TRUNCATE_LEN) + '...' : text);
}

/**
 * Infer pending work from message content.
 * @param {object[]} messages
 * @returns {string[]}
 */
function extractPendingWork(messages) {
  const pending = [];
  const recent = messages.slice(-20);

  for (const msg of recent) {
    const text = typeof msg.content === 'string' ? msg.content : '';
    if (!PENDING_KEYWORDS.test(text)) continue;

    const lines = text.split('\n');
    for (const line of lines) {
      if (PENDING_KEYWORDS.test(line)) {
        const trimmed = line.trim().slice(0, TRUNCATE_LEN);
        if (trimmed.length > 10) pending.push(trimmed);
      }
    }
  }
  return [...new Set(pending)].slice(0, 5);
}

/**
 * Extract file paths mentioned in messages (max 8).
 * @param {object[]} messages
 * @returns {string[]}
 */
function extractKeyFiles(messages) {
  const files = new Set();
  for (const msg of messages) {
    const text = typeof msg.content === 'string' ? msg.content : '';
    FILE_PATH_PATTERN.lastIndex = 0;
    let match;
    while ((match = FILE_PATH_PATTERN.exec(text)) !== null) {
      files.add(match[1]);
      if (files.size >= MAX_KEY_FILES) break;
    }
    if (files.size >= MAX_KEY_FILES) break;
  }
  return [...files];
}

/**
 * Infer current work from the last non-empty assistant message.
 * @param {object[]} messages
 * @returns {string}
 */
function extractCurrentWork(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if ((msg.role || msg.type) !== 'assistant') continue;
    const text = typeof msg.content === 'string' ? msg.content.trim() : '';
    if (text.length > 20) {
      return text.length > TRUNCATE_LEN ? text.slice(0, TRUNCATE_LEN) + '...' : text;
    }
  }
  return '';
}

// -------------------------------------------------------------------------
// Tag Processing
// -------------------------------------------------------------------------

/**
 * Strip analysis tags, preserve summary tags.
 * @param {string} text
 * @returns {string}
 */
function processTagsInContent(text) {
  return text.replace(/<analysis>[\s\S]*?<\/analysis>/g, '');
}

/**
 * Estimate token count using chars/4 + 1 heuristic.
 * @param {string} text
 * @returns {number}
 */
function estimateTokens(text) {
  return Math.ceil(text.length / 4) + 1;
}

// -------------------------------------------------------------------------
// Summary Builder
// -------------------------------------------------------------------------

/**
 * Build the structured compaction summary.
 * @param {object[]} messages
 * @returns {object}
 */
function buildCompactionSummary(messages) {
  const processed = messages.map((msg) => {
    if (typeof msg.content !== 'string') return msg;
    return { ...msg, content: processTagsInContent(msg.content) };
  });

  return {
    scope: extractScope(processed),
    tools_mentioned: extractToolsMentioned(processed),
    recent_requests: extractRecentRequests(processed),
    pending_work: extractPendingWork(processed),
    key_files: extractKeyFiles(processed),
    current_work: extractCurrentWork(processed),
  };
}

/**
 * Format the summary as a human-readable compaction preamble.
 * @param {object} summary
 * @param {number} tokenEstimate
 * @returns {string}
 */
function formatSummaryMessage(summary, tokenEstimate) {
  const lines = [
    '[compact] Structured compaction summary generated.',
    `  Messages: ${summary.scope.user}u/${summary.scope.assistant}a/${summary.scope.tool}t`,
    `  Tools used: ${summary.tools_mentioned.length > 0 ? summary.tools_mentioned.join(', ') : 'none'}`,
    `  Key files: ${summary.key_files.length > 0 ? summary.key_files.join(', ') : 'none'}`,
    `  Pending items: ${summary.pending_work.length}`,
    `  Est. tokens before compact: ~${tokenEstimate}`,
  ];

  if (summary.current_work) {
    lines.push(`  Current work: ${summary.current_work.slice(0, 80)}...`);
  }

  return lines.join('\n');
}

/**
 * Load current artibot state from disk.
 * @param {string} statePath
 * @returns {object}
 */
function loadCurrentState(statePath) {
  if (!existsSync(statePath)) return {};
  try {
    return JSON.parse(readFileSync(statePath, 'utf-8'));
  } catch {
    return {};
  }
}

// -------------------------------------------------------------------------
// Main
// -------------------------------------------------------------------------

async function main() {
  const raw = await readStdin();
  const hookData = parseJSON(raw) ?? {};

  const claudeDir = getClaudeDir();
  const statePath = getStatePath();
  const compactBackupPath = path.join(claudeDir, 'artibot-pre-compact.json');

  const currentState = loadCurrentState(statePath);

  // Extract messages from hookData
  const messages = hookData?.messages || hookData?.conversation || [];
  const summary = buildCompactionSummary(messages);

  // Estimate total tokens from raw content
  const totalText = messages
    .map((m) => typeof m.content === 'string' ? m.content : '')
    .join('');
  const tokenEstimate = estimateTokens(totalText);

  // Save snapshot before compaction
  const snapshot = {
    savedAt: new Date().toISOString(),
    reason: 'pre-compact',
    state: currentState,
    summary,
    tokenEstimate,
    suppress_follow_up_questions: true,
  };

  try {
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(compactBackupPath, JSON.stringify(snapshot, null, 2), 'utf-8');

    const message = formatSummaryMessage(summary, tokenEstimate);
    log(message);

    writeStdout({
      systemMessage: message,
    });
  } catch (err) {
    logHookError(HOOK_NAME, 'Failed to save snapshot', err);
  }
}

main().catch(createErrorHandler(HOOK_NAME));
