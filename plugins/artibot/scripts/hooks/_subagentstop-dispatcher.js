#!/usr/bin/env node
/**
 * SubagentStop dispatcher.
 *
 * Consolidates 3 previously-separate SubagentStop hook entries:
 *
 *   1. subagent-handler.js stop          (5s)  — lifecycle close for the
 *                                                completing teammate
 *   2. agent-evaluator.js                (8s)  — post-turn evaluation /
 *                                                scoring of the subagent
 *   3. workflow-status.js teammate-update (5s) — workflow / status surface
 *                                                refresh on team boards
 *
 * Ordering safety: SubagentStop ignores `additionalContext` per Claude Code
 * schema (same as Stop). Hooks are run in parallel; the dispatcher merges
 * any decision=block result and forwards stderr (where evaluator / status
 * surfaces print their [artibot:*] markers).
 *
 * Rollback: ARTIBOT_DISABLE_SUBAGENTSTOP_DISPATCHER=1 (slot) or
 * ARTIBOT_DISABLE_DISPATCHER=1 (global).
 *
 * Exits with code 0 on every failure path — a crashing teammate evaluator
 * must never block the SubagentStop slot for the parent agent.
 *
 * @module scripts/hooks/_subagentstop-dispatcher
 */

import {
  hookPath,
  isMainEntry,
  mergeResults,
  parseHookStdout,
  readPayload,
  spawnHook,
} from './_dispatcher-utils.js';

const HOOK_NAME = '_subagentstop-dispatcher';
const EVENT_NAME = 'SubagentStop';

const HOOKS = [
  { name: 'subagent-handler', script: hookPath('subagent-handler.js'), timeoutMs: 5000, args: ['stop'] },
  { name: 'agent-evaluator',  script: hookPath('agent-evaluator.js'),  timeoutMs: 8000 },
  { name: 'workflow-status',  script: hookPath('workflow-status.js'),  timeoutMs: 5000, args: ['teammate-update'] },
];

export { HOOKS };

async function main() {
  if (
    process.env.ARTIBOT_DISABLE_DISPATCHER === '1' ||
    process.env.ARTIBOT_DISABLE_SUBAGENTSTOP_DISPATCHER === '1'
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
        args: h.args || [],
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
  main().catch((err) => {
    process.stderr.write(`[artibot:${HOOK_NAME}] fatal: ${err.message}\n`);
    process.exit(0);
  });
}
