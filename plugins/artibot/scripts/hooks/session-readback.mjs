#!/usr/bin/env node
/**
 * SessionStart read-back advisory hook.
 *
 * Surfaces a one-line "here's what the last session left you" advisory built by
 * the ledger read-back module. Output is purely informational (additionalContext)
 * so it never blocks session start.
 *
 * Safety properties (must hold — same class as session-digest.js):
 *   - Errors go to stderr ONLY; the process always exits 0 and never throws.
 *   - When the advisory is null, NOTHING is written to stdout.
 *   - No network, no git mutation — local file reads only (DATA POLICY).
 *   - The read-back module is loaded via dynamic import() inside try/catch so a
 *     momentarily-absent module degrades silently instead of crashing load.
 *
 * Hook attachment (hooks/dispatch-table.json): SessionStart slot (parallel-spawn).
 * Stdin: Claude Code hook payload JSON.
 * Stdout: { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext } }
 *         — emitted only when an advisory exists; otherwise no output.
 *
 * @module scripts/hooks/session-readback
 */

import { readStdin, writeStdout } from '../utils/index.js';
import { resolveProjectRoot } from '../../lib/git/project-root.js';
import { isMainEntry } from './_main-entry.js';

const HOOK_NAME = 'session-readback';

async function main() {
  let payload;
  try {
    const stdin = await readStdin();
    payload = stdin ? JSON.parse(stdin) : {};
  } catch {
    payload = {}; // tolerate empty/malformed stdin — fall back to defaults
  }

  // Must use the SAME resolution as session-ledger.mjs — a reader anchored on a
  // different root than the writer would surface an unrelated (or empty) ledger.
  const projectRoot = resolveProjectRoot(payload?.cwd);
  const currentSessionId = payload?.session_id;

  let buildReadbackAdvisory;
  try {
    ({ buildReadbackAdvisory } = await import('../../lib/learning/ledger/readback.js'));
  } catch {
    return; // read-back module not available — degrade silently, no stdout
  }

  let result;
  try {
    result = await buildReadbackAdvisory({ projectRoot, currentSessionId });
  } catch {
    return; // builder failed — no advisory, no stdout
  }

  if (result?.advisory) {
    writeStdout({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: result.advisory,
      },
    });
  }
}

// Direct-run guard: importing this module must not run main(). Without it the
// import holds stdin in the background — invisible to the old import-safety
// probe, which exited the moment module evaluation finished. The dispatcher
// spawns this file as argv[1], so production behavior is unchanged.
if (isMainEntry(import.meta.url)) {
  main().catch((err) => {
    // Last-resort guard: never let a read-back failure surface to the host.
    process.stderr.write(`[artibot:${HOOK_NAME}] ${err?.message || 'failed'}\n`);
  });
}
