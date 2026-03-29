#!/usr/bin/env node
/**
 * PostToolUse hook: Edit/Write error recovery.
 * Detects common Edit/Write failure patterns in tool output and injects
 * a recovery reminder via stderr, guiding the agent to re-read the file
 * and retry with corrected input.
 *
 * Inspired by oh-my-opencode's edit-error-recovery hook.
 *
 * Attached to PostToolUse for Edit and Write tools.
 */

import { parseJSON, readStdin, writeStdout } from '../utils/index.js';
import { createErrorHandler, extractToolName } from '../../lib/core/hook-utils.js';

/**
 * Known failure patterns in Edit/Write tool output.
 * Each entry has a pattern (case-insensitive substring) and a recovery hint.
 * @type {Array<{ pattern: string, hint: string }>}
 */
const FAILURE_PATTERNS = [
  {
    pattern: 'old_string not found',
    hint: 'old_string was not found in the file. The content may have changed or your assumption was wrong.',
  },
  {
    pattern: 'oldstring not found',
    hint: 'oldString was not found in the file. The content may have changed or your assumption was wrong.',
  },
  {
    pattern: 'not unique',
    hint: 'The search string matched multiple locations. Provide more surrounding context to make it unique.',
  },
  {
    pattern: 'found multiple times',
    hint: 'The search string matched multiple locations. Provide more surrounding context to make it unique.',
  },
  {
    pattern: 'file not found',
    hint: 'The target file does not exist. Verify the path before retrying.',
  },
  {
    pattern: 'does not exist',
    hint: 'The target file does not exist. Verify the path before retrying.',
  },
];

/**
 * Match tool output against known failure patterns.
 * @param {string} output - The tool output / error text
 * @returns {{ pattern: string, hint: string } | null} First matching entry, or null
 */
export function matchFailurePattern(output) {
  if (!output || typeof output !== 'string') return null;
  const lower = output.toLowerCase();
  for (const entry of FAILURE_PATTERNS) {
    if (lower.includes(entry.pattern)) {
      return entry;
    }
  }
  return null;
}

/**
 * Build the recovery message shown to the agent.
 * @param {string} toolName - 'Edit' or 'Write'
 * @param {string} hint - Specific failure hint
 * @returns {string}
 */
export function buildRecoveryMessage(toolName, hint) {
  return [
    `[edit-recovery] ${toolName} failed: ${hint}`,
    'Action required:',
    '  1. Read the file to see its actual current state',
    '  2. Retry with the correct content based on what you read',
  ].join('\n');
}

async function main() {
  const raw = await readStdin();
  const hookData = parseJSON(raw);
  if (!hookData) return;

  const toolName = extractToolName(hookData);
  if (toolName !== 'Edit' && toolName !== 'Write') return;

  const toolOutput = hookData.tool_output
    ?? hookData.tool_result
    ?? hookData.output
    ?? '';
  const outputText = typeof toolOutput === 'string'
    ? toolOutput
    : JSON.stringify(toolOutput);

  const match = matchFailurePattern(outputText);
  if (!match) return;

  const message = buildRecoveryMessage(toolName, match.hint);

  process.stderr.write(`[artibot:post-edit-recovery] ${match.hint}\n`);

  writeStdout({ message });
}

main().catch(createErrorHandler('post-edit-recovery', { exit: true }));
