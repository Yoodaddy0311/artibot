/**
 * Graceful cancellation system for orchestration workflows.
 * Tracks cancellation requests and propagates them to downstream tasks
 * using DAG dependency information.
 *
 * Inspired by Harness CI's canceler pattern: only PENDING, WAITING_ON_DEPS,
 * and RUNNING tasks can be cancelled; terminal statuses are ignored.
 *
 * @module lib/orchestration/canceler
 */

import { canCancel, STATUS } from './status.js';

/**
 * @typedef {object} CancelRecord
 * @property {string} executionId
 * @property {string} reason
 * @property {number} cancelledAt
 * @property {string} previousStatus
 */

/**
 * Create a new Canceler instance.
 *
 * @param {object} [options]
 * @param {() => number} [options.now] - Clock function for testability.
 * @returns {Canceler}
 */
export function createCanceler(options = {}) {
  const now = options.now || Date.now;

  /** @type {Map<string, CancelRecord>} */
  const cancelled = new Map();

  return {
    /**
     * Register a cancellation request for an execution.
     * Only succeeds if the current status is cancellable (PENDING,
     * WAITING_ON_DEPS, or RUNNING). Returns true if cancelled,
     * false if the status prevents cancellation.
     *
     * @param {string} executionId
     * @param {string} [currentStatus='RUNNING'] - Current task status.
     * @param {string} [reason='cancelled by user'] - Reason for cancellation.
     * @returns {boolean} Whether the cancellation was accepted.
     */
    cancel(executionId, currentStatus = STATUS.RUNNING, reason = 'cancelled by user') {
      if (!executionId) return false;
      if (cancelled.has(executionId)) return true; // already cancelled
      if (!canCancel(currentStatus)) return false;

      cancelled.set(executionId, Object.freeze({
        executionId,
        reason,
        cancelledAt: now(),
        previousStatus: currentStatus,
      }));
      return true;
    },

    /**
     * Check whether an execution has been cancelled.
     *
     * @param {string} executionId
     * @returns {boolean}
     */
    isCancelled(executionId) {
      return cancelled.has(executionId);
    },

    /**
     * Cancel all downstream tasks of a failed/cancelled task in the DAG.
     * Walks the DAG using its public API and cancels every task that
     * transitively depends on the given task, provided its status is cancellable.
     *
     * @param {import('./dag.js').Dag} dag - A Dag instance.
     * @param {string} failedTaskId - The task that failed or was cancelled.
     * @param {(taskId: string) => string} [getStatus] - Status lookup per task.
     * @returns {string[]} List of newly cancelled downstream task IDs.
     */
    cancelDownstream(dag, failedTaskId, getStatus) {
      const statusFn = getStatus || (() => STATUS.PENDING);
      if (!dag || typeof dag.dependents !== 'function') return [];
      if (!dag.has(failedTaskId)) return [];

      const downstream = findDownstream(dag, failedTaskId);
      const newlyCancelled = [];

      for (const taskId of downstream) {
        const status = statusFn(taskId);
        const accepted = this.cancel(taskId, status, `upstream ${failedTaskId} failed`);
        if (accepted && !newlyCancelled.includes(taskId)) {
          newlyCancelled.push(taskId);
        }
      }
      return newlyCancelled;
    },

    /**
     * Return all cancelled task records.
     *
     * @returns {CancelRecord[]}
     */
    getCancelledTasks() {
      return [...cancelled.values()];
    },

    /**
     * Reset all cancellation state. Useful between test runs
     * or when starting a fresh orchestration.
     */
    reset() {
      cancelled.clear();
    },
  };
}

/**
 * Find all tasks that transitively depend on the given task.
 * Uses the Dag's public `dependents(id)` method for BFS traversal.
 *
 * @param {import('./dag.js').Dag} dag - A Dag instance.
 * @param {string} taskId - The root task to find dependents of.
 * @returns {string[]} All downstream task IDs (breadth-first order).
 */
function findDownstream(dag, taskId) {
  const result = [];
  const visited = new Set();
  const queue = [taskId];

  while (queue.length > 0) {
    const current = queue.shift();
    const children = dag.dependents(current);
    for (const child of children) {
      if (visited.has(child)) continue;
      visited.add(child);
      result.push(child);
      queue.push(child);
    }
  }
  return result;
}
