#!/usr/bin/env node
/**
 * Weekly self-benchmark cron runner.
 *
 * Triggered by an external scheduler (GitHub Actions / host cron) at the
 * time specified in `artibot.config.json > ago.selfBenchmark.schedule`
 * (default `0 4 * * 1` — Monday 04:00).
 *
 * Wave-2 gates (all must hold):
 *   1. `ago.selfControl.masterEnabled`    — default true (user-level off-switch)
 *   2. `ago.selfBenchmark.enabled`        — default true (per-feature off-switch)
 *   3. kill-switch not tripped for `self-benchmark`
 *
 * First-run observe mode is allowed: the benchmark is read-only/report-only
 * so running it during the initial observation window is safe.
 *
 * Behavior:
 *   - Reads `artibot.config.json`.
 *   - Short-circuits (exit 0) when any gate fails.
 *   - Otherwise runs the observational benchmark and writes the report.
 *   - Never modifies source code. Never makes network calls.
 *
 * Usage:
 *   node scripts/cron/self-benchmark-runner.js            # write report
 *   node scripts/cron/self-benchmark-runner.js --dry-run  # no writes
 *
 * @module scripts/cron/self-benchmark-runner
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readJsonFile } from '../../lib/core/file.js';
import { getPluginRoot } from '../../lib/core/platform.js';
import { runSelfBenchmark } from '../../lib/learning/self-benchmark.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');

  const pluginRoot = getPluginRoot() || path.resolve(__dirname, '..', '..');
  const configPath = path.join(pluginRoot, 'artibot.config.json');
  const config = (await readJsonFile(configPath)) || {};

  // Gate 1: master self-control off-switch.
  const masterEnabled = config?.ago?.selfControl?.masterEnabled !== false;
  if (!masterEnabled) {
    process.stdout.write('self-benchmark: disabled via ago.selfControl.masterEnabled=false\n');
    process.exit(0);
  }

  // Gate 2: per-feature off-switch — defaults to true.
  const sbCfg = config?.ago?.selfBenchmark || {};
  if (sbCfg.enabled === false) {
    process.stdout.write('self-benchmark: disabled via ago.selfBenchmark.enabled=false\n');
    process.exit(0);
  }

  // Gate 3: kill-switch. Graceful if module missing.
  try {
    const ks = await import('../../lib/learning/kill-switch.js');
    if (await ks.isKillSwitchTripped(config, { feature: 'self-benchmark', pluginRoot })) {
      process.stdout.write('self-benchmark: skipped — kill-switch tripped for self-benchmark\n');
      process.exit(0);
    }
  } catch {
    // Best-effort: missing kill-switch must not block the runner.
  }

  const result = await runSelfBenchmark({ pluginRoot, config, dryRun });

  const lines = [
    'SELF-BENCHMARK RESULT',
    '=====================',
    `Total score: ${Math.round(result.totalScore * 100) / 100} / 100`,
    `Report:      ${result.reportPath}${result.written ? '' : ' (dry-run — not written)'}`,
  ];
  for (const [dim, entry] of Object.entries(result.scores)) {
    lines.push(`  - ${dim.padEnd(10)} ${entry.score.toFixed(2)}`);
  }
  process.stdout.write(lines.join('\n') + '\n');
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`self-benchmark cron failed: ${err.message}\n`);
  process.exit(1);
});
