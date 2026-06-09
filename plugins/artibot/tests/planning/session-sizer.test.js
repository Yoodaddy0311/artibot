/**
 * Tests for the session sizer — autopilot footprint estimation & band sizing.
 * @module tests/planning/session-sizer
 */

import { describe, expect, it } from 'vitest';

import {
  classifySize,
  COMPLEXITY_MULT,
  estimateFootprint,
  MAX_BUDGET_TOKENS,
  PER_TASK_TOKENS,
  SESSION_BAND,
  sizePlan,
  THROUGHPUT_TOKENS_PER_HOUR,
} from '../../lib/planning/session-sizer.js';

describe('exported constants', () => {
  it('anchors throughput to the 2M/4h autopilot config (500k tok/h)', () => {
    expect(THROUGHPUT_TOKENS_PER_HOUR).toBe(500000);
    expect(MAX_BUDGET_TOKENS).toBe(2000000);
    // Sanity: 4h × throughput == config maxBudget.
    expect(SESSION_BAND.maxHours * THROUGHPUT_TOKENS_PER_HOUR).toBe(MAX_BUDGET_TOKENS);
  });

  it('freezes tuning tables so callers cannot mutate shared state', () => {
    expect(Object.isFrozen(PER_TASK_TOKENS)).toBe(true);
    expect(Object.isFrozen(COMPLEXITY_MULT)).toBe(true);
    expect(Object.isFrozen(SESSION_BAND)).toBe(true);
  });
});

describe('estimateFootprint', () => {
  it('sums per-task baseline tokens at medium complexity', () => {
    const tasks = [{ type: 'impl' }, { type: 'test' }, { type: 'review' }];
    const r = estimateFootprint(tasks);
    // 120000 + 70000 + 50000 = 240000
    expect(r.tokens).toBe(240000);
    expect(r.hours).toBeCloseTo(240000 / 500000, 6);
    expect(r.perTask).toHaveLength(3);
    expect(r.perTask[0]).toMatchObject({ type: 'impl', complexity: 'medium', tokens: 120000 });
  });

  it('applies complexity multipliers', () => {
    const low = estimateFootprint([{ type: 'impl', complexity: 'low' }]);
    const high = estimateFootprint([{ type: 'impl', complexity: 'high' }]);
    expect(low.tokens).toBe(Math.round(120000 * 0.6)); // 72000
    expect(high.tokens).toBe(Math.round(120000 * 1.6)); // 192000
  });

  it('falls back to "other" for unknown task types', () => {
    const r = estimateFootprint([{ type: 'wat' }]);
    expect(r.perTask[0].type).toBe('other');
    expect(r.tokens).toBe(PER_TASK_TOKENS.other); // 60000
  });

  it('falls back to "medium" for unknown complexity', () => {
    const r = estimateFootprint([{ type: 'docs', complexity: 'galaxy' }]);
    expect(r.perTask[0].complexity).toBe('medium');
    expect(r.tokens).toBe(PER_TASK_TOKENS.docs);
  });

  it('returns zero footprint and simple/low for empty input', () => {
    const r = estimateFootprint([]);
    expect(r.tokens).toBe(0);
    expect(r.hours).toBe(0);
    expect(r.tier).toBe('simple');
    expect(r.confidence).toBe('low');
    expect(r.perTask).toEqual([]);
  });

  it('tolerates non-array input safely', () => {
    expect(estimateFootprint(undefined).tokens).toBe(0);
    expect(estimateFootprint(null).tokens).toBe(0);
  });

  it('derives tier from complexity distribution', () => {
    expect(estimateFootprint([{ type: 'impl', complexity: 'low' }]).tier).toBe('simple');
    expect(estimateFootprint([{ type: 'impl', complexity: 'medium' }]).tier).toBe('moderate');
    expect(estimateFootprint([{ type: 'impl', complexity: 'high' }]).tier).toBe('complex');
  });

  it('keeps confidence low for complex or large plans, medium for small simple ones', () => {
    const small = estimateFootprint([{ type: 'docs', complexity: 'low' }]);
    expect(small.confidence).toBe('medium');
    const complex = estimateFootprint([{ type: 'impl', complexity: 'high' }]);
    expect(complex.confidence).toBe('low');
    const large = estimateFootprint(Array(6).fill({ type: 'docs', complexity: 'low' }));
    expect(large.confidence).toBe('low');
  });

  it('honors throughput and per-task overrides', () => {
    const r = estimateFootprint([{ type: 'impl' }], {
      throughput: 100000,
      perTaskTokens: { impl: 100000, other: 1 },
    });
    expect(r.tokens).toBe(100000);
    expect(r.hours).toBe(1);
  });
});

