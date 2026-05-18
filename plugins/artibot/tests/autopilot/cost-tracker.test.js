/**
 * Unit tests for lib/autopilot/cost-tracker.js
 *
 * Covers:
 *   - recordPhaseUsage updates totals + per-phase + appendEvent
 *   - guards: invalid sessionId/phase, NaN/negative tokens → 0
 *   - getSessionCost: missing session → empty, with usage → breakdown
 *   - budget=null/zero → budgetUsage:null; budget>0 → percent
 *   - checkBudgetThreshold: 50/80/95 boundaries fire once each
 *   - renderCostBlock: GFM table + Total + Budget row; empty → ''
 *   - renderCostInline: budget present/absent, last-phase suffix
 */
import {
  describe, expect, it, vi,
} from 'vitest';
import {
  checkBudgetThreshold,
  getSessionCost,
  recordPhaseUsage,
  renderCostBlock,
  renderCostInline,
} from '../../lib/autopilot/cost-tracker.js';

/**
 * Build a fresh in-memory DI store + spy `appendEvent`.
 * Returns the matching opts object usable with all cost-tracker APIs.
 */
function makeStore(initialState) {
  const store = new Map();
  if (initialState && initialState.sessionId) {
    store.set(initialState.sessionId, JSON.parse(JSON.stringify(initialState)));
  }
  const loadSession = vi.fn((id) => {
    const s = store.get(id);
    return s ? JSON.parse(JSON.stringify(s)) : null;
  });
  const saveSession = vi.fn((s) => {
    store.set(s.sessionId, JSON.parse(JSON.stringify(s)));
    return s;
  });
  const appendEvent = vi.fn(() => ({}));
  return {
    store,
    opts: { loadSession, saveSession, appendEvent },
    loadSession,
    saveSession,
    appendEvent,
  };
}

describe('recordPhaseUsage', () => {
  it('returns null for invalid sessionId', () => {
    const m = makeStore();
    expect(recordPhaseUsage('', 'EXECUTE', { tokensIn: 10 }, m.opts)).toBeNull();
    expect(recordPhaseUsage(null, 'EXECUTE', { tokensIn: 10 }, m.opts)).toBeNull();
    expect(m.opts.loadSession).not.toHaveBeenCalled();
  });

  it('returns null for invalid phase', () => {
    const m = makeStore({ sessionId: 'ap-1' });
    expect(recordPhaseUsage('ap-1', '', { tokensIn: 10 }, m.opts)).toBeNull();
    expect(recordPhaseUsage('ap-1', null, { tokensIn: 10 }, m.opts)).toBeNull();
  });

  it('returns null when session is missing on disk', () => {
    const m = makeStore();
    const out = recordPhaseUsage('ap-missing', 'EXECUTE', { tokensIn: 5 }, m.opts);
    expect(out).toBeNull();
    expect(m.opts.saveSession).not.toHaveBeenCalled();
  });

  it('persists totals + per-phase entry on first call', () => {
    const m = makeStore({ sessionId: 'ap-1' });
    const delta = recordPhaseUsage('ap-1', 'EXECUTE', {
      tokensIn: 100, tokensOut: 50, costUsd: 0.0123, model: 'opus-4.7',
    }, m.opts);
    expect(delta).toEqual({
      tokensIn: 100, tokensOut: 50, costUsd: 0.0123, model: 'opus-4.7',
    });
    const stored = m.store.get('ap-1');
    expect(stored.usage.totals).toEqual({ tokensIn: 100, tokensOut: 50, costUsd: 0.0123 });
    expect(stored.usage.phases.EXECUTE.tokensIn).toBe(100);
    expect(stored.usage.phases.EXECUTE.tokensOut).toBe(50);
    expect(stored.usage.phases.EXECUTE.costUsd).toBe(0.0123);
    expect(stored.usage.phases.EXECUTE.model).toBe('opus-4.7');
    expect(stored.usage.phases.EXECUTE.lastTs).toMatch(/T.*Z$/);
    expect(m.opts.appendEvent).toHaveBeenCalledTimes(1);
    const ev = m.opts.appendEvent.mock.calls[0][1];
    expect(ev.type).toBe('usage');
    expect(ev.phase).toBe('EXECUTE');
  });

  it('accumulates across multiple calls for the same phase', () => {
    const m = makeStore({ sessionId: 'ap-2' });
    recordPhaseUsage('ap-2', 'EXECUTE', { tokensIn: 100, costUsd: 0.01 }, m.opts);
    recordPhaseUsage('ap-2', 'EXECUTE', { tokensIn: 50, costUsd: 0.005 }, m.opts);
    const stored = m.store.get('ap-2');
    expect(stored.usage.phases.EXECUTE.tokensIn).toBe(150);
    expect(stored.usage.phases.EXECUTE.costUsd).toBeCloseTo(0.015, 6);
    expect(stored.usage.totals.tokensIn).toBe(150);
  });

  it('coerces NaN / negative / non-numeric inputs to 0 (silent guard)', () => {
    const m = makeStore({ sessionId: 'ap-3' });
    const delta = recordPhaseUsage('ap-3', 'PLAN', {
      tokensIn: -50, tokensOut: NaN, costUsd: 'abc',
    }, m.opts);
    expect(delta).toEqual({ tokensIn: 0, tokensOut: 0, costUsd: 0, model: undefined });
    const stored = m.store.get('ap-3');
    expect(stored.usage.totals).toEqual({ tokensIn: 0, tokensOut: 0, costUsd: 0 });
  });

  it('survives telemetry appendEvent failure without throwing', () => {
    const m = makeStore({ sessionId: 'ap-4' });
    m.opts.appendEvent = vi.fn(() => { throw new Error('telemetry down'); });
    expect(() => recordPhaseUsage('ap-4', 'EXECUTE', { tokensIn: 1 }, m.opts)).not.toThrow();
    const stored = m.store.get('ap-4');
    expect(stored.usage.totals.tokensIn).toBe(1);
  });

  it('survives saveSession failure with null return', () => {
    const m = makeStore({ sessionId: 'ap-5' });
    m.opts.saveSession = vi.fn(() => { throw new Error('disk full'); });
    const out = recordPhaseUsage('ap-5', 'EXECUTE', { tokensIn: 1 }, m.opts);
    expect(out).toBeNull();
  });
});

