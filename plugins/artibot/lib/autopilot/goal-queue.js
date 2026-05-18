/**
 * Multi-goal FIFO queue for autopilot (PRD v4.10.0 Track E).
 *
 * Stores per-queue state at `~/.artibot/queues/{queueId}.json` using the same
 * tmp+rename atomic write pattern as session-store.js. Each queue is an ordered
 * list of goals with per-goal status (`pending` | `running` | `completed` |
 * `failed` | `paused`). DI hooks for `now()` and `storeDir` keep the unit
 * tests pure (no real filesystem writes).
 *
 * Public surface:
 *   - enqueueGoal(goal, opts)
 *   - dequeueGoal(queueId, opts)
 *   - listQueue(queueId?, opts)
 *   - removeFromQueue(queueId, goalId, opts)
 *   - runQueue(queueId, opts)
 *
 * DATA POLICY: 100% local file I/O. No external HTTP, DB, or transmission.
 * Korean-path safe (uses path.join + manual file:// URL construction).
 *
 * @module lib/autopilot/goal-queue
 */

import path from 'node:path';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { getHomeDir } from '../core/platform.js';

export const CURRENT_QUEUE_SCHEMA_VERSION = 1;
export const GOAL_STATUS = Object.freeze({
  PENDING: 'pending',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  PAUSED: 'paused',
});

/**
 * Resolve the default queues directory (`~/.artibot/queues`).
 * @returns {string}
 */
export function getDefaultQueueDir() {
  return path.join(getHomeDir(), '.artibot', 'queues');
}

/**
 * Resolve the absolute path of a queue JSON file.
 * @param {string} queueId
 * @param {string} [storeDir]
 * @returns {string}
 */
export function getQueuePath(queueId, storeDir) {
  if (!queueId || typeof queueId !== 'string') {
    throw new TypeError('queueId must be a non-empty string');
  }
  return path.join(storeDir || getDefaultQueueDir(), `${queueId}.json`);
}

/**
 * Build a new goal record. Pure (no I/O).
 * @param {object|string} goal - either `{ id?, task, options? }` or a task string
 * @param {Function} now - DI clock returning ISO string
 * @returns {{id:string, task:string, options:object, status:string,
 *   createdAt:string, startedAt:null, completedAt:null,
 *   error:null, metadata:object}}
 */
function buildGoal(goal, now) {
  const src = typeof goal === 'string' ? { task: goal } : (goal && typeof goal === 'object' ? goal : {});
  const task = typeof src.task === 'string' ? src.task.trim() : '';
  if (!task) throw new TypeError('goal.task must be a non-empty string');
  const id = typeof src.id === 'string' && src.id.length > 0
    ? src.id
    : `g-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    id,
    task,
    options: src.options && typeof src.options === 'object' ? { ...src.options } : {},
    status: GOAL_STATUS.PENDING,
    createdAt: now(),
    startedAt: null,
    completedAt: null,
    error: null,
    metadata: src.metadata && typeof src.metadata === 'object' ? { ...src.metadata } : {},
  };
}

/**
 * Persist a queue object atomically (tmp + rename). Mirrors session-store.js.
 * @param {object} queue
 * @param {string} [storeDir]
 * @returns {string} absolute file path
 */
function writeQueue(queue, storeDir) {
  const filePath = getQueuePath(queue.queueId, storeDir);
  const dir = dirname(filePath);
  try { mkdirSync(dir, { recursive: true }); } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
  const payload = JSON.stringify(queue, null, 2);
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
 * Load a queue from disk; null on missing / unreadable.
 * @param {string} queueId
 * @param {string} [storeDir]
 * @returns {object|null}
 */
function readQueue(queueId, storeDir) {
  try {
    const filePath = getQueuePath(queueId, storeDir);
    if (!existsSync(filePath)) return null;
    const raw = readFileSync(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Construct a fresh empty queue. Pure.
 * @param {string} queueId
 * @param {Function} now
 * @returns {object}
 */
function buildQueue(queueId, now) {
  return {
    schemaVersion: CURRENT_QUEUE_SCHEMA_VERSION,
    queueId,
    createdAt: now(),
    updatedAt: now(),
    goals: [],
    paused: false,
  };
}

/**
 * Generate a queue id like `q-YYYYMMDD-HHmmss-xxxx`.
 * @returns {string}
 */
export function newQueueId() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const ymd = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
  const hms = `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
  const suffix = Math.random().toString(36).slice(2, 6).padEnd(4, '0');
  return `q-${ymd}-${hms}-${suffix}`;
}

