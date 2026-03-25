#!/usr/bin/env node
/**
 * SessionStart hook — Auto-Learning Pipeline status check.
 * Reads autoLearning config and outputs schedule status at session start.
 * Runs once per session (hooks.json: once: true).
 */

import { getPluginRoot, parseJSON, readStdin, resolveConfigPath, writeStdout } from '../utils/index.js';
import { readFileSync } from 'node:fs';
import { createErrorHandler } from '../../lib/core/hook-utils.js';

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

  const message = [
    `[auto-learn] Pipeline ON | schedule: ${schedule} | stages: ${stages} | max: ${maxChanges}${dryRun}`,
  ].join('\n');

  writeStdout({ message });
}

main().catch(createErrorHandler('auto-learning-check', { exit: true }));
