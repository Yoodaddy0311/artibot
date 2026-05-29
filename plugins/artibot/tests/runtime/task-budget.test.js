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
