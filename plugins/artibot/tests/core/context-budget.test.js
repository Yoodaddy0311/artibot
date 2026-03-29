import { describe, expect, it } from 'vitest';
import {
  EWMA,
  createContextBudget,
  distributeWeighted,
  predictTaskCost,
} from '../../lib/core/context-budget.js';

// ---------------------------------------------------------------------------
// EWMA
// ---------------------------------------------------------------------------

describe('EWMA', () => {
  it('initializes with zero value and count', () => {
    const ewma = new EWMA(0.3);
    expect(ewma.value).toBe(0);
    expect(ewma.count).toBe(0);
  });

  it('sets first observation directly without blending', () => {
    const ewma = new EWMA(0.3);
    ewma.update(100);
    expect(ewma.value).toBe(100);
    expect(ewma.count).toBe(1);
  });

  it('blends subsequent observations with alpha', () => {
    const ewma = new EWMA(0.5);
    ewma.update(100);
    ewma.update(200);
    // 0.5 * 200 + 0.5 * 100 = 150
    expect(ewma.value).toBe(150);
    expect(ewma.count).toBe(2);
  });

  it('converges toward repeated values', () => {
    const ewma = new EWMA(0.3);
    ewma.update(100);
    for (let i = 0; i < 20; i++) ewma.update(50);
    expect(ewma.value).toBeCloseTo(50, 0);
  });

  it('clamps alpha to valid range', () => {
    const low = new EWMA(0);
    expect(low._alpha).toBe(0.01);
    const high = new EWMA(5);
    expect(high._alpha).toBe(1);
  });

  it('can be initialized with a non-zero initial value', () => {
    const ewma = new EWMA(0.3, 500);
    expect(ewma.value).toBe(500);
    expect(ewma.count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// predictTaskCost
// ---------------------------------------------------------------------------

describe('predictTaskCost', () => {
  it('returns default cost for known task types', () => {
    const history = new Map();
    expect(predictTaskCost('code', history)).toBe(8000);
    expect(predictTaskCost('search', history)).toBe(3000);
    expect(predictTaskCost('chat', history)).toBe(2000);
  });

  it('returns default fallback for unknown task types', () => {
    const history = new Map();
    expect(predictTaskCost('unknown-xyz', history)).toBe(5000);
  });

  it('uses EWMA value when history exists', () => {
    const history = new Map();
    const ewma = new EWMA(0.3, 12000);
    history.set('code', ewma);
    expect(predictTaskCost('code', history)).toBe(12000);
  });
});

// ---------------------------------------------------------------------------
// distributeWeighted
// ---------------------------------------------------------------------------

describe('distributeWeighted', () => {
  it('distributes proportionally to estimates', () => {
    const result = distributeWeighted(10000, [
      { id: 'a', estimate: 3000 },
      { id: 'b', estimate: 7000 },
    ]);
    expect(result.get('a')).toBe(3000);
    expect(result.get('b')).toBe(7000);
  });

  it('returns zero for all tasks when remaining is 0', () => {
    const result = distributeWeighted(0, [
      { id: 'a', estimate: 5000 },
      { id: 'b', estimate: 5000 },
    ]);
    expect(result.get('a')).toBe(0);
    expect(result.get('b')).toBe(0);
  });

  it('handles empty estimates array', () => {
    const result = distributeWeighted(10000, []);
    expect(result.size).toBe(0);
  });

  it('handles single task', () => {
    const result = distributeWeighted(10000, [
      { id: 'solo', estimate: 5000 },
    ]);
    expect(result.get('solo')).toBe(10000);
  });
});

// ---------------------------------------------------------------------------
// createContextBudget + allocate
// ---------------------------------------------------------------------------

describe('ContextBudget.allocate', () => {
  it('allocates budget across tasks with safety reserve', () => {
    const budget = createContextBudget(100000, { safetyReserve: 0.1 });
    const alloc = budget.allocate([
      { id: 't1', type: 'code' },   // 8000 estimate
      { id: 't2', type: 'search' }, // 3000 estimate
    ], 0);

    // remaining = 100000 - 0 - 10000(reserve) = 90000
    // t1 share: 8000/11000 * 90000 = 65455
    // t2 share: 3000/11000 * 90000 = 24545
    const t1 = alloc.get('t1');
    const t2 = alloc.get('t2');
    expect(t1 + t2).toBeLessThanOrEqual(90000);
    expect(t1).toBeGreaterThan(t2);
  });

  it('accounts for currentUsage in allocation', () => {
    const budget = createContextBudget(100000, { safetyReserve: 0.1 });
    const alloc = budget.allocate([
      { id: 't1', type: 'code' },
    ], 80000);

    // remaining = 100000 - 80000 - 10000 = 10000
    expect(alloc.get('t1')).toBe(10000);
  });

  it('returns zero when currentUsage exceeds capacity', () => {
    const budget = createContextBudget(100000, { safetyReserve: 0.1 });
    const alloc = budget.allocate([
      { id: 't1', type: 'code' },
    ], 95000);

    // remaining = max(0, 100000 - 95000 - 10000) = 0
    expect(alloc.get('t1')).toBe(0);
  });

  it('uses default type when type is omitted', () => {
    const budget = createContextBudget(100000);
    const alloc = budget.allocate([{ id: 't1' }], 0);
    expect(alloc.get('t1')).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// record
// ---------------------------------------------------------------------------

describe('ContextBudget.record', () => {
  it('accumulates usage across multiple records', () => {
    const budget = createContextBudget(100000);
    budget.allocate([{ id: 't1', type: 'code' }], 0);
    budget.record('t1', 3000);
    budget.record('t1', 2000);
    expect(budget.getTaskBudget('t1').used).toBe(5000);
  });

  it('updates EWMA prediction history', () => {
    const budget = createContextBudget(100000);
    budget.allocate([{ id: 't1', type: 'code' }], 0);
    budget.record('t1', 6000);
    // Internal EWMA should now have a recorded value
    const info = budget.getTaskBudget('t1');
    expect(info.used).toBe(6000);
  });
});

// ---------------------------------------------------------------------------
// shouldCompress
// ---------------------------------------------------------------------------

describe('ContextBudget.shouldCompress', () => {
  it('returns no compression when usage is low', () => {
    const budget = createContextBudget(100000, { safetyReserve: 0 });
    budget.allocate([{ id: 't1', type: 'code' }], 0);
    budget.record('t1', 1000);
    const advice = budget.shouldCompress('t1');
    expect(advice.compress).toBe(false);
    expect(advice.severity).toBe('low');
  });

  it('returns low severity at 70%+ usage', () => {
    const budget = createContextBudget(100000, { safetyReserve: 0 });
    budget.allocate([{ id: 't1', type: 'code' }], 0);
    const allocated = budget.getTaskBudget('t1').budget;
    budget.record('t1', Math.ceil(allocated * 0.75));
    const advice = budget.shouldCompress('t1');
    expect(advice.compress).toBe(true);
    expect(advice.severity).toBe('low');
    expect(advice.recommendation).toContain('75%');
  });

  it('returns high severity at 90%+ usage', () => {
    const budget = createContextBudget(100000, { safetyReserve: 0 });
    budget.allocate([{ id: 't1', type: 'code' }], 0);
    const allocated = budget.getTaskBudget('t1').budget;
    budget.record('t1', Math.ceil(allocated * 0.95));
    const advice = budget.shouldCompress('t1');
    expect(advice.compress).toBe(true);
    expect(advice.severity).toBe('high');
  });

  it('returns no compression for unallocated task', () => {
    const budget = createContextBudget(100000);
    const advice = budget.shouldCompress('nonexistent');
    expect(advice.compress).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getTaskBudget
// ---------------------------------------------------------------------------

describe('ContextBudget.getTaskBudget', () => {
  it('returns correct budget info', () => {
    const budget = createContextBudget(100000, { safetyReserve: 0 });
    budget.allocate([{ id: 't1', type: 'code' }], 0);
    budget.record('t1', 20000);
    const info = budget.getTaskBudget('t1');
    expect(info.budget).toBe(100000);
    expect(info.used).toBe(20000);
    expect(info.remaining).toBe(80000);
    expect(info.pctUsed).toBe(20);
  });

  it('returns zeros for unknown task', () => {
    const budget = createContextBudget(100000);
    const info = budget.getTaskBudget('unknown');
    expect(info.budget).toBe(0);
    expect(info.used).toBe(0);
    expect(info.remaining).toBe(0);
    expect(info.pctUsed).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// suggestIsolation
// ---------------------------------------------------------------------------

describe('ContextBudget.suggestIsolation', () => {
  it('returns false when task has plenty of budget', () => {
    const budget = createContextBudget(100000, { safetyReserve: 0 });
    budget.allocate([{ id: 't1', type: 'code' }], 0);
    budget.record('t1', 10000); // 10% used
    expect(budget.suggestIsolation('t1')).toBe(false);
  });

  it('returns true when task has consumed over half its budget', () => {
    const budget = createContextBudget(100000, { safetyReserve: 0 });
    budget.allocate([{ id: 't1', type: 'code' }], 0);
    const allocated = budget.getTaskBudget('t1').budget;
    budget.record('t1', Math.ceil(allocated * 0.6));
    expect(budget.suggestIsolation('t1')).toBe(true);
  });

  it('returns false for unknown task', () => {
    const budget = createContextBudget(100000);
    expect(budget.suggestIsolation('nope')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getRemainingBudget
// ---------------------------------------------------------------------------

describe('ContextBudget.getRemainingBudget', () => {
  it('returns correct summary after allocation', () => {
    const budget = createContextBudget(100000, { safetyReserve: 0.1 });
    budget.allocate([
      { id: 't1', type: 'code' },
      { id: 't2', type: 'search' },
    ], 0);

    const summary = budget.getRemainingBudget();
    expect(summary.total).toBe(100000);
    expect(summary.safetyReserve).toBe(10000);
    expect(summary.allocated).toBeGreaterThan(0);
    expect(summary.allocated + summary.unallocated + summary.safetyReserve).toBe(100000);
  });

  it('returns full unallocated when no tasks allocated', () => {
    const budget = createContextBudget(100000, { safetyReserve: 0.2 });
    const summary = budget.getRemainingBudget();
    expect(summary.total).toBe(100000);
    expect(summary.allocated).toBe(0);
    expect(summary.safetyReserve).toBe(20000);
    expect(summary.unallocated).toBe(80000);
  });
});
