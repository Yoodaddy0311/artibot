import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks for I/O dependencies (hoisted by vitest)
// ---------------------------------------------------------------------------

const mockReadJsonFile = vi.fn();
const mockWriteJsonFile = vi.fn();

vi.mock('../../lib/core/file.js', () => ({
  readJsonFile: (...args) => mockReadJsonFile(...args),
  writeJsonFile: (...args) => mockWriteJsonFile(...args),
}));

vi.mock('../../lib/core/platform.js', () => ({
  getHomeDir: vi.fn(() => '/fake/home'),
}));

// ---------------------------------------------------------------------------
// Import after mocks are registered
// ---------------------------------------------------------------------------

import {
  registerAgent,
  unregisterAgent,
  addTask,
  updateTaskStatus,
  addHistory,
  getActiveAgents,
  getInProgressTasks,
  loadSessionState,
  saveSessionState,
} from '../../lib/context/session.js';

describe('session', () => {
  let baseState;

  beforeEach(() => {
    vi.clearAllMocks();
    mockReadJsonFile.mockResolvedValue(null);
    mockWriteJsonFile.mockResolvedValue(undefined);
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
      const newState = addTask(baseState, {
        id: 't1',
        description: 'Test task',
      });
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
      const newState = addTask(baseState, {
        id: 't1',
        description: 'Test',
        status: 'in_progress',
      });
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
      const newState = addHistory(baseState, 'task_completed', {
        taskId: 't1',
      });
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
      const s1 = addTask(baseState, {
        id: 't1',
        description: 'A',
        status: 'in_progress',
      });
      const s2 = addTask(s1, { id: 't2', description: 'B' }); // pending
      const s3 = addTask(s2, {
        id: 't3',
        description: 'C',
        status: 'in_progress',
      });
      const result = getInProgressTasks(s3);
      expect(result).toHaveLength(2);
      expect(result.map((t) => t.id)).toEqual(['t1', 't3']);
    });

    it('returns empty array when no in_progress tasks', () => {
      const s1 = addTask(baseState, { id: 't1', description: 'A' });
      expect(getInProgressTasks(s1)).toEqual([]);
    });
  });

  // =========================================================================
  // loadSessionState() - async I/O
  // =========================================================================
  describe('loadSessionState()', () => {
    it('returns default state when state file is missing', async () => {
      mockReadJsonFile.mockResolvedValue(null);

      const state = await loadSessionState();

      expect(state.sessionId).toBeNull();
      expect(state.startedAt).toBeNull();
      expect(state.agents).toEqual({});
      expect(state.tasks).toEqual([]);
      expect(state.history).toEqual([]);
      expect(state.metadata).toEqual({});
    });

    it('merges persisted data over defaults', async () => {
      mockReadJsonFile.mockResolvedValue({
        sessionId: 'saved-session',
        startedAt: '2026-02-01T00:00:00.000Z',
        agents: { planner: { active: true } },
      });

      const state = await loadSessionState();

      expect(state.sessionId).toBe('saved-session');
      expect(state.startedAt).toBe('2026-02-01T00:00:00.000Z');
      expect(state.agents.planner.active).toBe(true);
      // Defaults preserved for missing keys
      expect(state.tasks).toEqual([]);
      expect(state.history).toEqual([]);
      expect(state.metadata).toEqual({});
    });

    it('reads from the correct path', async () => {
      mockReadJsonFile.mockResolvedValue(null);

      await loadSessionState();

      expect(mockReadJsonFile).toHaveBeenCalledTimes(1);
      const calledPath = mockReadJsonFile.mock.calls[0][0];
      expect(calledPath.replace(/\\/g, '/')).toContain(
        '.claude/artibot-state.json',
      );
    });

    it('preserves extra fields from persisted data', async () => {
      mockReadJsonFile.mockResolvedValue({
        sessionId: 'saved',
        customField: 'custom-value',
      });

      const state = await loadSessionState();

      expect(state.sessionId).toBe('saved');
      expect(state.customField).toBe('custom-value');
    });

    it('returns default state when persisted data is empty object', async () => {
      mockReadJsonFile.mockResolvedValue({});

      const state = await loadSessionState();

      expect(state.sessionId).toBeNull();
      expect(state.agents).toEqual({});
      expect(state.tasks).toEqual([]);
    });
  });

  // =========================================================================
  // saveSessionState() - async I/O
  // =========================================================================
  describe('saveSessionState()', () => {
    it('writes state to disk via writeJsonFile', async () => {
      const state = {
        sessionId: 'test-123',
        startedAt: '2026-01-01T00:00:00.000Z',
        agents: {},
        tasks: [],
        history: [],
        metadata: {},
      };

      await saveSessionState(state);

      expect(mockWriteJsonFile).toHaveBeenCalledTimes(1);
      expect(mockWriteJsonFile.mock.calls[0][1]).toEqual(state);
    });

    it('writes to the correct path', async () => {
      await saveSessionState({ sessionId: 'test' });

      const calledPath = mockWriteJsonFile.mock.calls[0][0];
      expect(calledPath.replace(/\\/g, '/')).toContain(
        '.claude/artibot-state.json',
      );
    });

    it('propagates errors from writeJsonFile', async () => {
      mockWriteJsonFile.mockRejectedValue(
        new Error('EACCES: permission denied'),
      );

      await expect(saveSessionState({})).rejects.toThrow('EACCES');
    });
  });

  // =========================================================================
  // Edge cases for pure functions
  // =========================================================================
  describe('edge cases', () => {
    it('updateTaskStatus does not add updatedAt when taskId not found', () => {
      const s1 = addTask(baseState, { id: 't1', description: 'Test' });
      const s2 = updateTaskStatus(s1, 'nonexistent', 'completed');
      expect(s2.tasks[0].status).toBe('pending');
      expect(s2.tasks[0].updatedAt).toBeUndefined();
    });

    it('addHistory with empty data object still adds timestamp', () => {
      const newState = addHistory(baseState, 'event', {});
      expect(newState.history[0].event).toBe('event');
      expect(newState.history[0].timestamp).toBeTruthy();
    });

    it('registerAgent overwrites existing agent with same id', () => {
      const s1 = registerAgent(baseState, 'planner', { role: 'lead' });
      const s2 = registerAgent(s1, 'planner', { role: 'updated' });
      expect(s2.agents.planner.role).toBe('updated');
      expect(s2.agents.planner.active).toBe(true);
    });

    it('unregisterAgent preserves original agent info', () => {
      const s1 = registerAgent(baseState, 'planner', { role: 'lead' });
      const s2 = unregisterAgent(s1, 'planner');
      expect(s2.agents.planner.role).toBe('lead');
      expect(s2.agents.planner.active).toBe(false);
    });

    it('getActiveAgents returns empty when all agents inactive', () => {
      const s1 = registerAgent(baseState, 'planner');
      const s2 = registerAgent(s1, 'reviewer');
      const s3 = unregisterAgent(s2, 'planner');
      const s4 = unregisterAgent(s3, 'reviewer');
      expect(getActiveAgents(s4)).toEqual([]);
    });

    it('getInProgressTasks returns empty for completed tasks', () => {
      const s1 = addTask(baseState, {
        id: 't1',
        description: 'A',
        status: 'completed',
      });
      const s2 = addTask(s1, {
        id: 't2',
        description: 'B',
        status: 'blocked',
      });
      expect(getInProgressTasks(s2)).toEqual([]);
    });

    it('multiple status updates keep latest status', () => {
      const s1 = addTask(baseState, { id: 't1', description: 'Test' });
      const s2 = updateTaskStatus(s1, 't1', 'in_progress');
      const s3 = updateTaskStatus(s2, 't1', 'completed');
      expect(s3.tasks[0].status).toBe('completed');
      expect(s3.tasks[0].updatedAt).toBeTruthy();
    });
  });
});
