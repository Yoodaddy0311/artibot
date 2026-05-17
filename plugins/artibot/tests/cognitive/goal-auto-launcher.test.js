import { describe, expect, it } from 'vitest';
import {
  buildGoalSetup,
  selectEvaluator,
  EVALUATOR_STRATEGIES,
} from '../../lib/cognitive/goal-auto-launcher.js';
import { HARD_MAX_ITERATIONS } from '../../lib/autopilot/goal-schema.js';

function parsedFixture(overrides = {}) {
  return {
    found: true,
    condition: 'tests pass',
    maxIterations: 5,
    suggestedValidationCommand: 'npm test',
    confidence: 0.6,
    marker: 'until',
    ...overrides,
  };
}

describe('selectEvaluator', () => {
  it('returns "haiku" when no validation command', () => {
    const p = parsedFixture({ suggestedValidationCommand: null });
    expect(selectEvaluator(p)).toBe('haiku');
  });

  it('returns "hybrid" when validation command present (default)', () => {
    expect(selectEvaluator(parsedFixture())).toBe('hybrid');
  });

  it('returns "validation" when preferValidation=true', () => {
    expect(selectEvaluator(parsedFixture(), { preferValidation: true }))
      .toBe('validation');
  });

  it('returns "haiku" when forceHaiku=true even with command', () => {
    expect(selectEvaluator(parsedFixture(), { forceHaiku: true }))
      .toBe('haiku');
  });

  it('returns "haiku" on null parsed', () => {
    expect(selectEvaluator(null)).toBe('haiku');
  });

  it('exposes EVALUATOR_STRATEGIES with all three', () => {
    expect(EVALUATOR_STRATEGIES).toContain('haiku');
    expect(EVALUATOR_STRATEGIES).toContain('validation');
    expect(EVALUATOR_STRATEGIES).toContain('hybrid');
  });
});

describe('buildGoalSetup', () => {
  describe('not-ready cases', () => {
    it('returns ready=false when no parsed intent', () => {
      const r = buildGoalSetup(null, 'sess-1');
      expect(r.ready).toBe(false);
      expect(r.reason).toMatch(/no goal intent/);
    });

    it('returns ready=false when found=false', () => {
      const r = buildGoalSetup({ found: false }, 'sess-1');
      expect(r.ready).toBe(false);
    });

    it('returns null fields when not ready', () => {
      const r = buildGoalSetup(null, 'sess-1');
      expect(r.contractFragment).toBeNull();
      expect(r.claudeGoalCommand).toBeNull();
      expect(r.evaluatorChoice).toBeNull();
      expect(r.instruction).toBeNull();
    });
  });

  describe('contract fragment', () => {
    it('builds objective from condition', () => {
      const r = buildGoalSetup(parsedFixture(), 'sess-1');
      expect(r.contractFragment.objective).toBe('tests pass');
      expect(r.contractFragment.stoppingCondition).toBe('tests pass');
    });

    it('includes validation command when present', () => {
      const r = buildGoalSetup(parsedFixture(), 'sess-1');
      expect(r.contractFragment.validationCommand).toBe('npm test');
    });

    it('uses null validation command when missing', () => {
      const r = buildGoalSetup(
        parsedFixture({ suggestedValidationCommand: null }),
        'sess-1',
      );
      expect(r.contractFragment.validationCommand).toBeNull();
    });

    it('caps maxIterations at HARD_MAX_ITERATIONS', () => {
      const r = buildGoalSetup(
        parsedFixture({ maxIterations: 999 }),
        'sess-1',
      );
      expect(r.contractFragment.maxIterations).toBe(HARD_MAX_ITERATIONS);
    });

    it('initializes forbiddenChanges as empty array', () => {
      const r = buildGoalSetup(parsedFixture(), 'sess-1');
      expect(r.contractFragment.forbiddenChanges).toEqual([]);
    });

    it('truncates objective longer than 80 chars', () => {
      const long = 'a'.repeat(120);
      const r = buildGoalSetup(parsedFixture({ condition: long }), 'sess-1');
      expect(r.contractFragment.objective.length).toBeLessThanOrEqual(80);
      expect(r.contractFragment.objective.endsWith('...')).toBe(true);
    });
  });

  describe('claudeGoalCommand', () => {
    it('emits literal /goal <condition>', () => {
      const r = buildGoalSetup(parsedFixture(), 'sess-1');
      expect(r.claudeGoalCommand).toBe('/goal tests pass');
    });

    it('trims condition in command', () => {
      const r = buildGoalSetup(
        parsedFixture({ condition: '  tests pass  ' }),
        'sess-1',
      );
      expect(r.claudeGoalCommand).toBe('/goal tests pass');
    });
  });

  describe('evaluatorChoice per strategy', () => {
    it('selects hybrid by default with validation command', () => {
      const r = buildGoalSetup(parsedFixture(), 'sess-1');
      expect(r.evaluatorChoice).toBe('hybrid');
    });

    it('selects haiku when no validation command', () => {
      const r = buildGoalSetup(
        parsedFixture({ suggestedValidationCommand: null }),
        'sess-1',
      );
      expect(r.evaluatorChoice).toBe('haiku');
    });

    it('selects validation when opts.preferValidation', () => {
      const r = buildGoalSetup(parsedFixture(), 'sess-1', {
        preferValidation: true,
      });
      expect(r.evaluatorChoice).toBe('validation');
    });
  });

  describe('instruction', () => {
    it('includes session id', () => {
      const r = buildGoalSetup(parsedFixture(), 'my-sess-42');
      expect(r.instruction).toContain('my-sess-42');
    });

    it('mentions stopping condition', () => {
      const r = buildGoalSetup(parsedFixture(), 'sess-1');
      expect(r.instruction).toContain('tests pass');
    });

    it('mentions evaluator choice', () => {
      const r = buildGoalSetup(parsedFixture(), 'sess-1');
      expect(r.instruction).toContain('hybrid');
    });

    it('falls back to unknown sessionId on bad input', () => {
      const r = buildGoalSetup(parsedFixture(), null);
      expect(r.instruction).toContain('unknown');
    });
  });
});
