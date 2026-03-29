#!/usr/bin/env node
/**
 * PreToolUse hook for Write/Edit — automatic file checkpoint.
 * Snapshots the target file before any write/edit operation so it can
 * be restored later via FileCheckpoint.
 */

import { existsSync } from 'node:fs';
import { parseJSON, readStdin, writeStdout } from '../utils/index.js';
import { extractToolName } from '../../lib/core/hook-utils.js';
import { createErrorHandler } from '../../lib/core/hook-utils.js';
import { FileCheckpoint } from '../../lib/core/file-checkpoint.js';

/** Session-scoped checkpoint instance (reused across invocations via same session). */
const SESSION_ID = process.env.CLAUDE_SESSION_ID || 'default';
const checkpoint = new FileCheckpoint(SESSION_ID);

async function main() {
  const raw = await readStdin();
  const hookData = parseJSON(raw);

  const toolName = extractToolName(hookData) || '';
  if (toolName !== 'Write' && toolName !== 'Edit') {
    writeStdout({ decision: 'approve' });
    return;
  }

  const filePath = hookData?.tool_input?.file_path
    || hookData?.tool_input?.path
    || null;

  if (filePath && existsSync(filePath)) {
    try {
      checkpoint.snapshot(filePath);
      process.stderr.write(
        `[pre-write-checkpoint] Snapshot saved: ${filePath}\n`,
      );
    } catch (err) {
      process.stderr.write(
        `[pre-write-checkpoint] Snapshot failed: ${err.message}\n`,
      );
    }
  }

  writeStdout({ decision: 'approve' });
}

main().catch(createErrorHandler('pre-write-checkpoint', {
  writeStdout,
  blockReason: 'File checkpoint hook error. Approving by default.',
}));
