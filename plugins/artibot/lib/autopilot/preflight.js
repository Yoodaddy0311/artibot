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
 * Repository-scoped checks (PRD split-cross-session, Phase 3):
 *   - `repoConcurrency` — the feature lock is keyed per task, so a second
 *     autopilot in the SAME repository with a DIFFERENT task was invisible
 *     to `lockFree` (F3). This check lists live locks whose holder recorded
 *     the same repo identity. Peers in the same working tree fail (two runs
 *     mutating one checkout); peers in another worktree of the repo warn
 *     (isolated trees, shared refs); peers whose feature key is on the
 *     allowlist `ctx.options.repoConcurrency.allow` pass. Allowlist entries
 *     are exact keys or `prefix*`. The engine records the identity in every
 *     lock it acquires, so a live lock WITHOUT one comes from another plugin
 *     version (or a session outside any repo) — reported as a warn, not
 *     silently dropped.
 *   - `peerNotice` — ALWAYS pass. Advisory count of other Claude sessions
 *     whose cwd overlaps this repo. `ListAgents` is a model-side tool and is
 *     not reachable from node; the only source is an injected `deps.listAgents`
 *     seam. With no seam the check passes with `peer-listing-unavailable`,
 *     which is the normal state in subagent contexts.
 *
 * @module lib/autopilot/preflight
 */

import { execFileSync, execSync } from 'node:child_process';
import { statfsSync } from 'node:fs';
import path from 'node:path';
import { getRepoIdentity as defaultGetRepoIdentity } from '../git/repo-identity.js';
import { isLocked as defaultIsLocked, listLocks as defaultListLocks } from './lock.js';
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
  'repoConcurrency',
  'peerNotice',
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
 * Repo identity for a check. `deps.resolveRepoIdentity` is the hermetic seam;
 * `runPreflight` wraps it so one battery resolves the identity once (each
 * resolution is a git subprocess) — see {@link withSharedIdentity}. The memo
 * lives in that wrapper, not on `ctx`: callers reuse ctx objects, and a memo
 * keyed on them would pin the first answer across runs.
 * @param {object} ctx
 * @param {object} deps
 * @returns {string|null}
 */
function resolveIdentity(ctx, deps) {
  const resolve = deps.resolveRepoIdentity || defaultGetRepoIdentity;
  return resolve(ctx.cwd) || null;
}

/**
 * Return deps whose `resolveRepoIdentity` answers from a single resolution
 * for the lifetime of one preflight battery.
 * @param {object} deps
 * @returns {object}
 */
function withSharedIdentity(deps) {
  const resolve = deps.resolveRepoIdentity || defaultGetRepoIdentity;
  let done = false;
  let cached = null;
  return {
    ...deps,
    resolveRepoIdentity: (cwd) => {
      if (!done) { cached = resolve(cwd) || null; done = true; }
      return cached;
    },
  };
}

/**
 * lockFree — wraps lock.isLocked. Held + non-stale = fail. Stale = warn.
 * Probes the repo-scoped key when the identity resolves (the key the engine
 * now acquires under); `isLocked` itself also reads the legacy unscoped file
 * in that mode, so a holder from an older plugin version is still seen.
 */
