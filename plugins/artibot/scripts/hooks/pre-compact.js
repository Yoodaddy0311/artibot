#!/usr/bin/env node
/**
 * PreCompact hook.
 * Saves current in-progress task state to a temporary file before compaction.
 */

import { parseJSON, readStdin, writeStdout } from '../utils/index.js';
import path from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createErrorHandler, getClaudeDir, getStatePath, logHookError } from '../../lib/core/hook-utils.js';

async function main() {
  const raw = await readStdin();
  const hookData = parseJSON(raw);

  const claudeDir = getClaudeDir();
  const statePath = getStatePath();
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
    logHookError('pre-compact', 'Failed to save snapshot', err);
  }
}

main().catch(createErrorHandler('pre-compact'));
