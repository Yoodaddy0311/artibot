#!/usr/bin/env node
/**
 * on_handoff hook stub. Reads JSON from stdin and emits {continue: true}.
 * Extension point for users; wired in hooks.json (AD-07).
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
