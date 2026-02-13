#!/usr/bin/env node
/**
 * PreToolUse hook for Bash.
 * Detects dangerous commands and warns before execution.
 */

import { readStdin, writeStdout, parseJSON } from '../utils/index.js';

/**
 * Dangerous command patterns with descriptions.
 */
const DANGEROUS_PATTERNS = [
  { pattern: /rm\s+(-\w*r\w*f|--recursive).*\//i, label: 'rm -rf with path' },
  { pattern: /rm\s+-\w*f\w*r.*\//i, label: 'rm -fr with path' },
  { pattern: /git\s+push\s+.*--force/i, label: 'git push --force' },
  { pattern: /git\s+push\s+-f\b/i, label: 'git push -f' },
  { pattern: /git\s+reset\s+--hard/i, label: 'git reset --hard' },
  { pattern: /git\s+clean\s+-\w*f/i, label: 'git clean -f' },
  { pattern: /git\s+checkout\s+\.\s*$/i, label: 'git checkout . (discard all changes)' },
  { pattern: /git\s+restore\s+\.\s*$/i, label: 'git restore . (discard all changes)' },
  { pattern: /git\s+branch\s+-D\b/i, label: 'git branch -D (force delete)' },
  { pattern: /:\s*>\s*\//i, label: 'truncate file' },
  { pattern: /mkfs\./i, label: 'format filesystem' },
  { pattern: /dd\s+if=/i, label: 'dd raw disk write' },
  { pattern: />\s*\/dev\/sd/i, label: 'write to disk device' },
  { pattern: /chmod\s+-R\s+777/i, label: 'chmod 777 recursive' },
  { pattern: /npm\s+publish/i, label: 'npm publish (public registry)' },
];

async function main() {
  const raw = await readStdin();
  const hookData = parseJSON(raw);

  const command = hookData?.tool_input?.command || '';
  if (!command) {
    writeStdout({ decision: 'approve' });
    return;
  }

  for (const { pattern, label } of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) {
      writeStdout({
        decision: 'block',
        reason: `DANGEROUS COMMAND DETECTED: "${label}". Command: "${command}". This operation is blocked for safety. Override by removing this hook if intentional.`,
      });
      return;
    }
  }

  writeStdout({ decision: 'approve' });
}

main().catch((err) => {
  process.stderr.write(`[artibot:pre-bash] ${err.message}\n`);
  writeStdout({ decision: 'approve' });
});
