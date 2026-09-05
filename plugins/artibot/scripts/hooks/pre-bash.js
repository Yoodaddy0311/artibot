#!/usr/bin/env node
/**
 * PreToolUse hook for Bash.
 * Thin wrapper delegating to guard-registry, plus an append-only record of the
 * blocks it already makes (T-39).
 *
 * ── OBSERVE CONTRACT (PRD R-03 "행동 변화 0") ────────────────────────────────
 *  This file adds RECORDING ONLY. It creates no new block, lifts no existing
 *  one, and does not touch the bytes on stdout: `decision` and `reason` are
 *  produced exactly where and how they were before, and the ledger append
 *  happens AFTER `writeStdout` so the decision cannot be delayed, reordered, or
 *  altered by bookkeeping. The approve path records NOTHING.
 *  `tests/firewall/hook-decision-invariance.test.js` fixes that as a
 *  measurement — identical stdout bytes whether the ledger lands, fails, or is
 *  never attempted.
 *
 * ── WHERE THE RECORDING CONTRACT LIVES ──────────────────────────────────────
 *  The recorder moved to `lib/runtime/human-asked-record.js` when the write
 *  side needed the same behaviour. Its header is the CANONICAL text for why the
 *  append cannot take the hook down (dynamic import inside try/catch), why the
 *  project root is never derived from `process.cwd()`, and how a `question_id`
 *  is formed. This pointer is deliberately not a second copy of any of it — two
 *  copies of a contract are two contracts.
 *
 * @module scripts/hooks/pre-bash
 */

import { parseJSON, readStdin, writeStdout } from '../utils/index.js';
import { createErrorHandler } from '../../lib/core/hook-utils.js';
import { executeChain, registerBuiltinGuards, resetGuards } from '../../lib/core/guard-registry.js';
import { recordHumanAsked } from '../../lib/runtime/human-asked-record.js';
import { isMainEntry } from './_main-entry.js';

/**
 * Re-exported, not reimplemented: `question_id` keeps ONE definition repo-wide
 * while `tests/firewall/hook-decision-invariance.test.js` continues to import
 * it from the hook it guards. The implementation moved to the recorder; the
 * name available here did not.
 */
export { buildQuestionId } from '../../lib/runtime/human-asked-record.js';

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

/**
 * Read the payload, run the guard chain, write the decision.
 * @returns {Promise<void>}
 */
export async function main() {
  const raw = await readStdin();
  const hookData = parseJSON(raw);
  lastHookData = hookData;

  resetGuards();
  registerBuiltinGuards();

  const result = executeChain('pre', 'Bash', hookData, {
    cwd: hookData?.cwd || process.cwd(),
  });

  if (result.decision === 'block') {
    writeStdout({ decision: 'block', reason: result.reason });
    await recordHumanAsked({ hookData, tool: 'Bash', reason: result.reason });
  } else {
    writeStdout({ decision: 'approve' });
  }
}

/**
 * The fail-closed tail: block on any error the hook could not handle, then
 * record that block like any other. Exported so a test can enter the real
 * production path instead of a copy of it.
 *
 * @param {Error} err
 * @returns {Promise<void>}
 */
export async function handleHookError(err) {
  createErrorHandler('pre-bash', {
    writeStdout,
    blockReason: HOOK_ERROR_REASON,
  })(err);
  await recordHumanAsked({ hookData: lastHookData, tool: 'Bash', reason: HOOK_ERROR_REASON });
}

// Direct-run guard: importing this module (tests) must not execute the hook.
// main() blocks on stdin, so an import both hangs the importer and fires the
// hook's side effects. Production is unaffected — the dispatcher (or Claude
// Code) spawns this file as argv[1], so the guard passes there.
if (isMainEntry(import.meta.url)) {
  main().catch(handleHookError);
}
