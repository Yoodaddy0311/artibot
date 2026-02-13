#!/usr/bin/env node
/**
 * PreCompact hook.
 * Saves current in-progress task state to a temporary file before compaction.
 */

import { readStdin, writeStdout, parseJSON } from '../utils/index.js';
import path from 'node:path';
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';

async function main() {
  const raw = await readStdin();
  const hookData = parseJSON(raw);

  const home = process.env.USERPROFILE || process.env.HOME || '';
  const claudeDir = path.join(home, '.claude');
  const statePath = path.join(claudeDir, 'artibot-state.json');
  const compactBackupPath = path.join(claudeDir, 'artibot-pre-compact.json');

  // Load current state
  let currentState = {};
  if (existsSync(statePath)) {
    try {
      currentState = JSON.parse(readFileSync(statePath, 'utf-8'));
    } catch {
      currentState = {};
    }
  }

  // Save snapshot before compaction
  const snapshot = {
    savedAt: new Date().toISOString(),
    reason: 'pre-compact',
    state: currentState,
    hookData: hookData || {},
  };

  try {
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(compactBackupPath, JSON.stringify(snapshot, null, 2), 'utf-8');
    writeStdout({
      message: '[compact] Task state saved before compaction.',
    });
  } catch (err) {
    process.stderr.write(`[artibot:pre-compact] Failed to save snapshot: ${err.message}\n`);
  }
}

main().catch((err) => {
  process.stderr.write(`[artibot:pre-compact] ${err.message}\n`);
});
