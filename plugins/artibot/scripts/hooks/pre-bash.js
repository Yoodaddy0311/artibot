#!/usr/bin/env node
/**
 * PreToolUse hook for Bash.
 * Detects dangerous commands and warns before execution.
 */

import { parseJSON, readStdin, writeStdout } from '../utils/index.js';
import { createErrorHandler } from '../../lib/core/hook-utils.js';

/**
 * Dangerous command patterns with descriptions.
 */
const DANGEROUS_PATTERNS = [
  { pattern: /rm\s+(-\w*r\w*f|--recursive).*\//i, label: 'rm -rf with path' },
  { pattern: /rm\s+-\w*f\w*r.*\//i, label: 'rm -fr with path' },
  { pattern: /rm\s+-\w*[rf]\w*\s+\*/i, label: 'rm with wildcard' },
  { pattern: /sudo\s+rm\s/i, label: 'sudo rm' },
  { pattern: /curl\s+.*\|\s*(sh|bash|zsh|python[23]?|perl|ruby|node)/i, label: 'curl pipe to interpreter' },
  { pattern: /wget\s+.*\|\s*(sh|bash|zsh|python[23]?|perl|ruby|node)/i, label: 'wget pipe to interpreter' },
  { pattern: /git\s+push\s+.*--force/i, label: 'git push --force' },
  { pattern: /git\s+push\s+-f\b/i, label: 'git push -f' },
  { pattern: /git\s+reset\s+--hard/i, label: 'git reset --hard' },
  { pattern: /git\s+clean\s+-\w*f/i, label: 'git clean -f' },
  { pattern: /git\s+checkout\s+\.\s*$/i, label: 'git checkout . (discard all changes)' },
  { pattern: /git\s+restore\s+\.\s*$/i, label: 'git restore . (discard all changes)' },
  { pattern: /git\s+branch\s+-D\b/i, label: 'git branch -D (force delete)' },
  { pattern: /git\s+stash\s+drop/i, label: 'git stash drop' },
  { pattern: /:\s*>\s*\//i, label: 'truncate file' },
  { pattern: /mkfs\./i, label: 'format filesystem' },
  { pattern: /dd\s+if=/i, label: 'dd raw disk write' },
  { pattern: />\s*\/dev\/sd/i, label: 'write to disk device' },
  { pattern: /chmod\s+-R\s+777/i, label: 'chmod 777 recursive' },
  { pattern: /npm\s+publish/i, label: 'npm publish (public registry)' },
  { pattern: /\b(DROP|TRUNCATE)\s+(TABLE|DATABASE)/i, label: 'SQL destructive operation' },
  { pattern: /del\s+\/s/i, label: 'Windows recursive delete' },
  { pattern: /rmdir\s+\/s/i, label: 'Windows recursive rmdir' },
];

/**
 * Normalize a command string to defeat common evasion techniques:
 * - Remove surrounding quotes (single, double, $'...')
 * - Expand simple variable patterns like ${cmd} or $cmd
 * - Remove backslash escapes within the command
 * - Collapse backtick-wrapped subshells
 * - Collapse whitespace
 *
 * @param {string} raw - Original command string
 * @returns {string} Normalized command
 */
function normalizeCommand(raw) {
  let cmd = raw;

  // Strip ANSI escape codes
  // eslint-disable-next-line no-control-regex
  cmd = cmd.replace(/\u001b\[[0-9;]*m/g, '');

  // Replace backtick subshells with their content: `rm` -> rm
  cmd = cmd.replace(/`([^`]*)`/g, '$1');

  // Replace $() subshells with their content: $(rm) -> rm
  cmd = cmd.replace(/\$\(([^)]*)\)/g, '$1');

  // Remove quoting: "rm", 'rm', $'rm' -> rm
  cmd = cmd.replace(/\$?'([^']*)'/g, '$1');
  cmd = cmd.replace(/"([^"]*)"/g, '$1');

  // Remove backslash escapes: r\m -> rm
  cmd = cmd.replace(/\\(.)/g, '$1');

  // Expand simple ${VAR} and $VAR patterns that look like command evasion
  // e.g., r${IFS}m -> r m (whitespace), but also catches literal variable refs
  cmd = cmd.replace(/\$\{[^}]*\}/g, ' ');
  cmd = cmd.replace(/\$[A-Za-z_][A-Za-z0-9_]*/g, ' ');

  // Collapse whitespace
  cmd = cmd.replace(/\s+/g, ' ').trim();

  return cmd;
}

async function main() {
  const raw = await readStdin();
  const hookData = parseJSON(raw);

  const command = hookData?.tool_input?.command || '';
  if (!command) {
    writeStdout({ decision: 'approve' });
    return;
  }

  // Test both original and normalized forms to catch evasion
  const normalized = normalizeCommand(command);
  const variants = [command, normalized];

  for (const { pattern, label } of DANGEROUS_PATTERNS) {
    for (const variant of variants) {
      if (pattern.test(variant)) {
        writeStdout({
          decision: 'block',
          reason: `DANGEROUS COMMAND DETECTED: "${label}". Command: "${command}". This operation is blocked for safety. Override by removing this hook if intentional.`,
        });
        return;
      }
    }
  }

  writeStdout({ decision: 'approve' });
}

main().catch(createErrorHandler('pre-bash', {
  writeStdout,
  blockReason: 'Safety check failed due to hook error. Blocking by default.',
}));
