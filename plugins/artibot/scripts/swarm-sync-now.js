#!/usr/bin/env node
/**
 * Manually trigger a full swarm sync cycle.
 * Useful for testing, force-sync, and scripted usage.
 *
 * Usage:
 *   node scripts/swarm-sync-now.js
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { getPluginRoot } from '../lib/core/platform.js';
import { forceSync } from '../lib/swarm/sync-scheduler.js';
import { getSwarmConfig, isSwarmActive } from '../lib/swarm/swarm-config.js';

function out(line) {
  process.stdout.write(line + '\n');
}

async function main() {
  const pluginRoot = getPluginRoot();
  const configPath = path.join(pluginRoot, 'artibot.config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf-8'));

  const active = await isSwarmActive(config);
  if (!active) {
    out('Swarm is not active. Run: node plugins/artibot/scripts/swarm-init.js');
    process.exit(0);
  }

  const swarmCfg = getSwarmConfig(config);
  out(`Syncing (backend=${swarmCfg.backend}, url=${swarmCfg.gitRepoUrl || swarmCfg.serverUrl})...`);

  const result = await forceSync({ config: swarmCfg });

  out('');
  out('--- Sync Result ---');
  out(`success:    ${result.success}`);
  out(`uploaded:   ${result.uploaded}`);
  out(`downloaded: ${result.downloaded}`);
  out(`merged:     ${result.merged}`);
  out(`flushed:    ${result.flushed}`);
  out(`version:    ${result.version ?? '(none)'}`);
  if (result.error) out(`error:      ${result.error}`);
}

main().catch((err) => {
  process.stderr.write(`[swarm-sync-now] ${err.message || err}\n`);
  process.exit(1);
});
