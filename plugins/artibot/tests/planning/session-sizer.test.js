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
  SIZE_BANDS,
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

  it('accepts throughputTokensPerHour as a throughput alias', () => {
    const r = estimateFootprint([{ type: 'impl' }], {
      throughputTokensPerHour: 120000,
    });
    expect(r.hours).toBeCloseTo(120000 / 120000, 6); // 120000 tok / 120000 = 1h
    // throughput wins over the alias when both are present.
    const both = estimateFootprint([{ type: 'impl' }], {
      throughput: 240000,
      throughputTokensPerHour: 120000,
    });
    expect(both.hours).toBeCloseTo(120000 / 240000, 6);
  });
});

describe('estimateFootprint — tokenizerCoeff injection', () => {
  const tasks = [{ type: 'impl' }, { type: 'test' }, { type: 'review' }];
  const base = 240000; // 120000 + 70000 + 50000 at medium

  it('is byte-identical to the default when coeff is 1.0 or unspecified', () => {
    expect(estimateFootprint(tasks).tokens).toBe(base);
    expect(estimateFootprint(tasks, {}).tokens).toBe(base);
    expect(estimateFootprint(tasks, { tokenizerCoeff: 1.0 }).tokens).toBe(base);
  });

  it('multiplies per-task tokens by an explicit coefficient (1.3×)', () => {
    const r = estimateFootprint(tasks, { tokenizerCoeff: 1.3 });
    // Per-task rounding: round(120000*1.3)+round(70000*1.3)+round(50000*1.3).
    const expected = Math.round(120000 * 1.3)
      + Math.round(70000 * 1.3)
      + Math.round(50000 * 1.3);
    expect(r.tokens).toBe(expected);
    expect(r.tokens).toBeCloseTo(base * 1.3, -2);
  });

  it('resolves modelTier "fable" to the catalog coefficient (1.3)', () => {
    const fable = estimateFootprint(tasks, { modelTier: 'fable' });
    const explicit = estimateFootprint(tasks, { tokenizerCoeff: 1.3 });
    expect(fable.tokens).toBe(explicit.tokens);
  });

  it('lets explicit tokenizerCoeff win over modelTier', () => {
    const r = estimateFootprint(tasks, { modelTier: 'fable', tokenizerCoeff: 2.0 });
    const expected = Math.round(120000 * 2.0)
      + Math.round(70000 * 2.0)
      + Math.round(50000 * 2.0);
    expect(r.tokens).toBe(expected);
  });

  it('treats opus/unknown tiers as coefficient 1.0', () => {
    expect(estimateFootprint(tasks, { modelTier: 'opus' }).tokens).toBe(base);
    expect(estimateFootprint(tasks, { modelTier: 'nope' }).tokens).toBe(base);
  });

  it('degrades NaN / negative / string coefficients to 1.0', () => {
    expect(estimateFootprint(tasks, { tokenizerCoeff: NaN }).tokens).toBe(base);
    expect(estimateFootprint(tasks, { tokenizerCoeff: -1 }).tokens).toBe(base);
    expect(estimateFootprint(tasks, { tokenizerCoeff: 0 }).tokens).toBe(base);
    expect(estimateFootprint(tasks, { tokenizerCoeff: '1.3' }).tokens).toBe(base);
    expect(estimateFootprint(tasks, { tokenizerCoeff: Infinity }).tokens).toBe(base);
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

// ---------------------------------------------------------------------------
// U1 — `--size` binding. sizePlan/classifySize used to read `opts.band` only,
// so all four `--size` values produced byte-identical output.
// ---------------------------------------------------------------------------

describe('--size binding (opts.size)', () => {
  const TASKS = [{ type: 'impl' }, { type: 'test' }];

  it('maps quick/session/epic to distinct target windows', () => {
    expect(classifySize(1, { size: 'quick' }).target).toEqual(SIZE_BANDS.quick);
    expect(classifySize(1, { size: 'session' }).target).toEqual(SIZE_BANDS.session);
    expect(classifySize(1, { size: 'epic' }).target).toEqual(SIZE_BANDS.epic);
    // The three windows must actually differ, else the binding is cosmetic.
    const maxes = ['quick', 'session', 'epic'].map((s) => SIZE_BANDS[s].maxHours);
    expect(new Set(maxes).size).toBe(3);
  });

  it('sizePlan: each size yields a different maxHint and budgetHint', () => {
    // Throughput is lowered so no band's raw product hits MAX_BUDGET_TOKENS —
    // at the default 500k tok/h both session (4h→2M) and epic (8h→4M) clamp to
    // 2M and the budgetHint assertion would pass vacuously. The cap itself is
    // asserted separately below, with a combination that really exceeds it.
    const opts = { throughput: 100000 };
    const quick = sizePlan(TASKS, { ...opts, size: 'quick' });
    const session = sizePlan(TASKS, { ...opts, size: 'session' });
    const epic = sizePlan(TASKS, { ...opts, size: 'epic' });

    expect([quick.autopilot.maxHint, session.autopilot.maxHint, epic.autopilot.maxHint])
      .toEqual(['1h', '4h', '8h']);
    const budgets = [
      quick.autopilot.budgetHint,
      session.autopilot.budgetHint,
      epic.autopilot.budgetHint,
    ];
    expect(budgets).toEqual([100000, 400000, 800000]);
    expect(new Set(budgets).size).toBe(3);
    // Guard the guard: none of these were clamped, so the distinctness above
    // is a property of the presets, not of the cap.
    for (const b of budgets) expect(b).toBeLessThan(MAX_BUDGET_TOKENS);
  });

  it('caps budgetHint when the raw band×throughput product exceeds the cap', () => {
    // epic 8h × 500k = 4,000,000 raw — genuinely over the 2M cap.
    const raw = SIZE_BANDS.epic.maxHours * THROUGHPUT_TOKENS_PER_HOUR;
    expect(raw).toBeGreaterThan(MAX_BUDGET_TOKENS);
    expect(sizePlan(TASKS, { size: 'epic' }).autopilot.budgetHint).toBe(MAX_BUDGET_TOKENS);
  });

  it('lets an explicit opts.band win over opts.size', () => {
    const r = sizePlan(TASKS, { size: 'quick', band: { minHours: 1, maxHours: 6 } });
    expect(r.autopilot.maxHint).toBe('6h');
    expect(r.sizing.target).toEqual({ minHours: 1, maxHours: 6 });
  });

  it('normalises case and surrounding whitespace', () => {
    expect(classifySize(1, { size: '  EPIC  ' }).target).toEqual(SIZE_BANDS.epic);
  });

  // Negative control — the default path must stay byte-identical, because the
  // call sites are model-generated JS inside `.md` prompts (plan-critic I3).
  it('is byte-identical to the default for absent / undefined / empty size', () => {
    const base = JSON.stringify(sizePlan(TASKS));
    expect(JSON.stringify(sizePlan(TASKS, { size: undefined }))).toBe(base);
    expect(JSON.stringify(sizePlan(TASKS, { size: '' }))).toBe(base);
    expect(JSON.stringify(sizePlan(TASKS, { size: '   ' }))).toBe(base);
    expect(JSON.stringify(sizePlan(TASKS, { size: 'session' }))).toBe(base);
    expect(sizePlan(TASKS).sizing.target).toEqual(SESSION_BAND);
  });

  it('throws only for a non-empty string naming no preset', () => {
    expect(() => sizePlan(TASKS, { size: 'epci' })).toThrow(/unknown size/);
    expect(() => classifySize(1, { size: 'huge' })).toThrow(TypeError);
    // Prototype keys are not presets.
    expect(() => classifySize(1, { size: 'constructor' })).toThrow(/unknown size/);
  });

  // Documented residual: a truthy non-string `size` is ignored rather than
  // rejected. The throw is scoped to the string case on purpose (see
  // resolveBand); this pins the behavior so a future widening is a conscious
  // change, not a surprise.
  it('ignores non-string size values instead of throwing', () => {
    expect(() => classifySize(1, { size: 3 })).not.toThrow();
    expect(classifySize(1, { size: 3 }).target).toEqual(SESSION_BAND);
    expect(classifySize(1, { size: null }).target).toEqual(SESSION_BAND);
  });

  it('exposes session as the very same object as SESSION_BAND', () => {
    expect(SIZE_BANDS.session).toBe(SESSION_BAND);
    expect(Object.isFrozen(SIZE_BANDS)).toBe(true);
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

  it('flows tokenizerCoeff into the footprint without changing the budget cap', () => {
    const tasks = [{ type: 'impl' }, { type: 'test' }];
    const plain = sizePlan(tasks);
    const fable = sizePlan(tasks, { modelTier: 'fable' });
    // Footprint scales with the 1.3 coefficient.
    expect(fable.footprint.tokens).toBeGreaterThan(plain.footprint.tokens);
    expect(fable.footprint.tokens).toBeCloseTo(plain.footprint.tokens * 1.3, -2);
    // budgetHint is a band×throughput cap, independent of the coefficient.
    expect(fable.autopilot.budgetHint).toBe(plain.autopilot.budgetHint);
  });
});
