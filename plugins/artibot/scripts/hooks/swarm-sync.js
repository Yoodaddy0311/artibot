#!/usr/bin/env node
/**
 * SessionEnd hook: Swarm Sync.
 *
 * Automatically syncs swarm data at session end if the user has opted in.
 * Runs after the learning pipeline and before session cleanup.
 *
 * Flow:
 *   1. Load swarm config → check opt-in
 *   2. Package local patterns
 *   3. Apply PII scrubbing + differential privacy
 *   4. Upload to swarm server (or queue offline)
 *   5. Download latest global weights
 *   6. Merge into local patterns
 */

import path from 'node:path';
import { getPluginRoot, parseJSON, readStdin, toFileUrl } from '../utils/index.js';
import { createErrorHandler, logHookError } from '../../lib/core/hook-utils.js';
import {
  assertEgressAllowed,
  EgressBlockedError,
  loadAllowlist,
} from '../../lib/privacy/data-egress-guard.js';

async function main() {
  const raw = await readStdin();
  const hookData = parseJSON(raw);

  // Require session context
  if (!hookData) return;

  const pluginRoot = getPluginRoot();

  // Dynamic imports to avoid loading heavy modules when swarm is disabled
  const configPath = path.join(pluginRoot, 'lib', 'core', 'config.js');
  const swarmConfigPath = path.join(pluginRoot, 'lib', 'swarm', 'swarm-config.js');
  const dpPath = path.join(pluginRoot, 'lib', 'privacy', 'differential-privacy.js');
  const syncPath = path.join(pluginRoot, 'lib', 'swarm', 'sync-scheduler.js');

  try {
    const { loadConfig } = await import(toFileUrl(configPath));
    const { isSwarmActive, getSwarmConfig } = await import(toFileUrl(swarmConfigPath));

    const config = await loadConfig();

    // Early exit if not opted in
    const active = await isSwarmActive(config);
    if (!active) {
      process.stderr.write('[swarm-sync] Skipped: not opted in\n');
      return;
    }

    const swarmCfg = getSwarmConfig(config);

    // DATA POLICY gate: only proceed if the configured swarm server URL is on
    // the egress allowlist (localhost is auto-allowed for self-hosted swarms).
    // swarm-client.js already enforces an internal SSRF allowlist, but we
    // surface the DATA POLICY check at the hook level so deployment-time
    // misconfiguration is logged and blocked before any network I/O.
    const serverUrl =
      process.env.ARTIBOT_SWARM_SERVER || swarmCfg?.serverUrl || 'http://localhost:3000';
    try {
      assertEgressAllowed(serverUrl, {
        allowlist: loadAllowlist(),
        reason: 'swarm-sync',
      });
    } catch (egressErr) {
      if (egressErr instanceof EgressBlockedError) {
        process.stderr.write(
          `[swarm-sync] Skipped by DATA POLICY: ${egressErr.message}\n`,
        );
        return;
      }
      throw egressErr;
    }

    // Build noise function if differential privacy is enabled
    let addNoise;
    if (swarmCfg.differentialPrivacy?.enabled) {
      const { createNoiseFunction } = await import(toFileUrl(dpPath));
      addNoise = createNoiseFunction(swarmCfg.differentialPrivacy);
    }

    // Run session-end sync
    const { onSessionEnd } = await import(toFileUrl(syncPath));
    const result = await onSessionEnd({
      config: swarmCfg,
      addNoise,
    });

    const parts = ['[swarm-sync] Session sync complete'];
    if (result?.uploaded) parts.push(`uploaded: v${result.uploadVersion ?? '?'}`);
    if (result?.downloaded) parts.push(`downloaded: v${result.downloadVersion ?? '?'}`);
    if (result?.queued) parts.push('queued offline');
    if (result?.error) parts.push(`error: ${result.error}`);

    process.stderr.write(`${parts.join(' | ')}\n`);

    // Cancel any periodic sync timers to prevent orphaned timers
    try {
      const { cancelSync } = await import(toFileUrl(syncPath));
      cancelSync();
    } catch {
      // Non-critical: timer may not exist
    }

    // Report session telemetry to swarm server
    try {
      const clientPath = path.join(pluginRoot, 'lib', 'swarm', 'swarm-client.js');
      const { reportTelemetry } = await import(toFileUrl(clientPath));
      await reportTelemetry({
        sessionId: hookData.session_id || 'unknown',
        duration: hookData.duration || 0,
        toolCount: hookData.tool_count || 0,
        timestamp: new Date().toISOString(),
      }, swarmCfg);
    } catch (err) {
      logHookError('swarm-sync', 'telemetry failed', err);
    }
  } catch (err) {
    logHookError('swarm-sync', 'sync failed', err);
  }
}

main().catch(createErrorHandler('swarm-sync', { exit: true }));
