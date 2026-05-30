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
import { isMainEntry } from './_dispatcher-utils.js';
import {
  assertEgressAllowed,
  EgressBlockedError,
  loadAllowlist,
} from '../../lib/privacy/data-egress-guard.js';

/**
 * Safely import a module via dynamic import. Returns null on failure
 * so callers can degrade gracefully without throwing into stdout.
 * @param {string} filePath - Absolute filesystem path to ESM module
 * @returns {Promise<object|null>}
 */
async function safeImport(filePath) {
  try {
    return await import(toFileUrl(filePath));
  } catch (err) {
    logHookError('swarm-download', `dynamic import failed: ${filePath}`, err);
    return null;
  }
}

/**
 * DATA POLICY gate for the HTTP backend: ensure the configured swarm server
 * URL is on the egress allowlist before any network I/O. Returns true when
 * egress is allowed (or only soft-failed), false when the caller should abort.
 * @param {object} swarmCfg - Resolved swarm config section
 * @returns {boolean}
 */
export function checkHttpEgressAllowed(swarmCfg) {
  const serverUrl =
    process.env.ARTIBOT_SWARM_SERVER || swarmCfg?.serverUrl || 'http://localhost:3000';
  try {
    assertEgressAllowed(serverUrl, { allowlist: loadAllowlist(), reason: 'swarm-download' });
    return true;
  } catch (egressErr) {
    if (egressErr instanceof EgressBlockedError) {
      process.stderr.write(`[swarm-download] Skipped by DATA POLICY: ${egressErr.message}\n`);
    } else {
      logHookError('swarm-download', 'egress guard threw unexpectedly', egressErr);
    }
    return false;
  }
}

/**
 * HTTP backend pre-flight health check. checkHealth(options) expects an
 * options object with `.config` and returns { status, latency } where
 * status === 'healthy' on success. Failures are non-critical: log and treat
 * the server as unhealthy so the caller skips the download to be safe.
 * @param {string} pluginRoot - Absolute plugin root path
 * @param {object} swarmCfg - Resolved swarm config section
 * @returns {Promise<boolean>}
 */
export async function checkHttpServerHealthy(pluginRoot, swarmCfg) {
  try {
    const clientPath = path.join(pluginRoot, 'lib', 'swarm', 'swarm-client.js');
    const clientMod = await safeImport(clientPath);
    if (!clientMod?.checkHealth) return true;
    const health = await clientMod.checkHealth({ config: swarmCfg });
    const healthy = health?.status === 'healthy';
    if (!healthy) {
      process.stderr.write('[swarm-download] Server unhealthy, skipping download\n');
    }
    return healthy;
  } catch (err) {
    logHookError('swarm-download', 'health check threw', err);
    return false;
  }
}

async function main() {
  // Outer guard: NEVER let any error escape to stdout.
  // Claude Code parses hook stdout as JSON; non-empty stdout with non-JSON
  // text triggers "Invalid or unexpected token" parse errors.
  try {
    let raw;
    try {
      raw = await readStdin();
    } catch (err) {
      logHookError('swarm-download', 'stdin read failed', err);
      return;
    }

    const hookData = parseJSON(raw);
    // Require session context
    if (!hookData) return;

    let pluginRoot;
    try {
      pluginRoot = getPluginRoot();
    } catch (err) {
      logHookError('swarm-download', 'plugin root resolve failed', err);
      return;
    }

    // Dynamic imports to avoid loading heavy modules when swarm is disabled
    const configPath = path.join(pluginRoot, 'lib', 'core', 'config.js');
    const swarmConfigPath = path.join(pluginRoot, 'lib', 'swarm', 'swarm-config.js');
    const syncPath = path.join(pluginRoot, 'lib', 'swarm', 'sync-scheduler.js');

    const configMod = await safeImport(configPath);
    const swarmConfigMod = await safeImport(swarmConfigPath);
    if (!configMod || !swarmConfigMod) return;

    const { loadConfig } = configMod;
    const { isSwarmActive, getSwarmConfig } = swarmConfigMod;

    let config;
    try {
      config = await loadConfig();
    } catch (err) {
      logHookError('swarm-download', 'loadConfig failed', err);
      return;
    }

    // Early exit if not opted in
    let active = false;
    try {
      active = await isSwarmActive(config);
    } catch (err) {
      logHookError('swarm-download', 'isSwarmActive failed', err);
      return;
    }
    if (!active) {
      process.stderr.write('[swarm-download] Skipped: not opted in\n');
      return;
    }

    let swarmCfg;
    try {
      swarmCfg = getSwarmConfig(config);
    } catch (err) {
      logHookError('swarm-download', 'getSwarmConfig failed', err);
      return;
    }

    // DATA POLICY gate at hook level: refuse to talk to any swarm server
    // outside the egress allowlist. swarm-client.js has its own SSRF allowlist
    // for defence-in-depth; the hook-level check ensures the policy decision
    // is logged before any network I/O is initiated.
    // Git backend transport uses the git binary (push/pull), not the fetch
    // egress guard, so the HTTP allowlist check is only meaningful for the
    // HTTP backend. Skip it for git to avoid blocking a valid git sync path.
    if (swarmCfg?.backend !== 'git' && !checkHttpEgressAllowed(swarmCfg)) {
      return;
    }

    // Quick health check before attempting sync.
    // Git backend: skip the HTTP pre-flight health check entirely. A
    // never-initialized clone reports ok:false, so gating on it would prevent
    // the very first sync from bootstrapping (onSessionStart ->
    // gitDownloadLatestWeights -> ensureSwarmClone performs the first clone).
    const serverHealthy =
      swarmCfg?.backend === 'git'
        ? true
        : await checkHttpServerHealthy(pluginRoot, swarmCfg);

    // Download latest global weights and merge into local
    const syncMod = await safeImport(syncPath);
    if (!syncMod) return;
    const { onSessionStart, scheduleSync } = syncMod;

    const parts = ['[swarm-download] Session start sync complete'];

    if (serverHealthy) {
      try {
        const result = await onSessionStart({ config: swarmCfg });
        if (result?.downloaded) parts.push(`downloaded: v${result.version ?? '?'}`);
        if (!result?.downloaded) parts.push('no new weights');
      } catch (err) {
        logHookError('swarm-download', 'onSessionStart failed', err);
        parts.push('download error');
      }
    }

    // Schedule periodic sync if interval is not session-only
    if (swarmCfg?.syncInterval && swarmCfg.syncInterval !== 'session') {
      try {
        const scheduleResult = await scheduleSync({
          interval: swarmCfg.syncInterval,
          config: swarmCfg,
        });
        if (scheduleResult?.scheduled) {
          parts.push(`scheduled: ${swarmCfg.syncInterval}`);
        }
      } catch (err) {
        logHookError('swarm-download', 'scheduleSync failed', err);
      }
    }

    process.stderr.write(`${parts.join(' | ')}\n`);
  } catch (err) {
    // Last-resort catch: anything unexpected goes to stderr only.
    logHookError('swarm-download', 'unexpected failure', err);
  }
}

// Hook contract: never write to stdout (Claude Code parses stdout as JSON).
// Use exit:true so any rejection that escapes main() is logged to stderr
// and the process exits cleanly with code 0.
// isMainEntry guard: importing this module (e.g. from tests) must NOT fire
// main() — only run when invoked directly as the hook entry point.
if (isMainEntry(import.meta.url)) {
  main().catch(createErrorHandler('swarm-download', { exit: true }));
}
