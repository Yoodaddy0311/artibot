/**
 * Unit tests for lib/autopilot/goal-queue.js
 *
 * Covers enqueue / dequeue / list / remove / runQueue + pause + finalize.
 * Uses an isolated tmp dir as `storeDir` so no real `~/.artibot` writes leak.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CURRENT_QUEUE_SCHEMA_VERSION,
  dequeueGoal,
  enqueueGoal,
  finalizeGoal,
  getDefaultQueueDir,
  getQueuePath,
  GOAL_STATUS,
  listQueue,
  newQueueId,
  removeFromQueue,
  runQueue,
  setQueuePaused,
} from '../../lib/autopilot/goal-queue.js';

let storeDir;
let clock;
const now = () => new Date(clock).toISOString();

beforeEach(() => {
  storeDir = mkdtempSync(path.join(os.tmpdir(), 'artibot-queue-'));
  clock = Date.parse('2026-05-17T00:00:00Z');
});

afterEach(() => {
  try { rmSync(storeDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('newQueueId', () => {
  it('matches q-YYYYMMDD-HHmmss-xxxx pattern', () => {
    expect(newQueueId()).toMatch(/^q-\d{8}-\d{6}-[a-z0-9]{4}$/);
  });

  it('produces unique ids in tight loop', () => {
    const ids = new Set();
    for (let i = 0; i < 100; i += 1) ids.add(newQueueId());
    expect(ids.size).toBe(100);
  });
});

describe('getDefaultQueueDir', () => {
  it('ends with .artibot/queues', () => {
    const dir = getDefaultQueueDir();
    expect(dir.replace(/\\/g, '/')).toMatch(/\.artibot\/queues$/);
  });
});

describe('getQueuePath', () => {
  it('throws on empty queueId', () => {
    expect(() => getQueuePath('')).toThrow(TypeError);
    expect(() => getQueuePath(null)).toThrow(TypeError);
  });

  it('joins storeDir + queueId.json', () => {
    const p = getQueuePath('q-1', storeDir);
    expect(p).toBe(path.join(storeDir, 'q-1.json'));
  });
});

describe('enqueueGoal', () => {
  it('accepts a task string and creates the queue', () => {
    const { queueId, goal } = enqueueGoal('fix login bug', { storeDir, now });
    expect(queueId).toMatch(/^q-/);
    expect(goal.task).toBe('fix login bug');
    expect(goal.status).toBe(GOAL_STATUS.PENDING);
    expect(goal.id).toMatch(/^g-/);
  });

  it('accepts an object goal with options + metadata', () => {
    const { goal } = enqueueGoal(
      { task: 'refactor auth', options: { budget: 5 }, metadata: { src: 'cli' } },
      { storeDir, now, queueId: 'q-fixed' },
    );
    expect(goal.options.budget).toBe(5);
    expect(goal.metadata.src).toBe('cli');
  });

  it('rejects empty task', () => {
    expect(() => enqueueGoal('', { storeDir, now })).toThrow(TypeError);
    expect(() => enqueueGoal({ task: '   ' }, { storeDir, now })).toThrow(TypeError);
  });

  it('appends a second goal to an existing queue (FIFO order)', () => {
    enqueueGoal('a', { queueId: 'q-1', storeDir, now });
    enqueueGoal('b', { queueId: 'q-1', storeDir, now });
    const view = listQueue('q-1', { storeDir });
    expect(view.goals).toHaveLength(2);
    expect(view.goals[0].task).toBe('a');
    expect(view.goals[1].task).toBe('b');
  });

  it('stamps schemaVersion on first write', () => {
    enqueueGoal('a', { queueId: 'q-schema', storeDir, now });
    const view = listQueue('q-schema', { storeDir });
    expect(view).not.toBeNull();
    // listQueue elides schemaVersion; re-read via summary entry
    const summary = listQueue(null, { storeDir });
    expect(summary.find((s) => s.queueId === 'q-schema')).toBeDefined();
    // verify on raw file path
    const raw = JSON.parse(readFileSync(getQueuePath('q-schema', storeDir), 'utf-8'));
    expect(raw.schemaVersion).toBe(CURRENT_QUEUE_SCHEMA_VERSION);
  });

  it('uses caller-provided goal.id', () => {
    const { goal } = enqueueGoal({ task: 't', id: 'g-custom' }, { storeDir, now });
    expect(goal.id).toBe('g-custom');
  });
});

describe('dequeueGoal', () => {
  it('returns null on missing queue', () => {
    expect(dequeueGoal('q-missing', { storeDir, now })).toBeNull();
  });

  it('returns null when no pending goals', () => {
    enqueueGoal('a', { queueId: 'q-x', storeDir, now });
    const first = dequeueGoal('q-x', { storeDir, now });
    finalizeGoal('q-x', first.id, { status: GOAL_STATUS.COMPLETED, storeDir, now });
    expect(dequeueGoal('q-x', { storeDir, now })).toBeNull();
  });

  it('marks first pending as running and returns it', () => {
    enqueueGoal('a', { queueId: 'q-y', storeDir, now });
    enqueueGoal('b', { queueId: 'q-y', storeDir, now });
    const out = dequeueGoal('q-y', { storeDir, now });
    expect(out.task).toBe('a');
    expect(out.status).toBe(GOAL_STATUS.RUNNING);
    expect(out.startedAt).toBe(now());
  });

  it('respects paused flag', () => {
    enqueueGoal('a', { queueId: 'q-p', storeDir, now });
    setQueuePaused('q-p', true, { storeDir, now });
    expect(dequeueGoal('q-p', { storeDir, now })).toBeNull();
  });
});

describe('listQueue', () => {
  it('returns null for missing queueId', () => {
    expect(listQueue('q-nope', { storeDir })).toBeNull();
  });

  it('returns single-queue view with goals array', () => {
    enqueueGoal('a', { queueId: 'q-l', storeDir, now });
    const view = listQueue('q-l', { storeDir });
    expect(view.queueId).toBe('q-l');
    expect(view.paused).toBe(false);
    expect(view.goals).toHaveLength(1);
  });

  it('returns [] when no queues exist (no listing arg)', () => {
    expect(listQueue(null, { storeDir })).toEqual([]);
  });

  it('summarizes counts when listing all queues', () => {
    enqueueGoal('a', { queueId: 'q-sum', storeDir, now });
    enqueueGoal('b', { queueId: 'q-sum', storeDir, now });
    const summary = listQueue(null, { storeDir });
    expect(summary).toHaveLength(1);
    expect(summary[0]).toMatchObject({
      queueId: 'q-sum', total: 2, pending: 2, running: 0, completed: 0, failed: 0,
    });
  });
});

describe('removeFromQueue', () => {
  it('returns false on unknown queue', () => {
    expect(removeFromQueue('q-nope', 'g-1', { storeDir })).toBe(false);
  });

  it('returns false when goalId not present', () => {
    enqueueGoal('a', { queueId: 'q-r', storeDir, now });
    expect(removeFromQueue('q-r', 'g-missing', { storeDir })).toBe(false);
  });

  it('removes goal and updates queue', () => {
    const { goal } = enqueueGoal('a', { queueId: 'q-r2', storeDir, now });
    expect(removeFromQueue('q-r2', goal.id, { storeDir, now })).toBe(true);
    expect(listQueue('q-r2', { storeDir }).goals).toHaveLength(0);
  });
});

describe('setQueuePaused', () => {
  it('returns null on missing queue', () => {
    expect(setQueuePaused('q-nope', true, { storeDir, now })).toBeNull();
  });

  it('toggles paused flag', () => {
    enqueueGoal('a', { queueId: 'q-pa', storeDir, now });
    expect(setQueuePaused('q-pa', true, { storeDir, now })).toBe(true);
    expect(listQueue('q-pa', { storeDir }).paused).toBe(true);
    expect(setQueuePaused('q-pa', false, { storeDir, now })).toBe(false);
    expect(listQueue('q-pa', { storeDir }).paused).toBe(false);
  });
});

describe('finalizeGoal', () => {
  it('marks goal completed and stamps completedAt', () => {
    const { goal } = enqueueGoal('a', { queueId: 'q-f', storeDir, now });
    dequeueGoal('q-f', { storeDir, now });
    expect(finalizeGoal('q-f', goal.id, { status: GOAL_STATUS.COMPLETED, storeDir, now })).toBe(true);
    const view = listQueue('q-f', { storeDir });
    expect(view.goals[0].status).toBe(GOAL_STATUS.COMPLETED);
    expect(view.goals[0].completedAt).toBe(now());
  });

  it('marks goal failed with error', () => {
    const { goal } = enqueueGoal('a', { queueId: 'q-f2', storeDir, now });
    finalizeGoal('q-f2', goal.id, { status: GOAL_STATUS.FAILED, error: 'boom', storeDir, now });
    const view = listQueue('q-f2', { storeDir });
    expect(view.goals[0].status).toBe(GOAL_STATUS.FAILED);
    expect(view.goals[0].error).toBe('boom');
  });

  it('returns false on missing goal', () => {
    enqueueGoal('a', { queueId: 'q-f3', storeDir, now });
    expect(finalizeGoal('q-f3', 'g-missing', { status: GOAL_STATUS.COMPLETED, storeDir, now })).toBe(false);
  });
});

describe('runQueue', () => {
  it('throws when runner not provided', async () => {
    await expect(runQueue('q-1', { storeDir })).rejects.toThrow(TypeError);
  });

  it('drains pending goals, recording outcomes', async () => {
    enqueueGoal('a', { queueId: 'q-run', storeDir, now });
    enqueueGoal('b', { queueId: 'q-run', storeDir, now });
    const runner = vi.fn(async (g) => ({ ok: g.task === 'a' }));
    const out = await runQueue('q-run', { runner, storeDir, now });
    expect(out).toEqual({ ran: 2, completed: 1, failed: 1, stopped: false });
    expect(runner).toHaveBeenCalledTimes(2);
    const view = listQueue('q-run', { storeDir });
    expect(view.goals[0].status).toBe(GOAL_STATUS.COMPLETED);
    expect(view.goals[1].status).toBe(GOAL_STATUS.FAILED);
  });

  it('respects runner stop signal mid-drain', async () => {
    enqueueGoal('a', { queueId: 'q-stop', storeDir, now });
    enqueueGoal('b', { queueId: 'q-stop', storeDir, now });
    const runner = vi.fn(async () => ({ ok: true, stop: true }));
    const out = await runQueue('q-stop', { runner, storeDir, now });
    expect(out.stopped).toBe(true);
    expect(out.ran).toBe(1);
  });

  it('honours maxGoals cap', async () => {
    enqueueGoal('a', { queueId: 'q-cap', storeDir, now });
    enqueueGoal('b', { queueId: 'q-cap', storeDir, now });
    enqueueGoal('c', { queueId: 'q-cap', storeDir, now });
    const runner = vi.fn(async () => ({ ok: true }));
    const out = await runQueue('q-cap', { runner, storeDir, now, maxGoals: 2 });
    expect(out.ran).toBe(2);
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it('captures runner throws as failed outcomes', async () => {
    enqueueGoal('a', { queueId: 'q-throw', storeDir, now });
    const runner = vi.fn(async () => { throw new Error('boom'); });
    const out = await runQueue('q-throw', { runner, storeDir, now });
    expect(out.failed).toBe(1);
    expect(listQueue('q-throw', { storeDir }).goals[0].error).toBe('boom');
  });

  it('stops when queue paused', async () => {
    enqueueGoal('a', { queueId: 'q-paused', storeDir, now });
    setQueuePaused('q-paused', true, { storeDir, now });
    const runner = vi.fn(async () => ({ ok: true }));
    const out = await runQueue('q-paused', { runner, storeDir, now });
    expect(out.ran).toBe(0);
    expect(runner).not.toHaveBeenCalled();
  });
});
