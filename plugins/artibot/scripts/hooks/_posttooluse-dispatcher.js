#!/usr/bin/env node
/**
 * PostToolUse dispatcher.
 *
 * Consolidates the previously-separate PostToolUse entries (each with its own
 * tool matcher) into a single node invocation. Tool-name routing now happens
 * INSIDE the dispatcher: each entry in `HOOKS` declares the tool names it
 * applies to and the dispatcher filters the table on each invocation.
 *
 *   1. pre-write-guard.js     Read              (3s)   — guard staleness check
 *   2. quality-gate.js        Edit / Write      (8s)   — quality enforcement
 *   3. post-edit-format.js    Edit              (10s)  — auto-format
 *   4. post-edit-recovery.js  Edit / Write      (5s)   — recovery tracking
 *   5. post-bash.js           Bash              (5s)   — bash post-processing
 *   6. post-bash-failure.js   Bash              (3s)   — bash failure recovery
 *   7. post-write-tdd.js      Edit / Write      (2s)   — TDD advisory
 *   8. mark-main-agent-edit.js Edit/Write/Multi (3s)   — agent ownership tag
 *   9. tool-tracker.js        *                 (3s)   — universal tracker
 *  10. webfetch-cache-post.js WebFetch          (5s)   — webfetch cache write
 *  11. zero-result-guard.js  Grep / Glob       (3s)   — zero-result scope nudge
 *
 * Routing: hooks whose `tools` array does not include the current
 * `extractToolName(payload)` value are skipped entirely (no spawn, no cost).
 * Hooks with `tools: ['*']` run for every tool.
 *
 * Rollback: ARTIBOT_DISABLE_POSTTOOLUSE_DISPATCHER=1 (slot) or
 * ARTIBOT_DISABLE_DISPATCHER=1 (global).
 *
 * Exits with code 0 on every failure path. A hook decision=block from one
 * hook is surfaced — the merge logic preserves the first blocker's reason.
 *
 * @module scripts/hooks/_posttooluse-dispatcher
 */

import {
  extractToolName,
  isMainEntry,
  mergeResults,
  parseHookStdout,
  readPayload,
  spawnHook,
} from './_dispatcher-utils.js';
import { loadDispatchTable } from '../../lib/dispatcher/dispatch-table-loader.js';

const HOOK_NAME = '_posttooluse-dispatcher';
const EVENT_NAME = 'PostToolUse';

/**
 * Hook table — loaded from hooks/dispatch-table.json (v4.8.0 P1).
 * Each entry's `tools` array drives the per-payload routing in selectHooks().
 */
const HOOKS = loadDispatchTable(EVENT_NAME);

export { HOOKS };

/**
 * Decide which hooks should fire for this payload's tool name.
 * @param {string|null} toolName
 * @returns {Array<object>} filtered HOOKS subset
 */
export function selectHooks(toolName) {
  if (!toolName) {
    // Even with no detectable tool, still run the universal tracker so we
    // observe odd payloads (helps debug).
    return HOOKS.filter((h) => h.tools.includes('*'));
  }
  return HOOKS.filter((h) => h.tools.includes('*') || h.tools.includes(toolName));
}

async function main() {
  if (
    process.env.ARTIBOT_DISABLE_DISPATCHER === '1' ||
    process.env.ARTIBOT_DISABLE_POSTTOOLUSE_DISPATCHER === '1'
  ) {
    process.stderr.write(`[artibot:${HOOK_NAME}] disabled via env\n`);
    return;
  }

  const payload = await readPayload();
  const toolName = extractToolName(payload);
  const active = selectHooks(toolName);

  if (active.length === 0) return;

  const settled = await Promise.allSettled(
    active.map((h) =>
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
