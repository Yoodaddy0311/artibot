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
import { isMainEntry } from './_main-entry.js';

/**
 * Resolve the session id for this invocation. The hook stdin payload carries
 * `session_id`; the env var is only a fallback. Without the payload value every
 * checkpoint collapsed under 'default' and collided across sessions.
 * @param {object|null} hookData - Parsed hook input
 * @returns {string}
 */
export function resolveSessionId(hookData) {
  return hookData?.session_id
    || process.env.CLAUDE_SESSION_ID
    || 'default';
}

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
      const checkpoint = new FileCheckpoint(resolveSessionId(hookData));
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

if (isMainEntry(import.meta.url)) {
  main().catch(createErrorHandler('pre-write-checkpoint', {
    writeStdout,
    blockReason: 'File checkpoint hook error. Approving by default.',
  }));
}
