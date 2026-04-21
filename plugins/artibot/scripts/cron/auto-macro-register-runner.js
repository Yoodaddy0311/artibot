#!/usr/bin/env node
/**
 * Auto Macro-Register Runner — AGO Self-Control (B1).
 *
 * External scheduler / manual CLI entrypoint that sweeps pending macro
 * suggestions and auto-registers those that meet the strict criteria defined
 * in `lib/learning/macro-learner.js#tryAutoRegister`.
 *
 * Gate model (shared shape with auto-commit / auto-pr):
 *   1. Opt-out: `ago.selfControl.masterEnabled === false` OR
 *      `ago.selfControl.autoMacroRegister.enabled === false` blocks the run.
 *      Default / missing keys = ON.
 *   2. Kill switch: three critical failures in a row auto-disables the feature.
 *   3. First-run guard: first N runs are observe-only — sweep still executes,
 *      but the macro-learner short-circuits each suggestion with `observe-only`.
 *
 * Every attempt — gated or not — is written to the Decision Trail.
 *
 * Usage:
 *   node scripts/cron/auto-macro-register-runner.js
 *   node scripts/cron/auto-macro-register-runner.js --dry-run
 *
 * @module scripts/cron/auto-macro-register-runner
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readJsonFile } from '../../lib/core/file.js';
import { getPluginRoot } from '../../lib/core/platform.js';
import { recordDecision } from '../../lib/core/decision-trail.js';

const __filename = fileURLToPath(import.meta.url);

// ---------------------------------------------------------------------------
// Gate check (shared shape with auto-commit / auto-pr)
// ---------------------------------------------------------------------------

/**
 * Explicit opt-out check — default ON.
 *
 * @param {object} config
 * @returns {{allowed: boolean, reason?: string}}
 */
export function checkGates(config) {
  const sc = config?.ago?.selfControl;
  if (sc?.masterEnabled === false) {
    return { allowed: false, reason: 'masterEnabled=false' };
  }
  if (sc?.autoMacroRegister?.enabled === false) {
    return { allowed: false, reason: 'autoMacroRegister.enabled=false' };
  }
  return { allowed: true };
}

// ---------------------------------------------------------------------------
// Dynamic module loaders (tolerant to missing siblings)
// ---------------------------------------------------------------------------

async function loadKillSwitch() {
  try {
    const mod = await import('../../lib/learning/kill-switch.js');
    return {
      isKillSwitchTripped: mod.isKillSwitchTripped || (async () => false),
      recordFailure: mod.recordFailure || (async () => undefined),
    };
  } catch {
    return {
      isKillSwitchTripped: async () => false,
      recordFailure: async () => undefined,
    };
  }
}

async function loadFirstRunGuard() {
  try {
    const mod = await import('../../lib/learning/first-run-guard.js');
    return {
      shouldObserveOnly: mod.shouldObserveOnly || (async () => ({ shouldObserve: false })),
      bumpRunCounter: mod.bumpRunCounter || (async () => undefined),
    };
  } catch {
    return {
      shouldObserveOnly: async () => ({ shouldObserve: false }),
      bumpRunCounter: async () => undefined,
    };
  }
}

async function loadMacroLearner() {
  const mod = await import('../../lib/learning/macro-learner.js');
  return { sweepAutoRegister: mod.sweepAutoRegister };
}

// ---------------------------------------------------------------------------
// Core pipeline (exported for tests; accepts injected deps)
// ---------------------------------------------------------------------------

/**
 * @param {object} deps
 * @param {string} deps.pluginRoot
 * @param {object} deps.config
 * @param {boolean} [deps.dryRun]
 * @param {object} [deps.logger]
 * @param {object} [deps.killSwitch]
 * @param {object} [deps.firstRunGuard]
 * @param {object} [deps.macroLearner]
 * @param {Function} [deps.trail]
 * @returns {Promise<{ran: boolean, reason?: string, registered?: number, skipped?: number, observeMode?: boolean}>}
 */
export async function runAutoMacroRegister(deps) {
  const {
    pluginRoot,
    config,
    dryRun = false,
    logger = console,
    killSwitch,
    firstRunGuard,
    macroLearner,
    trail = recordDecision,
  } = deps;

  // Gate 1: explicit user opt-out.
  const gate = checkGates(config);
  if (!gate.allowed) {
    await trail({
      subsystem: 'auto-macro-register',
      action: 'refused',
      reason: gate.reason,
    });
    logger.log(`auto-macro-register: skipped — ${gate.reason}`);
    return { ran: false, reason: gate.reason };
  }

  // Gate 2: kill switch.
  const ks = killSwitch || (await loadKillSwitch());
  if (await ks.isKillSwitchTripped(config, { pluginRoot, feature: 'auto-macro-register' })) {
    await trail({
      subsystem: 'auto-macro-register',
      action: 'refused',
      reason: 'kill-switch-tripped',
    });
    logger.log('auto-macro-register: skipped — kill-switch tripped');
    return { ran: false, reason: 'kill-switch-tripped' };
  }

  // Gate 3: first-run guard (bump counter; observe flag is enforced per-entry
  // by macro-learner itself, so we still execute the sweep).
  const frg = firstRunGuard || (await loadFirstRunGuard());
  const observeState = await frg.shouldObserveOnly('auto-macro-register', config, { pluginRoot });
  await frg.bumpRunCounter('auto-macro-register', config, { pluginRoot });

  if (dryRun) {
    await trail({
      subsystem: 'auto-macro-register',
      action: 'dry-run',
      inputs: { observeMode: Boolean(observeState?.shouldObserve) },
    });
    logger.log('auto-macro-register: dry-run — would sweep pending suggestions');
    return { ran: false, reason: 'dry-run', observeMode: Boolean(observeState?.shouldObserve) };
  }

  const ml = macroLearner || (await loadMacroLearner());
  try {
    const result = await ml.sweepAutoRegister({ pluginRoot, config });
    const registered = Array.isArray(result?.registered) ? result.registered.length : 0;
    const skipped = Array.isArray(result?.skipped) ? result.skipped.length : 0;
    await trail({
      subsystem: 'auto-macro-register',
      action: registered > 0 ? 'registered' : 'swept',
      reason: result?.reason,
      outputs: { registered, skipped, observeMode: Boolean(observeState?.shouldObserve) },
    });
    logger.log(
      `auto-macro-register: registered=${registered} skipped=${skipped}${
        result?.reason ? ` reason=${result.reason}` : ''
      }`,
    );
    return {
      ran: true,
      registered,
      skipped,
      observeMode: Boolean(observeState?.shouldObserve),
      reason: result?.reason,
    };
  } catch (err) {
    await ks.recordFailure(
      { feature: 'auto-macro-register', error: err.message || String(err) },
      config,
      { pluginRoot },
    );
    throw err;
  }
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

async function main() {
  const dryRun = process.argv.slice(2).includes('--dry-run');
  const pluginRoot = getPluginRoot();
  const configPath = path.join(pluginRoot, 'artibot.config.json');
  const config = (await readJsonFile(configPath)) || {};

  const result = await runAutoMacroRegister({ pluginRoot, config, dryRun });
  process.stdout.write(`auto-macro-register: ${JSON.stringify(result)}\n`);
  process.exit(0);
}

const isDirectRun = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(__filename);

if (isDirectRun) {
  main().catch((err) => {
    process.stderr.write(`auto-macro-register cron failed: ${err.message}\n`);
    process.exit(1);
  });
}
