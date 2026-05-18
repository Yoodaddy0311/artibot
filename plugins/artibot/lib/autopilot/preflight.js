/**
 * Autopilot pre-flight checks (default-mode auto entry).
 *
 * Runs a fixed battery of cheap local checks BEFORE the autopilot
 * orchestrator hands off to phase work. The goal is to catch foot-guns
 * (dirty tree / stuck lock / out-of-disk / unsupported runtime /
 * malformed Goal Contract) up-front instead of mid-phase.
 *
 * Design contract:
 *   - 100% local — zero external calls (DATA POLICY).
 *   - Zero runtime deps; only node builtins + existing autopilot lib.
 *   - Never throws into orchestrator; failures degrade to warn status.
 *   - DI-friendly: every external surface (git, disk, lock, telemetry)
 *     is overridable via `deps` so tests stay hermetic.
 *
 * Public surface:
 *   - runPreflight(ctx, deps?)
 *   - runIndividualCheck(name, ctx, deps?)
 *
 * @module lib/autopilot/preflight
 */

import { execFileSync, execSync } from 'node:child_process';
import { statfsSync } from 'node:fs';
import path from 'node:path';
import { isLocked as defaultIsLocked } from './lock.js';
import { appendEvent as defaultAppendEvent } from './telemetry.js';

const MIN_DISK_FAIL_BYTES = 500 * 1024 * 1024; // 500 MB
const MIN_DISK_WARN_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB
const NODE_FAIL_MAJOR = 18;
const NODE_WARN_MAJOR = 20;

/**
 * Catalog of all check names. Stable order is intentional — drives the
 * REPORT-phase table rendering and telemetry consistency.
 */
const ALL_CHECKS = [
  'gitClean',
  'lockFree',
  'diskSpace',
  'nodeVersion',
  'goalContractLint',
];

/**
 * Default git runner using execFileSync. Returns trimmed stdout, throws
 * on non-zero exit so the check can catch + downgrade.
 * @param {string[]} args
 * @param {string} cwd
 * @returns {string}
 */
function defaultGitRunner(args, cwd) {
  const out = execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return typeof out === 'string' ? out : '';
}

/**
 * Default Windows disk-free reader. Uses wmic on win32, statfsSync elsewhere.
 * Returns bytes-free as a Number, or throws.
 * @param {string} cwd
 * @returns {number}
 */
