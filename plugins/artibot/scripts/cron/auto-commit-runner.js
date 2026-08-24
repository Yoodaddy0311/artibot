#!/usr/bin/env node
/**
 * AGO Self-Control Wave 1 — Auto-Commit Runner.
 *
 * Reads git working-tree changes, classifies their risk, and (if within
 * `ago.selfControl.autoCommit.maxRiskLevel`) creates a local commit.
 * On post-commit regression, it rolls back to the pre-commit HEAD.
 *
 * Gate model (default-ON, 1+1 shape):
 *   1. Opt-out gates: `ago.selfControl.masterEnabled` or
 *      `ago.selfControl.autoCommit.enabled` explicitly set to `false` blocks
 *      the run. Default/missing = ON.
 *   2. Kill switch: three critical failures in a row auto-disables the feature
 *      via `lib/learning/kill-switch.js`.
 *   3. First-run guard: first N runs are observe-only, logging `would-commit`
 *      decisions without touching git.
 *   4. Critical blocker: risk classifier rejects protected files
 *      (package.json, artibot.config.json, plugin.json) and `critical` level.
 *
 * The legacy `ARTIBOT_SELF_CONTROL` env var gate has been removed.
 *
 * Hard safety rails (unchanged):
 *   - Never calls `git push`.
 *   - Never commits files whose classified level is `critical`.
 *   - Single-process lock via `runtime/auto-commit.lock` with PID + timestamp.
 *
 * Usage:
 *   node scripts/cron/auto-commit-runner.js [--dry-run]
 *
 * @module scripts/cron/auto-commit-runner
 */

import { spawn } from 'node:child_process';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readJsonFile } from '../../lib/core/file.js';
import { getPluginRoot } from '../../lib/core/platform.js';
import { recordDecision } from '../../lib/core/decision-trail.js';
import {
  classifyDiff,
  isWithinRiskCeiling,
} from '../../lib/learning/risk-classifier.js';
import {
  rollback,
  runValidation,
  snapshot,
  validateAgainstBaseline,
} from '../../lib/learning/rollback-guard.js';
import {
  reportCriticalFailure,
  resolveSelfControlGates,
} from '../../lib/learning/self-control-gates.js';
import { isMainEntry } from '../hooks/_main-entry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Git helpers — all via spawn argv (no shell interpolation)
// ---------------------------------------------------------------------------

function runGit(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, shell: false });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => { stdout += d.toString(); });
    child.stderr?.on('data', (d) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });
}

/**
 * Collect changed files via `git status --porcelain` and `git diff --numstat`.
 *
 * @param {string} cwd
 * @returns {Promise<{files: Array<{path: string, status: string, additions: number, deletions: number}>}>}
 */
export async function collectDiff(cwd) {
  const porcelain = await runGit(['status', '--porcelain'], cwd);
  if (porcelain.code !== 0) throw new Error(`git status failed: ${porcelain.stderr}`);
  const files = [];
  for (const line of porcelain.stdout.split('\n')) {
    if (!line.trim()) continue;
    const code = line.slice(0, 2);
    const filePath = line.slice(3).trim();
    let status = 'M';
    if (code.includes('A') || code.includes('?')) status = 'A';
    else if (code.includes('D')) status = 'D';
    files.push({ path: filePath, status, additions: 0, deletions: 0 });
  }
  if (files.length === 0) return { files };

  const numstat = await runGit(['diff', 'HEAD', '--numstat'], cwd);
  if (numstat.code === 0) {
    for (const line of numstat.stdout.split('\n')) {
      const [a, d, p] = line.split('\t');
      if (!p) continue;
      const entry = files.find((f) => f.path === p.trim());
      if (entry) {
        entry.additions = Number.parseInt(a, 10) || 0;
        entry.deletions = Number.parseInt(d, 10) || 0;
      }
    }
  }
  return { files };
}

// ---------------------------------------------------------------------------
// Lock file (single-instance guard)
// ---------------------------------------------------------------------------

function lockPath(pluginRoot) {
  return path.join(pluginRoot, 'runtime', 'auto-commit.lock');
}

export function acquireLock(pluginRoot) {
  const p = lockPath(pluginRoot);
  try {
    fsSync.mkdirSync(path.dirname(p), { recursive: true });
    fsSync.writeFileSync(
      p,
      JSON.stringify({ pid: process.pid, timestamp: new Date().toISOString() }),
      { flag: 'wx' },
    );
    return true;
  } catch (err) {
    if (err.code === 'EEXIST') return false;
    throw err;
  }
}

