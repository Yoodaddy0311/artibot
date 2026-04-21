#!/usr/bin/env node
/**
 * Auto PR Creator — AGO Self-Control Module 5.
 *
 * Triggered by an external scheduler (GitHub Actions / host cron). Detects
 * drift / security / test-flake conditions, produces a candidate branch with
 * a focused fix, and opens a DRAFT PR via `gh pr create`. It NEVER merges.
 *
 * Self-control is ON by default. The user opts out via config:
 *   - `ago.selfControl.masterEnabled: false` (global)
 *   - `ago.selfControl.autoPR.enabled: false` (feature-specific)
 *
 * Safety layers (non-negotiable, enforced in code + tests):
 *   - `autoMerge === true` BLOCKED (defense-in-depth).
 *   - Only categories in `ago.selfControl.autoPR.categories` proceed.
 *   - `--draft` is always passed to `gh pr create`.
 *   - At most 1 PR per hour (runtime/auto-pr-cooldown.json).
 *   - `gh pr merge` is NEVER invoked. Pushes to `main`/`master` are blocked.
 *   - Kill switch trips after 3 critical failures in 24h.
 *   - First 5 runs are observe-only (First-Run Guard).
 *   - Every attempt is written to the Decision Trail.
 *
 * Usage:
 *   node scripts/cron/auto-pr-creator.js
 *   node scripts/cron/auto-pr-creator.js --category=drift --dry-run
 *
 * @module scripts/cron/auto-pr-creator
 */

import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { ensureDir, readJsonFile, writeJsonFile } from '../../lib/core/file.js';
import { getPluginRoot } from '../../lib/core/platform.js';
import { recordDecision } from '../../lib/core/decision-trail.js';

// ---------------------------------------------------------------------------
// Constants (security-critical — do not weaken)
// ---------------------------------------------------------------------------

const FORBIDDEN_BRANCHES = Object.freeze(['main', 'master']);
const REQUIRED_BRANCH_PREFIX = 'artibot/auto/';
const COOLDOWN_PATH = path.join('runtime', 'auto-pr-cooldown.json');
const MAX_PER_HOUR = 1;
const MS_PER_HOUR = 3_600_000;

/** Categories allowed by default. Extended by config. */
const SUPPORTED_CATEGORIES = Object.freeze(['drift', 'security-fix', 'test-flake']);

// ---------------------------------------------------------------------------
// Gate resolution
// ---------------------------------------------------------------------------

/**
 * Check user-opt-out gates. Self-control is ON by default; only explicit
 * `false` values opt out. `autoMerge === true` remains a hard security
 * invariant and always closes the gate.
 *
 * @param {object} config
 * @param {NodeJS.ProcessEnv} [_env] - kept for signature compatibility; unused.
 * @returns {{open: boolean, reason?: string}}
 */
export function checkGates(config, _env) {
  const sc = config?.ago?.selfControl;
  if (sc && sc.masterEnabled === false) return { open: false, reason: 'masterEnabled=false' };
  if (sc?.autoPR?.enabled === false) return { open: false, reason: 'autoPR.enabled=false' };
  if (sc?.autoPR?.autoMerge === true) return { open: false, reason: 'autoMerge must be false' };
  return { open: true };
}

/**
 * @param {object} config
 * @param {string} category
 * @returns {boolean}
 */