function defaultStatfs(cwd) {
  if (process.platform === 'win32') {
    const drive = path.parse(path.resolve(cwd)).root.replace(/\\$/, '');
    const out = execSync(
      `wmic logicaldisk where "DeviceID='${drive}'" get FreeSpace /value`,
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const m = /FreeSpace=(\d+)/.exec(out);
    if (!m) throw new Error('wmic parse failed');
    return Number(m[1]);
  }
  const s = statfsSync(cwd);
  return Number(s.bavail) * Number(s.bsize);
}

/**
 * Build a check-result object (pure helper).
 * @param {string} name
 * @param {'pass'|'warn'|'fail'} status
 * @param {string} [detail]
 * @returns {{ name: string, status: string, detail?: string }}
 */
function result(name, status, detail) {
  const r = { name, status };
  if (detail) r.detail = detail;
  return r;
}

/**
 * gitClean — pass if `git status --porcelain` is empty. Dirty trees warn
 * (do not block — sometimes the user intends to commit mid-flow).
 */
function checkGitClean(ctx, deps) {
  try {
    const runner = deps.gitRunner || defaultGitRunner;
    const out = runner(['status', '--porcelain'], ctx.cwd);
    if (!out || !out.trim()) return result('gitClean', 'pass');
    const lines = out.trim().split('\n').length;
    return result('gitClean', 'warn', `${lines} dirty path(s)`);
  } catch (err) {
    return result('gitClean', 'warn', err?.message || 'git unavailable');
  }
}

/**
 * lockFree — wraps lock.isLocked. Held + non-stale = fail. Stale = warn.
 */
function checkLockFree(ctx, deps) {
  try {
    const checker = deps.lockChecker || defaultIsLocked;
    const state = checker(ctx.featureKey);
    if (!state || state.locked === false) return result('lockFree', 'pass');
    if (state.stale === true) return result('lockFree', 'warn', 'stale lock detected');
    return result('lockFree', 'fail', `held by pid=${state.holder?.pid ?? '?'}`);
  } catch (err) {
    return result('lockFree', 'warn', err?.message || 'lock probe failed');
  }
}

/**
 * diskSpace — <500MB fail, <2GB warn, >=2GB pass. Unavailable = silent skip warn.
 */
function checkDiskSpace(ctx, deps) {
  try {
    const reader = deps.statfs || defaultStatfs;
    const free = reader(ctx.cwd);
    if (!Number.isFinite(free) || free < 0) {
      return result('diskSpace', 'warn', 'disk-check-unavailable');
    }
    if (free < MIN_DISK_FAIL_BYTES) {
      return result('diskSpace', 'fail', `${Math.round(free / 1024 / 1024)}MB free`);
    }
    if (free < MIN_DISK_WARN_BYTES) {
      return result('diskSpace', 'warn', `${Math.round(free / 1024 / 1024)}MB free`);
    }
    return result('diskSpace', 'pass', `${Math.round(free / 1024 / 1024 / 1024)}GB free`);
  } catch {
    return result('diskSpace', 'warn', 'disk-check-unavailable');
  }
}

/**
 * nodeVersion — parses process.versions.node. <18 fail, <20 warn.
 */
function checkNodeVersion(_ctx, deps) {
  try {
    const raw = deps.nodeVersion || process.versions.node;
    const major = Number(String(raw).split('.')[0]);
    if (!Number.isFinite(major)) return result('nodeVersion', 'warn', `unparseable: ${raw}`);
    if (major < NODE_FAIL_MAJOR) return result('nodeVersion', 'fail', `node ${raw} < ${NODE_FAIL_MAJOR}`);
    if (major < NODE_WARN_MAJOR) return result('nodeVersion', 'warn', `node ${raw} < ${NODE_WARN_MAJOR}`);
    return result('nodeVersion', 'pass', `node ${raw}`);
  } catch (err) {
    return result('nodeVersion', 'warn', err?.message || 'version probe failed');
  }
}

/**
 * goalContractLint — only runs when ctx.goalContract is provided.
 * Missing objective / stoppingCondition = fail. Missing validationCommand = warn.
 */
function checkGoalContractLint(ctx) {
  try {
    const g = ctx.goalContract;
    if (g === undefined || g === null) return result('goalContractLint', 'pass', 'no contract supplied');
    if (typeof g !== 'object' || Array.isArray(g)) {
      return result('goalContractLint', 'fail', 'contract must be an object');
    }
    const missing = [];
    if (!g.objective || typeof g.objective !== 'string' || !g.objective.trim()) missing.push('objective');
    if (!g.stoppingCondition || typeof g.stoppingCondition !== 'string' || !g.stoppingCondition.trim()) {
      missing.push('stoppingCondition');
    }
    if (missing.length) return result('goalContractLint', 'fail', `missing: ${missing.join(', ')}`);
    if (!g.validationCommand) return result('goalContractLint', 'warn', 'no validationCommand');
    return result('goalContractLint', 'pass');
  } catch (err) {
    return result('goalContractLint', 'warn', err?.message || 'lint failed');
  }
}

/**
 * Map check name → runner. Each runner is ≤30 lines and pure-ish (DI'd).
 */
const CHECK_RUNNERS = {
  gitClean: checkGitClean,
  lockFree: checkLockFree,
  diskSpace: checkDiskSpace,
  nodeVersion: checkNodeVersion,
  goalContractLint: checkGoalContractLint,
};

/**
 * Run a single check by name. Unknown names return a synthetic warn.
 *
 * @param {string} name
 * @param {{ cwd: string, featureKey: string, sessionId?: string, options?: object, goalContract?: object }} ctx
 * @param {object} [deps]
 * @returns {{ name: string, status: 'pass'|'warn'|'fail', detail?: string }}
 */
export function runIndividualCheck(name, ctx, deps = {}) {
  const runner = CHECK_RUNNERS[name];
  if (!runner) return result(name, 'warn', 'unknown check');
  try {
    return runner(ctx || {}, deps || {});
  } catch (err) {
    return result(name, 'warn', err?.message || 'check threw');
  }
}

/**
 * Telemetry emit helper — never throws.
 * @param {object} deps
 * @param {string|undefined} sessionId
 * @param {object} payload
 */
function emitTelemetry(deps, sessionId, payload) {
  if (!sessionId) return;
  try {
    const emit = deps.telemetry || defaultAppendEvent;
    emit(sessionId, {
      phase: 'PREFLIGHT',
      type: 'preflight',
      level: payload.errors.length ? 'error' : payload.warnings.length ? 'warn' : 'info',
      message: `preflight ok=${payload.ok}`,
      data: {
        errors: payload.errors.map((e) => e.check),
        warnings: payload.warnings.map((w) => w.check),
      },
    });
  } catch {
    /* telemetry advisory only */
  }
}

/**
 * Run the full pre-flight battery.
 *
 * Hard-fail checks (`status==='fail'`) drive `ok=false`. Warnings never
 * block, but are surfaced for the user and emitted to telemetry.
 *
 * @param {{ cwd: string, sessionId?: string, featureKey: string, options?: object, goalContract?: object }} ctx
 * @param {{ gitRunner?: Function, statfs?: Function, lockChecker?: Function, telemetry?: Function, nodeVersion?: string }} [deps]
 * @returns {{
 *   ok: boolean,
 *   warnings: Array<{ check: string, severity: string, message: string }>,
 *   errors:   Array<{ check: string, severity: string, message: string }>,
 *   checks:   Array<{ name: string, status: string, detail?: string }>,
 * }}
 */
export function runPreflight(ctx, deps = {}) {
  const safeCtx = ctx && typeof ctx === 'object' ? ctx : {};
  const safeDeps = deps && typeof deps === 'object' ? deps : {};
  const checks = [];
  const warnings = [];
  const errors = [];

  for (const name of ALL_CHECKS) {
    const r = runIndividualCheck(name, safeCtx, safeDeps);
    checks.push(r);
    if (r.status === 'fail') {
      errors.push({ check: name, severity: 'error', message: r.detail || 'check failed' });
    } else if (r.status === 'warn') {
      warnings.push({ check: name, severity: 'warn', message: r.detail || 'check warned' });
    }
  }

  const payload = { ok: errors.length === 0, warnings, errors, checks };
  emitTelemetry(safeDeps, safeCtx.sessionId, payload);
  return payload;
}