export function releaseLock(pluginRoot) {
  try { fsSync.unlinkSync(lockPath(pluginRoot)); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Main flow
// ---------------------------------------------------------------------------

/**
 * Determine whether the user has explicitly opted out.
 *
 * New default-ON policy: only block when `masterEnabled === false` or
 * `autoCommit.enabled === false`. Missing keys = enabled.
 *
 * The `env` parameter is retained for backwards compatibility with existing
 * callers but `ARTIBOT_SELF_CONTROL` is no longer consulted.
 *
 * @param {object} config
 * @param {NodeJS.ProcessEnv} [_env] Deprecated — retained for signature compatibility.
 * @returns {{allowed: boolean, reason?: string}}
 */
export function checkGates(config, _env) {
  const sc = config?.ago?.selfControl;
  if (sc?.masterEnabled === false) return { allowed: false, reason: 'masterEnabled=false' };
  if (sc?.autoCommit?.enabled === false) return { allowed: false, reason: 'autoCommit.enabled=false' };
  return { allowed: true };
}

/**
 * Assess the current working-tree diff against the configured risk ceiling.
 *
 * @param {object} args
 * @param {string} args.cwd
 * @param {object} args.gitOps
 * @param {Function} args.classify
 * @param {string} args.maxLevel
 * @param {Function} args.trail
 * @param {object} args.logger
 * @returns {Promise<{empty?: boolean, over?: boolean, diff?: object, classification?: object}>}
 */
async function assessRisk({ cwd, gitOps, classify, maxLevel, trail, logger }) {
  const diff = await gitOps.collectDiff(cwd);
  if (diff.files.length === 0) {
    logger.log('auto-commit: no changes');
    return { empty: true };
  }
  const classification = classify(diff);
  if (!isWithinRiskCeiling(classification.level, maxLevel)) {
    await trail({
      subsystem: 'auto-commit',
      action: 'refused',
      reason: `level=${classification.level} exceeds ceiling=${maxLevel}`,
      inputs: { files: diff.files.map((f) => f.path) },
      outputs: { level: classification.level },
    });
    logger.log(`auto-commit: refused — ${classification.level} > ${maxLevel}`);
    return { over: true, diff, classification };
  }
  return { diff, classification };
}

/**
 * Run baseline validation + take a rollback snapshot.
 *
 * @param {object} args
 * @param {string} args.cwd
 * @param {object} args.guard
 * @param {object} args.ac - autoCommit config
 * @returns {Promise<{ok: boolean, reason?: string, baseline?: object, snap?: object}>}
 */
async function snapshotState({ cwd, guard, ac }) {
  const baseline = await guard.runValidation({ cwd });
  if (ac.requiredTestsPass && !baseline.tests.passed) {
    return { ok: false, reason: 'baseline tests failing' };
  }
  if (ac.requiredLintClean && !baseline.lint.passed) {
    return { ok: false, reason: 'baseline lint failing' };
  }
  const snap = await guard.snapshot({ cwd });
  return { ok: true, baseline, snap };
}

/**
 * Perform the actual `git add -A && git commit -m ...`.
 *
 * @param {object} args
 * @param {string} args.cwd
 * @param {object} args.gitOps
 * @param {object} args.classification
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
async function executeCommit({ cwd, gitOps, classification }) {
  const add = await gitOps.runGit(['add', '-A'], cwd);
  if (add.code !== 0) return { ok: false, reason: 'git add failed' };
  const msg = `chore(artibot-auto): ${classification.level}-risk auto-commit [skip ci]`;
  const commit = await gitOps.runGit(['commit', '-m', msg], cwd);
  if (commit.code !== 0) return { ok: false, reason: 'git commit failed' };
  return { ok: true };
}

/**
 * Post-commit: run validation against baseline; on regression, rollback.
 * Rollback failures are reported to the kill-switch and re-thrown.
 *
 * @param {object} args
 * @returns {Promise<{rolledBack: boolean, regressions?: string[]}>}
 */
async function validateAndRollback({ cwd, guard, baseline, snap, trail, config, killSwitch }) {
  const check = await guard.validateAgainstBaseline(baseline, { cwd });
  if (check.passed) return { rolledBack: false };

  const rb = await guard.rollback(snap, { cwd }).catch(async (rbErr) => {
    await reportCriticalFailure('autoCommit', `rollback-failed: ${rbErr.message}`, config, {
      killSwitch, pluginRoot: cwd,
    });
    throw rbErr;
  });
  await trail({
    subsystem: 'auto-commit',
    action: 'rolled-back',
    reason: `regressions: ${check.regressions.join(',')}`,
    outputs: { sha: snap.sha, reverted: rb.reverted },
  });
  return { rolledBack: rb.reverted, regressions: check.regressions };
}

/**
 * Record an observe-only "would-commit" decision and return a result bag.
 *
 * @returns {Promise<object>}
 */
async function recordObserveDecision({ gates, diff, classification, trail, logger }) {
  await trail({
    subsystem: 'auto-commit',
    action: 'would-commit',
    reason: `first-run observe mode (${gates.mode || 'observe'})`,
    inputs: { files: diff.files.map((f) => f.path) },
    outputs: { level: classification.level },
  });
  logger.log(`auto-commit: observe-only — would commit ${diff.files.length} files (${classification.level})`);
  return { ran: false, reason: 'first-run-observe-mode', observe: true, classification };
}

/**
 * Mutating half of the commit pipeline (snapshot -> commit -> validate).
 *
 * @returns {Promise<object>} runAutoCommit result bag
 */
async function performCommitFlow(ctx) {
  const { cwd, guard, ac, dryRun, diff, classification, gitOps, trail, config, killSwitch, logger } = ctx;
  const snapRes = await snapshotState({ cwd, guard, ac });
  if (!snapRes.ok) return { ran: false, reason: snapRes.reason };
  const { baseline, snap } = snapRes;
  if (dryRun) {
    logger.log(`auto-commit: dry-run — would commit ${diff.files.length} files at ${snap.sha}`);
    return { ran: false, reason: 'dry-run', classification, snapshot: snap };
  }
  const ex = await executeCommit({ cwd, gitOps, classification });
  if (!ex.ok) return { ran: false, reason: ex.reason };

  if (ac.rollbackOnRegression !== false) {
    const vr = await validateAndRollback({ cwd, guard, baseline, snap, trail, config, killSwitch });
    if (vr.regressions) {
      return { ran: true, committed: true, rolledBack: vr.rolledBack, regressions: vr.regressions };
    }
  }
  await trail({
    subsystem: 'auto-commit',
    action: 'committed',
    reason: `${classification.level}-risk auto-commit`,
    outputs: { sha: snap.sha, files: diff.files.length },
  });
  return { ran: true, committed: true, rolledBack: false, classification };
}

/**
 * Core pipeline. Exported for testability — the wrapper `main()` injects
 * real git/validation deps, tests can inject mocks via `deps`.
 *
 * @param {object} deps
 */
export async function runAutoCommit(deps) {
  const {
    cwd, config, dryRun = false, logger = console,
    gitOps = { collectDiff, runGit },
    guard = { snapshot, runValidation, validateAgainstBaseline, rollback },
    classify = classifyDiff, trail = recordDecision,
    killSwitch, firstRunGuard,
  } = deps;

  const gates = await resolveSelfControlGates('autoCommit', config, {
    pluginRoot: cwd, killSwitch, firstRunGuard,
  });
  if (!gates.proceed) {
    logger.log(`auto-commit: skipped — ${gates.reason}`);
    if (gates.reason === 'kill-switch tripped') {
      await trail({ subsystem: 'auto-commit', action: 'refused', reason: 'kill-switch tripped' });
    }
    return { ran: false, reason: gates.reason };
  }

  const ac = config.ago.selfControl.autoCommit;
  const risk = await assessRisk({
    cwd, gitOps, classify, trail, logger, maxLevel: ac.maxRiskLevel || 'low',
  });
  if (risk.empty) return { ran: false, reason: 'no changes' };
  if (risk.over) return { ran: false, reason: 'risk ceiling', classification: risk.classification };
  const { diff, classification } = risk;

  if (gates.observeOnly) {
    return recordObserveDecision({ gates, diff, classification, trail, logger });
  }

  try {
    return await performCommitFlow({
      cwd, guard, ac, dryRun, diff, classification, gitOps, trail, config, killSwitch, logger,
    });
  } catch (err) {
    await reportCriticalFailure('autoCommit', err, config, { killSwitch, pluginRoot: cwd });
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
    process.stderr.write('auto-commit: lock held by another process\n');
    process.exit(0);
  }
  try {
    const result = await runAutoCommit({ cwd: pluginRoot, config, dryRun });
    process.stdout.write(`auto-commit: ${JSON.stringify(result)}\n`);
  } finally {
    releaseLock(pluginRoot);
  }
  process.exit(0);
}

// Only run when invoked directly (not when imported by tests).
if (isMainEntry(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`auto-commit cron failed: ${err.message}\n`);
    process.exit(1);
  });
}
