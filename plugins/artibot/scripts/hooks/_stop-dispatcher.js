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
 * Ordering safety: Stop ignores `additionalContext` per Claude Code schema,
 * so hook order does not affect the user-visible result. Hooks are run in
 * parallel; the dispatcher merges any decision=block result and forwards
 * stderr (where stop-recap emits its [artibot:recap] line).
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
  hookPath,
  isMainEntry,
  mergeResults,
  parseHookStdout,
  readPayload,
  spawnHook,
} from './_dispatcher-utils.js';

const HOOK_NAME = '_stop-dispatcher';
const EVENT_NAME = 'Stop';

const HOOKS = [
  { name: 'stop-review-gate',    script: hookPath('stop-review-gate.js'),    timeoutMs: 15000 },
  { name: 'dev-verify-gate',     script: hookPath('dev-verify-gate.js'),     timeoutMs: 8000 },
  { name: 'git-autopilot-close', script: hookPath('git-autopilot-close.js'), timeoutMs: 15000 },
  { name: 'stop-recap',          script: hookPath('stop-recap.js'),          timeoutMs: 5000 },
  { name: 'session-notes',       script: hookPath('session-notes.js'),       timeoutMs: 5000 },
];

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
  main().catch((err) => {
    process.stderr.write(`[artibot:${HOOK_NAME}] fatal: ${err.message}\n`);
    process.exit(0);
  });
}
