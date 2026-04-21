#!/usr/bin/env node
/**
 * AGO Self-Control Wave 1 — Auto-Cleanup Runner.
 *
 * Runs deterministic formatters / linters (currently `eslint --fix`) on the
 * working tree, then classifies the resulting diff. Only low-risk results
 * are accepted; otherwise changes are rolled back.
 *
 * Gate model (default-ON, 1+1 shape):
 *   1. Opt-out gates: `ago.selfControl.masterEnabled` or
 *      `ago.selfControl.autoCleanup.enabled` explicitly set to `false` blocks
 *      the run. Default/missing = ON.
 *   2. Kill switch: three critical failures in a row auto-disables the feature.
 *   3. First-run guard: first N runs are observe-only (rollback immediately,
 *      log `would-cleanup` decision).
 *   4. Critical blocker: classifier must return `low`; anything else is
 *      rolled back unconditionally.
 *
 * The legacy `ARTIBOT_SELF_CONTROL` env var gate has been removed.
 *
 * Limits:
 *   - `maxFilesPerRun` (default 20) from config.
 *
 * Usage:
 *   node scripts/cron/auto-cleanup-runner.js [--dry-run]
 *
 * @module scripts/cron/auto-cleanup-runner
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readJsonFile } from '../../lib/core/file.js';
import { getPluginRoot } from '../../lib/core/platform.js';
import { recordDecision } from '../../lib/core/decision-trail.js';
import { classifyDiff } from '../../lib/learning/risk-classifier.js';
import {
  rollback,
  snapshot,
} from '../../lib/learning/rollback-guard.js';
import {
  reportCriticalFailure,
  resolveSelfControlGates,
} from '../../lib/learning/self-control-gates.js';
import {
  acquireLock,
  collectDiff,
  releaseLock,
} from './auto-commit-runner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Spawn helper
// ---------------------------------------------------------------------------

function run(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, shell: false });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => { stdout += d.toString(); });
    child.stderr?.on('data', (d) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });
}

// ---------------------------------------------------------------------------
// Gate check (shared shape with auto-commit)
// ---------------------------------------------------------------------------

/**
 * Explicit opt-out check — default ON.
 *
 * @param {object} config
 * @param {NodeJS.ProcessEnv} [_env] Deprecated — kept for signature compatibility.
 * @returns {{allowed: boolean, reason?: string}}
 */
export function checkGates(config, _env) {
  const sc = config?.ago?.selfControl;
  if (sc?.masterEnabled === false) return { allowed: false, reason: 'masterEnabled=false' };
  if (sc?.autoCleanup?.enabled === false) return { allowed: false, reason: 'autoCleanup.enabled=false' };
  return { allowed: true };
}

// ---------------------------------------------------------------------------
// Tools registry — deterministic transforms only
// ---------------------------------------------------------------------------

const TOOLS = Object.freeze({
  'eslint-fix': {
    cmd: process.platform === 'win32' ? 'npx.cmd' : 'npx',
    args: ['eslint', '--fix', 'lib/', 'scripts/'],
  },
});

