#!/usr/bin/env node
/**
 * Stop / SessionEnd hook — Ambient Conversation Ledger.
 *
 * Fires automatically every turn (Stop) and at session teardown (SessionEnd)
 * with NO user command. Reads the session transcript, slims it to denoised
 * user/assistant conversation, redacts secrets, and incrementally appends to a
 * gitignored local ledger (`.artibot/ledger/<session>.jsonl`).
 *
 * Safety properties (must hold — same class as stop-recap.js):
 *   - Output channel: stderr ONLY. NEVER writes stdout (Codex parses Stop-hook
 *     stdout as a decision; any byte there could block the session).
 *   - Never throws: all failure is swallowed; the process exits 0 so a logging
 *     failure never blocks the participant's session.
 *   - No network, no git mutation — local file I/O only (DATA POLICY).
 *
 * Mode: invoked with arg "SessionEnd" → authoritative reconcile
 * (finalizeSession); otherwise → per-turn incremental capture (captureTurn).
 * The dispatch-table SessionEnd entry passes args:["SessionEnd"].
 *
 * @module scripts/hooks/session-ledger
 */

import { existsSync } from 'node:fs';
import { readStdin } from '../utils/index.js';
import { captureTurn, finalizeSession } from '../../lib/learning/ledger/store.js';

const HOOK_NAME = 'session-ledger';

async function main() {
  let payload;
  try {
    const stdin = await readStdin();
    payload = stdin ? JSON.parse(stdin) : {};
  } catch {
    return; // tolerate empty/malformed stdin — nothing to capture
  }

  const transcriptPath = payload?.transcript_path;
  if (!transcriptPath || !existsSync(transcriptPath)) return;

  const projectRoot = payload?.cwd || process.cwd();
  const sessionId = payload?.session_id || 'session';
  const isSessionEnd = process.argv.includes('SessionEnd')
    || payload?.hook_event_name === 'SessionEnd';

  if (isSessionEnd) {
    await finalizeSession({ projectRoot, sessionId, transcriptPath });
  } else {
    await captureTurn({ projectRoot, sessionId, transcriptPath });
  }
}

main().catch((err) => {
  // Last-resort guard: never let a ledger failure surface to the host.
  process.stderr.write(`[artibot:${HOOK_NAME}] ${err?.message || 'failed'}\n`);
});