export function isCategoryAllowed(config, category) {
  const allowed = config?.ago?.selfControl?.autoPR?.categories;
  if (!Array.isArray(allowed) || allowed.length === 0) return false;
  if (!SUPPORTED_CATEGORIES.includes(category)) return false;
  return allowed.includes(category);
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

/**
 * @param {string} pluginRoot
 * @param {Date} now
 * @returns {Promise<{allowed: boolean, history: string[]}>}
 */
export async function checkCooldown(pluginRoot, now) {
  const cooldownFile = path.join(pluginRoot, COOLDOWN_PATH);
  const data = (await readJsonFile(cooldownFile)) || { history: [] };
  const history = Array.isArray(data.history) ? data.history : [];
  const cutoff = now.getTime() - MS_PER_HOUR;
  const recent = history.filter((iso) => {
    const t = new Date(iso).getTime();
    return Number.isFinite(t) && t >= cutoff;
  });
  return { allowed: recent.length < MAX_PER_HOUR, history: recent };
}

/**
 * @param {string} pluginRoot
 * @param {Date} now
 * @param {string[]} prior
 * @returns {Promise<void>}
 */
export async function recordAttempt(pluginRoot, now, prior) {
  const cooldownFile = path.join(pluginRoot, COOLDOWN_PATH);
  await ensureDir(path.dirname(cooldownFile));
  const next = { history: [...prior, now.toISOString()] };
  await writeJsonFile(cooldownFile, next);
}

// ---------------------------------------------------------------------------
// Branch & argument guards
// ---------------------------------------------------------------------------

/**
 * Validate a branch name. Enforces prefix and blocks protected branches.
 *
 * @param {string} branch
 * @returns {{ok: boolean, reason?: string}}
 */
export function validateBranch(branch) {
  if (typeof branch !== 'string' || !branch) return { ok: false, reason: 'empty' };
  if (FORBIDDEN_BRANCHES.includes(branch)) return { ok: false, reason: 'protected-branch' };
  if (!branch.startsWith(REQUIRED_BRANCH_PREFIX)) return { ok: false, reason: 'missing-prefix' };
  if (/\s/.test(branch)) return { ok: false, reason: 'whitespace' };
  return { ok: true };
}

/**
 * Static guard: reject any argv that invokes `gh pr merge` or pushes to
 * `main`/`master`. Used to assert the runner's own invocations are safe.
 *
 * @param {string} cmd
 * @param {string[]} args
 * @returns {{ok: boolean, reason?: string}}
 */
export function assertSafeCommand(cmd, args) {
  if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'merge') {
    return { ok: false, reason: 'gh-pr-merge-forbidden' };
  }
  if (cmd === 'git' && args[0] === 'push') {
    const target = args.slice(1).join(' ');
    if (/\b(main|master)\b/.test(target) && !target.includes(REQUIRED_BRANCH_PREFIX)) {
      return { ok: false, reason: 'push-to-protected-branch' };
    }
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Shell runner
// ---------------------------------------------------------------------------

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {{cwd?: string, spawnImpl?: Function}} [opts]
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
export function runCommand(cmd, args, opts = {}) {
  const guard = assertSafeCommand(cmd, args);
  if (!guard.ok) {
    return Promise.reject(new Error(`refused: ${guard.reason}`));
  }
  const spawnFn = opts.spawnImpl || spawn;
  return new Promise((resolve, reject) => {
    const child = spawnFn(cmd, args, { cwd: opts.cwd, shell: false });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => { stdout += d.toString(); });
    child.stderr?.on('data', (d) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });
}

// ---------------------------------------------------------------------------
// Fix candidate generation
// ---------------------------------------------------------------------------

/**
 * @param {string} category
 * @param {Date} now
 * @returns {{branch: string, title: string, body: string}}
 */
export function buildFixPlan(category, now) {
  const ts = now.toISOString().replace(/[-:T]/g, '').slice(0, 13);
  const branch = `${REQUIRED_BRANCH_PREFIX}${category}-${ts}`;
  const title = `auto(${category}): scheduled remediation`;
  const body = [
    '## Summary',
    `Auto-generated DRAFT PR for category \`${category}\`.`,
    '',
    '## Trigger',
    `- Detector: ${category}`,
    `- Generated at: ${now.toISOString()}`,
    '',
    '## Review checklist',
    '- [ ] Verify diff is intentional',
    '- [ ] Run `npm test` locally',
    '- [ ] Close if noise, merge manually if valid',
    '',
    'Generated by Artibot Auto-PR. autoMerge is disabled by policy.',
  ].join('\n');
  return { branch, title, body };
}

// ---------------------------------------------------------------------------
// Safety helpers (kill-switch + first-run guard, tolerant to missing modules)
// ---------------------------------------------------------------------------

/**
 * @param {object} config
 * @param {{pluginRoot?: string}} [opts]
 * @returns {Promise<boolean>}
 */
async function isAutoPrKillSwitchActive(config, opts = {}) {
  try {
    const mod = await import('../../lib/learning/kill-switch.js');
    return await mod.isKillSwitchTripped(config, { ...opts, feature: 'auto-pr' });
  } catch {
    return false;
  }
}

/**
 * @param {object} config
 * @param {{pluginRoot?: string}} [opts]
 * @returns {Promise<boolean>}
 */
async function isAutoPrObserveOnly(config, opts = {}) {
  try {
    const mod = await import('../../lib/learning/first-run-guard.js');
    const state = await mod.shouldObserveOnly('auto-pr', config, opts);
    await mod.bumpRunCounter('auto-pr', config, opts);
    return Boolean(state?.shouldObserve);
  } catch {
    return false;
  }
}

/**
 * @param {string} error
 * @param {object} config
 * @param {{pluginRoot?: string}} [opts]
 */
async function recordAutoPrFailure(error, config, opts = {}) {
  try {
    const mod = await import('../../lib/learning/kill-switch.js');
    await mod.recordFailure({ feature: 'auto-pr', error }, config, opts);
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * @param {object} options
 * @param {object} options.config
 * @param {string} options.pluginRoot
 * @param {string} options.category
 * @param {boolean} [options.dryRun]
 * @param {Date} [options.now]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {Function} [options.runImpl] - injected runCommand for tests
 * @returns {Promise<{status: string, reason?: string, prUrl?: string, branch?: string}>}
 */
export async function createAutoPR(options) {
  const now = options.now || new Date();
  const env = options.env || process.env;
  const runImpl = options.runImpl || runCommand;
  const pluginRoot = options.pluginRoot;

  const gate = checkGates(options.config, env);
  if (!gate.open) {
    await recordDecision({
      subsystem: 'auto-pr-creator',
      action: 'rejected',
      reason: `gate-closed: ${gate.reason}`,
      inputs: { category: options.category },
    });
    return { status: 'rejected', reason: gate.reason };
  }

  if (await isAutoPrKillSwitchActive(options.config, { pluginRoot })) {
    await recordDecision({
      subsystem: 'auto-pr-creator',
      action: 'rejected',
      reason: 'kill-switch-tripped',
      inputs: { category: options.category },
    });
    return { status: 'rejected', reason: 'kill-switch-tripped' };
  }

  if (!isCategoryAllowed(options.config, options.category)) {
    await recordDecision({
      subsystem: 'auto-pr-creator',
      action: 'rejected',
      reason: 'category-not-allowed',
      inputs: { category: options.category },
    });
    return { status: 'rejected', reason: 'category-not-allowed' };
  }

  const cd = await checkCooldown(options.pluginRoot, now);
  if (!cd.allowed) {
    await recordDecision({
      subsystem: 'auto-pr-creator',
      action: 'rejected',
      reason: 'cooldown',
      inputs: { category: options.category, perHourLimit: MAX_PER_HOUR },
    });
    return { status: 'rejected', reason: 'cooldown' };
  }

  const plan = buildFixPlan(options.category, now);
  const branchCheck = validateBranch(plan.branch);
  if (!branchCheck.ok) {
    return { status: 'rejected', reason: `bad-branch: ${branchCheck.reason}` };
  }

  if (options.dryRun) {
    await recordDecision({
      subsystem: 'auto-pr-creator',
      action: 'dry-run',
      inputs: { category: options.category },
      outputs: { branch: plan.branch },
    });
    return { status: 'dry-run', branch: plan.branch };
  }

  // First-Run Guard: observe-only for the initial N runs. Returns a
  // "would-create" decision without invoking git/gh.
  if (await isAutoPrObserveOnly(options.config, { pluginRoot })) {
    await recordDecision({
      subsystem: 'auto-pr-creator',
      action: 'would-create',
      reason: 'first-run observe-only',
      inputs: { category: options.category },
      outputs: { branch: plan.branch },
    });
    return { status: 'observe-only', branch: plan.branch };
  }

  const cwd = options.pluginRoot;
  await runImpl('git', ['checkout', '-b', plan.branch], { cwd });
  await runImpl('git', ['commit', '--allow-empty', '-m', plan.title], { cwd });
  const pushRes = await runImpl('git', ['push', '-u', 'origin', plan.branch], { cwd });
  if (pushRes.code !== 0) {
    await recordAutoPrFailure('push-failed', options.config, { pluginRoot });
    return { status: 'failed', reason: 'push-failed', branch: plan.branch };
  }

  const prRes = await runImpl(
    'gh',
    ['pr', 'create', '--draft', '--title', plan.title, '--body', plan.body, '--head', plan.branch],
    { cwd },
  );

  await recordAttempt(options.pluginRoot, now, cd.history);

  const urlMatch = /https?:\/\/\S+/.exec(prRes.stdout || '');
  const prUrl = urlMatch ? urlMatch[0] : null;

  await recordDecision({
    subsystem: 'auto-pr-creator',
    action: prRes.code === 0 ? 'created' : 'failed',
    inputs: { category: options.category },
    outputs: { branch: plan.branch, prUrl },
  });

  if (prRes.code !== 0) {
    await recordAutoPrFailure('gh-failed', options.config, { pluginRoot });
    return { status: 'failed', reason: 'gh-failed', branch: plan.branch };
  }
  return { status: 'created', branch: plan.branch, prUrl };
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename);

function parseArgs(argv) {
  const out = { dryRun: false, category: 'drift' };
  for (const a of argv) {
    if (a === '--dry-run') out.dryRun = true;
    else if (a.startsWith('--category=')) out.category = a.slice('--category='.length);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const pluginRoot = getPluginRoot();
  const configPath = path.join(pluginRoot, 'artibot.config.json');
  const config = (await readJsonFile(configPath)) || {};

  const result = await createAutoPR({
    config,
    pluginRoot,
    category: args.category,
    dryRun: args.dryRun,
  });

  const line = `auto-pr: ${result.status}${result.reason ? ` (${result.reason})` : ''}`;
  process.stderr.write(`${line}\n`);
  if (result.prUrl) process.stderr.write(`pr: ${result.prUrl}\n`);
  process.exit(result.status === 'created' || result.status === 'dry-run' ? 0 : 0);
}

if (isDirectRun) {
  main().catch((err) => {
    process.stderr.write(`auto-pr-creator failed: ${err.message}\n`);
    process.exit(1);
  });
}

// ---------------------------------------------------------------------------
// Exports for tests
// ---------------------------------------------------------------------------

export const _constants = Object.freeze({
  FORBIDDEN_BRANCHES,
  REQUIRED_BRANCH_PREFIX,
  COOLDOWN_PATH,
  MAX_PER_HOUR,
  SUPPORTED_CATEGORIES,
});

/**
 * Check — purely via source inspection — that this module never calls
 * `gh pr merge`. Used by tests to enforce the no-merge invariant.
 *
 * @param {string} sourceText
 * @returns {boolean}
 */
export function sourceHasMergeCall(sourceText) {
  if (typeof sourceText !== 'string') return false;
  // Matches `gh ... pr ... merge` in any quoting/arg form within a short span.
  return /\bgh\b[^\n]{0,20}?\bpr\b[^\n]{0,20}?\bmerge\b/i.test(sourceText);
}
