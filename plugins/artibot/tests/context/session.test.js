import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  registerAgent,
  unregisterAgent,
  addTask,
  updateTaskStatus,
  addHistory,
  getActiveAgents,
  getInProgressTasks,
} from '../../lib/context/session.js';

describe('session', () => {
  let baseState;

  beforeEach(() => {
    baseState = {
      sessionId: 'test-session',
      startedAt: '2026-01-01T00:00:00.000Z',
      agents: {},
      tasks: [],
      history: [],
      metadata: {},
    };
  });

  describe('registerAgent()', () => {
    it('adds agent to state immutably', () => {
      const newState = registerAgent(baseState, 'planner');
      expect(newState.agents.planner).toBeDefined();
      expect(newState.agents.planner.active).toBe(true);
      expect(newState.agents.planner.registeredAt).toBeTruthy();
      // Original unchanged
      expect(baseState.agents.planner).toBeUndefined();
    });

    it('preserves existing agents', () => {
      const s1 = registerAgent(baseState, 'planner');
      const s2 = registerAgent(s1, 'reviewer');
      expect(s2.agents.planner).toBeDefined();
      expect(s2.agents.reviewer).toBeDefined();
    });

    it('accepts additional info', () => {
      const newState = registerAgent(baseState, 'planner', { role: 'lead' });
      expect(newState.agents.planner.role).toBe('lead');
    });
  });

  describe('unregisterAgent()', () => {
    it('marks agent as inactive', () => {
      const s1 = registerAgent(baseState, 'planner');
      const s2 = unregisterAgent(s1, 'planner');
      expect(s2.agents.planner.active).toBe(false);
      expect(s2.agents.planner.stoppedAt).toBeTruthy();
    });

    it('returns same state for unknown agent', () => {
      const result = unregisterAgent(baseState, 'unknown');
      expect(result).toBe(baseState);
    });

    it('preserves other agents', () => {
      const s1 = registerAgent(baseState, 'planner');
      const s2 = registerAgent(s1, 'reviewer');
      const s3 = unregisterAgent(s2, 'planner');
      expect(s3.agents.reviewer.active).toBe(true);
      expect(s3.agents.planner.active).toBe(false);
    });
  });

  describe('addTask()', () => {
    it('adds task with default pending status', () => {
      const newState = addTask(baseState, { id: 't1', description: 'Test task' });
      expect(newState.tasks).toHaveLength(1);
      expect(newState.tasks[0].id).toBe('t1');
      expect(newState.tasks[0].status).toBe('pending');
      expect(newState.tasks[0].createdAt).toBeTruthy();
    });

    it('preserves existing tasks', () => {
      const s1 = addTask(baseState, { id: 't1', description: 'First' });
      const s2 = addTask(s1, { id: 't2', description: 'Second' });
      expect(s2.tasks).toHaveLength(2);
    });

    it('does not mutate original state', () => {
      addTask(baseState, { id: 't1', description: 'Test' });
      expect(baseState.tasks).toHaveLength(0);
    });

    it('respects provided status', () => {
      const newState = addTask(baseState, { id: 't1', description: 'Test', status: 'in_progress' });
      expect(newState.tasks[0].status).toBe('in_progress');
    });
  });

  describe('updateTaskStatus()', () => {
    it('updates task status by id', () => {
      const s1 = addTask(baseState, { id: 't1', description: 'Test' });
      const s2 = updateTaskStatus(s1, 't1', 'completed');
      expect(s2.tasks[0].status).toBe('completed');
      expect(s2.tasks[0].updatedAt).toBeTruthy();
    });

    it('does not affect other tasks', () => {
      const s1 = addTask(baseState, { id: 't1', description: 'First' });
      const s2 = addTask(s1, { id: 't2', description: 'Second' });
      const s3 = updateTaskStatus(s2, 't1', 'completed');
      expect(s3.tasks[0].status).toBe('completed');
      expect(s3.tasks[1].status).toBe('pending');
    });

    it('does not mutate original state', () => {
      const s1 = addTask(baseState, { id: 't1', description: 'Test' });
      updateTaskStatus(s1, 't1', 'completed');
      expect(s1.tasks[0].status).toBe('pending');
    });
  });

  describe('addHistory()', () => {
    it('adds event to history', () => {
      const newState = addHistory(baseState, 'agent_started');
      expect(newState.history).toHaveLength(1);
      expect(newState.history[0].event).toBe('agent_started');
      expect(newState.history[0].timestamp).toBeTruthy();
    });

    it('includes additional data', () => {
      const newState = addHistory(baseState, 'task_completed', { taskId: 't1' });
      expect(newState.history[0].taskId).toBe('t1');
    });

    it('preserves existing history', () => {
      const s1 = addHistory(baseState, 'first');
      const s2 = addHistory(s1, 'second');
      expect(s2.history).toHaveLength(2);
    });

    it('does not mutate original state', () => {
      addHistory(baseState, 'event');
      expect(baseState.history).toHaveLength(0);
    });
  });

  describe('getActiveAgents()', () => {
    it('returns active agent ids', () => {
      const s1 = registerAgent(baseState, 'planner');
      const s2 = registerAgent(s1, 'reviewer');
      expect(getActiveAgents(s2)).toEqual(['planner', 'reviewer']);
    });

    it('excludes inactive agents', () => {
      const s1 = registerAgent(baseState, 'planner');
      const s2 = registerAgent(s1, 'reviewer');
      const s3 = unregisterAgent(s2, 'planner');
      expect(getActiveAgents(s3)).toEqual(['reviewer']);
    });

    it('returns empty array when no agents', () => {
      expect(getActiveAgents(baseState)).toEqual([]);
    });
  });

  describe('getInProgressTasks()', () => {
    it('returns only in_progress tasks', () => {
      const s1 = addTask(baseState, { id: 't1', description: 'A', status: 'in_progress' });
      const s2 = addTask(s1, { id: 't2', description: 'B' }); // pending
      const s3 = addTask(s2, { id: 't3', description: 'C', status: 'in_progress' });
      const result = getInProgressTasks(s3);
      expect(result).toHaveLength(2);
      expect(result.map(t => t.id)).toEqual(['t1', 't3']);
    });

    it('returns empty array when no in_progress tasks', () => {
      const s1 = addTask(baseState, { id: 't1', description: 'A' });
      expect(getInProgressTasks(s1)).toEqual([]);
    });
  });
});
