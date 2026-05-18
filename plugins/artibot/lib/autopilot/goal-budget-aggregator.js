/**
 * Per-goal budget aggregator (PRD v4.10.0 Track E).
 *
 * Layers on top of cost-tracker.js without modifying it. Each goal owns a
 * namespaced bucket inside `~/.artibot/queues/{queueId}.budget.json` (atomic
 * write, same tmp+rename pattern as session-store.js). Designed for the
 * multi-goal queue where the queue-wide total matters as much as per-goal
 * spend.
 *
 * Public surface:
 *   - recordGoalUsage(queueId, goalId, phase, usage, opts)
 *   - getGoalBudget(queueId, goalId, opts)
 *   - getQueueTotal(queueId, opts)
 *
 * State shape:
 *   {
 *     schemaVersion: 1,
 *     queueId,
 *     totals: { tokensIn, tokensOut, costUsd },
 *     goals: {
 *       [goalId]: {
 *         totals: { tokensIn, tokensOut, costUsd },
 *         phases: { [phase]: { tokensIn, tokensOut, costUsd, lastTs } }
 *       }
 *     },
 *     updatedAt
 *   }
 *
 * DATA POLICY: 100% local, no external transmission. Korean-path safe.
 *
 * @module lib/autopilot/goal-budget-aggregator
 */

import path from 'node:path';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { getDefaultQueueDir } from './goal-queue.js';

export const CURRENT_BUDGET_SCHEMA_VERSION = 1;

/**
 * Coerce input to non-negative finite number; NaN / negative → 0.
 * @param {unknown} n
 * @returns {number}
 */
function safeNum(n) {
  const v = typeof n === 'number' ? n : Number(n);
  if (!Number.isFinite(v) || v < 0) return 0;
  return v;
}

/**
 * Resolve absolute path for a queue's budget file.
 * @param {string} queueId
 * @param {string} [storeDir]
 * @returns {string}
 */
export function getBudgetPath(queueId, storeDir) {
  if (!queueId || typeof queueId !== 'string') {
    throw new TypeError('queueId must be a non-empty string');
  }
  return path.join(storeDir || getDefaultQueueDir(), `${queueId}.budget.json`);
}

/**
 * Read and parse a budget file. Null on missing / unreadable.
 * @param {string} queueId
 * @param {string} [storeDir]
 * @returns {object|null}
 */
