/**
 * Tests for lib/autopilot/goal-evaluator.js (v4.6.0 Phase 2).
 * Covers exit-code-based decision logic via DI-injected runCommand.
 * NO real subprocess execution — every test mocks the runner.
 */

import { describe, expect, it, vi } from 'vitest';
import { evaluateGoal } from '../../lib/autopilot/goal-evaluator.js';

const baseContract = Object.freeze({
  objective: 'X',
  stoppingCondition: 'Y',
  validationCommand: 'echo ok',
  forbiddenChanges: [],
  maxIterations: 3,
});

describe('evaluateGoal — invalid contract', () => {
  it('returns met=false confidence=0 for null contract', () => {
    const r = evaluateGoal({ contract: null });
    expect(r.met).toBe(false);
    expect(r.confidence).toBe(0);
    expect(r.reason).toMatch(/invalid contract/);
  });

  it('returns met=false confidence=0 for undefined contract', () => {
    const r = evaluateGoal({});
    expect(r.met).toBe(false);
    expect(r.confidence).toBe(0);
  });

  it('rejects array (non-object contract)', () => {
    const r = evaluateGoal({ contract: ['not', 'a', 'contract'] });
    expect(r.met).toBe(false);
    expect(r.reason).toMatch(/invalid contract/);
  });
});

describe('evaluateGoal — no validationCommand (manual gate)', () => {
  it('returns met=false confidence=0 with manual-evaluation reason', () => {
    const r = evaluateGoal({
      contract: { ...baseContract, validationCommand: null },
    });
    expect(r.met).toBe(false);
    expect(r.confidence).toBe(0);
    expect(r.reason).toMatch(/manual evaluation required/);
  });

  it('treats empty string validationCommand as missing', () => {
    const r = evaluateGoal({
      contract: { ...baseContract, validationCommand: '' },
    });
    expect(r.met).toBe(false);
    expect(r.reason).toMatch(/manual evaluation required/);
  });
});

describe('evaluateGoal — exit code decision', () => {
  it('met=true on exit code 0', () => {
    const runCommand = vi.fn(() => ({ exitCode: 0, stdout: 'ok\n', stderr: '' }));
    const r = evaluateGoal({ contract: baseContract, runCommand });
    expect(r.met).toBe(true);
    expect(r.confidence).toBe(1.0);
    expect(r.exitCode).toBe(0);
    expect(runCommand).toHaveBeenCalledWith('echo ok');
  });

  it('met=false confidence=1 on exit code 1', () => {
    const runCommand = vi.fn(() => ({ exitCode: 1, stdout: '', stderr: 'failed' }));
    const r = evaluateGoal({ contract: baseContract, runCommand });
    expect(r.met).toBe(false);
    expect(r.confidence).toBe(1.0);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toBe('failed');
  });

  it('met=false on any non-zero exit code (e.g. 137 SIGKILL)', () => {
    const runCommand = vi.fn(() => ({ exitCode: 137, stdout: '', stderr: '' }));
    const r = evaluateGoal({ contract: baseContract, runCommand });
    expect(r.met).toBe(false);
    expect(r.exitCode).toBe(137);
  });
});

describe('evaluateGoal — runner exceptions and malformed results', () => {
  it('returns confidence=0 when runCommand throws', () => {
    const runCommand = vi.fn(() => {
      throw new Error('spawn ENOENT');
    });
    const r = evaluateGoal({ contract: baseContract, runCommand });
    expect(r.met).toBe(false);
    expect(r.confidence).toBe(0);
    expect(r.stderr).toMatch(/spawn ENOENT/);
    expect(r.reason).toMatch(/runCommand exception/);
  });

  it('returns confidence=0 when runCommand returns null', () => {
    const runCommand = vi.fn(() => null);
    const r = evaluateGoal({ contract: baseContract, runCommand });
    expect(r.met).toBe(false);
    expect(r.confidence).toBe(0);
    expect(r.reason).toMatch(/non-object/);
  });

  it('defaults missing exitCode to 1 (treat as failure)', () => {
    const runCommand = vi.fn(() => ({ stdout: 'foo', stderr: '' }));
    const r = evaluateGoal({ contract: baseContract, runCommand });
    expect(r.met).toBe(false);
    expect(r.exitCode).toBe(1);
  });
});

describe('evaluateGoal — anti-hallucination guarantee', () => {
  it('does NOT call any LLM-style judgment — only inspects exit code', () => {
    // The function signature accepts only `contract` and `runCommand`.
    // No model parameter, no async LLM call, no fetch. Confirmed by
    // executing with a runCommand that returns exit 0 — result must
    // be met=true regardless of stoppingCondition content.
    const runCommand = vi.fn(() => ({ exitCode: 0, stdout: '', stderr: '' }));
    const r1 = evaluateGoal({
      contract: { ...baseContract, stoppingCondition: 'plausible' },
      runCommand,
    });
    const r2 = evaluateGoal({
      contract: { ...baseContract, stoppingCondition: 'gibberish XYZ 99 false' },
      runCommand,
    });
    expect(r1.met).toBe(true);
    expect(r2.met).toBe(true);
    // Identical exit code → identical decision regardless of natural-language content
  });
});