/**
 * Append a goal to a queue (creates the queue if absent).
 *
 * @param {object|string} goal
 * @param {{queueId?:string, storeDir?:string, now?:Function}} [opts]
 * @returns {{queueId:string, goal:object}}
 */
export function enqueueGoal(goal, opts = {}) {
  const now = typeof opts.now === 'function' ? opts.now : () => new Date().toISOString();
  const storeDir = opts.storeDir;
  const queueId = typeof opts.queueId === 'string' && opts.queueId.length > 0
    ? opts.queueId
    : newQueueId();
  const built = buildGoal(goal, now);
  const existing = readQueue(queueId, storeDir) || buildQueue(queueId, now);
  const next = {
    ...existing,
    updatedAt: now(),
    goals: [...(Array.isArray(existing.goals) ? existing.goals : []), built],
  };
  writeQueue(next, storeDir);
  return { queueId, goal: built };
}

/**
 * Find the next pending goal (FIFO) and mark it `running`. Returns the goal
 * (or null when queue empty / paused / no pending). Does not actually invoke
 * the engine — engine integration is the caller's responsibility (runQueue).
 *
 * @param {string} queueId
 * @param {{storeDir?:string, now?:Function}} [opts]
 * @returns {object|null}
 */
export function dequeueGoal(queueId, opts = {}) {
  const now = typeof opts.now === 'function' ? opts.now : () => new Date().toISOString();
  const storeDir = opts.storeDir;
  const queue = readQueue(queueId, storeDir);
  if (!queue || !Array.isArray(queue.goals)) return null;
  if (queue.paused) return null;
  const idx = queue.goals.findIndex((g) => g && g.status === GOAL_STATUS.PENDING);
  if (idx === -1) return null;
  const goal = queue.goals[idx];
  const updated = { ...goal, status: GOAL_STATUS.RUNNING, startedAt: now() };
  const nextGoals = [...queue.goals];
  nextGoals[idx] = updated;
  writeQueue({ ...queue, goals: nextGoals, updatedAt: now() }, storeDir);
  return updated;
}

/**
 * List goals for one queue, or summarize all queues when queueId omitted.
 *
 * @param {string|null} [queueId]
 * @param {{storeDir?:string}} [opts]
 * @returns {object[]|object|null}
 */
export function listQueue(queueId, opts = {}) {
  const storeDir = opts.storeDir;
  if (queueId) {
    const queue = readQueue(queueId, storeDir);
    if (!queue) return null;
    return {
      queueId: queue.queueId,
      paused: !!queue.paused,
      createdAt: queue.createdAt,
      updatedAt: queue.updatedAt,
      goals: Array.isArray(queue.goals) ? queue.goals : [],
    };
  }
  const dir = storeDir || getDefaultQueueDir();
  if (!existsSync(dir)) return [];
  let names;
  try { names = readdirSync(dir); } catch { return []; }
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0, -5);
    const queue = readQueue(id, storeDir);
    if (!queue) continue;
    const goals = Array.isArray(queue.goals) ? queue.goals : [];
    out.push({
      queueId: id,
      paused: !!queue.paused,
      total: goals.length,
      pending: goals.filter((g) => g.status === GOAL_STATUS.PENDING).length,
      running: goals.filter((g) => g.status === GOAL_STATUS.RUNNING).length,
      completed: goals.filter((g) => g.status === GOAL_STATUS.COMPLETED).length,
      failed: goals.filter((g) => g.status === GOAL_STATUS.FAILED).length,
    });
  }
  return out;
}

/**
 * Remove a goal from a queue. Returns true on success.
 *
 * @param {string} queueId
 * @param {string} goalId
 * @param {{storeDir?:string, now?:Function}} [opts]
 * @returns {boolean}
 */
