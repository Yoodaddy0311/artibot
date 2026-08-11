#!/usr/bin/env node
/**
 * Stop dispatcher.
 *
 * Consolidates 5 previously-separate Stop hook entries:
 *
 *   1. stop-review-gate.js    (15s) — autoreview / review-gate
 *   2. dev-verify-gate.js     (8s)  — DEV protocol verification
 *   3. git-autopilot-close.js (15s) — autopilot end-of-turn squash/commit
 *   4. stop-recap.js          (5s)  — read-only turn recap (stderr)
 *   5. session-notes.js       (5s)  — SESSION-NOTES.md append
 *
 * Output handling: Claude Code ≥ 2.1.163 honors `hookSpecificOutput.
 * additionalContext` on Stop / SubagentStop (non-blocking soft feedback), in
 * addition to the always-supported `decision: "block"` path. mergeResults
 * concatenates additionalContext from every hook AND forwards the first
 * decision=block, so both the DEV-verify advisory note and any blocking gate
 * survive consolidation. Hooks run in parallel; order does not change the
 * merged result (additionalContext is concatenated in array order, block wins
 * regardless of position). stderr is forwarded as-is (where stop-recap emits
 * its [artibot:recap] line).
 *
 * Loop guard: hooks individually check `stop_hook_active=true` and skip;
 * the dispatcher does NOT re-check because each hook implements its own
 * loop-prevention strategy. We forward the payload as-is.
 *
 * Rollback: ARTIBOT_DISABLE_STOP_DISPATCHER=1 (slot) or
 * ARTIBOT_DISABLE_DISPATCHER=1 (global).
 *
 * @module scripts/hooks/_stop-dispatcher
 */

import {
  createFatalHandler,
  isMainEntry,
  mergeResults,
  parseHookStdout,
  readPayload,
  spawnHook,
} from './_dispatcher-utils.js';
import { loadDispatchTable } from '../../lib/dispatcher/dispatch-table-loader.js';

const HOOK_NAME = '_stop-dispatcher';
const EVENT_NAME = 'Stop';

/**
 * Hook table — loaded from hooks/dispatch-table.json (v4.8.0 P1).
 */
const HOOKS = loadDispatchTable(EVENT_NAME);

export { HOOKS };

async function main() {
  if (
    process.env.ARTIBOT_DISABLE_DISPATCHER === '1' ||
    process.env.ARTIBOT_DISABLE_STOP_DISPATCHER === '1'
  ) {
    process.stderr.write(`[artibot:${HOOK_NAME}] disabled via env\n`);
    return;
  }

  const payload = await readPayload();

  const settled = await Promise.allSettled(
    HOOKS.map((h) =>
      spawnHook(h.script, payload, {
        timeoutMs: h.timeoutMs,
        name: h.name,
        dispatcherName: HOOK_NAME,
      }),
    ),
  );

  const parsed = settled.map((r) => {
    if (r.status !== 'fulfilled') return null;
    return parseHookStdout(r.value.stdout);
  });

  const merged = mergeResults(parsed, EVENT_NAME);
  if (merged) {
    try { process.stdout.write(JSON.stringify(merged)); } catch { /* ignore */ }
  }
}

if (isMainEntry(import.meta.url)) {
  main().catch(createFatalHandler(HOOK_NAME));
}
