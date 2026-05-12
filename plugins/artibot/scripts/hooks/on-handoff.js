#!/usr/bin/env node
/**
 * on_handoff hook stub. Reads JSON from stdin and emits {continue: true}.
 * Anthropic Agent SDK extension stub (AD-07). Not wired in hooks.json —
 * Claude Code's native loader rejects snake_case event keys. Reserved for
 * future SDK runtime wiring (e.g., artibot.config.json sdkHooks section).
 * @module scripts/hooks/on-handoff
 */

import { parseJSON, readStdin, writeStdout } from '../utils/index.js';

async function main() {
  const raw = await readStdin();
  const data = parseJSON(raw) ?? {};
  // Stub: pass-through. Future: invoke handoff filter / record handoff span.
  writeStdout({
    continue: true,
    event: 'on_handoff',
    from: data?.from ?? null,
    to: data?.to ?? null,
  });
}

main().catch((err) => {
  process.stderr.write(`[on-handoff] ${err?.message ?? err}\n`);
  writeStdout({ continue: true });
});
