#!/usr/bin/env node
/**
 * SessionStart hook: Swarm Download.
 *
 * Automatically downloads latest global weights at session start if the user
 * has opted in, then schedules periodic sync if configured.
 *
 * Flow:
 *   1. Load swarm config -> check opt-in
 *   2. Download latest global weights
 *   3. Merge into local patterns
 *   4. Schedule periodic sync (if interval != 'session')
 */

import path from 'node:path';
import { getPluginRoot, parseJSON, readStdin, toFileUrl } from '../utils/index.js';
import { createErrorHandler, logHookError } from '../../lib/core/hook-utils.js';

async function main() {
  const raw = await readStdin();
  const hookData = parseJSON(raw);

  // Require session context
  if (!hookData) return;

  const pluginRoot = getPluginRoot();

  // Dynamic imports to avoid loading heavy modules when swarm is disabled
  const configPath = path.join(pluginRoot, 'lib', 'core', 'config.js');
  const swarmConfigPath = path.join(pluginRoot, 'lib', 'swarm', 'swarm-config.js');
  const syncPath = path.join(pluginRoot, 'lib', 'swarm', 'sync-scheduler.js');

  try {
    const { loadConfig } = await import(toFileUrl(configPath));
    const { isSwarmActive, getSwarmConfig } = await import(toFileUrl(swarmConfigPath));

    const config = await loadConfig();

    // Early exit if not opted in
    const active = await isSwarmActive(config);
    if (!active) {
      process.stderr.write('[swarm-download] Skipped: not opted in\n');
      return;
    }

    const swarmCfg = getSwarmConfig(config);

    // Download latest global weights and merge into local
    const { onSessionStart, scheduleSync } = await import(toFileUrl(syncPath));
    const result = await onSessionStart({ config: swarmCfg });

    const parts = ['[swarm-download] Session start sync complete'];
    if (result?.downloaded) parts.push(`downloaded: v${result.version ?? '?'}`);
    if (!result?.downloaded) parts.push('no new weights');

    // Schedule periodic sync if interval is not session-only
    if (swarmCfg.syncInterval && swarmCfg.syncInterval !== 'session') {
      const scheduleResult = await scheduleSync({
        interval: swarmCfg.syncInterval,
        config: swarmCfg,
      });
      if (scheduleResult?.scheduled) {
        parts.push(`scheduled: ${swarmCfg.syncInterval}`);
      }
    }

    process.stderr.write(`${parts.join(' | ')}\n`);
  } catch (err) {
    logHookError('swarm-download', 'download failed', err);
  }
}

main().catch(createErrorHandler('swarm-download', { exit: true }));
