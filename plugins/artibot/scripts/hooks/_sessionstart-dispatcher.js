#!/usr/bin/env node
/**
 * SessionStart dispatcher.
 *
 * Consolidates 9 previously-separate SessionStart hook entries into a single
 * node invocation:
 *
 *   1. session-start.js              (5s)  — environment, config, banner
 *   2. memory-tracker.js SessionStart (5s) — memory recall
 *   3. swarm-download.js             (15s) — collective patterns
 *   4. git-autopilot-setup.js        (5s)  — git autopilot initialization
 *   5. image-cleanup.js              (5s)  — temp image rotation
 *   6. session-digest.js             (3s)  — session digest emission
 *   7. git-autopilot-session.js      (10s) — autopilot session marker
 *   8. skill-validation-check.js     (5s)  — skill index health check
 *   9. session-readback.mjs          (5s)  — prior-session read-back advisory
 *
 * Each hook is spawned in parallel as a child process so a crash, slow IO, or
 * long timeout in any one hook never blocks the others. stdout JSON outputs
 * are merged via `mergeResults`; stderr is forwarded so banners and
 * advisories remain visible.
 *
 * Rollback: set ARTIBOT_DISABLE_SESSIONSTART_DISPATCHER=1 (slot-scoped) or
 * ARTIBOT_DISABLE_DISPATCHER=1 (global rollback for every dispatcher). The
 * dispatcher then writes a stderr warning and exits without invoking any
 * hook — emergency-only.
 *
 * Process exits with code 0 on every failure path so a hook crash never
 * blocks the session.
 *
 * @module scripts/hooks/_sessionstart-dispatcher
 */

import { createFatalHandler, isMainEntry, mergeResults, parseHookStdout, readPayload, spawnHook } from './_dispatcher-utils.js';
import { loadDispatchTable } from '../../lib/dispatcher/dispatch-table-loader.js';

const HOOK_NAME = '_sessionstart-dispatcher';
const EVENT_NAME = 'SessionStart';

/**
 * Hook table — loaded from hooks/dispatch-table.json (v4.8.0 P1). Order is
 * only meaningful for stderr log readability; execution is parallel. Each
 * entry preserves the original hooks.json timeout so a slow swarm-download
 * (network-bound, 15s) doesn't get truncated.
 */
const HOOKS = loadDispatchTable(EVENT_NAME);

export { HOOKS };

async function main() {
  if (
    process.env.ARTIBOT_DISABLE_DISPATCHER === '1' ||
    process.env.ARTIBOT_DISABLE_SESSIONSTART_DISPATCHER === '1'
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
