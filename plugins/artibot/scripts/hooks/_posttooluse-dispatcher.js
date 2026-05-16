#!/usr/bin/env node
/**
 * PostToolUse dispatcher.
 *
 * Consolidates 10 previously-separate PostToolUse entries (each with its own
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
  hookPath,
  isMainEntry,
  mergeResults,
  parseHookStdout,
  readPayload,
  spawnHook,
} from './_dispatcher-utils.js';

const HOOK_NAME = '_posttooluse-dispatcher';
const EVENT_NAME = 'PostToolUse';

const HOOKS = [
  { name: 'pre-write-guard',     script: hookPath('pre-write-guard.js'),     timeoutMs: 3000,  tools: ['Read'] },
  { name: 'quality-gate',        script: hookPath('quality-gate.js'),        timeoutMs: 8000,  tools: ['Edit', 'Write'] },
  { name: 'post-edit-format',    script: hookPath('post-edit-format.js'),    timeoutMs: 10000, tools: ['Edit'] },
  { name: 'post-edit-recovery',  script: hookPath('post-edit-recovery.js'),  timeoutMs: 5000,  tools: ['Edit', 'Write'] },
  { name: 'post-bash',           script: hookPath('post-bash.js'),           timeoutMs: 5000,  tools: ['Bash'] },
  { name: 'post-bash-failure',   script: hookPath('post-bash-failure.js'),   timeoutMs: 3000,  tools: ['Bash'] },
  { name: 'post-write-tdd',      script: hookPath('post-write-tdd.js'),      timeoutMs: 2000,  tools: ['Edit', 'Write'] },
  { name: 'mark-main-agent-edit', script: hookPath('mark-main-agent-edit.js'), timeoutMs: 3000, tools: ['Edit', 'Write', 'MultiEdit'] },
  { name: 'tool-tracker',        script: hookPath('tool-tracker.js'),        timeoutMs: 3000,  tools: ['*'] },
  { name: 'webfetch-cache-post', script: hookPath('webfetch-cache-post.js'), timeoutMs: 5000,  tools: ['WebFetch'] },
];

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
