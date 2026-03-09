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

  const toolName = extractToolName(hookData) || 'Write';
  const result = executeChain('pre', toolName, hookData);

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