describe('classifySize', () => {
  it('classifies sub-band durations as quick/expand', () => {
    const r = classifySize(1.5);
    expect(r.band).toBe('quick');
    expect(r.recommendation).toBe('expand');
    expect(r.splitInto).toBe(1);
    expect(r.target).toEqual({ minHours: 2, maxHours: 4 });
  });

  it('classifies in-band durations as session/ok', () => {
    expect(classifySize(2).band).toBe('session');
    expect(classifySize(3).recommendation).toBe('ok');
    expect(classifySize(4).band).toBe('session'); // inclusive upper bound
  });

  it('classifies over-band durations as epic/split with correct splitInto', () => {
    const r = classifySize(9);
    expect(r.band).toBe('epic');
    expect(r.recommendation).toBe('split');
    expect(r.splitInto).toBe(Math.ceil(9 / 4)); // 3
  });

  it('treats zero/invalid hours as quick', () => {
    expect(classifySize(0).band).toBe('quick');
    expect(classifySize(-5).band).toBe('quick');
    expect(classifySize(undefined).band).toBe('quick');
  });

  it('honors a custom band', () => {
    const r = classifySize(5, { band: { minHours: 6, maxHours: 8 } });
    expect(r.band).toBe('quick');
    expect(r.target).toEqual({ minHours: 6, maxHours: 8 });
  });
});

describe('sizePlan', () => {
  it('combines footprint + sizing + autopilot handoff', () => {
    const tasks = [{ type: 'impl' }, { type: 'test' }];
    const r = sizePlan(tasks);
    expect(r.footprint.tokens).toBe(190000);
    expect(r.sizing.band).toBe('quick'); // 0.38h < 2h
    expect(r.autopilot.maxHint).toBe('4h');
    expect(r.autopilot.budgetHint).toBe(2000000); // 4h × 500k, capped at 2M
  });

  it('caps budgetHint at MAX_BUDGET_TOKENS', () => {
    const r = sizePlan([{ type: 'impl' }], { throughput: 1000000 });
    // 4h × 1,000,000 = 4M → capped at 2M.
    expect(r.autopilot.budgetHint).toBe(MAX_BUDGET_TOKENS);
  });

  it('produces an epic split recommendation for a heavy plan', () => {
    const tasks = Array(20).fill({ type: 'impl', complexity: 'high' });
    const r = sizePlan(tasks);
    // 20 × 192000 = 3.84M tokens ⇒ 7.68h ⇒ epic.
    expect(r.sizing.band).toBe('epic');
    expect(r.sizing.recommendation).toBe('split');
    expect(r.sizing.splitInto).toBeGreaterThanOrEqual(2);
  });

  it('respects custom band in the autopilot hint', () => {
    const r = sizePlan([{ type: 'impl' }], { band: { minHours: 1, maxHours: 6 } });
    expect(r.autopilot.maxHint).toBe('6h');
    expect(r.autopilot.budgetHint).toBe(Math.min(MAX_BUDGET_TOKENS, 6 * 500000));
  });

  it('is safe on empty input', () => {
    const r = sizePlan([]);
    expect(r.footprint.tokens).toBe(0);
    expect(r.sizing.band).toBe('quick');
    expect(r.sizing.recommendation).toBe('expand');
  });
});