describe('getSessionCost', () => {
  it('returns zeroed empty summary for missing sessionId', () => {
    expect(getSessionCost('')).toEqual({
      totalTokens: 0, totalCostUsd: 0, perPhase: [], budgetUsage: null,
    });
  });

  it('returns zeroed empty when session is not on disk', () => {
    const m = makeStore();
    expect(getSessionCost('ap-missing', m.opts)).toEqual({
      totalTokens: 0, totalCostUsd: 0, perPhase: [], budgetUsage: null,
    });
  });

  it('aggregates totals and per-phase breakdown after multiple records', () => {
    const m = makeStore({ sessionId: 'ap-6' });
    recordPhaseUsage('ap-6', 'INTAKE', { tokensIn: 10, tokensOut: 5, costUsd: 0.001 }, m.opts);
    recordPhaseUsage('ap-6', 'EXECUTE', { tokensIn: 100, tokensOut: 80, costUsd: 0.05 }, m.opts);
    const summary = getSessionCost('ap-6', m.opts);
    expect(summary.totalTokens).toBe(10 + 5 + 100 + 80);
    expect(summary.totalCostUsd).toBeCloseTo(0.051, 6);
    expect(summary.perPhase).toHaveLength(2);
    expect(summary.perPhase.map((p) => p.phase)).toEqual(['INTAKE', 'EXECUTE']);
    expect(summary.budgetUsage).toBeNull();
  });

  it('returns budgetUsage with percent when state.options.budget > 0', () => {
    const m = makeStore({ sessionId: 'ap-7', options: { budget: 10 } });
    recordPhaseUsage('ap-7', 'EXECUTE', { costUsd: 2.5 }, m.opts);
    const summary = getSessionCost('ap-7', m.opts);
    expect(summary.budgetUsage).toEqual({ limit: 10, used: 2.5, percent: 25 });
  });

  it('returns budgetUsage:null when budget = 0', () => {
    const m = makeStore({ sessionId: 'ap-8', options: { budget: 0 } });
    recordPhaseUsage('ap-8', 'EXECUTE', { costUsd: 1 }, m.opts);
    const summary = getSessionCost('ap-8', m.opts);
    expect(summary.budgetUsage).toBeNull();
  });
});

