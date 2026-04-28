#!/usr/bin/env node
/**
 * on_llm_end hook stub. Pass-through extension point.
 * Wired in hooks.json (AD-07).
 * @module scripts/hooks/on-llm-end
 */

import { parseJSON, readStdin, writeStdout } from '../utils/index.js';

async function main() {
  const raw = await readStdin();
  const data = parseJSON(raw) ?? {};
  writeStdout({
    continue: true,
    event: 'on_llm_end',
    model: data?.model ?? null,
    agent: data?.agent ?? null,
    usage: data?.usage ?? null,
  });
}

main().catch((err) => {
  process.stderr.write(`[on-llm-end] ${err?.message ?? err}\n`);
  writeStdout({ continue: true });
});
