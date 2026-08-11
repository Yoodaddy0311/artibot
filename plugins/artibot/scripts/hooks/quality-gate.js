#!/usr/bin/env node
/**
 * PostToolUse hook: Quality gate for Edit/Write operations.
 * Thin wrapper delegating to guard-registry.
 */

import { parseJSON, readStdin, writeStdout } from '../utils/index.js';
import { createErrorHandler, extractToolName } from '../../lib/core/hook-utils.js';
import { executeChain, registerBuiltinGuards, resetGuards } from '../../lib/core/guard-registry.js';
import { isMainEntry } from './_main-entry.js';

export async function main() {
  const raw = await readStdin();
  const hookData = parseJSON(raw);

  if (!hookData) return;

  const toolName = extractToolName(hookData);
  if (toolName !== 'Edit' && toolName !== 'Write') return;

  resetGuards();
  registerBuiltinGuards();

  const result = executeChain('post', toolName, hookData, {
    cwd: hookData?.cwd || process.cwd(),
  });

  if (result.decision === 'block') {
    writeStdout({
      decision: 'block',
      reason: result.reason,
    });
  } else if (result.warnings.length > 0) {
    const lines = ['[quality-gate] WARNINGS:'];
    for (const warn of result.warnings) {
      lines.push(`  - ${warn}`);
    }
    writeStdout({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: lines.join('\n'),
      },
    });
  }
}

// Direct-run guard: importing this module (tests) must not execute the hook.
// main() blocks on stdin, so an import both hangs the importer and fires the
// hook's side effects. Production is unaffected — the dispatcher (or Claude
// Code) spawns this file as argv[1], so the guard passes there.
if (isMainEntry(import.meta.url)) {
  main().catch(createErrorHandler('quality-gate', { exit: true }));
}
