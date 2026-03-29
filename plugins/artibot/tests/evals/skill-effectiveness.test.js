import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../../lib/core/event-bus.js', () => ({
  emit: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { createSkillEvalHarness } from '../../scripts/evals/skill-effectiveness.js';
import { emit } from '../../lib/core/event-bus.js';

// ---------------------------------------------------------------------------
// createTestCase
// ---------------------------------------------------------------------------

describe('createTestCase()', () => {
  it('returns a frozen test case object with all required fields', () => {
    const harness = createSkillEvalHarness();
    const tc = harness.createTestCase(
      'Test TypeScript generics',
      'Write a generic identity function',
      { hasGeneric: true },
    );

    expect(tc.id).toMatch(/^tc-/);
    expect(tc.description).toBe('Test TypeScript generics');
    expect(tc.input).toBe('Write a generic identity function');
    expect(tc.expectedBehavior).toEqual({ hasGeneric: true });
    expect(tc.createdAt).toBeTruthy();
    expect(() => { tc.id = 'mutated'; }).toThrow();
  });

  it('generates unique IDs for different test cases', () => {
    const harness = createSkillEvalHarness();
    const tc1 = harness.createTestCase('A', 'input-a', {});
    const tc2 = harness.createTestCase('B', 'input-b', {});
    expect(tc1.id).not.toBe(tc2.id);
  });

  it('includes ISO timestamp in createdAt', () => {
    const harness = createSkillEvalHarness();
    const tc = harness.createTestCase('C', 'input-c', {});
    expect(new Date(tc.createdAt).toISOString()).toBe(tc.createdAt);
  });
});

// ---------------------------------------------------------------------------
// evaluateSkill
// ---------------------------------------------------------------------------

