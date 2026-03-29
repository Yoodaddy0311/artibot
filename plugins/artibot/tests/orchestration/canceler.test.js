import { beforeEach, describe, expect, it } from 'vitest';
import { createCanceler } from '../../lib/orchestration/canceler.js';
import { Dag } from '../../lib/orchestration/dag.js';
import { STATUS } from '../../lib/orchestration/status.js';

/**
 * Build a DAG for testing cancelDownstream.
 * Graph: A -> B -> C, A -> D (B and D depend on A, C depends on B), E independent
 */
function makeDag() {
  const dag = new Dag();
  dag.add('A');
  dag.add('B', ['A']);
  dag.add('C', ['B']);
  dag.add('D', ['A']);
  dag.add('E');
  return dag;
}

describe('orchestration/canceler', () => {
  let canceler;
  const fixedNow = () => 1700000000000;

  beforeEach(() => {
    canceler = createCanceler({ now: fixedNow });
  });

  describe('cancel()', () => {
    it('cancels a RUNNING task', () => {
      const result = canceler.cancel('task-1', STATUS.RUNNING);
      expect(result).toBe(true);
      expect(canceler.isCancelled('task-1')).toBe(true);
    });

    it('cancels a PENDING task', () => {
      expect(canceler.cancel('task-2', STATUS.PENDING)).toBe(true);
      expect(canceler.isCancelled('task-2')).toBe(true);
    });

    it('cancels a WAITING_ON_DEPS task', () => {
      expect(canceler.cancel('task-3', STATUS.WAITING_ON_DEPS)).toBe(true);
    });

    it('rejects cancellation of SUCCESS task', () => {
      expect(canceler.cancel('task-4', STATUS.SUCCESS)).toBe(false);
      expect(canceler.isCancelled('task-4')).toBe(false);
    });

    it('rejects cancellation of FAILURE task', () => {
      expect(canceler.cancel('task-5', STATUS.FAILURE)).toBe(false);
    });

    it('rejects cancellation of ERROR task', () => {
      expect(canceler.cancel('task-6', STATUS.ERROR)).toBe(false);
    });

    it('rejects cancellation of KILLED task', () => {
      expect(canceler.cancel('task-7', STATUS.KILLED)).toBe(false);
    });

    it('rejects cancellation of SKIPPED task', () => {
      expect(canceler.cancel('task-8', STATUS.SKIPPED)).toBe(false);
    });

    it('returns true for already-cancelled task (idempotent)', () => {
      canceler.cancel('task-9', STATUS.RUNNING);
      expect(canceler.cancel('task-9', STATUS.RUNNING)).toBe(true);
    });

    it('returns false for empty executionId', () => {
      expect(canceler.cancel('', STATUS.RUNNING)).toBe(false);
      expect(canceler.cancel(null, STATUS.RUNNING)).toBe(false);
      expect(canceler.cancel(undefined, STATUS.RUNNING)).toBe(false);
    });

    it('uses default status and reason', () => {
      canceler.cancel('task-10');
      const tasks = canceler.getCancelledTasks();
      const record = tasks.find((t) => t.executionId === 'task-10');
      expect(record.previousStatus).toBe(STATUS.RUNNING);
      expect(record.reason).toBe('cancelled by user');
    });

    it('records cancellation timestamp', () => {
      canceler.cancel('task-11', STATUS.RUNNING);
      const record = canceler.getCancelledTasks()[0];
      expect(record.cancelledAt).toBe(1700000000000);
    });

    it('records custom reason', () => {
      canceler.cancel('task-12', STATUS.PENDING, 'timeout exceeded');
      const record = canceler.getCancelledTasks()[0];
      expect(record.reason).toBe('timeout exceeded');
    });

    it('record is frozen (immutable)', () => {
      canceler.cancel('task-13', STATUS.RUNNING);
      const record = canceler.getCancelledTasks()[0];
      expect(() => { record.reason = 'mutated'; }).toThrow();
    });
  });

  describe('isCancelled()', () => {
    it('returns false for unknown executionId', () => {
      expect(canceler.isCancelled('nonexistent')).toBe(false);
    });

    it('returns true after cancellation', () => {
      canceler.cancel('task-20', STATUS.RUNNING);
      expect(canceler.isCancelled('task-20')).toBe(true);
    });
  });

  describe('getCancelledTasks()', () => {
    it('returns empty array initially', () => {
      expect(canceler.getCancelledTasks()).toEqual([]);
    });

    it('returns all cancelled records', () => {
      canceler.cancel('a', STATUS.RUNNING);
      canceler.cancel('b', STATUS.PENDING);
      const tasks = canceler.getCancelledTasks();
      expect(tasks).toHaveLength(2);
      expect(tasks.map((t) => t.executionId)).toEqual(['a', 'b']);
    });

    it('returns a new array each call (no reference leaking)', () => {
      canceler.cancel('a', STATUS.RUNNING);
      const first = canceler.getCancelledTasks();
      const second = canceler.getCancelledTasks();
      expect(first).not.toBe(second);
      expect(first).toEqual(second);
    });
  });

  describe('reset()', () => {
    it('clears all cancellation state', () => {
      canceler.cancel('a', STATUS.RUNNING);
      canceler.cancel('b', STATUS.PENDING);
      canceler.reset();
      expect(canceler.getCancelledTasks()).toEqual([]);
      expect(canceler.isCancelled('a')).toBe(false);
    });
  });

  describe('cancelDownstream()', () => {
    it('cancels direct dependents of a failed task', () => {
      const dag = makeDag();
      const result = canceler.cancelDownstream(dag, 'A');
      expect(result).toContain('B');
      expect(result).toContain('D');
      expect(canceler.isCancelled('B')).toBe(true);
      expect(canceler.isCancelled('D')).toBe(true);
    });

    it('cancels transitive dependents (C depends on B depends on A)', () => {
      const dag = makeDag();
      const result = canceler.cancelDownstream(dag, 'A');
      expect(result).toContain('C');
      expect(canceler.isCancelled('C')).toBe(true);
    });

    it('does not cancel independent tasks', () => {
      const dag = makeDag();
      canceler.cancelDownstream(dag, 'A');
      expect(canceler.isCancelled('E')).toBe(false);
    });

    it('skips tasks in terminal status', () => {
      const dag = makeDag();
      const getStatus = (id) => (id === 'B' ? STATUS.SUCCESS : STATUS.PENDING);
      const result = canceler.cancelDownstream(dag, 'A', getStatus);
      expect(result).not.toContain('B');
      expect(result).toContain('D');
      // C still gets cancelled because it depends on B (traversal still walks)
      // but C has PENDING status so it can be cancelled
      expect(result).toContain('C');
    });

    it('includes upstream failure in reason', () => {
      const dag = makeDag();
      canceler.cancelDownstream(dag, 'A');
      const record = canceler.getCancelledTasks().find((t) => t.executionId === 'B');
      expect(record.reason).toContain('upstream A failed');
    });

    it('returns empty array for null/missing dag', () => {
      expect(canceler.cancelDownstream(null, 'A')).toEqual([]);
      expect(canceler.cancelDownstream({}, 'A')).toEqual([]);
    });

    it('returns empty array for task with no dependents', () => {
      const dag = makeDag();
      expect(canceler.cancelDownstream(dag, 'E')).toEqual([]);
    });

    it('does not duplicate already-cancelled tasks', () => {
      const dag = makeDag();
      canceler.cancel('B', STATUS.PENDING, 'manual');
      const result = canceler.cancelDownstream(dag, 'A');
      // B was already cancelled so cancel() returns true but it's not "newly" added
      expect(canceler.isCancelled('B')).toBe(true);
      expect(result).toContain('D');
      expect(result).toContain('C');
    });
  });
});
