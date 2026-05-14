#!/usr/bin/env node
/**
 * @deprecated 2026-05-14 — moved to _deprecated/ as part of perf audit P1.
 * No registered usage in hooks.json or via internal import.
 * If you depended on this, please file an issue.
 * Scheduled for deletion: 2026-05-21 (1 week monitoring).
 *
 * Original purpose: on_llm_start hook stub. Pass-through extension point.
 * Anthropic Agent SDK extension stub (AD-07). Not wired in hooks.json —
 * Claude Code's native loader rejects snake_case event keys. Reserved for
 * future SDK runtime wiring (e.g., artibot.config.json sdkHooks section).
 * @module scripts/hooks/_deprecated/on-llm-start
 */

import { parseJSON, readStdin, writeStdout } from '../../utils/index.js';

async function main() {
  const raw = await readStdin();
  const data = parseJSON(raw) ?? {};
  writeStdout({
    continue: true,
    event: 'on_llm_start',
    model: data?.model ?? null,
    agent: data?.agent ?? null,
  });
}

main().catch((err) => {
  process.stderr.write(`[on-llm-start] ${err?.message ?? err}\n`);
  writeStdout({ continue: true });
});
