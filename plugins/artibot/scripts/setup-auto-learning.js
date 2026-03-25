#!/usr/bin/env node
/**
 * Auto-Learning Pipeline Setup Script.
 *
 * Registers a recurring remote trigger for the auto-learning pipeline
 * using `claude schedule` or prints the equivalent CronCreate instructions
 * for in-session scheduling.
 *
 * Usage:
 *   node scripts/setup-auto-learning.js              # Interactive setup
 *   node scripts/setup-auto-learning.js --dry-run     # Preview only
 *   node scripts/setup-auto-learning.js --cron-only   # Print CronCreate instructions
 *   node scripts/setup-auto-learning.js --schedule     # Register via claude schedule
 *
 * @module scripts/setup-auto-learning
 */

import path from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { readJsonFile } from '../lib/core/file.js';
import { getPluginRoot } from '../lib/core/platform.js';

const execFile = promisify(execFileCb);

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG = {
  enabled: false,
  schedule: '0 3 * * *',
  pipeline: ['self-scan', 'pattern-extract', 'knowledge-update', 'skill-refinement'],
  autoCommit: true,
  autoPush: true,
  maxChangesPerRun: 10,
  dryRun: false,
};

async function loadConfig() {
  const pluginRoot = getPluginRoot();
  const configPath = path.join(pluginRoot, 'artibot.config.json');
  const full = await readJsonFile(configPath);
  return { ...DEFAULT_CONFIG, ...(full?.autoLearning ?? {}) };
}

// ---------------------------------------------------------------------------
// Setup Methods
// ---------------------------------------------------------------------------

function buildPipelinePrompt(config) {
  const stages = config.pipeline.join(', ');
  return [
    'Run the Artibot auto-learning pipeline:',
    `1. Execute pipeline stages: ${stages}`,
    '2. Self-scan: run lint, tests, coverage checks',
    '3. Pattern extract: analyze recent git commits for recurring patterns',
    '4. Knowledge update: persist patterns, run knowledge transfer (promote/demote)',
    '5. Skill refinement: update skill triggers based on learned patterns',
    config.autoCommit ? '6. Auto-commit changes (if any, within maxChangesPerRun limit)' : '6. Skip auto-commit (disabled)',
    config.autoPush ? '7. Auto-push committed changes' : '7. Skip auto-push (disabled)',
    `8. maxChangesPerRun: ${config.maxChangesPerRun}`,
    config.dryRun ? '9. DRY RUN MODE: log changes without writing to disk' : '',
    '10. Write pipeline run summary to learning-log.json',
  ].filter(Boolean).join('\n');
}

function printCronCreateInstructions(config) {
  const prompt = buildPipelinePrompt(config);
  const cronExpr = config.schedule.replace(/^(\d+) /, (_, m) => `${Number(m) + 3} `);

  console.log('=== CronCreate Instructions (Session-Only) ===');
  console.log('');
  console.log('Copy and use this with Claude Code CronCreate tool:');
  console.log('');
  console.log('CronCreate:');
  console.log(`  cron: "${cronExpr}"`);
  console.log('  recurring: true');
  console.log('  prompt: |');
  for (const line of prompt.split('\n')) {
    console.log(`    ${line}`);
  }
  console.log('');
  console.log('Note: CronCreate jobs are session-only and expire when Claude exits.');
  console.log('For persistent scheduling, use: node scripts/setup-auto-learning.js --schedule');
}

async function registerClaudeSchedule(config) {
  const prompt = buildPipelinePrompt(config);
  const pluginRoot = getPluginRoot();

  console.log('=== Registering claude schedule ===');
  console.log(`Schedule: ${config.schedule}`);
  console.log(`Working directory: ${pluginRoot}`);
  console.log('');

  try {
    const { stdout } = await execFile('claude', [
      'schedule',
      'create',
      '--cron', config.schedule,
      '--project', pluginRoot,
      '--prompt', prompt,
    ], {
      timeout: 30_000,
      encoding: 'utf-8',
    });

    console.log('Schedule registered successfully:');
    console.log(stdout.trim());
    return true;
  } catch (err) {
    console.error('Failed to register claude schedule:');
    console.error(err.message);
    console.log('');
    console.log('Possible causes:');
    console.log('  - Claude CLI not installed or not in PATH');
    console.log('  - claude schedule not available in your Claude version');
    console.log('  - Network/authentication issue');
    console.log('');
    console.log('Fallback: Use CronCreate (session-only) or Git webhook instead.');
    return false;
  }
}