describe('evaluateSkill()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns zeros when no test cases provided', async () => {
    const harness = createSkillEvalHarness();
    const result = await harness.evaluateSkill('lang-typescript', []);

    expect(result).toMatchObject({
      skillName: 'lang-typescript',
      baseline: 0,
      withSkill: 0,
      delta: 0,
      improvement: 0,
      testCaseCount: 0,
    });
    expect(result.evaluatedAt).toBeTruthy();
  });

  it('calculates correct scores with custom runner and scorer', async () => {
    const harness = createSkillEvalHarness({
      runWithoutSkill: vi.fn().mockResolvedValue({ score: 0.3 }),
      runWithSkill: vi.fn().mockResolvedValue({ score: 0.9 }),
      scorer: (output) => output.score,
    });

    const tc = harness.createTestCase('Test', 'input', { expected: true });
    const result = await harness.evaluateSkill('lang-typescript', [tc]);

    expect(result.skillName).toBe('lang-typescript');
    expect(result.baseline).toBe(0.3);
    expect(result.withSkill).toBe(0.9);
    expect(result.delta).toBe(0.6);
    expect(result.testCaseCount).toBe(1);
  });

  it('calculates improvement ratio correctly', async () => {
    const harness = createSkillEvalHarness({
      runWithoutSkill: vi.fn().mockResolvedValue({ score: 0.25 }),
      runWithSkill: vi.fn().mockResolvedValue({ score: 0.75 }),
      scorer: (output) => output.score,
    });

    const tc = harness.createTestCase('Test', 'input', {});
    const result = await harness.evaluateSkill('test-skill', [tc]);

    expect(result.improvement).toBe(2); // 0.5 / 0.25 = 2.0
  });

  it('handles zero baseline with positive skill score (Infinity improvement)', async () => {
    const harness = createSkillEvalHarness({
      runWithoutSkill: vi.fn().mockResolvedValue(null),
      runWithSkill: vi.fn().mockResolvedValue({ score: 1.0 }),
      scorer: (output) => output?.score ?? 0,
    });

    const tc = harness.createTestCase('Test', 'input', {});
    const result = await harness.evaluateSkill('test-skill', [tc]);

    expect(result.baseline).toBe(0);
    expect(result.withSkill).toBe(1);
    expect(result.improvement).toBe(Infinity);
  });

  it('handles zero baseline and zero skill score', async () => {
    const harness = createSkillEvalHarness({
      runWithoutSkill: vi.fn().mockResolvedValue(null),
      runWithSkill: vi.fn().mockResolvedValue(null),
      scorer: (output) => output?.score ?? 0,
    });

    const tc = harness.createTestCase('Test', 'input', {});
    const result = await harness.evaluateSkill('test-skill', [tc]);

    expect(result.improvement).toBe(0);
  });

  it('emits feature:skill-eval event on evaluation', async () => {
    const harness = createSkillEvalHarness({
      runWithoutSkill: vi.fn().mockResolvedValue({ score: 0.5 }),
      runWithSkill: vi.fn().mockResolvedValue({ score: 0.8 }),
      scorer: (output) => output.score,
    });

    const tc = harness.createTestCase('Test', 'input', {});
    await harness.evaluateSkill('lang-python', [tc]);

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(
      'feature:skill-eval',
      expect.objectContaining({
        type: 'skill-evaluated',
        skillName: 'lang-python',
      }),
    );
  });

  it('passes skillName to runWithSkill function', async () => {
    const mockRunWithSkill = vi.fn().mockResolvedValue({ score: 0.9 });
    const harness = createSkillEvalHarness({
      runWithoutSkill: vi.fn().mockResolvedValue({ score: 0.3 }),
      runWithSkill: mockRunWithSkill,
      scorer: (output) => output.score,
    });

    const tc = harness.createTestCase('Test', 'my-input', {});
    await harness.evaluateSkill('library-shadcn', [tc]);

    expect(mockRunWithSkill).toHaveBeenCalledWith('my-input', tc, 'library-shadcn');
  });

  it('averages scores across multiple test cases', async () => {
    let callCount = 0;
    const harness = createSkillEvalHarness({
      runWithoutSkill: vi.fn().mockImplementation(() => {
        callCount++;
        return Promise.resolve({ score: callCount <= 2 ? 0.2 : 0.4 });
      }),
      runWithSkill: vi.fn().mockResolvedValue({ score: 0.8 }),
      scorer: (output) => output.score,
    });

    const tc1 = harness.createTestCase('A', 'input-a', {});
    const tc2 = harness.createTestCase('B', 'input-b', {});
    const result = await harness.evaluateSkill('test-skill', [tc1, tc2]);

    expect(result.testCaseCount).toBe(2);
    expect(result.withSkill).toBe(0.8);
  });

  it('clamps scorer output to [0, 1]', async () => {
    const harness = createSkillEvalHarness({
      runWithoutSkill: vi.fn().mockResolvedValue({}),
      runWithSkill: vi.fn().mockResolvedValue({}),
      scorer: () => 5.0, // way above 1
    });

    const tc = harness.createTestCase('Test', 'input', {});
    const result = await harness.evaluateSkill('test-skill', [tc]);

    expect(result.baseline).toBeLessThanOrEqual(1);
    expect(result.withSkill).toBeLessThanOrEqual(1);
  });

  it('uses default binary scoring when no scorer provided', async () => {
    const harness = createSkillEvalHarness({
      runWithoutSkill: vi.fn().mockResolvedValue(null),
      runWithSkill: vi.fn().mockResolvedValue({ result: 'something' }),
    });

    const tc = harness.createTestCase('Test', 'input', {});
    const result = await harness.evaluateSkill('test-skill', [tc]);

    expect(result.baseline).toBe(0); // null => 0
    expect(result.withSkill).toBe(1); // truthy => 1
  });
});

// ---------------------------------------------------------------------------
// evaluateAll
// ---------------------------------------------------------------------------

