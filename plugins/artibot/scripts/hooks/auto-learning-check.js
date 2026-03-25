#!/usr/bin/env node
/**
 * SessionStart hook — Auto-Learning Pipeline status check & auto-register.
 * Reads autoLearning config, outputs schedule status, and attempts to
 * auto-register the schedule if not already registered.
 * Runs once per session (hooks.json: once: true).
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseJSON, readStdin, resolveConfigPath, writeStdout } from '../utils/index.js';
import { createErrorHandler } from '../../lib/core/hook-utils.js';

/**
 * Check if auto-learning schedule marker exists.
 *
 * @param {string} artibotDir
 * @returns {boolean}
 */
function isScheduleRegistered(artibotDir) {
  const markerPath = path.join(artibotDir, 'auto-learning-registered.json');
  return existsSync(markerPath);
}

/**
 * Write schedule registration marker so we don't re-prompt.
 *
 * @param {string} artibotDir
 * @param {string} schedule
 */
function markScheduleRegistered(artibotDir, schedule) {
  const markerPath = path.join(artibotDir, 'auto-learning-registered.json');
  const data = {
    registeredAt: new Date().toISOString(),
    schedule,
    method: 'auto-session-hint',
  };
  try {
    writeFileSync(markerPath, JSON.stringify(data, null, 2) + '\n');
  } catch {
    // Non-critical: marker write failure is acceptable
  }
}

async function main() {
  const raw = await readStdin();
  parseJSON(raw);

  // Load config
  let config = {};
  const configPath = resolveConfigPath('artibot.config.json');
  try {
    config = JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch {
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

  // Resolve artibot directory for schedule marker
  const artibotDir = path.dirname(configPath);
  const registered = isScheduleRegistered(artibotDir);

  const lines = [
    `[auto-learn] Pipeline ON | schedule: ${schedule} | stages: ${stages} | max: ${maxChanges}${dryRun}`,
  ];

  if (!registered) {
    // First time: output setup hint and mark as acknowledged
    lines.push(
      '[auto-learn] Schedule not yet registered. Run: node ~/.claude/artibot/scripts/setup-auto-learning.js --schedule',
    );
    lines.push(
      '[auto-learn] Or use CronCreate in-session: schedule="' + schedule + '" command="node ~/.claude/artibot/scripts/auto-learning-runner.js"',
    );
    markScheduleRegistered(artibotDir, schedule);
  }

  writeStdout({ message: lines.join('\n') });
}

main().catch(createErrorHandler('auto-learning-check', { exit: true }));
