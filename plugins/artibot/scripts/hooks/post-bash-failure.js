#!/usr/bin/env node
/**
 * PostToolUse hook: Bash failure auto-recovery suggester.
 *
 * Detects non-zero exit from Bash tool calls and classifies the command into
 * known recoverable categories (build / test / lint / typecheck). When a match
 * is found, emits a machine-readable suggestion token so the orchestrator can
 * auto-invoke the `build-error-resolver` agent.
 *
 * Output is strictly advisory (no `decision: block`). Timeouts ≤ 3 s.
 *
 * @module scripts/hooks/post-bash-failure
 */

import { parseJSON, readStdin, writeStdout } from '../utils/index.js';
import { createErrorHandler, extractToolName } from '../../lib/core/hook-utils.js';

/**
 * Recoverable command categories. First matching entry wins.
 * Patterns are lowercase substrings tested against the command string.
 *
 * Order matters: more specific patterns (typecheck) are evaluated before
 * more general ones (build) when they share a prefix like `tsc`.
 * @type {Array<{ category: string, patterns: string[] }>}
 */
const RECOVERY_CATEGORIES = [
  {
    category: 'typecheck',
    patterns: ['npm run typecheck', 'yarn typecheck', 'pnpm typecheck', 'tsc --noemit', 'tsc -noemit'],
  },
  {
    category: 'build',
    patterns: ['npm run build', 'yarn build', 'pnpm build', 'npx tsc', 'tsc -p', 'tsc --project'],
  },
  {
    category: 'test',
    patterns: ['npm test', 'npm run test', 'yarn test', 'pnpm test', 'vitest', 'jest', 'mocha'],
  },
  {
    category: 'lint',
    patterns: ['npm run lint', 'yarn lint', 'pnpm lint', 'eslint', 'biome check'],
  },
];

/**
 * Extract exit code from hook data. Checks several known shapes emitted by
 * different Claude Code versions: exit_code, exitCode, returncode.
 * @param {object} hookData
 * @returns {number|null}
 */
export function extractExitCode(hookData) {
  const candidates = [
    hookData?.tool_response?.exit_code,
    hookData?.tool_response?.exitCode,
    hookData?.tool_response?.returncode,
    hookData?.tool_result?.exit_code,
    hookData?.tool_result?.exitCode,
    hookData?.tool_result?.returncode,
    hookData?.exit_code,
  ];
  for (const value of candidates) {
    if (typeof value === 'number') return value;
  }
  return null;
}

/**
 * Extract the command/script string from hook data.
 * PowerShell tool emits the user-supplied program under tool_input.script,
 * while Bash uses tool_input.command. Either is treated identically.
 * @param {object} hookData
 * @returns {string}
 */
export function extractCommand(hookData) {
  return hookData?.tool_input?.command || hookData?.tool_input?.script || '';
}

/**
 * Classify a Bash command into a recoverable category.
 * @param {string} command
 * @returns {string|null} category name or null if not recoverable
 */
export function classifyCommand(command) {
  if (!command || typeof command !== 'string') return null;
  const lower = command.toLowerCase();
  for (const { category, patterns } of RECOVERY_CATEGORIES) {
    if (patterns.some((p) => lower.includes(p))) {
      return category;
    }
  }
  return null;
}

/**
 * Build the advisory suggestion message.
 * @param {string} category
 * @returns {string}
 */
export function buildSuggestionMessage(category) {
  return `[artibot:auto-recover suggest=build-error-resolver reason=${category}]`;
}

async function main() {
  const raw = await readStdin();
  const hookData = parseJSON(raw);
  if (!hookData) return;

  const toolName = extractToolName(hookData);
  if (toolName !== 'Bash' && toolName !== 'PowerShell') return;

  const exitCode = extractExitCode(hookData);
  if (exitCode === null || exitCode === 0) return;

  const command = extractCommand(hookData);
  const category = classifyCommand(command);
  if (!category) return;

  const message = buildSuggestionMessage(category);
  process.stderr.write(`[artibot:post-bash-failure] exit=${exitCode} category=${category}\n`);

  writeStdout({ message });
}

main().catch(createErrorHandler('post-bash-failure', { exit: true }));
