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
 *  altered by bookkeeping. `tests/firewall/hook-decision-invariance.test.js`
 *  fixes that as a measurement — identical stdout bytes whether the ledger
 *  lands, fails, or is never attempted.
 *
 *  The approve path records NOTHING. Observe is scoped to the block points
 *  (design §3.5 OD-5); an event on every approved command would be a different
 *  feature with a different volume profile.
 *
 * ── WHY THE APPEND CANNOT TAKE THE HOOK DOWN ────────────────────────────────
 *  The ledger modules are loaded with `await import()` inside a try/catch, not
 *  as top-level imports. A top-level import that failed to resolve would kill
 *  the process before it could write ANY decision — the hook would emit nothing
 *  at all, which is worse than fail-closed. `appendLedgerEvent` additionally
 *  never throws by contract (lib/runtime/ledger.js), so the catch here covers
 *  the resolution failure and anything a future refactor adds.
 *
 * ── WHY THE PROJECT ROOT IS NOT DERIVED ─────────────────────────────────────
 *  The root comes from the hook payload's `cwd` and from nowhere else. With no
 *  `cwd` the record is SKIPPED rather than anchored on `process.cwd()`:
 *  Artibot is also installed globally under `~/.claude/`, and a derived root
 *  writes one project's blocked commands into another project's ledger. A
 *  missing record is recoverable; a record filed under the wrong project is a
 *  false history. Claude Code sends `cwd` on every PreToolUse payload, so this
 *  branch is not the production path — see the deviation note in the test.
 *
 * @module scripts/hooks/pre-bash
 */

import { createHash } from 'node:crypto';
import { parseJSON, readStdin, writeStdout } from '../utils/index.js';
import { createErrorHandler } from '../../lib/core/hook-utils.js';
import { executeChain, registerBuiltinGuards, resetGuards } from '../../lib/core/guard-registry.js';
import { isMainEntry } from './_main-entry.js';

/**
 * The fail-closed reason string, unchanged from before this file recorded
 * anything. Named so the tail and the recorder cannot drift apart; the VALUE is
 * frozen by the invariance gate.
 */
const HOOK_ERROR_REASON = 'Safety check failed due to hook error. Blocking by default.';

/**
 * Strictness order of a gate row's `default`. `human-gates.js` deliberately
 * does NOT reduce multiple hits to one row ("Observe 단계에서 축약은 정보
 * 손실이다", lib/security/human-gates.js:31-35), so the full `hits[]` is what
 * the ledger line carries; `gate` is the single strictest id, added on top for
 * readers that need one value.
 */
const GATE_SEVERITY = Object.freeze({ human: 3, policy: 2, auto: 1 });

/**
 * The parsed payload of the turn in flight, kept so the fail-closed tail can
 * describe what it blocked. `null` until stdin is read and parsed — which is
 * also the realistic shape of a hook error, since the failure this tail exists
 * for happens while reading stdin.
 * @type {object|null}
 */
let lastHookData = null;

/**
 * `question_id` format — `q-<sid8>-<sha256(gate|command)[:12]>`.
 *
 * Ruled by the leader for T-39 (2026-09-02) and recorded in the design §0-2
 * correction table: the allowlist makes `question_id` required but no canonical
 * document states how one is issued, so these constants are that format's one
 * home. `sid8` is the session id's first 8 characters, or `nosess` when the
 * payload carries none.
 *
 * DETERMINISTIC on purpose. The same command blocked again in the same session
 * is the same question, and a later `human.resolved` has to be able to find
 * every ask it answers. A random or timestamped id would turn each re-block
 * into a new unanswered question, so the ask-without-resolution signal
 * (design §3.4 OD-5) would read as a backlog that nothing can ever close.
 *
 * The cost is the mirror image: two genuinely separate asks for one command in
 * one session collapse onto one id and are indistinguishable here.
 */
