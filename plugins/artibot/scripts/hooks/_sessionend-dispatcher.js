#!/usr/bin/env node
/**
 * SessionEnd dispatcher.
 *
 * Consolidates 5 previously-separate SessionEnd hook entries:
 *
 *   1. session-end.js                  (10s) — lifecycle close
 *   2. swarm-sync.js                   (15s) — outbound swarm push
 *   3. rotation-runner.js              (8s)  — log/artifact rotation
 *   4. memory-tracker.js SessionEnd    (8s)  — memory persistence
 *   5. http-notify.js                  (8s)  — external HTTP notifier
 *
 * Each hook is spawned in parallel as a child process. Network-bound hooks
 * (swarm-sync, http-notify) own their per-hook timeout so a slow remote
 * never holds up the other end-of-session tasks.
 *
 * Rollback: ARTIBOT_DISABLE_SESSIONEND_DISPATCHER=1 (slot) or
 * ARTIBOT_DISABLE_DISPATCHER=1 (global).
 *
 * Exits with code 0 on every failure path.
 *
 * @module scripts/hooks/_sessionend-dispatcher
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

const HOOK_NAME = '_sessionend-dispatcher';
const EVENT_NAME = 'SessionEnd';

/**
 * Hook table — loaded from hooks/dispatch-table.json (v4.8.0 P1).
 */
const HOOKS = loadDispatchTable(EVENT_NAME);

export { HOOKS };

async function main() {
  if (
    process.env.ARTIBOT_DISABLE_DISPATCHER === '1' ||
    process.env.ARTIBOT_DISABLE_SESSIONEND_DISPATCHER === '1'
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
  main().catch(createFatalHandler(HOOK_NAME));
}
