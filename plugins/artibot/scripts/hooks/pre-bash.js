#!/usr/bin/env node
/**
 * PreToolUse hook for Bash.
 * Thin wrapper delegating to guard-registry.
 */

import { parseJSON, readStdin, writeStdout } from '../utils/index.js';
import { createErrorHandler } from '../../lib/core/hook-utils.js';
import { executeChain, registerBuiltinGuards, resetGuards } from '../../lib/core/guard-registry.js';

async function main() {
  const raw = await readStdin();
  const hookData = parseJSON(raw);

  resetGuards();
  registerBuiltinGuards();

  const result = executeChain('pre', 'Bash', hookData, {
    cwd: hookData?.cwd || process.cwd(),
  });

  if (result.decision === 'block') {
    writeStdout({ decision: 'block', reason: result.reason });
  } else {
    writeStdout({ decision: 'approve' });
  }
}

main().catch(createErrorHandler('pre-bash', {
  writeStdout,
  blockReason: 'Safety check failed due to hook error. Blocking by default.',
}));