function checkLockFree(ctx, deps) {
  try {
    const checker = deps.lockChecker || defaultIsLocked;
    const identity = resolveIdentity(ctx, deps);
    const state = identity ? checker(ctx.featureKey, { repoIdentity: identity }) : checker(ctx.featureKey);
    if (!state || state.locked === false) return result('lockFree', 'pass');
    const via = identity && state.scheme === 'legacy' ? ' (legacy-scheme holder)' : '';
    if (state.stale === true) return result('lockFree', 'warn', `stale lock detected${via}`);
    return result('lockFree', 'fail', `held by pid=${state.holder?.pid ?? '?'}${via}`);
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
 * Normalise a path for same-tree comparison. Windows paths are compared
 * case-insensitively; `null` when the input is not a usable string.
 * @param {unknown} p
 * @returns {string|null}
 */
function treeKey(p) {
  if (typeof p !== 'string' || !p) return null;
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * Build the allowlist matcher from `ctx.options.repoConcurrency.allow`.
 * Entries are exact feature keys or `prefix*`. Non-array → nothing allowed.
 * @param {object} ctx
 * @returns {(featureKey: string) => boolean}
 */
function buildAllowMatcher(ctx) {
  const raw = ctx?.options?.repoConcurrency?.allow;
  const entries = Array.isArray(raw) ? raw.filter((e) => typeof e === 'string' && e) : [];
  return (featureKey) => entries.some((e) => (
    e.endsWith('*') ? featureKey.startsWith(e.slice(0, -1)) : featureKey === e
  ));
}

/**
 * Partition same-repo peer locks into the buckets the verdict is built from.
 * @param {Array<{ holder: object, stale: boolean }>} locks
 * @param {object} ctx
 * @param {string} identity
 * @returns {{ blocked: string[], isolated: string[], allowed: string[], stale: string[], unattributed: number }}
 */
function partitionPeers(locks, ctx, identity) {
  const allowed = buildAllowMatcher(ctx);
  const ownTree = treeKey(ctx.cwd);
  const out = { blocked: [], isolated: [], allowed: [], stale: [], unattributed: 0 };
  for (const entry of locks) {
    const h = entry?.holder;
    if (!h || typeof h !== 'object') continue;
    if (h.sessionId && h.sessionId === ctx.sessionId) continue;
    if (typeof h.repoIdentity !== 'string' || !h.repoIdentity) {
      if (!entry.stale) out.unattributed += 1;
      continue;
    }
    if (h.repoIdentity !== identity) continue;
    const key = typeof h.featureKey === 'string' ? h.featureKey : String(entry.lockKey ?? '?');
    if (key === ctx.featureKey) continue; // lockFree owns the same-key case
    if (entry.stale) { out.stale.push(key); continue; }
    if (allowed(key)) { out.allowed.push(key); continue; }
    const peerTree = treeKey(h.cwd);
    // Unknown peer cwd is treated as the same tree: fail-closed.
    if (peerTree === null || ownTree === null || peerTree === ownTree) out.blocked.push(key);
    else out.isolated.push(key);
  }
  return out;
}

/**
 * repoConcurrency — same repository, different task. See module header.
 * Identity unresolvable (not a repo, git missing) = warn, never fail.
 */
function checkRepoConcurrency(ctx, deps) {
  try {
    const identity = resolveIdentity(ctx, deps);
    if (!identity) return result('repoConcurrency', 'warn', 'repo-identity-unavailable');
    const list = deps.listLocks || defaultListLocks;
    const peers = partitionPeers(list() || [], ctx, identity);
    const notes = [];
    // The engine writes repoIdentity into every lock it can attribute, so a
    // live lock without one was written by another plugin version (or by a
    // session outside any repo) and cannot be placed. Reported, not hidden.
    if (peers.unattributed) notes.push(`${peers.unattributed} legacy-scheme live lock(s) from another plugin version (unattributable to a repo)`);
    if (peers.stale.length) notes.push(`stale: ${peers.stale.join(', ')}`);
    if (peers.allowed.length) notes.push(`allowlisted: ${peers.allowed.join(', ')}`);
    if (peers.blocked.length) {
      return result('repoConcurrency', 'fail', `same repo+tree: ${peers.blocked.join(', ')}`);
    }
    if (peers.isolated.length) {
      notes.unshift(`same repo, other worktree: ${peers.isolated.join(', ')}`);
      return result('repoConcurrency', 'warn', notes.join('; '));
    }
    if (peers.unattributed || peers.stale.length) return result('repoConcurrency', 'warn', notes.join('; '));
    return result('repoConcurrency', 'pass', notes.length ? notes.join('; ') : `repo=${identity}; no same-repo peer`);
  } catch (err) {
    return result('repoConcurrency', 'warn', err?.message || 'repo concurrency probe failed');
  }
}

/**
 * Does `peerCwd` overlap `ownCwd` — same dir, or one inside the other?
 * @param {unknown} peerCwd
 * @param {unknown} ownCwd
 * @returns {boolean}
 */
function cwdOverlaps(peerCwd, ownCwd) {
  const a = treeKey(peerCwd);
  const b = treeKey(ownCwd);
  if (a === null || b === null) return false;
  if (a === b) return true;
  return a.startsWith(b + path.sep) || b.startsWith(a + path.sep);
}

/**
 * peerNotice — advisory only; every path returns `pass`. Zero side effects:
 * reads `deps.listAgents()` if injected and nothing else.
 */
function checkPeerNotice(ctx, deps) {
  try {
    const lister = deps.listAgents;
    if (typeof lister !== 'function') {
      const env = deps.env && typeof deps.env === 'object' ? deps.env : process.env;
      const socket = env.CLAUDE_CODE_MESSAGING_SOCKET ? ' (messaging socket present; ListAgents is main-session only)' : '';
      return result('peerNotice', 'pass', `peer-listing-unavailable${socket}`);
    }
    const agents = lister();
    const rows = Array.isArray(agents) ? agents : [];
    const peers = rows.filter((a) => a && typeof a === 'object' && cwdOverlaps(a.cwd, ctx.cwd));
    const names = peers.map((a) => (typeof a.name === 'string' && a.name) || '?');
    return result('peerNotice', 'pass', `${peers.length} peer session(s) in this repo${names.length ? `: ${names.join(', ')}` : ''}`);
  } catch (err) {
    return result('peerNotice', 'pass', `peer-listing-failed: ${err?.message || 'unknown'}`);
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
  repoConcurrency: checkRepoConcurrency,
  peerNotice: checkPeerNotice,
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
 * @param {{ gitRunner?: Function, statfs?: Function, lockChecker?: Function, telemetry?: Function, nodeVersion?: string,
 *   resolveRepoIdentity?: Function, listLocks?: Function, listAgents?: Function, env?: object }} [deps]
 * @returns {{
 *   ok: boolean,
 *   warnings: Array<{ check: string, severity: string, message: string }>,
 *   errors:   Array<{ check: string, severity: string, message: string }>,
 *   checks:   Array<{ name: string, status: string, detail?: string }>,
 * }}
 */
export function runPreflight(ctx, deps = {}) {
  const safeCtx = ctx && typeof ctx === 'object' ? ctx : {};
  const safeDeps = withSharedIdentity(deps && typeof deps === 'object' ? deps : {});
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
