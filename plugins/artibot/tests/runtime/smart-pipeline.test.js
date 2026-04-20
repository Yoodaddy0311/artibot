import { describe, expect, it } from 'vitest';
import {
  _matchConditions,
  _matchIntent,
  _updateStats,
  createSmartPipeline,
} from '../../lib/runtime/smart-pipeline.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeState(overrides = {}) {
  return {
    context: {
      routing: { system: 'system1', score: 0.3, intent: 'action:implement' },
      intent: { best: 'action:implement' },
      mode: 'dev',
      ...overrides.context,
    },
    messageParts: [],
    userPrompt: 'test prompt',
    ...overrides,
  };
}

function makeMw(name, conditions = {}, fn = async (s) => s) {
  return { name, fn, conditions };
}

// ---------------------------------------------------------------------------
// matchIntent
// ---------------------------------------------------------------------------

describe('_matchIntent', () => {
  it('wildcard * matches everything', () => {
    expect(_matchIntent('action:implement', '*')).toBe(true);
    expect(_matchIntent('', '*')).toBe(true);
  });

  it('prefix glob matches prefix', () => {
    expect(_matchIntent('action:implement', 'action:*')).toBe(true);
    expect(_matchIntent('action:build', 'action:*')).toBe(true);
    expect(_matchIntent('query:search', 'action:*')).toBe(false);
  });

  it('exact match', () => {
    expect(_matchIntent('action:implement', 'action:implement')).toBe(true);
    expect(_matchIntent('action:build', 'action:implement')).toBe(false);
  });

  it('no match for completely different intent', () => {
    expect(_matchIntent('query:search', 'action:implement')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// matchConditions
// ---------------------------------------------------------------------------

describe('_matchConditions', () => {
  const ctx = { intent: 'action:implement', system: 'system2', mode: 'dev', complexity: 0.75 };

  it('empty conditions = always match', () => {
    expect(_matchConditions({ conditions: {} }, ctx)).toBe(true);
    expect(_matchConditions({ conditions: undefined }, ctx)).toBe(true);
    expect(_matchConditions({}, ctx)).toBe(true);
  });

  it('intents: "*" = always match', () => {
    expect(_matchConditions({ conditions: { intents: '*' } }, ctx)).toBe(true);
  });

  it('intents array with prefix glob', () => {
    expect(_matchConditions({ conditions: { intents: ['action:*'] } }, ctx)).toBe(true);
    expect(_matchConditions({ conditions: { intents: ['query:*'] } }, ctx)).toBe(false);
  });

  it('systems matching', () => {
    expect(_matchConditions({ conditions: { systems: ['system2'] } }, ctx)).toBe(true);
    expect(_matchConditions({ conditions: { systems: ['system1'] } }, ctx)).toBe(false);
  });

  it('modes matching', () => {
    expect(_matchConditions({ conditions: { modes: ['dev', 'debug'] } }, ctx)).toBe(true);
    expect(_matchConditions({ conditions: { modes: ['plan'] } }, ctx)).toBe(false);
  });

  it('minComplexity threshold', () => {
    expect(_matchConditions({ conditions: { minComplexity: 0.5 } }, ctx)).toBe(true);
    expect(_matchConditions({ conditions: { minComplexity: 0.9 } }, ctx)).toBe(false);
  });

  it('composite conditions (AND logic)', () => {
    expect(_matchConditions({
      conditions: { intents: ['action:*'], systems: ['system2'], minComplexity: 0.5 },
    }, ctx)).toBe(true);

    expect(_matchConditions({
      conditions: { intents: ['action:*'], systems: ['system1'] },
    }, ctx)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// _updateStats
// ---------------------------------------------------------------------------

describe('_updateStats', () => {
  it('records a run', () => {
    const map = new Map();
    _updateStats(map, 'test', 10, false);
    expect(map.get('test')).toEqual({ runs: 1, skips: 0, totalMs: 10, avgMs: 10 });
  });

  it('records a skip', () => {
    const map = new Map();
    _updateStats(map, 'test', 0, true);
    expect(map.get('test')).toEqual({ runs: 0, skips: 1, totalMs: 0, avgMs: 0 });
  });

  it('accumulates multiple runs', () => {
    const map = new Map();
    _updateStats(map, 'test', 10, false);
    _updateStats(map, 'test', 20, false);
    const stats = map.get('test');
    expect(stats.runs).toBe(2);
    expect(stats.totalMs).toBe(30);
    expect(stats.avgMs).toBe(15);
  });
});

// ---------------------------------------------------------------------------
// selectMiddlewares
// ---------------------------------------------------------------------------

describe('selectMiddlewares', () => {
  it('selects all when all conditions match', () => {
    const pipeline = createSmartPipeline([
      makeMw('a', { intents: '*' }),
      makeMw('b', { intents: '*' }),
    ]);
    const selected = pipeline.selectMiddlewares({ intent: 'anything', system: 'system1' });
    expect(selected).toHaveLength(2);
  });

  it('selects partial based on system', () => {
    const pipeline = createSmartPipeline([
      makeMw('always', { intents: '*' }),
      makeMw('s2only', { systems: ['system2'] }),
    ]);
    const selected = pipeline.selectMiddlewares({ system: 'system1' });
    expect(selected).toHaveLength(1);
    expect(selected[0].name).toBe('always');
  });

  it('selects none when nothing matches', () => {
    const pipeline = createSmartPipeline([
      makeMw('s2only', { systems: ['system2'] }),
    ]);
    const selected = pipeline.selectMiddlewares({ system: 'system1' });
    expect(selected).toHaveLength(0);
  });

  it('handles empty middleware list', () => {
    const pipeline = createSmartPipeline([]);
    expect(pipeline.selectMiddlewares({})).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

describe('run', () => {
  it('executes selected middlewares sequentially', async () => {
    const order = [];
    const pipeline = createSmartPipeline([
      makeMw('first', { intents: '*' }, async (s) => { order.push('first'); return s; }),
      makeMw('second', { intents: '*' }, async (s) => { order.push('second'); return s; }),
    ], { now: () => 1000 });

    const state = makeState();
    await pipeline.run(state);
    expect(order).toEqual(['first', 'second']);
  });

  it('skips non-matching middlewares', async () => {
    const executed = [];
    const pipeline = createSmartPipeline([
      makeMw('always', { intents: '*' }, async (s) => { executed.push('always'); return s; }),
      makeMw('s2only', { systems: ['system2'] }, async (s) => { executed.push('s2only'); return s; }),
    ], { now: () => 1000 });

    const state = makeState({ context: { routing: { system: 'system1', score: 0.3 } } });
    await pipeline.run(state);
    expect(executed).toEqual(['always']);
  });

  it('handles middleware errors gracefully', async () => {
    const pipeline = createSmartPipeline([
      makeMw('failing', { intents: '*' }, async () => { throw new Error('boom'); }),
      makeMw('after', { intents: '*' }, async (s) => { s.messageParts.push('after=ok'); return s; }),
    ], { now: () => 1000 });

    const state = makeState();
    const result = await pipeline.run(state);
    expect(result.messageParts).toContain('failing=error');
    expect(result.messageParts).toContain('after=ok');
  });

  it('works with empty pipeline', async () => {
    const pipeline = createSmartPipeline([], { now: () => 1000 });
    const state = makeState();
    const result = await pipeline.run(state);
    expect(result).toBe(state);
  });

  it('records stats for runs and skips', async () => {
    let time = 0;
    const pipeline = createSmartPipeline([
      makeMw('always', { intents: '*' }, async (s) => s),
      makeMw('s2only', { systems: ['system2'] }, async (s) => s),
    ], { now: () => { time += 5; return time; } });

    await pipeline.run(makeState({ context: { routing: { system: 'system1', score: 0.3 } } }));
    const stats = pipeline.getStats();
    expect(stats.get('always').runs).toBe(1);
    expect(stats.get('s2only').skips).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// getStats
// ---------------------------------------------------------------------------

describe('getStats', () => {
  it('returns stats for all registered middlewares', () => {
    const pipeline = createSmartPipeline([
      makeMw('a', {}),
      makeMw('b', {}),
    ]);
    const stats = pipeline.getStats();
    expect(stats.size).toBe(2);
    expect(stats.get('a')).toEqual({ runs: 0, skips: 0, totalMs: 0, avgMs: 0 });
  });

  it('returns defensive copy', async () => {
    const pipeline = createSmartPipeline([
      makeMw('a', { intents: '*' }, async (s) => s),
    ], { now: () => 1000 });

    await pipeline.run(makeState());
    const s1 = pipeline.getStats();
    s1.get('a').runs = 999;
    const s2 = pipeline.getStats();
    expect(s2.get('a').runs).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// getEfficiency
// ---------------------------------------------------------------------------

describe('getEfficiency', () => {
  it('all runs, no skips', async () => {
    const pipeline = createSmartPipeline([
      makeMw('a', { intents: '*' }, async (s) => s),
    ], { now: () => 1000 });

    await pipeline.run(makeState());
    const eff = pipeline.getEfficiency();
    expect(eff.totalRuns).toBe(1);
    expect(eff.totalSkips).toBe(0);
    expect(eff.skipRate).toBe(0);
  });

  it('mixed runs and skips', async () => {
    let time = 0;
    const pipeline = createSmartPipeline([
      makeMw('always', { intents: '*' }, async (s) => s),
      makeMw('s2only', { systems: ['system2'] }, async (s) => s),
    ], { now: () => { time += 10; return time; } });

    await pipeline.run(makeState({ context: { routing: { system: 'system1', score: 0.3 } } }));
    const eff = pipeline.getEfficiency();
    expect(eff.totalRuns).toBe(1);
    expect(eff.totalSkips).toBe(1);
    expect(eff.skipRate).toBe(0.5);
    expect(eff.savedMs).toBeGreaterThan(0);
  });

  it('all skips', () => {
    const pipeline = createSmartPipeline([
      makeMw('s2only', { systems: ['system2'] }, async (s) => s),
    ], { now: () => 1000 });

    // Don't run, just check initial state
    const eff = pipeline.getEfficiency();
    expect(eff.totalRuns).toBe(0);
    expect(eff.totalSkips).toBe(0);
    expect(eff.skipRate).toBe(0);
  });
});
