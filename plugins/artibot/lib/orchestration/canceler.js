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
     * Walks the DAG graph and cancels every task that transitively depends
     * on the given task, provided its status is cancellable.
     *
     * @param {object} dag - A Dag instance with `graph` Map of vertices.
     * @param {string} failedTaskId - The task that failed or was cancelled.
     * @param {(taskId: string) => string} [getStatus] - Status lookup per task.
     * @returns {string[]} List of newly cancelled downstream task IDs.
     */
    cancelDownstream(dag, failedTaskId, getStatus) {
      const statusFn = getStatus || (() => STATUS.PENDING);
      const graph = dag?.graph;
      if (!graph) return [];

      const downstream = findDownstream(graph, failedTaskId);
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
 * A task B depends on task A if A appears in B's dependency list (graph edges).
 *
 * @param {Map<string, object>} graph - DAG graph map (name -> Vertex).
 * @param {string} taskId - The root task to find dependents of.
 * @returns {string[]} All downstream task IDs (breadth-first order).
 */
function findDownstream(graph, taskId) {
  const dependents = [];
  const visited = new Set();
  const queue = [taskId];

  while (queue.length > 0) {
    const current = queue.shift();
    for (const [name, vertex] of graph) {
      if (visited.has(name)) continue;
      const deps = vertex.graph || [];
      if (deps.includes(current)) {
        visited.add(name);
        dependents.push(name);
        queue.push(name);
      }
    }
  }
  return dependents;
}