function printWebhookInstructions(config) {
  console.log('=== Git Webhook Setup ===');
  console.log('');
  console.log('Configure your Git server to send POST requests after push events.');
  console.log('');
  console.log('GitHub Actions example (.github/workflows/auto-learn.yml):');
  console.log('');
  console.log('  name: Auto-Learning Pipeline');
  console.log('  on:');
  console.log('    schedule:');
  console.log(`      - cron: "${config.schedule}"`);
  console.log('    workflow_dispatch:');
  console.log('  jobs:');
  console.log('    auto-learn:');
  console.log('      runs-on: ubuntu-latest');
  console.log('      steps:');
  console.log('        - uses: actions/checkout@v4');
  console.log('        - uses: actions/setup-node@v4');
  console.log('          with: { node-version: 22 }');
  console.log('        - run: npm ci');
  console.log('        - run: |');
  console.log('            node plugins/artibot/scripts/run-auto-learning.js');
  console.log('');
}

function printStatus(config) {
  console.log('=== Auto-Learning Pipeline Configuration ===');
  console.log('');
  console.log(`Enabled:          ${config.enabled}`);
  console.log(`Schedule:         ${config.schedule}`);
  console.log(`Pipeline stages:  ${config.pipeline.join(', ')}`);
  console.log(`Auto-commit:      ${config.autoCommit}`);
  console.log(`Auto-push:        ${config.autoPush}`);
  console.log(`Max changes/run:  ${config.maxChangesPerRun}`);
  console.log(`Dry run:          ${config.dryRun}`);
  console.log('');

  if (!config.enabled) {
    console.log('Pipeline is DISABLED. To enable, set autoLearning.enabled: true in artibot.config.json');
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const config = await loadConfig();

  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: node scripts/setup-auto-learning.js [options]');
    console.log('');
    console.log('Options:');
    console.log('  --status       Show current configuration');
    console.log('  --dry-run      Preview pipeline prompt without registering');
    console.log('  --cron-only    Print CronCreate instructions (session-only)');
    console.log('  --schedule     Register via claude schedule (persistent)');
    console.log('  --webhook      Print Git webhook / GitHub Actions setup');
    console.log('  --help         Show this help message');
    return;
  }

  if (args.includes('--status')) {
    printStatus(config);
    return;
  }

  if (args.includes('--dry-run')) {
    console.log('=== Pipeline Prompt Preview ===');
    console.log('');
    console.log(buildPipelinePrompt(config));
    return;
  }

  if (args.includes('--cron-only')) {
    printCronCreateInstructions(config);
    return;
  }

  if (args.includes('--webhook')) {
    printWebhookInstructions(config);
    return;
  }

  if (args.includes('--schedule')) {
    await registerClaudeSchedule(config);
    return;
  }

  // Default: show status + all options
  printStatus(config);
  console.log('--- Setup Options ---');
  console.log('');
  console.log('1. claude schedule (persistent, requires Claude CLI):');
  console.log('   node scripts/setup-auto-learning.js --schedule');
  console.log('');
  console.log('2. CronCreate (session-only, requires active REPL):');
  console.log('   node scripts/setup-auto-learning.js --cron-only');
  console.log('');
  console.log('3. Git webhook / GitHub Actions (CI-based):');
  console.log('   node scripts/setup-auto-learning.js --webhook');
  console.log('');
}

main().catch((err) => {
  console.error('Setup failed:', err.message);
  process.exit(1);
});
