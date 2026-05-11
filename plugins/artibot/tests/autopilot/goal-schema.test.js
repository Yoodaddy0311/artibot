/**
 * Tests for lib/autopilot/goal-schema.js (v4.6.0 Phase 1).
 * Covers validation rules, normalization, hard cap, and error paths.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_ITERATIONS,
  HARD_MAX_ITERATIONS,
  validateGoalContract,
} from '../../lib/autopilot/goal-schema.js';

describe('validateGoalContract — happy path', () => {
  it('accepts a minimal valid contract and applies defaults', () => {
    const r = validateGoalContract({
      objective: 'migrate API to v2',
      stoppingCondition: 'all endpoints return 200 under v2 schema',
    });
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.contract).toEqual({
      objective: 'migrate API to v2',
      stoppingCondition: 'all endpoints return 200 under v2 schema',
      validationCommand: null,
      forbiddenChanges: [],
      maxIterations: DEFAULT_MAX_ITERATIONS,
    });
  });

  it('accepts a full contract and trims string fields', () => {
    const r = validateGoalContract({
      objective: '  optimize bundle size  ',
      stoppingCondition: '  bundle < 500KB  ',
      validationCommand: '  npm run size  ',
      forbiddenChanges: ['docs/PRD/**', 'CHANGELOG.md'],
      maxIterations: 5,
    });
    expect(r.valid).toBe(true);
    expect(r.contract.objective).toBe('optimize bundle size');
    expect(r.contract.stoppingCondition).toBe('bundle < 500KB');
    expect(r.contract.validationCommand).toBe('npm run size');
    expect(r.contract.forbiddenChanges).toEqual(['docs/PRD/**', 'CHANGELOG.md']);
    expect(r.contract.maxIterations).toBe(5);
  });
});

describe('validateGoalContract — schema violations', () => {
  it('rejects null input', () => {
    const r = validateGoalContract(null);
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toMatch(/non-null object/);
    expect(r.contract).toBeNull();
  });

  it('rejects array input (typeof object but not a contract)', () => {
    const r = validateGoalContract([]);
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toMatch(/non-null object/);
  });

  it('rejects missing objective', () => {
    const r = validateGoalContract({ stoppingCondition: 'X' });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => /objective/.test(e))).toBe(true);
  });

  it('rejects empty-string objective (whitespace only)', () => {
    const r = validateGoalContract({
      objective: '   ',
      stoppingCondition: 'X',
    });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => /objective/.test(e))).toBe(true);
  });

  it('rejects missing stoppingCondition', () => {
    const r = validateGoalContract({ objective: 'do X' });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => /stoppingCondition/.test(e))).toBe(true);
  });

  it('rejects invalid validationCommand type (number)', () => {
    const r = validateGoalContract({
      objective: 'X',
      stoppingCondition: 'Y',
      validationCommand: 42,
    });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => /validationCommand/.test(e))).toBe(true);
  });

  it('rejects forbiddenChanges that is not an array', () => {
    const r = validateGoalContract({
      objective: 'X',
      stoppingCondition: 'Y',
      forbiddenChanges: 'docs/**',
    });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => /forbiddenChanges/.test(e))).toBe(true);
  });

  it('rejects forbiddenChanges containing non-strings', () => {
    const r = validateGoalContract({
      objective: 'X',
      stoppingCondition: 'Y',
      forbiddenChanges: ['docs/**', 42, null],
    });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => /forbiddenChanges/.test(e))).toBe(true);
  });
});

describe('validateGoalContract — maxIterations hard cap', () => {
  it('rejects maxIterations of 0', () => {
    const r = validateGoalContract({
      objective: 'X',
      stoppingCondition: 'Y',
      maxIterations: 0,
    });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => /positive integer/.test(e))).toBe(true);
  });

  it('rejects non-integer maxIterations', () => {
    const r = validateGoalContract({
      objective: 'X',
      stoppingCondition: 'Y',
      maxIterations: 3.5,
    });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => /positive integer/.test(e))).toBe(true);
  });

  it('rejects maxIterations exceeding hard cap (v4.5.6 trauma guard)', () => {
    const r = validateGoalContract({
      objective: 'X',
      stoppingCondition: 'Y',
      maxIterations: HARD_MAX_ITERATIONS + 1,
    });
    expect(r.valid).toBe(false);
    expect(
      r.errors.some((e) => new RegExp(`hard cap ${HARD_MAX_ITERATIONS}`).test(e)),
    ).toBe(true);
  });

  it('accepts maxIterations exactly at hard cap', () => {
    const r = validateGoalContract({
      objective: 'X',
      stoppingCondition: 'Y',
      maxIterations: HARD_MAX_ITERATIONS,
    });
    expect(r.valid).toBe(true);
    expect(r.contract.maxIterations).toBe(HARD_MAX_ITERATIONS);
  });
});

describe('validateGoalContract — optional fields with null/undefined', () => {
  it('treats undefined validationCommand as null (omitted)', () => {
    const r = validateGoalContract({ objective: 'X', stoppingCondition: 'Y' });
    expect(r.contract.validationCommand).toBeNull();
  });

  it('treats explicit null validationCommand as null', () => {
    const r = validateGoalContract({
      objective: 'X',
      stoppingCondition: 'Y',
      validationCommand: null,
    });
    expect(r.valid).toBe(true);
    expect(r.contract.validationCommand).toBeNull();
  });

  it('produces an independent forbiddenChanges array (no shared reference)', () => {
    const src = ['a', 'b'];
    const r = validateGoalContract({
      objective: 'X',
      stoppingCondition: 'Y',
      forbiddenChanges: src,
    });
    expect(r.contract.forbiddenChanges).toEqual(['a', 'b']);
    expect(r.contract.forbiddenChanges).not.toBe(src);
  });
});
