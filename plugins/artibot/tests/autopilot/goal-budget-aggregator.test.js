/**
 * Unit tests for lib/autopilot/goal-budget-aggregator.js
 *
 * Uses isolated tmpdir as storeDir so real ~/.artibot is untouched.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getBudgetPath,
  getGoalBudget,
  getQueueTotal,
  recordGoalUsage,
} from '../../lib/autopilot/goal-budget-aggregator.js';

let storeDir;
let clock;
const now = () => new Date(clock).toISOString();

beforeEach(() => {
  storeDir = mkdtempSync(path.join(os.tmpdir(), 'artibot-budget-'));
  clock = Date.parse('2026-05-17T00:00:00Z');
});

afterEach(() => {
  try { rmSync(storeDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('getBudgetPath', () => {
  it('throws on empty queueId', () => {
    expect(() => getBudgetPath('')).toThrow(TypeError);
  });

  it('joins storeDir + queueId.budget.json', () => {
    expect(getBudgetPath('q-1', storeDir)).toBe(path.join(storeDir, 'q-1.budget.json'));
  });
});

describe('recordGoalUsage', () => {
  it('returns null on invalid ids', () => {
    expect(recordGoalUsage('', 'g-1', 'EXECUTE', { tokensIn: 5 }, { storeDir })).toBeNull();
    expect(recordGoalUsage('q-1', '', 'EXECUTE', { tokensIn: 5 }, { storeDir })).toBeNull();
    expect(recordGoalUsage('q-1', 'g-1', '', { tokensIn: 5 }, { storeDir })).toBeNull();
  });

  it('creates a fresh budget file on first call', () => {
    const delta = recordGoalUsage('q-1', 'g-a', 'EXECUTE', {
      tokensIn: 100, tokensOut: 50, costUsd: 0.02,
    }, { storeDir, now });
    expect(delta).toEqual({ tokensIn: 100, tokensOut: 50, costUsd: 0.02 });
    const budget = getGoalBudget('q-1', 'g-a', { storeDir });
    expect(budget.tokensIn).toBe(100);
    expect(budget.tokensOut).toBe(50);
    expect(budget.costUsd).toBe(0.02);
  });

  it('accumulates across calls for the same goal+phase', () => {
    recordGoalUsage('q-2', 'g-a', 'EXECUTE', { tokensIn: 100, costUsd: 0.01 }, { storeDir, now });
    recordGoalUsage('q-2', 'g-a', 'EXECUTE', { tokensIn: 50, costUsd: 0.005 }, { storeDir, now });
    const budget = getGoalBudget('q-2', 'g-a', { storeDir });
    expect(budget.tokensIn).toBe(150);
    expect(budget.costUsd).toBeCloseTo(0.015, 6);
    expect(budget.perPhase).toHaveLength(1);
    expect(budget.perPhase[0].tokensIn).toBe(150);
  });

  it('keeps per-goal totals isolated', () => {
    recordGoalUsage('q-3', 'g-a', 'EXECUTE', { tokensIn: 100 }, { storeDir, now });
    recordGoalUsage('q-3', 'g-b', 'EXECUTE', { tokensIn: 200 }, { storeDir, now });
    expect(getGoalBudget('q-3', 'g-a', { storeDir }).tokensIn).toBe(100);
    expect(getGoalBudget('q-3', 'g-b', { storeDir }).tokensIn).toBe(200);
  });

  it('coerces NaN / negative inputs to 0', () => {
    const delta = recordGoalUsage('q-4', 'g-a', 'PLAN', {
      tokensIn: -10, tokensOut: NaN, costUsd: 'bad',
    }, { storeDir, now });
    expect(delta).toEqual({ tokensIn: 0, tokensOut: 0, costUsd: 0 });
  });
});

describe('getGoalBudget', () => {
  it('returns zeroed empty for missing queue', () => {
    const b = getGoalBudget('q-nope', 'g-a', { storeDir });
    expect(b).toEqual({
      tokensIn: 0, tokensOut: 0, costUsd: 0, totalTokens: 0, perPhase: [],
    });
  });

  it('returns zeroed empty for unknown goal', () => {
    recordGoalUsage('q-5', 'g-a', 'EXECUTE', { tokensIn: 10 }, { storeDir, now });
    const b = getGoalBudget('q-5', 'g-missing', { storeDir });
    expect(b.tokensIn).toBe(0);
    expect(b.perPhase).toEqual([]);
  });

  it('returns per-phase breakdown', () => {
    recordGoalUsage('q-6', 'g-a', 'INTAKE', { tokensIn: 10, tokensOut: 5 }, { storeDir, now });
    recordGoalUsage('q-6', 'g-a', 'EXECUTE', { tokensIn: 100, tokensOut: 80 }, { storeDir, now });
    const b = getGoalBudget('q-6', 'g-a', { storeDir });
    expect(b.totalTokens).toBe(10 + 5 + 100 + 80);
    expect(b.perPhase.map((p) => p.phase).sort()).toEqual(['EXECUTE', 'INTAKE']);
  });

  it('returns zeroed empty on non-string args', () => {
    expect(getGoalBudget(null, null)).toEqual({
      tokensIn: 0, tokensOut: 0, costUsd: 0, totalTokens: 0, perPhase: [],
    });
  });
});

describe('getQueueTotal', () => {
  it('returns zeroed empty for missing queue', () => {
    const t = getQueueTotal('q-nope', { storeDir });
    expect(t).toEqual({
      tokensIn: 0, tokensOut: 0, costUsd: 0, totalTokens: 0, goalCount: 0, perGoal: [],
    });
  });

  it('aggregates across multiple goals', () => {
    recordGoalUsage('q-7', 'g-a', 'EXECUTE', { tokensIn: 100, costUsd: 0.01 }, { storeDir, now });
    recordGoalUsage('q-7', 'g-b', 'EXECUTE', { tokensIn: 200, costUsd: 0.02 }, { storeDir, now });
    const t = getQueueTotal('q-7', { storeDir });
    expect(t.tokensIn).toBe(300);
    expect(t.costUsd).toBeCloseTo(0.03, 6);
    expect(t.goalCount).toBe(2);
    expect(t.perGoal.map((g) => g.goalId).sort()).toEqual(['g-a', 'g-b']);
  });

  it('returns zeroed empty on non-string queueId', () => {
    expect(getQueueTotal(null).goalCount).toBe(0);
  });
});
