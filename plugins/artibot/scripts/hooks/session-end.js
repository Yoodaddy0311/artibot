#!/usr/bin/env node
/**
 * SessionEnd hook.
 * Saves current session state to ~/.claude/artibot-state.json.
 */

import { readStdin, parseJSON, atomicWriteSync } from '../utils/index.js';
import path from 'node:path';

async function main() {
  const raw = await readStdin();
  const hookData = parseJSON(raw);

  const home = process.env.USERPROFILE || process.env.HOME || '';
  const claudeDir = path.join(home, '.claude');
  const statePath = path.join(claudeDir, 'artibot-state.json');

  const state = {
    sessionId: hookData?.session_id || null,
    endedAt: new Date().toISOString(),
    startedAt: hookData?.started_at || null,
    cwd: process.cwd(),
    metadata: {
      platform: process.platform,
      nodeVersion: process.version,
    },
  };

  try {
    atomicWriteSync(statePath, state);
  } catch (err) {
    process.stderr.write(`[artibot:session-end] Failed to save state: ${err.message}\n`);
  }
}

main().catch((err) => {
  process.stderr.write(`[artibot:session-end] ${err.message}\n`);
  process.exit(0);
});
