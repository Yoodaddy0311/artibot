/**
 * P3-2 — lib/runtime/task-budget.js unit tests.
 *
 * Covers:
 * - getTaskBudgetForEffort() per-level mapping + config override
 * - buildTaskBudgetDirective() output format + beta header toggle
 * - persistTaskBudget() file write + idempotency
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  buildTaskBudgetDirective,
  getTaskBudgetForEffort,
  persistTaskBudget,
} from '../../lib/runtime/task-budget.js';

describe('getTaskBudgetForEffort', () => {
  const config = {
    runtime: {
      effort: {
        budgetMap: { xhigh: 128000, high: 64000, medium: 32000, low: 16000 },
      },
    },
  };

  it('maps xhigh to 128000', () => {
    expect(getTaskBudgetForEffort('xhigh', config)).toBe(128000);
  });

  it('maps high to 64000', () => {
    expect(getTaskBudgetForEffort('high', config)).toBe(64000);
  });

  it('maps medium to 32000', () => {
    expect(getTaskBudgetForEffort('medium', config)).toBe(32000);
  });

  it('maps low to 16000', () => {
    expect(getTaskBudgetForEffort('low', config)).toBe(16000);
  });

  it('returns null for unknown level', () => {
    expect(getTaskBudgetForEffort('unknown', config)).toBeNull();
  });

  it('returns null for null/undefined level', () => {
    expect(getTaskBudgetForEffort(null, config)).toBeNull();
    expect(getTaskBudgetForEffort(undefined, config)).toBeNull();
  });

  it('falls back to defaults when config is empty', () => {
    expect(getTaskBudgetForEffort('xhigh', {})).toBe(128000);
    expect(getTaskBudgetForEffort('low', undefined)).toBe(16000);
  });

  it('honours caller-supplied budget override', () => {
    const custom = { runtime: { effort: { budgetMap: { xhigh: 200000 } } } };
    expect(getTaskBudgetForEffort('xhigh', custom)).toBe(200000);
  });
});

describe('getTaskBudgetForEffort P3 overlay multiplier', () => {
  const config = {
    runtime: {
      effort: {
        budgetMap: { max: 200000, xhigh: 128000, high: 64000, medium: 32000, low: 16000 },
      },
    },
  };

  it('returns the base value when overlay is null/absent', () => {
    expect(getTaskBudgetForEffort('high', config)).toBe(64000);
    expect(getTaskBudgetForEffort('high', config, null)).toBe(64000);
    expect(getTaskBudgetForEffort('high', config, {})).toBe(64000);
  });

  it('multiplies the base budget by a valid multiplier', () => {
    const overlay = { budgetMultipliers: { high: 1.2 } };
    expect(getTaskBudgetForEffort('high', config, overlay)).toBe(Math.round(64000 * 1.2));
  });

  it('re-clamps a boosted budget to the budgetMap ceiling (max)', () => {
    // xhigh=128000 * 1.5 = 192000 (< max 200000) — stays under ceiling.
    expect(getTaskBudgetForEffort('xhigh', config, { budgetMultipliers: { xhigh: 1.5 } }))
      .toBe(192000);
    // max=200000 * 1.5 = 300000 -> clamped down to ceiling 200000.
    expect(getTaskBudgetForEffort('max', config, { budgetMultipliers: { max: 1.5 } }))
      .toBe(200000);
  });

  it('ignores zero / NaN / negative / out-of-range multipliers', () => {
    expect(getTaskBudgetForEffort('high', config, { budgetMultipliers: { high: 0 } })).toBe(64000);
    expect(getTaskBudgetForEffort('high', config, { budgetMultipliers: { high: NaN } })).toBe(64000);
    expect(getTaskBudgetForEffort('high', config, { budgetMultipliers: { high: -1 } })).toBe(64000);
    expect(getTaskBudgetForEffort('high', config, { budgetMultipliers: { high: 2 } })).toBe(64000);
    expect(getTaskBudgetForEffort('high', config, { budgetMultipliers: { high: 0.4 } })).toBe(64000);
  });

  it('reduces budget for a multiplier below 1', () => {
    expect(getTaskBudgetForEffort('high', config, { budgetMultipliers: { high: 0.5 } }))
      .toBe(32000);
  });
});

describe('getTaskBudgetForEffort model coefficient (opts)', () => {
  const config = {
    runtime: {
      effort: {
        budgetMap: { max: 200000, xhigh: 128000, high: 64000, medium: 32000, low: 16000 },
      },
    },
  };

  it('is byte-identical when opts is absent or coeff is 1.0', () => {
    expect(getTaskBudgetForEffort('high', config)).toBe(64000);
    expect(getTaskBudgetForEffort('high', config, null, null)).toBe(64000);
    expect(getTaskBudgetForEffort('high', config, null, {})).toBe(64000);
    expect(getTaskBudgetForEffort('high', config, null, { tokenizerCoeff: 1.0 })).toBe(64000);
    expect(getTaskBudgetForEffort('high', config, null, { modelTier: 'opus' })).toBe(64000);
  });

  it('multiplies the budget by an explicit coefficient (1.3×)', () => {
    expect(getTaskBudgetForEffort('high', config, null, { tokenizerCoeff: 1.3 }))
      .toBe(Math.round(64000 * 1.3)); // 83200
  });

  it('resolves modelTier "fable" to the catalog coefficient (1.3)', () => {
    // medium=32000 * 1.3 = 41600 (well above the 20k floor).
    expect(getTaskBudgetForEffort('medium', config, null, { modelTier: 'fable' }))
      .toBe(Math.round(32000 * 1.3));
  });

  it('clamps fable budgets up to the 20k beta floor for low effort', () => {
    // low=16000 * 1.3 = 20800 → already >= 20000.
    expect(getTaskBudgetForEffort('low', config, null, { modelTier: 'fable' }))
      .toBeGreaterThanOrEqual(20000);
    // With a tiny custom budgetMap, the floor is what saves us.
    const tinyConfig = {
      runtime: { effort: { budgetMap: { max: 200000, low: 1000 } } },
    };
    expect(getTaskBudgetForEffort('low', tinyConfig, null, { modelTier: 'fable' }))
      .toBe(20000);
  });

  it('lets explicit coefficient win over modelTier', () => {
    expect(getTaskBudgetForEffort('high', config, null, { modelTier: 'fable', tokenizerCoeff: 2.0 }))
      .toBe(Math.min(Math.round(64000 * 2.0), 200000)); // 128000
  });

  it('re-clamps a coefficient-boosted budget to the map ceiling', () => {
    // xhigh=128000 * 1.3 = 166400 (< 200000) stays under ceiling.
    expect(getTaskBudgetForEffort('xhigh', config, null, { tokenizerCoeff: 1.3 }))
      .toBe(166400);
    // max=200000 * 1.3 = 260000 → clamped down to ceiling 200000.
    expect(getTaskBudgetForEffort('max', config, null, { tokenizerCoeff: 1.3 }))
      .toBe(200000);
  });

  it('stacks the overlay multiplier and the model coefficient', () => {
    // high=64000 * 1.2 (overlay) = 76800, then * 1.3 (coeff) = 99840.
    const out = getTaskBudgetForEffort(
      'high',
      config,
      { budgetMultipliers: { high: 1.2 } },
      { tokenizerCoeff: 1.3 },
    );
    expect(out).toBe(Math.round(Math.round(64000 * 1.2) * 1.3));
  });

  it('degrades NaN / negative / string coefficients to 1.0', () => {
    expect(getTaskBudgetForEffort('high', config, null, { tokenizerCoeff: NaN })).toBe(64000);
    expect(getTaskBudgetForEffort('high', config, null, { tokenizerCoeff: -1 })).toBe(64000);
    expect(getTaskBudgetForEffort('high', config, null, { tokenizerCoeff: 0 })).toBe(64000);
    expect(getTaskBudgetForEffort('high', config, null, { tokenizerCoeff: '1.3' })).toBe(64000);
    expect(getTaskBudgetForEffort('high', config, null, { modelTier: 'nope' })).toBe(64000);
  });
});

describe('buildTaskBudgetDirective', () => {
  it('emits max_tokens directive without beta header by default', () => {
    const out = buildTaskBudgetDirective('xhigh', 128000, {});
    expect(out).toBe('[artibot:task-budget max_tokens=128000]');
  });

  it('appends anthropic-beta header when longContext.enabled=true', () => {
    const config = {
      runtime: {
        longContext: { enabled: true, betaHeader: 'context-1m-2025-08-01' },
      },
    };
    const out = buildTaskBudgetDirective('xhigh', 128000, config);
    expect(out).toBe(
      '[artibot:task-budget max_tokens=128000 anthropic-beta=context-1m-2025-08-01]',
    );
  });

  it('omits beta header when longContext.enabled=false', () => {
    const config = {
      runtime: {
        longContext: { enabled: false, betaHeader: 'context-1m-2025-08-01' },
      },
    };
    const out = buildTaskBudgetDirective('xhigh', 128000, config);
    expect(out).toBe('[artibot:task-budget max_tokens=128000]');
  });

  it('returns empty string for invalid budget', () => {
    expect(buildTaskBudgetDirective('xhigh', 0, {})).toBe('');
    expect(buildTaskBudgetDirective('xhigh', null, {})).toBe('');
    expect(buildTaskBudgetDirective('', 128000, {})).toBe('');
  });
});

describe('persistTaskBudget', () => {
  let tmpRoot;

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'artibot-tb-'));
  });

  afterEach(() => {
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* noop */ }
  });

  it('writes runtime/current-task-budget.json with expected shape', () => {
    const filePath = persistTaskBudget(
      { command: 'implement', effort: 'xhigh', budget: 128000 },
      tmpRoot,
    );

    expect(filePath).toBeTruthy();
    expect(existsSync(filePath)).toBe(true);

    const data = JSON.parse(readFileSync(filePath, 'utf-8'));
    expect(data.command).toBe('implement');
    expect(data.effort).toBe('xhigh');
    expect(data.budget).toBe(128000);
    expect(typeof data.updatedAt).toBe('string');
  });

  it('returns null when pluginRoot is missing', () => {
    const result = persistTaskBudget(
      { command: 'implement', effort: 'xhigh', budget: 128000 },
      '',
    );
    expect(result).toBeNull();
  });

  it('returns null when budget is invalid', () => {
    const result = persistTaskBudget(
      { command: 'implement', effort: 'xhigh', budget: 0 },
      tmpRoot,
    );
    expect(result).toBeNull();
  });

  it('overwrites previous file on subsequent calls', () => {
    persistTaskBudget(
      { command: 'implement', effort: 'xhigh', budget: 128000 },
      tmpRoot,
    );
    const second = persistTaskBudget(
      { command: 'code-review', effort: 'high', budget: 64000 },
      tmpRoot,
    );

    const data = JSON.parse(readFileSync(second, 'utf-8'));
    expect(data.command).toBe('code-review');
    expect(data.budget).toBe(64000);
  });
});
