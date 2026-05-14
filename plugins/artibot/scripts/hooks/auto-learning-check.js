#!/usr/bin/env node
/**
 * SessionStart hook — Auto-Learning Pipeline status check.
 * Reads autoLearning config and marker, reports registration method and status.
 * If schedule was registered as "hint-only" (install.sh fallback), prompts
 * the user to complete registration in the current session.
 * Runs once per session (hooks.json: once: true).
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseJSON, readStdin, resolveConfigPath, writeStdout } from '../utils/index.js';
import { createErrorHandler } from '../../lib/core/hook-utils.js';

/**
 * Read the registration marker if it exists.
 *
 * @param {string} artibotDir
 * @returns {{ method: string, schedule: string } | null}
 */
function readMarker(artibotDir) {
  const markerPath = path.join(artibotDir, 'auto-learning-registered.json');
  if (!existsSync(markerPath)) return null;
  try {
    return JSON.parse(readFileSync(markerPath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Determine if the registration method is actually active (vs hint-only).
 *
 * @param {string} method
 * @returns {boolean}
 */
function isActiveMethod(method) {
  return ['claude-schedule', 'crontab', 'schtasks'].includes(method);
}

async function main() {
  const raw = await readStdin();
  parseJSON(raw);

  // Load config
  const configPath = resolveConfigPath('artibot.config.json');
  let config;
  try {
    config = JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch (err) {
    process.stderr.write(
      `[auto-learn] config unreadable: ${err?.message || err}, pipeline status unknown\n`,
    );
    return;
  }

  const autoLearn = config.autoLearning;
  if (!autoLearn) return;

  if (!autoLearn.enabled) {
    process.stderr.write('[auto-learn] Pipeline disabled. Enable in artibot.config.json > autoLearning.enabled\n');
    return;
  }

  const stages = Array.isArray(autoLearn.pipeline)
    ? autoLearn.pipeline.join(', ')
    : 'all';
  const schedule = autoLearn.schedule || '0 3 * * *';
  const dryRun = autoLearn.dryRun ? ' (DRY RUN)' : '';
  const maxChanges = autoLearn.maxChangesPerRun ?? 10;

  const artibotDir = path.dirname(configPath);
  const marker = readMarker(artibotDir);

  const lines = [
    `[auto-learn] Pipeline ON | schedule: ${schedule} | stages: ${stages} | max: ${maxChanges}${dryRun}`,
  ];

  if (!marker) {
    // No marker at all — install.sh was not run or old version
    lines.push(
      '[auto-learn] Schedule not registered. Run: bash ~/.claude/artibot/install.sh',
    );
  } else if (!isActiveMethod(marker.method)) {
    // Marker exists but schedule not actually registered (hint-only fallback)
    lines.push(
      `[auto-learn] Schedule pending (method: ${marker.method}). To activate:`,
    );
    lines.push(
      '[auto-learn]   Option 1: Use CronCreate tool in this session',
    );
    lines.push(
      '[auto-learn]   Option 2: node ~/.claude/artibot/scripts/setup-auto-learning.js --schedule',
    );
  } else {
    // Active registration
    lines.push(`[auto-learn] Registered via ${marker.method}`);
  }

  writeStdout({ message: lines.join('\n') });
}

main().catch(createErrorHandler('auto-learning-check', { exit: true }));
