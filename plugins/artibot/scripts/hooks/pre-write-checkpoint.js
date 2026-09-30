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
import { isMainEntry, tapDirectFiring } from './_main-entry.js';

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

/**
 * PASS IS PASSTHROUGH, NOT APPROVAL (CA-04, security). This hook takes a
 * snapshot and decides NOTHING: it writes zero bytes to stdout and exits 0, so
 * the host's own permission flow decides. It used to print
 * `{decision:'approve'}` after every snapshot, and the host reads that as
 * `allow` and skips the permission prompt (measured on host 2.1.284, in default,
 * acceptEdits and dontAsk mode). The contract and its ratchet live in
 * `tests/hooks/pretooluse-passthrough.test.js`.
 */
async function main() {
  const raw = await readStdin();
  const hookData = tapDirectFiring(import.meta.url, parseJSON(raw));

  const toolName = extractToolName(hookData) || '';
  if (toolName !== 'Write' && toolName !== 'Edit') {
    return; // PASSTHROUGH: not this hook's tool, no decision.
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
  // PASSTHROUGH: the snapshot is the whole job; no decision is written.
}

if (isMainEntry(import.meta.url)) {
  // NOTE: `createErrorHandler` prints a BLOCK whenever it is given a
  // `blockReason`, so this tail fails closed even though the wording below says
  // "Approving". Both the behaviour and the string are unchanged by CA-04 and
  // pinned byte-for-byte in tests/hooks/pretooluse-passthrough.test.js.
  main().catch(createErrorHandler('pre-write-checkpoint', {
    writeStdout,
    blockReason: 'File checkpoint hook error. Approving by default.',
  }));
}
