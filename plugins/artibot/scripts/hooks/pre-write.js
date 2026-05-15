#!/usr/bin/env node
/**
 * PreToolUse hook for Write/Edit.
 * Thin wrapper delegating to guard-registry.
 */

import { parseJSON, readStdin, writeStdout } from '../utils/index.js';
import { createErrorHandler, extractToolName } from '../../lib/core/hook-utils.js';
import { executeChain, registerBuiltinGuards, resetGuards } from '../../lib/core/guard-registry.js';

async function main() {
  const raw = await readStdin();
  const hookData = parseJSON(raw);

  resetGuards();
  registerBuiltinGuards();

  const toolName = extractToolName(hookData) || '';

  // Only process Write/Edit — other tools should not be handled by this hook
  if (toolName !== 'Write' && toolName !== 'Edit') {
    writeStdout({ decision: 'approve' });
    return;
  }

  // If hookData has a bash command field, this is a misdirected Bash tool call
  if (hookData?.tool_input?.command) {
    writeStdout({ decision: 'approve' });
    return;
  }

  const result = executeChain('pre', toolName, hookData, {
    cwd: hookData?.cwd || process.cwd(),
  });

  if (result.decision === 'block') {
    writeStdout({ decision: 'block', reason: result.reason });
  } else {
    writeStdout({ decision: 'approve' });
  }
}

main().catch(createErrorHandler('pre-write', {
  writeStdout,
  blockReason: 'Safety check failed due to hook error. Blocking by default.',
}));