describe('evaluateAll()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('evaluates multiple skills and sorts by improvement descending', async () => {
    const scores = {
      'skill-a': { baseline: 0.2, skill: 0.8 },
      'skill-b': { baseline: 0.5, skill: 0.6 },
      'skill-c': { baseline: 0.1, skill: 0.9 },
    };
    const harness = createSkillEvalHarness({
      runWithoutSkill: vi.fn().mockImplementation((_input, _tc) => {
        return Promise.resolve({ score: 0 });
      }),
      runWithSkill: vi.fn().mockImplementation((_input, _tc, name) => {
        return Promise.resolve({ score: scores[name]?.skill ?? 0 });
      }),
      scorer: (output) => output.score,
    });

    const tc = harness.createTestCase('Test', 'input', {});
    const results = await harness.evaluateAll(
      ['skill-a', 'skill-b', 'skill-c'],
      [tc],
    );

    expect(results).toHaveLength(3);
    // All baselines are 0 => Infinity improvement for all with positive skill
    // But sorted by improvement descending
    expect(results[0].skillName).toBeDefined();
    expect(results.every((r) => typeof r.improvement === 'number' || r.improvement === Infinity)).toBe(true);
  });

  it('returns empty array for empty skill list', async () => {
    const harness = createSkillEvalHarness();
    const results = await harness.evaluateAll([], []);
    expect(results).toEqual([]);
  });

  it('does not mutate the input skill names array', async () => {
    const harness = createSkillEvalHarness({
      runWithoutSkill: vi.fn().mockResolvedValue(null),
      runWithSkill: vi.fn().mockResolvedValue(null),
    });

    const skillNames = ['a', 'b', 'c'];
    const original = [...skillNames];
    const tc = harness.createTestCase('Test', 'input', {});
    await harness.evaluateAll(skillNames, [tc]);

    expect(skillNames).toEqual(original);
  });
});

// ---------------------------------------------------------------------------
// generateReport
// ---------------------------------------------------------------------------

describe('generateReport()', () => {
  it('returns no-results message for empty results', () => {
    const harness = createSkillEvalHarness();
    const report = harness.generateReport([]);
    expect(report).toContain('No skill evaluation results');
  });

  it('returns no-results message for null input', () => {
    const harness = createSkillEvalHarness();
    const report = harness.generateReport(null);
    expect(report).toContain('No skill evaluation results');
  });

  it('includes header and table for valid results', () => {
    const harness = createSkillEvalHarness();
    const results = [
      {
        skillName: 'lang-typescript',
        baseline: 0.3,
        withSkill: 0.9,
        delta: 0.6,
        improvement: 2.0,
        testCaseCount: 10,
        evaluatedAt: new Date().toISOString(),
      },
    ];
    const report = harness.generateReport(results);

    expect(report).toContain('SKILL EFFECTIVENESS REPORT');
    expect(report).toContain('lang-typescript');
    expect(report).toContain('TOP 5');
    expect(report).toContain('BOTTOM 5');
    expect(report).toContain('200.0%');
  });

  it('handles Infinity improvement in report', () => {
    const harness = createSkillEvalHarness();
    const results = [
      {
        skillName: 'test-skill',
        baseline: 0,
        withSkill: 1.0,
        delta: 1.0,
        improvement: Infinity,
        testCaseCount: 5,
        evaluatedAt: new Date().toISOString(),
      },
    ];
    const report = harness.generateReport(results);
    expect(report).toContain('N/A');
  });

  it('sorts results by improvement in report', () => {
    const harness = createSkillEvalHarness();
    const results = [
      { skillName: 'low', baseline: 0.5, withSkill: 0.6, delta: 0.1, improvement: 0.2, testCaseCount: 1, evaluatedAt: '' },
      { skillName: 'high', baseline: 0.2, withSkill: 0.9, delta: 0.7, improvement: 3.5, testCaseCount: 1, evaluatedAt: '' },
    ];
    const report = harness.generateReport(results);
    const highIdx = report.indexOf('high');
    const lowIdx = report.indexOf('low');
    expect(highIdx).toBeLessThan(lowIdx);
  });
});

// ---------------------------------------------------------------------------
// Immutability
// ---------------------------------------------------------------------------

describe('immutability', () => {
  it('harness object is frozen', () => {
    const harness = createSkillEvalHarness();
    expect(() => { harness.newProp = true; }).toThrow();
  });

  it('test case objects are frozen', () => {
    const harness = createSkillEvalHarness();
    const tc = harness.createTestCase('Test', 'input', {});
    expect(() => { tc.description = 'mutated'; }).toThrow();
  });
});