export function removeFromQueue(queueId, goalId, opts = {}) {
  const now = typeof opts.now === 'function' ? opts.now : () => new Date().toISOString();
  const storeDir = opts.storeDir;
  const queue = readQueue(queueId, storeDir);
  if (!queue || !Array.isArray(queue.goals)) return false;
  const nextGoals = queue.goals.filter((g) => g && g.id !== goalId);
  if (nextGoals.length === queue.goals.length) return false;
  writeQueue({ ...queue, goals: nextGoals, updatedAt: now() }, storeDir);
  return true;
}

/**
 * Set the queue's paused flag. Returns the new paused state, or null on miss.
 *
 * @param {string} queueId
 * @param {boolean} paused
 * @param {{storeDir?:string, now?:Function}} [opts]
 * @returns {boolean|null}
 */
export function setQueuePaused(queueId, paused, opts = {}) {
  const now = typeof opts.now === 'function' ? opts.now : () => new Date().toISOString();
  const storeDir = opts.storeDir;
  const queue = readQueue(queueId, storeDir);
  if (!queue) return null;
  const flag = !!paused;
  writeQueue({ ...queue, paused: flag, updatedAt: now() }, storeDir);
  return flag;
}

/**
 * Mark a previously-dequeued goal as completed/failed. Used by runQueue and
 * exposed for engine integration.
 *
 * @param {string} queueId
 * @param {string} goalId
 * @param {{status:'completed'|'failed', error?:string, storeDir?:string, now?:Function}} opts
 * @returns {boolean}
 */
export function finalizeGoal(queueId, goalId, opts = {}) {
  const now = typeof opts.now === 'function' ? opts.now : () => new Date().toISOString();
  const storeDir = opts.storeDir;
  const queue = readQueue(queueId, storeDir);
  if (!queue || !Array.isArray(queue.goals)) return false;
  const idx = queue.goals.findIndex((g) => g && g.id === goalId);
  if (idx === -1) return false;
  const status = opts.status === GOAL_STATUS.FAILED ? GOAL_STATUS.FAILED : GOAL_STATUS.COMPLETED;
  const updated = {
    ...queue.goals[idx],
    status,
    completedAt: now(),
    error: typeof opts.error === 'string' ? opts.error : null,
  };
  const nextGoals = [...queue.goals];
  nextGoals[idx] = updated;
  writeQueue({ ...queue, goals: nextGoals, updatedAt: now() }, storeDir);
  return true;
}

/**
 * Drain all pending goals through a runner. The runner is DI'd so unit tests
 * can stub engine invocation. Stops early if the queue is paused or runner
 * returns `{ stop: true }`.
 *
 * @param {string} queueId
 * @param {{
 *   runner: (goal:object) => Promise<{ok:boolean, error?:string, stop?:boolean}>,
 *   storeDir?: string,
 *   now?: Function,
 *   maxGoals?: number,
 * }} opts
 * @returns {Promise<{ran:number, completed:number, failed:number, stopped:boolean}>}
 */
export async function runQueue(queueId, opts = {}) {
  if (typeof opts.runner !== 'function') {
    throw new TypeError('runQueue requires opts.runner function');
  }
  const result = { ran: 0, completed: 0, failed: 0, stopped: false };
  const cap = Number.isFinite(opts.maxGoals) && opts.maxGoals > 0
    ? Math.floor(opts.maxGoals)
    : Infinity;
  while (result.ran < cap) {
    const goal = dequeueGoal(queueId, opts);
    if (!goal) break;
    result.ran += 1;
    let outcome;
    try {
      outcome = await opts.runner(goal);
    } catch (err) {
      outcome = { ok: false, error: err?.message || String(err) };
    }
    const ok = outcome && outcome.ok === true;
    finalizeGoal(queueId, goal.id, {
      status: ok ? GOAL_STATUS.COMPLETED : GOAL_STATUS.FAILED,
      error: ok ? null : (outcome?.error || 'runner returned not-ok'),
      storeDir: opts.storeDir,
      now: opts.now,
    });
    if (ok) result.completed += 1; else result.failed += 1;
    if (outcome && outcome.stop === true) {
      result.stopped = true;
      break;
    }
  }
  return result;
}