export function resolveTools(names) {
  const list = Array.isArray(names) ? names : ['eslint-fix'];
  return list.map((n) => TOOLS[n]).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Core pipeline
// ---------------------------------------------------------------------------

/**
 * Execute each configured deterministic fix tool. Tool exit codes are logged
 * but do not short-circuit — individual tools are best-effort.
 *
 * @param {Array<{cmd: string, args: string[]}>} tools
 * @param {Function} runner
 * @param {string} cwd
 * @param {object} logger
 * @returns {Promise<void>}
 */
async function executeTools(tools, runner, cwd, logger) {
  for (const tool of tools) {
    const res = await runner(tool.cmd, tool.args, cwd);
    if (res.code !== 0) {
      logger.log(`auto-cleanup: tool exited ${res.code} — ${(res.stderr || '').trim()}`);
    }
  }
}

/**
 * Observe-only rollback + decision trail.
 *
 * @returns {Promise<object>} result bag
 */
async function handleObserveRollback({ guard, cwd, snap, diff, classification, mode, trail, logger }) {
  const rb = await guard.rollback(snap, { cwd });
  await trail({
    subsystem: 'auto-cleanup',
    action: 'would-cleanup',
    reason: `first-run observe mode (${mode || 'observe'})`,
    outputs: {
      files: diff.files.map((f) => f.path),
      level: classification.level,
      reverted: rb.reverted,
    },
  });
  logger.log(`auto-cleanup: observe-only — would format ${diff.files.length} files`);
  return {
    ran: false,
    reason: 'first-run-observe-mode',
    observe: true,
    changed: diff.files.length,
    rolledBack: rb.reverted,
    classification,
  };
}

/**
 * Post-tool classification: apply, rollback, or finalize dry-run.
 *
 * @returns {Promise<object>} result bag
 */
async function finalizeCleanup({ guard, cwd, snap, diff, classification, dryRun, trail }) {
  if (classification.level !== 'low') {
    const rb = await guard.rollback(snap, { cwd });
    await trail({
      subsystem: 'auto-cleanup',
      action: 'rolled-back',
      reason: `non-low classification: ${classification.level}`,
      outputs: { reverted: rb.reverted, level: classification.level },
    });
    return { ran: true, changed: diff.files.length, rolledBack: true, classification };
  }
  if (dryRun) {
    const rb = await guard.rollback(snap, { cwd });
    return { ran: true, changed: diff.files.length, dryRun: true, rolledBack: rb.reverted };
  }
  await trail({
    subsystem: 'auto-cleanup',
    action: 'applied',
    reason: `${diff.files.length} files formatted`,
    outputs: { files: diff.files.map((f) => f.path) },
  });
  return { ran: true, changed: diff.files.length, rolledBack: false, classification };
}

/**
 * @param {object} deps
 */
export async function runAutoCleanup(deps) {
  const {
    cwd, config, dryRun = false, logger = console,
    runner = run, gitOps = { collectDiff },
    guard = { snapshot, rollback },
    classify = classifyDiff, trail = recordDecision,
    killSwitch, firstRunGuard,
  } = deps;

  const gates = await resolveSelfControlGates('autoCleanup', config, {
    pluginRoot: cwd, killSwitch, firstRunGuard,
  });
  if (!gates.proceed) {
    logger.log(`auto-cleanup: skipped — ${gates.reason}`);
    if (gates.reason === 'kill-switch tripped') {
      await trail({ subsystem: 'auto-cleanup', action: 'refused', reason: 'kill-switch tripped' });
    }
    return { ran: false, reason: gates.reason };
  }

  const cleanup = config.ago.selfControl.autoCleanup;
  const maxFiles = Number.isFinite(cleanup.maxFilesPerRun) ? cleanup.maxFilesPerRun : 20;
  const tools = resolveTools(cleanup.tools);
  if (tools.length === 0) return { ran: false, reason: 'no tools configured' };

  try {
    const snap = await guard.snapshot({ cwd });
    await executeTools(tools, runner, cwd, logger);

    const diff = await gitOps.collectDiff(cwd);
    if (diff.files.length === 0) {
      logger.log('auto-cleanup: no changes produced');
      return { ran: true, changed: 0 };
    }
    if (diff.files.length > maxFiles) diff.files = diff.files.slice(0, maxFiles);
    const classification = classify(diff);

    if (gates.observeOnly) {
      return handleObserveRollback({
        guard, cwd, snap, diff, classification, mode: gates.mode, trail, logger,
      });
    }
    return finalizeCleanup({ guard, cwd, snap, diff, classification, dryRun, trail });
  } catch (err) {
    await reportCriticalFailure('autoCleanup', err, config, { killSwitch, pluginRoot: cwd });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const pluginRoot = getPluginRoot() || path.resolve(__dirname, '..', '..');
  const configPath = path.join(pluginRoot, 'artibot.config.json');
  const config = (await readJsonFile(configPath)) || {};

  if (!acquireLock(pluginRoot)) {
    process.stderr.write('auto-cleanup: lock held by another process\n');
    process.exit(0);
  }
  try {
    const result = await runAutoCleanup({ cwd: pluginRoot, config, dryRun });
    process.stdout.write(`auto-cleanup: ${JSON.stringify(result)}\n`);
  } finally {
    releaseLock(pluginRoot);
  }
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}` ||
    import.meta.url === pathToFileURLSafe(process.argv[1])) {
  main().catch((err) => {
    process.stderr.write(`auto-cleanup cron failed: ${err.message}\n`);
    process.exit(1);
  });
}

function pathToFileURLSafe(p) {
  try { return new URL(`file://${path.resolve(p)}`).href; } catch { return ''; }
}