describe('checkBudgetThreshold', () => {
  it('returns empty result when sessionId or limit is missing/invalid', () => {
    const m = makeStore({ sessionId: 'ap-9' });
    expect(checkBudgetThreshold('', { limitUsd: 10, ...m.opts })).toEqual({
      crossed: null, used: 0, percent: 0,
    });
    expect(checkBudgetThreshold('ap-9', { limitUsd: 0, ...m.opts })).toEqual({
      crossed: null, used: 0, percent: 0,
    });
    expect(checkBudgetThreshold('ap-9', { limitUsd: -5, ...m.opts })).toEqual({
      crossed: null, used: 0, percent: 0,
    });
  });

  it('crosses 50% boundary exactly once', () => {
    const m = makeStore({ sessionId: 'ap-10' });
    recordPhaseUsage('ap-10', 'EXECUTE', { costUsd: 5 }, m.opts); // 50% of 10
    const first = checkBudgetThreshold('ap-10', { limitUsd: 10, ...m.opts });
    expect(first.crossed).toBe(50);
    expect(first.percent).toBe(50);
    const second = checkBudgetThreshold('ap-10', { limitUsd: 10, ...m.opts });
    expect(second.crossed).toBeNull(); // already fired
  });

  it('fires 80% as the largest newly-crossed when jumping from 0 → 85%', () => {
    const m = makeStore({ sessionId: 'ap-11' });
    recordPhaseUsage('ap-11', 'EXECUTE', { costUsd: 8.5 }, m.opts); // 85%
    const out = checkBudgetThreshold('ap-11', { limitUsd: 10, ...m.opts });
    // implementation visits 50→80→95 in order, marking all newly-crossed and
    // returning the largest. 50 and 80 fire and persist; 95 not crossed.
    expect(out.crossed).toBe(80);
    expect(out.percent).toBe(85);
    const next = checkBudgetThreshold('ap-11', { limitUsd: 10, ...m.opts });
    expect(next.crossed).toBeNull();
  });

  it('fires 95% danger gate when spend hits 95%+', () => {
    const m = makeStore({ sessionId: 'ap-12' });
    recordPhaseUsage('ap-12', 'EXECUTE', { costUsd: 9.7 }, m.opts);
    const out = checkBudgetThreshold('ap-12', { limitUsd: 10, ...m.opts });
    expect(out.crossed).toBe(95);
    expect(out.percent).toBe(97);
  });
});

describe('renderCostBlock', () => {
  it('returns empty string for null / empty / zero-cost summaries', () => {
    expect(renderCostBlock(null)).toBe('');
    expect(renderCostBlock({})).toBe('');
    expect(renderCostBlock({
      totalTokens: 0, totalCostUsd: 0, perPhase: [], budgetUsage: null,
    })).toBe('');
  });

  it('produces a GFM table with Total row when summary has data', () => {
    const md = renderCostBlock({
      totalTokens: 150,
      totalCostUsd: 0.05,
      perPhase: [
        { phase: 'EXECUTE', tokensIn: 100, tokensOut: 50, costUsd: 0.05 },
      ],
      budgetUsage: null,
    });
    expect(md).toContain('## Phase Cost');
    const header = md.split('\n').find((l) => l.startsWith('| Phase '));
    expect(header).toBeDefined();
    expect((header.match(/\|/g) || []).length).toBe(5); // 4 cols → 5 pipes
    expect(md).toMatch(/\|---\|/);
    expect(md).toContain('| EXECUTE | 100 | 50 | $0.0500 |');
    expect(md).toContain('**Total**: 150 tokens, $0.0500');
    expect(md).not.toContain('**Budget**');
  });

  it('appends a Budget row when budgetUsage is present', () => {
    const md = renderCostBlock({
      totalTokens: 1000,
      totalCostUsd: 2.5,
      perPhase: [{ phase: 'EXECUTE', tokensIn: 500, tokensOut: 500, costUsd: 2.5 }],
      budgetUsage: { limit: 10, used: 2.5, percent: 25 },
    });
    expect(md).toContain('**Budget**: $2.5000 / $10.0000 (25%)');
  });
});

describe('renderCostInline', () => {
  it('returns empty string for null / empty summaries', () => {
    expect(renderCostInline(null)).toBe('');
    expect(renderCostInline({
      totalTokens: 0, totalCostUsd: 0, perPhase: [], budgetUsage: null,
    })).toBe('');
  });

  it('formats cost / budget / last-phase suffix', () => {
    const line = renderCostInline({
      totalTokens: 14000,
      totalCostUsd: 0.23,
      perPhase: [
        { phase: 'INTAKE', tokensIn: 12000, tokensOut: 2000, costUsd: 0.23 },
      ],
      budgetUsage: { limit: 5, used: 0.23, percent: 4.6 },
    });
    expect(line).toContain('cost: $0.2300 / $5.0000 (4.6%)');
    expect(line).toContain('INTAKE 12.0k/2.0k');
  });

  it('falls back to non-budget format when budgetUsage missing', () => {
    const line = renderCostInline({
      totalTokens: 100,
      totalCostUsd: 0.01,
      perPhase: [{ phase: 'PLAN', tokensIn: 60, tokensOut: 40, costUsd: 0.01 }],
      budgetUsage: null,
    });
    expect(line.startsWith('cost: $0.0100')).toBe(true);
    expect(line).toContain('PLAN 60/40');
    expect(line).not.toContain('/ $');
  });
});