const QUESTION_ID_PREFIX = 'q-';
const QUESTION_ID_SESSION_CHARS = 8;
const QUESTION_ID_HASH_CHARS = 12;
const QUESTION_ID_NO_SESSION = 'nosess';

/**
 * The strictest gate among the hits, or null when there are none.
 *
 * `null` is truthful, not a placeholder: it means the existing blocked-patterns
 * layer caught the command and no HG row claims it. The key is then OMITTED
 * from the event rather than written as null — the allowlist types
 * `human.asked.data.gate` as a string, so a null would make the whole line a
 * `ledger.rejected` and the record would be lost.
 *
 * @param {Array<{id: string}>} hits
 * @param {(id: string) => {default?: string}|null} getGateRow
 * @returns {string|null}
 */
function strictestGate(hits, getGateRow) {
  let best = null;
  let bestScore = 0;
  for (const hit of hits) {
    const score = GATE_SEVERITY[getGateRow(hit.id)?.default] ?? 0;
    if (score > bestScore) {
      bestScore = score;
      best = hit.id;
    }
  }
  return best;
}

/**
 * The join key a later `human.resolved` line points back at. Exported so the
 * format has one testable definition rather than a copy in the gate.
 *
 * The gate is folded into the hash, so the same command reaching a different
 * gate is a different question — the thing being asked changed even though the
 * command did not.
 *
 * @param {string|undefined} sessionId
 * @param {string|null} gate strictest gate id, or null when no row claims it
 * @param {string} command
 * @returns {string}
 */
export function buildQuestionId(sessionId, gate, command) {
  const sid8 = typeof sessionId === 'string' && sessionId.length > 0
    ? sessionId.slice(0, QUESTION_ID_SESSION_CHARS)
    : QUESTION_ID_NO_SESSION;
  const digest = createHash('sha256')
    .update(`${gate ?? ''}|${command}`)
    .digest('hex')
    .slice(0, QUESTION_ID_HASH_CHARS);
  return `${QUESTION_ID_PREFIX}${sid8}-${digest}`;
}

/**
 * Append one `human.asked` line for a block. Best effort in every direction:
 * a failed import, an unwritable ledger, a missing root, or a rejected line all
 * end here silently, because the decision has already been written and nothing
 * this function does may change it.
 *
 * @param {object|null} hookData the payload that was blocked, when known
 * @param {string} reason the reason string sent to stdout, verbatim
 * @returns {Promise<void>}
 */
async function recordBlock(hookData, reason) {
  try {
    const cwd = hookData?.cwd;
    if (typeof cwd !== 'string' || cwd === '') return; // no injected root — see header
    const [gates, ledger, root] = await Promise.all([
      import('../../lib/security/human-gates.js'),
      import('../../lib/runtime/ledger.js'),
      import('../../lib/git/project-root.js'),
    ]);
    const command = typeof hookData?.tool_input?.command === 'string'
      ? hookData.tool_input.command
      : '';
    const hits = command === '' ? [] : gates.classify({ tool: 'Bash', command }).hits;
    const gate = strictestGate(hits, gates.getGateRow);
    const data = {
      question_id: buildQuestionId(hookData?.session_id, gate, command),
      hits: hits.map((hit) => hit.id),
      reason,
      decision: 'block',
    };
    if (gate !== null) data.gate = gate;
    ledger.appendLedgerEvent(root.resolveProjectRoot(cwd), {
      event: 'human.asked',
      session_id: hookData?.session_id,
      source: 'hook',
      data,
    });
  } catch {
    // Recording never changes the decision, and never fails louder than it.
  }
}

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
    await recordBlock(hookData, result.reason);
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
  await recordBlock(lastHookData, HOOK_ERROR_REASON);
}

// Direct-run guard: importing this module (tests) must not execute the hook.
// main() blocks on stdin, so an import both hangs the importer and fires the
// hook's side effects. Production is unaffected — the dispatcher (or Claude
// Code) spawns this file as argv[1], so the guard passes there.
if (isMainEntry(import.meta.url)) {
  main().catch(handleHookError);
}
