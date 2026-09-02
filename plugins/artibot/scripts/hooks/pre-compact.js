#!/usr/bin/env node
/**
 * PreCompact hook.
 * Generates a structured compaction summary preserving key metadata
 * before context window compression. Saves state snapshot and emits
 * a summary that helps the model resume without asking "where were we?"
 * @module scripts/hooks/pre-compact
 */

import { getPluginRoot, parseJSON, readStdin, writeStdout } from '../utils/index.js';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createErrorHandler, getClaudeDir, getStatePath, logHookError } from '../../lib/core/hook-utils.js';
import { isMainEntry } from './_main-entry.js';

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
 * Extract decision statements from assistant messages.
 * Looks for messages containing decision keywords and captures the
 * surrounding sentence for compaction-survival context.
 * @param {object[]} messages
 * @returns {string[]}
 */
function extractDecisionContext(messages) {
  const DECISION_KEYWORDS = /\b(decided|chose|locked|established|confirmed|selected|agreed)\b/i;
  const decisions = [];

  for (const msg of messages) {
    if ((msg.role || msg.type) !== 'assistant') continue;
    const text = typeof msg.content === 'string' ? msg.content : '';
    if (!DECISION_KEYWORDS.test(text)) continue;

    const lines = text.split('\n');
    for (const line of lines) {
      if (DECISION_KEYWORDS.test(line)) {
        const trimmed = line.trim().slice(0, TRUNCATE_LEN);
        if (trimmed.length > 10) decisions.push(trimmed);
      }
    }
  }
  return [...new Set(decisions)].slice(0, 5);
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
    decisions: extractDecisionContext(processed),
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

  if (summary.decisions && summary.decisions.length > 0) {
    lines.push(`  Decisions: ${summary.decisions.length} captured`);
  }

  return lines.join('\n');
}

/**
 * AD-40: capture cwd, current git branch, and `git status --short` so the
 * model can resume after compaction without re-issuing exploratory git
 * commands. All sub-calls wrapped in try/catch — failures must NEVER throw.
 * @returns {{ cwd: string, branch: string, head: string|null, gitStatus: string, capturedAt: string }}
 */
function captureGitState() {
  const cwd = process.cwd();
  const capturedAt = new Date().toISOString();
  let branch = 'unknown';
  let head = null;
  let gitStatus = '';
  try {
    branch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf-8',
      timeout: 2000,
      windowsHide: true,
    }).trim() || 'unknown';
  } catch {
    // Not a git repo or git unavailable — leave default
  }
  try {
    // Additive (vNext PR-CX01): lets post-compact-rehydrate.js report whether
    // the head moved between PreCompact and PostCompact. Never blocks rehydration.
    head = execSync('git rev-parse --short=12 HEAD', {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf-8',
      timeout: 2000,
      windowsHide: true,
    }).trim() || null;
  } catch {
    // Best effort
  }
  try {
    gitStatus = execSync('git status --short', {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf-8',
      timeout: 2000,
      windowsHide: true,
    });
  } catch {
    // Best effort
  }
  return { cwd, branch, head, gitStatus, capturedAt };
}

/**
 * AD-40: write a markdown state snapshot under runtime/state/. The file is
 * intentionally human-readable so anyone resuming a session (human or
 * model) can scan it without parsing JSON. Failures are swallowed.
 * @param {ReturnType<typeof captureGitState>} state
 * @returns {string|null} absolute path of the written file, or null on failure
 */
function writePreCompactState(state) {
  try {
    const repoRoot = path.resolve(getPluginRoot(), '..', '..');
    const dir = path.join(repoRoot, 'runtime', 'state');
    mkdirSync(dir, { recursive: true });
    // Sanitise ISO ts for filesystem (no colons on Windows)
    const fileStamp = state.capturedAt.replace(/[:.]/g, '-');
    const filePath = path.join(dir, `pre-compact-${fileStamp}.md`);
    const safeStatus = (state.gitStatus || '(clean / unavailable)').trimEnd();
    const body = [
      '---',
      `cwd: ${state.cwd}`,
      `branch: ${state.branch}`,
      `ts: ${state.capturedAt}`,
      'event: pre-compact',
      '---',
      '',
      '# Pre-compact state snapshot',
      '',
      '`git status --short`:',
      '',
      '```',
      safeStatus,
      '```',
      '',
    ].join('\n');
    writeFileSync(filePath, body, 'utf-8');
    return filePath;
  } catch {
    return null;
  }
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

export async function main() {
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

  // AD-40: capture git/cwd snapshot for human-readable resume context.
  // Wrapped per-call internally so failures never reach the main flow.
  const gitState = captureGitState();
  const stateFilePath = writePreCompactState(gitState);

  // Save snapshot before compaction
  const snapshot = {
    savedAt: new Date().toISOString(),
    reason: 'pre-compact',
    state: currentState,
    summary,
    tokenEstimate,
    suppress_follow_up_questions: true,
    gitState: {
      cwd: gitState.cwd,
      branch: gitState.branch,
      // Additive (vNext PR-CX01): read by scripts/hooks/post-compact-rehydrate.js
      // together with `sessionId` below; summary logic above is unchanged.
      head: gitState.head,
      hasStatus: Boolean(gitState.gitStatus && gitState.gitStatus.trim().length > 0),
    },
    stateFilePath,
    sessionId: typeof hookData.session_id === 'string' ? hookData.session_id : null,
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

// Direct-run guard: importing this module (tests) must not execute the hook.
// main() blocks on stdin, so an import both hangs the importer and fires the
// hook's side effects. Production is unaffected — the dispatcher (or Claude
// Code) spawns this file as argv[1], so the guard passes there.
if (isMainEntry(import.meta.url)) {
  main().catch(createErrorHandler(HOOK_NAME));
}
