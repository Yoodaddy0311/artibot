#!/usr/bin/env node
/**
 * PreToolUse hook for Write/Edit.
 * Thin wrapper delegating to guard-registry, plus an append-only record of the
 * blocks it already makes (T-39).
 *
 * ── OBSERVE CONTRACT (PRD R-03 "행동 변화 0") ────────────────────────────────
 *  Recording only. No new block, no lifted block, no changed `reason` byte; the
 *  append runs AFTER `writeStdout` so bookkeeping cannot delay or alter the
 *  decision, and the approve path records nothing. Canonical statement of the
 *  contract, the cwd rule, and the never-throw guarantee lives in the recorder:
 *  `lib/runtime/human-asked-record.js`.
 *
 * @module scripts/hooks/pre-write
 */

import { parseJSON, readStdin, writeStdout } from '../utils/index.js';
import { createErrorHandler, extractToolName } from '../../lib/core/hook-utils.js';
import { executeChain, registerBuiltinGuards, resetGuards } from '../../lib/core/guard-registry.js';
import { recordHumanAsked } from '../../lib/runtime/human-asked-record.js';
import { isMainEntry } from './_main-entry.js';

/**
 * The fail-closed reason string, unchanged from before this file recorded
 * anything. Named so the tail and the recorder cannot drift apart; the VALUE is
 * frozen by the invariance gate.
 */
const HOOK_ERROR_REASON = 'Safety check failed due to hook error. Blocking by default.';

/**
 * The parsed payload of the turn in flight, kept so the fail-closed tail can
 * describe what it blocked. `null` until stdin is read and parsed — which is
 * also the realistic shape of a hook error, since the failure this tail exists
 * for happens while reading stdin.
 * @type {object|null}
 */
let lastHookData = null;

export async function main() {
  const raw = await readStdin();
  const hookData = parseJSON(raw);
  lastHookData = hookData;

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
    await recordHumanAsked({ hookData, tool: toolName, reason: result.reason });
  } else {
    writeStdout({ decision: 'approve' });
  }
}

/**
 * The fail-closed tail: block on any error the hook could not handle, then
 * record that block like any other. Exported so a test can enter the real
 * production path instead of a copy of it.
 *
 * The tool name is recovered from the payload rather than assumed, but is
 * clamped to the recorder's contract (`'Write' | 'Edit'` here). The tail can
 * fire before the Write/Edit check — a parse failure leaves no payload at all,
 * and the dispatcher may route any tool here — so neither an unknown name nor
 * `null` may reach the recorder. When nothing is recoverable the recorder skips
 * the append anyway (no `cwd`), so `'Write'` is a shape default, not a claim
 * about what was blocked.
 *
 * @param {Error} err
 * @returns {Promise<void>}
 */
export async function handleHookError(err) {
  createErrorHandler('pre-write', {
    writeStdout,
    blockReason: HOOK_ERROR_REASON,
  })(err);
  const errored = extractToolName(lastHookData);
  await recordHumanAsked({
    hookData: lastHookData,
    tool: errored === 'Edit' ? 'Edit' : 'Write',
    reason: HOOK_ERROR_REASON,
  });
}

// Direct-run guard: importing this module (tests) must not execute the hook.
// main() blocks on stdin, so an import both hangs the importer and fires the
// hook's side effects. Production is unaffected — the dispatcher (or Claude
// Code) spawns this file as argv[1], so the guard passes there.
if (isMainEntry(import.meta.url)) {
  main().catch(handleHookError);
}
