#!/usr/bin/env node
/**
 * Nightly Trainers Setup Script.
 *
 * Helps users register the 5 nightly mjs trainers that populate Artibot's
 * GRPO / skill / agent / joint policies and the session rollup. The script
 * prints the equivalent crontab / schtasks / claude schedule commands —
 * actual registration is delegated to the user's OS (no shell exec of
 * destructive commands).
 *
 * Usage:
 *   node scripts/setup-nightly-trainers.js              # status + all guides
 *   node scripts/setup-nightly-trainers.js --dry-run    # preview only
 *   node scripts/setup-nightly-trainers.js --cron       # POSIX crontab guide
 *   node scripts/setup-nightly-trainers.js --schtasks   # Windows schtasks guide
 *   node scripts/setup-nightly-trainers.js --schedule   # `claude schedule` guide
 *
 * @module scripts/setup-nightly-trainers
 */

import path from 'node:path';
import { getPluginRoot } from '../lib/core/platform.js';

// ---------------------------------------------------------------------------
// Trainer registry — schedules pinned to docs/SCHEDULED-JOBS.md
// ---------------------------------------------------------------------------

const TRAINERS = [
  {
    name: 'nightly-grpo-trainer',
    cron: '30 2 * * *',
    schtasks: '02:30',
    script: 'scripts/hooks/nightly-grpo-trainer.mjs',
    purpose: 'Update GRPO routing policy from yesterday\'s episodes',
  },
  {
    name: 'nightly-agent-policy-trainer',
    cron: '45 2 * * *',
    schtasks: '02:45',
    script: 'scripts/hooks/nightly-agent-policy-trainer.mjs',
    purpose: 'Refresh per-agent success/latency weights',
  },
  {
    name: 'nightly-skill-policy-trainer',
    cron: '0 3 * * *',
    schtasks: '03:00',
    script: 'scripts/hooks/nightly-skill-policy-trainer.mjs',
    purpose: 'Refresh skill activation policy weights',
  },
  {
    name: 'nightly-joint-policy-trainer',
    cron: '15 3 * * *',
    schtasks: '03:15',
    script: 'scripts/hooks/nightly-joint-policy-trainer.mjs',
    purpose: 'Refresh joint (skill x agent) policy',
  },
  {
    name: 'nightly-session-rollup',
    cron: '30 4 * * *',
    schtasks: '04:30',
    script: 'scripts/hooks/nightly-session-rollup.mjs',
    purpose: 'Roll up yesterday\'s sessions, prune originals > 30d',
  },
];

// ---------------------------------------------------------------------------
// Guide renderers
// ---------------------------------------------------------------------------

function nodeBin() {
  return process.execPath || 'node';
}

function absScript(pluginRoot, rel) {
  return path.join(pluginRoot, rel);
}

function printStatus(pluginRoot) {
  console.log('=== Nightly Trainers — Status ===');
  console.log('');
  console.log(`Plugin root: ${pluginRoot}`);
  console.log('');
  console.log('Trainers (recommended schedules, UTC):');
  console.log('');
  for (const t of TRAINERS) {
    console.log(`  ${t.name}`);
    console.log(`    cron:    ${t.cron}`);
    console.log(`    script:  ${absScript(pluginRoot, t.script)}`);
    console.log(`    purpose: ${t.purpose}`);
    console.log('');
  }
}

function printCron(pluginRoot, dryRun) {
  console.log('=== POSIX crontab Guide ===');
  console.log('');
  console.log('Add to your crontab (run `crontab -e`):');
  console.log('');
  for (const t of TRAINERS) {
    console.log(`${t.cron} ${nodeBin()} ${absScript(pluginRoot, t.script)} >> ~/.claude/artibot/${t.name}.log 2>&1`);
  }
  console.log('');
  if (dryRun) {
    console.log('(--dry-run: not installed; copy the lines above into `crontab -e` to enable.)');
  } else {
    console.log('Copy the lines above into `crontab -e`. Logs land in ~/.claude/artibot/.');
  }
}

function printSchtasks(pluginRoot, dryRun) {
  console.log('=== Windows Task Scheduler (schtasks) Guide ===');
  console.log('');
  console.log('Run each command in an elevated PowerShell. Times are local 24h.');
  console.log('');
  for (const t of TRAINERS) {
    const tr = `Artibot-${t.name}`;
    console.log(`schtasks /Create /SC DAILY /ST ${t.schtasks} /TN "${tr}" /TR "\\"${nodeBin()}\\" \\"${absScript(pluginRoot, t.script)}\\"" /F`);
  }
  console.log('');
  if (dryRun) {
    console.log('(--dry-run: not installed; copy the lines above into an elevated PowerShell.)');
  } else {
    console.log('Copy each line into an elevated PowerShell. Use `schtasks /Delete /TN "Artibot-..."` to remove.');
  }
}

function printClaudeSchedule(pluginRoot, dryRun) {
  console.log('=== claude schedule Guide ===');
  console.log('');
  console.log('Requires Claude CLI with the `schedule` subcommand. Persistent across sessions.');
  console.log('');
  for (const t of TRAINERS) {
    const prompt = `Run the Artibot ${t.name} trainer: \`${nodeBin()} ${absScript(pluginRoot, t.script)}\``;
    console.log(`claude schedule create --cron "${t.cron}" --project "${pluginRoot}" --prompt ${JSON.stringify(prompt)}`);
  }
  console.log('');
  if (dryRun) {
    console.log('(--dry-run: not installed; copy the lines above into your shell.)');
  } else {
    console.log('Copy each line into your shell. Verify with `claude schedule list`.');
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  const pluginRoot = getPluginRoot();

  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: node scripts/setup-nightly-trainers.js [options]');
    console.log('');
    console.log('Options:');
    console.log('  --dry-run    Preview commands without installing them');
    console.log('  --cron       POSIX crontab guide');
    console.log('  --schtasks   Windows Task Scheduler guide');
    console.log('  --schedule   claude schedule guide (persistent)');
    console.log('  --help       Show this help');
    console.log('');
    console.log('Default: print status + all three guides.');
    return;
  }

  const dryRun = args.includes('--dry-run');
  const wantCron = args.includes('--cron');
  const wantSchtasks = args.includes('--schtasks');
  const wantSchedule = args.includes('--schedule');
  const showAll = !wantCron && !wantSchtasks && !wantSchedule;

  printStatus(pluginRoot);

  if (showAll || wantCron) {
    printCron(pluginRoot, dryRun);
    console.log('');
  }
  if (showAll || wantSchtasks) {
    printSchtasks(pluginRoot, dryRun);
    console.log('');
  }
  if (showAll || wantSchedule) {
    printClaudeSchedule(pluginRoot, dryRun);
    console.log('');
  }

  console.log('See docs/SCHEDULED-JOBS.md for purpose, troubleshooting, and disable instructions.');
}

main();
