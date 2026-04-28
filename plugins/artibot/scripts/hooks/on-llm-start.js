#!/usr/bin/env node
/**
 * on_llm_start hook stub. Pass-through extension point.
 * Wired in hooks.json (AD-07).
 * @module scripts/hooks/on-llm-start
 */

import { parseJSON, readStdin, writeStdout } from '../utils/index.js';

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