function readBudget(queueId, storeDir) {
  try {
    const filePath = getBudgetPath(queueId, storeDir);
    if (!existsSync(filePath)) return null;
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Atomic write via tmp + rename. Matches session-store.js pattern.
 * @param {object} state
 * @param {string} [storeDir]
 * @returns {string}
 */
function writeBudget(state, storeDir) {
  const filePath = getBudgetPath(state.queueId, storeDir);
  const dir = dirname(filePath);
  try { mkdirSync(dir, { recursive: true }); } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
  const payload = JSON.stringify(state, null, 2);
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  try {
    writeFileSync(tmp, payload, 'utf-8');
    renameSync(tmp, filePath);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
  return filePath;
}

/**
 * Build a fresh empty budget state for a queue.
 * @param {string} queueId
 * @param {Function} now
 * @returns {object}
 */
function buildBudget(queueId, now) {
  return {
    schemaVersion: CURRENT_BUDGET_SCHEMA_VERSION,
    queueId,
    totals: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
    goals: {},
    updatedAt: now(),
  };
}

/**
 * Build a fresh empty per-goal bucket.
 * @returns {object}
 */
function emptyGoalBucket() {
  return {
    totals: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
    phases: {},
  };
}

/**
 * Validate (queueId, goalId, phase) are all non-empty strings.
 * @returns {boolean}
 */
function isValidTuple(queueId, goalId, phase) {
  return typeof queueId === 'string' && queueId.length > 0
    && typeof goalId === 'string' && goalId.length > 0
    && typeof phase === 'string' && phase.length > 0;
}

/**
 * Record token + cost usage for a (queueId, goalId, phase) tuple.
 * Silently no-op on invalid ids or persistence failure.
 *
 * @param {string} queueId
 * @param {string} goalId
 * @param {string} phase
 * @param {{tokensIn?:number, tokensOut?:number, costUsd?:number}} usage
 * @param {{storeDir?:string, now?:Function}} [opts]
 * @returns {object|null} the delta applied, or null on failure
 */
export function recordGoalUsage(queueId, goalId, phase, usage, opts = {}) {
  if (!isValidTuple(queueId, goalId, phase)) return null;
  const u = usage && typeof usage === 'object' ? usage : {};
  const delta = {
    tokensIn: safeNum(u.tokensIn),
    tokensOut: safeNum(u.tokensOut),
    costUsd: safeNum(u.costUsd),
  };
  const now = typeof opts.now === 'function' ? opts.now : () => new Date().toISOString();
  const storeDir = opts.storeDir;
  try {
    const state = readBudget(queueId, storeDir) || buildBudget(queueId, now);
    const goals = state.goals && typeof state.goals === 'object' ? state.goals : {};
    const bucket = goals[goalId] && typeof goals[goalId] === 'object'
      ? { totals: { ...goals[goalId].totals }, phases: { ...goals[goalId].phases } }
      : emptyGoalBucket();
    const prevPhase = bucket.phases[phase] && typeof bucket.phases[phase] === 'object'
      ? bucket.phases[phase] : { tokensIn: 0, tokensOut: 0, costUsd: 0 };
    bucket.phases[phase] = {
      tokensIn: safeNum(prevPhase.tokensIn) + delta.tokensIn,
      tokensOut: safeNum(prevPhase.tokensOut) + delta.tokensOut,
      costUsd: safeNum(prevPhase.costUsd) + delta.costUsd,
      lastTs: now(),
    };
    bucket.totals = {
      tokensIn: safeNum(bucket.totals.tokensIn) + delta.tokensIn,
      tokensOut: safeNum(bucket.totals.tokensOut) + delta.tokensOut,
      costUsd: safeNum(bucket.totals.costUsd) + delta.costUsd,
    };
    const nextGoals = { ...goals, [goalId]: bucket };
    const nextTotals = {
      tokensIn: safeNum(state.totals?.tokensIn) + delta.tokensIn,
      tokensOut: safeNum(state.totals?.tokensOut) + delta.tokensOut,
      costUsd: safeNum(state.totals?.costUsd) + delta.costUsd,
    };
    writeBudget({
      ...state,
      goals: nextGoals,
      totals: nextTotals,
      updatedAt: now(),
    }, storeDir);
    return delta;
  } catch {
    return null;
  }
}

/**
 * Return per-goal budget summary. Missing → zeroed shape (never null) so
 * callers can render without branching.
 *
 * @param {string} queueId
 * @param {string} goalId
 * @param {{storeDir?:string}} [opts]
 * @returns {{tokensIn:number, tokensOut:number, costUsd:number, totalTokens:number,
 *   perPhase:Array<{phase:string, tokensIn:number, tokensOut:number, costUsd:number}>}}
 */
export function getGoalBudget(queueId, goalId, opts = {}) {
  const empty = {
    tokensIn: 0, tokensOut: 0, costUsd: 0, totalTokens: 0, perPhase: [],
  };
  if (typeof queueId !== 'string' || typeof goalId !== 'string') return empty;
  const state = readBudget(queueId, opts.storeDir);
  if (!state || !state.goals) return empty;
  const bucket = state.goals[goalId];
  if (!bucket) return empty;
  const totals = bucket.totals || {};
  const perPhase = [];
  for (const [phase, entry] of Object.entries(bucket.phases || {})) {
    if (!entry) continue;
    perPhase.push({
      phase,
      tokensIn: safeNum(entry.tokensIn),
      tokensOut: safeNum(entry.tokensOut),
      costUsd: safeNum(entry.costUsd),
    });
  }
  return {
    tokensIn: safeNum(totals.tokensIn),
    tokensOut: safeNum(totals.tokensOut),
    costUsd: safeNum(totals.costUsd),
    totalTokens: safeNum(totals.tokensIn) + safeNum(totals.tokensOut),
    perPhase,
  };
}

/**
 * Return queue-wide totals + per-goal breakdown.
 *
 * @param {string} queueId
 * @param {{storeDir?:string}} [opts]
 * @returns {{tokensIn:number, tokensOut:number, costUsd:number, totalTokens:number,
 *   goalCount:number, perGoal:Array<{goalId:string, tokensIn:number, tokensOut:number, costUsd:number}>}}
 */
export function getQueueTotal(queueId, opts = {}) {
  const empty = {
    tokensIn: 0, tokensOut: 0, costUsd: 0, totalTokens: 0, goalCount: 0, perGoal: [],
  };
  if (typeof queueId !== 'string') return empty;
  const state = readBudget(queueId, opts.storeDir);
  if (!state) return empty;
  const totals = state.totals || {};
  const goals = state.goals || {};
  const perGoal = [];
  for (const [goalId, bucket] of Object.entries(goals)) {
    if (!bucket || !bucket.totals) continue;
    perGoal.push({
      goalId,
      tokensIn: safeNum(bucket.totals.tokensIn),
      tokensOut: safeNum(bucket.totals.tokensOut),
      costUsd: safeNum(bucket.totals.costUsd),
    });
  }
  return {
    tokensIn: safeNum(totals.tokensIn),
    tokensOut: safeNum(totals.tokensOut),
    costUsd: safeNum(totals.costUsd),
    totalTokens: safeNum(totals.tokensIn) + safeNum(totals.tokensOut),
    goalCount: perGoal.length,
    perGoal,
  };
}
